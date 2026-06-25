/**
 * Pancake channel adapter tests.
 * Cover webhook normalization and page-scoped filtering here.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createPancakeChannel } from "../functions/_shared/pancake-channel.ts";

const ORIGINAL_FETCH = globalThis.fetch;

describe("pancake channel adapter", () => {
  beforeEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("normalizes messaging events into page-scoped conversations", async () => {
    const adapter = createPancakeChannel("page-1", "page-token", "hook-secret");
    const parsed = await adapter.parse(createPancakeRequest({
      page_id: "page-1",
      event_type: "messaging",
      data: {
        conversation: {
          id: "conversation-1",
          type: "INBOX",
          from: { id: "customer-1", name: "Ada" },
        },
        message: {
          id: "message-1",
          conversation_id: "conversation-1",
          page_id: "page-1",
          message: "hello pancake",
          type: "INBOX",
          from: {
            id: "customer-1",
            name: "Ada",
            page_customer_id: "page-customer-1",
          },
        },
      },
    }));

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected Pancake message event to be accepted");
    }

    expect(parsed.ack).toEqual({ statusCode: 200 });
    expect(parsed.message.eventId).toBe(`pancake:page-1:message-1:${hashText("hello pancake")}`);
    expect(parsed.message.conversationKey).toBe("pancake:page-1:conversation-1");
    expect(parsed.message.channelName).toBe("pancake");
    expect(parsed.message.content).toEqual([{ type: "text", text: "hello pancake" }]);
    expect(parsed.message.source).toMatchObject({
      pageId: "page-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      messageType: "INBOX",
      fromId: "customer-1",
      fromName: "Ada",
      pageCustomerId: "page-customer-1",
    });
  });

  it("carries comment source fields for comment replies", async () => {
    const adapter = createPancakeChannel("page-1", "page-token", "hook-secret");
    const parsed = await adapter.parse(createPancakeRequest({
      page_id: "page-1",
      event_type: "messaging",
      data: {
        conversation: { id: "comment-conversation", type: "COMMENT" },
        message: {
          id: "comment-1",
          conversation_id: "comment-conversation",
          page_id: "page-1",
          message: "price?",
          type: "COMMENT",
          from: {
            id: "customer-1",
            name: "Ada",
            page_customer_id: "page-customer-1",
          },
        },
        post: { id: "post-1" },
      },
    }));

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected Pancake comment event to be accepted");
    }

    expect(parsed.message.source).toMatchObject({
      messageType: "COMMENT",
      messageId: "comment-1",
      postId: "post-1",
    });
  });

  it("accepts media-only photo and video messages as guarded attachment candidates", async () => {
    const adapter = createPancakeChannel("page-1", "page-token", "hook-secret");
    const parsed = await adapter.parse(createPancakeRequest(validPayload({
      message: {
        message: "<div></div>",
        attachments: [
          {
            id: "photo-1",
            type: "photo",
            url: "https://cdn.example.com/photo.jpg",
            title: "photo.jpg",
            mime_type: "image/jpeg",
          },
          {
            id: "video-1",
            type: "video",
            url: "https://cdn.example.com/thumbnail.jpg",
            video_data: { url: "https://video.example.com/video.mp4" },
            mime_type: "video/mp4",
          },
        ],
      },
    })));

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") throw new Error("Expected media-only Pancake message");
    expect(parsed.message.content).toEqual([]);
    expect(parsed.message.attachments?.map(({ resolveDownload: _resolve, ...candidate }) => candidate)).toEqual([
      { id: "photo-1", kind: "image", filename: "photo.jpg", mediaType: "image/jpeg" },
      { id: "video-1", kind: "video", mediaType: "video/mp4" },
    ]);
    expect(await parsed.message.attachments?.[0]?.resolveDownload()).toEqual({
      url: "https://cdn.example.com/photo.jpg",
      allowedHosts: ["cdn.example.com"],
    });
    expect(await parsed.message.attachments?.[1]?.resolveDownload()).toEqual({
      url: "https://video.example.com/video.mp4",
      allowedHosts: ["video.example.com"],
    });
  });

  it("ignores unsupported attachment shapes and rejects unsafe media URLs at resolution", async () => {
    const adapter = createPancakeChannel("page-1", "page-token", "hook-secret");
    const unsupported = await adapter.parse(createPancakeRequest(validPayload({
      message: { message: " ", attachments: [{ id: "doc-1", type: "document", url: "https://cdn.example.com/a.pdf" }] },
    })));
    expect(unsupported).toEqual({ kind: "ignore" });
    expect(await adapter.parse(createPancakeRequest(validPayload({
      message: { message: " ", attachments: [null, "bad", { type: "photo", url: 42, title: 7 }] },
    })))).toEqual({ kind: "ignore" });

    const unsafe = await adapter.parse(createPancakeRequest(validPayload({
      message: { message: " ", attachments: [{ id: "photo-1", type: "photo", url: "http://127.0.0.1/photo.jpg" }] },
    })));
    expect(unsafe.kind).toBe("message");
    if (unsafe.kind !== "message") throw new Error("Expected candidate to degrade during ingestion");
    await expect(unsafe.message.attachments![0]!.resolveDownload()).rejects.toThrow("HTTPS URL destination");
  });

  it("ignores non-message events, wrong pages, empty text, and page-originated messages", async () => {
    const adapter = createPancakeChannel("page-1", "page-token", "hook-secret");

    expect(await adapter.parse(createPancakeRequest({ event_type: "post", page_id: "page-1" }))).toEqual({
      kind: "ignore",
    });
    expect(await adapter.parse(createPancakeRequest(validPayload({ page_id: "page-2" })))).toEqual({
      kind: "ignore",
    });
    expect(await adapter.parse(createPancakeRequest(validPayload({ message: { message: "   " } })))).toEqual({
      kind: "ignore",
    });
    expect(await adapter.parse(createPancakeRequest(validPayload({
      message: { from: { id: "page-1", name: "Page" } },
    })))).toEqual({ kind: "ignore" });
    expect(await adapter.parse(createPancakeRequest(validPayload({
      message: { from: { id: "customer-1", name: "Ada" } },
    })))).toEqual({ kind: "ignore" });
  });

  it("uses configured scenario handoff tags to ignore human-owned conversations", async () => {
    const adapter = createPancakeChannel("page-1", "page-token", "hook-secret", undefined, {
      accountId: "acct_test",
      agentId: "agent_test",
      configOptions: {
        ignoreTagIds: ["order-tag", "pending-tag"],
      },
    });

    globalThis.fetch = mock(async () => {
      throw new Error("Pancake handoff tag check should not call fetch");
    }) as never;

    const parsed = await adapter.parse(createPancakeRequest(validPayload({
      conversation: { tags: ["order-tag"] },
    })));

    expect(parsed).toEqual({
      kind: "ignore",
      response: { statusCode: 200 },
    });

    const pendingParsed = await adapter.parse(createPancakeRequest(validPayload({
      conversation: { tags: ["pending-tag"] },
    })));
    expect(pendingParsed).toEqual({
      kind: "ignore",
      response: { statusCode: 200 },
    });
  });

  it("continues normally when scenario handoff tags are absent", async () => {
    const adapter = createPancakeChannel("page-1", "page-token", "hook-secret", undefined, {
      configOptions: {
        ignoreTagIds: ["order-tag", "pending-tag"],
      },
    });

    const parsed = await adapter.parse(createPancakeRequest(validPayload({
      conversation: { tags: ["other-tag"] },
    })));

    expect(parsed.kind).toBe("message");
  });

  it("authenticates only requests carrying the webhook secret query parameter", async () => {
    const adapter = createPancakeChannel("page-1", "page-token", "hook-secret");

    expect(await adapter.authenticate(createPancakeRequest(validPayload(), "secret=hook-secret"))).toBe(true);
    expect(await adapter.authenticate(createPancakeRequest(validPayload(), "secret=wrong-secret"))).toBe(false);
    expect(await adapter.authenticate(createPancakeRequest(validPayload(), "secret="))).toBe(false);
    expect(await adapter.authenticate(createPancakeRequest(validPayload(), ""))).toBe(false);
  });
});

function createPancakeRequest(payload: Record<string, unknown>, rawQueryString = "") {
  return {
    method: "POST",
    rawPath: "/",
    rawQueryString,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function validPayload(overrides: {
  page_id?: string;
  conversation?: Record<string, unknown>;
  message?: Record<string, unknown>;
} = {}) {
  return {
    page_id: overrides.page_id ?? "page-1",
    event_type: "messaging",
    data: {
      conversation: {
        id: "conversation-1",
        type: "INBOX",
        tags: [],
        ...overrides.conversation,
      },
      message: {
        id: "message-1",
        conversation_id: "conversation-1",
        page_id: overrides.page_id ?? "page-1",
        message: "hello",
        type: "INBOX",
        from: {
          id: "customer-1",
          name: "Ada",
          page_customer_id: "page-customer-1",
        },
        ...overrides.message,
      },
    },
  };
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}
