import type { SQSEvent, SQSBatchResponse, SQSRecord } from "aws-lambda";
import { DynamoDBClient, PutItemCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { requireEnv } from "../_shared/env.ts";
import { buildToolConfig } from "../_shared/tools.ts";
import { processSqsBatch } from "../_shared/sqs.ts";
import { logInfo, logError } from "../_shared/log.ts";

const dynamo = new DynamoDBClient({});
const sfn = new SFNClient({});

const AGENT_WORKFLOW_ARN = requireEnv("AGENT_WORKFLOW_ARN");
const DEFAULT_SYSTEM_PROMPT = requireEnv("DEFAULT_SYSTEM_PROMPT");
const PROCESSED_EVENTS_TABLE_NAME = requireEnv("PROCESSED_EVENTS_TABLE_NAME");
const SLIDING_CONTEXT_WINDOW = Number(requireEnv("SLIDING_CONTEXT_WINDOW"));

interface InboundEvent {
  eventId: string;
  conversationKey: string;
  channel: string;
  content: string;
  source: Record<string, unknown>;
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  return processSqsBatch(event, processRecord);
}

async function processRecord(record: SQSRecord): Promise<void> {
  const inbound: InboundEvent = JSON.parse(record.body);
  const { eventId, conversationKey, channel, content } = inbound;

  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 86400;

  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: PROCESSED_EVENTS_TABLE_NAME,
        Item: {
          eventId: { S: eventId },
          createdAt: { S: now },
          expiresAt: { N: String(ttl) },
        },
        ConditionExpression: "attribute_not_exists(eventId)",
      }),
    );
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.name === "ConditionalCheckFailedException"
    ) {
      logInfo("Duplicate event skipped", { eventId });
      return;
    }
    throw err;
  }

  const workflowInput = {
    conversationKey,
    channel,
    source: { ...inbound.source, eventId, occurredAt: now },
    userMessage: { role: "user", content, createdAt: now },
    assistantMessage: { role: "assistant", content: "", createdAt: "" },
    agentConfig: {
      systemPrompt: [{ Text: DEFAULT_SYSTEM_PROMPT }],
      slidingContextWindow: SLIDING_CONTEXT_WINDOW,
      inferenceConfig: { maxTokens: 128000 },
    },
    toolConfig: buildToolConfig(),
  };

  try {
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: AGENT_WORKFLOW_ARN,
        name: `${eventId}-${Date.now()}`,
        input: JSON.stringify(workflowInput),
      }),
    );
    logInfo("Workflow started", { eventId, conversationKey });
  } catch (err) {
    logError("Workflow start failed, releasing event claim", {
      eventId,
      error: err instanceof Error ? err.message : String(err),
    });
    await dynamo.send(
      new DeleteItemCommand({
        TableName: PROCESSED_EVENTS_TABLE_NAME,
        Key: { eventId: { S: eventId } },
      }),
    );
    throw err;
  }
}
