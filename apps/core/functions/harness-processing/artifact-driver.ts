/**
 * Remote artifact-driver lifecycle protocol. Keep transfer orchestration in the caller and uploaded-driver execution elsewhere.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { assertPublicHttpsUrl } from "../_shared/http.ts";
import type { AgentRemoteArtifactDriverConfig } from "../_shared/storage/agent-config.ts";
import { pinnedHttpsFetch } from "../_shared/pinned-https.ts";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_EXTERNAL_REF_BYTES = 2_048;

export type ArtifactDriverOperation = "store" | "resolve" | "delete";

export interface ArtifactDriverLifecycleInput extends Record<string, unknown> {
  invocationId: string;
}

export interface ArtifactDriverStoreResult {
  externalRef: string;
  metadata?: Record<string, string>;
}

export interface ArtifactDriverResolveResult {
  url: string;
  headers?: Record<string, string>;
  expiresAt: string;
}

export interface ArtifactDriverClient {
  store(input: ArtifactDriverLifecycleInput): Promise<ArtifactDriverStoreResult>;
  resolve(input: ArtifactDriverLifecycleInput): Promise<ArtifactDriverResolveResult>;
  delete(input: ArtifactDriverLifecycleInput): Promise<void>;
}

export interface RemoteArtifactDriverClientOptions {
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  maxRetries?: number;
  now?: () => number;
  nonce?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** Creates a bounded, signed client for one validated remote artifact driver. */
export function createRemoteArtifactDriverClient(
  config: AgentRemoteArtifactDriverConfig,
  options: RemoteArtifactDriverClientOptions = {},
): ArtifactDriverClient {
  const endpoint = validateRemoteConfig(config);
  const fetchImpl = options.fetch ?? ((input, init) => pinnedHttpsFetch(input, init, {
    allowedHosts: config.allowedHosts,
  }));
  const timeoutMs = boundedInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs", 1, 30_000);
  const maxRetries = boundedInteger(options.maxRetries ?? DEFAULT_MAX_RETRIES, "maxRetries", 0, 3);
  const now = options.now ?? Date.now;
  const nonce = options.nonce ?? randomUUID;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  async function call(operation: ArtifactDriverOperation, input: ArtifactDriverLifecycleInput): Promise<unknown> {
    const idempotencyKey = validateInvocationId(input.invocationId);
    const body = JSON.stringify(input);
    const url = operationUrl(endpoint, operation);

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const timestamp = String(Math.floor(now() / 1_000));
      const requestNonce = nonce();
      const bodyDigest = createHash("sha256").update(body).digest("hex");
      const canonical = ["v1", timestamp, requestNonce, "POST", `${url.pathname}${url.search}`, bodyDigest].join("\n");
      const signature = createHmac("sha256", config.signingSecret).update(canonical).digest("hex");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(url, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
            "x-filthy-panty-timestamp": timestamp,
            "x-filthy-panty-nonce": requestNonce,
            "x-filthy-panty-content-sha256": bodyDigest,
            "x-filthy-panty-signature": `v1=${signature}`,
          },
          body,
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (attempt < maxRetries && isRetryableStatus(response.status)) {
            await sleep(retryDelay(attempt));
            continue;
          }
          throw new Error(`Artifact driver ${operation} failed with HTTP ${response.status}`);
        }
        if (operation === "delete") {
          await readBoundedBody(response);
          return undefined;
        }
        return parseJson(await readBoundedBody(response), operation);
      } catch (error) {
        if (attempt < maxRetries && isRetryableError(error)) {
          await sleep(retryDelay(attempt));
          continue;
        }
        throw sanitizeTransportError(error, operation);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`Artifact driver ${operation} failed`);
  }

  return {
    async store(input) {
      return parseStoreResult(await call("store", input));
    },
    async resolve(input) {
      return parseResolveResult(await call("resolve", input), config.allowedHosts);
    },
    async delete(input) {
      await call("delete", input);
    },
  };
}

function validateRemoteConfig(config: AgentRemoteArtifactDriverConfig): URL {
  if (!config.signingSecret) throw new Error("Artifact driver signing secret is required");
  const endpoint = assertPublicHttpsUrl(config.endpoint, "Artifact driver endpoint");
  if (endpoint.username || endpoint.password || endpoint.port || endpoint.hash) {
    throw new Error("Artifact driver endpoint must not include credentials, a custom port, or a fragment");
  }
  const hosts = validateAllowedHosts(config.allowedHosts);
  if (!hosts.includes(endpoint.hostname.toLowerCase())) {
    throw new Error("Artifact driver endpoint hostname must be present in allowedHosts");
  }
  return endpoint;
}

function validateAllowedHosts(values: string[]): string[] {
  if (!Array.isArray(values) || values.length === 0) throw new Error("Artifact driver allowedHosts is required");
  return values.map((value) => {
    const host = value.toLowerCase();
    if (host.includes(":") || host.includes("/") || host.includes("*") ||
      !host.split(".").every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))) {
      throw new Error("Artifact driver allowedHosts must contain exact DNS hostnames");
    }
    assertPublicHttpsUrl(`https://${host}`, "Artifact driver allowedHosts entry");
    return host;
  });
}

function operationUrl(endpoint: URL, operation: ArtifactDriverOperation): URL {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${operation}`;
  return url;
}

async function readBoundedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("Artifact driver response exceeds the size limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Artifact driver response exceeds the size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseJson(body: string, operation: ArtifactDriverOperation): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Artifact driver ${operation} returned invalid JSON`);
  }
}

function parseStoreResult(value: unknown): ArtifactDriverStoreResult {
  const result = requireObject(value, "store");
  const externalRef = validateExternalRef(result.externalRef);
  const metadata = result.metadata === undefined ? undefined : requireStringRecord(result.metadata, "store metadata");
  return { externalRef, ...(metadata ? { metadata } : {}) };
}

function parseResolveResult(value: unknown, allowedHosts: string[]): ArtifactDriverResolveResult {
  const result = requireObject(value, "resolve");
  if (typeof result.url !== "string") throw new Error("Artifact driver resolve response requires url");
  const url = assertPublicHttpsUrl(result.url, "Artifact driver resolve URL");
  if (!validateAllowedHosts(allowedHosts).includes(url.hostname.toLowerCase())) {
    throw new Error("Artifact driver resolve URL hostname is not allowed");
  }
  if (url.username || url.password || url.port || url.hash) {
    throw new Error("Artifact driver resolve URL must not include credentials, a custom port, or a fragment");
  }
  if (typeof result.expiresAt !== "string" || !Number.isFinite(Date.parse(result.expiresAt))) {
    throw new Error("Artifact driver resolve response requires a valid expiresAt timestamp");
  }
  const headers = result.headers === undefined ? undefined : requireStringRecord(result.headers, "resolve headers");
  return { url: url.toString(), expiresAt: result.expiresAt, ...(headers ? { headers } : {}) };
}

function validateExternalRef(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Artifact driver response requires externalRef");
  if (Buffer.byteLength(value) > MAX_EXTERNAL_REF_BYTES) throw new Error("Artifact driver externalRef exceeds the size limit");
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) throw new Error("Artifact driver externalRef must be opaque and must not use a URI scheme");
  return value;
}

function requireObject(value: unknown, operation: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Artifact driver ${operation} response must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireStringRecord(value: unknown, label: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !Object.values(value).every((entry) => typeof entry === "string")) {
    throw new Error(`Artifact driver ${label} must contain only string values`);
  }
  return value as Record<string, string>;
}

function validateInvocationId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw new Error("Artifact driver invocationId contains invalid characters");
  }
  return value;
}

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Artifact driver ${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  return error.name === "AbortError" || error instanceof TypeError;
}

function retryDelay(attempt: number): number {
  return Math.min(100 * (2 ** attempt), 1_000);
}

function sanitizeTransportError(error: unknown, operation: ArtifactDriverOperation): Error {
  if (error instanceof Error && error.message.startsWith("Artifact driver")) return error;
  return new Error(`Artifact driver ${operation} request failed`);
}
