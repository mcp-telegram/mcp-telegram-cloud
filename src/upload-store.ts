import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

/**
 * Per-user pending uploads for FS-bound Telegram tools (Phase X).
 *
 * Closes the gap that `telegram-send-file/voice/video-note/album/story/set-profile-photo`
 * cannot ship in cloud directly: upstream methods take an absolute filesystem path on
 * the host, but in cloud the "host" is the container — the user has no path on it.
 *
 * Flow: user POSTs bytes to `/my/upload`, store writes them to a temp file under
 * {@link UPLOAD_DIR_NAME} and inserts a row, returning an opaque `upload_id`.
 * A tool handler resolves the id back to the temp path, hands it to upstream,
 * then deletes the row + temp file (`consume()`). Unconsumed rows are purged
 * by a periodic TTL sweep ({@link purgeExpired}).
 *
 * Per-user quota and per-file size caps are enforced before any disk write to
 * bound a disk-fill DoS surface. The temp dir lives under `os.tmpdir()` so
 * container restarts wipe pending uploads (acceptable: TTL is short).
 */

export interface UploadRow {
  id: string;
  user_id: string;
  tmp_path: string;
  mime: string;
  size: number;
  original_name: string | null;
  created_at: string;
  expires_at: string;
}

/** Subdirectory under `os.tmpdir()` where upload payloads are written. */
export const UPLOAD_DIR_NAME = "mcp-telegram-cloud-uploads";

export type UploadDenyReason = "file_too_large" | "quota_exceeded";

export interface UploadCreated {
  ok: true;
  id: string;
  expiresAt: Date;
}

export interface UploadDenied {
  ok: false;
  reason: UploadDenyReason;
  message: string;
}

export class UploadStore {
  private db: Database.Database;
  private uploadDir: string;
  private fileMaxBytes: number;
  private quotaBytes: number;
  private ttlMs: number;

  private getStmt: Database.Statement;
  private listStmt: Database.Statement;
  private insertStmt: Database.Statement;
  private deleteStmt: Database.Statement;
  private quotaSumStmt: Database.Statement;
  private expiredStmt: Database.Statement;
  private bumpExpiryStmt: Database.Statement;

  /** Minimum remaining lifetime to guarantee an in-flight `resolve → upstream upload`
   * doesn't get purged mid-flight. 5 min covers a 50 MB upload over a slow ~140 KB/s link. */
  private static readonly MIN_HOLD_MS = 5 * 60_000;

  /**
   * @param db          shared cloud SQLite handle (same one DestructiveGuard / SessionManager use).
   *                    Used at construction-time for schema + statements, AND at runtime via
   *                    `db.transaction()` to atomically re-check quota during {@link put}.
   * @param fileMaxBytes hard ceiling on a single upload payload. Enforced before write.
   * @param quotaBytes   per-user sum of currently-pending bytes. Enforced before write.
   * @param ttlMs        time before an unconsumed upload is eligible for purge.
   * @param uploadDir    optional override (tests use a per-suite tmpdir to avoid collisions).
   */
  constructor(db: Database.Database, fileMaxBytes: number, quotaBytes: number, ttlMs: number, uploadDir?: string) {
    this.db = db;
    this.fileMaxBytes = fileMaxBytes;
    this.quotaBytes = quotaBytes;
    this.ttlMs = ttlMs;
    this.uploadDir = uploadDir ?? join(tmpdir(), UPLOAD_DIR_NAME);

    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_uploads (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        tmp_path TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        original_name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_uploads_user ON pending_uploads(user_id);
      CREATE INDEX IF NOT EXISTS idx_pending_uploads_expires ON pending_uploads(expires_at);
    `);

    this.getStmt = db.prepare("SELECT * FROM pending_uploads WHERE id = ?");
    this.listStmt = db.prepare(
      `SELECT id, user_id, tmp_path, mime, size, original_name, created_at, expires_at
       FROM pending_uploads
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    );
    this.insertStmt = db.prepare(
      `INSERT INTO pending_uploads (id, user_id, tmp_path, mime, size, original_name, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.deleteStmt = db.prepare("DELETE FROM pending_uploads WHERE id = ?");
    // Sum size of *unexpired* rows only — expired rows are about to be purged
    // and shouldn't count against the live quota.
    this.quotaSumStmt = db.prepare(
      `SELECT COALESCE(SUM(size), 0) AS total FROM pending_uploads
       WHERE user_id = ? AND expires_at > datetime('now')`,
    );
    this.expiredStmt = db.prepare("SELECT id, tmp_path FROM pending_uploads WHERE expires_at <= datetime('now')");
    this.bumpExpiryStmt = db.prepare("UPDATE pending_uploads SET expires_at = ? WHERE id = ? AND expires_at < ?");
  }

  /** Sum of currently-pending bytes for a user (excluding expired rows). */
  pendingBytesForUser(userId: string): number {
    const row = this.quotaSumStmt.get(userId) as { total: number };
    return row.total;
  }

  /** Per-file cap, exposed so URL-fetcher can mirror the same ceiling
   * (a fetched file lands on the same temp dir, same disk-pressure budget). */
  get fileMaxBytesCap(): number {
    return this.fileMaxBytes;
  }

  /** Per-user quota ceiling, exposed so URL-fetch path can subtract pending bytes
   * and apply a smaller per-call max — keeps URL-fetched files counted against
   * the same disk-pressure budget as user-uploaded `pending_uploads`. */
  get quotaBytesCap(): number {
    return this.quotaBytes;
  }

  /** Pre-flight check without touching disk. Returns null on pass, deny envelope on fail. */
  preflight(userId: string, size: number): UploadDenied | null {
    if (size > this.fileMaxBytes) {
      return {
        ok: false,
        reason: "file_too_large",
        message: `File too large (${size} bytes). Per-file cap is ${this.fileMaxBytes} bytes.`,
      };
    }
    const pending = this.pendingBytesForUser(userId);
    if (pending + size > this.quotaBytes) {
      return {
        ok: false,
        reason: "quota_exceeded",
        message: `Per-user upload quota exceeded (${pending} + ${size} > ${this.quotaBytes} bytes pending). Wait for the TTL to expire or send/discard a pending upload.`,
      };
    }
    return null;
  }

  /**
   * Persist bytes to disk + insert metadata row. Caller is expected to call
   * {@link preflight} first; we re-check inside in case of TOCTOU between
   * preflight and put — and again inside a SQLite transaction so two concurrent
   * `put()` calls from the same user can't both pass quota and over-commit.
   */
  async put(
    userId: string,
    bytes: Buffer,
    mime: string,
    originalName: string | null,
  ): Promise<UploadCreated | UploadDenied> {
    const denied = this.preflight(userId, bytes.byteLength);
    if (denied) return denied;

    // mode 0o700 — directory listable only by the cloud process owner. Files inside
    // are written with mode 0o600. Defense-in-depth against shared `/tmp` in
    // multi-tenant containers; in a single-process container the difference is moot.
    await mkdir(this.uploadDir, { recursive: true, mode: 0o700 });
    const id = `upl_${randomUUID().replace(/-/g, "")}`;
    const tmpPath = join(this.uploadDir, id);
    // Write the file BEFORE the txn-guarded insert. If the txn rejects (race), we
    // unlink. Reverse order would let two parallel callers both insert, then both
    // try to write to the same path with no rejection signal.
    await writeFile(tmpPath, bytes, { mode: 0o600 });

    const expiresAt = new Date(Date.now() + this.ttlMs);
    const expiresStr = isoUtc(expiresAt);
    // SQLite better-sqlite3 transactions are synchronous + serialized in this process,
    // so the SUM read + INSERT happen atomically with respect to other put() calls
    // sharing this DB handle. Two parallel async calls now race only on async work
    // OUTSIDE the transaction (the file write); the SUM-then-insert is linearized.
    const accepted = this.db.transaction(() => {
      const row = this.quotaSumStmt.get(userId) as { total: number };
      if (row.total + bytes.byteLength > this.quotaBytes) return false;
      this.insertStmt.run(id, userId, tmpPath, mime, bytes.byteLength, originalName, expiresStr);
      return true;
    })();

    if (!accepted) {
      // Race lost. Roll back the file write and report quota exceeded.
      await safeUnlink(tmpPath);
      const pending = this.pendingBytesForUser(userId);
      return {
        ok: false,
        reason: "quota_exceeded",
        message: `Per-user upload quota exceeded under concurrent put (${pending} + ${bytes.byteLength} > ${this.quotaBytes} bytes pending). Retry after the TTL or after consuming a pending upload.`,
      };
    }

    return { ok: true, id, expiresAt };
  }

  /**
   * Resolve an `upload_id` for a specific user. Returns the row if it exists,
   * is owned by `userId`, and is not expired. Returns null otherwise.
   * Does NOT delete — use {@link consume} to atomically resolve-and-delete.
   *
   * Side effect: extends `expires_at` to at least `now + MIN_HOLD_MS` so a
   * concurrent `purgeExpired()` doesn't unlink the temp file mid-upstream-upload.
   * The bump only triggers when the current expiry is sooner than the floor —
   * a fresh upload with full TTL ahead is unaffected.
   */
  resolve(userId: string, id: string): UploadRow | null {
    const row = this.getStmt.get(id) as UploadRow | undefined;
    if (!row) return null;
    if (row.user_id !== userId) return null;
    // expires_at is stored as `YYYY-MM-DD HH:MM:SS` UTC (matching SQLite's `datetime('now')`).
    // `new Date("YYYY-MM-DD HH:MM:SS")` is parsed as LOCAL time by JS — that would falsely
    // expire rows in any non-UTC timezone. Append "Z" to force UTC interpretation.
    const expiresMs = new Date(`${row.expires_at}Z`).getTime();
    if (expiresMs <= Date.now()) return null;

    // Hold-bump: if remaining lifetime < MIN_HOLD_MS, push it out so an in-flight
    // upstream upload won't race with purgeExpired(). Conditional UPDATE guarded
    // by `expires_at < ?` makes this idempotent for already-far-future rows.
    const floorMs = Date.now() + UploadStore.MIN_HOLD_MS;
    if (expiresMs < floorMs) {
      const floorStr = isoUtc(new Date(floorMs));
      this.bumpExpiryStmt.run(floorStr, id, floorStr);
      row.expires_at = floorStr;
    }
    return row;
  }

  /**
   * Resolve + delete row + unlink temp file. Idempotent: a second call returns null.
   * Used after a tool handler successfully finishes consuming the upload.
   */
  async consume(userId: string, id: string): Promise<UploadRow | null> {
    const row = this.resolve(userId, id);
    if (!row) return null;
    this.deleteStmt.run(id);
    await safeUnlink(row.tmp_path);
    return row;
  }

  /** Most recent N rows for a user (for `/my/uploads` listing). */
  listForUser(userId: string, limit = 50): UploadRow[] {
    return this.listStmt.all(userId, limit) as UploadRow[];
  }

  /**
   * Purge expired rows + unlink their temp files. Returns count purged.
   * Safe to call on a timer; no-op when nothing is expired.
   */
  async purgeExpired(): Promise<number> {
    const expired = this.expiredStmt.all() as Array<{ id: string; tmp_path: string }>;
    if (expired.length === 0) return 0;
    for (const row of expired) {
      this.deleteStmt.run(row.id);
      await safeUnlink(row.tmp_path);
    }
    return expired.length;
  }
}

function isoUtc(d: Date): string {
  // SQLite datetime() returns "YYYY-MM-DD HH:MM:SS" UTC; match the same shape
  // so string comparisons against `datetime('now')` are predictable.
  return d
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // File may already be gone (manual cleanup, race with concurrent purge).
    // Row deletion is the source of truth; orphan files would only matter if
    // the disk fills, which TTL purge + quota already bound.
  }
}
