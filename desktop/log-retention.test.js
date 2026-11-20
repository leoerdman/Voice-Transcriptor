"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { archivesToPrune, pruneLogArchives, MAIN_LOG_ARCHIVE_KEEP_COUNT, MAIN_LOG_ARCHIVE_KEEP_BYTES } = require("./log-retention");

const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const archive = (i, size = MB, ageDays = i) => ({ name: `main.log.archive-${i}`, mtimeMs: 1e12 - ageDays * DAY, size });

test("the user's policy: 10 archives, 50 MB", () => {
  assert.equal(MAIN_LOG_ARCHIVE_KEEP_COUNT, 10);
  assert.equal(MAIN_LOG_ARCHIVE_KEEP_BYTES, 50 * MB);
});

test("the November state (25 archives, ~5 MB each) is cut to what fits both caps, oldest first", () => {
  const archives = Array.from({ length: 25 }, (_, i) => archive(i, 5.3 * MB));
  const pruned = archivesToPrune(archives);
  // 9 × 5.3 MB = 47.7 MB fits; a 10th would pass 50 MB.
  assert.equal(pruned.length, 16);
  assert.deepEqual(pruned, archives.slice(9).map((a) => a.name));
});

test("small archives: the count cap keeps the newest ten", () => {
  const archives = Array.from({ length: 12 }, (_, i) => archive(i, 100));
  assert.deepEqual(archivesToPrune(archives), ["main.log.archive-10", "main.log.archive-11"]);
});

test("there is no age cap: ten old, small archives all stay", () => {
  const archives = Array.from({ length: 10 }, (_, i) => archive(i, 100, 90 + i));
  assert.deepEqual(archivesToPrune(archives), []);
});

test("the newest archive survives even when it alone exceeds the byte cap", () => {
  const archives = [archive(0, 80 * MB), archive(1, MB)];
  assert.deepEqual(archivesToPrune(archives), ["main.log.archive-1"]);
});

test("input order does not matter", () => {
  const archives = Array.from({ length: 12 }, (_, i) => archive(i, 100)).reverse();
  assert.deepEqual(archivesToPrune(archives).sort(), ["main.log.archive-10", "main.log.archive-11"]);
});

test("once an archive is pruned every older one goes too: no holes in the kept history", () => {
  // A big newer archive pushes past the byte cap; the small older one
  // behind it must not survive on its own.
  const archives = [archive(0, 10 * MB), archive(1, 45 * MB), archive(2, MB)];
  assert.deepEqual(archivesToPrune(archives), ["main.log.archive-1", "main.log.archive-2"]);
});

test("the boot sweep removes exactly the pruned archives from a real directory", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-retention-"));
  try {
    const logPath = path.join(dir, "main.log");
    fs.writeFileSync(logPath, "live");
    fs.writeFileSync(path.join(dir, "other.txt"), "not ours");
    const now = Date.now() / 1000;
    for (let i = 0; i < 12; i += 1) {
      const p = path.join(dir, `main.log.archive-${String(i).padStart(2, "0")}`);
      fs.writeFileSync(p, "x");
      fs.utimesSync(p, now - i * 60, now - i * 60);
    }
    const lines = [];
    const removed = pruneLogArchives(logPath, { log: (l) => lines.push(l) });
    assert.deepEqual(removed.sort(), ["main.log.archive-10", "main.log.archive-11"]);
    assert.ok(fs.existsSync(logPath), "the live log is never an archive");
    assert.ok(fs.existsSync(path.join(dir, "other.txt")), "files of other names are not touched");
    assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith("main.log.archive-")).length, 10);
    assert.equal(lines.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable directory is not an error", () => {
  assert.deepEqual(pruneLogArchives("/nonexistent-dir-for-test/main.log"), []);
});
