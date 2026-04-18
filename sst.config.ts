/// <reference path="./.sst/platform/config.d.ts" />

import type { Output } from "@pulumi/pulumi";

const AWS_REGION = "us-east-1";
const AWS_ACCOUNT_ID = "403012596812";
const PROJECT_NAME = "filthy-panty";
const PROJECT_OWNER_EMAIL = "phickstran@beeblast.co";
const BEDROCK_MODEL_ID = "nvidia.nemotron-nano-3-30b";
const MAX_AGENT_ITERATIONS = 20;
const MAX_TOOL_CONCURRENCY = 5;
const SLIDING_CONTEXT_WINDOW = 20;

const DEFAULT_SYSTEM_PROMPT = [
  "You are a helpful AI assistant.",
  "Reply in the same language as the user unless asked otherwise.",
  "Be concise, helpful, and safe.",
  "If the user asks something ambiguous, ask a short clarifying question.",
].join(" ");

const AWS_PROFILE =
  process.env.CI ? undefined : (process.env.AWS_PROFILE ?? "default");

function resourceName(service: string, stage: string): string {
  const stagePrefix = stage === "production" ? "" : `${stage}-`;
  return `${stagePrefix}${PROJECT_NAME}-${service}-${AWS_REGION}-${AWS_ACCOUNT_ID}`;
}

export default $config({
  app(input) {
    const stage = input?.stage ?? "dev";

    return {
      name: PROJECT_NAME,
      removal: stage === "production" ? "retain" : "remove",
      protect: stage === "production",
      home: "aws",
      providers: {
        aws: {
          region: AWS_REGION,
          version: "7.20.0",
          ...(AWS_PROFILE ? { profile: AWS_PROFILE } : {}),
          defaultTags: {
            tags: {
              terraform: "false",
              project: PROJECT_NAME,
              owner: PROJECT_OWNER_EMAIL,
            },
          },
        },
      },
    };
  },

  async run() {
    const aws = await import("@pulumi/aws");
    const pulumi = await import("@pulumi/pulumi");
    const stage = $app.stage;
    const names = {
      conversations: resourceName("conversations", stage),
      processedEvents: resourceName("processed-events", stage),
      inboundDlq: resourceName("inbound-dlq", stage),
      inboundQueue: resourceName("inbound-queue", stage),
      outboundDlq: resourceName("outbound-dlq", stage),
      outboundQueue: resourceName("outbound-queue", stage),
      webhookReceiver: resourceName("webhook-rx", stage),
      eventProcessor: resourceName("event-processor", stage),
      replySender: resourceName("reply-sender", stage),
      agentWorkflow: resourceName("agent-workflow", stage),
      agentWorkflowLogs: `/aws/vendedlogs/states/${resourceName("agent-workflow", stage)}`,
      agentWorkflowRole: resourceName("agent-wf-role", stage).slice(0, 64),
      agentWorkflowPolicy: resourceName("agent-wf-policy", stage).slice(
        0,
        128,
      ),
    };

    const telegramBotToken = new sst.Secret("TelegramBotToken");
    const telegramWebhookSecret = new sst.Secret("TelegramWebhookSecret");
    const allowedChatIds = new sst.Secret("AllowedChatIds");

    // ── DynamoDB ───────────────────────────────────────────────────────────

    const conversationsTable = new sst.aws.Dynamo("Conversations", {
      fields: {
        conversationKey: "string",
      },
      primaryIndex: { hashKey: "conversationKey" },
      deletionProtection: stage === "production",
      transform: {
        table: {
          name: names.conversations,
        },
      },
    });

    const processedEventsTable = new sst.aws.Dynamo("ProcessedEvents", {
      fields: {
        eventId: "string",
      },
      primaryIndex: { hashKey: "eventId" },
      ttl: "expiresAt",
      deletionProtection: stage === "production",
      transform: {
        table: {
          name: names.processedEvents,
        },
      },
    });

    // ── SQS Queues ────────────────────────────────────────────────────────

    const inboundDlq = new sst.aws.Queue("InboundDlq", {
      transform: { queue: { name: names.inboundDlq } },
    });
    const inboundQueue = new sst.aws.Queue("InboundQueue", {
      visibilityTimeout: "2 minutes",
      dlq: { queue: inboundDlq.arn, retry: 3 },
      transform: { queue: { name: names.inboundQueue } },
    });

    const outboundDlq = new sst.aws.Queue("OutboundDlq", {
      transform: { queue: { name: names.outboundDlq } },
    });
    const outboundQueue = new sst.aws.Queue("OutboundQueue", {
      visibilityTimeout: "2 minutes",
      dlq: { queue: outboundDlq.arn, retry: 3 },
      transform: { queue: { name: names.outboundQueue } },
    });

    // ── Tool Lambdas ──────────────────────────────────────────────────────
    // Add your tool Lambdas here. Each tool is a small Lambda invoked by
    // the Step Functions agent loop when Bedrock returns tool_use.
    //
    // Example:
    //   const toolMyTool = new sst.aws.Function("ToolMyTool", {
    //     name: names.toolMyTool,
    //     runtime: "provided.al2023",
    //     architecture: "arm64",
    //     bundle: "dist/tool-my-tool",
    //     handler: "bootstrap",
    //     timeout: "10 seconds",
    //     memory: "128 MB",
    //     logging: { format: "json", retention: "1 month" },
    //   });

    const toolLambdaArns: Output<string>[] = [];

    // ── Step Functions IAM ────────────────────────────────────────────────

    const stateMachineRole = new aws.iam.Role("AgentWorkflowRole", {
      name: names.agentWorkflowRole,
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "states.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    });

    const stateMachinePolicy = new aws.iam.RolePolicy("AgentWorkflowPolicy", {
      name: names.agentWorkflowPolicy,
      role: stateMachineRole.id,
      policy: pulumi
        .all([conversationsTable.arn, outboundQueue.arn, ...toolLambdaArns])
        .apply(([tableArn, outboundQueueArn, ...resolvedToolArns]) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: [
                  "bedrock:InvokeModel",
                  "bedrock:InvokeModelWithResponseStream",
                ],
                Resource: [
                  "arn:aws:bedrock:*::foundation-model/*",
                  `arn:aws:bedrock:${AWS_REGION}:${AWS_ACCOUNT_ID}:inference-profile/*`,
                  `arn:aws:bedrock:${AWS_REGION}:${AWS_ACCOUNT_ID}:application-inference-profile/*`,
                ],
              },
              {
                Effect: "Allow",
                Action: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
                Resource: tableArn,
              },
              {
                Effect: "Allow",
                Action: ["sqs:SendMessage"],
                Resource: outboundQueueArn,
              },
              ...(resolvedToolArns.length > 0
                ? [
                  {
                    Effect: "Allow",
                    Action: ["lambda:InvokeFunction"],
                    Resource: resolvedToolArns,
                  },
                ]
                : []),
              {
                Effect: "Allow",
                Action: [
                  "logs:CreateLogDelivery",
                  "logs:CreateLogStream",
                  "logs:GetLogDelivery",
                  "logs:UpdateLogDelivery",
                  "logs:DeleteLogDelivery",
                  "logs:ListLogDeliveries",
                  "logs:PutLogEvents",
                  "logs:PutResourcePolicy",
                  "logs:DescribeResourcePolicies",
                  "logs:DescribeLogGroups",
                ],
                Resource: "*",
              },
            ],
          }),
        ),
    });

    // ── CloudWatch Logs ───────────────────────────────────────────────────

    const agentWorkflowLogGroup = new aws.cloudwatch.LogGroup(
      "AgentWorkflowLogs",
      {
        name: names.agentWorkflowLogs,
        retentionInDays: 30,
      },
    );

    // ── Step Functions Express Workflow ────────────────────────────────────

    const toolArnMapping: Record<string, Output<string>> = {};

    const workflowDefinition = pulumi
      .all([conversationsTable.name, outboundQueue.url, toolArnMapping])
      .apply(([conversationsTableName, outboundQueueUrl, resolvedToolArns]) =>
        JSON.stringify({
          Comment: `${PROJECT_NAME} agent workflow: load context, persist user message, call Bedrock in an agentic tool-calling loop (up to ${MAX_AGENT_ITERATIONS} iterations), then persist final reply and enqueue to SQS.`,
          StartAt: "LoadContextAndPersistUser",
          States: {
            LoadContextAndPersistUser: {
              Type: "Parallel",
              Branches: [
                {
                  StartAt: "LoadContext",
                  States: {
                    LoadContext: {
                      Type: "Task",
                      Resource: "arn:aws:states:::dynamodb:getItem",
                      Parameters: {
                        TableName: conversationsTableName,
                        Key: {
                          conversationKey: {
                            "S.$": "$.conversationKey",
                          },
                        },
                        ConsistentRead: true,
                      },
                      Retry: [
                        {
                          ErrorEquals: [
                            "DynamoDB.ProvisionedThroughputExceededException",
                            "DynamoDB.RequestLimitExceeded",
                            "States.Timeout",
                          ],
                          IntervalSeconds: 2,
                          BackoffRate: 2,
                          MaxAttempts: 3,
                        },
                      ],
                      End: true,
                    },
                  },
                },
                {
                  StartAt: "PersistUserMessage",
                  States: {
                    PersistUserMessage: {
                      Type: "Task",
                      Resource: "arn:aws:states:::dynamodb:updateItem",
                      Parameters: {
                        TableName: conversationsTableName,
                        Key: {
                          conversationKey: {
                            "S.$": "$.conversationKey",
                          },
                        },
                        UpdateExpression:
                          "SET conversation = list_append(if_not_exists(conversation, :emptyConversation), :newTurns), updatedAt = :updatedAt",
                        ExpressionAttributeValues: {
                          ":emptyConversation": { L: [] },
                          ":newTurns": {
                            L: [
                              {
                                M: {
                                  role: { S: "user" },
                                  content: { "S.$": "$.userMessage.content" },
                                  createdAt: {
                                    "S.$": "$.userMessage.createdAt",
                                  },
                                },
                              },
                            ],
                          },
                          ":updatedAt": { "S.$": "$.userMessage.createdAt" },
                        },
                      },
                      Retry: [
                        {
                          ErrorEquals: [
                            "DynamoDB.ProvisionedThroughputExceededException",
                            "DynamoDB.RequestLimitExceeded",
                            "States.Timeout",
                          ],
                          IntervalSeconds: 2,
                          BackoffRate: 2,
                          MaxAttempts: 3,
                        },
                      ],
                      End: true,
                    },
                  },
                },
              ],
              ResultPath: "$.parallelResults",
              Next: "BuildBedrockRequest",
            },

            BuildBedrockRequest: {
              Type: "Pass",
              QueryLanguage: "JSONata",
              Output: {
                conversationKey: "{% $states.input.conversationKey %}",
                channel: "{% $states.input.channel %}",
                source: "{% $states.input.source %}",
                userMessage: "{% $states.input.userMessage %}",
                assistantMessage: "{% $states.input.assistantMessage %}",
                toolConfig: "{% $states.input.toolConfig %}",
                loopState: {
                  iteration: 0,
                  messages:
                    "{% ($currentUser := $states.input.userMessage; $priorContext := $exists($states.input.parallelResults[0].Item.conversation.L) ? $states.input.parallelResults[0].Item.conversation.L : []; $deduped := $filter($priorContext, function($m) { $m.M.role.S != $currentUser.role or $m.M.createdAt.S != $currentUser.createdAt or $m.M.content.S != $currentUser.content }); $windowSize := $states.input.agentConfig.slidingContextWindow; $start := $max([0, $count($deduped) - $windowSize]); $recentContext := $filter($deduped, function($message, $index) { $index >= $start }); $contextMessages := $map($recentContext, function($message) { {'Role': $message.M.role.S, 'Content': [{'Text': $message.M.content.S}]} }); $append($exists($contextMessages) ? $contextMessages : [], [{'Role': $currentUser.role, 'Content': [{'Text': $currentUser.content}]}])) %}",
                  system: "{% $states.input.agentConfig.systemPrompt %}",
                  inferenceConfig: {
                    MaxTokens:
                      "{% $states.input.agentConfig.inferenceConfig.maxTokens %}",
                  },
                },
              },
              Next: "InvokeAgent",
            },

            InvokeAgent: {
              Type: "Task",
              QueryLanguage: "JSONata",
              Resource:
                "arn:aws:states:::aws-sdk:bedrockruntime:converse",
              Arguments: `{% $merge([{'ModelId': '${BEDROCK_MODEL_ID}', 'Messages': $states.input.loopState.messages, 'System': $states.input.loopState.system, 'InferenceConfig': $states.input.loopState.inferenceConfig, 'AdditionalModelRequestFields': {'reasoning_effort': 'high'}}, $count($states.input.toolConfig.tools) > 0 ? {'ToolConfig': {'Tools': ($mapped := $map($states.input.toolConfig.tools, function($t) { {'ToolSpec': {'Name': $t.toolSpec.name, 'Description': $t.toolSpec.description, 'InputSchema': {'Json': $t.toolSpec.inputSchema.json}}} }); $type($mapped) = 'array' ? $mapped : [$mapped])}} : {}]) %}`,
              Output: {
                conversationKey: "{% $states.input.conversationKey %}",
                channel: "{% $states.input.channel %}",
                source: "{% $states.input.source %}",
                userMessage: "{% $states.input.userMessage %}",
                assistantMessage: "{% $states.input.assistantMessage %}",
                toolConfig: "{% $states.input.toolConfig %}",
                loopState: "{% $states.input.loopState %}",
                bedrockResult: {
                  stopReason: "{% $states.result.StopReason %}",
                  outputMessage:
                    "{% $states.result.Output.Message %}",
                },
              },
              Retry: [
                {
                  ErrorEquals: [
                    "Bedrock.InternalServerException",
                    "Bedrock.ModelNotReadyException",
                    "Bedrock.ModelTimeoutException",
                    "Bedrock.ServiceUnavailableException",
                    "Bedrock.ThrottlingException",
                    "States.Timeout",
                  ],
                  IntervalSeconds: 2,
                  BackoffRate: 2,
                  MaxAttempts: 3,
                },
              ],
              Next: "CheckToolUse",
            },

            CheckToolUse: {
              Type: "Choice",
              QueryLanguage: "JSONata",
              Choices: [
                {
                  Condition: `{% $states.input.bedrockResult.stopReason = 'tool_use' and $states.input.loopState.iteration < ${MAX_AGENT_ITERATIONS} %}`,
                  Next: "ExtractToolCalls",
                },
                {
                  Condition: `{% $states.input.bedrockResult.stopReason = 'tool_use' and $states.input.loopState.iteration >= ${MAX_AGENT_ITERATIONS} %}`,
                  Next: "MaxIterationsReached",
                },
              ],
              Default: "ExtractFinalText",
            },

            ExtractToolCalls: {
              Type: "Pass",
              QueryLanguage: "JSONata",
              Output: {
                conversationKey: "{% $states.input.conversationKey %}",
                channel: "{% $states.input.channel %}",
                source: "{% $states.input.source %}",
                userMessage: "{% $states.input.userMessage %}",
                assistantMessage: "{% $states.input.assistantMessage %}",
                toolConfig: "{% $states.input.toolConfig %}",
                loopState: "{% $states.input.loopState %}",
                bedrockResult: "{% $states.input.bedrockResult %}",
                toolCalls:
                  "{% ($toolCalls := $states.input.bedrockResult.outputMessage.Content[ToolUse != null].ToolUse; $type($toolCalls) = 'array' ? $toolCalls : ($exists($toolCalls) ? [$toolCalls] : [])) %}",
              },
              Next: "ExecuteToolCalls",
            },

            ExecuteToolCalls: {
              Type: "Map",
              QueryLanguage: "JSONata",
              Items: "{% $states.input.toolCalls %}",
              MaxConcurrency: MAX_TOOL_CONCURRENCY,
              ItemProcessor: {
                ProcessorConfig: {
                  Mode: "INLINE",
                },
                StartAt: "InvokeToolExecutor",
                States: {
                  InvokeToolExecutor: {
                    Type: "Task",
                    QueryLanguage: "JSONata",
                    Resource: "arn:aws:states:::lambda:invoke",
                    Arguments: {
                      FunctionName: `{% ($toolArns := ${JSON.stringify(resolvedToolArns)}; $lookup($toolArns, $states.input.Name)) %}`,
                      Payload: {
                        toolUseId: "{% $states.input.ToolUseId %}",
                        input: "{% $states.input.Input %}",
                        context: {
                          conversationKey:
                            "{% $states.context.Execution.Input.conversationKey %}",
                          latestUserMessage:
                            "{% $states.context.Execution.Input.userMessage.content %}",
                        },
                      },
                    },
                    Output: "{% $states.result.Payload %}",
                    Retry: [
                      {
                        ErrorEquals: [
                          "Lambda.ServiceException",
                          "Lambda.AWSLambdaException",
                          "Lambda.SdkClientException",
                          "States.Timeout",
                        ],
                        IntervalSeconds: 2,
                        BackoffRate: 2,
                        MaxAttempts: 2,
                      },
                    ],
                    End: true,
                  },
                },
              },
              Output: {
                conversationKey: "{% $states.input.conversationKey %}",
                channel: "{% $states.input.channel %}",
                source: "{% $states.input.source %}",
                userMessage: "{% $states.input.userMessage %}",
                assistantMessage: "{% $states.input.assistantMessage %}",
                toolConfig: "{% $states.input.toolConfig %}",
                loopState: "{% $states.input.loopState %}",
                bedrockResult: "{% $states.input.bedrockResult %}",
                toolCalls: "{% $states.input.toolCalls %}",
                toolResults: "{% $states.result %}",
              },
              Next: "PersistLoopIteration",
            },

            PersistLoopIteration: {
              Type: "Pass",
              QueryLanguage: "JSONata",
              Output: {
                conversationKey: "{% $states.input.conversationKey %}",
                channel: "{% $states.input.channel %}",
                source: "{% $states.input.source %}",
                userMessage: "{% $states.input.userMessage %}",
                assistantMessage: "{% $states.input.assistantMessage %}",
                toolConfig: "{% $states.input.toolConfig %}",
                loopState: "{% $states.input.loopState %}",
                bedrockResult: "{% $states.input.bedrockResult %}",
                toolResults: "{% $states.input.toolResults %}",
              },
              Next: "CheckImmediateToolReply",
            },

            CheckImmediateToolReply: {
              Type: "Choice",
              QueryLanguage: "JSONata",
              Choices: [
                {
                  Condition:
                    "{% ($toolResults := $type($states.input.toolResults) = 'array' ? $states.input.toolResults : [$states.input.toolResults]; $count($toolResults[action = 'immediate_reply']) > 0) %}",
                  Next: "PrepareImmediateReply",
                },
              ],
              Default: "BuildToolResultMessages",
            },

            PrepareImmediateReply: {
              Type: "Pass",
              QueryLanguage: "JSONata",
              Output: {
                conversationKey: "{% $states.input.conversationKey %}",
                channel: "{% $states.input.channel %}",
                source: "{% $states.input.source %}",
                userMessage: "{% $states.input.userMessage %}",
                assistantMessage: "{% $states.input.assistantMessage %}",
                replyTimestamp: "{% $now() %}",
                agent: {
                  assistantText:
                    "{% ($toolResults := $type($states.input.toolResults) = 'array' ? $states.input.toolResults : [$states.input.toolResults]; $immediate := $toolResults[action = 'immediate_reply'][0]; $reply := $trim($immediate.replyText); $reply != '' ? $reply : 'I need to hand this off. Someone will follow up shortly.') %}",
                  assistantContent:
                    "{% ($toolResults := $type($states.input.toolResults) = 'array' ? $states.input.toolResults : [$states.input.toolResults]; $immediate := $toolResults[action = 'immediate_reply'][0]; $reply := $trim($immediate.replyText); [{'Text': $reply != '' ? $reply : 'I need to hand this off. Someone will follow up shortly.'}] ) %}",
                },
              },
              Next: "PrepareOutboundMessage",
            },

            BuildToolResultMessages: {
              Type: "Pass",
              QueryLanguage: "JSONata",
              Output: {
                conversationKey: "{% $states.input.conversationKey %}",
                channel: "{% $states.input.channel %}",
                source: "{% $states.input.source %}",
                userMessage: "{% $states.input.userMessage %}",
                assistantMessage: "{% $states.input.assistantMessage %}",
                toolConfig: "{% $states.input.toolConfig %}",
                loopState: {
                  iteration:
                    "{% $states.input.loopState.iteration + 1 %}",
                  messages:
                    "{% ($toolResultBlocks := $states.input.toolResults.({'ToolResult': {'ToolUseId': toolUseId, 'Content': [{'Text': content}], 'Status': status}}); $normalizedToolResults := $type($toolResultBlocks) = 'array' ? $toolResultBlocks : [$toolResultBlocks]; $append($append($states.input.loopState.messages, [{'Role': 'assistant', 'Content': $states.input.bedrockResult.outputMessage.Content}]), [{'Role': 'user', 'Content': $normalizedToolResults}])) %}",
                  system: "{% $states.input.loopState.system %}",
                  inferenceConfig:
                    "{% $states.input.loopState.inferenceConfig %}",
                },
              },
              Next: "InvokeAgent",
            },

            ExtractFinalText: {
              Type: "Pass",
              QueryLanguage: "JSONata",
              Output: {
                conversationKey: "{% $states.input.conversationKey %}",
                channel: "{% $states.input.channel %}",
                source: "{% $states.input.source %}",
                userMessage: "{% $states.input.userMessage %}",
                assistantMessage: "{% $states.input.assistantMessage %}",
                replyTimestamp: "{% $now() %}",
                agent: {
                  assistantText:
                    "{% ($assistantText := $join($states.input.bedrockResult.outputMessage.Content[Text != null].Text, ''); $trim($assistantText) != '' ? $assistantText : 'Thanks for reaching out. How can I help?') %}",
                  assistantContent:
                    "{% $states.input.bedrockResult.outputMessage.Content %}",
                },
              },
              Next: "PrepareOutboundMessage",
            },

            MaxIterationsReached: {
              Type: "Pass",
              QueryLanguage: "JSONata",
              Output: {
                conversationKey: "{% $states.input.conversationKey %}",
                channel: "{% $states.input.channel %}",
                source: "{% $states.input.source %}",
                userMessage: "{% $states.input.userMessage %}",
                assistantMessage: "{% $states.input.assistantMessage %}",
                replyTimestamp: "{% $now() %}",
                agent: {
                  assistantText:
                    "{% $count($states.input.bedrockResult.outputMessage.Content[Text != null]) > 0 ? $join($states.input.bedrockResult.outputMessage.Content[Text != null].Text, '') : 'I was unable to complete the request within the allowed number of steps. Please try again.' %}",
                  assistantContent:
                    "{% $states.input.bedrockResult.outputMessage.Content %}",
                },
              },
              Next: "PrepareOutboundMessage",
            },

            PrepareOutboundMessage: {
              Type: "Pass",
              Parameters: {
                "conversationKey.$": "$.conversationKey",
                "text.$": "$.agent.assistantText",
                "channel.$": "$.channel",
                "source.$": "$.source",
              },
              ResultPath: "$.outboundMessage",
              Next: "PersistAndDispatch",
            },

            PersistAndDispatch: {
              Type: "Parallel",
              Branches: [
                {
                  StartAt: "UpdateConversation",
                  States: {
                    UpdateConversation: {
                      Type: "Task",
                      Resource:
                        "arn:aws:states:::dynamodb:updateItem",
                      Parameters: {
                        TableName: conversationsTableName,
                        Key: {
                          conversationKey: {
                            "S.$": "$.conversationKey",
                          },
                        },
                        UpdateExpression:
                          "SET conversation = list_append(if_not_exists(conversation, :emptyConversation), :newTurns), updatedAt = :updatedAt",
                        ExpressionAttributeValues: {
                          ":emptyConversation": { L: [] },
                          ":newTurns": {
                            L: [
                              {
                                M: {
                                  role: { S: "assistant" },
                                  content: {
                                    "S.$": "$.agent.assistantText",
                                  },
                                  fullContent: {
                                    "S.$":
                                      "States.JsonToString($.agent.assistantContent)",
                                  },
                                  createdAt: {
                                    "S.$": "$.replyTimestamp",
                                  },
                                },
                              },
                            ],
                          },
                          ":updatedAt": {
                            "S.$": "$.replyTimestamp",
                          },
                        },
                      },
                      Retry: [
                        {
                          ErrorEquals: [
                            "DynamoDB.ProvisionedThroughputExceededException",
                            "DynamoDB.RequestLimitExceeded",
                            "States.Timeout",
                          ],
                          IntervalSeconds: 2,
                          BackoffRate: 2,
                          MaxAttempts: 3,
                        },
                      ],
                      End: true,
                    },
                  },
                },
                {
                  StartAt: "SendReplyToQueue",
                  States: {
                    SendReplyToQueue: {
                      Type: "Task",
                      Resource:
                        "arn:aws:states:::sqs:sendMessage",
                      Parameters: {
                        QueueUrl: outboundQueueUrl,
                        "MessageBody.$":
                          "States.JsonToString($.outboundMessage)",
                      },
                      Retry: [
                        {
                          ErrorEquals: [
                            "SQS.AmazonSQSException",
                            "States.Timeout",
                          ],
                          IntervalSeconds: 2,
                          BackoffRate: 2,
                          MaxAttempts: 3,
                        },
                      ],
                      End: true,
                    },
                  },
                },
              ],
              End: true,
            },
          },
        }),
      );

    const agentWorkflow = new aws.sfn.StateMachine(
      "AgentWorkflow",
      {
        name: names.agentWorkflow,
        roleArn: stateMachineRole.arn,
        type: "EXPRESS",
        definition: workflowDefinition,
        loggingConfiguration: {
          level: "ALL",
          includeExecutionData: true,
          logDestination: pulumi.interpolate`${agentWorkflowLogGroup.arn}:*`,
        },
      },
      {
        dependsOn: [stateMachinePolicy, agentWorkflowLogGroup],
      },
    );

    // ── Webhook Receiver Lambda ───────────────────────────────────────────

    const webhookReceiver = new sst.aws.Function("WebhookReceiver", {
      name: names.webhookReceiver,
      runtime: "provided.al2023",
      architecture: "arm64",
      bundle: "dist/webhook-receiver",
      handler: "bootstrap",
      description:
        "Receives inbound webhook events and enqueues them for processing.",
      timeout: "10 seconds",
      memory: "128 MB",
      url: true,
      logging: { format: "json", retention: "1 month" },
      environment: {
        INBOUND_QUEUE_URL: inboundQueue.url,
        TELEGRAM_WEBHOOK_SECRET: telegramWebhookSecret.value,
        TELEGRAM_BOT_TOKEN: telegramBotToken.value,
        ALLOWED_CHAT_IDS: allowedChatIds.value,
        CONVERSATIONS_TABLE_NAME: conversationsTable.name,
      },
      permissions: [
        {
          actions: ["sqs:SendMessage", "sqs:SendMessageBatch"],
          resources: [inboundQueue.arn],
        },
        {
          actions: ["dynamodb:DeleteItem"],
          resources: [conversationsTable.arn],
        },
      ],
    });

    // ── Event Processor Lambda ────────────────────────────────────────────

    const eventProcessor = inboundQueue.subscribe(
      {
        name: names.eventProcessor,
        runtime: "provided.al2023",
        architecture: "arm64",
        bundle: "dist/event-processor",
        handler: "bootstrap",
        description:
          "Processes inbound events: deduplicates, builds agent context, starts Step Functions workflow.",
        timeout: "30 seconds",
        memory: "128 MB",
        logging: { format: "json", retention: "1 month" },
        environment: {
          AGENT_WORKFLOW_ARN: agentWorkflow.arn,
          DEFAULT_SYSTEM_PROMPT,
          PROCESSED_EVENTS_TABLE_NAME: processedEventsTable.name,
          SLIDING_CONTEXT_WINDOW: String(SLIDING_CONTEXT_WINDOW),
        },
        permissions: [
          {
            actions: ["dynamodb:DeleteItem", "dynamodb:PutItem"],
            resources: [processedEventsTable.arn],
          },
          {
            actions: ["states:StartExecution"],
            resources: [agentWorkflow.arn],
          },
        ],
      },
      {
        batch: { size: 10, window: "1 second", partialResponses: true },
        transform: { function: { name: names.eventProcessor } },
      },
    );

    // ── Reply Sender Lambda ───────────────────────────────────────────────

    const replySender = outboundQueue.subscribe(
      {
        name: names.replySender,
        runtime: "provided.al2023",
        architecture: "arm64",
        bundle: "dist/reply-sender",
        handler: "bootstrap",
        description: "Sends outbound reply messages to the destination channel.",
        timeout: "10 seconds",
        memory: "128 MB",
        logging: { format: "json", retention: "1 month" },
        environment: {
          TELEGRAM_BOT_TOKEN: telegramBotToken.value,
        },
      },
      {
        batch: { size: 10, window: "5 seconds", partialResponses: true },
        transform: { function: { name: names.replySender } },
      },
    );

    return {
      webhookReceiverUrl: webhookReceiver.url,
      inboundQueueUrl: inboundQueue.url,
      outboundQueueUrl: outboundQueue.url,
      conversationsTableName: conversationsTable.name,
      processedEventsTableName: processedEventsTable.name,
      agentWorkflowArn: agentWorkflow.arn,
      agentWorkflowLogGroupName: agentWorkflowLogGroup.name,
    };
  },
});
