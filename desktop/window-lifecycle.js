"use strict";

/**
 * Main-window lifecycle — every decision, in one place, with no Electron
 * in sight.
 *
 * Before this module the answer to "why did the window just disappear?"
 * was spread over nine mechanisms that each solved the previous one's
 * symptom: a reveal single-flight promise, an 80 ms reveal-request
 * timer, a 2.5 s "reveal protection" dwell, an "expected hide" dwell, an
 * `app.show()` un-hide dance, a `shouldRevealMainWindowForActivate`
 * heuristic that inspected four window flags, an auto-hide when the
 * recording capsule appeared, an auto-hide when a stop was driven from
 * the main process, and a macOS `close` handler that hid the window
 * instead of closing it. Together they produced the boot signature the
 * user reported: `[main-window] event=show/hide` eight times inside
 * 200 ms.
 *
 * The replacement is a table. Every window transition the app can make
 * is one of three actions, and which one is a pure function of the event
 * and two booleans. The Electron side does what the table says and logs
 * one line per transition — nothing in the app is allowed to show, hide
 * or reorder the main window on its own.
 *
 * The product contract this encodes:
 *
 *   1. The process runs ⇒ the Dock shows the running indicator. Regular
 *      activation policy, always; no accessory mode, no dock hiding.
 *   2. Clicking the app (Dock, Finder, `open -a`, tray) shows, focuses and
 *      maximises the window — zoomed to the display's work area, not into
 *      a macOS full-screen space. Saved bounds are restored only when the
 *      user has actually resized or moved the window; the default is
 *      maximised.
 *   3. The yellow button is a native minimise. The app keeps running:
 *      global hotkeys, recording capsule, backend. A Dock click restores it.
 *   4. Closing the window (red button, Cmd+W) and Cmd+Q both quit — on
 *      every platform. "Closed" means "not running". One exception, the
 *      user's decision of 2026-11-20 (DM-30 / S-14): closing the window
 *      while a recording is running or its transcript is still being
 *      produced or pasted asks first (`decideCloseRequest`) — closing
 *      would otherwise silently throw that work away.
 *   5. Nothing else the APP does moves the window. The recording capsule
 *      in particular is a separate, non-focusable, always-on-top window:
 *      showing, updating or hiding it never hides, focuses or reorders the
 *      main window. What macOS does on a click of it is another matter —
 *      see the limit below (H-03).
 *
 * What rule 5 still rests on, stated so nobody mistakes it for solved:
 * outside screen mode, a click on the capsule is an ordinary click the
 * window server delivers to a window of an inactive app, and macOS answers
 * it with an `activate` the app cannot refuse (measured 2026-11-20: the
 * main window has focus 0.5 s after a capsule click, `type: "panel"` or
 * not). main.js marks such an activate as `capsuleInteraction` by a time
 * window it opens when the capsule reports a click — a clock, not an
 * identity: a genuine Dock click inside that window is taken for the
 * capsule's. In screen mode the capsule's clicks never reach the window
 * server (the native helper turns them into in-process taps), so there the
 * question does not arise.
 */

/** Every event the Electron side is allowed to report. */
const WINDOW_LIFECYCLE_EVENTS = Object.freeze({
  /** `app.whenReady` finished its startup work. */
  startup: "startup",
  /** macOS `app.on("activate")` — Dock click, Finder, `open -a`. */
  appActivate: "app-activate",
  /** A second launch handed its argv to the running instance. */
  secondInstance: "second-instance",
  /** The tray icon or its "Open Transcriptor" item was clicked. */
  trayOpen: "tray-open",
  /** The user pressed the red button or Cmd+W. */
  mainWindowClose: "main-window-close",
  /** The user pressed the yellow button. */
  mainWindowMinimize: "main-window-minimize",
  /** Electron's `window-all-closed`. */
  allWindowsClosed: "all-windows-closed",
  /** The recording capsule became visible. */
  capsuleShown: "capsule-shown",
});

/** Every action the Electron side is allowed to take. */
const WINDOW_LIFECYCLE_ACTIONS = Object.freeze({
  /** Create the window if it is gone, then size, show and focus it. */
  show: "show",
  /** Quit the app: `before-quit` stops the backend child and the capsule. */
  quit: "quit",
  /** Do nothing at all. */
  none: "none",
});

const KNOWN_EVENTS = new Set(Object.values(WINDOW_LIFECYCLE_EVENTS));

/** The events that mean "the user asked for the window". */
const SHOW_EVENTS = new Set([
  WINDOW_LIFECYCLE_EVENTS.startup,
  WINDOW_LIFECYCLE_EVENTS.appActivate,
  WINDOW_LIFECYCLE_EVENTS.secondInstance,
  WINDOW_LIFECYCLE_EVENTS.trayOpen,
]);

/**
 * What to do about the main window.
 *
 * Deliberately platform-blind: Windows and Linux get the same behaviour
 * as macOS, which is the whole of rule 4 ("close = quit") on those
 * platforms too.
 *
 * @param {string} event one of `WINDOW_LIFECYCLE_EVENTS`
 * @param {{quitting?: boolean, capsuleInteraction?: boolean}} [context]
 *   `quitting` — `before-quit` has already run.
 *   `capsuleInteraction` — the activate we are being told about was
 *   produced by a click on the recording capsule, within the capsule's
 *   own suppression window. The capsule is `focusable: false` and shown
 *   with `showInactive()`, but a click on it still reaches the app as an
 *   activate on macOS, and raising the main window behind the capsule
 *   because the user pressed *stop* is exactly the reordering rule 5
 *   forbids.
 * @returns {{action: string, reason: string}}
 */
function decideWindowAction(event, context = {}) {
  if (!KNOWN_EVENTS.has(event)) {
    throw new TypeError(`unknown window lifecycle event: ${JSON.stringify(event)}`);
  }
  const quitting = context.quitting === true;
  const capsuleInteraction = context.capsuleInteraction === true;

  if (quitting) {
    // Shutdown is in progress. Nothing shows a window, and nothing asks
    // for a second quit — `app.quit()` re-entered from `window-all-closed`
    // during teardown is how a shutdown turns into a hang.
    return { action: WINDOW_LIFECYCLE_ACTIONS.none, reason: "already-quitting" };
  }

  if (SHOW_EVENTS.has(event)) {
    if (event === WINDOW_LIFECYCLE_EVENTS.appActivate && capsuleInteraction) {
      return { action: WINDOW_LIFECYCLE_ACTIONS.none, reason: "capsule-interaction" };
    }
    return { action: WINDOW_LIFECYCLE_ACTIONS.show, reason: event };
  }

  if (
    event === WINDOW_LIFECYCLE_EVENTS.mainWindowClose ||
    event === WINDOW_LIFECYCLE_EVENTS.allWindowsClosed
  ) {
    return { action: WINDOW_LIFECYCLE_ACTIONS.quit, reason: "close-is-quit" };
  }

  if (event === WINDOW_LIFECYCLE_EVENTS.mainWindowMinimize) {
    // The OS did the minimise. There is nothing left for the app to do —
    // and in particular no hiding, no dock work and no capsule shuffling.
    return { action: WINDOW_LIFECYCLE_ACTIONS.none, reason: "native-minimise" };
  }

  // capsuleShown — the capsule is a window of its own, not a window manager.
  return { action: WINDOW_LIFECYCLE_ACTIONS.none, reason: "capsule-never-moves-main-window" };
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isRect(value) {
  return (
    !!value &&
    typeof value === "object" &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height) &&
    value.width > 0 &&
    value.height > 0
  );
}

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Read back whatever is on disk in `window-state.json`.
 *
 * Anything malformed — a truncated write, a hand-edit, a file from a
 * future version — degrades to "no saved state", which means the window
 * opens maximised. There is no failure mode here that can leave the user
 * with a window they cannot see.
 *
 * @param {unknown} raw
 * @returns {{userSized: boolean, bounds: {x:number,y:number,width:number,height:number}|null}}
 */
function normalizeStoredWindowState(raw) {
  const empty = { userSized: false, bounds: null };
  if (!raw || typeof raw !== "object") return empty;
  if (raw.userSized !== true) return empty;
  if (!isRect(raw.bounds)) return empty;
  return {
    userSized: true,
    bounds: {
      x: Math.round(raw.bounds.x),
      y: Math.round(raw.bounds.y),
      width: Math.round(raw.bounds.width),
      height: Math.round(raw.bounds.height),
    },
  };
}

/**
 * Where the main window goes.
 *
 * Default is the whole work area — the screen minus menu bar and Dock,
 * which is what "maximised" means on macOS and what the native zoom
 * button does. It is NOT `setFullScreen(true)`: a full-screen space
 * takes the window out of the user's desktop and makes the capsule and
 * the paste target unreachable.
 *
 * Saved bounds win only after the user has moved or resized the window
 * themselves, and are clamped back into the current work area first, so
 * a window saved on a disconnected external display still opens where
 * the user can see it.
 *
 * @param {{workArea: object, savedBounds?: object|null, minWidth?: number, minHeight?: number}} options
 * @returns {{bounds: {x:number,y:number,width:number,height:number}, source: "work-area"|"saved"}}
 */
function decideMainWindowBounds(options = {}) {
  const { workArea, savedBounds = null, minWidth = 0, minHeight = 0 } = options;
  if (!isRect(workArea)) {
    throw new TypeError("decideMainWindowBounds requires a work area rectangle");
  }
  const area = {
    x: Math.round(workArea.x),
    y: Math.round(workArea.y),
    width: Math.round(workArea.width),
    height: Math.round(workArea.height),
  };
  if (!isRect(savedBounds)) {
    return { bounds: { ...area }, source: "work-area" };
  }
  const width = clamp(Math.round(savedBounds.width), Math.min(minWidth, area.width), area.width);
  const height = clamp(Math.round(savedBounds.height), Math.min(minHeight, area.height), area.height);
  const x = clamp(Math.round(savedBounds.x), area.x, area.x + area.width - width);
  const y = clamp(Math.round(savedBounds.y), area.y, area.y + area.height - height);
  return { bounds: { x, y, width, height }, source: "saved" };
}

/** What closing the window does once the app knows what is in flight. */
const CLOSE_REQUEST_ACTIONS = Object.freeze({
  /** Nothing would be lost: close = quit (rule 4). */
  quit: "quit",
  /** Something would be lost: ask, and quit only on the user's yes. */
  confirm: "confirm",
});

/**
 * Rule 4's exception (DM-30 / S-14, user decision 2026-11-20): the red
 * button or Cmd+W while work is in flight asks before quitting.
 *
 * @param {{recording?: boolean, postStopWork?: boolean}} state
 *   `recording` — the renderer is capturing a take (it is the only side
 *   that knows; an unanswered query counts as not recording, so a hung
 *   renderer can never trap the user in a window they cannot close).
 *   `postStopWork` — main still owes a stopped take its transcript or
 *   its paste.
 * @returns {{action: string, reason: string, message?: string, detail?: string}}
 */
function decideCloseRequest(state = {}) {
  if (state.recording === true) {
    return {
      action: CLOSE_REQUEST_ACTIONS.confirm,
      reason: "recording",
      message: "A recording is in progress.",
      detail: "Quitting now stops it without saving a transcript.",
    };
  }
  if (state.postStopWork === true) {
    return {
      action: CLOSE_REQUEST_ACTIONS.confirm,
      reason: "post-stop-work",
      message: "A transcript is still being prepared.",
      detail: "Quitting now may lose it before it is saved or pasted.",
    };
  }
  return { action: CLOSE_REQUEST_ACTIONS.quit, reason: "nothing-in-flight" };
}

/** The confirmation's buttons, in order; "Keep Running" is the default and the cancel. */
const CLOSE_CONFIRM_BUTTONS = Object.freeze(["Keep Running", "Quit"]);
const CLOSE_CONFIRM_QUIT_INDEX = 1;

module.exports = {
  WINDOW_LIFECYCLE_EVENTS,
  WINDOW_LIFECYCLE_ACTIONS,
  CLOSE_REQUEST_ACTIONS,
  CLOSE_CONFIRM_BUTTONS,
  CLOSE_CONFIRM_QUIT_INDEX,
  decideCloseRequest,
  decideWindowAction,
  decideMainWindowBounds,
  normalizeStoredWindowState,
};
