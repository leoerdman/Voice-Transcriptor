import { describe, expect, it } from "vitest";

import { decideDrainedSilence, type DrainedSilenceInput } from "../src/stop-epilogue";

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
