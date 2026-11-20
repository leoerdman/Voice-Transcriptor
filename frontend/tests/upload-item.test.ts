import { describe, expect, it } from "vitest";

import {
  enterUploadProcessingStage,
  isUploadClearable,
  pickNextQueuedUpload,
  uploadErrorView,
  uploadItemRetryable,
  uploadQueueTitle,
  uploadRetryPlan,
  uploadSourceValidationError,
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

describe("pickNextQueuedUpload — FQ-08: files run in the order they were added", () => {
  it("a batch A, B, C (shown newest-first: C, B, A) starts with A", () => {
    const shown = [
      { id: "C", status: "queued" as const },
      { id: "B", status: "queued" as const },
      { id: "A", status: "queued" as const },
    ];
    expect(pickNextQueuedUpload(shown)?.id).toBe("A");
  });

  it("an earlier batch is not overtaken by a later one, and non-queued rows are skipped", () => {
    const shown = [
      { id: "E", status: "queued" as const },
      { id: "D", status: "queued" as const },
      { id: "C", status: "queued" as const },
      { id: "B", status: "transcribing" as const },
      { id: "A", status: "done" as const },
    ];
    expect(pickNextQueuedUpload(shown)?.id).toBe("C");
    expect(pickNextQueuedUpload([{ id: "A", status: "done" as const }])).toBeUndefined();
  });
});

describe("uploadSourceValidationError — FQ-11: one rule for a dropped file and a remembered path", () => {
  const base = {
    capBytes: 100,
    allowedExts: new Set(["mp3", "mp4"]),
    formatBytes: (n: number) => `${n} B`,
  };

  it("rejects an oversized source", () => {
    expect(uploadSourceValidationError({ ...base, name: "a.mp3", sizeBytes: 101 })).toBe("File too large (101 B > 100 B cap).");
  });

  it("rejects a name without an extension, and an extension the backend does not accept", () => {
    expect(uploadSourceValidationError({ ...base, name: "/Users/x/notes", sizeBytes: 1 }))
      .toBe("Unsupported file type. Choose an audio or video file with a supported extension.");
    expect(uploadSourceValidationError({ ...base, name: "C:\\clips\\a.TXT", sizeBytes: 1 }))
      .toBe('Unsupported file type ".txt". Choose an audio or video file.');
  });

  it("accepts a supported file, case-insensitively, from a path leaf", () => {
    expect(uploadSourceValidationError({ ...base, name: "/Users/x/Talk.MP4", sizeBytes: 100 })).toBe("");
  });

  it("before the backend list is hydrated only the size and the presence of an extension are checked", () => {
    expect(uploadSourceValidationError({ ...base, allowedExts: new Set(), name: "a.xyz", sizeBytes: 1 })).toBe("");
  });
});

describe("uploadQueueTitle — FQ-16: failed items are not counted as done", () => {
  it("names failures and cancellations separately", () => {
    expect(uploadQueueTitle(["done", "done", "done", "error", "error"])).toBe("Queue · 3/5 done · 2 failed");
    expect(uploadQueueTitle(["done", "cancelled", "transcribing"])).toBe("Queue · 1/3 done · 1 cancelled");
  });

  it("an empty queue is just 'Queue'", () => {
    expect(uploadQueueTitle([])).toBe("Queue");
  });
});

describe("uploadItemRetryable — FQ-22: a cancelled file can be retried in place", () => {
  it("offers Retry for failed and cancelled items only", () => {
    expect(uploadItemRetryable("error")).toBe(true);
    expect(uploadItemRetryable("cancelled")).toBe(true);
    expect(uploadItemRetryable("done")).toBe(false);
    expect(uploadItemRetryable("queued")).toBe(false);
    expect(uploadItemRetryable("transcribing")).toBe(false);
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

describe("FQ-06: Uploading → Processing flips when the job exists, once", () => {
  it("moves an uploading item to processing and says it changed", () => {
    const item = { status: "transcribing" as const, stage: "uploading" as const };
    expect(enterUploadProcessingStage(item)).toBe(true);
    expect(item.stage).toBe("processing");
  });

  it("leaves an item already processing (a from-path job) and reports no change", () => {
    const item = { status: "transcribing" as const, stage: "processing" as const };
    expect(enterUploadProcessingStage(item)).toBe(false);
    expect(item.stage).toBe("processing");
  });

  it("leaves an item that stopped transcribing meanwhile", () => {
    const item = { status: "cancelled" as const, stage: "uploading" as const };
    expect(enterUploadProcessingStage(item)).toBe(false);
    expect(item.stage).toBe("uploading");
  });
});
