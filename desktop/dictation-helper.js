"use strict";

// The shell's side of the persistent native helper
// (desktop/native/dictation-helper/, OPTIMIZATION.md wave 2).
//
// One process for the whole app session, started at boot and restarted
// with a backoff if it dies. Requests carry an id that the answer repeats
// (JSON, one object per line — the protocol is documented at the top of
// native/dictation-helper/main.swift); lines without an id are events
// (`hotkey`, `tap-disabled`) and go to `onEvent`.
//
// Every request is bounded. A request that never reached the helper (not
// ready, the write failed) resolves to null: "no helper", take the
// fallback (AppleScript / lsappinfo / globalShortcut). A request that
// reached it and got no answer — late, or the helper died — resolves to
// LOST ({t: "lost"}): it may have run, so a caller whose request has a
// side effect (a paste) must not simply do it again another way. A helper that never
// starts — not macOS, an App Store build that does not ship it, a dev run
// without `build-native.sh` — is simply never ready.
//
// Pure of Electron: spawn, the clock and the log are injected
// (desktop/dictation-helper.test.js drives a fake child).

/** How long a fresh process gets to say `ready`. */
const READY_TIMEOUT_MS = 3000;
/** Default bound for a request; a paste passes its own. */
const REQUEST_TIMEOUT_MS = 1500;
/** Restart delays after an unexpected exit; the last one repeats. */
const RESTART_DELAYS_MS = Object.freeze([500, 2000, 10000, 60000]);
/** The answer's `t` for a request that reached the helper and got none. */
const LOST = "lost";

/**
 * @param {object} deps
 * @param {Function} deps.spawn          child_process.spawn
 * @param {() => string} deps.helperPath where the binary is
 * @param {(p: string) => boolean} deps.exists
 * @param {string} deps.platform
 * @param {(line: string) => void} [deps.log]
 * @param {(event: object) => void} [deps.onEvent]   id-less lines
 * @param {(ready: object) => void} [deps.onReady]
 * @param {(info: object) => void} [deps.onExit]     an unexpected exit
 * @param {Function} [deps.setTimer]  setTimeout
 * @param {Function} [deps.clearTimer] clearTimeout
 */
function createDictationHelper(deps) {
  const log = deps.log || (() => { });
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  let child = null;
  let ready = null;
  let buffer = "";
  let nextId = 1;
  let stopped = false;
  let restarts = 0;
  let restartTimer = null;
  let readyTimer = null;
  const pending = new Map();

  function unref(timer) {
    if (timer && typeof timer.unref === "function") timer.unref();
    return timer;
  }

  function settleAll() {
    for (const [, entry] of pending) {
      clearTimer(entry.timer);
      entry.resolve({ t: LOST, reason: "exit" });
    }
    pending.clear();
  }

  function onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "ready") {
      ready = msg;
      restarts = 0;
      if (readyTimer) { clearTimer(readyTimer); readyTimer = null; }
      log(`[dictation-helper] ready pid=${msg.pid} accessibility=${msg.accessibility ? 1 : 0} postEvents=${msg.postEvents ? 1 : 0}`);
      if (deps.onReady) deps.onReady(msg);
      return;
    }
    if (Number.isInteger(msg.id) && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimer(entry.timer);
      entry.resolve(msg);
      return;
    }
    if (!Number.isInteger(msg.id) && deps.onEvent) deps.onEvent(msg);
  }

  function scheduleRestart() {
    if (stopped || restartTimer) return;
    const delay = RESTART_DELAYS_MS[Math.min(restarts, RESTART_DELAYS_MS.length - 1)];
    restarts += 1;
    restartTimer = unref(setTimer(() => {
      restartTimer = null;
      start();
    }, delay));
  }

  function start() {
    if (stopped || child) return isAvailable();
    if (deps.platform !== "darwin") return false;
    const bin = deps.helperPath();
    if (!bin || !deps.exists(bin)) {
      log(`[dictation-helper] not started: no helper at ${bin || "(none)"}`);
      return false;
    }
    let proc;
    try {
      proc = deps.spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      log(`[dictation-helper] spawn failed: ${e?.message || e}`);
      scheduleRestart();
      return false;
    }
    child = proc;
    ready = null;
    buffer = "";
    readyTimer = unref(setTimer(() => {
      readyTimer = null;
      if (child === proc && !ready) {
        log(`[dictation-helper] no ready within ${READY_TIMEOUT_MS} ms; killing`);
        try { proc.kill("SIGKILL"); } catch { }
      }
    }, READY_TIMEOUT_MS));
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      if (child !== proc) return;
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) onLine(line);
      }
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (d) => log(`[dictation-helper] stderr: ${String(d).trim()}`));
    // A write to a pipe the helper already closed must not crash main.
    proc.stdin.on("error", () => { });
    const gone = (why) => {
      if (child !== proc) return;
      child = null;
      const wasReady = !!ready;
      ready = null;
      if (readyTimer) { clearTimer(readyTimer); readyTimer = null; }
      settleAll();
      if (stopped) return;
      log(`[dictation-helper] exited ${why}; restarting`);
      if (deps.onExit) deps.onExit({ why, wasReady });
      scheduleRestart();
    };
    proc.on("error", (e) => gone(`error=${e?.message || e}`));
    proc.on("exit", (code, signal) => gone(`code=${code} signal=${signal || ""}`));
    return true;
  }

  function write(obj) {
    if (!child || !ready) return false;
    try {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * One request; resolves to its answer, to null when it never reached
   * the helper, or to {t: LOST} when it did and no answer came.
   */
  function request(cmd, fields = {}, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    if (!child || !ready) return Promise.resolve(null);
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = unref(setTimer(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        log(`[dictation-helper] ${cmd} id=${id} timed out after ${timeoutMs} ms`);
        resolve({ t: LOST, reason: "timeout" });
      }, timeoutMs));
      pending.set(id, { resolve, timer });
      if (!write({ ...fields, cmd, id })) {
        pending.delete(id);
        clearTimer(timer);
        resolve(null);
      }
    });
  }

  function isAvailable() {
    return !!(child && ready);
  }

  function stop() {
    stopped = true;
    if (restartTimer) { clearTimer(restartTimer); restartTimer = null; }
    const proc = child;
    if (!proc) return;
    try { proc.stdin.write(`${JSON.stringify({ cmd: "quit" })}\n`); } catch { }
    try { proc.stdin.end(); } catch { }
    child = null;
    ready = null;
    settleAll();
  }

  return {
    start,
    stop,
    request,
    isAvailable,
    /** The `ready` line's permission bits, refreshed by `permissions`. */
    permissions: () => (ready ? { accessibility: !!ready.accessibility, postEvents: !!ready.postEvents } : null),
    notePermissions(answer) {
      if (ready && answer) {
        ready = { ...ready, accessibility: !!answer.accessibility, postEvents: !!answer.postEvents };
      }
    },
  };
}

// ── The native paste, as the shell asks for it and reads its answer ────
//
// Timings are Hex's (src/keyboard.rs, src/paste.rs): 15 ms between the
// four events of ⌘V, then 100 ms for the target to take the pasteboard
// before anything else touches it.
const NATIVE_PASTE = Object.freeze({
  gapMs: 15,
  settleMs: 100,
  pollMs: 10,
  /** On top of the modifier deadline: settle, the AX reads, the pipe. */
  answerSlackMs: 2500,
});

/**
 * The `paste` request for one transcript. `modifierPlan` is
 * paste-capability's planModifierRelease: only the paste-last hotkey, which
 * fires with its chord still held, waits for the keys to come up.
 */
function nativePasteRequest({ text, pid = 0, verify = false, modifierPlan = null } = {}) {
  const waitForRelease = !!(modifierPlan && modifierPlan.needed && modifierPlan.canPoll);
  const releaseDeadlineMs = waitForRelease ? Math.max(0, Number(modifierPlan.deadlineMs) || 0) : 0;
  return {
    fields: {
      text: String(text || ""),
      pid: Number.isInteger(pid) && pid > 0 ? pid : 0,
      verify: !!verify,
      releaseDeadlineMs,
      pollMs: NATIVE_PASTE.pollMs,
      settleMs: NATIVE_PASTE.settleMs,
      gapMs: NATIVE_PASTE.gapMs,
    },
    timeoutMs: releaseDeadlineMs + NATIVE_PASTE.answerSlackMs,
  };
}

/** The helper's verification verdict, as the verification policy counts it. */
const VERIFICATION_TO_POLICY = Object.freeze({
  verified: "verified",
  unreadable: "unreadable",
  unverified: "inconclusive",
});

/**
 * What one `paste` answer means for the ladder:
 *   * success  — ⌘V is out; the clipboard restore is scheduled by count.
 *   * fallback — nothing was posted (and the helper put the user's
 *                clipboard back if it had written): the AppleScript
 *                ladder runs as if the helper did not exist.
 *   * lost     — the request reached the helper and no answer came: ⌘V
 *                may be out, so pasting again another way could paste
 *                twice. The transcript stays on the clipboard.
 *
 * A lost answer's reason deliberately avoids the words paste-capability's
 * classifier reads as a silent AppleScript failure ("timeout"): a slow
 * helper says nothing about the Accessibility grant the ladder needs.
 */
function interpretNativePaste(answer) {
  if (answer === null || answer === undefined) return { kind: "fallback", reason: "helper-unavailable" };
  if (answer.t === LOST) {
    return { kind: "lost", reason: answer.reason === "exit" ? "native-paste-helper-exited" : "native-paste-unanswered" };
  }
  if (answer.ok && answer.sent) {
    const verification = String(answer.verification || "skipped");
    return {
      kind: "success",
      reason: "OK:native-paste",
      verified: verification === "verified",
      verification,
      policyOutcome: VERIFICATION_TO_POLICY[verification] || null,
      changeCount: Number.isInteger(answer.changeCount) ? answer.changeCount : null,
    };
  }
  return { kind: "fallback", reason: `native-${answer.reason || "failed"}`, reverted: !!answer.reverted };
}

module.exports = {
  LOST,
  NATIVE_PASTE,
  interpretNativePaste,
  nativePasteRequest,
  READY_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  RESTART_DELAYS_MS,
  createDictationHelper,
};
