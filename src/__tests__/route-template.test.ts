import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { statusClass, templatePath } from "../telemetry/route-template.js";

describe("route-template", () => {
  it("preserves known static routes verbatim", () => {
    assert.equal(templatePath("/mcp"), "/mcp");
    assert.equal(templatePath("/api/observability"), "/api/observability");
    assert.equal(templatePath("/health"), "/health");
    assert.equal(templatePath("/.well-known/oauth-authorization-server"), "/.well-known/oauth-authorization-server");
  });

  it("collapses bot webhook secret to :secret", () => {
    assert.equal(templatePath("/bot/webhook/abc-secret-deadbeef"), "/bot/webhook/:secret");
    assert.equal(templatePath("/bot/webhook/AAAAaaaa1111"), "/bot/webhook/:secret");
  });

  it("collapses upload IDs to :id under /my/upload(s)", () => {
    assert.equal(templatePath("/my/upload/01HZX5YK6JK4M3W2T8V9R7P0Q1"), "/my/upload/:id");
    assert.equal(templatePath("/my/uploads/abc-def-123"), "/my/uploads/:id");
  });

  it("collapses arbitrary trailing UUID/hex segments", () => {
    assert.equal(templatePath("/something/01hzx5yk6jk4m3w2t8v9r7p0q1"), "/something/:id");
    assert.equal(templatePath("/something/deadbeef-1234-5678-9abc-deadbeef0000"), "/something/:id");
  });

  it("leaves short or non-hex tail segments alone", () => {
    assert.equal(templatePath("/about"), "/about");
    assert.equal(templatePath("/random/page"), "/random/page");
  });

  it("returns the literal path when nothing matches (no `unknown` masking)", () => {
    assert.equal(templatePath("/some/new/route"), "/some/new/route");
  });

  it("collapses ID-shaped segments anywhere in path (not just trailing)", () => {
    assert.equal(templatePath("/users/01HZX5YK6JK4M3W2T8V9R7P0Q1/profile"), "/users/:id/profile");
    assert.equal(templatePath("/oauth/deadbeef-1234-5678-9abc-deadbeef0000/details"), "/oauth/:id/details");
  });
});

describe("statusClass", () => {
  it("maps 2xx/3xx/4xx/5xx", () => {
    assert.equal(statusClass(200), "2xx");
    assert.equal(statusClass(204), "2xx");
    assert.equal(statusClass(301), "3xx");
    assert.equal(statusClass(404), "4xx");
    assert.equal(statusClass(500), "5xx");
    assert.equal(statusClass(599), "5xx");
  });

  it("handles 1xx (informational)", () => {
    assert.equal(statusClass(101), "1xx");
  });
});
