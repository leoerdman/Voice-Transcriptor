# Review of fix phase fb2cef4..main (desktop/main.js lane, renderer live/upload lane, lead commit 2d7872c)

Read-only. Read: every new desktop module + test, the full main.js diff, the full main.tsx diff, all new frontend modules/tests, both journals.
Nothing was executed.

## Verdicts
- Desktop/main.js lane: has crutches (no forbidden "fixes" found, but one undisclosed behaviour loss, one test that tests a copy, and a systemic reliance on source-text tests).
- Renderer live/upload lane: has one real regression (History title) and the same source-grep reliance; no silenced errors.
- Lead commit 2d7872c: clean (kind-based paste gate, deleted globals have no readers in main.js or main.tsx; checked renderer-main-contract + grep).

## Problems, by severity

### 1. REGRESSION (P1) - d975368 - frontend/src/main.tsx `saveSessionMetadata` (~12557-12571) / success path (~13383-13384)
The old success-path final save wrote `title = plainTranscriptRaw ? _smartTitle(plainTranscriptRaw) : provisionalTitle`.
The unified `saveSessionMetadata` hard-codes `title: latestSourceTitle()` = `_smartTitle(latestSourceForSave())`, i.e. derived from the LIVE
source text. `title` is still computed at 13383, but only reaches `patchCurrentRecordingSummary`, never the History entry.
Effect: any recording whose live text is empty or differs from the final transcript (local provider, Deepgram REST recovery, upscale/Re-decode)
is archived with the live-text title (default "Recording <date>") instead of the transcript-derived one. The old catch-path save used latestSourceTitle (so
unifying them was right for that path, wrong for the success path).
Not caught: stop-epilogue.test.ts tests the pure module; the contract test only counts `saveRecordingText({` occurrences (2) and `isArchiveMutationConflict` (1).
Proper fix: `saveSessionMetadata(transcriptText, providerName, title)` (title argument, callers pass `title` / `provisionalTitle`/latestSourceTitle explicitly), plus a behavioural test of the title that
reaches saveRecordingText on the transcript path.

### 2. Undisclosed behaviour loss (P2) - a0be23d - desktop/main.js `processPostStopTask`
The deleted poll was the only caller of `setRecordingStatus("Upscaling", RECORDING_STATUS_KIND.UPSCALING)` (base main.js:6268). Now nothing sets it:
`consumeIpcSignal` classifies "status:upscaling" as PROVISIONAL but never moves the capsule. The capsule's whole "upscaling" wave mode/CSS (main.js ~1648-1652,
1768-1820, 1864) is unreachable, while the journal (Р-DM-4) says the only observable change is for a protocol-breaking renderer.
Proper fix: in `consumeIpcSignal`, on PROVISIONAL with phase "upscaling" call setRecordingStatus("Upscaling", UPSCALING) (the renderer's explicit phase is exactly the signal
the commit text says replaces the poll), with a test; or delete the dead capsule mode and say so in the journal.

### 3. Test that tests a copy of the logic (P2) - 397b696 - desktop/engine-install-flight.test.js second test
"the shape: a concurrent invoke during the probe is refused" defines its own `install()/body()/state` and asserts on that. It never touches installGigaamEngine, so it proves nothing
about the shipped code. The first test is a source-order grep (`inFlight = ` index < first `await` index in the comment-stripped function).
Proper fix: move the single-flight claim into a small pure helper (e.g. `createSingleFlight()`), have installGigaamEngine call it, test the helper under concurrency; delete the self-supplied copy.

### 4. Source-text tests where behaviour could be tested (P2, systemic) - desktop + frontend
Disclosed (Р-DM-2) but still the dominant proof. Behaviour-tested: transcript-signal, clipboard-lease, recording-stop, backend-exit, renderer-toggle (vm run), shortcut-runtime, data-dir,
capsule-geometry, stop-epilogue, upload-item, boot-error. Pure-grep only for the wiring: startup-boot, quit-path, timing-budgets, log-privacy, main-dead-code, own-process-rules, ipc-sender,
capsule-ipc, capsule-permissions, recording-monitor, post-stop-handoff, and ~25 new renderer-main-contract tests. Specific weak ones:
- desktop/quit-path.test.js:20-25 `assert.ok(calls.length >= 1)` is vacuous; the "only inside quitApp" check relies on a `^\s*(//|\*)` line filter.
- desktop/timing-budgets.test.js:2nd test and main-dead-code.test.js are negative-only regexes (`doesNotMatch`) - they pass if the code is deleted or reworded.
- desktop/ipc-sender.test.js slices 260 chars after the channel name and regex-matches `isFromMainWindow(event)`: passes if the call is in a comment or a different branch.
- renderer-main-contract "FL-02 exactly two saveRecordingText({" / "isArchiveMutationConflict count 1" pin counts of tokens, not behaviour; this is exactly why #1 slipped through.
Proper fix for the key ones: extract wiring into functions taking injected deps (quitApp, installIpcSenderGuard(ipcMain, isFromMainWindow), single-flight, stopLive's save call) and test those; keep grep tests only for "channel X is not present".

### 5. New duplication (P2)
- FL-20 (db7b76b): the ten-case coverage matrix now exists in frontend/tests/live-coverage.test.ts AND backend/tests/test_live_coverage_policy.py (still present). Disclosed in the journal ("backend's call"), but it is two sources of the same expectation. Delete one (the Python one drives tsc+node; the lane's own argument says it is obsolete).
- desktop/main.js:1551 `#pill.screen { width: ${t.width + t.pillGap + t.screenIconSize}px }` retypes the formula of `t.maxWidth` (line 1419). The window size now comes from `maxWidth` (capsuleWindowSize), the pill from the retyped sum - two places for one fact. Use `${t.maxWidth}px`.
- desktop/main.js:1388-1390 `minWidth/minHeight/maxHeight` of RECORDING_STATUS_CAPSULE are now unread (clamp code deleted) - dead constants left behind by d2decfe.

### 6. Comments that claim more / stale (P3)
- main.js:1472 and capsule-geometry.js:10 say "126 px screen-mode pill"; value is 110+8+16 = 134 (the lane's own test uses 134).
- frontend main.tsx publishRecordingOutput "Channel 1b" comment still says "judging it [the text] is the main process's job" - main no longer reads the text (transcript-signal.js header says the opposite).
- main.js `win.on("closed")` comment narrates deleted history ("deleted rather than 'fixed'"); keep the fact, drop the narration.
- Journal/commit 3cb32fc: only a comment changed (no behaviour). Fine and honest.

### 7. Smaller behaviour notes (P3, not forbidden, undisclosed)
- renderer-toggle.js: a press that reaches the renderer between notAfter (1750 ms) and main's 2000 ms cutoff returns `{ok:false, expired:true}`; toggleRecordingFromShortcut treats it as "renderer-not-ready" and shows the "App Loading" warning (main.js ~2813-2820). Handle `expired` explicitly (log + silent reset).
- DM-02: the transcript now reaches the clipboard only inside runPasteLadder, i.e. after resolvePasteDestination/activateCapturedPasteTarget (up to seconds) instead of right at transcript_ready. A hang in that window leaves nothing on the clipboard (last_transcript.json still holds it). Acceptable, but say so.
- handlePostStopTranscriptTimeout (main.js:6382) still writes the clipboard directly, outside the lease, contradicting the "callers must not write" rule in clipboard-lease.js (intended: no paste happens). Route through a ladder-owned "leave on clipboard" helper or document the exception in clipboard-lease.js.
- Frontend: dead CSS `.upload-queue-item-progress-bar.is-determinate`, `_stageCrossoverDelay/_stageTimer` left (disclosed in journal "not done").

## Checked and clean (one line each)
- No test deleted/weakened: no pre-existing desktop test touched; changed frontend tests were replaced for deleted features (finished-records depth) or strengthened (epilogue count 6 + zero inline calls); live-pane runtime-throw test replaced by compile-time `@ts-expect-error` under a tsconfig that includes tests/ (OK).
- No new silent catch: new catches log (capsule IPC, finish of orphaned screen session, attemptFinalSave warns and returns an outcome); `{ }` empty catches are pre-existing style.
- Backend exit (c1b0a18): any non-quitting exit restarts; planned kill (killBackendHard) releases handle then restarts; superseded child restarts nothing; attempts cap kept. Logic correct.
- Clipboard lease (ea361c5): snapshot before write, settle() in finally, handOff to delayed restore; all success/failure returns release exactly once. Correct.
- Post-stop hand-off (a0be23d, b3b4f7f): epoch+id keys, per-epoch slot captured in the task, refuse id<=0 with status reset. Correct apart from #2.
- DM-29 (7e7a54c): startup event -> show -> createWindow starts backend (`if (!backend)`) inside the try with error page. Correct.
- Capsule preload: three send-only verbs, sender check vs live capsule webContents, packaged in build.files, sandbox+contextIsolation kept.
- No generated file edited by hand; no new polling (probeInFlight guard reduces it); new magic numbers are named (BACKEND_*, GUARDED_STOP_DEADLINE_MS, ENGINE_PIP_INSTALL_TIMEOUT_MS, QUEUE_SAVE_RETRY, WS_PENDING_MAX_SEC, UPDATE_CHECK_BOOT_DELAY_MS).
- New window global: only `window.__capsule` via contextBridge (a real channel, replaces document.title). `window.__transcriptorShortcutStatus` pre-existed (journal S-10).

## Journal spot-checks (5)
1. DM-02/DM-26 (ea361c5): lease accounting tests are behavioural; the main.js wiring test is a grep, but it does fail pre-fix as claimed. Valid, wiring is text-only.
2. DM-01 (6974957): transcript-signal tests run the shipped module; main.js uses it (grep for classifyRecordingSignal). Valid; also exercised through consumeIpcSignal only by grep.
3. FL-02/D-13 (d975368): "before" failures are 3 source-grep tests + 1 unit test run against a mutated module. They prove the code shape, not stopLive behaviour; they did not catch the title regression (#1). Claim "no behaviour change" in the journal decision log is not complete: the title argument changed.
4. DM-10 capsule (37bb6e5): 2 of 3 tests are greps of main.js/HTML; preload test greps its own source. Proof of wiring is textual; nothing runs the capsule. Journal admits no live Electron run.
5. DM-06 (397b696): before/after is a grep + a self-contained copy (see #3). Weakest entry.
Journal-wide: "Nothing here was exercised in a live Electron" - the lane says so itself; capsule stop/shot, cold start, paste restore remain unverified on a real build.
