# Ultra-Audit (read-only) — desktop/ modules (not main.js), native helper, scripts, CI, installers
HEAD acbf737, v1.6.6. Auditor: desktop-modules. Nothing edited, nothing run except read-only greps and two throwaway node scripts in scratchpad.

## Coverage
| Area | State | How |
|---|---|---|
| screen-mode.js, screen-mode-controller.js | read in full | line by line |
| native/screen-input/{PressClassifier,main}.swift, native/tests, screen-input.test.js | read in full | |
| contracts/screen-session.json vs code + backend/screen_sessions.py + frontend screen-annotations | cross-checked | reason/dir/endedAt |
| accelerator, shortcut-migration, shortcut-defaults.json, user-data-dir, child-io, linux-wm-class, python-version, power-events, window-lifecycle, recording-final-slot, recording-status, renderer-console, paste-protocol, paste-result, preload | read in full | |
| paste-verification-policy | read 55-236 | |
| paste-capability | read 380-625 (repair/self-heal); rest skimmed by symbol list | |
| paste-script, engine-deps | partial (headers, compareVersions/specifierSatisfied, constants) | prior audit D-004/D-011 closed, not re-walked |
| afterPack, afterAllArtifactBuild, unlockDist, macos-signing-utils, check-designated-requirement, require-bash, build-mas, sign-mas, notarize-dmg, upload-testflight, prepare-runtime, build-native | read in full | |
| generate-dmg-background.py | not read (covered by packaging.test) | |
| package.json build config | read in full | |
| BUILD.command, INSTALL.command, INSTALL_ON_OTHER_MAC.command, .github/workflows/tests.yml | read in full | |
| tests: all 23 desktop/*.test.js | mechanical scan (assert count per test: 0 assertless tests of 330ish); ipc-contract, packaging, screen-input, screen-mode read in full; others by grep | |
| dead-export scan | scripted over 19 modules | only internally-used constants without outside importers; no function exported and unused |

Defect classes walked per sub-area: contracts, state/races, errors, resources, data, security, SSOT, engineering, perf, tests, dead code, UX. Clean places at the end.

---
## Findings

### DX-01 · P1 · confirmed · A stroke that ends while a screenshot is being captured is stamped into that shot, yet is not in the image and is wiped from the screen
File: desktop/screen-mode-controller.js, `takeShotNow` (L586-634) with screen-mode.js `recordShot`/`pendingStrokes`.
Gist: `pending` is computed at L589, then the function awaits `captureRegion` (up to 15 s timeout) and `__composite` per display. Helper lines keep arriving during those awaits (`onHelperLine` is not serialised). At L625 `recordShot` re-evaluates `pendingStrokes(session)`, so every stroke that finished during the awaits gets `shot = N` although neither screencapture nor composite saw it; L626-630 then do `entry.ops = []` + `__clear()`, dropping the not-yet-flushed ops, and a stroke still in progress loses its already-drawn part and every later `["m", id, ..]` op (`strokes.get(id)` is undefined in `__apply`).
Notice: draw a short stroke within ~200 ms after pressing the screenshot hotkey/capsule button (screencapture + PNG round trip), or keep dragging across the shot. The manifest says "stroke #k belongs to shot N" and the transcript mark points at an image without it; the stroke disappears from the screen without being captured anywhere.
Consequence: wrong transcript marks (a drawing the speaker pointed at is attributed to an image that does not show it) and lost visible drawing.
Current:
```js
const pending = pendingStrokes(session);            // L589, before the awaits
... await captureRegion(...); await overlayCall(... __composite ...)
const shot = recordShot(session, { at, files, reason });   // L625: pendingStrokes() again
for (const entry of overlays.values()) { entry.ops = []; overlayCall(entry, "window.__clear()"); ... }
```
Fixed: pass the captured ids into the rule so one list decides: `recordShot(session, { at, files, reason, strokeIds: pending.map(s => s.id) })` (screen-mode.js stamps only those), clear on the overlays only the strokes of that list (`__clear(ids)` removing those ids and keeping the rest and queued ops), and keep `entry.ops` untouched.
Why a bug: screen-mode.js header says a shot takes "strokes drawn since the last screenshot" and the screenshot is "the screen itself plus the strokes"; two evaluations of "pending" at two times contradict that.

### DX-02 · P2 · confirmed · `startNow` ignores the requested id when a session is live, and `finishNow` then refuses the new id forever
File: screen-mode-controller.js `startNow` L648 (`if (session) return { ok: true, id: session.id }`), `finishNow` L698 (`session-mismatch`).
Gist: a second `start(id2)` while session id1 is alive answers ok with id1. The caller (main.js L2891) only logs `ok`; the renderer holds id2 (it generated it, `startDetail.screenSessionId`) and `screenFinish({id: id2})` returns `session-mismatch` without tearing anything down.
Notice: any path that leaves a session unfinished (see DX-03) and then a new screen take.
Consequence: overlays + CGEventTap stay on for the rest of the app run, the new take's shots land in the old folder, its marks never arrive. Only quitting the app clears it.
Fixed: `start(id)` with a different live id finishes (keeps staged, `discard:false`) the old session first, then starts the new one; `finish` with a mismatching id for a live session whose recording is gone must not be a dead end.
Why a bug: one idempotency rule answered with the wrong identity, and the only exit requires the identity that start refused to adopt.

### DX-03 · P1 · hypothesis · Stop that wins the race against `screenMode.start` leaves a session with no recording
File: main.js L2891 (`await beginRecordingStatusSession(); ... screenMode.start(...)`) against preload `screenFinish` → main.js L9499 → controller `finishNow` L693-697.
Gist: the recording is already confirmed started (renderer knows the session id) before `screenMode.start` is even called. If stopLive reaches `screen-mode:finish` in that interval (capsule stop, fail-safe stop, autostop), `finishNow` sees `!session` and returns `no-session`; `start` then runs through the serialised chain and creates overlays/helper/palette for a recording that has ended. Combined with DX-02 nothing ends it.
Why only hypothesis: needs a stop inside the `beginRecordingStatusSession` await (tens to hundreds of ms); not reproduced.
Fixed: main starts the session BEFORE it tells the renderer to record, or `finishNow` with an id that has not started yet records a tombstone so a later `start(thatId)` is refused.

### DX-04 · P2 · confirmed · Stroke positions are recomputed from the CURRENT displays on every write, so a display change rewrites earlier strokes
File: controller `displayBoundsById()` L235 used by `writeEvents` L638; screen-mode.js `strokePosition` fallback `{0,0,1,1}`.
Gist: `displayBoundsById` is read at each `writeEvents`. After a display is removed (the very case `watchDisplays` handles), `strokePosition` gets `undefined` bounds → fallback 1x1 box → `cx/cy` clamp to 0 or 100. After a resolution change the percentages shift.
Notice: draw on an external display, take a shot, unplug the display, take another/stop: events.json (and the transcript marks) for the first shot now say xPct/yPct = 0 or 100.
Fixed: store the display bounds on the stroke at `beginStroke` (`displayBounds`) and compute the percentage from that.
Why a bug: position is a fact about when the stroke was drawn; the code re-derives it from a mutable source.

### DX-05 · P2 · confirmed · Overlay strokes are kept relative to the overlay origin and not rebased when the origin changes
File: controller overlayHtml `__apply` (points stored as `op - origin`) and `changed` handler L305-312 (`__setOrigin` after `display-metrics-changed`).
Gist: after the arrangement changes, existing strokes on that overlay are drawn shifted by the origin delta; `__composite` uses the same shifted points, so the screenshot also carries them in the wrong place.
Fixed: keep global points in the overlay and subtract `origin` at draw time (`drawStroke`), or shift stored points in `__setOrigin`.

### DX-06 · P2 · confirmed · A shot whose capture failed or whose display vanished is still recorded, with the evidence only in the log; the permission warning is matched on message text that the real permission failure never produces
File: controller `takeShotNow` L597-624.
Gist: `if (!display) continue;` and the capture `catch` leave `files` short; L624 only skips when BOTH `files` and `pending` are empty, so a pending stroke closes a shot with `files: []`, the transcript gets a mark for an image that does not exist. The comment L665-667 itself says a missing Screen Recording grant does not make `screencapture` fail (it returns the wallpaper), so the `/could not create image|not permitted|denied/` regex (L616) is not the permission signal; when it does match (sleeping display) the user is told "allow Screen Recording", which is false.
Fixed: surface "no screenshot saved" to the user (onWarning kind "capture-failed" with the real reason), keep the strokes pending instead of consuming them, and drop the regex path.

### DX-07 · P1 · hypothesis · The event tap is re-enabled after a timeout/user-input disable without resetting the press state
File: native/screen-input/main.swift L74-77 (callback head), L55-60 `State`.
Gist: on `.tapDisabledByTimeout/.tapDisabledByUserInput` the callback only re-enables the tap. `classifier.phase`, `downPoint` and `state.heldDown` stay as they were. If the tap was disabled between a swallowed press and its release: the app never gets the held press (it is only replayed on release, which no longer comes through the tap), it sees a bare mouse-up (the tap was off), no `end` is emitted for a stroke in progress, and `phase` stays `.held`/`.drawing` until the next `.down`.
Why hypothesis: needs macOS to disable the tap mid-gesture (slow callback, Secure Input toggles); not reproduced.
Fixed: on re-enable call a `PressClassifier.reset()` and, if `heldDown` is non-nil, replay it; emit `end` for an open stroke.

### DX-08 · P2 · confirmed · Helper spawn/exit failures leave the take looking active with no drawing, and `start` reports ok
File: controller `startHelper` L490-516, `startNow` L654-673.
Gist: `child.on("error")` only logs; `exit` with any code except 2 only logs (no warning, no restart); `startNow` catches overlay/palette failures, logs, and returns `{ ok: true }` (a failed `loadURL` of one display also skips `createPalette` through the shared `Promise.all`). The red frame says "screen mode" while clicks and drags do nothing special.
Fixed: warn (`onWarning("helper")`) on error/non-zero exit, return `ok:false` from start when overlays/helper are unusable, create the palette independent of overlay results.

### DX-09 · P2 · confirmed · screen-mode-controller.js (724 lines: state machine, display hot-plug, deliverTap, capture/composite, overlay JS) is not loaded by any test
Evidence: `grep -l "screen-mode-controller\|createScreenModeController" desktop/*.test.js` → none; `node --check` in CI only covers main.js/preload.js; packaging.test.js checks the file is whitelisted, not that it parses. A syntax error in the controller passes every desktop check.
Fixed: a node:test that `require()`s it with fake `BrowserWindow/screen/childProcess/fs` (the deps are already injected — `deps.captureRegion` exists "for tests" and nothing uses it), covering DX-01/02/03/04/06 as regression tests. Also the `overlayHtml()` script can be evaluated in a DOM-less `vm` for `__apply/__composite` shape.
Class: tests (coverage with no check; the injection seam `deps.captureRegion` is dead).

### DX-10 · P2 · confirmed · CI compiles only PressClassifier.swift, never main.swift
Files: desktop/screen-input.test.js L30-40 (compiles `PressClassifier.swift` + test main), build-native.sh L41-44 (the only place that compiles `main.swift`).
Consequence: a compile error or an API drift in the tap/protocol file (`CGEvent` fields, protocol keys) is discovered by `./BUILD.command` on a release day. The protocol (`{"t":...}` lines, `controls` command) shared between main.swift and the controller has no contract test either; the controller's `onHelperLine` reads keys `t,x,y,outcome,clicks,drags,code` that exist only as comments in main.swift.
Fixed: add `xcrun swiftc -typecheck` of both files to screen-input.test.js; add a golden-line test feeding the documented stdout lines into `onHelperLine` (needs DX-09's harness).

### DX-11 · P2 · confirmed · Nothing asserts the helper is built and shipped; its absence is a silent "unsupported"
Files: package.json `scripts.dist*` (build-native chained by hand in 4 scripts), `build.mac.extraResources` (`native/build/mac-${arch}`), controller `isSupported()` L222 (existsSync), packaging.test.js (no mention).
Gist: running `electron-builder` directly, or a future script that drops `build-native.sh`, yields a DMG in which the screen hotkey is simply not offered (`screenModeSupported:false`); no build step or test fails. BUILD.command does not check `Contents/Resources/runtime/bin/screen-input` either.
Fixed: packaging test "every dist script that targets mac runs build-native.sh before electron-builder" and a post-pack assertion in afterPack that the helper exists and is signed.

### DX-12 · P2 · confirmed · Layout/level numbers restated in two files
File: controller L50 `PALETTE`, L382 `wa.y + wa.height - size.height - 54`, L278/L415 `setAlwaysOnTop(true,"screen-saver", 0/1)`; main.js L1360-1363 (`bottomMargin: 16`, `pillHeight: 30`), main.js L2244 `"screen-saver", 2`; palette CSS (`#121212`, border, shadow) copies the capsule pill's CSS (main.js L1551).
Gist: `54` = capsule `bottomMargin 16` + height 30 + `marginAboveCapsule 8` typed as a literal; the stacking order overlay < palette < capsule exists as three bare numbers in two files joined only by comments.
Fixed: export the capsule geometry and levels from one constants object (the controller receives them via deps or `screen-mode.js`) and compute the fallback.

### DX-13 · P2 · confirmed · Palette talks to the controller through `document.title` and a second timestamp-suffixed string protocol
File: controller L168-172 (palette page sets `document.title = "__screen_palette__"+color+"__"+Date.now()`), L417-423 (`page-title-updated`).
Gist: second instance of the title-as-IPC crutch already in the known list (костыль 1, "preload for the capsule" in debt). It is unnecessary here: `deliverTap` already runs `executeJavaScript` in the palette page and could return the colour of the element hit (`el.closest(".dot")?.dataset.c`) directly to `setColor`. `Date.now()` exists only to force a title change.
Known/not fixed relation: ties to debt item 9 (title channel); this is new code adding another consumer.

### DX-14 · P2 · confirmed · `reason` on shot events is a field with no reader and a default that is never produced
Files: screen-mode.js L150 (`reason = "button"`), controller L718 (`takeShot(reason = "button")`), contracts/screen-session.json (`"reason": "capsule"`), main.js callers pass only `"capsule"`/`"hotkey"` and controller `"stop"`.
Evidence: `grep reason frontend/src/screen-annotations.ts backend/screen_sessions.py` → no consumer. "button" exists in two places and nowhere else.
Fixed: either consume it (transcript mark wording) or drop it from manifest + contract; delete the duplicate default.

### DX-15 · P2 · hypothesis · Overlay redraw is O(all points) per 16 ms batch, and a screenshot ships the whole PNG as base64 through `executeJavaScript` both ways
File: controller overlay `__apply` → `redraw()` (clearRect + every stroke), `takeShotNow` L607-610.
Gist: long un-shot drawing sessions make each flush slower; a 5K display PNG (several MB) becomes a ~10+ MB JS string literal evaluated in the overlay and a data URL back. Not measured.
Fixed: draw incrementally (append the new segment); composite in the overlay from the file URL instead of embedding the bytes, or write strokes JSON and composite in one pass.

### DX-16 · P2 · hypothesis (UX) · While screen mode runs, every left-drag on the machine is a stroke and every click is delayed to button-up
File: PressClassifier.swift header + `classify` (.held/.drawing), main.swift `.hold` on down.
Gist: no pen on/off, no modifier to pass a drag through. Window dragging, text selection, sliders, scroll-bar drags, menu press-drag-release and drag-and-drop cannot be done; a held press is replayed only at release so pressed-state feedback and press-and-hold semantics are lost. Intended by the product text ("only a press-and-drag draws"), but nothing in the UI tells the user and there is no escape hatch other than stopping the take.
Fixed: a modifier (e.g. hold Fn/Ctrl) or a pen toggle on the palette that makes the classifier return `.pass`.

### DX-17 · P2 · confirmed (product decision recorded) · New macOS defaults register Option+Right (always) and Option+Down (during a take) globally
File: desktop/shortcut-defaults.json L3-8; main.js 9863-9884 registers `screen` unconditionally on darwin.
Gist: Option+Arrow is word/paragraph navigation in every text field; `globalShortcut.register` consumes it system-wide. Known sibling: `Alt+Left` (BUGS_AUDIT_2026-09-03 §8 #30, "not done without the user's request") — 1.6.6 added two more of the same class.
Consequence: while the app runs, Option+Right stops moving the cursor in other apps.
Fixed: needs a decision; the consistent fix is a chord that is not an editing key (e.g. Control+Option+arrows) and a migration through shortcut-migration.js.

### DX-18 · P2 · hypothesis · Properties the feature depends on are set inside empty catches
File: controller L276-279, L284, L414-416 (`try { w.setIgnoreMouseEvents(true) } catch { }`, `setContentProtection`, `setAlwaysOnTop`).
Gist: if `setIgnoreMouseEvents` throws, the overlay swallows the mouse for the whole display; if `setContentProtection` throws, the frame/palette/capsule appear in every screenshot. Both fail silently; no log line.
Fixed: log the failure and refuse to show the overlay window unless both succeeded.

### DX-19 · P2 · hypothesis · The permission self-heal does not know Screen Recording, the grant screen mode needs most
File: paste-capability.js L384-401 (`TCC_SERVICE`, `PERMISSION_REPAIR_SERVICES` = Accessibility, AppleEvents), controller L668 (only pre-check via `getMediaAccessStatus`).
Gist: the same stale-after-rebuild grant failure the repair exists for (a grant keyed to a signature the new build no longer satisfies) can apply to ScreenCapture; macOS then returns wallpaper images, `getMediaAccessStatus` may still say granted, and screenshots are saved of nothing — the case controller L665-667 says it guards against. Not verified on a machine.

### DX-20 · P2 · confirmed · tests.yml header says "seventeen suites"; there are 23
File: .github/workflows/tests.yml L8-9 vs `ls desktop/*.test.js | wc -l` = 23. Documentation contradicting the tree; will rot again. Fixed: drop the number.

### DX-21 · P2 · confirmed · Notarization and TestFlight secrets are passed on the command line
Files: desktop/scripts/notarize-dmg.sh L70 (`--password "$NOTARYTOOL_PASSWORD"`), upload-testflight.sh L69 (`-p "$ASC_APP_SPECIFIC_PASSWORD"`).
Consequence: visible in `ps` to every local user for the length of the upload/notarization (minutes, `--wait`).
Fixed: `xcrun altool -p @env:ASC_APP_SPECIFIC_PASSWORD`; `notarytool` keychain profile as the only password path.

### DX-22 · P2 · confirmed (dead second path) / hypothesis (injection) · check-designated-requirement.js reads the requirement twice and the second path quotes a path into `sh -c`
File: desktop/scripts/check-designated-requirement.js L51-70.
Gist: the comment says codesign writes the requirement to stderr, the first call captures stdout only and falls through to `/bin/sh -c "codesign … 2>&1"` with `JSON.stringify(appPath)` (does not escape `$`, backtick). Two code paths for one read, the second built by string concatenation. The path is `$TRANSCRIPTOR_INSTALL_DIR/.Transcriptor.app.installing.$$` (env-controlled).
Fixed: one `spawnSync("/usr/bin/codesign", [...])` capturing both streams, no shell.

### DX-23 · P2 · confirmed · INSTALL_ON_OTHER_MAC.command lacks the identity guard BUILD.command applies, and takes its expected bundle id from a file beside it
File: INSTALL_ON_OTHER_MAC.command L71-81, L101-108; BUILD.command L326 runs `check-designated-requirement.js`.
Gist: installing over a copy the user has already granted, with a bundle signed by a different certificate (or ad hoc), strands every TCC grant (the failure BUILD.command's header and the whole 1.6.3 self-heal exist for); the installer only runs `codesign --verify`, which accepts ad hoc. `EXPECTED_BUNDLE_ID` is overridden by `app_id=` in the manifest next to the installer, so the check can be moved by whoever supplies the manifest.
Known and still present: H-6 (`NEEDS_SUDO` read under `set -u`, only assigned in `main`, L57/L260) and H-7 (L193 `pkill` then `sleep 1; break` without checking the process died) from docs/audit-2026-09-04/desktop-findings.md.

### DX-24 · P2 · known, not fixed (old IDs) · Still present
- D-023 residual: BUILD.command L90 `INTERNAL_SIGNING_IDENTITY="AntigravityTelegramDev"` default (moved to one place, still one developer's keychain name).
- H-8: prepare-runtime.sh L179 `github.com/indygreg/python-build-standalone`.
- D-063: prepare-runtime.sh L73 mutable osxexperts URL.
- D-061 release composition, D-034, DMG artwork text, costыль 1 (title channels), costыль 8 (afterPack read-only / unlockDist cycle), PowerShell helper — all listed in desktop-fix-journal "Долг", unchanged.
- BUGS_AUDIT_2026-09-03 §8 #30 `Alt+Left` (see DX-17).

### DX-25 · P2 · confirmed · Dead branches for an architecture the product does not ship
Files: desktop/scripts/build-native.sh L24-26 (`mac-x64` branch) and `desktop/native/build/mac-${process.arch}` in main.js L2252 vs BUILD.command L42-46 / prepare-runtime.sh L289 ("macOS release builds are arm64-only"); package.json `build.files` L53 mis-indented entry (`"user-data-dir.js"`, cosmetic).
Fixed: delete the x64 arm or state it as supported everywhere.

### DX-26 · P2 · confirmed · Windows paste success is a substring test and retypes the marker
File: paste-result.js L82 `outcomeOf(stdout).includes("OK:vbs-paste")`, L114 `includes("OK:")`, L100/L108 literal `"OK:vbs-paste"` (paste-protocol.js owns `PASTE_OK_PREFIX`).
Gist: `isPwshPasteFallbackSuccess` accepts any stdout that contains `OK:` anywhere (an error text such as "... NOT OK: ..."), while the macOS parser requires the last line to start with it. Two rules for one question and a retyped literal in a module whose header says markers are not retyped.
Fixed: `lastLineOf(stdout).startsWith(PASTE_OK_PREFIX)` in both, build the VBS marker from the prefix.

### DX-27 · P2 · hypothesis · paste-verification-policy switches a target's verification off for the process lifetime with no way back
File: paste-verification-policy.js `recordOutcome` / `shouldAttemptVerification` (L112-160).
Gist: once `disabled`, no read is attempted, so no `VERIFIED` outcome can ever reset it ("Proof ... outranks everything" is unreachable for a disabled key). An app update that starts exposing AX values stays unverified (clipboard never restored) until restart. No TTL/recheck.
Fixed: re-enable one probe every N pastes or after a time bound.

### DX-28 · P2 · confirmed · Two tests prove less than they claim
- desktop/ipc-contract.test.js L86-109 "main subscribes the power events at app scope": it text-matches a call exists and that `restoreShortcutsAfterCaptureAbort` does not contain it. The same defect class (the call nested inside some OTHER early-returning function) goes undetected; "app scope" is not asserted.
- L195 matches main.js text including the exact indentation (`\n    if (!win || ...`): a reformat fails it, a changed condition with the same text prefix passes it.
- desktop/screen-input.test.js L45 `split("\n").length === 11` pins the number of cases instead of asserting that every case ran (adding a case breaks it, removing a case plus adding one passes).
Fixed: assert the registration through the real module with a fake `powerMonitor` (power-events.test.js already does) plus a check that the call sits at whenReady depth; assert case names from the list, not a count.

### DX-29 · P2 · hypothesis · window-lifecycle.js claims the dwell timers are gone; one remains in the decision input
File: window-lifecycle.js L7-17 and L91-99 (`capsuleInteraction`), main.js L1437-1444 (`recordingStatusSuppressActivateUntil = Date.now() + RECORDING_STATUS_CAPSULE_ACTIVATE_SUPPRESS_MS`).
Gist: the module header lists a "2.5 s dwell" among the mechanisms the table replaced, but `appActivate` is suppressed by a time window set when the capsule page changes its title. A genuine Dock click inside that window is swallowed as "capsule interaction". Since 1.6.6 screen-mode taps never reach the window server, so for the screen path the dwell is dead weight. Belongs to main.js owner too.
Fixed: decide on `event.sender`/the capsule window being the clicked target instead of a clock, or drop the suppression now that the capsule is non-activating.

### DX-30 · P2 · hypothesis · prepare-runtime.sh falls back silently to the host's `python3 -m pip`
File: prepare-runtime.sh L192-200 `pip_runner_python`.
Gist: if the bundled interpreter has no pip the build quietly uses whatever pip the release host has; the lock is applied but the resolver/`--target` semantics differ by pip version. The log prints the pip version but nothing fails or warns.
Fixed: die unless the bundled pip is used for the native target; allow the fallback only for cross targets, with a warning.

---
## Clean places (named, with why)
- main.swift state sharing: `classifier` is read/written from the tap callback under `state.lock`; the stdin thread writes only `classifier.controls`, also under the lock; `heldDown` and `tap` are touched only from the callback thread (run loop) or before the thread starts. No race found. Output goes through a serial queue, never from the callback.
- PressClassifier: all 11 sequences in the Swift suite are consistent with `classify`; `.onControl` wander, orphan drag, release-without-press verified by reading, no off-by-one in the threshold (`>=`, Euclidean). Only the stale-state-after-disable hole (DX-07).
- Contract names: `stagingDirName`, `eventsFileName`, id and screenshot patterns match screen-mode.js and backend `EVENTS_FILE_NAME`; `dir` is re-homed by the backend (`_rehome_manifest`); `endedAt`/`audioStartedAt` handled.
- Overlay/palette HTML: all interpolated values are constants or Electron-owned numbers; palette colour is validated against `SCREEN_MODE.colors` in `setColor`; CSP `default-src 'none'`; windows sandboxed, no node. No injection path.
- Display listeners are removed in `unwatchDisplays`; helper is killed on quit and on stdin EOF; overlays destroyed in `teardown`.
- `serialize` chain: start/finish/takeShot are ordered; errors do not poison the chain.
- accelerator.js, shortcut-migration.js, user-data-dir.js, child-io.js, linux-wm-class.js, python-version.js, power-events.js, recording-final-slot.js, renderer-console.js, paste-protocol.js: logic read and consistent with their tests; no defect found. recording-status.js: substring ladder is the known D-013 tail, not re-reported.
- macos-signing-utils classifyMacho (fat32/fat64 offsets), resolveSigningPlan, runtimeSignArgs, afterPack ordering (pre-sign before osx-sign, read-only after): correct as read. unlockDist distinguishes missing from unreadable.
- tests: no test without an assertion (scripted scan of all 23 files); packaging.test.js whitelist walk is real (graph from main/preload).
- preload.js: fixed channels only, payload copied to fresh objects; `screen-mode:finish` is checked against `win.webContents` in main.
- CI workflow: permissions minimal, concurrency set, lock applied (checked by packaging test).
