# Fix journal — frontend UI lane (FU-01…FU-26, FG-01…FG-20)

Lane scope: `frontend/src/main.tsx` lines 1 to the function containing line 9285
(the `#deleteAllConfirmBtn` handler, which starts at 9242 on HEAD `bbce978`, is
therefore outside), `index.html`, `styles.css`, `vite.config.ts`, the pure modules
named in the lane brief and their tests. Proofs follow `ultra-audit/SKILL.md`
§7.1: the fix is taken off (the pre-fix decision restored in the file on disk),
the check is run, the file is restored byte-for-byte (`diff -q` silent), the check
is run again. Outputs are quoted verbatim.

## Commits

### e3bf527 · FU-01 (P1)
- Files: `frontend/src/settings-autosave.ts` (`catalogChoiceForSave`), `frontend/src/main.tsx` (`upscalePresetId`), `frontend/tests/settings-autosave.test.ts`.
- Check: `npx vitest run tests/settings-autosave.test.ts`.
- Before (parked fallback replaced by `return "";`), exit 1:
  ```
       × keeps the parked preset while the catalog could not be read 3ms
        Tests  1 failed | 6 passed (7)
  ```
- After, exit 0: `      Tests  7 passed (7)`

### 959e7f5 · FG-01 (P1), FG-18, FG-02 (consequence; the platform part stays a hypothesis), FG-19 (`pendingBytes`), FG-17 (part)
- Files: new `frontend/src/pcm-capture.ts` (`BoundedChunkWindow`, `pcmWavDurationSec`, `capturedHoursLabel`) + `frontend/tests/pcm-capture.test.ts`; `frontend/src/main.tsx` (`OpfsPcmSink`, `MemoryPcmSink`, `PcmSink`, `selectCanonicalCapturedAudio`).
- Check: `npx vitest run tests/pcm-capture.test.ts`.
- Before A (window unbounded = the pre-fix OPFS `pendingChunks`), exit 1:
  ```
       × drops the oldest chunks past the cap and reports it once 3ms
       × bounds the tail a failed disk write puts back, keeping write order 1ms
        Tests  2 failed | 8 passed (10)
  ```
- Before B (duration from the counter, the pre-fix `pcmSampleCount / rate`), exit 1:
  ```
       × is the file's duration when the window dropped samples the counter still counts 4ms
       × is zero for a header-only or empty file 0ms
        Tests  2 failed | 8 passed (10)
  ```
- After, exit 0: `      Tests  10 passed (10)`
- Not under test: the `showRecordSessionNotice` call inside `OpfsPcmSink.flushPending` (DOM-bound class, needs OPFS).

### 55e46b4 · FG-03 (P1), FG-07, FG-05, FG-04 (renderer comment only)
- Files: new `frontend/src/live-draft.ts` (`LiveDraftOperationQueue`, `parsePersistedLiveDraftPayload`, `recoveredDraftProvider`, `liveDraftContentKey`) + `frontend/tests/live-draft.test.ts`; `frontend/src/main.tsx` (queue wiring, `UI_TOKENS.draft.clearRetryDelaysMs`, recovery provider).
- Check: `npx vitest run tests/live-draft.test.ts`.
- Before (pre-fix behaviour put back in the module: one clear attempt with the failure swallowed, put failure swallowed, no content skip, `provider_present` resolution), exit 1:
  ```
       × retries a failed clear instead of dropping it 6ms
       × reports a clear that failed every retry, once, and moves on 1ms
       × keeps put → clear order while a clear is being retried 0ms
       × reports the first put failure of a streak, not every tick 0ms
       × does not resend a draft whose content did not change (only the clock moved) 0ms
       × resolves a pre-provider (legacy) draft to local, and keeps that through a migration 1ms
        Tests  6 failed | 4 passed (10)
  ```
- After, exit 0: `      Tests  10 passed (10)`

### d9dbf0d · FG-13 (a, c, d; b not done — see below)
- Files: new `frontend/src/job-poll.ts` (`waitForJob`, `nextJobPollDelayMs`) + `frontend/tests/job-poll.test.ts`; `frontend/src/main.tsx` (`waitForBackendJob`, `sleepUnlessAborted`, `UI_TOKENS.polling.backendJob`).
- Check: `npx vitest run tests/job-poll.test.ts`.
- Before (pre-fix behaviour in the module: first poll failure throws, no cancel, backend `cancelled` → AbortError), exit 1:
  ```
       × survives a transient poll failure instead of abandoning a running job 3ms
       × gives up after the tolerated run of failures and cancels the job it leaves behind 2ms
       × reports a job the backend cancelled as an error, not as the user's abort 1ms
        Tests  3 failed | 3 passed (6)
  ```
- After, exit 0: `      Tests  6 passed (6)`

### 3d5dc96 · FU-11, FG-17 (my range), FG-20, FG-19 (fallbacks, `requestData`, unused `ok`)
- Files: `frontend/src/main.tsx`.
- Check: `awk 'NR<9300 && /(^ *(9000|6000),$)|(}, 30_000\);)|(finish\(null\), 2500\))|(> 30_000 \? 3_000 : 900)|globalThis.crypto.randomUUID|recorder.requestData\(\)/'` over `git show HEAD~1:frontend/src/main.tsx` vs the working file.
- Before: `count=10` (2425, 2426, 2953, 4511, 4666, 5187, 5196, 5204, 6405, 7165).
- After: `count=0`.
- Not under test: the `<audio>` detach in `probeAudioFileDuration` (DOM).

### 0f657c3 · FU-03, FU-04 (Refresh; delete-all half cross-domain), FU-05, FU-07, FU-20
- Files: new `frontend/src/notice-surface.ts` (`noticeSurfaces`, `historyFailureSurfaces`), new `frontend/src/recovery-summary.ts`, their tests; `frontend/src/main.tsx` (`showRecordSessionNotice`, Refresh handler, preset modals/delete, `recoverBackendAudioSessions`, `openRecording` audio catch).
- Check 1: `npx vitest run tests/notice-surface.test.ts`. Before (banner only / body write), exit 1:
  ```
       × never writes a failure into the transcript body Copy copies 3ms
       × keeps an open transcript and reports through the status pill 1ms
       × uses the empty viewer's placeholder when nothing is open 0ms
       × shows a notice raised from Settings or History in the status pill too 0ms
       × does not drop a notice when no view could be identified 0ms
        Tests  5 failed | 1 passed (6)
  ```
  After, exit 0: `      Tests  6 passed (6)`
- Check 2: `npx vitest run tests/recovery-summary.test.ts`. Before (failures only when nothing succeeded, "Recordings"), exit 1:
  ```
       × reports a partial failure next to the successes instead of hiding it 2ms
       × reports a full success as a success, naming the History tab 1ms
       × reports a full failure and that it will be retried 1ms
        Tests  3 failed | 1 passed (4)
  ```
  After, exit 0: `      Tests  4 passed (4)`
- Check 3 (FU-05, FU-04): grep for `msg.textContent = e.message;`, the `#upscaleOutput` delete-error write and the Refresh body write — HEAD: 7424, 7456, 7474, 7502, 8843; after: none. FU-20 (meta line) is DOM-only: grep shows the new write at 8650; no test.

### 118ae59 · FU-02
- Files: new `frontend/src/network-probe.ts` + test; `frontend/src/main.tsx` (`probeNetwork`, `refreshNetworkState`, `setBackendUnreachable`).
- Check: `npx vitest run tests/network-probe.test.ts`. Before (both failure stages → offline), exit 1:
  ```
       × does not call a backend that is not answering 'internet offline' 6ms
       × keeps the last known internet state when the network probe itself failed 2ms
        Tests  2 failed | 2 passed (4)
  ```
  After, exit 0: `      Tests  4 passed (4)`

### 808dc05 · FU-09, FU-08 (renderer half), FU-22 (`keyEventToAccelerator`, shortcut-display dup), FU-26 (part), FU-23 (shortcut comment)
- Files: `frontend/index.html`, new `frontend/src/shortcut-capture.ts` + test, `frontend/src/shortcut-display.ts` (`shortcutBadge`, dead branch), `frontend/src/main.tsx`, `frontend/tests/shortcut-display.test.ts`, `frontend/tests/ui-copy.test.ts`.
- Check 1: `npx vitest run tests/shortcut-capture.test.ts`. Before (the old `keyEventToAccelerator` body verbatim in the module), exit 1:
  ```
       × refuses function keys Electron cannot register 2ms
        Tests  1 failed | 7 passed (8)
  ```
  After, exit 0: `      Tests  8 passed (8)` (the 7 shared cases pass on both: behaviour kept).
- Check 2: `npx vitest run tests/ui-copy.test.ts`. Before (HEAD `index.html`), exit 1:
  ```
       × leaves the shortcut keycaps to the renderer (desktop/shortcut-defaults.json is their source) (FU-09) 23ms
        Tests  1 failed | 19 passed (20)
  ```
  After, exit 0: `      Tests  20 passed (20)`
- `shortcutBadge` is an extraction (no behaviour change) — its test is new coverage, no before. FU-08's `switchView` call is DOM-only: no test.

### 92132ce · FU-12 (part — two Upload callers remain, cross-domain)
- Files: `frontend/src/button-feedback.ts` (`flashCopyOutcome`, private `flash`), `frontend/src/ui-copy.ts` (`UI_COPY.copyFeedback`), `frontend/src/main.tsx` (3 callers), `frontend/tests/button-feedback.test.ts`.
- Check: `npx vitest run tests/button-feedback.test.ts`. Before (class from `flashLabel === "Copied"`), exit 1:
  ```
       × keeps a success a success when the copy is reworded 6ms
        Tests  1 failed | 9 passed (10)
  ```
  After, exit 0: `      Tests  10 passed (10)`

### ba09046 · FU-06
- Files: new `frontend/src/key-action.ts` + test; `frontend/src/main.tsx` (`syncKeyActionButton`, `handleKeyAction`).
- Check: `npx vitest run tests/key-action.test.ts`. Before (confirm removed from `performKeyAction`), exit 1:
  ```
       × asks before deleting a stored key and keeps it when the user declines 3ms
       × deletes after the user confirms 2ms
        Tests  2 failed | 3 passed (5)
  ```
  After, exit 0: `      Tests  5 passed (5)`

### c3cc66e · FU-19, FU-18
- Files: `frontend/src/error-text.ts` (`isPermissionRefusal`, `formatErrorDetail`), `frontend/src/main.tsx` (`acquireMicStream`, `parseError`, `sanitizeUiErrorMessage`), `frontend/tests/error-text.test.ts`.
- Check: `npx vitest run tests/error-text.test.ts`.
- Before A (name check removed — message sniffing only), exit 1:
  ```
       × recognises a refusal by its DOMException name, whatever the message says 4ms
        Tests  1 failed | 26 passed (27)
  ```
- Before B (array detail printed as JSON), exit 1:
  ```
       × renders a FastAPI validation array as readable field messages, not JSON 5ms
        Tests  1 failed | 29 passed (30)
  ```
- After, exit 0: `      Tests  30 passed (30)`. The sanitize `console.warn` lines are logging only (no test).

### ac324e4 · FU-25 (hypothesis; no observable change, so fixed), FU-14 (hypothesis; same)
- Files: new `frontend/src/keepalive.ts`, new `frontend/src/runtime-limits.ts`, `frontend/tests/runtime-limits.test.ts`; `frontend/src/main.tsx` (`apiPost`, `apiPut`, `enqueueUiPreferencesSave`, `flushUiPreferencesSave*`, `applyRuntimeLimits`).
- Check 1: `npx vitest run tests/runtime-limits.test.ts`. Before (ceilings 8 / silent drop restored in the module), exit 1:
  ```
       × takes the backend's numbers, including ones above the renderer's old ceilings 6ms
       × reports a value that is not a positive integer instead of dropping it silently 1ms
        Tests  2 failed | 2 passed (4)
  ```
  After, exit 0: `      Tests  4 passed (4)`
- Check 2 (FU-25 wiring): `grep -c "flushUiPreferencesSaveNow({ keepalive: true })"` — HEAD~1: `0`, after: `1`.

### bf3cb2f · FG-16, FG-12, FG-11 (renderer side), FU-15 (comments only), FU-23 (loadCfg comments)
- Files: new `frontend/src/providers.ts` + `frontend/tests/providers.test.ts`; `frontend/src/main.tsx`.
- Check 1: `npx vitest run tests/providers.test.ts`. Before (`requireRemoteProvider` = `provider || "openrouter"`), exit 1:
  ```
       × refuses a None selection instead of billing it to OpenRouter 3ms
        Tests  1 failed | 3 passed (4)
  ```
  After, exit 0: `      Tests  4 passed (4)`
- Check 2 (FG-11): `grep -cE '"(remote_model|openrouter_model)"|remote_model: value|openrouter_model: value'` — pre-fix `main.tsx`: `4`, after: `0`. Backend reads `model` first at all three endpoints (`backend/main.py` `_remote_model_from_payload`, `/api/remote/jobs`, `/api/remote/transcribe-sync`), so the wire meaning is unchanged.
- FG-16 is a consolidation (no behaviour change): the new table tests are coverage, no before.

### b7928cb · FU-24, FU-22 (CLI defaults aliasing, `bindMedia` legacy branch), FU-23 (health-poll and CSP comments)
- Files: `frontend/src/styles.css`, `frontend/src/cli-section.ts`, `frontend/tests/cli-section.test.ts`, `frontend/src/main.tsx`, `frontend/index.html`.
- Check 1: `npx vitest run tests/cli-section.test.ts`. Before (HEAD `cli-section.ts`), exit 1:
  ```
       × hands out a fresh defaults object per status 4ms
        Tests  1 failed | 11 passed (12)
  ```
  After, exit 0: `      Tests  12 passed (12)`
- Check 2 (FU-24): `grep -c ':root.reduce-motion' styles.css` — HEAD `8`, after `1` (the explaining comment); `!important` 12 → 7.

### 02c3508 · FU-17 (decision half; wiring is cross-domain)
- Files: `frontend/src/update-check.ts` (`updateCheckOutcome`), `frontend/tests/update-check.test.ts`.
- Check: `npx vitest run tests/update-check.test.ts`. Before (stamp and render every result, the current `runUpdateCheck` behaviour), exit 1:
  ```
       × does not stamp the daily throttle for a check that learned nothing 3ms
       × keeps the passive boot check silent when it could not tell, but answers the button 0ms
        Tests  2 failed | 18 passed (20)
  ```
  After, exit 0: `      Tests  20 passed (20)`
- The user-visible behaviour changes only once `runUpdateCheck` adopts it (cross-domain below).

### bed81e5 · FU-16 (a–e)
- Files: new `frontend/src/screens-strip.ts` + test; `frontend/src/main.tsx` (`showRecordingViewerScreens`, `apiGetBlob`); `frontend/src/styles.css`.
- Check 1: `npx vitest run tests/screens-strip.test.ts` — 3 passed (new rules; nothing pre-fix to restore: the old code had no note and no label).
- Check 2 (grep over `main.tsx`, pre-fix tree → after): `for (const file of screens)` 1 → 0; `img.setAttribute("role", "listitem")` 1 → 0; `img.alt = file` 1 → 0; `screensStripNote(failed` 0 → 1.
- Not verified in a running app (no Electron run in this lane).

### 641a061 · FG-15, FG-14
- Files: new `frontend/src/player-source.ts` + test; `frontend/src/main.tsx` (`renderLatestSavedAudio` skip guard and fallback key, the `#currentRecordingAudio` error listener).
- Check: `npx vitest run tests/player-source.test.ts`. Before (backend-key-only comparison), exit 1:
  ```
       × leaves the in-memory fallback alone on a refresh instead of restarting playback 6ms
        Tests  1 failed | 2 passed (3)
  ```
  After, exit 0: `      Tests  3 passed (3)`
- FG-14 (error listener → disabled player + notice + key reset) is DOM-only: no test. The audit's other option (no fallback once saved) was not taken: it would remove playback that works where the file is still readable.

### 6d51011 · FU-21 (new part + the field/parse duplication of R-024/R-025)
- Files: new `frontend/src/recording-save.ts` + test; `frontend/src/main.tsx` (`saveRecordingText`).
- Check: `npx vitest run tests/recording-save.test.ts`. Before (refusal removed = pre-fix silent drop), exit 1:
  ```
       × refuses a screen session on a save without the audio file instead of dropping it 3ms
        Tests  1 failed | 4 passed (5)
  ```
  After, exit 0: `      Tests  5 passed (5)`

### Suites at the last commit
`npm --prefix frontend run typecheck` exit 0 · `npm --prefix frontend run lint` exit 0 ·
`npm --prefix frontend test` exit 0 (`Test Files  42 passed (42)`, `Tests  494 passed (494)`; 403 at start) ·
`npm --prefix frontend run build` exit 0. Desktop suites that read renderer files
(`node --test desktop/recording-status.test.js desktop/shortcut-defaults.test.js desktop/ipc-contract.test.js`): 25 pass, 0 fail.

## Not done (ID → reason)

- **FU-10** (`document.title` as IPC, = DM-10 = K-1) — needs a preload/`ipcMain` channel in desktop; transport left as is per lane brief. Cross-domain below.
- **FU-13 (a, b, c)** and **FG-10** (= FU-13b) — the renderer copies backend/desktop constants (custom preset limit 3, Deepgram small-audio 1 MiB / 13 s UI timeout, desktop auto-stop defaults). The fix is to publish them from the owner; a renderer-only change would just move the copy. Cross-domain below.
- **FU-15** — the Live toolbar offers "None", `loadCfg` reads a stored `""` back as Whisper. Both remedies (drop the option, or persist and restore "") change what the user sees, and a restored `""` silently disables transcription if it was ever written by accident; no source of truth (test, product doc, decision log) picks one. Only the two false comments were corrected (bf3cb2f). Needs a product decision.
- **FU-22 (rest)** — `CliAccessStatus.cliDir`, `CliDefaults.engines/localModels`, `CliCard.id` are parsed but unread; removing them means deleting existing assertions in `tests/cli-section.test.ts`, which §7 forbids as a "fix". `transcription-catalog.ts` `engines.whisper !== false` vs `engines.gigaam === true`: asymmetric on purpose (Whisper ships with the app, GigaAM is an optional install) — not a defect. `WHISPER_LABELS` degrades to `Whisper <id>` — not a defect.
- **FU-26 (rest)** — `renderer-main-contract.test.ts` asserts on source text (hypothesis). Rewriting it would remove existing checks; out of a fix lane's remit. The untested decisions the finding names are now covered where they were extracted: `keyEventToAccelerator`, the conflict badge, the screenshot strip copy, `saveRecordingText`'s request plan.
- **FU-11 (related named constants)** — `MIC_ACQUIRE_TIMEOUT_MS`, `PIPELINE_FAILSAFE_MS`, `WAVE_METER_INTERVAL_MS`, `STATUS_PILL_MAX_CHARS`, `MEDIA_RECORDER_STOP_FALLBACK_MS` are named, single-use and documented in place (S-23); moving them into `UI_TOKENS` is churn with no defect. The literal `320` (CSS transition length, `main.tsx` ~5462) and `250` (mic retry pause) remain as audited.
- **FG-02 (platform half)** — whether Chromium's `createWritable()` loses the committed prefix when `close()` rejects is unverified (needs a real Chromium with a forced write failure). Its consequence is closed by 959e7f5 (duration read off the file); the close failure is a warning now.
- **FG-04** — backend drops `schema_version` in `_normalize_live_draft`; renderer comment corrected (55e46b4). Cross-domain below.
- **FG-06** — backend keeps the FIRST 200 000 chars of a draft; the renderer does not know the limit. A renderer-side cap would be a copy of a backend number. Cross-domain below.
- **FG-08** (hypothesis) — a recording started before `recoverLiveDraftIfAny` runs can overwrite the single draft slot; the gate belongs in `startLive` / bootstrap (other lane). The empty-owner DELETE half: skipping it would re-offer an owner-less stale draft at every start; left with the gate. Cross-domain below.
- **FG-09** (hypothesis) — spool recovery and draft recovery for the same crash may yield two recordings; unverified that the ids coincide; no reproduction. Left as a hypothesis.
- **FG-13 (b)** — no overall deadline on a backend job wait: there is no product number for the longest legitimate job (a multi-hour file on CPU); an invented deadline would kill real work. (a, c, d) fixed in d9dbf0d.
- **FG-17 (rest)** — the "exceeds 2 hours" text at `main.tsx` ~11755 is in the other lane's range (cross-domain); `MEDIA_RECORDER_STOP_FALLBACK_MS` stays a named constant (its header explains why).
- **FG-19 (rest)** — `resolveFastLocalLanguage` vs `|| "auto"` in `localJobSync`: a defensive default at a wire boundary, no observable defect; not worth churn.
- **R-023** (early "nothing to save" exit looks like a save) — its callers are outside this lane; unchanged.

## Cross-domain, for the lead

1. **Delete-all handler** (`main.tsx` `#deleteAllConfirmBtn`, starts ~9242 — the function containing line 9285, so outside this lane) — FU-03/FU-04:
   - delete the dead `showRecordSessionNotice(summary, tone);` (the banner is invisible from History; `setStatus` above already reports, and since 0f657c3 `showRecordSessionNotice` would ALSO write the status pill, i.e. twice);
   - in the `catch`, replace `$("recordingContent").textContent = msg;` with `if (historyFailureSurfaces(!!selectedRecordingName).placeholder) resetRecordingViewer(msg);` (import from `./notice-surface`, already imported in main.tsx);
   - the raw `fetch("/api/recordings", { method: "DELETE", headers: authHeaders() })` + manual `r.ok` can be `apiDelete<{ deleted?: unknown; failed?: unknown }>("/api/recordings")`.
2. **Upload copy buttons** (`main.tsx` ~15517 and ~15610) — FU-12: replace `flashButtonFeedback(copyBtn, ok ? "Copied" : "Copy failed", "Copy transcript", {…})` with `flashCopyOutcome(copyBtn, ok, "Copy transcript", {…})` (already imported); then delete `flashButtonFeedback` from `button-feedback.ts` and its tests that exercise the label path move to `flashCopyOutcome`.
3. **Update check wiring** (`main.tsx` `runUpdateCheck` ~13654 and the boot IIFE ~13698) — FU-17 (= FQ-13): give `runUpdateCheck(trigger: UpdateCheckTrigger)`; after `checkForUpdate`, `const outcome = updateCheckOutcome(result, trigger)`; write `UPDATE_CHECK_CACHE_KEY` only if `outcome.stamp`; if `!outcome.render` restore the idle status text and return (re-enable the button); the button passes `"user"`, the boot IIFE `"boot"`.
4. **"exceeds 2 hours" copy** (`main.tsx` ~11755, live lane) — FG-17: build it with `capturedHoursLabel(UI_TOKENS.capture.fallbackWindowSec)` from `./pcm-capture` (already imported) and `UI_TOKENS.notice.longMs` instead of `9000`.
5. **FG-08** (live lane / bootstrap): gate `startLive` on `recordingsBootstrapReady` (or read the stale draft once before the first session can start), so `persistLiveDraft(true)` cannot overwrite a crash draft before `recoverLiveDraftIfAny` reads it.
6. **Backend** —
   - FG-04: add `schema_version` (int) to `_normalize_live_draft` (`backend/main.py` ~2650) and echo it, so the renderer's newer-schema gate can work for backend drafts.
   - FG-06: keep the TAIL, not the head, when a draft exceeds `LIVE_DRAFT_MAX_TEXT_CHARS` (`[-max_len:]`), or publish the limit in bootstrap so the renderer can trim the tail itself.
   - FG-11: remove the `remote_model` / `openrouter_model` aliases from `_remote_model_from_payload`, `/api/remote/jobs`, `/api/remote/jobs/from-path`, `/api/remote/transcribe-sync` (the renderer sends only `model` since bf3cb2f).
   - FU-13a: publish `UPSCALE_MAX_CUSTOM_PRESETS` (e.g. `runtime_limits.upscale_custom_preset_limit`); the renderer then reads it instead of `customCount >= 3` in `loadUpscalePresets`.
   - FU-13b / FG-10: publish `_DEEPGRAM_SMALL_AUDIO_BYTES` and the small-audio connect+read timeout in bootstrap; the renderer derives `REMOTE_SMALL_AUDIO_BYTES` and `UI_TOKENS.finalize.smallAudioUiMs` (= timeout + margin) from them.
7. **Desktop** —
   - FU-10 (= DM-10, K-1): expose `transcriptor.shortcuts.{update,captureStart,captureCancel}`, `toggleRecording()`, `revealRecording()` through `preload.js` + `ipcMain.handle`; then the renderer drops `TITLE_BRIDGE_PREFIX`, the nonce and the restore timer.
   - FU-08: dispatch `window.dispatchEvent(new CustomEvent("transcriptor:shortcut-status"))` in the same `executeJavaScript` that writes `window.__transcriptorShortcutStatus` (`desktop/main.js` ~8866, ~9956); the renderer then listens for it and deletes `_shortcutConflictPoll`.
   - FU-13c: `DEFAULT_RECORDING_AUTO_STOP_CONFIG` (`desktop/main.js` ~474) is a second copy of `UI_TOKENS.autoStopSilence`, held only by a test; main should read the renderer's published snapshot.

