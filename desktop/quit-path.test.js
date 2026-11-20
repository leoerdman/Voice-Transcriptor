"use strict";

// DM-19 (Ultra-Audit 2026-11-20): quitApp documents itself as the one
// call site that starts a shutdown; the tray's Quit and the signal
// handlers called app.quit() directly, invisible to the log and to the
// lifecycle bookkeeping.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { mainSource, topLevelFunctionSource } = require("./main-source");

test("app.quit() is called only inside quitApp", () => {
  const calls = mainSource.match(/\bapp\.quit\(\)/g) || [];
  const inQuitApp = topLevelFunctionSource("quitApp").match(/\bapp\.quit\(\)/g) || [];
  // One real call; any other occurrence must be inside a comment.
  const uncommented = mainSource
    .split("\n")
    .filter((line) => /\bapp\.quit\(\)/.test(line) && !/^\s*(\/\/|\*)/.test(line));
  assert.equal(inQuitApp.length, 1);
  assert.equal(uncommented.length, 1, `app.quit() outside quitApp: ${uncommented.join(" | ")}`);
  assert.ok(calls.length >= 1);
});

test("the tray and the signal handlers quit through quitApp", () => {
  assert.match(mainSource, /click: \(\) => quitApp\("tray-quit"\)/);
  assert.match(mainSource, /quitApp\(`signal-\$\{sig\}`\)/);
});
