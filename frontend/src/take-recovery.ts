/**
 * A take the app died in, put back together at the next launch — pure.
 *
 * A crash mid-take leaves two things behind, both keyed by the take's
 * live session id:
 *
 *   • the backend's audio spool, which the boot promotes into a History
 *     entry (`_promote_live_recovery`): the audio, and — for a screen
 *     take — its screenshots adopted beside it with their manifest; its
 *     text file says only "[Recovered live audio capture]";
 *   • the renderer's crash draft (./live-draft): the live text the user
 *     watched appear, autosaved while the take ran.
 *
 * They used to be recovered separately: the audio and screenshots in one
 * History entry with no text, the live text in a second, text-only entry
 * with no audio — and not one screen mark anywhere, so the TRANSCRIBE
 * panel showed the words without the strokes and screenshots they were
 * about. The plan below joins them: the promoted entry of the draft's
 * take gets the draft's text with the take's marks placed in it, by the
 * composer every screen-take transcript goes through
 * (./screen-annotations `annotateTranscript`). A promoted screen take with
 * no draft still gets its marks; a draft whose take has no promoted entry
 * is saved on its own, as before.
 */

import type { PersistedLiveDraft } from "./live-draft";
import { recoveredDraftProvider } from "./live-draft";
import { smartRecordingTitle } from "./recording-title";
import {
  annotateTranscript,
  parseScreenManifest,
  screenAnnotationFromManifest,
  screenSessionDurationMs,
  type ScreenManifest,
} from "./screen-annotations";

/** A History entry the boot promoted from a crashed take's audio spool. */
export interface PromotedTake {
  sessionId: string;
  name: string;
  archiveDir: string;
  /** The adopted screen manifest (archived paths); null for a voice take. */
  screens: ScreenManifest | null;
  /** What the promotion wrote into the entry's text file. */
  title: string;
  sourceText: string;
  provider: string;
  model: string;
  language: string;
}

/** The promote endpoint's answer for one session; null when it names no entry. */
export function parsePromotedTake(sessionId: string, body: unknown): PromotedTake | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const text = (key: string): string => (typeof b[key] === "string" ? (b[key] as string).trim() : "");
  const name = text("name");
  const id = String(sessionId || "").trim();
  if (!name || !id) return null;
  return {
    sessionId: id,
    name,
    archiveDir: text("archive_dir"),
    screens: parseScreenManifest(b.screens),
    title: text("title"),
    sourceText: text("source_text"),
    provider: text("provider"),
    model: text("model"),
    language: text("language"),
  };
}

/**
 * The transcript of a recovered take: its words with its screen marks,
 * placed by their share of the take's duration (a crash leaves no word
 * timings). The manifest's own clock is the time frame — the backend
 * writes `endedAt` from the spool when the take never stopped.
 */
export function recoveredTakeTranscript(spoken: string, screens: ScreenManifest | null): string {
  const words = String(spoken || "").trim();
  if (!screens) return words;
  return annotateTranscript(words, screenAnnotationFromManifest(screens), {
    durationMs: screenSessionDurationMs(screens),
  }).trim();
}

/** One promoted entry rewritten with its recovered text. */
export interface TakeTextWrite {
  name: string;
  archiveDir: string;
  title: string;
  sourceText: string;
  transcriptText: string;
  /** The words alone, without the screen marks. */
  spokenText: string;
  provider: string;
  model: string;
  language: string;
  /** Its words came from the crash draft. */
  fromDraft: boolean;
}

export interface TakeRecoveryPlan {
  /** Promoted entries to rewrite: the draft's take, and screen takes with marks. */
  writes: TakeTextWrite[];
  /** The draft's take had no promoted entry: the draft is saved on its own. */
  draftAlone: boolean;
  /** The draft is fully accounted for once these writes succeed (none
   *  needed when it was empty or its take wrote nothing). */
  draftInWrites: boolean;
  /** The write the TRANSCRIBE panel shows when the draft is not saved
   *  alone: the draft's take, else the last screen take recovered. */
  shown: TakeTextWrite | null;
}

/** The words a draft holds: its transcript, else its live text. */
export function draftSpokenText(draft: PersistedLiveDraft | null): string {
  if (!draft) return "";
  return String(draft.transcript_text || "").trim() || String(draft.source_text || "").trim();
}

export function planTakeRecovery(
  draft: PersistedLiveDraft | null,
  promoted: ReadonlyArray<PromotedTake>,
): TakeRecoveryPlan {
  const draftSession = String(draft?.session_id || "").trim();
  const spokenInDraft = draftSpokenText(draft);
  let draftMatched = false;
  const writes: TakeTextWrite[] = [];
  for (const take of promoted) {
    const fromDraft = !!draft && !!draftSession && take.sessionId === draftSession;
    if (fromDraft) draftMatched = true;
    const spoken = fromDraft ? spokenInDraft : "";
    const transcriptText = recoveredTakeTranscript(spoken, take.screens);
    if (!transcriptText) continue;
    const draftSource = fromDraft ? String(draft?.source_text || "").trim() : "";
    writes.push({
      name: take.name,
      archiveDir: take.archiveDir,
      title: spoken ? `${smartRecordingTitle(spoken, take.title)} (Recovered)` : take.title,
      sourceText: draftSource || take.sourceText,
      transcriptText,
      spokenText: spoken,
      provider: fromDraft && draft ? recoveredDraftProvider(draft) : take.provider,
      model: (fromDraft && String(draft?.model || "").trim()) || take.model,
      language: (fromDraft && String(draft?.language || "").trim()) || take.language,
      fromDraft,
    });
  }
  const draftWrite = writes.find((w) => w.fromDraft) || null;
  const draftAlone = !!draft && !draftMatched && !!spokenInDraft;
  return {
    writes,
    draftAlone,
    draftInWrites: !!draftWrite,
    shown: draftWrite || (draftAlone ? null : writes[writes.length - 1] || null),
  };
}
