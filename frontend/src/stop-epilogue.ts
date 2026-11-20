/**
 * How a stop ends — the decisions ``stopLive`` takes after the capture is
 * torn down, kept out of the 1 700-line function so they can be run and
 * tested on every input instead of being claims about its source text.
 *
 * ── Is this session empty? (``decideDrainedSilence``) ─────────────────
 *
 * The mic-health tracker's terminal state (``silent`` / ``muted`` /
 * ``lost``) exists to EXPLAIN an empty session: "the microphone was
 * muted", not the generic "no speech detected". It was also applied as a
 * VETO on a non-empty one: a headset unplugged after two minutes of
 * dictation ended the tracker in ``lost``, and the stop then wrote
 * "[ Mic not delivering audio ]" over everything that had been captured —
 * no transcript, nothing pasted — although the auto-stop on a lost track
 * exists precisely to hand over "a clean transcript up to the disconnect
 * point". The health state may only explain an empty session, never
 * overrule the evidence that the session held speech.
 */

export interface DrainedSilenceInput {
  /** ``captureSilenceSnapshot(...).silentCapture`` — the session's own
   *  measured verdict (digital silence, or nothing above its noise floor
   *  on a recording too short to trust). Absent when no provider runs. */
  silentCapture: boolean;
  /** A transcription provider is configured for this stop. */
  hasProvider: boolean;
  /** The mic-health tracker ended in a state the stop copy names as the
   *  capture hardware's fault (``STOP_COPY`` membership). */
  micHealthBad: boolean;
  /** ``summarizeCaptureLevel(...).carriedSpeech`` — at least one frame of
   *  this session rose above the room it recorded. */
  carriedSpeech: boolean;
  /** The live transcript the provider streamed back during the session. */
  liveText: string;
}

export interface DrainedSilenceDecision {
  /** End the stop as an empty session: no transcription pass runs. */
  silent: boolean;
  /** The emptiness is the microphone's fault (copy and tone say so). */
  micFault: boolean;
}

export function decideDrainedSilence(input: DrainedSilenceInput): DrainedSilenceDecision {
  const heldSpeech = input.carriedSpeech || !!String(input.liveText || "").trim();
  const micExplainsEmptiness = input.hasProvider && input.micHealthBad && !heldSpeech;
  const silent = input.silentCapture || micExplainsEmptiness;
  return { silent, micFault: silent && input.micHealthBad };
}

/**
 * ── How a stop ends (``runStopEpilogue`` and the summary resolvers) ───
 *
 * D-13 / U-022 (F/7). ``stopLive`` had six "stop without a transcript"
 * exits (discarded take, aborted start, silence, transcription skipped,
 * no provider, missing key) plus the finalization-failed catch and the
 * success path, each with its own ~25-line copy of "publish the signal,
 * hide the progress row, save the session metadata, handle the save
 * error, release the session, write the summary". Only the release
 * triplet was shared. The copies had drifted in the ways that matter:
 *
 *  - the metadata save caught ONLY the archive-moved conflict; any other
 *    failure (5xx, disk full, backend restarting) was dropped without a
 *    log and the stop reported success (FL-02) — on the success path
 *    that meant "Audio and transcript are both available" over a History
 *    entry that held no transcript;
 *  - three of the copies wrote the conflict warning and then overwrote it
 *    with the ordinary summary one line later, so the warning was never
 *    visible;
 *  - none of the six early exits ended the mic-health session, so the
 *    topbar pill kept saying "Mic live" after every recording with Auto
 *    transcribe off (FL-04).
 *
 * Every exit now states WHAT it ends with (a plan); HOW it ends is this
 * one function, and the save outcome reaches the summary on every path.
 */

export type StopEpilogueTone = "info" | "success" | "warning" | "error";

export interface StopSummaryCopy {
  status: string;
  tone: StopEpilogueTone;
}

/** What the session-metadata save at the end of a stop came to. */
export type FinalSaveOutcome =
  | { kind: "saved" }
  | { kind: "not-attempted" }
  /** The archive entry vanished or its folder went away before the save. */
  | { kind: "conflict" }
  | { kind: "failed"; message: string };

export interface FinalSaveErrorClassifier {
  isConflict(error: unknown): boolean;
  /** A short, user-safe description of the failure. */
  describe(error: unknown): string;
}

/** Run the final save and say how it went; never throws. */
export async function attemptFinalSave(
  save: () => Promise<unknown>,
  classify: FinalSaveErrorClassifier,
): Promise<FinalSaveOutcome> {
  try {
    await save();
    return { kind: "saved" };
  } catch (error) {
    if (classify.isConflict(error)) {
      console.warn("[stop] final History save hit an archive conflict", error);
      return { kind: "conflict" };
    }
    console.warn("[stop] final History save failed", error);
    return { kind: "failed", message: classify.describe(error) };
  }
}

export interface StopEpiloguePlan {
  /** What the recording-final channel carries. Never paste text: no
   *  epilogue here has a transcript to deliver. */
  signal: { domText: string; kind: "status" | "error" };
  /** The topbar status label. */
  statusLabel: string;
  /** Write the session metadata to History before the summary. */
  save: boolean;
  /** The summary the stop ends on; ``null`` leaves it as it is. */
  summary: StopSummaryCopy | null;
  /** The summary when the archive changed under the save. */
  conflictStatus?: string;
}

export interface StopEpilogueEffects {
  publish(signal: StopEpiloguePlan["signal"]): void;
  hideProgress(): void;
  setStatus(label: string): void;
  /** The metadata save, already classified (``attemptFinalSave``). */
  save(): Promise<FinalSaveOutcome>;
  /** Ends the session: live draft, mic-health session, busy flag, stop
   *  transition. Runs exactly once, whatever the save did. */
  release(): void;
  patchSummary(summary: StopSummaryCopy): void;
}

const HISTORY_SAVE_FAILED = "Saving the session to History failed:";

function worseTone(tone: StopEpilogueTone): StopEpilogueTone {
  return tone === "error" ? "error" : "warning";
}

export function resolveEpilogueSummary(
  plan: Pick<StopEpiloguePlan, "summary" | "conflictStatus">,
  outcome: FinalSaveOutcome,
): StopSummaryCopy | null {
  const base = plan.summary;
  if (!base) return null;
  if (outcome.kind === "conflict") {
    return {
      status: plan.conflictStatus
        || `${base.status} The original archive changed before the session metadata could be finalized.`,
      tone: worseTone(base.tone),
    };
  }
  if (outcome.kind === "failed") {
    return { status: `${base.status} ${HISTORY_SAVE_FAILED} ${outcome.message}`, tone: worseTone(base.tone) };
  }
  return base;
}

export async function runStopEpilogue(
  plan: StopEpiloguePlan,
  fx: StopEpilogueEffects,
): Promise<FinalSaveOutcome> {
  fx.publish(plan.signal);
  fx.hideProgress();
  fx.setStatus(plan.statusLabel);
  let outcome: FinalSaveOutcome = { kind: "not-attempted" };
  try {
    if (plan.save) outcome = await fx.save();
  } finally {
    fx.release();
  }
  const summary = resolveEpilogueSummary(plan, outcome);
  if (summary) fx.patchSummary(summary);
  return outcome;
}

export interface TranscriptStopSummary extends StopSummaryCopy {
  /** The History entry the summary links to; empty when there is none. */
  savedName: string;
}

/** The summary a stop that ran the transcription pass ends on. */
export function resolveTranscriptStopSummary(input: {
  transcriptReady: boolean;
  noSpeechStatus: string;
  persistedName: string;
  outcome: FinalSaveOutcome;
}): TranscriptStopSummary {
  const { outcome, persistedName } = input;
  if (outcome.kind === "conflict") {
    return {
      status: "Transcript is ready in memory, but the original archive changed before the final save completed.",
      tone: "warning",
      savedName: "",
    };
  }
  if (outcome.kind === "failed") {
    // The provisional save already holds the audio, so the entry exists
    // and stays linked; what it lacks is the transcript.
    return {
      status: input.transcriptReady
        ? `${HISTORY_SAVE_FAILED} ${outcome.message} The transcript was delivered but is not in History; the audio is saved.`
        : `${input.noSpeechStatus} ${HISTORY_SAVE_FAILED} ${outcome.message}`,
      tone: "warning",
      savedName: persistedName,
    };
  }
  return {
    status: input.transcriptReady
      ? "Final transcript is ready. Audio and transcript are both available."
      : input.noSpeechStatus,
    tone: "success",
    savedName: persistedName,
  };
}

/** The summary a stop whose transcription pass threw ends on. */
export function resolveFailedStopSummary(input: {
  failureMessage: string;
  persistedName: string;
  outcome: FinalSaveOutcome;
}): TranscriptStopSummary {
  const { outcome, failureMessage, persistedName } = input;
  if (outcome.kind === "conflict") {
    return {
      status: `${failureMessage} The original archive changed before fallback save completed.`,
      tone: "warning",
      savedName: "",
    };
  }
  if (outcome.kind === "failed") {
    return {
      status: `${failureMessage} ${HISTORY_SAVE_FAILED} ${outcome.message}`,
      tone: "error",
      savedName: persistedName,
    };
  }
  return { status: `${failureMessage} Audio is still available.`, tone: "error", savedName: persistedName };
}
