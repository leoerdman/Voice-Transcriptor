import { describe, expect, it } from "vitest";

import {
  attemptFinalSave,
  decideDrainedSilence,
  resolveEpilogueSummary,
  resolveFailedStopSummary,
  resolveTranscriptStopSummary,
  runStopEpilogue,
  type DrainedSilenceInput,
  type FinalSaveOutcome,
  type StopEpilogueEffects,
  type StopEpiloguePlan,
} from "../src/stop-epilogue";

const classify = {
  isConflict: (e: unknown) => String((e as Error)?.message || "").includes("no longer exists in the target archive"),
  describe: (e: unknown) => String((e as Error)?.message || "unknown"),
};

function recorder(saveResult: FinalSaveOutcome | Error) {
  const calls: string[] = [];
  const summaries: Array<{ status: string; tone: string }> = [];
  const fx: StopEpilogueEffects = {
    publish: (signal) => calls.push(`publish:${signal.kind}:${signal.domText}`),
    hideProgress: () => calls.push("hideProgress"),
    setStatus: (label) => calls.push(`status:${label}`),
    save: async () => {
      calls.push("save");
      if (saveResult instanceof Error) throw saveResult;
      return saveResult;
    },
    release: () => calls.push("release"),
    patchSummary: (summary) => {
      calls.push("summary");
      summaries.push(summary);
    },
  };
  return { calls, summaries, fx };
}

const noProviderPlan: StopEpiloguePlan = {
  signal: { domText: "No transcription provider is selected. Audio was saved locally.", kind: "status" },
  statusLabel: "Idle",
  save: true,
  summary: { status: "Audio saved. No transcription provider is selected.", tone: "warning" },
  conflictStatus: "No provider is selected, and the original archive changed before the session metadata could be finalized.",
};

describe("attemptFinalSave — FL-02: every save failure is an outcome, not silence", () => {
  it("a successful save is 'saved'", async () => {
    expect(await attemptFinalSave(async () => ({ name: "x" }), classify)).toEqual({ kind: "saved" });
  });

  it("the archive-moved conflict is 'conflict'", async () => {
    const out = await attemptFinalSave(async () => {
      throw new Error("Recording no longer exists in the target archive");
    }, classify);
    expect(out).toEqual({ kind: "conflict" });
  });

  it("any other failure (5xx, disk full, backend restarting) is 'failed' with its message, and never throws", async () => {
    const out = await attemptFinalSave(async () => {
      throw new Error("HTTP 500: disk full");
    }, classify);
    expect(out).toEqual({ kind: "failed", message: "HTTP 500: disk full" });
  });
});

describe("runStopEpilogue — D-13: one way every no-transcript stop ends", () => {
  it("publishes, hides the progress row, sets the status, saves, releases once, then writes the summary", async () => {
    const { calls, summaries, fx } = recorder({ kind: "saved" });
    expect(await runStopEpilogue(noProviderPlan, fx)).toEqual({ kind: "saved" });
    expect(calls).toEqual([
      `publish:status:${noProviderPlan.signal.domText}`,
      "hideProgress",
      "status:Idle",
      "save",
      "release",
      "summary",
    ]);
    expect(summaries).toEqual([noProviderPlan.summary]);
  });

  it("FL-02: a failed metadata save reaches the summary instead of the success copy", async () => {
    const { summaries, fx } = recorder({ kind: "failed", message: "HTTP 503: backend restarting" });
    await runStopEpilogue(noProviderPlan, fx);
    expect(summaries).toEqual([{
      status: "Audio saved. No transcription provider is selected. Saving the session to History failed: HTTP 503: backend restarting",
      tone: "warning",
    }]);
  });

  it("the conflict warning is the summary the stop ends on, not overwritten by the ordinary copy", async () => {
    const { summaries, fx } = recorder({ kind: "conflict" });
    await runStopEpilogue(noProviderPlan, fx);
    expect(summaries).toEqual([{ status: noProviderPlan.conflictStatus, tone: "warning" }]);
  });

  it("FL-04: the session is released exactly once even when the save effect throws", async () => {
    const { calls, fx } = recorder(new Error("effect blew up"));
    await expect(runStopEpilogue(noProviderPlan, fx)).rejects.toThrow("effect blew up");
    expect(calls.filter((c) => c === "release")).toHaveLength(1);
  });

  it("a plan without a save (aborted start, discarded take) never saves and still releases", async () => {
    const { calls, fx } = recorder({ kind: "saved" });
    const out = await runStopEpilogue({
      signal: { domText: "", kind: "status" },
      statusLabel: "Idle",
      save: false,
      summary: null,
    }, fx);
    expect(out).toEqual({ kind: "not-attempted" });
    expect(calls).toEqual(["publish:status:", "hideProgress", "status:Idle", "release"]);
  });
});

describe("resolveEpilogueSummary", () => {
  it("keeps an error tone an error when the save also failed", () => {
    expect(resolveEpilogueSummary(
      { summary: { status: "Deepgram API key is missing. Audio is still saved locally.", tone: "error" } },
      { kind: "failed", message: "HTTP 500" },
    )).toEqual({
      status: "Deepgram API key is missing. Audio is still saved locally. Saving the session to History failed: HTTP 500",
      tone: "error",
    });
  });

  it("derives a conflict line when the plan names none", () => {
    expect(resolveEpilogueSummary({ summary: { status: "Audio saved.", tone: "success" } }, { kind: "conflict" })).toEqual({
      status: "Audio saved. The original archive changed before the session metadata could be finalized.",
      tone: "warning",
    });
  });
});

describe("resolveTranscriptStopSummary — FL-02 on the success path", () => {
  const base = { transcriptReady: true, noSpeechStatus: "Recording completed, no speech detected.", persistedName: "2026-11-20 rec.txt" };

  it("a saved transcript reports both available and links the entry", () => {
    expect(resolveTranscriptStopSummary({ ...base, outcome: { kind: "saved" } })).toEqual({
      status: "Final transcript is ready. Audio and transcript are both available.",
      tone: "success",
      savedName: "2026-11-20 rec.txt",
    });
  });

  it("a failed save never claims the transcript is in History", () => {
    const out = resolveTranscriptStopSummary({ ...base, outcome: { kind: "failed", message: "HTTP 500" } });
    expect(out.tone).toBe("warning");
    expect(out.status).toContain("Saving the session to History failed: HTTP 500");
    expect(out.status).not.toContain("both available");
    // The provisional save holds the audio; the entry stays linked.
    expect(out.savedName).toBe("2026-11-20 rec.txt");
  });

  it("a conflict unlinks the entry", () => {
    expect(resolveTranscriptStopSummary({ ...base, outcome: { kind: "conflict" } })).toMatchObject({ tone: "warning", savedName: "" });
  });

  it("no speech + saved keeps the no-speech copy", () => {
    expect(resolveTranscriptStopSummary({ ...base, transcriptReady: false, outcome: { kind: "saved" } }).status)
      .toBe("Recording completed, no speech detected.");
  });
});

describe("resolveFailedStopSummary — the finalization-failed catch", () => {
  it("reports the fallback save failing too", () => {
    expect(resolveFailedStopSummary({ failureMessage: "Transcription failed.", persistedName: "a.txt", outcome: { kind: "failed", message: "HTTP 500" } }))
      .toEqual({ status: "Transcription failed. Saving the session to History failed: HTTP 500", tone: "error", savedName: "a.txt" });
  });

  it("keeps the audio-available copy when the fallback save worked", () => {
    expect(resolveFailedStopSummary({ failureMessage: "Transcription failed.", persistedName: "a.txt", outcome: { kind: "saved" } }))
      .toEqual({ status: "Transcription failed. Audio is still available.", tone: "error", savedName: "a.txt" });
  });
});

const base: DrainedSilenceInput = {
  silentCapture: false,
  hasProvider: true,
  micHealthBad: false,
  carriedSpeech: false,
  liveText: "",
};

describe("decideDrainedSilence — FL-01: mic health explains an empty session, never vetoes a spoken one", () => {
  it("a mic lost mid-dictation after captured speech still goes on to transcription", () => {
    // Headset unplugged after two minutes: the tracker ends in `lost`,
    // the capture carried speech and the provider streamed text back.
    const d = decideDrainedSilence({ ...base, micHealthBad: true, carriedSpeech: true, liveText: "first two minutes" });
    expect(d).toEqual({ silent: false, micFault: false });
  });

  it("speech evidenced by the level alone (no live text yet) is enough to transcribe", () => {
    expect(decideDrainedSilence({ ...base, micHealthBad: true, carriedSpeech: true }).silent).toBe(false);
  });

  it("speech evidenced by the live transcript alone is enough to transcribe", () => {
    expect(decideDrainedSilence({ ...base, micHealthBad: true, liveText: "привет" }).silent).toBe(false);
  });

  it("whitespace-only live text is not speech", () => {
    expect(decideDrainedSilence({ ...base, micHealthBad: true, liveText: "  \n " })).toEqual({ silent: true, micFault: true });
  });

  it("a bad mic with nothing captured is an empty session, blamed on the mic", () => {
    expect(decideDrainedSilence({ ...base, micHealthBad: true })).toEqual({ silent: true, micFault: true });
  });

  it("the session's own silence verdict still ends the stop, and names the mic when it was at fault", () => {
    expect(decideDrainedSilence({ ...base, silentCapture: true })).toEqual({ silent: true, micFault: false });
    expect(decideDrainedSilence({ ...base, silentCapture: true, micHealthBad: true, carriedSpeech: true }))
      .toEqual({ silent: true, micFault: true });
  });

  it("without a provider mic health decides nothing (the no-provider epilogue owns that stop)", () => {
    expect(decideDrainedSilence({ ...base, hasProvider: false, micHealthBad: true })).toEqual({ silent: false, micFault: false });
  });

  it("a healthy, non-silent session is never empty", () => {
    expect(decideDrainedSilence(base)).toEqual({ silent: false, micFault: false });
  });
});
