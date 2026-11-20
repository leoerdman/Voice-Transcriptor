"use strict";

// Which renderer a recording id belongs to (Ultra-Audit 2026-11-20 DM-32).
//
// The renderer numbers its recordings 1, 2, 3 … and starts again at 1
// every time its page loads. The main process keyed its double-paste
// guards on that number alone and tried to keep them valid by CLEARING
// both sets on did-finish-load — but only when no post-stop work was
// pending, because a clear during pending work would let the pending
// recording paste twice. So a reload while a transcription was pending
// kept the old ids, and the next recordings 1..N of the new page were
// dedup-skipped in silence (the capsule stayed on "Transcribing").
//
// The id is only unique together with the page that issued it. Main
// starts a new epoch whenever the main window's renderer begins a new
// document, and every key is (epoch, recordingId). Nothing has to be
// cleared, so there is no moment at which clearing is wrong. The same
// epoch also gets its own hand-off mailbox, so a new page's recording 1
// can never be answered with the old page's recording-1 text.
//
// Pure — desktop/renderer-epoch.test.js.

function recordingKey(epoch, recordingId) {
  return `${Math.trunc(Number(epoch) || 0)}:${Math.trunc(Number(recordingId) || 0)}`;
}

/** A Set of keys that forgets the oldest entry past ``cap``. */
function createBoundedKeySet(cap) {
  const limit = Math.max(1, Math.trunc(Number(cap) || 1));
  const keys = new Set();
  return {
    has: (key) => keys.has(key),
    add(key) {
      keys.add(key);
      if (keys.size > limit) {
        const oldest = keys.values().next().value;
        if (oldest !== undefined) keys.delete(oldest);
      }
    },
    size: () => keys.size,
  };
}

module.exports = { recordingKey, createBoundedKeySet };
