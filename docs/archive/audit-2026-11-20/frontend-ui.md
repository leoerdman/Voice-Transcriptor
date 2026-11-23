# Ultra-Audit: frontend UI (main.tsx 1..~9300, index.html, styles.css, pure modules)
Auditor: frontend-ui. Read-only. Line numbers are as of HEAD acbf737; symbols are given because lines rot.
Legend: C = confirmed (entry path -> defect site named), H = hypothesis.

## Coverage
| Area | Status | How | Note |
|---|---|---|---|
| settings-autosave.ts, upload-queue-restore.ts, recordings-list-reconciler.ts, list-window.ts, gated-poll.ts, shortcut-display.ts, ui-copy.ts, button-feedback.ts, error-text.ts, recording-title.ts, transcription-catalog.ts, cli-section.ts, update-check.ts | read in full | whole file | defects: FU-12, FU-15(partly), FU-22 |
| vite.config.ts | read in full | whole file | clean (see Clean places) |
| index.html | partial | CSP, Settings shortcuts/CLI/delete modal, History viewer, grep of defaults | no full read of the 926 lines |
| styles.css | partial | grep for !important, reduced-motion, screens strip, notice, cli | FU-24 |
| main.tsx 1-1300 (types, UI_TOKENS, title bridge, appearance) | read | | FU-10, FU-11 |
| main.tsx 1300-2360 (catalog, selectors, local models, health catalog, runtime config) | read | | FU-13, FU-14, FU-15 |
| main.tsx 2360-3000 (audio viewer, blob urls) | skimmed only | | not audited in depth |
| main.tsx 3000-3700 (abort signal, sanitizeUiErrorMessage, notice, status) | read | | FU-03, FU-18 |
| main.tsx 3700-3975 (autostop clamps, key buttons, apiGet/Post/Put/Delete) | read | | FU-06, FU-18 |
| main.tsx 3975-5100 (downsample, pcm sink, remote jobs) | NOT read | capture/live, belongs to the capture owner | |
| main.tsx 5100-5700 (recovery, switchView, network, mics) | partial | recoverBackendAudioSessions, switchView, refreshNetworkState, acquireMicStream | FU-02, FU-07, FU-23 |
| main.tsx 5700-6100 (live draft) | NOT read | | |
| main.tsx 6096-6490 (collectUiPreferences, shortcut picker) | read | | FU-08, FU-09, FU-10 |
| main.tsx 6488-6905 (upscale) | partial | presets, controls | FU-01, FU-13 |
| main.tsx 6905-7270 (autosave, loadCfg) | read | | FU-01, FU-15, FU-25 |
| main.tsx 7270-7745 (keys, settings listeners, CLI) | read | | FU-05, FU-06 |
| main.tsx 7744-9330 (History list, viewer, screens strip, saveRecordingText, retranscribe, delete-all) | read | | FU-03, FU-04, FU-16, FU-19, FU-20, FU-21 |
| update check wiring (main.tsx 13777-13860, outside range, read because update-check.ts is in scope) | read | | FU-17 |
| tests | partial | file list, settings-autosave.test, test names of contract+shortcut-display | FU-26 |

## Findings

Format per finding: ID . place (file:line + symbol) . gist . reproduce . consequence . severity + C/H . current code . fixed code . explanation . why a bug, not intent.

### FU-01 . P1 . C . A transient failure of the upscale-preset catalog makes the next autosave erase the saved preset
- Place: `frontend/src/main.tsx:6577` `loadUpscalePresets` (failure branch ~6600-6612) + `main.tsx:6522` `upscalePresetId` + `main.tsx:6096` `collectUiPreferences` (`upscale_preset: upscalePresetId()`).
- Gist: when `GET /api/upscale/presets` fails, the select is rebuilt with one disabled "Presets unavailable" option and `value = ""`. The user's id is parked only in `pendingUpscalePresetId`. `collectUiPreferences` reads the DOM select, not the parked id, so it writes `upscale_preset: ""`.
- Reproduce: start the app with `/api/config` answering and `/api/upscale/presets` failing once (backend still warming up). `loadCfg` already set `uiPreferencesLoaded = true`. Toggle any setting (even Live preview). The 260 ms debounced save posts the whole `ui` block with `upscale_preset: ""`. `loadUpscalePresets` is not re-run on a timer; it runs only again on preset save/delete or a failed `loadCfg`.
- Consequence: the user's chosen preset (Clean/Business/AI & Code/custom) is overwritten with blank, successfully and silently. This is the exact class that `settings-autosave.ts` was written to prevent ("never write what was not read"), applied to one key it did not cover.
- Current code:
```ts
sel.innerHTML = "";
if (!upscalePresets.length) {
  ... o.textContent = "Presets unavailable"; sel.value = "";
  pendingUpscalePresetId = prev;
  syncUpscalePresetControls();
  return;
}
...
upscale_preset: upscalePresetId(),   // collectUiPreferences
```
- Fixed code:
```ts
function upscalePresetId(): string {
  const chosen = (($("upscalePresetSelect") as HTMLSelectElement).value || "").trim();
  // An unloaded catalog is "unknown", not "none": keep what the user had.
  return chosen || pendingUpscalePresetId;
}
```
  and in the failure branch keep `upscalePresets` (stale rows beat none, as `refreshLocalModels` does) instead of `upscalePresets = []`.
- Explanation: the parked id exists precisely to carry the choice across a failed load, but the single reader of the choice does not consult it.
- Why a bug: the same file states the opposite rule for the whole preference block (`settings-autosave.ts` header) and for model lists (`refreshLocalModels` keeps stale cache).

### FU-02 . P2 . C . Any failure of the LOCAL backend probe is shown as "Offline / Internet unavailable"
- Place: `main.tsx:5384` `refreshNetworkState` (outer `catch { setNetworkState(false, null); }`), `main.tsx:5268` `setNetworkState`.
- Gist: `fetch("/api/health")` and `fetch("/api/network")` are same-origin calls to the app's own backend. Their failure (backend restarting, port change, token missing -> `authHeaders()` throws) lands in a catch that declares the INTERNET offline. The same catch swallows a thrown `authHeaders()` ("API token is missing").
- Reproduce: kill/restart the Python backend while the app is open; within 10 s the pill says "Offline", title "Internet unavailable". `resolveEffectiveProvider` then routes new sessions to local.
- Consequence: wrong diagnosis (the user hunts for a network problem), provider routing flips to local on a backend blip, error has no owner (no log line either: bare `catch`).
- Current: `} catch { setNetworkState(false, null); }`
- Fixed: separate the two facts: `catch (e) { console.warn("backend probe failed", e); setBackendReachable(false); /* keep isNetworkOnline unchanged */ }` and render a distinct "Backend not responding" state; only `/api/network` answering `online:false` sets Offline.
- Why a bug: the comment two lines above ("honor the backend's `online` field") shows intent is "internet", while the catch answers a different question.

### FU-03 . P2 . C . `showRecordSessionNotice` writes into the Record view, but is called from Settings and History where that view is hidden
- Place: `index.html:416` (`#recordSessionNotice` inside `<section data-view="record">`, section starts 288); `main.tsx:3273` `showRecordSessionNotice`; callers from other views: `main.tsx:6460` (`handleShortcutKeydown`: "already bound to …"), `main.tsx:6976` (`enqueueUiPreferencesSave` catch), `main.tsx:7217` (`loadCfg` catch), `main.tsx:9278` (delete-all summary).
- Gist: the banner is per-view DOM. `switchView` sets `hidden` on the whole section, so a notice fired while Settings/History is on screen is invisible and expires (6-9 s timer) before the user returns to Live.
- Reproduce: Settings -> Shortcuts -> click Record -> press the combination already used by Paste. The shortcut silently reverts (display restored by `stopShortcutRecording(true)`), the explanation goes to a hidden banner. Same for "Settings were not saved" when no status-pill text sticks.
- Consequence: user cannot understand why the rebind was refused. Delete-all (9278) is a leftover: R-003 was "fixed" with `setStatus`, but the dead call to the hidden banner stayed, and the comment above it says it is invisible.
- Current: `showRecordSessionNotice(`That shortcut is already bound to "${taken.label}". Pick a different combination.`, "warning", 6000); stopShortcutRecording(true);`
- Fixed: one `notify(message, tone, ms)` that shows the banner of the CURRENT view (or `setStatus` + a per-view hint) and have all callers use it; for the shortcut case also `setSettingsArchiveStatus`-style inline text under the button (`btn.title`/`aria-live` row in `.card-shortcuts`). Delete the dead call at 9278.
- Why a bug: the file already established the rule (comment at 9270-9277) that this banner is invisible from History; the other callers were not brought under it. Known as R-003 for one call site only; the class is not closed.

### FU-04 . P2 . C . Refresh/Delete-all failures are written into the transcript body, which Copy copies
- Place: `main.tsx:~8985` `$("recordingsRefreshBtn")` click `.catch`; `main.tsx:~9291` `#deleteAllConfirmBtn` catch (`$("recordingContent").textContent = msg`).
- Gist: `openRecording` explicitly puts errors into `data-placeholder` and not the body ("the failure there put 'Could not open this recording…' on the user's clipboard as if it were their transcript", comment at ~8710). These two handlers do the opposite.
- Reproduce: History with a recording open; stop backend; press Refresh. The open transcript is replaced by "Could not refresh the archive."/"Failed to fetch" text, `updateRecordingCopyState()` enables Copy, Copy puts the error on the clipboard. Delete-all failure does the same.
- Consequence: visible transcript destroyed on a failed refresh (it is still on disk, but the pane lies), error text copied as content.
- Current: `$("recordingContent").textContent = sanitizeUiErrorMessage(e, "Could not refresh the archive."); updateRecordingCopyState();`
- Fixed: `setStatus(`Refresh failed: ${msg}`, "warning")` and, only if nothing is selected, `resetRecordingViewer(msg)` (placeholder path).
- Why a bug: contradicts the invariant stated and implemented in the neighbouring `openRecording` catch.

### FU-05 . P2 . C . Deleting an upscale preset reports failure into the hidden Live pane and overwrites the user's upscale result; preset modals show raw `e.message`
- Place: `main.tsx:~7544` `#upscalePresetDeleteBtn` handler (`.catch` -> `$("upscaleOutput").textContent = "Preset delete failed: …"`); `#upscalePresetSaveBtn` / `#upscalePromptSaveBtn` / `#upscalePromptDefaultBtn` handlers (`msg.textContent = e.message`).
- Reproduce: Live view produced an upscale result; Settings -> delete a custom preset with the backend returning 4xx/5xx. The Live upscale pane (`#upscaleOutput`, in `data-view="record"`) now contains "Preset delete failed: HTTP 500…" instead of the user's text; nothing visible in Settings. The modals show un-sanitised `HTTP 400: {...}` / "Failed to fetch".
- Consequence: user's generated text lost from the pane, error invisible where the action was taken, jargon in modals.
- Fixed: `setStatus(`Preset delete failed: ${sanitizeUiErrorMessage(e, "Could not delete the preset.")}`, "error")`; modals `msg.textContent = sanitizeUiErrorMessage(e, "Could not save the preset.")`. Delete also uses raw `fetch`+`parseError` where `apiDelete` exists.
- Why a bug: result pane is a product output surface; no other error path writes into it from Settings.

### FU-06 . P2 . C . Stored API key is deleted by one click, no confirmation, on a button that was "Save" a moment earlier
- Place: `main.tsx:3848` `syncKeyActionButton`, `main.tsx:7334` `handleKeyAction` (`btn.classList.contains("delete")`), `main.tsx:7319` `deleteProviderKey`.
- Gist: the same button flips Save/Delete depending on `keySavedState` and whether text was typed. Focusing the masked field clears the mask (`clearMaskedKeyOnEdit`) while `canDelete` is still true (nothing typed), so the button reads "Delete key" over an empty focused field. One click posts `{key: ""}`.
- Consequence: irreversible loss of a secret the user may not have a copy of; the delete action is chosen by reading a CSS class.
- Fixed: `window.confirm`/modal like preset delete (the file already does it for presets and models and for Delete-all), and decide by state (`keySavedState && !hasTyped`) not by `classList.contains("delete")`.
- Why a bug: the file's own comments justify a confirm for far cheaper data (presets, 75 MB models).

### FU-07 . P2 . C . Partial failure of interrupted-recording recovery is silent
- Place: `main.tsx:5102` `recoverBackendAudioSessions`.
- Gist: `failed` is reported only when `succeeded === 0`. With 2 recovered and 1 failed the user gets "Recovered 2 …" and the failure is a `console.warn`.
- Consequence: a spool that cannot be promoted stays on disk, re-tried at every start, never surfaced. Also copy: "into Recordings" / "Check the Recordings folder" while the tab is called History.
- Fixed: one summary notice with both counts ("Recovered 2, 1 could not be recovered - see <folder>") and tab name "History".
- Why a bug: `if (failed > 0 && succeeded === 0)` is an arbitrary gate; the header comment of the function says the loop must not hide failures.

### FU-08 . P2 . C . Shortcut-conflict state arrives via a 2 s poll of a window global that main already writes by executeJavaScript, and the first tick is 2 s after opening Settings
- Place: `main.tsx:6355` `_shortcutConflictPoll = createGatedPoll({intervalMs: 2000 …})`, `main.tsx:6304` `refreshShortcutConflictState`, `gated-poll.ts` `arm()` (first tick after `intervalMs`), `main.tsx:5297` `switchView`; producer `desktop/main.js:8866,9956` (`window.__transcriptorShortcutStatus = …` via executeJavaScript).
- Gist: main pushes the value with executeJavaScript at every change; the renderer polls the global instead of being told. `switchView("settings")` calls `refreshLocalModels()` and `refreshCliSection()` immediately but not `refreshShortcutConflictState()`; `syncGatedPolls` only arms a timer.
- Reproduce: first open of Settings on macOS. The two screen-mode rows (`#shortcutScreenField`, `#shortcutScreenShotField`, hidden in markup, un-hidden only inside `refreshShortcutConflictState`) and any conflict badge appear up to 2 s later; the form jumps.
- Fixed: in `switchView` call `refreshShortcutConflictState()` next to the other two, and have main dispatch `window.dispatchEvent(new CustomEvent("transcriptor:shortcut-status"))` in the same executeJavaScript, deleting the poll.
- Why a bug: polling where an event is trivially available; and the "poll" gives UI that pops in.

### FU-09 . P2 . C . Settings shows macOS default hotkeys from markup until `loadCfg` succeeds (parallel copy of `shortcut-defaults.json`)
- Place: `index.html:780-818` (keycaps "Option ←", "Option Shift V", "Option →", "Option ↓" hard-coded in `.shortcut-keys` and `aria-label`), `main.tsx:7200` (only call of `updateAllShortcutDisplays` on load) and `main.tsx:7593` (Reset).
- Gist: `ui-copy.ts` declares that "the markup carries no copy of its own"; the shortcut rows violate that. `DEFAULT_SHORTCUTS` (from `desktop/shortcut-defaults.json`) is known at module load but is not painted until a successful `GET /api/config`.
- Reproduce: Windows/Linux, backend slower than the renderer or `/api/config` failing: Settings -> Shortcuts shows "Option Shift V" while main registered `Control+Alt+Shift+V`.
- Fixed: call `updateAllShortcutDisplays()` once at boot after `DEFAULT_SHORTCUTS` is built, and empty the markup keycaps.
- Why a bug: the manifest exists (AGENTS.md SSOT rule 4) to be the only place for default hotkeys.

### FU-10 . P2 . C(known K-1/U-014, not fixed) + H . document.title as IPC; its stated justification is stale; one-slot channel
- Place: `main.tsx:916-953` `TITLE_BRIDGE_PREFIX`, `postTitleBridgeMessage`; consumers `desktop/main.js:8399` `page-title-updated`. `desktop/preload.js:82-138` already exposes a `transcriptor` namespace with `ipcRenderer.send/invoke` (screen-mode:finish, recording-final).
- Gist: the comment says "the one channel available to a renderer that has no preload IPC for these three messages". There is a preload IPC now. Shortcuts (with a `Date.now()+random` nonce so the title always changes), record toggle and reveal still ride the window title.
- H: `document.title` is a single slot. Two messages in one task (e.g. `capture-cancel` then `update`) can collapse into one `page-title-updated` event (final title only); the module guards the restore, not the loss.
- Consequence: window title flicker/taskbar/screen-reader announcements, 96-char payload truncation in main.js (`slice(0, 96)`), loss of a message possible, any renderer string starting `__app_` triggers a main-process action.
- Fixed: `contextBridge.exposeInMainWorld("transcriptor", {... shortcuts: {update, captureStart, captureCancel}, toggleRecording(), revealRecording()})` with `ipcMain.handle`; delete the prefixes, the nonce and the restore timer.
- Why not intent: the module header only argues "no preload IPC", which is no longer true.

### FU-11 . P2 . C . The notice duration scale in `UI_TOKENS.notice` is bypassed by literals
- Place: `main.tsx:1005-1010` (`notice.briefMs/defaultMs/longMs`, comment: "rather than four literals sprinkled through the file (…9000)"); literal `9000` at `main.tsx:4421, 5147, 5156, 5164, 7220` (and 11758 outside this range); literal `6000` at `main.tsx:6463`.
- Fixed: `UI_TOKENS.notice.longMs` / `briefMs`.
- Why a bug: the token's own comment says it exists to remove exactly these.
- Related, same class: timers kept outside `UI_TOKENS` despite its comment ("every other stop timing lives inside it"): `MIC_ACQUIRE_TIMEOUT_MS` 5614, `PIPELINE_FAILSAFE_MS` 5563, `WAVE_METER_INTERVAL_MS` 5562, `STATUS_PILL_MAX_CHARS` 3593, bare `2500` at 4473 (duration probe), `250` at 5680, `30_000` at 2930 (blob revoke), `320` at 5462 (hard-coded to the CSS transition length in `styles.css`). Known as S-23 (not fixed).

### FU-12 . P2 . C . `flashButtonFeedback` decides success vs failure by comparing the label to the literal "Copied"
- Place: `button-feedback.ts:70` (`flashLabel === "Copied" ? "is-copy-ok" : "is-copy-failed"`); 5 callers pass `ok ? "Copied" : "Copy failed"` (`main.tsx:7669, 8036, 8049, 15630, 15723`).
- Gist: outcome is encoded in an English string; any wording/i18n change of "Copied" turns every success into the failed style. The visual state and the announced text share one parameter.
- Fixed: `flashButtonFeedback(btn, { ok, label }, resting, opts)`; classes from `ok`.
- Why a bug: two facts in one parameter; the module's own test only exercises the literal.

### FU-13 . P2 . C . Backend-owned constants repeated in the renderer
- (a) `main.tsx:6633` `addBtn.disabled = customCount >= 3` vs `backend/main.py:703` `UPSCALE_MAX_CUSTOM_PRESETS = 3` (raises 400 at 6928). Not in bootstrap.
- (b) `main.tsx:2993` `REMOTE_SMALL_AUDIO_BYTES = 1 * 1024 * 1024` and `DEEPGRAM_SMALL_AUDIO_UI_TIMEOUT_MS = 13_000` vs `backend/remote_deepgram.py:51,65` `_DEEPGRAM_SMALL_AUDIO_BYTES` (1 MiB, read timeout 12 s, 1 attempt). The renderer's 13 s is the backend's 12 s + 1 s by convention.
- (c) known, partially fixed F-003/S-03: `desktop/main.js:474` `DEFAULT_RECORDING_AUTO_STOP_CONFIG = {enabled:false, seconds:2, thresholdDb:-42}` second copy of `UI_TOKENS.autoStopSilence`, held in sync only by a test. UI_TOKENS comment still says "one set of numbers".
- Fix: add `custom_preset_limit` and `deepgram_small_audio_bytes`/timeout to `runtime_limits`/bootstrap and read them; for (c) let main read the renderer snapshot (already published) instead of keeping a default.

### FU-14 . P2 . H . Renderer re-validates backend runtime limits with its own ceilings and silently ignores out-of-range values
- Place: `main.tsx:2252` `applyRuntimeLimits` (`uploadParallel <= 8`, `persistedItems <= 1000`), `main.tsx:2182` (`sampleRate` 8 000-96 000).
- Gist: if the backend ever raises `upload_queue_max_parallel` to 10 the value is dropped and the default (1 / `Number.MAX_SAFE_INTEGER`) stays, with no log line. Default for `uploadQueueMaxPersistedItems` is `MAX_SAFE_INTEGER` (no bound) when the bootstrap fails.
- Hypothesis because the backend currently stays in range. Fix: trust the typed backend value (positive integer) and log when rejected.

### FU-15 . P2 . C . "None" provider: offered in the toolbar, not persisted across restart, and the code comment says it was removed
- Place: `main.tsx:1430` `renderTranscriptionSelectors` (`wantsNone` adds `<option value="">None</option>`), `main.tsx:7059-7075` `loadCfg` (comment "The 'None' provider option was removed … a legacy stored '' coerces to Whisper"), `transcription-catalog.ts` `groupFromWire("", …)` -> "local-whisper", `main.tsx:2985` `normalizeProviderSelection` accepts "".
- Reproduce: choose None in the Live toolbar, restart: toolbar shows Local Whisper; transcription now runs.
- Consequence: a choice the UI offers is dropped on restart; the comment and the code state opposite facts. Also `provider_group` is persisted by `collectUiPreferences` (read by `backend/cli_access.py:225`) while the `loadCfg` comment says the group is "never persisted" (stale comment); the backend re-implements `group -> engine` (cli_access.cli_defaults) against `transcription-catalog.ts`, a second source for the same mapping (H).
- Fixed: either remove the `None` option (matches the comment and `normalizeProviderSelection("")`) or persist and restore it.

### FU-16 . P2 . C . Screenshot strip (`showRecordingViewerScreens`): silent failure, mouse-only control, serial full-size fetches, raw fetch
- Place: `main.tsx:7826` `showRecordingViewerScreens`, caller `main.tsx:8654`, `index.html:576`, `styles.css:4306-4329`.
- (a) C: each failed file is only `console.warn`ed; if every fetch fails the row stays `hidden` and the user has no indication that screenshots exist but could not be loaded. Same class as FU-20.
- (b) C: images are `<img>` with a click handler (zoom), no `tabindex`, no key handler, `role="listitem"` on a thing that acts as a button, `alt = file name` (e.g. "shot-3.png"). Keyboard/screen-reader users cannot expand.
- (c) C: `for … await fetch` runs one screenshot at a time; screens appear in sequence and a slow first file delays the rest.
- (d) C: raw `fetch(..., {headers: authHeaders()})` instead of the `apiGet` family: no timeout, no `parseError`, a third copy of URL+auth construction (compare `fetchSavedAudioFromBackend`).
- (e) H: full-size blobs held as object URLs for 72 px thumbnails; expanded image has `height:auto; flex:1 1 100%` with no `max-height`, so a tall screenshot can push the transcript out of the pane.
- Fixed: build `<button class="screen-thumb"><img …></button>` with `aria-expanded`, `Promise.all` with the `stillCurrent` check per item, a single "N screenshots could not be loaded" hint in the row, `max-height: 70vh` on `.expanded`.

### FU-17 . P2 . C . Update check: "silent on failure" is not, and a failed check is stamped as done
- Place: `main.tsx:13795` `runUpdateCheck`, `13838` passive boot IIFE ("silent on failure so an offline start never nags"), `update-check.ts` `shouldAutoCheck`.
- Gist: the 4 s boot call goes through `runUpdateCheck`, which always writes `UPDATE_CHECK_CACHE_KEY = Date.now()` (even on `status: "unknown"`) and renders "Couldn't check for updates (…)" in Settings. After an offline/403 start there is no retry for 24 h, and the "silent" claim is false for the visible text.
- Fixed: stamp only for `update-available`/`up-to-date`; passive path renders nothing for `unknown`.

### FU-18 . P2 . C . Error sanitising turns real causes into generic fallbacks; misplaced doc comment
- Place: `main.tsx:3070` `sanitizeUiErrorMessage` (`/unexpected token/i`, `/cannot read properties/i`, `cleaned.length > 800` all -> `fallback`), `main.tsx:3866-3873` doc block "Translate a raw fetch/network error…" sits above `parseError` (it describes `explainNetworkError`, moved out), `main.tsx:3874` `parseError` (a FastAPI 422 `detail` array is rendered as `JSON.stringify(j)`).
- Gist: an HTML error page from a proxy ("Unexpected token '<'") or a >800-char server message surfaces only as "Transcription failed."; the cause is dropped without a log in this function (callers log only sometimes). A 422 shows raw JSON.
- Fixed: log the dropped raw text (`console.warn("sanitized:", raw)`), format `detail[]` as `loc: msg`, move/delete the stale comment.

### FU-19 . P2 . C . `acquireMicStream` decides "do not retry" by sniffing `message` for substrings
- Place: `main.tsx:5667-5672` (`msg.includes("notallowed") || msg.includes("permission denied")` where `msg = e.message`).
- Gist: `NotAllowedError` is the DOMException `name`; the message is browser text. "Permission dismissed", localized or Electron-specific messages do not match and the code retries 3 times with a 250 ms pause (and each may prompt).
- Fixed: `const name = (e as DOMException)?.name; if (name === "NotAllowedError" || name === "SecurityError") throw e;`. `describeError` already exists in `error-text.ts` for names. H on reach (macOS TCC messages currently contain "Permission denied").

### FU-20 . P2 . C . History: a failed audio load is swallowed; the player simply disappears
- Place: `main.tsx:8601` `openRecording` (catch of `fetchSavedAudioFromBackend`: `console.warn` + `setRecordingViewerAudioRowVisible(false)`).
- Gist: the item says "Audio" badge (`has_audio`), the player row vanishes with no message. The Live side shows `AUDIO_LOAD_FAILED_TEXT` via `showRecordSessionNotice` at 2783 for the same failure; History has no equivalent (and see FU-03 for where that notice lands).
- Fixed: reuse `AUDIO_LOAD_FAILED_TEXT` in `#recordingMeta` or a row note.

### FU-21 . P2 . known(R-023/24/25) + C . `saveRecordingText`: three branches repeat the same fields and response parsing; screens manifest handled in one branch only
- Place: `main.tsx:8735` `saveRecordingText` (the `audioFile` branch is the only one that sends `screen_session_id` and reads `js.screens`; the other two bodies and their three identical `Math.max(0, Math.trunc(Number(js.pruned_audio_count) || 0))` lines are copies). Also the `prunedAudioCount` message pluralises one count as "audio file or screenshot folder".
- Why a bug: known as R-023/R-024/R-025 (not fixed). New part: the manifest/session contract exists only in one branch, so adding a path that carries `screenSessionId` without `audioFile` silently drops it (`opts.screenSessionId` is ignored, no error).

### FU-22 . P2 . C . Dead data and double implementations in pure modules
- `cli-section.ts`: `CliAccessStatus.cliDir`, `CliDefaults.engines`, `CliDefaults.localModels`, `CliCard.id` are parsed and tested but read by no renderer code (`rg` over `main.tsx`: only `commandPath` via `enabled`, `baseUrl`, `cards`, `defaults` via `cliDefaultsSummary`). `CLI_ACCESS_OFF.defaults` aliases the shared `EMPTY_DEFAULTS` object (mutable shared state).
- `shortcut-display.ts`: `acceleratorToDisplayTokens` re-implements the Command/Control mapping that `normalizeAcceleratorForDisplay` has just done (rules restated twice; two places to change).
- `main.tsx:6193` `keyEventToAccelerator`: branches for `Escape` unreachable (`handleShortcutKeydown` consumes Escape before calling it), `F13`..`F99` accepted by `/^F\d{1,2}$/` while the macOS-media-key check `/^F([1-9]|1[0-2])$/` (6317) knows only F1-F12; both the key/code duplicate comparisons are redundant.
- `main.tsx:~880` `bindMedia` legacy `addListener` path is dead for Chromium 142 (`cssTarget: "chrome142"`).
- `transcription-catalog.ts`: `engines.whisper !== false` vs `engines.gigaam === true` (asymmetric defaults for a missing key), hard-coded `WHISPER_LABELS` ids (SSOT is the backend, falls back to `Whisper ${id}` so it only degrades).

### FU-23 . P2 . C . Stale comments that now state the opposite of the code
- `main.tsx:~1435` "2 s health poll" (it is the 10 s `_networkPoll`); `main.tsx:6460` handler comment "The window flag remains as a fallback for older/polling paths" (`publishShortcutUpdateToMain` doc says the flag was removed); `index.html:8-26` CSP comment: "connect-src stays same-origin … can only reach the local backend" while the directive on line 31 contains `https://api.github.com`; `main.tsx:7065` "UI group … never persisted" while `collectUiPreferences` writes `provider_group`.

### FU-24 . P2 . C . Reduced-motion rules written twice
- `styles.css:2924-2955` (`@media (prefers-reduced-motion)` block and `:root.reduce-motion` block with the same five `!important` declarations), `main.tsx:~850` mirrors the media query into a class. Both are true simultaneously, so no visible bug today; the media block additionally carries `animation: none` for `.boot-overlay-spinner`, `.shortcut-btn.recording` which the class block lacks (they drift on the next edit). 12 `!important` in the file, 10 of them this pair.

### FU-25 . P2 . H . Autosave on unload uses a non-keepalive `fetch`
- Place: `main.tsx:7018` `flushUiPreferencesSaveBestEffort` on `pagehide`/`beforeunload` -> `enqueueUiPreferencesSave` -> `apiPost` (no `keepalive`); `apiPut` has the `keepalive` option for the upload queue.
- Gist: a setting changed < 260 ms before quit may never reach the backend because the request can be cancelled with the page. H: Electron usually lets main outlive the window and the request often completes; not verified.
- Fix: `apiPost(url, body, {keepalive: true})` for this path, with the same 60 KB guard.

### FU-26 . P2 . H . Tests that read source text or restate constants instead of exercising behaviour
- `tests/renderer-main-contract.test.ts` (417 lines) asserts on regexes over `main.tsx` text (e.g. `mainTsx.split('"' + prefix + '"').length - 1 === 1`, boundary-marker slicing of `stopLive`). They pass on any refactor that keeps the strings and fail on harmless renames: "coverage without a check".
- No test covers `keyEventToAccelerator`, `refreshShortcutConflictState` (new screen slots incl. `id === "screenShot" ? !entry.error : !!entry.active`), `showRecordingViewerScreens`, `saveRecordingText`, `collectUiPreferences`/`loadCfg` round trip (these live inside the 15 k-line module, untestable without extraction). `settings-autosave.test.ts` tests a 2-line boolean function (4 cases); the actual bug it was written for (FU-01 is a sibling) is not under test.
- Hypothesis (not run): whether any of the contract tests would fail if `showRecordSessionNotice` were removed from History.

## Known, not fixed (re-seen, old IDs)
U/K-2 (size/10000 upload progress timer), U/K-5, U-009 (innerHTML rebuild of queue under aria-live), R-013, R-023/24/25 (-> FU-21), R-026/27 (End key materialises whole archive: `main.tsx:~9115` `ev.key === "End"` -> `getFilteredRecordings()` last + `renderRecordingsList` grows window to the selection), R-029/31, C-021 (apiGet/Post/Put/Delete have no shared timeout; the new raw `fetch` in `showRecordingViewerScreens` and `deleteAll` add two more bypasses of the family), S-23 (timers outside UI_TOKENS -> FU-11), K-1/U-014 (title bridge -> FU-10).

## Clean places (looked, no defect found)
- `settings-autosave.ts` + its use: `queueUiPreferencesSave` gates on `{loaded, suppressed}`; `loadCfgOnce` single-flight and retried from the health poll; `enqueueUiPreferencesSave` chain survives a failure.
- `upload-queue-restore.ts` decision function: pure, no reachable branch writes on `serverReadOk === false`; `shouldDropLegacyUploadQueueSnapshot` is the right way round.
- `recordings-list-reconciler.ts`: removal pass snapshots children first, `moved` counts only existing nodes, keyless nodes are dropped (R-013 contract gap is in the caller). `list-window.ts`: all functions clamp, `shouldGrowWindow` handles non-finite; `shouldResetWindowAfterLoad` tested.
- `gated-poll.ts`: chained timeouts, queued `refreshNow`, gate re-check in `finally`, `stop` idempotent. (Only the first-tick delay, FU-08, is a caller decision.)
- `recording-title.ts` (single implementation for stop and re-transcribe), `ui-copy.ts`, `button-feedback.ts` restore logic (keeps the first labels, clears timer), `error-text.ts` (`isGenericFetchFailure` whole-vs-embedded rules), `update-check.ts` (pre-release compare, future stamp, draft/prerelease refusal), `cli-section.ts` (defensive normalisation, backend authors the command text).
- `vite.config.ts`: version and repo slug from `desktop/package.json`, shortcut defaults from `desktop/shortcut-defaults.json`, worklet never inlined (explained), CSS unminified deliberately (explained). No parallel version source in the config.
- `index.html`: CSP has no `unsafe-eval`, `object-src 'none'`, `img-src blob:` covers the screenshot strip; delete-all modal is `role="dialog" aria-modal` with labelled title; autostop markup carries no numbers (tokens applied at boot).
- `loadCfg` shortcut migration goes through the shared `migrateShortcutPair` (D-015), screen slots fall back to platform defaults; `handleShortcutKeydown` rejects duplicates across all four slots.
- History list: keyed render, window never hides the selection, request-sequence guards on `openRecording`/`loadRecordings`/`loadRecordingsStats`, foreground-load counter.
- `refreshCliSection`/`setCliAccess`: toggle disabled while busy, re-read after a failed write, `textContent` (never innerHTML) for commands.
