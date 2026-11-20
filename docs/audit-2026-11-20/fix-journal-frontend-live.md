# Fix journal — frontend live/upload lane (Ultra-Audit 2026-11-20)

Scope: `frontend/src/main.tsx` from the delete-all handler (~9258) to the end, the live
pure modules and their tests, `renderer-main-contract.test.ts`, new pure modules.
Findings: `frontend-live.md` (FL-01…FL-22), `frontend-upload.md` (FQ-01…FQ-22),
renderer parts of `scenarios.md` S-15/S-16, duplicates of `BUGSAUDIT-2026-11-20.md` §3.

Proof method for every entry (SKILL §7.1): files copied aside, the fix removed (main.tsx
restored from `HEAD` of the commit's parent; for a new pure module the decision body put
back to the pre-fix inline rule), the check run ("before"), files restored byte-for-byte
(`diff -rq` against the copy → identical), the check run again ("after"). Script:
`prove.sh` in the session scratchpad; outputs quoted below.

## Journal of fixes

### 548c4aa · FL-01
- Files: `frontend/src/stop-epilogue.ts` (new, `decideDrainedSilence`), `frontend/src/main.tsx`
  (stopLive drained-silence branch), `frontend/tests/stop-epilogue.test.ts` (new),
  `frontend/tests/renderer-main-contract.test.ts` (pin).
- Check: `npx vitest run tests/stop-epilogue.test.ts tests/renderer-main-contract.test.ts`
- Before (fix removed): exit 1
  ```
       × a mic lost mid-dictation after captured speech still goes on to transcription 16ms
       × speech evidenced by the level alone (no live text yet) is enough to transcribe 3ms
       × speech evidenced by the live transcript alone is enough to transcribe 0ms
       × FL-01: the drained-silence branch asks decideDrainedSilence, so mic health cannot veto a spoken session 8ms
        Tests  4 failed | 32 passed (36)
  ```
- After: exit 0 — `Tests  36 passed (36)`

### d975368 · FL-02, FL-04, D-13/U-022 (+ FL-14 savedName spread)
- Files: `frontend/src/stop-epilogue.ts` (`attemptFinalSave`, `runStopEpilogue`, `resolveEpilogueSummary`,
  `resolveTranscriptStopSummary`, `resolveFailedStopSummary`), `frontend/src/main.tsx` (stopLive: six exits →
  `endWithoutTranscript(plan)`, one `saveSessionMetadata`, `endStopSession`), tests as below.
- Check: `npx vitest run tests/stop-epilogue.test.ts tests/renderer-main-contract.test.ts`
- Before (main.tsx = parent 548c4aa; `attemptFinalSave` non-conflict branch = pre-fix "falls through to success"): exit 1
  ```
       × the six no-transcript exits end through one epilogue, not a copy each (D-13) 3ms
       × FL-02: exactly two saves in stopLive — the provisional audio save and the one classified metadata save 1ms
       × FL-04: every exit ends the mic-health session through the one session-ending step 0ms
       × any other failure (5xx, disk full, backend restarting) is 'failed' with its message, and never throws 5ms
        Tests  4 failed | 50 passed (54)
  ```
- After: exit 0 — `Tests  54 passed (54)`
- Decision log: the conflict warning is now the summary a no-transcript stop ends on (three sites used to
  overwrite it on the next line); every epilogue hides `#progressRow` (idempotent; the silence exit did not);
  the missing-key exit writes its summary after the save instead of before (same end state); on a failed final
  save the summary keeps `savedName` — the provisional save holds the audio, so the entry exists; the audit's
  suggestion of `""` would unlink an entry that is there. The finalization-failed catch shares
  `saveSessionMetadata` and a resolver but not `runStopEpilogue`: it keeps busy until the outer `finally` (the
  single-capsule invariant), which `runStopEpilogue`'s `release` would break.

### e3bc2d8 · FQ-01, FQ-05, FQ-18
- Files: `frontend/src/upload-item.ts` (new), `frontend/src/main.tsx` (`saveUploadItemToHistory`,
  `processUploadItem`, `retryUploadItem`, `cancelUploadItem`, Clear done, `renderUploadQueue`,
  `renderUploadResultPane`), `frontend/tests/upload-item.test.ts` (new), contract pins.
- Check: `npx vitest run tests/upload-item.test.ts tests/renderer-main-contract.test.ts`
- Before (main.tsx = parent d975368; `uploadTranscriptAwaitingSave` = pre-fix "nothing reads `item.text` on error"): exit 1
  ```
       × is recognised as awaiting a save 3ms
       × the error view shows the transcript and offers Copy beside the error 1ms
       × 'Clear done' keeps it; every other finished item is clearable 0ms
       × plans a save-only retry when the transcript is held 1ms
       × both the queue row and the result pane render the error state through uploadErrorView 6ms
       × Retry asks uploadRetryPlan and a save-only retry goes through the one save helper 2ms
       × 'Clear done' filters by isUploadClearable 5ms
       × the save stage cannot be 'stopped': cancel ignores it and the Stop button is disabled 8ms
        Tests  8 failed | 33 passed (41)
  ```
- After: exit 0 — `Tests  41 passed (41)`
- Decision log: "awaiting save" is derived (status error + text + no savedName) rather than a new snapshot field,
  because the backend normaliser `_normalize_upload_queue_item` drops unknown fields — a new field would be a
  backend change and would not survive a restart. Consequence: a save failure of an EMPTY transcript still
  retries as a full transcription (nothing to keep). Retry-save sends the audio from the kept path when it still
  validates, else the kept File, else saves the transcript alone — never re-transcribes. FQ-18 fixed by making
  the save non-stoppable (a `saving` stage) rather than pretending to cancel a save that cannot be undone.

### d14ea3c · FQ-02, FQ-03 (c)
- Files: `frontend/src/upload-queue-persist.ts` (new), `frontend/src/main.tsx` (`flushUploadQueueSnapshotNow`,
  unload listener), `frontend/tests/upload-queue-persist.test.ts` (new), contract pins.
- Check: `npx vitest run tests/upload-queue-persist.test.ts tests/renderer-main-contract.test.ts`
- Before (main.tsx = parent e3bc2d8; `nextQueueSaveRetry` = pre-fix "never retried"): exit 1
  ```
       × retries after the first failures with a doubling delay 3ms
       × caps the delay 0ms
       × FQ-02: a failed queue snapshot write re-arms the dirty flag and goes through the retry policy 7ms
       × FQ-03: the unload flush listens to pagehide only 17ms
        Tests  4 failed | 36 passed (40)
  ```
- After: exit 0 — `Tests  40 passed (40)`
- Decision log: retry policy lives in the new module (not `UI_TOKENS`, which belongs to the other lane); FQ-03 (a)
  and (b) not done — see "Not done".

### d132c4f · FL-03
- Files: `frontend/src/live-envelope.ts` (`liveCloseOwesErrorEnvelope`), `frontend/src/main.tsx` (`ws.onclose` in
  startLive), `frontend/tests/live-envelope.test.ts`, contract pin.
- Check: `npx vitest run tests/live-envelope.test.ts tests/renderer-main-contract.test.ts`
- Before (main.tsx = parent d14ea3c; decision = pre-fix "no slot → nothing recorded"): exit 1
  ```
       × records the error envelope through liveCloseOwesErrorEnvelope, without bailing out on a missing slot 5ms
       × an unclean close with no envelope yet owes one, whether or not a waiter exists 4ms
        Tests  2 failed | 58 passed (60)
  ```
- After: exit 0 — `Tests  60 passed (60)`

### db7b76b · FL-05, FL-06, FL-08 (comment), FL-09, FL-14, FL-15, FL-16, FL-17, FL-18, FL-20, FL-21
- Files: `frontend/src/main.tsx`, `frontend/src/live-coverage.ts`, `frontend/src/screen-annotations.ts`,
  `frontend/src/live-pane.ts`, `frontend/tests/live-pane.test.ts`, `frontend/tests/live-coverage.test.ts`,
  `frontend/tests/renderer-main-contract.test.ts`.
- Check: `npx vitest run tests/renderer-main-contract.test.ts tests/live-coverage.test.ts tests/live-pane.test.ts tests/screen-annotations.test.ts`
  and `npx tsc --noEmit` (FL-21 is a compile-time check: tests/ is in the tsconfig include).
- Before (main.tsx, live-coverage.ts, screen-annotations.ts, live-pane.ts = parent d132c4f): vitest exit 1
  ```
       × cannot be asked to own preview-on rendering — that stays in the caller (FL-21) 6ms
       × FL-14: the dead projections, aliases and the never-reassigned promise are gone 42ms
       × FL-15: live-coverage compares against the exported source constant, not a literal 21ms
       × FL-18: screen-annotations counts words with text-match's countWords 6ms
       × FL-06: the pre-open buffer cap is a duration at the live sample rate, not 64 000 samples 51ms
       × FL-17: no PCM16 encode without a socket to send it to 1ms
       × FL-05: the final envelope is the parsed message minus its type, and the WS diarize comes from the snapshot 5ms
       × FL-09: the mic-fallback notice is a session notice, not text the next preview event overwrites 3ms
       × FL-16: comments name functions that exist 47ms
        Tests  9 failed | 71 passed (80)
  ```
  tsc exit 2:
  ```
  tests/live-pane.test.ts(26,32): error TS2345: Argument of type '{ recording: false; started: true; timerText: string; }' is not assignable to parameter of type 'LivePaneInput'.
    Property 'previewEnabled' is missing in type '{ recording: false; started: true; timerText: string; }' but required in type 'LivePaneInput'.
  tests/live-pane.test.ts(33,5): error TS2578: Unused '@ts-expect-error' directive.
  ```
- After: vitest exit 0 — `Tests  80 passed (80)`; tsc clean.
- Notes: FL-20's ported matrix passes before and after by design (it adds coverage of an unchanged decision; the
  Python copy in `backend/tests/test_live_coverage_policy.py` is backend-owned — cross-domain). FL-05 behaviour
  nuance: `uncoveredSpeechSec: 0` is now kept on the envelope instead of dropped (diagnostic only;
  `describeLiveFinalStats` does not print it). FL-08: only the false comment is fixed; the shared
  `decodeSavedRecording` needs the Re-transcribe handler (above line 9285) — cross-domain.

### fbd207c · FQ-06 (a), FQ-07, FQ-08, FQ-09, FQ-10, FQ-11, FQ-16, FQ-19 (partly), FQ-20, FQ-21, FQ-22 (1, 2, 4)
- Files: `frontend/src/upload-item.ts` (`pickNextQueuedUpload`, `uploadSourceValidationError`, `uploadQueueTitle`,
  `uploadItemRetryable`), `frontend/src/main.tsx` (upload queue region), tests.
- Check: `npx vitest run tests/upload-item.test.ts tests/renderer-main-contract.test.ts`
- Before (main.tsx = parent db7b76b; the new decisions set to the pre-fix rules — first queued from the top,
  dropped-file wording, terminal counted as done, Retry for errors only): exit 1
  ```
       × a batch A, B, C (shown newest-first: C, B, A) starts with A 5ms
       × an earlier batch is not overtaken by a later one, and non-queued rows are skipped 7ms
       × rejects a name without an extension, and an extension the backend does not accept 1ms
       × names failures and cancellations separately 0ms
       × offers Retry for failed and cancelled items only 1ms
       × FQ-06/FQ-07: no invented progress, and a poll tick re-renders only when the stage changes 16ms
       × FQ-08: the pump starts the oldest queued item 2ms
       × FQ-09: nothing is enqueued while the server queue is unknown 1ms
       × FQ-10/FQ-11: one provider normaliser and one source validator 1ms
       × FQ-16/FQ-19: rows are keyboard buttons, the title counts done only, one filter rule, one pane render 6ms
       × FQ-20: the window-level drop blocker cancels file drags only 9ms
       × FQ-21: upload timings are one clock (epoch ms) 1ms
       × FQ-22: no dead File.path fallback, no abort of a settled item, Retry for cancelled items 14ms
        Tests  13 failed | 56 passed (69)
  ```
- After: exit 0 — `Tests  69 passed (69)`
- Decision log: FQ-08 fixed by picking the oldest queued item rather than reversing the batch on enqueue
  (reversing still lets a later batch overtake an earlier one). FQ-09 fixed by blocking the enqueue while the
  server queue is unknown, not by merging on restore: with enqueue blocked no live rows can exist before a
  successful restore, so the `splice` is safe. FQ-21: `completedAt` kept (the backend normaliser owns the field
  list); a restored item keeps its own pair of old page-relative values, so no item mixes clocks.
  The validator's empty-extension-set pass-through is kept and documented (the backend revalidates).

### 9ede434 · FQ-13 (= FU-17), FQ-14 (renderer part), FQ-15, FQ-22 (3)
- Files: `frontend/src/boot-error.ts` (new, `classifyBootError` moved + fixed), `frontend/src/main.tsx`
  (`runUpdateCheck`, passive check, `initRecordingsBootstrap`, boot race, boot overlay), `frontend/tests/boot-error.test.ts`
  (new), contract pins.
- Check: `npx vitest run tests/boot-error.test.ts tests/renderer-main-contract.test.ts`
- Before (main.tsx = parent fbd207c; `classifyBootError` body = pre-fix substring match, no 10013 branch, "3.10+"): exit 1
  ```
       × FQ-13: a failed update check is not stamped as 'checked today' 9ms
       × FQ-14: the classifier lives in ./boot-error and every raw error gets its disclosure 29ms
       × FQ-15: bootstrap failures reach the status line, and the boot race clears only its own promise 3ms
       × FQ-22: no overlay state written right before the page reloads 0ms
       × WinError 5 is access denied, but WinError 50/53 are not 10ms
       × WinError 10013 (a reserved or firewalled port) has its own diagnosis 2ms
       × the Python copy states no version the project does not declare 11ms
        Tests  7 failed | 55 passed (62)
  ```
- After: exit 0 — `Tests  62 passed (62)`
- Note: FQ-13 duplicates FU-17 (other lane's ID); the code is in this lane's range, so it is fixed here once.

## Tally

| Severity | Findings in scope | Fixed + proven | Not done / cross-domain |
|---|---|---|---|
| P1 | FL-01, FL-02, FQ-01, FQ-02, FQ-04 (5) | 4 (FL-01, FL-02, FQ-01, FQ-02) | 1 (FQ-04 — code above line 9285) |
| P2 | FL-03…FL-21, FQ-03, FQ-05…FQ-22, S-15, S-16, D-13/U-022 | FL-03, FL-04, FL-05, FL-06, FL-09, FL-14, FL-15, FL-16, FL-17, FL-18, FL-20 (frontend half), FL-21, D-13/U-022, FQ-03 (c), FQ-05, FQ-06 (a), FQ-07, FQ-08, FQ-09, FQ-10, FQ-11, FQ-13, FQ-14 (b–d), FQ-15, FQ-16, FQ-18, FQ-19 (partly), FQ-20, FQ-21, FQ-22 (1–4) | FL-07, FL-08 (shared decode), FL-10, FL-11, FL-12, FL-13, FL-19, FQ-03 (a, b), FQ-06 (b, c), FQ-12, FQ-14 (a, e), FQ-17, FQ-19 (scoped static copy), FQ-22 (5), S-15, S-16 |
| — | FL-22 | known, not re-counted (D-13 part closed above) | executeJavaScript globals / `document.title` bridge: desktop |

## Not done (ID → reason)

- **FL-07** (stop budgets in three places, two envelope waiters) — the four numbers belong in
  `UI_TOKENS.finalize` (`ui-copy.ts`, the other lane's file), and putting the local path on the
  announced-budget waiter changes its budget from 4 s to 1.5 s (the backend sends `finalizing` only for
  Deepgram): a product decision, not a refactor. Left as found.
- **FL-08** (two "decode the saved recording" chains) — only the false comment in stopLive fixed
  (db7b76b). The shared `decodeSavedRecording` needs the Re-transcribe handler at ~8988–9200, above this
  lane's boundary. See cross-domain.
- **FL-10** (screen session finished-kept on startup-abort / all-saves-failed) — hypothesis (disk, bounded
  by the 24 h sweep). The renderer has no renderer-only fix: `finishScreenSession` runs at the top of stopLive
  (so the overlays leave with the press), and a second `screenFinish({discard:true})` after the session ended
  finds no session in the controller and removes nothing. Needs desktop — cross-domain.
- **FL-11** (silent fallback to staged screenshot paths when adoption fails) — hypothesis; the fix changes what
  the transcript says (marks become "not saved") and the staged files exist until the sweep. Per §7: hypothesis
  with observable change → described, not changed.
- **FL-12 / S-01 / H-01 / BM-04** (screen take recovered as Live) — renderer half is `buildLiveDraftPayload`
  (~5811), `recoverLiveDraftIfAny` (~6003) and `recoverBackendAudioSessions` (~5126): all above line 9285.
  No renderer-side change stands alone in this lane's range. Cross-domain.
- **FL-13** (too-short verdict computed twice) — needs desktop/main.js to put `discard` in the event detail.
  Cross-domain.
- **FL-16 (last bullet)** — `mediaRecorder.start(1000)` vs `fallbackWindowSec` coupled only by a comment: the
  window constant is computed from `UI_TOKENS` (other lane); naming the timeslice alone would add a third
  number. Left as found; the other FL-16 comments are fixed (db7b76b, d975368).
- **FL-19** (`mergeInterim` normalises the whole committed text per interim) — hypothesis (perf); the finding
  itself says to measure with a 2 h recording before changing. Not measured here.
- **FQ-03 (a)** (keepalive dropped above 60 KB) — needs either a compact payload the backend can merge (its PUT
  replaces the file wholesale, so a payload without `text` would erase transcripts) or `sendBeacon` with auth
  the backend accepts. Backend — cross-domain. **(b)** (unload flush chained behind an in-flight PUT) —
  hypothesis on timing; sending in parallel instead risks the older in-flight PUT landing last and overwriting
  the newer state (wholesale replace). Left as found.
- **FQ-04** (one failed job poll fails the item and leaves the backend job running) — `waitForBackendJob`,
  `waitForQueuedLocalJob`, `waitForQueuedRemoteJob` are at ~4774–4930. Cross-domain.
- **FQ-06 (b, c)** (local jobs get no "job created" moment; the size/10 000 timer — known U/K-2) — needs an
  `onJobCreated` hook from the transport (~4669–4930). Cross-domain. (a) — dead `uploadProgress` — fixed.
- **FQ-12** — (a) the renderer bounds are in `applyRuntimeLimits` (~2255); (b) hypothesis (pause uploads while
  recording) is a product decision. Cross-domain / not done.
- **FQ-14 (a, e)** — (a) a boot-error code instead of English prose needs desktop/main.js to send `{code, raw}`;
  (e) inline `style.*` on the disclosure needs classes in `styles.css` (other lane). Cross-domain.
- **FQ-17** (transcripts persisted in the queue file and the archive) — design change spanning the backend
  normaliser and the K-5/U-020 reveal reconcile (known product decision in BUGSAUDIT-2026-09-04 §6). Not done.
- **FQ-19 (scoped static copy)** — `applyStaticUiCopy(document)` takes a `Document`; scoping it to the empty-state
  node needs a `ui-copy.ts` signature change (other lane). Cross-domain. The rest of FQ-19 is fixed.
- **FQ-22 (5)** (`setBackendBootStatus("")` on the failure path) — desktop/main.js. Cross-domain.
- **S-15** (History audio fetched whole as a Blob) — `fetchSavedAudioFromBackend` at ~2583. Cross-domain.
- **S-16** (Russian marks, absolute paths that retention deletes) — hypothesis ("may be intended for a
  Russian-first product"); changing the mark language changes every pasted transcript, and the "screens
  removed" note is a backend retention change. Not done.
- **U-009** (queue rebuilt via `innerHTML` under aria-live) — known debt (BUGSAUDIT-2026-09-04 §6); FQ-07 removes
  its per-tick trigger, the reconciling render is not done here.

## Cross-domain, for the lead

Import lines: every new module is imported at the top of `main.tsx` (lines ~14–60) — the only edits above
line 9285 in this lane: `./stop-epilogue`, `./upload-item`, `./upload-queue-persist`, `./boot-error`, and
`liveCloseOwesErrorEnvelope` added to the existing `./live-envelope` import. Mechanical on merge.

1. **FQ-04 (P1)** — `main.tsx` `waitForBackendJob` (~4774): treat a rejected poll `fetch`, 5xx and 429 as
   transient (bounded retries on the same 0.9 s / 3 s cadence), 404/other 4xx as terminal; in
   `waitForQueuedLocalJob` / `waitForQueuedRemoteJob` (~4840–4925) call `cancelBackendJob(created.job_id)` in
   the `finally` when the wait ended without a terminal job status and not by abort (abort already cancels).
2. **FL-12 / S-01 (P1 dup of H-01/BM-04)** — renderer: `buildLiveDraftPayload` (~5811) must put
   `recording_collection: liveRecordingCollection(liveRecordingMode)`; `recoverLiveDraftIfAny` (~6003) and
   `recoverBackendAudioSessions` (~5126) must send the draft's collection / nothing instead of the
   `RECORDING_COLLECTIONS.live` literal. Backend: `promote_live_recovery` default `""` so the recovery meta wins;
   WS open stores `screen_session_id` in the meta; `_promote_live_recovery` calls `screen_sessions.adopt_session`.
3. **FL-08** — extract `decodeSavedRecording({name, archiveDir, language, diarize, signal, models})` and call it
   from the Re-transcribe handler (~8988–9200) and stopLive's `recoverFromEmptyTranscriptInner`; Re-transcribe
   should snapshot `diarize` and get the timeout/abort the stop path has.
4. **FL-07** — move `LIVE_ENVELOPE_CONFIRM_MS` / `_DELIVERY_MARGIN_MS` / `_MAX_WAIT_MS` and the inline "short
   recording ≤ 30 s" into `UI_TOKENS.finalize` (`ui-copy.ts`); decide the local-assist envelope budget explicitly
   before routing it through `waitForLiveEnvelopeWithAnnouncedBudget`.
5. **FL-10** — desktop `screen-mode-controller.js`: accept `discard` for an already-finished id (remove the
   staging dir of the last manifest when ids match); then stopLive's startup-abort and all-saves-failed exits
   can discard the kept session.
6. **FL-13** — desktop/main.js: put `discard` (its own `__transcriptorRecordingTooShort()` verdict) in the
   `transcriptor-hotkey-toggle` / `-stop` event detail; the renderer handlers (~13705–13725, this lane) then read
   `detail.discard` instead of re-evaluating `recordingIsTooShortToKeep()`.
7. **FL-20** — backend: `backend/tests/test_live_coverage_policy.py` now duplicates
   `frontend/tests/live-coverage.test.ts` (same ten cases); dropping the Python copy is the backend's call
   (same shape as the `test_mic_health.py` item that BUGSAUDIT-2026-09-04 §6 left to the user).
8. **FQ-03 (a)** — backend: accept a merge PUT (statuses without `text`) or a beacon-authenticated write, so the
   unload flush fits the 64 KiB keepalive budget.
9. **FQ-06 (b, c)** — transport (~4669–4930): give `localJob*`/`remoteJob*` an `onJobCreated` callback (the
   creation POST resolves only after the body is sent); the processor then sets `stage = "processing"` there and
   `_stageCrossoverDelay` / `_stageTimer` (U/K-2) can be deleted.
10. **FQ-12** — `applyRuntimeLimits` (~2255): accept any positive integer the backend reports for
    `uploadParallel` / `persistedItems` (log when clamping).
11. **FQ-14 (a, e)** — desktop/main.js: send boot errors as `{code, raw}` (`PYTHON_MISSING`, `PORT_IN_USE`, …);
    `frontend/src/boot-error.ts` then classifies on the code. `styles.css`: classes for the boot-error
    disclosure to replace the inline `style.*` in `__setBackendBootError`.
12. **FQ-19** — `ui-copy.ts`: let `applyStaticUiCopy` take a `ParentNode` so the empty-queue branch re-applies only
    its own copy.
13. **FQ-22 (5)** — desktop/main.js:7931: do not call `setBackendBootStatus("")` (documented as "boot finished
    successfully") on the Python-missing failure path.
14. **S-15** — `fetchSavedAudioFromBackend` (~2583): stream History playback via `<audio src>` on a short-lived
    URL; keep the File fetch for re-transcribe.
15. **Dead CSS** — `styles.css:3911` `.upload-queue-item-progress-bar.is-determinate` has no producer since FQ-06 (a).
