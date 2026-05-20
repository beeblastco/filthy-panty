/**
 * Customer-service conversation state integration.
 * Keep Supabase state/message persistence here; model session history stays in session.ts.
 */

import type { JSONValue, SystemModelMessage } from "ai";
import { extractText } from "../_shared/channels.ts";
import { logError, logInfo, logWarn } from "../_shared/log.ts";
import type { ChannelInboundEvent } from "./integrations.ts";
import { isSupabaseConfigured, supabaseRequest, SupabaseRequestError } from "./supabase.ts";

type ReplyMode = "auto" | "human" | "paused";

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

export interface ChannelConversationPreparation {
  enabled: boolean;
  duplicate: boolean;
  canAutoReply: boolean;
  state?: ConversationStateRecord;
  reason?: string;
}

export async function prepareChannelConversationState(
  event: ChannelInboundEvent,
): Promise<ChannelConversationPreparation> {
  if (!isSupportedStateChannel(event)) {
    return { enabled: false, duplicate: false, canAutoReply: true };
  }

  const source = pancakeSource(event.source);
  if (!source || !event.accountId || !event.agentId) {
    return { enabled: false, duplicate: false, canAutoReply: true };
  }

  const body = extractText(event.content).trim();
  const providerCreatedAt = normalizeTimestamp(source.insertedAt);
  const messageTime = providerCreatedAt ?? new Date().toISOString();
  const state = await upsertConversationState({
    conversationKey: event.conversationKey,
    accountId: event.accountId,
    agentId: event.agentId,
    channel: event.channelName,
    pageId: source.pageId,
    conversationId: source.conversationId,
    customerExternalId: source.pageCustomerId ?? source.fromId,
    customerName: source.fromName,
    lastCustomerMessageAt: messageTime,
  });
  const inserted = await insertConversationMessage({
    conversationKey: event.conversationKey,
    accountId: event.accountId,
    agentId: event.agentId,
    channel: event.channelName,
    pageId: source.pageId,
    conversationId: source.conversationId,
    providerMessageId: source.messageId,
    senderType: "customer",
    senderId: source.pageCustomerId ?? source.fromId,
    senderName: source.fromName,
    body,
    rawPayload: normalizedRawPayload(source, event.source),
    providerCreatedAt,
  });

  if (!inserted) {
    logInfo("Duplicate Supabase conversation message skipped", {
      conversationKey: event.conversationKey,
      providerMessageId: source.messageId,
    });
    return {
      enabled: true,
      duplicate: true,
      canAutoReply: false,
      state,
      reason: "duplicate_message",
    };
  }

  return {
    enabled: true,
    duplicate: false,
    canAutoReply: state.reply_mode === "auto",
    state,
    ...(state.reply_mode === "auto" ? {} : { reason: `reply_mode_${state.reply_mode}` }),
  };
}

export async function loadChannelConversationStatePrompt(
  event: ChannelInboundEvent,
): Promise<{ canAutoReply: boolean; prompt?: SystemModelMessage; state?: ConversationStateRecord; reason?: string }> {
  if (!isSupportedStateChannel(event)) {
    return { canAutoReply: true };
  }

  const state = await loadConversationState(event.conversationKey);
  if (!state) {
    return { canAutoReply: true };
  }

  if (state.reply_mode !== "auto") {
    return {
      canAutoReply: false,
      state,
      reason: `reply_mode_${state.reply_mode}`,
    };
  }

  return {
    canAutoReply: true,
    state,
    prompt: {
      role: "system",
      content: formatConversationStatePrompt(state),
    },
  };
}

export async function recordChannelAgentReply(
  event: ChannelInboundEvent,
  responseText: string,
): Promise<void> {
  if (!isSupportedStateChannel(event)) {
    return;
  }

  const source = pancakeSource(event.source);
  if (!source || !event.accountId || !event.agentId) {
    return;
  }

  const now = new Date().toISOString();
  await insertConversationMessage({
    conversationKey: event.conversationKey,
    accountId: event.accountId,
    agentId: event.agentId,
    channel: event.channelName,
    pageId: source.pageId,
    conversationId: source.conversationId,
    providerMessageId: `agent:${event.eventId}`,
    senderType: "agent",
    senderId: event.agentId,
    senderName: "agent",
    body: responseText,
    rawPayload: {
      sourceEventId: event.eventId,
      responseText,
    },
    providerCreatedAt: now,
  });
  await updateConversationStateTimestamps(event.conversationKey, {
    last_agent_reply_at: now,
    updated_at: now,
  });
}

function isSupportedStateChannel(event: ChannelInboundEvent): boolean {
  return event.channelName === "pancake" && isSupabaseConfigured();
}

async function upsertConversationState(input: {
  conversationKey: string;
  accountId: string;
  agentId: string;
  channel: string;
  pageId: string;
  conversationId: string;
  customerExternalId?: string;
  customerName?: string;
  lastCustomerMessageAt: string;
}): Promise<ConversationStateRecord> {
  const now = new Date().toISOString();
  const [state] = await supabaseRequest<ConversationStateRecord[]>(
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
    throw new Error("Supabase conversation state upsert returned no row");
  }

  return state;
}

async function loadConversationState(conversationKey: string): Promise<ConversationStateRecord | null> {
  const query = new URLSearchParams({
    conversation_key: `eq.${conversationKey}`,
    select: "*",
    limit: "1",
  });
  const [state] = await supabaseRequest<ConversationStateRecord[]>(`conversation_states?${query}`) ?? [];
  return state ?? null;
}

async function insertConversationMessage(input: {
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
}): Promise<boolean> {
  try {
    await supabaseRequest("conversation_messages", {
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
  conversationKey: string,
  patch: Pick<ConversationStateRecord, "last_agent_reply_at" | "updated_at">,
): Promise<void> {
  const query = new URLSearchParams({ conversation_key: `eq.${conversationKey}` });
  await supabaseRequest(`conversation_states?${query}`, {
    method: "PATCH",
    headers: { "Prefer": "return=minimal" },
    body: JSON.stringify(patch),
  });
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

function normalizedRawPayload(
  source: PancakeConversationSource,
  fallback: Record<string, unknown>,
): unknown {
  return source.rawPayload ?? fallback;
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    logWarn("Ignoring invalid provider timestamp", { value });
    return undefined;
  }

  return timestamp.toISOString();
}

function toJsonPayload(value: unknown): JSONValue {
  try {
    return JSON.parse(JSON.stringify(value ?? {})) as JSONValue;
  } catch (err) {
    logError("Failed to serialize Supabase raw payload", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}
