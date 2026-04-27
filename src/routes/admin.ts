import { Hono } from "hono";
import { isAdminAuthorized } from "../auth/admin.js";
import type { OAuthProvider } from "../oauth.js";
import type { SessionManager } from "../session-manager.js";
import type { UsageTracker } from "../usage.js";

export interface AdminRoutesDeps {
  oauth: OAuthProvider;
  sessions: SessionManager;
  usage: UsageTracker;
}

export function createAdminRoutes({ oauth, sessions, usage }: AdminRoutesDeps): Hono {
  const app = new Hono();

  app.get("/stats", (c) => {
    if (!isAdminAuthorized(c.req.header("Authorization"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const daysRaw = Number(c.req.query("days") ?? 30);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 30;
    const userId = c.req.query("user_id");
    return c.json({
      daily: usage.getDailyStats(days),
      users: usage.getUserStats(days),
      clients: usage.getClientStats(days),
      dau: usage.getDailyActiveUsers(days),
      peakHours: usage.getHourlyStats(days),
      ...(userId ? { tools: usage.getToolBreakdown(userId, days) } : {}),
    });
  });

  app.post("/import-session", async (c) => {
    const auth = c.req.header("Authorization");
    const body = await c.req.json();

    let userId: string | null = null;

    if (isAdminAuthorized(auth)) {
      userId = body.userId;
      if (!userId) return c.json({ error: "userId required" }, 400);
    } else if (auth?.startsWith("Bearer ")) {
      const tokenInfo = oauth.validateToken(auth.slice(7));
      if (tokenInfo) userId = tokenInfo.userId;
    }

    if (!userId) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const sessionString = body.sessionString;
    if (!sessionString) return c.json({ error: "sessionString required" }, 400);

    sessions.saveSessionString(userId, sessionString);
    return c.json({ ok: true, userId });
  });

  return app;
}
