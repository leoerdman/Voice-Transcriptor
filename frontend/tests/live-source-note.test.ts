import { describe, expect, it } from "vitest";

import { liveSourceNote } from "../src/live-source-note";

/**
 * The pane's model select is a request; the note beside it is the report.
 *
 * The defect behind these tests: a session with no Deepgram key came back with
 * ``source: "local-assist"`` and the pane kept reading "Deepgram nova-3", so
 * the owner judged Deepgram by words it had never seen.
 */
describe("what actually produced the text", () => {
  it("says nothing when the chosen provider is the one that ran", () => {
    expect(liveSourceNote("deepgram-stream", "deepgram")).toBe("");
  });

  it("warns that nothing was sent when a remote choice ran locally", () => {
    const text = liveSourceNote("local-assist", "deepgram");
    expect(text).toContain("this machine");
    expect(text).toContain("nothing was sent");
    expect(text).toContain("Settings");
  });

  it("stays quiet when the choice was local to begin with", () => {
    expect(liveSourceNote("local-assist", "local-whisper")).toBe("");
    expect(liveSourceNote("local-assist", "gigaam")).toBe("");
  });

  it("names Deepgram when it answered a choice that was not Deepgram", () => {
    expect(liveSourceNote("deepgram-stream", "local-whisper")).toContain("Deepgram");
  });

  it("says nothing at all before a session reports a source", () => {
    expect(liveSourceNote("", "deepgram")).toBe("");
  });

  it("ignores a source it does not know", () => {
    expect(liveSourceNote("something-new", "deepgram")).toBe("");
  });
});
