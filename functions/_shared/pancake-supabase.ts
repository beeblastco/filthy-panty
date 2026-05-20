/**
 * Optional Pancake conversation-state persistence backed by customer Supabase.
 * Keep this layer scoped to Pancake channel runtime hooks.
 */

import type { JSONValue, SystemModelMessage } from "ai";
import type {
  ChannelContextResult,
  ChannelLifecycleContext,
  ChannelPreparationResult,
} from "./channels.ts";
import { extractText } from "./channels.ts";
import { logError, logInfo, logWarn } from "./log.ts";

const SUPABASE_REST_PATH = "rest/v1/";

type ReplyMode = "auto" | "human" | "paused";

export interface PancakeSupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

interface ConversationStateRecord {
  conversation_key: string;
  account_id: string;
  agent_id: string;
  channel: string;
  provider_page_id: string;
  provider_conversation_id: string;
  customer_external_id?: string | null;
  customer_name?: string | null;
  reply_mode: ReplyMode;
  status: string;
  current_product_id?: string | null;
  current_product_name?: string | null;
  intent?: string | null;
  stage?: string | null;
  summary?: string | null;
  handoff_reason?: string | null;
  handoff_requested_at?: string | null;
  metadata?: JSONValue;
  last_customer_message_at?: string | null;
  last_agent_reply_at?: string | null;
  last_human_reply_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface PancakeConversationSource {
  pageId: string;
  conversationId: string;
  messageId: string;
  fromId?: string;
  fromName?: string;
  pageCustomerId?: string;
  insertedAt?: string;
  rawPayload?: unknown;
}

class SupabaseRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Supabase request failed (${status}): ${body || "empty response"}`);
  }
}

export function createPancakeSupabaseLayer(config: PancakeSupabaseConfig) {
  return {
    prepareMessage: (context: ChannelLifecycleContext) => preparePancakeConversationState(config, context),
    loadContext: (context: ChannelLifecycleContext) => loadPancakeConversationStateContext(config, context),
    recordReply: (context: ChannelLifecycleContext, responseText: string) =>
      recordPancakeAgentReply(config, context, responseText),
  };
}

async function preparePancakeConversationState(
  config: PancakeSupabaseConfig,
  context: ChannelLifecycleContext,
): Promise<ChannelPreparationResult> {
  const source = pancakeSource(context.source);
  if (!source || !context.accountId || !context.agentId) {
    return { shouldContinue: true };
  }

  const body = extractText(context.content).trim();
  const providerCreatedAt = normalizeTimestamp(source.insertedAt);
  const messageTime = providerCreatedAt ?? new Date().toISOString();
  const state = await upsertConversationState(config, {
    conversationKey: context.conversationKey,
    accountId: context.accountId,
    agentId: context.agentId,
    channel: context.channelName,
    pageId: source.pageId,
    conversationId: source.conversationId,
    customerExternalId: source.pageCustomerId ?? source.fromId,
    customerName: source.fromName,
    lastCustomerMessageAt: messageTime,
  });
  const inserted = await insertConversationMessage(config, {
    conversationKey: context.conversationKey,
    accountId: context.accountId,
    agentId: context.agentId,
    channel: context.channelName,
    pageId: source.pageId,
    conversationId: source.conversationId,
    providerMessageId: source.messageId,
    senderType: "customer",
    senderId: source.pageCustomerId ?? source.fromId,
    senderName: source.fromName,
    body,
    rawPayload: source.rawPayload ?? context.source,
    providerCreatedAt,
  });

  if (!inserted) {
    logInfo("Duplicate Pancake Supabase conversation message skipped", {
      conversationKey: context.conversationKey,
      providerMessageId: source.messageId,
    });
    return { shouldContinue: false, reason: "duplicate_message" };
  }

  return state.reply_mode === "auto"
    ? { shouldContinue: true }
    : { shouldContinue: false, reason: `reply_mode_${state.reply_mode}` };
}

async function loadPancakeConversationStateContext(
  config: PancakeSupabaseConfig,
  context: ChannelLifecycleContext,
): Promise<ChannelContextResult> {
  const source = pancakeSource(context.source);
  if (!source) {
    return { canReply: true };
  }

  const state = await loadConversationState(config, context.conversationKey);
  if (!state) {
    return { canReply: true };
  }

  if (state.reply_mode !== "auto") {
    return {
      canReply: false,
      reason: `reply_mode_${state.reply_mode}`,
    };
  }

  return {
    canReply: true,
    system: [{
      role: "system",
      content: formatConversationStatePrompt(state),
    } satisfies SystemModelMessage],
  };
}

async function recordPancakeAgentReply(
  config: PancakeSupabaseConfig,
  context: ChannelLifecycleContext,
  responseText: string,
): Promise<void> {
  const source = pancakeSource(context.source);
  if (!source || !context.accountId || !context.agentId) {
    return;
  }

  const now = new Date().toISOString();
  await insertConversationMessage(config, {
    conversationKey: context.conversationKey,
    accountId: context.accountId,
    agentId: context.agentId,
    channel: context.channelName,
    pageId: source.pageId,
    conversationId: source.conversationId,
    providerMessageId: `agent:${context.eventId}`,
    senderType: "agent",
    senderId: context.agentId,
    senderName: "agent",
    body: responseText,
    rawPayload: {
      sourceEventId: context.eventId,
      responseText,
    },
    providerCreatedAt: now,
  });
  await updateConversationStateTimestamps(config, context.conversationKey, {
    last_agent_reply_at: now,
    updated_at: now,
  });
}

async function upsertConversationState(
  config: PancakeSupabaseConfig,
  input: {
    conversationKey: string;
    accountId: string;
    agentId: string;
    channel: string;
    pageId: string;
    conversationId: string;
    customerExternalId?: string;
    customerName?: string;
    lastCustomerMessageAt: string;
  },
): Promise<ConversationStateRecord> {
  const now = new Date().toISOString();
  const [state] = await supabaseRequest<ConversationStateRecord[]>(
    config,
    `conversation_states?${new URLSearchParams({ on_conflict: "conversation_key", select: "*" })}`,
    {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({
        conversation_key: input.conversationKey,
        account_id: input.accountId,
        agent_id: input.agentId,
        channel: input.channel,
        provider_page_id: input.pageId,
        provider_conversation_id: input.conversationId,
        ...(input.customerExternalId ? { customer_external_id: input.customerExternalId } : {}),
        ...(input.customerName ? { customer_name: input.customerName } : {}),
        last_customer_message_at: input.lastCustomerMessageAt,
        updated_at: now,
      }),
    },
  ) ?? [];

  if (!state) {
    throw new Error("Pancake Supabase conversation state upsert returned no row");
  }

  return state;
}

async function loadConversationState(
  config: PancakeSupabaseConfig,
  conversationKey: string,
): Promise<ConversationStateRecord | null> {
  const query = new URLSearchParams({
    conversation_key: `eq.${conversationKey}`,
    select: "*",
    limit: "1",
  });
  const [state] = await supabaseRequest<ConversationStateRecord[]>(config, `conversation_states?${query}`) ?? [];
  return state ?? null;
}

async function insertConversationMessage(
  config: PancakeSupabaseConfig,
  input: {
    conversationKey: string;
    accountId: string;
    agentId: string;
    channel: string;
    pageId: string;
    conversationId: string;
    providerMessageId: string;
    senderType: "customer" | "agent" | "human" | "system";
    senderId?: string;
    senderName?: string;
    body: string;
    rawPayload: unknown;
    providerCreatedAt?: string;
  },
): Promise<boolean> {
  try {
    await supabaseRequest(config, "conversation_messages", {
      method: "POST",
      headers: { "Prefer": "return=minimal" },
      body: JSON.stringify({
        conversation_key: input.conversationKey,
        account_id: input.accountId,
        agent_id: input.agentId,
        channel: input.channel,
        provider_page_id: input.pageId,
        provider_conversation_id: input.conversationId,
        provider_message_id: input.providerMessageId,
        sender_type: input.senderType,
        ...(input.senderId ? { sender_id: input.senderId } : {}),
        ...(input.senderName ? { sender_name: input.senderName } : {}),
        ...(input.body ? { body: input.body } : {}),
        raw_payload: toJsonPayload(input.rawPayload),
        ...(input.providerCreatedAt ? { provider_created_at: input.providerCreatedAt } : {}),
      }),
    });
    return true;
  } catch (err) {
    if (err instanceof SupabaseRequestError && err.status === 409) {
      return false;
    }
    throw err;
  }
}

async function updateConversationStateTimestamps(
  config: PancakeSupabaseConfig,
  conversationKey: string,
  patch: Pick<ConversationStateRecord, "last_agent_reply_at" | "updated_at">,
): Promise<void> {
  const query = new URLSearchParams({ conversation_key: `eq.${conversationKey}` });
  await supabaseRequest(config, `conversation_states?${query}`, {
    method: "PATCH",
    headers: { "Prefer": "return=minimal" },
    body: JSON.stringify(patch),
  });
}

async function supabaseRequest<T>(
  config: PancakeSupabaseConfig,
  path: string,
  init: RequestInit = {},
): Promise<T | null> {
  const response = await fetch(supabaseUrl(config.url, path), {
    ...init,
    headers: {
      "Accept": "application/json",
      "apikey": config.serviceRoleKey,
      "Authorization": `Bearer ${config.serviceRoleKey}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
  const bodyText = await response.text();

  if (!response.ok) {
    throw new SupabaseRequestError(response.status, bodyText);
  }

  if (!bodyText.trim()) {
    return null;
  }

  return JSON.parse(bodyText) as T;
}

function supabaseUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(`${SUPABASE_REST_PATH}${path.replace(/^\/+/, "")}`, base).toString();
}

function formatConversationStatePrompt(state: ConversationStateRecord): string {
  const lines = [
    "Current customer-service conversation state:",
    `- reply_mode: ${state.reply_mode}`,
    `- status: ${state.status}`,
    formatOptionalLine("current_product_id", state.current_product_id),
    formatOptionalLine("current_product_name", state.current_product_name),
    formatOptionalLine("intent", state.intent),
    formatOptionalLine("stage", state.stage),
    formatOptionalLine("summary", state.summary),
    formatOptionalLine("handoff_reason", state.handoff_reason),
    "",
    "Use this state as operational context. Do not reveal internal field names to the customer.",
  ].filter((line): line is string => line !== null);

  return lines.join("\n");
}

function formatOptionalLine(name: string, value: string | null | undefined): string | null {
  return value ? `- ${name}: ${value}` : null;
}

function pancakeSource(source: Record<string, unknown>): PancakeConversationSource | null {
  if (
    typeof source.pageId !== "string" ||
    typeof source.conversationId !== "string" ||
    typeof source.messageId !== "string"
  ) {
    return null;
  }

  return {
    pageId: source.pageId,
    conversationId: source.conversationId,
    messageId: source.messageId,
    fromId: typeof source.fromId === "string" ? source.fromId : undefined,
    fromName: typeof source.fromName === "string" ? source.fromName : undefined,
    pageCustomerId: typeof source.pageCustomerId === "string" ? source.pageCustomerId : undefined,
    insertedAt: typeof source.insertedAt === "string" ? source.insertedAt : undefined,
    rawPayload: source.rawPayload,
  };
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    logWarn("Ignoring invalid Pancake provider timestamp", { value });
    return undefined;
  }

  return timestamp.toISOString();
}

function toJsonPayload(value: unknown): JSONValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JSONValue;
  } catch (err) {
    logError("Failed to serialize Pancake Supabase raw payload", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}
