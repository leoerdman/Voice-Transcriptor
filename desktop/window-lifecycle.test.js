"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  WINDOW_LIFECYCLE_EVENTS,
  WINDOW_LIFECYCLE_ACTIONS,
  decideWindowAction,
  decideMainWindowBounds,
  normalizeStoredWindowState,
} = require("./window-lifecycle");

const MAIN_JS = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

// ── The decision table ────────────────────────────────────────────────

test("the table covers every event, and nothing else is accepted", () => {
  const events = Object.values(WINDOW_LIFECYCLE_EVENTS);
  assert.deepEqual(
    [...events].sort(),
    [
      "all-windows-closed",
      "app-activate",
      "capsule-shown",
      "main-window-close",
      "main-window-minimize",
      "second-instance",
      "startup",
      "tray-open",
    ],
  );
  for (const event of events) {
    const decision = decideWindowAction(event);
    assert.ok(
      Object.values(WINDOW_LIFECYCLE_ACTIONS).includes(decision.action),
      `${event} produced an unknown action ${decision.action}`,
    );
    assert.ok(decision.reason, `${event} produced no reason`);
  }
  // A typo in a call site is a crash at the call site, not a window that
  // silently stops appearing.
  assert.throws(() => decideWindowAction("app-activated"), TypeError);
  assert.throws(() => decideWindowAction(undefined), TypeError);
});

test("every way the user asks for the app shows the window", () => {
  for (const event of ["startup", "app-activate", "second-instance", "tray-open"]) {
    assert.deepEqual(
      decideWindowAction(event),
      { action: WINDOW_LIFECYCLE_ACTIONS.show, reason: event },
      `${event} must show the window`,
    );
  }
});

test("closing the window quits — on every platform, not just Windows and Linux", () => {
  // Rule 4. The macOS `close` handler used to preventDefault and hide,
  // which is how the user ended up with an app that was closed and
  // running at the same time.
  assert.deepEqual(
    decideWindowAction(WINDOW_LIFECYCLE_EVENTS.mainWindowClose),
    { action: WINDOW_LIFECYCLE_ACTIONS.quit, reason: "close-is-quit" },
  );
  assert.deepEqual(
    decideWindowAction(WINDOW_LIFECYCLE_EVENTS.allWindowsClosed),
    { action: WINDOW_LIFECYCLE_ACTIONS.quit, reason: "close-is-quit" },
  );
});

test("the decision never depends on the platform", () => {
  // The whole point of the module: Windows and Linux behave identically,
  // so there is no `process.platform` in it to drift.
  const source = fs.readFileSync(path.join(__dirname, "window-lifecycle.js"), "utf8");
  assert.ok(
    !/process\.platform/.test(source),
    "window-lifecycle.js must stay platform-blind",
  );
});

test("minimise is the OS's business and the capsule is nobody's", () => {
  assert.deepEqual(
    decideWindowAction(WINDOW_LIFECYCLE_EVENTS.mainWindowMinimize),
    { action: WINDOW_LIFECYCLE_ACTIONS.none, reason: "native-minimise" },
  );
  assert.deepEqual(
    decideWindowAction(WINDOW_LIFECYCLE_EVENTS.capsuleShown),
    { action: WINDOW_LIFECYCLE_ACTIONS.none, reason: "capsule-never-moves-main-window" },
  );
});

test("a click on the capsule does not raise the main window behind it", () => {
  assert.deepEqual(
    decideWindowAction(WINDOW_LIFECYCLE_EVENTS.appActivate, { capsuleInteraction: true }),
    { action: WINDOW_LIFECYCLE_ACTIONS.none, reason: "capsule-interaction" },
  );
  // The suppression is scoped to the capsule's own activate. A Dock
  // click during a recording still opens the app.
  assert.equal(
    decideWindowAction(WINDOW_LIFECYCLE_EVENTS.trayOpen, { capsuleInteraction: true }).action,
    WINDOW_LIFECYCLE_ACTIONS.show,
  );
});

test("once quitting, nothing shows a window and nothing quits twice", () => {
  for (const event of Object.values(WINDOW_LIFECYCLE_EVENTS)) {
    assert.deepEqual(
      decideWindowAction(event, { quitting: true }),
      { action: WINDOW_LIFECYCLE_ACTIONS.none, reason: "already-quitting" },
      `${event} must be inert during shutdown`,
    );
  }
});

// ── Where the window goes ─────────────────────────────────────────────

const WORK_AREA = { x: 0, y: 25, width: 1728, height: 1085 };

test("the default is the whole work area", () => {
  assert.deepEqual(
    decideMainWindowBounds({ workArea: WORK_AREA, minWidth: 1140, minHeight: 700 }),
    { bounds: { ...WORK_AREA }, source: "work-area" },
  );
  // Anything that is not a usable saved rectangle means the same thing.
  for (const savedBounds of [null, undefined, {}, { x: 0, y: 0, width: 0, height: 5 }, "1420x780"]) {
    assert.equal(
      decideMainWindowBounds({ workArea: WORK_AREA, savedBounds }).source,
      "work-area",
    );
  }
});

test("bounds the user chose are restored, clamped back onto the screen", () => {
  assert.deepEqual(
    decideMainWindowBounds({
      workArea: WORK_AREA,
      savedBounds: { x: 200, y: 120, width: 1420, height: 780 },
      minWidth: 1140,
      minHeight: 700,
    }),
    { bounds: { x: 200, y: 120, width: 1420, height: 780 }, source: "saved" },
  );
  // Saved on a wide external display that is no longer attached: the
  // window still opens somewhere the user can reach it.
  const offscreen = decideMainWindowBounds({
    workArea: WORK_AREA,
    savedBounds: { x: 3000, y: 2000, width: 2400, height: 1400 },
    minWidth: 1140,
    minHeight: 700,
  });
  assert.equal(offscreen.source, "saved");
  assert.equal(offscreen.bounds.width, WORK_AREA.width);
  assert.equal(offscreen.bounds.height, WORK_AREA.height);
  assert.equal(offscreen.bounds.x, WORK_AREA.x);
  assert.equal(offscreen.bounds.y, WORK_AREA.y);
  // And a saved size below the layout's floor comes back at the floor.
  const tiny = decideMainWindowBounds({
    workArea: WORK_AREA,
    savedBounds: { x: 10, y: 40, width: 300, height: 200 },
    minWidth: 1140,
    minHeight: 700,
  });
  assert.equal(tiny.bounds.width, 1140);
  assert.equal(tiny.bounds.height, 700);
});

test("a work area is required — there is no invented fallback geometry", () => {
  assert.throws(() => decideMainWindowBounds({}), TypeError);
  assert.throws(
    () => decideMainWindowBounds({ workArea: { x: 0, y: 0, width: 0, height: 0 } }),
    TypeError,
  );
});

test("stored state is trusted only when it is complete", () => {
  assert.deepEqual(normalizeStoredWindowState(null), { userSized: false, bounds: null });
  assert.deepEqual(normalizeStoredWindowState("{}"), { userSized: false, bounds: null });
  // The flag alone is not enough, and neither is the rectangle alone.
  assert.deepEqual(normalizeStoredWindowState({ userSized: true }), { userSized: false, bounds: null });
  assert.deepEqual(
    normalizeStoredWindowState({ bounds: { x: 1, y: 2, width: 3, height: 4 } }),
    { userSized: false, bounds: null },
  );
  assert.deepEqual(
    normalizeStoredWindowState({ userSized: true, bounds: { x: 1.4, y: 2.6, width: 1420, height: 780 } }),
    { userSized: true, bounds: { x: 1, y: 3, width: 1420, height: 780 } },
  );
});

// ── What must not come back ───────────────────────────────────────────
//
// The mechanisms below were each added to fix the previous one's
// symptom, and together they flapped the window eight times in 200 ms at
// boot. These are source-level assertions because the failure they guard
// against is a future edit re-introducing one, not a runtime branch.

test("the app never leaves the Dock while it is running", () => {
  assert.ok(!/app\.dock\.hide/.test(MAIN_JS), "app.dock.hide() would drop the running indicator");
  assert.ok(
    !/setActivationPolicy\(\s*["'](accessory|prohibited)["']/.test(MAIN_JS),
    "accessory/prohibited activation policy hides the app from the Dock",
  );
  assert.match(MAIN_JS, /setActivationPolicy\(\s*["']regular["']\s*\)/);
  // One caller, at ready. The old code had a two-flag state machine that
  // re-asserted Dock presence from eight different places.
  assert.equal(
    (MAIN_JS.match(/setActivationPolicy\(/g) || []).length,
    1,
    "activation policy is set in exactly one place",
  );
});

test("nothing hides the app or the main window", () => {
  assert.ok(!/\bapp\.hide\(/.test(MAIN_JS), "app.hide() is not part of this app's lifecycle");
  assert.ok(!/\bapp\.show\(/.test(MAIN_JS), "app.show() only ever existed to undo app.hide()");
  assert.ok(!/\bwin\.hide\(/.test(MAIN_JS), "the main window is never hidden — closing it quits");
  // Call- and declaration-shaped, so the comment that quotes the old log
  // signature for posterity does not count as the mechanism coming back.
  assert.ok(
    !/(hideMainWindow|ensureWindowVisible|requestMainWindowReveal|markMainWindowExpectedHide|revealMainWindowWhenReady)\s*\(/
      .test(MAIN_JS),
    "the reveal/hide crutches are gone and must stay gone",
  );
  assert.ok(
    !/mainWindowRevealProtection|MAIN_WINDOW_REVEAL_PROTECTION_MS|MAIN_WINDOW_EXPECTED_HIDE_DWELL_MS/.test(MAIN_JS),
    "the reveal-protection and expected-hide dwells are gone",
  );
});

test("only the recording capsule spans workspaces, and it never activates the app", () => {
  // Every span goes through ./floating-window, which never transforms the
  // process: a bare setVisibleOnAllWorkspaces(…visibleOnFullScreen…) turns
  // the app into a Dock-less UIElement (the missing running indicator).
  assert.ok(!/setVisibleOnAllWorkspaces\(/.test(MAIN_JS), "span windows only through spanAllWorkspaces()");
  const spans = MAIN_JS.match(/^.*spanAllWorkspaces\(.*$/gm) || [];
  assert.equal(spans.length, 1, "exactly one window may span workspaces");
  assert.match(spans[0], /recordingStatusWindow/, "only the capsule, never the main window");
  // The capsule is a panel: not focusable, shown without activating.
  assert.match(MAIN_JS, /focusable:\s*false/);
  assert.match(MAIN_JS, /capsuleWindow\.showInactive\(\)/);
  assert.ok(
    !/\bapp\.focus\([^)]*\)[\s\S]{0,200}?showInactive/.test(MAIN_JS),
    "the capsule must not bring the app forward",
  );
});

test("window-all-closed quits on every platform", () => {
  const handler = MAIN_JS.match(/app\.on\("window-all-closed",[\s\S]*?\n\}\);/);
  assert.ok(handler, "window-all-closed handler not found");
  assert.ok(
    !/process\.platform/.test(handler[0]),
    "quitting on close must not be conditional on the platform",
  );
  assert.match(handler[0], /WINDOW_LIFECYCLE_EVENTS\.allWindowsClosed/);
});

test("the window is bundled as a normal app, not a background agent", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
  const raw = JSON.stringify(pkg);
  assert.ok(!/LSUIElement/.test(raw), "LSUIElement must not appear in the build config");
  for (const target of ["mac", "mas"]) {
    const info = pkg.build?.[target]?.extendInfo || {};
    assert.equal(info.LSUIElement, undefined, `${target}.extendInfo must not set LSUIElement`);
  }
});

test("every lifecycle event main.js reports is one the table knows", () => {
  const used = new Set(
    [...MAIN_JS.matchAll(/WINDOW_LIFECYCLE_EVENTS\.([A-Za-z]+)/g)].map((m) => m[1]),
  );
  assert.ok(used.size > 0, "main.js must drive the lifecycle through the module");
  for (const key of used) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(WINDOW_LIFECYCLE_EVENTS, key),
      `main.js reports an event the table does not define: ${key}`,
    );
  }
  // And every event the table defines has a caller — a decision nothing
  // can reach is a decision nobody maintains.
  for (const key of Object.keys(WINDOW_LIFECYCLE_EVENTS)) {
    assert.ok(used.has(key), `no caller reports ${key}`);
  }
});

// ── DM-30: closing with work in flight asks first (user decision 2026-11-20) ──
{
  const {
    CLOSE_REQUEST_ACTIONS,
    CLOSE_CONFIRM_BUTTONS,
    CLOSE_CONFIRM_QUIT_INDEX,
    decideCloseRequest,
  } = require("./window-lifecycle");

  test("nothing in flight: close is quit (rule 4)", () => {
    assert.equal(decideCloseRequest({}).action, CLOSE_REQUEST_ACTIONS.quit);
    assert.equal(decideCloseRequest({ recording: false, postStopWork: false }).action, CLOSE_REQUEST_ACTIONS.quit);
  });

  test("a running recording asks first", () => {
    const d = decideCloseRequest({ recording: true });
    assert.equal(d.action, CLOSE_REQUEST_ACTIONS.confirm);
    assert.equal(d.reason, "recording");
    assert.ok(d.message && d.detail);
  });

  test("a transcript still being prepared or pasted asks first", () => {
    const d = decideCloseRequest({ postStopWork: true });
    assert.equal(d.action, CLOSE_REQUEST_ACTIONS.confirm);
    assert.equal(d.reason, "post-stop-work");
  });

  test("only an explicit true counts: an unanswered renderer never traps the user", () => {
    assert.equal(decideCloseRequest({ recording: undefined }).action, CLOSE_REQUEST_ACTIONS.quit);
    assert.equal(decideCloseRequest({ recording: "yes" }).action, CLOSE_REQUEST_ACTIONS.quit);
  });

  test("the dialog's safe answer is the default; Quit is the named index", () => {
    assert.equal(CLOSE_CONFIRM_BUTTONS[0], "Keep Running");
    assert.equal(CLOSE_CONFIRM_BUTTONS[CLOSE_CONFIRM_QUIT_INDEX], "Quit");
  });

  test("main holds the close and resolves it through decideCloseRequest (wiring)", () => {
    const { topLevelFunctionSource } = require("./main-source");
    const fn = topLevelFunctionSource("resolveMainWindowClose");
    assert.ok(fn, "resolveMainWindowClose not found");
    assert.match(fn, /decideCloseRequest\(/);
  });
}

test("a hide while the window is still visible is occlusion, not a hide", () => {
  const { classifyMainWindowHide } = require("./window-lifecycle");
  assert.equal(classifyMainWindowHide({ visible: true }), "occluded");
  assert.equal(classifyMainWindowHide({ visible: false }), "hidden");
  assert.match(MAIN_JS, /event=occluded/);
});
