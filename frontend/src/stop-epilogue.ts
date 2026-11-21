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

import { smartRecordingTitle } from "./recording-title";
import {
  EMPTY_SCREEN_ANNOTATION,
  annotateTranscript,
  hasScreenAnnotation,
  type ScreenAnnotation,
} from "./screen-annotations";

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

/**
 * ── What the final History save writes (``createSessionMetadataSaver``) ──
 *
 * Every exit of a stop writes the session metadata through this one
 * saver. It owns the two decisions the History entry is made of:
 *
 *  - the TITLE comes from what was SAID: the final transcript without its
 *    screen marks when the stop has one, else the live text streamed
 *    during the session, else the caller's default ("Recording <date>").
 *    The final transcript is what History stores, so it is what names the
 *    entry — the live text can be empty (local provider) or differ from
 *    it (Deepgram REST recovery, upscale, re-decode), and screen marks
 *    say nothing about the recording;
 *  - the save failure is classified (``attemptFinalSave``), never thrown.
 *
 * It used to read its title from the live text on every path, so the
 * success path archived a transcribed recording under the live text's
 * title (often the date default) while the summary showed the
 * transcript's — the save and the summary disagreed about one name.
 */

/** The fields of the final save this module decides. */
export interface SessionSaveRequest {
  name: string;
  archiveDir: string;
  requireExisting: boolean;
  title: string;
  sourceText: string;
  transcriptText: string;
  /** The words said, without screen marks or a status line: what History
   *  counts words in (backend ``SPOKEN_SECTION_LABEL``). */
  spokenText: string;
  provider: string;
}

export interface SessionMetadataInput {
  /** What was SAID — without screen marks: the final transcript, else the
   *  live words the take kept (``KeptTranscript.words``). Empty when
   *  nothing was said. */
  spokenTranscript: string;
  /** What History stores as the transcript: screen marks included; a
   *  status line ("[ Silence ]") on an empty session; "" otherwise. */
  transcriptText: string;
  provider: string;
}

export interface SessionMetadataSaverDeps {
  /** The History entry the provisional save created (empty: none yet). */
  target(): { name: string; archiveDir: string };
  /** The live source text at the moment of the save — read late, since
   *  final events can still land while the socket drains. */
  liveSourceText(): string;
  /** The name when neither the transcript nor the live text has a word. */
  fallbackTitle: string;
  save(request: SessionSaveRequest): Promise<unknown>;
  classify: FinalSaveErrorClassifier;
}

/** The title a session is archived under (rule above). */
export function resolveSessionTitle(
  spokenTranscript: string,
  liveSourceText: string,
  fallbackTitle: string,
): string {
  const spoken = String(spokenTranscript || "");
  return smartRecordingTitle(spoken.trim() ? spoken : liveSourceText, fallbackTitle);
}

export function createSessionMetadataSaver(
  deps: SessionMetadataSaverDeps,
): (input: SessionMetadataInput) => Promise<FinalSaveOutcome> {
  return (input) => attemptFinalSave(() => {
    const { name, archiveDir } = deps.target();
    const sourceText = deps.liveSourceText();
    return deps.save({
      name,
      archiveDir,
      requireExisting: !!name,
      title: resolveSessionTitle(input.spokenTranscript, sourceText, deps.fallbackTitle),
      sourceText,
      transcriptText: input.transcriptText,
      spokenText: input.spokenTranscript,
      provider: input.provider,
    });
  }, deps.classify);
}

/**
 * ── What a take keeps when it has no final transcript (``keepLiveTranscript``) ──
 *
 * The live text the provider streamed during the take, with the take's
 * screen marks placed in it by the one composer
 * (``annotateTranscript``). Every stop that ends without a final
 * transcript — the transcription pass threw, the final came back empty,
 * the microphone delivered nothing, Auto transcribe is off, no provider
 * key — used to end on a status line in the TRANSCRIBE panel and an
 * empty transcript in History: the words the user had watched appear in
 * the live preview, and every stroke and screenshot mark of a screen
 * take, were gone from both. What the take kept is now what the panel
 * shows and History stores, and the summary says it is the live text.
 *
 * The marks are placed by their share of the take's duration: the live
 * text has no word timings the stop can trust.
 */
export interface KeptTranscript {
  /** Live text with marks; "" when the take has neither. */
  text: string;
  /** One sentence for the summary saying what ``text`` is; "" with no text. */
  note: string;
  /** ``text`` holds words that were said, not only screen marks. */
  spoken: boolean;
  /** The live words alone, without the marks; "" with none. */
  words: string;
  /** The take's screen annotation (empty for a voice take): what a
   *  marks-only text is recomposed from when a reason joins it. */
  screen: ScreenAnnotation;
}

export const NOTHING_KEPT: KeptTranscript = Object.freeze({
  text: "",
  note: "",
  spoken: false,
  words: "",
  screen: EMPTY_SCREEN_ANNOTATION,
});

/**
 * The transcript a no-transcript stop stores and shows: the kept text, but
 * a take that kept only marks still says WHY there is no speech — the
 * "[ Silence ]" / "[ Mic not delivering audio ]" marker heads its body,
 * under the header and above the marks (the composer's ``silence``).
 */
export function keptTranscriptText(kept: KeptTranscript, marker: string): string {
  const reason = String(marker || "").trim();
  if (!kept.text) return String(marker || "");
  if (kept.spoken || !reason) return kept.text;
  return annotateTranscript("", kept.screen, { silence: reason });
}

export function keepLiveTranscript(
  liveText: string,
  screen: ScreenAnnotation,
  durationMs: number,
): KeptTranscript {
  const live = String(liveText || "").trim();
  const text = annotateTranscript(live, screen, { durationMs }).trim();
  if (!text) return NOTHING_KEPT;
  const note = live && hasScreenAnnotation(screen)
    ? "The live text and the screen marks are kept as the transcript."
    : live
      ? "The live text is kept as the transcript."
      : "The screen marks are kept as the transcript.";
  return { text, note, spoken: !!live, words: live, screen };
}

/** A summary that says what the take kept, when it kept anything. */
export function withKeptNote<T extends StopSummaryCopy>(summary: T, kept: KeptTranscript): T {
  return kept.text ? { ...summary, status: `${summary.status} ${kept.note}` } : summary;
}

/**
 * The transcription pass ran and came back empty while the live preview
 * held words (the envelope never came and the saved-audio decode gave
 * nothing in its budget; an empty remote pass): the take ends on what it
 * kept, not on "no speech detected". A take whose live text is empty too
 * keeps the old ending — its transcript is its marks, if any.
 */
export function emptyFinalKeepsLiveText(finalTranscript: string, liveText: string): boolean {
  return !String(finalTranscript || "").trim() && !!String(liveText || "").trim();
}

export const EMPTY_FINAL_STATUS = "The final pass produced no transcript.";

/** The summary of a stop whose empty final was replaced by the kept text. */
export function resolveEmptyFinalSummary(kept: KeptTranscript, outcome: FinalSaveOutcome): StopSummaryCopy {
  const base = withKeptNote<StopSummaryCopy>({ status: EMPTY_FINAL_STATUS, tone: "warning" }, kept);
  return resolveEpilogueSummary({ summary: base }, outcome) || base;
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
  /** What History stores as the transcript when the take kept nothing
   *  (a status line such as "[ Silence ]"; "" by default). */
  transcriptText?: string;
  /** The live text with marks the take keeps (``keepLiveTranscript``). */
  kept?: KeptTranscript;
}

export interface StopEpilogueEffects {
  /** ``panelText`` is what the TRANSCRIBE panel shows: the kept text, or
   *  the signal's own text when the take kept nothing. The signal itself
   *  stays a short status — it is what the capsule says. */
  publish(signal: StopEpiloguePlan["signal"], panelText: string): void;
  hideProgress(): void;
  setStatus(label: string): void;
  /** The metadata save, already classified (``attemptFinalSave``), of the
   *  transcript the epilogue resolved and the words said in it. */
  save(transcriptText: string, spokenTranscript: string): Promise<FinalSaveOutcome>;
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
  const kept = plan.kept || NOTHING_KEPT;
  // The marker a marks-only take keeps above its marks is the transcript
  // the take would have stored without them ("[ Silence ]"), never a
  // status sentence ("Auto transcribe is off…"); with no such transcript
  // the panel falls back to the status, as before.
  fx.publish(plan.signal, kept.text ? keptTranscriptText(kept, plan.transcriptText || "") : plan.signal.domText);
  fx.hideProgress();
  fx.setStatus(plan.statusLabel);
  let outcome: FinalSaveOutcome = { kind: "not-attempted" };
  try {
    if (plan.save) outcome = await fx.save(keptTranscriptText(kept, plan.transcriptText || ""), kept.words);
  } finally {
    fx.release();
  }
  const summary = resolveEpilogueSummary(
    { ...plan, summary: plan.summary && withKeptNote(plan.summary, kept) },
    outcome,
  );
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
