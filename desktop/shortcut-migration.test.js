"use strict";

// Executable specification for the retired-hotkey-pair rule.
//
// Before this module the rule was three `if` blocks inside a 9k-line
// Electron file, with no test of any kind, plus a partial copy in the
// renderer that was missing the third case. That is how a Windows user ended
// up with `Control+Alt+Shift+R` registered, `F9` displayed in Settings, and
// `F9`/`F10` written back to disk on every session.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const manifest = require("./shortcut-defaults.json");
const { migrateShortcutPair, migratedLegacyKeys } = require("./shortcut-migration");

const DARWIN = manifest.platformDefaults.darwin;
const OTHER = manifest.platformDefaults.default;
const run = (stored, platform) =>
  migrateShortcutPair(stored, {
    manifest,
    defaults: platform === "darwin" ? DARWIN : OTHER,
    platform,
  });

test("every retired pair the manifest declares has a migration", () => {
  // The data and the rule must not drift: adding a `legacy` entry without a
  // rule leaves it in users' configs forever, which is exactly what happened
  // to winLinuxFunctionPair on the renderer side.
  assert.deepEqual(Object.keys(manifest.legacy).sort(), migratedLegacyKeys(manifest).sort());
});

test("the Windows/Linux F9/F10 pair migrates — the case the renderer never had", () => {
  const out = run({ record: "F9", paste: "F10" }, "win32");
  assert.equal(out.record, OTHER.record);
  assert.equal(out.paste, OTHER.paste);
  assert.deepEqual(out.applied.map((a) => a.id), ["winLinuxFunctionPair"]);
  assert.deepEqual(run({ record: "F9", paste: "F10" }, "linux"), out);
});

test("the same pair on macOS takes the macOS rule and the macOS defaults", () => {
  const out = run({ record: "F9", paste: "F10" }, "darwin");
  assert.equal(out.record, DARWIN.record);
  assert.equal(out.paste, DARWIN.paste);
  assert.deepEqual(out.applied.map((a) => a.id), ["macFunctionPair"]);
});

test("the unpressable paste accelerator is rewritten on every platform, and only the paste slot", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const defaults = platform === "darwin" ? DARWIN : OTHER;
    const out = run({ record: "Control+Shift+Space", paste: manifest.legacy.unpressablePaste }, platform);
    assert.equal(out.record, "Control+Shift+Space", `${platform}: the record slot is the user's own`);
    assert.equal(out.paste, defaults.paste);
    assert.deepEqual(out.applied.map((a) => a.id), ["unpressablePaste"]);
  }
});

test("a pair that is only HALF the retired pair is left alone", () => {
  // The retired pair migrates as a pair. A user who deliberately bound F9 to
  // record and something else to paste has made a choice, and a rule that
  // rewrote half of it would silently undo it.
  const out = run({ record: "F9", paste: "Control+Alt+Shift+P" }, "win32");
  assert.equal(out.record, "F9");
  assert.equal(out.paste, "Control+Alt+Shift+P");
  assert.deepEqual(out.applied, []);
});

test("a user's own accelerators pass through untouched", () => {
  const stored = { record: "Control+Alt+Shift+Q", paste: "Control+Alt+Shift+W" };
  const out = run(stored, "win32");
  assert.equal(out.record, stored.record);
  assert.equal(out.paste, stored.paste);
  assert.deepEqual(out.applied, []);
});

test("the current defaults are a fixed point — migrating them changes nothing", () => {
  for (const [platform, defaults] of [["darwin", DARWIN], ["win32", OTHER], ["linux", OTHER]]) {
    const out = run({ ...defaults }, platform);
    assert.equal(out.record, defaults.record, platform);
    assert.equal(out.paste, defaults.paste, platform);
    assert.deepEqual(out.applied, [], `${platform}: a default must not migrate to itself`);
  }
});

test("migrating twice is migrating once", () => {
  const first = run({ record: "F9", paste: "F10" }, "win32");
  const second = run(first, "win32");
  assert.equal(second.record, first.record);
  assert.equal(second.paste, first.paste);
  assert.deepEqual(second.applied, []);
});

test("the input is not mutated, and whitespace in a stored value is trimmed", () => {
  const stored = { record: "  F9 ", paste: "\tF10\n" };
  const out = run(stored, "win32");
  assert.deepEqual(stored, { record: "  F9 ", paste: "\tF10\n" });
  assert.equal(out.record, OTHER.record);
});

test("main.js reads the rule from the module instead of carrying its own copy", () => {
  // The three `if` blocks are gone. A fourth one appearing here is the drift
  // this module was extracted to prevent.
  const source = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  assert.match(source, /require\("\.\/shortcut-migration"\)/);
  assert.match(source, /migrateShortcutPair\(stored, \{/);
  for (const key of Object.keys(manifest.legacy)) {
    assert.ok(
      !new RegExp(`legacy\\.${key}\\b`).test(source),
      `main.js still reads legacy.${key} directly — the rule has grown a second copy`,
    );
  }
});

test("the old screenshot default Option+Down follows the new default on macOS, and only that slot", () => {
  const darwin = manifest.platformDefaults.darwin;
  const out = migrateShortcutPair(
    { record: "Alt+Left", paste: "Alt+Shift+V", screenShot: "Alt+Down" },
    { manifest, defaults: darwin, platform: "darwin" },
  );
  assert.equal(out.screenShot, "`");
  assert.equal(out.record, "Alt+Left");
  assert.equal(out.paste, "Alt+Shift+V");
  assert.deepEqual(out.applied.map((a) => a.id), ["retiredScreenShot"]);
  assert.equal(out.applied[0].to, "`");
  // A key the user chose themselves is theirs.
  const own = migrateShortcutPair(
    { record: "Alt+Left", paste: "Alt+Shift+V", screenShot: "F6" },
    { manifest, defaults: darwin, platform: "darwin" },
  );
  assert.equal(own.screenShot, "F6");
  assert.equal(own.applied.length, 0);
});
