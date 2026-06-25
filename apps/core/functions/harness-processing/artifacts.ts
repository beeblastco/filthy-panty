/**
 * Channel attachment ingestion.
 * Resolve authenticated provider media, enforce download limits, and persist private artifacts here.
 */

import { createHash } from "node:crypto";
import type { FilePart, ImagePart, UserContent } from "ai";
import type { InboundAttachmentCandidate } from "../_shared/channels.ts";
import { requireEnv } from "../_shared/env.ts";
import { logWarn } from "../_shared/log.ts";
import { deleteS3Object, getS3ObjectUrl, writeS3Object } from "../_shared/s3.ts";
import {
  artifactStagingAccountPrefix,
  getStorage,
  MANAGED_ARTIFACT_REF_PREFIX,
  type AgentConfig,
  type ArtifactKind,
} from "../_shared/storage/index.ts";
import { createRemoteArtifactDriverClient } from "./artifact-driver.ts";
import { planArtifactProjection } from "./artifact-projection.ts";
import { assertAllowedPinnedHttpsUrl, pinnedHttpsFetch } from "../_shared/pinned-https.ts";
import type { ResolvedWorkspace } from "../_shared/workspaces.ts";
import { materializeArtifact } from "./artifact-materialization.ts";
import { createArtifactService } from "./artifact-service.ts";

const MAX_ATTACHMENTS = 8;
const DEFAULT_MEDIA_MAX_MB = 20;
const HEADER_TIMEOUT_MS = 10_000;
const BODY_IDLE_TIMEOUT_MS = 5_000;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const RESOLVER_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 2;
const SNIFF_BYTES = 64 * 1024;
const ACTIVE_MARKUP_TOKENS = ["<!doctype", "<html", "<svg", "<script"].map((token) =>
  new TextEncoder().encode(token)
);
const ACTIVE_JAVASCRIPT_TOKEN = new TextEncoder().encode("javascript:");
function artifactStagingBucketName(): string {
  return requireEnv("ARTIFACT_STAGING_BUCKET_NAME");
}

const defaultArtifactRuntime = {
  writeObject: writeS3Object,
  deleteObject: deleteS3Object,
  signObject: getS3ObjectUrl,
  storage: getStorage,
  fetchHttps: pinnedHttpsFetch,
  remoteClient: createRemoteArtifactDriverClient,
  materialize: materializeArtifact,
};
let artifactRuntime = defaultArtifactRuntime;

/** Inject artifact I/O for focused tests without replacing shared modules. */
export function setArtifactRuntimeForTests(runtime: Partial<typeof defaultArtifactRuntime> | null): void {
  artifactRuntime = runtime ? { ...defaultArtifactRuntime, ...runtime } : defaultArtifactRuntime;
}

export type AttachmentFailureReason =
  | "attachment_limit"
  | "download_failed"
  | "invalid_content"
  | "size_limit"
  | "storage_failed";

export type AttachmentIngestionResult =
  | { status: "ready"; id: string; artifactId: string; filename: string; mediaType: string; size: number; key: string; workspaceName?: string; workspacePath?: string }
  | { status: "failed"; id: string; filename: string; reason: AttachmentFailureReason };

export interface IngestedChannelAttachments {
  content: UserContent;
  count: number;
  readyCount: number;
  failedCount: number;
  results: AttachmentIngestionResult[];
}

export async function ingestChannelAttachments(input: {
  accountId: string;
  agentId: string;
  agentConfig: AgentConfig;
  channelName: string;
  conversationKey: string;
  eventId: string;
  content: UserContent;
  candidates: InboundAttachmentCandidate[];
  workspaces?: ResolvedWorkspace[];
}): Promise<IngestedChannelAttachments> {
  const channelConfig = input.agentConfig.channels?.[input.channelName] as { mediaMaxMb?: number } | undefined;
  const maxBytes = (channelConfig?.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB) * 1024 * 1024;
  const messagePrefix = `${artifactStagingAccountPrefix(input.accountId)}${safeHash(input.agentId)}/${input.channelName}/${safeHash(input.conversationKey)}/${safeHash(input.eventId)}`;
  const textParts = typeof input.content === "string"
    ? input.content.trim() ? [{ type: "text" as const, text: input.content }] : []
    : input.content.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text");
  const mediaParts: Array<ImagePart | FilePart> = [];
  const results: AttachmentIngestionResult[] = [];
  let totalBytes = 0;

  for (const [index, candidate] of input.candidates.entries()) {
    const displayFilename = safeFilename(candidate.filename, candidate.id, candidate.mediaType ?? "application/octet-stream", index);
    if (index >= MAX_ATTACHMENTS) {
      addUnavailable(textParts, displayFilename, "attachment_limit");
      results.push({ status: "failed", id: candidate.id, filename: displayFilename, reason: "attachment_limit" });
      continue;
    }

    let downloaded: Awaited<ReturnType<typeof downloadAttachment>>;
    try {
      if (candidate.size !== undefined && candidate.size > maxBytes) throw new AttachmentError("size_limit");
      const request = await withTimeout(candidate.resolveDownload(), RESOLVER_TIMEOUT_MS, "Attachment resolver timed out");
      downloaded = await downloadAttachment(request, maxBytes);
      if (totalBytes + downloaded.bytes.byteLength > maxBytes) throw new AttachmentError("size_limit");
    } catch (error) {
      const reason = publicFailureReason(error);
      addUnavailable(textParts, displayFilename, reason);
      results.push({ status: "failed", id: candidate.id, filename: displayFilename, reason });
      continue;
    }

    let mediaType: string;
    try {
      mediaType = validateAttachmentContent(downloaded.bytes, {
        declaredMediaType: candidate.mediaType,
        responseMediaType: downloaded.mediaType,
        filename: candidate.filename,
        kind: candidate.kind,
      });
    } catch {
      addUnavailable(textParts, displayFilename, "invalid_content");
      results.push({ status: "failed", id: candidate.id, filename: displayFilename, reason: "invalid_content" });
      continue;
    }

    const filename = safeFilename(candidate.filename, candidate.id, mediaType, index);
    const sha256 = createHash("sha256").update(downloaded.bytes).digest("hex");
    const key = `${messagePrefix}/${sha256.slice(0, 12)}-${filename}`;
    try {
      await artifactRuntime.writeObject(artifactStagingBucketName(), key, downloaded.bytes, {
        contentType: mediaType,
        metadata: {
          "artifact-channel": input.channelName,
          "artifact-provider-id": safeMetadata(candidate.id),
          "artifact-sha256": sha256,
          "artifact-kind": candidate.kind,
        },
      });
    } catch {
      addUnavailable(textParts, filename, "storage_failed");
      results.push({ status: "failed", id: candidate.id, filename, reason: "storage_failed" });
      continue;
    }

    let artifactId: string;
    try {
      const policy = input.agentConfig.artifacts;
      const remoteDriver = policy?.driver;
      let artifact = await artifactRuntime.storage().artifacts.create(input.accountId, {
        agentId: input.agentId,
        conversationKey: input.conversationKey,
        sourceEventId: input.eventId,
        sourceAttachmentId: candidate.id,
        driverId: remoteDriver?.name ?? "managed-ephemeral",
        ...(!remoteDriver ? { externalRef: `${MANAGED_ARTIFACT_REF_PREFIX}${key}` } : {}),
        filename,
        mediaType,
        kind: artifactKind(candidate.kind, mediaType),
        size: downloaded.bytes.byteLength,
        sha256,
        state: remoteDriver ? "pending" : "ready",
      });
      artifactId = artifact.artifactId;
      const configuredDriverId = remoteDriver?.name ?? "managed-ephemeral";
      if (artifact.driverId !== configuredDriverId) {
        throw new Error("Existing artifact belongs to a different storage driver");
      }

      if (remoteDriver && artifact.state !== "ready") {
        try {
          const transferUrl = await artifactRuntime.signObject(artifactStagingBucketName(), key, { expiresInSeconds: 300 });
          const remoteClient = artifactRuntime.remoteClient(remoteDriver);
          const stored = await remoteClient.store({
            invocationId: `store:${artifact.artifactId}`,
            artifact: {
              artifactId: artifact.artifactId,
              filename,
              mediaType,
              kind: artifact.kind,
              size: downloaded.bytes.byteLength,
              sha256,
            },
            owner: {
              accountId: input.accountId,
              agentId: input.agentId,
              conversationKey: input.conversationKey,
            },
            transfer: { url: transferUrl, expiresInSeconds: 300 },
          });
          try {
            const committed = await artifactRuntime.storage().artifacts.update(
              input.accountId,
              input.conversationKey,
              artifact.artifactId,
              { state: "ready", externalRef: stored.externalRef, failureCode: null },
            );
            if (!committed) throw new Error("Artifact state changed before remote storage commit");
            artifact = committed;
          } catch (error) {
            await remoteClient.delete({
              invocationId: `delete:${artifact.artifactId}:store-compensation`,
              artifactId: artifact.artifactId,
              externalRef: stored.externalRef,
            }).catch((compensationError) => {
              logWarn("Remote artifact compensation failed", {
                artifactId: artifact.artifactId,
                error: compensationError instanceof Error ? compensationError.message : String(compensationError),
              });
            });
            throw error;
          }
          await cleanupStagingObject(key, artifact.artifactId);
        } catch (error) {
          if (policy?.fallback === "managed-ephemeral") {
            const fallbackArtifact = await artifactRuntime.storage().artifacts.update(
              input.accountId,
              input.conversationKey,
              artifact.artifactId,
              {
                driverId: "managed-ephemeral",
                state: "ready",
                externalRef: `${MANAGED_ARTIFACT_REF_PREFIX}${key}`,
                failureCode: null,
              },
            );
            if (!fallbackArtifact) throw new Error("Artifact state changed before fallback commit");
            artifact = fallbackArtifact;
          } else {
            await artifactRuntime.storage().artifacts.update(
              input.accountId,
              input.conversationKey,
              artifact.artifactId,
              { state: "failed", externalRef: null, failureCode: "driver_store_failed" },
            );
            await artifactRuntime.deleteObject(artifactStagingBucketName(), key).catch(() => {});
            addUnavailable(textParts, filename, "storage_failed");
            results.push({ status: "failed", id: candidate.id, filename, reason: "storage_failed" });
            continue;
          }
        }
      } else if (remoteDriver && artifact.state === "ready") {
        await cleanupStagingObject(key, artifact.artifactId);
      }
    } catch (error) {
      await artifactRuntime.deleteObject(artifactStagingBucketName(), key).catch(() => {});
      addUnavailable(textParts, filename, "storage_failed");
      results.push({ status: "failed", id: candidate.id, filename, reason: "storage_failed" });
      continue;
    }

    totalBytes += downloaded.bytes.byteLength;
    const capabilities = {
      imageMediaTypes: input.agentConfig.model?.inputCapabilities?.imageMediaTypes ?? [],
      fileMediaTypes: input.agentConfig.model?.inputCapabilities?.fileMediaTypes ?? [],
    };
    let workspaceCopy: Awaited<ReturnType<typeof materializeArtifact>> = null;
    if ((input.workspaces?.length ?? 0) > 0) {
      try {
        workspaceCopy = await artifactRuntime.materialize({
          artifactId,
          filename,
          mediaType,
          kind: artifactKind(candidate.kind, mediaType),
          config: input.agentConfig.artifacts,
          capabilities,
          workspaces: input.workspaces ?? [],
          service: createArtifactService({
            accountId: input.accountId,
            conversationKey: input.conversationKey,
            config: input.agentConfig.artifacts,
          }),
        });
      } catch (error) {
        logWarn("Artifact workspace materialization failed", {
          artifactId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const projection = planArtifactProjection({
      artifact: {
        artifactId,
        filename,
        mediaType,
        kind: artifactKind(candidate.kind, mediaType),
        size: downloaded.bytes.byteLength,
        sha256,
        bytes: downloaded.bytes,
        ...(workspaceCopy ?? {}),
      },
      capabilities,
    });
    for (const part of projection.content) {
      if (part.type === "text") textParts.push(part);
      else mediaParts.push(part);
    }
    results.push({
      status: "ready",
      id: candidate.id,
      artifactId,
      filename,
      mediaType,
      size: downloaded.bytes.byteLength,
      key,
      ...(workspaceCopy ?? {}),
    });
  }

  const readyCount = results.filter((result) => result.status === "ready").length;
  return {
    content: [...textParts, ...mediaParts],
    count: input.candidates.length,
    readyCount,
    failedCount: results.length - readyCount,
    results,
  };
}

async function cleanupStagingObject(key: string, artifactId: string): Promise<void> {
  await artifactRuntime.deleteObject(artifactStagingBucketName(), key).catch((error) => {
    logWarn("Artifact staging cleanup deferred to bucket lifecycle", {
      artifactId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function artifactKind(kind: InboundAttachmentCandidate["kind"], mediaType: string): ArtifactKind {
  if (kind === "image" || kind === "gif") return "image";
  if (kind === "audio") return "audio";
  if (kind === "video") return "video";
  if (mediaType === "application/pdf" || mediaType === "application/zip" || mediaType.startsWith("text/")) return "document";
  return "file";
}

export interface DownloadAttachmentOptions {
  headerTimeoutMs?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
}

export async function downloadAttachment(request: {
  url: string;
  headers?: Record<string, string>;
  allowedHosts: string[];
}, maxBytes = DEFAULT_MEDIA_MAX_MB * 1024 * 1024, options: DownloadAttachmentOptions = {}): Promise<{ bytes: Uint8Array; mediaType?: string }> {
  let url = new URL(request.url);
  let headers = request.headers;
  const controller = new AbortController();
  let timeoutKind = "total";
  const deadline = Date.now() + (options.totalTimeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  const totalTimer = setTimeout(() => {
    timeoutKind = "total";
    controller.abort();
  }, options.totalTimeoutMs ?? DOWNLOAD_TIMEOUT_MS);

  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      timeoutKind = "total";
      assertAllowedPinnedHttpsUrl(url, request.allowedHosts);
      const headerTimeout = options.headerTimeoutMs ?? HEADER_TIMEOUT_MS;
      const remaining = remainingMs(deadline);
      timeoutKind = remaining <= headerTimeout ? "total" : "header";
      const response = await raceTimeout(
        artifactRuntime.fetchHttps(url, { headers, redirect: "manual", signal: controller.signal }, {
          allowedHosts: request.allowedHosts,
        }),
        Math.min(headerTimeout, remaining),
        () => controller.abort(),
        `Attachment download ${timeoutKind} timed out`,
      );

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        if (!location || redirect === MAX_REDIRECTS) throw new Error("Attachment download exceeded the redirect limit");
        const next = new URL(location, url);
        if (next.origin !== url.origin) headers = undefined;
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Attachment download failed (${response.status})`);
      }

      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw new AttachmentError("size_limit", maxBytes);
      }
      if (!response.body) throw new Error("Attachment response has no body");

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const remaining = remainingMs(deadline);
          const idleTimeout = options.idleTimeoutMs ?? BODY_IDLE_TIMEOUT_MS;
          timeoutKind = remaining <= idleTimeout ? "total" : "idle";
          const { done, value } = await raceTimeout(
            reader.read(),
            Math.min(idleTimeout, remaining),
            () => controller.abort(),
            `Attachment download ${timeoutKind} timed out`,
          );
          if (done) break;
          if (size + value.byteLength > maxBytes) throw new AttachmentError("size_limit", maxBytes);
          chunks.push(value);
          size += value.byteLength;
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
      return {
        bytes,
        mediaType: normalizeOptionalMediaType(response.headers.get("content-type")?.split(";", 1)[0]),
      };
    }
    throw new Error("Attachment download failed");
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof AttachmentError)
      && !(error instanceof Error && error.message.includes("timed out"))) {
      throw new Error(`Attachment download ${timeoutKind} timed out`);
    }
    throw error;
  } finally {
    clearTimeout(totalTimer);
    controller.abort();
  }
}

export function validateAttachmentContent(bytes: Uint8Array, input: {
  declaredMediaType?: string;
  responseMediaType?: string;
  filename?: string;
  kind?: InboundAttachmentCandidate["kind"];
}): string {
  if (bytes.byteLength === 0) throw new Error("Empty attachment");
  const declared = normalizeOptionalMediaType(input.declaredMediaType);
  const response = normalizeOptionalMediaType(input.responseMediaType);
  const filenameType = mediaTypeForFilename(input.filename);
  const detected = sniffMediaType(bytes);

  if (containsActiveContent(bytes) || [declared, response, filenameType].some(isActiveMediaType)) {
    throw new Error("Active content is not allowed");
  }
  const binaryClaim = [declared, response, filenameType].find((value) => value && requiresMagicBytes(value));
  if (binaryClaim && (!detected || detected === "text/plain" || detected === "application/json")) {
    throw new Error("Attachment signature is missing or truncated");
  }
  for (const claimed of [declared, response, filenameType]) {
    if (claimed && detected && !mediaTypesCompatible(claimed, detected)) throw new Error("Attachment media types conflict");
  }

  const mediaType = detected ?? response ?? declared ?? filenameType ?? "application/octet-stream";
  if (!isAllowedMediaType(mediaType) || !kindMatchesMediaType(input.kind, mediaType)) {
    throw new Error(`Attachment media type is not allowed: ${mediaType}`);
  }
  return mediaType;
}

function sniffMediaType(bytes: Uint8Array): string | undefined {
  const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (ascii(bytes, 0, 4) === "%PDF") return "application/pdf";
  if (starts(0x50, 0x4b, 0x03, 0x04) || starts(0x50, 0x4b, 0x05, 0x06) || starts(0x50, 0x4b, 0x07, 0x08)) return "application/zip";
  if (ascii(bytes, 4, 4) === "ftyp") return "video/mp4";
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "audio/wav";
  if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return "audio/mpeg";

  const prefix = bytes.subarray(0, Math.min(bytes.byteLength, SNIFF_BYTES));
  if (!isProbablyText(prefix)) return undefined;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(prefix).trimStart();
  if (/^[\[{]/.test(text)) return "application/json";
  return "text/plain";
}

function containsActiveContent(bytes: Uint8Array): boolean {
  for (let offset = 0; offset < bytes.byteLength; offset += 1) {
    const first = asciiLower(bytes[offset]!);
    if (first === 0x3c) {
      for (const token of ACTIVE_MARKUP_TOKENS) {
        if (matchesAsciiTokenIgnoreCase(bytes, offset, token)) return true;
      }
    } else if (first === 0x6a && matchesAsciiTokenIgnoreCase(bytes, offset, ACTIVE_JAVASCRIPT_TOKEN)) {
      return true;
    }
  }
  return false;
}

function matchesAsciiTokenIgnoreCase(bytes: Uint8Array, offset: number, token: Uint8Array): boolean {
  if (offset + token.byteLength > bytes.byteLength) return false;
  for (let index = 0; index < token.byteLength; index += 1) {
    if (asciiLower(bytes[offset + index]!) !== token[index]) return false;
  }
  return true;
}

function asciiLower(value: number): number {
  return value >= 0x41 && value <= 0x5a ? value + 0x20 : value;
}

function isProbablyText(bytes: Uint8Array): boolean {
  let suspicious = 0;
  for (const byte of bytes) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) suspicious += 1;
  }
  return suspicious <= Math.max(1, Math.floor(bytes.byteLength * 0.01));
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.byteLength < offset + length) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function normalizeOptionalMediaType(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)
    ? normalized
    : undefined;
}

function isAllowedMediaType(mediaType: string): boolean {
  if (isActiveMediaType(mediaType)) return false;
  return mediaType.startsWith("image/") || mediaType.startsWith("video/") || mediaType.startsWith("audio/")
    || mediaType.startsWith("text/") || mediaType === "application/pdf" || mediaType === "application/json"
    || mediaType === "application/octet-stream" || mediaType === "application/zip";
}

function isActiveMediaType(mediaType: string | undefined): boolean {
  return mediaType === "image/svg+xml" || mediaType === "text/html" || mediaType === "application/xhtml+xml"
    || mediaType === "application/javascript" || mediaType === "text/javascript" || mediaType === "application/x-sh";
}

function mediaTypesCompatible(claimed: string, detected: string): boolean {
  if (claimed === "application/octet-stream" || claimed === detected) return true;
  if (detected === "application/zip" && (claimed === "application/zip" || claimed.startsWith("application/vnd.openxmlformats-officedocument."))) return true;
  return false;
}

function requiresMagicBytes(mediaType: string): boolean {
  return mediaType.startsWith("image/") || mediaType.startsWith("audio/") || mediaType.startsWith("video/")
    || mediaType === "application/pdf" || mediaType === "application/zip"
    || mediaType.startsWith("application/vnd.openxmlformats-officedocument.");
}

function kindMatchesMediaType(kind: InboundAttachmentCandidate["kind"] | undefined, mediaType: string): boolean {
  if (!kind || kind === "file") return true;
  if (kind === "gif") return mediaType === "image/gif";
  return mediaType.startsWith(`${kind}/`);
}

function mediaTypeForFilename(filename: string | undefined): string | undefined {
  const extension = filename?.split(".").at(-1)?.toLowerCase();
  return ({
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
    svg: "image/svg+xml", html: "text/html", htm: "text/html", js: "text/javascript", mjs: "text/javascript",
    pdf: "application/pdf", zip: "application/zip", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    mp4: "video/mp4", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", json: "application/json", txt: "text/plain",
  } as Record<string, string | undefined>)[extension ?? ""];
}

function safeFilename(filename: string | undefined, id: string, mediaType: string, index: number): string {
  const fallback = `attachment-${index + 1}-${safeHash(id).slice(0, 8)}${extensionFor(mediaType)}`;
  const normalized = filename?.normalize("NFKC").split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const safe = normalized?.replace(/[^a-zA-Z0-9._ -]/g, "_").replace(/^\.+/, "").slice(0, 160);
  return safe || fallback;
}

function extensionFor(mediaType: string): string {
  return ({ "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "video/mp4": ".mp4", "audio/mpeg": ".mp3", "audio/ogg": ".ogg", "application/pdf": ".pdf" } as Record<string, string>)[mediaType] ?? "";
}

function addUnavailable(textParts: Array<{ type: "text"; text: string }>, filename: string, reason: AttachmentFailureReason): void {
  textParts.push({ type: "text", text: `[Attachment unavailable: ${filename}; reason=${reason}]` });
}

function publicFailureReason(error: unknown): AttachmentFailureReason {
  return error instanceof AttachmentError ? error.reason : "download_failed";
}

class AttachmentError extends Error {
  constructor(readonly reason: AttachmentFailureReason, maxBytes?: number) {
    super(reason === "size_limit" ? `Attachment exceeds the ${maxBytes ?? "configured"} byte limit` : reason);
  }
}

async function raceTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return raceTimeout(promise, timeoutMs, () => {}, message);
}

function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function safeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function safeMetadata(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "").slice(0, 256);
}
