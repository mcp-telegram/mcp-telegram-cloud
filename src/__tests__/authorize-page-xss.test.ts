/**
 * The fallback authorize page builds an inline <script> out of OAuth query
 * parameters, which come straight from the request URL — anyone who can hand a
 * victim a link controls them.
 *
 * `JSON.stringify` escapes quotes but not `</script>`, so a `state` of
 * `</script><img src=x onerror=…>` used to close the script element and have
 * the remainder parsed as HTML. This pins the escaping, because the bug is
 * invisible on review: the code already looks like it is quoting properly.
 */
process.env.ISSUER ??= "https://authorize-page-xss-test.invalid";
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "stub";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { inlineJson } = await import("../pages/AuthorizePage.js");

describe("inline <script> embedding", () => {
  it("neutralises a closing script tag", () => {
    const out = inlineJson("</script><img src=x onerror=alert(1)>");
    assert.ok(!/<\/script/i.test(out), "closing tag survived");
    assert.ok(!out.includes("<"), "raw < survived");
    assert.ok(!out.includes(">"), "raw > survived");
  });

  it("escapes every character that can terminate or reopen an element", () => {
    for (const ch of ["<", ">", "&"]) {
      assert.ok(!inlineJson(`a${ch}b`).includes(ch), `${ch} not escaped`);
    }
  });

  it("escapes the line separators that are legal JSON but illegal in a JS string", () => {
    assert.ok(inlineJson("a\u2028b").includes("\\u2028"));
    assert.ok(inlineJson("a\u2029b").includes("\\u2029"));
  });

  it("still round-trips to the original value in the browser", () => {
    for (const value of ["abc123", "</script>", "a&b<c>d", "\u2028", 'quote" and \\ backslash']) {
      // What the browser's JS parser will see, evaluated the same way.
      assert.equal(
        JSON.parse(
          inlineJson(value)
            .replace(/\\u003c/g, "<")
            .replace(/\\u003e/g, ">")
            .replace(/\\u0026/g, "&"),
        ),
        value,
      );
    }
  });
});
