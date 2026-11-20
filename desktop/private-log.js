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

module.exports = { PRIVATE_FILE_MODE, createPrivateAppender };
