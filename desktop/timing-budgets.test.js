"use strict";

// DM-20 (Ultra-Audit 2026-11-20): timing numbers in main.js are named, and
// the two that must agree do — a reveal during a cold start waits for the
// whole backend cold-start budget, not 15 s of a 60 s wait.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { mainSource, topLevelFunctionSource } = require("./main-source");

function constValue(name) {
  const m = mainSource.match(new RegExp(`const ${name} = ([^;]+);`));
  assert.ok(m, `${name} is not declared`);
  return m[1];
}

test("the first window load waits for the backend cold start plus the page load", () => {
  assert.equal(constValue("MAIN_WINDOW_INITIAL_LOAD_TIMEOUT_MS"), "BACKEND_COLD_START_HEALTH_TIMEOUT_MS + MAIN_WINDOW_PAGE_LOAD_TIMEOUT_MS");
  assert.match(mainSource, /trackMainWindowInitialLoad\(win, "create-window", MAIN_WINDOW_INITIAL_LOAD_TIMEOUT_MS\)/);
  assert.match(mainSource, /waitForBackendHealth\(`\$\{BASE_URL\}\/api\/health`, BACKEND_COLD_START_HEALTH_TIMEOUT_MS\)/);
  assert.doesNotMatch(topLevelFunctionSource("trackMainWindowInitialLoad"), /settle\("timeout"\), 15000\)/);
});

test("restart policy, health polling, pip and stop deadlines are named, not literals", () => {
  assert.doesNotMatch(mainSource, /attempt > 8\b/);
  assert.doesNotMatch(mainSource, /Math\.min\(800 \* attempt, 5000\)/);
  assert.doesNotMatch(mainSource, /timeoutMs: 1800000/);
  assert.doesNotMatch(mainSource, /const deadlineMs = 12000;/);
  assert.doesNotMatch(mainSource, /setTimeout\(tick, 250\)/);
  assert.doesNotMatch(mainSource, /pointerEmitLocked = false; \}, 80\)/);
});
