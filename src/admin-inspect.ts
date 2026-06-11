import type { Database } from "bun:sqlite";
import { isEncrypted, isHashedToken } from "./crypto.js";

/**
 * Read-only admin queries over cloud.db: user lifecycle overview and DB
 * integrity checks. Lives outside SessionManager/UsageTracker because the
 * queries deliberately join across their domains (sessions + usage + oauth).
 * All endpoints consuming this module sit behind ADMIN_TOKEN.
 */

export interface AdminUser {
  userId: string;
  createdAt: string;
  updatedAt: string;
  sessionEncrypted: boolean;
  secondaryAccounts: number;
  activeAccessTokens: number;
  activeRefreshTokens: number;
  totalCalls: number;
  firstSeen: string | null;
  lastSeen: string | null;
  inactiveDays: number | null;
  clients: string[];
}

interface UserSessionRow {
  user_id: string;
  session_string: string;
  created_at: string;
  updated_at: string;
}

interface UsageRow {
  user_id: string;
  total_calls: number;
  first_seen: string;
  last_seen: string;
  clients: string | null;
}

/**
 * Every registered user (= row in user_sessions) enriched with usage activity
 * and OAuth token state. `inactiveDays` is null for users that never made a
 * tool call — judge those by `createdAt` instead.
 */
export function listUsers(db: Database): AdminUser[] {
  const sessions = db
    .prepare("SELECT user_id, session_string, created_at, updated_at FROM user_sessions ORDER BY created_at")
    .all() as UserSessionRow[];

  const usageRows = db
    .prepare(`
      SELECT user_id,
             COUNT(*) AS total_calls,
             MIN(created_at) AS first_seen,
             MAX(created_at) AS last_seen,
             GROUP_CONCAT(DISTINCT NULLIF(client, '')) AS clients
      FROM usage_log
      GROUP BY user_id
    `)
    .all() as UsageRow[];
  const usageByUser = new Map(usageRows.map((r) => [r.user_id, r]));

  const now = Date.now();
  // OAuth expires_at columns store UNIX SECONDS (see oauth.ts), not ms.
  const nowSec = Math.floor(now / 1000);
  const countByUser = (sql: string, ...params: number[]): Map<string, number> => {
    const rows = db.prepare(sql).all(...params) as { user_id: string; n: number }[];
    return new Map(rows.map((r) => [r.user_id, r.n]));
  };
  const secondaries = countByUser(
    "SELECT owner_user_id AS user_id, COUNT(*) AS n FROM telegram_accounts GROUP BY owner_user_id",
  );
  // expires_at = 0 means "never expires" (v2.23.0 eternal-token scheme).
  const accessTokens = countByUser(
    "SELECT user_id, COUNT(*) AS n FROM oauth_tokens WHERE expires_at = 0 OR expires_at > ? GROUP BY user_id",
    nowSec,
  );
  const refreshTokens = countByUser(
    "SELECT user_id, COUNT(*) AS n FROM oauth_refresh_tokens WHERE revoked = 0 AND (expires_at = 0 OR expires_at > ?) GROUP BY user_id",
    nowSec,
  );

  return sessions.map((s) => {
    const usage = usageByUser.get(s.user_id);
    const lastSeen = usage?.last_seen ?? null;
    return {
      userId: s.user_id,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      sessionEncrypted: isEncrypted(s.session_string),
      secondaryAccounts: secondaries.get(s.user_id) ?? 0,
      activeAccessTokens: accessTokens.get(s.user_id) ?? 0,
      activeRefreshTokens: refreshTokens.get(s.user_id) ?? 0,
      totalCalls: usage?.total_calls ?? 0,
      firstSeen: usage?.first_seen ?? null,
      lastSeen,
      // usage_log timestamps are SQLite datetime('now') — UTC "YYYY-MM-DD HH:MM:SS".
      inactiveDays: lastSeen ? Math.floor((now - Date.parse(`${lastSeen.replace(" ", "T")}Z`)) / 86_400_000) : null,
      clients: usage?.clients ? usage.clients.split(",") : [],
    };
  });
}

export interface IntegrityReport {
  tableCounts: Record<string, number>;
  plaintextSessions: string[];
  plaintextSecondarySessions: number[];
  plaintextAccessTokens: number;
  plaintextRefreshTokens: number;
  plaintextClientSecrets: string[];
  expiredAccessTokens: number;
  expiredOauthCodes: number;
  revokedRefreshTokens: number;
  orphanSecondaryAccounts: { accountId: number; ownerUserId: string }[];
  orphanActiveAccountRows: string[];
  tokenUsersWithoutSession: string[];
  usageUsersWithoutSession: string[];
}

/**
 * Anomaly sweep over cloud.db. Encryption/hash checks reuse the canonical
 * `v1:`/`h1:` prefix helpers from crypto.ts rather than re-deriving the shape
 * in SQL — tables are small (tens to low hundreds of rows), so scanning in JS
 * is fine and keeps a single source of truth for the prefixes.
 */
export function checkIntegrity(db: Database): IntegrityReport {
  // OAuth expires_at columns store UNIX SECONDS (see oauth.ts), not ms.
  const nowSec = Math.floor(Date.now() / 1000);
  const count = (sql: string, ...params: number[]): number => (db.prepare(sql).get(...params) as { n: number }).n;
  const col = <T>(sql: string, ...params: number[]): T[] =>
    (db.prepare(sql).all(...params) as Record<string, T>[]).map((r) => Object.values(r)[0] as T);

  const tables = [
    "user_sessions",
    "telegram_accounts",
    "active_account",
    "add_account_tokens",
    "oauth_clients",
    "oauth_codes",
    "oauth_tokens",
    "oauth_refresh_tokens",
    "usage_log",
    "user_prefs",
    "destructive_audit",
    "pending_uploads",
  ];
  const tableCounts: Record<string, number> = {};
  for (const t of tables) {
    try {
      tableCounts[t] = count(`SELECT COUNT(*) AS n FROM ${t}`);
    } catch {
      // Table not created in this deployment (feature unused) — report as absent.
      tableCounts[t] = -1;
    }
  }

  const sessionRows = db.prepare("SELECT user_id, session_string FROM user_sessions").all() as UserSessionRow[];
  const secondaryRows = db.prepare("SELECT account_id, session_string FROM telegram_accounts").all() as {
    account_id: number;
    session_string: string;
  }[];
  const clientRows = db
    .prepare("SELECT client_id, client_secret FROM oauth_clients WHERE client_secret IS NOT NULL")
    .all() as {
    client_id: string;
    client_secret: string;
  }[];

  return {
    tableCounts,
    plaintextSessions: sessionRows.filter((r) => !isEncrypted(r.session_string)).map((r) => r.user_id),
    plaintextSecondarySessions: secondaryRows.filter((r) => !isEncrypted(r.session_string)).map((r) => r.account_id),
    plaintextAccessTokens: col<string>("SELECT access_token FROM oauth_tokens").filter((t) => !isHashedToken(t)).length,
    plaintextRefreshTokens: col<string>("SELECT refresh_token FROM oauth_refresh_tokens").filter(
      (t) => !isHashedToken(t),
    ).length,
    plaintextClientSecrets: clientRows.filter((r) => !isHashedToken(r.client_secret)).map((r) => r.client_id),
    expiredAccessTokens: count(
      "SELECT COUNT(*) AS n FROM oauth_tokens WHERE expires_at != 0 AND expires_at < ?",
      nowSec,
    ),
    expiredOauthCodes: count("SELECT COUNT(*) AS n FROM oauth_codes WHERE expires_at < ?", nowSec),
    revokedRefreshTokens: count("SELECT COUNT(*) AS n FROM oauth_refresh_tokens WHERE revoked = 1"),
    orphanSecondaryAccounts: (
      db
        .prepare(
          "SELECT account_id, owner_user_id FROM telegram_accounts WHERE owner_user_id NOT IN (SELECT user_id FROM user_sessions)",
        )
        .all() as { account_id: number; owner_user_id: string }[]
    ).map((r) => ({ accountId: r.account_id, ownerUserId: r.owner_user_id })),
    orphanActiveAccountRows: col<string>(
      "SELECT owner_user_id FROM active_account WHERE owner_user_id NOT IN (SELECT user_id FROM user_sessions)",
    ),
    tokenUsersWithoutSession: col<string>(
      `SELECT DISTINCT user_id FROM oauth_refresh_tokens
       WHERE revoked = 0 AND (expires_at = 0 OR expires_at > ?)
         AND user_id NOT IN (SELECT user_id FROM user_sessions)`,
      nowSec,
    ),
    usageUsersWithoutSession: col<string>(
      "SELECT DISTINCT user_id FROM usage_log WHERE user_id NOT IN (SELECT user_id FROM user_sessions)",
    ),
  };
}
