/**
 * Example tool approval flow.
 */

import {
  createAccount,
  createAgent,
  deleteAccount,
  streamSSE,
  streamToolApprovalResponse,
} from "./utils.ts";

interface ToolApprovalRequestChunk {
  type: "tool-approval-request";
  approvalId: string;
  toolCallId: string;
}

const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;
const tavilyApiKey = process.env.ACCOUNT_TAVILY_API_KEY!;

const account = await createAccount(`approval-${Date.now()}`);
const agent = await createAgent(account.accountSecret, "Approval search assistant", {
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
    system: "Use Tavily search when current web information is needed.",
  },
  tools: {
    tavilySearch: {
      enabled: true,
      needsApproval: true,
      apiKey: tavilyApiKey,
      searchDepth: "advanced",
      includeAnswer: true,
      maxResults: 3,
    },
  },
});
const conversationKey = `approval-${Date.now()}`;

console.log("Created test account:", JSON.stringify(account));
console.log("Created test agent:", JSON.stringify(agent));

try {
  let approvalRequest: ToolApprovalRequestChunk | null = null;

  for await (const chunk of streamSSE({
    agentId: agent.agent.agentId,
    eventId: `approval-request-${Date.now()}`,
    conversationKey,
    events: [{
      role: "user",
      content: [{
        type: "text",
        text: "Search the web for the latest OpenAI model release and summarize one result.",
      }],
    }],
  }, account.accountSecret)) {
    process.stdout.write(chunk);
    const parsedChunk = parseToolApprovalRequestChunk(chunk);
    if (parsedChunk) {
      approvalRequest = parsedChunk;
    }
  }

  if (!approvalRequest) {
    throw new Error("Expected sync stream to include a tool-approval-request chunk");
  }

  console.log("\n\nApproving tool call:", JSON.stringify(approvalRequest, null, 2));

  for await (const chunk of streamToolApprovalResponse({
    accountSecret: account.accountSecret,
    agentId: agent.agent.agentId,
    conversationKey,
    approvalId: approvalRequest.approvalId,
    approved: true,
    reason: "Example script approved the search.",
  })) {
    process.stdout.write(chunk);
  }
} finally {
  await deleteAccount(account.accountSecret);
  console.log("\n\nDeleted test account");
}

function parseToolApprovalRequestChunk(chunk: string): ToolApprovalRequestChunk | null {
  try {
    const parsed = JSON.parse(chunk) as Partial<ToolApprovalRequestChunk>;
    return parsed.type === "tool-approval-request" &&
      typeof parsed.approvalId === "string" &&
      typeof parsed.toolCallId === "string"
      ? {
        type: parsed.type,
        approvalId: parsed.approvalId,
        toolCallId: parsed.toolCallId,
      }
      : null;
  } catch {
    return null;
  }
}
