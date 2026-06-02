import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { noindex } from "../middleware/noindex.js";

describe("noindex middleware", () => {
  const app = new Hono();
  app.use("*", noindex);
  app.get("/login", (c) => c.html("<html><body>ok</body></html>"));
  app.get("/api/data", (c) => c.json({ ok: true }));
  app.get("/redir", (c) => c.redirect("/login"));

  it("sets X-Robots-Tag on HTML responses", async () => {
    const res = await app.request("/login");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("sets X-Robots-Tag on JSON responses", async () => {
    const res = await app.request("/api/data");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("sets X-Robots-Tag on redirects (where <meta> cannot reach)", async () => {
    const res = await app.request("/redir");
    expect(res.status).toBe(302);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});
