# Fix journal — cross-domain lane `residue` (Ultra-Audit 2026-11-20)

Branch `worktree-agent-ac1b88dd03eb0f9b9`, cut from `main` at 54b8770. Items left open by the
`ui-desktop-p2` and `p1-backend` lanes: FQ-06 (b, c), FL-08, S-15, the dead
`window.__transcriptorMicHealth` global, and a statement on FL-07's local-waiter half.

## Commit 1 · FQ-06 (b, c) — the upload stage flips on the real "job created" event

- **Before.** `processUploadItem` guessed the "Uploading… → Processing…" moment with a timer
  (`_stageCrossoverDelay = clamp(size/10 000, 800, 8 000)` ms, `_stageTimer`). The remote path also flipped on its
  first job poll (`onProcessingProgress`), so two sources set one field; local jobs had only the guess — a
  multi-GB local upload read "Processing…" eight seconds in.
- **After.** `frontend/src/job-poll.ts` `createThenWaitForJob(create, wait, onJobCreated)`: the creation POST
  resolves only after the body is fully sent and the job exists; `onJobCreated` fires then, never when creation
  fails. All four queued transports (`localJobQueued`, `localJobQueuedFromPath`, `remoteJobQueued`,
  `remoteJobQueuedFromPath`) go through it. `frontend/src/upload-item.ts` `enterUploadProcessingStage(item)`
  owns the transition (only `transcribing` + `uploading` moves; returns whether it changed, so the queue
  re-renders once — FQ-07 kept). `_stageCrossoverDelay`, `_stageTimer`, `clearTimeout(_stageTimer)` and the
  remote `onProcessingProgress` plumbing are deleted; the item's `stage` type is `UploadItemStage`.
- Files: `frontend/src/{job-poll.ts,upload-item.ts,main.tsx}`,
  `frontend/tests/{job-poll.test.ts,upload-item.test.ts,renderer-main-contract.test.ts}`.
- Check — new behaviour tests run against HEAD 54b8770's modules: `Tests 5 failed | 26 passed`
  (`createThenWaitForJob is not a function`, `enterUploadProcessingStage is not a function`). With the change:
  pass. The FQ-06/FQ-07 wiring pin in `renderer-main-contract.test.ts` now asserts the timer and the poll hook
  are gone and the four transports use `createThenWaitForJob`.
- Suites: backend `Ran 1028 tests OK`; desktop `tests 477 · pass 477 · fail 0`; `node --check` OK; frontend
  typecheck, lint clean; vitest `Test Files 51 passed · Tests 649 passed`; build OK.
