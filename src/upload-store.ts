import { createHash, randomBytes } from "node:crypto";
import type { UploadedFile } from "@overpod/mcp-telegram/service";

/**
 * Pending uploads for the send-* tools, held in memory only.
 *
 * The bytes never touch this server's disk: `/my/upload`, one-time upload links
 * and URL sources stream them straight into Telegram (`uploadStream` in core),
 * and this store keeps only the resulting handle (Telegram's file id + part count
 * + name). A send tool resolves an `upl_...` id back to that handle and consumes it.
 *
 * Telegram ties uploaded parts to the account's session, so every record carries
 * the account it was uploaded with; `canUse` re-checks that binding.
 */

export interface UploadRow {
  id: string;
  user_id: string;
  mime: string;
  size: number;
  original_name: string | null;
  created_at: string;
  expires_at: string;
}

export interface UploadBinding {
  accountId: number;
  /** False once the account was detached or replaced. */
  canUse: () => boolean;
}

export interface ReadyUpload {
  row: UploadRow;
  file: UploadedFile;
  accountId: number;
  canUse: () => boolean;
}

export interface ClaimedLink {
  uploadId: string;
  owner: string;
  accountId: number;
  canUse: () => boolean;
  fileName: string;
  size: number;
  /** Lower-case hex SHA-256 the uploaded bytes must match, when the creator gave one. */
  sha256?: string;
}

interface ReadyEntry extends ReadyUpload {
  expires: number;
}

interface LinkEntry extends ClaimedLink {
  expires: number;
  tokenHash: string;
}

export const MAX_PENDING_UPLOADS_PER_USER = 20;
/**
 * An unused upload link expires sooner than an uploaded file: its URL and exact size sit
 * in the conversation, so a reader could otherwise race the owner to it for longer.
 */
const UPLOAD_LINK_TTL_MS = 5 * 60_000;

const hashLinkToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** `YYYY-MM-DD HH:MM:SS` UTC, the shape the uploads page has always shown. */
function displayTime(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}

export class UploadStore {
  private ready = new Map<string, ReadyEntry>();
  private links = new Map<string, LinkEntry>();

  constructor(
    readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private pendingCount(owner: string): number {
    let n = 0;
    for (const e of this.ready.values()) if (e.row.user_id === owner) n++;
    for (const l of this.links.values()) if (l.owner === owner) n++;
    return n;
  }

  /** Error text when the owner already holds too many pending uploads, else null. */
  checkCapacity(owner: string): string | null {
    this.purgeExpired();
    return this.pendingCount(owner) >= MAX_PENDING_UPLOADS_PER_USER
      ? `Too many pending uploads (${MAX_PENDING_UPLOADS_PER_USER}). Send or wait for some to expire (15 min).`
      : null;
  }

  /** Reserve an upload id and a one-time token for `PUT /u/<token>`. */
  createLink(
    owner: string,
    binding: UploadBinding,
    fileName: string,
    size: number,
    opts: { sha256?: string } = {},
  ): { uploadId: string; token: string; expiresAt: Date } | { error: string } {
    const full = this.checkCapacity(owner);
    if (full) return { error: full };
    const uploadId = `upl_${randomBytes(16).toString("hex")}`;
    const token = randomBytes(16).toString("base64url");
    const expires = this.now() + Math.min(this.ttlMs, UPLOAD_LINK_TTL_MS);
    const tokenHash = hashLinkToken(token);
    this.links.set(tokenHash, {
      uploadId,
      owner,
      accountId: binding.accountId,
      canUse: binding.canUse,
      fileName,
      size,
      ...(opts.sha256 && { sha256: opts.sha256.toLowerCase() }),
      expires,
      tokenHash,
    });
    return { uploadId, token, expiresAt: new Date(expires) };
  }

  /** Reservation behind a link token without using it up. */
  peekLink(token: string): ClaimedLink | null {
    const link = this.links.get(hashLinkToken(token));
    if (!link || link.expires <= this.now() || !link.canUse()) return null;
    const { tokenHash: _t, expires: _e, ...claimed } = link;
    return claimed;
  }

  /** Use up a link token. Returns the reservation on the first call only. */
  claimLink(token: string): ClaimedLink | null {
    const hash = hashLinkToken(token);
    const link = this.links.get(hash);
    if (!link) return null;
    this.links.delete(hash);
    if (link.expires <= this.now() || !link.canUse()) return null;
    const { tokenHash: _t, expires: _e, ...claimed } = link;
    return claimed;
  }

  /** Whether an upload id still waits for its link to be used. */
  isAwaitingLink(owner: string, id: string): boolean {
    for (const l of this.links.values()) {
      if (l.uploadId === id && l.owner === owner && l.expires > this.now()) return true;
    }
    return false;
  }

  /** Register a file already uploaded to Telegram. `id` is set when it came through a link. */
  put(
    owner: string,
    binding: UploadBinding,
    file: UploadedFile,
    mime: string,
    originalName: string | null,
    id: string = `upl_${randomBytes(16).toString("hex")}`,
  ): { id: string; expiresAt: Date } {
    const created = this.now();
    const expires = created + this.ttlMs;
    this.ready.set(id, {
      row: {
        id,
        user_id: owner,
        mime,
        size: file.size,
        original_name: originalName,
        created_at: displayTime(created),
        expires_at: displayTime(expires),
      },
      file,
      accountId: binding.accountId,
      canUse: binding.canUse,
      expires,
    });
    return { id, expiresAt: new Date(expires) };
  }

  /** The owner's live upload, or null. Does not consume it. */
  resolve(owner: string, id: string): ReadyUpload | null {
    const entry = this.ready.get(id);
    if (!entry || entry.row.user_id !== owner) return null;
    if (entry.expires <= this.now() || !entry.canUse()) {
      this.ready.delete(id);
      return null;
    }
    return { row: { ...entry.row }, file: entry.file, accountId: entry.accountId, canUse: entry.canUse };
  }

  /** Resolve and remove. Idempotent: a second call returns null. */
  consume(owner: string, id: string): ReadyUpload | null {
    const found = this.resolve(owner, id);
    if (found) this.ready.delete(id);
    return found;
  }

  /** Most recent uploads of a user, for the `/my/uploads` page. */
  listForUser(owner: string, limit = 50): UploadRow[] {
    this.purgeExpired();
    return [...this.ready.values()]
      .filter((e) => e.row.user_id === owner)
      .sort((a, b) => b.expires - a.expires)
      .slice(0, limit)
      .map((e) => ({ ...e.row }));
  }

  /** Uploads and unused upload links the owner holds now; parallel uploads can push it past MAX_PENDING_UPLOADS_PER_USER. */
  pendingCountForUser(owner: string): number {
    this.purgeExpired();
    return this.pendingCount(owner);
  }

  /** Bytes uploaded to Telegram and not yet sent. They live in Telegram, not here. */
  pendingBytesTotal(): number {
    let total = 0;
    for (const e of this.ready.values()) if (e.expires > this.now()) total += e.row.size;
    return total;
  }

  purgeExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const [id, e] of this.ready) {
      if (e.expires <= now) {
        this.ready.delete(id);
        removed++;
      }
    }
    for (const [hash, l] of this.links) {
      if (l.expires <= now) {
        this.links.delete(hash);
        removed++;
      }
    }
    return removed;
  }
}
