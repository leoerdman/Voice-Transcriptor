/**
 * Warm capture — the decisions that let a recording begin with audio
 * already in hand.
 *
 * Why it exists (BUGS_AUDIT_2026-09-03 §4.7). Measured on 2026-09-03,
 * the cold start path costs `getUserMedia: 82 ms → audioContext: 33 ms
 * → first-frame: 172 ms`: for ~310 ms after the hotkey nothing is
 * recording, and the first syllable of a phrase begun on the press is
 * absent from the WAV *and* from the live stream. When the input device
 * is busy the same path is measured in seconds. Nothing downstream can
 * recover audio that was never captured.
 *
 * Two mechanisms remove it, and both are decided here:
 *
 *   1. WARM HOLD — after Stop the MediaStream, AudioContext and capture
 *      worklet are kept alive for a bounded idle window instead of being
 *      torn down, so the next start pays none of those three costs.
 *   2. PRE-ROLL — while held, the worklet keeps the last few hundred
 *      milliseconds of PCM in a ring buffer and hands it over on the
 *      next start, so the recording begins *before* the hotkey press.
 *
 * The same shape is what the reference implementations converged on:
 * Hex keeps a 1 s ring and pre-rolls 450 ms while warm; whisper-local
 * never closes its input stream at all and trims a 500 ms deque while
 * idle, having found that "opening/closing streams per recording was the
 * source of first-word-clipped bugs"; OpenWhispr holds a master stream
 * and clones a track per recording, expiring pre-roll chunks at 2 s.
 *
 * This module is pure: no DOM, no Web Audio, no timers. `main.tsx` owns
 * the resources and asks these functions what to do with them, so every
 * rule below is unit-tested in tests/capture-warm.test.ts rather than
 * only reachable through a live microphone.
 */

/** Verdict shape shared by every decision here: what, and why. */
export interface CaptureDecision {
  /** The reason code, for the support log. Stable, greppable, lowercase. */
  reason: string;
}

export interface WarmHoldDecision extends CaptureDecision {
  hold: boolean;
}

export interface WarmReuseDecision extends CaptureDecision {
  reuse: boolean;
}

/**
 * Input-device labels that mean "this is a Bluetooth microphone".
 *
 * Holding the microphone open on a Bluetooth headset is not free the way
 * it is on a built-in or USB input: as long as *any* application holds
 * the input, the device stays in the Hands-Free Profile, whose uplink is
 * a narrowband mono codec and whose downlink drops the headset out of
 * A2DP — music and call audio audibly degrade, and stay degraded for the
 * whole hold window. MacParakeet and Handy both disable their warm hold
 * on Bluetooth inputs for exactly this reason.
 *
 * The label is the only signal available. Chromium exposes no transport
 * or bus type on `MediaTrackSettings` or `MediaTrackCapabilities` — the
 * settings dictionary carries `deviceId`, `groupId`, channel/rate and the
 * processing flags, and nothing that distinguishes USB from Bluetooth —
 * so a device-name match is not a shortcut here, it is the whole of what
 * the platform will tell us.
 *
 * The list deliberately over-matches. A false positive costs one
 * optimisation (the next recording starts cold, exactly as it does
 * today); a false negative degrades the user's headset audio for 30 s
 * after every dictation. Those are not comparable, so the tie goes to
 * releasing the device.
 */
const BLUETOOTH_LABEL_TOKENS = [
  "bluetooth",
  "hands-free",
  "handsfree",
  "hands free",
  "hfp",
  "a2dp",
  "airpods",
  "beats",
  "headset",
  "wireless",
  "wh-1000",
  "wf-1000",
  "jabra",
  "soundcore",
  "galaxy buds",
];

/**
 * Does this input-device label describe a Bluetooth microphone?
 *
 * Case- and whitespace-insensitive substring match against
 * {@link BLUETOOTH_LABEL_TOKENS}. An empty label is treated as Bluetooth:
 * a device we cannot name is a device we cannot clear, and the safe
 * answer is the one that releases it.
 */
export function isBluetoothInputLabel(label: string): boolean {
  const normalized = String(label ?? "").trim().toLowerCase();
  if (!normalized) return true;
  return BLUETOOTH_LABEL_TOKENS.some((token) => normalized.includes(token));
}

export interface WarmHoldInput {
  /** `UI_TOKENS.capture.warmHoldMs`. Zero or less disables the hold. */
  warmHoldMs: number;
  /** `MediaStreamTrack.label` of the capture track (or the picker's text). */
  deviceLabel: string;
  /** Does the capture track still exist — i.e. `readyState === "live"`? */
  trackLive: boolean;
  /** `AudioContext.state` at teardown time. */
  contextState: string;
  /**
   * Was the AudioWorklet the capture path for the session that is ending?
   *
   * The pre-roll ring lives inside the worklet, and the ScriptProcessor
   * fallback (§4.5) has no equivalent. A held fallback would keep a
   * main-thread audio node and an open microphone alive and give nothing
   * back for it, so a session that fell back releases everything and the
   * next start goes through the ordinary cold path.
   */
  workletCapture: boolean;
}

/**
 * Should the capture graph survive this Stop?
 *
 * Every "no" is a reason code the trace line carries, so a support log
 * answers "why did this machine never warm-hold?" without a repro.
 */
export function decideWarmHold(input: WarmHoldInput): WarmHoldDecision {
  if (!(input.warmHoldMs > 0)) return { hold: false, reason: "disabled" };
  if (!input.workletCapture) return { hold: false, reason: "script-fallback" };
  if (!input.trackLive) return { hold: false, reason: "track-ended" };
  if (input.contextState !== "running") {
    return { hold: false, reason: `context-${input.contextState || "unknown"}` };
  }
  if (isBluetoothInputLabel(input.deviceLabel)) {
    return { hold: false, reason: "bluetooth" };
  }
  return { hold: true, reason: "held" };
}

/** One `audioinput` entry of `enumerateDevices()`. */
export interface InputDeviceInfo {
  deviceId: string;
  label: string;
}

export interface CaptureDeviceInput {
  /** The device asked for — the picked one as ./mic-preference resolved it;
   *  "" means "system default". */
  requestedDeviceId: string;
  /** The setting "record from the built-in microphone while Bluetooth
   *  headphones are the default" (preferences.ui.bluetooth_builtin_mic). */
  preferBuiltInOverBluetooth: boolean;
  /** The current `audioinput` list, in `enumerateDevices()` order. */
  devices: readonly InputDeviceInfo[];
}

export interface CaptureDeviceChoice extends CaptureDecision {
  /** What `getUserMedia` is asked for: "" (or the "default" alias) = the
   *  system default. */
  deviceId: string;
  /** The device's label, for the support log ("" when unknown). */
  label: string;
}

/** Chromium's aliases for "whatever the system picks", not devices. */
const DEVICE_ALIAS_IDS = new Set(["default", "communications"]);

/**
 * Is this the Mac's own microphone? Chromium on macOS names devices with
 * their transport in parentheses — "MacBook Pro Microphone (Built-in)",
 * "Leo Liberty 5 BT (Bluetooth)" — which is the signal used first; the
 * bare product names are the fallback for a shell that omits it.
 */
export function isBuiltInInputLabel(label: string): boolean {
  const normalized = String(label ?? "").trim().toLowerCase();
  if (!normalized || isBluetoothInputLabel(normalized)) return false;
  return normalized.includes("(built-in)")
    || normalized.includes("built-in microphone")
    || /\b(macbook|imac)\b.*\bmicrophone\b/.test(normalized);
}

/**
 * Which microphone a cold start records from.
 *
 * Bluetooth headphones cannot be warm-held (``decideWarmHold``: an open
 * Bluetooth input forces the headset into the Hands-Free Profile), so a
 * user whose system default input is their headset started every take
 * cold — 22 of 173 takes on 22.11 logged ``warm hold=0 reason=bluetooth``.
 * With the setting on and the system default being a Bluetooth input,
 * the take records from the Mac's built-in microphone instead: the
 * headset stays in high-quality A2DP playback, and the built-in input
 * can be warm-held and pre-rolled like any other.
 *
 * Off by default (1.6.25). It was on in 1.6.22-1.6.24, and a user a
 * metre from the Mac with a headset on was recorded at a tenth of the
 * level (2026-11-22: built-in RMS ~0.005 / peak 0.02-0.05 against the
 * same user's headset at 0.05-0.07 / 0.6-0.87) — live Deepgram returned
 * no words at all. The built-in microphone only serves someone sitting
 * at the Mac; ``builtInMicBarelyHeard`` says so when it does not.
 *
 * What it never overrides:
 *  - a device the user picked by name in the list — their choice;
 *  - a non-Bluetooth default (USB, built-in, virtual);
 *  - a machine with no built-in microphone (Mac mini / Studio / Pro):
 *    the Bluetooth default is all there is, recorded as before.
 *
 * Every verdict carries a reason code for the one start log line.
 */
export function chooseCaptureDevice(input: CaptureDeviceInput): CaptureDeviceChoice {
  const requested = String(input.requestedDeviceId || "").trim();
  const devices = input.devices || [];
  // The list's "Default - <name>" entry is the system default by another
  // name, not a device the user pinned.
  if (requested && !DEVICE_ALIAS_IDS.has(requested)) {
    const picked = devices.find((d) => d.deviceId === requested);
    return { deviceId: requested, label: picked?.label || "", reason: "picked" };
  }
  // The system default: Chromium lists it first as the "default" alias
  // ("Default - <name>"); without the alias, the first entry is it.
  const systemDefault = devices.find((d) => d.deviceId === "default") || devices[0];
  const defaultLabel = systemDefault?.label || "";
  // Every "default" verdict passes the request through unchanged ("" or
  // the alias), so the device asked for is exactly what it always was.
  if (!input.preferBuiltInOverBluetooth) {
    return { deviceId: requested, label: defaultLabel, reason: "default" };
  }
  // No label means no permission yet (or no devices): nothing to judge
  // by, so the default stands — never a guess that moves the input.
  if (!defaultLabel.trim() || !isBluetoothInputLabel(defaultLabel)) {
    return { deviceId: requested, label: defaultLabel, reason: "default" };
  }
  const builtIn = devices.find((d) => !DEVICE_ALIAS_IDS.has(d.deviceId) && isBuiltInInputLabel(d.label));
  if (!builtIn) {
    return { deviceId: requested, label: defaultLabel, reason: "bluetooth-default-no-built-in" };
  }
  return { deviceId: builtIn.deviceId, label: builtIn.label, reason: "bluetooth-default-built-in" };
}

/**
 * The lifecycle events that end a warm hold, and why each one does.
 *
 * These strings are a support-log contract — they are what
 * ``[trace warmCapture] released reason=…`` prints — so they live here,
 * with the rest of the warm-capture policy, rather than as four string
 * literals spread across the renderer's event listeners.
 *
 *   ttl            — the hold's own timer expired: 30 s of holding the
 *                    microphone open is the whole budget.
 *   window-hidden  — the app left the screen. A microphone held open by
 *                    an app that is not visible is the one case where
 *                    the OS indicator has nothing at all to show for
 *                    itself. (The TRANSITION is what releases; a hold
 *                    taken while already hidden is the ordinary case of
 *                    dictating by global hotkey.)
 *   pagehide       — the renderer itself is going away.
 *   devicechange   — the device list changed underneath us, so the "same
 *                    microphone" premise the hold rests on is gone.
 *   system-suspend — the machine is sleeping or the screen is locking.
 *                    This one cannot be inferred from inside the
 *                    renderer: ``setTimeout`` does not run while asleep,
 *                    so the TTL timer above cannot fire, and the OS may
 *                    hand the input device to something else in the
 *                    meantime. ``decideWarmReuse`` still re-checks the
 *                    wall clock at the next press — that is the backstop
 *                    for a shell too old to send the event.
 */
export const WARM_HOLD_LIFECYCLE_RELEASES = [
  "ttl",
  "window-hidden",
  "pagehide",
  "devicechange",
  "system-suspend",
] as const;

export type WarmHoldLifecycleRelease = typeof WARM_HOLD_LIFECYCLE_RELEASES[number];

export interface WarmReuseInput {
  now: number;
  /** `Date.now()` at the moment the hold was taken. */
  heldSince: number;
  warmHoldMs: number;
  /** `deviceId` the held track reports. */
  heldDeviceId: string;
  /** `deviceId` this start asks for; "" means "system default". */
  requestedDeviceId: string;
  trackLive: boolean;
  contextState: string;
}

/**
 * May the held graph be adopted by the recording that is starting?
 *
 * The TTL is re-checked against the wall clock here rather than trusted
 * to the expiry timer, and that is the point: `setTimeout` does not run
 * while the machine is asleep, so a lid closed for two hours would
 * otherwise hand a two-hour-old MediaStream to the next press. The clock
 * comparison catches the sleep case even when the timer has not fired
 * yet, and the track/context checks catch the device that went away
 * while we were not looking.
 */
export function decideWarmReuse(input: WarmReuseInput): WarmReuseDecision {
  if (!(input.warmHoldMs > 0)) return { reuse: false, reason: "disabled" };
  const ageMs = input.now - input.heldSince;
  if (!(ageMs >= 0) || ageMs > input.warmHoldMs) return { reuse: false, reason: "expired" };
  if (!input.trackLive) return { reuse: false, reason: "track-ended" };
  if (input.contextState !== "running") {
    return { reuse: false, reason: `context-${input.contextState || "unknown"}` };
  }
  // An empty request means "whatever the system default is", which the
  // held stream already is — the user has not pinned a device, so there
  // is nothing to disagree with. A pinned device must match exactly.
  if (input.requestedDeviceId && input.requestedDeviceId !== input.heldDeviceId) {
    return { reuse: false, reason: "device-changed" };
  }
  return { reuse: true, reason: "reused" };
}

export interface PreRollInput {
  /** Samples the worklet's ring handed over. */
  sampleCount: number;
  /** Sample rate those samples are in (the AudioContext's rate). */
  sampleRate: number;
  /**
   * How long ago the ring last received a sample, in ms — the
   * AudioContext clock at the `start` message minus the clock at the
   * worklet's last write.
   */
  staleMs: number;
  /** `UI_TOKENS.capture.preRollMaxAgeMs`. */
  maxAgeMs: number;
}

export interface PreRollDecision extends CaptureDecision {
  accept: boolean;
  /** Wall duration of the pre-roll audio, ms. */
  durationMs: number;
  /** Age of its OLDEST sample at the moment of the start, ms. */
  ageMs: number;
}

/**
 * Is this pre-roll still the moment before the press?
 *
 * While the graph is warm and the context is running, the worklet writes
 * to the ring on every render quantum, so `staleMs` is a fraction of a
 * millisecond and the oldest sample is exactly one ring length old. A
 * ring that stopped being written — a suspended context, a machine that
 * slept between two presses — still holds audio, but it is audio from
 * some earlier minute, and splicing it onto the front of a recording
 * would put words the user did not just say into the transcript.
 *
 * So the age that is tested is the age of the OLDEST sample
 * (`staleMs + durationMs`), and the whole ring is dropped when it fails.
 * Trimming the stale part is not better: what remains is still the audio
 * that preceded a pause of unknown length, not the audio that preceded
 * the press. This mirrors OpenWhispr's `PRE_ROLL_MAX_AGE_MS`.
 */
export function decidePreRoll(input: PreRollInput): PreRollDecision {
  const rate = input.sampleRate > 0 ? input.sampleRate : 0;
  const durationMs = rate > 0 ? (input.sampleCount / rate) * 1000 : 0;
  const staleMs = Number.isFinite(input.staleMs) ? Math.max(0, input.staleMs) : 0;
  const ageMs = staleMs + durationMs;
  if (!(input.sampleCount > 0) || !(rate > 0)) {
    return { accept: false, durationMs: 0, ageMs: 0, reason: "empty" };
  }
  if (ageMs > input.maxAgeMs) {
    return { accept: false, durationMs, ageMs, reason: "stale" };
  }
  return { accept: true, durationMs, ageMs, reason: "accepted" };
}

export interface CaptureElapsedInput {
  now: number;
  /** When the renderer was ASKED to record (the hotkey press). */
  startRequestedAt: number;
  /** When the first captured sample of the recording was taken. */
  startAt: number;
}

/**
 * How long the recording in progress has been going, from the earliest
 * clock that has started.
 *
 * There are two, and which one is earlier depends on the path
 * (BUGS_AUDIT_2026-09-03 §4.9). Cold: the press comes first and the
 * first sample lands ~310 ms later, so the press is the honest clock —
 * measuring from the first frame silently added the device start-up to
 * the "too short to keep" floor and threw away one-word dictations.
 * Warm with pre-roll: the recording *contains* audio from before the
 * press, so `startAt` is earlier and it is the honest clock.
 *
 * Taking the earliest of the two is the single rule that is right on
 * both paths. It answers exactly one question — "has this press lasted
 * long enough to be a recording?" — in one place, for the renderer and
 * for the main process alike. Everything the user is shown (the elapsed
 * timer, the saved duration) still runs off `startAt`, because that is
 * the audio the recording actually contains.
 */
export function captureElapsedMs(input: CaptureElapsedInput): number {
  const clocks = [input.startRequestedAt, input.startAt].filter((t) => t > 0);
  if (clocks.length === 0) return 0;
  return Math.max(0, input.now - Math.min(...clocks));
}

/**
 * The two-step cooperation that freezes capture at Stop.
 *
 * Everything above answers a question. These two sequence the answers,
 * and they exist because the sequence is where the mechanism was broken
 * for its entire life: ``decideWarmHold`` asks whether the capture track
 * is ``readyState === "live"``, and the stop path stopped that track two
 * hundred lines before it asked. ``MediaStreamTrack.stop()`` moves the
 * track to ``"ended"`` synchronously, so the answer was "track-ended"
 * every time — 15 stops out of 15 in the production log, with all 14
 * starts cold and ``preRollMs=0``. The predicate was tested to its last
 * branch; the order it runs in was not testable at all, so it was not
 * tested, and that is precisely the seam that failed.
 *
 * They are written with injected dependencies for the same reason the
 * predicates are pure: so the ORDER is a unit test rather than a claim.
 */
export interface CaptureFreezeDeps<P extends { hold: boolean }> {
  /**
   * Take the hold decision. Must run while the capture track is still
   * live, which is the whole point of it being called first.
   */
  planHold: () => P;
  /** Stop the microphone track. */
  stopTracks: () => void;
}

/**
 * Step 1 of the stop sequence: freeze the capture pipeline.
 *
 * On a refused hold the track is stopped, exactly as before. On an
 * accepted one it is left running and the pipeline is frozen by the
 * armed worklet instead — which flushes what it holds and then delivers
 * nothing further, so the guarantee the stop path depends on ("no frame
 * captured after this point reaches the sink or the socket") is
 * unchanged, while the microphone stays open for the next press.
 */
export function freezeCaptureForStop<P extends { hold: boolean }>(
  deps: CaptureFreezeDeps<P>,
): P {
  const plan = deps.planHold();
  if (!plan.hold) deps.stopTracks();
  return plan;
}

export interface CaptureHandOverDeps<P extends { hold: boolean }> {
  /** The plan returned by {@link freezeCaptureForStop}. */
  plan: P;
  /**
   * Move the graph out of the renderer's module slots and into the
   * hold. Returns false when the graph is no longer the one that was
   * planned for and therefore cannot be accounted for.
   */
  commit: (plan: P) => boolean;
  /** Stop the microphone track. */
  stopTracks: () => void;
}

/**
 * Step N of the teardown: hand the planned graph over, or release it.
 *
 * The microphone was NOT stopped at step 1 on the strength of the plan,
 * so a plan that does not complete has to stop it here. Without this the
 * one failure mode of the reorder would be the worst one available: a
 * microphone left open with nothing holding it, until the page goes away.
 */
export function handOverHeldCapture<P extends { hold: boolean }>(
  deps: CaptureHandOverDeps<P>,
): boolean {
  if (!deps.plan.hold) return false;
  const held = deps.commit(deps.plan);
  if (!held) deps.stopTracks();
  return held;
}

/**
 * Did a take recorded from the built-in microphone — because of the
 * Bluetooth setting, not the user's pick — hear almost no speech?
 *
 * Judged on the take's own speech verdicts (``observeCaptureFrame``,
 * ./audio-levels): the share of frames that rose above the room. "Not a
 * single speech frame" never happens on a live microphone — a key thump
 * or one loud syllable clears the floor — so the measure is a share.
 * Measured on 2026-11-22: the built-in takes of a user wearing a headset
 * scored 2-5 % (3.4 s and 12 s of dictation, 0-5 words recognised); the
 * same user's headset takes 30-60 %. A take shorter than
 * ``BUILT_IN_HEARING_MIN_TAKE_MS`` says too little to judge.
 */
const BUILT_IN_HEARING_MIN_TAKE_MS = 3_000;
const BUILT_IN_HEARING_MIN_SPEECH_SHARE = 0.1;

export interface BuiltInHearingInput {
  /** ``CaptureDeviceChoice.reason`` of the take. */
  choiceReason: string;
  /** How long the take recorded. */
  recordedMs: number;
  /** ``CaptureLevel.frames`` / ``speechFrames`` of the take. */
  frames: number;
  speechFrames: number;
}

export function builtInMicBarelyHeard(input: BuiltInHearingInput): boolean {
  if (input.choiceReason !== "bluetooth-default-built-in") return false;
  if (!(input.recordedMs >= BUILT_IN_HEARING_MIN_TAKE_MS) || !(input.frames > 0)) return false;
  return input.speechFrames / input.frames < BUILT_IN_HEARING_MIN_SPEECH_SHARE;
}
