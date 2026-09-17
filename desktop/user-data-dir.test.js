"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  USER_DATA_MIGRATION,
  userDataDirName,
  decideUserDataMigration,
  userDataDirCandidates,
} = require("./user-data-dir");

const REPO_ROOT = path.resolve(__dirname, "..");

test("macOS and Windows use the backend's spelling; Linux keeps XDG's", () => {
  assert.equal(userDataDirName("darwin"), "Transcriptor");
  assert.equal(userDataDirName("win32"), "Transcriptor");
  assert.equal(userDataDirName("linux"), "transcriptor");
  assert.equal(userDataDirName("freebsd"), "transcriptor");
});

test("the name matches what backend/data_dir.py spells, per platform", () => {
  // The two runtimes resolve this directory independently — the shell
  // through Electron, the command-line client through
  // ``default_data_dir`` — so a spelling that drifts is a directory the
  // client cannot find on a case-sensitive volume. Read the Python and
  // compare rather than restating it here, which is how the two got out
  // of step in the first place.
  const python = fs.readFileSync(path.join(REPO_ROOT, "backend", "data_dir.py"), "utf8");

  const darwin = python.match(/"Library"\s*\/\s*"Application Support"\s*\/\s*"([^"]+)"/);
  assert.ok(darwin, "backend/data_dir.py no longer spells the macOS directory the expected way");
  assert.equal(userDataDirName("darwin"), darwin[1]);

  const windows = python.match(/return base\s*\/\s*"([^"]+)"/);
  assert.ok(windows, "backend/data_dir.py no longer spells the Windows directory the expected way");
  assert.equal(userDataDirName("win32"), windows[1]);

  const linux = python.match(/"\.local"\s*\/\s*"share"\s*\/\s*"([^"]+)"/);
  assert.ok(linux, "backend/data_dir.py no longer spells the Linux directory the expected way");
  assert.equal(userDataDirName("linux"), linux[1]);
});

test("the shell's own re-homing spells it the same way", () => {
  // The Windows OneDrive re-home builds its target path by hand. It was
  // already capitalised while Electron's name was not, which is one of
  // the two spellings this module exists to collapse.
  const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const rehome = main.match(/const newDir = path\.join\(local, "([^"]+)"\);/);
  assert.ok(rehome, "the OneDrive re-home no longer builds its path the expected way");
  assert.equal(rehome[1], userDataDirName("win32"));
});

test("nothing happens when the name did not change", () => {
  const decision = decideUserDataMigration({
    legacyName: "transcriptor",
    preferredName: "transcriptor",
    legacyExists: true,
    preferredExists: true,
  });
  assert.equal(decision.action, USER_DATA_MIGRATION.NONE);
});

test("nothing happens on a fresh install", () => {
  const decision = decideUserDataMigration({
    legacyName: "transcriptor",
    preferredName: "Transcriptor",
    legacyExists: false,
    preferredExists: false,
  });
  assert.equal(decision.action, USER_DATA_MIGRATION.NONE);
  assert.equal(decision.reason, "nothing-under-the-old-name");
});

test("a case-insensitive volume is left alone — the two names are one directory", () => {
  // The common case on macOS and Windows. Renaming here would be a
  // move of a directory onto itself.
  const decision = decideUserDataMigration({
    legacyName: "transcriptor",
    preferredName: "Transcriptor",
    legacyExists: true,
    preferredExists: true,
    sameDirectory: true,
  });
  assert.equal(decision.action, USER_DATA_MIGRATION.SAME_DIRECTORY);
});

test("a case-sensitive volume carries the old directory over", () => {
  const decision = decideUserDataMigration({
    legacyName: "transcriptor",
    preferredName: "Transcriptor",
    legacyExists: true,
    preferredExists: false,
    sameDirectory: false,
  });
  assert.equal(decision.action, USER_DATA_MIGRATION.ADOPT);
});

test("two distinct directories are never merged", () => {
  // One of them holds the user's config, provider keys and archive, and
  // the other may too. Guessing loses data nothing can reconstruct.
  const decision = decideUserDataMigration({
    legacyName: "transcriptor",
    preferredName: "Transcriptor",
    legacyExists: true,
    preferredExists: true,
    sameDirectory: false,
  });
  assert.equal(decision.action, USER_DATA_MIGRATION.KEEP_BOTH);
});

test("the candidate paths hang off the root Electron gives", () => {
  const { legacyDir, preferredDir } = userDataDirCandidates(
    "/Users/a/Library/Application Support", "transcriptor", "Transcriptor",
  );
  assert.equal(legacyDir, "/Users/a/Library/Application Support/transcriptor");
  assert.equal(preferredDir, "/Users/a/Library/Application Support/Transcriptor");
});

test("main.js applies the spelling before anything reads userData", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const applied = main.indexOf("_useOneSpellingForUserDataDir();");
  const rehomed = main.indexOf("_relocateUserDataOffOneDrive();");
  assert.ok(applied > 0, "the spelling is never applied");
  assert.ok(rehomed > 0, "the OneDrive re-home is never called");
  assert.ok(
    applied < rehomed,
    "the OneDrive re-home reads userData, so the spelling must be settled before it",
  );
  // Nothing may read userData earlier than that, or it caches the old
  // spelling — appendMainLog pins its log path on first use.
  const firstUserDataRead = main.indexOf('app.getPath("userData")');
  assert.ok(
    firstUserDataRead === -1 || firstUserDataRead > applied,
    "something reads userData before the spelling is settled",
  );
});
