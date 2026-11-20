"use strict";

// Pure "did this paste attempt actually succeed, and can we trust the
// clipboard to hold the pasted text after it?" decision — extracted so
// every paste method in desktop/main.js's tryPasteToFocusedField makes
// the call through ONE tested function instead of five near-duplicate
// ad-hoc `if (check.ok) ...` blocks that had drifted out of sync.
//
// BUGS_AUDIT_2026-09-03 §6.1: the Windows VBS branch trusted cscript's
// exit code alone and never looked at stdout, so a VBS script that ran
// to completion without the paste actually landing (AppActivate failing
// silently, SendKeys throwing) was reported as a successful paste — the
// macOS branch, for comparison, already required stdout to start with
// "OK:". This module makes both platforms go through the same kind of
// check, and adds a "verified" bit (§6.4/§6.6) so callers can decide
// whether it is safe to restore the user's previous clipboard.
//
// Every script this module understands prints its own outcome on
// stdout as the LAST line of output:
//   - Windows VBS (SendKeys "^v"):        "SENT:vbs-paste" then "OK:vbs-paste" / "ERR:activate" / (silent + non-zero exit)
//   - Windows PowerShell SendKeys fallback: "OK:pwsh-paste" (SendKeys itself has no failure signal)
//   - Linux (wtype/xdotool/ydotool):       nothing — exit code is the only signal these CLIs give
//   - macOS AppleScript (robust_paste / menu-paste-primary / menu-paste):
//       "OK:<method>[+activated][:verified|:unverified]" / "ERR:<reason>"
//
// The marker strings themselves are NOT retyped here: they come from
// ./paste-protocol, the one place the scripts that print them and the
// parsers that read them agree on.
//
// `ok` — the child process's own exit-code success, from runCommand —
// is required in every branch: a script that never got to run (spawn
// error, PowerShell parse error, timeout + SIGKILL) has no stdout worth
// trusting, no matter what happens to be sitting in the buffer.

const {
  PASTE_OK_PREFIX,
  PASTE_ERR_PREFIX,
  PASTE_SENT_RECEIPT_RE,
  VBS_PASTE_OK,
} = require("./paste-protocol");

function outcomeOf(stdout) {
  return String(stdout == null ? "" : stdout).trim();
}

/**
 * The LAST non-empty line of a stream. The macOS script now writes a
 * progress receipt before its result (see ``pasteSentReceipt``), so the
 * verdict is the last line, not the whole trimmed buffer.
 */
function lastLineOf(text) {
  const lines = String(text == null ? "" : text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

/**
 * "The paste was already dispatched" receipt.
 *
 * The macOS script emits ``log "SENT:<method>"`` — which osascript
 * flushes to stderr immediately, verified against a live osascript — the
 * instant after the Cmd+V keycode or the Edit ▸ Paste click leaves, and
 * BEFORE the AX verification read that can block for up to its own
 * timeout. That ordering is the whole point: when the per-attempt
 * wall-clock bound kills osascript, the receipt tells us whether the
 * kill landed before or after the paste was delivered.
 *
 * Without it, a kill during the verification read looked identical to a
 * kill before the keystroke, so the ladder retried and the target got
 * the transcript TWICE. Handy's paste_tx makes the same distinction —
 * only receipts that arrive after chord injection count as proof.
 */
function pasteSentReceipt({ stdout, stderr } = {}) {
  const haystack = `${String(stdout == null ? "" : stdout)}\n${String(stderr == null ? "" : stderr)}`;
  const m = PASTE_SENT_RECEIPT_RE.exec(haystack);
  return m ? m[2] : "";
}

/**
 * Windows VBS SendKeys paste (method: "vbs_paste"). The verdict is the
 * last line, the same rule as every other script here: the marker
 * appearing somewhere inside other output is not the script saying OK.
 */
function isVbsPasteSuccess({ ok, stdout }) {
  return !!ok && lastLineOf(stdout) === VBS_PASTE_OK;
}

/**
 * Full Windows VBS verdict, receipt included.
 *
 * The receipt matters most on this platform: cscript's launch can spend
 * 1-3 s in Defender's real-time scan, so the per-attempt bound can kill
 * the process in the window between `SendKeys "^v"` and the final Echo.
 * Without reading the receipt that kill is indistinguishable from a kill
 * before the keystroke — the ladder retries and the target gets the
 * transcript twice, which is the very thing the receipt exists to stop.
 * `sent` was previously hardcoded to false here and stderr was not even
 * passed in.
 */
function parseVbsPasteOutcome({ ok, stdout, stderr }) {
  const receipt = pasteSentReceipt({ stdout, stderr });
  if (isVbsPasteSuccess({ ok, stdout })) {
    return { success: true, verified: false, sent: !!receipt, reason: lastLineOf(stdout) };
  }
  if (receipt) {
    // Cut short AFTER the paste was dispatched: the text is in the
    // target, nothing verified it. A success that is not verified stops
    // the retry and leaves the transcript on the clipboard, because the
    // restore gate only opens for verified pastes.
    return { success: true, verified: false, sent: true, reason: receipt };
  }
  return { success: false, verified: false, sent: false, reason: outcomeOf(stdout) };
}

/** Windows PowerShell SendKeys fallback (method: "pwsh_paste_fallback"). */
function isPwshPasteFallbackSuccess({ ok, stdout }) {
  return !!ok && lastLineOf(stdout).startsWith(PASTE_OK_PREFIX);
}

/**
 * Linux paste cascade (wtype / xdotool / ydotool). None of these CLIs
 * print a protocol string on success — the process exit code is the
 * only truthful signal available, so that is the whole decision.
 */
function isLinuxPasteSuccess({ ok }) {
  return !!ok;
}

/**
 * What the macOS script's verification suffix says. Three answers, not
 * two, because "this app exposes no readable value" and "the reads
 * landed but the growth did not match" mean opposite things to
 * paste-verification-policy.js: the first is a permanent property of the
 * target and may switch the reads off; the second is inconclusive and
 * must not.
 */
const MAC_VERIFICATION = Object.freeze({
  /** The element grew by exactly the pasted length. */
  VERIFIED: "verified",
  /** Reads landed, growth did not match — inconclusive. */
  UNVERIFIED: "unverified",
  /** A read returned -1: this target exposes nothing to verify against. */
  UNREADABLE: "unreadable",
  /** The script carried no verification reads at all. */
  NONE: "none",
});

/** The suffix of an "OK:..." verdict line, as a MAC_VERIFICATION value. */
function macVerificationOf(outcomeLine) {
  const out = String(outcomeLine || "");
  if (/:verified$/.test(out)) return MAC_VERIFICATION.VERIFIED;
  if (/:unverified$/.test(out)) return MAC_VERIFICATION.UNVERIFIED;
  if (/:unreadable$/.test(out)) return MAC_VERIFICATION.UNREADABLE;
  return MAC_VERIFICATION.NONE;
}

/**
 * macOS AppleScript paste — both the primary robust_paste script
 * (methods "robust_paste" and "menu-paste-primary", returned as
 * "OK:robust-paste…" / "OK:menu-paste-primary…") and the secondary
 * menu-paste fallback ("OK:menu-paste"). A trailing ":verified" means
 * the script itself read the focused element's AXValue/AXNumberOfCharacters
 * length before and after the paste and saw it grow by exactly the
 * pasted text's length; ":unverified" means the target didn't expose an
 * inspectable value (verification impossible, not a failure) or the
 * growth didn't match; a bare "OK:<reason>" (no suffix — the secondary
 * menu-paste fallback never adds one) means nothing was verified.
 */
function parseMacPasteOutcome({ ok, stdout, stderr }) {
  const out = lastLineOf(stdout);
  // An explicit ERR: verdict is the script's own considered answer and
  // outranks any receipt — the script only logs a receipt after the
  // paste is out, and it never returns ERR: afterwards.
  if (out.startsWith(PASTE_ERR_PREFIX)) {
    return { success: false, verified: false, verification: MAC_VERIFICATION.NONE, sent: false, reason: out };
  }
  const receipt = pasteSentReceipt({ stdout, stderr });
  if (ok && out.startsWith(PASTE_OK_PREFIX)) {
    const verification = macVerificationOf(out);
    return {
      success: true,
      verified: verification === MAC_VERIFICATION.VERIFIED,
      verification,
      sent: !!receipt,
      reason: out,
    };
  }
  if (receipt) {
    // Killed (or otherwise cut short) AFTER the paste was dispatched:
    // the text is in the target, but nothing verified it. Report it as a
    // success that is NOT verified — that stops the ladder from pasting
    // a second time, and leaves the transcript on the clipboard because
    // the restore gate only opens for verified pastes.
    return { success: true, verified: false, verification: MAC_VERIFICATION.NONE, sent: true, reason: receipt };
  }
  if (!ok) return { success: false, verified: false, verification: MAC_VERIFICATION.NONE, sent: false, reason: out };
  return { success: false, verified: false, verification: MAC_VERIFICATION.NONE, sent: false, reason: out || "paste-return-unknown" };
}

/**
 * Single dispatch point: given the method name tryPasteToFocusedField is
 * about to report, and the raw {ok, stdout} from runCommand, decide
 * success + verified. This is the function every method branch should
 * call — see desktop/main.js's tryPasteToFocusedField.
 */
function evaluatePasteOutcome({ method, ok, stdout, stderr }) {
  switch (method) {
    case "vbs_paste":
      return parseVbsPasteOutcome({ ok, stdout, stderr });
    case "pwsh_paste_fallback":
      return { success: isPwshPasteFallbackSuccess({ ok, stdout }), verified: false, sent: false, reason: outcomeOf(stdout) };
    case "wtype":
    case "xdotool":
    case "ydotool":
      return { success: isLinuxPasteSuccess({ ok }), verified: false, sent: false, reason: outcomeOf(stdout) };
    case "robust_paste":
    case "menu-paste-primary":
    case "menu-paste":
      return parseMacPasteOutcome({ ok, stdout, stderr });
    default:
      return { success: !!ok, verified: false, sent: false, reason: outcomeOf(stdout) };
  }
}

module.exports = {
  MAC_VERIFICATION,
  macVerificationOf,
  lastLineOf,
  pasteSentReceipt,
  isVbsPasteSuccess,
  parseVbsPasteOutcome,
  isPwshPasteFallbackSuccess,
  isLinuxPasteSuccess,
  parseMacPasteOutcome,
  evaluatePasteOutcome,
};
