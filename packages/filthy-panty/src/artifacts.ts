/**
 * Public server contract for developer-hosted remote artifact drivers.
 * This module verifies core lifecycle requests before invoking storage handlers.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const ARTIFACT_DRIVER_OPERATIONS = ["store", "resolve", "delete"] as const;
export type ArtifactDriverOperation = (typeof ARTIFACT_DRIVER_OPERATIONS)[number];

export interface ArtifactDriverArtifact {
  artifactId: string;
  filename: string;
  mediaType: string;
  kind: "image" | "audio" | "video" | "document" | "file";
  size: number;
  sha256: string;
}

export interface ArtifactDriverOwner {
  accountId: string;
  agentId: string;
  conversationKey: string;
}

export interface ArtifactTransferGrant {
  url: string;
  expiresInSeconds: number;
}

export interface StoreArtifactRequest {
  invocationId: string;
  artifact: ArtifactDriverArtifact;
  owner: ArtifactDriverOwner;
  transfer: ArtifactTransferGrant;
}

export interface ResolveArtifactRequest {
  invocationId: string;
  artifactId: string;
  externalRef: string;
}

export interface DeleteArtifactRequest extends ResolveArtifactRequest {}

export interface StoreArtifactResult {
  externalRef: string;
  metadata?: Record<string, string>;
}

export interface ResolveArtifactResult {
  url: string;
  headers?: Record<string, string>;
  expiresAt: string;
}

export interface ArtifactDriverHandlers {
  store(input: StoreArtifactRequest): Promise<StoreArtifactResult> | StoreArtifactResult;
  resolve(input: ResolveArtifactRequest): Promise<ResolveArtifactResult> | ResolveArtifactResult;
  delete(input: DeleteArtifactRequest): Promise<void> | void;
}

export interface ArtifactDriverHandlerOptions {
  signingSecret: string;
  handlers: ArtifactDriverHandlers;
  /** Exact URL prefix before `/store`, `/resolve`, or `/delete`. */
  basePath?: string;
  /** Exact query string configured on the core endpoint, including the leading `?`. */
  query?: string;
  /** Atomically claims a verified nonce. Return false when it was already used. */
  claimNonce(nonce: string, expiresAt: Date): Promise<boolean> | boolean;
  maxTimestampSkewSeconds?: number;
  maxBodyBytes?: number;
  now?: () => number;
}

const DEFAULT_MAX_SKEW_SECONDS = 300;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const INVOCATION_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** Creates an exact-path Fetch handler for the remote artifact lifecycle protocol. */
export function createArtifactDriverHandler(options: ArtifactDriverHandlerOptions) {
  const secret = requiredString(options.signingSecret, "signingSecret", 4096);
  const basePath = normalizeBasePath(options.basePath ?? "/");
  const expectedQuery = options.query ?? "";
  if (expectedQuery && !expectedQuery.startsWith("?")) throw new Error("query must start with ?");
  const maxSkew = boundedInteger(options.maxTimestampSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS, "maxTimestampSkewSeconds", 1, 3600);
  const maxBodyBytes = boundedInteger(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, "maxBodyBytes", 1, MAX_BODY_BYTES);
  const now = options.now ?? Date.now;

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return jsonError(405, "Method not allowed", { allow: "POST" });
    const url = new URL(request.url);
    const operation = matchOperation(url.pathname, basePath);
    if (!operation || url.search !== expectedQuery) return jsonError(404, "Not found");

    let rawBody: Uint8Array;
    try {
      rawBody = await readBoundedBody(request, maxBodyBytes);
    } catch {
      return jsonError(413, "Request body exceeds the size limit");
    }

    const timestampText = request.headers.get("x-filthy-panty-timestamp") ?? "";
    const nonce = request.headers.get("x-filthy-panty-nonce") ?? "";
    const suppliedDigest = request.headers.get("x-filthy-panty-content-sha256") ?? "";
    const suppliedSignature = request.headers.get("x-filthy-panty-signature") ?? "";
    const timestamp = Number(timestampText);
    if (!Number.isSafeInteger(timestamp) || !INVOCATION_PATTERN.test(nonce) || !HEX_SHA256_PATTERN.test(suppliedDigest)) {
      return jsonError(401, "Invalid artifact driver authentication");
    }
    if (Math.abs(Math.floor(now() / 1000) - timestamp) > maxSkew) {
      return jsonError(401, "Artifact driver request timestamp is outside the allowed window");
    }

    const bodyDigest = createHash("sha256").update(rawBody).digest("hex");
    if (!safeEqual(bodyDigest, suppliedDigest)) return jsonError(401, "Invalid artifact driver authentication");
    const canonical = ["v1", timestampText, nonce, "POST", `${url.pathname}${url.search}`, bodyDigest].join("\n");
    const expectedSignature = `v1=${createHmac("sha256", secret).update(canonical).digest("hex")}`;
    if (!safeEqual(expectedSignature, suppliedSignature)) return jsonError(401, "Invalid artifact driver authentication");

    const expiresAt = new Date((timestamp + maxSkew + 1) * 1000);
    if (!(await options.claimNonce(nonce, expiresAt))) return jsonError(409, "Artifact driver request was already processed");

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
    } catch {
      return jsonError(400, "Invalid JSON body");
    }

    try {
      const invocationId = requireObject(payload, "request").invocationId;
      if (typeof invocationId !== "string" || !INVOCATION_PATTERN.test(invocationId) || request.headers.get("idempotency-key") !== invocationId) {
        return jsonError(400, "Invalid invocation id");
      }
      const response = await dispatch(operation, payload, options.handlers);
      return boundedJsonResponse(response);
    } catch {
      return jsonError(500, "Artifact driver operation failed");
    }
  };
}

async function dispatch(operation: ArtifactDriverOperation, payload: unknown, handlers: ArtifactDriverHandlers): Promise<unknown> {
  if (operation === "store") return validateStoreResult(await handlers.store(validateStoreRequest(payload)));
  if (operation === "resolve") return validateResolveResult(await handlers.resolve(validateReferenceRequest(payload)));
  if (operation === "delete") {
    await handlers.delete(validateReferenceRequest(payload));
    return null;
  }
  throw new Error("Unsupported artifact driver operation");
}

function validateStoreRequest(value: unknown): StoreArtifactRequest {
  const input = requireObject(value, "store request");
  const artifact = requireObject(input.artifact, "artifact");
  const owner = requireObject(input.owner, "owner");
  const transfer = requireObject(input.transfer, "transfer");
  const transferUrl = new URL(requiredString(transfer.url, "transfer.url", 8192));
  if (transferUrl.protocol !== "https:") throw new Error("transfer.url must use HTTPS");
  const kind = requiredString(artifact.kind, "artifact.kind", 32);
  if (!["image", "audio", "video", "document", "file"].includes(kind)) throw new Error("Invalid artifact kind");
  const size = boundedInteger(artifact.size, "artifact.size", 0, Number.MAX_SAFE_INTEGER);
  const sha256 = requiredString(artifact.sha256, "artifact.sha256", 64);
  if (!HEX_SHA256_PATTERN.test(sha256)) throw new Error("Invalid artifact checksum");
  return {
    invocationId: requiredInvocationId(input.invocationId),
    artifact: {
      artifactId: requiredString(artifact.artifactId, "artifact.artifactId", 512),
      filename: requiredString(artifact.filename, "artifact.filename", 512),
      mediaType: requiredString(artifact.mediaType, "artifact.mediaType", 256),
      kind: kind as ArtifactDriverArtifact["kind"],
      size,
      sha256,
    },
    owner: {
      accountId: requiredString(owner.accountId, "owner.accountId", 512),
      agentId: requiredString(owner.agentId, "owner.agentId", 512),
      conversationKey: requiredString(owner.conversationKey, "owner.conversationKey", 512),
    },
    transfer: {
      url: transferUrl.toString(),
      expiresInSeconds: boundedInteger(transfer.expiresInSeconds, "transfer.expiresInSeconds", 1, 3600),
    },
  };
}

function validateReferenceRequest(value: unknown): ResolveArtifactRequest {
  const input = requireObject(value, "artifact request");
  return {
    invocationId: requiredInvocationId(input.invocationId),
    artifactId: requiredString(input.artifactId, "artifactId", 512),
    externalRef: validateExternalRef(input.externalRef),
  };
}

function validateStoreResult(value: StoreArtifactResult): StoreArtifactResult {
  const result = requireObject(value, "store result");
  const metadata = result.metadata === undefined ? undefined : stringRecord(result.metadata, "metadata");
  return { externalRef: validateExternalRef(result.externalRef), ...(metadata ? { metadata } : {}) };
}

function validateResolveResult(value: ResolveArtifactResult): ResolveArtifactResult {
  const result = requireObject(value, "resolve result");
  const url = new URL(requiredString(result.url, "url", 8192));
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port) throw new Error("Resolve URL must use standard-port HTTPS");
  const expiresAt = requiredString(result.expiresAt, "expiresAt", 128);
  if (!Number.isFinite(Date.parse(expiresAt))) throw new Error("Invalid resolve expiry");
  const headers = result.headers === undefined ? undefined : stringRecord(result.headers, "headers");
  return { url: url.toString(), expiresAt, ...(headers ? { headers } : {}) };
}

function validateExternalRef(value: unknown): string {
  const ref = requiredString(value, "externalRef", 2048);
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) throw new Error("externalRef must be opaque without a URI scheme");
  return ref;
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("too large");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("too large");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function boundedJsonResponse(value: unknown): Response {
  const body = value === null ? "" : JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error("Response exceeds size limit");
  return new Response(body, { status: 200, headers: body ? { "content-type": "application/json" } : undefined });
}

function jsonError(status: number, error: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error }, { status, headers });
}

function matchOperation(pathname: string, basePath: string): ArtifactDriverOperation | null {
  for (const operation of ARTIFACT_DRIVER_OPERATIONS) {
    if (pathname === `${basePath === "/" ? "" : basePath}/${operation}`) return operation;
  }
  return null;
}

function normalizeBasePath(value: string): string {
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) throw new Error("basePath must be an absolute URL path");
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

function requiredInvocationId(value: unknown): string {
  if (typeof value !== "string" || !INVOCATION_PATTERN.test(value)) throw new Error("Invalid invocationId");
  return value;
}

function requiredString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be a bounded string`);
  }
  return value;
}

function boundedInteger(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${name} is out of range`);
  return value as number;
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function stringRecord(value: unknown, name: string): Record<string, string> {
  const object = requireObject(value, name);
  if (Object.keys(object).length > 64 || !Object.entries(object).every(([key, entry]) =>
    key.length > 0 && key.length <= 256 && typeof entry === "string" && entry.length <= 4096
  )) throw new Error(`${name} must contain bounded string values`);
  return object as Record<string, string>;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
