/**
 * Artifact workspace routing and integrity-checked working-copy materialization.
 * Provider transport and archive extraction do not belong in this boundary.
 */

import { ensureS3DirectoryMarkers, writeS3Object } from "../_shared/s3.ts";
import { requireEnv } from "../_shared/env.ts";
import { workspaceNamespacePrefix } from "../_shared/sandbox.ts";
import type { ArtifactKind } from "../_shared/storage/index.ts";
import type { AgentArtifactsConfig } from "../_shared/storage/agent-config.ts";
import type { ResolvedWorkspace } from "../_shared/workspaces.ts";
import { supportsArtifactMediaType, type ArtifactModelCapabilities } from "./artifact-projection.ts";
import { MAX_ARTIFACT_MODEL_BYTES, type ArtifactService } from "./artifact-service.ts";

const ARTIFACT_ID_PATTERN = /^art_[a-f0-9]{64}$/;

export interface ArtifactMaterializationResult {
  workspaceName: string;
  workspacePath: string;
}

interface MaterializationDependencies {
  ensureDirectories(bucket: string, key: string): Promise<void>;
  writeObject(
    bucket: string,
    key: string,
    bytes: Uint8Array,
    options: { contentType: string; executable: false; metadata: Record<string, string> },
  ): Promise<number>;
}

const defaultDependencies: MaterializationDependencies = {
  ensureDirectories: ensureS3DirectoryMarkers,
  writeObject: writeS3Object,
};

export async function materializeArtifact(input: {
  artifactId: string;
  filename: string;
  mediaType: string;
  kind: ArtifactKind;
  config?: AgentArtifactsConfig;
  capabilities: ArtifactModelCapabilities;
  workspaces: ResolvedWorkspace[];
  service: ArtifactService;
  filesystemBucket?: string;
  dependencies?: Partial<MaterializationDependencies>;
}): Promise<ArtifactMaterializationResult | null> {
  if (!shouldMaterialize(input)) return null;
  const workspace = selectArtifactWorkspace(input.workspaces, input.config?.workspace?.name);
  if (!workspace) return null;

  const workspacePath = artifactWorkspacePath(input.artifactId, input.filename);
  const loaded = await input.service.load(input.artifactId, MAX_ARTIFACT_MODEL_BYTES);
  if (loaded.status !== "ready") return null;

  const bucket = input.filesystemBucket ?? requireEnv("FILESYSTEM_BUCKET_NAME");
  const key = `${workspaceNamespacePrefix(workspace.namespace)}/${workspacePath}`;
  const dependencies = { ...defaultDependencies, ...input.dependencies };
  await dependencies.ensureDirectories(bucket, key);
  await dependencies.writeObject(bucket, key, loaded.bytes, {
    contentType: loaded.artifact.mediaType,
    executable: false,
    metadata: {
      "artifact-id": loaded.artifact.artifactId,
      "artifact-sha256": loaded.artifact.sha256,
    },
  });

  return { workspaceName: workspace.name, workspacePath };
}

export function selectArtifactWorkspace(
  workspaces: readonly ResolvedWorkspace[],
  configuredName?: string,
): ResolvedWorkspace | null {
  const writable = workspaces.filter((workspace) => workspace.sandbox !== undefined);
  if (configuredName) return writable.find((workspace) => workspace.name === configuredName) ?? null;
  return writable.length === 1 ? writable[0]! : null;
}

export function artifactWorkspacePath(artifactId: string, filename: string): string {
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) throw new Error("Artifact ID is invalid for workspace materialization");
  if (!filename || filename === "." || filename === ".." || filename.includes("/") || filename.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(filename)) {
    throw new Error("Artifact filename is invalid for workspace materialization");
  }
  return `.artifacts/${artifactId}/${filename}`;
}

function shouldMaterialize(input: {
  mediaType: string;
  kind: ArtifactKind;
  config?: AgentArtifactsConfig;
  capabilities: ArtifactModelCapabilities;
}): boolean {
  const mode = input.config?.workspace?.materialize ?? "complex";
  if (mode === "never") return false;
  const processing = input.config?.processing;
  if (input.kind === "audio" && (processing?.audio ?? "reject") !== "workspace") return false;
  if (mode === "all") return true;

  const native = input.kind === "image"
    ? supportsArtifactMediaType(input.capabilities.imageMediaTypes, input.mediaType)
    : supportsArtifactMediaType(input.capabilities.fileMediaTypes, input.mediaType);
  if (native) return false;
  if (input.mediaType === "application/zip") return (processing?.archives ?? "workspace") === "workspace";
  return (processing?.unsupportedFiles ?? "workspace") === "workspace";
}
