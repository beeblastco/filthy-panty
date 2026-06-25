/**
 * Runnable developer-owned artifact driver for the Telegram channel demo.
 * Local disk and the in-memory nonce store are single-process demo choices.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createArtifactDriverHandler,
  type ArtifactDriverArtifact,
} from "filthy-panty/artifacts";

const signingSecret = requiredEnv("ARTIFACT_DRIVER_SIGNING_SECRET");
const publicBaseUrl = new URL(requiredEnv("ARTIFACT_DRIVER_PUBLIC_BASE_URL"));
if (publicBaseUrl.protocol !== "https:") throw new Error("ARTIFACT_DRIVER_PUBLIC_BASE_URL must use HTTPS");
const dataDirectory = process.env.ARTIFACT_DRIVER_DATA_DIR ?? join(import.meta.dir, ".artifact-data");
const maxArtifactBytes = 20 * 1024 * 1024;
const nonceExpiries = new Map<string, number>();

const lifecycle = createArtifactDriverHandler({
  signingSecret,
  basePath: "/filthy-panty/artifacts",
  claimNonce(nonce, expiresAt) {
    const now = Date.now();
    for (const [key, expiry] of nonceExpiries) if (expiry <= now) nonceExpiries.delete(key);
    if ((nonceExpiries.get(nonce) ?? 0) > now) return false;
    nonceExpiries.set(nonce, expiresAt.getTime());
    return true;
  },
  handlers: {
    async store(input) {
      const bytes = await downloadBounded(input.transfer.url, maxArtifactBytes);
      if (bytes.byteLength !== input.artifact.size || sha256(bytes) !== input.artifact.sha256) {
        throw new Error("Transferred artifact failed integrity validation");
      }
      await mkdir(dataDirectory, { recursive: true });
      const externalRef = externalReference(input.artifact);
      await Bun.write(dataPath(externalRef), bytes);
      await Bun.write(metadataPath(externalRef), JSON.stringify({
        filename: input.artifact.filename,
        mediaType: input.artifact.mediaType,
      }));
      return { externalRef };
    },
    async resolve(input) {
      if (!(await Bun.file(dataPath(input.externalRef)).exists())) throw new Error("Artifact not found");
      const expires = Math.floor(Date.now() / 1000) + 300;
      const token = readGrant(input.externalRef, expires);
      const url = new URL(`/files/${encodeURIComponent(input.externalRef)}`, publicBaseUrl);
      url.searchParams.set("expires", String(expires));
      url.searchParams.set("token", token);
      return { url: url.toString(), expiresAt: new Date(expires * 1000).toISOString() };
    },
    async delete(input) {
      await Promise.all([
        rm(dataPath(input.externalRef), { force: true }),
        rm(metadataPath(input.externalRef), { force: true }),
      ]);
    },
  },
});

const server = Bun.serve({
  port: Number(process.env.PORT ?? "8787"),
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.startsWith("/files/")) return serveReadGrant(url);
    return lifecycle(request);
  },
});

console.log(`Artifact driver listening on ${server.url}`);

async function serveReadGrant(url: URL): Promise<Response> {
  let externalRef: string;
  try {
    externalRef = decodeURIComponent(url.pathname.slice("/files/".length));
    assertExternalReference(externalRef);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const expires = Number(url.searchParams.get("expires"));
  const token = url.searchParams.get("token") ?? "";
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000) || !safeEqual(token, readGrant(externalRef, expires))) {
    return new Response("Not found", { status: 404 });
  }
  const file = Bun.file(dataPath(externalRef));
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  const metadata = await Bun.file(metadataPath(externalRef)).json() as { mediaType?: string };
  return new Response(file, { headers: { "content-type": metadata.mediaType ?? "application/octet-stream" } });
}

async function downloadBounded(url: string, maxBytes: number): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok || !response.body) throw new Error(`Transfer failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Transfer exceeds size limit");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("Transfer exceeds size limit");
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

function externalReference(artifact: ArtifactDriverArtifact): string {
  return `objects/${artifact.artifactId}`;
}

function assertExternalReference(value: string): void {
  if (!/^objects\/art_[a-f0-9]{64}$/.test(value)) throw new Error("Invalid artifact reference");
}

function dataPath(externalRef: string): string {
  assertExternalReference(externalRef);
  return join(dataDirectory, `${externalRef.slice("objects/".length)}.bin`);
}

function metadataPath(externalRef: string): string {
  assertExternalReference(externalRef);
  return join(dataDirectory, `${externalRef.slice("objects/".length)}.json`);
}

function readGrant(externalRef: string, expires: number): string {
  return createHmac("sha256", signingSecret).update(`${externalRef}\n${expires}`).digest("hex");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
