# Fix journal — lane source-dup (doubled `Original:` in dual-stream takes)

Branch `source-dup`, cut from `main` at `22b71bc`.

## Symptom

Saved recordings whose `Original:` (the renderer's live reading, saved as
`sourceText` via `latestSourceForSave()` in `stopLive`) carries every clause
twice, interleaved, in two slightly different versions; `Transcription:`
is correct. Affected 2026-11-20 takes (user data, read only):
`Live Capsule/…17-03-00-827300`, `…17-44-45-871107`, `…19-48-28-953325`,
`Screen Sessions/…21-17-33-196915`, `…21-27-24-159740`, `…21-44-14-925848`.
All are Deepgram "Auto" = dual stream (primary `multi`, secondary `ru`).

## Evidence (main.log, session `7921e6ee`, 14:23:03–14:27:24 UTC)

* `dual-stream: second reading opened primary=multi secondary=ru` and at
  stop `dual-stream merge: multi=226 words ru=257 words merged=264
  filled_from_ru=41 … contested_to_ru=4`.
* Both streams' finals are logged, e.g. at 85.26–99.89 s:
  `Со всей суетой.` / `Со всією хуїтою`, `по мовчанняю не надо показувати` /
  `По умолчанию ее не надо показывать.`, `Здесь pop-up меню` (both),
  `полностью в дизайн токенах…` / `полностью в дизайн-токенах…`.
* Saved `Original:` for that stretch: `С Со всей суетой. Со всією хуїтою по
  мовчанняю не надо показувати По умолчанию ее не надо показывать. Здесь
  pop-up меню Здесь pop-up меню полностью в дизайн токенах наших делаешь.
  полностью в дизайн-токенах наших делаешь.` — the primary's live finals
  (`Со всією…`, `…дизайн-токенах…`) interleaved with the `Transcription:`
  reading (`С Со всей суетой.`, `По умолчанию…`, `…дизайн токенах…`).
* Clauses only one stream produced (`Нет, у нас у всех свои проекты.`) are
  not doubled; the backend forwards live events only from the primary,
  so the second copy cannot be the secondary's live events.

## Mechanism

The socket handler's `final` case appended the stop envelope's `segments`
to the session's live buffer (`appendSegmentsToBuffer`, unchanged since
April). For a single stream those segments are the live finals again
(same start, same text) and `mergeTranscriptSegments` drops them as exact
duplicates. For a dual-stream take they are the backend's merge
(`_segments_from_words`, backend/deepgram_dual.py): words from both
readings regrouped at ≤1 s gaps, each segment starting at its first
word's time and spanning several primary finals, contested stretches in
the `ru` reading. `mergeTranscriptSegments` only recognises "the same
segment" at the same start (±0.08 s) with a prefix-compatible text, so it
kept both, sorted by start — every clause twice, interleaved. Stop then
read the buffer (`latestSourceForSave()` → `getSessionCanonicalLiveSourceText`)
after the envelope had resolved and saved it as `Original:`. The preview
was not affected because `composeLivePreviewText` already shows the
envelope verbatim once it resolves (B-041 — the same defect, fixed there
for the pane only).

## Failing test before / after

Commit `19d1770` moves the buffer and its socket-message reducer
(`applyLiveStreamEvent`) out of main.tsx unchanged into
`frontend/src/live-transcript-buffer.ts`, so the handler's decision is
testable. `frontend/tests/live-transcript-buffer.test.ts` feeds the
logged primary finals, then a `final` envelope shaped like the dual merge.

Before the fix (3 of 4 failing):

```
Expected: "Со всією хуїтою по мовчанняю не надо показувати Здесь pop-up меню полностью в дизайн-токенах наших делаешь."
Received: "С Со всей суетой. Со всією хуїтою по мовчанняю не надо показувати По умолчанию ее не надо показывать. Здесь pop-up меню Здесь pop-up меню полностью в дизайн токенах наших делаешь. полностью в дизайн-токенах наших делаешь."
```

The received string is the saved `Original:` of that stretch character for
character. The `Референсы…/кнопка…` case (two primary finals, one merged
segment) reproduces that recording's other doubling the same way.

After the fix: 4/4 pass.

## Fix

`applyLiveStreamEvent`'s `final` case no longer touches the buffer: the live
reading is the provider's `segments`/`interim` stream and nothing else.
The envelope stays the one delivered transcript (`stopLive`, unchanged) and
the preview's post-stop text (`composeLivePreviewText`, unchanged). No
string dedup on the saved text. `Transcription:` behaviour is unchanged —
it never read the buffer.

## Title / file name

* The file name is fixed at the first save from `provisionalTitle =
  smartRecordingTitle(sourceLiveText)` — the stop-ENTRY snapshot of the
  live reading, taken before `finalize` is sent, so before any envelope.
  The doubled text never reached a file name.
* The `Title:` line is `resolveSessionTitle(transcript, liveSource, …)`:
  the transcript first, the live text only when the transcript is empty
  (and then the envelope carried nothing to double). Not affected.
* Observed separately, not changed in this lane: because the name comes
  from the live reading at stop entry while `Title:` comes from the
  transcript, the two can disagree when the primary missed the opening
  clause — `…21-44-14-925848__Искать мне эта не нужна.txt` has
  `Title: 2-ой режим вот такой То есть я могу`.

## Suites

Frontend typecheck/lint clean, vitest 54 files / 680 tests, build OK;
desktop 511/511; `node --check` main/preload OK. Backend untouched.

## Not verified live

No new dual-stream take was recorded with the fix. A `segments` event the
backend forwarder sends after the envelope still lands in the buffer
(covered by a test); one it never sends is no longer back-filled from the
envelope, so `Original:` can now lack a final clause the forwarder lost —
it is the live reading, and the transcript still has it.
