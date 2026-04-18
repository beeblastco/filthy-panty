import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { requireEnv } from "../_shared/env.ts";
import { logError, logInfo } from "../_shared/log.ts";
import { parseCommand, executeCommand } from "../_shared/commands.ts";
import type { ChannelAdapter } from "../_shared/channels.ts";
import { createTelegramChannel } from "../_shared/telegram-channel.ts";

const sqs = new SQSClient({});
const INBOUND_QUEUE_URL = requireEnv("INBOUND_QUEUE_URL");
const CONVERSATIONS_TABLE_NAME = requireEnv("CONVERSATIONS_TABLE_NAME");

function parseAllowedChatIds(raw: string): Set<number> {
  const ids = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  if (ids.length === 0) throw new Error("ALLOWED_CHAT_IDS contains no valid numeric IDs");
  return new Set(ids);
}

const channels: ChannelAdapter[] = [
  createTelegramChannel(
    requireEnv("TELEGRAM_BOT_TOKEN"),
    requireEnv("TELEGRAM_WEBHOOK_SECRET"),
    parseAllowedChatIds(requireEnv("ALLOWED_CHAT_IDS")),
  ),
];

interface LambdaUrlEvent {
  requestContext: {
    http: { method: string; path: string };
  };
  headers: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

interface LambdaUrlResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

function ok(data: Record<string, unknown> = {}): LambdaUrlResponse {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, ...data }),
  };
}

export async function handler(event: LambdaUrlEvent): Promise<LambdaUrlResponse> {
  const method = event.requestContext.http.method;

  if (method === "GET") {
    return ok({ service: "filthy-panty" });
  }

  if (method !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const body = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf-8")
      : (event.body ?? "");

    const adapter = channels.find((ch) => ch.authenticate(event.headers, body));
    if (!adapter) {
      return { statusCode: 401, body: "Unauthorized" };
    }

    const msg = adapter.parse(body);
    if (!msg) {
      return ok({ skipped: "no_actionable_message" });
    }

    const channel = adapter.actions(msg);

    const command = parseCommand(msg.content);
    if (command) {
      await executeCommand(command, {
        conversationKey: msg.conversationKey,
        conversationsTableName: CONVERSATIONS_TABLE_NAME,
        channel,
      });
      return ok({ command });
    }

    channel.sendTyping().catch(() => {});
    channel.reactToMessage().catch(() => {});

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: INBOUND_QUEUE_URL,
        MessageBody: JSON.stringify({
          eventId: msg.eventId,
          conversationKey: msg.conversationKey,
          channel: msg.channelName,
          content: msg.content,
          source: msg.source,
        }),
      }),
    );

    logInfo("Event enqueued", {
      channel: msg.channelName,
      eventId: msg.eventId,
      conversationKey: msg.conversationKey,
    });
    return ok();
  } catch (err) {
    logError("Failed to process inbound event", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { statusCode: 500, body: "Internal Server Error" };
  }
}
