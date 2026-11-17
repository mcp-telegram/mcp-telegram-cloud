import { createHash, randomBytes } from "node:crypto";
import { sanitizeFileName } from "./filename.js";

/** MCP chunk size; chunk offsets must be multiples of it. */
export const DOWNLOAD_CHUNK_BYTES = 64 * 1024;
/** Largest file a regular account can upload to Telegram (4000 parts of 512 KiB). */
export const UPLOAD_MAX_BYTES = 2000 * 1024 * 1024;
export const DOWNLOAD_LIMITS = {
  /**
   * Largest file a message can hold (Telegram Premium uploads). Tickets and MCP chunk
   * offsets share this cap, so every ticket can be read to the end through MCP too.
   */
  fileBytes: 4000 * 1024 * 1024,
  userTickets: 32,
  totalTickets: 10_000,
  ttlMs: 15 * 60_000,
} as const;

export interface DownloadMetadata {
  downloadId: string;
  fileName: string;
  mimeType: string;
  size: number;
  expiresAt: string;
  chatId: string;
  messageId: number;
}

/** Where the file lives and who may read it. `canRead` re-checks the account binding. */
export interface TicketSource {
  chatId: string;
  messageId: number;
  accountId: number;
  canRead: () => boolean;
}

export interface Ticket {
  owner: string;
  accountId: number;
  /** Telegram file identity at issue time; reads refuse a different file. */
  fileId: string;
  metadata: DownloadMetadata;
  canRead: () => boolean;
}

interface Entry extends Ticket {
  expires: number;
  tokenHash: string | undefined;
}

const EXTENSIONS: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "video/mp4": "mp4",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
};

const hashLinkToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Download tickets: in-memory records that say which Telegram file an owner may
 * fetch, from which account, until when. No file bytes are kept; every read goes
 * to Telegram. IDs are selectors, never credentials. The one-time link token is
 * the only bearer secret: 128 bits, stored hashed, valid for one request.
 * A restart forgets all tickets; callers then ask for the file again via MCP.
 */
export class DownloadStore {
  private entries = new Map<string, Entry>();
  private tokens = new Map<string, string>();
  constructor(private readonly now: () => number = Date.now) {}

  private drop(id: string): void {
    const entry = this.entries.get(id);
    if (entry?.tokenHash) this.tokens.delete(entry.tokenHash);
    this.entries.delete(id);
  }

  private live(entry: Entry): boolean {
    return entry.expires > this.now() && entry.canRead();
  }

  purgeExpired(): number {
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (!this.live(entry)) {
        this.drop(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Issue a ticket, or return the live one for the same owner, account and message.
   * Each call mints a fresh one-time token; the previous token of that ticket stops working.
   */
  issue(
    owner: string,
    source: TicketSource,
    info: { fileId: string; size: number; mimeType: string; fileName?: string },
  ): { metadata: DownloadMetadata; oneTimeToken: string; reused: boolean } {
    this.purgeExpired();
    let entry = [...this.entries.values()].find(
      (e) =>
        e.owner === owner &&
        e.accountId === source.accountId &&
        e.metadata.chatId === source.chatId &&
        e.metadata.messageId === source.messageId &&
        e.fileId === info.fileId &&
        e.metadata.size === info.size,
    );
    const reused = entry !== undefined;
    if (!entry) {
      const mine = [...this.entries.values()].filter((e) => e.owner === owner).sort((a, b) => a.expires - b.expires);
      // Records are tiny, so the oldest ticket makes room instead of refusing the request.
      while (mine.length >= DOWNLOAD_LIMITS.userTickets) this.drop((mine.shift() as Entry).metadata.downloadId);
      if (this.entries.size >= DOWNLOAD_LIMITS.totalTickets) {
        const oldest = [...this.entries.values()].sort((a, b) => a.expires - b.expires)[0];
        if (oldest) this.drop(oldest.metadata.downloadId);
      }
      const mimeType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(info.mimeType)
        ? info.mimeType.toLowerCase()
        : "application/octet-stream";
      const fileName = sanitizeFileName(info.fileName) ?? `media-${source.messageId}.${EXTENSIONS[mimeType] ?? "bin"}`;
      const downloadId = `dl_${randomBytes(16).toString("hex")}`;
      const expires = this.now() + DOWNLOAD_LIMITS.ttlMs;
      entry = {
        owner,
        accountId: source.accountId,
        fileId: info.fileId,
        canRead: source.canRead,
        expires,
        tokenHash: undefined,
        metadata: {
          downloadId,
          fileName,
          mimeType,
          size: info.size,
          expiresAt: new Date(expires).toISOString(),
          chatId: source.chatId,
          messageId: source.messageId,
        },
      };
      this.entries.set(downloadId, entry);
    }
    if (entry.tokenHash) this.tokens.delete(entry.tokenHash);
    const oneTimeToken = randomBytes(16).toString("base64url");
    entry.tokenHash = hashLinkToken(oneTimeToken);
    this.tokens.set(entry.tokenHash, entry.metadata.downloadId);
    return { metadata: { ...entry.metadata }, oneTimeToken, reused };
  }

  /** The owner's live ticket, or null when unknown, expired, foreign or no longer readable. */
  get(owner: string, id: string): Ticket | null {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) return null;
    if (!this.live(entry)) {
      this.drop(id);
      return null;
    }
    return {
      owner,
      accountId: entry.accountId,
      fileId: entry.fileId,
      canRead: entry.canRead,
      metadata: { ...entry.metadata },
    };
  }

  /** Use up a one-time token. Returns the ticket on the first call only. */
  redeem(token: string): Ticket | null {
    const hash = hashLinkToken(token);
    const id = this.tokens.get(hash);
    if (!id) return null;
    this.tokens.delete(hash);
    const entry = this.entries.get(id);
    if (!entry) return null;
    entry.tokenHash = undefined;
    return this.get(entry.owner, id);
  }

  forget(owner: string, id: string): void {
    if (this.entries.get(id)?.owner === owner) this.drop(id);
  }
}
