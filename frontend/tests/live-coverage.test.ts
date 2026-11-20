import { describe, it, expect } from "vitest";

import {
  decideLiveTranscriptAdoption,
  hasUnsentFrames,
  type AdoptionInput,
  type LiveCoverageReport,
} from "../src/live-coverage";
import { LOCAL_ASSIST_SOURCE } from "../src/live-envelope";

// The Deepgram path's dead-stream and envelope-coverage rules
// (decideDeadStreamRecovery, envelopeCoversRecording) are deleted with
// their tests: that path asks one question now — did an envelope arrive
// — and it is answered by ``envelopeMissing`` in ./envelope-deadline.
// What remains here is the LOCAL provider's adoption policy.
describe("hasUnsentFrames — the client half of the local adoption gate", () => {
  it("is false for zero", () => {
    expect(hasUnsentFrames(0)).toBe(false);
  });
  it("is true for any positive count", () => {
    expect(hasUnsentFrames(1)).toBe(true);
  });
});

/**
 * FL-20: the full adoption matrix — its only home. (A Python copy that
 * compiled this module with tsc and drove it through node was removed:
 * it tested no backend code and skipped wherever node/tsc was missing.)
 */
describe("decideLiveTranscriptAdoption — the full matrix (FL-20)", () => {
  const coverage = (overrides: Partial<LiveCoverageReport> = {}): LiveCoverageReport => ({
    complete: true,
    coveredSec: 12,
    totalSec: 12,
    droppedSec: 0,
    uncoveredTailSec: 0,
    ...overrides,
  });
  const input = (
    overrides: Partial<Omit<AdoptionInput, "envelope">> & {
      envelope?: Partial<NonNullable<AdoptionInput["envelope"]>> | null;
    } = {},
  ): AdoptionInput => {
    const { envelope, ...rest } = overrides;
    return {
      envelope: envelope === null
        ? null
        : { source: LOCAL_ASSIST_SOURCE, text: "the quick brown fox", coverage: coverage(), ...envelope },
      assistModel: "small",
      finalModel: "small",
      framesNeverSent: 0,
      ...rest,
    };
  };
  const rejected = (i: AdoptionInput, reason: string) => {
    expect(decideLiveTranscriptAdoption(i)).toEqual({ adopt: false, reason });
  };

  it("adopts a complete same-model session", () => {
    expect(decideLiveTranscriptAdoption(input())).toEqual({ adopt: true, coverage: coverage() });
  });

  it("the completeness flag is the only tolerance: sub-epsilon diagnostics do not veto", () => {
    expect(decideLiveTranscriptAdoption(input({ envelope: { coverage: coverage({ droppedSec: 0.001, uncoveredTailSec: 0.002 }) } })).adopt)
      .toBe(true);
  });

  it("a missing or failed envelope falls back", () => {
    rejected(input({ envelope: null }), "no-envelope");
    rejected(input({ envelope: { error: "stream died" } }), "envelope-error");
  });

  it("a non-assist transport falls back", () => {
    rejected(input({ envelope: { source: "deepgram-stream" } }), "not-local-assist");
  });

  it("audio stranded in the renderer falls back", () => {
    rejected(input({ framesNeverSent: 3 }), "frames-never-sent");
  });

  it("an absent coverage report is not permission", () => {
    rejected(input({ envelope: { coverage: undefined } }), "no-coverage-report");
  });

  it("incomplete coverage falls back, whatever made it incomplete", () => {
    rejected(input({ envelope: { coverage: coverage({ complete: false }) } }), "incomplete-coverage");
    rejected(input({ envelope: { coverage: coverage({ complete: false, droppedSec: 4.2 }) } }), "incomplete-coverage");
    rejected(input({ envelope: { coverage: coverage({ complete: false, uncoveredTailSec: 1.8 }) } }), "incomplete-coverage");
  });

  it("an empty session falls back", () => {
    rejected(input({ envelope: { coverage: coverage({ totalSec: 0 }) } }), "empty-session");
  });

  it("a cheaper or blank assist model never silently downgrades quality", () => {
    rejected(input({ assistModel: "tiny", finalModel: "medium" }), "model-mismatch");
    rejected(input({ assistModel: "", finalModel: "" }), "model-mismatch");
  });

  it("an empty transcript falls back", () => {
    rejected(input({ envelope: { text: "   " } }), "empty-transcript");
  });
});

describe("decideLiveTranscriptAdoption gates on frames-never-sent", () => {
  it("rejects adoption when frames were never sent", () => {
    const decision = decideLiveTranscriptAdoption({
      envelope: {
        source: "local-assist",
        text: "hello world",
        coverage: { complete: true, coveredSec: 10, totalSec: 10, droppedSec: 0, uncoveredTailSec: 0 },
      },
      assistModel: "base",
      finalModel: "base",
      framesNeverSent: 1,
    });
    expect(decision).toEqual({ adopt: false, reason: "frames-never-sent" });
  });
});
