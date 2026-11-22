"use strict";

// The three requests the main window's renderer makes of the main
// process over preload sends (DM-10 / FU-10 / K-1):
//
//   "shortcuts:message"  Settings → Shortcuts: capture started/cancelled,
//                        or a new accelerator set to register
//   "record:toggle"      the in-window Record/Stop button
//   "recording:reveal"   "Reveal in folder" for a saved transcript
//   "notice:built-in-mic" the built-in mic (chosen by the Bluetooth setting)
//                        barely heard the take: main shows its fixed notice
//
// They used to ride on `document.title`: the renderer wrote
// "__app_<verb>__<url-encoded JSON>", main intercepted page-title-updated
// and preventDefault()ed the change. That channel had no sender identity
// beyond "some page in this window", needed a nonce so a repeated message
// changed the title at all, and a restore timer that raced a second
// message in the same tick. The preload now sends on fixed channels and
// main checks the sender (isFromMainWindow) like every other channel.
//
// What stays the same is what main accepts. The renderer is not trusted
// to name a path or a verb: these functions decide, from the payload
// alone plus the roots main supplies, what a request is allowed to do.
// They are pure so the decision is testable without Electron.

const path = require("node:path");

/** Channel names, typed once here and in preload.js (ipc-contract.test.js). */
const RENDERER_REQUEST_CHANNELS = Object.freeze({
  SHORTCUTS: "shortcuts:message",
  RECORD_TOGGLE: "record:toggle",
  REVEAL_RECORDING: "recording:reveal",
  BUILT_IN_MIC_NOTICE: "notice:built-in-mic",
});

const SHORTCUT_ACTIONS = Object.freeze(["capture-start", "capture-cancel", "update"]);
const SHORTCUT_SLOT_FIELDS = Object.freeze(["record", "paste", "screen", "screenShot"]);
/** Longest accelerator string main will look at (a real one is ~20 chars). */
const ACCELERATOR_MAX_CHARS = 96;

/**
 * A Settings → Shortcuts message, normalised, or `{ error }` for one main
 * must refuse. Every slot is a trimmed, bounded string; nothing else in
 * the payload rides along.
 *
 * @returns {{ message: {action: string, record: string, paste: string, screen: string, screenShot: string} } | { error: string }}
 */
function parseShortcutMessage(payload) {
  const p = payload && typeof payload === "object" ? payload : null;
  if (!p) return { error: "bad-payload" };
  const action = String(p.action || "").trim();
  if (!SHORTCUT_ACTIONS.includes(action)) return { error: `rejected action=${action.slice(0, 40)}` };
  const message = { action };
  for (const field of SHORTCUT_SLOT_FIELDS) {
    message[field] = String(p[field] || "").trim().slice(0, ACCELERATOR_MAX_CHARS);
  }
  return { message };
}

/** Is `candidate` `root` itself or a descendant of it (no `..` escape)? */
function pathContains(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Which file a "Reveal in folder" request may show, or why it may not.
 *
 * Reveal means "show the transcript file" — never the adjacent audio,
 * which the History and Upload panes already play. The name must be a
 * bare `.txt` file name (no separator, no `..`: 1.1.25 path-traversal
 * defence — a dotted name used to let a compromised renderer enumerate
 * the home parent through shell.showItemInFolder). The archive dir, when
 * given, must be absolute, inside the user's home on a separator
 * boundary (plain startsWith let "/Users/foobar" pass for "/Users/foo"),
 * and inside one of the recording roots main allows: the data
 * directory's recordings/ and the configured recordings root.
 *
 * @param {{name?: unknown, archiveDir?: unknown}} payload from the renderer
 * @param {{home: string, recordingsRoot: string, allowedRoots: string[]}} roots from main
 * @returns {{ ok: true, target: string } | { ok: false, reason: string, detail?: string }}
 */
function resolveRevealTarget(payload, { home, recordingsRoot, allowedRoots }) {
  const p = payload && typeof payload === "object" ? payload : {};
  const name = String(p.name || "");
  if (!name || name.includes("..") || /[\\/]/.test(name)) return { ok: false, reason: "bad-name" };
  if (!name.toLowerCase().endsWith(".txt")) return { ok: false, reason: "not-a-transcript", detail: name };
  const archiveDirRaw = String(p.archiveDir || "").trim();
  const archiveDir = archiveDirRaw && path.isAbsolute(archiveDirRaw)
    ? path.resolve(archiveDirRaw)
    : path.resolve(recordingsRoot);
  const homeDir = path.resolve(home);
  if (!(archiveDir === homeDir || archiveDir.startsWith(homeDir + path.sep))) {
    return { ok: false, reason: "outside-home", detail: archiveDir };
  }
  const target = path.resolve(archiveDir, name);
  const allowed = (allowedRoots || []).some((root) =>
    pathContains(root, archiveDir) && pathContains(root, target));
  if (!allowed) return { ok: false, reason: "outside-recording-roots", detail: archiveDir };
  return { ok: true, target };
}

module.exports = {
  RENDERER_REQUEST_CHANNELS,
  SHORTCUT_ACTIONS,
  parseShortcutMessage,
  resolveRevealTarget,
};
