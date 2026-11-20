"use strict";

// The screen-surface presenter (desktop/screen-surfaces.js): the capsule,
// the palette and the frames are shown together, once, or not at all —
// never a subset first.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { PRESENTER_STATE, SCREEN_SURFACE, createSurfacePresenter } = require("./screen-surfaces");

const { CAPSULE, OVERLAYS, PALETTE } = SCREEN_SURFACE;

function presenter() {
  const shown = [];
  const p = createSurfacePresenter({
    required: [OVERLAYS],
    optional: [CAPSULE, PALETTE],
    present: (ready) => shown.push(ready),
  });
  return { p, shown };
}

test("nothing is shown while any surface is still on its way, whatever order they get ready in", () => {
  for (const order of [[OVERLAYS, CAPSULE, PALETTE], [CAPSULE, PALETTE, OVERLAYS], [PALETTE, OVERLAYS, CAPSULE]]) {
    const { p, shown } = presenter();
    p.settle(order[0], true);
    p.settle(order[1], true);
    assert.deepEqual(shown, [], `a subset was shown after ${order.slice(0, 2).join(", ")}`);
    p.settle(order[2], true);
    assert.equal(shown.length, 1);
    assert.deepEqual([...shown[0]].sort(), [CAPSULE, OVERLAYS, PALETTE].sort());
    assert.equal(p.state(), PRESENTER_STATE.PRESENTED);
  }
});

test("all three are shown in ONE present call, and only once", () => {
  const { p, shown } = presenter();
  p.settle(OVERLAYS, true);
  p.settle(CAPSULE, true);
  p.settle(PALETTE, true);
  p.settle(PALETTE, true);
  p.expire();
  assert.equal(shown.length, 1);
});

test("an optional surface that failed is left out; the others still show together", () => {
  const { p, shown } = presenter();
  p.settle(PALETTE, false);
  p.settle(OVERLAYS, true);
  assert.deepEqual(shown, []);
  p.settle(CAPSULE, true);
  assert.deepEqual(shown, [[OVERLAYS, CAPSULE]]);
});

test("no frame means nothing at all is shown", async () => {
  const { p, shown } = presenter();
  p.settle(CAPSULE, true);
  p.settle(PALETTE, true);
  p.settle(OVERLAYS, false);
  assert.deepEqual(shown, []);
  assert.equal(await p.done, PRESENTER_STATE.FAILED);
});

test("an abandoned start shows nothing, even if the surfaces get ready afterwards", async () => {
  const { p, shown } = presenter();
  p.settle(OVERLAYS, true);
  p.abort();
  p.settle(CAPSULE, true);
  p.settle(PALETTE, true);
  assert.deepEqual(shown, []);
  assert.equal(await p.done, PRESENTER_STATE.ABORTED);
});

test("the wait is bounded: expiry counts the late surfaces as failed", async () => {
  const { p, shown } = presenter();
  p.settle(OVERLAYS, true);
  p.settle(PALETTE, true);
  p.expire(); // the capsule never answered
  assert.equal(shown.length, 1);
  assert.equal(shown[0].includes(CAPSULE), false);
  assert.equal(await p.done, PRESENTER_STATE.PRESENTED);

  const late = presenter();
  late.p.settle(CAPSULE, true);
  late.p.expire(); // the frames never loaded
  assert.deepEqual(late.shown, []);
  assert.equal(await late.p.done, PRESENTER_STATE.FAILED);
});
