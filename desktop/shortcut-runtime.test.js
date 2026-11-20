"use strict";

// S-11 / DM-23 (Ultra-Audit 2026-11-20): the bound accelerators live in
// memory; a Settings update replaces them (an explicit "" unbinds an
// optional slot), a rejected update restores the previous bindings, and a
// later re-registration never re-reads disk.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { applyShortcutUpdate, normalizeShortcutSet } = require("./shortcut-runtime");
const { topLevelFunctionSource, mainSource } = require("./main-source");

const BOUND = { record: "Alt+Left", paste: "Alt+Shift+V", screen: "Alt+Right", screenShot: "Alt+Down" };

test("an update replaces every slot it carries, and an empty optional slot unbinds it", () => {
  const r = applyShortcutUpdate(BOUND, { record: "F8", paste: "F7", screen: "", screenShot: "" });
  assert.deepEqual(r, { ok: true, shortcuts: { record: "F8", paste: "F7", screen: "", screenShot: "" } });
});

test("a slot the update does not carry keeps its current value", () => {
  const r = applyShortcutUpdate(BOUND, { record: "F8", paste: "F7" });
  assert.deepEqual(r.shortcuts, { record: "F8", paste: "F7", screen: "Alt+Right", screenShot: "Alt+Down" });
});

test("record and paste are required", () => {
  assert.deepEqual(applyShortcutUpdate(BOUND, { record: "", paste: "F7" }), { ok: false, reason: "missing record" });
  assert.deepEqual(applyShortcutUpdate(BOUND, { record: "F8" }), { ok: false, reason: "missing paste" });
  assert.deepEqual(normalizeShortcutSet(null), { record: "", paste: "", screen: "", screenShot: "" });
});

// The handlers live inside app.whenReady, so they are read as text.
function nestedFunctionSource(name) {
  const at = mainSource.indexOf(`  function ${name}(`);
  if (at < 0) return "";
  const end = mainSource.indexOf("\n  }\n", at);
  return mainSource.slice(at, end + 4);
}

test("main.js: registrations bind the in-memory set; disk is read only to seed it", () => {
  const register = nestedFunctionSource("registerGlobalShortcuts");
  assert.ok(register, "registerGlobalShortcuts not found");
  assert.match(register, /if \(!activeShortcuts\) activeShortcuts = normalizeShortcutSet\(readShortcutsFromConfig\(\)\)/);
  assert.doesNotMatch(register, /override/, "no second source for the bound accelerators");
  assert.doesNotMatch(register, /screenFromDisk|fromDisk/);
  assert.equal(topLevelFunctionSource("registerGlobalShortcuts"), "", "still nested in whenReady");
});

test("main.js: a rejected update restores the bindings instead of waiting for the failsafe", () => {
  const bridge = nestedFunctionSource("handleShortcutBridgeMessage");
  assert.match(bridge, /applyShortcutUpdate\(activeShortcuts, message\)/);
  assert.match(bridge, /restoreShortcutsAfterCaptureAbort\("update-rejected"\)/);
});
