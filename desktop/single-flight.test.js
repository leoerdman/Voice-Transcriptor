"use strict";

// DM-06 (Ultra-Audit 2026-11-20): the engine install runs at most once at
// a time. The helper is exercised under concurrency here; the last test
// checks that installGigaamEngine runs its install through it.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createSingleFlight } = require("./single-flight");
const { topLevelFunctionSource } = require("./main-source");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("a second call while the first is still probing is refused, and the operation runs once", async () => {
  const flight = createSingleFlight();
  const probe = deferred();
  let starts = 0;
  const start = async () => {
    starts += 1;
    await probe.promise;
    return "installed";
  };
  const first = flight.tryRun(start);
  // The same synchronous turn, and a later turn while the probe runs.
  const sameTurn = flight.tryRun(start);
  await Promise.resolve();
  const laterTurn = flight.tryRun(start);
  assert.equal(sameTurn, null);
  assert.equal(laterTurn, null);
  assert.equal(flight.busy, true);
  probe.resolve();
  assert.equal(await first, "installed");
  assert.equal(starts, 1);
  assert.equal(flight.busy, false);
});

test("many concurrent callers: exactly one runs", async () => {
  const flight = createSingleFlight();
  let starts = 0;
  const start = () => new Promise((r) => setTimeout(() => { starts += 1; r("ok"); }, 5));
  const runs = Array.from({ length: 10 }, () => flight.tryRun(start));
  assert.equal(runs.filter(Boolean).length, 1);
  await Promise.all(runs.filter(Boolean));
  assert.equal(starts, 1);
});

test("the flight is released after the run settles, so the next install can start", async () => {
  const flight = createSingleFlight();
  assert.equal(await flight.tryRun(async () => 1), 1);
  assert.equal(flight.busy, false);
  assert.equal(await flight.tryRun(async () => 2), 2);
});

test("a failing run releases the flight and its error reaches the caller", async () => {
  const flight = createSingleFlight();
  await assert.rejects(flight.tryRun(async () => { throw new Error("pip failed"); }), /pip failed/);
  assert.equal(flight.busy, false);
  await assert.rejects(flight.tryRun(() => { throw new Error("sync throw"); }), /sync throw/);
  assert.equal(flight.busy, false);
});

test("installGigaamEngine runs the install through the single flight (wiring)", () => {
  const fn = topLevelFunctionSource("installGigaamEngine");
  assert.ok(fn, "installGigaamEngine not found");
  assert.match(fn, /engineInstallFlight\.tryRun\(\(\) => runGigaamEngineInstall\(/);
  // No second, hand-rolled flag beside it.
  assert.doesNotMatch(fn, /inFlight/);
});
