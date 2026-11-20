/**
 * Which source the Live pane's "current recording" player is attached
 * to, and when a refresh may leave it alone.
 *
 * After a save the player plays the backend's copy (key: saved name +
 * archive). When that fetch fails — retention pruning makes this an
 * ordinary path — it falls back to the in-memory file under a distinct
 * key. The skip guard compared only against the backend key, so with the
 * fallback attached every later refresh (each `loadRecordings(true)`)
 * re-fetched, revoked, re-attached and restarted playback: the exact
 * symptom the guard was written to stop.
 */

export function fallbackSourceKey(backendKey: string): string {
  return `${backendKey}\nfallback-file`;
}

/** Whether the attached source already is the one this recording wants. */
export function isCurrentPlayerSource(opts: {
  desiredBackendKey: string;
  attachedKey: string;
  hasSrc: boolean;
}): boolean {
  if (!opts.desiredBackendKey || !opts.hasSrc) return false;
  return opts.attachedKey === opts.desiredBackendKey
    || opts.attachedKey === fallbackSourceKey(opts.desiredBackendKey);
}
