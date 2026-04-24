/**
 * Telegram transport helpers.
 * Telegram low-level API calls and formatting.
 */

import { timingSafeEqual } from "node:crypto";
import { formatTelegramHtml } from "./channel-format.ts";

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: {
    id: number;
    first_name: string;
    username?: string;
    is_bot: boolean;
  };
  chat: {
    id: number;
    type: string;
  };
  date: number;
  text?: string;
}

export function verifyWebhookSecret(
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function splitHtmlChunks(html: string, maxLen: number = 4096): string[] {
  if (html.length <= maxLen) return [html];
  const chunks: string[] = [];
  let remaining = html;
  while (remaining) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

export async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
): Promise<void> {
  const html = formatTelegramHtml(text);
  const chunks = splitHtmlChunks(html);

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  for (const chunk of chunks) {
    let response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: "HTML" }),
    });
    if (!response.ok) {
      const plain = chunk.replace(/<[^>]*>/g, "").trim() || "(empty message)";
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: plain }),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Telegram sendMessage failed (${response.status}): ${body}`);
      }
    }
  }
}
