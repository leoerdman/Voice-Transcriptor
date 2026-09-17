# Changelog

All notable changes to Transcriptor are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.6.5] - 2026-09-18

### Added

- **The app is now a transcriber anything on the machine can call.** A shell script, a terminal, a Makefile or an AI agent hands it an audio or video file and gets the text back — through the same pipeline the Upload tab drives, with the same engines, the same models and the same archive. Switched on in Settings → Command line; the section shows the exact command, plus a paragraph written for pasting into CLAUDE.md, AGENTS.md or any system prompt.

  The client is `backend/cli.py`, standard library only, so it starts in milliseconds inside someone else's shell loop and never imports the crypto stack or creates a directory as a side effect of answering `--help`. It talks to the RUNNING app over the same HTTP API the renderer uses: there is no second backend, no second copy of the models, and when the app is not running the command says so and exits non-zero instead of doing half the job somewhere else.

  ```
  transcriptor transcribe talk.mp4                    # the text on stdout
  transcriptor transcribe call.wav --engine deepgram --diarize --save
  transcriptor submit long-call.wav                   # queue it, print the job id
  transcriptor result <job-id> --wait --json --out call.json
  transcriptor status <job-id> · cancel <job-id> · info
  ```

  Three properties make it usable from a script without parsing prose. **Stdout is the transcript** and nothing else — progress, notes and errors all go to stderr, so `$(transcriptor transcribe x.mp4)` is the text with nothing to strip. **The exit code says what happened**: 0 done, 1 the job failed, 2 the command line was wrong, 3 the app is unreachable or access is off, 4 cancelled, 130 interrupted. **A bare command does what the app would**: `GET /api/cli` reports the Upload tab's current engine, model, language and diarization, and the client inherits them, so the CLI and the window never disagree about what "transcribe this" means.

  Ctrl-C cancels the job as well as the wait — without that the app keeps decoding a file nobody is waiting for, burning a core or paid provider minutes into a result no one will read. A `--timeout` deliberately does NOT cancel: it stops waiting and prints the id to come back with, because the work is the app's and may be nearly done.

  **Access is a second token, not the renderer's under another name.** `backend/cli_access.py` owns it: the switch IS the presence of the token file, so there is no "enabled" flag in the config that could disagree with what the file system holds, and switching off revokes the token in the running process and deletes every file — no restart. `cli_token_may_call` is the whole reach of that token: create a job from a path, poll it, cancel it, download its result, save it to the archive, and read `/api/cli`. Nothing else. A CLI token pasted into an agent's prompt cannot read the config, the provider keys or the archive listing, cannot open the live socket, and cannot re-issue itself — `/api/cli/enable` answers it 403.

  The connection file follows the app: the desktop shell takes the next free port when 8321 is busy, so the backend records the address it was actually reached at (from the ASGI scope's bound socket, not a client-supplied header) and rewrites the file when it moves. A switch-on that fails halfway — token written, wrapper not — revokes what it wrote and reports off, rather than showing a command path with no command behind it.

### Fixed

- **A transcription saved from a file was filed in the archive under a UUID.** The archive names a recording after its source file, and the backend's snapshot of that file is named `<job id>.<original name>` — so "Team meeting.mp4" was saved as "9f2c1d4e-….Team meeting.txt". Five call sites wrote that name convention by hand and nothing read it back. It is now stated once, next to the reader that inverts it (`_upload_snapshot_path` / `_source_media_original_name`), and a path outside the uploads directory is never stripped, so a real file whose name merely starts with something UUID-shaped keeps every character of it. Fixes the Upload tab and `transcriptor transcribe --save` together, since both save through the same route.


## [1.6.4] - 2026-09-05

The window/Dock lifecycle rewrite, merged onto the 1.6.3 self-heal work it was built alongside. Suites: desktop 287 (was 270), frontend 375, backend 819, all green.

### Changed

- **The app opened strangely: often no running dot under the Dock icon, a window that showed, hid and showed again at launch, and a window that vanished the moment the recording capsule appeared.** The support log said it plainly — `[main-window] event=show/hide … lastReveal=ensure-window-visible revealProtection=…` eight times inside 200 ms at boot. Nine mechanisms were fighting over the window, each added to fix the previous one's symptom: a reveal single-flight promise, an 80 ms reveal-request timer, a 2.5 s "reveal protection" dwell, an "expected hide" dwell, an app-level un-hide dance, a `shouldRevealMainWindowForActivate` heuristic that weighed four window flags, an auto-hide when the capsule appeared, an auto-hide when a stop was driven from the main process, and a macOS `close` handler that hid the window instead of closing it. All nine are deleted, not disabled. What replaces them is a table in `desktop/window-lifecycle.js` — pure decisions, no Electron — that main.js consults from one function, logging exactly one `[main-window]` line per transition with its reason.

  The behaviour that table encodes is now a stated contract, the same on macOS, Windows and Linux:

  - While the process runs, the Dock shows the running indicator. Regular activation policy, set once, in one place; no accessory mode, no dock hiding, no `LSUIElement`.
  - Clicking the app — Dock, Finder, `open -a`, tray, a second launch — shows and focuses the window filling the display's work area. Not a macOS full-screen space, which would take the window away from the capsule and from the app being dictated into. Bounds are remembered and restored only once the user has resized or moved the window themselves; dragging it back to full size gives the default back.
  - The yellow button is a plain native minimise and the app keeps working: hotkeys, capsule, backend. A Dock click restores it.
  - The red button and `Cmd+W` quit, on every platform. "Closed" means "not running", and the existing `before-quit` path stops the backend child, the capsule and the tray.
  - Nothing else moves the window. The recording capsule neither hides it, focuses away from it nor reorders it: a `focusable: false` panel shown with `showInactive()`, and the one activate it can still produce on macOS is answered with "do nothing".

  Beyond the 17 tests over the decision table and the saved-bounds clamp, the suite now asserts at the source level what must not come back — no dock hiding, no app- or window-level hide, no reveal or protection crutches, exactly one activation-policy call, `window-all-closed` quitting with no platform branch, no `LSUIElement` in the build config, and every lifecycle event main.js reports being one the table defines (and every event the table defines having a caller). Desktop suite 256 → 273 on this branch, 270 → 287 merged onto 1.6.3.

  Merging this onto the paste-capability self-heal from 1.6.3 touched no overlapping lines in `desktop/main.js` — the two features live in disjoint sections of the file — but the self-heal dialog's "Restart Transcriptor" button was calling `app.quit()` on its own; it now goes through the same `quitApp()` the lifecycle table's `quit` action uses, so there remains exactly one place that asks Electron to start a shutdown. `docs/WINDOWS_CHECKLIST.md` gets a matching section: taskbar entry always present while running, a shortcut/taskbar click shows and maximises, minimised keeps hotkeys/capsule/backend alive, closing quits the backend process too, and the capsule never steals focus — noted as identical on Linux, where only the `WM_CLASS` plumbing (`desktop/linux-wm-class.js`) differs.

## [1.6.3] - 2026-09-05

The stale-macOS-permission failure, root cause first: the build that installs the app was breaking the permission, and the app could neither say so nor repair it. Suites: desktop 270 (was 256), frontend 375, all green.

### Fixed

- **Auto-paste stopped working after an install, and the app told the user to switch on a permission that was already on.** `main.log` at `2026-09-05T11:00:00Z`: three paste attempts and the menu fallback all refused with `Not authorized to send Apple events to System Events. (-1743)` while Privacy & Security → Automation showed Transcriptor → System Events as ON. The cause was not a stale grant at all — the bundle had been re-signed into `/Applications` at `10:56Z` under a process running since `2026-09-04T22:47Z`. That process probed fine at `10:58:53Z`, refused every Apple Event from `10:59:59Z`, and the very next launch of the same bundle probed `active` again at `11:00:51Z`: macOS stops validating a running process whose bundle has been replaced under it, and only a relaunch repairs that. `BUILD.command` now quits Transcriptor before it replaces the bundle and reopens it with `open -a` afterwards (`8c7c327`), so the window in which this can happen is gone.

- **The app described every dead grant as a stale Accessibility row, whichever permission had actually failed.** `pasteCapabilityMessage` hard-coded "Privacy & Security → Accessibility: remove and re-add", and an Automation refusal was folded into `untrusted` — "add Transcriptor and switch it on" — so the one instruction the user got was about the wrong pane and the wrong problem, once per paste. A `-1743` is now the `broken` state it is, described by the pane it belongs to, by the same classifier that routes the dialog (`efe59b4`).

- **A grant that macOS refuses is now repaired instead of reported.** The capability owner tells the two diseases apart — a bundle replaced under the running process (relaunch; a TCC reset would throw away a grant that is valid for the copy on disk) versus a grant whose code signing requirement no longer matches this build (`tccutil reset <service> <bundle id>`, once per boot per service, then a re-probe, logged as `[paste-capability] self-heal service=… reset=… re-probe=…`). Only if the repair fails does a dialog appear, once per boot rather than once per paste. Settings carries the same repair as a button next to the capability note, over an invoke-only `permissions:repair` bridge: the renderer names no service, no bundle id and no command.

### Changed

- **An ad-hoc build can no longer become the copy in `/Applications`.** macOS keys a permission grant to the bundle id *and* the code signing requirement that earned it; an ad-hoc signature's requirement is a cdhash of one exact build, so every rebuild silently invalidates every grant while System Settings goes on showing them. `codesign --verify --deep --strict`, which the install already ran, accepts ad-hoc signatures — the install now also requires a designated requirement of the form `identifier "<bundle id>" and certificate …` and refuses anything else. `BUILD.command`'s header states why the signing identity must stay constant across builds.

## [1.6.2] - 2026-09-05

Two renderer fixes reported the same day as 1.6.1 shipped. Suites: frontend 375 (was 363), all green.

### Fixed

- **The Live view carried a second copy of the Auto/dual-stream trade-off explanation, under the recording controls the user reads on every session.** Settings › API Keys already states the same trade-off next to the controls it governs (`deepgramDualStreamNote`, written from the shared `dualStreamTradeOffText`); the paragraph under the MIC/LANG/REC row (`#languageAutoHint` / `#languageAutoDualHint`) was clutter, not a second fact, and is gone (`e3b0cae`). `syncAutoLanguageUi` keeps only the Auto-dependent show/hide of the dual-stream row.

- **The live preview showed a whole transcript twice after a stop, while the delivered transcript showed it once.** Session `681a3df6` pasted a clean single reading (the TRANSCRIBE pane reads the backend's `final` envelope verbatim) while LIVE PREVIEW repeated the same speech — the envelope's segments were appended onto a buffer that already held the same speech from the incremental `segments`/`interim` stream, and their timings didn't line up closely enough for the segment-level dedup to see the overlap. Fixed with one rule instead of a better dedup: once a session's stop envelope has resolved, the preview shows it verbatim, never unioned with the reading it replaces (`composeLivePreviewText`, `0b31bd8`).

## [1.6.1] - 2026-09-05

The 2026-09-04 Ultra-Audit (`BUGSAUDIT-2026-09-04.md`, 270 numbered findings across backend, renderer and desktop) plus the cross-domain seams that closed the day after. Suites on the released revision: backend 819, frontend 363, desktop 256, all green.

### Fixed

**The transcript has one owner.**

- **The renderer assembled its own transcript at stop from data it had already streamed, so any clause the backend's envelope also carried could be pasted twice.** The renderer no longer assembles anything: it delivers the backend's final envelope verbatim (`889c91a`), and a complete envelope now replaces the live preview outright instead of being merged into it (`0de0c2d`) — which is exactly what made whole clauses double at stop. What is on screen is what the backend built, or nothing.

- **An envelope could be sent before it was complete, leaving hole-filling to whatever the renderer could guess.** The backend now re-decodes its own uncovered spans before the final envelope is sent (`bf84d6b`, `backend/deepgram_recovery.py`): covered time is never re-decoded, only the tail that reaches past it, and a wordless final no longer gets its own speech duplicated by the recovery pass. Measured on the 72.7 s three-language evidence recording: recovery spans=2 total=2.22 s in 1166 ms, `rec=2/0@1166ms uncov=1.31s` in the stop trace. The trace can state the number because the envelope reports it (`46934ce`) — the backend computes it, the renderer only reads it.

- **The tail guard retried on guesses, and a slow dual-stream secondary was dropped whole.** Retries fire only on real evidence — a hole proven by word times, not by absence (`e8f1632`) — and a secondary reading that arrives past its budget is merged partial instead of dropped.

- **A dual-stream primary replaced by the warm-socket liveness path went silent on the renderer.** The replacement publishes its segments through the same path as the original primary (`022fd27`), so finals keep arriving when liveness swaps the socket mid-recording.

- **Deepgram's answer to Finalize was thrown away, so the stop ended when a timer ran out instead of when the provider had answered.** The drain now ends on the provider's response, not on a timer (`3b8f5a8`); measured live, the wait ended by answer at 360 ms of the 3.0 s ceiling — and the two timer constants it replaced (`FINALIZE_COVERED_WAIT_SEC`, `FINALIZE_EMPTY_TAIL_WAIT_SEC`) are deleted, because they were the workaround the audit named first.

- **The stop envelope had as many wire shapes as writers, and nothing failed when the two sides drifted.** One builder on the wire (`backend/live_envelope.py`), one reader in the renderer (`frontend/src/live-envelope.ts`), and `contracts/live-final-envelope.json` + `contracts/live-defaults.json` as fixtures that fail the build when either side drifts (`52dab76`).

- **Three copies of backend knowledge lived in the renderer: the dual-stream defaults, the audio MIME map, and — supposedly — the segment epsilon.** The backend now ships the dual-stream defaults and the extension↔MIME map in the bootstrap payload, so neither can silently disagree with the config it describes (`6d31b53`); the third suspect, the 0.08 s segment epsilon, was checked and is *not* a duplicate — the renderer deduplicates already-sent segments of any provider, the backend's `emit_epsilon_sec` decides when a segment closes in the stream.

**The Ultra-Audit P0s, and the P1s that carried the release.**

- **A failed upload-queue load wiped every completed upload's transcript.** The `catch` that swallowed a failed state read still latched `uploadQueueSnapshotLoaded = true` and let the next autosave replace the state file — which the backend writes as a whole — with an empty queue. The latch is now honest (`74ff589`, `frontend/src/upload-queue-restore.ts`): a failed load leaves it down and the next entry into Upload restarts the restore. 9 tests; frontend 196 → 205.

- **Sleep, lock and wake never reached the app.** The power handlers were subscribed inside the hotkey capture path, so one aborted capture left the app deaf to sleep/lock/wake for the rest of its life. `desktop/power-events.js` subscribes each handler exactly once at startup (`a152ec7`), and the warm capture hold is released on suspend/lock like any other lifecycle edge.

- **A successful Windows paste was decoded as a failure, so the transcript was pasted twice.** The AppleScript handler's output is UTF-16LE on win32 and was read byte-wise; the paste wire protocol and the child-process decoding now live in `desktop/paste-protocol.js` and `desktop/child-io.js` — one decoder, one outcome grammar, no second copy in `main.js` (`317b4ca`).

- **A Deepgram final that arrives without a word list is a reading again, and the merge of two long readings no longer stops the backend for half a minute.** One rule, `segment_word_records(segment)`: a segment with words reads as words, a segment without them as a single spanless reading with its span and text — every asker goes through it (`d590a4e`). On any stretch of audio exactly one reading wins (a wordless blob loses to real words covering ≥ 50 % of its span). Merge cost measured: 3000×3000 words, 30.8 s (blocked the event loop) → 39.6 ms CPU / 65.2 ms wall under load average 44. The perf test measures `time.process_time`, the only measure a loaded machine cannot turn into a false red.

- **Paste verification verified nothing, and a failed paste deleted the transcript from the clipboard anyway.** Measured on macOS 27: `count of (value of attribute "AXValue" …)` inside `tell "System Events"` counts specifier elements, not characters — a scratch document holding "abcde" read back `1`, so no paste could ever verify, and a merely slow target was treated like a mute one. The element is resolved once and polled (4 × 50 ms, exit on match), three outcomes (`:verified/:unverified/:unreadable`) plus `INCONCLUSIVE` in the policy, `verificationAllowanceMs` 1500 → 3300 derived in the budget table (darwin worst case ≈ 24.8 s of the 32 s post-stop deadline). A/B with the real generated handlers against a scratch TextEdit document: `before=1 after=1 :unverified` → `before=0 after=5 :verified`. A failed paste no longer restores the clipboard, so the dictated text stays where the status says it is (`22c6e3d`).

- **The Accessibility prompt never came back, auto-send didn't send, a failed Windows activation claimed success, and the paste budget lied about its bounds.** The prompt path can be re-entered after a refusal, auto-send delivers to the focused app, the Windows activation path reports failure instead of assuming it, and the paste retry budget reads its bounds from the one table that is tested against the post-stop deadline (`86d63d3`).

- **The warm microphone hold and its 500 ms pre-roll could never engage: the hold was decided after the track had been stopped.** Stop step 1 now freezes the pipeline first — the hold is planned and the worklet armed (flush + armed: no frame after this point reaches the sink or the socket), `stopMediaRecorderAndFlush` moves up with it because the WebM container feeds from the MediaStream and would otherwise keep writing post-stop audio while the mic is still held, and ownership commits in teardown with the mic silenced if the planned hold failed (`3ee4cb9`). The end-to-end test that was unreachable before now holds a live track and refuses the same graph once it has ended; 32 tests in the module (was 25).

- **A failed settings load let the next click overwrite keyterms, the archive path and both hotkeys with defaults.** Autosave no longer writes a config that was never read: a failed load names the state, and the next click cannot persist defaults over real settings; the upload-queue snapshot carries a schema version read at migration instead of a magic number (`585b45f`).

- **The CSP didn't pin the WebSocket to the backend origin, and what rendered was not what was designed.** The CSP now names the backend origin for `ws:`/`wss:` (default-src 'self' does not cover them); the five undeclared UI tokens and nine with contradicting fallbacks are declared, `.btn-primary` is defined once, the dead `--record-stop-*` palette and the double-styled boot overlay are gone — the styles that render are the designed ones (`06f3330`).

- **A Developer ID build could not be signed without one developer's keychain.** The signing identity is discovered instead of hardcoded in build hooks, self-signed builds get their own entitlements plists, and the notarization profile and script ship ready-to-run — first notarization still awaits a Developer ID certificate in the build environment (`1d9fda2`).

**Resources, lifecycle and cancellation.**

- **ffmpeg read the channel Electron talks on, the heaviest model could not be unloaded, and a failed save kept a name it did not own.** ffmpeg no longer inherits the channel Electron talks on; the heaviest model can finally be unloaded; a failed save releases its name claim (`aed1e61`). The stereo split no longer loads the file it splits, and the job store's soft cap has a hard one behind it (`eb93fde`).

- **A cancelled stop did not stop, a control frame could be cancelled mid-write, and a socket swap could be pulled out from under the finalize.** A cancelled stop stops; control frames are written outside cancellation; the socket swap is ordered against the finalize (`f9ffa80`). `coveredEndSec` no longer repeats `durationSec`, so a spliced tail word can no longer make an incomplete envelope look complete (`3c3bbe9`).

- **A recording could be killed by silence without warning, and the capsule guessed its own state from the words in a status.** The status classification lives in `desktop/recording-status.js` — one ladder both sides read — and silence autostop warns before it fires (`0bf8ed7`). A recording that survives a stale stop keeps its monitor, a recovered backend gets its restart budget back, and a failed engine install says so (`966bcf7`). The paste memory learns which app it is talking to, and a loud renderer can no longer stall the main process (`aeb7039`).

**Engines and languages.**

- **"auto" meant different things per endpoint and nothing said why.** One meaning per endpoint with the reason written once (`backend/deepgram_language.py`): live resolves `auto`, REST deliberately keeps `detect_language=true` — the REST pass is the "full reading", and switching it to `multi` would be a quality regression, not a unification; the live config has one builder, and the predicates two modules shared are public (`cdcb11c`). The recovery pass stops re-flattening the two envelope numbers it repairs, stops duplicating speech a wordless final already owned, and stops knowing where Deepgram keeps its words (`1a4b122`). The local assist stops overstating what it lost, sees its own output while deciding what to trim, and moves a trimmed segment out of committed time (`6999634`). One list of built-in presets, one rule for an empty recognition, one way to claim a recording's name, and a duration each provider reports for itself — OpenRouter transcriptions no longer reported 0.0 s (`7461a64`). A refusal stops reporting itself as success, and eight pieces of code that did nothing are gone (`fadc50e`). A dual-stream recording pays one connect before its first byte instead of two, and the second reading is warmed like the first (`ea25b4f`).

**Configuration.**

- **Reading the config rewrote it, an unusable data dir killed the backend before it started, and one bad POST could brick Upscale forever.** Reading the config stops rewriting it; the backend survives an unusable data dir long enough to say why; the Upscale POST is idempotent (`b463e58`). The env reference stops describing a mechanism that does not exist, and the package six symbols are imported from is declared (`1ed7b32`).

**Errors that said the wrong thing.**

- **"Is this a network failure?" was answered in as many places as it was asked, and History showed a fiction.** The predicate is answered in one place (`b0eecd1`); History says what actually happened — a failed stats read is not an empty archive, an error is not a transcript, and re-transcribe no longer invents a session to guard itself with (`90876fa`); failures say what actually failed, a button that cannot work is not shown, and the title bridge is one idiom instead of three (`e1bf3d4`).

**Seams between the domains, closed.**

- **`stopLive` had six no-transcript exits repeating the same bookkeeping.** They share one bookkeeping step now, and the exactly-one-delivery-site invariant is a standing test (`c06b4f7`). No backend test can write into the real `~/Library/Application Support/Transcriptor` any more, no matter which module happens to import first (`82ba454`). The three renderer halves desktop was left waiting on: an Accessibility badge that actually reaches the user (invoke-only `paste-capability:get-status` bridge filling a note next to Shortcuts, instead of the `executeJavaScript`-injection pattern the audit named as the previous failure), one shortcut-migration rule (the renderer imports `migrateShortcutPair` from `desktop/shortcut-migration.js` instead of re-implementing it), and a suspend subscription that cannot stack (retire-before-resubscribe) (`b2ea2c5`).

### Changed

**One declaration per piece of knowledge: constants, copy, types, identity.**

- The numbers that shape the interface have names and one home (`UI_TOKENS`/`ui-copy.ts`), and a Copy button says the same thing everywhere (`50e52f6`); the numbers that decide a stop have names, the memory fallback has the bound its comment claimed, and a recording is titled by one rule (`f09c904`); auto-stop-on-silence has one set of numbers, and speaker diarization is snapshotted at start and remembered between launches (`27fba8d`); one declaration per type and per design token, and one number bounds the status pill (`a52e976`); accept lists and empty-state copy come from one source (`e679872`); nothing the renderer starts outlives what started it (per-instance teardown), and a clock set backwards no longer switches the update check off for good (`206737f`); scrolling History no longer refilters the whole archive on every scroll event (`58bafe8`).
- Desktop: a permission state nothing reads stops being polled, and the retired-hotkey rule has one home (`e74fca6`); an accelerator with a stray space stops becoming a global Ctrl+V, and the paste path drops three fictions (`f8db476`); the app's identity is declared once and the copies are checked against it (`f59850d`); the release manifest names its own artifact and stops copying the same file twice (`091865f`); pruning an engine-site duplicate removes the package, not just its label (`19b0235`); the hotkeys in the README are the ones the app registers (`c9d905a`); six numbers that decide behaviour get names, and the README stops describing a build we no longer make (`88de1c7`); the belt-and-braces paste guard says what it really guards, and both audit indexes carry a verdict for every entry (`7be4938`).

**Tests, CI and packaging.**

- Tests are type-checked — `tests/` is in `tsconfig.include` — and the microphone-health FSM is covered by the frontend suite (`0c916b9`); CI now runs the desktop suite where its AppleScript tests can compile (`b2d3461`); the two packaging and budget tests can now fail (`15bd422`); the finished-records depth check follows the main process now that its copy has a name (`4da7273`); the copy-feedback module the previous commit imports is in the repository (`9cca7d0`).
- **Every install of the backend's dependencies now uses the versions the release was built with.** `requirements.runtime-lock.txt` holds the exact versions the shipped runtime is built with; the release build, CI and the on-device repair all apply the same lock, and a packaging test fails when they disagree (`e679872`). The Python version the product ships is written down once (`.python-version`, read by `desktop/python-version.js`) (`8585a37`).

**Documented, so nothing depends on a live session surviving.**

- The Ultra-Audit report, journals and the evening hand-off are in the repo (`437d46e`); every agent's final report and the 2026-09-05 status are in docs (`300cfac`); the backend journal records the live A/B run and the debt this pass leaves behind (`b209c87`), the frontend journal accounts for every row of both audit indexes (`c31b642`), the desktop journal closes with what was measured on this Mac and what was not (`ae42aa3`), and the journal names the commit that repaired the depth check, not the one it replaced (`5c56e65`).

## [1.6.0] - 2026-09-04

### Fixed
- **A second final that arrived after the flush wait had already ended reached nobody.** Session 62115e77 (2026-09-03T21:42:09Z) streamed 14.26 s; 130 ms after Finalize the first final landed covering 0.00-10.85 s, the flush wait ended on that arrival, `finalize EXIT 405 ms` sent the envelope — and 2.7 s later Deepgram sent the rest of the same flush ("Напиши, на чем кто вас поверил.", 10.85-14.26 s) into a transcript nobody was reading any more; the 3.0 s budget had only spent 0.4 s. `drain_transcript()` (`backend/remote_deepgram_live.py`) now ends the wait on COVERAGE rather than on arrival: after each final it re-measures `_tail_coverage()` and keeps waiting, inside the one deadline already announced to the renderer, while `_tail_awaits_more_finals()` says the tail is still unflushed — a final carrying `speech_final=false` with more than segment-boundary jitter past it was forced out mid-utterance, so its continuation is still coming. No second Finalize goes out while the flush is arriving; exhausting the deadline falls through to the existing tail guard, unchanged. Diagnostics for the related "трёх" defect (session a9fd3fd9): an interim word judged covered by a *different* final word was neither a hole nor a splice, so every existing measurement read zero and the log said nothing — both places that drop a hypothesis for being covered now record the pair through `_note_overruled_word()`, and the coverage-holes block names each offending word alongside the final word that overruled it. Backend: 494 tests (baseline 475).

- **The Deepgram connect sat between the hotkey and the first word, and a socket that went dead mid-recording took the rest of the words with it.** Measured on this app's own log: connect p50 880 ms, p90 1.2 s, max 9.7 s, plus one 12 s timeout during which 126 s of dictation went into a stream that never existed (`BUGS_AUDIT_2026-09-03.md` §2.4/§3.7). `backend/deepgram_warm.py` holds at most one warm `DeepgramLiveSession`, keyed on `DeepgramLiveConfig.to_query_string()` — the exact string on the wire, so a model, language, keyterms or diarize change invalidates it by construction — opened at backend boot and re-warmed after every recording, on a 4 s KeepAlive cadence Deepgram's own docs require ("If no audio data or KeepAlive messages are sent within a 10-second window, the connection will close"). Liveness is checked twice: before adoption a socket that is closed, fatal, past its 5-minute idle TTL, or whose last KeepAlive is over 12 s old is rejected outright; after adoption, 2.5 s without a message following audio that carries speech swaps in a fresh connection and replays what the dead one swallowed from a bounded ring buffer, whose drop becomes the replacement session's `audio_offset_sec` — applied in the one place segments, interim words, coverage and `streamedSec` are all derived from, so nothing drifts onto a different timeline. Verified end to end against the 12 s evidence WAV: connect 854 ms, finalize 257 ms. Live final segments now also carry their own word list to the renderer, which needs word times (not just segment spans) to merge two readings. Backend: 544 tests (baseline 494).

- **An envelope that stopped short of the recording still ended the stop race, and a word buried inside covered time landed at the end of the transcript instead of in the middle of it.** Session 62115e77: the race ended 130 ms after `CloseStream` on an envelope worth one extra word whose last final stopped at 10.85 s of a 14.26 s stream, losing the clause that arrived 2.7 s later. `envelopeCoversRecording()` (`frontend/src/live-coverage.ts`) now asks whether the envelope actually covers the recording, once, and both stop branches use the answer: in the race an incomplete envelope is a floor, never a verdict — it keeps whatever it added and the recovery candidate is still awaited within the same race budget — and in the interim-covered confirm branch it turns recovery on exactly as a proven hole does. Separately (session a9fd3fd9), "трёх" existed only in an interim inside the finals' time range, so the durable-tail recovery glued "трёх в" onto the END of the transcript regardless. The renderer now recovers only from a hypothesis whose decode window reaches past the covered time — a word inside covered time belongs to the backend's own word-level splice, which can put it back where it belongs; a word with no timestamp recovers nothing. Frontend: typecheck, lint, 194 tests (baseline 180), build.

- **A second recording on the same microphone lost the half-second of speech spoken before the hotkey was pressed.** After Stop, the capture graph (MediaStream, AudioContext, worklet) is now held for 30 s unless the input device is Bluetooth, and the worklet keeps a rolling 500 ms pre-roll ring while armed; the next Start adopts the held graph — no `getUserMedia`, no new `AudioContext` — and begins with the pre-roll audio already in hand, counted once, in `startAt`, so both the shown duration and the too-short-to-keep guard see the same clock the saved audio actually starts from. First-frame batching also moved from 2048 to 512 samples so the worklet's own first frame arrives sooner. Frontend: typecheck, lint, 229 tests (baseline 180), build.

### Changed
- **Two readings of one recording were joined by how alike their words looked, not by when either side was actually listening.** `unionTranscripts` reconciled by text alone, and text cannot say which reading was listening to a given second: it paired words that merely look alike, so a clause the two readings worded differently came back as a sentence neither of them contains, and a clause a live re-decode restated came back twice. `mergeReadings(held, authoritative)` is now the one entry point and chooses by data: when both readings can be placed on one time axis — the live buffer's committed segments against the envelope's segments, whose word start/end `parseLiveWsMessage` now keeps — it cuts once, in time, at the widest silence inside the region where the two disagree, held words before it and authoritative words after it, reconciling only the ±1 s straddling the cut word by word through the same alignment engine. `whisper_streaming`'s n-gram guard (i ≤ 5) is now gated on the two runs' times *overlapping*, so a phrase the speaker genuinely repeated a minute later stays twice while the same seconds written down twice collapse. Without timestamps on both sides — an older backend, a recovery decode of the file, a bare string — the text union still runs exactly as before. Frontend: typecheck, lint, 242 tests (baseline 180), build.

### Fixed
- **Verifying a paste into an app that can never confirm one cost 1543 ms instead of 216 ms, every single time.** Measured against the Claude desktop app on macOS 27: its focused element's `AXValue`/`AXNumberOfCharacters` both fail with `-1728`, so every paste into it logged `OK:menu-paste-primary:unverified` while paying the full read cost anyway. `desktop/paste-verification-policy.js` remembers per target (bundle id, or app name when there is none) and switches verification off after two consecutive unverified outcomes, resetting the moment one verifies — an app that *can* be verified keeps being verified. `robustPasteScript(verify)` (`desktop/paste-script.js`) is now a pure builder with two shapes: the disabled shape emits no accessibility read at all, dropping the cost back to the plain `OK:menu-paste-primary` form the outcome parser already reads as an unverified success. Separately, the AppleScript read bound was fiction: measured on macOS 27 against the Finder process, `with timeout` placed *inside* a `tell` block bounds nothing (the read still blocked past 12 s), while the same statement wrapping the `tell` errors out at exactly its value. Every read now carries a wrapping 0.25 s bound outside the `tell`, the "after" read is skipped when the "before" read failed, and the script timestamps each read's edges so the paste trace carries what the reads actually cost.

- **A stale Accessibility grant let the app believe it could paste when the OS would silently refuse, and a failed paste used to restore the clipboard anyway — deleting the only copy of the transcript along with the failure.** `isTrustedAccessibilityClient` answers a question about a TCC row, not about whether synthesised events land, and after a re-signed install (exactly what a fresh 1.5.0 build is) that row can outlive the code identity it was granted to. `desktop/paste-capability.js` now drives the paste path from a state machine (Unknown/Untrusted/Active/Broken): the trust bit is paired with a real 1 s-bounded System Events probe, run at boot, on focus regain and before a paste, blocking only when nothing has been probed yet or the cached verdict is what would refuse this paste. A refusal is now a WARN line and a status naming the exact click sequence that repairs it, instead of a silent no-op. Failure also keeps its promise: every failing path used to restore the previous clipboard while the status still said "In Clipboard" — so the paste had not happened *and* the dictated text was gone — the transcript now stays exactly where the status says it is, naming the paste-last hotkey. Every bound the retry ladder spends now comes from one table, tested against the post-stop deadline (worst case 19.4 s darwin, 19.9 s win32, 18.4 s linux, against a 32 s ceiling). The script logs a SENT receipt the instant the paste is out and before anything that can block, so a wall-clock kill during verification reads as a paste that happened rather than being retried into a double paste, and the paste-last hotkey now waits for its own chord to release (150 ms floor, 500 ms ceiling) before sending the synthesised Cmd+V, so it cannot inherit a held Alt+Shift.

### Added
- **Auto mode can be told to run a second, monolingual Deepgram stream, and a held microphone is now released before it can survive sleep.** In the Deepgram card, next to Key terms: a checkbox and a secondary-language select, persisted as `preferences.deepgram.dual_stream` and `.dual_secondary_language` through the same debounced `/api/config` path as keyterms, shown only while the live language is Auto — the Auto hint now says which way they are set. `frontend/src/deepgram-dual.ts` is the one place that resolves what a stored, missing or build-unsupported value means, so an absent config key resolves to the documented backend default rather than silently to off (the config is rewritten on every autosave, so "absent means off" would persist). `[trace stopLive] FINAL` now prints `dual=1/0` from the envelope's stats. Separately: a held microphone now also releases on the desktop's new system-suspend bridge (sleep and lock-screen, `desktop/main.js` → `window.transcriptor.onSystemSuspend` → `frontend/src/capture-warm.ts`) — the renderer cannot otherwise learn this happened, because `setTimeout` does not run while the machine is asleep, so the hold's own TTL timer never fires and the OS may hand the microphone to another application in the meantime. Frontend: typecheck, lint, 250 tests (baseline 180), build.

- **Auto mode's dual-stream Deepgram reading ships: a trilingual recording's language-switch holes now close automatically.** A second Deepgram session (nova-3, `language=ru` by default) runs alongside the existing multilingual one whenever a recording resolves to `language=multi`, and the two are merged by word timestamp at stop (`backend/deepgram_dual.py`). On the 72.7 s trilingual evidence recording (`BUGS_AUDIT_2026-09-03.md` §1) this closes both language-switch holes measured there, verified again via `backend/tools/deepgram_live_ab.py --dual`: 128 merged words against 105/119 words from either single stream alone, at twice the Deepgram minutes and no added latency — the toggle lives in Settings (see above). The warm pool now holds up to two sockets, keyed by configuration, so the second reading's connect is also paid ahead of time (`backend/deepgram_warm.py`); the two preference keys are validated in `backend/config.py` the same way keyterms are. 41 new tests (`backend/tests/test_deepgram_dual.py`) cover the decision, the merge — including a "без без" adjacent-word duplicate the measurement itself found and named — the facade's fan-out/degradation, and the envelope's wire shape. Full backend suite: 587 tests.

- **A comparison doc names what the best dictation apps do that we don't yet.** Two research passes surveyed WebRTC AGC2 internals, `whisper_streaming`'s LocalAgreement, ROVER, and six OSS dictation apps (OpenWhispr, Hex, Handy, FluidVoice, Whispering, whisper-local) against this app's own measured numbers (`BUGS_AUDIT_2026-09-03.md`). `docs/COMPARISON_2026-09-04.md` ranks eleven design points — pre-roll, warm socket, AGC, stop handshake, committed-text policy, seam merging, paste verification, stale AX grants, hotkey holds, language mixing, VAD — against what ships in this release, what was still open in the three worktrees that fed it, and what stays deliberately out of scope (permanent mic hold, ROVER at N=2, LLM fusion).

## [1.5.0] - 2026-09-04

### Fixed
- **A word Deepgram only ever said once, in an interim that no final agreed with, was gone by the time the recording stopped.** Coverage was decided by whether a final's TIME WINDOW contained a word's centre, not by whether the final's own words said anything about it: a final reading "три на или если это" over 4.91-9.70 s deleted "субагента" (heard in interim at 5.5-6.1 s) purely because the span covered it, and the same shape cost a 99 s recording roughly a third of its words (`BUGS_AUDIT_2026-09-03.md` §3.1-§3.4). `word_accounted_for` / `final_words_cover` (`backend/remote_deepgram_live.py`) now answer from each final's own parsed `words` list, kept for every final and interim alike; the orphan pool that used to hold displaced hypotheses is purged by the same word-identity rule instead of by any time overlap (§3.2, `test_deepgram_orphan_pool.py`); and at finalize, every interim/orphan word no final's words ever covered is spliced back into the committed transcript at its time position — inside the final it belongs in the middle of when there is one, as its own segment otherwise. The finalize log now names each hole span next to the interim hypotheses that overlapped it (§3.9), so a report of missing words can be checked against what Deepgram actually heard there instead of only a length.

  The splice's own A/B run against a trilingual evidence recording (`backend/tools/deepgram_live_ab.py`) then produced three new artifacts of the recovery itself — "Так, слушаю слушай" (the final re-timed a word instead of re-spelling it, and the identity-plus-overlap coverage test missed the re-time), "истинные причины и can fix them | them sub agents" and "посмотреть в WAV | WAB файлы" (the same spoken word recovered on both sides of a fallback-segment seam). Three guards close this without weakening the recovery: (1) an orphan is covered — not a hole — when ANY final word overlaps it by at least 25% of either word's own duration, not only when a strict majority of the orphan's duration overlaps, because a final that re-decoded that audio into a different word still owns the time it occupies; (2) a word may only be spliced where there is room for it — the gap at the insertion point, inside a final's own word list or at the seam between two finals/fallback segments, must be at least the word's own duration less 50 ms; (3) a word is never spliced beside a neighbour sharing its first five letters of alpha core, case-folded — the same stem rule catches an exact repeat and a re-spelling alike. Fixed with new cases built from the three real artifacts, alongside the existing "субагента" recovery and "тебе тебе нужно" neighbour-guard cases, all still passing (`test_deepgram_orphan_pool.py`).

  A fourth, unrelated duplication class survived the same guard: Deepgram's own endpointing documentation shows a word straddling an `is_final` boundary can be transcribed on BOTH sides of it, independent of any splice ("two two" | "two two three three…"). Nothing else in the module compared two already-final segments against each other. `drop_repeated_seam_ngrams` runs once, on the same merged segment list `text` and `segments` are both derived from (the §3.8 SSOT): for each seam it finds the longest run, up to 5 words, whose tail on one side and head on the other match by the same stem rule, and drops the repeated head. A stem match alone is not proof of a duplicate, though — isolating and re-decoding the 57-62 s span of the same evidence recording confirmed the speaker genuinely said "sub agents, sub agents" twice, back to back — so when both sides carry word timings, a match is only dropped when every matched WORD PAIR also overlaps in time (≥25% of either word's own duration, the splice guard's own coverage fraction); disjoint-time occurrences of the same words are two utterances and both survive. Only a segment pair with no word list at all falls back to the coarser rule this function shipped with, a seam no wider than 1 s.

- **Deepgram's periodic forced flush could cut a preposition off the word after it, and the seam-repair fusion could not tell the difference.** `merge_seam_fragments`'s length/vowel heuristic read a whole one-letter word ("в", "с", "к") the same way it read a genuine fragment, so "мы живём в" | "доме на горе" became "мы живём вдоме" — the exact defect the audit's own worked example named (§3.3). With Deepgram's word lists available on both sides of a seam, `_provider_split_token` now asks the provider directly: the two touching WORDS must be contiguous in time, and at least one of the touching text tokens must NOT be a whole entry in its own segment's word list — i.e. the provider's own transcript and word list disagree about where that token ends, which is exactly what a flush cutting through a token produces. When both tokens ARE whole words in the provider's list, the provider is believed. The morphological heuristic remains, unchanged, as the fallback for segments that arrive with no word list at all.

- **A dead upstream WebSocket could stall the receive loop for 5 seconds at a time, and the user's own `finalize` queued up behind hundreds of already-stuck audio frames.** `await session.send_pcm(data)` ran inline between reads of the renderer's socket, so one slow or wedged send to Deepgram stopped the backend reading anything else — four consecutive 5 s stalls in one recorded session, 20 s of a dictation with nothing being read (`BUGS_AUDIT_2026-09-03.md` §3.6). Cancelling the send via `wait_for` mid-frame is the likely reason these stalls arrived in runs: it leaves a `websockets` connection in an undefined state. The receiver now only ever hands frames to a queue and goes straight back to reading; one sender task owns the upstream socket and is never cancelled mid-write; a watchdog judges the upstream wedged from the AGE of audio still waiting to go out (same 5 s bound as before) and answers by closing the socket, which unblocks the pending write by making it raise, rather than by cancelling it. Frames are also batched to 1.6 KB (50 ms of 16 kHz mono PCM16) before being written, replacing roughly 375 tiny sends per second — one syscall, one WebSocket frame and one TLS record per renderer frame, at Deepgram's own observed size — with a bounded 20 per second; a `finalize` still reaches Deepgram strictly after every byte already captured, because it now rides the same FIFO queue as the audio instead of a timer.

- **`/api/transcribe/warmup` answered 500 whenever the model host was unreachable — including for a user who never uses the local engine at all.** Loading weights goes through the Hugging Face hub even for a model already cached on disk, so a machine with no network, or one working entirely through an API key, hit an `httpx` connection error on every warmup the renderer fires (on startup, on provider change, on every network-state flip) — five times in one 2026-09-01 window (`BUGS_AUDIT_2026-09-03.md` §7). An unreachable host is a state of the environment, not a server fault. The endpoint now recognises transport failures across the libraries that can raise them (`httpx`, `httpcore`, `requests`, the hub's own `LocalEntryNotFoundError`/`OfflineModeIsEnabled`, and DNS failure) walking the cause/context chain, and answers `200 {ok:false, state:"offline"}` instead of raising — a genuinely broken loader still raises. The renderer treats that as a quiet no-op rather than an error to retry or log.

- **Live Capsule kept only the three newest recordings' audio, so a report of missing words outlived the evidence it could be checked against.** The four recordings the 2026-09-03 word-loss audit was built on were deleted by this policy while the audit was still being written, and the comparison in it was only reproducible because copies had been taken by hand first (`BUGS_AUDIT_2026-09-03.md`, addendum (a)). `TRANSCRIPTOR_LIVE_AUDIO_KEEP_COUNT` defaults to 100 (was 3) — at ~1.9 MB/minute of 16 kHz mono PCM16, 100 one-minute takes stay under 200 MB, and the env var still overrides it for anyone who wants the old bound back.

- **`unionTranscripts` dropped a held reading outright on a two-sided disagreement, and could duplicate a clause on a one-sided one.** `flushGap`'s two-sided branch always took the authoritative reading regardless of which side actually held more of the words, so a candidate word ("sunnette") vanished whenever the envelope read that same span differently; the similarity gate compared shared words against the SMALLER side's count, so a one-word candidate trivially passed and aligned by coincidence. Separately, on a real stop (2026-09-03 23:49:57) the live splice's own re-decode had restated "prompt я наговорил, можешь посмотреть WAV" a few words after the authoritative reading's only copy of it; because the longest-common-subsequence alignment can pair a repeated word with only one occurrence, the unmatched restatement surfaced as a one-sided run and was appended whole, duplicating the clause in what got delivered. A two-sided gap now keeps exactly one reading — the LONGER of the two, authoritative only on a tie; the similarity ratio is measured against the larger side, with a floor on how many aligned tokens must exist before the ratio is trusted at all; and a one-sided run is dropped as a redundant echo, not new content, when it merely restates wording the alignment just placed within roughly its own length before it — a clause genuinely repeated much later in the recording is still kept twice. The 600-word alignment cutoff is gone; the shared head and tail of the two readings are matched directly and excluded from the O(n·m) table, so only the genuinely divergent middle costs anything, bounded on both cell count and wall-clock time with a fallback to the plain pick. Fixed and regression-tested against the real 23:49:57 duplication (`frontend/tests/transcript-merge.test.ts`).

- **A word a final dropped from its own interim lived only in a register the very next final overwrote.** `lastInterimText`/`lastInterimSnapshot` described only the LAST commit; a word an earlier final's interim heard but its own text omitted was reachable for exactly one more `is_final` before it was gone from every live view the stop path reads (`BUGS_AUDIT_2026-09-03.md` §4.1). The reconciliation now runs at the moment of every commit, not just the last one: `uncoveredInterimTail` (`frontend/src/live-source.ts`) asks the same question `mergeInterim` already answers — what does this hypothesis add that the committed text does not already cover — and accumulates the answer into a durable `recoveredTailText`, bounded to the same 40-word re-decode window every other seam decision uses. `composeCanonicalLiveSourceText` folds it in before either interim view, so it is never appended twice.

  Every guard `mergeInterim` applies was also answering a question wider than the one that actually matters. The re-statement containment check searched the WHOLE committed text, so an interim repeating "нужно" thirty seconds after it last appeared was discarded as already covered even though the speaker had just said it again (§4.2) — the exact regression the repeat-preserving fix in 876a93a was supposed to guard against. Every guard is now anchored at the SEAM — a window sized to the hypothesis's own length, sliced from the tail of the committed text — so a word occurring earlier in the recording says nothing about whether it was just said again. The re-decode rule that lets a hypothesis supersede committed text was similarly unbounded: past a mis-heard word or two at the seam, the run being dropped is content the speaker deliberately said twice, not a mis-hearing, and the old share-based rule let up to 30% of a 40-word window (twelve words) disappear with nothing standing in for them; past a 2-word ceiling the committed text is now kept in full and only the hypothesis's own continuation past the run it restates is appended.

- **Chromium's automatic gain control chose the level every capture opened at, and it chose badly.** All three recordings measured on 2026-09-03 opened at 0 dBFS peak with a 7 dB crest factor (speech normally shows 12-18 dB) — a signal sitting in the limiter, with the first words recorded in clip — then slid 10-15 dB over the next five to ten seconds and never came back (`BUGS_AUDIT_2026-09-03.md` §4.3); a June recording made before this code path sat at a steady -24 dB. `autoGainControl` is now `false` (`frontend/src/main.tsx`, `DICTATION_AUDIO_PROCESSING`) and nothing replaces it — the PCM the WAV and the live socket carry is exactly what the device delivered. The absolute silence thresholds this level slide made meaningless (`CAPTURE_TAIL_ACTIVITY_RMS`/`_PEAK`) are gone with it: `frontend/src/audio-levels.ts` measures each session's own noise floor, adapting down fast and up slowly, and answers "was this frame speech" from how far a frame rises above THAT floor rather than against a constant amplitude that means "loud speech" on one recording and "everything" on another.

- **The ScriptProcessor capture fallback's watchdog armed nothing for 1.3 s and only then checked whether the worklet had produced a frame.** On the one host it fired on (2026-08-31 21:12) the recording's first 1.3 s did not exist in either capture path, and there was a window where both paths could be connected and every sample captured twice (`BUGS_AUDIT_2026-09-03.md` §4.5). The fallback is now pre-armed alongside the worklet from the start, buffering into `scriptFallbackPending` without being the active path; it commits only if the worklet has produced nothing by the time its own first buffer period elapses, and the worklet's own first frame disposes of the fallback instead. Exactly one capture path is ever committed, and neither the blind window nor the double-capture window exists anymore.

- **A recording's "too short to keep" threshold was measured from the first captured audio frame, not from when the user asked to record.** `getUserMedia` + AudioContext + first frame measured 82+33+172 ms on 2026-09-03 — about 310 ms the clock never counted — so the nominal 500 ms minimum was actually an ~810 ms hold, and a genuine one-word dictation ("да", "стоп") was discarded as a mis-press (`BUGS_AUDIT_2026-09-03.md` §4.9). `recordingIsTooShortToKeep` now measures from `startRequestedAt` — the hotkey press or toggle, as received, before any device is opened — while `startAt` (first frame) stays the clock for everything the user is shown, because that is what the saved audio actually contains.

- **A user transcribing exclusively through a remote provider still loaded a ~700 MB local Whisper model into the backend on every launch.** `scheduleLocalWarmup` and the upload path each re-derived "is the local engine in use" as a second copy of `resolveEffectiveProvider`'s four rules, and the two copies could disagree (`BUGS_AUDIT_2026-09-03.md` §7). `localEngineInUse` is now the one predicate every caller — warmup, session model resolution, uploads — asks, so a provider selection that never reaches the local engine cannot trigger a warm of it.

- **The Electron main process learned a recording's transcript was ready by injecting `executeJavaScript` into the renderer every 30 ms, for up to 32 s — up to ~1000 synchronous evaluations landing at exactly the moment the renderer is finalizing Deepgram, running the paste upscale and serializing audio.** (`BUGS_AUDIT_2026-09-03.md` §6.7). The renderer now says so once, over IPC, the instant it happens: `window.transcriptor.recordingFinal({recordingId, text, final, source})` (`desktop/preload.js`, send-only, one fixed channel) lands in a per-recordingId mailbox (`desktop/recording-final-slot.js`) that the post-stop task waits on instead of polling. `final` is a real boolean the renderer states, never inferred from a wall-clock guess standing in for it — the mechanism that let pre-upscale, provisional text be pasted (§6.8) — so only the one signal explicitly marked final is ever pasted; a non-final signal is kept only as the best-known text the deadline-expiry recovery (§6.9) hands to the user if nothing final ever arrives. The `executeJavaScript` poll is kept, unchanged, as the fallback for a renderer that never speaks the protocol (an older build, or a recordingId too old to have one) — entered only after a 2 s grace window the bridge has stayed silent through.

### Changed
- **`AGENTS.md`-mandated release for the wave covering all of the above:** version `1.4.0` → `1.5.0` (`desktop/package.json`, `frontend/package.json`, kept equal — `desktop/packaging.test.js` asserts it).
- **The finalize-budget race the previous fix (3e5aa7e) left behind: an announcement that lands after the wait already started was silently ignored.** `announcedFinalizeBudget.get(sessionUiToken)` was read once, synchronously, at fast-path entry, but the `finalizing` message that fills that map arrives a median of 126 ms (p90 186 ms) later — so across 479 stops that waited for the envelope, 312 read the map before the backend's announcement had landed and waited the fallback 1500 ms regardless of what the backend had actually budgeted. Separately, that 1500 ms cap was itself hit in 62 stops, and in 17 of those the backend already held more text than the renderer delivered (`BUGS_AUDIT_2026-09-03.md` §2.1, §2.3). The deadline is now a re-armable promise per session (`frontend/src/envelope-deadline.ts`), recomputed if the announcement lands mid-wait instead of being usable only by a wait that starts after it.

- **The stop's own teardown, and its fixed 250 ms drain, were costing seconds nobody needed.** The backend used to hold the `final` envelope until after `CloseStream`, the recv drain and `close()` had all finished — teardown the client was never waiting on, at a median 270 ms and observed up to 5 s. The envelope now goes out the moment the transcript is known complete, before any of that; `drain_transcript()` produces it and `shutdown()` handles teardown separately afterwards, saving a measured p50 270 ms per stop. The post-`finalize` drain that used to spend its full 250 ms on every stop — because the microphone is already stopped by the time the control message arrives, so nothing more is usually in flight — now stops the instant the renderer's own `framesSent`/`bytesSent` counts (carried on the `finalize` message) are matched; an older renderer that omits them keeps the previous timed drain unchanged.

- **A dead Deepgram socket could deliver 2-12 characters of an 81 s recording, and the app treated that fragment as the transcript.** Both existing recovery branches gated on `!liveStreamErrorAtStop` — so a fatal stream error, the strongest signal that the instant transcript is unreliable, was exactly the signal that disabled recovery (`BUGS_AUDIT_2026-09-03.md` §2, catastrophic-stop class 2026-08-27/2026-09-02). `decideDeadStreamRecovery` (`frontend/src/live-coverage.ts`) now decides from data — a fatal error, a socket not OPEN at stop, unsent captured frames, an envelope-proven coverage hole, or tail audio past the last recognised speech — never from whether the instant transcript happens to be non-empty; any one of these forces the full-audio decode of the saved recording instead of pasting the fragment alone.

- **Windows paste success was decided by `cscript`'s exit code alone; the clipboard was then wiped regardless of whether anything was actually typed.** `if (check.ok)` accepted any zero exit without reading stdout, so a VBS `AppActivate` failure (it returns a boolean the script never checked) or a `SendKeys "^v"` with nowhere to land still reported success, `_markRecordingPasted` fired, and `scheduleSmartClipboardRestore` overwrote the clipboard 1.5 s later — the most likely explanation logged for "Windows says it pasted and nothing arrived" (`BUGS_AUDIT_2026-09-03.md` §6.1). Two of the three window-activation branches were dead code: `AppActivate` only ran when `!effectiveTarget.hwnd`, and the Windows frontmost lookup always returns an `hwnd`, so the only activation actually reached was a child PowerShell's `SetForegroundWindow`, which Win32 refuses to a non-foreground process and which discarded its own result through `Out-Null` (§6.2). VBS now requires both a zero exit code AND an `OK:` marker in stdout, `AppActivate`'s return value gates whether the paste is even attempted, and the clipboard is restored only when the paste method reports `verified === true` — on every platform, not just Windows, since macOS's own AX-unverified pastes (13 return points that hardcoded `verified: false`) had the same silent-restore problem (§6.5, §6.6). macOS gained an AX-based verification: the focused element's text length is read before and after the keystroke, bounded to 0.5 s per read so it cannot reintroduce the 40+ s hang a prior unbounded probe measured against Finder.

- **Windows re-compiled its front-window lookup's C# class on every single call.** `activateWindowsWindowByHwnd`'s inline `Add-Type` compiles a P/Invoke class through `csc.exe` on every paste — 700-2000 ms cold, worse under Defender — where macOS's equivalent (`lsappinfo`) costs about 10 ms (§6.3). A persistent PowerShell helper process now compiles that class once and keeps it warm, answering each front-window request over its stdin/stdout protocol instead of paying the compile again; combined with the retry ladder that used to run three separate PowerShell compiles per paste and could stretch to roughly 30 s end to end (§6.4), a single paste attempt is back to the double-digit-millisecond range the fast path was designed for.

- **Windows and Linux shipped F9/F10 as the default record/paste hotkeys — both already claimed by other software.** F10 activates the menu bar mnemonic in essentially every Win32 application, F9/F10 double as run/step-over in Visual Studio, VS Code and JetBrains IDEs, and F9 recalculates Excel — so registration either silently failed or another app stole the keypress before Transcriptor saw it (`BUGS_AUDIT_2026-09-03.md` §6.10). `desktop/shortcut-defaults.json` now ships distinct 3+-modifier chords for win32/linux, with a migration that detects a config still carrying the stale F9/F10 pair and rewrites it — the same shape as the darwin migration this app already shipped — so an existing install picks up the new default without the user re-binding by hand.

- **The Auto-mode hint said a fixed language was simply better; a second day of measurement says neither mode is.** The 2026-09-03 finding was that `language=multi` drops clauses on Russian speech while `language=ru` keeps them, so the in-app hint pointed users at a fixed language. Re-measuring against further recordings the next day found the opposite failure on the fixed side too: `ru` also dropped an English phrase ("single source of truth") and an interjection, and flipped "мне" to "не", on recordings where `multi` fused two words together and hallucinated a name instead. On a 72.7 s trilingual recording, streaming `multi` deterministically dropped two spans (17.9-25.8 s and 57.2-62.1 s) that keyterms shrank but did not close, while `ru` was the only reading without a gap over 1.5 s but garbled the non-Russian clause it crossed (`BUGS_AUDIT_2026-09-03.md`, Addendum 2026-09-04). The hint (`#languageAutoHint`, `frontend/index.html`) now says what was actually measured — Auto can drop phrases around language switches, a fixed language keeps that language but garbles the others, and Key terms reduces drops in both — instead of recommending one mode as the fix.

### Added
- **Nova-3 Keyterm Prompting, so a fixed language stops mangling English names.** Forcing `language=ru` (see below) fixes Auto's word loss but pays for it in transliteration — Deepgram spells "Sonnet" as "санет", "Opus" as "опус". On the 12 s recording from the same measurement, `ru` alone gave "…на санет или опус…"; `ru` with keyterms `Sonnet, Opus, Claude, Deepgram, субагент` gave "…субагента на Sonnet или Opus…", byte-identical across two runs. `backend/deepgram_keyterms.py` is the one place that parses the user's raw text (commas and/or newlines, deduped, capped to Deepgram's ~500-token combined limit), decides which models support the feature (Nova-3 only), and builds the repeated `keyterm=` query parameters — both the live WebSocket path and the prerecorded REST path call it, so a term added once reaches both instead of drifting the way `smart_format` once did (see below). Settings gained a "Key terms (Nova-3)" field under the Deepgram key, and `backend/tools/deepgram_live_ab.py` accepts `--keyterms` so the mitigation can be re-measured against saved recordings the same way the multi/ru regression was found.

### Fixed
- **`language=auto` quietly cost words on Russian dictation, and nothing in the app said so.** Auto maps to Deepgram nova-3's `language=multi`, which auto-detects the spoken language per utterance across ten languages. Replaying this app's own saved recordings through the same code, two runs each: on a 12 s clip ("…в одну, два и три субагента на Sonnet или Opus, если это будет нужно"), `multi` returned "…три на или если это нужно" — losing "субагента" and "Sonnet или Opus" outright — while `language=ru` on the identical audio kept every clause. A 99 s dictation lost roughly a third of its words the same way, and `multi` was non-deterministic between repeat runs on the SAME file; `ru` was byte-identical across repeats (`BUGS_AUDIT_2026-09-03.md` §1). This does not change what Auto maps to — `multi` is still the intended mode for the other nine supported languages, and a 173 s June recording made without clipping showed no difference between the modes, so the failure is specific to this kind of content rather than universal. What changed: the measurement is now recorded where the mapping lives (`remote_deepgram_live.py`), reproducible with `backend/tools/deepgram_live_ab.py`, and the live topbar shows a hint under the language select — visible only while Auto is selected — pointing the user at a fixed language and at Key terms for the English names a fixed language would otherwise transliterate.

- **The two halves of a stop disagreed about how long a stop may take, and the words fell in the gap.** The backend's finalize spends a budget chosen from tail coverage — up to 3 s, plus a retry of the same ceiling when the tail is uncovered. The renderer bounded its own wait for the resulting envelope with a constant 1.5 s. Measured 2026-08-25: finalize p50 550 ms, **p90 3306 ms, max 9379 ms, and 41 of 170 stops (24 %) ran past the renderer's constant** — in every one of those the backend spent seconds producing a transcript that reached nobody, because the renderer had already delivered. One observed cost: a 174 s recording where Deepgram returned 1844 characters and 1770 were delivered. The deadline is now decided once, where the coverage data lives, and published: `finalize()` announces `(budget, expects_more)` the moment it picks them and before it starts waiting, the backend forwards that as a `finalizing` message, and the renderer waits the announced time when the backend expects the wait to yield words — and keeps the short confirmation window when it does not, because then waiting is pure latency. A hard ceiling still bounds the stop, an absent announcement keeps the previous constant, and a consumer that throws cannot break the stop.

### Changed
- **The model registry is derived from the catalog, not listed beside it.** `models_manager` carried its own hand-written table of Whisper repos and size hints, so after the catalog was cut to three sizes `tiny` and `base` still had repos — downloadable through the API while the UI could not offer them, with nothing reporting the disagreement. Repos are now derived by the one naming rule every Systran repo follows (`_REPO_OVERRIDES` exists for a future model that breaks it), size hints are keyed to the catalog, and tests assert the manager's universe of models *equals* the catalog's in both directions. `LOCAL_LIVE_PREVIEW_MODELS` — the cap on what may decode continuously beside a remote provider, so a user who chose `large-v3` for final quality does not get it running live — is now the catalog's first entry rather than a second list; `WHISPER_LOCAL_MODELS` is documented as ordered cheapest-first and a test holds that order against the size hints, so a reorder cannot silently make the live preview heavier.
- **The `smart_format` A/B is settled: the flag is inert.** Run through this app's own REST path with only the flag changed — three of the user's recordings (28.8 s, 77.6 s, 174.7 s; 280 seconds of Russian, six calls) — all three pairs came back **byte-identical**: same characters, word count, punctuation, capitalisation and number formatting. Both comments that disagreed about it were wrong. It does not strip punctuation for Russian, and it is not what produces punctuation either; `punctuate` does that. The value stays at the provider's default because there is nothing here to optimise, and the code now records the measurement instead of two beliefs, so nobody needs to run it again.
- **Both Deepgram paths now format a transcript the same way, from one module.** Live streaming sent `smart_format=true`, prerecorded REST sent `smart_format=false`, and each carried a comment asserting the other was wrong — so the same recording came back formatted differently depending on which path served it, with nothing telling the user which did. The premise for disabling it, that Deepgram strips punctuation for Russian, is contradicted by the live path's own output: 3646 sessions run with it enabled, and 23 sampled transcripts carry a median of **60.3 punctuation marks per 1000 letters** (an earlier archive-wide measurement found the same direction, 50.7 against 36.6 on the path that disabled it "to protect punctuation"). `backend/deepgram_format.py` now owns `smart_format`, `punctuate` and `filler_words`; `DeepgramLiveConfig` no longer carries private copies, and options only one endpoint accepts (`paragraphs`, `numerals`, `endpointing`, `utterance_end_ms`) stay with their path because they are genuinely path-specific rather than a second opinion. `TRANSCRIPTOR_DEEPGRAM_SMART_FORMAT` flips the shared value without a code change, and a test asserts the two paths agree, so they cannot drift apart again. What stays unproven is the narrower question of whether enabling it improves the batch path specifically — only a same-audio A/B answers that, and it spends live API calls against the user's key.

### Fixed
- **Eight stops in sixty-nine delivered less text than the provider had returned.** Measured by pairing `finalize EXIT text_len` against `[trace stopLive] FINAL transcriptLen` across a day of real recordings; the saved files name what went missing, and it is mid-sentence, not at a seam: `старая база данных отклоняет пароли. Я ж тебе скинул` delivered as `старая база данных Я ж тебе скинул`, `вот так, чтобы стоял Вот, и отправь` as `вот и отправь`. Three functions were answering one question — pick the richer text, graft the candidate's tail, or keep what we hold — and each loses a different half. `unionTranscripts` aligns the two readings by their longest common subsequence and keeps every word of both: shared runs take the authoritative wording (it decoded the whole recording with context), a run only one side has is inserted where the alignment places it, and where both decoded the same span differently the authoritative reading wins. It falls back to the pick when the texts share too little to be the same speech, or when either is long enough that alignment would cost more than the stop path can spend. `mergeTranscriptTail` is gone — the union subsumes it, and its production case is now one of the union's fixtures.

- **A word re-heard slightly later is the same word.** The local live path decided a word was new when its END fell past the emit watermark. A re-decode of already-committed audio answers yes to that whenever its estimated end drifts — which both engines do, by more than `emit_epsilon_sec` — so the second reading was emitted again. The text guard cannot catch these: they are the same speech rendered differently (`пять` re-decoded as `56789`, `сам` as `самое`), sharing no token. Coverage is now decided by a word's CENTRE, which moves half as far under the same drift, and which is the rule the Deepgram path's interim splice already applies to the same question. Measured on a real recording, replayed through the shipped pipeline under both rules: overlapping segments **10 → 2**, 26 words → 21, with the removed five being re-decode debris (`и дальше` after `дальше`, a repeated filler). The trade is stated plainly: where the first reading was the poorer one, it is the reading that survives — a streaming path cannot retract what it has already emitted.

- **The capsule stayed invisible for a whole recording.** Reported after a press produced no capsule at all; the next press showed one already reading six seconds. The log agrees — the window was created in 198 ms at the start and first painted 6 s later by the stop. `ensureRecordingStatusCapsuleWindow` returned the window as soon as `new BrowserWindow` had constructed it, before its document had loaded, so a caller handed it mid-load fell out at the `recordingStatusWindowReady` check. That was harmless while some other caller was still going to paint — and stopped being harmless the moment every update took a sequence number: the early return had already claimed the newest number, so the caller that *was* waiting for the load saw itself superseded and skipped its paint as well. Both left; nothing painted. Every caller now waits for the in-flight load, which is what makes the sequence guard sound: it may only ever drop a paint in favour of one that will actually happen. A dropped update also says so in the log instead of returning silently.

- **The model dropdown and the engine that ran disagreed.** The user selected GigaAM, the selector showed a GigaAM model, and five consecutive sessions transcribed with Whisper `small` — the WS query in the log says `model=small` on every one of them. `setTranscriptionSelection(group, model?)` stored the model only when one was passed, and the group selector's change handler has none to pass, so switching group left that group's model slot empty. From there the two sides answered "what is selected here?" differently: the selector rendered `group.models[0].id` while the reader of the selection fell back to the global default model, which is a Whisper id. One `defaultModelForGroup` now answers for both, preferring a model whose engine is actually installed, and `selectedLocalModel` falls back inside the chosen group before it falls back to the global default — answering with a Whisper model for a GigaAM group is a silent engine switch.

### Changed
- **Three Whisper sizes instead of five, and one GigaAM instead of two.** `tiny` and `base` were choices with no reason to choose them: fast in exchange for a transcript that needs correcting. `small` is the default and the floor, `medium` and `large-v3` the steps above. The GigaAM pair differ by decoding head, not by hearing: `e2e-rnnt` is trained end to end over a 1024-piece SentencePiece vocabulary, emits punctuated normalised text directly and decodes faster, while plain `rnnt` has a 33-character vocabulary and emits lowercase without punctuation — it exists so word-error rate can be scored without case and punctuation absorbing errors. That is a benchmarking tool, not a dictation engine. The live-preview model list followed the catalog (it pointed at `tiny`/`base`, both now gone), and four tests that hardcoded retired ids now read them from the catalog.

- **Local engines repeated the window overlap into the transcript.** Reported against both faster-whisper and GigaAM, and visible verbatim in the reports themselves: `насколько он хорошо. хорошо работает`, `какие-то проблемы. проблемы, может быть`, `у этих чуваков чуваков еще Чанкова`. The local live path decodes a rolling 8 s window and re-feeds 1 s of already-committed audio at its head so a word on a boundary is decoded with context — the head of every pass is therefore a second reading of speech already emitted. It was removed by timestamp alone: a word whose end fell at or before the watermark plus `emit_epsilon_sec` (50 ms) was dropped. But both engines re-estimate word times on every pass and drift by more than that, so the second reading survived the trim and was emitted again. Timestamps cannot settle it — both readings are equally plausible. The text can: the longest run of words at the head of a new segment that repeats the tail of what was already said is the overlap, and it is now dropped, bounded to ten words so a genuine repetition further along is never touched. `trim_repeated_prefix` is pure and unit-tested against the reported transcripts. One existing single-flight test had a stub returning the *same* words on both passes and asserted that the second was still emitted — it now returns distinct text per pass, because a fixture that repeats itself was asserting the duplication.

## [1.4.0] - 2026-08-25

The release that fixed the things that had been quietly costing words and
seconds on every single recording. Every entry below was accepted on a
measurement taken from production logs, and the ones that were wrong the first
time are marked as such — including two regressions introduced and corrected
inside this release.

Headline numbers, all measured on this tree:

| | before | after |
|---|---|---|
| hotkey press → renderer | 110-380 ms | 2-29 ms |
| press → first captured audio frame | never measured | 182-230 ms |
| paste | 592 ms (p50) | 235-374 ms |
| finalize, empty tail | 962-1011 ms | ~460 ms |
| the last word of a sentence | missing in ~45 % of stops' worth of risk | captured |

### Performance
- **A hotkey press reaches the microphone in one round trip.** The press had to survive three sequential `executeJavaScript` calls to the renderer and a capsule-window create before the toggle event was dispatched: `renderer_ready_check` → `queryRendererRecordingState` → `publishRecordingStatus` (110-380 ms, because the capsule is destroyed 8 s after going idle and most presses pay a fresh create) → an awaited `osascript` frontmost-app lookup (60-250 ms). The three questions are one question — the toggle handler reads both facts anyway — so `dispatchRendererTogglePress` asks and acts at once, with `allowStart` carrying the main process's veto (post-stop work holding the single capsule, microphone permission not granted) so a start that could not proceed is still refused. `getMediaAccessStatus` is synchronous, so the granted case costs nothing. The capsule is published, not awaited. The frontmost lookup is fired at the press and read after the start is confirmed — it reports the same app either way, and auto-paste needs it at stop.
- **The paste stopped waiting on itself: p50 ~590 ms, ~240 ms of it fixed sleeps that nothing observed.** `set frontmost of p to true` followed by `delay 0.08` ran on every paste; the log says the target was already frontmost in **1459 of 1459** of them, because Transcriptor never takes focus (the capsule is a non-focusable window). The activation is now conditional on `frontmost of p is false` — the safety net survives, the delay does not, and the returned reason carries `+activated` when it does fire, so the assumption stays measurable. The `delay 0.16` between clicking the target's Paste menu item and returning was 160 ms added to exactly the moment the user is waiting for: nothing after it observes the paste, the clipboard restore does not run for at least 1.5 s, and the auto-send Enter carries its own settle (220 → 380 ms, so the paste-to-Enter interval is unchanged).
- **The short post-Finalize window now covers only the tails it was measured on.** Shipping it against `_tail_needs_flush` applied a 0.25 s window — measured on stops whose gap was 0.06-0.24 s, pure boundary jitter — to every tail that did not need a *retry*, a band up to `TAIL_GUARD_MIN_SEC` (0.75 s) wide. "Needs a retry" and "has nothing left to flush" are different questions, and collapsing them cost a user the end of a sentence: production 2026-08-25 14:33:16, `gap=0.50s speech_in_gap=0.00`, stream closed 0.25 s after Finalize, transcript delivered ending `…чтобы никуда не не`. Half a second of audio past the last final that no interim had decoded either — exactly what Finalize exists to force, and the answer takes a round trip the window was too short to receive. Three of the stops recorded in the hour it shipped were in that band (gaps 0.39, 0.50, 0.58 s). Three cases now: an empty tail (≤ `COVERAGE_GAP_MIN_SEC`) keeps 0.25 s, a small but real tail gets the 0.75 s sized from actual round trips, an uncovered tail keeps the full ceiling and the retry. The timeout log also stops printing "nothing was unflushed" over half a second of unflushed audio — it reports what was measured and lets the reader conclude.
- **The post-Finalize confirmation window was sized from the wrong population.** 0.75 s came from the round trips of sessions that *received* a post-Finalize transcript — all uncovered-tail sessions, where `Finalize` has something to flush and therefore answers. A covered tail is the case where it does not, and every covered stop recorded since the split shipped — **9 of 9** — waited out the whole window and got nothing, at 962-1011 ms per finalize. A number never once reached is not a margin, it is a fixed cost: 0.75 → 0.25 s, still long enough for a message already on the wire. What is risked is bounded by what "covered" means — every streamed second is already inside a finalized segment, so a late arrival could only re-word text we hold, never add missing speech. An uncovered tail keeps the full 3 s ceiling and the retry.

### Fixed
- **The microphone stays open 200 ms past Stop, because the last word was missing from the audio itself.** Reported as "I say the last word, press stop right after, and the word is simply gone". Two saved recordings analysed frame by frame end with speech at full level in their final 50 ms — `0.036 0.045 0.051 0.042 0.041 0.049 0.058 0.051 0.026` — with 0.05 s and 0.15 s of trailing silence. The word is not lost in transcription; it is not in the recording, and no re-decode, tail guard or merge can recover what was never captured. Nor is it rare: across 112 measured stops, **39 % left no trailing silence at all and 45 % left 100 ms or less**. A recogniser also needs the word's release and a moment of silence before it will seal it. The hold is fixed and unconditional — no speech detection, no variable window — and is skipped for a discarded take. It is reported as the first phase of the stop breakdown so the stop chain's published total stays the true distance from the press.
- **A double-tap on the hotkey no longer breaks the next recording.** Reported as "I pressed twice very fast and recording broke". The log: a stop at 07:43:21.900 ending a 3.3 s take, then a press 308 ms later answered with `start blocked by single-capsule post-stop work pending=1` — the second press started nothing, while a 14-character fragment went to the clipboard. The one-capsule-at-a-time guard is right; there was simply no work worth blocking for. A recording shorter than `minRecordingMs` is now discarded outright: no transcript, no history entry, no audio on disk, no `Finalize` sent upstream, and no post-stop work for the next press to queue behind — the capsule just closes. 500 ms, and the archive picked the number: across 3681 recordings the shortest are 0.00 s (six of them, a second press landing before any audio arrived), 0.22 s and 0.25 s, and then nothing at all until 0.55 s. The floor sits inside that gap, so it discards every accident on record (8 of 3681) and nothing that looks like speech. The renderer owns the clock (first captured audio frame) and the threshold, and the main process asks it rather than timing the press itself — two measurements would disagree at the boundary, and that disagreement is the main process waiting for a transcript the renderer had already thrown away.
- **A mis-heard word at the seam repeated the opening of the sentence.** Delivered to the user, 2026-08-25 14:19:55: `Так, ну вроде сейчас сообщение записывается за Так, ну вроде сейчас сообщение записывается, заебись, довольно быстро…` — the whole clause twice. The live source is `committed + snapshot + interim`, and the snapshot is the hypothesis a final replaced; here the final read `…записывается за` where its own interim had `…записывается, заебись, довольно быстро`. Six words agree and the seventh does not. Every existing guard needs the overlap to be exact end-to-end — `base.endsWith`, containment, the suffix/prefix scan — so one divergent word at the seam defeated all of them at every window length, and the hypothesis was appended whole. A hypothesis whose leading words re-decode a run at the end of the committed text now supersedes that run instead of following it: aligned by stem so an inflected re-decode still lines up, and only when the run is at least three words and at least 70 % accounted for, so a common opening cannot swallow committed speech. `composeCanonicalLiveSourceText` moved to `frontend/src/live-source.ts` to be testable at all — the production pair is a fixture, and the guards that already worked are pinned beside it.
- **"I press stop and my words get cut off" was a tie-break, not a lost tail.** The audio and the recognition were both complete. The saved file from the reported recording holds both texts: the backend final ends `…и у меня обрываются слова. В чём проблема?`, the delivered transcript ends `…и у меня обрываются` — and the delivered one carries `несколько слов. Они иногда`, a phrase no final segment ever covered. Two partial views of one utterance, both 27 words, so `richerTranscript` — a *pick* — tied on word count and fell through to "longer string wins". `mergeTranscriptTail` aligns the tail of what we hold against the candidate by stem key (a re-decode with different endings still anchors) at the LAST place it occurs (a repeated phrase grafts after its final appearance) and appends everything past it. No anchor means the texts are not continuations of each other, and there the pick is still safest, so `richerTranscript` stays the fallback. The production pair is a test fixture, next to a test pinning what the old policy returned.
- **The hole warning measured re-decode windows, not speech.** `_uncovered_speech_sec` charged the full span of every interim message carrying ≥8 characters. A rolling interim spans several seconds and can carry two words near its end, so each one reported seconds of "recognised speech that never reached a final" that was never spoken — and that number is shown to the user as a warning that their transcript may be incomplete. Spans now come from Deepgram's word timings, with inter-word silence shorter than the boundary threshold bridged so a breath is not a hole and a real pause still splits the span. A hypothesis that arrives without word timings still contributes its message span: going blind would be worse than over-reporting.

### Changed
- **The support log answers three questions it could not before.** `[trace startLive]` — the phases between the hotkey reaching the renderer and the FIRST CAPTURED AUDIO FRAME, mirroring the stop chain's breakdown; nothing in that path had ever been measured. `[trace tail-gap]` — the verdict on whether a stop believed its tail was complete, which is the whole diagnosis when a user reports a cut-off ending and which existed only in a devtools console nobody had open. `[recording-capsule] visible … create=…ms` — how long the capsule took to appear and how much of it was its window create. Deepgram sessions also log their full query string at connect: `endpointing`, `utterance_end_ms`, `smart_format` and `punctuate` all change what the transcript looks like, and a session whose parameters are absent from the log cannot be compared with one recorded before they changed.
- Detaching the capsule publish makes two writers concurrent, so every intent to change what the capsule shows takes a sequence number and a write that had to wait for its window re-checks it before painting. A slow create can no longer repaint a state the app has left, nor re-show a window a later hide put away.

## [1.3.10] - 2026-08-25

Verified good build: stop latency, memory, idle CPU and the recording tail all measured on
this tree. See the entries below for the numbers each change was accepted on.

### Performance
- **Half a second removed from every stop.** The instrumentation shipped an hour earlier produced its first breakdown: `total=1255ms | stream.getTracks.stop: 1ms → flushWorkletPort: 2ms → waitForWorkletDrain: 467ms → …`. `waitForWorkletDrain` waits for a 120 ms gap with no new frame, bounded at 450 ms — but the microphone track is stopped in step 1 while the worklet node stays connected, so the audio thread keeps calling `process()` and keeps handing over frames of silence. The idle condition can never be satisfied, so the cost was the ceiling, every time. The flush that runs immediately before it already provides a complete barrier: the processor runs `flushPending()` and posts `flush-ack` in the same handler, and a MessagePort preserves order, so every PCM message posted before the ack has been delivered. `flushWorkletPort` now reports whether the ack arrived, and the drain runs only when it did not — which is the ScriptProcessor fallback, where no port exists and the silence heuristic is the only barrier available.

- **~~The tail guard measured audio; it now measures speech.~~ REVERTED — see below.** Almost every recording ends the same way: the user finishes a sentence, then reaches for the stop hotkey. That trailing second or two of silence is streamed audio with no final segment covering it, so `streamed − covered` read it as an unflushed tail and took the retry path — a 3 s wait, a second `Finalize`, another 3 s wait — to discover Deepgram had nothing to send, because there was nothing there. Observed in production immediately after the previous fix shipped: two consecutive sessions, gaps of 3.01 s and 1.94 s, **6272 ms and 6214 ms at finalize**, one splicing a single word and the other nothing at all. With `interim_results` on, Deepgram emits a hypothesis as it decodes, so a trailing region that produced no interim produced no words — and a `Finalize` cannot flush words that were never decoded. `_tail_coverage` now also returns the recognised speech lying past the last final (clipped and merged, so a rolling re-decode cannot double-count), and that is what the guard turns on. Real unflushed speech keeps the full ceiling and the retry, unchanged. With interim results off the audio measure still applies — without hypotheses there is no speech signal, and waiting needlessly is the safe direction.

- **Paste script walks the target's menu bar once, not twice.** The auto-paste AppleScript asked `exists` for a deep accessibility path and then fetched the same path again — two full traversals of another application's menu bar, the most expensive operation in the script. Measured against a live app: 170–240 ms duplicated and visibly jittery, versus a flat 160 ms evaluated once, over a 40 ms `osascript` baseline. The window-title lookup had the same shape. Semantics are unchanged; a missing element raises, which is exactly what the `exists` test was detecting.

- **Stop latency: the post-Finalize wait now sizes itself from tail coverage.** Measured over 706 real Deepgram sessions in `main.log`: median finalize wait 1205 ms, p90 3220 ms, 1053 s in total — and 267 of 410 traced stops (65 %) ended with the streamed audio *already fully covered* by finalized segments, meaning Finalize had nothing left to flush and Deepgram was never going to answer. The coverage figure that proves nothing is missing was computed only inside the timeout handler, i.e. strictly after the ceiling had been paid. It is now measured first (`_tail_coverage`) and chooses the budget: an uncovered tail keeps the full 3.0 s plus the retry (truncating there would cost the user real words), a covered tail gets a 0.75 s confirmation window — sized from 411 measured round trips whose p95 is 0.49 s and max is 1.49 s.
- **Deepgram session summaries carry the whole picture** (`streamed_sec`, `text_len` added), and the finalize log lines now print `streamed / covered / gap` so a truncated tail can be diagnosed from the log alone instead of inferred.

- **Idle memory cut from ~1.4 GB to ~0.5 GB**: the backend loaded faster-whisper (plus ctranslate2, PyAV and the Silero VAD) on *every* launch, regardless of the selected provider — 767 MB resident, 1.3 GB peak, and 5-16 s of startup CPU even for users who transcribe exclusively through Deepgram or OpenRouter. The unconditional startup warm is gone; `scheduleLocalWarmup` now fires only when `resolveEffectiveProvider` actually resolves to `local` (missing/unusable remote key, or offline), and re-fires on the connectivity transition that creates that condition. Measured backend footprint after the change: **60.9 MB** at rest, no `ctranslate2` / `av` / `tokenizers` mapped into the process.
- **Local models are released after 10 minutes idle** (`TRANSCRIPTOR_WHISPER_IDLE_UNLOAD_SEC`, 0 disables): the LRU cap only ever evicted on *insert*, so a single local transcription pinned its model until quit. Measured: 504 MB → 116 MB after one sweep.
- **`/api/transcribe/warmup` short-circuits when the model is already resident**: the renderer calls it on startup, on provider change and on every network flip, and each call re-ran two full synthetic transcriptions. Repeat call now costs 15 ms instead of 4.7 s. Residency — not a stale warm record — is the authority, so a model dropped by the idle sweeper still re-warms.
- **The recording capsule no longer outlives the recording**: its window was created on the first recording and lived until quit — a second permanently resident renderer process (~64 MB and its own V8 isolate) that, created with `backgroundThrottling` disabled, kept compositing while hidden and burned ~13% of a CPU core at idle, dragging the shared GPU process with it. The window is now destroyed 8 s after going idle and re-created on demand.

### Changed
- **The radius scale is the only place a corner is decided.** A census of the stylesheet found 15 distinct `border-radius` values, of which a third were raw pixel literals sitting alongside tokens that already carried the same number: `999px` is what `--chip-radius` means, `10px` is `--control-radius`, `8px` is `--radius-sm`, `12px` is `--radius`. Sixteen such literals now use their token, which is a pure de-duplication — each value *is* the token's value, verified in a live page: every token resolves to exactly the literal it replaced and real elements measure unchanged (chip 999px, controls 10px, cards 12px). `6px` was used four times with no token at all, so the scale did not cover what the design actually used; it gained `--radius-xs`. What deliberately stays literal: `50%` on circular dots, where a token would hide the intent, and four genuine one-offs.

- **History list rebuild: ~1250 ms → ~85 ms** (measured on this archive's 5907 transcripts). Rebuilding the list read the full text of *every* transcript to parse four header fields and probed *every* accepted audio extension per item to find the sibling file — ~12 MB of reads and ~100k `stat()` calls. And it ran constantly: the list cache is invalidated after every single save, so the first History load after each recording paid the whole rescan. Two structural fixes, no change to the response contract: a per-transcript metadata cache keyed by identity + `(mtime_ns, size)` (a saved transcript is immutable, so every unchanged file becomes a dict lookup; the cache is pruned to exactly the files each scan sees, so deletions cannot leak it), and one directory listing per archive dir that builds a stem→audio index in place of the per-item extension probe.
- **History list renders a window, not the whole archive.** Every filtered item used to get its own DOM row — ~35 000 nodes at 5907 recordings, for a list showing about twenty. `frontend/src/list-window.ts` (unit-tested) caps what is materialised at 200 rows and grows by 200 as the user scrolls toward the end. Search, keyboard navigation and selection still operate over the complete filtered set — only the DOM is bounded — and the window always extends far enough to contain the selected row, so `moveRecordingSelection` keeps working. Growth is monotonic within a filtered set (scrolling back up never tears down rows), and resets when the set is replaced: a new search query or a fresh archive load. A "Showing N of M" line under the search box keeps the truncation honest.

- **Background polls suspend instead of spinning.** `createGatedPoll` (`frontend/src/gated-poll.ts`, unit-tested) is now the one scheduler behind every recurring renderer refresh. The old shape — `setInterval(() => { if (hidden) return; refresh(); }, 2000)` — still pays for the wakeup, and the main window runs with `backgroundThrottling: false` (needed so recording survives an alt-tab), so Chromium does not clamp those timers the way it would in a normal tab. A closed gate now costs **zero** wakeups. Consumers: the Settings→Shortcuts conflict badge (was 2 s forever, now only while that pane is on screen), the network-state pill (only while the window is visible; an OS online/offline event refreshes immediately instead of waiting out the interval), and the local-models list. Ticks are chained rather than interval-driven, so a request slower than the cadence delays the next wakeup instead of queueing callbacks behind it, and a throw or rejection is reported without killing the poll.
- **Global-shortcut changes are event-driven.** The renderer published every shortcut edit on *two* channels: the `__app_shortcuts__` bridge message, and a `window.__transcriptorPendingShortcuts` value that the main process fetched with an `executeJavaScript` round-trip every 2 s for the entire life of the app. The bridge message already carries the accelerators, and it is strictly better — it arrives the instant capture finishes rather than up to 2 s later, and it is the only channel that can express the capture lifecycle at all. The poll, its handle, its teardown and the renderer-side duplicate are gone; one channel now carries the fact.

- **Audio retention is now per collection, and declarative.** The old rule — "only the newest recording in the archive keeps its audio" — was a single global cardinality answer applied to two collections with different economics, and it was written twice (once for the per-save path, once re-derived from the newest transcript for the startup sweep). It also meant a voice note lost its audio the instant the next one was recorded. Retention is now a data table (`AUDIO_RETENTION_POLICIES`) keyed by collection, with two composable dimensions evaluated by one function:
  - **Live Capsule** (voice notes): keep the audio of the newest **3** takes (`TRANSCRIPTOR_LIVE_AUDIO_KEEP_COUNT`).
  - **Uploaded Media** (track extracted from an uploaded file): keep for **7 days** (`TRANSCRIPTOR_UPLOAD_AUDIO_RETENTION_SEC`).
  - The archive root inherits the Live policy — it predates the collection folders and held voice recordings.
  - **Transcripts are never deleted**, at any age or count, in any collection.
  A recording just saved is exempt from deletion but still occupies a slot in the count ranking, so a clock skew can never let a save collect its own audio. Age limits also get an hourly background sweep, because a long-running app would otherwise never revisit files that aged out while it was up.

### Fixed
- **Reverted: gating the tail guard on recognised speech. It lost four seconds of a real sentence.** The reasoning was that with `interim_results` on, a trailing region producing no interim produced no words, so a `Finalize` could not flush what was never decoded — which would let a pause before Stop close fast instead of paying the retry path. The premise is false in exactly the case the guard exists for. Measured in production one stop after it shipped: `streamed=20.08s covered=16.07s gap=4.01s speech_in_gap=0.00s` — four seconds of speech, reported as zero, because Deepgram had stopped emitting interims 3.7 s before Stop and then never flushed the final either. A provider going quiet and a user falling silent are indistinguishable to that signal. Uncovered **audio** decides again; recognised speech can only add a reason to retry, never remove one. The cost is that a pause before Stop still pays the retry path — losing a closing sentence is not a trade worth three seconds. `speech_in_gap` stays measured and logged, because telling the two shapes apart after the fact is how this was caught.

- **The per-stop latency breakdown was computed on every recording and thrown away.** `stopLive` already times each phase of the stop chain — `flushWorkletPort → waitForWorkletDrain → stopMediaRecorderAndFlush → pcmSink.finalize → …` — and emits it as one `[trace stopLive]` line. Severity is the right default rule for the console mirror, but it misfiled this: a summary emitted once per recording is not chatter, and sitting behind the debug flag with the thousands of per-step `[trace]` lines meant that when a user said "the transcript took a very long time" the answer existed only in a devtools console nobody had open. Summaries are now always mirrored (prefix match, so a transcript quoting the prefix cannot smuggle itself in); the high-volume stream stays behind the flag. The chain also gained a `wsFinalizeSent` mark, because the interval between Stop and telling Deepgram the recording ended was invisible — measured on one real stop at **1.4 s**, spent on local canonical-audio work while the upstream flush had not yet begun.
- **Permission denials said what, never why.** A recording start produces six decisions in ~40 ms and some are denials *by design*: Chromium probes video alongside audio, and `selectAudioOutput` asks for a capability this app does not use. Both logged as a bare `perm=media allow=false`, which reads as "the microphone was refused" — and was indistinguishable from an actual refusal, so the one line worth spotting was camouflaged by 70 that meant nothing was wrong. Each decision now carries the media types and a reason.

- **A write landed inside the audio spool's own close, and blamed the disk for it.** `OpfsPcmSink.finalize` awaits `writable.close()` and only nulls `writable` after it resolves — so for the whole duration of that close, a microtask flush scheduled by a late `append` still saw a non-null stream and wrote into it. The stream rejects that with "Cannot write to a closing writable stream", which the catch reported as **"disk may be full or permissions revoked"**: an internal ordering bug, told to the user as failing hardware, and it also set `lastWriteError`, diverting finalize onto its salvage path for a perfectly healthy disk. A `closing` flag is now set *before* the close is awaited and checked by the flush, because `writable` being non-null cannot be the test for "may I still write". Samples arriving past the drain barrier are counted and reported rather than dropped silently — a rising count would mean the barrier itself is wrong. Only visible at all because the renderer console mirror and readable error text landed first; before that it was `[object Object]` in a log nobody received.

- **Retries were invisible latency.** Every remote transcription and upscale call passes through `request_with_retry`, and the module had no logger. A user whose upload took eight seconds because the provider answered 429 twice saw only that it was slow, and the support log agreed with them. Retries now record the status or exception, the wait, and — importantly — whether the wait came from our backoff or from the provider's `Retry-After`, because a run of `Retry-After` waits is a rate limit rather than a flaky network and the two are fixed very differently. The two paths that give up are WARNINGs: a read timeout on a non-idempotent request, which is abandoned deliberately because the provider may already have done and billed the work, and the final failure, which records attempts and elapsed time so a "the upload failed" report has a history behind it. A clean first attempt stays silent. Log targets are `METHOD host/path` — never the query string, which is where provider URLs carry keys.

- **Focus was drawn three different ways, and the API-key row got two of them at once.** Generic controls used a 2 px `outline` offset 2 px outward, list rows used an outline plus a coloured border, composite fields used a 2–3 px `box-shadow` ring — so a focused key field showed a soft ring on the row *and* a hard outline offset outward from the input inside it, painted straight across the row's own border. One recipe now, expressed as tokens (`--focus-ring-width`, `--focus-border`): a `box-shadow` ring, which unlike `outline-offset` adds nothing to the control's footprint, so focusing never makes a control look taller than its neighbours. The ring is neutral rather than accent blue — it belongs to the same surface family as the plate it sits on, which is what keeps a focused control looking like the same component it was a moment ago. The `forced-colors` blocks still map both tokens to `Highlight`, so high-contrast users keep a system-strength indicator.
- **A saved API key looked unconfigured after you clicked its field.** Focus clears the mask so a click lands you straight into typing a replacement; nothing restored it. Clicking the field and clicking away left it empty, showing the placeholder, so a provider with a perfectly good stored key read as having none. Blur restores the mask when nothing was typed — safe precisely because the mask displays stored state and never *is* it.
- **`activate` with a visible-but-unfocused window now reveals.** Visible is not the same as frontmost: a window can be on screen behind another application, and `activate` is the user explicitly asking for this app. Measured before changing: across 157 activates that skipped the reveal, 156 were already focused and the skip was correct — this closes the one that was not, and cannot affect the other 156. The focus event also records `waited_ms` from the activate or reveal request, so "the window does not come forward immediately" stops being a report with nothing in the log to confirm or refute it.

- **Every recording was captured through the deprecated ScriptProcessor, not the AudioWorklet.** Vite inlines assets under 4 KB as `data:` URLs, and `pcm-worklet.js` is 2.3 KB — so every production build emitted the PCM capture processor as `data:text/javascript;base64,…`, which the page CSP (`script-src 'self' 'unsafe-inline'`) quite correctly refuses. `audioWorklet.addModule()` rejected on **every single take** and the catch fell back to ScriptProcessor: capture on the main thread, dropping frames under load, instead of on a dedicated realtime audio thread. Measured once the renderer console mirror was repaired: **5 fallbacks in 5 capture attempts, 100 %**. The CSP is not the thing to relax — `script-src data:` is a standard XSS vector, and the policy was refusing an artifact the build should never have produced; the worklet is now emitted as a real file served from `'self'`.
- **Renderer failures logged their context but not their reason.** `console.warn("context", err)` formats a caught error as `[object DOMException]`, so the support log recorded that the AudioWorklet fallback happened while discarding the one field that explained it. Fixing ~25 call sites would have fixed the 25 that exist today; `frontend/src/error-text.ts` fixes the formatting once, for every site present and future. The error `name` leads, because that is what separates a CSP refusal from a permission denial from a cancellation.

- **The upload pipeline left no trace at all.** `backend/jobs.py` had no logger, so the only record of an upload or from-path transcription in main.log was the uvicorn access line for the POST that created it — not whether it started, how long it queued, how long it ran, what it produced, or why it stopped. A user reporting "I dropped in a file and nothing came out" produced a support log with nothing to read. Every transition is now recorded in the store itself, which every caller passes through, so a new call site cannot ship silent: start with its queue wait, completion with duration and text length (an empty-but-successful transcription used to be indistinguishable from a real one), failure at WARNING with the reason and the progress it reached, and cancellation with how far it got. Fields are snapshotted under the lock and emitted after releasing it, so a blocking write to stderr cannot stall every other job's state transition.
- **ffmpeg conversions were timed nowhere.** `backend/audio.py` logged failures only, so decoding a source file — the heaviest step in the upload pipeline, tens of seconds for a long video — was indistinguishable in the log from a fast conversion or from none at all. `_run_ffmpeg`, the one runner every invocation in the module goes through, now records duration and input/output sizes on success and adds the elapsed time to both failure paths.

- **The microphone chip had no capsule because JavaScript kept deleting the class that draws it.** `renderMicHealthPill` assigned `pill.className` wholesale, which also wiped `status-chip` — the class giving all three topbar chips their shared background, border and radius. From the first state change onward the chip rendered as bare text beside two capsules, and no stylesheet fix could show, because the markup had already lost the class the rules were keyed to. Only the state class is swapped now; a state writer does not own the whole class attribute.
- **Topbar controls share one height.** The Record button took `--h-control` (40 px) and stood beside MIC and LANG selects on `--h-topbar-control` (34 px). The row already had a token meaning "the height of a topbar control"; the button simply had not joined it. Its "Rec" caption also aligns left like its neighbours instead of being pinned right.
- **The API-key row was a control drawn inside a control.** The action button inherited `.icon-btn`'s background, border and inset shadow — the same surface `.key-row` already paints — so the field rendered as a box containing a second, identically-coloured box. It is flat until hovered now, like a clear-button in a search field, and the input no longer carries a second copy of the row's padding.
- **Model sizes finally line up.** Verified numerically: all seven rows, including the two GigaAM rows that carry no action button, now share one right edge.
- **Settings header is one row.** Title left; version and "Check for updates" right. They were stacked under the heading, costing two rows of vertical space on every visit while the right half of the header sat empty.

- **Rescued words lost their punctuation.** Deepgram returns two spellings per word — `word` (raw) and `punctuated_word` (after the `smart_format`/`punctuate` options we request). The two providers disagreed about precedence: the batch path preferred `punctuated_word`, the live path preferred `word`. The live form was not a fallback chain at all, since `word` is populated on every word Deepgram returns, so the formatted spelling was unreachable. It mattered on the path that exists to *improve* quality: the live provider keeps interim words so `_splice_uncovered_interim_words` can fold back speech no final ever covered (43 such repairs across the shipped logs), and each rescued word entered the transcript raw — unpunctuated, uncapitalised — inside otherwise punctuated prose, so the repair announced itself. `backend/deepgram_words.py` now owns the decision and both providers import it.
- **Topbar chips, the Record control and the model table**, from user-reported screenshots: the microphone chip expressed its state with an `outline` while its two neighbours use the dot's colour — a difference of *kind*, painted outside the border box by separate machinery, so it rendered as a hard rectangle pinned beside two rounded pills; state is now a tint on the chip's own border. The Record button had no caption, so flex baseline alignment floated it above its labelled MIC/LANG neighbours; it is now a captioned `.top-item` like them, right-aligned via the wrapper so the caption travels with it. Model sizes still did not line up because every row was an independent grid — grid tracks are sized per container, and the GigaAM rows carry no action button, so their trailing `auto` track collapsed and shifted their cells; the table now owns one set of tracks and each row adopts them with `grid-template-columns: subgrid`, keeping per-row backgrounds while aligning every column down the card.

- **Discarding a live recovery left its sidecar behind.** `_live_recovery_paths` resolves the spool/sidecar pair by globbing for the `.pcm16`, so once the spool was gone it reported "no such recovery" and the delete returned immediately — orphaning the `.json` with nothing left that could ever name it. Measured on a real machine: 207 orphan sidecars against a single live spool, one per recording of the past day, cleared only by the 24 h retention sweep. Both halves are now removed independently, sidecar first so that a sidecar which cannot be deleted still leaves the audio in place (an orphan `.json` advertising a recovery whose PCM is gone is worse than leaving both for the sweep).

- **Nothing the renderer logged had ever reached the support log.** Measured across the entire archive set: zero `[renderer …]` lines, in any file, ever. Two independent causes, either sufficient on its own — the mirror was gated behind a development-only flag so every shipped build had it off, and the handler read Electron's pre-36 `console-message` signature `(event, level, message)` while the bundled Electron is 42, which passes `(event, details)`, so even with the flag on it tested the string `"undefined"` for a `[trace` prefix and matched nothing. Every renderer-side failure was therefore invisible: the recovery that could not be promoted, an AudioWorklet falling back to ScriptProcessor (a real capture-quality downgrade), a failed saved-audio fetch, a rejected key save. Diagnosing a user-visible error banner meant reproducing it by hand. `desktop/renderer-console.js` (pure, unit-tested) now owns the policy: **severity decides, not a string prefix** — warnings and errors are always mirrored, `[trace…]` stays behind the debug flag because it is thousands of lines per session, and routine info/debug is dropped. Both call signatures are normalised so the mirror survives the next Electron upgrade instead of silently going dark again; messages are newline-folded to one log line and length-clipped so a runaway dump cannot flood the file.

- **There was no way to record from inside the window.** The Live view had a microphone picker, a language picker and three panes, but no Record control — `setRecordButton()` had not painted a button in a long time, it only flipped a flag, and the renderer's own comment said recording "is controlled by global hotkey events". A hotkey the OS or another app had claimed therefore left the user unable to record at all, with nothing on screen to suggest why. The Live topbar now carries a Record/Stop button. It does not start recording itself: it asks the main process to run the same `toggleRecordingFromShortcut` the hotkey runs, so the microphone-permission prompt, the frontmost-window capture auto-paste depends on, the recording capsule, the single-capsule busy guard and the trace all behave identically whichever way the user asked. `setRecordButton` stays the single writer of the flag and now paints the control from it, so a recording started by hotkey shows a Stop button and vice versa.

- **"Could not recover 1 interrupted recording" on every launch.** A session interrupted by a crash, a SIGKILL or an installer leaves its recovery sidecar saying `status: "recording"` — that field is written when the session opens and only rewritten when it closes. The promote guard read it as "this session is still streaming" and answered 409, while the list endpoint happily offered the same session as recoverable. The renderer promotes every listed recovery at startup, so the pair produced a permanent, self-renewing failure: the message reappeared on every launch and the audio stayed unreachable. Liveness is process state, so it is now answered by an in-process registry that is empty at startup by construction — after a crash nothing is registered, so a stale "recording" sidecar reads as exactly what it is. Both endpoints consult the same predicate, so the list can no longer offer what promote would reject.

- **A live transcription that returns nothing is no longer silent.** 29 of 706 sessions (4.1 %) ended with zero final segments, 21 of them after more than 2 s of streamed audio — the renderer falls back to REST so the user usually still got their text, but the live path having failed left no trace above INFO. Now a WARNING carrying `interim_segs` (which separates "Deepgram never recognised anything" from "recognition worked, the flush failed"), the connect/finalize timings and the upstream error.
- **The support log is no longer three-quarters polling noise.** On a real 42 833-line archive: `GET /api/health` 29.5 %, `GET /api/network` 29.5 %, `PUT /api/ui/live-draft` 15.5 % — while the 135 recordings actually saved were 0.3 %. A `uvicorn.access` filter drops **successful** requests to the four paths the UI polls on a timer; a non-2xx on those same paths is kept, since a failing `/api/health` is the most useful line in the file. This also slows rotation, so real history survives longer than ~1.5 days.

- **AudioContext leak, one realtime audio thread per failed recording start**: `stopLive` returned early whenever `isRecording` was false — exactly the state `startLive`'s error path funnels into after the AudioContext exists but before the flag flips — so the context, its MediaStream and its AudioWorklet were never released, and Chromium keeps a running context's realtime thread and V8 isolate alive forever. Every teardown path now vacates the single-owner `ac` slot through one `closeAudioContextSlot`, and a start that finds the slot occupied closes and reports it instead of overwriting.
- **Log archives are capped at 7 days** in addition to the existing count/byte caps, so a heavy-logging stretch can no longer pin 50 MB of months-old archives.

## [1.3.9] - 2026-08-25

### Fixed
- **Audit wave 2 (BUG-39..52)**: offline machines no longer stall boot on a pip attempt (engine install is never part of the boot path); a failed model-download request can no longer pin `#model` to an un-downloaded model; config loading survives an unusable encryption keyfile instead of raising; the model-manager card derives its button/state from row state in both create and update paths; dead full-audio WAV write removed from the GigaAM adapter; model download progress is byte-weighted; cancelling the download modal restores the previous model choice.
- **GigaAM adapter contract**: empty-audio early return carries the full result shape (`text`, `language_probability`); model cache is LRU-capped (`TRANSCRIPTOR_GIGAAM_CACHE_SIZE`, default 1).
- **Backend hygiene**: recordings cache-key probe moved off the event loop; recovery session-id fallback handles ids containing underscores.
- **Audit wave 1 (BUG-24..38)**: GigaAM ids now work on every path that accepts them — file jobs, re-transcribe and warmup dispatch to the engine instead of crashing inside WhisperModel; the adapter emits faster-whisper's word-spacing convention and full result shape (live trim no longer glues GigaAM words, sync transcriptions no longer lose text); >20 s audio is chunked with a 1.2 s overlap and stitched by word time, so boundary words are neither truncated nor duplicated; Settings cards no longer paint inputs outside their borders (grid rows now measure real content); uploads honor the selected local model; a model choice made before its download finishes applies automatically; the Local-models card states loading/offline instead of rendering blank.
- **Audit wave 2 (BUG-53..76)**: POST requests are no longer retried on read timeouts (a provider may have processed — and billed — the first attempt); saving settings with an unusable key file returns a clean 503 instead of a raw 500; the finalize splice deduplicates orphan words that a newer hypothesis re-decoded at shifted times; model rows carry reconciler keys (no full-table rebuild every 2 s); the upload queue snapshots the model at enqueue time and gates availability; the model `<select>` rebuilds only when options change (an open dropdown survives the health poll); the live WS handshake buffer is capped in output samples (4 s of audio, was ~1.3 s — slow handshakes no longer drop opening words); the engine installer logs real pip stderr, gates on 8 GB free disk, installs into a fresh staging tree swapped in atomically, and boot-sweeps retired trees; pip children are killed on quit; a backend spawn error releases its dead handle so restart works; stereo channel split writes atomically; job progress is monotonic; OpenRouter audio-support detection no longer misfires on the word "image" and upscale shape errors are reported verbatim; the seam merger no longer mutates caller segments; the post-Finalize event is armed before the send (both paths); the stop-time forced flush is bounded; GigaAM models load under per-model locks; a failed model download releases the pending selection; the microphone-acquire timer is cleared on success (no unhandled rejection per recording); persisted queue/draft payloads are version-gated; the boot status line replays into a reloaded window; desktop and frontend package versions are equality-tested.
- **Audit wave 2.5 (BUG-77..81)**: a JSON-null Deepgram transcript no longer crashes the provider call; the engine import probe allows 60 s for a cold torch load; the install network gate validates TLS (captive portals that pass TCP now fail fast with a clear reason); global hotkeys are re-registered on system resume.
- **Runtime failure attribution (BUG-82)**: when the bundled runtime fails its import check, a clean-environment re-probe distinguishes engine-site shadowing from a genuinely damaged bundle — the error names the real cause instead of blaming the bundle.

### Changed
- **Engine install is user-initiated** (Settings → Local models → "Install engine"): explicit consent, network/disk gates, staged install with atomic swap, backend auto-restart after success. Boot never installs the engine.
- **Dependency-overlap policy** (`desktop/engine-deps.js`): engine-site may only add names the pinned bundle lacks — every overlap is pruned when the bundle satisfies all declared requirements and fails the install loudly otherwise. Boot-time reconcile heals pre-existing dirty installs.

## [1.3.8] - 2026-08-24

### Fixed
- **numpy shadowing**: the GigaAM stack installs its own numpy into engine-site, which would shadow the bundled runtime's pinned numpy for every import. The installer now prunes duplicate `numpy`/`ml_dtypes` after install — the bundle provides the single numpy; torch/gigaam are verified to run against it. *(Superseded by the generalized overlap policy in Unreleased.)*

## [1.3.7] - 2026-08-24

### Fixed
- **GigaAM engine location**: torch must never live inside the signed `.app` — writes break the code signature and every update wipes them. The installer now targets `userData/engine-site` via `pip --target`, and the backend imports the engine through a prepended `PYTHONPATH`. Both files (`requirements-gigaam.txt`, `ENABLE_GIGAAM`) now ship inside the bundle's resources, so packaged installs can actually see the opt-in.

## [1.3.6] - 2026-08-24

### Fixed
- **GigaAM never installed on existing setups**: the engine installer lived inside the requirements.txt reinstall branch, which healthy venvs skip entirely (early return on import check). Installation is now an independent gate — it runs whenever ENABLE_GIGAAM exists and `import gigaam` fails, on every launch path.

## [1.3.5] - 2026-08-24

### Added
- **GigaAM-v3 engine (Sber)** — Russian-only local ASR alongside faster-whisper: `gigaam-v3-e2e-rnnt` / `gigaam-v3-rnnt` in the same model catalog, dispatched to a new adapter that maps upstream results (incl. word timestamps) onto the existing segment shape; >20 s audio is auto-sliced under the upstream 25 s cap. Opt-in install via `ENABLE_GIGAAM` marker → app venv (never bloats the DMG); selector disables entries whose engine is missing.
- **Settings → Local models**: per-model download management — presence detection via HF cache, one-click Download with live progress, ✓ when stored. Selecting a missing model now asks first ("Download it now?") and applies the choice automatically once the download lands.

### Fixed
- **BUG-24**: superseded interim hypotheses no longer destroy the only record of unconfirmed speech — an orphan pool feeds the finalize splice (root cause of backend-side mid-recording holes).

## [1.3.4] - 2026-08-24

### Fixed (expanded audit wave 2 — desktop/main.js, backend API surface, config/persistence layer)
- **live.py single-flight**: a Stop-time forced flush could run concurrently with an in-flight periodic pass — overlapping windows interleaved emits (duplicate/out-of-order tail text). Forced flush now awaits the running pass; periodic ticks during a pass are skipped.
- **Recovery promote TOCTOU**: promoting a session that is still recording truncated the WAV and unlinked the PCM out from under the live writer; now rejected with 409.
- **Backend kill escalation on exit paths**: SIGKILL escalation lived in a timer that cannot fire during `process.on("exit")`/signals — hung uvicorn could survive as an orphan. Signal paths now escalate after 250 ms; the exit path escalates synchronously.
- **Port picker degenerate fallback**: ephemeral port `0` fell back to a port just proven occupied → EADDRINUSE crash loop. Now retried, then extended scan.
- **config.py keyfile contract**: Windows branch overwrote an existing-but-unreadable keyfile (permanent loss of all `enc:` values) — now mirrors POSIX refusal. Plaintext downgrade when the key is unavailable is refused loudly instead of silently writing secrets. Backup recovery unified between the two config readers (missing-primary case).
- **DEFAULT_CONFIG providers skeleton** derives from `REMOTE_TRANSCRIPTION_PROVIDERS` (SSOT).
- **Log rotation orphans**: crash between rotation renames stranded `*.rotating` support logs forever; swept and promoted at boot.
- Minor: upscale `instruction` capped (413 >20k), stale `enableRemoteModule` removed, http_retry timeout hint corrected.

### Verified clean (wave 2)
preload.js IPC surface · frontend id-wiring/listener-leaks/timers/draft-queue/XSS/settings-races/storage · backend WS disconnect/cancel paths · requirements vs imports · packaging whitelist vs require graph.

## [1.3.3] - 2026-08-24

### Fixed
- **Duplicated trailing phrases in live transcripts**: an interim hypothesis restating its own span with different word forms ("...на визуальную часть" → "...на визуальное") was appended as new content; stem-normalized subsequence matching now recognizes re-statements (seen live, session 20-32-21).
- **Word fragments severed at Deepgram flush boundaries** ("четыре, пя | ть"): adjacent touching finals whose boundary tokens form one vowel-less fragment are re-joined in the canonical transcript.
### Added
- **Finalize tail guard**: when Deepgram stays silent after Finalize AND streamed audio runs past the last final, the flush is retried once instead of closing blind (19 silent-close sessions on 2026-08-24 were benign by luck only).

## [1.3.2] — 2026-08-24

### Fixed
- **Update check "Failed to fetch":** the Content-Security-Policy now allows the renderer to reach `api.github.com`, so "Check for updates" actually works.
- **Build footprint:** a finished build no longer keeps three full copies of the same version (~715 MB → ~470 MB); the root-level internal zip is dropped once the install kit embeds it.

## [1.3.1] — 2026-08-24

### Fixed
- **Live tail truncation (BUG-20):** the end of dictated messages no longer gets cut off. Backend now waits up to 3 s for Deepgram's post-Finalize flush (was 1.5 s; healthy sessions still return instantly); an unflushed interim at the tail counts as proof of speech and triggers tail recovery; proven uncovered speech (>0.5 s) surfaces a visible warning instead of silent holes.

### Added
- **Update detection:** Settings header gains "Check for updates". The app checks GitHub releases at most once per day (plus on demand) and links to the new release page when one exists. Detection only — no automatic download/install.

## [1.3.0] — 2026-08-23

Recording reliability and stop-to-paste latency pass. Every number below
was measured from `main.log`, before and after.

### Added (integration pass, same release)

- **ESLint 9 flat config** as a hard CI gate at zero-warning baseline
  (`npm run lint`; adopted from external PR #4 by @chiliec).
- **GitHub Actions** running all three suites on every push/PR:
  backend unittest on the shipped Python 3.12 runtime (including the
  ten live-coverage TS cross-tests), frontend lint/typecheck/vitest/
  build on Node pinned by `.nvmrc`, desktop node:test.
- **BUGS_AUDIT.md** — full 19-defect audit with per-bug resolution
  status kept in-repo.
 and stop-to-paste latency pass. Every number below
was measured from `main.log`, before and after.

### Fixed

- **Recordings captured pure silence.** `askForMediaAccess` was only
  reached from the global-hotkey path, so starting a recording from the
  in-app button never asked macOS for microphone access — and a renderer
  `getUserMedia` does not reject when access was never granted, it
  resolves with a live track that emits zeros. No waveform, no words, no
  error. Microphone access is now resolved once at startup through a
  single `ensureMacMicrophoneAccess` helper shared by every entry point,
  and the TCC status is read live instead of latched.
- **Quiet recordings and clipped phrase boundaries.** Capture used
  Chromium's call-oriented defaults; echo cancellation and noise
  suppression are tuned for conferencing and both attenuate a quiet
  source and gate low-energy speech. Both are off for dictation, gain
  control stays on, defined once in `DICTATION_AUDIO_PROCESSING`.
- **The opening words of short recordings were dropped.** Frames captured
  while the live WebSocket was still connecting were drained only from
  inside `pushCapturedFrame`, so the flush depended on another frame
  arriving after the socket opened. A recording that ended inside the
  handshake window kept its first frames buffered forever. The socket's
  `open` event now drains them, and stop drains them again before
  finalize.
- **The last sentence went missing when Stop landed mid-phrase.**
  `Finalize` and `CloseStream` were written in the same millisecond, so
  the close raced the transcript Finalize had just flushed. Across 14
  sessions, streams that ended naturally left 0.25 s of audio undecoded
  on average; streams stopped mid-utterance left 1.86 s. `finalize()`
  now waits for the flushed transcript, bounded and short-circuited on
  arrival.
- **A client disconnect was logged as a server error.**
  `_is_broken_pipe_error` matched substrings of the message and missed
  `ConnectionClosedOK`, producing a full traceback thirteen times in one
  session. Classification is type-first and walks the cause chain.

### Changed

- **Stop → text in the target app: 9.56 s → 1.1–1.7 s.** The transcript
  now goes into whatever holds focus rather than restoring a start
  target. The trace showed the target app was *already* frontmost and the
  pipeline still spent 2.46 s restoring it and 2.20 s activating it,
  while Transcriptor's own window bounced forward mid-sequence. Target
  resolution went from 4156 ms to 13 ms.
- **Frontmost-app lookup: ~800 ms → ~110 ms.** `first process whose
  frontmost is true` makes AppleScript enumerate every process;
  `lsappinfo` reads the same facts from LaunchServices. Callers that
  route by window still use the AppleScript path.
- **Local stop no longer re-transcribes what was already decoded.** The
  live assist runs the same model the final pass would in the default
  configuration, so `LiveSession` now reports coverage truth — seconds
  covered, dropped, and left untranscribed — and the stop path adopts the
  live transcript only when the backend certifies full coverage, the
  models match, and no frame was stranded in the renderer.
- **Model warm-up is symmetric.** Startup probed the default model while
  the user-triggered warmup only loaded weights, leaving the lazy VAD
  load and first encoder pass to the first live window. Both probe now,
  and the probe exercises the decode path rather than only silence.
- **Recording capsule** narrowed 1.25× to 110 px, waveform column kept at
  30 px with a taller 15 px envelope, and the pill is fully opaque.

### Added

- **Microphone health state machine** (`frontend/src/mic-health.ts`) —
  classifies the capture stream on *digital silence*, no sample above one
  16-bit LSB, rather than on loudness, so a quiet room is never mistaken
  for a broken microphone. Flags a dead pipeline 2.5 s after start or
  after 4 s mid-session, with a 10 s watchdog for an audio graph that
  never starts. A topbar pill and the stop-time summary name the actual
  cause — permission, OS mute, device loss — instead of "No speech
  captured".
- **Live-transcript adoption policy** (`frontend/src/live-coverage.ts`) —
  pure, typed rejection reasons, so choosing the slow path is visible in
  the trace log.
- 42 tests across the new paths: mic-health FSM, coverage contract,
  adoption policy, disconnect classification, finalize ordering.

### Security

- **Purged a leaked OpenRouter API key from the entire git history.** It
  had been committed in `data/config.json` in the initial commit and was
  already published to GitHub. Removing it from history does not
  un-publish it — the key must be revoked at the provider.

## [Unreleased] — 2026-06-25

### Fixed

- **Settings shortcuts UI** — each key in a shortcut is rendered as an
  individual outlined keycap instead of a plain text phrase.
- **Deepgram small-audio REST timeout** — live recovery and short
  re-transcribe payloads no longer inherit the large-upload timeout budget.
  Tiny payloads fail fast on provider/network stalls while large uploads keep
  their long upload window.
- **Deepgram live connect budget** — live WebSocket connection attempts are
  bounded to an 8 s first attempt plus one 4 s retry.
- **Remote offline guard** — remote transcription calls fail fast when the
  app's network probe already reports offline, avoiding long cloud waits.
- **Redacted API-key roundtrip** — saving the Settings payload returned by
  `/api/config` preserves the real provider secret instead of persisting the
  masked display value.
- **Dormant legacy waveform** — the hidden legacy waveform sink no longer
  creates a canvas context, resize observer, or rAF render loop while disabled.
- **Recordings stats scan** — the expensive summary scan is now lazy and runs
  only when the Stats panel is explicitly opened.

### Build

- Added README guidance for internal ad-hoc macOS arm64 transfer artifacts
  versus production Developer ID + notarized distribution.

## [1.1.25] — 2026-05-10

Historical release-audit batch across 24K LOC. This changelog keeps the
1.1.25 release notes; the current verified bug audit lives in
`VERIFIED_AUDIT.md` and intentionally lists only confirmed real bugs.

### Fixed (audit + post-audit batch)

#### P0 (data-loss / breakage)
- **frontend `setSelectedFile`** — extension-less + MIME-less files no longer
  bypass the upload validator (lenient `!file.type` short-circuit removed).
- **frontend `OpfsPcmSink.finalize`** — recovers in-memory PCM after a write
  failure instead of returning empty WAV; salvages spool prefix + RAM tail.
- **frontend `parseError`** — reads response body once as text then attempts
  JSON; previous form double-consumed the stream and dropped server error
  detail.

#### P1 (incorrect behaviour / leaks)
- **backend Fernet keyfile** — disk-write failure no longer returns an
  in-memory key that would have caused silent permanent loss of every
  encrypted API key on the next boot.
- **backend `decrypt_value`** — distinguishes InvalidToken (warn) from any
  other exception (error + stack), no more silent secret loss.
- **backend `dict(DEFAULT_CONFIG)` → `copy.deepcopy`** — caller mutation no
  longer corrupts the global default for the rest of the process (5 sites).
- **backend Deepgram error envelopes** — final-payload + `/api/upscale` 502
  now route through `_safe_error_text`, no more raw upstream URLs / token
  prefixes leaking into the renderer.
- **backend local-assist final envelope** — `LiveSession.finalize_envelope()`
  reports the cumulative transcript instead of always-empty; frontend stops
  triggering a recovery REST round-trip on every successful local stop.
- **backend `transcribe.py` warm-probe regex** — covers Python 3.12 wording
  ("max() iterable argument is empty"); spurious stack trace on every cold
  start is gone.
- **backend `audio.py` ffmpeg cleanup** — partial output files unlinked on
  ffmpeg failure (both `compact_audio_for_remote` and `ensure_wav_16k`);
  downstream transcribe paths can no longer consume torn files.
- **backend Deepgram `connect()`** — retries on `OSError` (DNS gaierror,
  ConnectionRefused) per the docstring; previous code retried only on
  `TimeoutError`.
- **backend `_finalize_sent` flag** — set AFTER the Finalize send succeeds,
  not before; cancellation between flag-set and send no longer orphans the
  Finalize.
- **backend keepalive race** — snapshots `self._ws` before each send; close()
  on the same event loop can no longer null the reference between guard
  and use.
- **backend `connect()` rollback** — closes the open WebSocket if a
  `BaseException` (incl. `CancelledError`) fires between socket-open and
  recv/keepalive task launch; eliminates a connection-leak path.
- **backend `_ws_send_json`** — 5 s send timeout treats stalled clients as
  broken pipes; one paused renderer can no longer wedge the entire
  forwarder loop.
- **backend `_extract_meta_field`** — restricted to the file header prefix
  (text before first blank line); user transcript content starting with
  "Provider:" / "Language:" no longer corrupts stats / graph / filter.
- **backend `_promote_live_recovery`** — registers archive dir AFTER writes
  succeed, not before; failed writes no longer pollute the registry.
- **backend `compact_audio_for_remote` ffmpeg-missing** — raises
  `RemoteError` with an actionable message for non-Deepgram-native
  containers (.wma / .mkv / .opus / .webm / etc.) instead of degrading
  to a confusing upstream 400.
- **backend validators** — `_validate_audio_filename` rejects empty
  extensions; `_normalize_filename` strips Windows backslashes regardless
  of host OS and ensures fallback `.wav` extension when none exists.
- **backend recordings list** — `_recording_audio_payload` receives
  `target_dir` from list and single-recording paths so non-default
  archives correctly resolve audio existence.
- **frontend `lastSegEnd`** — tail-gap detection uses `Math.max(end)` over
  segments instead of array tail; correct for diarized recordings and
  out-of-order arrivals.
- **frontend `xhr.send`** — wrapped in try/catch + idempotent abort guard;
  pre-send abort no longer surfaces as a network-error reject.
- **frontend `discardLiveRecovery`** — failure no longer misreported as a
  save failure; recovery duplicate-on-restart eliminated.
- **frontend `hideBootOverlayOnce`** — defers `hidden=true` past the CSS
  transition so the documented fade-out actually runs.
- **frontend Re-transcribe token leak** — `activeUiSessionToken` adopted
  on cold-start re-transcribe is now released in `finally`; phantom token
  no longer survives.
- **frontend `reportFileSelectionError`** — non-disruptive notice replaces
  the blanket `patchCurrentRecordingSummary` write that could clobber an
  active live recording's status pill.
- **desktop `toggleRecordingFromShortcut`** — uses
  `execRendererJsWithTimeout(2000)` instead of unbounded
  `executeJavaScript`; stuck renderer no longer makes the hotkey a
  permanent no-op.
- **desktop OneDrive migration** — marker only written when EVERY child
  copy succeeded; partial copy failures now retry on next boot instead
  of permanently stranding user data in the OneDrive path.
- **desktop backend restart timer** — null'd from `.finally` instead of
  the synchronous start path; concurrent `startBackend()` callers no
  longer race into a double-spawn → port-bind collision loop.
- **desktop `hideRecordingOverlay`** — clears `overlayMouseTrackTimer`;
  20 Hz syscall poll no longer wastes CPU + battery for the entire app
  session whenever the overlay is hidden.
- **desktop overlay timer regex** — `\d{2,3}:\d{2}` accepts 100+ minute
  recordings; previous regex froze the overlay timer at 99:59.
- **desktop macOS permissions** — request prompt runs in parallel with
  backend boot, no longer blocks the launch sequence on a modal dialog
  the user might leave for minutes.
- **desktop `playOverlayCue`** — 500 ms cap on executeJavaScript so a
  stuck overlay webContents can't freeze hotkey-bound code paths.
- **desktop overlay close** — resets `overlayQuickSettingsInitialized` and
  `overlayQuickAutoSendInitialized` flags; recreated overlay window no
  longer shows stale checkbox states until manual toggle.
- **desktop `__app_reveal_recording__`** — rejects names containing `..`;
  prevents path-traversal enumeration of the user's home parent through
  `shell.showItemInFolder`.
- **desktop hotkey 1.1.24 regression** — comment block inside
  `createOverlayHtml`'s template literal was breaking the outer literal
  via stray backticks + `${}`; rewritten without those characters.

#### SSOT consolidation
- **`backend/audio_constants.py`** — single source of truth for
  `LIVE_SAMPLE_RATE_HZ` (16 000), `LIVE_PCM_BYTES_PER_SEC` (32 000), and
  `LIVE_RECOVERY_MIN_BYTES`. Every literal `16000`/`32000` in `audio.py`,
  `main.py`, `live.py`, and `remote_deepgram_live.py` migrated.
- **`backend/deepgram_endpoints.py`** — `DEEPGRAM_REST_BASE` and
  `DEEPGRAM_LIVE_URL` centralised; both `remote_deepgram` and
  `remote_deepgram_live` import from here. `TRANSCRIPTOR_DEEPGRAM_HOST`
  env override for regional routing.
- **Version SSOT** — `vite.config.ts` now reads
  `desktop/package.json` instead of `frontend/package.json` for
  `__APP_VERSION__`. One file to bump per release; `frontend/package.json`
  `"version"` field is vestigial.
- **MIME drift assert** — backend module-import-time assertion that
  `ALLOWED_AUDIO_EXTS ⊆ _AUDIO_EXT_TO_MIME.keys()` so a future addition
  to the ext list without a matching MIME entry fails on boot, not
  silently downstream.
- **`DEFAULT_OPENROUTER_AUDIO_MODEL`** — single named constant replaces
  inline `OPENROUTER_AUDIO_MODELS[0]` at 11 sites.
- **`countWords`** — `wordCountOf` aliases the module-level helper
  instead of a divergent inline lambda.

#### Docs / build
- **README** — corrected hotkey defaults per OS, removed Mac Intel
  section (build is arm64-only since 1.1.24), replaced hardcoded
  `1.1.1` filenames with `<version>` placeholders.
- **`.env.example`** — `TRANSCRIPTOR_LIVE_RECOVERY_RETENTION_SEC`
  documented default corrected from 3600 to 86400 (matches code).
- **`install/win/build.bat`** — JS-string backslash escape bug fixed
  (`\b`, `\t`, etc. in user paths). Pass via env var instead.
- **Mac build rules** — arm64-only (M-series); Intel x64 dropped from
  electron-builder target and `dist` script.
- **Renderer trace log bridge** — `console.log("[trace ...]")` lines
  mirror to `main.log` via `webContents.on("console-message", ...)`;
  enables packaged-build debugging without DevTools.

### [Unreleased prior to 1.1.25]
1.1.2 → 1.1.24: 22 release commits between 1.1.1 and 1.1.25
covering tail-cut recovery (1.1.13 → 1.1.16 ladder), parallel
race + Finalize-before-CloseStream (1.1.17 → 1.1.19), the
Deepgram-WS-not-emitting-is_final root cause investigation
(1.1.20 → 1.1.22), the overlay waveform red-line fix (1.1.23) and
the comment-in-template hotkey breakage + restore (1.1.24).
See `git log --oneline --grep "release"` for the full chain.

## [1.1.1] — 2026-04-25

Enterprise-grade storage layer (SSOT) and a dense wave of pre-launch
hardening. Shipped to global users the day after 1.1.0-rc was cut;
**24 audit passes** went into this release, ~105 unique bugs
identified and triaged across the stack.

Final tag at commit `a9a6da9` (chain: pass-15 → … → pass-24c).

### Added (passes 18–24)

#### Persistence / SSOT
- **Shared `backend/storage.py`** — every persistent file write
  (config, upscale presets, archive registry, API token, encryption
  key, recording transcripts, job results, live-recovery meta,
  legacy migration copies) routes through four primitives:
  `atomic_write_bytes`, `atomic_write_text`, `atomic_write_json`,
  `rotate_backup`. Each guarantees atomicity (`tmp + os.replace`),
  durability (`fsync` on file + parent dir on POSIX), recoverability
  (`.bak` rotation where applicable), and matches the
  `<path>.tmp-<hex>` convention swept by `_sweep_orphan_tmp_files`.
- **Config schema versioning** (`SCHEMA_VERSION=2`). Legacy 1.0.x
  configs (no `schema_version`) auto-migrated on load. Pre-migration
  version captured BEFORE `_migrate_schema` mutates it (pass-23 M
  fix), so the stamp-back-to-disk path actually fires for
  beta-shaped configs with encrypted keys.
- **Config `.bak` recovery.** `load_config` falls back to backup
  on parse failure of the primary; backup rotated on every save.
- **Config shape validation.** Wrongly-typed subtrees (e.g.
  `providers: "string"` from a buggy client) reset to defaults
  with a warning instead of crashing.

#### Async + concurrency
- **6 sync routes converted to `async def`** with `asyncio.to_thread`
  offload + per-cache `asyncio.Lock` rebuild gating. Historical batch
  included the Graph route; Graph is now dormant and the backend route is
  no longer registered. Current routes include GET
  `/api/recordings`, `/recordings/stats/summary`,
  `/recordings/{name}`, DELETE `/api/recordings`, POST
  `/recordings/pick-folder`, `/recordings/open-folder`,
  `/live/recoveries/{id}/promote`. Cold-cache scans no longer pin
  executor threads or starve the event loop.
- **`JobStore.shutdown(timeout=1.5)`** in lifespan post-yield drains
  in-flight transcription workers via `cancel_futures=True` +
  daemon-thread join. Prevents the half-written `result.json` /
  `.txt` corruption on Electron SIGTERM.
- **Whisper LRU model cache** (default 2, env-overridable). Cycling
  through tiny→base→small→medium→large-v3 no longer OOM-kills
  on 8 GB hosts.
- **Whisper `run_in_executor` 60 s timeout** in live transcription
  prevents wedged CUDA-OOM hangs from freezing the WS forwarder.
- **`http_retry pool_block=False` + pool_connections=8.** Stalled
  upstream providers no longer freeze the FastAPI executor by
  pinning all 64 connection slots.

#### Desktop
- **Progressive boot-loading UI** — `_bootLoadingDataUrl` shows a
  pulse + live timer immediately during the 5–60 s cold-start;
  120 s → 60 s ceiling.
- **Smart clipboard restore** — polls clipboard contents and
  ABORTS restore if user copied something new during the paste
  window, instead of unconditionally clobbering after 1200 ms.
- **macOS F-key Mission Control collision detection** —
  `getUserDefault("com.apple.keyboard.fnState", "boolean")` piped
  into shortcut status; renderer badges F-key rows with a tooltip
  offering 3 remediations (toggle OS setting, hold Fn, pick
  non-F-key).
- **OneDrive `%APPDATA%` auto-remediation** — detects when
  corporate KFM Roaming routed AppData into OneDrive sync,
  re-homes `userData` to `%LOCALAPPDATA%\Transcriptor` early in
  init, performs one-time `fs.cpSync` migration with
  `.migrated-from-onedrive` marker.
- **Orphaned 1.0.x `.venv` cleanup** on first 1.1.x launch with a
  working bundled runtime. Three safety guards: marker for
  idempotency, exact-path equality (no symlink escape), Python-venv
  signature check.
- **macOS Accessibility-revocation poll** — 30 s poll surfaces
  `__transcriptorAccessibilityStatus` to renderer.
- **Overlay multi-monitor resilience** — `display-metrics-changed`,
  `display-added`, `display-removed` listeners re-pin the overlay
  to the correct display.
- **Windows tree-kill via `taskkill /T /F`** prevents orphan
  uvicorn workers + ffmpeg grandchildren on shutdown.
- **Richer paste target capture** (pass 22) — single struct with
  appName/pid/windowTitle/windowId/hwnd/className/instanceName
  enables exact-window paste targeting (fixes "paste into wrong
  Chrome tab" reports).

#### Frontend / UX
- **Retranscribe session-gating** + `runUpscaleIfEnabled` integration.
- **API key save errors surface to UI** via `setStatus` + red ring
  + aria-invalid (was silent `console.error`).
- **Mic-enumerate error classification** by `DOMException.name`:
  6 distinct messages instead of one misleading "Permission denied".
- **Boot error overlay** classifies known families
  (port-in-use, permission-denied, missing-module, Python-not-found)
  with raw stderr in `<details>` disclosure (no longer leaks paths
  into the paste buffer).
- **Upscale text capped at 120 000 chars** client-side with
  user-visible "trimmed N chars" status, instead of opaque HTTP 400.
- **Custom upscale-preset delete confirms** before destructive action.
- **Silence-seconds + dB threshold inputs reflect clamped value**
  back into the DOM (UI/state mismatch fix).
- **Audio playback no longer disrupted** by routine
  `loadRecordings` refresh when the source URL hasn't changed.

#### Tests + docs
- **24 unit tests** in `backend/tests/` (15 storage primitives + 9
  config lifecycle + 1 pass-23 M regression) — `python -m unittest
  backend.tests.test_storage backend.tests.test_config -v` runs in
  ~70 ms with zero external dependencies.
- **CHANGELOG.md** Keep-a-changelog format documenting every
  user-facing change.

### Changed
- **Enterprise error redaction** (`backend/main.py `_safe_error_text`).
  Absolute filesystem paths and API-key-shaped tokens are stripped
  from every error string that reaches HTTP response bodies or the
  job store. Full exceptions still `logger.exception`'d locally.
- **API token comparison is constant-time** via
  `secrets.compare_digest` on both HTTP and WebSocket auth paths.
- **Live-recovery PCM spool has a 1 GB ceiling** (~8.7 h of
  16 kHz mono audio). Prevents a runaway session from filling a
  small SSD. Cap configurable via `MAX_LIVE_RECOVERY_BYTES`.
- **`http_retry` connection pool is non-blocking**. Previously,
  stalled upstream providers could freeze the FastAPI executor
  threadpool by pinning all 64 pool slots. Overflow connections
  now open transparently (100–300 ms TLS cost vs. a minute-long
  backend hang).
- **Mic enumeration errors are classified**. `DOMException.name`
  is inspected: `NotAllowedError` → "Permission denied",
  `NotFoundError` → "No microphone detected", `NotReadableError`
  → "Microphone in use by another app", etc. Previously everything
  mapped to the single misleading "Permission denied".
- **Boot-error overlay shows friendly headlines** (port-in-use,
  permission-denied, missing-module, Python-not-found) with the
  raw stderr moved to a `<details>` disclosure. Previously the
  raw text was visible by default and could leak into the paste
  buffer on first Cmd+V.
- **API key save failures surface to the user** via `setStatus`,
  red input ring, and `aria-invalid`. Previously silent
  `console.error` → user had no idea why transcription later
  complained about a missing key.
- **Retranscribe session-gated.** The "Re-transcribe" button now
  captures a session token, checks it before every DOM write, and
  routes through `runUpscaleIfEnabled` so AI rewriting applies to
  retranscripts when enabled.

### Fixed
- Windows SIGTERM orphaning python.exe subtree (→ `taskkill /T /F`).
- hardenedRuntime inconsistency between package.json (false) and
  afterPack.js (true) — now `true` in both.
- Hotkey-registration status never reaching the first renderer
  window (cached + replayed from `did-finish-load`, alongside
  accessibility-trust state and any prior boot error).
- Overlay `overlayLoaded` flag stuck `true` after window destroy +
  recreate, leaving the overlay a permanent blank capsule until
  process restart (pass-24c P0 fix).
- `startBackend` early-out order race: concurrent caller seeing
  momentarily-set `backend` during spawn-then-instant-crash window
  could proceed to loadURL against a backend about to die.
- URL `setWindowOpenHandler` / `will-navigate` now use
  `new URL()` origin parsing instead of vulnerable
  `startsWith(BASE_URL)` prefix-match (suffix-injection fix).
- VBS paste temp file uses `crypto.randomUUID()` instead of
  `Date.now()` (millisecond collision fix).
- `setIgnoreMouseEvents(true, { forward: true })` re-invocation
  on overlay mouse-leave is now platform-gated (macOS-only flag).
- `cscript` VBS-paste timeout 2500 → 5000 ms (Windows Defender
  AV scan budget).
- Audio playback no longer reset to position 0 by routine
  `loadRecordings` refresh when source URL hasn't changed.
- Deepgram "API key is not configured" misrouted to
  region-block/VPN hint; now explicitly classified.
- Upscale placeholder collision via text-equality sentinel
  (replaced with per-session `dataset.upscaleNonce`).
- Whisper `run_in_executor` now wrapped in
  `asyncio.wait_for(timeout=60)` — wedged CUDA-OOM hangs no longer
  freeze the WS forwarder.
- Whisper LRU cache evicts oldest model on insert beyond cap
  (was unbounded, OOM on 8 GB hosts when cycling models).
- Historical sync route handlers (then including graph, stats, promote,
  pickers, DELETE, get_recording) converted to `async def` + `asyncio.to_thread` —
  no longer pin the FastAPI executor pool on cold-cache scans.
- 6 raw `str(e)` error leak sites routed through `_safe_error_text`
  (WS fatal, Deepgram WS connect, save_config, picker errors,
  picker FileNotFound, open-folder errors).
- `_rec_dir_cache` reads/writes guarded by lock (race on
  fresh-cache-stale-timestamp).
- `_register_archive_dir` SSOT consistency — text-only save now
  registers the archive dir like audio save does.
- `http_retry pool_connections` 4 → 8 to absorb steady-state burst
  without TLS re-handshake.
- ffmpeg stderr now bounded at 64 KB via background reader thread
  (prevents OOM from corrupt-input ffmpeg crash loops).
- Click-and-hold overlay buttons leaking intervals when user drags
  off (document-level `pointerup`/`pointercancel`/`blur` cleanup).
- Accessibility-poll `setInterval` handle captured + `.unref()`'d
  + cleared on `before-quit`. Same now applied to
  `shortcutPollTimer`.
- `_ERROR_PATH_REDACT_RE` no longer over-matches URL paths
  containing `/Users`, `/home`, `/var`, `/tmp` (negative
  look-behind).
- `"Deleted undefined recording(s)"` in archive-delete UI (shape
  coercion + surfaces partial failures).
- `.encryption_key` write is now atomic — a crash during first-launch
  keyfile creation no longer produces a zero-length keyfile that
  silently invalidates every previously-encrypted value on next
  load.
- 5 persistence sites still using bare `Path.write_text` migrated
  to SSOT atomic writers (job result `.json`/`.txt` for both local
  and remote, live-recovery meta start + finalize, volatile-path
  migration copy).
- Silence-seconds + dB threshold inputs reflect the clamped value
  back into the DOM (UI/state mismatch fix).
- Custom upscale-preset deletion now confirms with `window.confirm`
  before destroying a user's tuned prompt.
- Upscale text > 120 000 chars trimmed client-side (preserving
  trailing summary) with status notice instead of opaque HTTP 400.
- Window-level mousemove drag-pan handler scope-bound to
  mousedown / mouseup / blur — zero overhead outside an active
  drag instead of fire-and-early-return on every mouse move
  for the lifetime of the renderer.
- Schema-version stamp regression: pre-migration version captured
  before `_migrate_schema` mutates it, so the stamp-back-to-disk
  path actually fires for legacy beta-shaped configs (pass-23 M).

### Infrastructure
- `install/win/build.bat` and `install/linux/build.sh` post-build
  filename hints corrected (1.0.0 → 1.1.1).
- `.gitignore` ignores `.claude/` harness state.

### Security
- Constant-time API-token comparison (`secrets.compare_digest`)
  on both HTTP and WebSocket auth surfaces.
- Absolute filesystem paths redacted from HTTP error responses
  and persisted job errors.
- API-key-shaped token patterns stripped from error strings.
- Live-recovery PCM spool cap prevents disk-fill DoS.
- Config file written atomically with `fsync` + parent-dir `fsync`
  on POSIX.

---

## [1.1.0] — 2026-04-14 (internal RC)

Bundled Python + ffmpeg runtime for zero-setup install on
Windows + macOS. Not publicly shipped — superseded by 1.1.1.

## [1.0.2] — 2026-03-28

Diagnostics + user-friendly network errors.

## [1.0.1] — 2026-03-15

Fixed blank Windows window; version badge; update story.

## [1.0.0] — 2026-03-01

Initial public release.
