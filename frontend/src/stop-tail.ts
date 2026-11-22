/**
 * How long the microphone stays open after Stop — decided by the voice in
 * the audio, not by a fixed pause.
 *
 * Stop lands while the user is still finishing the last word far more
 * often than it looks: across 112 measured stops, 39 % left no trailing
 * silence at all and 45 % left 100 ms or less. A word cut there is not in
 * the audio, and no re-decoding can bring it back. The old answer was a
 * fixed 200 ms on every stop: too long when the user had already gone
 * quiet (most stops), too short when a long word was still sounding.
 *
 * The rule is Hex's release tail (src/dictation/release_tail.rs and
 * `DictationCapture::release_tail`), ported to the renderer's frames:
 *
 *  1. Keep at least `minMs` after the press.
 *  2. If speech does not run up to that point, stop there.
 *  3. Otherwise the speech must carry on past the stop tone — the tone
 *     plays through the speakers and a microphone can hear it, so what
 *     runs into the tone's window is not taken for speech. It must be
 *     followed by `speechRunMs` of speech (syllable gaps of up to
 *     `speechGapMs` allowed) once the tone (plus `toneMarginMs` of output
 *     and input latency) is over.
 *  4. Then wait for `quietEndMs` of quiet, and never past `maxMs`.
 *
 * Positions are milliseconds of AUDIO delivered since the take began, so
 * a burst of frames (a ScriptProcessor buffer, a main thread that was
 * busy) is judged by what it contains, not by when it arrived. The wall
 * clock only bounds the wait, for a capture that stops delivering.
 *
 * The speech verdict per frame is `observeCaptureFrame`'s
 * (./audio-levels), the one place the renderer decides "speech or not".
 *
 * Pure: no DOM, no timers. Unit-tested in tests/stop-tail.test.ts.
 */

export interface StopTailConfig {
  /** Audio always kept after the press. */
  minMs: number;
  /** The longest the tail grows while speech carries on. */
  maxMs: number;
  /** Quiet in a row that ends a growing tail. */
  quietEndMs: number;
  /** Speech in a row that counts as still talking (a key click is shorter). */
  speechRunMs: number;
  /** Quiet a run of speech may skip over, as between syllables. */
  speechGapMs: number;
  /** How long after its own length the stop tone may still reach the mic. */
  toneMarginMs: number;
  /** How long past a tail's bound the wall clock waits for its audio. */
  graceMs: number;
}

/** Where a stop's tail stands, from the audio delivered so far. */
export type StopTailState =
  /** More audio is needed; the wait is bounded by `boundMs`. */
  | { kind: "waiting"; boundMs: number; growing: boolean }
  /** Finish now; `tailMs` is the tail the rule settled on. */
  | { kind: "through"; tailMs: number; reason: StopTailReason };

/**
 * Why the tail ended: no speech at the press, speech that was only the
 * tone or did not last, the quiet after the last word, or the cap.
 */
export type StopTailReason = "quiet-at-min" | "speech-not-sustained" | "quiet-after-speech" | "capped";

interface VoiceFrame {
  startMs: number;
  endMs: number;
  speech: boolean;
}

/**
 * The recent speech verdicts of one take, positioned in audio time.
 * Only the last `historyMs` are kept: the rule never looks further back
 * than a run of speech before the press.
 */
export class VoiceTimeline {
  private frames: VoiceFrame[] = [];
  private heard = 0;

  constructor(private readonly historyMs = 2_000) {}

  /** Audio delivered so far, in ms. */
  get heardMs(): number {
    return this.heard;
  }

  /** Append one delivered frame and its speech verdict. */
  push(durationMs: number, speech: boolean): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    const startMs = this.heard;
    this.heard += durationMs;
    this.frames.push({ startMs, endMs: this.heard, speech });
    const keepFrom = this.heard - this.historyMs;
    let drop = 0;
    while (drop < this.frames.length && this.frames[drop].endMs <= keepFrom) drop += 1;
    if (drop) this.frames.splice(0, drop);
  }

  /**
   * Whether speech runs up to `endMs`: the last speech before it is
   * within a syllable gap of it, and at least `speechRunMs` of speech —
   * none of it before `fromMs` — lead up to it with no gap longer than a
   * syllable's.
   */
  talkingUntil(endMs: number, fromMs: number, config: StopTailConfig): boolean {
    let speech = 0;
    let gap = 0;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const frame = this.frames[i];
      if (frame.startMs >= endMs) continue;
      if (frame.endMs <= fromMs) return false;
      // A long frame (a ScriptProcessor buffer) may straddle either end;
      // only its part inside the window counts.
      const length = Math.min(frame.endMs, endMs) - Math.max(frame.startMs, fromMs);
      if (frame.speech) {
        speech += length;
        gap = 0;
        if (speech >= config.speechRunMs) return true;
      } else {
        gap += length;
        if (gap > config.speechGapMs) return false;
      }
    }
    return false;
  }

  /**
   * Where the first `quietEndMs` of quiet in a row at or after `fromMs`
   * ends, or null when the audio heard so far has none.
   */
  quietEnd(fromMs: number, config: StopTailConfig): number | null {
    let quiet = 0;
    for (const frame of this.frames) {
      if (frame.endMs <= fromMs) continue;
      if (frame.speech) {
        quiet = 0;
        continue;
      }
      const start = Math.max(frame.startMs, fromMs);
      const need = config.quietEndMs - quiet;
      if (frame.endMs - start >= need) return start + need;
      quiet += frame.endMs - start;
    }
    return null;
  }
}

/**
 * The tail of a stop pressed at audio position `stopAtMs`, whose stop
 * tone sounds for `toneMs` from the press (0: no tone was played).
 */
export function decideStopTail(
  timeline: VoiceTimeline,
  stopAtMs: number,
  toneMs: number,
  config: StopTailConfig,
): StopTailState {
  const heard = timeline.heardMs;
  const base = stopAtMs + config.minMs;
  const cap = stopAtMs + config.maxMs;
  if (heard < base) return { kind: "waiting", boundMs: config.minMs, growing: false };
  const capped = heard >= cap;
  const settle = (reason: StopTailReason): StopTailState => ({ kind: "through", tailMs: config.minMs, reason });
  if (!timeline.talkingUntil(base, Number.NEGATIVE_INFINITY, config)) return settle("quiet-at-min");
  // What runs into the base tail's end may be the tone; speech must carry
  // on once it is over.
  const afterTone = toneMs > 0 ? stopAtMs + toneMs + config.toneMarginMs : Number.NEGATIVE_INFINITY;
  // Hex's window after the tone is exactly one speech run of 20 ms
  // frames. The renderer's frames are ~11 ms, short enough to fall into
  // the gap between two syllables, so the window also has room for the
  // syllable gaps the run is allowed to skip.
  const decision = Math.max(base, afterTone + config.speechRunMs + config.speechGapMs);
  if (decision > cap) return settle("speech-not-sustained");
  if (heard < decision) {
    return capped ? settle("speech-not-sustained") : { kind: "waiting", boundMs: config.maxMs, growing: true };
  }
  if (!timeline.talkingUntil(decision, afterTone, config)) return settle("speech-not-sustained");
  const end = timeline.quietEnd(decision, config);
  if (end !== null) {
    const tailMs = Math.min(config.maxMs, Math.max(config.minMs, end - stopAtMs));
    return { kind: "through", tailMs, reason: "quiet-after-speech" };
  }
  if (capped) return { kind: "through", tailMs: config.maxMs, reason: "capped" };
  return { kind: "waiting", boundMs: config.maxMs, growing: true };
}

/** What a finished wait settled on, for the stop's log line. */
export interface StopTailOutcome {
  tailMs: number;
  reason: StopTailReason | "timeout";
}

/**
 * One stop waiting for its tail. `poll` is called on every delivered
 * frame and on the wall-clock deadlines; it answers once the tail is
 * decided, or once the wait for its audio is over (the bound plus
 * `graceMs`) — a capture that stopped delivering ends the wait with what
 * it has.
 */
export class StopTailWait {
  constructor(
    private readonly timeline: VoiceTimeline,
    private readonly stopAtMs: number,
    private readonly toneMs: number,
    private readonly startedAt: number,
    private readonly config: StopTailConfig,
  ) {}

  poll(now: number): StopTailOutcome | null {
    const state = decideStopTail(this.timeline, this.stopAtMs, this.toneMs, this.config);
    if (state.kind === "through") return { tailMs: state.tailMs, reason: state.reason };
    if (now >= this.startedAt + state.boundMs + this.config.graceMs) {
      return { tailMs: state.boundMs, reason: "timeout" };
    }
    return null;
  }

  /** The wall-clock instants at which `poll` is certain to answer. */
  deadlines(): number[] {
    return [
      this.startedAt + this.config.minMs + this.config.graceMs,
      this.startedAt + this.config.maxMs + this.config.graceMs,
    ];
  }
}
