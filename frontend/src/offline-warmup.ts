/**
 * When an internet-state flip may warm the local engine (BL-12).
 *
 * Going offline collapses a remote provider to the local fallback, so the
 * renderer warms the local Whisper model ahead of the first local window.
 * It used to do that on EVERY flip to offline — and a machine waking from
 * sleep reports a few seconds of "offline" before Wi-Fi is back. The
 * support log: ~50 loads of the ~700 MB model in 18 days for a user who
 * transcribed locally 4 times, 31 of them within 30 min of a power event,
 * every one released again after 600 s idle.
 *
 * The rule now: an offline state warms only once it has lasted
 * ``settleMs``; coming back online before that cancels it. Coming online
 * is passed through at once (the warm-up gate itself decides whether a
 * local engine is still in use, so it is a no-op for a remote provider).
 *
 * Timers are injected so the rule is testable without a clock.
 */

export interface OfflineWarmupDeps {
  settleMs: number;
  /** The warm-up itself (``scheduleLocalWarmup``: a no-op unless a local engine is in use). */
  warm: () => void;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

export interface OfflineWarmupGate {
  /** Report an internet-state FLIP (not every probe). */
  networkChanged(online: boolean): void;
}

export function createOfflineWarmupGate(deps: OfflineWarmupDeps): OfflineWarmupGate {
  const setTimer = deps.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => window.clearTimeout(handle));
  let pending = 0;
  return {
    networkChanged(online: boolean): void {
      if (pending) {
        clearTimer(pending);
        pending = 0;
      }
      if (online) {
        deps.warm();
        return;
      }
      pending = setTimer(() => {
        pending = 0;
        deps.warm();
      }, deps.settleMs);
    },
  };
}
