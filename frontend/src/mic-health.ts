/**
 * Microphone health — the single source of truth for the question
 * "is the capture pipeline actually delivering audio?".
 *
 * Motivation: on macOS a TCC (privacy) reset — which happens on every
 * reinstall because the ad-hoc code signature changes — does **not**
 * make ``getUserMedia`` reject. It resolves with a live
 * ``MediaStreamTrack`` that emits digital silence forever. The old
 * pipeline had no way to tell that apart from "the user did not speak",
 * so a whole dictation session was saved as a zero-byte-signal WAV and
 * reported as "No speech captured".
 *
 * The discriminator is therefore **not** loudness. A working microphone
 * in a soundproof room still dithers above one 16-bit LSB within a
 * 50 ms window; a dead pipeline emits exactly 0.0. Anything above the
 * dead floor proves the pipeline works and is treated as healthy, no
 * matter how quiet — false "your mic is broken" banners during a normal
 * pause between sentences are far more damaging than missing a genuinely
 * broken mic for a couple of extra seconds.
 *
 * The FSM below is pure and clock-injected so it can be unit tested
 * deterministically (see ``frontend/tests/mic-health.test.ts``). All
 * user-visible copy lives in ``STATUS_FOR_STATE`` and is derived from
 * the resulting state, never passed alongside it — that keeps status
 * text single-sourced.
 */

export type MicHealthState =
  | "idle"
  | "probing"
  | "live"
  | "silent"
  | "muted"
  | "lost";

export type MicHealthTone = "info" | "warning" | "error";

export type MicHealthObservation =
  | { kind: "session-start"; deviceId: string }
  | { kind: "session-stop" }
  | { kind: "rms"; rms: number; peak: number }
  | { kind: "track-muted"; muted: boolean }
  | { kind: "track-ended" }
  | { kind: "stream-error"; message: string }
  | { kind: "force-silent"; reason: string };

export interface MicHealthSnapshot {
  state: MicHealthState;
  /** Machine-readable reason for the current state, for logs/telemetry. */
  detail: string;
  /** ``deviceId`` reported by the track that opened this session. */
  deviceId: string;
  /**
   * Continuous milliseconds of digital silence in the current dwell.
   * Reset on every state change and on every sample that carries signal.
   */
  silenceMs: number;
  /**
   * Timestamp of the last observation. The FSM derives real elapsed time
   * from it instead of assuming a fixed sampling cadence, so a stalled
   * or re-scheduled interval cannot skew the dwell timers.
   */
  lastSampleMs: number;
}

/**
 * One 16-bit LSB. A real ADC exceeds this within a single 50 ms window
 * even in a silent room; a permission-blocked stream never does.
 */
export const DEAD_PEAK_FLOOR = 1 / 32768;
export const DEAD_RMS_FLOOR = DEAD_PEAK_FLOOR / 4;
/**
 * Digital silence tolerated right after start before flagging the mic.
 *
 * A working capture path exceeds one 16-bit LSB within a single 50 ms
 * window, so waiting seconds buys no extra certainty — it only delays
 * the warning. 2500 ms was slow enough that a 2.8 s recording ended
 * before the pill ever turned red, and the user was left with a silent
 * WAV and no explanation.
 */
export const PROBE_TIMEOUT_MS = 1200;
/** Digital silence tolerated mid-session before flagging the mic. */
export const SILENT_CONFIRM_MS = 4000;
/**
 * Upper bound applied to a single inter-sample delta. Protects the dwell
 * timers from a suspended/throttled timer resuming after minutes and
 * tripping a state change from one observation.
 */
export const MAX_SAMPLE_GAP_MS = 250;

/**
 * The wording has to work for the case that actually happens most: the
 * permission is ALREADY enabled and macOS still reports "granted", but
 * the stream is silent because a reinstall changed the app's code
 * identity and the grant went stale. Telling that user to "enable
 * Transcriptor" is advice they have already followed, so the message
 * names the off/on cycle that re-issues the grant to the new binary.
 */
export const MIC_SILENT_HELP =
  "Microphone is not delivering audio. Open System Settings → Privacy & Security → Microphone: if Transcriptor is not listed or is off, enable it. If it is already on, the permission went stale after an app update — switch it off and back on, then restart Transcriptor.";
export const MIC_MUTED_HELP =
  "Microphone is muted in the operating system — unmute the input device to capture audio.";
export const MIC_LOST_HELP =
  "Microphone stream ended unexpectedly — re-select the input device and start a new recording.";

const STATUS_FOR_STATE: Record<
  MicHealthState,
  { statusText: string; statusTone: MicHealthTone }
> = {
  idle: { statusText: "", statusTone: "info" },
  probing: { statusText: "Connecting microphone…", statusTone: "info" },
  live: { statusText: "", statusTone: "info" },
  silent: { statusText: MIC_SILENT_HELP, statusTone: "error" },
  muted: { statusText: MIC_MUTED_HELP, statusTone: "warning" },
  lost: { statusText: MIC_LOST_HELP, statusTone: "error" },
};

/**
 * User-visible copy for a state. The renderer, the recording-summary
 * patcher and the stop-time failure classifier all read from here so
 * the wording has exactly one definition site.
 */
export function describeMicHealth(state: MicHealthState): {
  statusText: string;
  statusTone: MicHealthTone;
} {
  return STATUS_FOR_STATE[state];
}

/** A recording summary's status line, as the mic-health warning sees it. */
export interface MicHealthStatusLine {
  status: string;
  tone: string;
}

const MIC_HEALTH_STATUS_TEXTS: ReadonlySet<string> = new Set(
  Object.values(STATUS_FOR_STATE).map((s) => s.statusText).filter(Boolean),
);

/**
 * What the recording summary's status line should become when the
 * microphone's health changes — the warning's own lifecycle, not just its
 * entry.
 *
 * Entering a bad state shows its warning and keeps the line it displaced.
 * Returning to `live` puts that line back, but only while the warning is
 * still what the summary shows: a status written since (a stream error,
 * "Saving…") is newer news and stays. Before this, the warning was only
 * ever written, never withdrawn: a Bluetooth headset is digitally silent
 * for its first second while it switches to its call profile, the probe
 * rightly said "not delivering audio", the pill went back to *Mic live*
 * — and the red banner stayed for the whole take (user, 2026-11-20 15:47).
 *
 * @returns the patch to apply (null: leave the line alone) and the line
 *          to restore later.
 */
export function reconcileMicHealthStatus(
  state: MicHealthState,
  current: MicHealthStatusLine,
  displaced: MicHealthStatusLine | null,
): { patch: MicHealthStatusLine | null; displaced: MicHealthStatusLine | null } {
  const showingWarning = MIC_HEALTH_STATUS_TEXTS.has(current.status);
  if (state === "silent" || state === "muted" || state === "lost") {
    const { statusText, statusTone } = STATUS_FOR_STATE[state];
    return {
      patch: { status: statusText, tone: statusTone },
      displaced: showingWarning ? displaced : { ...current },
    };
  }
  if (state === "live" && showingWarning) {
    return { patch: displaced ?? { status: "", tone: "info" }, displaced: null };
  }
  if (state === "idle") return { patch: null, displaced: null };
  return { patch: null, displaced };
}

export function initialSnapshot(): MicHealthSnapshot {
  return {
    state: "idle",
    detail: "",
    deviceId: "",
    silenceMs: 0,
    lastSampleMs: 0,
  };
}

export interface TransitionInput {
  nowMs: number;
  last: MicHealthSnapshot;
  obs: MicHealthObservation;
}

export interface TransitionResult {
  next: MicHealthSnapshot;
  statusText: string;
  statusTone: MicHealthTone;
  /**
   * Non-null only on the edge that *enters* a bad state. Callers may
   * surface it once; it is never repeated while the state persists.
   */
  notice: string | null;
}

/**
 * Builds a transition result, deriving the user-visible copy from the
 * resulting state so status text has exactly one definition site.
 */
function settle(next: MicHealthSnapshot, notice: string | null): TransitionResult {
  const status = STATUS_FOR_STATE[next.state];
  return {
    next,
    statusText: status.statusText,
    statusTone: status.statusTone,
    notice,
  };
}

/** True when the sample window contains nothing but digital silence. */
export function isDigitalSilence(rms: number, peak: number): boolean {
  return !(rms >= DEAD_RMS_FLOOR || peak >= DEAD_PEAK_FLOOR);
}

export function nextMicHealth(input: TransitionInput): TransitionResult {
  const { nowMs, last, obs } = input;
  switch (obs.kind) {
    case "session-start":
      return settle(
        {
          state: "probing",
          detail: "waiting for first samples",
          deviceId: obs.deviceId,
          silenceMs: 0,
          lastSampleMs: nowMs,
        },
        null,
      );

    case "session-stop":
      return settle(initialSnapshot(), null);

    case "track-ended":
      if (last.state === "idle") return settle(last, null);
      return settle(
        { ...last, state: "lost", detail: "audio track ended", silenceMs: 0, lastSampleMs: nowMs },
        MIC_LOST_HELP,
      );

    case "stream-error":
      if (last.state === "idle") return settle(last, null);
      return settle(
        { ...last, state: "lost", detail: obs.message, silenceMs: 0, lastSampleMs: nowMs },
        `Microphone stream error: ${obs.message}`,
      );

    case "track-muted":
      if (last.state === "idle" || last.state === "lost") return settle(last, null);
      if (obs.muted) {
        if (last.state === "muted") return settle(last, null);
        return settle(
          { ...last, state: "muted", detail: "track.muted=true", silenceMs: 0, lastSampleMs: nowMs },
          MIC_MUTED_HELP,
        );
      }
      if (last.state !== "muted") return settle(last, null);
      // Unmuted: go back to probing rather than straight to live — the
      // pipeline still has to prove it delivers samples.
      return settle(
        { ...last, state: "probing", detail: "unmuted, re-probing", silenceMs: 0, lastSampleMs: nowMs },
        null,
      );

    case "force-silent":
      if (last.state === "silent") return settle(last, null);
      return settle(
        { ...last, state: "silent", detail: obs.reason, silenceMs: 0, lastSampleMs: nowMs },
        MIC_SILENT_HELP,
      );

    case "rms": {
      // A muted or ended track is diagnosed by its own event; samples
      // only refresh the clock so a later transition starts from a fresh
      // base instead of an arbitrarily old timestamp.
      if (last.state === "idle" || last.state === "muted" || last.state === "lost") {
        return settle({ ...last, lastSampleMs: nowMs }, null);
      }

      const alive = !isDigitalSilence(obs.rms, obs.peak);
      const deltaMs = Math.min(
        MAX_SAMPLE_GAP_MS,
        Math.max(0, nowMs - (last.lastSampleMs || nowMs)),
      );

      if (alive) {
        if (last.state === "live") {
          return settle({ ...last, silenceMs: 0, lastSampleMs: nowMs }, null);
        }
        // Any sample above the dead floor proves the capture path works,
        // regardless of how quiet the room is.
        return settle(
          {
            ...last,
            state: "live",
            detail: last.state === "silent" ? "signal recovered" : "signal detected",
            silenceMs: 0,
            lastSampleMs: nowMs,
          },
          null,
        );
      }

      const silenceMs = last.silenceMs + deltaMs;
      const dwellLimit = last.state === "probing" ? PROBE_TIMEOUT_MS : SILENT_CONFIRM_MS;
      if (last.state !== "silent" && silenceMs >= dwellLimit) {
        return settle(
          {
            ...last,
            state: "silent",
            detail:
              last.state === "probing"
                ? `no samples within ${PROBE_TIMEOUT_MS} ms of start`
                : `digital silence for ${SILENT_CONFIRM_MS} ms`,
            silenceMs: 0,
            lastSampleMs: nowMs,
          },
          MIC_SILENT_HELP,
        );
      }
      return settle({ ...last, silenceMs, lastSampleMs: nowMs }, null);
    }

    default: {
      const exhaustive: never = obs;
      void exhaustive;
      return settle(last, null);
    }
  }
}

export type MicHealthListener = (snap: MicHealthSnapshot) => void;

/**
 * Stateful wrapper around {@link nextMicHealth}. Listeners are
 * edge-triggered: they fire only when the state actually changes, so a
 * 20 Hz sampling loop cannot turn into a re-render / notice storm.
 */
export class MicHealthTracker {
  private snap: MicHealthSnapshot = initialSnapshot();
  private listeners: Set<MicHealthListener> = new Set();

  constructor(private now: () => number = () => Date.now()) {}

  get(): MicHealthSnapshot {
    return this.snap;
  }

  observe(obs: MicHealthObservation): TransitionResult {
    const result = nextMicHealth({ nowMs: this.now(), last: this.snap, obs });
    const changed = result.next.state !== this.snap.state;
    this.snap = result.next;
    if (changed) {
      for (const fn of this.listeners) fn(this.snap);
    }
    return result;
  }

  subscribe(fn: MicHealthListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  reset(): void {
    const changed = this.snap.state !== "idle";
    this.snap = initialSnapshot();
    if (changed) {
      for (const fn of this.listeners) fn(this.snap);
    }
  }
}
