/**
 * DNS-pinned HTTPS transport for artifact egress.
 * URL policy and connection-time address selection stay in one operation to prevent DNS rebinding.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

export interface PinnedHttpsOptions {
  allowedHosts: string[];
  resolve?: typeof dnsLookup;
  request?: typeof httpsRequest;
}

const blockedIpv4Addresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
const blockedIpv6Addresses = new BlockList();
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["100::", 64],
  ["2001::", 32], ["2001:10::", 28], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");

/** Fetches one HTTPS response through an address verified immediately before socket creation. */
export async function pinnedHttpsFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  options: PinnedHttpsOptions,
): Promise<Response> {
  const url = input instanceof Request ? new URL(input.url) : new URL(input);
  assertAllowedPinnedHttpsUrl(url, options.allowedHosts);

  const resolve = options.resolve ?? dnsLookup;
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname, family: isIP(url.hostname) }]
    : await resolve(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isGlobalAddress(address))) {
    throw new Error("HTTPS destination resolves to a private or reserved address");
  }
  const pinned = addresses[0]!;
  const request = options.request ?? httpsRequest;
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  for (const name of ["connection", "content-length", "host", "proxy-authorization", "transfer-encoding", "upgrade"]) {
    headers.delete(name);
  }
  if (typeof init.body === "string") headers.set("content-length", String(Buffer.byteLength(init.body)));
  else if (init.body instanceof Uint8Array) headers.set("content-length", String(init.body.byteLength));
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
  const method = init.method ?? (input instanceof Request ? input.method : "GET");

  return await new Promise<Response>((resolveResponse, reject) => {
    const requestOptions: RequestOptions = {
      protocol: "https:",
      hostname: url.hostname,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method,
      headers: Object.fromEntries(headers.entries()),
      servername: url.hostname,
      rejectUnauthorized: true,
      agent: false,
      lookup(_hostname, _options, callback) {
        callback(null, pinned.address, pinned.family);
      },
    };
    const outgoing = request(requestOptions, (incoming) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((entry) => responseHeaders.append(name, entry));
        else if (value !== undefined) responseHeaders.set(name, value);
      }
      const status = incoming.statusCode ?? 500;
      const body = status === 101 || status === 204 || status === 205 || status === 304
        ? null
        : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolveResponse(new Response(body, {
        status,
        statusText: incoming.statusMessage,
        headers: responseHeaders,
      }));
    });
    const abort = () => outgoing.destroy(new DOMException("aborted", "AbortError"));
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener("abort", abort, { once: true });
    outgoing.once("error", reject);
    outgoing.once("close", () => init.signal?.removeEventListener("abort", abort));

    if (typeof init.body === "string" || init.body instanceof Uint8Array) outgoing.write(init.body);
    else if (init.body !== undefined && init.body !== null) {
      outgoing.destroy(new TypeError("Pinned HTTPS transport only supports string or byte request bodies"));
      return;
    }
    outgoing.end();
  });
}

/** Performs the synchronous URL/host checks also used before an injected test transport. */
export function assertAllowedPinnedHttpsUrl(url: URL, allowedHosts: string[]): void {
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
    throw new Error("HTTPS URL destination must not include credentials, a custom port, or a fragment");
  }
  const hostname = normalizeHostname(url.hostname);
  if (!allowedHosts.some((allowed) => hostname === normalizeHostname(allowed))) {
    throw new Error("HTTPS destination host is not allowed");
  }
  if (isIP(hostname) && !isGlobalAddress(hostname)) {
    throw new Error("HTTPS destination resolves to a private or reserved address");
  }
}

function normalizeHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/** Reject special-use address space; outbound artifact traffic must use global unicast addresses. */
export function isGlobalAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  if (family === 4) return !blockedIpv4Addresses.check(normalized, "ipv4");
  if (family === 6) return !blockedIpv6Addresses.check(normalized, "ipv6");
  return false;
}
