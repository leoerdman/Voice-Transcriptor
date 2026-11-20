"use strict";

// Which main.log archives the boot sweep deletes (BUG-34, Ultra-Audit
// 2026-11-20 BL-03).
//
// Rotation never deletes, so without a cap the archives grow forever
// (25 archives / 131.6 MB by November). The policy is the user's decision
// of 2026-11-20 (AGENTS.md rule 3): keep the newest MAIN_LOG_ARCHIVE_KEEP_COUNT
// archives and at most MAIN_LOG_ARCHIVE_KEEP_BYTES in total; nothing else
// — no age cap. What is kept is always the newest UNBROKEN run of
// archives: once one is pruned, every older one goes too, so the history
// kept never has a hole in it. The newest archive always survives, even
// when it alone exceeds the byte cap: it holds the freshest crash
// evidence.
//
// ``archivesToPrune`` is the pure decision; ``pruneLogArchives`` is the
// boot sweep over a directory, with the fs injected —
// desktop/log-retention.test.js runs it against a real temp directory.

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
  let kept = 0;
  let keptBytes = 0;
  for (const [i, a] of newestFirst.entries()) {
    const overCaps = kept + 1 > keepCount || keptBytes + a.size > keepBytes;
    if (i > 0 && overCaps) return newestFirst.slice(i).map((x) => x.name);
    kept += 1;
    keptBytes += a.size;
  }
  return [];
}

/**
 * The boot sweep: delete the archives of ``logPath`` (``<name>.<anything>``
 * beside it) that ``archivesToPrune`` names. Never throws; a file that
 * cannot be read or removed is left for the next boot.
 *
 * @param {string} logPath the live log; its archives share its name as prefix
 * @param {{fs?: typeof import("fs"), path?: typeof import("path"), log?: (line: string) => void}} [deps]
 * @returns {string[]} the names actually removed
 */
function pruneLogArchives(logPath, { fs = require("fs"), path = require("path"), log = () => {} } = {}) {
  const removed = [];
  try {
    const dir = path.dirname(logPath);
    const prefix = path.basename(logPath) + ".";
    const archives = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      let st;
      try { st = fs.statSync(path.join(dir, name)); } catch { continue; }
      if (!st.isFile()) continue;
      archives.push({ name, mtimeMs: st.mtimeMs, size: st.size });
    }
    for (const name of archivesToPrune(archives)) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
        removed.push(name);
        log(`[log-rotation] pruned old archive ${name}`);
      } catch { /* keep in place; retried next boot */ }
    }
  } catch { /* directory unreadable — non-fatal */ }
  return removed;
}

module.exports = { archivesToPrune, pruneLogArchives, MAIN_LOG_ARCHIVE_KEEP_COUNT, MAIN_LOG_ARCHIVE_KEEP_BYTES };
