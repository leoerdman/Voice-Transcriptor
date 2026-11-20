import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";

import {
  DEEPGRAM_LIVE_SOURCE,
  LOCAL_ASSIST_SOURCE,
  describeLiveFinalStats,
  liveCloseOwesErrorEnvelope,
  parseLiveFinalEnvelope,
  parseLiveFinalStats,
} from "../src/live-envelope";
import { decideLiveTranscriptAdoption } from "../src/live-coverage";

/**
 * The RENDERER half of the ``final`` envelope contract (B-038).
 *
 * The fixture below is not written by hand here. It is produced by the
 * backend's own envelope constructor in
 * ``backend/tests/test_live_envelope.py`` and committed, so this suite
 * reads exactly what the backend sends. Rename, re-nest or drop a field
 * on the backend and regenerate the fixture, and this suite is what
 * says the renderer has not been taught the new shape.
 *
 * If this file fails right after a backend change: the fix is in
 * ``src/live-envelope.ts``, not in the fixture.
 */
// Resolved from the vitest root (``frontend/``) rather than from
// ``import.meta.url``: the jsdom environment rewrites the module URL, so
// a URL-relative path is not a file URL by the time it is read.
const FIXTURE_PATH = resolve(
  process.cwd(),
  "../contracts/live-final-envelope.json",
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as Record<
  string,
  Record<string, unknown>
>;

/** The renderer's own segment normaliser is in main.tsx; this is its shape. */
type Segment = { start: number; end: number; text: string; speaker?: number };
const normalizeSegment = (raw: unknown): Segment | null => {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as { start?: unknown; end?: unknown; text?: unknown; speaker?: unknown };
  const text = String(source.text || "").trim();
  if (!text) return null;
  const start = Math.max(0, Number(source.start) || 0);
  const end = Math.max(start, Number(source.end) || 0);
  const segment: Segment = { start, end, text };
  if (source.speaker !== undefined) segment.speaker = Number(source.speaker);
  return segment;
};

describe("the committed fixture is the wire shape both sides implement", () => {
  it("carries the three envelopes the backend can send", () => {
    expect(Object.keys(fixture).sort()).toEqual([
      "connectFailure",
      "deepgramStream",
      "localAssist",
    ]);
  });

  it("gives every envelope the same key set, in the same order", () => {
    const keys = [
      "type",
      "source",
      "text",
      "segments",
      "durationSec",
      "coveredEndSec",
      "streamedSec",
      "uncoveredSpeechSec",
      "error",
      "stats",
      "coverage",
    ];
    for (const [name, envelope] of Object.entries(fixture)) {
      expect(Object.keys(envelope), name).toEqual(keys);
      expect(envelope.type, name).toBe("final");
    }
  });
});

describe("parseLiveFinalEnvelope reads a dual-stream Deepgram stop", () => {
  const parsed = parseLiveFinalEnvelope(fixture.deepgramStream, normalizeSegment);

  it("delivers the transcript verbatim", () => {
    expect(parsed.text).toBe("Привет everybody. Это тест.");
  });

  it("keeps every segment the backend committed", () => {
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0].speaker).toBe(0);
    expect(parsed.segments[1].text).toBe("Это тест.");
  });

  it("reads the four top-level numbers as sent", () => {
    expect(parsed.durationSec).toBe(3.02);
    expect(parsed.coveredEndSec).toBe(3.02);
    expect(parsed.streamedSec).toBe(3.5);
    expect(parsed.uncoveredSpeechSec).toBe(0);
  });

  it("reads source and reports no error", () => {
    expect(parsed.source).toBe(DEEPGRAM_LIVE_SOURCE);
    expect(parsed.error).toBeUndefined();
  });

  it("reads every stats field the trace line prints", () => {
    expect(parsed.stats).toEqual({
      connectMs: 318.4,
      finalizeMs: 214.7,
      dualStream: true,
      dualSecondaryLanguage: "ru",
      dualFilledFromSecondary: 3,
      dualFilledFromPrimary: 1,
      recoverySpansSec: 1.1,
      recoveryMs: 412.5,
      recoveryWords: 2,
    });
  });

  it("has no coverage report — a stream has no windows", () => {
    expect(parsed.coverage).toBeUndefined();
  });
});

describe("parseLiveFinalEnvelope reads a local-assist stop", () => {
  const parsed = parseLiveFinalEnvelope(fixture.localAssist, normalizeSegment);

  it("reads the coverage report out of its own object", () => {
    // B-038: these five numbers used to arrive as FLAT top-level keys
    // on this envelope and on no other. That was the second of the
    // three shapes; a renderer reading the flat form against the
    // nested one silently refuses every adoption.
    expect(parsed.coverage).toEqual({
      complete: true,
      coveredSec: 2,
      totalSec: 2,
      droppedSec: 0,
      uncoveredTailSec: 0,
    });
  });

  it("is adoptable by the policy that gates the full re-transcription", () => {
    const decision = decideLiveTranscriptAdoption({
      envelope: {
        source: parsed.source,
        text: parsed.text,
        error: parsed.error,
        coverage: parsed.coverage,
      },
      assistModel: "base",
      finalModel: "base",
      framesNeverSent: 0,
    });
    expect(decision).toEqual({ adopt: true, coverage: parsed.coverage });
  });

  it("names itself local-assist", () => {
    expect(parsed.source).toBe(LOCAL_ASSIST_SOURCE);
  });

  it("reports no stats rather than a missing object", () => {
    expect(parsed.stats).toBeUndefined();
  });
});

describe("parseLiveFinalEnvelope reads a connect failure", () => {
  const parsed = parseLiveFinalEnvelope(fixture.connectFailure, normalizeSegment);

  it("carries the error and nothing else", () => {
    expect(parsed.error).toBe("Deepgram API key is not configured");
    expect(parsed.text).toBe("");
    expect(parsed.segments).toEqual([]);
    expect(parsed.coverage).toBeUndefined();
  });
});

describe("absence is never read as a fact", () => {
  it("drops a coverage block without an explicit complete boolean", () => {
    const parsed = parseLiveFinalEnvelope(
      { coverage: { coveredSec: 9, totalSec: 9 } },
      normalizeSegment,
    );
    expect(parsed.coverage).toBeUndefined();
  });

  it("drops a null coverage block", () => {
    expect(parseLiveFinalEnvelope({ coverage: null }, normalizeSegment).coverage)
      .toBeUndefined();
  });

  it("leaves a missing number absent instead of defaulting it to zero", () => {
    const parsed = parseLiveFinalEnvelope({}, normalizeSegment);
    expect(parsed.streamedSec).toBeUndefined();
    expect(parsed.coveredEndSec).toBeUndefined();
    expect(parsed.uncoveredSpeechSec).toBeUndefined();
  });

  it("rejects a negative or non-finite number", () => {
    const parsed = parseLiveFinalEnvelope(
      { streamedSec: -1, coveredEndSec: "nope", uncoveredSpeechSec: Infinity },
      normalizeSegment,
    );
    expect(parsed.streamedSec).toBeUndefined();
    expect(parsed.coveredEndSec).toBeUndefined();
    expect(parsed.uncoveredSpeechSec).toBeUndefined();
  });

  it("lets each stats field stand on its own", () => {
    expect(parseLiveFinalStats({ dual_stream: false })).toEqual({ dualStream: false });
    expect(parseLiveFinalStats({ recovery: { ms: 12 } })).toEqual({ recoveryMs: 12 });
    expect(parseLiveFinalStats({})).toBeUndefined();
    expect(parseLiveFinalStats(null)).toBeUndefined();
  });
});

describe("describeLiveFinalStats — every parsed field has a reader", () => {
  it("prints the whole dual + recovery diagnosis", () => {
    const stats = parseLiveFinalStats(fixture.deepgramStream.stats);
    expect(describeLiveFinalStats(stats)).toBe(
      "connect=318ms finalize=215ms dual=1/ru/+3/+1 recovery=1.10s/413ms/2w",
    );
  });

  it("says n/a for what the backend never reported, never zero", () => {
    expect(describeLiveFinalStats(undefined)).toBe(
      "connect=n/a finalize=n/a dual=0 recovery=n/a",
    );
  });
});

describe("liveCloseOwesErrorEnvelope — FL-03: a socket that dies mid-recording records its failure", () => {
  it("an unclean close with no envelope yet owes one, whether or not a waiter exists", () => {
    expect(liveCloseOwesErrorEnvelope({ hadEnvelope: false, wasClean: false, code: 1006 })).toBe(true);
    expect(liveCloseOwesErrorEnvelope({ hadEnvelope: false, wasClean: true, code: 1011 })).toBe(true);
  });

  it("a clean normal close after finalize owes nothing", () => {
    expect(liveCloseOwesErrorEnvelope({ hadEnvelope: false, wasClean: true, code: 1000 })).toBe(false);
    expect(liveCloseOwesErrorEnvelope({ hadEnvelope: false, wasClean: true, code: 1005 })).toBe(false);
  });

  it("a session that already has its final envelope is never overwritten", () => {
    expect(liveCloseOwesErrorEnvelope({ hadEnvelope: true, wasClean: false, code: 1006 })).toBe(false);
  });
});
