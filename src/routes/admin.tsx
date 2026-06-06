import { Hono } from "hono";
import { isAdminAuthorized } from "../auth/admin.js";
import { config } from "../config.js";
import { logUser } from "../logger.js";
import type { OAuthProvider } from "../oauth.js";
import { ObservabilityPage } from "../pages/ObservabilityPage.js";
import { detectRequestLocale, islandScripts, reactPagesAvailable, renderReactPage } from "../react-pages.js";
import type { SessionManager } from "../session-manager.js";
import { getRecentErrors } from "../telemetry/error-buffer.js";
import { snapshot } from "../telemetry/metrics.js";
import { recentSpans } from "../telemetry/tracer.js";
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

  app.get("/observability", async (c) => {
    if (!isAdminAuthorized(c.req.header("Authorization"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const days = 7;
    const topUsersRaw = usage.getUserStats(days);
    const topUsers = topUsersRaw.slice(0, 10).map((u) => ({ userId: logUser(u.userId), totalCalls: u.totalCalls }));
    const daily = usage.getDailyStats(days);
    const dau = usage.getDailyActiveUsers(days);
    const clients = usage.getClientStats(days);
    const recentErrors = getRecentErrors(50);
    const metrics = snapshot();

    // Prefer the React/i18n page when its bundle is built; fall back to the
    // legacy hono page otherwise (mirrors /my/settings, /my/audit).
    if (reactPagesAvailable()) {
      const locale = detectRequestLocale(c);
      // Flatten the backend's span shape into the page's transport DTO. Newest
      // first (the hono page reversed in-render; we do it here once). Cap at 50.
      const spans = recentSpans()
        .slice()
        .reverse()
        .slice(0, 50)
        .map((s) => ({
          name: s.name,
          traceId: s.context.traceId,
          durationMs: Number((s.endTimeNs - s.startTimeNs) / 1_000_000n),
          statusCode: s.status.code,
          attrs: Object.fromEntries(Object.entries(s.attributes).map(([k, v]) => [k, String(v)])),
        }));
      const html = await renderReactPage("observability", {
        locale,
        telemetryMode: config.telemetryMode,
        signozEndpointConfigured: config.signozEndpoint !== "",
        daily,
        dau,
        clients,
        topUsers,
        recentErrors,
        metrics,
        spans,
        scripts: islandScripts("language-switcher"),
      });
      return c.html(html);
    }

    return c.html(
      <ObservabilityPage
        telemetryMode={config.telemetryMode}
        signozEndpointConfigured={config.signozEndpoint !== ""}
        daily={daily}
        dau={dau}
        clients={clients}
        topUsers={topUsers}
        recentErrors={recentErrors}
        metrics={metrics}
        spans={recentSpans()}
      />,
    );
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
