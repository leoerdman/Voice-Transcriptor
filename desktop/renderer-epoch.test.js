"use strict";

// DM-32 (Ultra-Audit 2026-11-20): recording ids restart at 1 on every
// renderer page load; the double-paste guards key on (epoch, id) and are
// never cleared, so a reload with pending work cannot dedup-skip the new
// page's recordings.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { recordingKey, createBoundedKeySet } = require("./renderer-epoch");
const { mainSource, topLevelFunctionSource } = require("./main-source");

test("a reload with pending work does not swallow the new page's recording 1", () => {
  const enqueued = createBoundedKeySet(4096);
  let epoch = 1;
  enqueued.add(recordingKey(epoch, 1));
  enqueued.add(recordingKey(epoch, 2)); // still pending when the page reloads
  epoch += 1; // did-start-navigation
  assert.equal(enqueued.has(recordingKey(epoch, 1)), false, "new page, new recording");
  assert.equal(enqueued.has(recordingKey(1, 2)), true, "the old pending recording is still guarded");
});

test("the same recording on the same page is a duplicate", () => {
  const set = createBoundedKeySet(4);
  set.add(recordingKey(3, 7));
  assert.equal(set.has(recordingKey(3, 7)), true);
});

test("the key set forgets only past its cap", () => {
  const set = createBoundedKeySet(2);
  set.add("a"); set.add("b"); set.add("c");
  assert.equal(set.has("a"), false);
  assert.equal(set.has("b"), true);
  assert.equal(set.size(), 2);
});

test("main.js keys both guards by epoch, never clears them, and gives each epoch its own mailbox", () => {
  assert.doesNotMatch(mainSource, /_enqueuedRecordingIds\.clear\(\)|_pastedRecordingIds\.clear\(\)/);
  const enqueue = topLevelFunctionSource("enqueuePostStopTask");
  assert.match(enqueue, /recordingKey\(task\.epoch, task\.recordingId\)/);
  assert.match(enqueue, /epoch: rendererEpoch/);
  assert.match(enqueue, /slot: recordingFinalSlot/);
  const task = topLevelFunctionSource("processPostStopTask");
  assert.match(task, /slot: task\.slot,\s*recordingId: task\.recordingId,/);
  assert.match(topLevelFunctionSource("beginRendererEpoch"), /recordingFinalSlot = createRecordingFinalSlot\(\)/);
  assert.match(mainSource, /beginRendererEpoch\("navigation"\)/);
});
