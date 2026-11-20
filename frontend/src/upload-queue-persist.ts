/**
 * The write side of the upload-queue snapshot: what happens when
 * ``PUT /api/ui/upload-queue`` fails.
 *
 * FQ-02. ``./upload-queue-restore`` states the invariant for the read side
 * — never lose state the backend does not hold. The write side broke it:
 * the dirty flag was cleared BEFORE the PUT and a failure (429 from the
 * rate limiter, a 5xx while the backend restarts, a timeout) was logged
 * and forgotten. Nothing re-armed the save and nothing told the user; the
 * next launch restored the older queue and the newest uploads came back
 * as "Interrupted by app restart" or not at all.
 *
 * Now a failed write leaves the queue dirty and is retried on a bounded
 * backoff; when the retries run out the user is told once, and the next
 * change to the queue starts a fresh budget.
 */

export interface QueueSaveRetryPolicy {
  /** Failed attempts after which the renderer stops retrying on its own. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const QUEUE_SAVE_RETRY: QueueSaveRetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
};

export const UPLOAD_QUEUE_SAVE_FAILED_STATUS =
  "The upload queue could not be saved. Its latest changes will be lost if the app restarts now; they are saved again on the next change.";

/**
 * After ``failedAttempts`` consecutive failed writes: how long to wait
 * before the next one, or ``null`` when the budget is spent.
 */
export function nextQueueSaveRetry(
  failedAttempts: number,
  policy: QueueSaveRetryPolicy = QUEUE_SAVE_RETRY,
): { retryInMs: number } | null {
  if (failedAttempts < 1 || failedAttempts >= policy.maxAttempts) return null;
  return { retryInMs: Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (failedAttempts - 1)) };
}
