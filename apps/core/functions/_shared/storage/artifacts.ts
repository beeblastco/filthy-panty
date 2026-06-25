/**
 * Artifact control-plane records and validation.
 * Byte storage and access URLs belong to the configured artifact driver.
 */

import { createHash } from "node:crypto";

export const ARTIFACT_STATES = ["pending", "ready", "failed", "expired", "deleted"] as const;
export type ArtifactState = (typeof ARTIFACT_STATES)[number];

export const ARTIFACT_KINDS = ["image", "audio", "video", "document", "file"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const MANAGED_ARTIFACT_REF_PREFIX = "managed-staging/";

export interface ArtifactRecord {
  artifactId: string;
  accountId: string;
  agentId: string;
  conversationKey: string;
  sourceEventId: string;
  sourceAttachmentId: string;
  driverId: string;
  externalRef?: string;
  filename: string;
  mediaType: string;
  kind: ArtifactKind;
  size: number;
  sha256: string;
  state: ArtifactState;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface CreateArtifactInput {
  agentId: string;
  conversationKey: string;
  sourceEventId: string;
  sourceAttachmentId: string;
  driverId: string;
  externalRef?: string;
  filename: string;
  mediaType: string;
  kind: ArtifactKind;
  size: number;
  sha256: string;
  state?: ArtifactState;
  failureCode?: string;
}

export interface UpdateArtifactInput {
  state?: ArtifactState;
  driverId?: string;
  externalRef?: string | null;
  failureCode?: string | null;
}

const ID_MAX_LENGTH = 512;
const EXTERNAL_REF_MAX_LENGTH = 4096;
const FILENAME_MAX_LENGTH = 512;
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const URI_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function requiredBoundedString(value: unknown, name: string, maxLength = ID_MAX_LENGTH): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`${name} must be a non-empty string no longer than ${maxLength} characters`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${name} must not contain control characters`);
  }
  return value;
}

/** Validates a driver-owned reference without interpreting or logging it. */
export function normalizeArtifactExternalRef(value: unknown): string {
  const normalized = requiredBoundedString(value, "externalRef", EXTERNAL_REF_MAX_LENGTH);
  if (URI_SCHEME_PATTERN.test(normalized)) {
    throw new Error("externalRef must be opaque and must not use a URI scheme");
  }
  return normalized;
}

/** Returns the account-owned staging prefix used by ingestion and account cleanup. */
export function artifactStagingAccountPrefix(accountId: string): string {
  const hash = createHash("sha256").update(requiredBoundedString(accountId, "accountId")).digest("hex").slice(0, 24);
  return `staging/${hash}/`;
}

/** Builds the stable artifact ID used to converge duplicate provider deliveries. */
export function createArtifactId(
  accountId: string,
  input: Pick<CreateArtifactInput, "agentId" | "conversationKey" | "sourceEventId" | "sourceAttachmentId">,
): string {
  const identity = [
    requiredBoundedString(accountId, "accountId"),
    requiredBoundedString(input.agentId, "agentId"),
    requiredBoundedString(input.conversationKey, "conversationKey"),
    requiredBoundedString(input.sourceEventId, "sourceEventId"),
    requiredBoundedString(input.sourceAttachmentId, "sourceAttachmentId"),
  ].join("\u0000");
  return `art_${createHash("sha256").update(identity).digest("hex")}`;
}

/** Validates create input and applies default state without storing access URLs. */
export function normalizeCreateArtifactInput(input: CreateArtifactInput): Required<Omit<CreateArtifactInput, "externalRef" | "failureCode">> & Pick<CreateArtifactInput, "externalRef" | "failureCode"> {
  const state = input.state ?? "pending";
  if (!ARTIFACT_STATES.includes(state)) throw new Error("Invalid artifact state");
  if (!ARTIFACT_KINDS.includes(input.kind)) throw new Error("Invalid artifact kind");
  if (!Number.isSafeInteger(input.size) || input.size < 0) {
    throw new Error("size must be a non-negative safe integer");
  }
  if (!MEDIA_TYPE_PATTERN.test(input.mediaType)) throw new Error("mediaType must be a valid MIME type");
  if (!SHA256_PATTERN.test(input.sha256)) throw new Error("sha256 must be a 64-character hex digest");

  const externalRef = input.externalRef === undefined
    ? undefined
    : normalizeArtifactExternalRef(input.externalRef);
  if (state === "ready" && !externalRef) throw new Error("Ready artifacts require externalRef");

  return {
    agentId: requiredBoundedString(input.agentId, "agentId"),
    conversationKey: requiredBoundedString(input.conversationKey, "conversationKey"),
    sourceEventId: requiredBoundedString(input.sourceEventId, "sourceEventId"),
    sourceAttachmentId: requiredBoundedString(input.sourceAttachmentId, "sourceAttachmentId"),
    driverId: requiredBoundedString(input.driverId, "driverId"),
    ...(externalRef ? { externalRef } : {}),
    filename: requiredBoundedString(input.filename, "filename", FILENAME_MAX_LENGTH),
    mediaType: input.mediaType.toLowerCase(),
    kind: input.kind,
    size: input.size,
    sha256: input.sha256.toLowerCase(),
    state,
    ...(input.failureCode
      ? { failureCode: requiredBoundedString(input.failureCode, "failureCode", 128) }
      : {}),
  };
}

/** Validates a state update while preserving an explicit null as field removal. */
export function normalizeUpdateArtifactInput(input: UpdateArtifactInput): UpdateArtifactInput {
  if (input.state !== undefined && !ARTIFACT_STATES.includes(input.state)) {
    throw new Error("Invalid artifact state");
  }
  const externalRef = input.externalRef == null
    ? input.externalRef
    : normalizeArtifactExternalRef(input.externalRef);
  const failureCode = input.failureCode == null
    ? input.failureCode
    : requiredBoundedString(input.failureCode, "failureCode", 128);
  if (input.state === "ready" && input.externalRef === null) {
    throw new Error("Ready artifacts require externalRef");
  }
  return {
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(input.driverId !== undefined
      ? { driverId: requiredBoundedString(input.driverId, "driverId") }
      : {}),
    ...(externalRef !== undefined ? { externalRef } : {}),
    ...(failureCode !== undefined ? { failureCode } : {}),
  };
}

/** Enforces lifecycle transitions shared by every storage adapter. */
export function assertArtifactStateTransition(current: ArtifactState, next: ArtifactState): void {
  if (current === next) return;
  const allowed: Record<ArtifactState, readonly ArtifactState[]> = {
    pending: ["ready", "failed", "deleted"],
    ready: ["expired", "deleted"],
    failed: ["deleted"],
    expired: ["deleted"],
    deleted: [],
  };
  if (!allowed[current].includes(next)) {
    throw new Error(`Invalid artifact state transition: ${current} -> ${next}`);
  }
}
