import type { Database, Statement } from "bun:sqlite";

/**
 * Per-user toggle + per-day quota + audit log for destructive tools (Phase 2.1).
 *
 * Server-default OFF: a fresh user must opt in at `/my/settings` before any
 * `destructiveHint=true` tool can run. The toggle is global (one bit covers all
 * destructive tools); category granularity can be added later as a bitfield without
 * a breaking schema change. Quota is separate from `FREE_TIER_LIMIT` so destructive
 * actions don't compete with read traffic.
 *
 * Audit rows are written for every gated invocation — both denied and allowed —
 * so the `/my/audit` page shows the user the full record of what was attempted.
 */

export type DestructiveResult = "ok" | "denied_disabled" | "denied_quota" | "error";

export interface AuditRow {
  id: number;
  user_id: string;
  tool_name: string;
  args_summary: string;
  result: DestructiveResult;
  created_at: string;
}

/** Cap on `args_summary` to prevent log bloat from large arrays / long captions. */
const ARGS_SUMMARY_MAX_CHARS = 200;

/** Build a short, human-readable args summary for the audit log.
 *
 * Never serializes the full args blob — just a few well-known scalar fields
 * plus the count of any array. Truncated to {@link ARGS_SUMMARY_MAX_CHARS}.
 */
export function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const obj = args as Record<string, unknown>;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      parts.push(`${key}[${value.length}]`);
      continue;
    }
    const t = typeof value;
    if (t === "string") {
      const s = value as string;
      parts.push(`${key}=${s.length > 24 ? `${s.slice(0, 24)}…` : s}`);
    } else if (t === "number" || t === "boolean") {
      parts.push(`${key}=${String(value)}`);
    } else {
      parts.push(`${key}=<${t}>`);
    }
  }
  const joined = parts.join(" ");
  return joined.length > ARGS_SUMMARY_MAX_CHARS ? `${joined.slice(0, ARGS_SUMMARY_MAX_CHARS)}…` : joined;
}

export class DestructiveGuard {
  private db: Database;
  private dailyLimit: number;
  private settingsUrl: string;

  private getPrefStmt: Statement;
  private setPrefStmt: Statement;
  private todayCountStmt: Statement;
  private insertAuditStmt: Statement;
  private listAuditStmt: Statement;

  constructor(db: Database, dailyLimit: number, settingsUrl: string) {
    this.db = db;
    this.dailyLimit = dailyLimit;
    this.settingsUrl = settingsUrl;

    db.exec(`
      CREATE TABLE IF NOT EXISTS user_prefs (
        user_id TEXT PRIMARY KEY,
        enable_destructive INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS destructive_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_summary TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_dest_audit_user ON destructive_audit(user_id);
      CREATE INDEX IF NOT EXISTS idx_dest_audit_created ON destructive_audit(created_at);
    `);

    this.getPrefStmt = db.prepare("SELECT enable_destructive FROM user_prefs WHERE user_id = ?");
    this.setPrefStmt = db.prepare(
      `INSERT INTO user_prefs (user_id, enable_destructive, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET enable_destructive = excluded.enable_destructive,
                                          updated_at = datetime('now')`,
    );
    // Quota only counts actually-executed calls (`result='ok'`). Denied attempts don't burn quota,
    // so a user who flips the toggle off mid-day doesn't lose budget on the rejection.
    this.todayCountStmt = db.prepare(
      `SELECT COUNT(*) AS count FROM destructive_audit
       WHERE user_id = ? AND result = 'ok' AND created_at >= date('now')`,
    );
    this.insertAuditStmt = db.prepare(
      "INSERT INTO destructive_audit (user_id, tool_name, args_summary, result) VALUES (?, ?, ?, ?)",
    );
    this.listAuditStmt = db.prepare(
      `SELECT id, user_id, tool_name, args_summary, result, created_at
       FROM destructive_audit
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    );
  }

  isEnabled(userId: string): boolean {
    const row = this.getPrefStmt.get(userId) as { enable_destructive: number } | undefined;
    return row?.enable_destructive === 1;
  }

  setEnabled(userId: string, enabled: boolean): void {
    this.setPrefStmt.run(userId, enabled ? 1 : 0);
  }

  todayOkCount(userId: string): number {
    const row = this.todayCountStmt.get(userId) as { count: number };
    return row.count;
  }

  /** Pre-flight check. Returns null on pass, human-readable error on deny.
   *
   * `denied_disabled` and `denied_quota` write an audit row immediately; the caller
   * is responsible for calling {@link recordResult} after the handler runs.
   */
  preflight(userId: string, toolName: string, argsSummary: string): string | null {
    if (!this.isEnabled(userId)) {
      this.insertAuditStmt.run(userId, toolName, argsSummary, "denied_disabled");
      return (
        `Destructive tools are disabled for your account. ` +
        `Open ${this.settingsUrl} in your browser to enable them, ` +
        `then retry. Why disabled by default: ${toolName} performs an irreversible action ` +
        `(delete content, revoke an invite link, or change a chat-wide setting).`
      );
    }
    if (this.dailyLimit > 0 && this.todayOkCount(userId) >= this.dailyLimit) {
      this.insertAuditStmt.run(userId, toolName, argsSummary, "denied_quota");
      return (
        `Daily destructive-action limit reached (${this.dailyLimit} calls/day). ` +
        `Resets at 00:00 UTC. Self-hosters can lift this via DESTRUCTIVE_DAILY_LIMIT.`
      );
    }
    return null;
  }

  recordResult(userId: string, toolName: string, argsSummary: string, result: "ok" | "error"): void {
    this.insertAuditStmt.run(userId, toolName, argsSummary, result);
  }

  /** Most recent N rows for a user, newest first. */
  listForUser(userId: string, limit = 100): AuditRow[] {
    return this.listAuditStmt.all(userId, limit) as AuditRow[];
  }

  /** Delete rows older than `days`. Returns rows removed. No-op when `days <= 0`. */
  purgeOldRows(days: number): number {
    if (days <= 0) return 0;
    const result = this.db
      .prepare(`DELETE FROM destructive_audit WHERE created_at < datetime('now', '-${days} days')`)
      .run();
    return result.changes;
  }
}
