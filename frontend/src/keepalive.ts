/**
 * Whether a request may carry `keepalive: true`.
 *
 * A request sent while the page goes away (`pagehide`/`beforeunload`) is
 * cancelled with the page unless it is a keepalive request. Browsers cap
 * the body of keepalive requests at 64 KiB across all of them in flight;
 * over that the fetch rejects outright, and a rejected save is worse than
 * an interrupted one, so the flag is dropped for a payload that would not
 * fit. One rule for every writer that saves on the way out (the upload
 * queue snapshot, the settings autosave).
 */
export const KEEPALIVE_MAX_BODY_BYTES = 60_000;

export function keepaliveFor(payload: string, wanted: boolean): boolean {
  if (!wanted) return false;
  return new TextEncoder().encode(payload).length <= KEEPALIVE_MAX_BODY_BYTES;
}
