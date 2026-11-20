/**
 * The per-session live transcript buffer: what the streaming provider
 * has said so far, as the renderer received it over the live socket.
 *
 * It is the ONE owner of the live reading — the text the preview
 * shows, the draft autosave stores and the archive records as the
 * recording's ``Original:`` (``latestSourceForSave`` in ``stopLive``).
 * ``applyLiveStreamEvent`` is the only way a socket message reaches it,
 * so which messages feed the live reading is decided here, in one
 * place, under test (tests/live-transcript-buffer.test.ts), rather than
 * case by case inside the socket handler.
 *
 * The live reading is the provider's live stream and nothing else: the
 * ``final`` stop envelope is the delivered transcript, a different
 * reading of the same speech, and folding it in here doubled every
 * clause of a dual-stream take's ``Original:`` (see the ``final`` case).
 *
 * Pure: no DOM, no I/O.
 */

import { mergeInterim } from "./live-source";
import { normalizeTranscriptWhitespace } from "./text-match";
import { joinTranscriptSegments } from "./transcript-merge";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  /** Deepgram diarization index when enabled. undefined otherwise. */
  speaker?: number;
}

export type LiveWsMode = "local-assist" | "deepgram-stream";

export function mergeTranscriptSegments(
  segments: TranscriptSegment[],
  epsilon: number,
): TranscriptSegment[] {
  if (!segments.length) return [];
  // Speaker-aware equality. Both undefined ↔ both undefined (mono
  // stream); a numbered speaker on one side and undefined on the
  // other counts as DIFFERENT (don't conflate diarized into mono).
  // Two distinct speaker indices are ALWAYS different — even when
  // the text and timing happen to match, they're genuinely two
  // utterances and must both be kept. Without this gate, a
  // call-recording with cross-talk where speaker 0 and speaker 1
  // utter "yeah" within the same epsilon window had ONE of them
  // silently dropped from the transcript and the auto-paste was
  // missing a turn. Subtle data-loss bug visible only with
  // diarize=on.
  const sameSpeaker = (a: TranscriptSegment, b: TranscriptSegment): boolean =>
    a.speaker === b.speaker;
  // Sort by start asc, then end DESC, then speaker asc. The
  // longer / later-ending segment for the same (start, speaker)
  // lands FIRST in the merged list, so the shorter overlapping
  // interim that follows is dropped by the is-prefix-of-prev test
  // below. Without the descending end-tie-break the shorter
  // interim arrived first and the longer final was kept,
  // leaving both in the transcript and producing visible
  // duplication — exactly the user-reported "Просто расскажу," +
  // "Просто расскажу кратко. И ты тоже" pattern within a single
  // recording. The speaker tertiary keeps diarized output
  // deterministic when two speakers share a start tick.
  const ordered = [...segments].sort(
    (a, b) =>
      (a.start - b.start) ||
      (b.end - a.end) ||
      ((a.speaker ?? -1) - (b.speaker ?? -1)),
  );
  const merged: TranscriptSegment[] = [];
  for (const segment of ordered) {
    const prev = merged[merged.length - 1];
    // 1. Exact duplicate (same speaker, same timing, same text): drop.
    if (
      prev &&
      sameSpeaker(prev, segment) &&
      Math.abs(prev.start - segment.start) <= epsilon &&
      Math.abs(prev.end - segment.end) <= epsilon &&
      prev.text === segment.text
    ) {
      continue;
    }
    // 2. Prefix-overlap dedup: when a later interim emission shares
    //    the same start AND speaker as a kept segment AND its text
    //    is a strict prefix of the kept segment's text (within
    //    whitespace normalisation), drop the shorter interim.
    //    Deepgram streaming emits this pattern: an interim
    //    "Сергей привет" is followed by the final "Сергей привет,
    //    как дела" — both arrive with identical start times. The
    //    previous merge only dropped EXACT duplicates so both ended
    //    up in the transcript, the user saw their utterance twice
    //    in the paste, and the auto-paste delivered both halves
    //    back-to-back. Comparing on whitespace-normalised lowercase
    //    guards against trailing-comma / spacing differences
    //    between the two emissions ("hello world," vs "hello world
    //    , "). Speaker-aware: cross-talk between two speakers at
    //    the same start is preserved.
    if (
      prev &&
      sameSpeaker(prev, segment) &&
      Math.abs(prev.start - segment.start) <= epsilon
    ) {
      const prevNorm = prev.text.replace(/\s+/g, " ").trim().toLowerCase();
      const curNorm = segment.text.replace(/\s+/g, " ").trim().toLowerCase();
      if (prevNorm.startsWith(curNorm)) {
        // Current segment's text is wholly contained in prev (which
        // ended later thanks to the descending end-tie-break) → drop.
        continue;
      }
      if (curNorm.startsWith(prevNorm)) {
        // Reverse case — shouldn't happen with the desc-end sort
        // but defensive: replace prev with the longer segment.
        merged[merged.length - 1] = segment;
        continue;
      }
    }
    merged.push(segment);
  }
  return merged;
}

/**
 * Format an ordered list of transcript segments for display.
 *
 * When ``speaker`` is populated (Deepgram diarize), consecutive
 * segments from the same speaker are coalesced under one ``Speaker N:``
 * prefix. Speaker transitions start a new paragraph so the user can
 * visually separate voices in the live preview.
 */
export function formatSegmentsForDisplay(segments: TranscriptSegment[], separator: string): string {
  if (!segments.length) return "";
  const parts: string[] = [];
  let lastSpeaker: number | undefined;
  for (const seg of segments) {
    const t = seg.text.trim();
    if (!t) continue;
    if (seg.speaker !== undefined && seg.speaker !== lastSpeaker) {
      // New speaker — add a speaker-prefixed chunk.
      if (parts.length) parts.push("\n");
      // Deepgram numbers speakers from 0. "Speaker 0:" is an array
      // index shown to a person; the first speaker is Speaker 1.
      parts.push(`Speaker ${seg.speaker + 1}: ${t}`);
      lastSpeaker = seg.speaker;
    } else {
      if (parts.length && parts[parts.length - 1] !== "\n") {
        parts.push(separator);
      }
      parts.push(t);
    }
  }
  return parts.join("").trim();
}

/**
 * Per-session live PREVIEW state: the committed finals and the current
 * hypothesis for the tail, and nothing else.
 *
 * It used to carry two more fields — ``lastInterimText`` (the
 * hypothesis the last final displaced) and ``recoveredTailText`` (what
 * every earlier final dropped from its own interim, accumulated) —
 * because the stop path read this buffer and delivered what it found.
 * It no longer does. Recovering a word the provider's finals dropped is
 * the backend's word-level splice's job, where the word goes back where
 * it was spoken; the renderer's version of it could only append, which
 * put "трёх в" on the end of session ``a9fd3fd9``'s transcript. The
 * preview never regresses visibly without them either: the display floor
 * in ``scheduleLiveOutputRender`` is monotonic.
 */
export interface LiveTranscriptBuffer {
  segments: TranscriptSegment[];
  committedText: string;
  committedDisplayText: string;
  interimText: string;
  interimSegment: TranscriptSegment | null;
  committedDisplayCache: string;
  wsMode: LiveWsMode;
  /** ``UI_TOKENS.finalize.segmentEpsilonSec`` — see ``mergeTranscriptSegments``. */
  segmentEpsilonSec: number;
}

export function createLiveTranscriptBuffer(
  wsMode: LiveWsMode,
  segmentEpsilonSec: number,
): LiveTranscriptBuffer {
  return {
    segments: [],
    committedText: "",
    committedDisplayText: "",
    interimText: "",
    interimSegment: null,
    committedDisplayCache: "",
    wsMode,
    segmentEpsilonSec,
  };
}

export function canonicalTextFromBuffer(buffer: LiveTranscriptBuffer): string {
  return mergeInterim(buffer.committedText, buffer.interimText);
}

export function appendSegmentsToBuffer(
  buffer: LiveTranscriptBuffer,
  nextSegments: ReadonlyArray<TranscriptSegment>,
): void {
  if (!nextSegments.length) return;

  const prevLen = buffer.segments.length;
  const combined = buffer.segments.concat(nextSegments);
  const merged = mergeTranscriptSegments(combined, buffer.segmentEpsilonSec);
  const appendOnly =
    merged.length === combined.length &&
    merged.length >= prevLen &&
    merged.slice(0, prevLen).every((seg, i) => seg === buffer.segments[i]);

  buffer.segments = merged;
  // The final retires the hypothesis that produced it. Whatever the
  // final did not carry over is the backend's to splice back in, at the
  // time it was spoken — see the LiveTranscriptBuffer doc.
  buffer.interimText = "";
  buffer.interimSegment = null;

  const separator = buffer.wsMode === "deepgram-stream" ? " " : "\n";
  const hasDiarization = buffer.segments.some((s) => s.speaker !== undefined);
  if (hasDiarization) {
    buffer.committedDisplayCache = formatSegmentsForDisplay(buffer.segments, separator);
  } else if (appendOnly) {
    let delta = "";
    for (let i = prevLen; i < merged.length; i++) {
      const t = merged[i].text;
      if (!t) continue;
      if (delta) delta += separator;
      delta += t;
    }
    if (delta) {
      buffer.committedDisplayCache = buffer.committedDisplayCache
        ? `${buffer.committedDisplayCache}${separator}${delta}`
        : delta;
    }
  } else {
    buffer.committedDisplayCache = merged
      .map((segment) => segment.text)
      .filter(Boolean)
      .join(separator)
      .trim();
  }
  buffer.committedText = joinTranscriptSegments(buffer.segments);
  buffer.committedDisplayText = buffer.committedDisplayCache || buffer.committedText;
}

export function hasStreamingActivity(buffer: LiveTranscriptBuffer | null): boolean {
  if (!buffer) return false;
  return (
    buffer.segments.length > 0 ||
    !!buffer.committedText.trim() ||
    !!buffer.interimText.trim()
  );
}

/**
 * The socket messages that touch the live buffer, in the shape
 * ``parseLiveWsMessage`` produces them (segments already normalized).
 */
export type LiveStreamEvent =
  | { type: "segments"; segments: ReadonlyArray<TranscriptSegment> }
  | { type: "interim"; segment: TranscriptSegment }
  | { type: "final"; segments: ReadonlyArray<TranscriptSegment> };

/** Fold one socket message into the session's live buffer. */
export function applyLiveStreamEvent(buffer: LiveTranscriptBuffer, event: LiveStreamEvent): void {
  switch (event.type) {
    case "segments":
      appendSegmentsToBuffer(buffer, event.segments);
      return;
    case "interim":
      buffer.interimText = normalizeTranscriptWhitespace(event.segment.text);
      buffer.interimSegment = event.segment;
      return;
    case "final":
      // The stop envelope is NOT the live reading and never joins it.
      // Its segments are the backend's own re-merge of the whole
      // recording — for a dual-stream take, the two readings' words
      // regrouped at clause-length silences (``_segments_from_words`` in
      // backend/deepgram_dual.py) — so their boundaries and starts do
      // not line up with the primary's finals already held here, and
      // ``mergeTranscriptSegments``, which can only recognise the same
      // segment at the same start, kept both: every clause twice,
      // interleaved by start time, in the saved ``Original:`` of
      // 2026-11-20's dual-stream takes. The envelope is delivered
      // verbatim as the transcript (``stopLive``) and replaces the
      // preview verbatim (``composeLivePreviewText``); what the provider
      // said live is exactly the ``segments``/``interim`` stream above.
      return;
  }
}
