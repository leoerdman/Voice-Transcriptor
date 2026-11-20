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
 *  - start — the take started (at the press);
 *  - stop  — the take stopped (at the press).
 *
 * Both sound at the press, whatever the microphone. The start tone used
 * to wait for the first audio frame on a cold start, and a cold start is
 * every take on a Bluetooth headset (the warm hold refuses Bluetooth):
 * that frame lands while the headset is switching from its music profile
 * to its call profile, when its output is re-routed and muted, so the
 * 75 ms tone was never heard (user, 2026-11-20 15:36, "Leo Liberty 5 BT").
 * At the press the output has not started switching yet.
 *
 * The tone shapes are the overlay's original ones — a 75 ms rising
 * triangle for start, a 90 ms falling one for stop — at a gain the user
 * can actually hear.
 *
 * A suspended context is resumed BEFORE the tone is scheduled: its clock
 * stands still while suspended, so a tone scheduled on it lands in the
 * past once it runs and is cut or dropped. The player returns what it
 * did, for the renderer's log line — the cue leaves no other trace.
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
  // Gains raised from the overlay's 0.04 / 0.055 (user, 2026-11-20: too
  // quiet to notice); the tones stay short so they never mask speech.
  start: Object.freeze({ durationSec: 0.075, baseHz: 760, endHz: 980, gainPeak: 0.25 }),
  stop: Object.freeze({ durationSec: 0.09, baseHz: 560, endHz: 420, gainPeak: 0.3 }),
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
): (kind: RecordingCueKind) => RecordingCueResult {
  let ctx: CueAudioContext | null = null;
  return (kind) => {
    try {
      if (!ctx) ctx = createContext();
      if (!ctx) return "unavailable";
      const live = ctx;
      if (live.state === "suspended") {
        live.resume().then(() => scheduleCue(live, kind), () => {});
        return "resuming";
      }
      scheduleCue(live, kind);
      return "played";
    } catch {
      // A cue is feedback, never a reason for a recording to fail.
      return "failed";
    }
  };
}

/** What a cue did: sounded now, sounds once the output resumes, or could not. */
export type RecordingCueResult = "played" | "resuming" | "unavailable" | "failed";

function scheduleCue(ctx: CueAudioContext, kind: RecordingCueKind): void {
  try {
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
}

function defaultCueContext(): CueAudioContext | null {
  const AC = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  return AC ? new AC() : null;
}

/** The app's one cue player. */
export const playRecordingCue = createRecordingCuePlayer();
