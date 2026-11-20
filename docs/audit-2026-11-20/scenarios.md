# PRODUCT pass (SKILL §1(3)) — scenarios, seams, findings S-01…S-17
Revision audited: HEAD acbf737 (main, clean). Read-only; nothing run. Known/closed lists (BUGSAUDIT-2026-09-04 §6, docs/audit-2026-09-04) consulted; screen mode (1.6.6), CLI (1.6.5), window-lifecycle (1.6.4), TCC repair (1.6.3) postdate them, so most findings are new.

## A. Scenario walk-throughs (scenario → steps → files → verdict)

1. Record hotkey → capsule → stop → transcript → auto-paste
   - Alt+Left → main.js registerGlobalShortcuts (≈9795) → toggleRecordingFromShortcut (2724) → dispatchRendererTogglePress (2680, one executeJavaScript round trip) → renderer `transcriptor-hotkey-toggle` → startLive (main.tsx 11322) → main waits waitForRendererRecordingStart, captures paste target (setCapturedPasteTarget) → capsule (updateRecordingStatusCapsule) → stop press → renderer stopLive → `recording-final` IPC → recording-final-slot → enqueuePostStopTask (5969) → processPostStopTask (6080) → clipboard + tryPasteToFocusedField (paste-capability.js) → "Paste Sent".
   - Verdict: works; two owners of "can a recording start now" (main blocks hotkey while post-stop work is active, renderer's own isBusy guards the button; see seam table); a second transcript-finality path (poll) is kept next to the IPC one (S-13).
2. Screen mode (Option+Right … stop)
   - Alt+Right → toggleRecordingFromShortcut("screen") (main.js 2724) → startDetail{mode:"screen", screenSessionId} → renderer startLive(request) sets liveScreenSessionId (main.tsx 11335) → recording confirmed → beginRecordingStatusSession → `screenMode.start(id)` (main.js 2891) → controller.startNow (screen-mode-controller.js 647): mkdir staging, helper spawn (CGEventTap), overlay per display, palette → onActiveChange(true) (main.js 2282): bind Alt+Down, capsule raised.
   - drawing: helper stdout → onHelperLine (529) → beginStroke/extendStroke → queueOp → overlay canvas (16 ms batched executeJavaScript).
   - shot: capsule title channel `__recording_capsule_shot__` (main.js 2091) / Alt+Down → takeShotNow (586): screencapture -R per display with strokes → overlay.__composite → events.json.
   - stop: ANY stop path → renderer stopLive → finishScreenSession (main.tsx 9608) → IPC `screen-mode:finish` (main.js 9499) → finishNow (692): final shot if strokes pending, teardown, manifest. Save → `/api/recordings/save-with-audio` with screen_session_id → backend save (main.py 8046) → screen_sessions.adopt_session (screen_sessions.py 128) moves staging → `<stem>.screens/`, rewrites events.json, adds audioStartedAt → marks placed by annotateTranscript (screen-annotations.ts) → pasted + saved → History strip (showRecordingViewerScreens main.tsx 7826).
   - Verdict: happy path coherent; failure/interruption paths broken: S-01 (reload/crash/quit mid-take), S-02 (stop before session exists), S-03 (permission blind), S-04 (silent start failure).
3. Upload → job → transcript → archive
   - renderer upload queue (main.tsx ≈15060): local → /api/jobs(+from-path) → JobStore (jobs.py, 2 workers shared with CLI) → poll → saveRecordingText(collection uploads) → backend `_save_recording_audio_source` → retention (age 7 d). Remote → /api/remote/jobs.
   - Verdict: OK. Fake stage timer already known (U/K-2). History audio fetched whole as Blob (S-15).
4. History: open / play / re-transcribe / delete all
   - openRecording (main.tsx 8656) → GET /api/recordings/{name} (payload incl. screens, screens_manifest) → audio fetched as Blob → strip. Re-transcribe (≈9060-9160): Deepgram REST → local fallback → screenMarksForSavedRecording(archived manifest) → annotateTranscript(durationMs) → saveRecordingText. Delete all: DELETE /api/recordings → _delete_all_recordings_sync (main.py 7600).
   - Verdict: marks kept on re-transcribe (CHANGELOG claim holds, code path verified). Delete-all leaves screenshots on partial failure (S-06). No single-recording delete exists (only delete-all) — noted, not a defect.
5. Settings: shortcuts (4 slots), providers/keys, models, autosave
   - capture-start → main unregisterRegisteredShortcuts → keyEventToAccelerator (main.tsx 6205) → duplicate check by raw string (6458) → publishShortcutUpdateToMain → bridge "update" → registerGlobalShortcuts(override) (main.js 9795). Screenshot key re-bound while a take runs (9884) — handled.
   - Verdict: works; status reporting for slot 4 blind (S-09), renderer polls a pushed value (S-10), later re-registers re-read disk (S-11).
6. CLI client vs running app
   - `transcriptor` wrapper (cli_access.py render_posix_wrapper) → backend/cli.py → connection.json → CLI token (cli_token_may_call whitelist, main.py 1514) → /api/jobs/from-path → JobStore → poll 0.5 s → /download → optional save-from-path.
   - Verdict: works; token scope wider than documented on save-from-path (S-07); wrapper never refreshed (S-08).
7. App lifecycle
   - launch (whenReady → startBackend → health → loadURL), Dock/activate → window-lifecycle.js decideWindowAction (pure table; consistent), close=quit (main.js 8905 → before-quit 9301: screenMode.teardown, backend kill), sleep/resume (subscribePowerEvents → reclaimShortcuts + system-suspend), renderer crash (render-process-gone 8697 → endScreenModeForLostRenderer + state reset), backend crash (exit handler 8058: backoff restart ≤8, token persisted so the renderer survives).
   - Verdict: lifecycle table is coherent; interruption of a screen take loses its screenshots (S-01); close=quit has no in-flight guard (S-14).
8. Permissions (mic, accessibility, screen recording, TCC repair)
   - mic: requestMacMicrophonePermissionOnce; accessibility/automation: paste-capability.js TCC_SERVICE {Accessibility, AppleEvents} + tccutil reset; screen recording: only `getMediaAccessStatus("screen")` at take start (main.js 2301) — no repair, not-determined/stale-grant not handled (S-03).

## B. Seams table

| Seam | Mechanism checked | Result |
|---|---|---|
| screen mode + record hotkey pressed | toggleRecordingFromShortcut: a press during a recording stops it whatever the mode; stop → renderer stopLive → finish IPC | OK (stop is single path). |
| screen hotkey pressed during voice recording | same rule: it stops the voice take, does not start screen mode | OK, by documented rule. |
| stop arrives before screenMode.start runs | stop = capsule/UI button/dead-pipeline failsafe (bypass shortcutToggleInFlight); finish("no-session") then start runs | BROKEN → S-02 |
| screen mode + renderer reload / crash / quit | did-start-navigation + render-process-gone → finish; before-quit → teardown | session ended, screenshots stranded → S-01 |
| recording while post-stop paste runs | main blocks hotkey start while pendingTranscriptionCount/queue/worker (main.js 2808); button path asks renderer only | two owners; hotkey silently shows "Transcribing" for up to PASTE_POST_STOP_DEADLINE_MS=32 s; no finding beyond that (intended single-capsule rule) |
| two recordings racing the one capsule | recordingId dedup sets (enqueuedRecordingIds/pastedRecordingIds), single worker | OK |
| retention deleting media of a recording open in History | viewer already holds Blob; re-open → 404 → "Could not open"; screens ranked separately from audio | S-05 (separate ranking); no crash |
| shortcut change during screen mode | registerGlobalShortcuts unregisters all, re-binds shot key if isActive (main.js 9884); capture-start unregisters record key for up to 120 s so the take cannot be stopped by hotkey meanwhile (capsule still can) | OK; note only |
| upload + live recording | upload jobs use JobStore pool (2); live local fallback uses /api/transcribe-sync (default executor) | no queueing conflict; CPU contention only (not a defect) |
| CLI job + live recording | CLI jobs share the 2-worker JobStore with Upload tab | OK; a CLI + 2 uploads queue behind each other (by design) |
| app quit mid screen take | before-quit teardown (sync), staged folder kept, swept after 24 h | S-01 |
| backend restart | token persisted (api_token.txt), same port normally; renderer not reloaded | OK (port shift would strand the page: not reproduced, not filed) |
| CLI writes to archive while History open | History list not refreshed by backend events | not filed (no event channel exists; refresh on view switch) |

## C. Findings

### S-01 · P1 · confirmed — A screen take cut short (renderer reload/crash, app quit) is recovered as a plain Live recording; its screenshots are stranded and swept after 24 h
- Where: desktop/main.js:2316 `endScreenModeForLostRenderer` (comment promises "the backend's recovery sweep owns them from then on, exactly like the take's audio spool"); backend/main.py:1353 `_promote_live_recovery` (collection from `recording_collection or meta…`), :6121 `promote_live_recovery` (`payload.get("recording_collection") or "live"`); frontend/src/main.tsx:5126 `recoverBackendAudioSessions` (body hard-codes `RECORDING_COLLECTIONS.live`), :5811 live-draft snapshot (`recording_collection: RECORDING_COLLECTIONS.live`), :6003 draft recovery; backend/screen_sessions.py:169 `sweep_orphan_sessions` called from main.py:1066.
- Gist: the WS open records the right collection in the recovery meta (main.tsx:11474 `liveRecordingCollection(liveRecordingMode)` → main.py:4264), but the promote endpoint defaults the body value to "live" and the renderer always sends "live", so the meta is never consulted; and nothing in the recovery path knows `screen_session_id`, so `adopt_session` is only reachable from the normal save.
- Reproduce: Option+Right, draw, take a shot, speak 20 s, then Cmd+R / kill the renderer / Cmd+Q. Relaunch: a "Recovered …" entry appears under Live Capsule with audio, no `.screens`, no marks; `<data>/screen-sessions/screen-…` is deleted by the next recovery sweep after 86400 s.
- Consequence: user-made material (screenshots with their drawings) is silently deleted a day later, while the audio spool of the same take IS kept and promoted — the opposite of PRODUCT.md "one archive entry, one retention rule", and of the docstring in screen_sessions.py (module header: "ages out … the same window the audio spool of such a take is kept for" — the spool is kept forever once promoted, the screenshots are not).
- Current code:
  ```
  # backend/main.py:6121
  recording_collection = str((payload or {}).get("recording_collection") or "live").strip()
  # main.tsx:5126
  recording_collection: RECORDING_COLLECTIONS.live,
  ```
- Fixed code: endpoint `recording_collection = str((payload or {}).get("recording_collection") or "").strip()` (empty → meta wins, which `_promote_live_recovery` already implements); renderer stops sending a literal and sends nothing (or `liveRecordingCollection(...)` for the draft snapshot at :5811/:6003); the WS open stores `screen_session_id` in the recovery meta and `_promote_live_recovery` calls `screen_sessions.adopt_session(DATA_DIR, sid, target_dir, stem, audio_started_at=meta started_at)` before it discards the spool.
- Explanation: one owner of "which collection / which session does this audio belong to" — the recovery meta — instead of three (meta, endpoint default, renderer literal).
- Why a bug: the meta field exists exactly to carry this and the fallback expression `recording_collection or meta.get(...)` is dead because the left operand is never empty; the draft snapshot even disagrees with the final save in the same file (`liveRecordingCollection(mode)` at :11987 vs `.live` at :5811).

### S-02 · P1 · confirmed (narrow window) — A stop that lands before `screenMode.start` runs leaves an orphan screen session nobody will ever finish
- Where: desktop/main.js:2891 `toggleRecordingFromShortcut` (screenMode.start is called after `await frontAtHotkeyPromise` and `await beginRecordingStatusSession()`, i.e. 0.3-1.5 s after the renderer confirmed the take); desktop/screen-mode-controller.js:692 `finishNow` (no session → `{ok:false,error:"no-session"}`), :647 `startNow` (`if (session) return {ok:true,id:session.id}` — returns the OLD id, caller ignores it).
- Reproduce: Option+Right, then immediately click the capsule (stop path `__recording_capsule_stop__` → guardedStopFromRecordingStatus bypasses shortcutToggleInFlight) or the in-window Stop. Renderer stopLive → finish(id) → "no-session" → manifest null; THEN main's pending `screenMode.start(id)` runs: red frame, palette, CGEventTap and Alt+Down binding appear for a take that no longer exists. The next screen take: `start(newId)` returns ok with the old session; renderer's finish(newId) → "session-mismatch" → no marks; the stale session keeps drawing until the app quits.
- Consequence: full-screen overlay + mouse tap stuck on; screenshot key stolen; next take's marks lost.
- Current code:
  ```
  // controller 693-698
  if (!session) { return lastManifest && (!id || lastManifest.id === id) ? {ok:true, manifest:lastManifest} : {ok:false, error:"no-session"}; }
  // controller 648
  if (session) return { ok: true, id: session.id };
  ```
- Fixed code: the controller remembers finished/cancelled ids: in `finishNow` with an `id` and no session add `id` to a `retired` Set; in `startNow(id)` `if (retired.has(id)) return {ok:false, error:"retired"}` and if `session && session.id !== id` return `{ok:false, error:"busy"}` (main logs/handles the non-ok, see S-04). Or main starts the session before it awaits the front-app lookup.
- Explanation: the stop/start ordering of two async owners (renderer-driven finish, main-driven start) is made explicit in one place.
- Why a bug: `finishNow` already treats an id-mismatch as an error, so the "stop first" order is a recognised-but-unhandled state; the serialize chain orders calls but not intent.

### S-03 · P1 · hypothesis — Screen Recording permission: "not-determined" and a stale grant produce wallpaper-only screenshots that are recorded as real
- Where: desktop/screen-mode-controller.js:665-669 `startNow` (warns only on "denied"/"restricted"), :614-618 `takeShotNow` (regex on screencapture failure — but the file's own comment says macOS does not fail, it returns the wallpaper), desktop/paste-capability.js:384 `TCC_SERVICE` / :390 `PERMISSION_REPAIR_SERVICES` (Accessibility, AppleEvents only), main.js:2301 `screenCaptureAccess`.
- Reproduce: fresh install / after an ad-hoc re-sign (the 1.6.3 stale-grant class): `getMediaAccessStatus("screen")` is "not-determined" or "granted" while the grant is stale; take a shot → PNG of the desktop picture without windows; shot is recorded with `files:[path]`, mark `[📸 00:15 скрин 1: /…/shot-01.png]` and pasted to an agent.
- Consequence: user and downstream agent are handed screenshots of nothing, with no notice; the app that repairs the same defect for paste leaves it unrepaired here.
- Current code: `if (captureAccess === "denied" || captureAccess === "restricted") deps.onWarning("screen-recording");`
- Fixed code: treat anything but "granted" as a warning at start (not-determined included, and trigger the prompt once via a real capture), add `ScreenCapture` to `TCC_SERVICE` + repair table, and verify a capture by comparing it with a capture of a known own window (the content-protected overlay is excluded; use a one-pixel probe window) — or at least refuse to list a file as a screenshot when the probe says "wallpaper only".
- Why a bug: the code's own comment states the failure mode and then handles only the case that cannot occur. Hypothesis: macOS behaviour not executed here.

### S-04 · P2 · confirmed — Screen-mode start failure is swallowed; the renderer has already committed the take to the Screen Sessions collection
- Where: controller 654-661 `startNow` (try/catch logs and falls through to `return {ok:true}`); main.js:2891-2895 (only traces `started.ok`); main.tsx:11335 (`liveRecordingMode` decided before main answers); backend main.py:3156 (Screen policy keeps audio of newest 5).
- Reproduce: helper missing/crashing at spawn (ENOENT after isSupported()), overlay `loadURL` rejects. User sees no frame/palette; recording is saved as screen collection → audio kept for five takes only (Live keeps 100).
- Consequence: silent downgrade of retention + a mode that is "on" in the renderer and off on screen.
- Fix: `startNow` returns `{ok:false,error}` when overlays/helper fail (and tears down); main shows the existing `onWarning` notification and tells the renderer to demote (`liveRecordingMode="voice"`) — one owner of "is this a screen take": main, communicated back.
- Why a bug: `ok:true` after a caught failure is an error turned into success (§2 errors).

### S-05 · P2 · confirmed — Retention ranks `<stem>.screens` by the directory's own mtime and the audio by the file's, so "the same rule" is two counts
- Where: backend/main.py:3536-3548 `_prune_recording_screens` (`entry.stat().st_mtime` of a directory) vs :3466 (`entry.stat().st_mtime` of the audio) fed to `_beyond_retention_policy`.
- Reproduce: Finder opens an old take's `.screens` folder and writes `.DS_Store` (or the user deletes a file) → its dir mtime becomes "newest"; with six takes the screenshots of the 2nd-newest audio can be collected while an old take's screenshots survive; audio and screenshots of one recording then diverge.
- Consequence: History row with audio but no strip (or the reverse), contradicting the "one retention rule" contract (PRODUCT.md; module docstring "never by a second count").
- Fix: rank screens with the mtime of the recording's audio/text (`screens_stem(entry)` → sibling audio), i.e. compute one list of recordings and prune both media from it.
- Why a bug: the docstring says "same ranking"; the implementation reads a different timestamp source.

### S-06 · P2 · confirmed — Delete-all removes the text first, screenshots second with `ignore_errors=True`, and counts the recording deleted either way
- Where: backend/main.py:7600-7625 `_delete_all_recordings_sync` (`p.unlink()` then `shutil.rmtree(screens, ignore_errors=True)`); retention only prunes `.screens` that have a text stem (:3540).
- Reproduce: a locked/permission-denied file in a `.screens` folder, or a crash between the two calls → the text is gone, the folder can never be collected again (no text stem) and "Deleted N recording(s)" reports success.
- Consequence: after "Delete all" sensitive screenshots remain on disk indefinitely, silently.
- Fix: remove screens before the text (rollback like the audio backup), or count a failed rmtree into `failed`; add an orphan sweep for `.screens` without text.
- Why a bug: the same function already implements backup/rollback for the audio and logs failures; the screenshots got neither.

### S-07 · P2 · confirmed — The CLI token may call `save-from-path` with the full body: `archive_dir`, `name`/`require_existing`, `recording_collection`
- Where: backend/cli_access.py `_CLI_ROUTES` (`POST /api/recordings/save-from-path`), backend/main.py:8133 `save_recording_from_path` (passes every field through), :3030 `_resolve_recordings_target_dir` (any path under $HOME), :8068 `_register_archive_dir`.
- Reproduce: with the CLI token POST save-from-path `{source_path:<any .wav>, archive_dir:"~/Music", name:"<existing recording>.txt", require_existing:true}` → overwrites an existing History entry's text/audio, or registers `~/Music` as an archive dir that the retention sweeper then prunes (audio with a sibling same-stem .txt beyond the Live count of 100).
- Consequence: the documented scope ("opens only the transcription routes … cannot read or write the config, … the archive") is exceeded; the real client only ever sends source_path/title/transcript/provider/model/language/consume.
- Fix: for a CLI-token request, `_require_api_auth` (or the handler, via a flag on `request.state`) strips/rejects `archive_dir`, `name`, `require_existing`, `recording_collection`; collection fixed to uploads.
- Why a bug: capability granted beyond the one the token exists for; a same-user agent can read the data anyway, hence P2.

### S-08 · P2 · hypothesis — The CLI wrapper embeds interpreter + script paths at enable time and is never refreshed
- Where: backend/cli_access.py `_write_wrapper` (only from `enable`), backend/main.py:864-865 (`load()` at boot restores the token, `sync_connection` rewrites only connection.json).
- Reproduce: enable CLI from a dev checkout, then run the packaged app (or move/reinstall the app so `sys.executable` / `cli.py` change): `transcriptor …` → "No such file" from the stale `exec`, while the CLI section still says enabled.
- Consequence: agent-facing install silently dead; the card shows a command path that exists but points nowhere.
- Fix: at boot (and in `sync_connection`) compare the rendered wrapper text with the file and rewrite on difference — the render function is already pure.
- Why a bug: state derived from the running app (interpreter, script) is stored once and never re-derived; contradicts the module's "the switch is the presence of the file" invariant only if the file is wrong.

### S-09 · P2 · confirmed — A screenshot hotkey that another app owns is never reported
- Where: desktop/main.js:2214 `bindScreenShotHotkey` (logs "FAILED" only), :9946-9951 (status `screenShot:{active:"", error: screenSupported ? "" : "unsupported"}`), frontend/src/main.tsx:6325 (`const active = id === "screenShot" ? !entry.error : !!entry.active`).
- Reproduce: set Screenshot to a combo another app has registered; start a take; press it → nothing; Settings shows no conflict badge at any time.
- Consequence: the one key the user presses mid-dictation can be dead with no sign.
- Fix: `bindScreenShotHotkey` probes `globalShortcut.isRegistered`/register result at settings-update time (register+unregister) and puts the real `error` in `status.screenShot`; the renderer special-case disappears.
- Why a bug: the rule "slot 4 has no meaningful active" is restated in renderer and main instead of the status carrying the fact.

### S-10 · P2 · confirmed — Polling where an event exists: shortcut status is pushed into a window global and polled every 2 s
- Where: desktop/main.js:9958-9963 (`executeJavaScript("window.__transcriptorShortcutStatus = …")`), frontend/src/main.tsx:6355 `_shortcutConflictPoll` (gated, 2000 ms), :6294 `refreshShortcutConflictState`.
- Consequence: up to 2 s stale conflict badge; a second channel for a fact main already emits at the moment it changes. Gated, so cost is small — P2.
- Fix: main sends the status on the preload event bridge (as `system-suspend` is sent) and the renderer repaints on receipt; drop the poll.

### S-11 · P2 · hypothesis — Hotkeys re-registered after an override are re-read from disk, so an unsaved change silently reverts
- Where: desktop/main.js:9805-9815 (`override` used once; no in-memory copy), :9751 `readShortcutsFromConfig` (parses backend's private `preferences.ui.shortcut_*` keys), power-event `reclaimShortcuts: () => registerGlobalShortcuts()` (:10036), `restoreShortcutsAfterCaptureAbort`.
- Reproduce: change a shortcut while the /api/config save fails or is still debounced (backend restarting), then sleep/resume: the old accelerator is re-registered, Settings still shows the new one.
- Fix: keep `activeShortcuts` in main as the only runtime truth, updated by the bridge; disk only seeds it at boot.
- Why a bug: two sources for the runtime accelerator (override vs disk) with no reconciliation; plus the desktop parses a schema the backend owns (B-057 family).

### S-12 · P2 · confirmed — The data-directory rule is restated five times in desktop/main.js
- Where: main.js:945 `mainWindowStatePath`, :2258 `screenModeStagingRoot`, :8028 child env, :8476, :9666 `readShortcutsFromConfig` — each `process.env.TRANSCRIPTOR_DATA_DIR || app.getPath("userData")`; user-data-dir.js already exists as the module for this rule.
- Fix: one `dataDir()` in user-data-dir.js, five call sites use it. The staging path the backend must equal (screen_sessions.staging_root) hangs on all five staying identical.

### S-13 · P2 · hypothesis — The post-stop finality has two owners (IPC slot and a 250 ms executeJavaScript poll) and the poll exists for a renderer that cannot occur
- Where: desktop/main.js:6080-6370 `processPostStopTask` (`POST_STOP_IPC_GRACE_MS = 2000`, "an OLDER renderer — one built before the bridge existed") — main and renderer ship in one bundle; no skew is possible. The poll also starts after 2 s of IPC silence even when the renderer is legitimately still finalising (envelope wait up to ~4 s, recovery up to 20 s per the file's own comments), so it runs exactly when the comment says it should not.
- Fix: delete the legacy poll and `recordingId <= 0` branches or gate them on a real failure signal; one owner (recording-final-slot).
- Hypothesis: depends on whether the renderer emits a provisional signal inside the grace window (not verified end to end).

### S-14 · P2 · hypothesis — Close = quit with no guard while a take, a post-stop transcription, an upload queue or a screen take is in flight
- Where: desktop/window-lifecycle.js `decideWindowAction` (mainWindowClose → quit, rule 4), main.js:8905 `win.on("close")`, :9301 `before-quit` (kills backend, teardown).
- Reproduce: Cmd+W while the Upload tab runs or a recording is being transcribed: everything stops, backend killed; only the audio spool is recoverable (S-01 for screenshots).
- Fix: on the close event, if `hasActivePostStopWork() || recording || uploads running || screenMode.isActive()` confirm or minimise instead; contract rule 4 stays for the idle case.
- Hypothesis: contradicts a stated product decision only in the in-flight case.

### S-15 · P2 · confirmed — History fetches a recording's whole audio into memory as a Blob to play it
- Where: frontend/src/main.tsx:2583 `fetchSavedAudioFromBackend` (`await audioResp.blob()`), used by `openRecording` (:8690) — uploaded media audio can be hundreds of MB.
- Fix: stream via a `<audio src>` pointing at a short-lived signed URL (or a cookie-less token query limited to this route), keep the File fetch only for re-transcribe.

### S-16 · P2 · hypothesis — Marks pasted into the target app are hard-coded Russian and carry absolute paths that the retention later deletes
- Where: frontend/src/screen-annotations.ts:107 `regionWords`, :135 `screenMarksFromManifest` ("линия", "скрин", "не сохранён"); retention main.py:3156 (newest 5).
- Consequence: an English dictation gets Russian bracket marks; a transcript saved in History (`.txt` kept forever) points at files removed after five takes, with nothing in it saying so.
- Fix: language from the take's language setting (one table in ui-copy.ts) and a note in the archived transcript header when `.screens` is collected (retention writes `screens: removed`).
- Hypothesis: may be intended for a Russian-first product.

### S-17 · P2 · confirmed — Stale/duplicated statements of the Screen retention rule
- Where: backend/main.py:3073 comment ("the desktop shell … keeps the same newest-N count" — the desktop keeps nothing since screenshots moved to the backend), frontend/src/main.tsx:380 ("the backend keeps the audio of the newest five" — literal duplicate of an env-tunable count `TRANSCRIPTOR_SCREEN_AUDIO_KEEP_COUNT`), screen-mode.js header ("Nothing here deletes a session…" is current). 
- Fix: delete the two comments, point at `AUDIO_RETENTION_POLICIES`; PRODUCT/CHANGELOG state "five" as the default only.

## D. Places where no defect was found (proof of coverage)
- window-lifecycle table vs capsule/activate: consistent; tests exist.
- screen-mode `serialize` chain: start/shot/finish are ordered; shot index computed inside the chain; `shotFileName` collision-free.
- Screen-session id/names: contract file + three suites; backend `SCREENSHOT_NAME_RE` rejects path traversal in `screenshot_path`.
- Display hot-plug: overlays created/destroyed under watchDisplays; destroyed-window guards present.
- adopt_session: move + rehome + atomic manifest write; re-save replaces folder.
- recordingId double-paste guards (enqueue + paste) sound; renderer reload resets state (8697-8760).
- CLI auth: constant-time compare, route whitelist 403 vs 401, token file 0600; polling is client-side by HTTP necessity.
