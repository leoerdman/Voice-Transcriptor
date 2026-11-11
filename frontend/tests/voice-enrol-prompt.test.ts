import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ENROL_MIN_SECONDS,
  ENROL_NO_MIC,
  ENROL_SCRIPT,
  ENROL_SECONDS,
  enrolExpectationText,
  enrolLiveView,
  enrolSecondsText,
} from "../src/voice-enrol-prompt";
import {
  ENROL_SAMPLE_RATE,
  concatSamples,
  int16FromFloat,
  pcmSeconds,
  resampleTo16k,
} from "../src/enrol-audio";

/**
 * The card's promise to the person pressing it, as arithmetic.
 *
 * The defect behind these tests was not a wrong number: pressing an empty slot
 * quietly enrolled from the newest take in the archive, so the card asked for
 * nothing and took somebody's last meeting. Everything below is the answer to
 * "what is expected of me, how long have I got, and how do I know it is
 * recording" — which is only true if the countdown, the markup and the backend
 * minimum agree.
 */
describe("what the press asks for", () => {
  it("gives a span the mask can actually embed", () => {
    // `voice_enrol.enrol_windows` refuses a take shorter than the mask's 2 s
    // window instead of padding it, so a countdown that could end under two
    // seconds would be a press that was always going to be refused.
    expect(ENROL_SECONDS).toBeGreaterThanOrEqual(ENROL_MIN_SECONDS);
    expect(ENROL_MIN_SECONDS).toBe(2);
  });

  it("names the span in the singular the card uses", () => {
    expect(enrolSecondsText()).toBe("6 seconds");
    expect(enrolSecondsText(9)).toBe("9 seconds");
  });

  it("says the span, the microphone, the throw-away and the History fact", () => {
    const text = enrolExpectationText();
    expect(text).toContain("6 seconds");
    expect(text).toContain("out loud");
    expect(text).toContain("thrown away");
    expect(text).toContain("never appears in History");
    // The one thing the old card got wrong by omission: it never said the
    // press would record anything, because it never recorded anything.
    expect(text).toContain("microphone is open");
  });

  it("keeps the script short enough to read in the span", () => {
    // ~2.4 words a second is a comfortable reading pace; a script that needs
    // longer than the countdown is a script the user will be cut off in.
    const words = ENROL_SCRIPT.trim().split(/\s+/).length;
    expect(words).toBeLessThanOrEqual(ENROL_SECONDS * 3);
    expect(words).toBeGreaterThan(6);
  });
});

describe("the countdown", () => {
  it("starts at the whole span", () => {
    const view = enrolLiveView(0, "Voice 1");
    expect(view.remainingSec).toBe(ENROL_SECONDS);
    expect(view.recording).toBe(true);
    expect(view.caption).toContain(`Recording Voice 1 — ${ENROL_SECONDS} s left`);
  });

  it("never shows a zero while it is still recording", () => {
    // `ceil`, not `round`: at 5.4 s a rounded clock says "0 s left" and the
    // capture is still running, which is the one number the user watches.
    const view = enrolLiveView(5_400, "Voice 1");
    expect(view.remainingSec).toBe(1);
    expect(view.recording).toBe(true);
  });

  it("stops recording at the span, not at the next tick", () => {
    const view = enrolLiveView(ENROL_SECONDS * 1_000, "Voice 1");
    expect(view.recording).toBe(false);
    expect(view.remainingSec).toBe(0);
    expect(view.caption).toContain("done, measuring");
  });

  it("says nothing but done once the span is behind it", () => {
    const view = enrolLiveView(60_000, "Voice 2");
    expect(view.recording).toBe(false);
    expect(view.remainingSec).toBe(0);
  });

  it("knows when a capture is too short to send", () => {
    // The backend refuses under two seconds; the card has to agree before the
    // microphone closes, or the refusal arrives as a surprise.
    expect(enrolLiveView(900, "Voice 1").enough).toBe(false);
    expect(enrolLiveView(ENROL_MIN_SECONDS * 1_000, "Voice 1").enough).toBe(true);
  });

  it("survives a clock that hands it nonsense", () => {
    expect(enrolLiveView(Number.NaN, "Voice 1").remainingSec).toBe(ENROL_SECONDS);
    expect(enrolLiveView(-500, "Voice 1").recording).toBe(true);
  });

  it("tells the user what to fix when the microphone never opens", () => {
    expect(ENROL_NO_MIC).toContain("microphone");
    expect(ENROL_NO_MIC).toContain("Allow");
  });
});

describe("the capture's arithmetic", () => {
  it("copies a buffer that is already 16 kHz", () => {
    const input = new Float32Array([0.1, -0.2, 0.3]);
    const out = resampleTo16k(input, ENROL_SAMPLE_RATE);
    expect(Array.from(out)).toEqual(Array.from(input));
    expect(out).not.toBe(input);
  });

  it("halves a 32 kHz device to half the samples", () => {
    const input = new Float32Array(3_200).fill(0.5);
    const out = resampleTo16k(input, 32_000);
    expect(out.length).toBe(1_600);
    expect(out[0]).toBeCloseTo(0.5, 5);
  });

  it("averages instead of dropping samples", () => {
    // 48 kHz triples whose mean is zero. Decimation by picking every third
    // sample would keep the 1s and land on full scale; averaging keeps the
    // energy, and this signal's energy is silence, which is what the frame
    // test reads.
    const input = new Float32Array([1, -1, 0, 1, -1, 0]);
    const out = resampleTo16k(input, 48_000);
    expect(out.length).toBe(2);
    expect(Math.abs(out[0])).toBeLessThan(0.01);
    expect(Math.abs(out[1])).toBeLessThan(0.01);
  });

  it("lays chunks end to end", () => {
    const out = concatSamples([
      new Float32Array([1, 2]),
      new Float32Array([]),
      new Float32Array([3]),
    ]);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  it("scales the two halves separately so neither edge wraps", () => {
    const out = int16FromFloat(new Float32Array([1, -1, 0, 2]));
    expect(out[0]).toBe(0x7fff);
    expect(out[1]).toBe(-0x8000);
    expect(out[2]).toBe(0);
    // Over-full input is clamped, not wrapped: 2 → 32767, never -32768.
    expect(out[3]).toBe(0x7fff);
  });

  it("reports the seconds a capture holds", () => {
    expect(pcmSeconds(new Int16Array(32_000))).toBe(2);
    expect(pcmSeconds(new Int16Array(0))).toBe(0);
    expect(pcmSeconds(new Int16Array(16_000), 0)).toBe(0);
  });
});

describe("the card documents all of it before the press", () => {
  const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
  const main = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
  const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

  it("carries the expectation, the script and the live line in the markup", () => {
    for (const id of ["voiceEnrolExpectation", "voiceEnrolScript", "voiceEnrolLive", "voiceEnrolLiveText"]) {
      expect(html, `#${id} is missing from index.html`).toContain(`id="${id}"`);
    }
    expect(html).toContain("six seconds");
    expect(html).toContain("never appears in History");
    expect(html).toContain("count down");
  });

  it("keeps the markup's six seconds equal to the constant", () => {
    // Two places say the number: the sentence a reader sees before any fetch,
    // and the countdown. A test is what stops them drifting.
    expect(html).toContain(`six seconds`);
    expect(enrolSecondsText()).toBe("6 seconds");
    expect(ENROL_SECONDS).toBe(6);
  });

  it("paints both from the constants, not from literals", () => {
    expect(main).toContain("$(\"voiceEnrolExpectation\").textContent = enrolExpectationText();");
    expect(main).toContain("$(\"voiceEnrolScript\").textContent = `“${ENROL_SCRIPT}”`;");
  });

  it("shows the window's own recording dot while it records", () => {
    // "Depict recording when it is really recording": the same dot class the
    // topbar uses, the same pulse, and `is-recording` only while the capture
    // is open.
    expect(html).toContain('class="voice-enrol-live"');
    expect(html).toContain('class="record-toggle-dot"');
    expect(main).toContain('box.classList.toggle("is-recording", enrolRecording && view.recording);');
    expect(css).toContain(".voice-enrol-live.is-recording .record-toggle-dot {");
    expect(css).toContain("animation: record-toggle-pulse 1.4s ease-in-out infinite;");
  });

  it("records a press instead of borrowing a take from History", () => {
    // The regression: the card silently enrolled from the newest recording,
    // so "what am I supposed to do" had no answer and somebody's meeting
    // became their voice. Scoped to the section's own functions — the History
    // list legitimately reads /api/recordings elsewhere in this file.
    const learn = main.slice(main.indexOf("async function learnInto("));
    const learnBody = learn.slice(0, learn.indexOf("\n}\n"));
    expect(learnBody).not.toContain("/api/recordings");
    expect(learnBody).not.toContain("recording_name");
    expect(main).not.toContain("voiceMaskReferences");
    expect(main).toContain("getUserMedia({ audio: true })");
    expect(main).toContain("/enrol-live");
  });

  it("will not open a second microphone over a running take", () => {
    expect(main).toContain("if (isRecording) {");
    expect(main).toContain("the mask listens to one microphone at a time");
  });

  it("releases the device however the capture ends", () => {
    const fn = main.slice(main.indexOf("async function captureEnrolment("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("for (const track of stream.getTracks()) track.stop();");
    expect(body).toContain("void ctx.close()");
    expect(body).toContain("node.onaudioprocess = null;");
  });
});
