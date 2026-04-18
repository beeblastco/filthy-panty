import type { SQSEvent, SQSBatchResponse, SQSRecord } from "aws-lambda";
import { processSqsBatch } from "../_shared/sqs.ts";
import { logInfo, logWarn } from "../_shared/log.ts";
import { requireEnv } from "../_shared/env.ts";
import { sendMessage } from "../_shared/telegram.ts";

const TELEGRAM_BOT_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");

interface OutboundMessage {
  conversationKey: string;
  text: string;
  channel: string;
  source: { chatId?: number; [key: string]: unknown };
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  return processSqsBatch(event, processRecord);
}

async function processRecord(record: SQSRecord): Promise<void> {
  const message: OutboundMessage = JSON.parse(record.body);

  if (message.channel !== "telegram") {
    logWarn("Unknown channel, message not delivered", { channel: message.channel });
    return;
  }

  const chatId = message.source.chatId;
  if (!chatId) throw new Error(`Missing chatId for conversation ${message.conversationKey}`);
  await sendMessage(TELEGRAM_BOT_TOKEN, chatId, message.text);

  logInfo("Outbound message sent", {
    conversationKey: message.conversationKey,
    channel: message.channel,
    textLength: message.text.length,
  });
}
