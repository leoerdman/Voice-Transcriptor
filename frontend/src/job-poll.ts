/**
 * Waiting for a backend transcription job (`/api/jobs/<id>`).
 *
 * The backend has no event stream for jobs, so polling is the transport;
 * what this module owns is how the wait reacts to the things that go
 * wrong around it:
 *
 *   • one failed poll (a fetch TypeError during a backend hiccup, a 5xx)
 *     used to throw out of the wait while the job kept running on the
 *     backend — a paid Deepgram/OpenRouter job nobody would collect, and
 *     a retry by the user started a second one. A short run of failures
 *     is tolerated; giving up cancels the job.
 *   • a job the BACKEND cancelled (shutdown) was reported as AbortError,
 *     the shape of "the user cancelled", which callers treat as silence.
 *     It is an AbortError only when the caller's own signal aborted.
 *   • the poll ladder (fast, then slow after a while) lived as three bare
 *     literals beside `UI_TOKENS.polling`; it is a policy object now.
 */

export interface JobPollPolicy {
  /** Interval while the job is young. */
  fastMs: number;
  /** Interval once the job has run longer than `slowAfterMs`. */
  slowMs: number;
  slowAfterMs: number;
  /** Consecutive failed polls tolerated before the wait gives up. */
  maxConsecutiveFailures: number;
}

export interface JobPollState<T> {
  status?: string;
  result?: T | null;
  error?: unknown;
  progress?: unknown;
}

export interface JobPollDeps<T> {
  fetchJob(signal: AbortSignal | undefined): Promise<JobPollState<T>>;
  /** Resolves after `ms`, rejects with an AbortError when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal | undefined): Promise<void>;
  cancel(): Promise<void> | void;
  now(): number;
  onProgress?(job: JobPollState<T>): void;
  onTransientFailure?(error: unknown, consecutive: number): void;
}

export function nextJobPollDelayMs(elapsedMs: number, policy: JobPollPolicy): number {
  return elapsedMs > policy.slowAfterMs ? policy.slowMs : policy.fastMs;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/** A terminal answer from the backend — not a transport failure, never retried. */
class JobTerminalError extends Error {}

export async function waitForJob<T>(
  deps: JobPollDeps<T>,
  policy: JobPollPolicy,
  signal?: AbortSignal,
): Promise<T> {
  const startedAt = deps.now();
  let consecutiveFailures = 0;
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      let job: JobPollState<T> | null = null;
      try {
        job = await deps.fetchJob(signal);
        consecutiveFailures = 0;
      } catch (e) {
        if (signal?.aborted) throw abortError();
        consecutiveFailures += 1;
        if (consecutiveFailures > policy.maxConsecutiveFailures) throw e;
        deps.onTransientFailure?.(e, consecutiveFailures);
      }
      if (job) {
        deps.onProgress?.(job);
        if (job.status === "done") {
          if (!job.result) throw new JobTerminalError("Job finished without a result.");
          return job.result;
        }
        if (job.status === "error") {
          throw new JobTerminalError(String(job.error || "Transcription failed."));
        }
        if (job.status === "cancelled") {
          if (signal?.aborted) throw abortError();
          throw new JobTerminalError("The backend cancelled the transcription job.");
        }
      }
      await deps.sleep(nextJobPollDelayMs(deps.now() - startedAt, policy), signal);
    }
  } catch (e) {
    // The caller's own abort cancels through its signal listener, and a
    // terminal answer means the job is already over. Anything else is a
    // wait abandoned while the job may still run: stop it.
    const aborted = e instanceof DOMException && e.name === "AbortError";
    if (!aborted && !(e instanceof JobTerminalError)) {
      await deps.cancel();
    }
    throw e;
  }
}
