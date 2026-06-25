/**
 * Covers remote artifact-driver signing, transport bounds, response validation, and nested agent policy validation.
 */

import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, mock } from "bun:test";
import {
  normalizeAgentConfig,
  redactAgentConfig,
  toRuntimeAgentConfig,
  type AgentRemoteArtifactDriverConfig,
} from "../functions/_shared/storage/agent-config.ts";
import { createRemoteArtifactDriverClient } from "../functions/harness-processing/artifact-driver.ts";

const config: AgentRemoteArtifactDriverConfig = {
  name: "customer-api",
  mode: "remote",
  endpoint: "https://storage.example.com/artifacts",
  signingSecret: "driver-secret",
  allowedHosts: ["storage.example.com"],
};

describe("remote artifact driver", () => {
  it("signs store requests and sends a stable idempotency key", async () => {
    const fetchMock = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://storage.example.com/artifacts/store");
      const headers = new Headers(init?.headers);
      const body = String(init?.body);
      const digest = createHash("sha256").update(body).digest("hex");
      const canonical = ["v1", "1700000000", "nonce-1", "POST", "/artifacts/store", digest].join("\n");
      const signature = createHmac("sha256", "driver-secret").update(canonical).digest("hex");
      expect(headers.get("idempotency-key")).toBe("ingress:message-1");
      expect(headers.get("x-filthy-panty-content-sha256")).toBe(digest);
      expect(headers.get("x-filthy-panty-signature")).toBe(`v1=${signature}`);
      expect(init?.redirect).toBe("error");
      return Response.json({ externalRef: "customer/object-1", metadata: { region: "eu" } });
    });
    const client = createRemoteArtifactDriverClient(config, {
      fetch: fetchMock,
      now: () => 1_700_000_000_000,
      nonce: () => "nonce-1",
    });

    await expect(client.store({ invocationId: "ingress:message-1", artifactId: "artifact-1" }))
      .resolves.toEqual({ externalRef: "customer/object-1", metadata: { region: "eu" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries transient statuses with the same idempotency key", async () => {
    const keys: string[] = [];
    const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      return keys.length === 1
        ? new Response(null, { status: 503 })
        : Response.json({ externalRef: "customer/object-2" });
    });
    const sleep = mock(async () => {});
    const client = createRemoteArtifactDriverClient(config, { fetch: fetchMock, sleep });

    await expect(client.store({ invocationId: "store:2" })).resolves.toEqual({ externalRef: "customer/object-2" });
    expect(keys).toEqual(["store:2", "store:2"]);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("rejects URL external references and oversized responses", async () => {
    const urlClient = createRemoteArtifactDriverClient(config, {
      fetch: mock(async () => Response.json({ externalRef: "https://storage.example.com/private/object" })),
      maxRetries: 0,
    });
    await expect(urlClient.store({ invocationId: "store:3" })).rejects.toThrow("must be opaque and must not use a URI scheme");

    const largeClient = createRemoteArtifactDriverClient(config, {
      fetch: mock(async () => new Response(null, { headers: { "content-length": "65537" } })),
      maxRetries: 0,
    });
    await expect(largeClient.store({ invocationId: "store:4" })).rejects.toThrow("exceeds the size limit");
  });

  it("rejects resolve URLs outside the exact host allowlist", async () => {
    const client = createRemoteArtifactDriverClient(config, {
      fetch: mock(async () => Response.json({
        url: "https://cdn.example.com/object",
        expiresAt: "2030-01-01T00:00:00.000Z",
      })),
      maxRetries: 0,
    });

    await expect(client.resolve({ invocationId: "resolve:1", externalRef: "customer/object-1" }))
      .rejects.toThrow("hostname is not allowed");
  });

  it("rejects custom ports consistently before transport", async () => {
    expect(() => createRemoteArtifactDriverClient({
      ...config,
      endpoint: "https://storage.example.com:8443/artifacts",
    })).toThrow("custom port");

    const client = createRemoteArtifactDriverClient(config, {
      fetch: mock(async () => Response.json({
        url: "https://storage.example.com:8443/object",
        expiresAt: "2030-01-01T00:00:00.000Z",
      })),
      maxRetries: 0,
    });
    await expect(client.resolve({ invocationId: "resolve:port", externalRef: "customer/object-1" }))
      .rejects.toThrow("custom port");
  });

  it("keeps the timeout active while reading the response body", async () => {
    const client = createRemoteArtifactDriverClient(config, {
      fetch: mock(async (_url, init) => new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      }))),
      timeoutMs: 5,
      maxRetries: 0,
    });

    await expect(client.store({ invocationId: "store:timeout" })).rejects.toThrow("request failed");
  });
});

describe("artifact driver agent config", () => {
  it("validates and retains remote policies while redacting secrets", () => {
    const normalized = normalizeAgentConfig({
      artifacts: {
        driver: config,
        fallback: "reject",
      },
    });
    expect(toRuntimeAgentConfig(normalized).artifacts).toEqual(normalized.artifacts);
    expect(redactAgentConfig(normalized).artifacts?.driver).toMatchObject({ signingSecret: "********" });
  });

  it("accepts workspace processing without a remote driver", () => {
    expect(normalizeAgentConfig({
      artifacts: {
        workspace: { name: "attachments", materialize: "complex" },
        processing: { audio: "reject", archives: "workspace", unsupportedFiles: "workspace" },
      },
    }).artifacts).toEqual({
      workspace: { name: "attachments", materialize: "complex" },
      processing: { audio: "reject", archives: "workspace", unsupportedFiles: "workspace" },
    });
    expect(() => normalizeAgentConfig({ artifacts: { fallback: "reject" } })).toThrow("fallback requires");
    expect(() => normalizeAgentConfig({ artifacts: { workspace: { materialize: "sometimes" } } })).toThrow("never, complex, all");
    expect(() => normalizeAgentConfig({ artifacts: { processing: { audio: "execute" } } })).toThrow("reject, workspace");
  });

  it("rejects uploaded drivers with a remote-driver migration message", () => {
    expect(() => normalizeAgentConfig({
      artifacts: {
        driver: {
          name: "uploaded",
          mode: "uploaded",
          path: "artifacts/driver.ts",
          grants: ["super-secret-grant"],
          bundle: "export default {};",
          sha256: "a".repeat(64),
        } as any,
      },
    })).toThrow("Uploaded artifact drivers are not supported; use a remote artifact driver");
    expect(() => normalizeAgentConfig({
      artifacts: { driver: { ...config, endpoint: "https://other.example.com/artifacts" } },
    })).toThrow("endpoint hostname must be present");
    expect(() => normalizeAgentConfig({
      artifacts: { driver: { ...config, endpoint: "https://storage.example.com:8443/artifacts" } },
    })).toThrow("custom port");
  });

  it("accepts bounded explicit model input capabilities", () => {
    expect(normalizeAgentConfig({
      model: { inputCapabilities: { imageMediaTypes: ["image/*", "image/png"], fileMediaTypes: ["application/pdf"] } },
    }).model?.inputCapabilities).toEqual({
      imageMediaTypes: ["image/*", "image/png"],
      fileMediaTypes: ["application/pdf"],
    });
    expect(() => normalizeAgentConfig({
      model: { inputCapabilities: { imageMediaTypes: ["image/png; charset=utf-8"] } },
    })).toThrow("exact MIME types or top-level wildcards");
    expect(() => normalizeAgentConfig({
      model: { inputCapabilities: { fileMediaTypes: Array.from({ length: 33 }, () => "application/pdf") } },
    })).toThrow("at most 32");
  });
});
