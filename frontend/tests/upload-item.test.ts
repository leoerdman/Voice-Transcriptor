import { describe, expect, it } from "vitest";

import {
  isUploadClearable,
  uploadErrorView,
  uploadRetryPlan,
  uploadTranscriptAwaitingSave,
} from "../src/upload-item";

const saveFailed = {
  status: "error" as const,
  text: "Сорок минут интервью, расшифрованные за деньги.",
  savedName: "",
  error: "Transcript finished, but History save failed: HTTP 507: disk full",
};

describe("FQ-01: a transcript whose History save failed stays reachable", () => {
  it("is recognised as awaiting a save", () => {
    expect(uploadTranscriptAwaitingSave(saveFailed)).toBe(true);
  });

  it("the error view shows the transcript and offers Copy beside the error", () => {
    expect(uploadErrorView(saveFailed)).toEqual({
      error: saveFailed.error,
      transcript: saveFailed.text,
      copyable: true,
    });
  });

  it("an ordinary failure (no transcript) shows only its error, without Copy", () => {
    expect(uploadErrorView({ status: "error", text: "", error: "Transcription failed." })).toEqual({
      error: "Transcription failed.",
      transcript: "",
      copyable: false,
    });
  });

  it("a transcript already in History is not 'awaiting'", () => {
    expect(uploadTranscriptAwaitingSave({ ...saveFailed, savedName: "2026-11-20 interview.txt" })).toBe(false);
    expect(uploadTranscriptAwaitingSave({ ...saveFailed, status: "done" })).toBe(false);
  });

  it("'Clear done' keeps it; every other finished item is clearable", () => {
    expect(isUploadClearable(saveFailed)).toBe(false);
    expect(isUploadClearable({ status: "done", text: "x", savedName: "a.txt" })).toBe(true);
    expect(isUploadClearable({ status: "error", text: "" })).toBe(true);
    expect(isUploadClearable({ status: "cancelled" })).toBe(true);
    expect(isUploadClearable({ status: "transcribing" })).toBe(false);
    expect(isUploadClearable({ status: "queued" })).toBe(false);
  });
});

describe("FQ-05: Retry of a save failure re-runs the save, not the paid transcription", () => {
  it("plans a save-only retry when the transcript is held", () => {
    expect(uploadRetryPlan(saveFailed)).toBe("save");
  });

  it("plans a full transcription when there is nothing to save", () => {
    expect(uploadRetryPlan({ status: "error", text: "   " })).toBe("transcribe");
    expect(uploadRetryPlan({ status: "error" })).toBe("transcribe");
  });
});
