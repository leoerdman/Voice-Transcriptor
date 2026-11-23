/**
 * PCM capture AudioWorklet processor.
 *
 * Batches render quanta into Float32Array chunks before posting to the
 * main thread. Posting every 128-sample quantum produces hundreds of UI
 * thread messages per second; batching keeps capture lossless while
 * reducing renderer scheduling pressure.
 *
 * Between recordings the processor can be left connected in an "armed"
 * state: it posts nothing, and keeps the last `preRollMs` of audio in a
 * ring buffer. The next `start` hands that ring over before the first
 * live frame, so the recording begins slightly BEFORE the hotkey press
 * instead of ~310 ms after it (BUGS_AUDIT_2026-09-03 §4.7). The renderer
 * decides whether to keep the ring; see src/capture-warm.ts.
 *
 * Control messages:
 *   {type: "arm", preRollMs: number} → stop delivering, start filling
 *                                     the pre-roll ring.
 *   {type: "start"}                 → hand the ring over as a single
 *                                     {type: "pre-roll"} message, then
 *                                     resume delivering live frames.
 *   {type: "flush", token: string}  → processor immediately acknowledges
 *                                     with {type: "flush-ack", token}. The
 *                                     ack guarantees that all PCM frames
 *                                     posted BEFORE the ack have been
 *                                     handed to the port (ordering is
 *                                     preserved within a MessagePort).
 *
 * This file is loaded raw into the AudioWorklet global scope, so it has
 * no imports and no exports. Its pure ring buffer is exercised by
 * tests/pcm-worklet.test.ts, which evaluates the file in a vm with a
 * stubbed `registerProcessor`.
 */

/**
 * How many samples accumulate before a batch is posted.
 *
 * 512 samples is ~11 ms at 48 kHz (four render quanta), which is what
 * the FIRST frame of a cold recording now waits for. The previous value,
 * 2048, was ~43 ms — a quarter of the 172 ms first-frame cost measured
 * in §4.7, paid on every start for nothing the user gets back. The floor
 * on the other side is the main thread: each batch is one MessagePort
 * message plus one `pushCapturedFrame` pass (downsample, RMS, PCM16
 * encode), so 512 costs ~94 messages/s at 48 kHz against 2048's ~23.
 * That is the same order as the 50 ms VU interval already running and
 * far below the per-quantum rate (375/s) the batching exists to avoid.
 */
const MAX_PENDING_SAMPLES = 512;

/**
 * How long an armed ring must see nothing but digital zeros before the
 * device is reported as not delivering.
 *
 * A live input always carries its own noise floor — measured on the
 * owner's built-in microphone at peak ~0.008 with the room silent — so
 * exact zeros mean no data, which is what an input that was taken away,
 * reset or asleep produces. The window is a second rather than a quantum
 * because the same digital silence is normal for ~100 ms while a device
 * wakes (``microphone woke: 104 ms of digital silence``); anything
 * shorter would call a healthy device dead at every cold start.
 *
 * Nothing is posted while the device is healthy: a transition is one
 * ~40-byte message, into silence and back out of it, so a 15-minute hold
 * costs one message if nothing goes wrong.
 */
const SILENT_HOLD_MS = 1000;

/**
 * Ring buffer holding the most recent `capacity` samples.
 *
 * Pure and self-contained on purpose: it is the one piece of the worklet
 * with arithmetic worth getting wrong (wrap-around, a chunk longer than
 * the ring, reading before the ring has filled once), and it is directly
 * unit-tested.
 */
class PreRollRing {
  constructor(capacity) {
    this.capacity = Math.max(0, Math.floor(capacity) || 0);
    this.buffer = new Float32Array(this.capacity);
    this.writeIndex = 0;
    this.filled = 0;
  }

  reset() {
    this.writeIndex = 0;
    this.filled = 0;
  }

  /** Append a chunk, overwriting the oldest samples once full. */
  push(chunk) {
    if (!this.capacity || !chunk || !chunk.length) return;
    // A chunk longer than the ring can only leave its own tail behind.
    const start = chunk.length > this.capacity ? chunk.length - this.capacity : 0;
    for (let i = start; i < chunk.length; i++) {
      this.buffer[this.writeIndex] = chunk[i];
      this.writeIndex = this.writeIndex + 1 === this.capacity ? 0 : this.writeIndex + 1;
    }
    this.filled = Math.min(this.capacity, this.filled + (chunk.length - start));
  }

  /** The ring's contents, oldest sample first. */
  read() {
    const out = new Float32Array(this.filled);
    if (!this.filled) return out;
    // Oldest sample sits `filled` positions behind the write cursor.
    let readIndex = this.writeIndex - this.filled;
    if (readIndex < 0) readIndex += this.capacity;
    for (let i = 0; i < this.filled; i++) {
      out[i] = this.buffer[readIndex];
      readIndex = readIndex + 1 === this.capacity ? 0 : readIndex + 1;
    }
    return out;
  }
}

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.pendingSamples = 0;
    this.maxPendingSamples = MAX_PENDING_SAMPLES;
    // Delivering from construction. A node is only ever constructed to
    // record right now, and a node that waited for a `start` message
    // would drop every quantum captured before that message crossed the
    // thread boundary — the exact loss this file exists to remove.
    this.armed = false;
    this.ring = null;
    // AudioContext clock at the last sample written to the ring. The
    // renderer subtracts it from its own `currentTime` to learn whether
    // the ring kept filling or the context stopped rendering.
    this.lastRingWriteTime = 0;
    // Context clock at the first zero-only quantum since the last real
    // sample; -1 means "the device is delivering". See ``watchDevice``.
    this.quietSince = -1;
    this.silent = false;
    this.port.onmessage = (event) => {
      const msg = event?.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "arm") {
        this.arm(msg.preRollMs);
        return;
      }
      if (msg.type === "start") {
        this.start();
        return;
      }
      if (msg.type === "flush" && msg.token) {
        this.flushPending();
        // Post ack synchronously. All PCM messages posted during previous
        // process() ticks are already queued on the port before this ack,
        // so the main-thread listener observes them first. This is the
        // correct semantics for a "drain" barrier.
        this.port.postMessage({ type: "flush-ack", token: String(msg.token) });
      }
    };
  }

  /**
   * Stop delivering; keep the last `preRollMs` of audio.
   *
   * Pending batches are flushed first: they belong to the recording that
   * is ending, and the renderer's stop barrier is waiting for them.
   */
  arm(preRollMs) {
    this.flushPending();
    const ms = Number(preRollMs);
    const capacity = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) * sampleRate / 1000));
    this.ring = capacity > 0 ? new PreRollRing(capacity) : null;
    this.lastRingWriteTime = currentTime;
    // A new hold starts unjudged, whatever the previous one looked like.
    this.quietSince = -1;
    this.silent = false;
    this.armed = true;
  }

  /**
   * Begin delivering. Whatever the ring holds goes first, in one
   * message, tagged so the renderer can date it and decide.
   */
  start() {
    if (this.armed && this.ring) {
      const samples = this.ring.read();
      if (samples.length) {
        this.port.postMessage({
          type: "pre-roll",
          samples,
          sampleRate,
          // Not "how old is this" — the renderer computes that against
          // its own clock reading. This is when the ring last received
          // a sample, which is the only fact this side of the boundary
          // can state.
          lastWriteTime: this.lastRingWriteTime,
        });
      }
      this.ring.reset();
    }
    this.ring = null;
    this.armed = false;
    // `pending` is deliberately left alone. It is empty whenever the
    // processor was armed (arm() flushed it, and an armed process()
    // appends nothing), and on a node that was never armed it holds the
    // quanta captured since construction — dropping those here would
    // reintroduce, at the front of every cold recording, the loss this
    // whole mechanism exists to remove.
  }

  flushPending() {
    if (!this.pendingSamples) return;
    if (this.pending.length === 1) {
      this.port.postMessage(this.pending[0]);
    } else {
      const merged = new Float32Array(this.pendingSamples);
      let offset = 0;
      for (const chunk of this.pending) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      this.port.postMessage(merged);
    }
    this.pending = [];
    this.pendingSamples = 0;
  }

  /**
   * Report a held device that has stopped (or resumed) delivering.
   *
   * Called for every armed quantum. A quantum with no channel at all is
   * silence like any other: the device owes us 128 samples every 128
   * samples of the context clock, and a context that keeps rendering
   * without them is exactly the "live track, dead device" the renderer
   * must not hand to a recording.
   */
  watchDevice(channel) {
    let sound = false;
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        if (channel[i] !== 0) { sound = true; break; }
      }
    }
    if (sound) {
      this.quietSince = -1;
      if (this.silent) {
        this.silent = false;
        this.port.postMessage({ type: "signal", silent: false });
      }
      return;
    }
    if (this.quietSince < 0) this.quietSince = currentTime;
    if (!this.silent && (currentTime - this.quietSince) * 1000 >= SILENT_HOLD_MS) {
      this.silent = true;
      this.port.postMessage({ type: "signal", silent: true });
    }
  }

  process(inputs) {
    const channel = inputs?.[0]?.[0];
    if (this.armed) {
      this.watchDevice(channel);
      if (channel && channel.length && this.ring) {
        this.ring.push(channel);
        this.lastRingWriteTime = currentTime;
      }
      return true;
    }
    if (channel && channel.length) {
      const copy = channel.slice(0);
      this.pending.push(copy);
      this.pendingSamples += copy.length;
      if (this.pendingSamples >= this.maxPendingSamples) {
        this.flushPending();
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
