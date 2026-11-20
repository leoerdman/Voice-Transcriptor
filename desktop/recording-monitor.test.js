"use strict";

// DM-14 (Ultra-Audit 2026-11-20), main-side half: the recording-state
// monitor must not queue a new renderer evaluation every tick while the
// previous one is still pending (a wedged renderer would collect an
// unbounded number of them). Its doc must state its real rate.
//
// The monitor's tick runs its probe through ./single-flight; the tick's
// use of it is driven here with the shipped helper, the wiring is read
// from main.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createSingleFlight } = require("./single-flight");
const { mainSource, topLevelFunctionSource } = require("./main-source");

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

test("ticks while a probe is pending start no second probe; the next tick after it settles does", async () => {
  const probeFlight = createSingleFlight();
  const probes = [];
  // The monitor's tick: start a probe unless one is in flight.
  const tick = () => {
    probeFlight.tryRun(() => {
      const d = deferred();
      probes.push(d);
      return d.promise;
    })?.catch(() => { });
  };
  tick();
  tick();
  tick();
  assert.equal(probes.length, 1, "a wedged renderer collects one pending evaluation, not one per tick");
  probes[0].resolve({ vu: 0 });
  await probes[0].promise;
  await new Promise((r) => setImmediate(r));
  tick();
  assert.equal(probes.length, 2);
});

test("a probe that throws synchronously does not wedge the monitor", async () => {
  const probeFlight = createSingleFlight();
  let starts = 0;
  const tick = () => probeFlight.tryRun(() => {
    starts += 1;
    throw new Error("webContents destroyed");
  })?.catch(() => { });
  await tick();
  await tick();
  assert.equal(starts, 2);
});

test("startRecordingStateMonitor's tick probes through one single-flight (wiring)", () => {
  const fn = topLevelFunctionSource("startRecordingStateMonitor");
  assert.match(fn, /const probeFlight = createSingleFlight\(\);/);
  assert.match(fn, /probeFlight\.tryRun\(\(\) => win\.webContents\s*\.executeJavaScript\(/);
  assert.equal((fn.match(/\.executeJavaScript\(/g) || []).length, 1, "every probe goes through the flight");
  assert.doesNotMatch(fn, /\bprobeInFlight\b/, "no hand-written in-flight flag beside the helper");
});

test("no comment calls the ~5.5 Hz monitor a 1 Hz monitor", () => {
  // Absence of a wording, so textual by nature.
  assert.doesNotMatch(mainSource, /1 Hz (recording-state )?monitor/);
});
