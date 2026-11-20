import { describe, expect, it } from "vitest";

import { recordingOutputIsPasteReady } from "../src/recording-output";

describe("recordingOutputIsPasteReady", () => {
  it("pastes a transcript whatever it says", () => {
    // Ultra-Audit 2026-11-20 DM-01: these were silently never pasted.
    expect(recordingOutputIsPasteReady({ kind: "transcript", pasteText: "HTTP server returns 500 on login" })).toBe(true);
    expect(recordingOutputIsPasteReady({ kind: "transcript", pasteText: "error" })).toBe(true);
    expect(recordingOutputIsPasteReady({ kind: "transcript", pasteText: "[silence]" })).toBe(true);
  });

  it("never pastes a status or an error, whatever it says", () => {
    expect(recordingOutputIsPasteReady({ kind: "error", pasteText: "Transcription failed." })).toBe(false);
    expect(recordingOutputIsPasteReady({ kind: "status", pasteText: "Recording completed" })).toBe(false);
    expect(recordingOutputIsPasteReady({ kind: "", pasteText: "anything" })).toBe(false);
  });

  it("never pastes nothing", () => {
    expect(recordingOutputIsPasteReady({ kind: "transcript", pasteText: "   " })).toBe(false);
  });
});
