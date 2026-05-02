import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF-hardened HTTPS file fetcher (Phase X).
 *
 * Used by 6 FS-bound tools (`telegram-send-file/voice/video-note/album/story`,
 * `telegram-set-profile-photo`) when the user supplies a `https://` URL instead
 * of an `uploadId`. The unsafe path: an LLM coerced via prompt injection into
 * fetching `http://169.254.169.254/latest/meta-data/...` (AWS IMDS) or
 * `http://10.0.0.5/internal-admin` from inside the cloud container.
 *
 * Defenses (each is independently sufficient for the case it covers):
 * 1. **Scheme allow-list** — `https:` only. No `file:`, `data:`, `gopher:`, `http:`.
 * 2. **Hostname pre-resolve** — DNS lookup before `fetch()`. Reject the URL if
 *    any resolved address is private/loopback/link-local/multicast.
 * 3. **DNS-rebinding pin** — `fetch()` is given a custom `dispatcher` that
 *    connects to the pre-resolved IP, not the hostname. A rebind between
 *    lookup and fetch can't redirect us to a different IP.
 * 4. **Redirect re-validation** — `redirect: "manual"`; we follow at most
 *    {@link MAX_REDIRECTS} hops, re-running steps 1-3 on each `Location`.
 * 5. **Size cap during stream** — abort once `Content-Length` (if known) or
 *    accumulated bytes exceed {@link maxBytes}. Prevents slow-loris disk-fill.
 * 6. **Timeout** — total fetch wall-clock bounded by {@link timeoutMs}.
 *
 * Out of scope (intentionally): authenticated fetches (no `Authorization`
 * passthrough), HTTP/0.9 oddities, FTP. If users need those, they upload via
 * `/my/upload` instead.
 */

import { Agent, fetch as undiciFetch } from "undici";

/** Maximum redirect hops we'll follow. Each is independently SSRF-revalidated. */
const MAX_REDIRECTS = 3;

/** Default fetch timeout (entire request, including redirects + body stream). */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * IPv4 ranges blocked from outbound fetch.
 * Sources: RFC 1918 (private), RFC 6890 (special-use), AWS/GCP/Azure metadata,
 * loopback, link-local, multicast, broadcast.
 */
const BLOCKED_IPV4_CIDRS: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network" / source-only
  ["10.0.0.0", 8], // RFC 1918 private
  ["100.64.0.0", 10], // CGNAT (RFC 6598)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local incl. AWS/GCP/Azure metadata 169.254.169.254
  ["172.16.0.0", 12], // RFC 1918 private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1 documentation
  ["192.168.0.0", 16], // RFC 1918 private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2 documentation
  ["203.0.113.0", 24], // TEST-NET-3 documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + 255.255.255.255 broadcast
];

/**
 * IPv6 ranges blocked.
 * Sources: RFC 4291 (loopback ::1), RFC 4193 (ULA fc00::/7), RFC 4291 link-local fe80::/10,
 * RFC 6052 IPv4-mapped ::ffff:0:0/96, multicast ff00::/8, deprecated site-local fec0::/10.
 */
const BLOCKED_IPV6_PREFIXES: string[] = [
  "::1", // loopback (treated as exact below; /128 effectively)
  "fc", // ULA fc00::/7
  "fd", // ULA continued
  "fe8", // link-local fe80::/10
  "fe9",
  "fea",
  "feb",
  "fec", // deprecated site-local fec0::/10
  "fed",
  "fee",
  "fef",
  "ff", // multicast ff00::/8
];

export type FetchDenyReason =
  | "bad_scheme"
  | "bad_url"
  | "private_address"
  | "dns_failure"
  | "too_large"
  | "redirect_limit"
  | "redirect_missing_location"
  | "fetch_failed"
  | "timeout"
  | "non_2xx";

export interface FetchSuccess {
  ok: true;
  bytes: Buffer;
  mime: string;
  finalUrl: string;
}

export interface FetchDenied {
  ok: false;
  reason: FetchDenyReason;
  message: string;
}

export interface FetchOptions {
  maxBytes: number;
  timeoutMs?: number;
}

/**
 * Fetch `url` over HTTPS with SSRF protection.
 *
 * Returns either {ok:true, bytes, mime, finalUrl} or {ok:false, reason, message}.
 * Never throws on policy violations — the deny envelope is the contract.
 * May throw on programmer errors (invalid maxBytes, etc.) — those are bugs.
 */
export async function fetchUrlSafely(url: string, opts: FetchOptions): Promise<FetchSuccess | FetchDenied> {
  if (opts.maxBytes <= 0) throw new Error("fetchUrlSafely: maxBytes must be positive");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const validated = await validateAndPin(currentUrl);
    if (!validated.ok) return validated;

    // Per-hop dispatcher with IP pinning. Allocated here (not inside doFetch) so
    // its lifetime spans both the request AND the body stream — closing it inside
    // doFetch's finally would race with streamBody's reader, producing flaky
    // socket-closed errors on success-path large bodies.
    const dispatcher = makePinnedDispatcher(validated.pinnedIp);
    let releasedDispatcher = false;
    const releaseDispatcher = () => {
      if (releasedDispatcher) return;
      releasedDispatcher = true;
      dispatcher.close().catch(() => {});
    };

    const response = await doFetch(validated.url, dispatcher, timeoutMs);
    if (!response.ok) {
      releaseDispatcher();
      return response;
    }
    const res = response.response;

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      // Drain & discard any redirect body; we only care about Location.
      try {
        await res.body?.cancel();
      } catch {
        // Body cancel may fail on already-closed streams; safe to ignore.
      }
      releaseDispatcher();
      if (!loc) {
        return {
          ok: false,
          reason: "redirect_missing_location",
          message: `Redirect ${res.status} without Location header`,
        };
      }
      currentUrl = new URL(loc, validated.url).toString();
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      try {
        await res.body?.cancel();
      } catch {
        // ignore (see above)
      }
      releaseDispatcher();
      return { ok: false, reason: "non_2xx", message: `Upstream returned HTTP ${res.status}` };
    }

    try {
      return await streamBody(res, currentUrl, opts.maxBytes);
    } finally {
      releaseDispatcher();
    }
  }
  return { ok: false, reason: "redirect_limit", message: `Too many redirects (>${MAX_REDIRECTS})` };
}

/** Per-call dispatcher that pins outbound socket connect to the pre-validated IP.
 * Host header still reflects the original hostname (TLS SNI + virtual hosting work). */
function makePinnedDispatcher(pinnedIp: string): Agent {
  return new Agent({
    connect: {
      lookup: (
        _hostname: string,
        _options: unknown,
        cb: (err: Error | null, address: string, family: number) => void,
      ) => {
        cb(null, pinnedIp, isIP(pinnedIp) === 6 ? 6 : 4);
      },
    },
  });
}

interface ValidatedUrl {
  ok: true;
  url: string;
  pinnedIp: string;
}

async function validateAndPin(rawUrl: string): Promise<ValidatedUrl | FetchDenied> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "bad_url", message: `Not a valid URL: ${truncate(rawUrl, 80)}` };
  }
  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: "bad_scheme",
      message: `Only https:// URLs allowed, got ${parsed.protocol}`,
    };
  }

  // URL hostname keeps square brackets around IPv6 literals (`[::1]` not `::1`).
  // Strip them for `isIP` / `isPrivateAddress` which expect bare addresses.
  const hostname = parsed.hostname;
  const bareHost = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  // If hostname is already a literal IP, skip DNS but still validate it.
  if (isIP(bareHost) !== 0) {
    if (isPrivateAddress(bareHost)) {
      return { ok: false, reason: "private_address", message: `IP literal ${bareHost} is in a blocked range` };
    }
    return { ok: true, url: parsed.toString(), pinnedIp: bareHost };
  }

  let resolved: Awaited<ReturnType<typeof lookup>>;
  try {
    // `all: false` returns one address (system-default). For SSRF, one is enough —
    // we don't want to pick a "safe" one out of a mixed list and ignore the unsafe.
    resolved = await lookup(hostname);
  } catch (e) {
    return { ok: false, reason: "dns_failure", message: `DNS lookup failed for ${hostname}: ${(e as Error).message}` };
  }

  if (isPrivateAddress(resolved.address)) {
    return {
      ok: false,
      reason: "private_address",
      message: `Hostname ${hostname} resolves to ${resolved.address} (private/loopback/link-local/multicast)`,
    };
  }

  return { ok: true, url: parsed.toString(), pinnedIp: resolved.address };
}

interface FetchResult {
  ok: true;
  response: Response;
}

async function doFetch(url: string, dispatcher: Agent, timeoutMs: number): Promise<FetchResult | FetchDenied> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await undiciFetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      dispatcher,
    });
    // undici's Response is structurally compatible with the global Response type
    // for the parts we use (status, headers.get, body.getReader, body.cancel).
    return { ok: true, response: response as unknown as Response };
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") {
      return { ok: false, reason: "timeout", message: `Fetch timed out after ${timeoutMs}ms` };
    }
    return { ok: false, reason: "fetch_failed", message: `Fetch failed: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function streamBody(res: Response, finalUrl: string, maxBytes: number): Promise<FetchSuccess | FetchDenied> {
  const declaredLen = Number(res.headers.get("content-length"));
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    try {
      await res.body?.cancel();
    } catch {
      // ignore
    }
    return {
      ok: false,
      reason: "too_large",
      message: `Content-Length ${declaredLen} exceeds cap ${maxBytes}`,
    };
  }

  if (!res.body) {
    return {
      ok: true,
      bytes: Buffer.alloc(0),
      mime: res.headers.get("content-type") ?? "application/octet-stream",
      finalUrl,
    };
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      return {
        ok: false,
        reason: "too_large",
        message: `Body exceeded cap ${maxBytes} bytes mid-stream`,
      };
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  return {
    ok: true,
    bytes,
    mime: res.headers.get("content-type") ?? "application/octet-stream",
    finalUrl,
  };
}

/**
 * Returns true if `addr` is a literal IP in any blocked range.
 * Accepts both IPv4 dotted quads and IPv6 (including `::ffff:` mapped forms).
 */
export function isPrivateAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 0) return false;

  if (family === 4) return isPrivateIPv4(addr);

  // IPv6: normalize lowercase, strip brackets if any caller leaked them.
  const norm = addr.toLowerCase().replace(/^\[|\]$/g, "");

  // IPv4-mapped IPv6: ::ffff:1.2.3.4 — apply IPv4 rules to the embedded address
  // so an attacker can't bypass via mapped form.
  if (norm.startsWith("::ffff:")) {
    const tail = norm.slice("::ffff:".length);
    if (isIP(tail) === 4) return isPrivateIPv4(tail);
  }

  // Exact unspecified / loopback
  if (norm === "::" || norm === "::1") return true;

  // Prefix-match blocked v6 ranges. We use the first hex group's prefix so
  // fc00::/7 (ULA) and fe80::/10 (link-local) are caught regardless of
  // the rest of the address.
  for (const prefix of BLOCKED_IPV6_PREFIXES) {
    if (norm.startsWith(prefix)) return true;
  }
  return false;
}

function isPrivateIPv4(addr: string): boolean {
  const parts = addr.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
    // Caller must validate via `isIP()` first. If we reach here, it's a programmer
    // bug elsewhere — fail loud so the bug surfaces rather than silently allow.
    throw new Error(`isPrivateIPv4: invalid IPv4 address slipped past isIP gate: ${addr}`);
  }
  const ipNum = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];

  for (const [cidr, mask] of BLOCKED_IPV4_CIDRS) {
    const cidrParts = cidr.split(".").map((p) => Number(p));
    const cidrNum = (cidrParts[0] << 24) | (cidrParts[1] << 16) | (cidrParts[2] << 8) | cidrParts[3];
    const maskBits = mask === 0 ? 0 : (~0 << (32 - mask)) >>> 0;
    if ((ipNum & maskBits) === (cidrNum & maskBits)) return true;
  }
  return false;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
