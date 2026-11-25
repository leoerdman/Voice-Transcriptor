/**
 * The line of state a refused voice leaves in the pane (§5.3, §5.4).
 *
 * The mask zeroes a window in the copy that goes to the provider, which
 * in the transcript is indistinguishable from speech the app lost. §5.4
 * is explicit that silence reads as a lost utterance, and that a line of
 * state costs less than one: this module is that line's only writer, so
 * what the pane says about a withheld voice is decided in one place and
 * tested without a DOM.
 *
 * Three rules, in order:
 *   1. A gate that gave up says so. It forwarded audio it never judged —
 *      the opposite of a refusal — and hiding that would be a second,
 *      worse silence.
 *   2. A refusal says how much, and says where the audio still is. The
 *      recording keeps every byte (§1.4); only the provider never saw
 *      them. Without that half the line reads as data loss.
 *   3. Nothing withheld, nothing drawn. The pane carries one line less
 *      rather than a permanent note over a recording that went fine.
 *
 * Pure: no DOM, no globals. Unit-tested in tests/voice-mask-note.test.ts
 * and imported by main.tsx's ws message handler.
 */

/** What the backend reports on the ``voice-mask`` event, per hop of state. */
export interface VoiceMaskState {
  /** ``"idle"`` before any verdict about a voice, then open or closed. */
  state: "idle" | "open" | "closed";
  /** Seconds of audio this gate zeroed on purpose. */
  withheldSec: number;
  /** The gate fell behind and forwarded audio unmasked. */
  degraded: boolean;
  /** The recording's total: sent at stop, after the last flush. */
  final: boolean;
  /** The last cosine the gate judged with, absent before the first verdict. */
  score?: number | null;
  /** The pair this voice is judged by, so a meter draws the real lines. */
  openAt?: number;
  closeAt?: number;
  /**
   * Score per learned track for the window just judged.
   *
   * Several tracks are versions of one voice, and the card lights the rows
   * that matched this window: knowing which version is winning right now is
   * the only way to see a track that is doing nothing.
   */
  /** The take carried no reliable identity: nothing was withheld. */
  readonly unverified?: boolean;
  /** Seconds of this take the gate has been handed: the press counts them. */
  heardSec?: number;
  tracks?: Array<{ slot: number; score: number }>;
}

/** The gate's message on /ws/transcribe: its line, tagged. */
export type VoiceMaskMessage = { type: "voice-mask" } & VoiceMaskState;

/**
 * Read one `voice-mask` payload the backend sent.
 *
 * This lives here, and is tested here, because the parser that reads the live
 * socket returns `null` for a type it does not know: when the gate's type was
 * missing from that one function, every verdict was thrown away between the
 * socket and the switch - the card could not light a row and the pane stayed
 * empty however well the gate judged. Measured 2026-11-25: 71 state messages
 * arrived on one take and nothing was drawn.
 */
export function parseVoiceMaskMessage(value: unknown): VoiceMaskMessage | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (String(obj.type || "").trim() !== "voice-mask") return null;
  const tracks = Array.isArray(obj.tracks)
    ? obj.tracks
        .map((track) => {
          const entry = (track || {}) as Record<string, unknown>;
          return { slot: Number(entry.slot), score: Number(entry.score) };
        })
        .filter((track) => Number.isFinite(track.slot) && Number.isFinite(track.score))
    : [];
  const score = Number(obj.score);
  return {
    type: "voice-mask",
    state: obj.state === "open" || obj.state === "closed" || obj.state === "idle" ? obj.state : "idle",
    withheldSec: Number(obj.withheldSec) || 0,
    degraded: !!obj.degraded,
    unverified: !!obj.unverified,
    final: !!obj.final,
    score: Number.isFinite(score) && obj.score !== null ? score : null,
    openAt: Number(obj.openAt) || undefined,
    closeAt: Number(obj.closeAt) || undefined,
    heardSec: Number(obj.heardSec) || 0,
    tracks,
  };
}

/**
 * The names of the tracks whose score passed the open threshold.
 *
 * The name comes from a lookup by SLOT, never by position: the status list is
 * ordered but its index is not the slot's number, and indexing it with the
 * slot read the wrong track - the pane said nothing while a row was glowing.
 */
export function voiceMaskCaughtNames(
  state: VoiceMaskState,
  nameForSlot: (slot: number) => string,
): string[] {
  const open = Number(state.openAt ?? 0.5);
  return (state.tracks ?? [])
    .filter((track) => Number(track.score) >= open)
    .map((track) => nameForSlot(track.slot).trim())
    .filter((name) => name.length > 0);
}

export function formatWithheld(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  if (safe > 0 && safe < 0.1) return "under 0.1 s";
  return `${safe.toFixed(1)} s`;
}

/**
 * Which tracks are catching this take, by name.
 *
 * The rows that glow live in Settings, and nobody is in Settings while they
 * speak: the pane is where a take happens, so the tracks that matched are
 * named here, in the one line already being read.
 */
export function voiceMaskCaughtText(names: readonly string[]): string {
  const clean = names.map((name) => name.trim()).filter((name) => name.length > 0);
  if (clean.length === 0) return "";
  return `Catching: ${clean.join(", ")}.`;
}

export function voiceMaskNoteText(state: VoiceMaskState): string {
  const withheld = formatWithheld(state.withheldSec);
  const refused = state.withheldSec > 0;

  if (state.degraded) {
    // The one message that must never be optimised away: from here on,
    // everything was sent without a judgement. What was refused before
    // that point still was, so both halves are stated.
    const before = refused
      ? ` ${withheld} was withheld before that.`
      : "";
    return `Solo stopped keeping up and withheld what it could not judge. Your recording is safe in History - turn Solo off, or record again to try once more.${before}`;
  }

  if (!refused) return "";

  if (state.final) {
    // "not sent", not "not transcribed": what the mask withholds never
    // reached the provider, and the recording still holds every byte of
    // it (§1.4). Claiming more than that would be the pane's own bug.
    return `Solo withheld ${withheld} of another voice. It is still in the recording; it was not sent.`;
  }

  return `Solo is withholding another voice — ${withheld} so far.`;
}
