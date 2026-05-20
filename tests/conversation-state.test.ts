import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ChannelInboundEvent } from "../functions/harness-processing/integrations.ts";
import {
  loadChannelConversationStatePrompt,
  prepareChannelConversationState,
  recordChannelAgentReply,
} from "../functions/harness-processing/conversation-state.ts";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

describe("conversation state Supabase helper", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    globalThis.fetch = ORIGINAL_FETCH;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("is disabled when Supabase env is not configured", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 500 }));
    globalThis.fetch = fetchMock as never;

    const result = await prepareChannelConversationState(createPancakeEvent());

    expect(result).toEqual({ enabled: false, duplicate: false, canAutoReply: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("upserts conversation state and inserts the inbound customer message", async () => {
    configureSupabaseEnv();
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      if (fetchCalls.length === 1) {
        return jsonResponse([stateRow({ reply_mode: "auto" })]);
      }
      return new Response(null, { status: 201 });
    }) as never;

    const result = await prepareChannelConversationState(createPancakeEvent());

    expect(result.enabled).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.canAutoReply).toBe(true);
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]!.url).toContain("/rest/v1/conversation_states?");
    expect(fetchCalls[0]!.init?.method).toBe("POST");
    expect(fetchCalls[0]!.init?.headers).toMatchObject({
      apikey: "service-key",
      Authorization: "Bearer service-key",
      Prefer: "resolution=merge-duplicates,return=representation",
    });
    expect(JSON.parse(String(fetchCalls[0]!.init?.body))).toMatchObject({
      conversation_key: "acct:acct_test:agent:agent_test:pancake:page-1:conversation-1",
      account_id: "acct_test",
      agent_id: "agent_test",
      channel: "pancake",
      provider_page_id: "page-1",
      provider_conversation_id: "conversation-1",
      customer_external_id: "page-customer-1",
      customer_name: "Ada",
    });
    expect(fetchCalls[1]!.url).toBe("https://supabase.example/rest/v1/conversation_messages");
    expect(JSON.parse(String(fetchCalls[1]!.init?.body))).toMatchObject({
      provider_message_id: "message-1",
      sender_type: "customer",
      sender_id: "page-customer-1",
      sender_name: "Ada",
      body: "hello pancake",
    });
  });

  it("blocks duplicate provider messages", async () => {
    configureSupabaseEnv();
    let callCount = 0;
    globalThis.fetch = mock(async (_url: string | URL, _init?: RequestInit) => {
      callCount += 1;
      if (callCount === 1) {
        return jsonResponse([stateRow({ reply_mode: "auto" })]);
      }
      return new Response(JSON.stringify({ code: "23505" }), { status: 409 });
    }) as never;

    const result = await prepareChannelConversationState(createPancakeEvent());

    expect(result.enabled).toBe(true);
    expect(result.duplicate).toBe(true);
    expect(result.canAutoReply).toBe(false);
    expect(result.reason).toBe("duplicate_message");
  });

  it("blocks auto-reply when the state is in human mode", async () => {
    configureSupabaseEnv();
    let callCount = 0;
    globalThis.fetch = mock(async (_url: string | URL, _init?: RequestInit) => {
      callCount += 1;
      if (callCount === 1) {
        return jsonResponse([stateRow({ reply_mode: "human" })]);
      }
      return new Response(null, { status: 201 });
    }) as never;

    const result = await prepareChannelConversationState(createPancakeEvent());

    expect(result.enabled).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.canAutoReply).toBe(false);
    expect(result.reason).toBe("reply_mode_human");
  });

  it("loads a compact system prompt for auto-mode conversation state", async () => {
    configureSupabaseEnv();
    globalThis.fetch = mock(async () => jsonResponse([
      stateRow({
        reply_mode: "auto",
        status: "open",
        current_product_name: "AquaSilk Serum",
        intent: "price_check",
      }),
    ])) as never;

    const result = await loadChannelConversationStatePrompt(createPancakeEvent());

    expect(result.canAutoReply).toBe(true);
    expect(result.prompt?.role).toBe("system");
    expect(result.prompt?.content).toContain("current_product_name: AquaSilk Serum");
    expect(result.prompt?.content).toContain("intent: price_check");
  });

  it("records agent replies after channel send succeeds", async () => {
    configureSupabaseEnv();
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(null, { status: fetchCalls.length === 1 ? 201 : 204 });
    }) as never;

    await recordChannelAgentReply(createPancakeEvent(), "Agent reply");

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]!.url).toBe("https://supabase.example/rest/v1/conversation_messages");
    expect(JSON.parse(String(fetchCalls[0]!.init?.body))).toMatchObject({
      provider_message_id: "agent:acct:acct_test:agent:agent_test:pancake:page-1:message-1:abc",
      sender_type: "agent",
      sender_id: "agent_test",
      body: "Agent reply",
    });
    expect(fetchCalls[1]!.url).toContain("/rest/v1/conversation_states?");
    expect(fetchCalls[1]!.init?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchCalls[1]!.init?.body))).toHaveProperty("last_agent_reply_at");
  });
});

function configureSupabaseEnv() {
  process.env.SUPABASE_URL = "https://supabase.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
}

function createPancakeEvent(): ChannelInboundEvent {
  return {
    accountId: "acct_test",
    agentId: "agent_test",
    agentConfig: {},
    eventId: "acct:acct_test:agent:agent_test:pancake:page-1:message-1:abc",
    conversationKey: "acct:acct_test:agent:agent_test:pancake:page-1:conversation-1",
    content: [{ type: "text", text: "hello pancake" }],
    events: [{ role: "user", content: [{ type: "text", text: "hello pancake" }] }],
    channelName: "pancake",
    source: {
      pageId: "page-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      messageType: "INBOX",
      fromId: "customer-1",
      fromName: "Ada",
      pageCustomerId: "page-customer-1",
      insertedAt: "2026-05-20T01:02:03.000000",
      rawPayload: { event_type: "messaging" },
    },
    channel: {
      sendText: async () => { },
      sendTyping: async () => { },
      reactToMessage: async () => { },
    },
  };
}

function stateRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    conversation_key: "acct:acct_test:agent:agent_test:pancake:page-1:conversation-1",
    account_id: "acct_test",
    agent_id: "agent_test",
    channel: "pancake",
    provider_page_id: "page-1",
    provider_conversation_id: "conversation-1",
    reply_mode: "auto",
    status: "open",
    metadata: {},
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
