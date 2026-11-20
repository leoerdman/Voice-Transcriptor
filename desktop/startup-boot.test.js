"use strict";

// DM-29 (Ultra-Audit 2026-11-20): a backend that fails at boot must reach
// the window's own error page (stderr tail, recovery poll), not a bare
// modal with no window — so whenReady must not await the backend before
// it raises the startup event; createWindow owns the boot.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { mainSource } = require("./main-source");

test("whenReady raises the startup event without awaiting the backend first", () => {
  const at = mainSource.indexOf("await applyWindowLifecycleEvent(WINDOW_LIFECYCLE_EVENTS.startup);");
  assert.ok(at > 0, "the startup event is raised");
  const before = mainSource.slice(Math.max(0, at - 1200), at).replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(before, /await startBackend\(\);/);
});

test("createWindow starts the backend itself and owns the failure page", () => {
  const at = mainSource.indexOf("async function createWindow(");
  const body = mainSource.slice(at, mainSource.indexOf("\nasync function ", at + 10));
  assert.match(body, /if \(!backend\) \{\s*await startBackend\(\);/);
});
