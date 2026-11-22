import { describe, it, expect } from "vitest";

import { MIC_ALIVE_PEAK, createMicWakeTracker } from "../src/mic-wake";

describe("mic wake tracker", () => {
  it("a first frame that already has sound is no wake at all", () => {
    const t = createMicWakeTracker();
    const o = t.observe(0.01, 10);
    expect(o).toEqual({ waking: false, justWoke: false, silentMs: 0, beganDead: false });
    expect(t.waking).toBe(false);
  });

  it("dead frames keep the microphone waking and add up their audio time", () => {
    const t = createMicWakeTracker();
    const a = t.observe(0, 10.67);
    expect(a.waking).toBe(true);
    expect(a.beganDead).toBe(true);
    expect(a.justWoke).toBe(false);
    const b = t.observe(0, 10.67);
    expect(b.beganDead).toBe(false);
    expect(b.silentMs).toBeCloseTo(21.34, 5);
    expect(t.waking).toBe(true);
  });

  it("the first live frame after dead ones is the wake, with the dead time", () => {
    const t = createMicWakeTracker();
    for (let i = 0; i < 4; i++) t.observe(0, 20);
    const woke = t.observe(0.002, 20);
    expect(woke.justWoke).toBe(true);
    expect(woke.waking).toBe(false);
    expect(woke.silentMs).toBe(80);
    expect(t.waking).toBe(false);
    expect(t.silentMs).toBe(80);
  });

  it("the wake is announced once; later frames, even silent ones, do not undo it", () => {
    const t = createMicWakeTracker();
    t.observe(0, 20);
    expect(t.observe(0.01, 20).justWoke).toBe(true);
    expect(t.observe(0, 20)).toEqual({ waking: false, justWoke: false, silentMs: 20, beganDead: false });
    expect(t.observe(0.3, 20).justWoke).toBe(false);
  });

  it("dead means int16 == 0 in the recording: below half an LSB is still dead", () => {
    const t = createMicWakeTracker();
    expect(t.observe(MIC_ALIVE_PEAK * 0.9, 10).waking).toBe(true);
    expect(Math.round(MIC_ALIVE_PEAK * 0x7fff)).toBe(1);
    expect(Math.round(MIC_ALIVE_PEAK * 0.9 * 0x7fff)).toBe(0);
    expect(t.observe(MIC_ALIVE_PEAK, 10).justWoke).toBe(true);
  });

  it("a headset's own noise floor (|x| 5..50 of 32768) counts as awake", () => {
    const t = createMicWakeTracker();
    t.observe(0, 30);
    expect(t.observe(5 / 32768, 30).justWoke).toBe(true);
  });

  it("a stuck-at-zero device stays waking and never throws", () => {
    const t = createMicWakeTracker();
    let last = t.observe(0, 10);
    for (let i = 0; i < 1000; i++) last = t.observe(0, 10);
    expect(last.waking).toBe(true);
    expect(last.silentMs).toBe(10010);
  });

  it("garbage input is dead, never a wake", () => {
    const t = createMicWakeTracker();
    expect(t.observe(Number.NaN, Number.NaN).waking).toBe(true);
    expect(t.silentMs).toBe(0);
    expect(t.observe(-1, 10).waking).toBe(true);
  });

  it("is waking only after a frame has been seen", () => {
    const t = createMicWakeTracker();
    expect(t.waking).toBe(false);
    t.observe(0, 10);
    expect(t.waking).toBe(true);
  });
});
