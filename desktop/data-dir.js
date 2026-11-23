"use strict";

// The ONE rule for where the desktop shell keeps its data
// (Ultra-Audit 2026-11-20 DM-07, DM-11, S-12, DM-34).
//
// ``TRANSCRIPTOR_DATA_DIR`` (documented in .env.example as an override)
// wins; otherwise Electron's ``userData``. The backend is handed the same
// answer in its environment, so the two processes agree on one directory.
//
// It used to be restated: five call sites in main.js spelled
// ``process.env.TRANSCRIPTOR_DATA_DIR || app.getPath("userData")`` and
// eight more read bare ``userData`` (main.log, last_transcript.json, the
// engine site, the venv, the python cache, the log path printed in error
// dialogs). With the override set, the backend, window state and screen
// staging used one directory while the log, the last transcript, the venv
// and the engine lived in another, and the dialogs named a log path where
// the log was not.
//
// DM-07 was the same split in time: ``appendMainLog`` cached the log path
// on its first call, which on Windows happens inside the data-directory
// spelling fix — BEFORE the OneDrive re-home moves userData off the
// synced folder. main.log (which carried dictation previews) stayed in
// OneDrive for the whole session. The log path is now derived from
// ``resolveDataDir`` on every write, so it follows the directory instead
// of remembering an old one.
//
// Pure — desktop/data-dir.test.js.

const path = require("path");

const MAIN_LOG_FILE = "main.log";

function resolveDataDir({ envDataDir = "", userDataPath = "" } = {}) {
  const override = String(envDataDir || "").trim();
  return override ? path.resolve(override) : String(userDataPath || "");
}

/**
 * DM-34: which entries of an old data directory the OneDrive re-home
 * copies to the new one. It used to be an inclusion list retyped from the
 * backend's files (config, key, token, archive dirs, presets, recordings)
 * that silently missed everything added since — history, last transcript,
 * window state, screen staging. The rule is inverted: the user's data is
 * everything, except what this shell regenerates on its own.
 */
const REGENERATED_ENTRIES = Object.freeze([
  // Python environments and caches the shell rebuilds.
  ".venv",
  "python-cache",
  "engine-site",
  // Chromium's own caches and crash store for this profile.
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GrShaderCache",
  "ShaderCache",
  "Crashpad",
  // The re-home's own marker.
  ".migrated-from-onedrive",
]);

function isRegeneratedEntry(name) {
  const n = String(name || "");
  if (!n) return true;
  if (REGENERATED_ENTRIES.includes(n)) return true;
  // engine-site.staging, engine-site.old-<ts>
  if (n.startsWith("engine-site.")) return true;
  // main.log and its rotated archives stay where they were written.
  if (n === MAIN_LOG_FILE || n.startsWith(`${MAIN_LOG_FILE}.`)) return true;
  return false;
}

function oneDriveMigrationEntries(names) {
  return (Array.isArray(names) ? names : []).filter((n) => !isRegeneratedEntry(n));
}

module.exports = {
  MAIN_LOG_FILE,
  resolveDataDir,
  isRegeneratedEntry,
  oneDriveMigrationEntries,
};
