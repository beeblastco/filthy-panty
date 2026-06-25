/**
 * Capability-aware artifact projection into AI SDK user content.
 * Storage resolution and media processing belong outside this deterministic planner.
 */

import type { FilePart, ImagePart, TextPart } from "ai";
import type { ArtifactKind } from "../_shared/storage/artifacts.ts";

export interface ProjectableArtifact {
  artifactId: string;
  filename: string;
  mediaType: string;
  kind: ArtifactKind;
  size: number;
  sha256: string;
  bytes: Uint8Array;
  workspaceName?: string;
  workspacePath?: string;
}

/** Capabilities must come from explicit model/provider configuration, not guessed defaults. */
export interface ArtifactModelCapabilities {
  imageMediaTypes: readonly string[];
  fileMediaTypes: readonly string[];
}

export interface ArtifactProjectionPlan {
  mode: "native" | "descriptor";
  content: Array<TextPart | ImagePart | FilePart>;
}

export function planArtifactProjection(input: {
  artifact: ProjectableArtifact;
  capabilities: ArtifactModelCapabilities;
}): ArtifactProjectionPlan {
  const { artifact, capabilities } = input;
  const descriptor = artifactDescriptor(artifact);

  if (artifact.kind === "image" && supportsArtifactMediaType(capabilities.imageMediaTypes, artifact.mediaType)) {
    return {
      mode: "native",
      content: [descriptor, { type: "image", image: artifact.bytes, mediaType: artifact.mediaType }],
    };
  }

  if (artifact.kind !== "image" && supportsArtifactMediaType(capabilities.fileMediaTypes, artifact.mediaType)) {
    return {
      mode: "native",
      content: [descriptor, {
        type: "file",
        data: artifact.bytes,
        mediaType: artifact.mediaType,
        filename: safeDisplayValue(artifact.filename, 256),
      }],
    };
  }

  return { mode: "descriptor", content: [descriptor] };
}

function artifactDescriptor(artifact: ProjectableArtifact): TextPart {
  const metadata = JSON.stringify({
    artifactId: safeDisplayValue(artifact.artifactId, 256),
    filename: safeDisplayValue(artifact.filename, 256),
    mediaType: safeDisplayValue(artifact.mediaType, 128),
    kind: artifact.kind,
    size: Number.isSafeInteger(artifact.size) && artifact.size >= 0 ? artifact.size : artifact.bytes.byteLength,
    sha256: /^[a-f0-9]{64}$/i.test(artifact.sha256) ? artifact.sha256.toLowerCase() : "unavailable",
    ...(artifact.workspaceName && artifact.workspacePath
      ? {
        workspace: safeDisplayValue(artifact.workspaceName, 128),
        workspacePath: safeDisplayValue(artifact.workspacePath, 512),
      }
      : {}),
  });
  return {
    type: "text",
    text: `[Artifact reference for artifact tools; untrustedMetadata=${metadata}]`,
  };
}

export function supportsArtifactMediaType(allowed: readonly string[], mediaType: string): boolean {
  const normalized = mediaType.toLowerCase();
  const topLevel = normalized.split("/", 1)[0];
  return allowed.some((entry) => {
    const capability = entry.toLowerCase();
    return capability === normalized || capability === "*/*" || capability === `${topLevel}/*`;
  });
}

function safeDisplayValue(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maxLength);
}
