"use strict";

// DM-04 (Ultra-Audit 2026-11-20): the PowerShell paste fallback must not
// send Ctrl+V unless the target window was actually brought forward.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { ERR_ACTIVATE, buildPwshPasteFallbackScript } = require("./windows-paste-fallback");
const { topLevelFunctionSource } = require("./main-source");

function assertActivationGatesKeystroke(script) {
  const sendAt = script.indexOf("SendWait(");
  assert.ok(sendAt > 0, "the script sends the keystroke");
  const head = script.slice(0, sendAt);
  assert.match(head, /if \(-not \[W\]::SetForegroundWindow\(\$h\)\) \{ Write-Output "ERR:activate"; exit 2 \}/);
  assert.match(head, /if \(\$h -eq \[IntPtr\]::Zero\) \{ Write-Output "ERR:activate"; exit 2 \}/);
  assert.doesNotMatch(head, /SetForegroundWindow\([^)]*\) \| Out-Null/, "the activation result must not be discarded");
}

test("an hwnd target: the keystroke is sent only after a confirmed activation", () => {
  const script = buildPwshPasteFallbackScript({ hwndHex: "1a2B", pid: 77 });
  assertActivationGatesKeystroke(script);
  assert.match(script, /Parse\('1a2B'/);
  assert.doesNotMatch(script, /Get-Process/);
});

test("a pid target: the keystroke is sent only after a confirmed activation", () => {
  const script = buildPwshPasteFallbackScript({ pid: 4242 });
  assertActivationGatesKeystroke(script);
  assert.match(script, /Get-Process -Id 4242 /);
});

test("no window to activate means no script, and nothing hostile is interpolated", () => {
  assert.equal(buildPwshPasteFallbackScript({}), "");
  assert.equal(buildPwshPasteFallbackScript({ hwndHex: "zz'; rm", pid: -1 }), "");
  assert.equal(buildPwshPasteFallbackScript({ pid: 1.5 }), "");
  assert.equal(ERR_ACTIVATE, "ERR:activate");
});

test("main.js builds the fallback through ./windows-paste-fallback", () => {
  const ladder = topLevelFunctionSource("pasteFromClipboard") || topLevelFunctionSource("runPasteLadder");
  assert.match(ladder, /buildPwshPasteFallbackScript\(/);
  assert.doesNotMatch(ladder, /SetForegroundWindow\(\$h\) \| Out-Null/);
  assert.doesNotMatch(ladder, /SetForegroundWindow\(\$p\.MainWindowHandle\) \| Out-Null/);
});
