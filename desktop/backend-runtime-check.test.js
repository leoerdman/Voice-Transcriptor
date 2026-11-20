"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { IMPORT_CHECK_TIMEOUT_MS, VERDICT, importCheckVerdict, needsCleanRerun } = require("./backend-runtime-check");
const { topLevelFunctionSource } = require("./main-source");

const pass = { ok: true };
const fail = { ok: false };
const slow = { ok: false, timedOut: true };

test("a passing check is the whole answer: no re-run", () => {
  assert.equal(needsCleanRerun(pass), false);
  assert.equal(importCheckVerdict(pass, null), VERDICT.OK);
});

test("a timed-out check blames nobody (2026-11-21: cold first launch blamed a healthy engine site)", () => {
  assert.equal(needsCleanRerun(slow), false);
  assert.equal(importCheckVerdict(slow, null), VERDICT.TOO_SLOW);
  // Even if a warm re-run had passed, a timeout is not evidence against the engine site.
  assert.equal(importCheckVerdict(slow, pass), VERDICT.TOO_SLOW);
});

test("a real failure is attributed by the clean re-run", () => {
  assert.equal(needsCleanRerun(fail), true);
  assert.equal(importCheckVerdict(fail, pass), VERDICT.ENGINE_SITE);
  assert.equal(importCheckVerdict(fail, fail), VERDICT.BUNDLE);
  assert.equal(importCheckVerdict(fail, slow), VERDICT.TOO_SLOW);
  assert.throws(() => importCheckVerdict(fail, null));
});

test("the limit is a hang guard, far above a cold import", () => {
  assert.ok(IMPORT_CHECK_TIMEOUT_MS >= 60000);
});

test("main.js decides through this module and its runCommand marks a timeout", () => {
  const ensure = topLevelFunctionSource("ensureBackendRuntime");
  assert.match(ensure, /importCheckVerdict\(/);
  assert.match(ensure, /needsCleanRerun\(/);
  assert.match(ensure, /IMPORT_CHECK_TIMEOUT_MS/);
  assert.doesNotMatch(ensure, /timeoutMs: 12000/);
  assert.match(topLevelFunctionSource("runCommand"), /timedOut: true/);
});
