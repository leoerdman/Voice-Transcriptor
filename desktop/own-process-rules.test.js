"use strict";

// DM-16 (Ultra-Audit 2026-11-20): one rule for "is this our own app", one
// accessor for the paste-last accelerator, and settle constants named for
// what they settle rather than for one platform.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { mainSource, topLevelFunctionSource } = require("./main-source");

test("both target checks use one own-app rule derived from the app name", () => {
  assert.match(topLevelFunctionSource("isOwnAppName"), /app\.getName\(\)/);
  assert.match(topLevelFunctionSource("isBadActivationTarget"), /isOwnAppName\(n\)/);
  assert.match(topLevelFunctionSource("shouldUsePasteTarget"), /isOwnAppName\(name\)/);
  assert.doesNotMatch(mainSource, /=== "transcriptor"|=== "transcriptor helper"/, "no retyped product name");
});

test("the paste-last accelerator has one accessor", () => {
  const reads = mainSource.match(/lastShortcutStatus\?\.paste\?\.active/g) || [];
  assert.equal(reads.length, 1);
  assert.match(topLevelFunctionSource("pasteLastAccelerator"), /lastShortcutStatus\?\.paste\?\.active/);
});

test("activation settle constants are named for what they settle", () => {
  assert.doesNotMatch(mainSource, /\bWIN_ACTIVATION_SETTLE_MS\b|\bX11_ACTIVATION_SETTLE_MS\b/);
  assert.match(topLevelFunctionSource("activateWindowsWindowByHwnd"), /activationSettleMs\("window"\)/);
  assert.match(topLevelFunctionSource("activateAppByName"), /activationSettleMs\("app"\)/);
});
