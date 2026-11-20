/**
 * The ``final`` WebSocket envelope — the renderer's HALF of one contract.
 *
 * The backend's half is ``backend/live_envelope.py``, and it is the only
 * place a ``final`` message is built. This module is the only place one
 * is read. Before B-038 there was no "only place" on either side: the
 * backend wrote the message out by hand at five call sites in three
 * mutually incompatible shapes (the Deepgram drain, the local assist
 * with its FLAT coverage keys, and two error paths carrying a third
 * subset), and ``parseLiveWsMessage`` had to be the union of all three.
 * Adding a field to one side was then a silent no-op on the other —
 * which, for a message that IS the delivered transcript, means words
 * quietly not arriving.
 *
 * What keeps the two halves honest is not this comment. It is
 * ``contracts/live-final-envelope.json``: produced by the backend's own
 * builder in ``backend/tests/test_live_envelope.py`` and parsed by
 * ``frontend/tests/live-envelope.test.ts``. Rename or re-nest a field on
 * either side and the other side's suite goes red.
 *
 * Reading rules, unchanged from the parser this replaces and stated
 * once here instead of per field:
 *
 *  * a number is adopted only when it is finite and non-negative;
 *    anything else reads as ABSENT, never as zero. "No field" and
 *    "proven zero" are different facts, and confusing them is how a
 *    false "fully covered" signal gets believed
 *    (BUGS_AUDIT_2026-09-03 §3.4);
 *  * ``coverage`` is adopted only when the backend actually sent the
 *    ``complete`` boolean. A malformed or null block is absent, and an
 *    absent one refuses adoption in ``./live-coverage`` — never the
 *    other way round;
 *  * segments are normalised by the caller's own normaliser, injected,
 *    because the renderer's segment shape is the renderer's business
 *    and this module has no DOM and no globals.
 */

import type { LiveCoverageReport } from "./live-coverage";

/** ``source`` values the backend can put on an envelope. */
export const DEEPGRAM_LIVE_SOURCE = "deepgram-live";
export const LOCAL_ASSIST_SOURCE = "local-assist";

/**
 * The slice of the backend's ``stats`` object the renderer reads.
 *
 * Every field here has a reader in the ``[trace stopLive] FINAL`` line:
 * how the recording was decoded (one Nova-3 stream or two, and what the
 * second one contributed), what the connect and the finalize cost, and
 * what the backend re-decoded from its own spool to make the envelope
 * complete. None of it is visible in the transcript, and together it is
 * the whole diagnosis of a stop in a support log.
 *
 * The wire names are the backend's, verified against the code that
 * writes them (``DeepgramLiveStats.as_dict``, ``backend/deepgram_dual``,
 * ``RecoveryReport.as_dict``). Anything else in ``stats`` is the
 * backend's own bookkeeping and is not parsed.
 */
export interface LiveFinalStats {
  /** ``stats.connect_ms`` — what opening the upstream socket cost. */
  connectMs?: number;
  /** ``stats.finalize_ms`` — what flushing it at stop cost. */
  finalizeMs?: number;
  /** ``stats.dual_stream`` — was this recording read by two streams? */
  dualStream?: boolean;
  /** ``stats.dual_secondary_language`` — the second stream's language. */
  dualSecondaryLanguage?: string;
  /** Words the merge took from the second reading. */
  dualFilledFromSecondary?: number;
  /** Words the merge took from the primary where the second had none. */
  dualFilledFromPrimary?: number;
  /** Seconds of the recording the backend re-decoded to close a gap. */
  recoverySpansSec?: number;
  /** What that re-decode cost, in ms — part of the announced budget. */
  recoveryMs?: number;
  /** Words the re-decode actually spliced into the transcript. */
  recoveryWords?: number;
}

/** The envelope, minus its ``type`` tag. One shape, every field. */
export interface LiveFinalEnvelopeFields<Segment> {
  text: string;
  segments: Segment[];
  durationSec: number;
  source: string;
  error?: string;
  /**
   * The local assist's window report. ``null`` on the wire for every
   * transport that has no notion of windows (a Deepgram stream decodes
   * a continuous socket), absent here for the same and for a malformed
   * one — ``./live-coverage`` refuses to adopt a transcript whose
   * coverage it cannot read, which is the safe direction.
   */
  coverage?: LiveCoverageReport;
  /**
   * Seconds where the backend's own interims recognised speech that no
   * final segment covers. Diagnostic only: the backend closes those
   * spans itself, from its own audio spool, before the envelope is
   * sent, and reports what it re-decoded in ``stats.recovery``.
   */
  uncoveredSpeechSec?: number;
  /** Seconds of audio the backend actually streamed to the provider. */
  streamedSec?: number;
  /** The last second of audio a DECODER (never an interim) reported. */
  coveredEndSec?: number;
  stats?: LiveFinalStats;
}

/**
 * Adopt a wire number only when it is finite and non-negative.
 * Everything else is absent — see the reading rules in the module doc.
 */
export function parseOptionalNonNegativeNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * ``stats``, field by field, each standing on its own so a backend that
 * reports one and not another still gets the one it reports through.
 * Returns ``undefined`` when nothing readable was in there at all.
 */
export function parseLiveFinalStats(raw: unknown): LiveFinalStats | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const stats: LiveFinalStats = {};

  const connectMs = parseOptionalNonNegativeNumber(source.connect_ms);
  if (connectMs !== undefined) stats.connectMs = connectMs;
  const finalizeMs = parseOptionalNonNegativeNumber(source.finalize_ms);
  if (finalizeMs !== undefined) stats.finalizeMs = finalizeMs;

  if (typeof source.dual_stream === "boolean") stats.dualStream = source.dual_stream;
  if (typeof source.dual_secondary_language === "string") {
    const code = source.dual_secondary_language.trim();
    if (code) stats.dualSecondaryLanguage = code;
  }
  const filledSecondary = parseOptionalNonNegativeNumber(source.dual_filled_from_secondary);
  if (filledSecondary !== undefined) stats.dualFilledFromSecondary = filledSecondary;
  const filledPrimary = parseOptionalNonNegativeNumber(source.dual_filled_from_primary);
  if (filledPrimary !== undefined) stats.dualFilledFromPrimary = filledPrimary;

  const recovery = source.recovery;
  if (recovery && typeof recovery === "object") {
    const spans = recovery as Record<string, unknown>;
    const spansSec = parseOptionalNonNegativeNumber(spans.spans_sec);
    if (spansSec !== undefined) stats.recoverySpansSec = spansSec;
    const ms = parseOptionalNonNegativeNumber(spans.ms);
    if (ms !== undefined) stats.recoveryMs = ms;
    const words = parseOptionalNonNegativeNumber(spans.words);
    if (words !== undefined) stats.recoveryWords = words;
  }

  return Object.keys(stats).length ? stats : undefined;
}

/**
 * The ``coverage`` block, adopted only on an explicit ``complete``
 * boolean. Its four numbers default to 0 once that boolean is present —
 * unlike the top-level diagnostics — because the backend sends all five
 * together or none of them, and a partial block would mean a corrupted
 * message rather than an older build.
 */
export function parseLiveCoverage(raw: unknown): LiveCoverageReport | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  if (typeof source.complete !== "boolean") return undefined;
  return {
    complete: source.complete,
    coveredSec: Math.max(0, Number(source.coveredSec) || 0),
    totalSec: Math.max(0, Number(source.totalSec) || 0),
    droppedSec: Math.max(0, Number(source.droppedSec) || 0),
    uncoveredTailSec: Math.max(0, Number(source.uncoveredTailSec) || 0),
  };
}

/**
 * The stats half of the ``[trace stopLive] FINAL`` line.
 *
 * Every field the parser above adopts is printed here, which is the
 * point: a wire field with no reader is a field nobody notices the
 * backend has stopped sending. A fact the backend did not report reads
 * ``n/a`` — never ``0``, which would claim it was measured and found to
 * be nothing.
 */
export function describeLiveFinalStats(stats: LiveFinalStats | undefined): string {
  const ms = (value: number | undefined): string =>
    value === undefined ? "n/a" : `${value.toFixed(0)}ms`;
  const dual = stats?.dualStream
    ? `1/${stats.dualSecondaryLanguage || "?"}` +
      `/+${stats.dualFilledFromSecondary ?? 0}` +
      `/+${stats.dualFilledFromPrimary ?? 0}`
    : "0";
  const recovery =
    stats?.recoverySpansSec === undefined
      ? "n/a"
      : `${stats.recoverySpansSec.toFixed(2)}s/${ms(stats.recoveryMs)}` +
        `/${stats.recoveryWords ?? 0}w`;
  return (
    `connect=${ms(stats?.connectMs)} finalize=${ms(stats?.finalizeMs)} ` +
    `dual=${dual} recovery=${recovery}`
  );
}

/**
 * Parse a ``final`` message body into the envelope the stop delivers.
 *
 * ``normalizeSegment`` is the caller's segment normaliser; segments it
 * rejects are dropped, which is the same rule every other transcript
 * surface in the renderer follows.
 */
export function parseLiveFinalEnvelope<Segment>(
  obj: Record<string, unknown>,
  normalizeSegment: (raw: unknown) => Segment | null,
): LiveFinalEnvelopeFields<Segment> {
  const rawSegments = Array.isArray(obj.segments) ? obj.segments : [];
  const segments = rawSegments
    .map((segment) => normalizeSegment(segment))
    .filter((segment): segment is Segment => segment !== null);
  const error = typeof obj.error === "string" && obj.error ? obj.error : undefined;
  return {
    text: String(obj.text || ""),
    segments,
    durationSec: Math.max(0, Number(obj.durationSec) || 0),
    source: String(obj.source || ""),
    error,
    coverage: parseLiveCoverage(obj.coverage),
    uncoveredSpeechSec: parseOptionalNonNegativeNumber(obj.uncoveredSpeechSec),
    streamedSec: parseOptionalNonNegativeNumber(obj.streamedSec),
    coveredEndSec: parseOptionalNonNegativeNumber(obj.coveredEndSec),
    stats: parseLiveFinalStats(obj.stats),
  };
}

/**
 * Does a closing live socket owe its session a synthetic error envelope?
 *
 * FL-03. Yes when the close is unclean and no ``final`` arrived — whether
 * or not anyone is waiting yet. The handler used to bail out when the
 * session had no envelope slot, and a slot only exists once stopLive arms
 * its (lazy) waiter, so a socket that died mid-recording recorded
 * nothing: the stop then waited out its whole envelope budget (1.5 s
 * Deepgram, 4 s local) for a message that could no longer come before
 * falling back to the saved audio.
 */
export function liveCloseOwesErrorEnvelope(close: {
  hadEnvelope: boolean;
  wasClean: boolean;
  code: number;
}): boolean {
  if (close.hadEnvelope) return false;
  return !(close.wasClean && (close.code === 1000 || close.code === 1005));
}
