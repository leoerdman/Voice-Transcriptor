"use strict";

// SSOT for the renderer → main transcript hand-off (BUGS_AUDIT_2026-09-03
// §6.7/§6.8): the shape of a "recording-final" IPC payload, and the
// per-recordingId mailbox the post-stop task waits on.
//
// Before this module, ``processPostStopTask`` learned that a transcript
// was ready by running ``executeJavaScript`` in the renderer every 30 ms
// for up to 32 s — up to ~1000 synchronous evaluations injected into the
// renderer at exactly the moment it is finalizing Deepgram, running the
// paste upscale and serializing audio (§6.7). The renderer already knows
// the instant the paste-ready text exists; it now says so once, over IPC.
//
// Two ideas, and nothing else, live here:
//
//   1. ``validateRecordingFinalPayload`` — the ONE definition of what a
//      well-formed hand-off looks like. IPC is renderer-controlled input:
//      a payload that does not match exactly is ignored, never coerced.
//      Coercion is what turned a status string into a "recordingId" and
//      a wall-clock guess into "finality" in the first place.
//
//   2. ``createRecordingFinalSlot`` — a mailbox keyed by recordingId that
//      holds the last signal of each kind and wakes waiters. It exists
//      because the signal and the waiter race: the renderer can publish
//      the final text BEFORE the post-stop task starts waiting (fast
//      recording, slow queue) or long after (slow recovery). A plain
//      event listener drops the first case on the floor; a slot does not.
//
// Deliberately free of Electron and of any timer other than the caller's
// own timeout, so it is exercised directly by
// desktop/recording-final-slot.test.js.

/**
 * What a publish IS, stated by the renderer at the publish site — never
 * read out of the text (DM-01): the paste-ready or best-known transcript,
 * a status line, or an error line.
 */
const RECORDING_SIGNAL_KINDS = Object.freeze(["transcript", "status", "error"]);

/**
 * What the renderer is doing at this publish ("upscaling", "no-speech").
 * A lowercase token: it is compared, never displayed, so anything else is
 * not a phase this contract knows how to carry.
 */
const RECORDING_SIGNAL_PHASE = /^[a-z][a-z0-9-]{0,31}$/;

/** Recordings tracked at once before the oldest slot is superseded. */
const DEFAULT_MAX_RECORDINGS = 32;

/**
 * The hand-off contract, in one place.
 *
 * Required, exactly:
 *   - ``recordingId``: a safe integer > 0. The renderer's monotonic
 *     ``liveRecordingSeq``. Strings ("7"), floats, 0 and negatives are
 *     rejected rather than coerced — a mismatched id must never let one
 *     recording's text be pasted for another (§6, "сопоставление
 *     recordingId строгое").
 *   - ``text``: a string. May be empty ("nothing to hand off yet").
 *   - ``final``: a boolean. ``true`` means "this is the paste-ready
 *     text"; ``false`` means "this is the best text known so far".
 *     Only a real boolean counts: the truthiness of a wall-clock timer
 *     standing in for finality is the §6.8 defect.
 *
 *   - ``kind``: one of RECORDING_SIGNAL_KINDS. It used to be the first
 *     half of a free-form ``source`` label ("status:upscaling") that
 *     main split on a colon; a label is not a contract, so the two
 *     halves are fields now and a payload without a known kind is not a
 *     hand-off.
 *
 * Optional:
 *   - ``phase``: "" (absent) or a RECORDING_SIGNAL_PHASE token. Any other
 *     value rejects the payload — it decides the capsule's state
 *     (desktop/transcript-signal.js), so it is not coerced either.
 *
 * Any other key is dropped. Returns the normalized payload, or ``null``
 * if the shape does not match.
 */
function validateRecordingFinalPayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!Number.isSafeInteger(raw.recordingId) || raw.recordingId <= 0) return null;
  if (typeof raw.text !== "string") return null;
  if (typeof raw.final !== "boolean") return null;
  if (!RECORDING_SIGNAL_KINDS.includes(raw.kind)) return null;
  const phase = raw.phase === undefined || raw.phase === "" ? "" : raw.phase;
  if (phase !== "" && (typeof phase !== "string" || !RECORDING_SIGNAL_PHASE.test(phase))) return null;
  return { recordingId: raw.recordingId, text: raw.text, final: raw.final, kind: raw.kind, phase };
}

/**
 * Per-recordingId mailbox for validated hand-off signals.
 *
 * ``set`` stores a signal and wakes every waiter on that recordingId.
 * ``waitForSignal`` resolves with the newest signal for an id once its
 * sequence number passes ``sinceSeq`` — immediately when that is already
 * true (set-before-wait), otherwise when the signal arrives
 * (wait-before-set), and with ``null`` when the caller's timeout expires
 * or the slot is superseded by newer recordings.
 *
 * A monotonic ``seq`` is what makes "have I already handled this one?"
 * answerable without the caller holding on to signal objects, and what
 * lets one wait primitive serve both "wake me on anything new" and "wake
 * me only on something I have not seen".
 */
function createRecordingFinalSlot(options = {}) {
  const maxRecordings = Math.max(1, Number(options.maxRecordings) || DEFAULT_MAX_RECORDINGS);
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  /** @type {Map<number, {recordingId:number,last:object|null,final:object|null,provisional:object|null,waiters:Set<object>}>} */
  const slots = new Map();
  let seqCounter = 0;

  function ensureSlot(recordingId) {
    let slot = slots.get(recordingId);
    if (slot) return slot;
    slot = { recordingId, last: null, final: null, provisional: null, waiters: new Set() };
    slots.set(recordingId, slot);
    // Insertion order = age. Anything older than the last
    // ``maxRecordings`` recordings cannot still be relevant to a
    // post-stop task (each one is bounded by a 32 s deadline), so it is
    // superseded: its waiters are released with null and take their own
    // fallback path instead of hanging until their deadline.
    while (slots.size > maxRecordings) {
      const oldestId = slots.keys().next().value;
      if (oldestId === undefined || oldestId === recordingId) break;
      const oldest = slots.get(oldestId);
      slots.delete(oldestId);
      if (oldest) for (const waiter of [...oldest.waiters]) waiter.settle(null);
    }
    return slot;
  }

  /**
   * Store a hand-off signal. Accepts the raw IPC payload and validates
   * it here, so there is exactly one door into the slot and no caller
   * can smuggle an unvalidated shape in.
   *
   * Last write wins for each kind: a renderer that republishes its final
   * text is telling us something more current, and double-paste is
   * already prevented downstream by the pasted-recordingId guard.
   *
   * @returns the stored signal ({...payload, seq, at}), or null when the
   *          payload was ignored.
   */
  function set(raw) {
    const payload = validateRecordingFinalPayload(raw);
    if (!payload) return null;
    seqCounter += 1;
    const signal = Object.freeze({ ...payload, seq: seqCounter, at: now() });
    const slot = ensureSlot(payload.recordingId);
    slot.last = signal;
    if (signal.final) slot.final = signal;
    else slot.provisional = signal;
    for (const waiter of [...slot.waiters]) {
      if (signal.seq > waiter.sinceSeq) waiter.settle(signal);
    }
    return signal;
  }

  /**
   * Non-blocking read of what is known about a recording.
   * @returns {{recordingId:number,last:object|null,final:object|null,provisional:object|null}|null}
   */
  function peek(recordingId) {
    if (!Number.isSafeInteger(recordingId) || recordingId <= 0) return null;
    const slot = slots.get(recordingId);
    // A slot conjured by a waiter that has not received anything yet is
    // "nothing is known", not an empty answer the caller has to unpack.
    if (!slot || !slot.last) return null;
    return {
      recordingId: slot.recordingId,
      last: slot.last,
      final: slot.final,
      provisional: slot.provisional,
    };
  }

  /**
   * Wait for the next signal for ``recordingId`` newer than ``sinceSeq``.
   *
   * Resolves with that signal, or with ``null`` when ``timeoutMs``
   * elapses or the slot is superseded. An unusable recordingId (the
   * legacy ``0`` from a renderer too old to send one) can never receive
   * a signal, so the call degrades to a plain timer — which is exactly
   * what the poll fallback needs it to be, with no branch at the call
   * site.
   */
  function waitForSignal(recordingId, waitOptions = {}) {
    const sinceSeq = Math.max(0, Number(waitOptions.sinceSeq) || 0);
    const timeoutMs = Math.max(0, Number(waitOptions.timeoutMs) || 0);
    const usableId = Number.isSafeInteger(recordingId) && recordingId > 0;
    if (usableId) {
      const slot = slots.get(recordingId);
      if (slot?.last && slot.last.seq > sinceSeq) return Promise.resolve(slot.last);
    }
    if (timeoutMs <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      if (!usableId) {
        setTimeout(() => resolve(null), timeoutMs);
        return;
      }
      const slot = ensureSlot(recordingId);
      const waiter = { sinceSeq, settled: false, timer: null, settle: null };
      waiter.settle = (value) => {
        if (waiter.settled) return;
        waiter.settled = true;
        slot.waiters.delete(waiter);
        if (waiter.timer) clearTimeout(waiter.timer);
        resolve(value);
      };
      waiter.timer = setTimeout(() => waiter.settle(null), timeoutMs);
      slot.waiters.add(waiter);
    });
  }

  /** Slots currently tracked. For tests and diagnostics only. */
  function size() {
    return slots.size;
  }

  return { set, peek, waitForSignal, size };
}

module.exports = {
  RECORDING_SIGNAL_KINDS,
  DEFAULT_MAX_RECORDINGS,
  validateRecordingFinalPayload,
  createRecordingFinalSlot,
};
