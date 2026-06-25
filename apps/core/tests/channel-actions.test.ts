/**
 * Channel action tests.
 * Cover outbound Discord, Slack, and Pancake reply branches here with mocked fetch calls.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createDiscordChannel } from "../functions/_shared/discord-channel.ts";
import { createPancakeChannel } from "../functions/_shared/pancake-channel.ts";
import { createSlackChannel } from "../functions/_shared/slack-channel.ts";
import { createTelegramChannel } from "../functions/_shared/telegram-channel.ts";
import { createZaloChannel } from "../functions/_shared/zalo-channel.ts";

type FetchInput = string | URL | Request;

interface FetchCall {
  input: FetchInput;
  init?: RequestInit;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("discord channel actions", () => {
  it("splits long replies, sends typing, and ignores reactions", async () => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(
      new Response("", { status: 200 }),
      new Response("", { status: 200 }),
      new Response("", { status: 204 }),
    );

    const actions = createDiscordChannel("bot-token", "public-key", null).actions(
      createMessage({
        applicationId: "app-1",
        interactionToken: "interaction-token",
        interactionId: "interaction-1",
        channelId: "channel-1",
      }),
    );

    await actions.sendText(`${"hello ".repeat(450)}tail`);
    await actions.sendTyping();
    await actions.reactToMessage();

    expect(fetchMock.calls).toHaveLength(3);
    expect(toUrl(fetchMock.calls[0]!.input)).toBe(
      "https://discord.com/api/v10/webhooks/app-1/interaction-token/messages/@original",
    );
    expect(fetchMock.calls[0]!.init?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchMock.calls[0]!.init?.body))).toMatchObject({
      allowed_mentions: { parse: [] },
    });

    expect(toUrl(fetchMock.calls[1]!.input)).toBe(
      "https://discord.com/api/v10/webhooks/app-1/interaction-token",
    );
    expect(fetchMock.calls[1]!.init?.method).toBe("POST");

    expect(toUrl(fetchMock.calls[2]!.input)).toBe(
      "https://discord.com/api/v10/channels/channel-1/typing",
    );
    expect(fetchMock.calls[2]!.init?.headers).toEqual({
      Authorization: "Bot bot-token",
    });
  });

  it("rethrows an interaction failure when no channel id is available to fall back to", async () => {
    const fetchMock = installFetchMock();
    const actions = createDiscordChannel("bot-token", "public-key", null).actions(
      createMessage({
        applicationId: "app-1",
        interactionToken: "interaction-token",
        interactionId: "interaction-1",
      }),
    );

    fetchMock.responses.push(new Response("boom", { status: 500 }));
    await expect(actions.sendText("hello")).rejects.toThrow(
      "Discord reply failed (500): boom",
    );
    expect(fetchMock.calls).toHaveLength(1);
  });

  it("falls back to a bot-token channel post when the interaction token has expired", async () => {
    const fetchMock = installFetchMock();
    const actions = createDiscordChannel("bot-token", "public-key", null).actions(
      createMessage({
        applicationId: "app-1",
        interactionToken: "expired-token",
        interactionId: "interaction-1",
        channelId: "channel-1",
      }),
    );

    // Interaction @original edit fails (token expired), bot-token channel post succeeds.
    fetchMock.responses.push(new Response("Unknown Webhook", { status: 404 }));
    fetchMock.responses.push(new Response("", { status: 200 }));

    await actions.sendText("job done");

    expect(fetchMock.calls).toHaveLength(2);
    expect(toUrl(fetchMock.calls[1]!.input)).toBe(
      "https://discord.com/api/v10/channels/channel-1/messages",
    );
    expect(fetchMock.calls[1]!.init?.method).toBe("POST");
    expect(fetchMock.calls[1]!.init?.headers).toMatchObject({
      Authorization: "Bot bot-token",
    });
    expect(JSON.parse(String(fetchMock.calls[1]!.init?.body))).toMatchObject({
      content: "job done",
      allowed_mentions: { parse: [] },
    });
  });

  it("surfaces a bot-token channel post failure", async () => {
    const fetchMock = installFetchMock();
    const actions = createDiscordChannel("bot-token", "public-key", null).actions(
      createMessage({
        applicationId: "app-1",
        interactionToken: "expired-token",
        interactionId: "interaction-1",
        channelId: "channel-1",
      }),
    );

    fetchMock.responses.push(new Response("Unknown Webhook", { status: 404 }));
    fetchMock.responses.push(new Response("missing access", { status: 403 }));
    await expect(actions.sendText("hello")).rejects.toThrow(
      "Discord channel message failed (403): missing access",
    );
  });

  it("throws when a Discord typing request fails", async () => {
    const fetchMock = installFetchMock();
    const actions = createDiscordChannel("bot-token", "public-key", null).actions(
      createMessage({
        applicationId: "app-1",
        interactionToken: "interaction-token",
        interactionId: "interaction-1",
        channelId: "channel-1",
      }),
    );

    fetchMock.responses.push(new Response("nope", { status: 403 }));
    await expect(actions.sendTyping()).rejects.toThrow(
      "Discord typing indicator failed (403): nope",
    );
  });

  it("skips typing without a channel id and rejects invalid source payloads", async () => {
    const fetchMock = installFetchMock();
    const adapter = createDiscordChannel("bot-token", "public-key", null);
    const actions = adapter.actions(
      createMessage({
        applicationId: "app-1",
        interactionToken: "interaction-token",
        interactionId: "interaction-1",
      }),
    );

    await actions.sendTyping();
    expect(fetchMock.calls).toHaveLength(0);

    expect(() =>
      adapter.actions(createMessage({
        applicationId: "app-1",
      })),
    ).toThrow("Invalid Discord source payload");
  });

  it("rejects more than Discord's documented ten attachments before building a request", async () => {
    const fetchMock = installFetchMock();
    const actions = createDiscordChannel("bot-token", "public-key", null).actions(
      createMessage({ applicationId: "app-1", interactionToken: "interaction-token", interactionId: "interaction-1" }),
    );
    const artifacts = Array.from({ length: 11 }, (_, index) => ({
      bytes: new Uint8Array([index]),
      filename: `${index}.txt`,
      mediaType: "text/plain",
      kind: "file" as const,
    }));

    await expect(actions.sendArtifacts!(artifacts)).rejects.toThrow("at most 10 attachments");
    expect(fetchMock.calls).toHaveLength(0);
  });
});

describe("slack channel actions", () => {
  it("posts to response_url payloads with formatted table attachments", async () => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(new Response("", { status: 200 }));

    const actions = createSlackChannel("bot-token", "signing-secret", null).actions(
      createMessage({
        teamId: "T1",
        channelId: "C1",
        responseUrl: "https://hooks.slack.test/response",
      }),
    );

    await actions.sendText("| Name | Value |\n| --- | --- |\n| Alpha | Beta |");

    expect(fetchMock.calls).toHaveLength(1);
    expect(toUrl(fetchMock.calls[0]!.input)).toBe("https://hooks.slack.test/response");
    expect(fetchMock.calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.calls[0]!.init?.body))).toEqual({
      text: " ",
      response_type: "in_channel",
      attachments: [{
        blocks: [{
          type: "table",
          column_settings: [{ is_wrapped: true }, null],
          rows: [
            [
              { type: "raw_text", text: "Name" },
              { type: "raw_text", text: "Value" },
            ],
            [
              { type: "raw_text", text: "Alpha" },
              { type: "raw_text", text: "Beta" },
            ],
          ],
        }],
      }],
    });
  });

  it("posts threaded Slack messages and reactions through the Web API", async () => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true }),
    );

    const actions = createSlackChannel("bot-token", "signing-secret", null).actions(
      createMessage({
        teamId: "T1",
        channelId: "C1",
        threadTs: "1713916800.000001",
        messageTs: "1713916800.000002",
      }),
    );

    await actions.sendText("hello slack");
    await actions.reactToMessage();
    await actions.sendTyping();

    expect(fetchMock.calls).toHaveLength(2);
    expect(toUrl(fetchMock.calls[0]!.input)).toBe("https://slack.com/api/chat.postMessage");
    expect(fetchMock.calls[0]!.init?.headers).toEqual({
      Authorization: "Bearer bot-token",
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(JSON.parse(String(fetchMock.calls[0]!.init?.body))).toEqual({
      channel: "C1",
      text: "hello slack",
      thread_ts: "1713916800.000001",
    });

    expect(toUrl(fetchMock.calls[1]!.input)).toBe("https://slack.com/api/reactions.add");
    expect(JSON.parse(String(fetchMock.calls[1]!.init?.body))).toEqual({
      channel: "C1",
      timestamp: "1713916800.000002",
      name: "eyes",
    });
  });

  it("skips Slack reactions without a message timestamp and rejects invalid source payloads", async () => {
    const fetchMock = installFetchMock();
    const adapter = createSlackChannel("bot-token", "signing-secret", null);
    const actions = adapter.actions(
      createMessage({
        teamId: "T1",
        channelId: "C1",
      }),
    );

    await actions.reactToMessage();
    await actions.sendTyping();
    expect(fetchMock.calls).toHaveLength(0);

    expect(() =>
      adapter.actions(createMessage({
        channelId: "C1",
      })),
    ).toThrow("Invalid Slack source payload");
  });

  it("throws on Slack response_url and Web API failures", async () => {
    const fetchMock = installFetchMock();
    const adapter = createSlackChannel("bot-token", "signing-secret", null);

    const responseUrlActions = adapter.actions(
      createMessage({
        teamId: "T1",
        channelId: "C1",
        responseUrl: "https://hooks.slack.test/response",
      }),
    );
    fetchMock.responses.push(new Response("", { status: 500 }));
    await expect(responseUrlActions.sendText("hello")).rejects.toThrow(
      "Slack response_url failed (500)",
    );

    const apiActions = adapter.actions(
      createMessage({
        teamId: "T1",
        channelId: "C1",
        messageTs: "1713916800.000002",
      }),
    );
    fetchMock.responses.push(jsonResponse({ ok: false, error: "channel_not_found" }, 200));
    await expect(apiActions.sendText("hello")).rejects.toThrow(
      "Slack chat.postMessage failed (200): channel_not_found",
    );

    fetchMock.responses.push(jsonResponse({ ok: false, error: "missing_scope" }, 403));
    await expect(apiActions.reactToMessage()).rejects.toThrow(
      "Slack reactions.add failed (403): missing_scope",
    );
  });

  it("checks every stage of Slack's external upload flow", async () => {
    const fetchMock = installFetchMock();
    const actions = createSlackChannel("bot-token", "signing-secret", null).actions(
      createMessage({ teamId: "T1", channelId: "C1" }),
    );
    const artifact = { bytes: new Uint8Array([1, 2, 3]), filename: "file.bin", mediaType: "application/octet-stream", kind: "file" as const };

    fetchMock.responses.push(jsonResponse({ ok: true, upload_url: "https://upload.slack.test/file", file_id: "F1" }));
    fetchMock.responses.push(new Response("upload failed", { status: 500 }));
    await expect(actions.sendArtifacts!([artifact])).rejects.toThrow("Slack file upload failed (500)");

    fetchMock.responses.push(jsonResponse({ ok: true, upload_url: "https://upload.slack.test/file", file_id: "F1" }));
    fetchMock.responses.push(new Response("OK", { status: 200 }));
    fetchMock.responses.push(jsonResponse({ ok: true, files: [] }));
    await expect(actions.sendArtifacts!([artifact])).rejects.toThrow("incomplete file list");
  });

  it("rejects oversized Slack artifacts before requesting an upload URL", async () => {
    const fetchMock = installFetchMock();
    const actions = createSlackChannel("bot-token", "signing-secret", null).actions(
      createMessage({ teamId: "T1", channelId: "C1" }),
    );
    const artifact = {
      bytes: new Uint8Array(20 * 1024 * 1024 + 1),
      filename: "large.bin",
      mediaType: "application/octet-stream",
      kind: "file" as const,
    };

    await expect(actions.sendArtifacts!([artifact])).rejects.toThrow("20971520 byte limit");
    expect(fetchMock.calls).toHaveLength(0);
  });
});

describe("telegram channel actions", () => {
  it("requires a successful Telegram API response body for attachment sends", async () => {
    const fetchMock = installFetchMock();
    const actions = createTelegramChannel("bot-token", "secret", new Set([123]), "eyes").actions(
      createMessage({ chatId: 123, messageId: "123:1", threadId: "telegram:123" }),
    );
    const artifact = { bytes: new Uint8Array([1]), filename: "file.bin", mediaType: "application/octet-stream", kind: "file" as const };

    fetchMock.responses.push(jsonResponse({ ok: false, description: "file rejected" }));
    await expect(actions.sendArtifacts!([artifact])).rejects.toThrow("Telegram sendDocument failed (200): file rejected");

    fetchMock.responses.push(new Response("not json", { status: 200 }));
    await expect(actions.sendArtifacts!([artifact])).rejects.toThrow("returned an invalid response");
  });
});

describe("pancake channel actions", () => {
  it("sends inbox replies through Pancake's page message API", async () => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(jsonResponse({ success: true, id: "reply-1" }));

    const actions = createPancakeChannel("page-1", "page-token", "hook-secret", "sender-1").actions(
      createMessage({
        pageId: "page-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        messageType: "INBOX",
      }),
    );

    await actions.sendText("hello inbox");
    await actions.sendTyping();
    await actions.reactToMessage();

    expect(fetchMock.calls).toHaveLength(1);
    expect(toUrl(fetchMock.calls[0]!.input)).toBe(
      "https://pages.fm/api/public_api/v1/pages/page-1/conversations/conversation-1/messages?page_access_token=page-token",
    );
    expect(fetchMock.calls[0]!.init?.method).toBe("POST");
    expect(fetchMock.calls[0]!.init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(fetchMock.calls[0]!.init?.body))).toEqual({
      action: "reply_inbox",
      message: "hello inbox",
      sender_id: "sender-1",
    });
  });

  it("sends comment replies with the source message id", async () => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(jsonResponse({ success: true, id: "reply-1" }));

    const actions = createPancakeChannel("page-1", "page-token", "hook-secret").actions(
      createMessage({
        pageId: "page-1",
        conversationId: "conversation-1",
        messageId: "comment-1",
        messageType: "COMMENT",
      }),
    );

    await actions.sendText("hello comment");

    expect(fetchMock.calls).toHaveLength(1);
    expect(JSON.parse(String(fetchMock.calls[0]!.init?.body))).toEqual({
      action: "reply_comment",
      message_id: "comment-1",
      message: "hello comment",
    });
  });

  it("uploads inbox photos and sends the returned content id before a separate caption", async () => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(
      jsonResponse({ success: true, id: "content-1", attachment_type: "PHOTO" }),
      jsonResponse({ success: true, id: "media-message" }),
      jsonResponse({ success: true, id: "caption-message" }),
    );
    const actions = createPancakeChannel("page-1", "page-token", "hook-secret", "sender-1").actions(
      createMessage({ pageId: "page-1", conversationId: "conversation-1", messageId: "message-1", messageType: "INBOX" }),
    );

    await actions.sendArtifacts!([{
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      filename: "photo.jpg",
      mediaType: "image/jpeg",
      kind: "image",
    }], "A caption");

    expect(fetchMock.calls).toHaveLength(3);
    expect(toUrl(fetchMock.calls[0]!.input)).toBe(
      "https://pages.fm/api/public_api/v1/pages/page-1/upload_contents?page_access_token=page-token",
    );
    const form = fetchMock.calls[0]!.init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect((form.get("file") as File).name).toBe("photo.jpg");
    expect(JSON.parse(String(fetchMock.calls[1]!.init?.body))).toEqual({
      action: "reply_inbox",
      content_ids: ["content-1"],
      sender_id: "sender-1",
    });
    expect(JSON.parse(String(fetchMock.calls[2]!.init?.body))).toEqual({
      action: "reply_inbox",
      message: "A caption",
      sender_id: "sender-1",
    });
  });

  it("limits Pancake media safely and does not expose ambiguous comment uploads", async () => {
    const fetchMock = installFetchMock();
    const adapter = createPancakeChannel("page-1", "page-token", "hook-secret");
    const inbox = adapter.actions(createMessage({
      pageId: "page-1", conversationId: "conversation-1", messageId: "message-1", messageType: "INBOX",
    }));
    await expect(inbox.sendArtifacts!([{
      bytes: new Uint8Array(15 * 1024 * 1024 + 1),
      filename: "video.mp4",
      mediaType: "video/mp4",
      kind: "video",
    }])).rejects.toThrow("15 MiB");
    await expect(inbox.sendArtifacts!([{
      bytes: new Uint8Array([1]), filename: "file.pdf", mediaType: "application/pdf", kind: "file",
    }])).rejects.toThrow("photo and video only");
    expect(fetchMock.calls).toHaveLength(0);

    const comment = adapter.actions(createMessage({
      pageId: "page-1", conversationId: "conversation-1", messageId: "comment-1", messageType: "COMMENT",
    }));
    expect(comment.sendArtifacts).toBeUndefined();
  });

  it("requires a successful Pancake upload response with a content id", async () => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(jsonResponse({ success: true }));
    const actions = createPancakeChannel("page-1", "page-token", "hook-secret").actions(createMessage({
      pageId: "page-1", conversationId: "conversation-1", messageId: "message-1", messageType: "INBOX",
    }));
    await expect(actions.sendArtifacts!([{
      bytes: new Uint8Array([0xff, 0xd8, 0xff]), filename: "photo.jpg", mediaType: "image/jpeg", kind: "image",
    }])).rejects.toThrow("Pancake upload content failed");
    expect(fetchMock.calls).toHaveLength(1);
  });

  it("throws on Pancake API failures and rejects invalid source payloads", async () => {
    const fetchMock = installFetchMock();
    const adapter = createPancakeChannel("page-1", "page-token", "hook-secret");
    const actions = adapter.actions(
      createMessage({
        pageId: "page-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        messageType: "INBOX",
      }),
    );

    fetchMock.responses.push(jsonResponse({ success: false, message: "permission denied" }, 200));
    await expect(actions.sendText("hello")).rejects.toThrow(
      "Pancake send message failed (200): permission denied",
    );

    expect(() =>
      adapter.actions(createMessage({
        pageId: "page-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        messageType: "UNKNOWN",
      })),
    ).toThrow("Invalid Pancake source payload");
  });
});

describe("zalo channel actions", () => {
  it("sends text chunks and typing through the Zalo Bot API", async () => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(
      jsonResponse({ ok: true, result: { message_id: "reply-1" } }),
      jsonResponse({ ok: true, result: { message_id: "reply-2" } }),
      jsonResponse({ ok: true, result: true }),
    );

    const actions = createZaloChannel("bot-token", "zalo-secret", new Set(["user-1"])).actions(
      createMessage({
        chatId: "chat-1",
        chatType: "PRIVATE",
        messageId: "message-1",
        senderId: "user-1",
        eventName: "message.text.received",
      }),
    );

    await actions.sendText(`${"a".repeat(2000)}b`);
    await actions.sendTyping();
    await actions.reactToMessage();

    expect(fetchMock.calls).toHaveLength(3);
    expect(toUrl(fetchMock.calls[0]!.input)).toBe(
      "https://bot-api.zaloplatforms.com/botbot-token/sendMessage",
    );
    expect(fetchMock.calls[0]!.init?.method).toBe("POST");
    expect(fetchMock.calls[0]!.init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(fetchMock.calls[0]!.init?.body))).toEqual({
      chat_id: "chat-1",
      text: "a".repeat(2000),
    });
    expect(JSON.parse(String(fetchMock.calls[1]!.init?.body))).toEqual({
      chat_id: "chat-1",
      text: "b",
    });
    expect(toUrl(fetchMock.calls[2]!.input)).toBe(
      "https://bot-api.zaloplatforms.com/botbot-token/sendChatAction",
    );
    expect(JSON.parse(String(fetchMock.calls[2]!.init?.body))).toEqual({
      chat_id: "chat-1",
      action: "typing",
    });
  });

  it("throws on Zalo API failures and rejects invalid source payloads", async () => {
    const fetchMock = installFetchMock();
    const adapter = createZaloChannel("bot-token", "zalo-secret", new Set(["user-1"]));
    const actions = adapter.actions(
      createMessage({
        chatId: "chat-1",
        chatType: "PRIVATE",
        messageId: "message-1",
        senderId: "user-1",
        eventName: "message.text.received",
      }),
    );

    fetchMock.responses.push(jsonResponse({ ok: false, description: "permission denied" }, 200));
    await expect(actions.sendText("hello")).rejects.toThrow(
      "Zalo sendMessage failed (200): permission denied",
    );

    expect(() =>
      adapter.actions(createMessage({
        chatId: "chat-1",
        chatType: "GROUP",
        messageId: "message-1",
        senderId: "user-1",
        eventName: "message.text.received",
      })),
    ).toThrow("Invalid Zalo source payload");
  });
});

function createMessage(source: Record<string, unknown>) {
  return {
    eventId: "event-1",
    conversationKey: "conversation-1",
    channelName: "test",
    content: [],
    source,
  };
}

function installFetchMock() {
  const calls: FetchCall[] = [];
  const responses: Response[] = [];

  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    calls.push({ input, init });
    const response = responses.shift();
    if (!response) {
      throw new Error(`Unexpected fetch: ${toUrl(input)}`);
    }
    return response;
  }) as unknown as typeof fetch;

  return { calls, responses };
}

function toUrl(input: FetchInput): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
