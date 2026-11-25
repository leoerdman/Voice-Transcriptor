import { describe, expect, it } from "vitest";

import {
  SPECTRUM_BARS,
  meterCaption,
  meterIsQuiet,
  meterZone,
  scorePosition,
  spectrumBars,
  spectrumEdges,
  type MeterState,
} from "../src/live-meter";

const state = (over: Partial<MeterState> = {}): MeterState => ({
  score: 0.7,
  openAt: 0.648,
  closeAt: 0.551,
  state: "open",
  withheldSec: 0,
  ...over,
});

describe("the needle", () => {
  it("clamps a score to the bar it is drawn on", () => {
    expect(scorePosition(0.7)).toBe(0.7);
    expect(scorePosition(-0.2)).toBe(0);
    expect(scorePosition(1.4)).toBe(1);
    expect(scorePosition(null)).toBe(0);
  });

  it("names the comparison the gate made", () => {
    expect(meterZone(state({ score: 0.7 }))).toBe("owner");
    expect(meterZone(state({ score: 0.6 }))).toBe("between");
    expect(meterZone(state({ score: 0.3 }))).toBe("stranger");
    expect(meterZone(state({ score: null }))).toBe("nothing");
  });

  it("reads the boundaries the gate reads", () => {
    // open is inclusive, close is not - the same rule as windowZone.
    expect(meterZone(state({ score: 0.648 }))).toBe("owner");
    expect(meterZone(state({ score: 0.5509 }))).toBe("stranger");
  });

  it("says whose voice it is, not which state the gate is in", () => {
    expect(meterCaption(state({ score: 0.7 }))).toContain("your voice");
    expect(meterCaption(state({ score: 0.3 }))).toContain("not your voice");
    expect(meterCaption(state({ score: 0.6 }))).toContain("between the lines");
    expect(meterCaption(state({ score: null }))).toContain("Nothing judged");
  });

  it("prints the number the decision was made on", () => {
    expect(meterCaption(state({ score: 0.7123 }))).toContain("0.71");
  });
});

describe("the spectrum", () => {
  it("spreads its bars logarithmically, not linearly", () => {
    // A linear spread puts 44 of 48 bars above 1 kHz, where speech has almost
    // nothing; the low harmonics, which carry the energy, get four.
    const edges = spectrumEdges(16_000, 512, SPECTRUM_BARS);
    expect(edges).toHaveLength(SPECTRUM_BARS);
    for (let i = 1; i < edges.length; i += 1) {
      expect(edges[i]).toBeGreaterThanOrEqual(edges[i - 1]);
    }
    // The first bar starts at 80 Hz, the last reaches near 8 kHz.
    expect(edges[0]).toBe(Math.round((80 / 8000) * 512));
    expect(edges[edges.length - 1]).toBe(512 - 1);
  });

  it("keeps every index inside the FFT it reads", () => {
    const edges = spectrumEdges(16_000, 256, 32);
    for (const index of edges) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(256);
    }
  });

  it("turns dBFS into bars with a quiet room at the bottom", () => {
    // getFloatFrequencyData is already dBFS: -90 is the floor, 0 is full scale.
    const flat = new Float32Array(64).fill(-90);
    expect(spectrumBars(flat, spectrumEdges(16_000, 64, 4), -90)).toEqual([0, 0, 0, 0]);
    const loud = new Float32Array(64).fill(0);
    expect(spectrumBars(loud, spectrumEdges(16_000, 64, 4), -90)).toEqual([1, 1, 1, 1]);
  });

  it("reads the peak of each band, so one strong harmonic fills its bar", () => {
    const bins = new Float32Array(64).fill(-90);
    bins[10] = -20;
    const bars = spectrumBars(bins, spectrumEdges(16_000, 64, 4), -90);
    expect(Math.max(...bars)).toBeCloseTo(70 / 90, 3);
  });

  it("survives a frame shorter than the bars it was asked for", () => {
    const bars = spectrumBars(new Float32Array(4).fill(-40), spectrumEdges(16_000, 4, 8), -90);
    expect(bars).toHaveLength(8);
    for (const bar of bars) expect(Number.isFinite(bar)).toBe(true);
  });

  it("knows a silent room from a speaking one", () => {
    expect(meterIsQuiet([0, 0.01, 0.02])).toBe(true);
    expect(meterIsQuiet([0, 0.5, 0.02])).toBe(false);
  });
});
