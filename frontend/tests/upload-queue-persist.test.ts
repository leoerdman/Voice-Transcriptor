import { describe, expect, it } from "vitest";

import { QUEUE_SAVE_RETRY, nextQueueSaveRetry } from "../src/upload-queue-persist";

describe("nextQueueSaveRetry — FQ-02: a failed queue write is retried, boundedly", () => {
  it("retries after the first failures with a doubling delay", () => {
    expect(nextQueueSaveRetry(1)).toEqual({ retryInMs: 1_000 });
    expect(nextQueueSaveRetry(2)).toEqual({ retryInMs: 2_000 });
    expect(nextQueueSaveRetry(3)).toEqual({ retryInMs: 4_000 });
  });

  it("gives up once the budget is spent (the caller tells the user)", () => {
    expect(nextQueueSaveRetry(QUEUE_SAVE_RETRY.maxAttempts)).toBeNull();
    expect(nextQueueSaveRetry(QUEUE_SAVE_RETRY.maxAttempts + 3)).toBeNull();
  });

  it("never schedules a retry for a write that has not failed", () => {
    expect(nextQueueSaveRetry(0)).toBeNull();
  });

  it("caps the delay", () => {
    expect(nextQueueSaveRetry(9, { maxAttempts: 20, baseDelayMs: 1_000, maxDelayMs: 15_000 })).toEqual({ retryInMs: 15_000 });
  });
});
