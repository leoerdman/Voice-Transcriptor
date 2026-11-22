"use strict";

// The waveform's motion is a function of time alone. User, 2026-11-23: "the
// waveform jumps left and right when I start speaking and stop; it must run
// continuously, the way the line runs from the right into the left wall."

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createWaveScroller } = require("./capsule-wave-scroll");

const STEP = 2.4;
const TICK = 220;
const WIDTH = 30;
const BAR = 1;
const make = () => createWaveScroller({ stepPx: STEP, tickMs: TICK, maxBars: Math.floor(WIDTH / STEP), widthPx: WIDTH });

/** Left edges of the bars, oldest first, in the order a viewer reads them. */
const xs = (scroller, now) => scroller.layout(now, BAR).map((b) => b.x).reverse();

test("a bar is born at the right wall and runs left at a constant speed", () => {
  const s = make();
  s.advance(1000, () => 0.5);
  assert.deepEqual(s.layout(1000, BAR), [], "at its tick the bar is still outside the canvas");
  const early = s.layout(1050, BAR);
  assert.equal(early.length, 1);
  assert.ok(early[0].w < BAR, "it slides in through the wall, clipped, not popped in");
  assert.equal(early[0].x + early[0].w, WIDTH);
  const a = s.layout(1100, BAR)[0].x;
  const b = s.layout(1200, BAR)[0].x;
  const c = s.layout(1300, BAR)[0].x;
  assert.ok(Math.abs((a - b) - (b - c)) < 1e-9, "equal time, equal distance");
  assert.ok(Math.abs((a - b) - (STEP / TICK) * 100) < 1e-9);
});

test("irregular frames, a stall included, never move a bar back to the right", () => {
  const s = make();
  const frames = [];
  for (let t = 1000; t < 1500; t += 16) frames.push(t);
  frames.push(2200); // a 700 ms stall: the capsule's thread was busy
  for (let t = 2216; t < 3200; t += 16) frames.push(t);
  // Follow the bar born at the first tick by its time, across all frames.
  let last = Infinity;
  for (const now of frames) {
    s.advance(now, () => 0.3);
    const oldest = s.layout(now, BAR).find((b) => b.w >= BAR);
    if (!oldest) continue;
    // The first tick is at 1000: its place is a pure function of `now`.
    const expected = WIDTH - (now - 1000) * (STEP / TICK);
    if (expected >= 0) {
      assert.ok(expected <= last + 1e-9, `bar moved right at ${now}`);
      last = expected;
    }
  }
});

test("spacing stays even after a stall: the grid is caught up, not restarted", () => {
  const s = make();
  s.advance(1000, () => 0.4);
  s.advance(1600, () => 0.4); // 600 ms with no frame, then one
  const places = xs(s, 1600);
  assert.ok(places.length >= 2, "the missed ticks were filled in");
  for (let i = 1; i < places.length; i += 1) {
    assert.ok(Math.abs((places[i] - places[i - 1]) - STEP) < 1e-9, `gap ${i} is one step`);
  }
});

test("a frame that overshoots the tick does not shift the phase", () => {
  const s = make();
  s.advance(1000, () => 0.4);
  s.advance(1237, () => 0.4); // 17 ms late
  s.advance(1445, () => 0.4);
  const places = xs(s, 1445);
  for (let i = 1; i < places.length; i += 1) {
    assert.ok(Math.abs((places[i] - places[i - 1]) - STEP) < 1e-9);
  }
});

test("the level never moves a bar: positions come from time alone", () => {
  const quiet = make();
  const loud = make();
  for (let now = 1000; now <= 2500; now += 16) {
    quiet.advance(now, () => 0);
    loud.advance(now, () => (Math.floor(now / 200) % 2 ? 0.9 : 0.05));
  }
  assert.deepEqual(quiet.layout(2500, BAR).map((b) => b.x), loud.layout(2500, BAR).map((b) => b.x));
});

test("switching the level source (recording <-> auto-stop) pushes no extra bar and moves nothing", () => {
  const s = make();
  s.advance(1000, () => 0.5);
  s.advance(1100, () => 0.5);
  const before = s.layout(1150, BAR)[0].x;
  s.advance(1150, () => 0.9); // the source changed; no tick is due
  assert.equal(s.layout(1150, BAR)[0].x, before);
  assert.equal(s.size, 1);
});

test("a long gap restarts the grid instead of pushing hundreds of bars", () => {
  const s = make();
  s.advance(1000, () => 0.5);
  s.advance(1000 + 3600000, () => 0.5);
  assert.ok(s.size <= Math.floor(WIDTH / STEP) + 1);
});

test("old bars leave through the left wall and are dropped", () => {
  const s = make();
  for (let now = 1000; now < 6000; now += 16) s.advance(now, () => 0.5);
  assert.ok(s.size <= Math.floor(WIDTH / STEP) + 1);
  assert.ok(s.layout(6000, BAR).every((b) => b.x >= 0 && b.x + b.w <= WIDTH));
});

test("reset forgets the grid: the next activation starts at its own time", () => {
  const s = make();
  s.advance(1000, () => 0.5);
  s.reset();
  assert.equal(s.size, 0);
  s.advance(9000, () => 0.5);
  assert.equal(s.size, 1);
});
