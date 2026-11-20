"use strict";

/**
 * Can the bundled Python import the backend — the verdict, pure.
 *
 * The boot runs `import fastapi, uvicorn, …` with the engine site on
 * PYTHONPATH; when that fails it runs the same import in a clean
 * environment to say who is at fault (BUG-82): clean passes → the engine
 * site shadows the bundle, clean fails → the bundle itself is damaged.
 *
 * A check that ran out of time says neither. The first launch after an
 * install imports a freshly written runtime that macOS scans file by file:
 * on 2026-11-21 that import outlived the old 12 s limit while the clean
 * re-run, a moment later and warm, passed — and the app blamed a healthy
 * engine site and refused to start. So the limit only guards against a
 * hang, and a timeout is its own verdict, never evidence for the other two.
 */

// Warm, the import takes 3–9 s (measured 2026-11-21); cold, after an
// install, longer than 12 s. The limit is a hang guard, not a speed bar.
const IMPORT_CHECK_TIMEOUT_MS = 90000;

const VERDICT = Object.freeze({
  OK: "ok",
  TOO_SLOW: "too-slow",
  ENGINE_SITE: "engine-site",
  BUNDLE: "bundle",
});

/**
 * @param {{ok: boolean, timedOut?: boolean}} withSite  the boot's import check
 * @param {{ok: boolean, timedOut?: boolean}|null} clean  the clean re-run;
 *   null when it was not run (only a real failure of `withSite` asks for it)
 */
function importCheckVerdict(withSite, clean) {
  if (withSite.ok) return VERDICT.OK;
  if (withSite.timedOut) return VERDICT.TOO_SLOW;
  if (!clean) throw new Error("a failed import check needs the clean re-run to be attributed");
  if (clean.timedOut) return VERDICT.TOO_SLOW;
  return clean.ok ? VERDICT.ENGINE_SITE : VERDICT.BUNDLE;
}

/** Whether `importCheckVerdict` needs the clean re-run for this result. */
function needsCleanRerun(withSite) {
  return !withSite.ok && !withSite.timedOut;
}

module.exports = { IMPORT_CHECK_TIMEOUT_MS, VERDICT, importCheckVerdict, needsCleanRerun };
