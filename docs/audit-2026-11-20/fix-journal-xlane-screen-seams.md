# Fix journal — cross-domain lane "screen-seams" (2026-11-20)

Branch `worktree-agent-ad996ef2a89b4d235`, cut from `main` at 3cc7666. Screen mode's
cross-process seams (review D1–D3, S-02/S-04, M3, FL-12/S-01) and the coordinator's
"screen surfaces appear at once" requirement.

Before-evidence method (desktop): a copy of `desktop/` with the HEAD versions of
`screen-mode-controller.js`, `screen-session-start.js`, `main.js`, `preload.js` and the old
`SCREEN_MODE_WARNINGS` table (as a stand-in `screen-mode-warnings.js`), running the NEW tests.

## Step 1 · D1, D2, D3, S-02 / DM-31, S-04 / DX-08, FL-12 / S-01 (renderer half)

Files: `desktop/screen-mode-controller.js`, `desktop/screen-mode-warnings.js` (new),
`desktop/screen-session-start.js`, `desktop/main.js`, `desktop/preload.js`, `desktop/package.json`
(build.files), `frontend/src/take-collection.ts` (new), `frontend/src/main.tsx`,
`PROJECT_STRUCTURE.md`; tests `desktop/screen-mode-controller.test.js`,
`desktop/screen-mode-warnings.test.js` (new), `desktop/screen-session-start.test.js`,
`desktop/ipc-contract.test.js`, `desktop/screenshot-hotkey-status.test.js`,
`frontend/tests/take-collection.test.ts` (new).

- **D1** — the controller exports `SCREEN_MODE_WARNING` (start-failed, accessibility,
  screen-recording, helper, capture-failed) and raises only those constants. The one copy table
  is `desktop/screen-mode-warnings.js` (keyed by the imported constants + main's own
  `screenshot-hotkey`); main.js's `SCREEN_MODE_WARNINGS` is gone and `notifyScreenModeWarning`
  reads `screenModeWarningCopy(kind)`. Copy added for `helper` ("Screen mode stopped drawing")
  and `capture-failed` ("A screenshot could not be taken"). Test: every exported kind has copy,
  AND every warning any controller test actually raised has copy (checked in each test's cleanup).
- **D2** — one owner of the failed-start notification: the controller. Every failed start warns
  (including `unsupported`, which used to answer silently), and `start()` never rejects (an
  unexpected throw is a warned FAILED). `toggleRecordingFromShortcut` no longer calls
  `notifyScreenModeWarning`.
- **D3** — `start()` answers `{ ok, outcome }` with `SCREEN_START_OUTCOME` STARTED / ENDED /
  FAILED. ENDED (the take's stop reached the controller first) is not a failure: no warning, no
  renderer notice. One mechanism for "this take already ended": the controller's ended-id
  tombstone. Main's `END_ORPHAN` re-ask of the renderer (cb31c13) is removed; the tombstone is fed
  by every way a take ends — the renderer's `screen-mode:finish` (every stopLive of a screen take
  calls it) and main's `endScreenModeForLostRenderer`, which now names the id.
- **S-02 / DM-31** — `screenMode.start()` is called as soon as the renderer confirms the take,
  before `await frontAtHotkeyPromise` and `await beginRecordingStatusSession()`; its answer is
  read after them. `endScreenModeForLostRenderer` passes the take's id (`screenTakeId`, kept by
  main from the start until the take's finish / a non-started outcome / renderer loss), with or
  without a live session, so a start still on its way is refused.
- **S-04 / DX-08** — on FAILED main sends `screen-mode:voice-take {screenSessionId}` to the main
  window; preload `onScreenVoiceTake` (fixed channel, fresh payload, unsubscribe returned); the
  renderer (`subscribeToScreenVoiceTake`, HMR-safe like `subscribeToSystemSuspend`) demotes the
  take via `liveTakeAfterVoiceTakeNotice` (only the take it names). The channel is main→renderer
  only, so there is no renderer sender for `isFromMainWindow` to check; main sends only to
  `win.webContents`. Channel added to `ipc-contract.test.js`.
- **FL-12 / S-01** — `buildLiveDraftPayload` sends `liveRecordingCollection(liveRecordingMode)`;
  `recoverLiveDraftIfAny` files the draft by `recordingCollectionFromDraft(draft.recording_collection)`;
  `recoverBackendAudioSessions` sends `recoveryPromoteBody(archiveDir)` (no collection — the sidecar
  decides); the `/ws/transcribe` query carries `screen_session_id` for a screen take.
  `RECORDING_COLLECTIONS` / `liveRecordingCollection` moved from main.tsx to `take-collection.ts`.
- Backend half verified by reading: `ws_transcribe` passes `qp.get("screen_session_id")` to
  `_open_live_recovery` (main.py ~4510), which stores only a valid id; `_promote_live_recovery`
  adopts `meta["screen_session_id"]` and defaults the collection to the sidecar's. Covered by
  `test_screen_sessions.py` `CrashedScreenTakeRecoveryTests` (sidecar stores the id, rejects an
  invalid one, promotion adopts the screenshots into Screen Sessions, the route without a
  collection lets the sidecar decide). No backend test added; backend untouched.

Check: `node --test desktop/screen-mode-controller.test.js desktop/screen-mode-warnings.test.js desktop/screen-session-start.test.js desktop/ipc-contract.test.js`

Before (old code, new tests): `tests 37, pass 18, fail 19`, among them
`the controller raised "helper", which has no copy for the user`,
`the controller raised "capture-failed", which has no copy for the user`,
`a stop that reaches the controller before its start wins` (ENDED shape, no warning),
`a start on a machine without the helper fails, warned` (old: silent `unsupported`),
`a start that throws on the way resolves FAILED and warns, it never rejects` (old: rejected),
`a take that ended before its session started is ENDED, not a failure (D3)`,
`main does not notify a failed start itself…`, `main starts the session before the awaits…`,
`a lost renderer retires its take by id…`, `screen-mode:voice-take is sent by main…`.
After: all pass. Frontend before: HEAD main.tsx sent `RECORDING_COLLECTIONS.live` at three
draft/promote sites (5185, 5870, 5976) and no `screen_session_id` — the wiring cases of
`take-collection.test.ts` fail on it.

Full suites after step 1: desktop `tests 437 pass 437`; `node --check` main/preload OK;
frontend typecheck OK, lint OK, vitest `48 files, 609 tests passed`, build OK.

Not verified live: the order change in `toggleRecordingFromShortcut` and the voice-take notice
(need the packaged app on macOS).

## Step 2 · M3 `screens_error` (save and spool promotion)

Files: `frontend/src/recording-save.ts`, `frontend/src/recovery-summary.ts`, `frontend/src/main.tsx`;
tests `frontend/tests/recording-save.test.ts`, `frontend/tests/recovery-summary.test.ts`.

- `parseRecordingSaveResponse` returns `screensError` (`parseScreensError`: the trimmed string, ""
  for none or a non-string). `saveRecordingText` passes it on.
- `transcriptScreenManifest(adopted, staged, screensError)`: the adopted manifest when there is
  one; **null when `screens_error` is set** (the staged paths point into the staging folder, which
  is swept — no marks are written rather than broken links); the staged one otherwise (unchanged).
  stopLive calls it instead of `adopted || staged`.
- stopLive: a save with `screens_error` shows a warning notice ("Recording audio is saved, but its
  screenshots could not be attached (…). The transcript has no screen marks.") instead of the
  success notice, and logs it.
- `recoverBackendAudioSessions` reads `screens_error` from each promotion answer and
  `recoverySummary(succeeded, failed, withoutScreens)` says "Its/Their screenshots could not be
  attached" (tone warning) instead of a plain success.

Check: `npm --prefix frontend test -- recording-save recovery-summary`.
Before: HEAD `parseRecordingSaveResponse` returns no `screensError` (the two `toEqual` cases and the
`screens_error` case fail), `transcriptScreenManifest` / `parseScreensError` do not exist, HEAD
main.tsx has `parseScreenManifest(persisted.screensManifest) || stagedScreenManifest` (the wiring
case's `not.toContain` fails), and `recoverySummary(1, 0, 1)` reports a plain success.
After: `14 passed` in the two files; full frontend `48 files, 616 tests passed`; typecheck, lint,
build OK; desktop `437/437` (untouched).

Not verified live: a real adoption failure (needs a failing disk write during a screen take's save).

## Step 3 · coordinator side note: the helper's "press outcome=click clicks=0 drags=0" flood

Real. `main.swift` logs `classifier.lastOutcome` on every left-mouse-up the tap sees. A release
that ends no press (phase `.idle`: another app posting mouse-ups — `clicks=0` is the click state
synthetic events carry — or a release whose press went past the tap) returned `.pass` but left
`lastOutcome` at the PREVIOUS press's value, so each stray release re-reported it: the 13 lines at
12:28:11.792. Fix (root cause, in the rule): `PressClassifier.classify(.up)` in `.idle` sets
`lastOutcome = nil`, so no line is emitted for a release that finished nothing. The decision
(`.pass`) is unchanged — the release still reaches the app.

Files: `desktop/native/screen-input/PressClassifier.swift`, `desktop/native/tests/press-classifier/main.swift`
(new case), `desktop/screen-input.test.js` (case list).
Check: `node --test desktop/screen-input.test.js` (compiles and runs the Swift suite; macOS + CLT).
Before (line reverted): `pass 1 fail 1` —
`FAIL a stray release after a click reports no second outcome: expected no outcome, got Optional(main.PressClassifier.Outcome.click)`.
After: `pass 2 fail 0`.

Not verified live: which process posts the stray mouse-ups on the user's machine is not known;
after the next build the log should show no repeated `press` lines (the shipped helper binary
must be rebuilt by `desktop/scripts/build-native.sh`).

## Step 4 · coordinator requirement: capsule, palette and frames appear at once (S-02 area)

Evidence (user's main.log, take 12:28:06): press 06.211 → capsule visible 06.222 in VOICE shape →
front-app lookup 211 ms → `screenMode.start` → helper ready 06.483 → started 06.758; the frames,
palette and computer button arrived ~550 ms after the capsule, one after another. Causes: (a) the
capsule was shown by its first status paint, before main knew anything about screen mode;
(b) the session started only after mic confirmation + front-app lookup + capsule session (step 1
moved it before the last two); (c) the controller awaited the helper's `ready` BEFORE creating
the overlays, showed each overlay as it loaded, then created the palette, then told main
(`onActiveChange`) to restyle the capsule.

Design (no delays added):
- `desktop/screen-surfaces.js` (new, pure): `createSurfacePresenter({required, optional, present})`.
  Each surface reports ready/failed; `present(ready)` runs exactly ONCE when every surface has
  reported, with all ready ones, or never (a required surface failed / the start was aborted).
  `expire()` bounds the wait (late surfaces count as failed). Required: the frames; optional:
  capsule, palette.
- Controller: overlays and palette are created hidden (`showInactive` only after the showing;
  a display plugged in mid-take shows when ready). Overlays, palette, capsule preparation and the
  helper start run side by side; `presentSurfaces` (on the presenter's single call) tells main the
  session is on, then shows capsule → overlays → palette back to back with no await, then logs
  `[screen-mode] surfaces visible press_to_visible_ms=<n> capsule=<0|1> overlays=<n> palette=<0|1>`.
  The helper is not a surface: the picture does not wait for it; `start()` answers STARTED once
  the helper is ready. A helper that fails BEFORE the surfaces are ready aborts the presenter
  (nothing shown); after — teardown + warning as before. Wait bound
  `SURFACES_READY_TIMEOUT_MS = 3000` (a page that never loads). The palette is placed above the
  capsule window while both are still hidden (`capsuleBounds` reads the hidden capsule).
  `start(id, { pressedAt })` carries the press time for the log line.
- main.js: `startScreenTake(id, pressedAt)` = hold the capsule + `screenMode.start`, called right
  after the renderer accepted a screen start (also after a re-dispatch following the mic prompt) —
  before the transition status's first paint, mic confirmation, front-app lookup and capsule
  session. `holdCapsuleForScreenTake` sets the capsule's screen shape before its first paint and
  keeps it hidden (`updateRecordingStatusCapsule` paints, resolves `prepareCapsule`, does not
  show); `showHeldScreenCapsule` is the controller's `showCapsule`; `releaseCapsuleScreenHold`
  shows the capsule its usual (voice) way when the session did not start (ENDED/FAILED), when the
  mic was not confirmed (the session is then discarded), and `hideRecordingStatusCapsule` drops a
  hold. A capsule already visible (re-dispatch path) is not hidden: it restyles in place
  (capsule=0 in the log line).

Files: `desktop/screen-surfaces.js` (+ test, new), `desktop/screen-mode-controller.js`,
`desktop/main.js`, `desktop/package.json` (build.files), `PROJECT_STRUCTURE.md`,
`desktop/screen-mode-controller.test.js` (fake `loadGate`, `prepareCapsule`/`showCapsule`;
4 new cases), `desktop/screen-session-start.test.js` (start before mic confirmation / first paint).

Check: `node --test desktop/screen-surfaces.test.js desktop/screen-mode-controller.test.js`.
Before (step-3 controller, new tests): `fail 2` — `the surfaces do not wait for the mouse helper`
→ `AssertionError: the frame waited for the helper`; `…appear in one step…` → the old controller
never asks for the capsule (`TypeError: capsuleReady is not a function`: no `prepareCapsule`
call) and showed each overlay as it loaded. The presenter's own suite (6 cases: no subset in any
ready order, one call only, optional left out, no frame → nothing, abort → nothing, expiry) is new.
After: desktop `tests 447 pass 447` (run twice); `node --check` OK; frontend typecheck/lint OK,
vitest `616 passed`, build OK.

**Not verified live** (needs the packaged app on macOS): that the three windows actually
appear in the same frame on screen (`showInactive` of four-plus windows back to back is one JS
turn, not one compositor transaction); the real press→visible time (read the new
`surfaces visible press_to_visible_ms=` line); that a hidden capsule window keeps its painted
state for the reveal; the re-dispatch-after-mic-prompt path; the unconfirmed-mic discard path
(the frames may flash up and go if the mic confirmation fails after they were shown).

## Not done (ID → reason)

- **D3 residue — an ENDED take's collection** → a take stopped before its screen session
  started (ENDED) was already stopped by the renderer as a screen take, so it is saved under
  Screen Sessions without screenshots. Fixing it means deciding the collection in stopLive after
  `finishScreenSession` answers (screen only with a manifest), but `recordingCollection` is
  captured at the top of stopLive and also feeds `createSessionMetadataSaver` before the manifest
  is awaited — a restructuring of stopLive owned by the frontend-live lane. Cross-domain #1.
- **S-04 residue — the recovery sidecar of a demoted take** → the live socket opens before main
  knows whether the session started, so the backend sidecar says `screen` + the session id.
  A crash AFTER a demotion promotes the take into Screen Sessions (adoption of the missing
  staged session returns nothing, no error). The draft snapshot (`buildLiveDraftPayload`) does
  follow the demotion. Needs a backend way to update the sidecar's collection (e.g. on the draft
  PUT) — backend lane. Cross-domain #2.
- **Capsule hold / reveal in main.js** has no behaviour test: it is window state inside main.js
  (needs Electron); covered only by the order checks in `screen-session-start.test.js` and the
  controller's fake `prepareCapsule`/`showCapsule`.

## Cross-domain for the lead

1. Renderer (frontend-live): stopLive should file a screen take under Screen Sessions only when
   `finishScreenSession` returned a manifest (an ENDED take is a voice take).
2. Backend: let the live draft PUT (which now carries the take's real collection) or a small
   endpoint update the recovery sidecar's `recording_collection` / clear `screen_session_id`, so a
   take demoted by `screen-mode:voice-take` is recovered under Live.
3. `ipc-contract.test.js:195` still pins the inline sender check of `screen-mode:finish`
   (unchanged here; DM-28 item from fix-journal-desktop-main Cross-domain #7).
4. CHANGELOG: screen mode now appears in one moment (capsule, palette, frames); the helper no
   longer floods `press` lines; a failed screen start keeps the take as a voice take; the drawing
   helper dying or a failed screenshot is now told to the user; a recording whose screenshots
   could not be attached says so.
5. Merge note: `RECORDING_COLLECTIONS` / `liveRecordingCollection` moved from main.tsx to
   `frontend/src/take-collection.ts` (import added next to `./recording-save`).

## Not verified live (summary)

Everything that needs the packaged app on macOS: the one-moment showing and its real
press→visible time, the voice-take notice reaching the renderer, the lost-renderer retirement,
the helper's press-line fix (needs the rebuilt helper), a real `screens_error`.
