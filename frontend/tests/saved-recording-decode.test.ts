import { describe, expect, it } from "vitest";

import {
  runSavedRecordingDecode,
  savedDecodeFailureView,
  type SavedDecodePlan,
  type SavedDecodeStep,
} from "../src/saved-recording-decode";

type Answer = string | Error;

function harness(answers: { onDisk?: Answer; audio?: string | null | Error; upload?: Answer; local?: Answer }) {
  const calls: string[] = [];
  const steps: SavedDecodeStep[] = [];
  const answer = async (name: string, a: Answer | undefined): Promise<string> => {
    calls.push(name);
    if (a === undefined) throw new Error(`${name}: unexpected call`);
    if (a instanceof Error) throw a;
    return a;
  };
  return {
    calls,
    steps,
    deps: {
      deepgramOnDisk: () => answer("on-disk", answers.onDisk),
      fetchAudio: async () => {
        calls.push("fetch");
        if (answers.audio instanceof Error) throw answers.audio;
        return answers.audio === undefined ? "audio-bytes" : answers.audio;
      },
      deepgramUpload: (audio: string) => answer(`upload:${audio}`, answers.upload),
      localDecode: (audio: string) => answer(`local:${audio}`, answers.local),
      now: () => 0,
      onStep: (s: SavedDecodeStep) => { steps.push(s); },
    },
  };
}

const persistedWithKey: SavedDecodePlan = {
  persisted: true,
  deepgram: { model: "nova-3", unavailableReason: "" },
  localModel: "large-v3",
};

// The stop path's recovery (stopLive, no final envelope) as it behaved
// before FL-08: on-disk Deepgram for a persisted take, the upload route
// when that failed / heard nothing / the take was not persisted, then
// local Whisper; Deepgram skipped when the probe says offline; every
// failure swallowed into "".
describe("FL-08 · the stop path's recovery outcomes are kept", () => {
  it("a persisted take is decoded in place by Deepgram; no audio is fetched", async () => {
    const h = harness({ onDisk: " hello " });
    const r = await runSavedRecordingDecode(persistedWithKey, h.deps);
    expect(r).toMatchObject({ text: "hello", provider: "deepgram", model: "nova-3" });
    expect(h.calls).toEqual(["on-disk"]);
  });

  it("on-disk failure falls back to the upload route, then to local", async () => {
    const h = harness({ onDisk: new Error("HTTP 502"), upload: new Error("HTTP 502"), local: "привет" });
    const r = await runSavedRecordingDecode(persistedWithKey, h.deps);
    expect(r).toMatchObject({ text: "привет", provider: "local", model: "large-v3" });
    expect(h.calls).toEqual(["on-disk", "fetch", "upload:audio-bytes", "local:audio-bytes"]);
  });

  it("on-disk that hears nothing still tries the upload route", async () => {
    const h = harness({ onDisk: "", upload: "late words" });
    const r = await runSavedRecordingDecode(persistedWithKey, h.deps);
    expect(r.text).toBe("late words");
    expect(h.calls).toEqual(["on-disk", "fetch", "upload:audio-bytes"]);
  });

  it("an unpersisted take skips the on-disk route", async () => {
    const h = harness({ upload: "words" });
    const r = await runSavedRecordingDecode({ ...persistedWithKey, persisted: false }, h.deps);
    expect(r.text).toBe("words");
    expect(h.calls).toEqual(["fetch", "upload:audio-bytes"]);
  });

  it("offline: Deepgram is not called; local decodes", async () => {
    const h = harness({ local: "words" });
    const plan = { ...persistedWithKey, deepgram: { model: "nova-3", unavailableReason: "Deepgram is unavailable because the internet probe is offline." } };
    const r = await runSavedRecordingDecode(plan, h.deps);
    expect(r).toMatchObject({ text: "words", provider: "local" });
    expect(h.calls).toEqual(["fetch", "local:audio-bytes"]);
  });

  it("no key: straight to local, and the status names no failure", async () => {
    const h = harness({ local: "words" });
    await runSavedRecordingDecode({ ...persistedWithKey, deepgram: null }, h.deps);
    expect(h.steps).toEqual([{ provider: "local", model: "large-v3", afterFailure: false }]);
  });

  it("everything failing yields \"\" and never throws", async () => {
    const h = harness({ onDisk: new Error("a"), upload: new Error("b"), local: new Error("c") });
    const r = await runSavedRecordingDecode(persistedWithKey, h.deps);
    expect(r).toMatchObject({ text: "", provider: "" });
    expect(r.attempts.map((a) => a.route)).toEqual(["on-disk", "upload", "local"]);
  });

  it("no audio to read: no local step, \"\"", async () => {
    const h = harness({ onDisk: new Error("a"), audio: null });
    const r = await runSavedRecordingDecode(persistedWithKey, h.deps);
    expect(r.text).toBe("");
    expect(h.calls).toEqual(["on-disk", "fetch"]);
    expect(h.steps.map((s) => s.provider)).toEqual(["deepgram"]);
  });

  it("the audio is fetched once for both the upload and the local step", async () => {
    const h = harness({ onDisk: new Error("a"), upload: "", local: "x" });
    await runSavedRecordingDecode(persistedWithKey, h.deps);
    expect(h.calls.filter((c) => c === "fetch")).toHaveLength(1);
  });

  it("an aborted signal (the stop budget expired) ends the chain before the next step", async () => {
    const ac = new AbortController();
    const h = harness({ onDisk: "", local: "never" });
    h.deps.deepgramOnDisk = async () => { h.calls.push("on-disk"); ac.abort(); throw new DOMException("Aborted", "AbortError"); };
    const r = await runSavedRecordingDecode(persistedWithKey, h.deps, ac.signal);
    expect(r.text).toBe("");
    expect(h.calls).toEqual(["on-disk"]);
  });
});

// Re-transcribe as it behaved before FL-08: Deepgram when a key is
// configured, local Whisper otherwise or after it; the status says
// "Deepgram failed — trying local" after a Deepgram failure; the result
// names the providers tried; the error shown is the last failure, with
// Deepgram's as "First:" when both ran; an offline probe surfaced as
// Deepgram's failure (remoteJobSync threw the offline message).
describe("FL-08 · Re-transcribe's outcomes are kept", () => {
  it("Deepgram's text wins and is labelled Deepgram", async () => {
    const h = harness({ onDisk: "text" });
    const r = await runSavedRecordingDecode(persistedWithKey, h.deps);
    expect(r.provider).toBe("deepgram");
    expect(savedDecodeFailureView(r)).toEqual({ kind: "decoded" });
  });

  it("after a Deepgram failure the local step is announced as a fallback", async () => {
    const h = harness({ onDisk: new Error("401"), upload: new Error("401"), local: "words" });
    await runSavedRecordingDecode(persistedWithKey, h.deps);
    expect(h.steps).toEqual([
      { provider: "deepgram", model: "nova-3", afterFailure: false },
      { provider: "local", model: "large-v3", afterFailure: true },
    ]);
  });

  it("offline counts as Deepgram's failure in the status and in \"tried\"", async () => {
    const h = harness({ local: new Error("model missing") });
    const reason = "Deepgram is unavailable because the internet probe is offline.";
    const r = await runSavedRecordingDecode({ ...persistedWithKey, deepgram: { model: "nova-3", unavailableReason: reason } }, h.deps);
    expect(h.steps).toEqual([{ provider: "local", model: "large-v3", afterFailure: true }]);
    const view = savedDecodeFailureView(r);
    expect(view).toMatchObject({ kind: "error", tried: ["Deepgram nova-3", "local Whisper large-v3"], localTried: true });
    if (view.kind !== "error") throw new Error("unreachable");
    expect(String(view.error)).toContain("model missing");
    expect(String(view.firstError)).toContain(reason);
  });

  it("both providers failing: the local error, Deepgram's as First, each provider named once", async () => {
    const h = harness({ onDisk: new Error("dg on-disk 502"), upload: new Error("dg upload 502"), local: new Error("whisper OOM") });
    const view = savedDecodeFailureView(await runSavedRecordingDecode(persistedWithKey, h.deps));
    expect(view).toMatchObject({ kind: "error", tried: ["Deepgram nova-3", "local Whisper large-v3"] });
    if (view.kind !== "error") throw new Error("unreachable");
    expect(String(view.error)).toContain("whisper OOM");
    expect(String(view.firstError)).toContain("dg upload 502");
  });

  it("Deepgram failed and local heard nothing: an empty result, not an error", async () => {
    const h = harness({ onDisk: new Error("x"), upload: new Error("x"), local: "" });
    expect(savedDecodeFailureView(await runSavedRecordingDecode(persistedWithKey, h.deps)))
      .toEqual({ kind: "empty", tried: ["Deepgram nova-3", "local Whisper large-v3"] });
  });

  it("only local, failing: no First tail, and switching to local is not suggested", async () => {
    const h = harness({ local: new Error("boom") });
    const view = savedDecodeFailureView(await runSavedRecordingDecode({ ...persistedWithKey, deepgram: null }, h.deps));
    expect(view).toMatchObject({ kind: "error", tried: ["local Whisper large-v3"], firstError: undefined, localTried: true });
  });

  it("the audio cannot be read: the read error is the message", async () => {
    const h = harness({ audio: new Error("Audio fetch failed: HTTP 404") });
    const view = savedDecodeFailureView(await runSavedRecordingDecode({ ...persistedWithKey, deepgram: null }, h.deps));
    expect(view).toMatchObject({ kind: "error", tried: [], localTried: false });
    if (view.kind !== "error") throw new Error("unreachable");
    expect(String(view.error)).toContain("HTTP 404");
  });
});
