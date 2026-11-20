import { describe, expect, it } from "vitest";
import { KEEPALIVE_MAX_BODY_BYTES, keepaliveFor } from "../src/keepalive";
import { customPresetLimitReached, parseRuntimeLimits, smallAudioUiTimeoutMs } from "../src/runtime-limits";

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

describe("backend-owned limits the renderer used to copy (FU-13a/b, FG-10)", () => {
  const published = {
    upscale_custom_preset_limit: 5,
    deepgram_small_audio_bytes: 2 * 1024 * 1024,
    deepgram_small_audio_read_timeout_ms: 20_000,
  };

  it("parses the published numbers", () => {
    expect(parseRuntimeLimits(published)).toEqual({
      upscaleCustomPresetLimit: 5,
      deepgramSmallAudioBytes: 2 * 1024 * 1024,
      deepgramSmallAudioReadTimeoutMs: 20_000,
      rejected: [],
    });
  });

  it("closes the add-preset control at the backend's limit, not at a renderer 3", () => {
    const { upscaleCustomPresetLimit } = parseRuntimeLimits(published);
    expect(customPresetLimitReached(3, upscaleCustomPresetLimit)).toBe(false);
    expect(customPresetLimitReached(5, upscaleCustomPresetLimit)).toBe(true);
    expect(customPresetLimitReached(99, undefined)).toBe(false);
  });

  it("derives the small-audio UI deadline from the backend's threshold and read timeout", () => {
    const limits = parseRuntimeLimits(published);
    const oneAndAHalfMiB = 1.5 * 1024 * 1024;
    expect(smallAudioUiTimeoutMs("deepgram", oneAndAHalfMiB, limits, 1_000)).toBe(21_000);
    expect(smallAudioUiTimeoutMs("deepgram", 3 * 1024 * 1024, limits, 1_000)).toBeNull();
    expect(smallAudioUiTimeoutMs("deepgram", 0, limits, 1_000)).toBeNull();
    expect(smallAudioUiTimeoutMs("openrouter", 1_000, limits, 1_000)).toBeNull();
    expect(smallAudioUiTimeoutMs("deepgram", 1_000, {}, 1_000)).toBeNull();
  });
});

describe("keepaliveFor (FU-25)", () => {
  it("asks for keepalive only when wanted and the body fits the browser's budget", () => {
    expect(keepaliveFor("{}", true)).toBe(true);
    expect(keepaliveFor("{}", false)).toBe(false);
    expect(keepaliveFor("x".repeat(KEEPALIVE_MAX_BODY_BYTES + 1), true)).toBe(false);
  });
});
