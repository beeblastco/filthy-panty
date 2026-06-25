/**
 * Attachment ingestion security tests.
 * Cover bounded downloads, content validation, and isolated per-item failures.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { createRemoteArtifactDriverClient } from "../functions/harness-processing/artifact-driver.ts";
import { createArtifactService } from "../functions/harness-processing/artifact-service.ts";
import type { ArtifactRecord } from "../functions/_shared/storage/index.ts";
import { normalizeCreateArtifactInput, type CreateArtifactInput } from "../functions/_shared/storage/artifacts.ts";

const originalFetch = globalThis.fetch;
const writeS3ObjectMock = mock(async () => 0);
const deleteS3ObjectMock = mock(async () => {});
const getS3ObjectUrlMock = mock(async () => "https://test-artifact-staging.s3.amazonaws.com/staging/file?signature=redacted");
const createArtifactMock = mock(async (_accountId: string, input: CreateArtifactInput) => ({
  artifactId: `art_${input.sourceAttachmentId}`,
  ...normalizeCreateArtifactInput(input),
}));
const updateArtifactMock = mock(async (_accountId: string, _conversationKey: string, artifactId: string, patch: Record<string, unknown>) => ({
  artifactId,
  ...patch,
}));

let artifacts: typeof import("../functions/harness-processing/artifacts.ts");

beforeAll(async () => {
  process.env.ARTIFACT_STAGING_BUCKET_NAME = "test-artifact-staging";
  artifacts = await import("../functions/harness-processing/artifacts.ts");
  artifacts.setArtifactRuntimeForTests({
    writeObject: writeS3ObjectMock,
    deleteObject: deleteS3ObjectMock,
    signObject: getS3ObjectUrlMock,
    storage: () => ({ artifacts: { create: createArtifactMock, update: updateArtifactMock } } as never),
    fetchHttps: (input, init) => globalThis.fetch(input, init),
    remoteClient: (config) => createRemoteArtifactDriverClient(config, { fetch: globalThis.fetch }),
  });
});

afterAll(() => {
  artifacts.setArtifactRuntimeForTests(null);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  writeS3ObjectMock.mockClear();
  writeS3ObjectMock.mockImplementation(async () => 0);
  deleteS3ObjectMock.mockClear();
  getS3ObjectUrlMock.mockClear();
  createArtifactMock.mockClear();
  updateArtifactMock.mockClear();
});

describe("attachment downloader", () => {
  it("rejects non-HTTPS, unapproved, and private hosts before fetch", async () => {
    const fetchMock = mock(async () => new Response("should not run"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(artifacts.downloadAttachment({ url: "http://example.com/file", allowedHosts: ["example.com"] }))
      .rejects.toThrow("HTTPS URL");
    await expect(artifacts.downloadAttachment({ url: "https://example.com/file", allowedHosts: ["cdn.example.com"] }))
      .rejects.toThrow("host is not allowed");
    await expect(artifacts.downloadAttachment({ url: "https://127.0.0.1/file", allowedHosts: ["127.0.0.1"] }))
      .rejects.toThrow("private or reserved");
    await expect(artifacts.downloadAttachment({ url: "https://192.0.2.1/file", allowedHosts: ["192.0.2.1"] }))
      .rejects.toThrow("private or reserved");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects oversized content before reading the response body", async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    globalThis.fetch = mock(async () => new Response(body, {
      headers: { "content-length": String(20 * 1024 * 1024 + 1) },
    })) as unknown as typeof fetch;

    await expect(artifacts.downloadAttachment({
      url: "https://example.com/file",
      allowedHosts: ["example.com"],
    })).rejects.toThrow("byte limit");
    expect(cancelled).toBe(true);
  });

  it("enforces the caller-provided channel media budget", async () => {
    globalThis.fetch = mock(async () => new Response("12345", {
      headers: { "content-length": "5" },
    })) as unknown as typeof fetch;

    await expect(artifacts.downloadAttachment({
      url: "https://example.com/file",
      allowedHosts: ["example.com"],
    }, 4)).rejects.toThrow("4 byte limit");
  });

  it("rejects cross-origin redirects before forwarding authorization", async () => {
    const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response(null, { status: 302, headers: { location: "https://www.example.com/file" } });
      }
      throw new Error(`unexpected redirected request: ${String(_url)} ${String(init?.headers)}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(artifacts.downloadAttachment({
      url: "https://example.com/file",
      headers: { Authorization: "Bearer secret" },
      allowedHosts: ["example.com"],
    })).rejects.toThrow("host is not allowed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("revalidates redirected hosts", async () => {
    const fetchMock = mock(async () => new Response(null, {
      status: 302,
      headers: { location: "https://attacker.invalid/file" },
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(artifacts.downloadAttachment({
      url: "https://example.com/file",
      allowedHosts: ["example.com"],
    })).rejects.toThrow("host is not allowed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("times out while waiting for headers and aborts the request", async () => {
    let aborted = false;
    globalThis.fetch = mock((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    })) as unknown as typeof fetch;

    await expect(artifacts.downloadAttachment({
      url: "https://example.com/file",
      allowedHosts: ["example.com"],
    }, 20, { headerTimeoutMs: 10, totalTimeoutMs: 100 })).rejects.toThrow("header timed out");
    expect(aborted).toBe(true);
  });

  it("times out and cancels a stalled body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { cancelled = true; },
    });
    globalThis.fetch = mock(async () => new Response(body)) as unknown as typeof fetch;

    await expect(artifacts.downloadAttachment({
      url: "https://example.com/file",
      allowedHosts: ["example.com"],
    }, 20, { idleTimeoutMs: 10, totalTimeoutMs: 100 })).rejects.toThrow("idle timed out");
    expect(cancelled).toBe(true);
  });

  it("keeps the total timeout active for a body that never goes idle", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await Bun.sleep(5);
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() { cancelled = true; },
    });
    globalThis.fetch = mock(async () => new Response(body)) as unknown as typeof fetch;

    await expect(artifacts.downloadAttachment({
      url: "https://example.com/file",
      allowedHosts: ["example.com"],
    }, 10_000, { idleTimeoutMs: 20, totalTimeoutMs: 15 })).rejects.toThrow("total timed out");
    expect(cancelled).toBe(true);
  });
});

describe("attachment content validation", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  it("detects valid common formats from content", () => {
    expect(artifacts.validateAttachmentContent(png, {
      declaredMediaType: "image/png",
      responseMediaType: "application/octet-stream",
      filename: "photo.png",
      kind: "image",
    })).toBe("image/png");
    expect(artifacts.validateAttachmentContent(new TextEncoder().encode("%PDF-1.7\n"), {
      filename: "report.pdf",
      kind: "file",
    })).toBe("application/pdf");
  });

  it("rejects mislabeled HTML, SVG, scripts, and image conflicts", () => {
    expect(() => artifacts.validateAttachmentContent(new TextEncoder().encode("<!doctype html><p>bad</p>"), {
      declaredMediaType: "image/png",
      filename: "photo.png",
      kind: "image",
    })).toThrow("Active content");
    expect(() => artifacts.validateAttachmentContent(new TextEncoder().encode("<svg><script>alert(1)</script></svg>"), {
      declaredMediaType: "text/plain",
      filename: "note.txt",
    })).toThrow("Active content");
    expect(() => artifacts.validateAttachmentContent(new TextEncoder().encode("alert(1)"), {
      declaredMediaType: "text/javascript",
      filename: "run.js",
    })).toThrow("Active content");
    expect(() => artifacts.validateAttachmentContent(png, {
      declaredMediaType: "image/jpeg",
      filename: "photo.jpg",
      kind: "image",
    })).toThrow("conflict");
  });

  it("rejects truncated binary claims and active-content polyglots", () => {
    expect(() => artifacts.validateAttachmentContent(new Uint8Array([0x89, 0x50]), {
      declaredMediaType: "image/png",
      filename: "photo.png",
      kind: "image",
    })).toThrow("signature");
    expect(() => artifacts.validateAttachmentContent(new Uint8Array([
      ...png,
      ...new TextEncoder().encode("<script>alert(1)</script>"),
    ]), { filename: "photo.png", kind: "image" })).toThrow("Active content");
    const paddedPolyglot = new Uint8Array(70 * 1024 + 8);
    paddedPolyglot.set(png);
    paddedPolyglot.set(new TextEncoder().encode("<script>"), 70 * 1024);
    expect(() => artifacts.validateAttachmentContent(paddedPolyglot, {
      filename: "photo.png",
      kind: "image",
    })).toThrow("Active content");
  });

  it("treats Office containers as generic ZIP content", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    expect(artifacts.validateAttachmentContent(zip, {
      declaredMediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "report.docx",
      kind: "file",
    })).toBe("application/zip");
  });
});

describe("attachment ingestion", () => {
  it("caps provider fan-out at eight candidates without resolving overflow items", async () => {
    const resolvers = Array.from({ length: 9 }, () => mock(async () => ({
      url: "https://example.com/file",
      allowedHosts: ["example.com"],
    })));
    const result = await artifacts.ingestChannelAttachments({
      accountId: "acct",
      agentId: "agent",
      agentConfig: { channels: { slack: { mediaMaxMb: 1 } } },
      channelName: "slack",
      conversationKey: "conversation",
      eventId: "event",
      content: "Keep this text",
      candidates: resolvers.map((resolveDownload, index) => ({
        id: `file-${index}`,
        kind: "file" as const,
        filename: `file-${index}.bin`,
        size: 2 * 1024 * 1024,
        resolveDownload,
      })),
    });

    expect(result.results).toHaveLength(9);
    expect(result.results.at(-1)).toMatchObject({ status: "failed", reason: "attachment_limit" });
    expect(resolvers.every((resolve) => resolve.mock.calls.length === 0)).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Keep this text");
  });

  it("writes managed references that the artifact service can read", async () => {
    const bytes = new TextEncoder().encode("hello artifact");
    globalThis.fetch = mock(async () => new Response(bytes, {
      headers: { "content-type": "text/plain" },
    })) as unknown as typeof fetch;

    const result = await artifacts.ingestChannelAttachments({
      accountId: "acct",
      agentId: "agent",
      agentConfig: {},
      channelName: "slack",
      conversationKey: "conversation",
      eventId: "event",
      content: "Read this",
      candidates: [{
        id: "managed",
        kind: "file",
        filename: "note.txt",
        mediaType: "text/plain",
        resolveDownload: async () => ({ url: "https://example.com/note", allowedHosts: ["example.com"] }),
      }],
    });

    expect(result.readyCount).toBe(1);
    const createInput = createArtifactMock.mock.calls.at(-1)?.[1] as unknown as Omit<ArtifactRecord, "artifactId" | "accountId" | "createdAt" | "updatedAt">;
    expect(createInput.externalRef).toMatch(/^managed-staging\/staging\//);
    const record: ArtifactRecord = {
      artifactId: "art_managed",
      accountId: "acct",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...createInput,
    };
    const readManaged = mock(async () => bytes);
    const service = createArtifactService({
      accountId: "acct",
      conversationKey: "conversation",
      dependencies: {
        artifacts: { getById: mock(async () => record) } as never,
        stagingBucket: "test-artifact-staging",
        now: Date.now,
        readManaged,
      },
    });

    expect(await service.read("art_managed")).toMatchObject({ status: "ready", text: "hello artifact" });
    expect(readManaged).toHaveBeenCalledWith(
      "test-artifact-staging",
      expect.stringContaining("staging/"),
      1024 * 1024,
    );
  });

  it("transfers staged bytes to a configured remote driver and deletes staging", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    globalThis.fetch = mock(async (request) => {
      const url = new URL(String(request));
      if (url.hostname === "storage.example.com") {
        return Response.json({ externalRef: "customer_object/art_remote" });
      }
      return new Response(png, { headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch;

    const result = await artifacts.ingestChannelAttachments({
      accountId: "acct",
      agentId: "agent",
      agentConfig: {
        artifacts: {
          driver: {
            name: "customer-storage",
            mode: "remote",
            endpoint: "https://storage.example.com/artifacts",
            signingSecret: "test-signing-secret",
            allowedHosts: ["storage.example.com"],
          },
          fallback: "reject",
        },
        model: { inputCapabilities: { imageMediaTypes: ["image/png"] } },
      },
      channelName: "slack",
      conversationKey: "conversation",
      eventId: "event",
      content: "Inspect this",
      candidates: [{
        id: "remote",
        kind: "image",
        filename: "remote.png",
        mediaType: "image/png",
        resolveDownload: async () => ({ url: "https://example.com/remote", allowedHosts: ["example.com"] }),
      }],
    });

    expect(result.readyCount).toBe(1);
    expect(updateArtifactMock).toHaveBeenCalledWith(
      "acct",
      "conversation",
      "art_remote",
      { state: "ready", externalRef: "customer_object/art_remote", failureCode: null },
    );
    expect(deleteS3ObjectMock).toHaveBeenCalledWith("test-artifact-staging", expect.stringContaining("staging/"));
    expect(Array.isArray(result.content) && result.content.some((part) => part.type === "image")).toBe(true);
  });

  it("rejects an idempotent replay when the persisted artifact uses another driver", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    globalThis.fetch = mock(async () => new Response(png, { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    createArtifactMock.mockImplementationOnce(async (_accountId, input) => ({
      artifactId: "art_replay",
      ...normalizeCreateArtifactInput(input),
      driverId: "previous-driver",
      state: "ready",
      externalRef: "opaque-existing-ref",
    }));

    const result = await artifacts.ingestChannelAttachments({
      accountId: "acct",
      agentId: "agent",
      agentConfig: {
        artifacts: {
          driver: {
            name: "current-driver",
            mode: "remote",
            endpoint: "https://storage.example.com/artifacts",
            signingSecret: "test-signing-secret",
            allowedHosts: ["storage.example.com"],
          },
        },
      },
      channelName: "slack",
      conversationKey: "conversation",
      eventId: "event",
      content: "Inspect this",
      candidates: [{
        id: "replay",
        kind: "image",
        filename: "replay.png",
        mediaType: "image/png",
        resolveDownload: async () => ({ url: "https://example.com/replay", allowedHosts: ["example.com"] }),
      }],
    });

    expect(result).toMatchObject({ readyCount: 0, failedCount: 1 });
    expect(updateArtifactMock).not.toHaveBeenCalled();
    expect(getS3ObjectUrlMock).not.toHaveBeenCalled();
    expect(deleteS3ObjectMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a committed remote artifact ready when staging cleanup fails", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    globalThis.fetch = mock(async (request) => new URL(String(request)).hostname === "storage.example.com"
      ? Response.json({ externalRef: "customer_object/art_remote" })
      : new Response(png, { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    deleteS3ObjectMock.mockImplementation(async () => { throw new Error("S3 unavailable"); });

    const result = await artifacts.ingestChannelAttachments({
      accountId: "acct",
      agentId: "agent",
      agentConfig: {
        artifacts: {
          driver: {
            name: "customer-storage",
            mode: "remote",
            endpoint: "https://storage.example.com/artifacts",
            signingSecret: "test-signing-secret",
            allowedHosts: ["storage.example.com"],
          },
          fallback: "managed-ephemeral",
        },
      },
      channelName: "slack",
      conversationKey: "conversation",
      eventId: "event",
      content: "Inspect this",
      candidates: [{
        id: "remote",
        kind: "image",
        filename: "remote.png",
        mediaType: "image/png",
        resolveDownload: async () => ({ url: "https://example.com/remote", allowedHosts: ["example.com"] }),
      }],
    });

    expect(result.readyCount).toBe(1);
    expect(updateArtifactMock).toHaveBeenCalledTimes(1);
    expect(updateArtifactMock).toHaveBeenCalledWith("acct", "conversation", "art_remote", {
      state: "ready",
      externalRef: "customer_object/art_remote",
      failureCode: null,
    });
  });

  it("deletes a remote object when its ready-state commit loses a race", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const operations: string[] = [];
    globalThis.fetch = mock(async (request) => {
      const url = new URL(String(request));
      if (url.hostname !== "storage.example.com") return new Response(png, { headers: { "content-type": "image/png" } });
      operations.push(url.pathname.split("/").at(-1)!);
      return url.pathname.endsWith("/store")
        ? Response.json({ externalRef: "customer_object/art_remote" })
        : new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    updateArtifactMock
      .mockImplementationOnce(async () => null as never)
      .mockImplementationOnce(async (_accountId, _conversationKey, artifactId, patch) => ({ artifactId, ...patch }));

    const result = await artifacts.ingestChannelAttachments({
      accountId: "acct",
      agentId: "agent",
      agentConfig: {
        artifacts: {
          driver: {
            name: "customer-storage",
            mode: "remote",
            endpoint: "https://storage.example.com/artifacts",
            signingSecret: "test-signing-secret",
            allowedHosts: ["storage.example.com"],
          },
          fallback: "reject",
        },
      },
      channelName: "slack",
      conversationKey: "conversation",
      eventId: "event",
      content: "Inspect this",
      candidates: [{
        id: "remote",
        kind: "image",
        filename: "remote.png",
        mediaType: "image/png",
        resolveDownload: async () => ({ url: "https://example.com/remote", allowedHosts: ["example.com"] }),
      }],
    });

    expect(result.failedCount).toBe(1);
    expect(operations).toEqual(["store", "delete"]);
    expect(updateArtifactMock).toHaveBeenLastCalledWith("acct", "conversation", "art_remote", {
      state: "failed",
      externalRef: null,
      failureCode: "driver_store_failed",
    });
  });

  it("preserves text and successful files when another attachment is invalid", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    globalThis.fetch = mock(async (url) => String(url).includes("good")
      ? new Response(png, { headers: { "content-type": "image/png" } })
      : new Response("<html>bad</html>", { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;

    const result = await artifacts.ingestChannelAttachments({
      accountId: "acct",
      agentId: "agent",
      agentConfig: {},
      channelName: "slack",
      conversationKey: "conversation",
      eventId: "event",
      content: "Please inspect these",
      candidates: [
        { id: "good", kind: "image", filename: "good.png", mediaType: "image/png", resolveDownload: async () => ({ url: "https://example.com/good", allowedHosts: ["example.com"] }) },
        { id: "bad", kind: "image", filename: "bad.png", mediaType: "image/png", resolveDownload: async () => ({ url: "https://example.com/bad", allowedHosts: ["example.com"] }) },
      ],
    });

    expect(result).toMatchObject({ count: 2, readyCount: 1, failedCount: 1 });
    expect(result.results.map((item) => item.status)).toEqual(["ready", "failed"]);
    expect(result.content).toContainEqual({ type: "text", text: "Please inspect these" });
    expect(result.content).toContainEqual({
      type: "text",
      text: expect.stringContaining('"artifactId":"art_good"'),
    });
    expect(Array.isArray(result.content) && result.content.some((part) => part.type === "image")).toBe(false);
    expect(result.content).toContainEqual({ type: "text", text: "[Attachment unavailable: bad.png; reason=invalid_content]" });
    expect(writeS3ObjectMock).toHaveBeenCalledTimes(1);
  });

  it("does not write content that fails validation", async () => {
    globalThis.fetch = mock(async () => new Response("<svg></svg>", {
      headers: { "content-type": "text/plain" },
    })) as unknown as typeof fetch;

    const result = await artifacts.ingestChannelAttachments({
      accountId: "acct",
      agentId: "agent",
      agentConfig: {},
      channelName: "slack",
      conversationKey: "conversation",
      eventId: "event",
      content: "Text survives",
      candidates: [{
        id: "bad",
        kind: "file",
        filename: "bad.txt",
        resolveDownload: async () => ({ url: "https://example.com/bad", allowedHosts: ["example.com"] }),
      }],
    });

    expect(result.readyCount).toBe(0);
    expect(result.content).toContainEqual({ type: "text", text: "Text survives" });
    expect(writeS3ObjectMock).not.toHaveBeenCalled();
  });
});
