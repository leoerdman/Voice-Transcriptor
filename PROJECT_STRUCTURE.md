# Voice Transcriptor — Project Structure

This file documents the current source layout. It intentionally avoids exact line counts because they drift on every audit/fix pass.

## Root

```text
Voice Transcriptor/
├── BUILD.command                  # macOS source build + install entrypoint
├── INSTALL.command                # macOS delegate / Linux AppImage source build
├── INSTALL_ON_OTHER_MAC.command   # target-Mac installer shipped inside macOS transfer zips
├── README.md                      # install, build, development, troubleshooting
├── CHANGELOG.md                   # historical release notes
├── LICENSE                        # repository license
├── requirements.txt               # direct backend/runtime Python dependencies
├── requirements-gigaam.txt        # optional GigaAM engine stack (ENABLE_GIGAAM opt-in)
├── requirements.runtime-lock.txt  # release-runtime transitive wheel constraints
├── .python-version                # Python version the shipped runtime is built with (SSOT)
├── contracts/                     # cross-domain wire fixtures: live-final-envelope.json, live-defaults.json, screen-session.json (fail the build on drift)
├── BUGS_AUDIT.md                  # running audit ledger (2026-08-23 wave)
├── BUGS_AUDIT_2026-08-24.md       # dated audit waves + fix statuses (root per audit charter)
├── BUGS_AUDIT_2026-09-03.md       # dated audit waves + fix statuses (root per audit charter)
├── BUGSAUDIT-2026-09-04.md        # Ultra-Audit 2026-09-04 summary: 270 findings, all P0 closed; consolidated journals
├── .env.example                   # user-facing environment-variable SSOT
├── docs/                          # VERIFIED_AUDIT.md, AUDIT_2026-08.md, PRODUCT.md, VISION.md, install guides
├── backend/                       # FastAPI backend and transcription pipeline
├── frontend/                      # Vite/TypeScript renderer
└── desktop/                       # Electron shell and package config
```

Removed root clutter:

- `INCONSISTENCIES.md` was an obsolete research snapshot and is no longer SSOT.
- `desktop/README.md` duplicated stale desktop instructions and was removed.
- `AUDIT_100_BUGS.md` was renamed to `VERIFIED_AUDIT.md` and moved to `docs/` because the audit intentionally lists only verified real bugs.
- `INSTALL_OTHER_MAC.md` and the audit documents live under `docs/`, not the root.

## Backend

```text
backend/
├── main.py                    # FastAPI app, REST/WS routes, jobs, recordings, config endpoints;
│                              #   audio-retention policy table + recordings-scan caches
├── config.py                  # config loading, migration, encrypted provider keys
├── model_catalog.py           # provider/model catalog SSOT: model ids that affect provider calls (bootstrap + /api/health)
├── audio_mime.py              # canonical audio/video upload Content-Type mapping (serving + provider uploads)
├── data_dir.py                # where this installation keeps its data — one rule, dependency-free (config.py and cli.py both read it)
├── cli_access.py              # command-line access SSOT: the CLI token, connection file, wrapper script, and what that token may call
├── cli.py                     # the command-line client itself (stdlib only) — `transcriptor transcribe|submit|status|result|cancel|info`
├── audio.py                   # ffmpeg/soundfile conversion and chunking
├── audio_constants.py         # shared audio constants
├── live.py                    # local live transcription session logic
├── transcribe.py              # engine dispatch, faster-whisper model cache + idle unload, local transcription
├── transcribe_gigaam.py       # optional Sber GigaAM-v3 engine adapter (gigaam-* ids)
├── models_manager.py          # local model presence/download manager (Settings → Local models)
├── remote_deepgram.py         # Deepgram prerecorded REST provider
├── remote_deepgram_live.py    # Deepgram live WebSocket provider
├── remote_openrouter.py       # OpenRouter audio transcription and text upscale
├── deepgram_endpoints.py      # Deepgram endpoint SSOT
├── deepgram_format.py         # Deepgram formatting options both transcription paths send (live + REST) SSOT
├── deepgram_words.py          # Deepgram word-spelling SSOT (punctuated vs raw)
├── deepgram_keyterms.py       # Deepgram Nova-3 Keyterm Prompting SSOT (parse/limit/query pairs)
├── deepgram_warm.py           # warm Deepgram live-socket pool SSOT (KeepAlive cadence, liveness probe, replay ring)
├── deepgram_dual.py           # dual-stream Auto SSOT: second Deepgram session + word-timestamp merge of the two readings
├── deepgram_language.py       # what a configured language means per Deepgram endpoint (live resolve vs REST detect_language); Nova-3 language hints (options, default ru+en)
├── deepgram_recovery.py       # re-decode of uncovered spans before the final envelope is sent (one owner of recovery)
├── screen_sessions.py         # screen-mode screenshots SSOT: staging → `<stem>.screens` beside the recording, serving, orphan sweep (retention shares the audio rule)
├── live_envelope.py           # the `final` WebSocket envelope: one shape, one constructor
├── async_tasks.py             # ending started asyncio tasks without ending the awaiting coroutine (one owner of the pattern)
├── http_retry.py              # remote request retry handling
├── jobs.py                    # in-memory job store and cancellation
├── storage.py                 # atomic write helpers
├── tools/                     # operator scripts (not imported by the app), e.g. deepgram_live_ab.py A/B tool
└── tests/                     # backend unit/regression tests
```

Backend owns:

- API token auth.
- local and remote transcription.
- live WebSocket sessions.
- recording persistence and retention.
- upload/from-path job lifecycle.
- provider config storage.
- command-line access: the second token, its route allowlist, and every file the CLI client reads.

Graph is dormant: no backend graph route is registered.

## Frontend

```text
frontend/
├── index.html                        # renderer DOM shell; dormant Graph markup removed
├── package.json                      # frontend build dependencies/scripts
├── tsconfig.json                     # TypeScript config
├── vite.config.ts                    # Vite config and app-version injection
└── src/
    ├── main.tsx                      # renderer app logic
    ├── styles.css                    # renderer styles; Graph styles removed while dormant
    ├── pcm-worklet.js                # AudioWorklet PCM/VU processor
    ├── text-match.ts                 # transcript word-normalisation SSOT (pure)
    ├── transcript-merge.ts           # transcript adoption policy SSOT (pure)
    ├── live-coverage.ts              # live-envelope reuse decision SSOT (pure)
    ├── envelope-deadline.ts          # re-armable stop-envelope deadline SSOT (pure)
    ├── mic-health.ts                 # microphone-health FSM SSOT (clock-injected, pure)
    ├── audio-levels.ts               # capture-level SSOT: session noise floor, relative speech threshold (pure)
    ├── capture-warm.ts               # warm-hold/pre-roll/reuse decision SSOT for held-microphone captures (pure)
    ├── deepgram-dual.ts              # dual-stream Auto preference-resolution SSOT (pure)
    ├── language-hints.ts             # "Expected languages" (Nova-3 language hints) preference resolution (pure)
    ├── recording-cues.ts             # recording start/stop tones (pure, fake-AudioContext tested)
    ├── live-source.ts                # live-source composition SSOT: committed + interim → preview text and draft autosave (pure)
    ├── live-pane.ts                  # Live Preview pane display contract: preview on/off, status line (pure)
    ├── live-envelope.ts              # the `final` stop-envelope wire type: one reader, matches backend/live_envelope.py
    ├── screen-annotations.ts         # screen-mode marks: manifest → bracketed marks placed in the transcript by their moment in speech (pure)
    ├── take-collection.ts            # which History collection a live take is filed under, on every path (live socket, save, draft, recovery) (pure)
    ├── transcription-catalog.ts      # transcription catalog + selection SSOT for every model picker (pure)
    ├── shortcut-display.ts           # Electron accelerator → Settings keycap labels, per platform (pure)
    ├── cli-section.ts                # Settings → Command line: parses /api/cli and decides what the section shows (the backend composes every command)
    ├── upload-queue-restore.ts       # upload-queue snapshot restore SSOT: a failed read leaves the latch down (pure)
    ├── settings-autosave.ts          # settings autosave gate SSOT: no write of a config that was never read (pure)
    ├── recording-title.ts            # recording title rule SSOT (pure)
    ├── button-feedback.ts            # copy/button feedback copy SSOT (pure)
    ├── ui-copy.ts                    # UI copy + interface numbers tokens SSOT (pure)
    ├── recordings-list-reconciler.ts # keyed DOM reconciler for the history list (pure)
    ├── gated-poll.ts                 # conditional-polling scheduler SSOT (pure, timer-injected)
    ├── error-text.ts                 # readable text for thrown values SSOT (pure)
    ├── list-window.ts                # history-list windowing policy SSOT (pure)
    └── update-check.ts               # GitHub release detection (Level 1), version compare (pure)
```

Frontend owns:

- upload queue and job polling.
- live recording UI.
- settings UI.
- history/search/stats UI.
- local audio preview and re-transcribe actions.
- OpenRouter upscale UI.

## Desktop

```text
desktop/
├── main.js                         # Electron main process, backend lifecycle, recording monitor, hotkeys
├── accelerator.js                  # accelerator canonicalisation SSOT (pure, node --test)
├── engine-deps.js                  # GigaAM engine dependency-policy SSOT (pure, node --test)
├── renderer-console.js             # renderer console → support-log policy SSOT (pure, node --test)
├── paste-result.js                 # auto-paste success/verification decision SSOT (pure, node --test)
├── recording-final-slot.js         # renderer→main transcript hand-off payload + mailbox SSOT (pure, node --test)
├── paste-capability.js             # paste-capability state machine SSOT: stale Accessibility grants, Unknown/Untrusted/Active/Broken (pure, node --test)
├── paste-script.js                 # macOS paste AppleScript builder SSOT: robustPasteScript(verify) (pure, node --test)
├── paste-verification-policy.js    # per-target AX-verification memory SSOT: disables verification after repeated unverifiable reads (pure, node --test)
├── paste-protocol.js               # paste wire protocol SSOT: marker strings the paste scripts print and parsers read (pure, node --test)
├── power-events.js                 # powerMonitor subscription SSOT: each handler subscribed exactly once at startup (pure, node --test)
├── recording-status.js             # recording-capsule status classification SSOT: one ladder both sides read (pure, node --test)
├── screen-mode.js                  # screen-mode rules SSOT: session record, stroke position, manifest, shared names (pure, node --test)
├── screen-mode-controller.js       # screen-mode I/O: overlays + red frame, palette, native helper (its taps on our controls delivered in-process), display hot-plug, screencapture + compositing
├── native/screen-input/            # CGEventTap helper (main.swift) + PressClassifier.swift, the one click-vs-stroke rule (built by scripts/build-native.sh)
├── child-io.js                     # child-process text-output decoding SSOT (UTF-16LE on win32) (pure, node --test)
├── python-version.js               # interpreter version reader: the ONE file that declares it is .python-version (pure, node --test)
├── shortcut-migration.js           # retired-hotkey migration rule SSOT, shared with the renderer (pure, node --test)
├── linux-wm-class.js               # WM_CLASS split from `wmctrl -lpGx` for Linux window activation (pure, node --test)
├── user-data-dir.js                # one spelling for the app's data directory, shared with backend/data_dir.py (pure, node --test)
├── window-lifecycle.js             # main-window lifecycle SSOT: activate/close/minimise/quit/second-instance/capsule decisions and where the window opens (pure, node --test)
├── transcript-signal.js            # what a renderer hand-off signal means for the post-stop task: paste, keep waiting, or terminal (pure, node --test)
├── clipboard-lease.js              # one owner of the user's real-clipboard snapshot during a paste; released exactly once (pure, node --test)
├── recording-stop.js               # what a main-process stop does once the renderer has or has not answered (pure, node --test)
├── windows-paste-fallback.js       # the Windows PowerShell paste fallback script; sends keys only after a confirmed foreground switch (pure, node --test)
├── renderer-toggle.js              # the record hotkey's one renderer round trip and its deadline (pure, node --test)
├── renderer-requests.js            # the main window's requests (shortcuts, record toggle, reveal) — what main accepts from each (pure, node --test); replaces the document.title channel
├── auto-stop-config.js             # the silence auto-stop setting main applies: the renderer's, or off — no copy of its defaults (pure, node --test)
├── data-dir.js                     # the one rule for where the desktop shell keeps its data (pure, node --test)
├── backend-exit.js                 # what the shell does when the backend child exits: restart (with the capped backoff), report, or let it go on quit (pure, node --test)
├── log-retention.js                # which main.log archives the boot sweep deletes: newest 10, at most 50 MB (user decision; pure, node --test)
├── backend-auth.js                 # the backend API token: minted per launch, passed in the backend's env, handed only to the main window over IPC (pure, node --test)
├── private-log.js                  # main.log appends: the file is created 0600, an older world-readable one tightened once (pure, node --test)
├── single-flight.js                # at most one run of an operation at a time; check and claim in one step (engine install, the recording-state probe) (pure, node --test)
├── ipc-sender-guard.js             # the one registrar for a window's IPC channels: the sender check runs before every handler (main window, capsule) (pure, node --test)
├── quit-path.js                    # the one way a normal shutdown starts (quitApp → app.quit) and the SIGINT/SIGTERM/SIGHUP handlers (pure, node --test)
├── post-stop-handoff.js            # which stopped recordings get a post-stop task, and how it waits for the transcript: the recording-final mailbox only (pure, node --test)
├── session-permissions.js          # a session partition that grants no permission request or check (the capsule) (pure, node --test)
├── renderer-epoch.js               # which renderer a recording id belongs to, so a reloaded renderer's ids are never confused (pure, node --test)
├── shortcut-runtime.js             # the accelerators bound right now and how a Settings update changes them (pure, node --test)
├── capsule-geometry.js             # the recording capsule's window size and placement (pure, node --test)
├── screen-session-start.js         # what main does once screenMode.start() has answered: keep, already ended, or a voice take (pure, node --test)
├── screen-mode-warnings.js         # the one copy table for screen-mode warnings, keyed by the controller's kinds (pure, node --test)
├── screen-surfaces.js              # a screen take's capsule, palette and frames are shown together, once, never a subset (pure, node --test)
├── capsule-preload.js              # the recording capsule's preload bridge to main (stop, screenshot, geometry) — replaces the document.title channel
├── ipc-contract.test.js            # main.js/preload.js IPC channel-name contract test (node --test)
├── preload.js                      # safe renderer bridge (path-for-file, engine lifecycle invoke-only, recordingFinal / shortcuts / record-toggle / reveal send-only, system-suspend / shortcut-status receive-only)
├── package.json                    # electron-builder config and desktop scripts
├── shortcut-defaults.json          # per-platform default hotkey manifest
├── afterPack.js                    # macOS bundle signing/runtime fixups
├── afterAllArtifactBuild.js        # macOS DMG artifact signing hook
├── unlockDist.js                   # build artifact lock cleanup
├── entitlements.mac.plist             # macOS app entitlements
├── entitlements.mac.inherit.plist     # macOS helper entitlements
├── entitlements.mac.selfsigned.plist      # self-signed (non-Developer-ID) macOS app entitlements
├── entitlements.mac.selfsigned.inherit.plist # self-signed macOS helper entitlements
├── entitlements.mas.plist             # Mac App Store app entitlements
├── entitlements.mas.inherit.plist  # Mac App Store helper entitlements
├── icon.png / icon.ico             # package icons
└── scripts/
    ├── prepare-runtime.sh          # macOS arm64 / Windows x64 / Linux x64 runtime builder
    ├── build-native.sh             # screen mode's native helper (native/screen-input) → native/build/<target>; macOS arm64 only
    ├── notarize-dmg.sh             # Developer ID DMG notarization + stapling
    ├── check-designated-requirement.js # refuses an install whose signature would strand the TCC grants (BUILD.command)
    ├── generate-dmg-background.py  # DMG background artwork generator
    ├── build-mas.sh                # Mac App Store package build entrypoint (ships no screen-mode helper)
    ├── sign-mas.js                 # Mac App Store signing and provisioning preflight
    ├── upload-testflight.sh        # App Store Connect/TestFlight upload entrypoint
    ├── macos-signing-utils.js      # shared macOS signing/provisioning helpers
    └── require-bash.js             # release-host shell guard for Windows packaging
```

Desktop owns:

- single-instance app lock.
- backend process spawn and port selection.
- boot nonce verification.
- global hotkeys.
- headless recording state monitor and global hotkey coordination.
- auto-paste platform integrations.
- log writing and non-destructive rotation.
- GigaAM engine lifecycle: user-initiated install (Settings → Local models),
  network/disk gates, staging+swap into userData/engine-site, overlap policy
  against the pinned bundle (`engine-deps.js`), boot-time reconcile only.
- bundled runtime packaging for macOS, Windows, and Linux.
- Developer ID app/DMG signing handoff for notarization.
- Mac App Store packaging, provisioning preflight, and TestFlight upload handoff.

## Build SSOT

- App version: `desktop/package.json` (frontend/package.json duplicates the number for tooling; the drift test in `desktop/packaging.test.js` fails if they diverge).
- Python version: `.python-version` (read by `desktop/python-version.js`).
- Direct Python dependencies: `requirements.txt`.
- Release runtime constraints: `requirements.runtime-lock.txt`.
- User-facing environment variables: `.env.example`.
- Frontend output: `frontend/dist` generated by Vite.
- Packaged resources: `desktop/package.json` `build.extraResources`.

- `docs/NEXT_SESSION_2026-09-04.md` — точка входа следующей сессии: ТЗ трёх хотфиксов и трёх worktree-веток.
- `docs/NEXT_SESSION_2026-09-04b.md` — хендофф вечера 2026-09-04: единый владелец текста, Ultra-Audit, кто на чём остановился; §8 — релиз 1.6.1 и живые проверки.
- `docs/audit-2026-09-04/` — разделы находок, журналы правок и отчёты агентов Ultra-Audit (включая «Швы (2026-09-05)»); сводка — `BUGSAUDIT-2026-09-04.md` в корне.
- `docs/COMPARISON_2026-09-04.md` — сравнение с лучшими open-source/коммерческими реализациями диктовки: ранжированная таблица по 11 пунктам дизайна, что уже не хуже, что сознательно не берём.
