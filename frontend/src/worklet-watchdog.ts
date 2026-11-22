/**
 * When the ScriptProcessor fallback is built: only once the AudioWorklet
 * has actually failed.
 *
 * It used to be pre-armed ALONGSIDE the worklet on every start, warm or
 * cold, and torn down by the worklet's first frame (BUGS_AUDIT_2026-09-03
 * §4.5). That cost a deprecated main-thread audio node per recording —
 * Chromium logs "ScriptProcessorNode is deprecated" on each one (175–232
 * of them in the logs OPTIMIZATION.md §3.7 reviewed) — to insure against
 * a worklet that connects and never delivers. Across 1450 cold starts in the logs the fallback
 * never once won: the worklet's first frame lands 36 ms after it is
 * connected at the median, 382 ms at the 99th percentile (a Bluetooth
 * input waking up — nothing captures earlier then, the fallback
 * included).
 *
 * So the worklet path now stands alone, and the fallback is reached in
 * exactly two ways:
 *
 *  - the worklet cannot be built at all (no `audioWorklet`, `addModule`
 *    or the node constructor throws) — the start path builds the
 *    fallback as the capture path right away, with nothing to lose;
 *  - the worklet is connected but has delivered nothing by the deadline
 *    — this watchdog arms the fallback in its standby mode, where its
 *    own first buffer arbitrates exactly as the pre-armed one did: if the
 *    worklet has delivered by then (a slow worklet is late, not dead, and
 *    its frames carry the audio from the start) the fallback is thrown
 *    away; if not, it becomes the capture path.
 *
 * The one price: a worklet that is truly dead loses the audio up to the
 * deadline, where the pre-armed fallback lost none. That case has no
 * occurrence in the logs; the warnings and the main-thread work had one
 * per recording.
 *
 * Pure apart from the injected timer. Unit-tested in
 * tests/worklet-watchdog.test.ts.
 */

export interface WatchdogTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class WorkletDeliveryWatchdog {
  private handle: unknown = null;

  constructor(private readonly timers: WatchdogTimers) {}

  /**
   * Check once, `deadlineMs` from now, whether the worklet has
   * `delivered`; if it has not, call `onSilent`. Re-arming replaces the
   * previous check.
   */
  arm(deadlineMs: number, delivered: () => boolean, onSilent: () => void): void {
    this.cancel();
    const handle = this.timers.setTimeout(() => {
      if (this.handle !== handle) return;
      this.handle = null;
      if (!delivered()) onSilent();
    }, Math.max(0, deadlineMs));
    this.handle = handle;
  }

  /** Drop a pending check (the take stopped or its capture was torn down). */
  cancel(): void {
    if (this.handle === null) return;
    this.timers.clearTimeout(this.handle);
    this.handle = null;
  }

  get armed(): boolean {
    return this.handle !== null;
  }
}
