import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { purgeLegacyUploads } from "../legacy-uploads.js";

describe("legacy disk-backed upload cleanup", () => {
  it("deletes legacy rows, their files inside the legacy dirs and the dirs themselves", async () => {
    const root = await mkdtemp(join(tmpdir(), "legacy-uploads-test-"));
    const db = new Database(":memory:");
    try {
      const uploadsDir = join(root, "mcp-telegram-cloud-uploads");
      const fetchDir = join(root, "mcp-telegram-cloud-urlfetch");
      await mkdir(uploadsDir);
      await mkdir(fetchDir);
      const legacy = join(uploadsDir, "upl_1");
      const orphan = join(fetchDir, "urlfetch_2");
      const outside = join(root, "not-ours.txt");
      for (const f of [legacy, orphan, outside]) await writeFile(f, "x");
      db.exec(
        "CREATE TABLE pending_uploads (id TEXT PRIMARY KEY, user_id TEXT, tmp_path TEXT, mime TEXT, size INTEGER, original_name TEXT, created_at TEXT, expires_at TEXT)",
      );
      const insert = db.prepare("INSERT INTO pending_uploads (id, tmp_path) VALUES (?, ?)");
      insert.run("upl_1", legacy);
      insert.run("upl_evil", outside); // a row is not a licence to delete arbitrary paths
      insert.run("upl_escape", join(uploadsDir, "..", "not-ours.txt"));

      const result = await purgeLegacyUploads(db, root);
      assert.deepEqual(result, { rows: 3, files: 1, dirs: 2 });
      assert.equal(existsSync(legacy), false);
      assert.equal(existsSync(orphan), false, "orphans go with their dir");
      assert.equal(existsSync(uploadsDir) || existsSync(fetchDir), false);
      assert.equal(existsSync(outside), true, "files outside the legacy dirs are never touched");
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM pending_uploads").get() as { n: number }).n, 0);

      assert.deepEqual(await purgeLegacyUploads(db, root), { rows: 0, files: 0, dirs: 0 }, "idempotent");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is a no-op on a database that never had the legacy table", async () => {
    const db = new Database(":memory:");
    const root = await mkdtemp(join(tmpdir(), "legacy-uploads-empty-"));
    try {
      assert.deepEqual(await purgeLegacyUploads(db, root), { rows: 0, files: 0, dirs: 0 });
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
