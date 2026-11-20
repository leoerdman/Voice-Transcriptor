"use strict";

// DM-19 (Ultra-Audit 2026-11-20): quitApp is the one call site that starts
// a shutdown; the tray's Quit and the signal handlers called app.quit()
// directly, invisible to the log and to the lifecycle bookkeeping.
//
// ./quit-path is driven with fakes here. What only main.js's text can show
// — that it calls app.quit() nowhere itself and that it installs these
// handlers — is the last test.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  SIGNAL_EXIT_CODES,
  SIGNAL_QUIT_GRACE_MS,
  SIGNAL_BACKEND_ESCALATE_AFTER_MS,
  createQuitApp,
  installSignalQuitHandlers,
} = require("./quit-path");
const { mainSource } = require("./main-source");

const normalizeReason = (r) => String(r || "unknown").trim() || "unknown";

test("quitApp logs the reason, then asks Electron to quit — once per call", () => {
  const events = [];
  const quitApp = createQuitApp({
    app: { quit: () => events.push("app.quit") },
    log: (line) => events.push(line),
    normalizeReason,
  });
  quitApp("tray-quit");
  quitApp("");
  assert.deepEqual(events, [
    "[main-window] quit requested reason=tray-quit",
    "app.quit",
    "[main-window] quit requested reason=unknown",
    "app.quit",
  ]);
});

function signalRig({ quitThrows = false } = {}) {
  const proc = new EventEmitter();
  const events = [];
  const timers = [];
  installSignalQuitHandlers({
    proc,
    log: (line) => events.push(["log", line]),
    markQuitting: () => events.push(["markQuitting"]),
    killBackend: (reason, opts) => events.push(["killBackend", reason, opts]),
    quitApp: (reason) => {
      events.push(["quitApp", reason]);
      if (quitThrows) throw new Error("app gone");
    },
    exit: (code) => events.push(["exit", code]),
    setTimer: (fn, ms) => {
      const timer = { fn, ms, unrefed: false, unref() { this.unrefed = true; } };
      timers.push(timer);
      return timer;
    },
  });
  return { proc, events, timers };
}

test("each signal marks the app quitting, kills the backend, and quits through quitApp", () => {
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const { proc, events, timers } = signalRig();
    proc.emit(sig);
    assert.deepEqual(events, [
      ["log", `[signal] ${sig}`],
      ["markQuitting"],
      ["killBackend", `signal-${sig}`, { escalateAfterMs: SIGNAL_BACKEND_ESCALATE_AFTER_MS }],
      ["quitApp", `signal-${sig}`],
    ]);
    // The forced exit is armed, does not keep the loop alive, and fires
    // with the signal's status only if the normal shutdown has not ended
    // the process by then.
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, SIGNAL_QUIT_GRACE_MS);
    assert.equal(timers[0].unrefed, true);
    timers[0].fn();
    assert.deepEqual(events.at(-1), ["exit", SIGNAL_EXIT_CODES[sig]]);
  }
});

test("a quitApp that throws exits at once with the signal's status", () => {
  const { proc, events } = signalRig({ quitThrows: true });
  proc.emit("SIGTERM");
  assert.deepEqual(events.slice(-2), [["quitApp", "signal-SIGTERM"], ["exit", 143]]);
});

test("the escalation lands before the forced exit, and the statuses are 128 + signal number", () => {
  assert.ok(SIGNAL_BACKEND_ESCALATE_AFTER_MS < SIGNAL_QUIT_GRACE_MS);
  assert.deepEqual({ ...SIGNAL_EXIT_CODES }, { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 });
});

// ── Wiring (textual) ─────────────────────────────────────────────────────

test("main.js calls app.quit() nowhere itself, quits through quitApp, and installs the signal handlers", () => {
  // Absence: a line that is not a comment and calls app.quit(). (A real
  // call after code on the same line still counts.)
  const direct = mainSource
    .split("\n")
    .filter((line) => /\bapp\.quit\s*\(/.test(line) && !/^\s*(\/\/|\*)/.test(line));
  assert.deepEqual(direct, [], `app.quit() outside ./quit-path: ${direct.join(" | ")}`);
  assert.match(mainSource, /^const quitApp = createQuitApp\(\{ app, log: appendMainLog,/m);
  assert.match(mainSource, /^installSignalQuitHandlers\(\{\n {2}proc: process,[\s\S]*?\n {2}quitApp,\n/m);
  assert.doesNotMatch(mainSource, /\bprocess\.on\("SIG/, "no second signal handler");
  assert.match(mainSource, /^\s*click: \(\) => quitApp\("tray-quit"\)/m);
});
