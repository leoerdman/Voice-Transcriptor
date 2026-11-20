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
