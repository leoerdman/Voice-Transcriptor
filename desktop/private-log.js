"use strict";

// main.log is readable by its owner only (Ultra-Audit 2026-11-20 BL-02).
//
// The log names recordings, archive folders and paste targets, and the
// error dialogs ask users to send it to support — but it was created with
// the process umask (0644 on macOS): readable by every other account on
// the Mac, under a data folder that is itself world-listable. The backend's
// own secrets (api_token.txt, the encryption key) are written 0600; the log
// is the same kind of file.
//
// `appendFileSync`'s `mode` applies only when the call CREATES the file,
// so a log that already exists from an older version is tightened once per
// path per process; every file the rotation starts afresh is created 0600.
//
// Pure apart from the injected fs — desktop/private-log.test.js.

const fs = require("fs");

const PRIVATE_FILE_MODE = 0o600;

// ── What may not go into the log ──────────────────────────────────────
//
// The file is private, but it is still handed to support when something
// goes wrong. A foreign window's title is the text its user is reading in
// another application — a mail subject, a document name, a chat partner —
// and it was being written by the post-stop queue and by every paste
// trace that touched the frontmost window (P3-4).
//
// Diagnostics need identity, not content: which app (its name and bundle
// id), which process, and which platform window (windowId / hwnd) the
// paste was aimed at. So every window-bearing shape — a captured paste
// target, a frontmost-app answer — goes through windowLogSummary /
// windowLogFields, and redactWindowTitles is the second line at the
// structured log gates: a future traceStep that passes a whole window
// object still cannot carry the title into the file.

/** A window title field, whatever its call site named the prefix. */
const WINDOW_TITLE_KEY = /window_?title$/i;

function windowIdentity(info) {
  const src = info && typeof info === "object" ? info : {};
  return {
    app: String(src.appName ?? src.name ?? src.targetName ?? "").trim(),
    pid: Number.parseInt(String(src.pid ?? src.targetPid ?? 0), 10) || 0,
    bundleId: String(src.bundleId || "").trim(),
    windowId: String(src.windowId || "").trim(),
    hwnd: String(src.hwnd || "").trim(),
    className: String(src.className || "").trim(),
    instanceName: String(src.instanceName || "").trim(),
  };
}

/**
 * The compact object form for traceStep / logPasteTrace. Fields with no
 * value are left out so a trace does not carry empty keys; app and pid
 * are always present because they are the pair a log reader looks for.
 */
function windowLogFields(info) {
  const id = windowIdentity(info);
  const fields = { app: id.app, pid: id.pid };
  for (const key of ["bundleId", "windowId", "hwnd", "className", "instanceName"]) {
    if (id[key]) fields[key] = id[key];
  }
  return fields;
}

/**
 * The canonical one-line form for appendMainLog — the line
 * `[post-stop-queue] enqueue …` and every other log entry that names a
 * foreign window use. Never contains the title.
 */
function windowLogSummary(info) {
  const id = windowIdentity(info);
  return `app="${id.app}" pid=${id.pid} windowId="${id.windowId}" hwnd="${id.hwnd}" class="${id.className}" instance="${id.instanceName}" bundleId="${id.bundleId}"`;
}

/**
 * A copy of `value` with every window-title field removed, at any depth.
 * Only plain objects and arrays are rebuilt: a Date, Buffer or Error is
 * returned as is. `copies` is filled BEFORE recursing, so both a cycle and
 * a container shared between two fields resolve to the redacted copy —
 * returning the original on a repeat encounter would put the title back
 * into a structure that still serialises.
 */
function redactWindowTitles(value, copies = new WeakMap()) {
  const container = Array.isArray(value)
    ? value
    : value && typeof value === "object" ? value : null;
  if (!container) return value;
  const proto = Object.getPrototypeOf(container);
  if (!Array.isArray(container) && proto !== Object.prototype && proto !== null) return value;
  if (copies.has(container)) return copies.get(container);
  if (Array.isArray(container)) {
    const list = [];
    copies.set(container, list);
    for (const item of container) list.push(redactWindowTitles(item, copies));
    return list;
  }
  const copy = {};
  copies.set(container, copy);
  for (const [key, item] of Object.entries(container)) {
    if (WINDOW_TITLE_KEY.test(key)) continue;
    copy[key] = redactWindowTitles(item, copies);
  }
  return copy;
}

function createPrivateAppender(fsImpl = fs) {
  const tightened = new Set();
  return function appendPrivate(filePath, text) {
    fsImpl.appendFileSync(filePath, text, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
    if (tightened.has(filePath)) return;
    tightened.add(filePath);
    try {
      fsImpl.chmodSync(filePath, PRIVATE_FILE_MODE);
    } catch {
      // A filesystem without POSIX modes (FAT, some network mounts):
      // the append itself succeeded, which is what the logger owes.
    }
  };
}

module.exports = {
  createPrivateAppender,
  windowLogFields,
  windowLogSummary,
  redactWindowTitles,
};
