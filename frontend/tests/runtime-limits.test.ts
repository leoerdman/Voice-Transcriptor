import { describe, expect, it } from "vitest";
import { KEEPALIVE_MAX_BODY_BYTES, keepaliveFor } from "../src/keepalive";
import { parseRuntimeLimits } from "../src/runtime-limits";

describe("parseRuntimeLimits (FU-14)", () => {
  it("takes the backend's numbers, including ones above the renderer's old ceilings", () => {
    expect(parseRuntimeLimits({ upload_queue_max_parallel: 10, upload_queue_max_persisted_items: 5000 })).toEqual({
      uploadQueueMaxParallel: 10,
      uploadQueueMaxPersistedItems: 5000,
      rejected: [],
    });
  });

  it("reports a value that is not a positive integer instead of dropping it silently", () => {
    const r = parseRuntimeLimits({ upload_queue_max_parallel: 0, upload_queue_max_persisted_items: "x" });
    expect(r.uploadQueueMaxParallel).toBeUndefined();
    expect(r.rejected).toEqual(["upload_queue_max_parallel=0", 'upload_queue_max_persisted_items="x"']);
  });

  it("ignores a missing block or key without complaint", () => {
    expect(parseRuntimeLimits(undefined)).toEqual({ rejected: [] });
    expect(parseRuntimeLimits({})).toEqual({ rejected: [] });
  });
});

describe("keepaliveFor (FU-25)", () => {
  it("asks for keepalive only when wanted and the body fits the browser's budget", () => {
    expect(keepaliveFor("{}", true)).toBe(true);
    expect(keepaliveFor("{}", false)).toBe(false);
    expect(keepaliveFor("x".repeat(KEEPALIVE_MAX_BODY_BYTES + 1), true)).toBe(false);
  });
});
