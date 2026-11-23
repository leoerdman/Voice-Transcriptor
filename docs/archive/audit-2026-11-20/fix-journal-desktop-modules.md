# Fix journal — desktop modules lane (Ultra-Audit 2026-11-20)

Lane: everything under `desktop/` except `main.js`/`preload.js`, plus root
`BUILD.command`, `INSTALL*.command`, `.github/workflows/*`,
`contracts/screen-session.json`, `PROJECT_STRUCTURE.md`.
Branch: `worktree-agent-a30345c8757a812a1` (fast-forwarded to `bbce978`, the audit report commit).
Proof method: SKILL §7.1 — the fix is taken off (`git show HEAD:<file> > <file>`),
the check is run, the fix is put back byte-for-byte (`diff -q` against the backup),
the check is run again. Outputs below are verbatim excerpts of the saved runs.

## Commits

| Label | Hash | IDs |
|---|---|---|
| C1 | fed6041 | DX-07, DX-10 (main.swift type-check), DX-28 (case names) |
| C2 | 843dea7 | DX-01, DX-04, DX-09, DX-14 |
| C3 | 907a9f1 | S-02 = DX-03 = DM-31 (controller side), DX-02, DX-08 = H-08 = S-04 (controller side), DX-18, DX-06, S-03 (capture side), DX-10 (golden lines) |
| C4 | 22cfe18 | DX-13 |
| C5 | afdb862 | DX-11, H-09, DX-25, DX-20 |
| C6 | 0c8ecde | H-04, H-10, DX-29 + H-03 (documentation half) |
| C7 | 40851dc | DX-22, DX-21 (altool half), DX-23, H-6, H-7 (old IDs), H-12 |
| C8 | 204be72 | DX-26 |
| C9 | ff74adb | DX-30, DX-24 (H-8) |
| C10 | (this journal's last commit) | journal: Not done + Cross-domain |

### C1 — DX-07, DX-10 (part: main.swift type-checked), DX-28 (part: case names, not a count)
Files: `desktop/native/screen-input/PressClassifier.swift`, `desktop/native/screen-input/main.swift`,
`desktop/native/tests/press-classifier/main.swift`, `desktop/screen-input.test.js`.
Check: `node --test desktop/screen-input.test.js`.

DX-07 — before (PressClassifier.swift at HEAD, new suite):
```
✖ PressClassifier: clicks pass, drags draw, double-tap-drag draws, controls tap in-process, a switched-off tap abandons its press (9423.825291ms)
✖ the helper (event tap + protocol) compiles with the rule it ships (982.354833ms)
ℹ pass 0
ℹ fail 2
  AssertionError [ERR_ASSERTION]: …/native/tests/press-classifier/main.swift:35:48: error: 'Abandoned' is not a member type of struct 'main.PressClassifier'
```
after:
```
✔ PressClassifier: clicks pass, drags draw, double-tap-drag draws, controls tap in-process, a switched-off tap abandons its press (6296.169083ms)
✔ the helper (event tap + protocol) compiles with the rule it ships (5480.304209ms)
ℹ pass 2
ℹ fail 0
```
The main.swift half (reposting the held press, emitting `end` for an open
stroke, the `tap-disabled` line) has no unit check — it needs macOS to switch
a live tap off; it is covered by the type-check below and by the controller
golden-line test (C3) that logs the `tap-disabled` line.

DX-10 — a compile error appended to main.swift (`let broken: Int = "drift"`);
before (screen-input.test.js and the Swift suite at HEAD):
```
exit=0
✔ PressClassifier: clicks pass, drags draw, double-tap-drag draws, controls tap in-process (1756.418084ms)
ℹ pass 1
ℹ fail 0
```
after (new test file, same broken main.swift):
```
exit=1
✔ PressClassifier: clicks pass, drags draw, double-tap-drag draws, controls tap in-process, a switched-off tap abandons its press (939.319417ms)
✖ the helper (event tap + protocol) compiles with the rule it ships (735.679083ms)
ℹ pass 1
ℹ fail 1
```

DX-28 (third bullet) — a case silently replaced (the "release with no press"
case renamed to a duplicate of another, count unchanged); before (HEAD test):
```
exit=0
✔ PressClassifier: clicks pass, drags draw, double-tap-drag draws, controls tap in-process (842.783791ms)
```
after (named-case test):
```
exit=1
✖ PressClassifier: clicks pass, drags draw, double-tap-drag draws, controls tap in-process, a switched-off tap abandons its press (678.756542ms)
```

### C2 — DX-01, DX-04, DX-09 (harness), DX-14
Files: `desktop/screen-mode.js`, `desktop/screen-mode-controller.js`, `desktop/screen-mode.test.js`,
new `desktop/screen-mode-controller.test.js`.
Check: `node --test desktop/screen-mode-controller.test.js desktop/screen-mode.test.js`.
Before (screen-mode.js and screen-mode-controller.js at HEAD, new tests):
```
exit=1
✖ a stroke that finishes while a shot is captured is not in that shot and stays on the screen (43.985208ms)
✖ a shot leaves a stroke still being drawn on the screen, with what it has drawn (41.731916ms)
✖ unplugging a display does not move the strokes already drawn on it (6.471791ms)
✖ the manifest lists strokes and shots in time order with their shot number (0.576375ms)
✖ a shot takes only the strokes it was made with; one finished meanwhile stays pending (0.137166ms)
✖ a stroke's position comes from its display as it was when drawn, not as it is now (0.136459ms)
ℹ pass 9
ℹ fail 6
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:   actual: 2, expected: 1          (shot 1 claimed the stroke finished during capture)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:   actual: false, expected: true   (the in-progress stroke was wiped)
  AssertionError [ERR_ASSERTION]: … actual: [ 100, 100 ], expected: [ 20, 10 ]                          (unplugged display moved the stroke)
```
After:
```
exit=0
ℹ pass 15
ℹ fail 0
```
DX-14: the never-produced default `reason = "button"` is gone from both
places (screen-mode.js `recordShot`, controller `takeShot`); `reason` stays
a diagnostic field of events.json and the shot log line, set by every caller
(`capsule`, `hotkey`, `stop`). No consumer was added (no product need).
DX-09: the harness runs the shipped overlay page in a `vm` with a recording
canvas; the controller takes `deps.platform` so the suite runs on every OS
instead of joining the darwin-gated list in packaging.test.js.

### C3 — S-02 = DX-03 = DM-31 (controller side), DX-02, DX-08 = H-08 = S-04 (controller side), DX-18, DX-06, S-03 (capture side), DX-10 (protocol golden lines)
Files: `desktop/screen-mode-controller.js`, `desktop/screen-mode-controller.test.js`.
Check: `node --test desktop/screen-mode-controller.test.js`.
Before (controller at C2, new tests):
```
exit=1
✖ a stop that reaches the controller before its start wins: the late start is refused (5.734209ms)
    actual: { ok: true, id: 'screen-20261120-100000-000' },  expected: { ok: false, error: 'ended' },
✖ a new take while an old session is still up closes the old one and starts the new id (3.770792ms)
    actual: { ok: true, id: 'screen-20261120-100000-000' },  expected: { ok: true, id: 'screen-20261120-100500-000' },
✖ a helper without Accessibility fails the start: not ok, warned, nothing left on screen (3.813667ms)
    actual: true, expected: false,
✖ a helper that cannot be spawned fails the start (4.43175ms)
    actual: true, expected: false,
✖ no overlay that can be shown fails the start (2.75575ms)
    actual: true, expected: false,
✖ an overlay that would take the mouse is never shown (5.093667ms)
    actual: true, expected: false,
✖ one display's overlay failing, or the palette failing, still starts the take (7.0295ms)
    actual: 2, expected: 1,
✖ a helper that dies mid-take is reported (5.611334ms)
    actual: [], expected: [ 'helper' ],
✖ a capture that fails claims no screenshot and keeps the strokes for the next one (4.271ms)
    actual: { index: 1, files: [] }, expected: null,
✖ a stroke on a display that is gone is not stamped into a shot of the others (5.503375ms)
    actual: 2, expected: 1,
✖ Screen Recording that is not granted yet is warned about at start (5.481709ms)
    actual: [], expected: [ 'screen-recording' ],
✖ every stdout line main.swift documents is understood by the controller (4.310416ms)
  AssertionError [ERR_ASSERTION]: line tap-disabled had no effect
ℹ pass 3
ℹ fail 12
```
After:
```
exit=0
ℹ pass 15
ℹ fail 0
```
Behaviour changes the lead must know about (they need main.js, see Cross-domain):
`start` now answers `{ok:false, error}` on failure and calls `onWarning` with
`"start-failed"`, `"accessibility"`; mid-take helper death → `"helper"`;
failed capture → `"capture-failed"` (the old regex-matched `"screen-recording"`
on capture failure is gone; `"screen-recording"` is now raised at start for
every access state but `"granted"`). main.js's `SCREEN_MODE_WARNINGS` has
copy only for `accessibility` and `screen-recording`, so the three new kinds
are logged (`[screen-mode] warning <kind>`) but not shown until main adds copy.
A stroke whose display could not be captured stays pending; if the stop's own
shot cannot capture it either, it is not in the manifest (it was never in an
image) — the log line `capture failed (stop): …` records it.

### C4 — DX-13
Files: `desktop/screen-mode-controller.js`, `desktop/screen-mode-controller.test.js`.
Check: `node --test --test-name-pattern="palette dot" desktop/screen-mode-controller.test.js`.
Before (controller at C3):
```
exit=1
✖ a tap on a palette dot selects its colour without a title channel (11.3765ms)
  AssertionError [ERR_ASSERTION]: no document.title IPC
    actual: 1,
    expected: 0,
```
After:
```
exit=0
✔ a tap on a palette dot selects its colour without a title channel (14.803375ms)
ℹ pass 1
```
The capsule's own title channel (костыль 1, main.js) is unchanged — main.js lane.

### C5 — DX-11, H-09, DX-25, DX-20
Files: `desktop/afterPack.js`, `desktop/scripts/macos-signing-utils.js`, `desktop/scripts/build-mas.sh`,
`desktop/scripts/build-native.sh`, `desktop/package.json`, `.github/workflows/tests.yml`,
`desktop/packaging.test.js`, `desktop/signing.test.js`.
Check: `node --test desktop/packaging.test.js desktop/signing.test.js`.
H-09 settled by reading app-builder-lib 26.15.3: `macPackager.getPlatformConfig("mas")` =
`deepAssign({}, mac, mas)` and `deepAssign` concatenates arrays — so the MAS build inherits
`build.mac.extraResources` (the helper directory AND a second copy of `runtime/mac-${arch}`
to the same destination; the duplicate-destination test modelled mas as base+mas only).
Decision: the App Store build ships no helper (an active CGEventTap cannot run in the App
Sandbox); `build-mas.sh` empties `native/build/mac-arm64` before packing and afterPack
refuses a MAS bundle that carries one; the redundant `build.mas.extraResources` is removed.
Before (all eight files at HEAD of C4, new tests):
```
exit=1
✖ CI runs the desktop suite where its osacompile tests can execute (1.126583ms)
  AssertionError [ERR_ASSERTION]: The input was expected to not match the regular expression /\b(\d+|one|…|seventeen|…) suites are\b/i.
✖ no extraResource is copied to the same destination twice (0.433834ms)
  AssertionError [ERR_ASSERTION]: mas: duplicate extraResources destinations
✖ every mac dist script builds screen mode's helper before electron-builder; the App Store one leaves it out (7.735667ms)
  AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
✖ the helper's place in the bundle is one fact across build-native.sh, package.json, main.js and afterPack (2.778042ms)
  TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string. Received undefined
✖ afterPack's helper check: a mac build must carry screen-input, an App Store build must not (0.3945ms)
✖ afterPack runs the helper check for every mac flavour, before signing (0.641208ms)
ℹ pass 28
ℹ fail 6
```
After:
```
exit=0
ℹ pass 34
ℹ fail 0
```
DX-25: `build-native.sh mac-x64` is now an explicit error ("macOS builds are arm64-only")
instead of a dead branch; the mis-indented `"user-data-dir.js"` entry is fixed. main.js's
dev path `mac-${process.arch}` stays (main.js lane; on Intel it resolves to a directory
that is never built → `isSupported()` false, consistent with arm64-only).

### C6 — H-04, H-10, DX-29 + H-03 (documentation half)
Files: `PROJECT_STRUCTURE.md`, `desktop/window-lifecycle.js`, `desktop/packaging.test.js`.
Check: `node --test --test-name-pattern="PROJECT_STRUCTURE" desktop/packaging.test.js`.
Before (PROJECT_STRUCTURE.md at HEAD of C5):
```
exit=1
✖ every module the desktop bundle ships is named in PROJECT_STRUCTURE.md (4.92675ms)
  + actual - expected
  + [
  +   'user-data-dir.js'
  + ]
  - []
```
After:
```
exit=0
✔ every module the desktop bundle ships is named in PROJECT_STRUCTURE.md (1.672917ms)
```
H-10: also added backend/model_catalog.py, audio_mime.py, deepgram_format.py and
frontend live-source.ts, live-pane.ts, transcription-catalog.ts, shortcut-display.ts,
plus the unlisted desktop/scripts (build-native.sh, notarize-dmg.sh,
check-designated-requirement.js, generate-dmg-background.py); the guard covers the
desktop bundle only (backend/frontend entries have no machine-readable list to check
against). H-04: "non-activating panels" (PROJECT_STRUCTURE), "exclusion rectangles"
(controller header C3, main.swift stdin comment C1), "prune list" (controller header C2),
"non-focusable … panel" / "the capsule is a panel" (window-lifecycle.js) reworded to what
the code is. DX-29/H-03: window-lifecycle.js now states that `capsuleInteraction` comes
from a 700 ms clock in main.js (not an identity) and that a Dock click inside it is
swallowed; the behavioural fix is main.js's (Cross-domain). Doc-only; no check beyond the
grep that the stale words are gone.

### C7 — DX-22, DX-21 (altool half), DX-23, H-6, H-7 (old desktop-findings IDs), H-12
Files: `desktop/scripts/check-designated-requirement.js`, `desktop/scripts/upload-testflight.sh`,
`INSTALL_ON_OTHER_MAC.command`, `BUILD.command`, `desktop/signing.test.js`, `desktop/packaging.test.js`.
Check: `node --test --test-name-pattern="without a shell|TestFlight" desktop/signing.test.js desktop/packaging.test.js`
and `node --test --test-name-pattern="other-Mac|BUILD.command quits" desktop/packaging.test.js`.

DX-22/DX-21 before (both scripts at HEAD of C6):
```
exit=1
✖ the TestFlight upload keeps the app-specific password off the command line (1.520208ms)
  AssertionError [ERR_ASSERTION]: The input was expected to not match the regular expression /-p\s+"\$ASC_APP_SPECIFIC_PASSWORD"/.
✖ the install-time requirement check reads the signature without a shell (89.9165ms)
  AssertionError [ERR_ASSERTION]: a command in the bundle path was executed
  true !== false
```
(the second is a real injection: an unsigned bundle under a directory named
`inj-$(touch pwned)` made the old `/bin/sh -c` fallback create `pwned`.)
After:
```
exit=0
✔ the TestFlight upload keeps the app-specific password off the command line (1.700625ms)
✔ the install-time requirement check reads the signature without a shell (58.203042ms)
```

Installer/BUILD before (INSTALL_ON_OTHER_MAC.command and BUILD.command at HEAD):
```
exit=1
✖ the other-Mac installer refuses a build whose signature would strand the user's permissions (440.636ms)
✖ the other-Mac installer never replaces the bundle under a process that would not quit (189.890375ms)
✖ the other-Mac installer's privileged helpers work before main() decides on sudo (set -u) (76.783625ms)
✖ BUILD.command quits a running duplicate bundle before deleting it (0.289209ms)
ℹ pass 0
ℹ fail 4
```
Because the HEAD installer runs `main` when sourced, the same three installer tests were
also run against HEAD logic with only the source guard added — they still fail on the
defects themselves:
```
✖ the other-Mac installer refuses a build whose signature would strand the user's permissions (169.578208ms)
  AssertionError [ERR_ASSERTION]: same signer: install          (no verify_identity_continuity at all)
✖ the other-Mac installer never replaces the bundle under a process that would not quit (49.241458ms)
  AssertionError [ERR_ASSERTION]: [Transcriptor installer] Stopping still-running Transcriptor process
  returned
  0 !== 1                                                        (H-7: pkill, sleep 1, break, carry on)
✖ the other-Mac installer's privileged helpers work before main() decides on sudo (set -u) (199.716917ms)
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /ran/. Input: ''   (H-6: NEEDS_SUDO unbound)
```
After:
```
exit=0
ℹ pass 4
ℹ fail 0
```
DX-23 manifest half: `app_id=` in the manifest beside the installer is written by
BUILD.command into the same kit as the DMG; whoever can replace the manifest can replace
the DMG, so it is not a trust boundary — left as is (see Not done).

### C8 — DX-26
Files: `desktop/paste-result.js`, `desktop/paste-protocol.js`, `desktop/paste-result.test.js`.
Check: `node --test desktop/paste-result.test.js`.
Before (paste-result.js, paste-protocol.js at HEAD of C7):
```
exit=1
✖ windows: the verdict is the last line, as on macOS — a marker inside other text is not an OK (0.860583ms)
ℹ pass 30
ℹ fail 1
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    actual: true,
```
After:
```
exit=0
ℹ pass 31
ℹ fail 0
```
The method names `vbs-paste` / `pwsh-paste` now live in paste-protocol.js
(`VBS_PASTE_METHOD`, `PWSH_PASTE_METHOD`); main.js still types them in the scripts it
builds (L5416-5417, L5453, L5499, L5507) — Cross-domain.

### C9 — DX-30, DX-24 (H-8)
Files: `desktop/scripts/prepare-runtime.sh`, `desktop/packaging.test.js`.
Check: `node --test --test-name-pattern="host's pip" desktop/packaging.test.js`.
Before (prepare-runtime.sh at HEAD of C8):
```
exit=1
✖ prepare-runtime never installs a native runtime with the release host's pip (186.566917ms)
  AssertionError [ERR_ASSERTION]: python3
    actual: 0,
```
After:
```
exit=0
✔ prepare-runtime never installs a native runtime with the release host's pip (124.534667ms)
```
H-8: the python-build-standalone URL now names its current home (astral-sh); checked
`curl -sIL` → `200` for the pinned 20260414 / 3.12.13 aarch64 tarball. The download is still
verified by the pinned SHA256 in `fetch`, so the bytes cannot differ.

## Final verification (on the last commit)
`npm --prefix desktop test` → tests 343, pass 343, fail 0;
`node --check desktop/main.js && node --check desktop/preload.js` → ok;
`bash desktop/scripts/build-native.sh mac-arm64` → built.

## Not done (ID → reason)
- **DX-05** (P2) → refuted on reading, not changed. The overlay stores points relative to
  the display's origin AT THE TIME they were drawn. A display that moves in the arrangement
  keeps its pixels where they are physically, so a stroke at local (100,100) must stay at
  local (100,100) — which is exactly what the current code does. Re-basing (the audit's
  fix) would move every existing stroke off the place it was drawn. The only real residue
  is a ≤16 ms window where ops queued before `__setOrigin` are applied after it; too small
  to justify converting ops in the controller.
- **DX-12** (P2) → needs main.js: the `54` fallback is capsule `bottomMargin 16` + height
  30 + palette margin 8, and the overlay < palette < capsule levels are `"screen-saver"`
  0/1 here and 2 in main.js. One constants object must be owned by one side and injected
  into the other (see Cross-domain).
- **DX-15** (P2, hypothesis/perf) → not measured; the suggested "composite from the file
  URL" is not available (overlay page is a sandboxed `data:` page with CSP `img-src data:`).
  Left until a measurement shows the cost.
- **DX-16** (P2, UX) → product decision (pen toggle / pass-through modifier); not a defect
  of the stated product rule.
- **DX-17** (P2) → product decision per the lead's brief (global Option+Right / Option+Down
  defaults); `shortcut-defaults.json` untouched.
- **DX-19** (P2, hypothesis) → adding `ScreenCapture` to paste-capability's repair table
  changes behaviour (it would reset a TCC grant) on an unverified macOS assumption.
- **S-03 rest** (P1, hypothesis) → the wallpaper-only probe (compare against a one-pixel
  probe window) and the TCC repair need macOS behaviour verified on a machine; only the
  capture-side parts were fixed (C3: warn on every non-"granted" state, no regex, no
  screenshot claimed for a failed capture).
- **DX-21 notarytool half** (P2) → `notarytool --password` has no env/keychain-reference
  form; removing the Apple-ID password path means changing `.env.example` (another lane's
  SSOT). See Cross-domain.
- **DX-23 manifest half** (P2) → `app_id=` in the manifest beside the installer is written
  by BUILD.command into the same kit as the DMG; replacing it requires the same access as
  replacing the DMG, so it is not a trust boundary. The identity guard (C7) is what protects
  the user's grants.
- **DX-24** (P2, known items) → D-023 (default internal identity name), D-063 (mutable
  osxexperts ffmpeg URL: hosting decision), D-061, D-034, DMG artwork text, костыль 1
  (main.js title channels), костыль 8 (afterPack read-only / unlockDist cycle), PowerShell
  helper, BUGS_AUDIT_2026-09-03 §8 #30 `Alt+Left` — decisions or other lanes, unchanged.
  H-8 was fixed (C9).
- **DX-27** (P2, hypothesis) → re-enabling a disabled verification target changes observable
  paste behaviour (clipboard restore) on an unverified premise.
- **DX-28 bullets 1–2** (P2) → `ipc-contract.test.js` tests only main.js; main.js lane.
- **DX-29 / H-03 behaviour** (P1/P2) → the 700 ms activate suppression lives in main.js;
  only the documentation half was done here (C6).

## Cross-domain, for the lead
1. **main.js — screen-mode warnings copy** (C3): `SCREEN_MODE_WARNINGS` must gain copy for
   the new kinds the controller now raises: `start-failed` ("Screen mode could not start"),
   `helper` ("Screen mode stopped drawing" — the mouse helper died mid-take),
   `capture-failed` ("A screenshot could not be taken" — the strokes stay on screen for the
   next one). Until then they are only logged as `[screen-mode] warning <kind>`.
2. **main.js + renderer — S-04 / DX-08 renderer side**: `screenMode.start()` now answers
   `{ok:false, error}` on failure (`"ended"`, `"unsupported"`, helper/overlay errors).
   main.js L2891 only traces it; it must tell the renderer to demote the take to a voice
   take (`liveRecordingMode = "voice"`, Live collection, not Screen Sessions), so retention
   is not downgraded for a take with no screen session.
3. **main.js — S-02 / DM-31 main side**: the controller refuses a start whose id already
   ended. main should also stop awaiting `frontAtHotkeyPromise` / `beginRecordingStatusSession`
   before `screenMode.start` (or start it before the renderer is told to record), and
   `endScreenModeForLostRenderer` should pass the take's id
   (`screenMode.finish({ id, discard:false })`) so a renderer lost before main's start ran
   retires that id too.
4. **main.js — DX-12**: export the capsule geometry (`bottomMargin`, `pillHeight`) and the
   window levels (overlay 0 < palette 1 < capsule 2 on `"screen-saver"`) from one place and
   inject them into the controller (`deps.capsuleLayout`, `deps.levels`); the controller then
   computes its palette fallback instead of the literal `54`.
5. **main.js — DX-26 markers**: the VBS/PowerShell scripts main.js builds still type
   `"OK:vbs-paste"` (L5417, L5453) and `"OK:pwsh-paste"` (L5499, L5507); build them from
   `PASTE_OK_PREFIX` + `VBS_PASTE_METHOD` / `PWSH_PASTE_METHOD` (paste-protocol.js).
6. **main.js — DX-29 / H-03**: decide `capsuleInteraction` from the capsule being the clicked
   target (or route voice-mode capsule clicks through the same in-process tap path) instead of
   `RECORDING_STATUS_CAPSULE_ACTIVATE_SUPPRESS_MS`; then drop the limit paragraph from
   window-lifecycle.js's header.
7. **main.js — DX-25 tail**: the dev helper path `native/build/mac-${process.arch}` can name
   `mac-arm64` (the only target build-native.sh builds).
8. **desktop/ipc-contract.test.js (main.js tests) — DX-28 bullets 1–2**: assert the power
   events registration through power-events.js with a fake `powerMonitor` and its whenReady
   depth, not a text match; drop the indentation-exact match at L195.
9. **.env.example — DX-21 notarytool half**: remove `NOTARYTOOL_APPLE_ID` /
   `NOTARYTOOL_TEAM_ID` / `NOTARYTOOL_PASSWORD` (keychain profile or API key only); then
   `desktop/scripts/notarize-dmg.sh` drops the `--password` branch (my lane can do that part
   once `.env.example` changes).
10. **CHANGELOG.md** — user-visible changes in this lane worth an entry: screen mode no longer
    reports a failed start as started; a stroke finished during a screenshot goes to the next
    one; a failed capture keeps its strokes; the helper logs `tap disabled …` lines; the
    other-Mac installer refuses ad-hoc builds and certificate changes over a granted copy.
11. **Not verified on a machine**: DX-07's main.swift half (replaying a held press when macOS
    switches the tap off) — type-checked and its rule unit-tested, but a live disabled tap
    was not reproduced. The new `[screen-mode] tap disabled reason=… abandoned=…` line in
    main.log is what will show whether the user's trackpad double-tap-drag failure is a
    disabled tap.
