"use strict";

// A start press during the previous take's finish is queued, not dropped
// (./queued-start), and main.js serves the queue when the take is done.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { QUEUED_START_MAX_WAIT_MS, QUEUED_START_RETRY_MS, createQueuedStart } = require("./queued-start");
const { mainSource, topLevelFunctionSource } = require("./main-source");

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("a press queues; a second press cancels it (the hotkey stays a toggle)", () => {
  const c = clock();
  const queue = createQueuedStart({ now: c.now });
  assert.equal(queue.pending, null);
  const first = queue.press("voice");
  assert.equal(first.action, "queued");
  assert.deepEqual(queue.pending, { mode: "voice", queuedAt: 1_000 });
  c.advance(300);
  const second = queue.press("voice");
  assert.equal(second.action, "cancelled");
  assert.equal(second.entry.queuedAt, 1_000);
  assert.equal(queue.pending, null);
});

test("one slot, and only the two kinds of take", () => {
  const queue = createQueuedStart({ now: () => 0 });
  queue.press("screen");
  assert.equal(queue.pending.mode, "screen");
  queue.clear();
  queue.press("something-else");
  assert.equal(queue.pending.mode, "voice");
});

test("a queued start expires instead of starting a take long after the press", () => {
  const c = clock();
  const queue = createQueuedStart({ now: c.now, maxWaitMs: 500 });
  queue.press();
  c.advance(500);
  assert.equal(queue.expired(), false);
  assert.equal(queue.waitedMs(), 500);
  c.advance(1);
  assert.equal(queue.expired(), true);
  const entry = queue.clear();
  assert.equal(entry.mode, "voice");
  assert.equal(queue.expired(), false);
  assert.equal(queue.waitedMs(), 0);
});

test("the limits are sane: retries are fast, the wait covers the slowest finish", () => {
  assert.ok(QUEUED_START_RETRY_MS > 0 && QUEUED_START_RETRY_MS <= 250);
  assert.ok(QUEUED_START_MAX_WAIT_MS >= 27_000, "envelope 4 s + recovery 20 s + upscale 3 s");
});

test("main.js no longer drops a start press behind post-stop work", () => {
  const toggle = topLevelFunctionSource("toggleRecordingFromShortcut");
  assert.doesNotMatch(toggle, /single-capsule-post-stop-active/);
  assert.match(toggle, /queuedStart\.press\(mode\)/);
  assert.match(toggle, /result\.startBlocked/);
  // A queued run never cancels its own queue entry.
  assert.match(toggle, /if \(!fromQueue\) \{\s*const \{ action, entry \} = queuedStart\.press\(mode\)/);
});

test("the post-stop worker opens the gate when its work is done, not after the dwell", () => {
  const worker = topLevelFunctionSource("runPostStopQueue");
  assert.doesNotMatch(worker, /await sleep\(/, "the terminal dwell must not hold the worker");
  assert.match(worker, /scheduleTerminalStatusReset\(/);
  assert.match(worker, /if \(queuedStart\.pending\) scheduleQueuedStart\(0\)/);
});

test("the dwell's reset never hides a capsule something else took over", () => {
  const schedule = topLevelFunctionSource("scheduleTerminalStatusReset");
  for (const guard of ["hasActivePostStopWork()", "queuedStart.pending", "shortcutToggleInFlight", "recordingStartedAt > 0"]) {
    assert.ok(schedule.includes(guard), `missing guard ${guard}`);
  }
  assert.match(topLevelFunctionSource("enqueuePostStopTask"), /cancelTerminalStatusReset\(\)/);
});

test("the capsule shows a queued start", () => {
  assert.match(topLevelFunctionSource("updateRecordingStatusCapsule"), /queued: !!recordingStatusCapsuleState\.queued/);
  assert.match(mainSource, /pillEl\.classList\.toggle\("queued", !!state\.queued\)/);
  assert.match(mainSource, /#pill\.queued #stateIcon::after/);
});
