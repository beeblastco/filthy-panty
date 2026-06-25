/**
 * Public remote artifact-driver protocol verification and routing tests.
 */

import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, mock } from "bun:test";
import {
  createArtifactDriverHandler,
  type ArtifactDriverHandlers,
} from "../src/artifacts.ts";

const SECRET = "driver-signing-secret";
const NOW = Date.parse("2026-06-19T12:00:00.000Z");

describe("createArtifactDriverHandler", () => {
  it("verifies and routes the exact store protocol", async () => {
    const handlers = lifecycleHandlers();
    const claimed = new Set<string>();
    const handler = createArtifactDriverHandler({
      signingSecret: SECRET,
      basePath: "/filthy-panty/artifacts",
      now: () => NOW,
      claimNonce: (nonce) => !claimed.has(nonce) && Boolean(claimed.add(nonce)),
      handlers,
    });
    const payload = storePayload();
    const response = await handler(signedRequest("store", payload));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ externalRef: "tenant/object-1", metadata: { region: "eu" } });
    expect(handlers.store).toHaveBeenCalledWith(payload);
  });

  it("rejects invalid signatures before claiming a nonce", async () => {
    const claimNonce = mock(async () => true);
    const handler = createArtifactDriverHandler({
      signingSecret: SECRET,
      basePath: "/filthy-panty/artifacts",
      now: () => NOW,
      claimNonce,
      handlers: lifecycleHandlers(),
    });
    const request = signedRequest("store", storePayload());
    request.headers.set("x-filthy-panty-signature", `v1=${"0".repeat(64)}`);

    expect((await handler(request)).status).toBe(401);
    expect(claimNonce).not.toHaveBeenCalled();
  });

  it("rejects stale timestamps and replayed nonces", async () => {
    const claimNonce = mock(async () => false);
    const handler = createArtifactDriverHandler({
      signingSecret: SECRET,
      basePath: "/filthy-panty/artifacts",
      now: () => NOW,
      maxTimestampSkewSeconds: 60,
      claimNonce,
      handlers: lifecycleHandlers(),
    });

    const stale = signedRequest("store", storePayload(), { timestamp: Math.floor(NOW / 1000) - 61 });
    expect((await handler(stale)).status).toBe(401);
    expect(claimNonce).not.toHaveBeenCalled();

    const replay = signedRequest("store", storePayload());
    expect((await handler(replay)).status).toBe(409);
    expect(claimNonce).toHaveBeenCalledTimes(1);
  });

  it("requires exact paths, query, POST, and matching idempotency keys", async () => {
    const handler = createArtifactDriverHandler({
      signingSecret: SECRET,
      basePath: "/driver",
      query: "?tenant=one",
      now: () => NOW,
      claimNonce: async () => true,
      handlers: lifecycleHandlers(),
    });
    expect((await handler(new Request("https://driver.example/driver/store?tenant=one"))).status).toBe(405);
    expect((await handler(signedRequest("store", storePayload(), { basePath: "/other", query: "?tenant=one" }))).status).toBe(404);
    expect((await handler(signedRequest("store", storePayload(), { basePath: "/driver", query: "?tenant=two" }))).status).toBe(404);
    expect((await handler(signedRequest("store", storePayload(), {
      basePath: "/driver",
      query: "?tenant=one",
      idempotencyKey: "different",
    }))).status).toBe(400);
  });

  it("routes resolve and delete with validated results", async () => {
    const handlers = lifecycleHandlers();
    const handler = createArtifactDriverHandler({
      signingSecret: SECRET,
      basePath: "/filthy-panty/artifacts",
      now: () => NOW,
      claimNonce: async () => true,
      handlers,
    });
    const reference = {
      invocationId: "resolve:art_1:req_1",
      artifactId: "art_1",
      externalRef: "tenant/object-1",
    };

    const resolveResponse = await handler(signedRequest("resolve", reference, { nonce: "resolve-nonce" }));
    expect(await resolveResponse.json()).toEqual({
      url: "https://media.example/object-1",
      expiresAt: "2026-06-19T12:05:00.000Z",
      headers: { authorization: "Bearer grant" },
    });

    const deletePayload = { ...reference, invocationId: "delete:art_1:req_1" };
    const deleteResponse = await handler(signedRequest("delete", deletePayload, { nonce: "delete-nonce" }));
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.text()).toBe("");
    expect(handlers.delete).toHaveBeenCalledWith(deletePayload);

  });

  it("bounds request bodies and rejects URL-shaped external references", async () => {
    const handler = createArtifactDriverHandler({
      signingSecret: SECRET,
      basePath: "/filthy-panty/artifacts",
      maxBodyBytes: 128,
      now: () => NOW,
      claimNonce: async () => true,
      handlers: lifecycleHandlers(),
    });
    const oversized = signedRequest("store", { ...storePayload(), padding: "x".repeat(512) });
    expect((await handler(oversized)).status).toBe(413);

    const invalidRef = {
      invocationId: "delete:art_1:req_1",
      artifactId: "art_1",
      externalRef: "https://storage.example/object-1",
    };
    expect((await handler(signedRequest("delete", invalidRef, { nonce: "invalid-ref" }))).status).toBe(500);
  });
});

function lifecycleHandlers(): ArtifactDriverHandlers & Record<keyof ArtifactDriverHandlers, ReturnType<typeof mock>> {
  return {
    store: mock(async () => ({ externalRef: "tenant/object-1", metadata: { region: "eu" } })),
    resolve: mock(async () => ({
      url: "https://media.example/object-1",
      expiresAt: "2026-06-19T12:05:00.000Z",
      headers: { authorization: "Bearer grant" },
    })),
    delete: mock(async () => {}),
  };
}

function storePayload() {
  return {
    invocationId: "store:art_1",
    artifact: {
      artifactId: "art_1",
      filename: "photo.jpg",
      mediaType: "image/jpeg",
      kind: "image" as const,
      size: 42,
      sha256: "a".repeat(64),
    },
    owner: { accountId: "acct_1", agentId: "agent_1", conversationKey: "conv_1" },
    transfer: { url: "https://transfer.example/object?signature=secret", expiresInSeconds: 300 },
  };
}

function signedRequest(
  operation: "store" | "resolve" | "delete",
  payload: unknown,
  options: {
    timestamp?: number;
    nonce?: string;
    basePath?: string;
    query?: string;
    idempotencyKey?: string;
  } = {},
): Request {
  const timestamp = String(options.timestamp ?? Math.floor(NOW / 1000));
  const nonce = options.nonce ?? "nonce-1";
  const basePath = options.basePath ?? "/filthy-panty/artifacts";
  const query = options.query ?? "";
  const pathname = `${basePath}/${operation}`;
  const body = JSON.stringify(payload);
  const digest = createHash("sha256").update(body).digest("hex");
  const canonical = ["v1", timestamp, nonce, "POST", `${pathname}${query}`, digest].join("\n");
  const signature = createHmac("sha256", SECRET).update(canonical).digest("hex");
  const invocationId = (payload as { invocationId?: string }).invocationId ?? "unknown";
  return new Request(`https://driver.example${pathname}${query}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": options.idempotencyKey ?? invocationId,
      "x-filthy-panty-timestamp": timestamp,
      "x-filthy-panty-nonce": nonce,
      "x-filthy-panty-content-sha256": digest,
      "x-filthy-panty-signature": `v1=${signature}`,
    },
    body,
  });
}
