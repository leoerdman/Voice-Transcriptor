"use strict";

// SSOT for the paste wire protocol — the marker strings the paste
// scripts PRINT and the parsers READ.
//
// Every one of these was typed independently in two or three files:
// "SENT:" in paste-script.js and again as a literal inside
// paste-result.js's regex; "AXT:" in paste-script.js, again in
// paste-verification-policy.js's line matcher, and again in main.js's
// stream filter. Nothing resolved the duplicates, so renaming a marker
// in the script left every test green while the production parse went
// silently blind — and going blind on "SENT:" specifically means the
// ladder cannot tell "killed before the keystroke" from "killed after
// it" and pastes the transcript into the target a second time. That is
// the exact defect the receipt was introduced to prevent.
//
// Producers: paste-script.js (macOS AppleScript), the Windows VBS built
// in main.js. Consumers: paste-result.js, paste-verification-policy.js,
// main.js.

/** Successful outcome, e.g. `OK:robust-paste:verified`, `OK:vbs-paste`. */
const PASTE_OK_PREFIX = "OK:";

/**
 * The Windows paste scripts' own method names, as printed after
 * `PASTE_OK_PREFIX` / `PASTE_SENT_PREFIX`: the VBS SendKeys paste and the
 * PowerShell SendKeys fallback (both built in main.js).
 */
const VBS_PASTE_METHOD = "vbs-paste";
const PWSH_PASTE_METHOD = "pwsh-paste";

/** Considered failure verdict from the script itself, e.g. `ERR:activate`. */
const PASTE_ERR_PREFIX = "ERR:";

/**
 * "The paste is already out" receipt, printed the instant after the
 * paste chord leaves and BEFORE anything that can block (the AX
 * verification read, or simply the return trip). When the parent's
 * wall-clock bound kills the script, this receipt is what tells the
 * ladder whether the kill landed before or after the paste was
 * delivered. Handy's paste_tx draws the same line: only a receipt that
 * arrives after chord injection counts as proof.
 *
 * Parsed by paste-result.js `pasteSentReceipt`.
 */
const PASTE_SENT_PREFIX = "SENT:";

/**
 * Accessibility read timing markers, `AXT:<label>:begin` /
 * `AXT:<label>:end`, emitted around each AX read because AppleScript has
 * no sub-second clock that does not cost a `do shell script`. The parent
 * timestamps the lines as they arrive.
 *
 * Parsed by paste-verification-policy.js `summarizeAxReadTrace`.
 */
const AX_TRACE_PREFIX = "AXT:";

/** Matches one complete AX trace line and captures label + edge. */
const AX_TRACE_LINE_RE = new RegExp(`^${AX_TRACE_PREFIX}([A-Za-z0-9_-]+):(begin|end)$`);

/**
 * The Windows scripts' complete marker lines, built once from the parts
 * above so the script that prints one and the parser that reads it cannot
 * drift (DX-26): main.js's VBS and ./windows-paste-fallback print them,
 * ./paste-result reads them.
 */
const VBS_PASTE_OK = `${PASTE_OK_PREFIX}${VBS_PASTE_METHOD}`;
const VBS_PASTE_SENT = `${PASTE_SENT_PREFIX}${VBS_PASTE_METHOD}`;
const PWSH_PASTE_OK = `${PASTE_OK_PREFIX}${PWSH_PASTE_METHOD}`;
/** Both Windows scripts refuse to send keys into a window the OS did not raise. */
const PASTE_ERR_ACTIVATE = `${PASTE_ERR_PREFIX}activate`;

/** Matches a receipt anywhere in a stream, at the start of a line. */
const PASTE_SENT_RECEIPT_RE = new RegExp(`(^|[\\r\\n])(${PASTE_SENT_PREFIX}[A-Za-z0-9_.+-]+)`);

module.exports = {
  PASTE_OK_PREFIX,
  VBS_PASTE_OK,
  VBS_PASTE_SENT,
  PWSH_PASTE_OK,
  PASTE_ERR_ACTIVATE,
  PASTE_ERR_PREFIX,
  PASTE_SENT_PREFIX,
  AX_TRACE_PREFIX,
  AX_TRACE_LINE_RE,
  PASTE_SENT_RECEIPT_RE,
};
