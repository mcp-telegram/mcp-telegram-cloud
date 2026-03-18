import type Database from "better-sqlite3";

/** Lightweight usage tracking — logs every MCP tool call for analytics & future rate limiting */
export class UsageTracker {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        client TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_log(user_id);
      CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at);
    `);
    // Add client column if missing (migration from older schema)
    try {
      this.db.exec("ALTER TABLE usage_log ADD COLUMN client TEXT NOT NULL DEFAULT ''");
    } catch {
      // Column already exists — expected
    }
    this.insertStmt = this.db.prepare("INSERT INTO usage_log (user_id, tool_name, client) VALUES (?, ?, ?)");
  }

  /** Log a single tool call (synchronous, fast) */
  logToolCall(userId: string, toolName: string, client = ""): void {
    this.insertStmt.run(userId, toolName, client);
  }

  /** Get total calls per user (optionally filtered by days) */
  getUserStats(days?: number): { userId: string; totalCalls: number }[] {
    const where = days ? `WHERE created_at >= datetime('now', '-${days} days')` : "";
    return this.db
      .prepare(
        `SELECT user_id AS userId, COUNT(*) AS totalCalls
         FROM usage_log ${where}
         GROUP BY user_id ORDER BY totalCalls DESC`,
      )
      .all() as { userId: string; totalCalls: number }[];
  }

  /** Get per-tool breakdown for a specific user */
  getToolBreakdown(userId: string, days?: number): { toolName: string; count: number }[] {
    const dateFilter = days ? `AND created_at >= datetime('now', '-${days} days')` : "";
    return this.db
      .prepare(
        `SELECT tool_name AS toolName, COUNT(*) AS count
         FROM usage_log WHERE user_id = ? ${dateFilter}
         GROUP BY tool_name ORDER BY count DESC`,
      )
      .all(userId) as { toolName: string; count: number }[];
  }

  /** Get daily totals (for charts / monitoring) */
  getDailyStats(days = 30): { date: string; count: number }[] {
    return this.db
      .prepare(
        `SELECT date(created_at) AS date, COUNT(*) AS count
         FROM usage_log
         WHERE created_at >= datetime('now', '-${days} days')
         GROUP BY date(created_at) ORDER BY date DESC`,
      )
      .all() as { date: string; count: number }[];
  }

  /** Get call count for a user today (for rate limiting) */
  getTodayCount(userId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM usage_log
         WHERE user_id = ? AND created_at >= date('now')`,
      )
      .get(userId) as { count: number };
    return row.count;
  }

  /** Get breakdown by client (Claude, ChatGPT, etc.) */
  getClientStats(days?: number): { client: string; totalCalls: number; uniqueUsers: number }[] {
    const where = days ? `WHERE created_at >= datetime('now', '-${days} days')` : "";
    return this.db
      .prepare(
        `SELECT CASE WHEN client = '' THEN 'unknown' ELSE client END AS client,
                COUNT(*) AS totalCalls,
                COUNT(DISTINCT user_id) AS uniqueUsers
         FROM usage_log ${where}
         GROUP BY client ORDER BY totalCalls DESC`,
      )
      .all() as { client: string; totalCalls: number; uniqueUsers: number }[];
  }

  /** Get daily active users count */
  getDailyActiveUsers(days = 30): { date: string; activeUsers: number }[] {
    return this.db
      .prepare(
        `SELECT date(created_at) AS date, COUNT(DISTINCT user_id) AS activeUsers
         FROM usage_log
         WHERE created_at >= datetime('now', '-${days} days')
         GROUP BY date(created_at) ORDER BY date DESC`,
      )
      .all() as { date: string; activeUsers: number }[];
  }

  /** Get peak usage hours (UTC) */
  getHourlyStats(days = 7): { hour: number; count: number }[] {
    return this.db
      .prepare(
        `SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour, COUNT(*) AS count
         FROM usage_log
         WHERE created_at >= datetime('now', '-${days} days')
         GROUP BY hour ORDER BY hour`,
      )
      .all() as { hour: number; count: number }[];
  }
}
