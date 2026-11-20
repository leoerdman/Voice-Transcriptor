"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { archivesToPrune, MAIN_LOG_ARCHIVE_KEEP_COUNT, MAIN_LOG_ARCHIVE_KEEP_BYTES } = require("./log-retention");
const { topLevelFunctionSource } = require("./main-source");

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

test("the boot sweep deletes exactly what archivesToPrune names (wiring)", () => {
  const fn = topLevelFunctionSource("pruneMainLogArchives");
  assert.ok(fn, "pruneMainLogArchives not found");
  assert.match(fn, /archivesToPrune\(/);
});
