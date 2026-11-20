import { describe, expect, it } from "vitest";

import { createOfflineWarmupGate } from "../src/offline-warmup";

function harness() {
  const timers = new Map<number, () => void>();
  let next = 1;
  let warms = 0;
  const gate = createOfflineWarmupGate({
    settleMs: 15_000,
    warm: () => { warms += 1; },
    setTimer: (fn) => { const h = next++; timers.set(h, fn); return h; },
    clearTimer: (h) => { timers.delete(h); },
  });
  return {
    gate,
    warms: () => warms,
    pending: () => timers.size,
    elapse: () => { const due = Array.from(timers.values()); timers.clear(); for (const fn of due) fn(); },
  };
}

describe("createOfflineWarmupGate (BL-12)", () => {
  it("does not warm the local engine for an offline blip that ends before the settle time", () => {
    const h = harness();
    h.gate.networkChanged(false); // dark wake: Wi-Fi not back yet
    expect(h.warms()).toBe(0);
    h.gate.networkChanged(true); // back within seconds
    h.elapse();
    // Only the online flip passed through (a no-op gate for a remote provider) — no offline warm.
    expect(h.warms()).toBe(1);
    expect(h.pending()).toBe(0);
  });

  it("warms once an offline state has lasted the settle time", () => {
    const h = harness();
    h.gate.networkChanged(false);
    expect(h.pending()).toBe(1);
    h.elapse();
    expect(h.warms()).toBe(1);
  });

  it("keeps one pending warm across repeated offline reports", () => {
    const h = harness();
    h.gate.networkChanged(false);
    h.gate.networkChanged(false);
    expect(h.pending()).toBe(1);
    h.elapse();
    expect(h.warms()).toBe(1);
  });
});
