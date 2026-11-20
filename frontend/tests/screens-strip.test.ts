import { describe, expect, it } from "vitest";
import { screenThumbLabel, screensStripNote } from "../src/screens-strip";

describe("screensStripNote (FU-16)", () => {
  it("says so when screenshots exist but could not be loaded", () => {
    expect(screensStripNote(3, 3)).toBe("3 screenshots could not be loaded.");
    expect(screensStripNote(1, 1)).toBe("The screenshot could not be loaded.");
    expect(screensStripNote(1, 4)).toBe("1 of 4 screenshots could not be loaded.");
  });

  it("says nothing when every screenshot loaded", () => {
    expect(screensStripNote(0, 4)).toBeNull();
  });
});

describe("screenThumbLabel (FU-16)", () => {
  it("names the thumbnail and the action, not the file", () => {
    expect(screenThumbLabel(0, 3, false)).toBe("Screenshot 1 of 3 — expand");
    expect(screenThumbLabel(2, 3, true)).toBe("Screenshot 3 of 3 — collapse");
    expect(screenThumbLabel(0, 1, false)).toBe("Screenshot — expand");
  });
});
