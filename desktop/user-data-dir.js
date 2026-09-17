/**
 * One spelling for the directory this app keeps its data in.
 *
 * There were two. Electron names ``userData`` after the package's
 * ``name`` field, which npm requires to be lower case — so the shell
 * wrote ``…/Application Support/transcriptor`` — while
 * ``backend/data_dir.py`` spells the same directory ``Transcriptor``,
 * and the Windows OneDrive re-home a few lines below its caller spells
 * it ``Transcriptor`` too. Three writers, two spellings.
 *
 * On macOS and Windows that never broke anything, because both file
 * systems are case-insensitive by default and the backend is handed the
 * shell's path in ``TRANSCRIPTOR_DATA_DIR`` anyway — the two names are
 * the same directory, and the env var settles it. What it did produce
 * was a path that reads wrong wherever it is shown, including in the
 * command-line client's wrapper, and one real failure mode: on a
 * case-SENSITIVE volume the two spellings are two directories, and
 * anything that resolves the name itself rather than reading the env
 * var — ``python backend/cli.py`` run by hand, without the wrapper's
 * ``--connection`` — looks in the empty one.
 *
 * So the shell adopts the backend's spelling, and this module owns both
 * halves of that: which name to use, and what to do about a directory
 * left behind under the old one. Both are pure, so the decision is
 * testable without a file system and without Electron
 * (desktop/user-data-dir.test.js).
 *
 * Linux is deliberately NOT capitalised. There ``backend/data_dir.py``
 * says ``~/.local/share/transcriptor`` — lower case, per XDG — so lower
 * case is already the matching spelling, and renaming Electron's
 * ``~/.config/transcriptor`` would move a real directory on a real
 * case-sensitive file system to gain nothing.
 */

"use strict";

const path = require("path");

/**
 * The name, per platform. Must match the last path segment
 * ``backend/data_dir.py::default_data_dir`` produces for that platform;
 * desktop/user-data-dir.test.js reads the Python source and asserts it.
 */
const USER_DATA_DIR_NAMES = Object.freeze({
  darwin: "Transcriptor",
  win32: "Transcriptor",
});
const USER_DATA_DIR_NAME_DEFAULT = "transcriptor";

const USER_DATA_MIGRATION = Object.freeze({
  /** Nothing to do: the name did not change, or nothing was left behind. */
  NONE: "none",
  /** The old directory IS the new one — a case-insensitive volume. */
  SAME_DIRECTORY: "same-directory",
  /** Take the old directory over to the new name. */
  ADOPT: "adopt",
  /** Two real directories exist. Use the new one; touch neither. */
  KEEP_BOTH: "keep-both",
});

function userDataDirName(platform = process.platform) {
  return USER_DATA_DIR_NAMES[platform] || USER_DATA_DIR_NAME_DEFAULT;
}

/**
 * What to do with a data directory sitting under the previous spelling.
 *
 * Every input is a fact the caller has already established, so this
 * function neither touches the disk nor guesses:
 *
 *  - ``legacyName`` / ``preferredName`` — the two spellings.
 *  - ``legacyExists`` — is there a directory under the old name.
 *  - ``preferredExists`` — is there one under the new name.
 *  - ``sameDirectory`` — do the two paths resolve to the same directory
 *    (same device and inode). True on a case-insensitive volume, which
 *    is the common case on macOS and Windows and the reason this
 *    transition is normally a no-op rather than a move.
 *
 * KEEP_BOTH is deliberate, and it is the reason this is a decision
 * rather than a rename. If both names hold a real, distinct directory,
 * one of them has the user's config, provider keys and archive and the
 * other may too — merging them is guesswork, and the wrong guess loses
 * data that cannot be reconstructed. The caller says so loudly in the
 * log and leaves both where they are.
 */
function decideUserDataMigration({
  legacyName = "",
  preferredName = "",
  legacyExists = false,
  preferredExists = false,
  sameDirectory = false,
} = {}) {
  if (!legacyName || !preferredName || legacyName === preferredName) {
    return { action: USER_DATA_MIGRATION.NONE, reason: "name-unchanged" };
  }
  if (!legacyExists) {
    return { action: USER_DATA_MIGRATION.NONE, reason: "nothing-under-the-old-name" };
  }
  if (sameDirectory) {
    return {
      action: USER_DATA_MIGRATION.SAME_DIRECTORY,
      reason: "case-insensitive-volume",
    };
  }
  if (!preferredExists) {
    return { action: USER_DATA_MIGRATION.ADOPT, reason: "old-directory-carries-the-data" };
  }
  return { action: USER_DATA_MIGRATION.KEEP_BOTH, reason: "two-distinct-directories" };
}

/** The two candidate paths, given the root Electron puts app data under. */
function userDataDirCandidates(appDataRoot, legacyName, preferredName) {
  return {
    legacyDir: path.join(String(appDataRoot || ""), String(legacyName || "")),
    preferredDir: path.join(String(appDataRoot || ""), String(preferredName || "")),
  };
}

module.exports = {
  USER_DATA_DIR_NAMES,
  USER_DATA_DIR_NAME_DEFAULT,
  USER_DATA_MIGRATION,
  userDataDirName,
  decideUserDataMigration,
  userDataDirCandidates,
};
