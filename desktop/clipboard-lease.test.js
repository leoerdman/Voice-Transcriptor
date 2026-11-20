"use strict";

// DM-02 / DM-26 (Ultra-Audit 2026-11-20): the snapshot of the user's
// clipboard must be taken before the transcript is written, and every
// lease on it must be released exactly once — a throw included.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createClipboardLeases } = require("./clipboard-lease");
const { topLevelFunctionSource } = require("./main-source");

function fakeClipboard(initial) {
  let text = initial;
  return {
    read: () => text,
    write: (t) => { text = t; },
  };
}

test("a chain of pastes shares the first snapshot and frees it after the last lease", () => {
  const cb = fakeClipboard("user content A");
  let taken = 0;
  const leases = createClipboardLeases(() => { taken += 1; return cb.read(); });
  const first = leases.acquire();
  cb.write("transcript 1");
  const second = leases.acquire();
  assert.equal(second.snapshot, "user content A", "paste-2 must not capture paste-1's transcript");
  assert.equal(taken, 1);
  first.release();
  assert.equal(leases.depth(), 1);
  second.release();
  assert.equal(leases.depth(), 0);
  cb.write("user content B");
  assert.equal(leases.acquire().snapshot, "user content B", "a new chain takes a fresh snapshot");
});

test("release is idempotent and settle releases only what was not handed off", () => {
  const leases = createClipboardLeases(() => "x");
  const a = leases.acquire();
  a.release();
  a.release();
  a.settle();
  assert.equal(leases.depth(), 0);
  const b = leases.acquire();
  const releaseLater = b.handOff();
  b.settle();
  assert.equal(leases.depth(), 1, "a handed-off lease belongs to the delayed restore");
  releaseLater();
  releaseLater();
  assert.equal(leases.depth(), 0);
});

test("a throw between acquire and an outcome cannot strand the snapshot", async () => {
  const leases = createClipboardLeases(() => "user content");
  const ladder = async () => {
    const lease = leases.acquire();
    try {
      throw new Error("paste script blew up");
    } finally {
      lease.settle();
    }
  };
  await assert.rejects(ladder());
  assert.equal(leases.depth(), 0, "the next paste must take a fresh snapshot");
});

test("main.js: only the paste ladder writes the transcript, after snapshotting, with a finally", () => {
  for (const caller of ["processPostStopTask", "pasteLatestTranscriptFromShortcut"]) {
    const body = topLevelFunctionSource(caller);
    assert.ok(body, `${caller} not found in main.js`);
    assert.doesNotMatch(body, /clipboard\.writeText\(/, `${caller} must not write the clipboard before the ladder snapshots it`);
  }
  const ladder = topLevelFunctionSource("runPasteLadder");
  const acquireAt = ladder.indexOf("clipboardLeases.acquire()");
  const writeAt = ladder.indexOf("clipboard.writeText(");
  assert.ok(acquireAt > 0, "runPasteLadder takes the lease");
  assert.ok(writeAt > acquireAt, "the snapshot is taken before the transcript is written");
  assert.match(ladder, /finally \{[\s\S]*clipboardLease\.settle\(\)/);
});
