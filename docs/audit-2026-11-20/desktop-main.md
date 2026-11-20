# Audit: desktop/main.js (10076 lines) — read-only, 2026-11-20

Method: full linear read of all 10076 lines (nine passes of ~900-1000 lines), plus targeted rg for dead symbols
(function/const referenced once outside comments), renderer-side counterparts (frontend/src/main.tsx, desktop/preload.js)
and screen-mode-controller.js API surface for the wiring. No builds or tests run.

## Coverage table

| Sub-area | Status | How | Why not |
|---|---|---|---|
| Boot, process handlers, data-dir spelling + OneDrive re-home (1-400) | viewed | full read | |
| Logging: main.log, rotation, retention, trace helpers (560-900) | viewed | full read | |
| Window lifecycle table, bounds, saved state, frontend signature (900-1250) | viewed | full read | |
| Renderer probes (execRendererJsWithTimeout etc.) (1250-1340) | viewed | full read | |
| Capsule geometry, HTML, window, update seq, teardown (1340-2400) | viewed | full read | |
| Screen mode wiring (hotkey bind, layer, controller deps, lost renderer, toggle start, IPC finish, before-quit teardown) | viewed | main.js read in full; controller read only at API level (lines 203-235, 640-724) | controller internals belong to another auditor |
| Recording state monitor / autostop / dead-pipeline (2394-2570) | viewed | full read | |
| Recording toggle / start / stop / guarded stop (2600-3060) | viewed | full read | |
| Renderer state query + start-confirm polling (3060-3200) | viewed | full read | |
| Paste target capture / normalisation / Linux window helpers (3178-3700) | viewed | full read | |
| Frontmost-app helpers (mac fast path, Win persistent PS helper, Linux) (3700-4000) | viewed | full read | |
| Target activation (win/linux/mac) (4000-4260) | viewed | full read | |
| Paste capability probe, TCC self-heal, mic permission (4260-4860) | viewed | full read | logic lives in paste-capability.js (not audited here) |
| Clipboard snapshot / smart restore (4860-5055) | viewed | full read | |
| Paste ladder win/linux/mac + auto-send chord (5055-5945) | viewed | full read | |
| Post-stop queue, dedup, transcript hand-off + poll fallback, timeout recovery (5945-6740) | viewed | full read | |
| runCommand, tracked children, python env, ports (6740-7010) | viewed | full read | |
| Python/venv/runtime resolution, engine install lifecycle, backend runtime check (7005-7905) | viewed | full read | engine-deps.js not audited |
| Backend spawn / restart / health / kill (7905-8211, 9158-9300) | viewed | full read | |
| createWindow, title bridge, permissions, did-finish-load/render-gone, error page (8213-9134) | viewed | full read | |
| App events, before-quit, signals (9136-9390) | viewed | full read | |
| whenReady: IPC handlers, tray, shortcuts registration + bridge, power events (9389-10076) | viewed | full read | |
| Tests for main.js | not viewed | — | other auditor; only noted desktop/ipc-contract.test.js exists |

Known-and-closed (not re-reported): D-001 (power events now subscribed at app scope), D-006 (activateAppByName reads result),
D-007/D-008 paste chord/modifier wait, D-009 (accessibility poll removed), D-012 (autostop reachable), D-014 (engine:install phase),
D-016 (PASTE_SENT_PREFIX single import), D-017 (monitor restart on stale stop), D-018 (restart counter reset via noteBackendHealthy),
D-019 (budget table partly), dedup-set clearing on render-process-gone/did-finish-load.

Known, NOT fixed (still present): crutch index #1 title-as-IPC (see DM-12), #2 executeJavaScript polling + DOM-id reads (DM-14),
#4 double dedup sets, H-2 clipboard.writeText re-run per attempt (win 5341, linux 5544, mac 5654), H-3 heardIpcSignal is permanent (6136, 6225-6239),
D-013 residual: status classification by literal strings (DM-15).

---

## Findings

### P1

**DM-01 · main.js:829 `isNoSpeechFinalStatusText`, :852 `isMeaningfulTranscriptText` (consumers :6141 `consumeIpcSignal`, :6315, :6644 `getLatestTranscriptText`) · dictated CONTENT is classified as an error/status by substring · P1 · confirmed**
- Gist: the paste gate decides "is this a transcript or a status string" by looking inside the user's own words.
- Reproduce: dictate "HTTP server returns 500" (lower-cased starts with `"http "`), "network error handling is flaky" (`startsWith("network error")`), or any sentence containing "silence detected" / "no speech detected" / "no speech captured" with auto-transcribe on. Renderer publishes `final:true` text → `consumeIpcSignal` → `isMeaningfulTranscriptText(text)` false → `terminalWithoutPasteStatus = text` → nothing pasted, nothing written to clipboard, capsule shows the dictation as a "status".
- Path: recording-final IPC (:9512) → slot → `processPostStopTask` loop (:6222) → `consumeIpcSignal` (:6146-6164) → "terminal" → :6540 status branch. `getLatestTranscriptText` (paste-last) also refuses it (:6644).
- Consequence: silent loss of a correct transcript for plausible developer/support dictation; user is told "Recording completed" / sees their own text as a status.
- Current:
```js
if (lower.startsWith("http ") || lower.startsWith("network error")) return false;
return ( lower.includes("no speech detected") || lower.includes("silence detected") || ... )
```
- Fixed: the renderer already sends `final` and `uiFinalKind` ("transcript"|"status"|"error"). Decide only on that explicit kind (add `kind` to the recording-final payload and slot validator); delete the text sniffing from main.js. Keep a bounded equality check ("whole text === known sentinel"), never `includes/startsWith`.
- Why a bug: in-band signalling over user data; D-013 fixed the same class for the capsule (explicit `kind`) but this classifier was left.

**DM-02 · main.js:6439 + :6697 `clipboard.writeText(transcript)` before `tryPasteToFocusedField` → :5276 `acquireClipboardSnapshot` · the "original clipboard" snapshot is taken AFTER the app overwrote it · P1 · confirmed**
- Reproduce: copy "A", dictate with auto-paste, paste verified. `processPostStopTask` writes the transcript at :6439; `runPasteLadder` then snapshots (:5276) → snapshot holds the transcript; `scheduleSmartClipboardRestore` "restores" the transcript onto itself. "A" is gone. Same in `pasteLatestTranscriptFromShortcut` (:6697 then ladder).
- Consequence: the whole snapshot/refcount/restore machinery (:4860-5053, ~190 lines + the D-004 verification work) can never return the user's clipboard on the two production paths; every dictation destroys what they had copied. Comments at :4893 and :5269 claim the opposite.
- Fixed: take the snapshot first, exactly once per dictation (move `acquireClipboardSnapshot()` to the callers before their `clipboard.writeText`, pass it into the ladder), or delete the pre-writes since the ladder writes the text itself (:5278) and failure paths already leave it there.
- Why not intent: restore is explicitly designed to give the user's data back; with the pre-write it provably cannot.

**DM-03 · main.js:2965 `stopRecordingFromMainProcess` (:2975 `queryRendererRecordingState().catch(...)`, :3140 fallback `{recording:false}`) · a slow renderer is read as "not recording" · P1 · confirmed path, needs a >1 s renderer stall**
- Reproduce: capsule click / auto-stop fires while the renderer is busy ≥1 s (heavy finalize, GC, layout). `execRendererJsWithTimeout(...,1000)` returns the fallback `{recording:false}` → `snapshot.recording` false → the `: { ok:false, recording:false }` branch (:3002) → final `else` (:3045): `setRecordingStatus("Saved To App", OK)` + `resetRecordingStatusState()` → capsule hidden, monitor stopped (:2566), but the renderer is STILL recording.
- Consequence: recording continues with no capsule, no auto-stop, no dead-pipeline guard, and the UI says "Saved To App". The user cannot stop it from the capsule (hidden) and may speak sensitive content unknowingly.
- Current: `const snapshot = await queryRendererRecordingState().catch(() => ({ recording:false, recordingId:0 }));`
- Fixed: `execRendererJsWithTimeout` must return `null` on timeout for this caller (distinguish "no answer" from "answer: idle"); `null` → treat like the existing `!result` branch (:3011: "App Loading", keep monitor alive) and keep recording state, do not reset.
- Why not intent: the branch for "renderer did not answer" already exists one level down (:3011) and is bypassed by the fallback object.

**DM-04 · main.js:5472-5510 Windows `pwshSimple` fallback (`activateBlock`) · activation result discarded before SendKeys · P1 · confirmed**
- Path: VBS attempt fails (e.g. `AppActivate` false → `ERR:activate`, :5383-5385) → `activateBlock` runs `[W]::SetForegroundWindow($h) | Out-Null` (:5490, :5497) → `SendWait("^{v}")` regardless.
- Consequence: exactly the failure the comment at :5369-5381 and D-006 forbid ("a target that failed to activate must not have SendKeys fired — it would type into Transcriptor itself"); the text lands in whatever is foreground. D-006 fixed `activateAppByName/ByPid/ByHwnd` but not this fourth copy.
- Fixed: `$ok = [W]::SetForegroundWindow(...); if (-not $ok) { Write-Output "ERR:activate"; exit 2 }` before SendWait; better, delete the copy and call `activateCapturedPasteTarget` (already done at :5344) — the fallback adds only a duplicate of a rung that just failed.
- Why not intent: sibling copies were fixed for this exact reason.

**DM-05 · main.js:2760 `toggleRecordingFromShortcut` (`result === null` branch), :2684 `dispatchRendererTogglePress` · timeout abandons a press that may still execute · P1 · hypothesis**
- `executeJavaScript` is not cancelled by the 2 s race. If the renderer unblocks at 2.1 s it runs the toggle (starts a recording) after main already called `resetRecordingStatusState()` and returned: no capsule, no monitor, no paste-target capture, `shortcutToggleInFlight` released so the user's retry then STOPS the invisible recording they did not know started.
- Fixed: per-press token passed into the injected script (`if (window.__pressToken === expired) return`) or re-query `isRec` after timeout and reconcile (publish capsule/monitor if it turned out to be recording).

**DM-06 · main.js:9404 `ipcMain.handle("engine:install")` → :7537 `installGigaamEngine` · single-flight flag is set only after a 60 s await · P1 · hypothesis**
- `if (engineInstall.inFlight) return ...` (:7538) is checked first, but `engineInstall.inFlight = (async...)()` is assigned at :7558, after `await probeGigaamImportable(...)` (timeout 60 s, :7521-7552). Two invokes within that window (double click, two windows, StrictMode double effect) both pass the check, both `rmSync(staging)` and run two multi-GB `pip --target staging` into the same dir (:7594-7598) → corrupt engine-site that then gets the completion marker.
- Fixed: assign a sentinel (`engineInstall.inFlight = Promise...`) synchronously at function entry, or set `engineInstall.phase = PROBING` and test phase.

**DM-07 · main.js:394 `_useOneSpellingForUserDataDir` vs :397 `_relocateUserDataOffOneDrive` + :746 `appendMainLog` (`mainLogFilePath` cache) · main.log stays inside the OneDrive-synced folder · P1 · confirmed by code (Windows + OneDrive KFM)**
- Order of calls: spelling fix first (it always calls `appendMainLog` on its non-early-return paths, :369/:377/:388/:394; on win32 `legacyName "transcriptor"` ≠ `"Transcriptor"` so it does run) → `mainLogFilePath` is cached to `%APPDATA%\Transcriptor\main.log` (:746-747) → then the OneDrive re-home calls `app.setPath("userData", %LOCALAPPDATA%…)`. The comment at :315-318 says the log path "switches automatically… computed lazily" — false, it is cached.
- Consequence: the exact leak the re-home exists to prevent (:224-237): the log (which carries dictation previews, see DM-08) syncs to OneDrive cloud and conflicts; also `window-state.json`, `last_transcript.json`, `.venv`, engine-site resolve via different bases (DM-11).
- Fixed: run the OneDrive re-home first (it only touches env/paths), then the spelling migration; or reset `mainLogFilePath = ""` inside `_relocateUserDataOffOneDrive` after `setPath`. Add a unit test over the call order.

**DM-08 · main.js:5166-5170 `createTrace("paste", {textPreview})`, :6431-6435 `traceStep "transcript_ready" {preview}`, :6682-6694, `[paste-trace]` · dictated text is written to main.log · P1 · confirmed**
- Every paste logs up to 120-140 chars of the transcript plus a digest; error dialogs tell users to "send the log file to support" (:8788, :9033). 7 days / 50 MB of previews of everything dictated (passwords, medical, private chats) sit in plaintext and travel in support bundles.
- Fixed: log length + digest only (already present: `textLen`, `textDigest`); drop `textPreview`/`preview`, or gate behind the existing `TRANSCRIPTOR_RENDERER_TRACE_LOGS`-style debug switch, off in packaged builds.
- Why not intent: the same codebase carefully encrypts API keys and re-homes userData for privacy.

**DM-09 · main.js:8058 backend `exit` handler + :9173 `killBackendHard` + :7645 engine activation · restart depends on a non-null exit signal; code-0 exit is silent · P1 · hypothesis**
- `abnormalExit = code !== 0 || signal != null` (:8068). A backend that exits with code 0 outside shutdown (uvicorn graceful stop after SIGTERM, parent-watchdog `os._exit(0)`, someone `kill`ing it) takes the `else if (code===0)` branch (:8127): counter reset, no restart, no `backendBootError`, no UI. Dictation then fails with connection errors until app relaunch. The engine-install activation (:7645-7648, "killing the backend makes the exit handler respawn it") works only when the child dies by signal (uvicorn ≥0.29 re-raises) — a version-coupled side effect, and `killBackendHard` clears `backendRestartTimer` and sets `backend = null` first, so restart is only the exit handler's accident.
- Fixed: an explicit `restartBackend(reason)` (kill → await exit → startBackend) for planned restarts; in the exit handler treat ANY unexpected exit while `!isQuitting && !expectedKill` as restart-worthy.

### P2

**DM-10 · main.js:2096/2105 capsule + :8399 main window `page-title-updated` (`__recording_capsule_*`, `__app_shortcuts__`, `__app_record_toggle__`, `__app_reveal_recording__`) · document.title used as IPC · P2 · confirmed (known crutch #1, NOT fixed)**
- Seven verbs over a side channel. The comment at :8391-8398 claims the renderer "cannot use ipcRenderer … the canonical workaround", but preload.js exposes `contextBridge` invoke/send bridges (engine, paste-capability, recording-final, screen-mode:finish) to this very window; three of the four main-window verbs could be `ipcRenderer.send` like `recording-final`. The capsule can take a ~20-line preload with `contextBridge` too (sandbox allows preloads). Title bridge is lossy under coalescing (renderer restores the title in `setTimeout 0`; two sentinels in one tick; identical constant `__recording_capsule_stop__` title does not re-fire), needs 700 ms/80 ms guards (:486, :1955) and each side repeats prefixes (frontend/src/main.tsx:931 ↔ main.js).
- Fixed: add preload channels `shortcuts:message`, `record:toggle`, `recording:reveal` (validated with `event.sender === win.webContents` like :9513), capsule preload `capsule:stop|shot|pointer`; delete both `page-title-updated` handlers.

**DM-11 · main.js:945, :2258, :8028, :8476, :9666 vs :747, :3252, :6915, :7007, :7033, :7998, :8783, :9023 · data directory resolved two ways · P2 · confirmed**
- `process.env.TRANSCRIPTOR_DATA_DIR || app.getPath("userData")` in 5 places; bare `app.getPath("userData")` in 8 (main.log, last_transcript.json, engine-site, .venv, python-cache, legacy-venv guard, log paths shown to users). With the env var set (documented in .env.example/README as an override) the backend and window-state/staging/config reader use one directory and the log, last transcript, venv and engine live in another; the error dialogs print a log path that is not where the log is when `app.setPath` was used.
- Fixed: one `dataDir()` function (env override else userData) used everywhere in main.js, or call `app.setPath("userData", env)` once at boot and read only userData.

**DM-12 · main.js:1296 `getRendererProviderChoice`, :1307 `getRendererLocalModelChoice`, :1246 `normalizeProviderChoice`, :1255 `normalizeLocalModelChoice` · dead · P2 · confirmed**
- Zero callers outside their own comment (rg count). They also encode a second copy of the provider-group → wire mapping ("local-whisper"/"gigaam" → "local", default model `"small"`) and read `document.getElementById('providerSelect')` — a parallel source of truth the transcription catalog owns. Delete the four functions and the docblock reference at :1263.
- Same sweep, dead payload: `tone: presentation.tone` (:2174) is sent to the capsule but the capsule script never reads `state.tone`; `RECORDING_STATUS_CAPSULE.geometryPadding` is always 0 and its `pad` logic (:1451) never varies; `const cmdStarted` unused at :5351; the `win.on("closed")` cleanup (:8942-8950) tests `!win.isDestroyed()` which is false inside `closed`, so `removeAllListeners` never runs (ineffective "fix").

**DM-13 · main.js:1352 `RECORDING_STATUS_CAPSULE` vs :1782-1801 `emitGeometry`/`applyRecordingStatusCapsuleGeometryPayload` · capsule size has two sources, bridged by title · P2 · confirmed**
- Width is already derived from constants in main (`width` 110, `maxWidth = width+gap+icon`), and the same constants build the CSS; the DOM is then measured and its size sent back via `document.title` to resize the window. Until the first measurement `getRecordingStatusCapsuleWindowSize` returns 110 (`recordingStatusCapsuleGeometry` is nulled in `hideRecordingStatusCapsule` :2369), so the screen-mode pill (126 px) is clipped on the first frames of every screen take.
- Fixed: `size = recordingStatusCapsuleState.screen ? {w: maxWidth} : {w: width}`; delete the geometry channel and `recordingStatusCapsuleGeometry`.

**DM-14 · main.js:2394 `startRecordingStateMonitor` (180 ms, :2522), :3151 `waitForRendererRecordingStart` (80 ms), :2624 `waitForRendererUiReady` (120 ms), :6220 poll fallback (250 ms) · polling where the renderer can push · P2 · confirmed (known crutch #2)**
- The monitor evals 4 renderer globals ~5.5 Hz for the whole take and pushes each level to the capsule via a second `executeJavaScript`; the interval has no in-flight guard (a wedged renderer queues an unbounded number of pending evals every 180 ms, :2396-2414). Stale doc: :477-479 and :2396 call it the "1 Hz monitor". Start-confirm, ui-ready and the post-stop fallback are likewise loops on `executeJavaScript`; `recording-final` IPC proves a push channel already exists.
- Fixed: preload `send` for `recording-state {isRec, vu, rms, lastFrameAt, recordingId}` at ≤10 Hz from the renderer; main keeps only the dead-pipeline watchdog timer. Until then add `if (monitorProbeInFlight) return;`.

**DM-15 · main.js:6080-6424 `processPostStopTask` poll fallback, :6384-6392 `doneLike` (`state.status === "Done"|"Error"|"Idle"`, `statusLower === "upscaling"|"processing"`), :6136/:6225 `heardIpcSignal` · two paths for one decision + renderer vocabulary as string literals · P2 · confirmed (known: #2, D-013 residual, H-3)**
- Main and renderer ship in one bundle, so the "older renderer built before the bridge existed" the fallback serves cannot occur (and `recordingId <= 0` "legacy" handling at :5978, :6200, :6279 with it). ~250 lines of parallel logic read ~14 `__transcriptor*` globals and 6 DOM ids (`finalOutput`, `liveOutput`, `progressRow`, `autoTranscribeToggle`…), pinned by no type. `heardIpcSignal` is never reset, so one provisional followed by a renderer death sleeps the full `PASTE_POST_STOP_DEADLINE_MS` (H-3).
- Fixed: delete the poll, make the recording-final slot the only source; expire `heardIpcSignal` after the grace window.

**DM-16 · main.js:3375 `isBadActivationTarget`, :3392 `shouldUsePasteTarget`, :6611/:6707 + :3423 `pasteLastAccelerator`, :4004-4008 settle constants · same rule restated · P2 · confirmed**
- "Is this our own app" is two lists (exact names `electron|transcriptor|transcriptor helper`, helper substrings vs `pid === process.pid` + two names); hard-coded product name rather than `app.getName()`. `lastShortcutStatus?.paste?.active || …desired` appears three times though `pasteLastAccelerator()` exists. `WIN_ACTIVATION_SETTLE_MS` is also used for macOS (:4079) and `X11_ACTIVATION_SETTLE_MS` for Windows hwnd activation (:4166) — constants named for one platform used by another. Fixed: one `isOwnProcess(info)`, one accelerator accessor, rename/move the settle values into the PASTE_BUDGET table.

**DM-17 · main.js:5246-5263 `runPasteLadder` (`genericElectronTarget`) · "force global frontmost route" is dead — ends in `no-target` · P2 · confirmed**
- For a target named "Electron" the code sets `effectiveTarget = emptyCapturedPasteTarget()` "to force global frontmost route", then :5263 `!hasCapturedPasteTarget(effectiveTarget)` returns `{reason:"no-target"}` before any paste. Every paste into an app whose process is literally named Electron fails with "In Clipboard · No Focus". Fixed: when front is a safe foreign pid keep that pid; otherwise fall through to the explicit failure, and delete the dead comment/branch.

**DM-18 · main.js:4000-4170 Windows activators + :3781 helper, :5484-5498 inline blocks, :5858 `sendCommandEnterToFocusedApp` · four copies of `SetForegroundWindow` C# and per-call `Add-Type` · P2 · confirmed**
- The persistent helper at :3750-3822 exists because `Add-Type` costs 0.7-2 s; `activateAppByName`, `activateAppByPid`, `activateWindowsWindowByHwnd`, the pwsh paste fallback and auto-send (`Add-Type -AssemblyName System.Windows.Forms`) each still compile/load in a fresh PowerShell under a 5 s-class budget. The fallback's comment ":5461 lightweight PowerShell (no C# compilation)" is false (it `Add-Type`s). Fixed: one activation/keystroke verb on the persistent helper (extend `FRONT` protocol with `ACTIVATE <hwnd>`, `SENDKEYS`), delete the copies.

**DM-19 · main.js:9625 tray "Quit" `app.quit()`, :9380/:9378 signal paths · "one place that quits" is not · P2 · confirmed**
- `quitApp` (:1154) documents itself as the single call site; tray Quit, SIGINT/TERM/HUP handlers call `app.quit()` directly. Harmless today, but the log line `[main-window] quit requested` is missing for them and the lifecycle table cannot see them. Route them through `quitApp`.

**DM-20 · main.js timing literals outside the budget tables · P2 · confirmed**
- `scheduleSmartClipboardRestore` 400/200/1500 ms (:4993-4995), `guardedStopFromRecordingStatus` 12000 (:2937), `trackMainWindowInitialLoad` 15000 (:8248) vs backend health 60 000 (:8979), restart cap `8` literal (:8081) and 800/5000 backoff (:8088), pip `1800000` (:7599), health `250/2000` (:8166/:8204), capsule `80` pointer lock (:1956), AppleScript `delay 0.08` (:4197). The 15 s vs 60 s pair is a live defect: `showMainWindow` on a second-instance/tray click during a slow cold start waits 15 s then `presentMainWindow` shows an un-loaded dark window, defeating the "no blank window" design (:8968-8975). Fixed: named constants in one table; initial-load wait = backend health budget.

**DM-21 · stale comments · P2 · confirmed**
- `line 227`, `line 154`, `line ~5085` in :234-237/:310/:316 (the file moved by ~5000 lines); "1 Hz" (:477, :2396); "line numbers of main.js" in docs. Remove line numbers from prose; they have already rotted (CLAUDE rule: do not leave parallel/incorrect documentation).

**DM-22 · main.js:3049-3051 `stopRecordingFromMainProcess` `finally { clearCapturedPasteTarget() }` · paste target erased on a stale/failed stop · P2 · confirmed**
- On the `stale` branch (:3015) and the `!result` branch the recording keeps going, yet the captured target (the app the user started in) is wiped; the later real stop enqueues `target: pasteTarget` empty → `resolvePasteDestination` falls back to the current front, which is Transcriptor if the user stopped from its window → `no-target`. Fixed: clear only on the paths that enqueued or reset.

**DM-23 · main.js:9811-9818 `registerGlobalShortcuts` override fill-in; :9989 `handleShortcutBridgeMessage` update reject · P2 · confirmed**
- (a) A cleared `screen`/`screenShot` slot (empty string) is refilled from disk (`override.screen || screenFromDisk.screen`) so the user cannot unbind it live; also `readShortcutsFromConfig()` is invoked twice. (b) On `update` with empty record/paste the bridge returns at :9989-9992 without clearing `shortcutsSuspendedForCapture` or the failsafe → all hotkeys stay unregistered until the 120 s failsafe (:9757). Fixed: treat `""` as an explicit value for optional slots; on rejection call `restoreShortcutsAfterCaptureAbort("update-rejected")`.

**DM-24 · main.js:2214 `bindScreenShotHotkey`, :9940 status · P2 · confirmed**
- Screenshot-hotkey registration failure is only logged (`FAILED`) — the user in a screen take presses the key and nothing happens; status `screenShot.active` is always `""` and `error` empty so Settings cannot show it. Also `Alt+Down` bound system-wide for the whole take. Fixed: surface `{active,error}` for the slot after bind and notify (like `onWarning`).

**DM-25 · main.js:2163 `updateRecordingStatusCapsule` → `setBounds(recordingStatusCapsuleBounds())` + `screenMode.refreshLayout()` on every status/level update · P2 · confirmed**
- Runs at up to 5.5 Hz; `recordingStatusCapsuleBounds` re-reads `getCursorScreenPoint()` so on multi-monitor the capsule (and palette layout) jumps to wherever the cursor is, mid-take; native `setBounds` and layout recompute at tick rate. Fixed: compute bounds on show / display change only; level ticks only `executeJavaScript`.

**DM-26 · main.js:4917 `acquireClipboardSnapshot` / `releaseClipboardSnapshot` · depth counter without try/finally · P2 · hypothesis**
- Between acquire (:5276) and the return points there are ~12 `return`s each hand-releasing, plus awaited calls; a throw from `robustPasteScript`, `evaluatePasteOutcome`, `traceStep` etc. leaves depth > 0 forever and every later paste reuses a stale snapshot. Fixed: wrap the body in `try { … } finally { release unless already handed to the restore timer }`.

**DM-27 · main.js:8058/:8132 backend `exit`/`error` handlers · P2 · hypothesis**
- Both do `backend = null` without `if (backend === child)`. A late `exit` of a previous child (after the replacement spawned) nulls the live handle: `startBackend()` then spawns a second uvicorn, `killBackendHard` cannot reach the first. Fixed: capture `const child = spawn(...)` and guard.

**DM-28 · main.js:9499 `screen-mode:finish`, :9404 `engine:install`, :9449 `paste-capability:get-status`, :9470 `permissions:repair` · sender validation inconsistent · P2 · confirmed**
- Only `screen-mode:finish` and `recording-final` check `event.sender === win.webContents`; the other three handle from any sender/frame. Only the main window has the preload today, so no exploit, but the contract is not uniform. Put the check in one `handleFromMainWindow(channel, fn)` wrapper.

**DM-29 · main.js:10044 `whenReady … await startBackend()` · startup failure shows a bare modal and no window · P2 · confirmed**
- If `resolvePython`/`ensureBackendRuntime` throw at boot, the `.catch` (:10046) shows `dialog.showErrorBox` (win is null) and `applyWindowLifecycleEvent(startup)` never runs — the rich in-window error page with stderr tail and recovery poll (createWindow catch :9011) is unreachable at startup, only after a tray click. Fixed: don't await the backend here; let `createWindow` own the boot error UX.

**DM-30 · main.js:9301 `before-quit` · P2 · hypothesis**
- Quit (Cmd+Q/tray) during a recording or post-stop transcription tears everything down: `postStopQueue` dropped, backend SIGTERM, no confirmation or flush (renderer's spool may recover the audio, but the pending paste/transcript is lost). Fixed: when `isRendererRecording() || hasActivePostStopWork()` ask once ("Stop and discard / Cancel").

**DM-31 · main.js:2891 `toggleRecordingFromShortcut` screen branch + :9499 · screen-mode start/finish ordering · P2 · hypothesis**
- `screenMode.start` is issued only after `waitForRendererRecordingStart` (≤8 s) and `beginRecordingStatusSession`, while the renderer already holds the screen `recordingId`. A renderer stop that reaches `screen-mode:finish` before `start` is queued (capsule/autostop-stale during that window) gets `{error:"no-session"}` (controller :692), then `start` creates overlays for a take that is already over — nothing ends them until the next stop. Also `started.ok === false` only produces a trace line (:2895) with the renderer already in screen mode. Fixed: start the session before dispatching the screen toggle or have `finish` record a tombstone id so a late `start(id)` no-ops; surface the failure.

**DM-32 · main.js:5967 `_enqueuedRecordingIds`, :6069 `_pastedRecordingIds`, :8842 idle-gated clear · P2 · hypothesis (known crutch #4)**
- Idempotency is keyed on a renderer counter that resets per renderer instance, with the clear tied to `did-finish-load` + an "idle" heuristic. A reload while post-stop work is pending leaves old ids, and the next recordings 1..N are dedup-skipped with no status (capsule stays "Transcribing" because :2910 already published it and `enqueuePostStopTask` returns false). Fixed: include a renderer-session epoch (random, sent with every `recording-final` and toggle result) in the key; no clears needed.

**DM-33 · main.js hard-coded English UI strings (:2263 `SCREEN_MODE_WARNINGS`, :4534-4539/:4753-4762 dialogs, :8784-8797, :9112, status words "Saved To App", "Grant Access") · P2 · hypothesis**
- Main-process copy is not routed through the renderer's locale (README exists in two locales, users are bilingual). Move user-facing strings to one catalog (shared JSON like shortcut-defaults.json) or send keys to the renderer.

**DM-34 · main.js:292-299 `_relocateUserDataOffOneDrive` copyChild list · P2 · confirmed**
- Copies only config.json, .encryption_key, api_token.txt, known_archive_dirs.json, upscale_presets, recordings; omits `last_transcript.json`, `window-state.json`, `history`/DB files the backend keeps under the same dir, `screen-staging`. After re-home these look reset. List should be derived from backend/data_dir.py (SSOT) not retyped.

**DM-35 · main.js:2046 capsule `BrowserWindow` partition without permission handler · P2 · hypothesis**
- Only `win.webContents.session` gets `setPermissionRequestHandler`; the capsule partition keeps Electron's default (grant). The page is static data: today harmless, but a deny-all handler is one line.

---

## Clean places (looked for defects in each class, none found)

- Log infrastructure: `mainLogArchivePath`, `recoverOrphanRotatingLogs`, `pruneMainLogArchives`, `rotateMainLogIfNeeded` — rename sequences cannot delete, caps enforced at boot, newest archive preserved, clock-skew guarded. Sync append is deliberate and justified.
- `runCommand` (:6773): settle-once, bounded buffers, SIGKILL on timeout, tracked children killed on quit, UTF-16/BOM handled via child-io; no shell interpolation (args array). Windows PowerShell name escaping uses single-quote doubling; VBS name sanitising strips controls and doubles quotes; `pid` is integer-clamped everywhere it is interpolated into AppleScript/PS.
- `reveal-recording` handler (:8444-8535): `..`/separator rejection, `.txt` only, allow-listed roots with separator-boundary check, home anchor.
- Permission handlers (:8640-8667): origin-gated to the backend origin, clipboard-read denied.
- `startBackend` single-flight + nonce (:7905-8149, :8151): inflight checked before `backend`, restart timer absorbed, health verifies `boot_nonce`, per-request timeout, bounded body; D-018 counter reset present in both health paths.
- `killBackendHard`: Windows taskkill /T with fallback, POSIX SIGTERM→SIGKILL with sync escalation on `process.on("exit")`; before-quit clears restart/recover timers first.
- `pickBackendPort` fallbacks, `TRANSCRIPTOR_PORT` validation, `readPythonVersion` (no literal version).
- Window lifecycle: every show/hide/quit goes through `applyWindowLifecycleEvent` → `presentMainWindow`; no stray `win.show()` found (rg); bounds guard against self-triggered resize.
- Paste capability/TCC self-heal flow, once-per-boot reporting, throttle, single in-flight (:4402-4800) — no recursion path (`probePasteCapability` vs `probeAndRepairPasteCapability` separated).
- Windows front helper FIFO protocol (:3836-3925): push+write synchronous, timeout kills and restarts, late answers cannot mis-match.
- `saveLastTranscriptToDisk`/`loadLastTranscriptFromDisk`: tmp+rename in same dir, mtime-keyed cache, boot sweep with mtime floor.
- Post-stop worker accounting (:6008-6052): `pendingTranscriptionCount` decremented exactly once per task; catastrophic drain in finally.
- Capsule update sequencing (:2131-2204): `recordingStatusCapsuleUpdateSeq` supersession is consistent between update/hide; teardown timer re-checks status; windows destroyed on quit.
- Screen-mode wiring itself: single `onActiveChange` owner for hotkey/layer/flag, `endScreenModeForLostRenderer` called on navigation, render-process-gone (before clean-exit early return) — correct; `screenMode.teardown()` in before-quit; `isScreenSessionId` validated in the IPC handler; autostop excluded during screen take (:2458).
- Engine install gates/staging/swap + boot sweep (:7691): marker-gated promotion, retired tree best-effort cleanup — correct apart from DM-06.
- Power events (D-001), accessibility poll removal (D-009), `PASTE_SENT_PREFIX` single import (D-016), autostop reachable (D-012): closed, verified in code.
