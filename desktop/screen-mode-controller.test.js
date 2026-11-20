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

const { createScreenModeController } = require("./screen-mode-controller");

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
  const element = () => ({ style: {}, addEventListener() { }, classList: { toggle() { } } });
  const context = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: 1,
    addEventListener() { },
    requestAnimationFrame: (fn) => fn(),
    document: {
      title: "",
      getElementById: (id) => (id === "cv" ? screenCanvas : element()),
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
  return { context, screenCanvas };
}

// ── Electron fakes ─────────────────────────────────────────────────────
function createWorld({ displays, helperReady = true, failLoad = () => false, hit = () => null } = {}) {
  const world = {
    displays: displays || [{ id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 }, workArea: { x: 0, y: 25, width: 1000, height: 775 } }],
    windows: [],
    children: [],
    logs: [],
    warnings: [],
    active: [],
    captures: [],
    captureGate: null,
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

    setIgnoreMouseEvents() { }
    setContentProtection() { }
    setAlwaysOnTop() { }
    setVisibleOnAllWorkspaces() { }
    async loadURL(url) {
      await tick();
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
    helperPath: () => process.execPath, // a file that exists, so isSupported() is true
    stagingRoot: () => staging,
    log: (line) => world.logs.push(line),
    capsuleWindow: () => world.capsule,
    onActiveChange: (active) => world.active.push(active),
    onWarning: (kind) => world.warnings.push(kind),
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
  world.cleanup = () => {
    world.controller.teardown();
    fs.rmSync(staging, { recursive: true, force: true });
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
