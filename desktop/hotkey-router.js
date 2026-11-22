"use strict";

// Who holds the app's hotkeys (record, paste-last, screen mode): the
// native tap in the dictation helper, or Electron's globalShortcut
// (OPTIMIZATION.md §3.3, wave 2 item 2.2).
//
// A press caught by the tap reaches main straight from the key-down,
// stamped with the instant the key went down; a globalShortcut press is
// stamped when Electron's callback runs. Never both at once: a chord the
// tap holds is not registered with globalShortcut (one press would toggle
// twice), and a chord is registered with globalShortcut whenever the tap
// cannot be trusted with it —
//   * the key has no native chord (desktop/accelerator.js macHotkeyChord),
//   * no helper (not macOS, an App Store build, a dev run without
//     build-native.sh, the helper died or has not said `ready` yet),
//   * the helper refused (no Accessibility, the tap would not arm) or did
//     not answer, or macOS switched the tap off and it would not come back,
//   * Secure Input is on (a password field, Terminal's Secure Keyboard
//     Entry): no tap sees keys then, while globalShortcut still does.
// The first engagement registers globalShortcut first and lets go once the
// helper confirms, so no key is ever dead while the helper is asked; once
// the tap is trusted, a new table goes straight to it.
//
// Pure of Electron: the helper client, the globalShortcut calls and the
// accelerator → chord translation are injected (hotkey-router.test.js).

/** How long the helper gets to arm (or disarm) the tap. */
const HOTKEYS_REQUEST_TIMEOUT_MS = 1500;
/** A native press stamp further from main's clock than this is not used. */
const PRESS_STAMP_MAX_AGE_MS = 10000;
const PRESS_STAMP_MAX_AHEAD_MS = 1000;

/**
 * The press instant a `hotkey` event carries, or `now` when it is missing
 * or implausible (a clock jump between the two processes).
 */
function pressedAtFromEvent(event, now) {
  const stamp = Number(event?.pressedAt);
  if (!Number.isFinite(stamp)) return now;
  if (stamp > now + PRESS_STAMP_MAX_AHEAD_MS || stamp < now - PRESS_STAMP_MAX_AGE_MS) return now;
  return Math.min(stamp, now);
}

/**
 * @param {object} deps
 * @param {{isAvailable: () => boolean, request: Function}} deps.helper  desktop/dictation-helper.js
 * @param {(accelerator: string, handler: Function) => {ok: boolean, accelerator: string, error: string}} deps.registerGlobal
 * @param {(accelerator: string) => void} deps.unregisterGlobal
 * @param {(accelerator: string) => ({keyCode: number, mods: string[]} | null)} deps.chordFor
 * @param {(accelerator: string) => string} deps.canonicalize
 * @param {string} deps.platform
 * @param {(line: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {(status: object) => void} [deps.onStatusChange]  after a change apply() did not return
 */
function createHotkeyRouter(deps) {
  const log = deps.log || (() => { });
  const now = deps.now || Date.now;
  const onStatusChange = deps.onStatusChange || (() => { });
  const nativeSupported = deps.platform === "darwin";

  /** @type {Array<{action: string, accelerator: string, canonical: string, handler: Function, chord: object|null, held: string, error: string}>} */
  let bindings = [];
  // Bumped by every apply/clear and by a helper exit: an answer to an
  // older table is never acted on.
  let generation = 0;
  // "native": the chords that have one are the tap's; "global": every
  // chord is globalShortcut's.
  let owner = "global";
  let secureInput = false;
  // The helper may hold a non-empty table (disarm it when it must not).
  let helperArmed = false;
  // The last transition logged — one line per change, not per apply.
  let announced = "";

  function announce(state, detail) {
    if (state === announced) return;
    announced = state;
    log(`[hotkeys] ${detail}`);
  }

  function nativeOwns(binding) {
    return !!binding.chord && owner === "native" && !secureInput;
  }

  function holdGlobal(binding) {
    if (binding.held) return;
    const result = deps.registerGlobal(binding.accelerator, () => binding.handler(now()));
    binding.canonical = result.accelerator || binding.canonical;
    binding.held = result.ok ? result.accelerator : "";
    binding.error = result.ok ? "" : String(result.error || "registration failed");
  }

  function releaseGlobal(binding) {
    if (!binding.held) return;
    try { deps.unregisterGlobal(binding.held); } catch { }
    binding.held = "";
  }

  /** Bring globalShortcut in line with who owns what. */
  function sync() {
    for (const binding of bindings) {
      if (nativeOwns(binding)) releaseGlobal(binding);
      else holdGlobal(binding);
    }
  }

  function status() {
    const out = {};
    for (const binding of bindings) {
      const native = nativeOwns(binding);
      const active = native ? binding.canonical : binding.held;
      out[binding.action] = {
        desired: binding.canonical,
        active,
        error: active ? "" : binding.error,
        via: native ? "native" : (binding.held ? "global" : ""),
      };
    }
    return out;
  }

  function changed() {
    sync();
    onStatusChange(status());
  }

  function nativeTable() {
    return bindings
      .filter((b) => b.chord)
      .map((b) => ({ chord: b.action, keyCode: b.chord.keyCode, mods: b.chord.mods.slice() }));
  }

  function disarm() {
    helperArmed = false;
    if (deps.helper.isAvailable()) void deps.helper.request("hotkeys", { chords: [] }, { timeoutMs: HOTKEYS_REQUEST_TIMEOUT_MS });
  }

  function fallBack(reason) {
    owner = "global";
    changed();
    announce(`global:${reason}`, `native tap unavailable (${reason}); hotkeys on globalShortcut`);
  }

  /** Hand the table to the helper; switch on its confirmation. */
  function engage() {
    if (!nativeSupported) return;
    const table = nativeTable();
    if (table.length === 0) {
      if (helperArmed) disarm();
      if (owner === "native") { owner = "global"; changed(); }
      return;
    }
    if (!deps.helper.isAvailable()) {
      if (owner === "native") fallBack("helper-unavailable");
      return;
    }
    const gen = generation;
    deps.helper.request("hotkeys", { chords: table }, { timeoutMs: HOTKEYS_REQUEST_TIMEOUT_MS }).then((answer) => {
      if (gen !== generation) return;
      if (answer && answer.t === "hotkeys" && answer.active) {
        helperArmed = true;
        owner = "native";
        secureInput = !!answer.secureInput;
        changed();
        announce("native", `native tap active: ${table.map((c) => c.chord).join(",")}${secureInput ? " (Secure Input on: globalShortcut meanwhile)" : ""}`);
        return;
      }
      let reason;
      if (!answer) reason = "helper-unavailable";
      else if (answer.t === "lost") {
        // It reached the helper: the tap may arm late. Make sure it does not.
        reason = `no-answer-${answer.reason || "lost"}`;
        disarm();
      } else {
        helperArmed = false;
        reason = String(answer.reason || "refused");
      }
      fallBack(reason);
    });
  }

  return {
    /**
     * Bind exactly `list` ([{action, accelerator, handler(pressedAt)}]),
     * replacing what was bound. Returns the status at once; a later
     * switch to (or away from) the tap is reported through onStatusChange.
     */
    apply(list) {
      generation += 1;
      for (const binding of bindings) releaseGlobal(binding);
      bindings = list.map((entry) => ({
        action: String(entry.action),
        accelerator: String(entry.accelerator || ""),
        canonical: deps.canonicalize(String(entry.accelerator || "")),
        handler: entry.handler,
        chord: nativeSupported ? deps.chordFor(String(entry.accelerator || "")) : null,
        held: "",
        error: "",
      }));
      // A tap already trusted takes the new table directly; anything else
      // starts on globalShortcut and moves once the helper confirms.
      if (!(owner === "native" && deps.helper.isAvailable())) owner = "global";
      sync();
      engage();
      return status();
    },

    /** Let every hotkey go (Settings is capturing a key; quitting). */
    clear() {
      generation += 1;
      for (const binding of bindings) releaseGlobal(binding);
      bindings = [];
      if (helperArmed) disarm();
    },

    status,

    /** An id-less line from the helper. */
    onHelperEvent(event) {
      if (!event || typeof event !== "object") return;
      if (event.t === "hotkey") {
        // The tap swallowed this press, so globalShortcut never saw it:
        // it is dispatched whoever owns the chord right now.
        const binding = bindings.find((b) => b.chord && b.action === event.chord);
        if (binding) binding.handler(pressedAtFromEvent(event, now()));
        return;
      }
      if (event.t === "tap-disabled") {
        if (event.reenabled === false) {
          helperArmed = false;
          fallBack(`tap-disabled-${event.reason || "unknown"}`);
        } else {
          log(`[hotkeys] tap switched off by macOS (${event.reason || "unknown"}) and back on`);
        }
        return;
      }
      if (event.t === "secure-input") {
        const on = !!event.on;
        if (on === secureInput) return;
        secureInput = on;
        if (owner !== "native") return;
        changed();
        log(`[hotkeys] Secure Input ${on ? "on: hotkeys on globalShortcut meanwhile" : "off: native tap again"}`);
      }
    },

    /** The helper said `ready` (first start or a restart). */
    onHelperReady() {
      helperArmed = false;
      if (bindings.length > 0) engage();
    },

    /** The helper died: its tap died with it. */
    onHelperExit() {
      generation += 1;
      helperArmed = false;
      secureInput = false;
      if (owner === "native") fallBack("helper-exited");
    },
  };
}

module.exports = {
  HOTKEYS_REQUEST_TIMEOUT_MS,
  createHotkeyRouter,
  pressedAtFromEvent,
};
