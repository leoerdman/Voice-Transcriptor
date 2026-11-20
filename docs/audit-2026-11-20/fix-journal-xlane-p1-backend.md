# Fix journal — cross-domain lane p1-backend (2026-11-20)

Branch `worktree-agent-a20e6e245bf863957`, cut from `main` at 3cc7666.
Source: `docs/NEXT_SESSION_2026-11-20.md` §3.2 and Appendix A; original
findings in `docs/audit-2026-11-20/*.md`.

Every commit was verified with the full set from AGENTS.md: backend suite
(throwaway venv), `npm --prefix desktop test`, `node --check` main/preload,
frontend typecheck, lint, vitest, build.

## C1 — FQ-04: job poll failures classified (renderer)

Files: `frontend/src/job-poll.ts`, `frontend/src/main.tsx`
(`waitForBackendJob`), `frontend/tests/job-poll.test.ts`.

What was already there (FG-13 a/c/d, d9dbf0d): a rejected poll is retried up
to `maxConsecutiveFailures`, and a wait that ends without a terminal job
status and without the caller's abort cancels the job (`waitForJob`'s
`catch` → `deps.cancel()`), so the `finally` cancel the handoff asks for in
`waitForQueued*Job` is already provided one level down — adding it there
would be a second owner of the same decision. Abort still cancels through the
callers' signal listener.

What was missing: every non-2xx poll was a plain `Error` and therefore
retried — a 404 (job gone after a backend restart / results sweep) was polled
three more times and then "cancelled", a 401 likewise. Now `fetchJob` throws
`JobPollHttpError(status)`, and `classifyJobPollFailure` decides:
transport failure / 5xx / 429 → transient (bounded retries, same ladder);
404 → terminal, no cancel (no job left); other 4xx → terminal at once, cancel
(the job may still be running).

Check (test fails on the old behaviour — classification forced to "transient"):

```
before:  × ends the wait on a 404 at once, without retrying or cancelling a job that is gone
         × ends the wait on another 4xx at once and cancels the job it may leave running
         Tests  2 failed | 8 passed (10)
after:   Tests  10 passed (10)
```

Suites: backend 991 OK; desktop 427 pass; vitest 604 pass; typecheck, lint,
build clean.
