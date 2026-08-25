/**
 * OAuth protected-resource discovery paths (RFC 9728 + MCP authorization spec).
 *
 * Production regression, found 2026-08-25 in SigNoz: ~280 requests a day were
 * 404ing, split across the two spec-shaped discovery paths, because metadata
 * was only served at the bare `/.well-known/oauth-protected-resource`. Clients
 * had to guess that path in the first place, since the 401 from /mcp carried no
 * WWW-Authenticate header pointing anywhere.
 *
 * These tests pin both halves of the fix:
 *  1. the 401 advertises where the metadata lives, and
 *  2. that advertised URL — plus the legacy layout — actually serves it.
 *
 * The `resource` identifier is asserted per path on purpose: the /mcp-scoped
 * documents must name `<issuer>/mcp` (what the client is really calling), while
 * the bare path keeps advertising the issuer it always has, so clients that
 * already discover us there do not regress.
 */
process.env.ISSUER ??= "https://test.example.com";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";

const { createOAuthWellKnownRoutes, MCP_RESOURCE_METADATA_PATH, rootUrl } = await import("../routes/oauth.js");
const { registerMcpRoutes } = await import("../routes/mcp.js");
const { config } = await import("../config.js");
const { templatePath } = await import("../telemetry/route-template.js");

const oauth = {
  getMetadata: () => ({ issuer: config.issuer }),
  validateToken: () => null,
} as unknown as Parameters<typeof createOAuthWellKnownRoutes>[0];

function makeApp() {
  const app = new Hono();
  app.route("/", createOAuthWellKnownRoutes(oauth));
  registerMcpRoutes(app, {
    oauth: oauth as never,
    sessions: {} as never,
    usage: {} as never,
    destructive: {} as never,
    uploads: {} as never,
  });
  return app;
}

const MCP_SCOPED_PATHS = [MCP_RESOURCE_METADATA_PATH, "/mcp/.well-known/oauth-protected-resource"];

describe("protected-resource discovery", () => {
  it("401 from /mcp points at the resource metadata document", async () => {
    const res = await makeApp().request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    assert.equal(res.status, 401);
    const header = res.headers.get("www-authenticate");
    assert.ok(header, "401 must carry WWW-Authenticate or the client cannot discover the auth server");
    assert.match(header, /^Bearer /);
    // Substring, not a built regex: the issuer is full of `.` and `/`, which a
    // naive RegExp would treat as wildcards and quietly weaken the assertion.
    assert.ok(
      header.includes(`resource_metadata="${config.issuer}${MCP_RESOURCE_METADATA_PATH}"`),
      `expected the advertised metadata URL, got: ${header}`,
    );
  });

  // ISSUER is only validated as an http(s) URL, so these shapes are reachable
  // by misconfiguration rather than by attack. Both used to produce a metadata
  // URL that this server does not serve, or a malformed header.
  describe("rootUrl (issuer normalisation)", () => {
    it("anchors at the origin, because every route is mounted at /", () => {
      assert.equal(
        rootUrl("https://host.example/base", MCP_RESOURCE_METADATA_PATH),
        `https://host.example${MCP_RESOURCE_METADATA_PATH}`,
        "a path-bearing issuer must not produce /base/.well-known/... — nothing serves that",
      );
      assert.equal(rootUrl("https://host.example/base/", "/mcp"), "https://host.example/mcp");
    });

    it("leaves an ordinary issuer untouched", () => {
      assert.equal(
        rootUrl("https://host.example", MCP_RESOURCE_METADATA_PATH),
        `https://host.example${MCP_RESOURCE_METADATA_PATH}`,
      );
      assert.equal(rootUrl("https://host.example:8443", "/mcp"), "https://host.example:8443/mcp");
    });

    it('cannot emit a bare quote that would break out of resource_metadata="..."', () => {
      const url = rootUrl('https://host.example/a"b', MCP_RESOURCE_METADATA_PATH);
      assert.ok(!url.includes('"'), `quote must not survive into the header parameter: ${url}`);
    });

    it("drops userinfo so credentials are never republished as discovery metadata", () => {
      const url = rootUrl("https://user:pass@host.example/base", MCP_RESOURCE_METADATA_PATH);
      assert.equal(url, `https://host.example${MCP_RESOURCE_METADATA_PATH}`);
      assert.ok(!url.includes("pass"), `credentials must not survive: ${url}`);
    });
  });

  it("serves metadata at every path a client may try", async () => {
    const app = makeApp();
    for (const path of ["/.well-known/oauth-protected-resource", ...MCP_SCOPED_PATHS]) {
      const res = await app.request(path);
      assert.equal(res.status, 200, `${path} must not 404 — production clients probe it`);
      const body = (await res.json()) as Record<string, unknown>;
      assert.deepEqual(body.authorization_servers, [config.issuer], `${path}: wrong authorization_servers`);
      assert.deepEqual(body.bearer_methods_supported, ["header"], `${path}: wrong bearer_methods_supported`);
    }
  });

  it("scopes the resource identifier to /mcp on the mcp-specific documents", async () => {
    const app = makeApp();
    for (const path of MCP_SCOPED_PATHS) {
      const body = (await (await app.request(path)).json()) as { resource: string };
      assert.equal(body.resource, `${config.issuer}/mcp`, `${path}: resource must identify the MCP endpoint`);
    }
  });

  it("keeps the bare path advertising the issuer (no regression for existing clients)", async () => {
    const body = (await (await makeApp().request("/.well-known/oauth-protected-resource")).json()) as {
      resource: string;
    };
    assert.equal(body.resource, config.issuer);
  });

  it("the metadata URL the 401 advertises is the one that is actually served", async () => {
    const res = await makeApp().request(MCP_RESOURCE_METADATA_PATH);
    assert.equal(res.status, 200, "advertising a 404 would be worse than advertising nothing");
  });

  it("discovery paths stay their own metric series (not collapsed by the id-shaped mask)", () => {
    for (const path of MCP_SCOPED_PATHS) {
      assert.equal(templatePath(path), path, `${path} must survive route templating verbatim`);
    }
  });
});
