/**
 * DNS-pinned HTTPS transport tests.
 * Verify URL policy, reserved-address rejection, and connection-time address pinning.
 */

import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, mock } from "bun:test";
import { pinnedHttpsFetch } from "../functions/_shared/pinned-https.ts";

describe("DNS-pinned HTTPS transport", () => {
  it("requires an exact allowed hostname", async () => {
    await expect(pinnedHttpsFetch("https://media.example.com/file", {}, {
      allowedHosts: ["example.com"],
      resolve: mock(async () => [{ address: "93.184.216.34", family: 4 }]) as never,
    })).rejects.toThrow("host is not allowed");
  });

  it("rejects a private DNS answer before opening a socket", async () => {
    const request = mock(() => { throw new Error("must not connect"); });
    await expect(pinnedHttpsFetch("https://media.example.com/file", {}, {
      allowedHosts: ["media.example.com"],
      resolve: mock(async () => [{ address: "127.0.0.1", family: 4 }]) as never,
      request: request as never,
    })).rejects.toThrow("private or reserved");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects mapped private IPv6 and mixed public/private DNS answers", async () => {
    const request = mock(() => { throw new Error("must not connect"); });
    for (const answers of [
      [{ address: "::ffff:7f00:1", family: 6 }],
      [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }],
    ]) {
      await expect(pinnedHttpsFetch("https://media.example.com/file", {}, {
        allowedHosts: ["media.example.com"],
        resolve: mock(async () => answers) as never,
        request: request as never,
      })).rejects.toThrow("private or reserved");
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("pins the verified address into socket lookup while preserving the TLS hostname", async () => {
    let connectedAddress = "";
    let requestOptions: Record<string, unknown> | undefined;
    const request = mock((options: Record<string, unknown>, callback: (incoming: Readable & {
      statusCode?: number;
      statusMessage?: string;
      headers: Record<string, string>;
    }) => void) => {
      requestOptions = options;
      const outgoing = new EventEmitter() as EventEmitter & {
        write(value: unknown): void;
        end(): void;
        destroy(error: Error): void;
      };
      outgoing.write = () => {};
      outgoing.destroy = (error) => outgoing.emit("error", error);
      outgoing.end = () => {
        const socketLookup = options.lookup as (
          hostname: string,
          lookupOptions: object,
          done: (error: Error | null, address: string, family: number) => void,
        ) => void;
        socketLookup("media.example.com", {}, (_error, address) => { connectedAddress = address; });
        const incoming = Readable.from([Buffer.from("ok")]) as Readable & {
          statusCode?: number;
          statusMessage?: string;
          headers: Record<string, string>;
        };
        incoming.statusCode = 200;
        incoming.headers = { "content-type": "text/plain" };
        callback(incoming);
      };
      return outgoing;
    });
    const resolve = mock(async () => [{ address: "93.184.216.34", family: 4 }]);

    const response = await pinnedHttpsFetch("https://media.example.com/file", {}, {
      allowedHosts: ["media.example.com"],
      resolve: resolve as never,
      request: request as never,
    });

    expect(await response.text()).toBe("ok");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(connectedAddress).toBe("93.184.216.34");
    expect(requestOptions).toMatchObject({
      hostname: "media.example.com",
      servername: "media.example.com",
      rejectUnauthorized: true,
      agent: false,
      headers: { "accept-encoding": "identity" },
    });
  });

  it("rejects a redirected target whose fresh DNS answer is private", async () => {
    const secondRequest = mock(() => { throw new Error("must not connect to rebound target"); });

    await expect(pinnedHttpsFetch("https://cdn.example.com/redirected", {}, {
      allowedHosts: ["cdn.example.com"],
      resolve: mock(async () => [{ address: "10.0.0.8", family: 4 }]) as never,
      request: secondRequest as never,
    })).rejects.toThrow("private or reserved");
    expect(secondRequest).not.toHaveBeenCalled();
  });
});
