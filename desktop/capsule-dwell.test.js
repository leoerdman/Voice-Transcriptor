"use strict";

// The capsule's terminal dwell, run as main.js runs it.
//
// main.js cannot be required outside Electron, so this suite lifts the
// real functions that own the capsule's end of a take — the stop hand-off,
// the post-stop worker, the dwell timer, the reset and the hide/show — out
// of its source and runs them in a sandbox around a fake capsule window.
// The rest of the app is stubbed at the edges those functions call.
//
// The bug it pins (installed 1.6.24, 2026-11-22 19:11): the dwell reset
// refused to run while ``recordingStartedAt`` was set, and nothing but the
// reset itself cleared it, so after every take stopped by the hotkey the
// capsule stayed on screen on its last status ("висит").

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { topLevelFunctionSource } = require("./main-source");
const { createCapsulePower, capsulePressMetricLine } = require("./capsule-power");
const { RECORDING_STATUS_KIND, recordingStatusIsLive, recordingStatusPresentation } = require("./recording-status");

const LIFTED = [
  "hasActivePostStopWork",
  "cancelTerminalStatusReset",
  "scheduleTerminalStatusReset",
  "hideRecordingStatusCapsule",
  "stopRecordingStateMonitor",
  "beginRecordingStatusSession",
  "endRecordingStatusSession",
  "resetRecordingStatusState",
  "updateRecordingStatusCapsule",
  "revealRecordingStatusCapsule",
  "setRecordingStatus",
  "runPostStopQueue",
];

function fakeCapsuleWindow() {
  const w = {
    visible: false,
    throttled: true,
    shows: 0,
    painted: [],
    isDestroyed: () => false,
    isVisible: () => w.visible,
    showInactive() { w.visible = true; w.shows += 1; },
    hide() { w.visible = false; },
    webContents: {
      setBackgroundThrottling(on) { w.throttled = on; },
      async executeJavaScript(js) { w.painted.push(js); return true; },
    },
  };
  return w;
}

function loadCapsuleLifecycle() {
  const timers = new Map();
  let nextTimer = 1;
  let clock = 1_000_000;
  const capsule = fakeCapsuleWindow();
  const log = [];
  const sandbox = {
    log,
    capsule,
    Date: { now: () => clock },
    setTimeout(fn, ms) { const id = nextTimer++; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return 1; },
    clearInterval() { },
    console,
    Math,
    Number,
    String,
    JSON,
    Object,
    Promise,
    RECORDING_STATUS_KIND,
    recordingStatusIsLive,
    recordingStatusPresentation,
    capsulePressMetricLine,
    capsulePower: createCapsulePower({ log: (l) => log.push(l) }),
    processPostStopTask: null,
  };
  const prelude = `
    const RECORDING_STATUS_TERMINAL_DWELL_MS = 900;
    const AUTO_STOP_OFF = { enabled: false };
    const WINDOW_LIFECYCLE_EVENTS = { capsuleShown: "capsule-shown" };
    const queuedStart = { pending: null };
    let recordingStopInFlight = false;
    let recordingSilenceStartedAt = 0;
    let recordingAutoStopConfigRefreshAt = 0;
    let recordingAutoStopConfigGen = 0;
    let recordingAutoStopConfig = AUTO_STOP_OFF;
    let recordingStartedAt = 0;
    let recordingSeenAudioFrames = false;
    let recordingStateMonitor = null;
    let postStopQueue = [];
    let pendingTranscriptionCount = 0;
    let postStopWorkerRunning = false;
    let shortcutToggleInFlight = false;
    let terminalStatusResetTimer = null;
    let capsuleScreenHold = null;
    let recordingStatusCapsuleUpdateSeq = 0;
    const recordingStatusCapsuleState = { status: "", kind: "", startedAt: 0, elapsedMs: 0, timerRunning: false, level: 0, screen: false, queued: false };
    let recordingStatusCapsulePlacedSize = null;
    let recordingStatusCapsulePressedAt = 0;
    let recordingStatusCapsuleLastLevelSent = -1;
    let recordingStatusCapsuleLastLevelSentAt = 0;
    let recordingStatusCapsuleLastCreateMs = 0;
    const recordingStatusWindow = capsule;
    const recordingStatusWindowReady = true;
    function appendMainLog(line) { log.push(line); }
    function compactLogText(t) { return String(t); }
    function startRecordingStateMonitor() { recordingStateMonitor = 1; }
    async function getRendererAutoStopSilenceConfig() { return AUTO_STOP_OFF; }
    async function setRendererMainStatus() { }
    async function ensureRecordingStatusCapsuleWindow() { return capsule; }
    function capsuleNeedsPlacement() { return false; }
    function watchDisplaysForRecordingStatusCapsule() { }
    function placeRecordingStatusCapsule() { }
    function getRecordingStatusCapsuleWindowSize() { return { width: 110, height: 30 }; }
    function applyWindowLifecycleEvent() { }
    function scheduleQueuedStart() { }
  `;
  const lifted = LIFTED.map((name) => {
    const src = topLevelFunctionSource(name);
    assert.ok(src, `main.js has no top-level function ${name}`);
    return src;
  }).join("\n");
  const exportsSrc = `
    ({
      state: () => ({ recordingStartedAt, pendingTranscriptionCount, status: recordingStatusCapsuleState.status }),
      setPostStop: (fn) => { processPostStopTask = fn; },
      beginRecordingStatusSession,
      endRecordingStatusSession,
      setRecordingStatus,
      queueTake(task) { postStopQueue.push(task); pendingTranscriptionCount += 1; return runPostStopQueue(); },
      setRecordingStartedAt(v) { recordingStartedAt = v; },
    })
  `;
  const api = vm.runInNewContext(`${prelude}\n${lifted}\n${exportsSrc}`, sandbox);
  api.capsule = capsule;
  api.log = log;
  api.advance = async (ms) => {
    clock += ms;
    for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= clock && timers.has(id)) {
        timers.delete(id);
        t.fn();
      }
    }
    await new Promise((r) => setImmediate(r));
  };
  api.setPostStop = (fn) => { sandbox.processPostStopTask = fn; };
  return api;
}

async function hotkeyTake(m, terminalStatus) {
  // Start: the press opened a recording session and the capsule shows it.
  await m.beginRecordingStatusSession();
  assert.ok(m.capsule.visible, "the take's capsule is on screen");
  // Stop: the hand-off ends the session, then the worker finishes the take
  // with a terminal status and hands back the dwell.
  m.endRecordingStatusSession();
  m.setPostStop(async () => {
    await m.setRecordingStatus(terminalStatus, RECORDING_STATUS_KIND.OK);
    return { dwellMs: 900, recording: false };
  });
  await m.queueTake({ recordingId: 1 });
}

test("a terminal status hides the capsule once its dwell ends", async () => {
  const m = loadCapsuleLifecycle();
  await hotkeyTake(m, "No Speech");
  assert.ok(m.capsule.visible, "the terminal status is shown for its dwell");
  await m.advance(899);
  assert.ok(m.capsule.visible, "not hidden before the dwell ends");
  await m.advance(1);
  assert.equal(m.capsule.visible, false, "hidden when the dwell ends");
  assert.equal(m.capsule.throttled, true, "and asleep");
  assert.equal(m.state().status, "");
  assert.ok(m.log.includes("[recording-capsule] hidden"));
});

test("the capsule shows again on the next take after it was hidden", async () => {
  const m = loadCapsuleLifecycle();
  await hotkeyTake(m, "Paste Sent");
  await m.advance(900);
  assert.equal(m.capsule.visible, false);
  await m.beginRecordingStatusSession();
  assert.ok(m.capsule.visible, "the second take's capsule is on screen");
  assert.equal(m.capsule.shows, 2);
  assert.equal(m.capsule.throttled, false, "awake while shown");
  // …and it hides again after that take too.
  m.endRecordingStatusSession();
  m.setPostStop(async () => {
    await m.setRecordingStatus("Paste Sent", RECORDING_STATUS_KIND.OK);
    return { dwellMs: 900, recording: false };
  });
  await m.queueTake({ recordingId: 2 });
  await m.advance(900);
  assert.equal(m.capsule.visible, false);
});

test("a take that starts during the dwell keeps the capsule", async () => {
  const m = loadCapsuleLifecycle();
  await hotkeyTake(m, "Paste Sent");
  // A new take's session opens before the dwell runs out.
  await m.beginRecordingStatusSession();
  await m.advance(900);
  assert.ok(m.capsule.visible, "the live take owns the capsule");
  assert.ok(m.log.some((l) => l === "[recording-capsule] dwell reset skipped: taken over by take"));
});

test("negative control: a session left open at the stop leaves the capsule stuck", async () => {
  // What 1.6.23-1.6.24 did: the stop never closed the session.
  const m = loadCapsuleLifecycle();
  await m.beginRecordingStatusSession();
  m.setPostStop(async () => {
    await m.setRecordingStatus("No Speech", RECORDING_STATUS_KIND.OK);
    return { dwellMs: 900, recording: false };
  });
  await m.queueTake({ recordingId: 1 });
  await m.advance(900);
  assert.ok(m.capsule.visible, "without endRecordingStatusSession the dwell reset is skipped");
});

test("main.js closes the recording session at both stop hand-offs", () => {
  const toggle = topLevelFunctionSource("toggleRecordingFromShortcut");
  assert.match(toggle, /endRecordingStatusSession\(\);\s*enqueuePostStopTask\(/);
  const stop = topLevelFunctionSource("stopRecordingFromMainProcess");
  assert.match(stop, /endRecordingStatusSession\(\);\s*enqueuePostStopTask\(/);
});

test("the capsule window is painted while hidden (paintWhenInitiallyHidden is not turned off)", () => {
  const ensure = topLevelFunctionSource("ensureRecordingStatusCapsuleWindow");
  assert.doesNotMatch(ensure, /paintWhenInitiallyHidden:\s*false/);
});
