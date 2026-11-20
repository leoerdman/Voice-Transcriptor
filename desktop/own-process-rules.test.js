"use strict";

// DM-16 (Ultra-Audit 2026-11-20): one rule for "is this our own app", one
// accessor for the paste-last accelerator, and settle constants named for
// what they settle rather than for one platform.
//
// The own-app rule lives in ./own-process and is driven here; the last
// two tests pin facts of main.js's text (one accessor, constant names).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createOwnProcessRules } = require("./own-process");
const { mainSource, topLevelFunctionSource } = require("./main-source");

const OWN_PID = 4242;
const rules = (name = "Transcriptor") => createOwnProcessRules({ appName: () => name, pid: OWN_PID });

test("the own-app rule is the app's name and its helper, exactly — not a substring", () => {
  const { isOwnAppName } = rules();
  for (const own of ["Transcriptor", "transcriptor", "  TRANSCRIPTOR helper "]) assert.equal(isOwnAppName(own), true, own);
  for (const other of ["Audio Transcriptor Pro", "Transcriptor2", "", null, "Notes"]) assert.equal(isOwnAppName(other), false, String(other));
});

test("the rule follows the app's name, so no product name is retyped", () => {
  const renamed = rules("Dictate");
  assert.equal(renamed.isOwnAppName("Dictate Helper"), true);
  assert.equal(renamed.isOwnAppName("Transcriptor"), false);
  assert.equal(renamed.shouldUsePasteTarget({ pid: 1, name: "Transcriptor" }), true);
  assert.equal(renamed.isBadActivationTarget("Dictate"), true);
  // An app name that is not known yet excludes nothing by name.
  assert.equal(rules("").isOwnAppName(""), false);
});

test("activation refuses our own family, bare Electron and Electron helpers, and nothing else", () => {
  const { isBadActivationTarget } = rules();
  for (const bad of ["", "Transcriptor", "Transcriptor Helper", "Electron", "Slack Helper (Renderer)", "Code Helper (GPU)", "X Helper (Plugin)", "Electron Helper"]) {
    assert.equal(isBadActivationTarget(bad), true, bad);
  }
  for (const good of ["Slack", "Visual Studio Code", "Audio Transcriptor Pro"]) assert.equal(isBadActivationTarget(good), false, good);
});

test("a paste target is neither this process nor our app, and not an unidentified front", () => {
  const { shouldUsePasteTarget } = rules();
  assert.equal(shouldUsePasteTarget({ pid: OWN_PID, name: "Electron" }), false, "this process, whatever its name");
  assert.equal(shouldUsePasteTarget({ pid: 77, name: "Transcriptor" }), false);
  assert.equal(shouldUsePasteTarget({ pid: 0, name: "" }), false);
  assert.equal(shouldUsePasteTarget(null), false);
  assert.equal(shouldUsePasteTarget({ pid: 77, name: "" }), true, "a pid identifies it");
  assert.equal(shouldUsePasteTarget({ pid: 0, name: "Notes" }), true, "a name identifies it");
});

test("main.js takes both target checks from ./own-process and retypes no product name (wiring)", () => {
  assert.match(mainSource, /^const \{ isBadActivationTarget, shouldUsePasteTarget \} = createOwnProcessRules\(\{\n {2}appName: \(\) => app\.getName\(\),\n {2}pid: process\.pid,/m);
  assert.doesNotMatch(mainSource, /^(?:async )?function (?:isOwnAppName|isBadActivationTarget|shouldUsePasteTarget)\(/m, "no second copy");
  assert.doesNotMatch(mainSource, /=== "transcriptor"|=== "transcriptor helper"/, "no retyped product name");
});

test("the paste-last accelerator has one accessor", () => {
  // A one-reader claim about the text: kept textual.
  const reads = mainSource.match(/lastShortcutStatus\?\.paste\?\.active/g) || [];
  assert.equal(reads.length, 1);
  assert.match(topLevelFunctionSource("pasteLastAccelerator"), /lastShortcutStatus\?\.paste\?\.active/);
});

test("activation settle constants are named for what they settle", () => {
  // Naming: kept textual.
  assert.doesNotMatch(mainSource, /\bWIN_ACTIVATION_SETTLE_MS\b|\bX11_ACTIVATION_SETTLE_MS\b/);
  assert.match(topLevelFunctionSource("activateWindowsWindowByHwnd"), /activationSettleMs\("window"\)/);
  assert.match(topLevelFunctionSource("activateAppByName"), /activationSettleMs\("app"\)/);
});
