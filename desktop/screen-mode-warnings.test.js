"use strict";

// D1 (review of the Ultra-Audit 2026-11-20 lanes): the screen-mode
// controller raised "helper", "capture-failed" and "start-failed" and
// main's copy table had nothing for the first two, so the user was told
// nothing when the drawing helper died or a screenshot failed.
// screen-mode-controller.test.js additionally checks, in every test's
// cleanup, that each warning the controller ACTUALLY raised has copy.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { SCREEN_MODE_WARNING } = require("./screen-mode-controller");
const {
  SCREEN_MODE_WARNING_COPY,
  SCREEN_SHOT_HOTKEY_WARNING,
  screenModeWarningCopy,
} = require("./screen-mode-warnings");
const { mainSource, topLevelFunctionSource } = require("./main-source");

test("every warning kind the controller can raise has a title and a body", () => {
  const kinds = Object.values(SCREEN_MODE_WARNING);
  assert.ok(kinds.length >= 5);
  for (const kind of kinds) {
    const copy = screenModeWarningCopy(kind);
    assert.ok(copy, `no copy for the controller's "${kind}" warning`);
    assert.ok(String(copy.title || "").trim(), `"${kind}" has no title`);
    assert.ok(String(copy.body || "").trim(), `"${kind}" has no body`);
  }
});

test("main's own screenshot-hotkey warning has copy, and nothing else is in the table", () => {
  assert.ok(screenModeWarningCopy(SCREEN_SHOT_HOTKEY_WARNING));
  const expected = new Set([...Object.values(SCREEN_MODE_WARNING), SCREEN_SHOT_HOTKEY_WARNING]);
  assert.deepEqual(new Set(Object.keys(SCREEN_MODE_WARNING_COPY)), expected, "no copy for a kind nobody raises");
});

test("an unknown kind has no copy (and no inherited property passes for one)", () => {
  assert.equal(screenModeWarningCopy("no-such-kind"), null);
  assert.equal(screenModeWarningCopy("toString"), null);
});

test("the kinds are named once: the controller raises constants, main reads the one table", () => {
  const controllerSource = require("node:fs").readFileSync(require.resolve("./screen-mode-controller"), "utf8");
  assert.doesNotMatch(controllerSource, /onWarning\(\s*["'`]/, "a warning raised by a retyped string literal");
  assert.doesNotMatch(mainSource, /SCREEN_MODE_WARNINGS\s*=/, "a second copy table in main.js");
  assert.match(topLevelFunctionSource("notifyScreenModeWarning"), /screenModeWarningCopy\(kind\)/);
});
