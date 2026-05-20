import { describe, expect, test } from "bun:test";
import { matchRedirectUri } from "../redirect-uri-matcher.js";

describe("matchRedirectUri — exact match (RFC 6749 default)", () => {
  test("byte-equal URI matches", () => {
    expect(matchRedirectUri(["https://claude.ai/callback"], "https://claude.ai/callback")).toBe(true);
  });

  test("trailing slash difference does not match (non-loopback)", () => {
    expect(matchRedirectUri(["https://claude.ai/callback"], "https://claude.ai/callback/")).toBe(false);
  });

  test("different scheme does not match", () => {
    expect(matchRedirectUri(["https://claude.ai/cb"], "http://claude.ai/cb")).toBe(false);
  });

  test("unknown URI does not match", () => {
    expect(matchRedirectUri(["https://claude.ai/cb"], "https://evil.example/cb")).toBe(false);
  });

  test("empty registered list never matches", () => {
    expect(matchRedirectUri([], "https://claude.ai/cb")).toBe(false);
  });
});

describe("matchRedirectUri — RFC 8252 §7.3 loopback port flexibility", () => {
  test("127.0.0.1 with different port matches", () => {
    expect(matchRedirectUri(["http://127.0.0.1:36201/callback"], "http://127.0.0.1:50000/callback")).toBe(true);
  });

  test("127.0.0.1 with same port matches via fast path", () => {
    expect(matchRedirectUri(["http://127.0.0.1:36201/callback"], "http://127.0.0.1:36201/callback")).toBe(true);
  });

  test("127.0.0.1 without port matches registered with port", () => {
    expect(matchRedirectUri(["http://127.0.0.1:36201/callback"], "http://127.0.0.1/callback")).toBe(true);
  });

  test("[::1] IPv6 loopback with different port matches", () => {
    expect(matchRedirectUri(["http://[::1]:36201/callback"], "http://[::1]:50000/callback")).toBe(true);
  });

  test("127.0.0.1 with different path does NOT match", () => {
    expect(matchRedirectUri(["http://127.0.0.1:36201/callback"], "http://127.0.0.1:36201/evil")).toBe(false);
  });

  test("127.0.0.1 with different query does NOT match", () => {
    expect(matchRedirectUri(["http://127.0.0.1:36201/callback"], "http://127.0.0.1:36201/callback?x=1")).toBe(false);
  });

  test("127.0.0.1 vs [::1] cross-family does NOT match (different host)", () => {
    expect(matchRedirectUri(["http://127.0.0.1:36201/callback"], "http://[::1]:36201/callback")).toBe(false);
  });

  test("https loopback gets no port flexibility (only http per RFC 8252)", () => {
    expect(matchRedirectUri(["https://127.0.0.1:36201/callback"], "https://127.0.0.1:50000/callback")).toBe(false);
  });

  test("localhost is NOT treated as loopback alias — exact match only", () => {
    expect(matchRedirectUri(["http://localhost:36201/callback"], "http://localhost:50000/callback")).toBe(false);
  });

  test("loopback vs non-loopback hostname does not match via port-flex path", () => {
    expect(matchRedirectUri(["http://127.0.0.1:36201/callback"], "http://evil.example:36201/callback")).toBe(false);
  });

  test("fragment in incoming URI is ignored (URL drops it from comparison surface)", () => {
    expect(matchRedirectUri(["http://127.0.0.1:36201/callback"], "http://127.0.0.1:50000/callback#frag")).toBe(true);
  });
});

describe("matchRedirectUri — malformed input safety", () => {
  test("malformed incoming URI returns false", () => {
    expect(matchRedirectUri(["http://127.0.0.1:36201/callback"], "not a url")).toBe(false);
  });

  test("malformed registered URI skipped, others still evaluated", () => {
    expect(matchRedirectUri(["not a url", "http://127.0.0.1:36201/callback"], "http://127.0.0.1:50000/callback")).toBe(
      true,
    );
  });

  test("multiple registered URIs — match any one", () => {
    expect(matchRedirectUri(["https://claude.ai/cb", "http://127.0.0.1:36201/cb"], "http://127.0.0.1:50000/cb")).toBe(
      true,
    );
  });
});
