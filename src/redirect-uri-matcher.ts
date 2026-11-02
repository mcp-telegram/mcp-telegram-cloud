// RFC 8252 §7.3 / §8.4 — for loopback redirect URIs (127.0.0.1, [::1]), the
// authorization server MUST allow the port to vary between registration and
// authorize, since native clients bind an ephemeral OS-assigned port that may
// change between runs.
//
// Match algorithm:
//   - if any registered URI is byte-equal to incoming → match
//   - else, for each registered URI: if both registered and incoming are
//     http:// loopback URIs (host = 127.0.0.1 or [::1]) AND scheme + hostname
//     + pathname + search are equal → match (port + hash ignored)
//
// `localhost` is intentionally NOT treated as a loopback alias — RFC 8252
// §8.3 prefers IP literals; DNS resolution is out of scope.

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "[::1]"]);

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

function parseUri(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

function loopbackEquivalent(registered: URL, incoming: URL): boolean {
  if (registered.protocol !== "http:") return false;
  if (incoming.protocol !== "http:") return false;
  if (!isLoopbackHostname(registered.hostname)) return false;
  if (registered.hostname !== incoming.hostname) return false;
  if (registered.pathname !== incoming.pathname) return false;
  if (registered.search !== incoming.search) return false;
  return true;
}

/** Schemes a browser would execute or read locally instead of handing to an app. */
const UNSAFE_SCHEMES = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "about:",
  "blob:",
  "filesystem:",
  "view-source:",
]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Where an authorization code may be sent: https, http only to loopback (native apps on
 * the user's machine), or an app's own scheme (`cursor:`, `vscode:`, ...). Registration
 * used to accept anything, so `javascript:`/`data:` targets were stopped only by the
 * page CSP; plain http to a remote host would leak the code on the wire.
 */
export function isAllowedRedirectUri(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return LOOPBACK_HOSTS.has(u.hostname);
  if (UNSAFE_SCHEMES.has(u.protocol)) return false;
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol);
}

export function matchRedirectUri(registeredUris: string[], incoming: string): boolean {
  if (!isAllowedRedirectUri(incoming)) return false;
  if (registeredUris.includes(incoming)) return true;

  const incomingUrl = parseUri(incoming);
  if (!incomingUrl) return false;

  for (const registered of registeredUris) {
    const registeredUrl = parseUri(registered);
    if (!registeredUrl) continue;
    if (loopbackEquivalent(registeredUrl, incomingUrl)) return true;
  }
  return false;
}
