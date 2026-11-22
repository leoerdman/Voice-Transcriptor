# Agent Rules

These rules apply to automated and human-assisted code changes in this
repository.

1. Use durable, enterprise-grade solutions only. Fix the root cause, not the
   visible symptom.
2. Do not add temporary hacks, hidden TODOs, duplicated logic, or parallel
   sources of truth.
3. Do not delete logs unless the user explicitly asks for log deletion.
   Standing exception the user approved on 2026-11-20: the desktop boot
   sweep keeps the newest 10 `main.log` archives and at most 50 MB of them
   (`desktop/log-retention.js`). Any other log deletion still needs an
   explicit request.
4. Preserve SSOT boundaries. Product vision lives in `docs/PRODUCT.md`
   (`docs/VISION.md` is the one-paragraph statement it expands); release
   environment variables live in `.env.example`; app version lives in
   `desktop/package.json`; the Python version lives in `.python-version`
   and the Node version in `.nvmrc`; the exact dependency versions the
   shipped runtime is built with live in `requirements.runtime-lock.txt`;
   the default hotkeys live in `desktop/shortcut-defaults.json`.
5. Before edits, check `git status` and `git worktree list`, then keep changes
   atomic and commit only verified code.

## Verification commands (run before every commit)

Backend (the interpreter version is `.python-version`; a local interpreter
without the deps is fine to skip — CI runs these on every push):

```bash
python3 -m unittest discover -s backend/tests
```

The whole backend suite runs offline in a throwaway venv — worth doing
rather than deferring to CI, because the modules with the most behaviour
per line (Deepgram live, coverage, splice) need only pure-Python deps:

```bash
python3 -m venv /tmp/vt-tests && /tmp/vt-tests/bin/pip -q install websockets requests numpy soundfile fastapi huggingface_hub cryptography python-multipart httpx && /tmp/vt-tests/bin/python -m unittest discover -s backend/tests
```

Frontend:

```bash
npm --prefix frontend run typecheck   # tsc --noEmit
npm --prefix frontend run lint        # eslint .
npm --prefix frontend test            # vitest
npm --prefix frontend run build       # vite build (CI parity)
```

Desktop:

```bash
npm --prefix desktop test             # node --test — every desktop suite
node --check desktop/main.js && node --check desktop/preload.js
```

The desktop job runs on macOS in CI so that the suites which need macOS
tooling actually execute: the two that hand the shipped AppleScript to
`osacompile` (`applescript.test.js`, `paste-script.test.js`) and the one
that compiles screen mode's click-vs-stroke rule with `swiftc`
(`screen-input.test.js`). They skip themselves elsewhere.

Screen mode's native mouse helper is built by
`desktop/scripts/build-native.sh` (part of every `dist` script); for a dev
run of the desktop shell, build it once with
`bash desktop/scripts/build-native.sh mac-arm64`.

A change is committable only when the suites covering it pass. Push `main`
after committing — work left only on a local branch is considered lost.

