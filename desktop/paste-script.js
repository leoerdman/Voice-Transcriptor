"use strict";

// The AppleScript the macOS paste path runs, as a pure function of the
// target and of ONE decision: do we verify this paste, or not?
//
// ── Why this is a module and not a template literal in main.js ────────
//
// It used to be an inline template inside tryPasteToFocusedField, which
// meant the only guard on it was desktop/applescript.test.js scanning
// main.js for template literals and compiling them with `${...}`
// replaced by the literal 0. That guard cannot see the script this
// module actually emits, and the script now has TWO shapes — with and
// without the accessibility verification reads. A pure builder can be
// required from a test, so desktop/paste-script.test.js compiles both
// real shapes with osacompile and asserts, textually, that the
// non-verifying shape contains no accessibility read at all.
//
// ── The verification reads and their bound (BUGS_AUDIT §6.6, A3) ──────
//
// Verification means: read the length of the focused element text
// before the paste, read it again after, and call the paste "verified"
// when it grew by exactly the pasted length. Some targets never expose
// an inspectable value — measured against the Claude desktop app on
// macOS 27, AXValue and AXNumberOfCharacters of its focused element
// both fail immediately with -1728 — so for those apps every paste is
// reported ":unverified" and the reads are pure cost.
// desktop/paste-verification-policy.js is the memory that stops paying
// that cost; this module is what it switches off.
//
// The read bound was also, until now, fiction. `with timeout of N
// second` bounds an Apple Event sent BY the enclosing statement, and the
// old code placed it INSIDE `tell application "System Events"`, where it
// bounds nothing. Measured on macOS 27 against the Finder process, whose
// AXFocusedUIElement read is the pathological case the timeout was
// written for:
//
//   no timeout                                    -> still blocked at 20 s (killed)
//   `with timeout` INSIDE the tell block (old)    -> still blocked at 12 s (killed)
//   `with timeout of 0.25 second` AROUND the tell -> error -1712 after 286 ms
//   `with timeout of 2 seconds`   AROUND the tell -> error -1712 after 2044 ms
//   `with timeout of 0 seconds`   AROUND the tell -> no bound at all (killed at 10 s)
//
// So the timeout statement must wrap the `tell`, fractional values are
// honoured (0.25 s really is 0.25 s — it is NOT coerced to an integer),
// and 0 means "wait forever". Every read below is written that way.

/**
 * AppleScript string literals terminate at CR/LF. A bare newline in a
 * target app name would break out of the quoted string and inject
 * arbitrary AppleScript. Strip all control characters AND escape
 * backslashes + quotes. Backslash must be replaced FIRST so the
 * subsequent double-quote replacement does not double-escape its own
 * slash.
 *
 * Lives here, with the scripts, so every AppleScript main.js builds
 * escapes its interpolations through one function.
 */
function escapeAppleScriptString(s) {
  return String(s || "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

/**
 * Per-Apple-Event bound for one accessibility read, in seconds. Three
 * reads make up one axFocusedValueLength call (focused element, then
 * AXValue, then AXNumberOfCharacters), so a call against a wedged app
 * costs at most 0.75 s — and the "after" read is skipped entirely when
 * the "before" read already failed, because the comparison needs both.
 */
const AX_READ_TIMEOUT_SEC = 0.25;

/**
 * How the "after" read waits for an asynchronously delivered paste.
 *
 * `key code` and `click` post an event and return; the target applies it
 * on its own run loop. Reading the length on the very next line measured
 * the element BEFORE the paste, so every paste came back ":unverified".
 *
 * Measured against a scratch TextEdit document (8 trials, corrected
 * counting): the change was visible after ONE 50 ms poll every time. So
 * the common case pays 50 ms — less than the fixed 160 ms sleep that
 * used to sit here — and a slower target gets up to 4 tries, at most
 * 4 x (50 ms + one bounded AXValue read), which is what
 * PASTE_BUDGET.verificationAllowanceMs is sized for.
 */
// Menu-paste fallback settle delays. Unlike the primary script's polls,
// these are fixed: this path forces another application to the front and
// then drives ITS menu bar, and neither step publishes anything to observe.
// The values are the ones the fallback has always used.
const MENU_FALLBACK_FRONTMOST_SETTLE_SEC = 0.32;
const MENU_FALLBACK_CLICK_SETTLE_SEC = 0.16;

const AX_VERIFY_POLLS = 4;
const AX_VERIFY_POLL_INTERVAL_SEC = 0.05;

// The markers this script PRINTS and the parsers READ are one fact, and
// they live in ./paste-protocol. They used to be typed here and again in
// paste-result.js's regex, paste-verification-policy.js's line matcher
// and main.js's stream filter, with nothing resolving the copies:
// renaming one here left every test green while the production parse
// went blind — and going blind on the receipt means the ladder retries a
// paste that already landed.
//
// The progress markers are written with `log`, which osascript flushes
// to stderr line by line as they happen (verified against a live
// osascript: a marker logged before a 1 s delay arrives ~1 s before the
// result on stdout). The parent times their arrival, so the cost of the
// AX reads is measured without spending anything inside the script to
// measure it — AppleScript has no sub-second clock that does not cost a
// `do shell script`.
const { AX_TRACE_PREFIX, PASTE_SENT_PREFIX } = require("./paste-protocol");

/** Sanitize a numeric interpolation before it reaches AppleScript. */
function safeInt(value, max = 2 ** 31) {
  const n = Number.parseInt(String(value ?? 0), 10) || 0;
  return Number.isFinite(n) && n >= 0 && n < max ? Math.trunc(n) : 0;
}

/**
 * The QWERTY position of V (kVK_ANSI_V), and the LAST resort of the
 * paste: the code AppleScript presses when nothing could read the
 * keyboard layout. It mirrors `qwertyVKeyCode` in
 * native/dictation-helper/KeyLayout.swift — the one place the layout's
 * ⌘ table is read — which falls back to the same position when a layout
 * gives no "v". A virtual key code names a position, not a letter:
 * code 9 is V on QWERTY and K on Dvorak, so this is only correct when
 * the layout question could not be asked at all. The test keeps the two
 * copies of the number equal.
 */
const QWERTY_V_KEY_CODE = 9;

/** The 0…127 range of real key positions (KeyLayout.swift's loop bound). */
function safeKeyCode(value) {
  return Number.isInteger(value) && value >= 0 && value < 128 ? value : QWERTY_V_KEY_CODE;
}

/**
 * What the helper's `paste-key` answer means: the key the current
 * layout's ⌘ table calls V, or the QWERTY last resort when there was no
 * answer (helper absent, crashed, or too slow). `source` is logged, so a
 * wrong-key report is traceable to the fallback rather than guessed at.
 */
function pasteKeyFromAnswer(answer) {
  const code = answer && answer.t === "paste-key" ? answer.code : null;
  if (Number.isInteger(code) && code >= 0 && code < 128) {
    return { code, layout: String(answer.layout || ""), source: "helper" };
  }
  return { code: QWERTY_V_KEY_CODE, layout: "", source: "fallback" };
}

/**
 * Build the primary macOS paste script.
 *
 * @param {object}  target
 * @param {string}  target.appName      raw app name (escaped here)
 * @param {string}  target.windowTitle  raw window title (escaped here)
 * @param {number}  target.pid          unix pid of the target process
 * @param {number}  target.pastedTextLen  length of the text on the clipboard
 * @param {number}  target.vKeyCode     the key the layout's ⌘ table calls
 *                                      V (the helper's paste-key answer;
 *                                      QWERTY's 9 when nothing answered)
 * @param {boolean} target.verify       attempt AX verification at all
 * @returns {string} AppleScript source for `osascript -e`
 *
 * Returns, on stdout:
 *   OK:menu-paste-primary[+activated][:verified|:unverified|:unreadable]
 *   OK:robust-paste[+activated][:verified|:unverified|:unreadable]
 *   ERR:no-accessibility | ERR:no-process | ERR:no-focus
 * The `:verified`/`:unverified` suffix is present ONLY when verify is
 * true; with verify false the result is the plain form, which
 * desktop/paste-result.js already reads as an unverified success.
 */
function robustPasteScript({
  appName = "",
  windowTitle = "",
  pid = 0,
  pastedTextLen = 0,
  vKeyCode = QWERTY_V_KEY_CODE,
  verify = false,
} = {}) {
  const escapedApp = escapeAppleScriptString(appName);
  const escapedWindowTitle = escapeAppleScriptString(windowTitle);
  const safePid = safeInt(pid);
  const safeLen = safeInt(pastedTextLen);
  const safeKey = safeKeyCode(vKeyCode);
  const wantVerify = !!verify;

  // The four verification-only fragments. Each is interpolated into a
  // position where the applescript.test.js placeholder (a bare 0) also
  // compiles, so the source-scanning guard keeps working.
  const beforeRead = wantVerify
    ? 'set beforeLen to my axFocusedValueLength(p, "before")'
    : "";
  // Skipping the "after" read when the "before" read failed is not an
  // optimisation, it is the only correct behaviour: the verdict is a
  // comparison of the two, so a missing "before" makes "after"
  // unusable — and it halves the worst-case cost against an app whose
  // accessibility reads hang.
  // The paste chord is delivered ASYNCHRONOUSLY: `key code` / `click`
  // post an event and return, and the target may not have processed it
  // by the next line. Reading the length immediately after therefore
  // measured the element BEFORE the paste, `afterLen - beforeLen` was 0,
  // and the verdict was `:unverified` for every paste — which is why the
  // policy went on to disable verification for every app after two
  // pastes, and why the user's previous clipboard was never restored
  // (scheduleSmartClipboardRestore only opens that gate for a verified
  // paste). Measured against a scratch TextEdit document: one 50 ms poll
  // sufficed in 8 of 8 trials, so the common case pays 50 ms — less than
  // the fixed 160 ms sleep that used to sit here — and a slower target
  // gets up to AX_VERIFY_POLLS attempts instead of a wrong answer.
  const afterRead = wantVerify
    ? 'if beforeLen is not -1 then set afterLen to my axAwaitPasteGrowth(p, beforeLen, pastedTextLen)'
    : "";
  const verifiedTagExpr = wantVerify
    ? "my pasteVerifiedTag(beforeLen, afterLen, pastedTextLen)"
    : '""';
  const axHandlers = wantVerify ? axVerificationHandlers() : "";

  return `
    set targetApp to "${escapedApp}"
    set targetPid to ${safePid}
    set targetWindowTitle to "${escapedWindowTitle}"
    set pastedTextLen to ${safeLen}
    set beforeLen to -1
    set afterLen to -1
    tell application "System Events"
      if UI elements enabled is false then return "ERR:no-accessibility"
      set p to missing value

      -- Priority 1: Target by exact Unix PID
      if targetPid > 0 then
        if exists (first process whose unix id is targetPid) then
          set p to first process whose unix id is targetPid
        end if
      end if

      -- Priority 2: Target by exact App Name
      if p is missing value and targetApp is not "" then
        if exists process targetApp then
          set p to process targetApp
        end if
      end if

      if p is missing value then return "ERR:no-process"

      -- Fast path: bring target to front and send physical Cmd+V keycode.
      -- Avoid AXFocusedUIElement probing HERE (before even deciding how
      -- to paste) because some apps block this call for several seconds
      -- and make the recording status look stuck on transcribing --
      -- measured against the Finder process AXFocusedUIElement itself,
      -- a probe with no bound blocked for 40+ seconds. The verification
      -- reads below are bounded, one Apple Event at a time, by the
      -- timeout statements that WRAP their tell blocks.
      --
      -- The activation and its settle delay are conditional. Transcriptor
      -- never takes focus -- the capsule is a non-focusable window -- so the
      -- app the user dictated into is still frontmost when the transcript
      -- comes back: 1459 of 1459 pastes in the log recorded
      -- "target_activation_skipped reason=already-frontmost". Raising an
      -- app that is already raised is free; the 80 ms delay after it was
      -- not, and it was paid on every one of them. Reading "frontmost"
      -- is a single attribute fetch, and the activation still happens
      -- whenever focus really did move.
      set activationTag to ""
      if frontmost of p is false then
        set frontmost of p to true
        set activationTag to "+activated"
        delay 0.08
      end if
      if targetWindowTitle is not "" then
        try
          -- Resolve the window ONCE. "if exists X then set w to X" runs
          -- the same accessibility traversal twice; a try around a
          -- single fetch has identical semantics (a missing window
          -- raises, which the surrounding try already swallows).
          set w to missing value
          try
            set w to first window of p whose name is targetWindowTitle
          end try
          if w is not missing value then
            try
              perform action "AXRaise" of w
            end try
            try
              set value of attribute "AXMain" of w to true
            end try
            delay 0.05
          end if
        end try
      end if

      -- Snapshot the focused element text length right before the
      -- paste fires, so the same length read after it fires (at either
      -- return point below) can tell a genuine paste from a click/keycode
      -- that was sent but never received by anything. Emitted only when
      -- the caller asked for verification.
      ${beforeRead}

      -- If the target exposes a standard Edit > Paste command, prefer
      -- executing that command directly over synthesising Cmd+V. A
      -- keycode only proves the keyboard event was delivered; the menu
      -- command is the target app own paste action and is a stronger
      -- signal that the active responder can accept text.
      try
        -- Walk the target menu bar ONCE. The previous form asked
        -- "exists" for this exact path and then fetched it again -- two
        -- full accessibility traversals of another application menu
        -- bar, the most expensive operation in this script. Measured
        -- against a live app: 170-240 ms duplicated (and visibly
        -- jittery) versus a flat 160 ms evaluated once, over a 40 ms
        -- osascript baseline. Semantics are unchanged: a missing menu
        -- item raises, which is what the "exists" test was detecting.
        set pasteMenuItem to missing value
        try
          set pasteMenuItem to menu item "Paste" of menu 1 of menu bar item "Edit" of menu bar 1 of p
        end try
        if pasteMenuItem is not missing value then
          if enabled of pasteMenuItem is false then
            return "ERR:no-focus"
          end if
          try
            click pasteMenuItem
            -- No settle delay before returning. "click" performs the
            -- app own paste action; nothing this script does afterwards
            -- observes the result, and the two things that DO care about
            -- the paste having landed carry their own waits: the clipboard
            -- restore does not run for at least 1.5 s, and the auto-send
            -- Enter sleeps before it fires. A delay here was 160 ms added
            -- to the moment the user is waiting for.
            log "${PASTE_SENT_PREFIX}menu-paste-primary"
            ${afterRead}
            return "OK:menu-paste-primary" & activationTag & ${verifiedTagExpr}
          end try
        end if
      end try

      -- Press ⌘V on the key the current layout's ⌘ table calls "v".
      --
      -- The code is a parameter, not a literal: KeyLayout.swift reads it
      -- from the layout (via the helper's paste-key answer) because a
      -- virtual key code names a POSITION — code 9 is V on QWERTY and K
      -- on Dvorak, where ⌘V is code 47. The default here is the same
      -- QWERTY last resort the native path uses when no layout answers.
      --
      -- keystroke "v" is not an alternative: it types through the plain
      -- layout and fails on a non-Latin one (Russian "м").
      tell p
        key code ${safeKey} using {command down}
      end tell

      -- Same reasoning as the menu path: the settle allowance lives with
      -- the caller that needs it, not in front of the return.
      log "${PASTE_SENT_PREFIX}robust-paste"
      ${afterRead}
      return "OK:robust-paste" & activationTag & ${verifiedTagExpr}
    end tell
    ${axHandlers}
  `;
}

/**
 * The verification half of the script: emitted only when the caller
 * asked for it, so a paste that will not be verified spawns an
 * osascript whose source contains no accessibility read at all.
 */
function axVerificationHandlers() {
  return `
    -- Resolve the focused UI element ONCE, bounded. This is the
    -- expensive read: measured on macOS 27, an unbounded
    -- AXFocusedUIElement fetch against Finder blocked for 20+ seconds.
    -- Every poll below reuses the element instead of re-resolving it.
    on axFocusedElement(p)
      try
        with timeout of ${AX_READ_TIMEOUT_SEC} second
          tell application "System Events"
            return (value of attribute "AXFocusedUIElement" of p)
          end tell
        end timeout
      on error
        return missing value
      end try
    end axFocusedElement

    -- Character length of an element's text value, or -1 when it is
    -- unavailable/unreadable/times out.
    --
    -- The value is fetched into a variable and only THEN counted. The
    -- previous form, "count of (value of attribute \"AXValue\" of axElem)"
    -- inside the System Events tell block, counted the ELEMENTS of an
    -- object specifier rather than the characters of the string, and so
    -- returned 1 for every readable value regardless of its length.
    -- Measured against a scratch TextEdit document holding "abcde":
    --
    --   inline_count=1        value_first_count=5
    --
    -- That is why no paste was ever verified even when the target did
    -- expose its value: beforeLen and afterLen were both 1, their
    -- difference 0, never equal to the pasted length. AXNumberOfCharacters
    -- (which reported 5 correctly) was unreachable, because it is only
    -- consulted when the first read returns -1 and this one returned 1.
    on axValueLengthOf(axElem)
      set axLen to -1
      try
        with timeout of ${AX_READ_TIMEOUT_SEC} second
          tell application "System Events"
            set axValue to (value of attribute "AXValue" of axElem)
          end tell
        end timeout
        set axLen to (count of (axValue as text))
      end try
      if axLen is -1 then
        -- What some custom text views expose instead of AXValue.
        try
          with timeout of ${AX_READ_TIMEOUT_SEC} second
            tell application "System Events"
              set axLen to (value of attribute "AXNumberOfCharacters" of axElem)
            end tell
          end timeout
        end try
      end if
      return axLen
    end axValueLengthOf

    -- The "before" read: one element resolve plus one value read.
    on axFocusedValueLength(p, label)
      log "${AX_TRACE_PREFIX}" & label & ":begin"
      set axElem to my axFocusedElement(p)
      if axElem is missing value then
        log "${AX_TRACE_PREFIX}" & label & ":end"
        return -1
      end if
      set axLen to my axValueLengthOf(axElem)
      log "${AX_TRACE_PREFIX}" & label & ":end"
      return axLen
    end axFocusedValueLength

    -- The "after" read: a key code or a menu click is delivered
    -- asynchronously, so the target may not have applied it yet. Poll
    -- the SAME element up to ${AX_VERIFY_POLLS} times, ${AX_VERIFY_POLL_INTERVAL_SEC} s
    -- apart, stopping the moment the length has grown by exactly the
    -- pasted length. Measured against a scratch TextEdit document, one
    -- poll sufficed in 8 of 8 trials; the bound is what keeps a target
    -- that never updates from costing more than the budget allows.
    on axAwaitPasteGrowth(p, beforeLen, expectedLen)
      log "${AX_TRACE_PREFIX}after:begin"
      set axElem to my axFocusedElement(p)
      if axElem is missing value then
        log "${AX_TRACE_PREFIX}after:end"
        return -1
      end if
      set axLen to -1
      repeat ${AX_VERIFY_POLLS} times
        delay ${AX_VERIFY_POLL_INTERVAL_SEC}
        set axLen to my axValueLengthOf(axElem)
        if axLen is -1 then exit repeat
        if (axLen - beforeLen) is equal to expectedLen then exit repeat
      end repeat
      log "${AX_TRACE_PREFIX}after:end"
      return axLen
    end axAwaitPasteGrowth

    -- Three distinguishable answers, because they mean different things
    -- to desktop/paste-verification-policy.js:
    --
    --   :verified    both reads landed and the element grew by exactly
    --                the pasted length.
    --   :unreadable  a read returned -1 — this target does not expose an
    --                inspectable value at all (measured: the Claude
    --                desktop app fails both AXValue and
    --                AXNumberOfCharacters with -1728). Verification here
    --                is IMPOSSIBLE, not failed, and repeating it is pure
    --                cost — this is the outcome that may switch the
    --                reads off for the app.
    --   :unverified  both reads landed but the growth did not match. The
    --                paste happened (the ladder has its own verdict for
    --                whether it did not); the element simply did not end
    --                up the length we predicted — the target rewrote the
    --                text, the poll bound expired, focus moved. That is
    --                inconclusive, and it must NOT count towards
    --                switching verification off, or a target that is
    --                merely slow gets treated like one that is mute.
    on pasteVerifiedTag(beforeLen, afterLen, pastedTextLen)
      if beforeLen is -1 or afterLen is -1 then return ":unreadable"
      if (afterLen - beforeLen) is equal to pastedTextLen then return ":verified"
      return ":unverified"
    end pasteVerifiedTag
  `;
}

/**
 * Build the SECONDARY menu-paste fallback, run only after the primary script
 * has failed and the ladder is exhausted.
 *
 * It lived in main.js as a hand-written template that re-implemented this
 * module's process resolution and re-typed its `ERR:` vocabulary, and it
 * interpolated its two values with main.js's own escaping rather than
 * `escapeAppleScriptString` / `safeInt`. Two AppleScripts speaking the same
 * protocol, only one of which any test compiled.
 *
 * Deliberately different from `robustPasteScript` in exactly two ways, both
 * because it is the last attempt rather than the first:
 *   - it forces `frontmost` instead of trying the focused element first;
 *   - it does no AX verification, so it returns the plain `OK:` form that
 *     paste-result.js reads as an unverified success.
 *
 * @param {object} target
 * @param {string} target.appName  raw app name (escaped here)
 * @param {number} target.pid      unix pid of the target process
 * @returns {string} AppleScript source for `osascript -e`
 *
 * Returns, on stdout:
 *   OK:menu-paste
 *   ERR:no-accessibility | ERR:no-process | ERR:menu-paste:<message>
 */
function menuPasteFallbackScript({ appName = "", pid = 0 } = {}) {
  const escapedApp = escapeAppleScriptString(appName);
  const safePid = safeInt(pid);
  return `
    set targetApp to "${escapedApp}"
    set targetPid to ${safePid}
    tell application "System Events"
      if UI elements enabled is false then return "ERR:no-accessibility"
      set p to missing value
      if targetPid > 0 then
        if exists (first process whose unix id is targetPid) then
          set p to first process whose unix id is targetPid
        end if
      end if
      if p is missing value and targetApp is not "" then
        if exists process targetApp then
          set p to process targetApp
        end if
      end if
      if p is missing value then return "ERR:no-process"
      set frontmost of p to true
      delay ${MENU_FALLBACK_FRONTMOST_SETTLE_SEC}
      try
        click menu item "Paste" of menu 1 of menu bar item "Edit" of menu bar 1 of p
        delay ${MENU_FALLBACK_CLICK_SETTLE_SEC}
        return "OK:menu-paste"
      on error errMsg
        return "ERR:menu-paste:" & errMsg
      end try
    end tell
  `;
}

module.exports = {
  AX_READ_TIMEOUT_SEC,
  AX_VERIFY_POLLS,
  AX_VERIFY_POLL_INTERVAL_SEC,
  AX_TRACE_PREFIX,
  PASTE_SENT_PREFIX,
  QWERTY_V_KEY_CODE,
  escapeAppleScriptString,
  pasteKeyFromAnswer,
  robustPasteScript,
  menuPasteFallbackScript,
};
