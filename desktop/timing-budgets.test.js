"use strict";

// DM-20 (Ultra-Audit 2026-11-20): timing numbers in main.js are named, and
// the two that must agree do — a reveal during a cold start waits for the
// whole backend cold-start budget, not 15 s of a 60 s wait.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { mainSource, topLevelFunctionSource } = require("./main-source");
const {
  BACKEND_RESTART_MAX_ATTEMPTS,
  backendRestartPlan,
} = require("./backend-exit");

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

test("the restart policy gives up after its cap and backs off by one step per attempt up to the ceiling", () => {
  // Behaviour: ./backend-exit owns the policy; main.js schedules what it says.
  const plans = [];
  for (let attempt = 1; attempt <= BACKEND_RESTART_MAX_ATTEMPTS + 2; attempt += 1) plans.push(backendRestartPlan(attempt));
  assert.deepEqual(plans.map((p) => (p.giveUp ? "give-up" : p.delayMs)), [
    800, 1600, 2400, 3200, 4000, 4800, 5000, 5000, "give-up", "give-up",
  ]);
  const exitHandler = mainSource.slice(mainSource.indexOf("const restartPlan = backendRestartPlan(attempt);"));
  assert.ok(exitHandler.length < mainSource.length, "main.js does not ask backendRestartPlan");
  assert.match(exitHandler, /^\s*if \(restartPlan\.giveUp\) \{/m);
  assert.match(exitHandler, /const delay = restartPlan\.delayMs;/);
});

test("health polling, the pip install and the stop deadline wait for their named budget", () => {
  // Naming is a fact of the source text. Each budget is declared once
  // with its value and is what the call site waits for — so deleting or
  // inlining the call site fails here, not only retyping a literal.
  assert.equal(constValue("BACKEND_HEALTH_RETRY_MS"), "250");
  assert.match(mainSource, /^\s*setTimeout\(tick, BACKEND_HEALTH_RETRY_MS\);/m);
  assert.equal(constValue("ENGINE_PIP_INSTALL_TIMEOUT_MS"), "30 * 60 * 1000");
  assert.match(mainSource, /timeoutMs: ENGINE_PIP_INSTALL_TIMEOUT_MS,/);
  assert.equal(constValue("GUARDED_STOP_DEADLINE_MS"), "12000");
  assert.match(mainSource, /^\s*const deadlineMs = GUARDED_STOP_DEADLINE_MS;/m);
  assert.match(mainSource, /^\s*pointerLockMs: 80,/m);
  assert.match(mainSource, /setTimeout\(\(\) => \{ pointerEmitLocked = false; \}, \$\{t\.pointerLockMs\}\);/);
});
