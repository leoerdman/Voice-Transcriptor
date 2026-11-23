"use strict";

// DM-29 (Ultra-Audit 2026-11-20): a backend that fails at boot must reach
// the window's own error page (stderr tail, recovery poll), not a bare
// modal with no window — so whenReady must not await the backend before
// it raises the startup event; createWindow owns the boot.
// This remains a source pin, not a behavior test: the ordering lives in
// Electron's app.whenReady/createWindow lifecycle and cannot be executed
// by this Node test without starting the desktop app. Replacing it
// requires extracting startup orchestration from main.js into an
// independently executable module; main.js is out of scope for this lane.

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

// FQ-22(5) / FQ-14: an empty boot status means "boot finished
// successfully" to the renderer, so only the health-OK path sends it;
// every failure records a code and retires the status without signalling
// success, and the error reaches the renderer as { code, raw }. This is
// also a source pin: the producer and consumer are wired through Electron
// IPC in main.js. A behavior replacement requires an injected backend and
// fake BrowserWindow/preload bridge, exercising success and each failure
// through the real startup coordinator; the coordinator is not extracted
// and main.js is out of scope here. boot-error.test.ts behavior-tests the
// renderer's classification, not this producer's IPC ordering.
test("only the success path sends an empty boot status; failures carry a code", () => {
  const empties = mainSource.match(/setBackendBootStatus\(""\)/g) || [];
  assert.equal(empties.length, 1, "exactly one success signal");
  const success = mainSource.indexOf('setBackendBootStatus("")');
  const health = mainSource.lastIndexOf("await waitForBackendHealth(", success);
  assert.ok(health > 0 && success - health < 600, "the success signal follows a healthy /api/health");
  const failures = mainSource.match(/failBackendBoot\(\s*BACKEND_BOOT_ERROR_CODES\.[A-Z_]+/g) || [];
  assert.equal(failures.length, 5, "every boot failure names its code");
  assert.equal((mainSource.match(/^\s*backendBootError = /gm) || []).length, 1, "only failBackendBoot writes the message");
  assert.doesNotMatch(mainSource, /__setBackendBootError\(\$\{JSON\.stringify\(backendBootError\)\}/);
});
