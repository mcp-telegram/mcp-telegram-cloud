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
 * 3. **DNS-rebinding pin** — `fetch()` is pointed at the pre-resolved IP (the
 *    hostname in the URL is swapped for the IP literal), while the original
 *    hostname is carried in `tls.serverName` (SNI) and the `Host` header so TLS
 *    and virtual hosting still work. A rebind between lookup and fetch can't
 *    redirect us to a different IP, because we never resolve the hostname again.
 * 4. **Redirect re-validation** — `redirect: "manual"`; we follow at most
 *    {@link MAX_REDIRECTS} hops, re-running steps 1-3 on each `Location`.
 * 5. **Size cap during stream** — abort once `Content-Length` (if known) or
 *    accumulated bytes exceed {@link maxBytes}. Prevents slow-loris disk-fill.
 * 6. **Timeout** — total fetch wall-clock bounded by {@link timeoutMs}.
 *
 * Out of scope (intentionally): authenticated fetches (no `Authorization`
 * passthrough), HTTP/0.9 oddities, FTP. If users need those, they upload via
 * `/my/upload` instead.
 *
 * Runtime note: we use Bun's global `fetch`, NOT undici's `Agent`/`dispatcher`.
 * Bun ships a stub `undici` module whose `Agent` is an empty EventEmitter — its
 * `dispatcher` is silently ignored by `fetch` (so the IP pin never applied) and
 * it has no `.close()` (so cleanup threw `dispatcher.close is not a function`).
 * Bun's native `fetch` supports `tls.serverName`, which lets us pin by IP while
 * keeping SNI/Host correct — the same SSRF guarantee without the broken Agent.
 */

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

    // IP pin via native fetch: hit the pre-resolved IP, carry the original host
    // in SNI + Host header. No per-connection cleanup needed — Bun's fetch owns
    // the socket lifecycle, so there's nothing to close.
    const response = await doFetch(validated, timeoutMs);
    if (!response.ok) return response;
    const res = response.response;

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      // Drain & discard any redirect body; we only care about Location.
      try {
        await res.body?.cancel();
      } catch {
        // Body cancel may fail on already-closed streams; safe to ignore.
      }
      if (!loc) {
        return {
          ok: false,
          reason: "redirect_missing_location",
          message: `Redirect ${res.status} without Location header`,
        };
      }
      // Resolve relative redirects against the ORIGINAL hostname URL, not the
      // IP-pinned one, so the next hop re-validates the real host.
      //
      // Guarded because `loc` is attacker-controlled: a hostile upstream can
      // answer with `Location: https://[::bad`, and an unguarded `new URL`
      // would throw straight out of this function — breaking the contract
      // documented above ("never throws on policy violations") and turning a
      // remote server's response into a 500 on our side.
      let next: string;
      try {
        next = new URL(loc, validated.url).toString();
      } catch {
        return {
          ok: false,
          reason: "bad_url",
          message: `Redirect ${res.status} pointed at an unparseable Location: ${truncate(loc, 80)}`,
        };
      }
      currentUrl = next;
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      try {
        await res.body?.cancel();
      } catch {
        // ignore (see above)
      }
      return { ok: false, reason: "non_2xx", message: `Upstream returned HTTP ${res.status}` };
    }

    return streamBody(res, currentUrl, opts.maxBytes);
  }
  return { ok: false, reason: "redirect_limit", message: `Too many redirects (>${MAX_REDIRECTS})` };
}

interface PinnedRequest {
  /** URL with hostname replaced by the pinned IP literal. */
  pinnedUrl: string;
  /** Original host (with :port if present) — for the Host header. */
  host: string;
  /** Original hostname (no port, no brackets) — for SNI (tls.serverName). */
  serverName: string;
}

/** Builds the IP-pinned request shape for native fetch: the URL targets the
 * pre-validated IP, while SNI + Host header preserve the original hostname so
 * TLS and virtual hosting keep working. IPv6 literals are bracket-wrapped. */
function buildPinnedRequest(originalUrl: string, pinnedIp: string): PinnedRequest {
  const u = new URL(originalUrl);
  const host = u.host; // includes :port if present; used for the Host header
  const hostname = u.hostname; // no port; may have [] around IPv6
  const serverName = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  u.hostname = isIP(pinnedIp) === 6 ? `[${pinnedIp}]` : pinnedIp;
  return { pinnedUrl: u.toString(), host, serverName };
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

async function doFetch(validated: ValidatedUrl, timeoutMs: number): Promise<FetchResult | FetchDenied> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const { pinnedUrl, host, serverName } = buildPinnedRequest(validated.url, validated.pinnedIp);
  try {
    const response = await fetch(pinnedUrl, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { Host: host },
      // Bun-specific: pin the socket to the IP in `pinnedUrl` but present the
      // real hostname for TLS SNI. Typed via cast — not in the lib DOM RequestInit.
      tls: { serverName },
    } as RequestInit & { tls: { serverName: string } });
    return { ok: true, response };
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
    // Guarded because the peer controls this stream: a server that aborts
    // mid-body makes `read()` reject, and an unguarded await would throw out
    // of fetchUrlSafely, breaking the "deny envelope is the contract" promise
    // and surfacing as a 500 instead of a handled upload failure.
    // Derived from the reader itself: the global DOM type name for this result
    // is not in scope under this tsconfig's lib set.
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (e) {
      return {
        ok: false,
        reason: "fetch_failed",
        message: `Upstream aborted the response body: ${truncate((e as Error).message ?? String(e), 120)}`,
      };
    }
    const { value, done } = chunk;
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

  // IPv4-mapped IPv6: две формы:
  //   • десятичная ::ffff:1.2.3.4   — Node/browsers сохраняют её как есть
  //   • hex         ::ffff:a00:114  — node:net.isIP возвращает 6, tail не IPv4
  // Обе нужно прогнать через isPrivateIPv4, иначе ::ffff:10.0.1.20 проходит.
  if (norm.startsWith("::ffff:")) {
    const tail = norm.slice("::ffff:".length);
    if (isIP(tail) === 4) return isPrivateIPv4(tail);
    // hex-форма: ровно два hex-слова «aabb:ccdd» → IPv4 aabb>>8.aabb&ff.ccdd>>8.ccdd&ff
    const hexMatch = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMatch) {
      const hi = Number.parseInt(hexMatch[1], 16);
      const lo = Number.parseInt(hexMatch[2], 16);
      const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isPrivateIPv4(ipv4);
    }
    // ни та, ни другая форма — блокируем на всякий случай (неизвестная структура)
    return true;
  }

  // ...and the SAME address in hex form. This is the branch that matters in
  // practice: `new URL()` rewrites `[::ffff:10.0.1.20]` to `[::ffff:a00:114]`
  // BEFORE any of this runs, so the dotted check above never sees the attack
  // — the hostname reaching us is already hex. Without this, an internal
  // address (our own swarm backend lives on 10.0.1.20) sailed through as
  // "public". Also covers IPv4-compatible ::a00:114 and NAT64 64:ff9b::/96,
  // which embed an IPv4 destination just as effectively.
  const embedded = embeddedIPv4(norm);
  if (embedded !== null) return isPrivateIPv4(embedded);

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

/**
 * Expand an IPv6 literal to its 8 numeric groups, or null if it isn't parseable.
 * Handles `::` compression and a trailing dotted-quad (`::ffff:1.2.3.4`).
 */
function expandIPv6(addr: string): number[] | null {
  let s = addr;

  // Trailing dotted quad -> two hex groups, so one code path handles both forms.
  const dotted = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const o = dotted[1].split(".").map(Number);
    if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const head = ((o[0] << 8) | o[1]).toString(16);
    const tail = ((o[2] << 8) | o[3]).toString(16);
    s = `${s.slice(0, -dotted[1].length)}${head}:${tail}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };

  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (head === null || tail === null) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}

/**
 * If `addr` is an IPv6 form that embeds an IPv4 destination, return that IPv4 as
 * a dotted quad. Covers IPv4-mapped (::ffff:0:0/96), the deprecated
 * IPv4-compatible (::/96) and NAT64 (64:ff9b::/96) — all three reach an IPv4
 * host, so all three must be judged by IPv4 rules.
 */
function embeddedIPv4(addr: string): string | null {
  const g = expandIPv6(addr);
  if (g === null) return null;

  const isMapped = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff;
  const isCompat = g.slice(0, 6).every((x) => x === 0) && !(g[6] === 0 && (g[7] === 0 || g[7] === 1));
  const isNat64 = g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
  if (!isMapped && !isCompat && !isNat64) return null;

  return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join(".");
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
