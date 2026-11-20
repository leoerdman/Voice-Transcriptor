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
 *   • not every failed poll is a hiccup (FQ-04). A rejected fetch, a 5xx
 *     and a 429 are transient and retried within the bounded run; a 404
 *     (the job no longer exists — backend restarted, results swept) and
 *     any other 4xx are answers that a retry cannot change, so the wait
 *     ends at once. A 404 has no job left to cancel; another 4xx may.
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

/**
 * A poll the backend answered with a non-2xx status. `fetchJob` throws it
 * so the wait can tell an HTTP answer apart from a transport failure.
 */
export class JobPollHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "JobPollHttpError";
    this.status = status;
  }
}

export type JobPollFailureKind = "transient" | "job-gone" | "terminal";

/** How the wait treats one failed poll: retried, or the end of the wait. */
export function classifyJobPollFailure(error: unknown): JobPollFailureKind {
  if (!(error instanceof JobPollHttpError)) return "transient";
  if (error.status >= 500 || error.status === 429) return "transient";
  if (error.status === 404) return "job-gone";
  return "terminal";
}

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
        const kind = classifyJobPollFailure(e);
        if (kind === "job-gone") {
          throw new JobTerminalError(e instanceof Error ? e.message : String(e));
        }
        if (kind === "terminal") throw e;
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

/**
 * Create a backend job, report the moment it exists, then wait for it.
 *
 * The creation POST resolves only after its request body has been sent
 * in full and the backend has accepted the job, so "created" is the real
 * end of an upload — the event the Upload queue's "Uploading… →
 * Processing…" label is about (FQ-06 b). The queue used to guess that
 * moment from the file size (size/10 000 ms, capped at 8 s), which said
 * "Processing…" eight seconds into a minutes-long local upload; the
 * remote path also flipped on its first poll, so two sources set the
 * same field (FQ-06 c). `onJobCreated` is now the only source, for every
 * provider. It is not called when creation fails.
 */
export async function createThenWaitForJob<C, R>(
  create: () => Promise<C>,
  wait: (created: C) => Promise<R>,
  onJobCreated?: (created: C) => void,
): Promise<R> {
  const created = await create();
  onJobCreated?.(created);
  return wait(created);
}
