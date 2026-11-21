"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createWindowLiveness, isRecoverableRendererLoss } = require("./window-liveness");
const { createBackendServing } = require("./backend-serving");
const { mainSource, topLevelFunctionSource } = require("./main-source");

function fakeWindow() {
  const webContents = new EventEmitter();
  webContents.destroyed = false;
  webContents.isDestroyed = () => webContents.destroyed;
  const win = { webContents, destroyed: false, isDestroyed: () => win.destroyed };
  return win;
}

function harness({ quitting = false } = {}) {
  const lines = [];
  const state = { quitting };
  const liveness = createWindowLiveness({ log: (l) => lines.push(l), isQuitting: () => state.quitting });
  return { liveness, lines, state };
}

const tick = () => new Promise((r) => setImmediate(r));

test("a killed page is restored, and its owner hears about it first", async () => {
  const { liveness } = harness();
  const win = fakeWindow();
  const calls = [];
  liveness.watch(win, {
    name: "main",
    onGone: (d, { recoverable }) => calls.push(`gone:${d.reason}:${recoverable}`),
    restore: async (w) => { assert.equal(w, win); calls.push("restore"); },
    recreate: async () => calls.push("recreate"),
  });
  win.webContents.emit("render-process-gone", {}, { reason: "killed", exitCode: 15 });
  await tick();
  assert.deepEqual(calls, ["gone:killed:true", "restore"]);
});

test("clean-exit is the page closing with its window: nothing is restored", async () => {
  const { liveness } = harness();
  const win = fakeWindow();
  const calls = [];
  liveness.watch(win, {
    onGone: (_d, { recoverable }) => calls.push(`gone:${recoverable}`),
    restore: async () => calls.push("restore"),
  });
  win.webContents.emit("render-process-gone", {}, { reason: "clean-exit", exitCode: 0 });
  await tick();
  assert.deepEqual(calls, ["gone:false"]);
  assert.equal(isRecoverableRendererLoss("clean-exit"), false);
  for (const r of ["crashed", "killed", "oom", "abnormal-exit", "launch-failed", "integrity-failure"]) {
    assert.equal(isRecoverableRendererLoss(r), true, r);
  }
});

test("nothing is restored while the app quits", async () => {
  const { liveness } = harness({ quitting: true });
  const win = fakeWindow();
  let restored = 0;
  liveness.watch(win, { restore: async () => { restored += 1; } });
  win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  await tick();
  assert.equal(restored, 0);
});

test("a window whose webContents is gone is recreated, not reloaded", async () => {
  const { liveness } = harness();
  const win = fakeWindow();
  const calls = [];
  liveness.watch(win, { restore: async () => calls.push("restore"), recreate: async () => calls.push("recreate") });
  win.webContents.destroyed = true;
  win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  await tick();
  assert.deepEqual(calls, ["recreate"]);
});

test("losses during a running restore coalesce into exactly one more restore", async () => {
  const { liveness } = harness();
  const win = fakeWindow();
  let restores = 0;
  let release;
  liveness.watch(win, {
    restore: () => {
      restores += 1;
      return restores === 1 ? new Promise((r) => { release = r; }) : Promise.resolve();
    },
  });
  win.webContents.emit("render-process-gone", {}, { reason: "killed" });
  win.webContents.emit("render-process-gone", {}, { reason: "killed" });
  win.webContents.emit("render-process-gone", {}, { reason: "killed" });
  await tick();
  assert.equal(restores, 1);
  release();
  await tick();
  await tick();
  assert.equal(restores, 2);
});

test("a failing restore is logged, never an unhandled rejection", async () => {
  const { liveness, lines } = harness();
  const win = fakeWindow();
  liveness.watch(win, { name: "main", restore: async () => { throw new Error("ERR_CONNECTION_REFUSED"); } });
  win.webContents.emit("render-process-gone", {}, { reason: "killed" });
  await tick();
  assert.ok(lines.some((l) => l.includes("window=main recovery failed: ERR_CONNECTION_REFUSED")), lines.join("\n"));
});

test("GPU and utility process losses are logged with what died", () => {
  const { liveness, lines } = harness();
  liveness.onChildProcessGone({ type: "GPU", reason: "killed", exitCode: 15 });
  liveness.onChildProcessGone({ type: "Utility", reason: "crashed", exitCode: 11, serviceName: "audio.mojom.AudioService", name: "Audio Service" });
  assert.match(lines[0], /child-process-gone type=GPU reason=killed exitCode=15/);
  assert.match(lines[1], /type=Utility reason=crashed exitCode=11 service=audio\.mojom\.AudioService name="Audio Service"/);
});

// The 2026-11-21 incident end to end, with main's real restore order: the
// renderer and the backend die together; the page must load only once the
// backend serves again — and must load then.
test("the main page waits for the restarted backend instead of loading against a dead one", async () => {
  const { liveness } = harness();
  const serving = createBackendServing();
  serving.markServing();
  const win = fakeWindow();
  const loads = [];
  liveness.watch(win, {
    name: "main",
    restore: async () => {
      await serving.whenServing();
      loads.push(serving.state());
    },
  });
  serving.markDown(); // backend got the same SIGTERM
  win.webContents.emit("render-process-gone", {}, { reason: "killed", exitCode: 15 });
  await tick();
  assert.deepEqual(loads, [], "no load while the backend is down");
  serving.markServing(); // the backend restart answered /api/health
  await tick();
  assert.deepEqual(loads, ["serving"]);
});

// One owner: main.js answers a lost page only through window-liveness,
// and the main page's restore waits for the backend before it loads.
test("main.js has no render-process-gone listener of its own", () => {
  assert.equal(/on\(\s*["']render-process-gone["']/.test(mainSource), false);
  assert.match(mainSource, /windowLiveness\.watch\(win, \{\s*name: "main"/);
  assert.match(mainSource, /app\.on\("child-process-gone"/);
  const restore = topLevelFunctionSource("restoreMainWindowPage");
  assert.ok(restore, "restoreMainWindowPage exists");
  assert.match(restore, /loadWhenServing\(\{\s*serving: backendServing,/, "loads only through loadWhenServing");
  assert.match(restore, /confirmServing:[\s\S]*waitForBackendHealth\(/, "a failed load is checked against /api/health");
  assert.equal(/setTimeout/.test(restore), false, "no timer in the restore");
});
