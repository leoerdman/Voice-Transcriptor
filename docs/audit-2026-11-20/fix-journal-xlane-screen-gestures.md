# Fix journal: lane screen-gestures (2026-11-20)

Branch `worktree-agent-a34db39e26926102c`, cut from `main` at 13f25e2.

## Bug 1: trackpad double-tap-and-drag gives a cursor jump and a pile of marks

### Evidence (main.log, installed 1.6.7, session `screen-20261120-215447-343`)

- Two bursts in one take:
  - 14:55:14.202–.990: 1,393 lines of `press outcome=click clicks=1 drags=0`, then `stroke clicks=1 drags=1`, then `orphanStroke drags=23`.
  - 14:55:35.267–39.927: 12,402 lines of `press outcome=click clicks=0 drags=0`, some lines with `clicks=1` mixed in, then `stroke drags=1`, then `orphanStroke drags=15`.
  - In total about 20,800 complete down→up press cycles in about 5.5 s, at 5–13 per millisecond. No finger can do that. No `tap-disabled` line appears.
- Both bursts end at the exact moment the classifier starts a stroke, which is when the helper stops replaying the held press. So the replay is what keeps the loop running.
- The `clicks` value stays the same through a burst (1 in the first, 0 in the second). The events coming back are copies of what the helper posted, not newly created events. I checked locally that a freshly created `CGEvent` gets clickState=1 and the poster's pid by default.
- Output of `CGGetEventTapList` on this Mac: BetterTouchTool has an enabled modifying session-level tap (`0x800005f`: left and right down/up, left dragged). DockDoor has HID-level taps.
- `com.apple.AppleMultitouchTrackpad` has `Dragging=0`, `DragLock=0`, `TrackpadThreeFingerDrag=0`. So macOS's own tap-drag is off, and the user's double-tap-drag most likely goes through BetterTouchTool, which has `BTTTrackpadSingleFingerTapDoubleTapDelay` set.
- I checked locally that a posted event keeps its timestamp: a mouseMoved posted at the cursor with ts=123456789 was received by a session tap with the same ts.

### Mechanism

The helper swallows a press. On release it re-posts the held down and the up, marked with `eventSourceUserData`. Another app's tap re-posts those events with its own user data written over the marker. They come back unmarked and look like a new press, so the helper holds and replays them again, and the loop repeats. Each replayed down is posted at the original press point, which moves the cursor there ("jumps away and flies back"). The finger's drags are measured against a press point that keeps resetting, so a drag stays below the 5 pt threshold until one gets through. That stroke is then ended by an echoed up, and the drags that follow become orphan strokes. The result was 17 strokes at one spot and 16 identical marks.

### Fix (commit e815519)

- `PressClassifier` remembers the timestamps of the events it replays (`replayClick`, and a press handed over by `interrupt`) in a ring of the last 8. A down or up that carries one of these timestamps is passed through. The press in progress is not touched, no outcome is reported, and the event is counted in `echoes`.
- The helper's press line now has `echoes=N` and `by=<process that posted the release>`. The controller logs a run of identical press lines once, followed by `(xN more, identical)`.
- Failing test first: `a replayed click that comes back re-posted is passed, not pressed again`. Before the fix it failed with `down … stamp 7000000: expected pass, got hold`. After the fix it passes. Desktop suite: 511/511.

### Not verified live / remaining

- I assumed BetterTouchTool re-posts copies, which keep the timestamp. If it builds new events instead, the timestamp will not match and the loop can still happen. The next live attempt settles this: look for `echoes>0` on press lines (fix working), or a collapsed `(xN more)` run with `by=BetterTouchTool` (new events, need another way to identify them).
- I did not post real mouse events on the user's machine (that would click real UI), so the loop has not been reproduced end to end.
- Mark coalescing in `frontend/src/screen-annotations.ts` (identical stroke marks, meaning same second, same place and same shot, printed once) is not done yet.

## Bug 2: drawings should disappear before the screenshot is saved

Plan, not committed at the time of writing. Add a "detached" state to the overlay page:
- `__detach(ids)` moves the strokes to a held map and redraws right away. This happens at the start of `takeShotNow`, after `pendingStrokes` is snapshotted.
- `__composite` paints from the held map.
- On success, `__drop(ids)` deletes them. A display whose capture failed gets `__restore(ids)`, so its strokes come back on screen and stay pending for the next shot, which keeps the existing guarantee.
- Log the clear latency.
