import { describe, expect, it } from "vitest";
import { recoverySummary } from "../src/recovery-summary";

describe("recoverySummary (FU-07)", () => {
  it("says nothing when there was nothing to recover", () => {
    expect(recoverySummary(0, 0)).toBeNull();
  });

  it("reports a partial failure next to the successes instead of hiding it", () => {
    const s = recoverySummary(2, 1)!;
    expect(s.tone).toBe("warning");
    expect(s.text).toContain("Recovered 2 interrupted recordings");
    expect(s.text).toContain("1 could not be recovered");
  });

  it("reports a full success as a success, naming the History tab", () => {
    expect(recoverySummary(1, 0)).toEqual({ text: "Recovered 1 interrupted recording into History.", tone: "success" });
  });

  it("reports a full failure and that it will be retried", () => {
    const s = recoverySummary(0, 3)!;
    expect(s.tone).toBe("warning");
    expect(s.text).toContain("Could not recover 3 interrupted recordings");
    expect(s.text).toContain("next start");
  });
});
