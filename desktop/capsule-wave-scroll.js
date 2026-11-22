"use strict";

// The capsule waveform's motion, as pure logic.
//
// User, 2026-11-23: "the waveform jumps left and right when I start
// speaking and when I stop. It must run continuously, the way the line runs
// from the right into the left wall."
//
// The bars used to be a list that scrolled by `progress * step`, where
// `progress` was the time since the LAST PUSH. Every irregularity of the
// page moved the bars:
//   - a push happened at the first frame at or after the tick, and the
//     overshoot was thrown away, so the phase drifted and the scroll
//     stuttered at each push;
//   - a stalled frame (the capsule's renderer shares its thread with the
//     main process's level probes) froze the bars at `progress == 1` and
//     lost the time the stall took, then a single bar was pushed;
//   - a change of mode (recording <-> auto-stop countdown, which is exactly
//     what speech and silence trigger) zeroed the push clock, so the next
//     frame pushed an extra bar at an arbitrary phase and every bar jumped
//     left by whatever fraction of a step had elapsed;
//   - a new bar was born at full height one step away from the wall.
//
// Here a bar's place is a function of TIME ALONE: it is born at the right
// wall at the moment of its tick and runs left at a constant speed, so a
// late frame draws the bars where they belong instead of where the last
// frame left them. Ticks sit on a fixed grid (`nextTickAt += tickMs`, never
// `= now`), so spacing stays even; a stall is made up by catching the grid
// up with the level held at that moment. Nothing about the mode, the level
// or the loudness changes where a bar is.
//
// The factory is injected into the capsule page by `Function#toString`
// (the page is a data: URL and cannot `require`), so it must stay
// self-contained: no closure over anything outside it.

/**
 * @param {{ stepPx: number, tickMs: number, maxBars: number, widthPx: number }} config
 *   stepPx: distance between two neighbouring bars; tickMs: time between
 *   them (their ratio is the scroll speed); maxBars: how many fit;
 *   widthPx: the canvas width the bars scroll across.
 */
function createWaveScroller(config) {
  const stepPx = Number(config.stepPx);
  const tickMs = Number(config.tickMs);
  const maxBars = Math.max(1, Math.floor(Number(config.maxBars)));
  const widthPx = Number(config.widthPx);
  const speedPxPerMs = stepPx / tickMs;
  // A bar older than this has left through the left wall.
  const lifeMs = (widthPx / speedPxPerMs) + tickMs;
  /** @type {{ t: number, v: number }[]} Oldest first; `t` is the bar's tick on the grid. */
  const samples = [];
  let nextTickAt = 0;

  return {
    speedPxPerMs,
    /** Bars alive now (for tests and the "is anything drawn" checks). */
    get size() { return samples.length; },
    /**
     * Bring the grid up to `now`, taking a bar's value from `levelAt()` for
     * every tick that has come due. A frame that was late finds several ticks
     * due and fills them all, each at its own time — the bars are evenly
     * spaced whatever the frame times were.
     */
    advance(now, levelAt) {
      if (!(nextTickAt > 0)) nextTickAt = now;
      // A gap longer than the whole strip (the page was parked, the clock
      // jumped) shows nothing older anyway: restart the grid at `now`
      // rather than push hundreds of bars.
      if (now - nextTickAt > lifeMs) nextTickAt = now;
      while (nextTickAt <= now) {
        samples.push({ t: nextTickAt, v: levelAt() });
        nextTickAt += tickMs;
      }
      while (samples.length > maxBars + 1) samples.shift();
      while (samples.length && now - samples[0].t > lifeMs) samples.shift();
    },
    /**
     * Where each bar is at `now`: `x` is its left edge before clipping, a
     * bar born at the wall starts entirely outside the canvas (x = width)
     * and slides in, so it comes out of the right wall instead of appearing.
     * Newest first.
     */
    layout(now, barWidthPx) {
      const out = [];
      for (let i = samples.length - 1; i >= 0; i -= 1) {
        const x = widthPx - Math.max(0, now - samples[i].t) * speedPxPerMs;
        const left = Math.max(0, x);
        const right = Math.min(widthPx, x + barWidthPx);
        if (right <= left) {
          if (x + barWidthPx <= 0) break;
          continue;
        }
        out.push({ x: left, w: right - left, v: samples[i].v });
      }
      return out;
    },
    /** Forget everything: the next activation starts a fresh grid. */
    reset() {
      samples.length = 0;
      nextTickAt = 0;
    },
  };
}

module.exports = { createWaveScroller };
