import { describe, expect, it } from "vitest";

import {
  clampClose,
  clampOpen,
  normalizeTuneData,
  tuneBarHeight,
  tuneDecisions,
  tuneSeconds,
  tuneSummary,
  tuneSummaryText,
  windowZone,
  type TuneWindow,
} from "../src/voice-tune";

const w = (score: number, far = false): TuneWindow => ({
  start_ms: 0,
  score,
  level_db: -26,
  far,
});

describe("normalizeTuneData", () => {
  it("reads a well-formed payload whole", () => {
    const data = normalizeTuneData({
      slot: 2,
      name: "Я",
      recording: "take.txt",
      self_floor: 0.888,
      level_db: -26.1,
      open_at: 0.648,
      close_at: 0.551,
      tuned: false,
      windows: [{ start_ms: 0, score: 0.72, level_db: -25.4, far: false }],
    });
    expect(data).not.toBeNull();
    expect(data?.slot).toBe(2);
    expect(data?.windows).toHaveLength(1);
    expect(data?.windows[0].score).toBe(0.72);
  });

  it("refuses junk rather than drawing an empty picture of it", () => {
    expect(normalizeTuneData(null)).toBeNull();
    expect(normalizeTuneData("no")).toBeNull();
    expect(normalizeTuneData({ windows: [] })).toBeNull();
  });

  it("keeps the windows it can read and drops the ones it cannot", () => {
    const data = normalizeTuneData({
      slot: 1,
      windows: [
        { score: 0.5 },
        { score: "junk" },
        "junk",
        { score: 0.9, far: true },
      ],
    });
    expect(data?.windows).toHaveLength(2);
    expect(data?.windows[1].far).toBe(true);
  });
});

describe("the sliders' clamps", () => {
  it("keeps the open inside the cosine's useful range", () => {
    expect(clampOpen(0.5)).toBe(0.5);
    expect(clampOpen(0)).toBe(0.02);
    expect(clampOpen(1.2)).toBe(0.98);
    expect(clampOpen(Number.NaN)).toBe(0.5);
  });

  it("never lets the close reach the open", () => {
    expect(clampClose(0.4, 0.6)).toBe(0.4);
    expect(clampClose(0.65, 0.6)).toBe(0.59);
    expect(clampClose(0, 0.05)).toBe(0.01);
    expect(clampClose(Number.NaN, 0.5)).toBe(0.49);
  });

  it("rounds to the third decimal the gate stores", () => {
    expect(clampOpen(0.55555)).toBe(0.556);
    expect(clampClose(0.44449, 0.6)).toBe(0.444);
  });
});

describe("the zones a strip draws", () => {
  it("splits the take at the two lines", () => {
    expect(windowZone(w(0.9), 0.65, 0.55)).toBe("kept");
    expect(windowZone(w(0.6), 0.65, 0.55)).toBe("between");
    expect(windowZone(w(0.3), 0.65, 0.55)).toBe("cut");
  });

  it("lets the level rule overrule the score", () => {
    // A window this quiet is withheld whatever it scored: a picture that
    // hid that would send the owner tuning a number not in charge.
    expect(windowZone(w(0.9, true), 0.65, 0.55)).toBe("far");
  });

  it("reads the open boundary as kept and the close as cut", () => {
    expect(windowZone(w(0.65), 0.65, 0.55)).toBe("kept");
    expect(windowZone(w(0.5499), 0.65, 0.55)).toBe("cut");
  });
});

describe("the summary under the strip", () => {
  it("counts shares over the windows the level rule left to the score", () => {
    const s = tuneSummary([w(0.9), w(0.4), w(0.6), w(0.9, true)], 0.65, 0.55);
    expect(s.total).toBe(4);
    expect(s.kept).toBe(1);
    expect(s.between).toBe(1);
    expect(s.cut).toBe(1);
    expect(s.far).toBe(1);
    // keptShare excludes the far window: the level rule already decided it.
    expect(s.keptShare).toBeCloseTo(1 / 3);
    expect(s.withheldShare).toBeCloseTo(0.5);
  });

  it("says so when there is nothing to show", () => {
    expect(tuneSummaryText(tuneSummary([], 0.65, 0.55))).toContain(
      "no window",
    );
  });

  it("names the two shares the owner is tuning against", () => {
    const text = tuneSummaryText(tuneSummary([w(0.9), w(0.4)], 0.65, 0.55));
    expect(text).toContain("50% of your scored windows pass");
    expect(text).toContain("50% of the take is withheld");
  });

  it("points at the band between the lines when it exists", () => {
    const text = tuneSummaryText(tuneSummary([w(0.6)], 0.65, 0.55));
    expect(text).toContain("1 sit between the lines");
  });
});

describe("the strip's drawing helpers", () => {
  it("gives every bar a height in percent", () => {
    expect(tuneBarHeight(0.72)).toBe(72);
    expect(tuneBarHeight(1.2)).toBe(100);
    expect(tuneBarHeight(-0.5)).toBe(0);
    expect(tuneBarHeight(Number.NaN)).toBe(0);
  });

  it("stamps bars with a clock a person reads", () => {
    expect(tuneSeconds(0)).toBe("0:00");
    expect(tuneSeconds(65_000)).toBe("1:05");
    expect(tuneSeconds(125_400)).toBe("2:05");
  });

  it("maps every window to exactly one zone", () => {
    const zones = tuneDecisions([w(0.9), w(0.6), w(0.3), w(0.2, true)], 0.65, 0.55);
    expect(zones).toEqual(["kept", "between", "cut", "far"]);
  });
});
