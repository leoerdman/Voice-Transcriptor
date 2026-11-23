# Audit: frontend/src/main.tsx 13732-15754 (bootstrap, update check, boot overlay, Upload tab + queue)

Read-only. All line numbers refer to the working tree at audit time (git status clean, HEAD acbf737).
Also read: upload-queue-restore.ts, gated-poll.ts, update-check.ts, backend/main.py (upload-queue routes 1682-1690, 2506-2598; jobs routes 6131-6215, 7013-7040), backend/jobs.py (JobStore), main.tsx 3915-3950 (apiPut), 4669-4900 (job transport), 2110-2270 (runtime config), 5348-5470 (provider resolve, network, boot overlay hide), 8411-8480 + 8735-8850 (loadRecordings, saveRecordingText), desktop/main.js boot-status/boot-error senders.

## Coverage

| Sub-area (main.tsx) | Status | Method |
|---|---|---|
| 13732-13750 initRecordingsBootstrap | read line by line | + loadRecordings, ensureRecordingsArchiveReady |
| 13755-13849 version badge, update check (UI + passive timer) | read line by line | + update-check.ts, vite define, CSP in index.html |
| 13851-13962 boot wiring, network poll, bootstrap race, platform marker | read line by line | + gated-poll.ts |
| 13964-14114 boot overlay (status, classify, error, retry) | read line by line | + desktop/main.js senders |
| 14116-14260 upload types/state | read line by line | + runtime limits 2245-2270 |
| 14256-14445 validation, path, reveal bridge | read line by line | |
| 14447-14520 reveal reconcile | read line by line | known K-5/U-020, not re-reported |
| 14522-14791 snapshot (persist/restore/legacy) | read line by line | + upload-queue-restore.ts, backend normalizer |
| 14793-14947 DnD, setupUploadView | read line by line | + index.html upload markup |
| 14949-15243 hint, enqueue, pump, processUploadItem | read line by line | + job transport 4669-4900, backend job routes, jobs.py |
| 15245-15437 status label, remove, cancel, retry, persistence note | read line by line | |
| 15439-15754 renderUploadQueue, result pane, init | read line by line | |

Classes walked per sub-area: contracts, races/cancel/timeouts, errors swallowed, resources (timers/polls/listeners/object URLs - no object URLs exist in the region), SSOT, perf, dead code, UX/a11y.

## Known, not fixed (not re-counted)
- U-009 (frontend-findings.md; BUGSAUDIT §6 Renderer): renderUploadQueue still rebuilds the list via innerHTML under aria-live (15493). See FQ-07 for the exact per-tick trigger.
- U/K-2: `_stageCrossoverDelay` timer still at 15071-15079. See FQ-06 for the new aspects.
- U/K-5 + U-020: reveal reconcile at 14447-14520 still unbounded sequential apiGet.
Closed and verified present as fixed: U-001 (restore latch), U-003, U-004, U-006, U-007, U-008, U-011, U-012, U-017, U-018, U-019 (partly, see FQ-03), H-11.

## Findings

### FQ-01 · main.tsx:15194-15205 `processUploadItem` save-failure branch + 15640 / 15736 / 15556 render paths · a finished transcript whose History save failed is kept in `item.text` but is not shown, copyable or retrievable
- Reproduce: make `/api/recordings/save-from-path` (or save-with-audio) fail (archive dir unwritable, disk full, 4xx). The upload job itself succeeds.
- What happens: item.status = "error", `item.text = text`, error "Transcript finished, but History save failed: ...". `renderUploadQueue` shows only `item.error` for status error (15640-15645, no Copy button); `renderUploadResultPane` error branch shows `item.error` only and hides Copy (15736-15740). The only actions are Retry (which wipes text, see FQ-05), Remove and "Clear done" (terminal set includes error, 14897). The text is persisted to upload_queue.json but nothing in the UI reads it.
- Consequence: paid/long transcription is unreachable exactly when storage is failing; the message promises "Transcript finished" and gives no way to get it. P1, confirmed (path: save rejects -> catch at 15194 -> status error -> no render path for text).
- Current code:
```ts
item.text = text;
item.status = "error";
...
item.error = `Transcript finished, but History save failed: ${...}`;
```
```ts
} else if (item.status === "error" && item.error) {   // queue row
  const err = document.createElement("div"); err.textContent = item.error; ...
```
- Fixed code: in the error row and in `renderUploadResultPane` show `item.text` when non-empty (body + Copy button) beside the error line; make Retry for such an item re-run only the save (`saveRecordingText` with the kept text), and make Clear done/remove skip or confirm for error items that carry text.
- Why a bug: the code deliberately keeps the text (`item.text = text` in the failure branch) and the message states it exists; the missing reader is an omission, not a decision.

### FQ-02 · main.tsx:14633-14660 `flushUploadQueueSnapshotNow` · a failed queue PUT is logged and forgotten; the dirty flag is cleared before the attempt
- Reproduce: PUT /api/ui/upload-queue answers 429/500/times out (backend busy restarting, rate limiter) right after the last job completes; then quit.
- Mechanism: `uploadQueueSavePending = false` (14640) before the PUT; on failure only `uploadQueueLastSaveOk = false` and `console.warn` (14651-14654). Nothing re-arms the debounce, nothing tells the user. Next launch restores the older queue; the just-finished items show "Interrupted by app restart" or are missing.
- Consequence: silent loss of the most recent queue state (transcripts of the newest uploads still exist in History, but the queue/reveal link is lost). P1 (error swallowed), confirmed by code path; trigger frequency low.
- Current code:
```ts
const payload = uploadQueueSnapshotPayload();
uploadQueueSavePending = false;
...
.catch((e) => { uploadQueueLastSaveOk = false; console.warn("Upload queue backend snapshot save failed", e); });
```
- Fixed code: on failure set `uploadQueueSavePending = true` and schedule one bounded retry (backoff, N attempts) through `saveUploadQueueSnapshot`, and surface a one-line notice (`setStatus(..., "warning")`) after the retries are exhausted.
- Why a bug: the file's own header (upload-queue-restore.ts) states the invariant "never lose state the backend does not hold"; the write side drops its dirty marker on failure, contradicting it.

### FQ-03 · main.tsx:14633-14660 + 14774-14779 + apiPut 3932-3948 · the U-019 "unload flush" fix is ineffective for realistic queues and for any save already in flight
- Reproduce: queue with >60 KB of JSON (a handful of done items with transcripts; backend allows 200 items x 200 000 chars, backend/main.py:2519, 449) -> close the window with a debounced change pending.
- Mechanism: (a) `apiPut` drops `keepalive` above KEEPALIVE_MAX_BODY_BYTES = 60 000 (3930-3939), so an ordinary fetch is issued during unload - exactly the cancelled-request case U-019 was meant to fix; (b) when a PUT is already in flight the unloading flush is chained behind it (`uploadQueueSaveInFlight.catch().then(...)` 14641-14643): the continuation never runs once the document is gone; (c) both `pagehide` and `beforeunload` (14778-14779) fire the same flush, so a small queue sends two identical keepalive PUTs that share the 64 KiB budget.
- Consequence: the last <=180 ms of changes (terminal statuses set as the user closes) is lost for any non-trivial queue. P2, confirmed for (a) by arithmetic, hypothesis for (b) timing.
- Current code: `window.addEventListener("pagehide", flush...); window.addEventListener("beforeunload", flush...);`
- Fixed code: keep one listener (`pagehide`); on unload skip the chain and send immediately; send a compact delta payload (statuses only, no `text`) when the full body would exceed the keepalive cap, or use `navigator.sendBeacon`; drop the second listener.
- Why a bug: the flag was added to make the unload write survive, and its own guard disables it for the payloads that matter; two listeners for one event is the "rule restated twice".

### FQ-04 · main.tsx:4768-4776 `waitForBackendJob` (consumed by 15128-15157) · one failed poll fails the item and leaves the backend job running, un-cancelled
- Reproduce: during a long upload job (local Whisper on a video, many minutes) a single poll `fetch` rejects (backend GC pause, rate-limit 429, renderer-side network hiccup) or returns non-2xx.
- Mechanism: `if (!r.ok) throw ...` and a raw `fetch` rejection propagate out of the loop; `waitForQueuedLocalJob/RemoteJob` only removes the abort listener in `finally` (4905-4900 region), it never calls `cancelBackendJob`. `processUploadItem` marks the item "error". The job continues on one of only 2 pool workers (JOB_MAX_WORKERS = 2, backend/main.py:449) and its result is discarded; a Retry starts a second job beside it.
- Consequence: wasted provider spend/CPU, pool starvation by zombie jobs, an item reported as failed that actually completed. P1, confirmed (path: poll fetch rejects -> throw -> catch at 15221 -> status error; no cancel anywhere).
- Current code:
```ts
const r = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {...});
if (!r.ok) throw new Error(await parseError(r));
```
- Fixed code: treat network errors and 5xx/429 as transient (bounded retries with the same backoff cadence), 404/other 4xx as terminal; on any terminal renderer-side failure (not "job error" from the server) call `cancelBackendJob(jobId)` in `finally` when the job is not terminal.
- Why a bug: the backend contract (jobs.py `get`) makes polling the lifecycle ("clients must fetch the job they care about"); a poller that dies on the first blip abandons a job it owns. The cancel path exists and is used on abort, so omitting it on failure is inconsistent.

### FQ-05 · main.tsx:15363-15408 `retryUploadItem` · Retry of an item whose only failure was the History save re-runs the whole transcription
- Reproduce: item in the FQ-01 state -> click Retry.
- Mechanism: `item.text = ""`, status queued, `requested*` re-read from the current UI (15382-15400); `processUploadItem` calls `localJobQueued...`/`remoteJobQueued...` again.
- Consequence: a second paid transcription (and a different provider/model/language if the UI changed meanwhile) for work already done. P2, confirmed.
- Fixed code: store a `savePending` marker (text present, `savedName` empty) and route Retry to `saveRecordingText` only.
- Why a bug: the transcript is held for exactly this reason (it is persisted in the snapshot); discarding it on retry wastes it.

### FQ-06 · main.tsx:14193-14199, 15071-15079, 15261-15264, 15597-15602 · crutches around upload progress: guessed stage timer, never-set `uploadProgress`, local jobs get no progress hook
- Known: U/K-2 (timer). New: (a) `item.uploadProgress` is never assigned a number anywhere (only `= undefined` at 15151, 15385): the `Uploading · N%` label (15261-15264), the `is-determinate` bar (15597-15602) and the type field with its comment (14194-14199) are dead code after the earlier "stop inventing progress" fix. (b) The stage "uploading -> processing" has a real event: the job-creation POST resolves only after the body is fully sent (`remoteJob`/`localJob` 4669-4707). The remote path uses it indirectly (first poll calls `onProcessingProgress`, 15148), but local jobs pass no `onProgress` at all (`waitForQueuedLocalJob` 4895: `waitForBackendJob(created.job_id, { signal })`), so the local stage flip is ONLY the size/10000 ms guess; for a multi-GB local upload the label says "Processing…" 8 s into a minutes-long upload, and for a fast one it stays "Uploading…" until the timer. (c) The timer also fires for the remote path where the real event exists, so two sources set the same field.
- Consequence: wrong status labels on the local path; ~25 lines of dead UI branches. P2, confirmed.
- Fixed code: return the "job created" moment from the transport (`onJobCreated` callback or split `localJob` / `waitFor...`) and set `stage = "processing"` there for both providers; delete `_stageTimer`, `uploadProgress`, the percentage label and the determinate-bar branch.
- Why a bug: the comment at 15062-15070 admits the delay is a heuristic "replaced by the real transition when the response arrives" - for local jobs that replacement is never wired.

### FQ-07 · main.tsx:15148-15153 `onProcessingProgress` closure -> renderUploadQueue · every poll tick (0.9 s, then 3 s) rebuilds the whole queue DOM and re-writes unchanged state (extends known U-009)
- Reproduce: remote upload, keyboard-focus the Stop button or hover a Copy on another row: focus/hover are lost roughly every second; screen reader re-reads the aria-live list.
- Mechanism: `waitForQueuedRemoteJob` calls `opts.onProcessingProgress` on each `onProgress` (4832) and the callback assigns the same `stage` and calls `renderUploadQueue()` unconditionally. The progress value is discarded (`item.uploadProgress = undefined`).
- Consequence: perf (O(items) DOM rebuild per tick per active item) and the a11y/focus damage U-009 describes; this is the concrete trigger site. P2 (rolls into U-009), confirmed.
- Fixed code: `if (item.stage !== "processing") { item.stage = "processing"; renderUploadQueue(); }`, and fix U-009 by reconciling rows.
- Why a bug: nothing in the render depends on the progress ticks; re-render only on state change.

### FQ-08 · main.tsx:14781-14791 `addUploadQueueItem`/`enqueueUploadFiles` + 15015 `runUploadProcessor` · a batch is processed in reverse of the order it was dropped
- Reproduce: drop files A, B, C. `uploadQueue.unshift` each in order -> list C, B, A; the pump takes `uploadQueue.find(status === "queued")` (first match) -> C runs first.
- Consequence: with parallel 1 (default until health hydrates, 1311) the last file selected is transcribed first; on a failure of the batch, the user's mental order is inverted. P2, confirmed.
- Fixed code: enqueue the batch in reverse (`files.slice().reverse().forEach(...)`) or pick the oldest queued item (`findLast`) while keeping newest-on-top display.
- Why a bug: the header comment promises "insert at the top + bounded parallel processor" - the UI order is a display choice, processing order is not documented anywhere as reversed.

### FQ-09 · main.tsx:14702-14764 `restoreUploadQueueSnapshot` / `afterUploadQueueSnapshotLoaded` / `applyUploadQueueSnapshot` · after a failed restore the queue runs unpersisted, and a later successful restore wipes live items
- Reproduce (hypothesis, needs a failed first GET then recovery): GET /api/ui/upload-queue fails at boot (latch stays down - correct per U-001); user drops file X: `afterUploadQueueSnapshotLoaded` (14766-14772) awaits the restore promise, which RESOLVES after a failure, then runs the action -> X is enqueued and processed with `uploadQueueSnapshotLoaded === false`, so every `saveUploadQueueSnapshot` is a no-op (14663). User drops file Y: `beginUploadQueueSnapshotRestore` retries, GET succeeds, `applyUploadQueueSnapshot` does `uploadQueue.splice(0)` (14583) - X's row vanishes while its processor is still running (the processor keeps mutating a detached object, `uploadActiveProcessors` still counts it).
- Consequence: lost rows/results in the UI, one unpersisted session of work. P2, hypothesis.
- Fixed code: have the restore promise reject (or return a boolean) so `afterUploadQueueSnapshotLoaded` refuses to enqueue while the server queue is unknown, with a visible notice; and make `applyUploadQueueSnapshot` merge instead of splice when live items exist.
- Why a bug: the restore module's stated invariant is that unknown server state blocks writes; enqueue continuing is the second half of the same situation left unguarded.

### FQ-10 · main.tsx:14334-14339 `normalizeUploadProvider` vs 2985-2991 `normalizeProviderSelection` · two normalizers of the same provider enum
- `normalizeUploadProvider` re-lists `"local" | "openrouter" | "deepgram"` and falls back to `UI_TOKENS.upload.defaultProvider`; `normalizeProviderSelection(value, fallback)` does the same with an extra `""` member; applyUploadQueueSnapshot uses both for two fields of the same item (14609 vs 14613). Adding a provider needs edits in both (the `Provider` type was just made single-sourced in the catalogue, 127).
- P2 (SSOT), confirmed. Fixed code: `normalizeProviderSelection(value, UI_TOKENS.upload.defaultProvider) || UI_TOKENS.upload.defaultProvider`, delete `normalizeUploadProvider`. Not intent: the header comment of Provider (105-127) says exactly this duplication was removed elsewhere.

### FQ-11 · main.tsx:14263-14276 `uploadFileValidationError` vs 14308-14323 `uploadSourcePathValidationError` (+ call sites 15372-15374, 15558-15560) · the "size cap + extension + allowlist" rule is written twice with drifted messages and evaluated up to three times per item
- Same three checks, different text ("Drop an audio or video file" vs "Choose an audio or video file with ..."); `UPLOAD_ALLOWED_EXTS.size > 0 &&` silently accepts any extension while the backend list is not hydrated (14272/14319; cache exists for the size cap but not for the extension set). Retry and `renderUploadQueue` recompute the validator for every error row on every render (15558).
- P2 (SSOT/perf), confirmed. Fixed code: one `uploadSourceValidationError({ name, sizeBytes })` used by both entry points; compute once and store `item.retryBlockReason` instead of per-render; cache accepted extensions like `UPLOAD_CAP_CACHE_KEY`.
- Why a bug: two sources of one rule already diverged in wording; the empty-set pass-through is a silent fallback hiding "backend not hydrated".

### FQ-12 · main.tsx:2255-2265 `applyRuntimeLimits` + backend/main.py:1667 + 14137-14139 comment · renderer re-validates backend limits with its own magic bounds; and upload parallelism equals the entire job pool, contradicting the stated intent
- (a) `uploadParallel <= 8` and `persistedItems <= 1000` are renderer copies of limits the backend owns; a backend raising `JOB_MAX_WORKERS` above 8 or the persisted cap above 1000 is silently ignored (value stays 1 / MAX_SAFE_INTEGER) with no log. Also `uploadQueueMaxPersistedItems` defaults to MAX_SAFE_INTEGER until health lands, so `renderUploadPersistenceNote` (15419-15437) and the `slice` in the snapshot behave as unlimited before hydration. (b) The comment at 14137-14139 says uploads "must not saturate every backend worker while the user is recording", but the backend reports `upload_queue_max_parallel = jobs.max_workers` (= 2 = every worker) and the renderer never consults `isRecording`. (Live finalisation goes through the sync endpoints, so the pool starvation is for other job users; local-engine CPU contention while recording remains.)
- P2, (a) confirmed, (b) hypothesis. Fixed code: accept any positive integer the backend reports (log when clamping), and either cap parallel at `max_workers - 1` on the backend or pause the pump while `isRecording` with a visible "Waiting for recording to finish" status.

### FQ-13 · main.tsx:13793-13829 `runUpdateCheck` + 13838-13849 passive timer · a failed check is stamped as "checked", so an offline launch silences the check for 24 h
- Reproduce: launch offline -> 4 s later `runUpdateCheck` -> `checkForUpdate` returns `{status:"unknown"}` -> `localStorage.setItem(UPDATE_CHECK_CACHE_KEY, Date.now())` runs unconditionally (13798-13802) -> next launch within 24 h `shouldAutoCheck` is false.
- The comment at 13836 says "silent on failure so an offline start never nags" - the status text "Couldn't check for updates" is in fact rendered in Settings and the stamp is written either way.
- Consequence: update notice delayed up to a day after any failed attempt. P2, confirmed. Fixed code: write the stamp only for `up-to-date` / `update-available`. Also the inline `4000` delay (13848) is a magic number outside UI_TOKENS, the same pattern K-10 flagged in update-check.ts.

### FQ-14 · main.tsx:13998-14048 `classifyBootError` · string-matching on English prose from another process, with a hard-coded Python version that contradicts the SSOT and a prefix-match bug
- (a) "python 3 interpreter was not found" is the literal sentence desktop/main.js:7930 builds; renderer and main share a protocol through prose (a reword in main.js silently downgrades the diagnosis to the generic one). (b) the detail says "Install Python 3.10+" (14040) while `.python-version` is 3.12.13 and desktop/main.js:7145 states the bundled runtime is 3.12; no 3.10 minimum exists anywhere. (c) `low.includes("winerror 5")` also matches "winerror 53", "winerror 50"...; WinError 10013, named in the function's own docblock, is not matched at all. (d) `raw !== detail` (14070) compares the raw stderr to the friendly copy - always true; harmless dead condition. (e) inline `style.*` assignments on the details/pre (14072-14082) instead of CSS classes.
- P2, (a)(b)(c) confirmed by reading, hypothesis for user impact. Fixed code: have main.js send `{code, raw}` (e.g. `PYTHON_MISSING`, `PORT_IN_USE`), classify on the code; drop the version number from copy or read it from the build define; match `/winerror 5\b/`.

### FQ-15 · main.tsx:13732-13750 `initRecordingsBootstrap` + 13929-13946 · failures of the History/recovery bootstrap are console-only, and the final `.finally` nulls a promise it does not own
- (a) `loadRecordings`, `recoverBackendAudioSessions`, `recoverLiveDraftIfAny` failures and the 15 s timeout are each `console.warn` only (13736-13747, 13938). Nothing tells the user their History list failed to load or that interrupted recordings were not recovered; loadRecordings throws before `renderRecordingsList` (8411+), so the pane just stays empty. (b) `recordingsBootstrapPromise = null` in the `.finally` (13945) is unconditional; the settings archive-folder save (6964-6969) assigns a new tracked promise and guards its own clear with an identity check. If the user changes the archive folder while the boot race is still pending, the boot `.finally` (fired later, on timeout) drops the settings promise, and `ensureRecordingsArchiveReady` (8112) stops waiting for it and starts a duplicate `loadRecordings`.
- P2, (a) confirmed, (b) hypothesis. Fixed code: show `showRecordSessionNotice`/`setStatus` warnings on each failure; in `.finally` clear only `if (recordingsBootstrapPromise === thisPromise)`.

### FQ-16 · main.tsx:15501-15505 queue `li` click handler; 15471-15480 title · queue rows are mouse-only, and the title counts failed items as done
- `li` has a click listener only (no tabindex/role/keydown, no `aria-current`), so a keyboard user cannot select a row to view its transcript in the result pane (only the inner buttons are focusable). P2 a11y, confirmed.
- `finished = uploadQueue.filter(isUploadTerminalStatus)` and "Queue · N/M done" (15480) counts errors and cancellations as done ("3/5 done" with two failures). P2 UX, confirmed. Fixed code: count `done` only, show failed separately ("3 done · 2 failed"); make rows `role="button" tabindex=0` with Enter/Space.

### FQ-17 · main.tsx:14534-14557 `uploadQueueSnapshotItem` + backend/main.py:2553 · full transcripts are persisted twice (queue file and archive) and rewritten wholesale on every mutation
- `text` (up to 200 000 chars x 200 items) is part of every PUT body and of upload_queue.json while `savedName/savedArchiveDir` already point at the archive copy (the source of the K-5 text-matching heuristic when the link is missing). Each 180 ms-debounced save re-serialises and re-sends the entire queue; the backend replaces the file wholesale.
- Consequence: parallel source of truth (queue copy can drift from the History file), O(total transcript size) per mutation, and it is the reason FQ-03 cannot use keepalive. P2, confirmed (design). Fixed code: persist `text` only while `savedName` is empty; render done rows from the archive on demand.

### FQ-18 · main.tsx:15167-15207 and 15300-15322 · Stop pressed while the History save is in flight is acknowledged ("Stopping") and then ignored
- The `cancelRequested` check (15167) sits before `saveRecordingText`; if the user presses Stop after the job finished but during the save await, `abort()` does nothing (no request in flight on the controller) and the item completes as "done" with a History entry, while the button said "Stopping". `finally` then clears the flag. P2, confirmed by ordering.
- Fixed code: re-check `item.cancelRequested` after the save and either undo (not possible) or disable Stop once `stage` is "saving" (add the stage).

### FQ-19 · main.tsx:15449 & 15489 (`renderUploadPersistenceNote` twice per render), 15504 + 15648 (`renderUploadResultPane` called by the row handler and again at the end of `renderUploadQueue`), 15407 + 15648, 15464 (`applyStaticUiCopy(document)` re-applies all static copy to the whole document on every empty-queue render), 15446 vs 14530 (filter predicate inlined next to `isUploadVisibleUnderCurrentFilter`), 14526 (`isUploadPastItem` is a one-line alias of `isUploadTerminalStatus`)
- Redundant work and restated rules; each harmless alone. P2, confirmed. Fixed code: drop the second `renderUploadPersistenceNote`, the explicit `renderUploadResultPane()` calls, scope `applyStaticUiCopy` to the empty-state node, reuse `isUploadVisibleUnderCurrentFilter`, delete the alias.

### FQ-20 · main.tsx:14803-14810 window-level `dragover`/`drop` blocker · swallows every drop outside the zone with no feedback and also text drag-and-drop into textareas
- Listener on `window` calls `preventDefault()` for any target outside `#uploadLargeDrop` on every view: a file dropped on Record/History/Settings does nothing and says nothing; dragging selected text inside a `<textarea>` (keyterms, dictionary fields) has its default drop disabled. No contenteditable exists (index.html), but textareas do. P2, hypothesis (textarea) / confirmed (no feedback).
- Fixed code: only cancel when `e.dataTransfer?.types.includes("Files")`; optionally flash a hint "Switch to Upload to add files".

### FQ-21 · main.tsx:15045, 15171, 15203, 14534-14557, 15680 · two clocks and two fields for one event
- `startedAt`/`endedAt` are `performance.now()` (page-relative) and `completedAt` is `Date.now()` (epoch); all three are persisted. Durations only work by subtracting two page-relative values; the sort fallback `b.completedAt || b.endedAt` mixes epoch with page-relative if a restored item lacks `completedAt`. P2 (SSOT/data), confirmed. Fixed code: store `startedAt/endedAt` as epoch ms (`Date.now()`) and drop `completedAt`, or store `durationMs`.

### FQ-22 · dead / ineffective code in region
- main.tsx:14298-14300: `(file as {path?}).path` fallback - Electron 42.4.1 (desktop/package.json:35) removed `File.path`; the preload bridge is the only source. Dead since Electron 32. P2.
- main.tsx:15401-15402 `retryUploadItem`: `item.abortController?.abort()` on an item whose status is "error" (controller already cleared in `finally`, 15239). Dead. P2.
- main.tsx:14110 / 14055: `_bootOverlayHidden = false` set immediately before `window.location.reload()` (state dies with the page). P2.
- main.tsx:15325 `pickUploadRetryFile` only for items without file/path; cancelled items have no Retry at all (retry guard `item.status !== "error"`, 15365) so a cancelled file must be re-dropped (UX P2).
- Boot-status contract: `__setBackendBootStatus("")` is documented as "boot finished successfully" (13974) but desktop/main.js:7931 calls `setBackendBootStatus("")` on the failure path (Python missing) before replaying the error; the renderer briefly shows "Ready". P2, confirmed by reading (order saves it).

## Clean places (examined, no defect found)
- upload-queue-restore.ts: decision table and legacy-drop rule consistent with restoreUploadQueueSnapshot (14702-14751); version gating (14689-14698) correct.
- gated-poll.ts: chained timeouts, queued `refreshNow`, gate re-check in `finally`; `_networkPoll` registration/teardown (13904-13922) correct; no timer leak.
- 13944 clearTimeout of the bootstrap race timer (K-8 fixed).
- Update check: CSP allows api.github.com (index.html:31); `checkForUpdate` never throws (all in try); button re-enabled; prerelease/rc ordering fixed; `renderUpdateStatus` single writer.
- Boot overlay: error state not overridden by `hideBootOverlayOnce` (5448 `dataset.state === "error"` guard, U-023 closed); raw stderr kept out of live pane; detail built with textContent (no HTML injection).
- Queue cancel path for the in-flight request: `waitForBackendJob` abort listener + `cancelBackendJob` on abort (4813-4836, 4895-4905) correct, timers cleaned in `cleanup` (4787-4803).
- No object URLs, intervals or global listeners leaked in the region; the only permanent listeners are pagehide/beforeunload/drag (intentional).
- Backend contract for upload-queue PUT/GET: renderer payload matches `_normalize_upload_queue_item` field names; unknown status mapping (backend -> "queued") is handled on the renderer as "interrupted".
- `renderUploadQueue` uses textContent for all user data (file names, errors, transcripts): no HTML injection.
- Wire contract for jobs: `job_id`, `audio_source_path` consumed correctly; `status` values done/error/cancelled handled.
