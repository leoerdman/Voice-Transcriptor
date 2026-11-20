/**
 * The short tones that mark a recording's start and stop.
 *
 * They lived in the legacy visual overlay window and were deleted with it
 * on 2026-07-02 (1a8aa6b, "Remove legacy visual recording overlay"):
 * ``playOverlayCue`` became an empty function and the app went silent.
 * They belong to the renderer because only the renderer knows the two
 * moments that matter, whatever started or stopped the take (hotkey,
 * button, auto-stop):
 *
 *  - start — the first audio frame arrived, i.e. the microphone is really
 *    recording and it is safe to speak;
 *  - stop  — the take stopped.
 *
 * The tone shapes are the overlay's original ones: a 75 ms rising
 * triangle for start, a 90 ms falling one for stop, both quiet.
 *
 * Best effort by design: a cue never throws and never delays the
 * recording path. Tested with a fake AudioContext —
 * frontend/tests/recording-cues.test.ts.
 */

export type RecordingCueKind = "start" | "stop";

export interface RecordingCueSpec {
  durationSec: number;
  baseHz: number;
  endHz: number;
  gainPeak: number;
}

export const RECORDING_CUES: Readonly<Record<RecordingCueKind, Readonly<RecordingCueSpec>>> = Object.freeze({
  start: Object.freeze({ durationSec: 0.075, baseHz: 760, endHz: 980, gainPeak: 0.04 }),
  stop: Object.freeze({ durationSec: 0.09, baseHz: 560, endHz: 420, gainPeak: 0.055 }),
});

/** Attack of the gain envelope, seconds. */
export const CUE_ATTACK_SEC = 0.012;
/** The oscillator runs this much past the envelope's end. */
const CUE_RELEASE_TAIL_SEC = 0.01;
/** Exponential ramps cannot reach zero; this is "silent". */
const CUE_SILENT_GAIN = 0.0001;

type CueAudioContext = Pick<AudioContext, "currentTime" | "state" | "destination" | "resume" | "createOscillator" | "createGain">;

/**
 * A player that owns one AudioContext for every cue (created on the first
 * cue, not at import, so a window that never records never opens audio).
 */
export function createRecordingCuePlayer(
  createContext: () => CueAudioContext | null = defaultCueContext,
): (kind: RecordingCueKind) => void {
  let ctx: CueAudioContext | null = null;
  return (kind) => {
    try {
      if (!ctx) ctx = createContext();
      if (!ctx) return;
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const cue = RECORDING_CUES[kind];
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(cue.baseHz, now);
      osc.frequency.exponentialRampToValueAtTime(cue.endHz, now + cue.durationSec);
      gain.gain.setValueAtTime(CUE_SILENT_GAIN, now);
      gain.gain.exponentialRampToValueAtTime(cue.gainPeak, now + CUE_ATTACK_SEC);
      gain.gain.exponentialRampToValueAtTime(CUE_SILENT_GAIN, now + cue.durationSec);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + cue.durationSec + CUE_RELEASE_TAIL_SEC);
    } catch {
      // A cue is feedback, never a reason for a recording to fail.
    }
  };
}

function defaultCueContext(): CueAudioContext | null {
  const AC = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  return AC ? new AC() : null;
}

/** The app's one cue player. */
export const playRecordingCue = createRecordingCuePlayer();
