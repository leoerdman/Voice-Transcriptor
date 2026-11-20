# Fix journal: cross-lane "behaviour-tests" (review-merged.md §4)

Lane goal: the wiring the audit's fix lanes proved by grepping
`desktop/main.js` / `frontend/src/main.tsx` is extracted into small
functions with injected dependencies, the shipped code calls them, and the
claim is tested on behaviour with fakes. Source-text tests stay only for
facts that are textual (a channel/module is or is not present, which
registrar a channel goes through). Every replacement test was run against
a deliberately broken shipped function (break, run, restore); the
evidence is recorded per step.

Cut from `main` at 8e8f0a6.

## 1. IPC sender guarding (DM-28) — security

- New `desktop/ipc-sender-guard.js`: `createSenderGuardedIpc(ipcMain, { isAllowedSender, onRefused })`
  returns `{ handle, on }`; the registrar runs the sender check before the
  handler, so a handler cannot leave it out. main.js registers all nine
  main-window channels through `mainWindowIpc` and the capsule's three
  verbs through `capsuleIpc` (the inline `if (!isFromMainWindow(event))` /
  `if (!fromCapsule(event))` first lines are gone). The only direct
  `ipcMain.on` left is `API_TOKEN_CHANNEL`, which answers every sender by
  design (`""` for anyone but the main window's page; `apiTokenForRequest`
  in ./backend-auth decides, tested in backend-auth.test.js).
- `desktop/ipc-sender.test.js` rewritten. Grep test removed: "slice 260
  chars after the channel name and regex-match `isFromMainWindow(event)`"
  (passed with the call in a comment or another branch). Replaced by:
  - behaviour (fake ipcMain): an invoke channel runs the handler for the
    allowed sender with its arguments; refuses any other sender (and a
    missing event) without running it and answers with `onRefused`'s value;
    a send-only channel drops a foreign sender; the predicate is asked per
    message (window recreated); a registrar without predicate/refusal throws.
  - wiring (textual, kept on purpose — "which registrar a channel goes
    through" is a fact of the source): the set of channels preload.js
    invokes/sends equals the set main.js registers on `mainWindowIpc`
    (line-anchored, so a comment cannot count); the capsule preload's three
    verbs equal the `capsuleIpc` registrations; main.js has no direct
    `ipcMain.handle/on/once` except `API_TOKEN_CHANNEL`.
- `capsule-ipc.test.js`: its regex over `installRecordingStatusCapsuleIpc`
  (`ipcMain.on("verb", (event) => { if (!fromCapsule(event)) return;`) is
  replaced by the two tests above; the preload-path and packaging checks
  stay. `ipc-contract.test.js` / `recording-final-slot.test.js`: the
  channel-presence regexes now name `mainWindowIpc`.
- Break-it evidence:
  - guard `handle` without the check → "an invoke channel refuses any other
    sender…" fails (1 fail); restored → 8/8.
  - guard `on` without the check → "a send-only channel…" and "the
    predicate is asked on every message…" fail; restored.
  - main.js registers `permissions:repair` on `ipcMain.handle` directly →
    "every channel the preload uses…" and "nothing in main.js registers on
    ipcMain directly…" fail; same with the guarded line left in a `//`
    comment above the direct one → same two fail (the old test would have
    passed this one); restored → 8/8.
- Suites: desktop 490/490, frontend 649/649 (51 files), typecheck, lint,
  build, `node --check` main/preload: green.

## 2. Quit path (DM-19)

- New `desktop/quit-path.js`: `createQuitApp({ app, log, normalizeReason })`
  (main.js: `const quitApp = createQuitApp(...)`, so main.js itself calls
  `app.quit()` nowhere) and `installSignalQuitHandlers({ proc, log,
  markQuitting, killBackend, quitApp, exit, setTimer })`, which replaces
  main.js's `for (const sig of [...]) process.on(sig, ...)` loop. The
  250 ms escalation and 1500 ms forced-exit grace are now named
  (`SIGNAL_BACKEND_ESCALATE_AFTER_MS`, `SIGNAL_QUIT_GRACE_MS`) next to
  `SIGNAL_EXIT_CODES`. Behaviour unchanged.
- `desktop/quit-path.test.js` rewritten. Removed: the vacuous
  `assert.ok(calls.length >= 1)`, the "one `app.quit()` inside
  `topLevelFunctionSource("quitApp")`" count, and the regex for the signal
  handler's `quitApp(`signal-${sig}`)` text. Replaced by behaviour tests
  with fakes: quitApp logs the normalised reason, then calls `app.quit`
  once per call; each of SIGINT/SIGTERM/SIGHUP runs log → markQuitting →
  killBackend(escalate 250 ms) → quitApp(`signal-X`) and arms an unref'd
  forced exit with 128+n; a throwing quitApp exits at once.
  Kept textual (wiring): no non-comment line of main.js calls `app.quit(`
  (an absence claim — the comment-line filter can only make it stricter,
  a line starting with `//` or `*` is not code); main.js builds quitApp
  with createQuitApp and installs the handlers with `proc: process`, with
  no `process.on("SIG…")` of its own; the tray item's
  `click: () => quitApp("tray-quit")` (line-anchored).
- Break-it evidence: signal handler without the quitApp call → 2 tests
  fail; quitApp without `app.quit()` → "quitApp logs the reason, then asks
  Electron to quit" fails; the tray item changed to `app.quit()` in
  main.js → the wiring test fails; forced-exit timer removed → "each
  signal…" fails. Restored → 5/5.
- Suites: desktop 493/493, frontend 649/649, typecheck, lint, build,
  `node --check`: green.
