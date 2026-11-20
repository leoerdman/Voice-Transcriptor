"use strict";

// DM-07 / DM-11 / S-12 / DM-34 (Ultra-Audit 2026-11-20): one rule for the
// data directory, read live by every caller including the logger, and a
// OneDrive re-home that carries the user's data rather than a retyped
// subset of it.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  MAIN_LOG_FILE,
  resolveDataDir,
  isRegeneratedEntry,
  oneDriveMigrationEntries,
} = require("./data-dir");
const { mainSource, topLevelFunctionSource } = require("./main-source");

test("the override wins, otherwise userData", () => {
  assert.equal(resolveDataDir({ envDataDir: "/srv/t", userDataPath: "/u" }), path.resolve("/srv/t"));
  assert.equal(resolveDataDir({ envDataDir: "   ", userDataPath: "/u" }), "/u");
  assert.equal(resolveDataDir({ userDataPath: "/u" }), "/u");
});

test("main.js resolves the data directory in exactly one place", () => {
  const userDataReads = mainSource.match(/app\.getPath\("userData"\)/g) || [];
  assert.equal(userDataReads.length, 1, "only dataDir() may read userData");
  assert.match(topLevelFunctionSource("dataDir"), /app\.getPath\("userData"\)/);
  assert.doesNotMatch(mainSource, /process\.env\.TRANSCRIPTOR_DATA_DIR \|\|/, "no restated override rule");
});

test("main.log follows the data directory instead of caching its first path (DM-07)", () => {
  assert.doesNotMatch(mainSource, /let mainLogFilePath\b/, "a cached log path outlives the OneDrive re-home");
  assert.match(topLevelFunctionSource("mainLogFilePath"), /path\.join\(dataDir\(\), MAIN_LOG_FILE\)/);
  assert.match(topLevelFunctionSource("appendMainLog"), /mainLogFilePath\(\)/);
  assert.equal(MAIN_LOG_FILE, "main.log");
});

test("the OneDrive re-home copies everything but what the shell regenerates (DM-34)", () => {
  const old = [
    "config.json", ".encryption_key", "api_token.txt", "known_archive_dirs.json",
    "upscale_presets", "recordings", "last_transcript.json", "window-state.json",
    "screen-staging", "history.db", "Local Storage",
    ".venv", "python-cache", "engine-site", "engine-site.staging", "engine-site.old-1700000000",
    "Cache", "Code Cache", "GPUCache", "Crashpad",
    "main.log", "main.log.archive-2026-01-01", ".migrated-from-onedrive",
  ];
  assert.deepEqual(oneDriveMigrationEntries(old), [
    "config.json", ".encryption_key", "api_token.txt", "known_archive_dirs.json",
    "upscale_presets", "recordings", "last_transcript.json", "window-state.json",
    "screen-staging", "history.db", "Local Storage",
  ]);
  assert.equal(isRegeneratedEntry(""), true);
  assert.match(topLevelFunctionSource("_relocateUserDataOffOneDrive"), /oneDriveMigrationEntries\(/);
});
