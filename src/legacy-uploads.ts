import type { Database } from "bun:sqlite";
import { rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/** Temp dirs the disk-backed upload pipeline (before media streaming) wrote into. */
const LEGACY_UPLOAD_DIRS = ["mcp-telegram-cloud-uploads", "mcp-telegram-cloud-urlfetch"] as const;

/**
 * One-shot cleanup after the move to in-memory upload handles. Earlier versions kept
 * pending uploads as files under the temp dir, indexed by SQLite `pending_uploads`;
 * nothing reads them any more, so on an in-place upgrade they would stay forever.
 *
 * Deletes every legacy row, unlinks its file only when the path lies inside a legacy
 * dir (a row is data, not a licence to delete arbitrary paths), then removes both dirs.
 * The table itself is kept: during a rolling update the previous task may still write
 * to it, which is why the caller runs this only after that task's uploads have expired.
 */
export async function purgeLegacyUploads(
  db: Database,
  root: string = tmpdir(),
): Promise<{ rows: number; files: number; dirs: number }> {
  const dirs = LEGACY_UPLOAD_DIRS.map((d) => resolve(join(root, d)));
  const inside = (path: string) => {
    const full = resolve(path);
    return dirs.some((d) => full.startsWith(`${d}${sep}`));
  };
  let rows = 0;
  let files = 0;
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_uploads'").get();
  if (table) {
    const paths = db.prepare("SELECT tmp_path FROM pending_uploads").all() as Array<{ tmp_path: string }>;
    for (const { tmp_path } of paths) {
      if (!tmp_path || !inside(tmp_path)) continue;
      try {
        await unlink(tmp_path);
        files++;
      } catch {
        // already gone
      }
    }
    rows = db.prepare("DELETE FROM pending_uploads").run().changes;
  }
  let removedDirs = 0;
  for (const dir of dirs) {
    try {
      await stat(dir);
    } catch {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
    removedDirs++;
  }
  return { rows, files, dirs: removedDirs };
}
