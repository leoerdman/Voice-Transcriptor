# HISTORY pass — git log -p -40 on main (HEAD acbf737 .. 15bd422)

Coverage: DEEP = diff read and HEAD code checked; SCAN = message + stat read, targeted HEAD checks (claims verified by grep, removed
identifiers grepped for dangling refs, removed test assertions reviewed, TODO/FIXME/workaround scan over all added lines: none in code).

| commit | what it changed | review |
|---|---|---|
| acbf737 | screen mode: panel type removed, helper takes taps on own controls (tap event), orphan-drag draws, serial output queue, press log | DEEP |
| 70273a0 | 1.6.6 screen mode (overlay, helper, backend screen_sessions, retention, contract json), dual-stream contested-stretch rule | DEEP (backend, main.js, controller, swift); renderer main.tsx SCAN |
| 8e284da | 1.6.5 CLI client (cli.py, cli_access.py, token, wrapper), user-data-dir spelling | DEEP cli_access/main.py auth; cli.py, user-data-dir SCAN |
| 25048ca / 4bebd9e / ee01fc8 | release bumps + changelog | reviewed |
| baa7476 + merge 04ed626 | window lifecycle table (nine mechanisms deleted) | DEEP: all removed identifiers grepped, none dangling |
| 8c7c327 | BUILD.command, designated-requirement check | DEEP |
| efe59b4 | paste-permission self-heal (tccutil) | DEEP main.js part; paste-capability.js SCAN |
| 0b31bd8 / e3b0cae | live preview duplication fix; Live hint removal | SCAN |
| 2e0a043 | 1.6.1 audit consolidation docs | SCAN |
| b2ea2c5 | renderer halves (badge, migration, suspend), tsconfig allowJs | DEEP tsconfig |
| 82ba454 | backend tests cannot touch real data dir | SCAN |
| c06b4f7, 6d31b53, 52dab76 | stopLive bookkeeping; live-defaults contract; stop-envelope contract | SCAN (partial) |
| 300cfac, 3c3bbe9, b209c87, 1a4b122, 3c.. docs/journals | journals, recovery pass | SCAN |
| eb93fde, fadc50e, 6999634, cdcb11c, 7461a64, 1ed7b32 | audit-fix waves (resource bounds, error honesty, SSOT) | SCAN + claims spot-checked at HEAD (_LAST_LOAD_ERROR, compact_audio_for_remote gone; chmod-after-replace fixed; removed test asserts all legitimate) |
| aed1e61, 7be4938, 88de1c7, b463e58, aeb7039, e1bf3d4, 15bd422, 4da7273, 5c56e65, c31b642, ae42aa3 | older fixes/journals | SCAN (partial) |

Env SSOT checked: TRANSCRIPTOR_* set in code == set in .env.example (124 == 124, no drift). Packaging: every local require of main.js/preload is in build.files.

## Findings

H-01 · desktop/main.js:2316 endScreenModeForLostRenderer + backend/main.py:1353 _promote_live_recovery / :1066 _cleanup_live_recovery_files · P1 · CONFIRMED
 gist: Screenshots of a screen-mode take whose renderer died are never adopted; they are deleted after 24 h.
 path: renderer crash/reload -> main.js:2316 finish({discard:false}) keeps staging -> comment says "the backend's recovery sweep owns them ... like the audio spool" -> live-recovery promote (_promote_live_recovery, no screen_sessions call; only refs in backend/main.py: 1066 sweep, 3507-3540, 7619, 7682-7736, 8050) saves the audio into Live Capsule collection without .screens -> sweep_orphan_sessions rmtree after LIVE_RECOVERY_RETENTION_SEC (86400).
 consequence: user loses screenshots/drawings on exactly the crash path the staging exists for; recovered audio lands in the wrong collection (Live, not Screen Sessions); CHANGELOG 1.6.6 "ages out" is true, "recovery owns them" is not.
 current: promote path has no adoption; fixed: promote adopts the staged session whose id the recovery snapshot carries (store screen_session_id in the live-recovery meta) into <stem>.screens and uses the screen collection; or the comment/CHANGELOG say plainly that crash loses screenshots.
 not intent: the comment at main.js:2308-2314 states the opposite of what the code does.

H-02 · backend/cli_access.py:367 CliAccess.disable + backend/main.py:7097 disable_cli_access · P1 · CONFIRMED
 gist: Revocation swallows unlink failure and still answers "disabled / token revoked".
 path: POST /api/cli/disable -> disable() clears memory, unlink(token) OSError -> logger.warning only -> handler logs "token revoked" and returns status enabled=false. Next boot load() (cli_access.py:~262) reads the surviving token file -> CLI access is ON again, the UI showed OFF.
 consequence: a security switch lies; the same class fadc50e fixed elsewhere (refusal reported as success). enable() was made honest (rolls back, 500), disable was not.
 fixed: disable() returns/raises when token file could not be removed; handler returns 500 naming the file; or truncate/overwrite when unlink fails.
 not intent: docstring says "Never raises" but the module header says the file IS the switch.

H-03 · desktop/main.js:486,1437-1445,9154 (700 ms capsule activate suppression) vs CHANGELOG.md:75 + desktop/window-lifecycle.js:39,136 · P1 · HYPOTHESIS
 gist: Only screen mode got a real fix for "clicking the capsule raises the main window". In voice mode the capsule stop click is still an OS click on a window of an inactive app; the suppression is a 700 ms time dwell in app.on("activate"), the very crutch family baa7476 says it deleted, and it cannot stop the OS raising the window (acbf737 measured: main-window focus 0.5 s after a capsule click, panel type did not help; the helper that now avoids it exists only while screen mode runs).
 consequence: 1.6.4 claim "the capsule never moves the main window ... the one activate it can produce is answered with do nothing" is contradicted by the project's own later measurement. Needs macOS to reproduce -> hypothesis.
 fixed: either the tap-in-process approach for the voice capsule too, or state the limit in CHANGELOG/lifecycle doc.

H-04 · PROJECT_STRUCTURE.md:147, desktop/screen-mode-controller.js:21,27, desktop/native/screen-input/main.swift:148, desktop/window-lifecycle.js:39,136 · P2 · CONFIRMED
 gist: Half-done rename/revert after acbf737: "non-activating panels" (PROJECT_STRUCTURE), "exclusion rectangles" (command is now "controls"), "prune list" (no such list in screen-mode.js), "non-focusable ... panel" still describe removed code. (CHANGELOG.md:22 was updated.)
 fixed: reword each to "controls"/"windows"; delete "prune list".

H-05 · backend/main.py:3073-3074 and :3103-3104 · P2 · CONFIRMED
 gist: Comments say the desktop shell's screen-session store "keeps the same newest-N count". It does not: desktop/screen-mode.js:14-17 and screen_sessions.py docstring say the backend owns retention (one rule, AUDIO_RETENTION_POLICIES). Documents a second source of truth that does not exist and contradicts the SSOT note.
 fixed: delete the two sentences.

H-06 · CHANGELOG.md [1.6.6] (edited by acbf737), desktop/package.json:3 · P2 · CONFIRMED
 gist: acbf737 rewrote the already-released 1.6.6 entry (helper taps, panel removed, drag-always-draws, press log) and left [Unreleased] empty and version 1.6.6. The installed 1.6.6 build (70273a0) has panels and exclude; the notes now describe a later build. Version is SSOT (AGENTS rule 4): two different builds share it.
 fixed: new entry (1.6.7 or Unreleased) for acbf737.

H-07 · frontend/src/main.tsx:9939 and :10212 · P2 · CONFIRMED
 gist: Comments cite holdWarmCapture, which no longer exists (3ee4cb9 split it into planWarmCaptureHold at :10077 and commitWarmCaptureHold at :10130). Ownership-moves comment now points at nothing; the expiry-timer comment at :10212 names the wrong function.
 fixed: name planWarmCaptureHold/commitWarmCaptureHold.

H-08 · desktop/screen-mode-controller.js:647-660 startNow · P2 · CONFIRMED
 gist: Overlay/helper/palette creation failure is caught, logged, and startNow still calls onActiveChange(true) and returns {ok:true}. Capsule shows the screen button, hotkey is bound, but nothing can draw; the user gets no warning (error without owner, fallback hiding the cause).
 fixed: on failure teardown, return {ok:false,error}, surface onWarning.

H-09 · desktop/scripts/build-mas.sh:62-73 vs desktop/package.json mac.extraResources native/build/mac-${arch} · P2 · HYPOTHESIS
 gist: every dist script got build-native.sh in 70273a0 except dist:mas (build-mas.sh runs only prepare-runtime.sh); the mac extraResources entry points at a directory that will not exist for the MAS build. Either electron-builder warns/fails or screen mode silently is absent (isSupported() is false when the helper file is missing). Needs a MAS build to settle.

H-10 · PROJECT_STRUCTURE.md · P2 · CONFIRMED
 gist: Not listed: desktop/user-data-dir.js (8e284da touched this file but omitted it), backend/model_catalog.py (the catalog SSOT), backend/audio_mime.py, backend/deepgram_format.py, frontend/src/live-pane.ts, live-source.ts, shortcut-display.ts, transcription-catalog.ts.

H-11 · backend/main.py:7679-7693 _read_recording_payload · P2 · HYPOTHESIS (perf)
 gist: Per recording in every list build: screens_dir()+is_dir stat evaluated 3x, list_screenshots (iterdir) and read_manifest (JSON parse) each time, even for plain recordings (is_dir stat repeated). Compute once; cost scales with archive size on each refresh unless the list cache hides it.

H-12 · BUILD.command retire_duplicate_app_bundle (after install) · P2 · HYPOTHESIS
 gist: quit_running_app guards only the primary bundle; the legacy ~/Applications copy is deleted by cleanup_path without checking it is running, the exact "replace a bundle under a live process" hazard 8c7c327 documents. Only when both copies exist and the legacy one is running.

Checked, no defect: dead exports of new modules (all used or internal), window-lifecycle removed identifiers (no dangling refs), env vs .env.example, desktop package.json files list, removed test assertions (all superseded), CLI route allowlist and enable rollback, screen_sessions path validation (regex on id and file name), delete-all removes .screens (no single-recording delete/rename endpoints exist), dual-stream contested rule (confidence rule matches message; secondary_source doubles as language code but options are bare codes).
Not verified (cannot run): app.setName() moving userData in _useOneSpellingForUserDataDir (desktop/main.js:331-380) on a case-sensitive volume; electron-builder behaviour for a missing extraResources dir.

## Branch verdicts (git diff main...<branch>; compared with HEAD files)

### wip/ultra-audit-2026-09-04 (2 commits, 13 files; snapshot "NOT verified, do not merge as-is") — OBSOLETE, everything superseded, delete branch
- .python-version, .gitignore (committed .python-version, desktop/build/* + dmg-background negation, .claude/*): in main (.gitignore:13,89,112; .python-version exists).
- AGENTS.md SSOT rule 4 + verification wording: in main verbatim (main is shorter by 13 lines only in prose).
- README.md / README.en.md hotkeys F9/F10 -> Ctrl+Alt+Shift+R/V: in main (README.md:23,121) plus test "documented hotkeys are the ones the app registers" (shortcut-defaults.test.js:105).
- desktop/main.js ensureBackendRuntime `-c requirements.runtime-lock.txt`: in main (main.js:7830 and retry path).
- desktop/package.json require-bash guards, artifactName, runtime-lock extraResource, gigaam resources removed from non-mac sections: all in main (package.json:23-31,42,98); main additionally has build-native, .python-version resource.
- desktop/packaging.test.js: lock/artifact-name/Python-version tests exist in main under evolved names (:173,:266,:288); main 393 lines larger.
- desktop/shortcut-defaults.test.js: strengthened asserts (3-modifier chord, no bare F-key, docs match) all in main (:53,:72,:105).
- tests.yml, prepare-runtime.sh, notarize-dmg.sh, generate-dmg-background.py: main has the same changes in a later, refined form (WELL_HALF_WIDTH constants, product_name, newer ffmpeg pin, D-063 note).
- Still needed: nothing found.

### origin/worktree-agent-a90710620c8f16c09 (1 commit, 3 files; "agent stopped mid-work, NOT verified") — OBSOLETE, superseded by main
- frontend/src/capture-warm.ts (271 lines): main has it at 384 lines, with Bluetooth refusal, lifecycle releases, decideWarmReuse (commits 2868689, 3ee4cb9).
- frontend/src/pcm-worklet.js (PreRollRing, arm/start, MAX_PENDING_SAMPLES 512): present in main verbatim (pcm-worklet.js:48,58,118,142), tests in frontend/tests/pcm-worklet.test.ts.
- frontend/src/main.tsx (+491): helpers streamHasLiveAudio, micTrackLabel, micTrackDeviceId, releaseWarmCapture, takeWarmCapture, handleWorkletMessage, acceptPreRoll, pushCapturedFrame exist in main; holdWarmCapture was split into planWarmCaptureHold/commitWarmCaptureHold (fixing audit F-001: hold decided before the track is stopped), which the branch version still has the bug of.
- Still needed: nothing. Do not merge: it would reintroduce the pre-fix ordering.
