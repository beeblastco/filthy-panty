/**
 * Cross-layer channel artifact flow.
 * Proves provider webhook media reaches only the live model turn while history keeps a safe descriptor.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { createTelegramChannel } from "../functions/_shared/telegram-channel.ts";
import {
  createArtifactId,
  normalizeCreateArtifactInput,
  type ArtifactRecord,
} from "../functions/_shared/storage/artifacts.ts";
import {
  ingestChannelAttachments,
  setArtifactRuntimeForTests,
} from "../functions/harness-processing/artifacts.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setArtifactRuntimeForTests(null);
  delete process.env.ARTIFACT_STAGING_BUCKET_NAME;
  delete process.env.CONVERSATIONS_TABLE_NAME;
  delete process.env.PROCESSED_EVENTS_TABLE_NAME;
  delete process.env.FILESYSTEM_BUCKET_NAME;
});

describe("channel artifact flow", () => {
  it("projects validated Telegram bytes live and persists only caption plus descriptor", async () => {
    process.env.ARTIFACT_STAGING_BUCKET_NAME = "artifact-staging";
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.PROCESSED_EVENTS_TABLE_NAME = "processed-events";
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
    const { sanitizeUserMessageForPersistence } = await import("../functions/harness-processing/session.ts");
    const adapter = createTelegramChannel(
      "bot-secret-token",
      "webhook-secret",
      new Set([123]),
      "eyes",
      mock(async () => Response.json({
        ok: true,
        result: { file_path: "photos/provider-file.png" },
      })),
    );
    const parsed = await adapter.parse({
      method: "POST",
      rawPath: "/",
      rawQueryString: "",
      headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
      body: JSON.stringify({
        update_id: 42,
        message: {
          message_id: 7,
          chat: { id: 123, type: "private" },
          caption: "Inspect this image",
          photo: [{ file_id: "photo-small" }, { file_id: "photo-large", file_size: 12 }],
        },
      }),
    });
    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") throw new Error("Expected a Telegram media message");

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    let record: ArtifactRecord | undefined;
    setArtifactRuntimeForTests({
      writeObject: mock(async () => png.byteLength),
      deleteObject: mock(async () => {}),
      fetchHttps: mock(async () => new Response(png, { headers: { "content-type": "image/png" } })),
      storage: () => ({
        artifacts: {
          async create(accountId: string, rawInput: Parameters<typeof normalizeCreateArtifactInput>[0]) {
            const input = normalizeCreateArtifactInput(rawInput);
            const now = new Date().toISOString();
            record = {
              accountId,
              artifactId: createArtifactId(accountId, input),
              ...input,
              createdAt: now,
              updatedAt: now,
            };
            return record;
          },
          async update() { return null; },
        },
      } as never),
    });

    const ingested = await ingestChannelAttachments({
      accountId: "acct",
      agentId: "agent",
      agentConfig: {
        channels: { telegram: { mediaMaxMb: 20 } },
        model: { inputCapabilities: { imageMediaTypes: ["image/png"] } },
      },
      channelName: "telegram",
      conversationKey: "acct:acct:agent:agent:tg:123",
      eventId: "acct:acct:agent:agent:tg:42",
      content: parsed.message.content,
      candidates: parsed.message.attachments ?? [],
    });

    expect(ingested.readyCount).toBe(1);
    expect(Array.isArray(ingested.content)).toBe(true);
    const liveContent = ingested.content as Exclude<typeof ingested.content, string>;
    expect(liveContent.some((part) => part.type === "image")).toBe(true);
    expect(liveContent.some((part) => part.type === "text" && part.text === "Inspect this image")).toBe(true);

    const persisted = sanitizeUserMessageForPersistence({ role: "user", content: liveContent });
    const serialized = JSON.stringify(persisted);
    expect(serialized).toContain("Inspect this image");
    expect(serialized).toContain(record!.artifactId);
    expect(serialized).not.toContain("provider-file.png");
    expect(serialized).not.toContain("bot-secret-token");
    expect(serialized).not.toContain(record!.externalRef!);
    expect(serialized).not.toContain('"type":"image"');
  });
});
