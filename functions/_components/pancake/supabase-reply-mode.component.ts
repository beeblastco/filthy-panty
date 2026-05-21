/**
 * Pancake Supabase reply-mode helper.
 * Keep the customer-specific Supabase gate beside Pancake, outside the core agent loop.
 */

import type { ChannelParseResult, ParsedChannelMessage } from "../../_shared/channels.ts";
import { logInfo } from "../../_shared/log.ts";
import { accountAgentScopedKey } from "../../_shared/runtime-keys.ts";

const SUPABASE_REST_PATH = "rest/v1/";

type ReplyMode = "auto" | "human" | "paused";

export interface PancakeSupabaseReplyModeConfig {
  url: string;
  serviceRoleKey: string;
}

interface PancakeSupabaseReplyModeScope {
  accountId: string;
  agentId: string;
}

interface ConversationStateRecord {
  conversation_key: string;
  reply_mode: ReplyMode;
}

export async function applyPancakeSupabaseReplyMode(
  config: PancakeSupabaseReplyModeConfig,
  scope: PancakeSupabaseReplyModeScope,
  parsed: ParsedChannelMessage,
): Promise<ChannelParseResult> {
  const conversationKey = accountAgentScopedKey(
    scope.accountId,
    scope.agentId,
    parsed.message.conversationKey,
  );
  const replyMode = await getPancakeSupabaseReplyMode(config, conversationKey);

  if (replyMode === "auto") {
    return parsed;
  }

  logInfo("Pancake Supabase reply mode skipped agent reply", {
    accountId: scope.accountId,
    agentId: scope.agentId,
    conversationKey,
    replyMode,
  });

  return {
    kind: "ignore",
    response: parsed.ack ?? { statusCode: 200 },
  };
}

export async function getPancakeSupabaseReplyMode(
  config: PancakeSupabaseReplyModeConfig,
  conversationKey: string,
): Promise<ReplyMode> {
  const state = await upsertConversationState(config, conversationKey);
  return state.reply_mode;
}

async function upsertConversationState(
  config: PancakeSupabaseReplyModeConfig,
  conversationKey: string,
): Promise<ConversationStateRecord> {
  const [state] = await supabaseRequest<ConversationStateRecord[]>(
    config,
    `conversation_states?${new URLSearchParams({ on_conflict: "conversation_key", select: "conversation_key,reply_mode" })}`,
    {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({
        conversation_key: conversationKey,
      }),
    },
  ) ?? [];

  if (!state) {
    throw new Error("Supabase conversation state upsert returned no row");
  }

  return state;
}

async function supabaseRequest<T>(
  config: PancakeSupabaseReplyModeConfig,
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
    throw new Error(`Supabase request failed (${response.status}): ${bodyText || "empty response"}`);
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
