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

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// ── a DOM just large enough for the overlay and palette pages ──────────
function recordingContext2d() {
  const calls = [];
  const ctx = { calls };
  for (const name of ["save", "restore", "beginPath", "moveTo", "lineTo", "quadraticCurveTo", "arc", "fill", "stroke", "clearRect", "setTransform", "drawImage", "closePath"]) {
    ctx[name] = (...args) => { calls.push([name, ...args.filter((a) => typeof a === "number")]); };
  }
  // The number beside a stroke: its text, where, and in what colour.
  ctx.fillText = (text, x, y) => { calls.push(["fillText", String(text), x, y, ctx.fillStyle]); };
  return ctx;
}

function fakeCanvas() {
  const ctx = recordingContext2d();
  return {
    width: 0,
    height: 0,
    ctx,
    getContext: () => ctx,
    // The "PNG" (or JPEG) a render produces: the draw calls, so a test can
    // read which strokes were painted into a screenshot, and its size.
    toDataURL(type = "image/png") {
      const body = { w: this.width, h: this.height, calls: ctx.calls };
      return `data:${type};base64,${Buffer.from(JSON.stringify(body)).toString("base64")}`;
    },
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
    // A capture's size is in the fake file the capture wrote (the region
    // at 2x); anything else is the whole window at 2x.
    Image: class {
      set src(url) {
        let size = null;
        try { size = JSON.parse(Buffer.from(url.slice(url.indexOf(",") + 1), "base64").toString("utf8")); } catch { }
        this.naturalWidth = size && size.w ? size.w : width * 2;
        this.naturalHeight = size && size.h ? size.h : height * 2;
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
      child.stdin = {
        written: [],
        destroyed: false,
        write(s) {
          this.written.push(s);
          // The helper answers a front-window request from the window list
          // (`world.frontWindow`: null — no front window — unless a test
          // sets one; `world.frontWindowSilent`: no answer at all).
          let cmd = null;
          try { cmd = JSON.parse(s); } catch { }
          if (cmd && cmd.cmd === "front-window" && !world.frontWindowSilent) {
            const w = world.frontWindow;
            const answer = w ? { t: "front-window", id: cmd.id, x: w.x, y: w.y, w: w.width, h: w.height } : { t: "front-window", id: cmd.id };
            setImmediate(() => child.stdout.emit("data", `${JSON.stringify(answer)}\n`));
          }
        },
        end() { this.destroyed = true; },
      };
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
      // The capture, as the fake Image reads it: the region at 2x.
      fs.writeFileSync(outFile, JSON.stringify({ w: bounds.width * 2, h: bounds.height * 2, raw: true }));
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

function painted(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function paintedMoveTos(file) {
  return painted(file).calls.filter((c) => c[0] === "moveTo");
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
    assert.ok(world.logs.some((l) => /shot captured \(capsule\) displays=1 area=display capture_ms=\d+ strokes_off=1 compose_ms=\d+/.test(l)));
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
    assert.deepEqual(world.warnings, ["overlay"]);
    assert.equal(world.children[0].stdin.destroyed, true, "the helper is stopped");
    assert.deepEqual(world.active, []);
  } finally {
    world.cleanup();
  }
});

test("a failed overlay aborts immediately without waiting on the palette or leaving a live session", async () => {
  const world = createWorld({
    failLoad: (w) => w.opts.title === "Transcriptor Screen Mode",
    loadGate: (w) => (w.opts.title === "Transcriptor Screen Colors" ? new Promise(() => {}) : null),
  });
  try {
    const started = await world.controller.start(ID);
    assert.equal(started.outcome, SCREEN_START_OUTCOME.FAILED);
    assert.match(started.error, /no overlay could be shown/);
    assert.deepEqual(world.warnings, ["overlay"]);
    assert.deepEqual(world.active, []);
    assert.equal(world.controller.isActive(), false);
    assert.equal(world.visibleOverlays(), 0);
    assert.equal(world.palette(), null);
    assert.ok(world.logs.some((line) => line.includes("overlay failed: loadURL failed")));
    assert.ok(screenModeWarningCopy("overlay"));
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
    // Off every number: nothing to cross. The cross itself is driven by
    // the number tests.
    hover: { line: { t: "hover", x: 900, y: 700 }, seen: () => true },
    click: { line: { t: "click", x: 300, y: 300 }, seen: () => true },
    press: { line: { t: "press", outcome: "stroke", clicks: 1, drags: 9 }, seen: (w) => w.logs.some((l) => l.includes("press outcome=stroke clicks=1 drags=9")) },
    "tap-disabled": { line: { t: "tap-disabled", reason: "timeout", abandoned: "stroke" }, seen: (w) => w.logs.some((l) => l.includes("tap disabled reason=timeout abandoned=stroke")) },
    // An answer nobody asked for (a request that already timed out) is
    // dropped; the request/answer pair itself is driven by the window tests.
    "front-window": { line: { t: "front-window", id: 999 }, seen: () => true },
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
    await world.controller.start(ID, { recordClicks: true });
    for (const kind of ["ready", "start", "move", "end", "tap", "hover", "click", "press", "tap-disabled", "front-window", "error"]) {
      world.say(samples[kind].line);
      assert.ok(samples[kind].seen(world), `line ${kind} had no effect`);
    }
    await world.controller.takeShot("hotkey");
    const manifest = (await world.controller.finish({ id: ID })).manifest;
    assert.equal(manifest.events.filter((e) => e.type === "stroke").length, 1, "start/move/end drew one stroke");
    assert.equal(manifest.events.filter((e) => e.type === "click").length, 1, "click recorded a click");
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

// ── tools, numbers, the front window, the cheap copies ─────────────────
async function screenNumbers(world) {
  // What the live canvas last drew: the numbers' text, in order.
  await tick(30);
  const calls = world.overlays()[0].page.screenCanvas.ctx.calls;
  const lastClear = calls.map((c) => c[0]).lastIndexOf("clearRect");
  return calls.slice(lastClear).filter((c) => c[0] === "fillText").map((c) => c[1]);
}

test("every take starts with the rectangle; a tap on the pen switches the next stroke to it", async () => {
  let hitTool = null;
  const world = createWorld({
    hit: () => ({ closest: (sel) => (sel === ".tool" && hitTool ? { dataset: { t: hitTool } } : null) }),
  });
  try {
    await world.controller.start(ID);
    drawStroke(world, [[100, 100], [140, 150], [300, 250]]); // a rectangle: two corners
    hitTool = "pen";
    const b = world.palette().getBounds();
    world.say({ t: "tap", x: b.x + 15, y: b.y + 15 });
    await tick(5);
    assert.ok(world.palette().webContents.scripts.some((js) => js.includes('__selectTool("pen")')), "the pen is shown selected");
    assert.ok(world.logs.includes("[screen-mode] tool pen"));
    drawStroke(world, [[400, 400], [450, 420], [500, 400]]);
    await world.controller.takeShot("hotkey");
    const strokes = (await world.controller.finish({ id: ID })).manifest.events.filter((e) => e.type === "stroke");
    assert.deepEqual(strokes.map((e) => [e.n, e.tool, e.shape]), [[1, "rect", "rect"], [2, "pen", "curve"]]);
  } finally {
    world.cleanup();
  }
  // The next take starts with the rectangle again.
  const next = createWorld();
  try {
    await next.controller.start(ID);
    drawStroke(next, [[100, 100], [300, 300]]);
    await next.controller.takeShot("hotkey");
    const stroke = (await next.controller.finish({ id: ID })).manifest.events.find((e) => e.type === "stroke");
    assert.equal(stroke.tool, "rect");
  } finally {
    next.cleanup();
  }
});

test("the palette shows the two tools, a divider, then the colours, the selected ones lit alike", () => {
  const { SCREEN_MODE } = require("./screen-mode");
  const { paletteHtml, paletteSize } = require("./screen-mode-controller");
  const html = paletteHtml(SCREEN_MODE.colors, SCREEN_MODE.colors[0], SCREEN_MODE.tools, "rect");
  const order = [...html.matchAll(/class="(tool|sep|dot)[^"]*"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["tool", "tool", "sep", ...SCREEN_MODE.colors.map(() => "dot")]);
  assert.match(html, /class="tool sel" data-t="rect"/);
  assert.match(html, /class="tool" data-t="pen"/);
  assert.match(html, /\.dot\.sel, \.tool\.sel \{/, "one highlight for a selected tool and a selected colour");
  // padding 2·10 + tools 2·22 + divider 1 + colours 6·18 + 8 gaps of 8 + border 2.
  assert.deepEqual(paletteSize(6, 2), { width: 20 + 44 + 1 + 108 + 64 + 2, height: 30 });
  // Every tool has an icon and a name: no blank button.
  for (const tool of SCREEN_MODE.tools) {
    assert.match(html, new RegExp(`data-t="${tool}" aria-label="[A-Z][a-z]+"><svg `), tool);
  }
});

test("a rectangle is drawn live from the press to the pointer, in any direction", async () => {
  const world = createWorld();
  try {
    await world.controller.start(ID);
    world.say({ t: "start", x: 500, y: 400 });
    world.say({ t: "move", x: 300, y: 250 }); // up and to the left of the press
    await tick(30);
    const calls = world.overlays()[0].page.screenCanvas.ctx.calls;
    const last = calls.slice(calls.map((c) => c[0]).lastIndexOf("clearRect"));
    const path = last.filter((c) => c[0] === "moveTo" || c[0] === "lineTo").map((c) => c.slice(1));
    assert.deepEqual(path, [[500, 400], [300, 400], [300, 250], [500, 250]]);
    assert.ok(last.some((c) => c[0] === "closePath"));
  } finally {
    world.cleanup();
  }
});

test("each stroke shows its number live; after a shot the next one is 1 again", async () => {
  const world = createWorld();
  try {
    await world.controller.start(ID);
    drawStroke(world, [[100, 100], [200, 200]]);
    drawStroke(world, [[300, 100], [400, 200]]);
    world.say({ t: "start", x: 500, y: 100 }); // still being drawn: numbered already
    world.say({ t: "move", x: 600, y: 200 });
    assert.deepEqual(await screenNumbers(world), ["1", "2", "3"]);
    await world.controller.takeShot("capsule");
    // Strokes 1 and 2 left with the shot; the one still being drawn is now 1.
    assert.deepEqual(await screenNumbers(world), ["1"]);
    world.say({ t: "end", x: 600, y: 200 });
    drawStroke(world, [[100, 500], [200, 600]]);
    assert.deepEqual(await screenNumbers(world), ["1", "2"]);
    await world.controller.takeShot("capsule");
    const strokes = (await world.controller.finish({ id: ID })).manifest.events.filter((e) => e.type === "stroke");
    assert.deepEqual(strokes.map((e) => [e.shot, e.n]), [[1, 1], [1, 2], [2, 1], [2, 2]]);
  } finally {
    world.cleanup();
  }
});

test("a shot is the front window when every stroke touches it: placed, numbered and copied from the window", async () => {
  const world = createWorld();
  world.frontWindow = { x: 100, y: 50, width: 600, height: 400 };
  try {
    await world.controller.start(ID);
    drawStroke(world, [[250, 150], [400, 250]]); // inside the window
    drawStroke(world, [[600, 300], [900, 700]]); // runs past its corner
    const shot = await world.controller.takeShot("capsule");
    assert.deepEqual(world.captures.map((c) => c.bounds), [world.frontWindow], "only the window is captured");
    // The helper is asked with Transcriptor's own windows excluded and the
    // shared minimum size (one number for both sides).
    const { SCREEN_MODE } = require("./screen-mode");
    const request = world.helper().stdin.written.map((l) => JSON.parse(l)).find((m) => m.cmd === "front-window");
    assert.deepEqual(request.exclude, [process.pid]);
    assert.equal(request.minSide, SCREEN_MODE.minWindowSide);
    const manifest = (await world.controller.finish({ id: ID })).manifest;
    assert.equal(manifest.version, require("./screen-mode").SCREEN_MODE.manifestVersion);
    const shotEvent = manifest.events.find((e) => e.type === "shot");
    const strokes = manifest.events.filter((e) => e.type === "stroke");
    assert.equal(shotEvent.area, "window");
    assert.deepEqual(shotEvent.files, shot.files);
    // Places are percent of the window, the second stroke cut at its edge.
    assert.deepEqual(strokes[0].box, { x: 25, y: 25, w: 25, h: 25 });
    assert.deepEqual(strokes[1].box, { x: 83, y: 63, w: 17, h: 37 });
    // The image is the window at its own pixels, with both strokes and both numbers.
    const image = painted(shotEvent.files[0]);
    assert.deepEqual([image.w, image.h], [1200, 800]);
    assert.equal(image.calls.filter((c) => c[0] === "closePath").length, 2);
    const numbers = image.calls.filter((c) => c[0] === "fillText");
    assert.deepEqual(numbers.map((c) => c[1]), ["1", "2"]);
    for (const [, , x, y] of numbers) assert.ok(x >= 0 && y >= 0 && x <= 1200 && y <= 800, "every number is inside the picture");
    // The preview: a JPEG beside the original, named by the contract.
    assert.equal(shotEvent.preview, path.join(world.staging, ID, "shot-01-preview.jpg"));
    assert.ok(fs.existsSync(shotEvent.preview));
    // A close-up per stroke that fits one, at the stroke's own number.
    assert.equal(strokes[0].crop, path.join(world.staging, ID, "shot-01-n1.jpg"));
    assert.ok(fs.existsSync(strokes[0].crop));
    const crop = painted(strokes[0].crop);
    assert.ok(crop.w <= 1024 && crop.h <= 1024);
    // (150+2·40)·2 × (100+2·40)·2: the box plus its 40 pt margin, at 2x.
    assert.deepEqual([crop.w, crop.h], [460, 360]);
  } finally {
    world.cleanup();
  }
});

test("a stroke wholly outside the front window makes the shot the whole display", async () => {
  const world = createWorld();
  world.frontWindow = { x: 100, y: 50, width: 400, height: 300 };
  try {
    await world.controller.start(ID);
    drawStroke(world, [[150, 100], [250, 200]]);
    drawStroke(world, [[700, 600], [800, 700]]); // nowhere near the window
    await world.controller.takeShot("hotkey");
    assert.deepEqual(world.captures.map((c) => c.bounds), [world.displays[0].bounds]);
    const manifest = (await world.controller.finish({ id: ID })).manifest;
    assert.equal(manifest.events.find((e) => e.type === "shot").area, "display");
    assert.deepEqual(manifest.events.find((e) => e.type === "stroke").box, { x: 15, y: 13, w: 10, h: 13 });
  } finally {
    world.cleanup();
  }
});

test("a helper that does not say where the front window is: the shot is the display, not a hang", async () => {
  const world = createWorld();
  world.frontWindowSilent = true;
  try {
    await world.controller.start(ID);
    drawStroke(world, [[150, 100], [250, 200]]);
    const started = Date.now();
    await world.controller.takeShot("hotkey");
    assert.ok(Date.now() - started < 2000);
    assert.deepEqual(world.captures.map((c) => c.bounds), [world.displays[0].bounds]);
    assert.ok(world.logs.some((l) => /front window: no answer within \d+ ms/.test(l)));
    const manifest = (await world.controller.finish({ id: ID })).manifest;
    assert.equal(manifest.events.find((e) => e.type === "shot").area, "display");
  } finally {
    world.cleanup();
  }
});

test("a shot with nothing drawn keeps its capture as taken and still gets a preview", async () => {
  const world = createWorld();
  world.frontWindow = { x: 100, y: 50, width: 600, height: 400 };
  try {
    await world.controller.start(ID);
    const shot = await world.controller.takeShot("hotkey");
    assert.equal(painted(shot.files[0]).raw, true, "the original is the capture itself");
    const manifest = (await world.controller.finish({ id: ID })).manifest;
    const shotEvent = manifest.events.find((e) => e.type === "shot");
    assert.equal(shotEvent.area, "window");
    assert.equal(shotEvent.strokes, 0);
    assert.ok(fs.existsSync(shotEvent.preview));
  } finally {
    world.cleanup();
  }
});

test("a stroke covering most of the area gets no close-up: the preview already shows it", async () => {
  const world = createWorld();
  try {
    await world.controller.start(ID);
    drawStroke(world, [[50, 50], [950, 750]]);
    await world.controller.takeShot("hotkey");
    const manifest = (await world.controller.finish({ id: ID })).manifest;
    const stroke = manifest.events.find((e) => e.type === "stroke");
    assert.equal("crop" in stroke, false);
    assert.deepEqual(fs.readdirSync(path.join(world.staging, ID)).filter((f) => /-n\d+\.jpg$/.test(f)), []);
  } finally {
    world.cleanup();
  }
});

test("a stroke's number is a black digit whatever the colour (user, 2026-11-21)", async () => {
  const { SCREEN_MODE } = require("./screen-mode");
  const world = createWorld();
  try {
    await world.controller.start(ID);
    drawStroke(world, [[100, 100], [200, 200]]); // red, the default
    await tick(30);
    const red = world.overlays()[0].page.screenCanvas.ctx.calls.filter((c) => c[0] === "fillText").pop();
    assert.equal(red[4], "#000000");
    const overlay = world.overlays()[0];
    await overlay.webContents.executeJavaScript(`window.__apply([["b", 99, ${JSON.stringify(SCREEN_MODE.colors[5])}, 300, 300, "rect", 2, { x: 0, y: 0, width: 1000, height: 800 }], ["m", 99, 400, 400]])`);
    const white = overlay.page.screenCanvas.ctx.calls.filter((c) => c[0] === "fillText").pop();
    assert.equal(white[4], "#000000");
  } finally {
    world.cleanup();
  }
});

// ── 2026-11-21: a session no take owns ─────────────────────────────────
test("the stopping take ends a live session under another id: its drawings and palette leave the screen", async () => {
  const world = createWorld();
  const RENDERER_TAKE = "screen-20261120-100400-000";
  try {
    await world.controller.start(ID);
    drawStroke(world, [[100, 100], [200, 160]]);
    await tick(30);
    // Any other finish of a foreign id still refuses.
    assert.deepEqual(await world.controller.finish({ id: RENDERER_TAKE }), { ok: false, error: "session-mismatch" });
    assert.equal(world.controller.isActive(), true);
    // The renderer's stop for its take: the live session goes with it.
    const out = await world.controller.finish({ id: RENDERER_TAKE, endsTake: true });
    assert.equal(out.ok, true);
    assert.equal(out.adoptedId, ID);
    assert.equal(out.manifest.id, ID);
    assert.equal(out.manifest.events.filter((e) => e.type === "shot").length, 1, "the pending drawing is shot at the stop");
    assert.equal(world.controller.isActive(), false);
    assert.equal(world.overlays().length, 0, "nothing left on the screen");
  } finally {
    world.cleanup();
  }
});

test("screen mode draws no frame around the screen: the overlay is the strokes' canvas only (user, 2026-11-21)", () => {
  const { overlayHtml } = require("./screen-mode-controller");
  const html = overlayHtml();
  assert.doesNotMatch(html, /id="frame"|#frame|border:/);
  assert.match(html, /<canvas id="cv"><\/canvas>/);
});

// ── clicks (the "record clicks" setting) ───────────────────────────────
const CLICK_RING_RADIUS = require("./screen-mode").SCREEN_MODE.clickMark.radius;
const ringsIn = (file, scale) => painted(file).calls.filter((c) => c[0] === "arc" && c[3] === CLICK_RING_RADIUS * scale);

test("with the setting on, a plain click is a ring in the next shot and a placed click in the manifest", async () => {
  const world = createWorld();
  world.frontWindow = { x: 100, y: 50, width: 600, height: 400 };
  try {
    await world.controller.start(ID, { recordClicks: true });
    world.say({ t: "click", x: 400, y: 250 }); // inside the front window
    const shot = await world.controller.takeShot("hotkey");
    // The capture is the window at 2x: the ring is at the click, in window pixels.
    const rings = ringsIn(shot.files[0], 2);
    assert.equal(rings.length, 1, "one ring, no number");
    assert.deepEqual(rings[0].slice(1, 3), [(400 - 100) * 2, (250 - 50) * 2]);
    assert.equal(painted(shot.files[0]).calls.some((c) => c[0] === "fillText"), false, "a click carries no number");
    world.say({ t: "click", x: 10, y: 10 }); // after the last shot
    const manifest = (await world.controller.finish({ id: ID })).manifest;
    assert.deepEqual(manifest.events.filter((e) => e.type === "click").map(({ at, ...rest }) => rest), [
      { type: "click", shot: 1, xPct: 50, yPct: 50 },
      { type: "click" },
    ]);
    assert.ok(world.logs.some((l) => / clicks=on$/.test(l)));
  } finally {
    world.cleanup();
  }
});

test("with the setting off, a click leaves no trace: no ring, no event", async () => {
  const world = createWorld();
  world.frontWindow = { x: 100, y: 50, width: 600, height: 400 };
  try {
    await world.controller.start(ID);
    world.say({ t: "click", x: 400, y: 250 });
    const shot = await world.controller.takeShot("hotkey");
    assert.equal(painted(shot.files[0]).raw, true, "the capture as taken");
    const manifest = (await world.controller.finish({ id: ID })).manifest;
    assert.equal(manifest.events.some((e) => e.type === "click"), false);
  } finally {
    world.cleanup();
  }
});

// ── deleting a stroke by its number (user, 2026-11-21) ─────────────────
const BADGE_RADIUS = require("./screen-mode").SCREEN_MODE.badge.radius;

// The numbers' circles the helper was last told about, as [cx, cy, r].
function sentDiscs(world) {
  const controls = world.helper().stdin.written
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((cmd) => cmd && cmd.cmd === "controls");
  return controls.length ? controls[controls.length - 1].discs : [];
}

// The numbers' circles the live canvas last drew, as [cx, cy].
async function screenBadges(world) {
  await tick(30);
  const calls = world.overlays()[0].page.screenCanvas.ctx.calls;
  const lastClear = calls.map((c) => c[0]).lastIndexOf("clearRect");
  return calls.slice(lastClear).filter((c) => c[0] === "arc" && c[3] === BADGE_RADIUS).map((c) => [c[1], c[2]]);
}

test("the helper is told each number's circle exactly where the overlay draws it", async () => {
  const world = createWorld();
  try {
    await world.controller.start(ID);
    drawStroke(world, [[100, 100], [200, 200]]); // a rectangle
    drawStroke(world, [[300, 100], [400, 200]]);
    world.say({ t: "start", x: 500, y: 100 }); // being drawn: no number to tap yet
    world.say({ t: "move", x: 600, y: 200 });
    const drawn = await screenBadges(world);
    assert.equal(drawn.length, 3);
    assert.deepEqual(sentDiscs(world), drawn.slice(0, 2).map(([x, y]) => [x, y, BADGE_RADIUS]));
    // The rectangle's number is outside its top-right corner.
    const [x, y] = drawn[0];
    assert.ok(x > 200 && y < 100);
    world.say({ t: "end", x: 600, y: 200 });
    await tick(5);
    assert.equal(sentDiscs(world).length, 3, "a finished stroke's number can be tapped");
  } finally {
    world.cleanup();
  }
});

test("a tap on a stroke's number deletes it everywhere, is never a click, and the rest keep their numbers", async () => {
  const world = createWorld();
  try {
    await world.controller.start(ID, { recordClicks: true });
    drawStroke(world, [[100, 100], [200, 200]]);
    drawStroke(world, [[300, 100], [400, 200]]);
    drawStroke(world, [[500, 100], [600, 200]]);
    assert.deepEqual(await screenNumbers(world), ["1", "2", "3"]);
    const [, second] = sentDiscs(world);
    world.say({ t: "tap", x: second[0] + 3, y: second[1] - 3 });
    assert.deepEqual(await screenNumbers(world), ["1", "3"], "the others keep their numbers on the screen");
    const overlay = world.overlays()[0];
    assert.equal(await overlay.webContents.executeJavaScript("window.__hasStrokes([2])"), false, "off the screen");
    assert.equal(sentDiscs(world).length, 2, "the helper forgets its number");
    assert.ok(world.logs.some((l) => l.includes("stroke 2 deleted by its number; 2 left on the screen")));
    const shot = await world.controller.takeShot("hotkey");
    assert.equal(paintedMoveTos(shot.files[0]).length, 2, "not in the screenshot");
    assert.deepEqual(painted(shot.files[0]).calls.filter((c) => c[0] === "fillText").map((c) => c[1]), ["1", "3"]);
    const manifest = (await world.controller.finish({ id: ID })).manifest;
    const strokes = manifest.events.filter((e) => e.type === "stroke");
    assert.deepEqual(strokes.map((e) => [e.shot, e.n, e.box.x]), [[1, 1, 10], [1, 3, 50]], "not in the manifest; the numbers as drawn");
    assert.equal(manifest.events.find((e) => e.type === "shot").strokes, 2);
    assert.equal(manifest.events.some((e) => e.type === "click"), false, "a tap on a number is not a click, setting on or not");
  } finally {
    world.cleanup();
  }
});

test("the pointer on a stroke's number shows a cross in that same circle; off it, the digit again", async () => {
  const world = createWorld();
  try {
    await world.controller.start(ID);
    drawStroke(world, [[100, 100], [200, 200]]);
    drawStroke(world, [[300, 100], [400, 200]]);
    const before = await screenBadges(world);
    const [first] = sentDiscs(world);
    world.say({ t: "hover", x: first[0], y: first[1] + 2 });
    assert.deepEqual(await screenNumbers(world), ["×", "2"], "a cross in place of the digit");
    assert.deepEqual(await screenBadges(world), before, "in the same circle");
    world.say({ t: "hover", x: first[0] + 30, y: first[1] }); // the helper's report on leaving it
    assert.deepEqual(await screenNumbers(world), ["1", "2"]);
    // Back on it, and tapped: the stroke goes, and so does the cross.
    world.say({ t: "hover", x: first[0], y: first[1] });
    world.say({ t: "tap", x: first[0], y: first[1] });
    assert.deepEqual(await screenNumbers(world), ["2"], "the one left keeps its number");
    // A cross is never painted into a screenshot.
    world.say({ t: "hover", x: sentDiscs(world)[0][0], y: sentDiscs(world)[0][1] });
    const shot = await world.controller.takeShot("hotkey");
    assert.deepEqual(painted(shot.files[0]).calls.filter((c) => c[0] === "fillText").map((c) => c[1]), ["2"], "the screenshot shows the number the stroke had");
  } finally {
    world.cleanup();
  }
});

test("a number tapped while a shot is being taken goes with the shot: the shot asked first", async () => {
  const world = createWorld();
  try {
    await world.controller.start(ID);
    drawStroke(world, [[100, 100], [200, 200]]);
    await tick(30);
    const [disc] = sentDiscs(world);
    let release;
    world.captureGate = new Promise((resolve) => { release = resolve; });
    const shot = world.controller.takeShot("hotkey");
    await tick(5);
    world.say({ t: "tap", x: disc[0], y: disc[1] });
    release();
    await shot;
    await tick(5);
    assert.deepEqual(sentDiscs(world), [], "nothing left to tap");
    const manifest = (await world.controller.finish({ id: ID })).manifest;
    assert.deepEqual(manifest.events.filter((e) => e.type === "stroke").map((e) => e.shot), [1]);
    assert.equal(world.logs.some((l) => l.includes("deleted by its number")), false);
  } finally {
    world.cleanup();
  }
});

test("a number under the palette is not tapped: the palette is above it", async () => {
  const world = createWorld({ hit: () => null });
  try {
    await world.controller.start(ID);
    const b = world.palette().getBounds();
    // A rectangle whose number lands on the palette.
    drawStroke(world, [[b.x + 10, b.y + 20], [b.x + 20, b.y + 40]]);
    await tick(30);
    const [disc] = sentDiscs(world);
    assert.ok(disc[0] >= b.x && disc[0] < b.x + b.width && disc[1] >= b.y && disc[1] < b.y + b.height, "the number is on the palette");
    world.say({ t: "tap", x: disc[0], y: disc[1] });
    assert.deepEqual(await screenNumbers(world), ["1"], "the stroke stays");
  } finally {
    world.cleanup();
  }
});

// Every overlay is handed every stroke (a line across two displays is
// drawn on both); the number used to be pulled inside EACH overlay's view,
// so a stroke on one display also showed a stray number at the edge of
// the other. It is kept inside the stroke's own display — the view the
// controller hit-tests it in.
test("a stroke's number shows on the display it was drawn on only", async () => {
  const world = createWorld({
    displays: [
      { id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 }, workArea: { x: 0, y: 25, width: 1000, height: 775 } },
      { id: 2, bounds: { x: 1000, y: 0, width: 1000, height: 800 }, workArea: { x: 1000, y: 0, width: 1000, height: 800 } },
    ],
  });
  try {
    await world.controller.start(ID);
    drawStroke(world, [[1100, 100], [1200, 200]]);
    await tick(30);
    const numbersOn = (overlay) => {
      const calls = overlay.page.screenCanvas.ctx.calls;
      return calls.slice(calls.map((c) => c[0]).lastIndexOf("clearRect"))
        .filter((c) => c[0] === "arc" && c[3] === BADGE_RADIUS)
        .filter((c) => c[1] + BADGE_RADIUS > 0 && c[1] - BADGE_RADIUS < 1000 && c[2] + BADGE_RADIUS > 0 && c[2] - BADGE_RADIUS < 800);
    };
    const [first, second] = world.overlays();
    assert.equal(numbersOn(first).length, 0, "no stray number on the other display");
    assert.equal(numbersOn(second).length, 1);
    const [disc] = sentDiscs(world);
    const [arc] = numbersOn(second);
    // The page works in display points, the helper in global ones.
    assert.ok(Math.hypot(arc[1] + 1000 - disc[0], arc[2] - disc[1]) < 1e-9, "where the helper hit-tests it");
  } finally {
    world.cleanup();
  }
});
