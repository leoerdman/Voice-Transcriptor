"use strict";

// Which main.log archives the boot sweep deletes (BUG-34, Ultra-Audit
// 2026-11-20 BL-03).
//
// Rotation never deletes, so without a cap the archives grow forever
// (25 archives / 131.6 MB by November). The policy is the user's decision
// of 2026-11-20 (AGENTS.md rule 3): keep the newest MAIN_LOG_ARCHIVE_KEEP_COUNT
// archives and at most MAIN_LOG_ARCHIVE_KEEP_BYTES in total; nothing else
// — no age cap. The newest archive always survives, even when it alone
// exceeds the byte cap: it holds the freshest crash evidence.
//
// Pure: no fs — desktop/log-retention.test.js.

const MAIN_LOG_ARCHIVE_KEEP_COUNT = 10;
const MAIN_LOG_ARCHIVE_KEEP_BYTES = 50 * 1024 * 1024;

/**
 * @param {{name: string, mtimeMs: number, size: number}[]} archives
 * @returns {string[]} names to delete, oldest last
 */
function archivesToPrune(archives, {
  keepCount = MAIN_LOG_ARCHIVE_KEEP_COUNT,
  keepBytes = MAIN_LOG_ARCHIVE_KEEP_BYTES,
} = {}) {
  const newestFirst = [...archives].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const prune = [];
  let kept = 0;
  let keptBytes = 0;
  for (const [i, a] of newestFirst.entries()) {
    const overCaps = kept + 1 > keepCount || keptBytes + a.size > keepBytes;
    if (i > 0 && overCaps) {
      prune.push(a.name);
      continue;
    }
    kept += 1;
    keptBytes += a.size;
  }
  return prune;
}

module.exports = { archivesToPrune, MAIN_LOG_ARCHIVE_KEEP_COUNT, MAIN_LOG_ARCHIVE_KEEP_BYTES };
