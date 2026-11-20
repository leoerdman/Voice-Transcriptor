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
