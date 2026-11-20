import { describe, expect, it } from "vitest";

import {
  applyLiveStreamEvent,
  canonicalTextFromBuffer,
  createLiveTranscriptBuffer,
  type LiveStreamEvent,
  type TranscriptSegment,
} from "../src/live-transcript-buffer";

// UI_TOKENS.finalize.segmentEpsilonSec — the value main.tsx passes.
const EPSILON = 0.08;

function feed(events: LiveStreamEvent[]) {
  const buffer = createLiveTranscriptBuffer("deepgram-stream", EPSILON);
  for (const event of events) applyLiveStreamEvent(buffer, event);
  return buffer;
}

const seg = (start: number, end: number, text: string): TranscriptSegment => ({ start, end, text });

/**
 * Screen session 2026-11-20 21:23:03 local (saved 21-27-24-159740),
 * Deepgram "Auto" = dual stream, primary ``multi``, secondary ``ru``.
 *
 * The live ``segments`` events below are the primary's finals exactly
 * as main.log logged them (``is_final start=… end=… text=…``). The
 * ``final`` envelope's segments are the dual-stream merge's
 * (``_segments_from_words`` in backend/deepgram_dual.py): regrouped
 * from merged WORDS at ≤1 s gaps, so each one starts at its first
 * word's time — not at the primary segment's start — and spans several
 * primary finals, and the contested Ukrainian stretch is the ``ru``
 * reading. The word times are not in the log; the starts used here are
 * any value past the primary start by more than the 0.08 s epsilon,
 * which is all the mechanism needs.
 */
describe("the stop envelope does not feed the live reading (Original: doubled, 2026-11-20)", () => {
  const liveEvents: LiveStreamEvent[] = [
    { type: "interim", segment: seg(85.26, 87.9, "Со всією") },
    { type: "segments", segments: [seg(85.26, 88.4, "Со всією хуїтою")] },
    { type: "segments", segments: [seg(88.4, 92.08, "по мовчанняю не надо показувати")] },
    { type: "segments", segments: [seg(92.08, 96.36, "Здесь pop-up меню")] },
    { type: "interim", segment: seg(96.36, 98.5, "полностью в дизайн") },
    { type: "segments", segments: [seg(96.36, 99.89, "полностью в дизайн-токенах наших делаешь.")] },
  ];
  const liveReading =
    "Со всією хуїтою по мовчанняю не надо показувати Здесь pop-up меню " +
    "полностью в дизайн-токенах наших делаешь.";
  const envelope: LiveStreamEvent = {
    type: "final",
    segments: [
      seg(84.9, 88.2, "С Со всей суетой."),
      seg(88.62, 91.7, "По умолчанию ее не надо показывать."),
      seg(92.9, 99.7, "Здесь pop-up меню полностью в дизайн токенах наших делаешь."),
    ],
  };

  it("holds the primary's live reading before the envelope", () => {
    expect(canonicalTextFromBuffer(feed(liveEvents))).toBe(liveReading);
  });

  it("is the same live reading after the envelope — not the two readings interleaved", () => {
    // Before the fix the envelope's segments were appended to this
    // buffer and re-sorted by start time beside the primary's finals;
    // the saved Original read
    // "С Со всей суетой. Со всією хуїтою по мовчанняю не надо показувати
    //  По умолчанию ее не надо показывать. Здесь pop-up меню Здесь pop-up
    //  меню полностью в дизайн токенах наших делаешь. полностью в
    //  дизайн-токенах наших делаешь."
    expect(canonicalTextFromBuffer(feed([...liveEvents, envelope]))).toBe(liveReading);
  });

  it("says each clause once when the merge regroups two primary finals into one segment", () => {
    // Same session, 27.79–35.71 s: two primary finals, one merged
    // segment over both. Saved Original: "Референсы … отображаются,
    // Референсы … отображаются, кнопка, и она … всего. кнопка, и она … всего."
    const buffer = feed([
      { type: "segments", segments: [seg(27.79, 31.92, "Референсы участников только у меня отображаются,")] },
      { type: "segments", segments: [seg(31.92, 35.71, "кнопка, и она отображается вот здесь в конце после всего.")] },
      {
        type: "final",
        segments: [
          seg(
            28.0,
            35.6,
            "Референсы участников только у меня отображаются, кнопка, и она отображается вот здесь в конце после всего.",
          ),
        ],
      },
    ]);
    const text = canonicalTextFromBuffer(buffer);
    expect(text.match(/Референсы/g)).toHaveLength(1);
    expect(text.match(/кнопка/g)).toHaveLength(1);
  });

  it("keeps segments that arrive after the envelope (late forwarder events still count)", () => {
    const buffer = feed([
      { type: "segments", segments: [seg(0.5, 2.0, "Привет.")] },
      { type: "final", segments: [seg(0.6, 3.4, "Привет. Как дела?")] },
      { type: "segments", segments: [seg(2.0, 3.4, "Как дела?")] },
    ]);
    expect(canonicalTextFromBuffer(buffer)).toBe("Привет. Как дела?");
  });
});
