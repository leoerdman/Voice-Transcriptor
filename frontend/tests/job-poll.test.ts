import { describe, expect, it } from "vitest";
import { nextJobPollDelayMs, waitForJob, type JobPollPolicy, type JobPollState } from "../src/job-poll";

const policy: JobPollPolicy = { fastMs: 900, slowMs: 3_000, slowAfterMs: 30_000, maxConsecutiveFailures: 3 };

function harness(answers: Array<JobPollState<string> | Error>) {
  let clock = 0;
  const log: string[] = [];
  const deps = {
    fetchJob: async () => {
      const next = answers.shift();
      if (!next) throw new Error("no more answers");
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async (ms: number) => { clock += ms; log.push(`sleep:${ms}`); },
    cancel: async () => { log.push("cancel"); },
    now: () => clock,
  };
  return { deps, log };
}

describe("waitForJob (FG-13)", () => {
  it("survives a transient poll failure instead of abandoning a running job", async () => {
    const { deps, log } = harness([
      { status: "running" },
      new TypeError("Failed to fetch"),
      { status: "done", result: "text" },
    ]);
    await expect(waitForJob(deps, policy)).resolves.toBe("text");
    expect(log).not.toContain("cancel");
  });

  it("gives up after the tolerated run of failures and cancels the job it leaves behind", async () => {
    const { deps, log } = harness([
      { status: "running" },
      new Error("HTTP 502"),
      new Error("HTTP 502"),
      new Error("HTTP 502"),
      new Error("HTTP 502"),
    ]);
    await expect(waitForJob(deps, policy)).rejects.toThrow("HTTP 502");
    expect(log[log.length - 1]).toBe("cancel");
  });

  it("reports a job the backend cancelled as an error, not as the user's abort", async () => {
    const { deps, log } = harness([{ status: "cancelled" }]);
    const err = await waitForJob(deps, policy).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).not.toBe("AbortError");
    expect(log).not.toContain("cancel");
  });

  it("is an AbortError when the caller aborted, and leaves cancelling to the caller's listener", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const { deps, log } = harness([{ status: "running" }]);
    const err = await waitForJob(deps, policy, ctl.signal).catch((e: unknown) => e);
    expect((err as DOMException).name).toBe("AbortError");
    expect(log).not.toContain("cancel");
  });

  it("does not cancel a job that ended in error on the backend", async () => {
    const { deps, log } = harness([{ status: "error", error: "bad audio" }]);
    await expect(waitForJob(deps, policy)).rejects.toThrow("bad audio");
    expect(log).not.toContain("cancel");
  });

  it("slows the ladder once the job is old", () => {
    expect(nextJobPollDelayMs(1_000, policy)).toBe(900);
    expect(nextJobPollDelayMs(30_001, policy)).toBe(3_000);
  });
});
