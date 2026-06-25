/**
 * Slack channel adapter.
 * Handle request verification, inbound normalization, and Slack Web API reply actions here.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelParseResult,
  InboundAttachmentCandidate,
} from "./channels.ts";
import { assertOutboundArtifactLimits } from "./channels.ts";
import { formatSlackMessage } from "./channel-format.ts";
import { logWarn } from "./log.ts";
import {
  SLACK_COMMAND_INTEGRATION_PREFIX,
  SLACK_INTEGRATION_PREFIX,
} from "./runtime-keys.ts";

interface SlackEventEnvelope {
  type: string;
  event_id?: string;
  team_id?: string;
  challenge?: string;
  event?: {
    type?: string;
    subtype?: string;
    text?: string;
    channel?: string;
    channel_type?: string;
    user?: string;
    bot_id?: string;
    ts?: string;
    thread_ts?: string;
    files?: SlackFile[];
  };
}

interface SlackFile {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
  mode?: string;
}

export interface SlackSource {
  teamId: string;
  channelId: string;
  threadTs?: string;
  messageTs?: string;
  responseUrl?: string;
  commandToken?: string;
  userId?: string;
}

export function createSlackChannel(
  botToken: string,
  signingSecret: string,
  allowedChannelIds: Set<string> | null,
): ChannelAdapter {
  return {
    name: "slack",

    canHandle(req) {
      return "x-slack-signature" in req.headers;
    },

    authenticate(req) {
      const timestamp = req.headers["x-slack-request-timestamp"];
      const signature = req.headers["x-slack-signature"];
      if (!timestamp || !signature) {
        return false;
      }

      const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
      if (!Number.isFinite(ageSeconds) || ageSeconds > 60 * 5) {
        logWarn("Slack request timestamp outside replay window");
        return false;
      }

      const base = `v0:${timestamp}:${req.body}`;
      const expected = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
      const actualBytes = Buffer.from(signature);
      const expectedBytes = Buffer.from(expected);

      return actualBytes.length === expectedBytes.length
        && timingSafeEqual(actualBytes, expectedBytes);
    },

    parse(req): ChannelParseResult {
      const contentType = req.headers["content-type"] ?? "";

      if (contentType.includes("application/x-www-form-urlencoded")) {
        return parseSlashCommand(req.body, allowedChannelIds);
      }

      return parseEventCallback(req.body, allowedChannelIds, botToken);
    },

    actions(msg): ChannelActions {
      return createSlackActions(botToken, toSlackSource(msg.source));
    },
  };
}

function parseEventCallback(
  body: string,
  allowedChannelIds: Set<string> | null,
  botToken: string,
): ChannelParseResult {
  const payload = JSON.parse(body) as SlackEventEnvelope;

  if (payload.type === "url_verification" && typeof payload.challenge === "string") {
    return {
      kind: "response",
      response: {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge: payload.challenge }),
      },
    };
  }

  if (payload.type !== "event_callback" || !payload.event || !payload.event_id || !payload.team_id) {
    return { kind: "ignore" };
  }

  if (!isSupportedSlackEvent(payload.event)) {
    return { kind: "ignore" };
  }

  const channelId = payload.event.channel;
  const ts = payload.event.ts;
  if (!channelId || !ts) {
    return { kind: "ignore" };
  }

  if (allowedChannelIds && !allowedChannelIds.has(channelId)) {
    logWarn("Slack channel not in allow list", { channelId });
    return { kind: "ignore" };
  }

  const text = stripSlackMentions(payload.event.text ?? "");
  const attachments = extractSlackAttachments(payload.event.files, botToken);
  const threadTs = payload.event.thread_ts ?? ts;
  const replyThreadTs = getSlackReplyThreadTs(payload.event, ts);

  return {
    kind: "message",
    ack: { statusCode: 200 },
    message: {
      eventId: `${SLACK_INTEGRATION_PREFIX}${payload.event_id}`,
      conversationKey: getSlackConversationKey(payload.team_id, channelId, payload.event, threadTs),
      channelName: "slack",
      content: text ? [{ type: "text", text }] : [],
      ...(attachments.length > 0 ? { attachments } : {}),
      source: {
        teamId: payload.team_id,
        channelId,
        messageTs: ts,
        threadTs: replyThreadTs,
        userId: payload.event.user,
      } satisfies SlackSource,
    },
  };
}

function isSupportedSlackEvent(event: NonNullable<SlackEventEnvelope["event"]>): boolean {
  if ((event.subtype && event.subtype !== "file_share") || event.bot_id) {
    return false;
  }

  if (event.type === "app_mention") {
    return true;
  }

  return event.type === "message" && (event.channel_type === "im" || event.channel_type === "app_home");
}

function extractSlackAttachments(files: SlackFile[] | undefined, botToken: string): InboundAttachmentCandidate[] {
  return (files ?? []).flatMap((file) => {
    const url = file.url_private_download ?? file.url_private;
    if (!file.id) return [];
    const mediaType = file.mimetype;
    return [{
      id: file.id,
      kind: mediaKind(mediaType),
      ...(file.name ? { filename: file.name } : {}),
      ...(mediaType ? { mediaType } : {}),
      ...(typeof file.size === "number" ? { size: file.size } : {}),
      async resolveDownload() {
        if (!url || file.mode === "external") throw new Error("Slack file is not downloadable");
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();
        if (parsed.protocol !== "https:" || !isSlackMediaHost(hostname)) {
          throw new Error("Slack file host is not allowed");
        }
        return {
          url: parsed.href,
          headers: { Authorization: `Bearer ${botToken}` },
          allowedHosts: [hostname],
        };
      },
    } satisfies InboundAttachmentCandidate];
  });
}

function isSlackMediaHost(hostname: string): boolean {
  return ["slack.com", "slack-files.com", "slack-edge.com"].some((base) =>
    hostname === base || hostname.endsWith(`.${base}`)
  );
}

function mediaKind(mediaType: string | undefined): InboundAttachmentCandidate["kind"] {
  if (mediaType === "image/gif") return "gif";
  if (mediaType?.startsWith("image/")) return "image";
  if (mediaType?.startsWith("video/")) return "video";
  if (mediaType?.startsWith("audio/")) return "audio";
  return "file";
}

function getSlackConversationKey(
  teamId: string,
  channelId: string,
  event: NonNullable<SlackEventEnvelope["event"]>,
  threadTs: string,
): string {
  if (event.type === "message" && (event.channel_type === "im" || event.channel_type === "app_home")) {
    return `${SLACK_INTEGRATION_PREFIX}${teamId}:${channelId}`;
  }

  return `${SLACK_INTEGRATION_PREFIX}${teamId}:${channelId}:${threadTs}`;
}

function getSlackReplyThreadTs(
  event: NonNullable<SlackEventEnvelope["event"]>,
  messageTs: string,
): string | undefined {
  if (event.type === "app_mention") {
    return event.thread_ts ?? messageTs;
  }

  return event.thread_ts;
}

function parseSlashCommand(
  body: string,
  allowedChannelIds: Set<string> | null,
): ChannelParseResult {
  const params = new URLSearchParams(body);
  const teamId = params.get("team_id");
  const channelId = params.get("channel_id");
  const command = params.get("command");

  if (!teamId || !channelId || !command) {
    return { kind: "ignore" };
  }

  if (allowedChannelIds && !allowedChannelIds.has(channelId)) {
    logWarn("Slack slash command channel not in allow list", { channelId });
    return { kind: "ignore" };
  }

  const text = params.get("text") ?? "";

  return {
    kind: "message",
    ack: { statusCode: 200 },
    message: {
      eventId: `${SLACK_COMMAND_INTEGRATION_PREFIX}${params.get("trigger_id") ?? `${teamId}:${channelId}:${command}:${text}`}`,
      conversationKey: `${SLACK_INTEGRATION_PREFIX}${teamId}:${channelId}`,
      channelName: "slack",
      content: [{ type: "text", text }],
      source: {
        teamId,
        channelId,
        responseUrl: params.get("response_url") ?? undefined,
        commandToken: command,
        userId: params.get("user_id") ?? undefined,
      } satisfies SlackSource,
    },
  };
}

function createSlackActions(
  botToken: string,
  source: SlackSource,
): ChannelActions {
  const artifactLimits = {
    maxBytesPerArtifact: 20 * 1024 * 1024,
    maxTotalBytes: 20 * 1024 * 1024,
  } as const;
  return {
    artifactLimits,
    async sendText(text) {
      const formattedMessage = formatSlackMessage(text);

      if (source.responseUrl) {
        const response = await fetch(source.responseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: formattedMessage.text,
            response_type: "in_channel",
            ...(formattedMessage.attachments ? { attachments: formattedMessage.attachments } : {}),
          }),
        });
        if (!response.ok) {
          throw new Error(`Slack response_url failed (${response.status})`);
        }
        return;
      }

      await slackApi(botToken, "chat.postMessage", {
        channel: source.channelId,
        text: formattedMessage.text,
        ...(formattedMessage.attachments ? { attachments: formattedMessage.attachments } : {}),
        ...(source.threadTs ? { thread_ts: source.threadTs } : {}),
      });
    },

    async sendTyping() {
      return;
    },

    async reactToMessage() {
      if (!source.messageTs) {
        return;
      }

      await slackApi(botToken, "reactions.add", {
        channel: source.channelId,
        timestamp: source.messageTs,
        name: "eyes",
      });
    },

    async addReaction(emoji) {
      if (!source.messageTs) throw new Error("Slack reaction requires a source message");
      await slackApi(botToken, "reactions.add", {
        channel: source.channelId,
        timestamp: source.messageTs,
        name: emoji.replace(/^:|:$/g, ""),
      });
    },

    async sendArtifacts(artifacts, text) {
      assertOutboundArtifactLimits(artifacts, artifactLimits);
      const files: Array<{ id: string; title: string }> = [];
      for (const artifact of artifacts) {
        const upload = await slackApi(botToken, "files.getUploadURLExternal", {
          filename: artifact.filename,
          length: artifact.bytes.byteLength,
        }) as { upload_url?: string; file_id?: string };
        if (!upload.upload_url || !upload.file_id) throw new Error("Slack did not return an upload URL");
        const response = await fetch(upload.upload_url, {
          method: "POST",
          headers: { "Content-Type": artifact.mediaType },
          body: artifact.bytes,
        });
        const uploadBody = await response.text();
        if (!response.ok || !uploadBody.startsWith("OK")) {
          throw new Error(`Slack file upload failed (${response.status}): ${uploadBody || "unknown_error"}`);
        }
        files.push({ id: upload.file_id, title: artifact.filename });
      }
      const completed = await slackApi(botToken, "files.completeUploadExternal", {
        files,
        channel_id: source.channelId,
        ...(text ? { initial_comment: text } : {}),
        ...(source.threadTs ? { thread_ts: source.threadTs } : {}),
      });
      if (!Array.isArray(completed.files) || completed.files.length !== files.length) {
        throw new Error("Slack files.completeUploadExternal returned an incomplete file list");
      }
    },

    // Edit-in-place streaming. Always posts to the channel/thread (chat.update
    // cannot edit a response_url message) and returns the new message ts.
    async beginMessage(text) {
      const result = await slackApi(botToken, "chat.postMessage", {
        channel: source.channelId,
        text: formatSlackMessage(text).text,
        ...(source.threadTs ? { thread_ts: source.threadTs } : {}),
      });
      if (!result.ts) throw new Error("Slack chat.postMessage returned no ts");
      return result.ts;
    },

    async editMessage(messageTs, text) {
      await slackApi(botToken, "chat.update", {
        channel: source.channelId,
        ts: messageTs,
        text: formatSlackMessage(text).text,
      });
    },
  };
}

function toSlackSource(source: Record<string, unknown>): SlackSource {
  if (
    typeof source.teamId !== "string" ||
    typeof source.channelId !== "string"
  ) {
    throw new Error("Invalid Slack source payload");
  }

  return {
    teamId: source.teamId,
    channelId: source.channelId,
    threadTs: typeof source.threadTs === "string" ? source.threadTs : undefined,
    messageTs: typeof source.messageTs === "string" ? source.messageTs : undefined,
    responseUrl: typeof source.responseUrl === "string" ? source.responseUrl : undefined,
    commandToken: typeof source.commandToken === "string" ? source.commandToken : undefined,
    userId: typeof source.userId === "string" ? source.userId : undefined,
  };
}

async function slackApi(
  token: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<{ ok?: boolean; error?: string; ts?: string; [key: string]: unknown }> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  const json = await response.json() as { ok?: boolean; error?: string; ts?: string };
  if (!response.ok || !json.ok) {
    throw new Error(
      `Slack ${method} failed (${response.status}): ${json.error ?? "unknown_error"}`,
    );
  }
  return json;
}

function stripSlackMentions(text: string): string {
  return text.replace(/<@[^>]+>/g, "").trim();
}
