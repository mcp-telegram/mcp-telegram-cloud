import { Hono } from "hono";
import { buildAdminSessionCookie, isAdminSessionValid, verifyAdminPassword } from "../auth/admin.js";
import { config } from "../config.js";
import { AdminLoginPage } from "../pages/AdminLoginPage.js";
import { adminLoginRateLimit } from "../rate-limit.js";

/** Only ever redirect within this app — an attacker-controlled absolute
 *  returnTo would turn this into an open redirect off a login form. */
function safeReturnTo(raw: string | undefined): string {
  if (!raw || !raw.startsWith("/")) return "/";
  if (raw.length > 1 && (raw[1] === "/" || raw[1] === "\\")) return "/";
  return raw;
}

export function createAdminLoginRoutes(): Hono {
  const app = new Hono();

  app.use("/*", adminLoginRateLimit);

  app.get("/", (c) => {
    const returnTo = safeReturnTo(c.req.query("returnTo"));
    if (isAdminSessionValid(c.req.header("cookie"))) {
      return c.redirect(returnTo, 302);
    }
    return c.html(<AdminLoginPage returnTo={returnTo} error={c.req.query("error") === "1"} />);
  });

  app.post("/", async (c) => {
    const returnTo = safeReturnTo(c.req.query("returnTo"));
    const body = await c.req.parseBody();
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";

    const ok = username === config.adminUsername && verifyAdminPassword(password, config.adminPasswordHash);
    if (!ok) {
      return c.redirect(`/admin-login?returnTo=${encodeURIComponent(returnTo)}&error=1`, 302);
    }

    c.header("Set-Cookie", buildAdminSessionCookie());
    return c.redirect(returnTo, 302);
  });

  return app;
}
