import { describe, expect, it } from "vitest";

import {
  EMPTY_SCREEN_ANNOTATION,
  annotateTranscript,
  parseScreenManifest,
  screenAnnotationFromManifest,
  type ScreenAnnotation,
  type ScreenMark,
} from "../src/screen-annotations";
import {
  attemptFinalSave,
  createSessionMetadataSaver,
  decideDrainedSilence,
  EMPTY_FINAL_STATUS,
  emptyFinalKeepsLiveText,
  keepLiveTranscript,
  keptTranscriptText,
  resolveEmptyFinalSummary,
  NOTHING_KEPT,
  resolveEpilogueSummary,
  resolveFailedStopSummary,
  resolveSessionTitle,
  resolveTranscriptStopSummary,
  runStopEpilogue,
  withKeptNote,
  type DrainedSilenceInput,
  type FinalSaveOutcome,
  type SessionSaveRequest,
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


/** Inline marks with no header or sections — what these suites place. */
const marksOnlyAnnotation = (marks: ScreenMark[]): ScreenAnnotation => ({ marks, header: "", sections: [] });

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

describe("createSessionMetadataSaver — the History entry a stop writes", () => {
  function saverWith(opts: { liveSourceText: string; target?: { name: string; archiveDir: string }; fail?: Error }) {
    const requests: SessionSaveRequest[] = [];
    const save = createSessionMetadataSaver({
      target: () => opts.target || { name: "rec-1", archiveDir: "/archive" },
      liveSourceText: () => opts.liveSourceText,
      fallbackTitle: "Recording 20.11.2026",
      save: async (request) => {
        requests.push(request);
        if (opts.fail) throw opts.fail;
        return { name: request.name };
      },
      classify,
    });
    return { save, requests };
  }

  it("names the entry after the final transcript when it differs from the live text", async () => {
    const { save, requests } = saverWith({ liveSourceText: "draft words the live stream heard" });
    expect(await save({
      spokenTranscript: "The final transcript the recovery pass produced",
      transcriptText: "The final transcript the recovery pass produced",
      provider: "deepgram",
    })).toEqual({ kind: "saved" });
    expect(requests).toHaveLength(1);
    expect(requests[0].title).toBe("The final transcript the recovery pass produced");
    // The live text is still archived as the source it is.
    expect(requests[0].sourceText).toBe("draft words the live stream heard");
    expect(requests[0].transcriptText).toBe("The final transcript the recovery pass produced");
  });

  it("names the entry after the final transcript when the live stream said nothing (local provider)", async () => {
    const { save, requests } = saverWith({ liveSourceText: "" });
    await save({
      spokenTranscript: "Привет это локальная расшифровка",
      transcriptText: "Привет это локальная расшифровка",
      provider: "local",
    });
    expect(requests[0].title).toBe("Привет это локальная расшифровка");
  });

  it("names a screen recording after what was said, while History keeps the marks", async () => {
    const spoken = "one two three four";
    const marked = annotateTranscript(spoken, marksOnlyAnnotation([{ atMs: 0, text: "[Screenshot 0:00]" }]), { durationMs: 10_000 });
    expect(marked.startsWith("[Screenshot 0:00]")).toBe(true);
    const { save, requests } = saverWith({ liveSourceText: "" });
    await save({ spokenTranscript: spoken, transcriptText: marked, provider: "deepgram" });
    expect(requests[0].title).toBe("one two three four");
    expect(requests[0].transcriptText).toBe(marked);
    // History counts words in what was said, not in the marks.
    expect(requests[0].spokenText).toBe(spoken);
  });

  it("without a transcript falls back to the live text, then to the default name", async () => {
    const live = saverWith({ liveSourceText: "what the live stream heard" });
    await live.save({ spokenTranscript: "", transcriptText: "[ Silence ]", provider: "deepgram" });
    expect(live.requests[0].title).toBe("what the live stream heard");
    expect(live.requests[0].transcriptText).toBe("[ Silence ]");
    const none = saverWith({ liveSourceText: "  " });
    await none.save({ spokenTranscript: "   ", transcriptText: "", provider: "" });
    expect(none.requests[0].title).toBe("Recording 20.11.2026");
  });

  it("updates the provisional entry when there is one and creates none otherwise", async () => {
    const existing = saverWith({ liveSourceText: "x" });
    await existing.save({ spokenTranscript: "x", transcriptText: "x", provider: "p" });
    expect(existing.requests[0]).toMatchObject({ name: "rec-1", archiveDir: "/archive", requireExisting: true, provider: "p" });
    const fresh = saverWith({ liveSourceText: "x", target: { name: "", archiveDir: "" } });
    await fresh.save({ spokenTranscript: "x", transcriptText: "x", provider: "p" });
    expect(fresh.requests[0].requireExisting).toBe(false);
  });

  it("a failing save is a classified outcome, never a throw", async () => {
    const conflict = saverWith({ liveSourceText: "", fail: new Error("Recording no longer exists in the target archive") });
    expect(await conflict.save({ spokenTranscript: "a", transcriptText: "a", provider: "p" })).toEqual({ kind: "conflict" });
    const failed = saverWith({ liveSourceText: "", fail: new Error("disk full") });
    expect(await failed.save({ spokenTranscript: "a", transcriptText: "a", provider: "p" }))
      .toEqual({ kind: "failed", message: "disk full" });
  });
});

describe("resolveSessionTitle — titles come from what was SAID", () => {
  it("prefers the spoken transcript, then the live text, then the default", () => {
    expect(resolveSessionTitle("final words", "live words", "D")).toBe("final words");
    expect(resolveSessionTitle("", "live words", "D")).toBe("live words");
    expect(resolveSessionTitle(" \n", "", "D")).toBe("D");
  });
});

describe("keepLiveTranscript — a take without a final transcript keeps its live text and marks", () => {
  const marks = screenAnnotationFromManifest(parseScreenManifest({
    version: 2,
    id: "screen-20261120-100000-000",
    dir: "/rec/take.screens",
    startedAt: 1_000_000,
    audioStartedAt: 1_000_000,
    events: [
      { type: "stroke", at: 1_001_000, endedAt: 1_002_000, color: "#ff3b30", shot: 1, n: 1, tool: "pen", shape: "loop", box: { x: 70, y: 50, w: 8, h: 6 } },
      { type: "shot", at: 1_009_000, shot: 1, files: ["/rec/take.screens/shot-01.png"], area: "window", strokes: 1 },
    ],
  })!);

  it("places the marks in the live text by the one composer", () => {
    const kept = keepLiveTranscript("вот тут кнопка съехала вправо", marks, 10_000);
    expect(kept.text).toBe(annotateTranscript("вот тут кнопка съехала вправо", marks, { durationMs: 10_000 }));
    expect(kept.text).toContain("shot-01.png");
    expect(kept.text).toContain("кнопка");
    expect(kept.note).toBe("The live text and the screen marks are kept as the transcript.");
  });

  it("a screen take drawn without speaking keeps its marks alone", () => {
    const kept = keepLiveTranscript("  ", marks, 10_000);
    expect(kept.text).toBe([
      marks.header,
      "### Скрин 1 · 00:00–00:09 · shot-01.png\nШтрихи: 1 — 70–78% × 50–56%\n[✏️1 красный обвод, справа]",
    ].join("\n\n"));
    expect(kept.note).toBe("The screen marks are kept as the transcript.");
  });

  it("a voice take keeps its live text", () => {
    expect(keepLiveTranscript(" hello there ", EMPTY_SCREEN_ANNOTATION, 5_000)).toEqual({
      text: "hello there",
      note: "The live text is kept as the transcript.",
      spoken: true,
      words: "hello there",
      screen: EMPTY_SCREEN_ANNOTATION,
    });
  });

  it("a take with neither keeps nothing", () => {
    expect(keepLiveTranscript("", EMPTY_SCREEN_ANNOTATION, 5_000)).toEqual(NOTHING_KEPT);
  });
});

describe("runStopEpilogue — a failed stop keeps the live text with marks in the panel and History", () => {
  function keptRecorder() {
    const published: Array<{ domText: string; panelText: string }> = [];
    const saved: string[] = [];
    const spoken: string[] = [];
    const summaries: Array<{ status: string; tone: string }> = [];
    const fx: StopEpilogueEffects = {
      publish: (signal, panelText) => published.push({ domText: signal.domText, panelText }),
      hideProgress: () => {},
      setStatus: () => {},
      save: async (transcriptText, spokenTranscript) => {
        saved.push(transcriptText);
        spoken.push(spokenTranscript);
        return { kind: "saved" };
      },
      release: () => {},
      patchSummary: (summary) => summaries.push(summary),
    };
    return { published, saved, spoken, summaries, fx };
  }
  const kept = keepLiveTranscript("live words [mark]", EMPTY_SCREEN_ANNOTATION, 1_000);

  it("mic not delivering audio: the capsule gets the status, the panel and History the reason above the kept marks", async () => {
    const { published, saved, spoken, summaries, fx } = keptRecorder();
    const marksOnly = keepLiveTranscript("", marksOnlyAnnotation([{ atMs: 0, text: "[📸 00:00 скрин 1: /x/shot-01.png]" }]), 1_000);
    await runStopEpilogue({
      signal: { domText: "[ Mic not delivering audio ]", kind: "error" },
      statusLabel: "Done",
      save: true,
      summary: { status: "The microphone delivered no audio.", tone: "error" },
      transcriptText: "[ Mic not delivering audio ]",
      kept: marksOnly,
    }, fx);
    const stored = `[ Mic not delivering audio ]\n\n${marksOnly.text}`;
    expect(published).toEqual([{ domText: "[ Mic not delivering audio ]", panelText: stored }]);
    expect(saved).toEqual([stored]);
    // Nothing was said: the marks and the reason are not words.
    expect(spoken).toEqual([""]);
    expect(summaries[0].status).toBe("The microphone delivered no audio. The screen marks are kept as the transcript.");
  });

  it("auto transcribe off / no key: the live text is shown and saved, not a status line", async () => {
    const { published, saved, summaries, fx } = keptRecorder();
    await runStopEpilogue({ ...noProviderPlan, kept }, fx);
    expect(published[0].panelText).toBe("live words [mark]");
    expect(published[0].domText).toBe(noProviderPlan.signal.domText);
    expect(saved).toEqual(["live words [mark]"]);
    expect(summaries[0].status).toBe(`${noProviderPlan.summary?.status} ${kept.note}`);
  });

  it("silence with nothing kept still shows and saves its status line", async () => {
    const { published, saved, summaries, fx } = keptRecorder();
    await runStopEpilogue({
      signal: { domText: "[ Silence ]", kind: "status" },
      statusLabel: "Done",
      save: true,
      summary: { status: "Silence detected.", tone: "success" },
      transcriptText: "[ Silence ]",
    }, fx);
    expect(published).toEqual([{ domText: "[ Silence ]", panelText: "[ Silence ]" }]);
    expect(saved).toEqual(["[ Silence ]"]);
    expect(summaries[0].status).toBe("Silence detected.");
  });

  it("empty final with live text: the take keeps the live text instead of 'no speech detected'", () => {
    expect(emptyFinalKeepsLiveText("", "слова из превью")).toBe(true);
    expect(emptyFinalKeepsLiveText("final words", "слова из превью")).toBe(false);
    // Nothing live either: the old ending (marks alone, or no speech).
    expect(emptyFinalKeepsLiveText("", "  ")).toBe(false);
    expect(resolveEmptyFinalSummary(kept, { kind: "saved" })).toEqual({
      status: `${EMPTY_FINAL_STATUS} ${kept.note}`,
      tone: "warning",
    });
    expect(resolveEmptyFinalSummary(kept, { kind: "failed", message: "HTTP 503" }).status)
      .toBe(`${EMPTY_FINAL_STATUS} ${kept.note} Saving the session to History failed: HTTP 503`);
  });

  it("transcription threw: the failed-stop summary says the live text is kept", () => {
    const summary = withKeptNote(resolveFailedStopSummary({
      failureMessage: "Transcription failed.",
      persistedName: "take.txt",
      outcome: { kind: "saved" },
    }), kept);
    expect(summary).toEqual({
      status: "Transcription failed. Audio is still available. The live text is kept as the transcript.",
      tone: "error",
      savedName: "take.txt",
    });
  });
});

describe("a screen take with no speech keeps its header first", () => {
  it("the reason heads the body: header, reason, then each screenshot's section with its marks", () => {
    const screen = screenAnnotationFromManifest(parseScreenManifest({
      version: 2,
      dir: "/rec/take.screens",
      startedAt: 1_000_000,
      audioStartedAt: 1_000_000,
      events: [
        { type: "stroke", at: 1_001_000, endedAt: 1_002_000, color: "#ffcc00", shot: 1, n: 1, shape: "loop", box: { x: 10, y: 10, w: 10, h: 10 } },
        { type: "shot", at: 1_003_000, shot: 1, files: ["/rec/take.screens/shot-01.png"], area: "window" },
      ],
    })!);
    const kept = keepLiveTranscript("", screen, 5_000);
    expect(keptTranscriptText(kept, "[ Silence ]")).toBe([
      screen.header,
      "[ Silence ]",
      "### Скрин 1 · 00:00–00:03 · shot-01.png\nШтрихи: 1 — 10–20% × 10–20%\n[✏️1 жёлтый обвод, вверху слева]",
    ].join("\n\n"));
  });
});

describe("review findings, 2026-11-20", () => {
  it("a silent take that drew keeps the reason above its marks", () => {
    const mark = "[✏️1 скрин 1: штрих, в центре]";
    const marksOnly = keepLiveTranscript("", marksOnlyAnnotation([{ atMs: 2_000, text: mark }]), 10_000);
    expect(keptTranscriptText(marksOnly, "[ Silence ]")).toBe(`[ Silence ]\n\n${mark}`);
    expect(keptTranscriptText({ ...marksOnly, spoken: true }, "[ Silence ]")).toBe(marksOnly.text);
    expect(keptTranscriptText(NOTHING_KEPT, "[ Mic not delivering audio ]")).toBe("[ Mic not delivering audio ]");
    expect(keepLiveTranscript("привет", EMPTY_SCREEN_ANNOTATION, 1000).spoken).toBe(true);
    expect(keepLiveTranscript("", EMPTY_SCREEN_ANNOTATION, 1000).spoken).toBe(false);
  });
});
