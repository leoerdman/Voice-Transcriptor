# Fix journal — desktop modules lane (Ultra-Audit 2026-11-20)

Lane: everything under `desktop/` except `main.js`/`preload.js`, plus root
`BUILD.command`, `INSTALL*.command`, `.github/workflows/*`,
`contracts/screen-session.json`, `PROJECT_STRUCTURE.md`.
Branch: `worktree-agent-a30345c8757a812a1` (fast-forwarded to `bbce978`, the audit report commit).
Proof method: SKILL §7.1 — the fix is taken off (`git show HEAD:<file> > <file>`),
the check is run, the fix is put back byte-for-byte (`diff -q` against the backup),
the check is run again. Outputs below are verbatim excerpts of the saved runs.

## Commits

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
