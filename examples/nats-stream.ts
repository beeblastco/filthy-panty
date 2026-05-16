/**
 * Example NATS WebSocket stream invocation with subagents and tools.
 */

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { connect, StringCodec } from "nats";
import { toRuntimeAgentConfig, type AgentConfig } from "../functions/_shared/accounts.ts";
import { streamResponseSubject, type NatsStreamEvent } from "../functions/_shared/nats.ts";
import { scopedDirectConversationKey, scopedDirectEventId } from "../functions/_shared/runtime-keys.ts";
import type { DirectInboundEvent } from "../functions/harness-processing/integrations.ts";
import { createAccount, createAgent, deleteAccount } from "./utils.ts";

const googleApiKey = requiredEnv("ACCOUNT_GOOGLE_API_KEY");
const tavilyApiKey = requiredEnv("ACCOUNT_TAVILY_API_KEY");
const lambdaFunctionName = process.env.HARNESS_FUNCTION_NAME?.trim() ||
  requiredEnv("HARNESS_FUNCTION_ARN");
const natsUrl = requiredEnv("NATS_URL");
const connectionId = `ws-test-${Date.now()}`;
const publicEventId = `nats-${Date.now()}`;
const publicConversationKey = `nats-${Date.now()}`;
const codec = StringCodec();

const researchAgentConfig: AgentConfig = {
  provider: {
    google: {
      apiKey: googleApiKey,
    },
  },
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it",
  },
  agent: {
    system: [
      "Knowledge cutoff: January 2025.",
      "You are a focused research subagent.",
      "Use available tools for current facts, cite what you found briefly, and return only the requested research.",
    ].join("\n\n"),
  },
  tools: {
    tavilySearch: {
      enabled: true,
      apiKey: tavilyApiKey,
      searchDepth: "advanced",
      topic: "news",
      includeAnswer: true,
      maxResults: 3,
    },
  },
};

// Initialize clients.
const nats = await connect({ servers: natsUrl, timeout: 5000 });
const lambda = new LambdaClient({ region: "eu-central-1", profile: "default" });

// Create account and agents, then subscribe before invoking the worker.
const account = await createAccount(`nats-stream-${Date.now()}`);
const researchAgent = await createAgent(
  account.accountSecret,
  "NATS research subagent",
  researchAgentConfig,
  "Researches current model releases using configured tools.",
);

const agentConfig: AgentConfig = {
  provider: {
    google: {
      apiKey: googleApiKey,
    },
  },
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it",
  },
  agent: {
    system: [
      "Knowledge cutoff: January 2025.",
      "You are a coordinator agent.",
      "Use subagents for independent research.",
    ].join("\n\n"),
  },
  subagent: {
    enabled: true,
    allowed: [researchAgent.agent.agentId],
    context: "new",
  },
};
const agent = await createAgent(account.accountSecret, "NATS stream test assistant", agentConfig);
const subject = streamResponseSubject(account.account.accountId, agent.agent.agentId, connectionId);
const subscription = nats.subscribe(subject);

console.log("Created test account:", JSON.stringify(account.account));
console.log("Created research subagent:", JSON.stringify(researchAgent.agent));
console.log("Created test agent:", JSON.stringify(agent.agent));
console.log("Subscribed to:", subject);

try {
  const inboundEvent: DirectInboundEvent = {
    accountId: account.account.accountId,
    agentId: agent.agent.agentId,
    agentConfig: toRuntimeAgentConfig(agentConfig),
    eventId: scopedDirectEventId(account.account.accountId, agent.agent.agentId, publicEventId),
    publicEventId: publicEventId,
    conversationKey: scopedDirectConversationKey(account.account.accountId, agent.agent.agentId, publicConversationKey),
    publicConversationKey: publicConversationKey,
    connectionId: connectionId,
    events: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "Launch two subagent tasks in parallel using the configured research subagent:",
              "one for the newest model release from OpenAI and one for the newest model release from Anthropic.",
              "Then compare their coding capabilities and say which is better for coding.",
            ].join(" "),
          },
        ],
      },
    ],
  };

  await lambda.send(new InvokeCommand({
    FunctionName: lambdaFunctionName,
    InvocationType: "Event",
    Payload: new TextEncoder().encode(JSON.stringify({
      kind: "nats-worker",
      event: inboundEvent,
    })),
  }));

  console.log("Invoked nats-worker. Streaming response:\n");
  await printNatsStream(subscription);
} finally {
  subscription.unsubscribe();
  await nats.drain().catch(() => { });
  await deleteAccount(account.accountSecret);
  console.log("\nDeleted test account");
}

async function printNatsStream(subscription: ReturnType<typeof nats.subscribe>): Promise<void> {
  const timeout = setTimeout(() => { subscription.unsubscribe(); }, 120000);

  try {
    for await (const message of subscription) {
      const event = JSON.parse(codec.decode(message.data)) as NatsStreamEvent;
      const data = event.data as { type?: string; text?: string; error?: string };

      process.stdout.write(`\n[${event.sequence}] ${JSON.stringify(data)}\n`);

      if (data.type === "finish" || data.type === "error") {
        break;
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
