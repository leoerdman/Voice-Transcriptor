"use strict";

// When a screen take's three surfaces — the capsule in its screen shape
// (with the computer button), the colour palette above it and the red
// frame on every display — are shown: together, in one step, once every
// one of them is ready (or known not to come). Never a subset first.
//
// They used to appear one after another: the capsule at once in its voice
// shape, then (after the frontmost-app lookup and the mouse helper's
// `ready`) the frames, then the palette, and only then the capsule's
// screen shape — ~550 ms of staggered pieces in the user's log
// (2026-11-20 12:28:06). Each surface is now prepared hidden and reported
// here; the presenter calls `present` exactly once with the ones that are
// ready. The mouse helper is not a surface: drawing begins when it is
// ready, the picture does not wait for it.
//
//   required  surfaces without which nothing is shown (the frames: a take
//             with no frame is not a screen take)
//   optional  surfaces shown if ready, left out if they failed (a palette
//             that failed to load: the take draws in the default colour;
//             a capsule that could not be prepared hidden: main shows it
//             its usual way)
//
// Pure — desktop/screen-surfaces.test.js.

const SCREEN_SURFACE = Object.freeze({
  CAPSULE: "capsule",
  OVERLAYS: "overlays",
  PALETTE: "palette",
});

const PRESENTER_STATE = Object.freeze({
  /** Still waiting for at least one surface. */
  PENDING: "pending",
  /** `present` ran, once, with every ready surface. */
  PRESENTED: "presented",
  /** A required surface failed: nothing was shown. */
  FAILED: "failed",
  /** The start was abandoned before the surfaces were ready: nothing shown. */
  ABORTED: "aborted",
});

/**
 * @param {{required: string[], optional?: string[], present: (ready: string[]) => void}} opts
 * @returns {{settle(name: string, ok: boolean): void, expire(): void, abort(): void,
 *   state(): string, done: Promise<string>}}
 *   `settle` reports one surface ready (ok) or failed; a second report of
 *   the same surface is ignored. `expire` counts every surface not yet
 *   reported as failed (the bound on how long the picture may wait).
 *   `done` resolves with the final state.
 */
function createSurfacePresenter({ required, optional = [], present }) {
  const names = [...required, ...optional];
  const results = new Map();
  let state = PRESENTER_STATE.PENDING;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  function finish(next) {
    state = next;
    resolveDone(next);
  }

  function decide() {
    if (state !== PRESENTER_STATE.PENDING) return;
    if (!names.every((n) => results.has(n))) return;
    if (!required.every((n) => results.get(n) === true)) {
      finish(PRESENTER_STATE.FAILED);
      return;
    }
    const ready = names.filter((n) => results.get(n) === true);
    // The state changes before `present` runs, so a present that throws
    // can never be retried into a second, partial showing.
    finish(PRESENTER_STATE.PRESENTED);
    present(ready);
  }

  return {
    settle(name, ok) {
      if (state !== PRESENTER_STATE.PENDING || !names.includes(name) || results.has(name)) return;
      results.set(name, ok === true);
      decide();
    },
    expire() {
      if (state !== PRESENTER_STATE.PENDING) return;
      for (const n of names) if (!results.has(n)) results.set(n, false);
      decide();
    },
    abort() {
      if (state === PRESENTER_STATE.PENDING) finish(PRESENTER_STATE.ABORTED);
    },
    state: () => state,
    done,
  };
}

module.exports = { PRESENTER_STATE, SCREEN_SURFACE, createSurfacePresenter };
