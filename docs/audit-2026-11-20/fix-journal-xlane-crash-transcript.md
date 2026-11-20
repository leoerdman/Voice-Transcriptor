# Fix journal — cross-domain lane "crash-transcript" (2026-11-20)

Branch `worktree-agent-a3c81b4b9900d3548`, fast-forwarded to `main` at 69b545f.

User requirement: even if the app crashes or the stop fails, the take's live text — with its
screen-mode marks and screenshot path lines — is saved, the screenshots are kept, and the
TRANSCRIBE panel shows it (after a failed stop immediately; after a crash on the next launch).

## Step 0 · What survived before (evidence, line numbers at 69b545f)

### The composer that exists

`frontend/src/screen-annotations.ts` `annotateTranscript` + `screenMarksFromManifest` is the one
composer of marks into text. `stopLive` wraps it in a local `withScreenMarks`
(`main.tsx` ~13097) and calls it ONLY on the success path, after transcription — so no exit that
leaves before it (or throws) ever composes the marks.

### (a) The app/renderer dies mid-take

Two independent recoveries, run one after the other at boot (`initRecordingsBootstrap`,
`main.tsx` ~13331):

1. `recoverBackendAudioSessions` (~5283) → `POST /api/live/recoveries/{id}/promote` →
   `_promote_live_recovery` (`backend/main.py` ~1601): writes the spool as a WAV, a `.txt` with
   `source_text="[Recovered live audio capture]"` and `transcript_text=""` (~1706), and adopts
   the staged screen session beside it (~1738) — screenshots kept, `events.json` rehomed, with
   `audioStartedAt` but NO `endedAt` (the desktop shell writes `endedAt` only in `finish`).
2. `recoverLiveDraftIfAny` (~6106) → a SECOND, text-only History entry
   `"<title> (Recovered)"` with the draft's live text and no audio, no marks; that text is what
   the TRANSCRIBE panel shows.

So after a crash: audio + screenshots in one entry with no text; text in another entry with no
marks and no audio; the TRANSCRIBE panel shows text without a single mark. The two entries share
the session id (the draft's `session_id` is `activeLiveSessionId`, the WS `session_id` query is
the same value, ~11191/11294) — nothing joined them.

Desktop side: `events.json` is written at start, after every shot and at finish
(`screen-mode-controller.js` 944/1054/1095); a stroke appears in the manifest only once a shot
holds it (`screen-mode.js` `screenSessionManifest`), so every mark that can appear in a
transcript is already on disk when the app dies. Nothing to change there.

### (b) The stop path fails

- **Transcription throws** (`catch` ~13186): the panel gets the error message, History gets
  `transcriptText: ""` — the live text survives only as `source_text`, the marks nowhere.
- **Mic fault / silence** (~12646): panel `"[ Mic not delivering audio ]"` / `"[ Silence ]"`,
  History the same string — a screen take drawn without speech loses every mark.
- **Auto transcribe off / no key / no canonical input** (~12661, ~12686): panel a status line,
  History `transcriptText: ""` — live text and marks not in the panel.
- **Empty final** (Deepgram envelope missing and the REST/Whisper recovery returned nothing,
  ~12985; or an empty remote pass): panel "Recording completed, no speech detected." even when
  the live preview held text; with marks, the transcript became the marks ALONE (the live text
  dropped).

### (c) The backend dies mid-take

The draft PUT fails (one warning notice), the provisional save fails ("save failed: …"), the
envelope never comes, the recovery decode fails → case (b) "empty final": panel "no speech
detected", nothing in History. The spool and the staged screens stay on disk (the sidecar's
`screen_session_id` keeps them out of the orphan sweep) and are promoted at the next launch —
case (a), with the same split.

## Step 1 · Backend: a crashed take's manifest gets an end (commit bc91944)

`screen_sessions.adopt_session` takes `audio_ended_at` and writes `endedAt` only when the
manifest has none; `_promote_live_recovery` passes the spool's span
(`_recovery_audio_span_ms`: last write = end, minus the audio it holds = start). Tests:
`test_a_crashed_take_gets_its_end_from_the_audio`, `test_a_stopped_take_keeps_the_end_the_shell_wrote`,
`test_a_crashed_screen_takes_promotion_gives_its_marks_a_time_frame`. Backend suite 1052 OK.

## Step 2 · Stop path: a take without a final transcript keeps its live text with marks

`stop-epilogue.ts`: `keepLiveTranscript(liveText, marks, durationMs)` composes through
`annotateTranscript` (the one composer); `runStopEpilogue` takes `plan.kept` /
`plan.transcriptText`, publishes `(signal, panelText)` and saves the resolved transcript;
`emptyFinalKeepsLiveText` / `resolveEmptyFinalSummary` for the empty-final case.
`main.tsx`: `publishRecordingOutput` gained `panelText` (the TRANSCRIBE panel only — the
signal to the desktop shell keeps its short status, so the capsule never shows a whole
transcript as a status). `stopLive` computes `screenMarks` once, right after the save, and
every exit — silence/mic fault, Auto transcribe off, no canonical input, no key, the
empty final, the `catch` — shows and saves `keptLiveTranscript()`. Never pasted.

## Step 3 · Crash recovery: the draft joins the entry its audio was promoted into

Backend: the promote answer carries the text fields it wrote (`title`, `source_text`,
`transcript_text`, `provider`, `model`, `language`) so the renderer rewrites the entry
without guessing. New pure module `frontend/src/take-recovery.ts`: `parsePromotedTake`,
`recoveredTakeTranscript` (draft words + marks via `annotateTranscript`, in the manifest's
time frame), `planTakeRecovery`. `recoverBackendAudioSessions` returns the promoted takes;
`recoverLiveDraftIfAny(promoted)` writes the draft's text with marks into the promoted entry
(`requireExisting: true`), gives a promoted screen take without a draft its marks, saves a
draft with no promoted take on its own (as before), shows the draft's take in the
TRANSCRIBE panel, and clears the draft only once the write carrying it succeeded.
Tests: `frontend/tests/take-recovery.test.ts` (12), contract pins in
`renderer-main-contract.test.ts` / `recording-save.test.ts`,
`test_a_promotion_says_what_it_wrote_so_the_renderer_can_complete_the_entry`.
