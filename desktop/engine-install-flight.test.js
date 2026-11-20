"use strict";

// DM-06 (Ultra-Audit 2026-11-20): the engine install's single-flight flag
// must be claimed before the first await, or two invokes inside the
// 60 s import probe both run a multi-GB pip install into one staging dir.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { topLevelFunctionSource } = require("./main-source");

test("installGigaamEngine claims engineInstall.inFlight before it awaits anything", () => {
  const fn = topLevelFunctionSource("installGigaamEngine").replace(/\/\/.*$/gm, "");
  assert.ok(fn, "installGigaamEngine not found");
  const claimAt = fn.search(/engineInstall\.inFlight = /);
  const firstAwaitAt = fn.search(/\bawait\b/);
  assert.ok(claimAt > 0, "the flag is claimed");
  assert.ok(firstAwaitAt > 0, "the function awaits the run");
  assert.ok(claimAt < firstAwaitAt, "the claim happens on the synchronous turn, before any await");
});

test("the shape: a concurrent invoke during the probe is refused", async () => {
  // The same pattern main.js now uses, exercised: the claim is made
  // before the first await, so a second call on the next turn sees it.
  const state = { inFlight: null, runs: 0 };
  const probe = () => new Promise((r) => setTimeout(r, 20));
  async function body() {
    await probe();
    state.runs += 1;
    return "installed";
  }
  async function install() {
    if (state.inFlight) return "already-running";
    const run = body();
    state.inFlight = run;
    try { return await run; } finally { if (state.inFlight === run) state.inFlight = null; }
  }
  const results = await Promise.all([install(), install()]);
  assert.deepEqual(results, ["installed", "already-running"]);
  assert.equal(state.runs, 1);
  assert.equal(state.inFlight, null);
});
