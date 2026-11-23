# Ultra-Audit · frontend live-recording half · Voice Transcriptor
Revision read: HEAD acbf737 (main, clean). Read-only. Scope: frontend/src/main.tsx 9285-end (+ retranscribe 8988-9200, saveRecordingText 8735-8860 for cross-checks) and pure modules live-envelope, live-coverage, live-pane, live-source, envelope-deadline, capture-warm, mic-health, audio-levels, deepgram-dual, transcript-merge, text-match, pcm-worklet.js, screen-annotations + their tests.

## 1. Coverage table
| Area | Status | How | Note |
|---|---|---|---|
| main.tsx 9285-9475 (settings popup, toggles, language fill) | read | full | 2 orphaned doc comments (FL-16) |
| 9474-9770 WS pending buffer, slots, screen helpers, globals | read | full | |
| 9770-10460 worklet/ScriptProcessor/warm-capture/mic watchers | read | full | clean ownership model (see §3) |
| 10460-11140 live buffers, envelope slots, publish*, preview render, budget slot, deadline wait | read | full | FL-05, FL-07, FL-14 |
| 11142-11320 pushCapturedFrame, flushWorkletPort | read | full | FL-06, FL-17 |
| 11322-11915 startLive (+ WS handlers) | read | full | FL-03, FL-05, FL-09 |
| 11917-13693 waitForCaptureDrain, stopLive | read | full (all 8 exits traced) | FL-01, FL-02, FL-04, FL-08, FL-10, FL-11 |
| 13695-13730 record button + hotkey listeners | read | full | FL-13 |
| 13732-14230 bootstrap, update check, boot overlay | skimmed 13732-14035 | read, not audited deeply | outside live recording |
| 14230-15754 upload queue | symbol map only | NOT audited | not live-recording; regional audit U exists (docs/archive/audit-2026-09-04/frontend-findings.md) |
| retranscribe handler 8988-9215 | read | full | FL-08 |
| live-envelope.ts, live-coverage.ts, live-pane.ts, envelope-deadline.ts | read | full | FL-05, FL-15, FL-21 |
| live-source.ts, text-match.ts, transcript-merge.ts | read | full | FL-18, FL-19 |
| capture-warm.ts, mic-health.ts, audio-levels.ts, deepgram-dual.ts | read | full | clean |
| pcm-worklet.js | read | full | clean |
| screen-annotations.ts | read | full | clean in itself; integration FL-10/11 |
| tests: live-coverage, live-pane, screen-annotations (full); renderer-main-contract (stopLive block + head); others (live-envelope, envelope-deadline, capture-warm, mic-health, audio-levels, deepgram-dual, transcript-merge, text-match, pcm-worklet, live-source) | counted it/expect and grepped for skip/mock/vacuous asserts, not read line by line | FL-20 |

## 2. Findings

### FL-01 · main.tsx:12168 `micHealthBad` + 12772 `drainedIsSilent` (stopLive) · a mic-health terminal state at Stop discards the whole transcript, even if minutes of speech were captured · P1 · confirmed
Reproduce / path: dictating with Auto transcribe on and a Deepgram/local provider -> unplug the headset (or OS-mute the input) mid-recording. `attachMicTrackWatchers` (10309) fires `ended` -> `micHealth.observe({kind:"track-ended"})` -> state `lost` -> `void stopLive(shouldAutoTranscribe())`. In stopLive, `finalMicHealth = micHealth.get()` (12140), `micHealthBad = !!STOP_COPY["lost"]` (12168), and 12772 `drainedIsSilent = silentCapture || (!!provider && micHealthBad)` is true regardless of captured level or live text -> the `drainedIsSilent` branch publishes "[ Mic not delivering audio ]" (kind error), saves that literal as `transcriptText`, returns. No envelope wait, no recovery, nothing pasted. Same for `muted` at stop (user mutes at the OS, then presses Stop) and `silent`.
Consequence: the comment at 10296-10299 promises "a clean transcript up to the disconnect point"; instead the user loses auto-paste and the History transcript is a placeholder; the audio is saved (Re-transcribe works) but the status says the mic "ended unexpectedly" with no transcript.
Current:
```ts
const micHealthBad = !!STOP_COPY[finalMicHealth.state];
...
const drainedIsSilent = !!drainedSilence?.silentCapture || (!!provider && micHealthBad);
```
Fixed: the health state may only explain an EMPTY session, never veto a non-empty one:
```ts
const level = summarizeCaptureLevel(captureLevel);
const sessionHeldSpeech = level.carriedSpeech || !!drainedSourceLiveText.trim();
const drainedIsSilent = !!drainedSilence?.silentCapture || (!!provider && micHealthBad && !sessionHeldSpeech);
```
(and keep `stopFailureReason`'s mic copy for the genuinely empty case).
Why a bug: STOP_COPY's own header (12135) says it exists to say "why is this session empty?"; applying it as a gate on non-empty sessions contradicts that and the auto-stop-on-disconnect design.

### FL-02 · main.tsx:13537 (stopLive final save) and 12796, 12843, 12889, 12946, 13586 · failure to persist the transcript is swallowed; UI says success · P1 · confirmed
Path: stop with transcript -> `saveRecordingText({... transcriptText: transcriptRaw})` throws on any non-2xx / network error (8804 `throw new Error(await parseError(r))`, apiPost throws) -> `catch (e) { if (isArchiveMutationConflict(e)) {...} }` handles only the 409 conflict; every other error is dropped without a log or a status -> next patch (13547-13557) sets `status: "Final transcript is ready. Audio and transcript are both available."`, `tone: "success"`, `savedName: persistedRecordingName`.
Consequence: a 5xx / disk-full / backend-restart during the final save leaves History with the provisional entry (empty transcript, source_text only), live-recovery spool already discarded (12697), and the user is told it was saved. Audio survives, transcript only on screen/clipboard. Same pattern in the four early-exit epilogues (silence 12796, skipped 12843, no-provider 12889, missing-key 12946) and the fallback save in the finalization-failed catch (13586, variable `saveError`); there only metadata/placeholder is lost, but still silent.
Current:
```ts
} catch (e) {
  if (isArchiveMutationConflict(e)) { finalSaveConflict = true; patchCurrentRecordingSummary({... warning ...}); }
}
```
Fixed: one helper used at all six sites, which logs and surfaces non-conflict failures:
```ts
type FinalSave = "saved" | "conflict" | "failed";
const saveFinal = async (opts: SaveOpts): Promise<FinalSave> => {
  try { await saveRecordingText(opts); return "saved"; }
  catch (e) {
    console.warn("final save failed", e);
    return isArchiveMutationConflict(e) ? "conflict" : "failed";
  }
};
// success path: status "Transcript is ready, but saving it to History failed: <sanitized>", tone "warning", savedName ""
```
Why a bug (not intent): the neighbouring code deliberately distinguishes the conflict case and writes copy for it; a generic failure falling through to the success copy is the error-turned-into-success class, and the Re-transcribe handler (9149-9152) already handles exactly this case (`archiveSaveFailureMessage`) - the two paths disagree.

### FL-03 · main.tsx:11523 `ws.onclose` (startLive) · the "synthetic error envelope on unclean close" is never recorded when the socket dies mid-recording · P2 · confirmed
Path: backend/connection drops while recording (code 1006) -> `onclose`: `const slot = liveFinalSlots.get(sessionUiToken); if (!slot) return;`. A slot exists only after `resolveLiveFinal` or `ensureLiveFinalSlot` (called from the waiters at stop: 10639, 11063) - i.e. never during recording (grep: no creation in startLive). So the comment at 11526-11533 ("stopLive now arms its waiter lazily ... dropping the envelope here meant the later waiter burned its whole timeout") describes a fix that the `!slot` bail-out cancels. At Stop the waiter then waits `LIVE_ENVELOPE_CONFIRM_MS` 1.5 s (Deepgram) or `envelopeWaitMs` 4 s (local) for a message that cannot come, before falling back. Also no user-visible status at the moment the stream died (only console.warn); the preview just freezes.
Current: `const slot = liveFinalSlots.get(sessionUiToken); if (!slot) return; if (slot.envelope) return;`
Fixed: `const slot = ensureLiveFinalSlot(sessionUiToken); if (slot.envelope) return;` (the remainder unchanged), plus on unclean close while `isActiveSession && isRecording` patch the summary "Live stream lost - the recording continues and will be transcribed from the saved audio".
Why a bug: the comment and the code of the same function disagree; the intended behaviour (immediate fallback) is not achieved. Cost is 1.5-4 s extra per such stop; correctness of the transcript is not affected (fallback still runs).

### FL-04 · main.tsx:13609 (inner `finally`) vs the six early returns 12638, 12766, 12813, 12862, 12906, 12957 · `micHealth.observe({kind:"session-stop"})` is skipped on every no-transcript exit -> the topbar mic pill stays "Mic live" / "Mic: no audio" after Stop · P2 · confirmed
Path: any stop through discard (too short), startup-abort, drained-silent, auto-transcribe off, no provider, missing key. `session-stop` (resets the tracker to `idle`, which hides `#micPill`, 5764) is only in the inner `finally` (13609) of the `try` that starts at 12974, after all six `return`s. `releaseStopEpilogueBookkeeping` (12027) does not include it. The tracker is reset only at the next `startLive` (11700). The most ordinary trigger is Auto transcribe OFF: after every recording the pill keeps saying "Mic live" while the mic is released; after a silent take it keeps "Mic: no audio".
Fixed: move the observation into the shared bookkeeping step (or into the outer `finally`) so exactly one place ends the session:
```ts
const releaseStopEpilogueBookkeeping = (): void => {
  micHealth.observe({ kind: "session-stop" });
  clearLiveDraft(sessionUiToken); setBusy(false, sessionUiToken); releaseStopTransitionAfterCaptureDetach();
};
```
(`finalMicHealth` is already read at 12140, so the early reset does not lose the verdict.) Test: extend renderer-main-contract with "session-stop observed once per stop" is source-text only - better to move the whole epilogue into a function (see D-13).
Why a bug: the tracker's documented lifecycle is session-start -> session-stop; this is the "D-13 epilogues drifted" consequence the helper's own comment warned about (12014-12025: "the order-independent triplet" - session-stop is the fourth item the triplet silently lacks).

### FL-05 · main.tsx:11624-11643 (`case "final"` in startLive) vs 11455/489-531 · the envelope is rebuilt field-by-field from the already-parsed message, re-introducing the drift the contract module exists to remove · P2 · confirmed
`parseLiveWsMessage` returns `{type:"final", ...parseLiveFinalEnvelope(obj)}` and `LiveFinalEnvelope` is declared as that message minus `type` ("the two used to be ten fields written out twice, where adding a field to one of them was a silent no-op", 449-455). The handler then copies text, segments, durationSec, source, error, coverage, uncoveredSpeechSec (only if >0), streamedSec, coveredEndSec, stats one by one. Add an eleventh field to `LiveFinalEnvelopeFields` and `LiveFinalEnvelope` silently lacks it (optional fields: no compile error) - the failure mode `live-envelope.ts` header describes.
Current: `const envelope: LiveFinalEnvelope = { text: ..., segments: msg.segments, ... }; if (msg.error) envelope.error = ...; if (msg.coverage) ...`
Fixed:
```ts
const { type: _type, ...fields } = msg;
const envelope: LiveFinalEnvelope = { ...fields, text: normalizeTranscriptWhitespace(fields.text), source: fields.source || sessionWsMode };
```
Behavioural nuance to keep: `uncoveredSpeechSec` zero is currently dropped; spread keeps 0 (harmless; `describeLiveFinalStats` does not print it).
Also nit in the same function (11475 vs 11387): `diarize: readDiarizeEnabled()` re-reads the DOM for the WS query although `activeLiveSessionSnapshot.diarize` was just captured (F-006 follow-up: snapshot added, WS query not moved onto it). Use `String(activeLiveSessionSnapshot.diarize)`.

### FL-06 · main.tsx:9486 `WS_PENDING_MAX_SAMPLES = 64_000` vs 976/2136 `LIVE_SAMPLE_RATE_HZ` · the pre-open buffer cap hardcodes 4 s at 16 kHz while the sample rate is a backend-driven `let` (8k-96k) · P2 · hypothesis (latent: only when the backend reports a rate other than 16 kHz)
`pushCapturedFrame` counts `ds.length` (samples at `LIVE_SAMPLE_RATE_HZ`) against 64 000. If `live_sample_rate_hz` is 48 000 the cap is 1.33 s - exactly the BUG-59 regression the comment at 9481 describes ("slow handshake silently dropped opening words", and `wsFramesNeverSent` then forces the slow path).
Fixed: `const wsPendingMaxSamples = (): number => LIVE_SAMPLE_RATE_HZ * UI_TOKENS.live.preOpenBufferSec;` (new token, 4).
Why a bug: a duration is expressed as a sample count at one assumed rate, next to the variable that can change that rate.

### FL-07 · main.tsx:11014-11026 `LIVE_ENVELOPE_*`, 10632 `waitForLiveFinalEnvelope`, 13071 `recordedSec <= 30` · stop budgets live in three places and the final envelope has two waiters · P2 · confirmed
`UI_TOKENS.finalize.envelopeWaitMs` (4 000, "argued for alongside the other stop budgets", 12383), `shortEmptyRecoveryMs`, `defaultEmptyRecoveryMs` are in UI_TOKENS; `LIVE_ENVELOPE_CONFIRM_MS` 1 500 / `LIVE_ENVELOPE_DELIVERY_MARGIN_MS` 800 / `LIVE_ENVELOPE_MAX_WAIT_MS` 11 000 are module constants; the "short recording" threshold 30 s is an inline literal (13072). Two implementations wait for the same `final` message: `waitForLiveFinalEnvelope(token, ms)` (local assist only, fixed 4 s, ignores `finalizing`) and `waitForLiveEnvelopeWithAnnouncedBudget` (Deepgram). Consequence: tuning "stop latency" means editing three places; the local path never benefits from C3.
Fixed: move the four numbers to `UI_TOKENS.finalize`; make the local path call the announced-budget waiter too (backend sends `finalizing` only for Deepgram today, so for local it degrades to `confirmMs`=1.5 s - decide the local budget explicitly in the config object passed to the one waiter).

### FL-08 · main.tsx:13319 comment + 13044-13160 `recoverFromEmptyTranscriptInner` vs 8988-9190 Re-transcribe handler · two parallel "decode the saved recording" implementations; the comment claiming they are the same chain is false · P2 · confirmed
stopLive comment: "through the same `transcribe-on-disk` chain the manual Re-transcribe button uses". Re-transcribe does NOT call `transcribe-on-disk` (grep: the endpoint appears only at 13046 and in comments); it fetches the audio and uploads via `remoteJobSync` + `transcribeCanonicalAudioLocally`. Differences between the two chains: on-disk fast path vs upload; Deepgram-first both, but the stop path honours `isRemoteProviderReachable` and a hard timeout + AbortController, Re-transcribe has neither; stop path snapshots `diarize`, Re-transcribe reads the DOM at click time; only Re-transcribe annotates marks (re-implemented at 9120 with a different clock, see below). Raw `fetch` + `authHeaders()` at 13047 bypasses the api wrapper (known C-021 area).
Fixed: extract `decodeSavedRecording({name, archiveDir, language, diarize, signal, snapshotModels})` returning `{text, provider}` and call it from both; fix/delete the comment.
Also: screen marks at stop use `durationMs: recordedMs` + live word timings (13446-13459) while Re-transcribe uses `screenSessionDurationMs(manifest)` (9122): two clocks for one rule. Acceptable (no timings on re-decode) but the Re-transcribe path should be the same helper as `withScreenMarks`.

### FL-09 · main.tsx:9831 `showMicFallbackNotice` · the on-screen "[Mic fallback engaged]" notice is overwritten by the next transcript event · P2 · confirmed
It writes into `liveDraftDisplayText` via `setLiveDraftState(liveDraftText, cur + "\n[Mic fallback engaged]")`. Every `segments`/`interim` WS event calls `projectLiveTranscriptBufferToActiveState` (10575) -> `setLiveDraftState(buffer.committedText, buffer.committedDisplayText)`, replacing it (Deepgram sends several per second). With preview off it is not shown at all (`shouldLivePreview()` early return). So the only durable signal is `console.warn`. Fixed: use `showRecordSessionNotice(...)`/`patchCurrentRecordingSummary` (the channels already used for the 2-hour WebM notice, 11755) instead of the preview text.

### FL-10 · main.tsx:12747 startup-abort branch / 12720 both-saves-failed · the screen session is finished (kept) but never adopted or discarded · P2 · hypothesis (disk, bounded)
Path: screen take, mic start fails (`liveStartAbortReason`) or both archive saves fail. `finishScreenSession(id, discarding=false)` (11990) has already moved main to "finished, keep"; `screenFinish` removes the staging dir only on `discard` (screen-mode-controller.js:707); adoption happens only inside a successful `save-with-audio`. The startup-abort return and the all-saves-failed path never call discard, so screenshots stay in `<data>/screen-sessions/<id>` until the next backend start's `sweep_orphan_sessions` (backend/main.py:1066). Fixed: in those two branches call `finishScreenSession`-equivalent discard (`screenFinish({id, discard:true})`) once the take is known to have no recording; or decide discard from `savedAudioFile` before the first `finish`.

### FL-11 · main.tsx:12686 `screenManifest = parseScreenManifest(persisted.screensManifest) || stagedScreenManifest` · silent fallback to staging paths when adoption failed · P2 · hypothesis
backend/main.py:8050-8060 logs a warning and returns `screens: null` if `adopt_session` fails; the renderer silently keeps the staged manifest and writes its `files` (staging paths) into the transcript marks (13446-13467), which the orphan sweep later deletes - the saved transcript then points at files that disappear. Fixed: when `stagedScreenManifest` is set and `persisted.screensManifest` is null, drop the shots' `files` (marks fall back to "- not saved") and show a warning in the summary.

### FL-12 · main.tsx:5811 `buildLiveDraftPayload` / 6003 `recoverLiveDraftIfAny` (called from startLive/stopLive) · a screen-mode take is always recorded in the draft as collection `live` · P2 · hypothesis
`liveRecordingCollection(liveRecordingMode)` is passed to the WS (11474) and to every save, but the autosaved draft (`persistLiveDraft(true)` every `draft.autosaveIntervalMs`) hardcodes `RECORDING_COLLECTIONS.live`, and recovery saves under `live`. After a crash mid-screen-take the backend's audio recovery lands in the screen collection (from the WS param) and the renderer's draft recovery creates a second text-only "(Recovered)" entry in `live`. Fixed: put `recording_collection: liveRecordingCollection(liveRecordingMode)` in the payload and read `draft.recording_collection` in recovery. (Lines are in the other auditor's half; the cause is the new `liveRecordingMode`.)

### FL-13 · main.tsx:13708/13724 vs desktop/main.js:2700 · the "too short to keep" verdict is computed twice, at two instants · P2 · hypothesis (race at the 500 ms boundary)
The doc at 9651-9655 says one clock, one threshold, one answer because two measurements disagree at the boundary. Main evaluates `__transcriptorRecordingTooShort()` in its executeJavaScript (`discarded: tooShort`) and the renderer evaluates it again, later, in the event handler (`{discard: recordingIsTooShortToKeep()}`). A press at 499/501 ms can be judged "too short" by main (skips queueing post-stop work) and "keep" by the renderer (transcribes, nothing pastes), or the reverse. Fixed: main puts `discard` in the event detail (`transcriptor-hotkey-toggle`/`-stop` `detail`) and the renderer obeys it; the window function remains only as the query main uses to decide.

### FL-14 · dead / duplicate state · P2 · confirmed
- main.tsx:12195 `remoteApiPromise` is initialised to `null`, assigned once (13386) right after a `!remoteApiPromise &&` check; the "start it only after save" comment (12468) describes a path that no longer exists.
- main.tsx:9748 `liveWsMode` module `let`, written 11423, read once on the next line into `sessionWsMode`; nothing else reads it.
- main.tsx:9717 `liveTranscriptSegments` (projection "kept for the existing renderer and main-process read paths", 10948) is read only in two `console.log` fallbacks (12265, 12333).
- main.tsx:10829 `clearRecordingFinalSignal()` is a one-line alias of `clearRecordingOutput()` (one caller, 11435); `publishRecordingFinalSignal` (10833) is a rename wrapper of `publishRecordingOutput` (`signalText`->`pasteText`); two vocabularies for one signal, eight call sites on the wrapper.
- main.tsx:13556/13605 `...(cond ? { savedName: x } : { savedName: "" })` - both arms set the same key.
Fixed: delete the first four, collapse to `{ savedName: cond ? x : "" }`.

### FL-15 · live-coverage.ts:115 vs live-envelope.ts:41-42 vs main.tsx:443,5216 · `"local-assist"` / `"deepgram-live"` written 4+ times, the exported constants have no production reader · P2 · confirmed
`LOCAL_ASSIST_SOURCE`/`DEEPGRAM_LIVE_SOURCE` are imported only by tests/live-envelope.test.ts; `decideLiveTranscriptAdoption` compares with the literal `"local-assist"`, `LiveWsMode` and `resolveLiveWsMode` (5216) repeat it. Fixed: import the constant in live-coverage.ts (type-only cycle is already there) and derive `LiveWsMode` from it.

### FL-16 · stale / misplaced comments and formatting · P2 · confirmed
- main.tsx:10211 "the expiry timer in `holdWarmCapture` above" - no such function (it is `commitWarmCaptureHold`).
- main.tsx:9385-9394 doc block for `fillDualSecondaryLanguageOptions` sits above `fillUploadLanguageOptions` (two stacked doc blocks).
- main.tsx:9577-9580 doc ("Ask main to end the screen-mode session...") belongs to `finishScreenSession` (9608) but sits above `screenMarksForSavedRecording`.
- main.tsx:12400-12401 mis-indented `wsPendingFrameSamples = 0;`.
- main.tsx:11737-11742 "one chunk per second (see start(1000))" - the literal 1000 and `fallbackWindowSec` are coupled only by comment.
- main.tsx:12010 "F/7 found seven near-identical epilogues"; actual list now eight exits (the discard one was added later) - known D-13.
(frontend-findings F-013 already asked for no line-number comments; these are new instances.)

### FL-17 · main.tsx:11229-11240 `pushCapturedFrame` · PCM16 encoding runs for every frame even when there is no socket · P2 · confirmed (perf)
`new ArrayBuffer` + a per-sample `setInt16` loop run before `if (!ws) return;` (11240). For audio-only sessions (no provider: `sessionWsMode === "none"`) that is ~94 allocations/s and a full encode that nobody reads. Fixed: `if (!ws) return;` before the encode (the sink append above does not need `pcm`).

### FL-18 · screen-annotations.ts:158 vs text-match.ts:33 · `countWords` is defined twice with different implementations · P2 · confirmed
Private `\S+` match vs exported `split(/\s+/).filter(Boolean)`; text-match.ts's header says it is the single source for word primitives. Fixed: import `countWords` from `./text-match`.

### FL-19 · live-source.ts:~200 `mergeInterim` (called per interim by `getCanonicalLiveSourceText`/draft autosave) · whole-committed-text normalisation per call · P2 · hypothesis (perf, long recordings)
`baseRawWords = base.split(...)` and `baseNormWords = normalizeWords(base)` over the entire committed text on every interim (10-20 Hz) and every 1.2 s autosave, although the file's own comment (redecodedTailAlignment) argues "stemming a whole recording's committed text per commit is work that grows with the recording". Only the seam window is needed for rules 1, 2, 4; rule 3's overlap needs at most `min(len(interim words), window)` tail words. Measure with a 2 h recording before changing.

### FL-20 · tests · P2 · confirmed
- tests/live-coverage.test.ts has 3 cases (one rejection reason of nine, no adopt case). The matrix lives in backend/tests/test_live_coverage_policy.py, which compiles the TS with `tsc` and drives it via node, justified by "the frontend has no JavaScript test runner" (file header) - false since vitest; it also silently skips when node/tsc is missing. The same pattern is F-009's mic-health. Fix: port the 10 cases to vitest, drop the python copy.
- tests/renderer-main-contract.test.ts:171-221 pins stopLive by regex on main.tsx source text: `kind: "transcript"` appears once; `releaseStopEpilogueBookkeeping();` appears exactly 6 times; "boundary markers" = string indexes. It passes for any refactor that keeps the strings and fails for behaviour-preserving moves; it cannot see FL-01/FL-02/FL-04. The screen-mode composition inside stopLive (plain vs annotated, timed vs proportional, marks-only transcript when nothing was said: 13446-13512) has no test at all because it is inline in the 1 700-line function; only `annotateTranscript` itself is tested.
- tests/live-pane.test.ts:30 locks in that `livePaneDisplayText` THROWS for `previewEnabled: true` (see FL-21).

### FL-21 · live-pane.ts:27 `livePaneDisplayText` · an input field whose only legal value is `false` · P2 · confirmed
`previewEnabled` exists in `LivePaneInput` but any `true` throws; the single caller (main.tsx:10882) hard-codes `false`. Fixed: drop the field and the throw (the function is "preview-off status text").

### FL-22 · known, not fixed (do not re-count)
- D-13/U-022 (F/7): stopLive epilogues - still 6 early returns + the catch + success, five different inline save blocks (12669, 12784, 12831, 12877, 12934). Only the bookkeeping triplet is shared. FL-01/02/04 are live consequences.
- desktop-findings §"executeJavaScript-опрос как API рендерера" (docs/archive/audit-2026-09-04/desktop-findings.md:1110): renderer still publishes ~20 `window.__transcriptor*` globals that main polls (`desktop/main.js` 2401-2404, 3074-3091, 2689) in parallel with the pushed `window.transcriptor.recordingFinal` channel (10770) - two sources of truth for "paste-ready text" (Channel 1 scalars + Channel 1b IPC). Still present.
- BUGSAUDIT-2026-09-04 §"Preload ... уберёт `document.title`-канал": `postTitleBridgeMessage` (940, uses 13703, 14413) still the renderer->main IPC for record-toggle/reveal/shortcuts, while preload already exposes `ipcRenderer.invoke` (`screenFinish`, `recordingFinal`); the desktop comment (8395) "the renderer cannot use ipcRenderer" is stale since 1.6.6.

## 3. Clean places (checked, no defect)
- Warm capture ownership move (plan at step 1, commit at teardown, TTL/devicechange/visibility/pagehide/suspend release, wall-clock re-check in `decideWarmReuse`): ownership never shared; `handOverHeldCapture` stops the mic if the plan fails. `capture-warm.ts` pure functions + order tests are sound.
- pcm-worklet.js: ring wrap-around, arm-flush-then-ack ordering, `start()` leaving `pending` alone, cold start delivering from construction.
- Frame accounting: `recordWsFrameSent` single increment; `wsFramesNeverSent` for send-throw, cap overflow, CLOSING/CLOSED; stranded-frame handling at stop (12397-12403) before finalize.
- `waitForLiveEnvelopeWithAnnouncedBudget` leaves `finish`/`applyAnnouncement` in the slot waiter lists after a timer settle; harmless: the outer `finally` (13664-13685) splices waiters and deletes `liveFinalSlots`, `liveStreamErrors`, `liveTranscriptBuffers`, `finalizeBudgetSlots` for the stopped token. `computeEnvelopeDeadlineMs`/`envelopeMissing` correct (an empty no-error envelope is not missing).
- stopLive guards: `stopTransitionInFlight` + owner token + double release; outer `finally` always resets ids/busy and closes the deferred socket with handlers nulled; start-cancel via `liveStartAttemptSeq` + `cleanupCancelledStartCaptureResources` covers stream/AudioContext/recorder; `startLiveInFlight` set before the first await.
- Screen mode: main starts the screen session only after the renderer confirmed the start (desktop/main.js:2891), so early `return`s in `startLive` (11359, 11333) leave nothing to finish; `finishScreenSession` never throws and is taken before any await in stopLive; discard -> `rmSync` staging; marks use archived `audioStartedAt` with live-clock fallback; `annotateTranscript` placement/ordering/empty-text rules and the manifest parser are consistent with their tests and with `contracts/screen-session.json`; upscale-rewritten text is placed proportionally (13511) and the title is taken from the spoken text only (13474, 13524); `recordingCollection` omitted in Re-transcribe is safe because the backend idempotently accepts the archived collection dir (main.py `_resolve_recordings_collection_target_dir`).
- `mic-health.ts` FSM transitions (dwell clamp `MAX_SAMPLE_GAP_MS`, muted/lost ignore rms, unmute re-probes) and `audio-levels.ts` (floor fall fast / rise slow, dead-pipeline absolute anchor).
- `deepgram-dual.ts` resolves absent -> backend default, never "off".
- `parseLiveFinalEnvelope`/`parseLiveCoverage`: absent never read as zero; fixtures shared with backend.
- Publish channels: `FINISHED_RECORDS_KEPT` pinned to the desktop constant by a test; `clearRecordingOutput` atomic before id change.
