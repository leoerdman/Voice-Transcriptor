"use strict";

// Screen mode's Electron half (desktop/screen-mode-controller.js), driven
// through its injected seams: fake BrowserWindow / screen / child process,
// the real filesystem in a temp dir, and `captureRegion` in place of
// screencapture. The overlay page the controller ships (`overlayHtml`) is
// run for real in a `vm` context with a recording canvas, so what a shot
// paints and what stays on the screen is the page's own behaviour.

const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const { SCREEN_START_OUTCOME, createScreenModeController } = require("./screen-mode-controller");
const { screenModeWarningCopy } = require("./screen-mode-warnings");

const PNG = "data:image/png;base64,";
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// ── a DOM just large enough for the overlay and palette pages ──────────
function recordingContext2d() {
  const calls = [];
  const ctx = { calls };
  for (const name of ["save", "restore", "beginPath", "moveTo", "lineTo", "quadraticCurveTo", "arc", "fill", "stroke", "clearRect", "setTransform", "drawImage"]) {
    ctx[name] = (...args) => { calls.push([name, ...args.filter((a) => typeof a === "number")]); };
  }
  return ctx;
}

function fakeCanvas() {
  const ctx = recordingContext2d();
  return {
    width: 0,
    height: 0,
    ctx,
    getContext: () => ctx,
    // The "PNG" a composite produces: the draw calls, so a test can read
    // which strokes were painted into a screenshot.
    toDataURL: () => `${PNG}${Buffer.from(JSON.stringify(ctx.calls)).toString("base64")}`,
  };
}

function pageContext(html, { width, height, hit }) {
  const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || "";
  const screenCanvas = fakeCanvas();
  const animations = [];
  const element = (id) => ({
    id,
    style: {},
    addEventListener() { },
    classList: { toggle() { } },
    animate(keyframes, options) {
      const animation = { id, keyframes, options, cancelled: false, cancel() { this.cancelled = true; } };
      animations.push(animation);
      return animation;
    },
  });
  const elements = new Map();
  const context = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: 1,
    addEventListener() { },
    requestAnimationFrame: (fn) => fn(),
    document: {
      title: "",
      getElementById: (id) => {
        if (id === "cv") return screenCanvas;
        if (!elements.has(id)) elements.set(id, element(id));
        return elements.get(id);
      },
      createElement: () => fakeCanvas(),
      querySelectorAll: () => [],
      elementFromPoint: (x, y) => hit(x, y),
    },
    Image: class {
      set src(url) {
        this.naturalWidth = width * 2;
        this.naturalHeight = height * 2;
        this.url = url;
        setImmediate(() => this.onload());
      }
    },
    MouseEvent: class { constructor(type, init) { Object.assign(this, init, { type }); } },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(script, context);
  return { context, screenCanvas, animations };
}

// ── Electron fakes ─────────────────────────────────────────────────────
function createWorld({ displays, helperReady = true, failLoad = () => false, hit = () => null, loadGate = () => null } = {}) {
  const world = {
    displays: displays || [{ id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 }, workArea: { x: 0, y: 25, width: 1000, height: 775 } }],
    windows: [],
    children: [],
    logs: [],
    warnings: [],
    active: [],
    captures: [],
    captureGate: null,
    capsuleShows: [],
  };

  class FakeWindow {
    constructor(opts) {
      this.opts = opts;
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      this.destroyed = false;
      this.visible = false;
      this.page = null;
      const self = this;
      this.webContents = Object.assign(new EventEmitter(), {
        scripts: [],
        executeJavaScript(js) {
          this.scripts.push(js);
          if (!self.page) return Promise.reject(new Error("no page"));
          try {
            return Promise.resolve(vm.runInContext(js, self.page.context));
          } catch (e) {
            return Promise.reject(e);
          }
        },
      });
      world.windows.push(this);
    }

    setIgnoreMouseEvents() { if (world.throwOn === "setIgnoreMouseEvents") throw new Error("refused"); }
    setContentProtection() { if (world.throwOn === "setContentProtection") throw new Error("refused"); }
    setAlwaysOnTop() { }
    setVisibleOnAllWorkspaces() { }
    async loadURL(url) {
      await tick();
      const gate = loadGate(this);
      if (gate) await gate;
      if (failLoad(this)) throw new Error("loadURL failed");
      const html = decodeURIComponent(url.slice(url.indexOf(",") + 1));
      this.page = pageContext(html, { width: this.bounds.width, height: this.bounds.height, hit });
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    setBounds(b) { this.bounds = { ...b }; }
    getBounds() { return { ...this.bounds }; }
    showInactive() { this.visible = true; }
    isVisible() { return this.visible && !this.destroyed; }
  }

  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => world.displays.slice(),
    getCursorScreenPoint: () => ({ x: 10, y: 10 }),
    getDisplayNearestPoint: (p) => world.displays.find((d) => (
      p.x >= d.bounds.x && p.x < d.bounds.x + d.bounds.width && p.y >= d.bounds.y && p.y < d.bounds.y + d.bounds.height
    )) || world.displays[0],
  });

  const childProcess = {
    spawn() {
      const child = new EventEmitter();
      child.stdin = { written: [], destroyed: false, write(s) { this.written.push(s); }, end() { this.destroyed = true; } };
      child.stdout = Object.assign(new EventEmitter(), { setEncoding() { } });
      child.stderr = Object.assign(new EventEmitter(), { setEncoding() { } });
      child.exitCode = null;
      child.kill = () => { child.exitCode = -1; };
      world.children.push(child);
      if (helperReady === true) setImmediate(() => child.stdout.emit("data", '{"t":"ready"}\n'));
      else if (typeof helperReady === "function") setImmediate(() => helperReady(child));
      return child;
    },
  };

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "screen-mode-controller-test-"));
  world.staging = staging;
  world.capsule = null;

  world.controller = createScreenModeController({
    BrowserWindow: FakeWindow,
    screen,
    childProcess,
    fs,
    path,
    platform: "darwin",
    // A file that exists, so isSupported() is true — unless a test says not.
    helperPath: () => (world.helperMissing ? path.join(staging, "no-such-helper") : process.execPath),
    stagingRoot: () => {
      if (world.stagingFails) throw new Error("no data directory");
      return staging;
    },
    log: (line) => world.logs.push(line),
    capsuleWindow: () => world.capsule,
    capsuleLayout: { bottomMargin: 16, height: 30 },
    onActiveChange: (active) => world.active.push(active),
    onWarning: (kind) => world.warnings.push(kind),
    prepareCapsule: () => (world.prepareCapsule ? world.prepareCapsule() : Promise.resolve(false)),
    showCapsule: () => {
      // What else is on screen at the instant the capsule is shown.
      world.capsuleShows.push({ overlays: world.visibleOverlays(), palette: !!world.palette()?.isVisible() });
    },
    screenCaptureAccess: () => world.captureAccess || "granted",
    captureRegion: async (bounds, outFile) => {
      world.captures.push({ bounds, outFile });
      if (world.captureGate) await world.captureGate;
      if (world.captureFails && world.captureFails(bounds)) throw new Error("display asleep");
      fs.writeFileSync(outFile, "raw-capture");
    },
  });
  world.screen = screen;
  world.helper = () => world.children[world.children.length - 1];
  world.say = (obj) => world.helper().stdout.emit("data", `${JSON.stringify(obj)}\n`);
  world.overlays = () => world.windows.filter((w) => w.opts.title === "Transcriptor Screen Mode" && !w.destroyed);
  world.palette = () => world.windows.find((w) => w.opts.title === "Transcriptor Screen Colors" && !w.destroyed) || null;
  world.visibleOverlays = () => world.overlays().filter((w) => w.isVisible()).length;
  world.cleanup = () => {
    world.controller.teardown();
    fs.rmSync(staging, { recursive: true, force: true });
    // D1: every warning any test made the controller raise is one main
    // has copy for — a kind without copy reaches the log and nobody else.
    for (const kind of world.warnings) {
      assert.ok(screenModeWarningCopy(kind), `the controller raised "${kind}", which has no copy for the user`);
    }
  };
  return world;
}

function drawStroke(world, points) {
  const [first, ...rest] = points;
  world.say({ t: "start", x: first[0], y: first[1] });
  for (const p of rest.slice(0, -1)) world.say({ t: "move", x: p[0], y: p[1] });
  const last = rest[rest.length - 1] || first;
  world.say({ t: "end", x: last[0], y: last[1] });
}

function paintedMoveTos(file) {
  return JSON.parse(fs.readFileSync(file, "utf8")).filter((c) => c[0] === "moveTo");
}

const ID = "screen-20261120-100000-000";

// ── DX-01 ──────────────────────────────────────────────────────────────
test("a stroke that finishes while a shot is captured is not in that shot and stays on the screen", async () => {
  const world = createWorld();
  try {
    assert.equal((await world.controller.start(ID)).ok, true);
    drawStroke(world, [[100, 100], [150, 100], [200, 100]]); // stroke 1, finished
    world.say({ t: "start", x: 300, y: 300 }); // stroke 2, still being drawn
    world.say({ t: "move", x: 340, y: 300 });
    let release;
    world.captureGate = new Promise((resolve) => { release = resolve; });
    const shot = world.controller.takeShot("hotkey");
    await tick(5);
    // During the capture: stroke 2 finishes, stroke 3 begins.
    world.say({ t: "end", x: 380, y: 300 });
    world.say({ t: "start", x: 500, y: 500 });
    world.say({ t: "move", x: 540, y: 500 });
    await tick(30); // the 16 ms op flush
    release();
    const result = await shot;
    assert.equal(result.index, 1);

    const manifest = (await world.controller.finish({ id: ID, discard: false })).manifest;
    const shotEvents = manifest.events.filter((e) => e.type === "shot");
    // Shot 1 holds stroke 1 only; stroke 2 was taken by the stop's shot.
    assert.equal(shotEvents[0].strokes, 1);
    assert.deepEqual(manifest.events.filter((e) => e.type === "stroke").map((e) => e.shot).sort(), [1, 2]);
    // The image of shot 1 has exactly one stroke painted into it.
    assert.equal(paintedMoveTos(shotEvents[0].files[0]).length, 1);
  } finally {
    world.cleanup();
  }
});

test("a shot leaves a stroke still being drawn on the screen, with what it has drawn", async () => {
  const world = createWorld();
  try {
    await world.controller.start(ID);
    drawStroke(world, [[100, 100], [200, 100]]);
    world.say({ t: "start", x: 300, y: 300 });
    world.say({ t: "move", x: 360, y: 300 });
    await tick(30);
    await world.controller.takeShot("capsule");
    await tick(5);
    const overlay = world.overlays()[0];
    assert.equal(await overlay.webContents.executeJavaScript("window.__hasStrokes([1])"), false);
    assert.equal(await overlay.webContents.executeJavaScript("window.__hasStrokes([2])"), true);
  } finally {
    world.cleanup();
  }
});

// The user, 2026-11-20 (after trying the reverse): "first the screenshot,
// then clear the drawings off the screen".
test("a shot is captured with its strokes still on the screen; they leave the moment it is taken", async () => {
  const world = createWorld();
  try {
    await world.controller.start(ID);
    drawStroke(world, [[100, 100], [150, 100], [200, 100]]);
    await tick(30);
    const overlay = world.overlays()[0];
    let release;
    world.captureGate = new Promise((resolve) => { release = resolve; });
    const shot = world.controller.takeShot("capsule");
    await tick(5);
    assert.equal(world.captures.length, 1, "the capture is under way");
    assert.equal(await overlay.webContents.executeJavaScript("window.__hasStrokes([1])"), true, "still on the screen while the capture runs");
    release();
    const result = await shot;
    assert.equal(await overlay.webContents.executeJavaScript("window.__hasStrokes([1])"), false, "gone once it is taken");
    assert.equal(paintedMoveTos(result.files[0]).length, 1, "the image holds the stroke");
    assert.ok(world.logs.some((l) => /shot captured \(capsule\) displays=1 capture_ms=\d+ strokes_off=1 compose_ms=\d+/.test(l)));
  } finally {
    world.cleanup();
  }
});

test("every shot plays the white flash, from visible to gone, however quickly shots follow", async () => {
  const world = createWorld();
  try {
    await world.controller.start(ID);
    const flashes = () => world.overlays()[0].page.animations.filter((a) => a.id === "flash");
    for (let i = 0; i < 3; i += 1) {
      drawStroke(world, [[100 + i * 10, 100], [200, 100]]);
      await tick(30);
      await world.controller.takeShot("hotkey");
    }
    assert.equal(flashes().length, 3, "one flash per shot");
    for (const flash of flashes()) {
      // Both ends are in the one animation: it cannot start from 0.
      assert.ok(flash.keyframes[0].opacity > 0, "it starts visible");
      assert.equal(flash.keyframes[flash.keyframes.length - 1].opacity, 0, "and ends gone");
      assert.ok(flash.options.duration >= 250);
    }
    assert.ok(flashes().slice(0, -1).every((f) => f.cancelled), "a flash still running is restarted, not stacked");
  } finally {
    world.cleanup();
  }
});

test("a failed capture puts its strokes back on the screen", async () => {
  const world = createWorld();
  try {
    await world.controller.start(ID);
    drawStroke(world, [[100, 100], [200, 100]]);
    await tick(30);
    world.captureFails = () => true;
    assert.equal(await world.controller.takeShot("hotkey"), null);
    await tick(5);
    const overlay = world.overlays()[0];
    assert.equal(await overlay.webContents.executeJavaScript("window.__hasStrokes([1])"), true);
  } finally {
    world.cleanup();
  }
});

// ── DX-04 ──────────────────────────────────────────────────────────────
test("unplugging a display does not move the strokes already drawn on it", async () => {
  const external = { id: 2, bounds: { x: 1000, y: 0, width: 1000, height: 1000 }, workArea: { x: 1000, y: 0, width: 1000, height: 1000 } };
  const world = createWorld({
    displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 }, workArea: { x: 0, y: 25, width: 1000, height: 775 } }, external],
  });
  try {
    await world.controller.start(ID);
    drawStroke(world, [[1100, 100], [1300, 100]]);
    await world.controller.takeShot("hotkey");
    world.displays = world.displays.filter((d) => d.id !== 2);
    world.screen.emit("display-removed", {}, external);
    await world.controller.takeShot("hotkey");
    const manifest = (await world.controller.finish({ id: ID })).manifest;
    const stroke = manifest.events.find((e) => e.type === "stroke");
    assert.deepEqual([stroke.xPct, stroke.yPct], [20, 10]);
  } finally {
    world.cleanup();
  }
});

// ── S-02 / DX-03 / DX-02 ───────────────────────────────────────────────
test("a stop that reaches the controller before its start wins: the late start is refused", async () => {
  const world = createWorld();
  try {
    const stopped = await world.controller.finish({ id: ID, discard: false });
    assert.equal(stopped.ok, false);
    const started = await world.controller.start(ID);
    // D3: a distinct outcome, not a failure — and nobody is warned.
    assert.deepEqual(started, { ok: false, outcome: SCREEN_START_OUTCOME.ENDED });
    assert.deepEqual(world.warnings, [], "a quick stop is not a failed start");
    assert.equal(world.children.length, 0, "no mouse helper for a take that ended");
    assert.equal(world.overlays().length, 0);
    assert.deepEqual(world.active, []);
    assert.equal(world.controller.isActive(), false);
  } finally {
    world.cleanup();
  }
});

test("a new take while an old session is still up closes the old one and starts the new id", async () => {
  const world = createWorld();
  const NEXT = "screen-20261120-100500-000";
  try {
    await world.controller.start(ID);
    drawStroke(world, [[100, 100], [200, 100]]);
    const started = await world.controller.start(NEXT);
    assert.deepEqual(started, { ok: true, outcome: SCREEN_START_OUTCOME.STARTED, id: NEXT });
    // The old take's screenshots stay staged with its finished manifest.
    const old = JSON.parse(fs.readFileSync(path.join(world.staging, ID, "events.json"), "utf8"));
    assert.ok(old.endedAt > 0);
    assert.equal(old.events.filter((e) => e.type === "shot").length, 1);
    // The new id is the live one: its stop gets its manifest back.
    const finished = await world.controller.finish({ id: NEXT });
    assert.equal(finished.ok, true);
    assert.equal(finished.manifest.id, NEXT);
    assert.equal(world.overlays().length, 0);
    assert.deepEqual(world.active, [true, false, true, false]);
  } finally {
    world.cleanup();
  }
});

// ── DX-08 / S-04 / H-08 / DX-18 ────────────────────────────────────────
test("a helper without Accessibility fails the start: not ok, warned, nothing left on screen", async () => {
  const world = createWorld({
    helperReady: (child) => {
      child.stdout.emit("data", '{"t":"error","code":"tap-unavailable"}\n');
      child.emit("exit", 2, null);
    },
  });
  try {
    const started = await world.controller.start(ID);
    assert.equal(started.ok, false);
    assert.deepEqual(world.warnings, ["accessibility"]);
    assert.equal(world.overlays().length, 0);
    assert.equal(world.palette(), null);
    assert.deepEqual(world.active, [], "main is never told the take is on");
    assert.equal(world.controller.isActive(), false);
    assert.equal(fs.existsSync(path.join(world.staging, ID)), false, "no empty session folder left behind");
  } finally {
    world.cleanup();
  }
});

test("a helper that cannot be spawned fails the start", async () => {
  const world = createWorld({ helperReady: (child) => child.emit("error", new Error("spawn ENOENT")) });
  try {
    const started = await world.controller.start(ID);
    assert.equal(started.ok, false);
    assert.match(started.error, /ENOENT/);
    assert.deepEqual(world.warnings, ["start-failed"]);
    assert.equal(world.controller.isActive(), false);
  } finally {
    world.cleanup();
  }
});

// ── surfaces at once (coordinator requirement, 2026-11-20 12:28:06 log) ──
test("the capsule, the palette and the frames appear in one step, and not before the slowest is ready", async () => {
  const second = { id: 2, bounds: { x: 1000, y: 0, width: 800, height: 600 }, workArea: { x: 1000, y: 0, width: 800, height: 600 } };
  let capsuleReady;
  let paletteLoaded;
  const paletteGate = new Promise((resolve) => { paletteLoaded = resolve; });
  const world = createWorld({
    displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 }, workArea: { x: 0, y: 25, width: 1000, height: 775 } }, second],
    // The palette page is the slow one.
    loadGate: (w) => (w.opts.title === "Transcriptor Screen Colors" ? paletteGate : null),
  });
  world.prepareCapsule = () => new Promise((resolve) => { capsuleReady = resolve; });
  try {
    const starting = world.controller.start(ID);
    await tick(10);
    capsuleReady(true);
    await tick(10);
    // Frames and capsule ready, palette still loading: nothing is shown.
    assert.equal(world.visibleOverlays(), 0, "a frame was shown before the palette was ready");
    assert.deepEqual(world.capsuleShows, []);
    assert.deepEqual(world.active, []);
    paletteLoaded();
    const started = await starting;
    assert.equal(started.outcome, SCREEN_START_OUTCOME.STARTED);
    // One step: main told, then capsule, frames, palette — no gap between.
    assert.deepEqual(world.active, [true]);
    assert.equal(world.capsuleShows.length, 1);
    assert.deepEqual(world.capsuleShows[0], { overlays: 0, palette: false }, "the capsule is the first of the three, in the same step");
    assert.equal(world.visibleOverlays(), 2);
    assert.equal(world.palette().isVisible(), true);
    assert.ok(world.logs.some((l) => /surfaces visible press_to_visible_ms=\d+ capsule=1 overlays=2 palette=1/.test(l)));
  } finally {
    world.cleanup();
  }
});

test("the surfaces do not wait for the mouse helper; the start answers when it is ready", async () => {
  let ready;
  const world = createWorld({ helperReady: (child) => { ready = () => child.stdout.emit("data", '{"t":"ready"}\n'); } });
  world.prepareCapsule = () => Promise.resolve(true);
  try {
    let answered = false;
    const starting = world.controller.start(ID).then((r) => { answered = true; return r; });
    await tick(20);
    assert.equal(world.visibleOverlays(), 1, "the frame waited for the helper");
    assert.equal(world.palette().isVisible(), true);
    assert.equal(world.capsuleShows.length, 1);
    assert.equal(answered, false, "the start answered before the helper could draw");
    ready();
    assert.equal((await starting).outcome, SCREEN_START_OUTCOME.STARTED);
  } finally {
    world.cleanup();
  }
});

test("a capsule that cannot be prepared hidden is left out; the frame and palette still show together", async () => {
  const world = createWorld();
  world.prepareCapsule = () => Promise.resolve(false);
  try {
    const started = await world.controller.start(ID);
    assert.equal(started.outcome, SCREEN_START_OUTCOME.STARTED);
    assert.deepEqual(world.capsuleShows, [], "main shows that capsule its own way");
    assert.equal(world.visibleOverlays(), 1);
    assert.equal(world.palette().isVisible(), true);
  } finally {
    world.cleanup();
  }
});

test("a helper that fails before the surfaces are ready shows nothing at all", async () => {
  const world = createWorld({
    helperReady: (child) => child.emit("exit", 2, null),
    loadGate: () => tick(20),
  });
  world.prepareCapsule = () => Promise.resolve(true);
  try {
    const started = await world.controller.start(ID);
    assert.equal(started.outcome, SCREEN_START_OUTCOME.FAILED);
    assert.deepEqual(world.capsuleShows, []);
    assert.deepEqual(world.active, []);
    await tick(40);
    assert.equal(world.windows.filter((w) => w.isVisible()).length, 0, "a window appeared after the failed start");
  } finally {
    world.cleanup();
  }
});

// D2: the controller is the one owner of the failed-start notification,
// so EVERY failed start warns — and no start rejects, so main has nothing
// to report on its own.
test("a start on a machine without the helper fails, warned, instead of answering silently", async () => {
  const world = createWorld();
  world.helperMissing = true;
  try {
    const started = await world.controller.start(ID);
    assert.equal(started.ok, false);
    assert.equal(started.outcome, SCREEN_START_OUTCOME.FAILED);
    assert.deepEqual(world.warnings, ["start-failed"]);
    assert.equal(world.children.length, 0);
  } finally {
    world.cleanup();
  }
});

test("a start that throws on the way resolves FAILED and warns, it never rejects", async () => {
  const world = createWorld();
  world.stagingFails = true;
  try {
    const started = await world.controller.start(ID);
    assert.equal(started.outcome, SCREEN_START_OUTCOME.FAILED);
    assert.match(started.error, /no data directory/);
    assert.deepEqual(world.warnings, ["start-failed"]);
    assert.equal(world.controller.isActive(), false);
  } finally {
    world.cleanup();
  }
});

test("no overlay that can be shown fails the start", async () => {
  const world = createWorld({ failLoad: (w) => w.opts.title === "Transcriptor Screen Mode" });
  try {
    const started = await world.controller.start(ID);
    assert.equal(started.ok, false);
    assert.deepEqual(world.warnings, ["start-failed"]);
    assert.equal(world.children[0].stdin.destroyed, true, "the helper is stopped");
    assert.deepEqual(world.active, []);
  } finally {
    world.cleanup();
  }
});

test("an overlay that would take the mouse is never shown", async () => {
  const world = createWorld();
  world.throwOn = "setIgnoreMouseEvents";
  try {
    const started = await world.controller.start(ID);
    assert.equal(started.ok, false);
    assert.equal(world.windows.some((w) => w.visible), false);
  } finally {
    world.cleanup();
  }
});

test("one display's overlay failing, or the palette failing, still starts the take", async () => {
  const second = { id: 2, bounds: { x: 1000, y: 0, width: 800, height: 600 }, workArea: { x: 1000, y: 0, width: 800, height: 600 } };
  const world = createWorld({
    displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 }, workArea: { x: 0, y: 25, width: 1000, height: 775 } }, second],
    failLoad: (w) => w.opts.x === 1000 || w.opts.title === "Transcriptor Screen Colors",
  });
  try {
    const started = await world.controller.start(ID);
    assert.deepEqual(started, { ok: true, outcome: SCREEN_START_OUTCOME.STARTED, id: ID });
    assert.equal(world.overlays().length, 1);
    assert.deepEqual(world.active, [true]);
  } finally {
    world.cleanup();
  }
});

test("a helper that dies mid-take is reported", async () => {
  const world = createWorld();
  try {
    await world.controller.start(ID);
    world.helper().emit("exit", null, "SIGSEGV");
    assert.deepEqual(world.warnings, ["helper"]);
  } finally {
    world.cleanup();
  }
});

// ── DX-06 / S-03 ───────────────────────────────────────────────────────
test("a capture that fails claims no screenshot and keeps the strokes for the next one", async () => {
  const world = createWorld();
  try {
    await world.controller.start(ID);
    drawStroke(world, [[100, 100], [200, 100]]);
    world.captureFails = () => true;
    assert.equal(await world.controller.takeShot("hotkey"), null);
    assert.deepEqual(world.warnings, ["capture-failed"]);
    assert.deepEqual(fs.readdirSync(path.join(world.staging, ID)).filter((f) => f.endsWith(".png")), []);
    world.captureFails = null;
    const shot = await world.controller.takeShot("hotkey");
    assert.equal(shot.index, 1);
    const manifest = (await world.controller.finish({ id: ID })).manifest;
    const shotEvent = manifest.events.find((e) => e.type === "shot");
    assert.equal(shotEvent.strokes, 1);
    assert.equal(fs.existsSync(shotEvent.files[0]), true);
  } finally {
    world.cleanup();
  }
});

test("a stroke on a display that is gone is not stamped into a shot of the others", async () => {
  const external = { id: 2, bounds: { x: 1000, y: 0, width: 1000, height: 1000 }, workArea: { x: 1000, y: 0, width: 1000, height: 1000 } };
  const world = createWorld({
    displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 }, workArea: { x: 0, y: 25, width: 1000, height: 775 } }, external],
  });
  try {
    await world.controller.start(ID);
    drawStroke(world, [[100, 100], [200, 100]]); // display 1
    drawStroke(world, [[1100, 100], [1200, 100]]); // display 2
    world.displays = world.displays.filter((d) => d.id !== 2);
    world.screen.emit("display-removed", {}, external);
    const shot = await world.controller.takeShot("capsule");
    assert.equal(shot.files.length, 1);
    const manifest = (await world.controller.finish({ id: ID })).manifest;
    const shotEvent = manifest.events.find((e) => e.type === "shot");
    assert.equal(shotEvent.strokes, 1);
    assert.deepEqual(world.warnings.filter((w) => w === "capture-failed").length >= 1, true);
  } finally {
    world.cleanup();
  }
});

test("Screen Recording that is not granted yet is warned about at start", async () => {
  const world = createWorld();
  world.captureAccess = "not-determined";
  try {
    assert.equal((await world.controller.start(ID)).ok, true);
    assert.deepEqual(world.warnings, ["screen-recording"]);
  } finally {
    world.cleanup();
  }
});

// ── DX-13 ──────────────────────────────────────────────────────────────
test("a tap on a palette dot selects its colour without a title channel", async () => {
  const { SCREEN_MODE } = require("./screen-mode");
  const picked = SCREEN_MODE.colors[2];
  const world = createWorld({ hit: () => ({ closest: (sel) => (sel === ".dot" ? { dataset: { c: picked } } : null) }) });
  try {
    await world.controller.start(ID);
    const palette = world.palette();
    assert.equal(palette.webContents.listenerCount("page-title-updated"), 0, "no document.title IPC");
    const b = palette.getBounds();
    world.say({ t: "tap", x: b.x + b.width / 2, y: b.y + b.height / 2 });
    await tick(5);
    drawStroke(world, [[100, 100], [200, 100]]);
    await world.controller.takeShot("hotkey");
    const manifest = (await world.controller.finish({ id: ID })).manifest;
    assert.equal(manifest.events.find((e) => e.type === "stroke").color, picked);
  } finally {
    world.cleanup();
  }
});

// ── DX-10: the helper's documented protocol, line by line ──────────────
test("every stdout line main.swift documents is understood by the controller", async () => {
  const swift = fs.readFileSync(path.join(__dirname, "native", "screen-input", "main.swift"), "utf8");
  const header = swift.slice(0, swift.indexOf("import "));
  const documented = [...new Set([...header.matchAll(/\{"t":"([a-z-]+)"/g)].map((m) => m[1]))].sort();
  const samples = {
    ready: { line: { t: "ready" }, seen: (w) => w.logs.some((l) => l.includes("mouse helper ready")) },
    start: { line: { t: "start", x: 100, y: 100 }, seen: () => true },
    move: { line: { t: "move", x: 150, y: 100 }, seen: () => true },
    end: { line: { t: "end", x: 200, y: 100 }, seen: () => true },
    tap: { line: { t: "tap", x: 5, y: 5 }, seen: (w) => w.capsule.webContents.scripts.length === 1 },
    press: { line: { t: "press", outcome: "stroke", clicks: 1, drags: 9 }, seen: (w) => w.logs.some((l) => l.includes("press outcome=stroke clicks=1 drags=9")) },
    "tap-disabled": { line: { t: "tap-disabled", reason: "timeout", abandoned: "stroke" }, seen: (w) => w.logs.some((l) => l.includes("tap disabled reason=timeout abandoned=stroke")) },
    error: { line: { t: "error", code: "tap-unavailable" }, seen: (w) => w.logs.some((l) => l.includes("helper error tap-unavailable")) },
  };
  assert.deepEqual(documented, Object.keys(samples).sort());

  const world = createWorld();
  world.capsule = {
    isDestroyed: () => false,
    isVisible: () => true,
    getBounds: () => ({ x: 0, y: 0, width: 50, height: 20 }),
    webContents: { scripts: [], executeJavaScript(js) { this.scripts.push(js); return Promise.resolve(true); } },
  };
  try {
    await world.controller.start(ID);
    for (const kind of ["ready", "start", "move", "end", "tap", "press", "tap-disabled", "error"]) {
      world.say(samples[kind].line);
      assert.ok(samples[kind].seen(world), `line ${kind} had no effect`);
    }
    await world.controller.takeShot("hotkey");
    const manifest = (await world.controller.finish({ id: ID })).manifest;
    assert.equal(manifest.events.filter((e) => e.type === "stroke").length, 1, "start/move/end drew one stroke");
  } finally {
    world.cleanup();
  }
});

// DX-12: the palette's place without a capsule on screen follows main's
// capsule geometry (injected), not a literal 54.
test("the palette sits above where the capsule is, or would be, from the injected capsule layout", () => {
  const { paletteBoundsFor } = require("./screen-mode-controller");
  const size = { width: 100, height: 30 };
  const workArea = { x: 0, y: 0, width: 1000, height: 800 };
  // Today's capsule: bottom margin 16, height 30, palette margin 8 → 800 - 30 - 54.
  assert.deepEqual(
    paletteBoundsFor({ capsule: null, workArea, size, capsuleLayout: { bottomMargin: 16, height: 30 } }),
    { x: 450, y: 716, width: 100, height: 30 },
  );
  // A taller capsule moves the palette with it (the literal did not).
  assert.equal(
    paletteBoundsFor({ capsule: null, workArea, size, capsuleLayout: { bottomMargin: 16, height: 40 } }).y,
    706,
  );
  // On screen, the capsule's real bounds win.
  assert.deepEqual(
    paletteBoundsFor({ capsule: { x: 400, y: 754, width: 200, height: 30 }, workArea, size, capsuleLayout: null }),
    { x: 450, y: 716, width: 100, height: 30 },
  );
});

test("the overlay, palette and capsule layers are one ordered fact", () => {
  const { SCREEN_MODE_LAYERS } = require("./screen-mode-controller");
  assert.ok(SCREEN_MODE_LAYERS.overlay < SCREEN_MODE_LAYERS.palette);
  assert.ok(SCREEN_MODE_LAYERS.palette < SCREEN_MODE_LAYERS.capsule);
});
