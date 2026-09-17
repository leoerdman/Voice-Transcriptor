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
├── contracts/                     # cross-domain wire fixtures: live-final-envelope.json, live-defaults.json (fail the build on drift)
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
├── deepgram_words.py          # Deepgram word-spelling SSOT (punctuated vs raw)
├── deepgram_keyterms.py       # Deepgram Nova-3 Keyterm Prompting SSOT (parse/limit/query pairs)
├── deepgram_warm.py           # warm Deepgram live-socket pool SSOT (KeepAlive cadence, liveness probe, replay ring)
├── deepgram_dual.py           # dual-stream Auto SSOT: second Deepgram session + word-timestamp merge of the two readings
├── deepgram_language.py       # what a configured language means per Deepgram endpoint (live resolve vs REST detect_language)
├── deepgram_recovery.py       # re-decode of uncovered spans before the final envelope is sent (one owner of recovery)
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
    ├── live-envelope.ts              # the `final` stop-envelope wire type: one reader, matches backend/live_envelope.py
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
├── child-io.js                     # child-process text-output decoding SSOT (UTF-16LE on win32) (pure, node --test)
├── python-version.js               # interpreter version reader: the ONE file that declares it is .python-version (pure, node --test)
├── shortcut-migration.js           # retired-hotkey migration rule SSOT, shared with the renderer (pure, node --test)
├── linux-wm-class.js               # WM_CLASS split from `wmctrl -lpGx` for Linux window activation (pure, node --test)
├── window-lifecycle.js             # main-window lifecycle SSOT: activate/close/minimise/quit/second-instance/capsule decisions and where the window opens (pure, node --test)
├── ipc-contract.test.js            # main.js/preload.js IPC channel-name contract test (node --test)
├── preload.js                      # safe renderer bridge (path-for-file, engine lifecycle invoke-only, recordingFinal send-only, system-suspend receive-only)
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
    ├── build-mas.sh                # Mac App Store package build entrypoint
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
