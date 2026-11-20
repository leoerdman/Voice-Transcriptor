"use strict";

// DM-12 (Ultra-Audit 2026-11-20): code in main.js that nothing calls, or
// that cannot do what it says, is not kept as a second source of truth.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { mainSource, topLevelFunctionSource } = require("./main-source");

test("no dead renderer probes restating the provider catalog", () => {
  for (const name of [
    "getRendererProviderChoice",
    "getRendererLocalModelChoice",
    "normalizeProviderChoice",
    "normalizeLocalModelChoice",
  ]) {
    assert.doesNotMatch(mainSource, new RegExp(`\\b${name}\\b`), `${name} is dead and duplicates the catalog`);
  }
  assert.doesNotMatch(mainSource, /getElementById\('providerSelect'\)/);
});

test("the capsule payload carries only what the capsule reads", () => {
  const update = topLevelFunctionSource("updateRecordingStatusCapsule");
  assert.doesNotMatch(update, /tone: presentation\.tone/);
});

test("no window-closed cleanup guarded by a condition that is always false there", () => {
  assert.doesNotMatch(mainSource, /if \(win && !win\.isDestroyed\(\) && win\.webContents\) \{\s*win\.webContents\.removeAllListeners/);
});
