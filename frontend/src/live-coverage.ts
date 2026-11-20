/**
 * Live-transcript adoption policy for the LOCAL provider.
 *
 * At stop, a local-provider recording can either re-transcribe the saved
 * file from scratch or reuse what the live assist already decoded while
 * the user was speaking. Re-transcribing costs time proportional to the
 * recording length — the "sometimes the transcript takes twenty seconds"
 * stall — but reusing is only safe when the live pass provably saw every
 * captured second and ran the same model the final pass would run.
 *
 * The decision is isolated here, as a pure function over primitives, for
 * two reasons: it is the single place the rule is defined, and it can be
 * unit tested (see ``backend/tests/test_live_coverage_policy.py``)
 * without standing up a recording session.
 *
 * Coverage has two halves and both must be clean:
 *
 *  * The **backend** half — ``complete`` — certifies that everything the
 *    server received reached the model. It is computed once, in
 *    ``LiveSession.finalize_envelope``, against the same epsilon the
 *    windowing logic uses. It is never re-derived here: a second
 *    tolerance would silently diverge from the first.
 *  * The **client** half — ``framesNeverSent`` — accounts for audio the
 *    renderer captured but never managed to hand over. The server cannot
 *    see that, so a transcript can be "complete" server-side and still be
 *    missing the words the user spoke during a slow WebSocket handshake.
 *
 * Every rejection carries a reason so the decision is visible in the
 * trace log instead of being an unexplained branch.
 *
 * The Deepgram streaming path used to share this module's dead-stream
 * and envelope-coverage arithmetic (``decideDeadStreamRecovery``,
 * ``envelopeCoversRecording``, ``TAIL_GAP_THRESHOLD_SEC``). It no longer
 * asks any of those questions: the backend's ``final`` envelope is
 * complete by construction and is the only source of the delivered
 * transcript, so the one thing the renderer still decides there is
 * whether an envelope arrived at all (``envelopeMissing`` in
 * ./envelope-deadline). Those predicates were deleted rather than left
 * unused — a second, unread coverage rule is exactly the parallel owner
 * this change exists to remove.
 */

import { LOCAL_ASSIST_SOURCE } from "./live-envelope";

/**
 * True when this session dropped captured audio on the client side —
 * discarded at the pending-buffer cap, lost to a failed ``send``, or
 * still queued when the socket went away. This is the client half of
 * the coverage contract (see module doc); the server cannot see this
 * loss, so it must gate adoption independently of whatever the server
 * reports.
 *
 * PROTOCOL CONTRACT R4 (BUGS_AUDIT_2026-09-03 §4.6). On the Deepgram
 * path the same loss is now the backend's to see and to close: the
 * renderer reports its frame and byte totals on ``finalize``, the
 * backend drains exactly the frames it is owed and re-decodes whatever
 * span it still cannot account for from its own audio spool. Here it
 * remains a gate, because adopting the local assist's own output means
 * skipping the full pass entirely — and audio that never left the
 * renderer reached no model at all.
 */
export function hasUnsentFrames(framesNeverSent: number): boolean {
  return framesNeverSent > 0;
}

export type AdoptionRejection =
  | "no-envelope"
  | "envelope-error"
  | "not-local-assist"
  | "frames-never-sent"
  | "no-coverage-report"
  | "incomplete-coverage"
  | "empty-session"
  | "model-mismatch"
  | "empty-transcript";

export interface LiveCoverageReport {
  /** True only when nothing was dropped and no tail went untranscribed. */
  complete: boolean;
  coveredSec: number;
  totalSec: number;
  /** Audio discarded because the assist fell behind its window budget. */
  droppedSec: number;
  /** Audio at the end of the stream that never reached the model. */
  uncoveredTailSec: number;
}

export interface AdoptionInput {
  /** Present only when a final envelope actually arrived. */
  envelope: {
    source: string;
    text: string;
    error?: string;
    coverage?: LiveCoverageReport;
  } | null;
  /** Model the live assist ran. */
  assistModel: string;
  /** Model the full re-transcription would run. */
  finalModel: string;
  /** Captured frames that never reached the backend. */
  framesNeverSent: number;
}

export type AdoptionDecision =
  | { adopt: true; coverage: LiveCoverageReport }
  | { adopt: false; reason: AdoptionRejection };

/**
 * Decide whether a live-assist transcript may stand in for a full
 * re-transcription. Defaults to rejection: anything unproven falls back
 * to the full pass, because not losing words outranks stopping fast.
 */
export function decideLiveTranscriptAdoption(input: AdoptionInput): AdoptionDecision {
  const { envelope } = input;
  if (!envelope) return { adopt: false, reason: "no-envelope" };
  if (envelope.error) return { adopt: false, reason: "envelope-error" };
  if (envelope.source !== LOCAL_ASSIST_SOURCE) {
    return { adopt: false, reason: "not-local-assist" };
  }
  if (hasUnsentFrames(input.framesNeverSent)) {
    return { adopt: false, reason: "frames-never-sent" };
  }
  const coverage = envelope.coverage;
  if (!coverage) return { adopt: false, reason: "no-coverage-report" };
  if (!coverage.complete) return { adopt: false, reason: "incomplete-coverage" };
  if (!(coverage.totalSec > 0)) return { adopt: false, reason: "empty-session" };
  const assistModel = String(input.assistModel || "").trim();
  const finalModel = String(input.finalModel || "").trim();
  if (!assistModel || assistModel !== finalModel) {
    return { adopt: false, reason: "model-mismatch" };
  }
  if (!String(envelope.text || "").trim()) {
    return { adopt: false, reason: "empty-transcript" };
  }
  return { adopt: true, coverage };
}
