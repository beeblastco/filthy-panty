/**
 * Telegram channel adapter implementated as a ChannelAdapter.
 * Implements Telegram auth, message normalization, and reply actions through low-level telegram.ts helpers.
 */

import { TelegramAdapter, type TelegramMessage, type TelegramUpdate } from "@chat-adapter/telegram";
import { ConsoleLogger } from "chat";
import type { ChannelActions, ChannelAdapter, ChannelParseResult, InboundAttachmentCandidate } from "./channels.ts";
import { logWarn } from "./log.ts";
import { pinnedHttpsFetch } from "./pinned-https.ts";
import { TELEGRAM_INTEGRATION_PREFIX } from "./runtime-keys.ts";
import { editMessageText, sendMessage, sendMessageReturningId, verifyWebhookSecret } from "./telegram.ts";

export interface TelegramSource {
  chatId: number;
  messageId: string;
  threadId: string;
  fromUserId?: number;
  fromUsername?: string;
}

const TELEGRAM_API_HOST = "api.telegram.org";
const TELEGRAM_METADATA_MAX_BYTES = 64 * 1024;
const TELEGRAM_METADATA_TIMEOUT_MS = 10_000;
const TELEGRAM_METADATA_MAX_REDIRECTS = 2;

export function createTelegramChannel(
  botToken: string,
  webhookSecret: string,
  allowedChatIds: Set<number>,
  reactionEmoji: string,
  fetchHttps: typeof pinnedHttpsFetch = pinnedHttpsFetch,
): ChannelAdapter {
  const transport = new TelegramAdapter({
    botToken,
    secretToken: webhookSecret,
    mode: "webhook",
    logger: new ConsoleLogger("error").child("telegram"),
  });

  return {
    name: "telegram",

    canHandle(req) {
      return "x-telegram-bot-api-secret-token" in req.headers;
    },

    authenticate(req) {
      const secret = req.headers["x-telegram-bot-api-secret-token"];
      if (!verifyWebhookSecret(secret, webhookSecret)) {
        logWarn("Webhook secret verification failed");
        return false;
      }
      return true;
    },

    parse(req): ChannelParseResult {
      const update: TelegramUpdate = JSON.parse(req.body);
      const message = extractInboundMessage(update);
      const attachments = message ? extractTelegramAttachments(message, botToken, fetchHttps) : [];
      if (!message) {
        return { kind: "ignore" };
      }

      const parsed = transport.parseMessage(message);
      if (!parsed.text && attachments.length === 0) return { kind: "ignore" };

      if (!allowedChatIds.has(message.chat.id)) {
        logWarn("Chat not in allow list", { chatId: message.chat.id });
        return { kind: "ignore" };
      }

      return {
        kind: "message",
        message: {
          eventId: `${TELEGRAM_INTEGRATION_PREFIX}${update.update_id}`,
          conversationKey: `${TELEGRAM_INTEGRATION_PREFIX}${message.chat.id}`,
          channelName: "telegram",
          content: parsed.text || [],
          ...(attachments.length > 0 ? { attachments } : {}),
          source: {
            chatId: message.chat.id,
            messageId: parsed.id ?? `${message.chat.id}:${message.message_id}`,
            threadId: parsed.threadId ?? `telegram:${message.chat.id}`,
            fromUserId: message.from?.id,
            fromUsername: message.from?.username,
          } satisfies TelegramSource,
        },
      };
    },

    actions(msg): ChannelActions {
      return createTelegramActions(botToken, transport, toTelegramSource(msg.source), reactionEmoji);
    },
  };
}

function extractTelegramAttachments(
  message: TelegramMessage,
  botToken: string,
  fetchHttps: typeof pinnedHttpsFetch,
): InboundAttachmentCandidate[] {
  const raw = message as TelegramMessage & Record<string, unknown>;
  const candidates: Array<{ value: unknown; kind: InboundAttachmentCandidate["kind"] }> = [
    { value: raw.document, kind: "file" },
    { value: raw.video, kind: "video" },
    { value: raw.voice, kind: "audio" },
    { value: raw.audio, kind: "audio" },
    { value: raw.animation, kind: "gif" },
  ];
  if (Array.isArray(raw.photo) && raw.photo.length > 0) {
    candidates.unshift({ value: raw.photo.at(-1), kind: "image" });
  }

  return candidates.flatMap(({ value, kind }) => {
    if (!value || typeof value !== "object") return [];
    const file = value as Record<string, unknown>;
    if (typeof file.file_id !== "string") return [];
    const fileId = file.file_id;
    return [{
      id: fileId,
      kind,
      ...(typeof file.file_name === "string" ? { filename: file.file_name } : {}),
      ...(typeof file.mime_type === "string" ? { mediaType: file.mime_type } : {}),
      ...(typeof file.file_size === "number" ? { size: file.file_size } : {}),
      async resolveDownload() {
        return resolveTelegramFileDownload(botToken, fileId, fetchHttps);
      },
    } satisfies InboundAttachmentCandidate];
  });
}

export async function resolveTelegramFileDownload(
  botToken: string,
  fileId: string,
  fetchHttps: typeof pinnedHttpsFetch = pinnedHttpsFetch,
): Promise<{ url: string; allowedHosts: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_METADATA_TIMEOUT_MS);
  let url = new URL(`https://${TELEGRAM_API_HOST}/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);

  try {
    for (let redirect = 0; redirect <= TELEGRAM_METADATA_MAX_REDIRECTS; redirect += 1) {
      if (url.protocol !== "https:" || url.hostname !== TELEGRAM_API_HOST || url.port || url.username || url.password || url.hash) {
        throw new Error("Telegram getFile failed");
      }
      const response = await fetchHttps(url, { redirect: "manual", signal: controller.signal }, {
        allowedHosts: [TELEGRAM_API_HOST],
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        if (!location || redirect === TELEGRAM_METADATA_MAX_REDIRECTS) throw new Error("Telegram getFile failed");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Telegram getFile failed");
      }
      const body = JSON.parse(new TextDecoder().decode(await readTelegramMetadataBody(response))) as {
        ok?: boolean;
        result?: { file_path?: string };
      };
      const path = body.result?.file_path;
      if (body.ok !== true || !path || path.includes("..") || path.startsWith("/")) throw new Error("Telegram getFile failed");
      return {
        url: `https://${TELEGRAM_API_HOST}/file/bot${botToken}/${path}`,
        allowedHosts: [TELEGRAM_API_HOST],
      };
    }
    throw new Error("Telegram getFile failed");
  } catch {
    throw new Error("Telegram getFile failed");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function readTelegramMetadataBody(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > TELEGRAM_METADATA_MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Telegram getFile failed");
  }
  if (!response.body) throw new Error("Telegram getFile failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > TELEGRAM_METADATA_MAX_BYTES) throw new Error("Telegram getFile failed");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createTelegramActions(
  botToken: string,
  transport: TelegramAdapter,
  source: TelegramSource,
  reactionEmoji: string,
): ChannelActions {
  return {
    sendText: (text) => sendMessage(botToken, source.chatId, text),
    sendTyping: () => transport.startTyping(source.threadId),
    reactToMessage: () => transport.addReaction(source.threadId, source.messageId, reactionEmoji),
    addReaction: (emoji) => transport.addReaction(source.threadId, source.messageId, emoji),
    async sendArtifacts(artifacts, text) {
      for (const [index, artifact] of artifacts.entries()) {
        const method = artifact.kind === "image" ? "sendPhoto"
          : artifact.kind === "gif" ? "sendAnimation"
          : artifact.kind === "video" ? "sendVideo"
          : artifact.kind === "audio" ? "sendAudio"
          : "sendDocument";
        const field = method.slice(4).toLowerCase();
        const form = new FormData();
        form.set("chat_id", String(source.chatId));
        form.set(field, new Blob([artifact.bytes], { type: artifact.mediaType }), artifact.filename);
        if (text && index === 0) form.set("caption", text);
        const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, { method: "POST", body: form });
        let body: { ok?: boolean; description?: string };
        try {
          body = await response.json() as { ok?: boolean; description?: string };
        } catch {
          throw new Error(`Telegram ${method} returned an invalid response (${response.status})`);
        }
        if (!response.ok || body.ok !== true) {
          throw new Error(`Telegram ${method} failed (${response.status}): ${body.description ?? "unknown_error"}`);
        }
      }
    },
    beginMessage: (text) => sendMessageReturningId(botToken, source.chatId, text),
    editMessage: (messageId, text) => editMessageText(botToken, source.chatId, messageId, text),
  };
}

function extractInboundMessage(update: TelegramUpdate): TelegramMessage | null {
  return update.message ?? update.edited_message ?? null;
}

function toTelegramSource(source: Record<string, unknown>): TelegramSource {
  if (
    typeof source.chatId !== "number" ||
    typeof source.messageId !== "string" ||
    typeof source.threadId !== "string"
  ) {
    throw new Error("Invalid Telegram source payload");
  }

  return {
    chatId: source.chatId,
    messageId: source.messageId,
    threadId: source.threadId,
    fromUserId: typeof source.fromUserId === "number" ? source.fromUserId : undefined,
    fromUsername: typeof source.fromUsername === "string" ? source.fromUsername : undefined,
  };
}
