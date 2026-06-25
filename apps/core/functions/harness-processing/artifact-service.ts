/**
 * Conversation-scoped artifact lifecycle access for harness tools and orchestration.
 * Keep driver URLs and opaque references inside this boundary.
 */

import { createHash, randomUUID } from "node:crypto";
import { requireEnv } from "../_shared/env.ts";
import {
  isMissingS3Error,
  readS3BytesBounded,
} from "../_shared/s3.ts";
import {
  getStorage,
  MANAGED_ARTIFACT_REF_PREFIX,
  type ArtifactRecord,
} from "../_shared/storage/index.ts";
import type { AgentArtifactsConfig } from "../_shared/storage/agent-config.ts";
import type { ArtifactStore } from "../_shared/storage/types.ts";
import { createRemoteArtifactDriverClient, type ArtifactDriverClient } from "./artifact-driver.ts";

type DownloadAttachment = typeof import("./artifacts.ts")["downloadAttachment"];

const MANAGED_ELIGIBILITY_MS = 24 * 60 * 60 * 1_000;
export const MAX_ARTIFACT_TOOL_BYTES = 1024 * 1024;
export const MAX_ARTIFACT_TEXT_CHARS = 64 * 1024;
export const MAX_ARTIFACT_MODEL_BYTES = 20 * 1024 * 1024;

export interface SafeArtifactMetadata {
  artifactId: string;
  filename: string;
  mediaType: string;
  kind: ArtifactRecord["kind"];
  size: number;
  sha256: string;
  state: ArtifactRecord["state"];
  createdAt: string;
  updatedAt: string;
  failureCode?: string;
}

export type ArtifactReadResult =
  | { status: "ready"; artifact: SafeArtifactMetadata; text: string; truncated: boolean }
  | { status: "binary"; artifact: SafeArtifactMetadata }
  | { status: "unavailable"; artifact?: SafeArtifactMetadata; reason: string };

export type ArtifactLoadResult =
  | { status: "ready"; artifact: SafeArtifactMetadata; bytes: Uint8Array }
  | { status: "unavailable"; artifact?: SafeArtifactMetadata; reason: string };

interface ArtifactServiceDependencies {
  artifacts: ArtifactStore;
  stagingBucket: string;
  now: () => number;
  readManaged: (bucket: string, key: string, maxBytes: number) => Promise<Uint8Array>;
  createInvocationId: () => string;
  remoteClient: (config: Extract<AgentArtifactsConfig["driver"], { mode: "remote" }>) => ArtifactDriverClient;
  downloadRemote: DownloadAttachment;
}

export interface ArtifactService {
  get(artifactId: string): Promise<SafeArtifactMetadata | null>;
  read(artifactId: string): Promise<ArtifactReadResult>;
  load(artifactId: string, maxBytes?: number): Promise<ArtifactLoadResult>;
}

export function createArtifactService(input: {
  accountId: string;
  conversationKey: string;
  config?: AgentArtifactsConfig;
  dependencies?: Partial<ArtifactServiceDependencies>;
}): ArtifactService {
  const dependencies: ArtifactServiceDependencies = {
    artifacts: getStorage().artifacts,
    stagingBucket: requireEnv("ARTIFACT_STAGING_BUCKET_NAME"),
    now: Date.now,
    readManaged: readS3BytesBounded,
    createInvocationId: randomUUID,
    remoteClient: createRemoteArtifactDriverClient,
    downloadRemote: async (...args) => (await import("./artifacts.ts")).downloadAttachment(...args),
    ...input.dependencies,
  };

  const find = (artifactId: string) =>
    dependencies.artifacts.getById(input.accountId, input.conversationKey, artifactId);

  async function markExpired(record: ArtifactRecord, failureCode: string): Promise<ArtifactRecord> {
    return (await dependencies.artifacts.update(input.accountId, input.conversationKey, record.artifactId, {
      state: "expired",
      failureCode,
    })) ?? record;
  }

  async function readBytes(record: ArtifactRecord, maxBytes: number): Promise<Uint8Array | ArtifactLoadResult> {
    if (record.size > maxBytes) return unavailable(record, "Artifact exceeds the model read limit");
    if (record.driverId === "managed-ephemeral") {
      const key = managedKey(record);
      if (dependencies.now() - Date.parse(record.createdAt) >= MANAGED_ELIGIBILITY_MS) {
        return unavailable(await markExpired(record, "managed_eligibility_expired"), "Artifact has expired");
      }
      try {
        return await dependencies.readManaged(dependencies.stagingBucket, key, maxBytes);
      } catch (error) {
        if (isMissingArtifactObjectError(error)) {
          return unavailable(await markExpired(record, "managed_object_missing"), "Artifact has expired");
        }
        throw error;
      }
    }

    const driver = input.config?.driver;
    if (!driver) return unavailable(record, "Artifact driver is not configured");
    if (record.driverId !== driver.name || !record.externalRef) {
      return unavailable(record, "Artifact driver is not available for this artifact");
    }
    const resolved = await dependencies.remoteClient(driver).resolve({
      invocationId: `resolve:${record.artifactId}:${dependencies.createInvocationId()}`,
      artifactId: record.artifactId,
      externalRef: record.externalRef,
    });
    if (Date.parse(resolved.expiresAt) <= dependencies.now()) {
      return unavailable(record, "Artifact driver returned an expired transfer capability");
    }
    const downloaded = await dependencies.downloadRemote({
      url: resolved.url,
      headers: resolved.headers,
      allowedHosts: driver.allowedHosts,
    }, maxBytes);
    return downloaded.bytes;
  }

  async function load(artifactId: string, maxBytes = MAX_ARTIFACT_MODEL_BYTES): Promise<ArtifactLoadResult> {
    const record = await find(artifactId);
    if (!record) return { status: "unavailable", reason: "Artifact not found" };
    if (record.state !== "ready") return unavailable(record, `Artifact is ${record.state}`);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_ARTIFACT_MODEL_BYTES) {
      return unavailable(record, "Artifact read limit is invalid");
    }
    try {
      const value = await readBytes(record, maxBytes);
      if (!(value instanceof Uint8Array)) return value;
      if (value.byteLength !== record.size || createHash("sha256").update(value).digest("hex") !== record.sha256) {
        return unavailable(record, "Artifact content failed integrity validation");
      }
      return { status: "ready", artifact: safeMetadata(record), bytes: value };
    } catch (error) {
      return unavailable(record, publicReadError(error));
    }
  }

  return {
    async get(artifactId) {
      const record = await find(artifactId);
      return record ? safeMetadata(record) : null;
    },

    async read(artifactId) {
      const record = await find(artifactId);
      if (!record) return { status: "unavailable", reason: "Artifact not found" };
      if (record.state !== "ready") return unavailable(record, `Artifact is ${record.state}`);
      if (!isTextMediaType(record.mediaType)) return { status: "binary", artifact: safeMetadata(record) };

      const loaded = await load(artifactId, MAX_ARTIFACT_TOOL_BYTES);
      if (loaded.status !== "ready") return loaded;
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes);
        return {
          status: "ready",
          artifact: safeMetadata(record),
          text: decoded.slice(0, MAX_ARTIFACT_TEXT_CHARS),
          truncated: decoded.length > MAX_ARTIFACT_TEXT_CHARS,
        };
      } catch (error) {
        return unavailable(record, publicReadError(error));
      }
    },

    load,
  };
}

function managedKey(record: ArtifactRecord): string {
  if (!record.externalRef?.startsWith(MANAGED_ARTIFACT_REF_PREFIX)) {
    throw new Error("Managed artifact reference is invalid");
  }
  const key = record.externalRef.slice(MANAGED_ARTIFACT_REF_PREFIX.length);
  if (!key || key.startsWith("/") || key.includes("..")) throw new Error("Managed artifact reference is invalid");
  return key;
}

function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/") || mediaType === "application/json" || mediaType.endsWith("+json");
}

function safeMetadata(record: ArtifactRecord): SafeArtifactMetadata {
  return {
    artifactId: record.artifactId,
    filename: record.filename,
    mediaType: record.mediaType,
    kind: record.kind,
    size: record.size,
    sha256: record.sha256,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.failureCode ? { failureCode: record.failureCode } : {}),
  };
}

function unavailable(record: ArtifactRecord, reason: string): Extract<ArtifactReadResult, { status: "unavailable" }> {
  return { status: "unavailable", artifact: safeMetadata(record), reason };
}

function publicReadError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Artifact read failed";
  if (message.includes("exceeds") || message.includes("size limit")) return "Artifact exceeds the model read limit";
  return "Artifact content is unavailable";
}

function isMissingArtifactObjectError(error: unknown): boolean {
  if (isMissingS3Error(error)) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; code?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "NoSuchKey" || candidate.code === "NoSuchKey" || candidate.Code === "NoSuchKey"
    || candidate.name === "NotFound" || candidate.$metadata?.httpStatusCode === 404;
}
