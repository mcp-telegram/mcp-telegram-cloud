import { createHash, randomBytes } from "node:crypto";
import { sanitizeFileName } from "./filename.js";

export const DOWNLOAD_CHUNK_BYTES = 64 * 1024;
export const DOWNLOAD_LIMITS = {
  fileBytes: 8 * 1024 * 1024,
  userBytes: 32 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
  userFiles: 8,
  totalFiles: 128,
  concurrent: 4,
  ttlMs: 15 * 60_000,
} as const;

export interface DownloadMetadata {
  downloadId: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  expiresAt: string;
  chatId: string;
  messageId: number;
}
interface Entry {
  owner: string;
  bytes: Buffer;
  metadata: DownloadMetadata;
  expires: number;
  canRead: () => boolean;
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

/** Bounded, process-local snapshots. Nothing sensitive lands in SQLite,
 * backups or /tmp. IDs are selectors, NEVER bearer credentials. A restart or
 * rolling update may lose a snapshot: callers then prepare it again via MCP.
 * Reservations remain held until actual MTProto work settles, even after the
 * outer tool timeout: releasing them early would permit unlimited orphan IO.
 */
export class DownloadStore {
  private entries = new Map<string, Entry>();
  private pending = new Set<string>();
  constructor(private readonly now: () => number = Date.now) {}

  purgeExpired(): number {
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (entry.expires <= this.now() || !entry.canRead()) {
        this.entries.delete(id);
        removed++;
      }
    }
    return removed;
  }

  async prepare(
    owner: string,
    source: { chatId: string; messageId: number; canRead: () => boolean },
    loadMedia: (maxBytes: number) => Promise<{ buffer: Buffer; mimeType: string; fileName?: string }>,
  ): Promise<DownloadMetadata> {
    this.purgeExpired();
    if (this.pending.has(owner) || this.pending.size >= DOWNLOAD_LIMITS.concurrent) {
      throw new Error("Download already in progress or server busy. Retry later.");
    }
    const entries = [...this.entries.values()];
    const mine = entries.filter((e) => e.owner === owner);
    // Reserve a whole file before network IO, not after receiving the bytes.
    const reserved = this.pending.size * DOWNLOAD_LIMITS.fileBytes;
    if (
      mine.length >= DOWNLOAD_LIMITS.userFiles ||
      entries.length + this.pending.size >= DOWNLOAD_LIMITS.totalFiles ||
      mine.reduce((n, e) => n + e.bytes.length, 0) + DOWNLOAD_LIMITS.fileBytes > DOWNLOAD_LIMITS.userBytes ||
      entries.reduce((n, e) => n + e.bytes.length, 0) + reserved + DOWNLOAD_LIMITS.fileBytes >
        DOWNLOAD_LIMITS.totalBytes
    ) {
      throw new Error("Temporary download quota exceeded. Wait for expiry before preparing another file.");
    }
    this.pending.add(owner);
    try {
      const result = await loadMedia(DOWNLOAD_LIMITS.fileBytes);
      if (!result.buffer.length || result.buffer.length > DOWNLOAD_LIMITS.fileBytes) {
        throw new Error(`Media must be between 1 and ${DOWNLOAD_LIMITS.fileBytes} bytes`);
      }
      if (!source.canRead()) throw new Error("Source account is no longer available. Reconnect and prepare again.");
      const mimeType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(result.mimeType)
        ? result.mimeType.toLowerCase()
        : "application/octet-stream";
      const fileName =
        sanitizeFileName(result.fileName) ?? `media-${source.messageId}.${EXTENSIONS[mimeType] ?? "bin"}`;
      const downloadId = `dl_${randomBytes(16).toString("hex")}`;
      const expires = this.now() + DOWNLOAD_LIMITS.ttlMs;
      const metadata: DownloadMetadata = {
        downloadId,
        fileName,
        mimeType,
        size: result.buffer.length,
        sha256: createHash("sha256").update(result.buffer).digest("hex"),
        expiresAt: new Date(expires).toISOString(),
        chatId: source.chatId,
        messageId: source.messageId,
      };
      this.entries.set(downloadId, { owner, bytes: result.buffer, metadata, expires, canRead: source.canRead });
      return { ...metadata };
    } finally {
      this.pending.delete(owner);
    }
  }

  private resolve(owner: string, id: string): Entry | null {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) return null;
    if (entry.expires <= this.now() || !entry.canRead()) {
      this.entries.delete(id);
      return null;
    }
    return entry;
  }

  read(owner: string, id: string): { bytes: Buffer; metadata: DownloadMetadata } | null {
    const entry = this.resolve(owner, id);
    return entry ? { bytes: entry.bytes, metadata: { ...entry.metadata } } : null;
  }

  forget(owner: string, id: string): void {
    if (this.entries.get(id)?.owner === owner) this.entries.delete(id);
  }

  chunk(owner: string, id: string, chatId: string, messageId: number, offset: number) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative safe integer");
    const entry = this.resolve(owner, id);
    if (!entry || entry.metadata.chatId !== chatId || entry.metadata.messageId !== messageId) return null;
    if (offset > entry.bytes.length) throw new Error("offset exceeds file size");
    const end = Math.min(offset + DOWNLOAD_CHUNK_BYTES, entry.bytes.length);
    return {
      downloadId: id,
      offset,
      nextOffset: end,
      eof: end === entry.bytes.length,
      base64: entry.bytes.subarray(offset, end).toString("base64"),
    };
  }
}
