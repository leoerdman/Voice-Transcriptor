"use strict";

// DM-09 / DM-27 (Ultra-Audit 2026-11-20): any exit of the live backend
// while the app is not quitting brings it back, whatever the exit code;
// an exit of a replaced child touches neither the handle nor the restart.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { BACKEND_HANDLE, backendHandleOf, decideBackendExit } = require("./backend-exit");
const { topLevelFunctionSource } = require("./main-source");

test("a code-0 exit nobody asked for restarts the backend", () => {
  const d = decideBackendExit({ code: 0, signal: null, isQuitting: false, handle: BACKEND_HANDLE.CURRENT });
  assert.equal(d.restart, true);
  assert.equal(d.forgetHandle, true);
  assert.equal(d.abnormal, false);
});

test("crashes and signals restart; quitting never does", () => {
  for (const [code, signal] of [[1, null], [null, "SIGSEGV"], [null, "SIGTERM"]]) {
    assert.equal(decideBackendExit({ code, signal, isQuitting: false, handle: BACKEND_HANDLE.CURRENT }).restart, true);
    assert.equal(decideBackendExit({ code, signal, isQuitting: true, handle: BACKEND_HANDLE.CURRENT }).restart, false);
  }
});

test("a planned restart (handle released by a kill, app not quitting) restarts with any exit code", () => {
  for (const [code, signal] of [[0, null], [null, "SIGTERM"]]) {
    const d = decideBackendExit({ code, signal, isQuitting: false, handle: BACKEND_HANDLE.RELEASED });
    assert.equal(d.restart, true);
    assert.equal(d.forgetHandle, false);
  }
});

test("a late exit of a replaced child leaves the live handle and spawns nothing", () => {
  const oldChild = {};
  const newChild = {};
  const handle = backendHandleOf(newChild, oldChild);
  assert.equal(handle, BACKEND_HANDLE.SUPERSEDED);
  assert.deepEqual(
    decideBackendExit({ code: 1, signal: null, isQuitting: false, handle }),
    { forgetHandle: false, restart: false, abnormal: true },
  );
  assert.equal(backendHandleOf(oldChild, oldChild), BACKEND_HANDLE.CURRENT);
  assert.equal(backendHandleOf(null, oldChild), BACKEND_HANDLE.RELEASED);
});

test("main.js wires the backend exit through ./backend-exit and closes over its own child", () => {
  const start = topLevelFunctionSource("startBackend");
  assert.match(start, /const child = spawn\(/);
  assert.match(start, /decideBackendExit\(\{ code, signal, isQuitting, handle \}\)/);
  assert.match(start, /if \(backend === child\) backend = null;/);
  assert.doesNotMatch(start, /else if \(Number\(code \|\| 0\) === 0\)/, "a clean exit code must not suppress the restart");
  assert.doesNotMatch(start, /backend\.on\("exit"/);
});
