"use strict";

/**
 * Screen mode — the Electron half.
 *
 * Owns, for the length of one screen-mode recording:
 *
 *   * one transparent overlay window per display — a red frame around the
 *     screen and a canvas the strokes are drawn on. The overlays never
 *     receive the mouse (`setIgnoreMouseEvents(true)`): clicks, scrolls and
 *     hovers reach the apps underneath as if the overlay were not there;
 *   * the colour palette — a small floating pill above the capsule;
 *   * the native mouse helper (`runtime/bin/screen-input`, source
 *     desktop/native/screen-input/) — a CGEventTap that passes a
 *     plain click through and turns a press-and-drag into a stroke;
 *   * the session's staging directory, where every screenshot and
 *     `events.json` are written. Nothing here deletes a session except a
 *     discarded take's: on save the backend moves the folder beside the
 *     recording and owns it from then on (backend/screen_sessions.py).
 *
 * Event-driven, no polling: our controls' rectangles (sent to the helper)
 * and the palette are re-laid-out when main moves the capsule
 * (`refreshLayout`), overlays
 * follow displays being added, removed or rearranged, and a renderer that
 * dies or reloads mid-take ends the session through main's webContents
 * hooks (`finish`), not through a timer asking whether it is still alive.
 *
 * The rules — session record, stroke positions, manifest — are
 * ./screen-mode.js. This module is the I/O around them.
 *
 * Screenshots: `screencapture -x -R` of each display that has strokes (or
 * the display under the cursor when none does). The overlays, the palette
 * and the capsule are content-protected while screen mode runs, so the
 * capture is the screen itself; the strokes are then painted onto it at
 * the image's own pixel scale by the overlay that drew them. Which strokes
 * a shot holds is decided once, when the capture begins: a stroke that
 * finishes while the images are being made is not in them, stays on the
 * screen and belongs to the next shot. A display that could not be
 * captured keeps its strokes pending too — a shot never claims a stroke
 * its images do not show.
 *
 * Starting is all or nothing: `start` answers ok only once the helper
 * reports its tap is live and at least one overlay is on screen; anything
 * less is torn down and reported (`onWarning`) instead of a red frame
 * that draws nothing. What the user SEES is one moment: the overlays, the
 * palette and the capsule in its screen shape are prepared hidden and
 * shown together (./screen-surfaces.js) — without waiting for the helper,
 * which comes up alongside; drawing begins when it is ready. Every session id that ended — finished, or asked to
 * finish before it ever started — is remembered, so a `start` that loses
 * the race to its own stop is refused instead of opening a take nobody
 * will finish.
 */

const {
  SCREEN_MODE,
  beginStroke,
  createScreenSession,
  endStroke,
  extendStroke,
  pendingStrokes,
  recordShot,
  screenSessionManifest,
  shotFileName,
} = require("./screen-mode");
const { PRESENTER_STATE, SCREEN_SURFACE, createSurfacePresenter } = require("./screen-surfaces");

const OVERLAY_PARTITION = "screen-mode-overlay";
const PALETTE = Object.freeze({ dot: 18, gap: 8, padX: 10, height: 30, marginAboveCapsule: 8 });
// The helper prints `ready` right after macOS hands it the event tap; a
// helper that has said nothing by then is not going to draw anything.
const HELPER_READY_TIMEOUT_MS = 5000;
// How long the picture may wait for its slowest surface (a window whose
// page never loads). A frame not ready by then fails the start; a capsule
// or palette not ready by then is left out of the picture.
const SURFACES_READY_TIMEOUT_MS = 3000;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

/**
 * Every warning the controller raises through `deps.onWarning`. Main shows
 * each one to the user from ONE copy table keyed by these values
 * (./screen-mode-warnings.js), whose test requires copy for every kind
 * here — a kind raised with no copy was a warning nobody saw (D1).
 */
const SCREEN_MODE_WARNING = Object.freeze({
  /** A start failed for a reason other than the two below. */
  START_FAILED: "start-failed",
  /** The helper exited 2: no Accessibility grant, so nothing can draw. */
  ACCESSIBILITY: "accessibility",
  /** Screen Recording is not granted: captures would show the wallpaper. */
  SCREEN_RECORDING: "screen-recording",
  /** The mouse helper died mid-take: nothing draws from then on. */
  HELPER: "helper",
  /** A screenshot could not be taken; its strokes stay for the next one. */
  CAPTURE_FAILED: "capture-failed",
});

/**
 * What `start(id)` answers, as `{ ok, outcome, id?, error? }`. `ok` is
 * true exactly for STARTED.
 *
 *   STARTED  the session is live (overlays up, helper tapping).
 *   ENDED    the take already ended — its stop reached the controller
 *            first. A normal outcome of a quick stop, not a failure: no
 *            warning, nothing to tell the renderer (D3).
 *   FAILED   the start failed; the controller has already warned the
 *            user (it is the one owner of that notification — D2) and the
 *            take goes on as a voice take.
 */
const SCREEN_START_OUTCOME = Object.freeze({
  STARTED: "started",
  ENDED: "ended",
  FAILED: "failed",
});

function overlayHtml() {
  const border = SCREEN_MODE.borderWidth;
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
  #frame { position: fixed; inset: 0; border: ${border}px solid ${SCREEN_MODE.borderColor}; box-sizing: border-box; pointer-events: none; }
  #flash { position: fixed; inset: 0; background: #fff; opacity: 0; pointer-events: none; transition: opacity .25s ease-out; }
  canvas { position: fixed; inset: 0; width: 100%; height: 100%; }
</style></head>
<body>
<canvas id="cv"></canvas><div id="frame"></div><div id="flash"></div>
<script>
  const cv = document.getElementById("cv");
  const ctx = cv.getContext("2d");
  const LINE = ${SCREEN_MODE.strokeWidth};
  let origin = { x: 0, y: 0 };
  const strokes = new Map();
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(innerWidth * dpr);
    cv.height = Math.round(innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }
  function drawStroke(c, s, scale) {
    if (!s.points.length) return;
    c.save();
    c.strokeStyle = s.color;
    c.fillStyle = s.color;
    c.lineWidth = LINE * scale;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.beginPath();
    const p0 = s.points[0];
    c.moveTo(p0[0] * scale, p0[1] * scale);
    if (s.points.length === 1) {
      c.arc(p0[0] * scale, p0[1] * scale, LINE * scale / 2, 0, Math.PI * 2);
      c.fill();
    } else {
      for (let i = 1; i < s.points.length - 1; i += 1) {
        const a = s.points[i], b = s.points[i + 1];
        c.quadraticCurveTo(a[0] * scale, a[1] * scale, (a[0] + b[0]) / 2 * scale, (a[1] + b[1]) / 2 * scale);
      }
      const last = s.points[s.points.length - 1];
      c.lineTo(last[0] * scale, last[1] * scale);
      c.stroke();
    }
    c.restore();
  }
  function redraw() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const s of strokes.values()) drawStroke(ctx, s, 1);
  }
  window.__setOrigin = (x, y) => { origin = { x, y }; return true; };
  // ops: ["b", id, color, gx, gy] begin, ["m", id, gx, gy] move. Points
  // are kept relative to the display they were drawn on, as it was then.
  window.__apply = (ops) => {
    for (const op of ops) {
      if (op[0] === "b") strokes.set(op[1], { color: op[2], points: [[op[3] - origin.x, op[4] - origin.y]] });
      else if (op[0] === "m") {
        const s = strokes.get(op[1]);
        if (s) s.points.push([op[2] - origin.x, op[3] - origin.y]);
      }
    }
    redraw();
    return true;
  };
  // A shot names the strokes it holds; nothing else is touched, so a
  // stroke still being drawn keeps what it has drawn and keeps drawing.
  window.__hasStrokes = (ids) => ids.some((id) => strokes.has(id));
  window.__clear = (ids) => { for (const id of ids) strokes.delete(id); redraw(); return true; };
  window.__flash = () => {
    const f = document.getElementById("flash");
    f.style.transition = "none"; f.style.opacity = ".35";
    requestAnimationFrame(() => { f.style.transition = "opacity .25s ease-out"; f.style.opacity = "0"; });
    return true;
  };
  // Paint the strokes \`ids\` onto a capture of this display, at the
  // capture's own pixel scale, and hand back a PNG data URL.
  window.__composite = (dataUrl, ids) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = img.naturalWidth / Math.max(1, innerWidth);
      const out = document.createElement("canvas");
      out.width = img.naturalWidth;
      out.height = img.naturalHeight;
      const c = out.getContext("2d");
      c.drawImage(img, 0, 0);
      for (const id of ids) {
        const s = strokes.get(id);
        if (s) drawStroke(c, s, scale);
      }
      resolve(out.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("capture image failed to load"));
    img.src = dataUrl;
  });
  addEventListener("resize", resize);
  resize();
</script></body></html>`;
}

function paletteHtml(colors, selected) {
  const dots = colors
    .map((c) => `<button class="dot${c === selected ? " sel" : ""}" data-c="${c}" style="background:${c}" aria-label="${c}"></button>`)
    .join("");
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; -webkit-user-select: none; }
  body { display: flex; align-items: center; justify-content: center; }
  #pill { height: ${PALETTE.height}px; display: flex; align-items: center; gap: ${PALETTE.gap}px; padding: 0 ${PALETTE.padX}px;
    border-radius: 999px; background: #121212; border: 1px solid rgba(255,255,255,.16); box-shadow: inset 0 1px 0 rgba(255,255,255,.10); }
  .dot { width: ${PALETTE.dot}px; height: ${PALETTE.dot}px; border-radius: 50%; border: 2px solid rgba(255,255,255,.18); padding: 0; cursor: pointer; outline: none; }
  .dot.sel { border-color: #fff; box-shadow: 0 0 0 2px rgba(255,255,255,.25); }
</style></head>
<body><div id="pill">${dots}</div>
<script>
  // A tap on a dot reaches this page only as the helper's tap, which the
  // controller resolves to the dot's colour itself (\`deliverTap\`).
  window.__select = (c) => {
    for (const b of document.querySelectorAll(".dot")) b.classList.toggle("sel", b.dataset.c === c);
    return true;
  };
</script></body></html>`;
}

function paletteSize(colorCount) {
  return {
    width: PALETTE.padX * 2 + colorCount * PALETTE.dot + (colorCount - 1) * PALETTE.gap + 2,
    height: PALETTE.height,
  };
}

/**
 * @param {object} deps
 * @param {typeof import("electron").BrowserWindow} deps.BrowserWindow
 * @param {import("electron").Screen} deps.screen
 * @param {typeof import("node:child_process")} deps.childProcess
 * @param {typeof import("node:fs")} deps.fs
 * @param {typeof import("node:path")} deps.path
 * @param {() => string} deps.helperPath       absolute path of the native helper
 * @param {() => string} deps.stagingRoot      directory the sessions are staged in
 * @param {(line: string) => void} deps.log
 * @param {() => (import("electron").BrowserWindow|null)} deps.capsuleWindow  the capsule, when it is on screen
 * @param {(active: boolean) => void} deps.onActiveChange   capsule restyle / raise
 * @param {(warning: string) => void} deps.onWarning
 * @param {() => Promise<boolean>} [deps.prepareCapsule]  resolves true once the capsule is
 *   painted in its screen shape and kept hidden for the shared showing (false: main shows it
 *   its own way)
 * @param {() => void} [deps.showCapsule]  show that prepared capsule, now
 * @param {() => string} [deps.screenCaptureAccess]  macOS media access status for "screen"
 * @param {(bounds: object, outFile: string) => Promise<void>} [deps.captureRegion]  replaces screencapture (tests)
 * @param {string} [deps.platform]  replaces process.platform (tests)
 */
function createScreenModeController(deps) {
  const { BrowserWindow, screen, childProcess, fs, path, log } = deps;
  let session = null;
  let lastManifest = null;
  let overlays = new Map(); // displayId -> { win, bounds, ready, ops: [] }
  let palette = null;
  let helper = null;
  let helperBuffer = "";
  let lastControlsKey = "";
  let displayListeners = null;
  let flushScheduled = false;
  let chain = Promise.resolve();
  // Main was told the session is on (`onActiveChange(true)`); only then is
  // it told it is off.
  let announced = false;
  // Pending helper start: settles on the helper's `ready`, or fails on its
  // exit/error before it.
  let helperStart = null;
  // Every session id that ended or was asked to end. A `start` of one of
  // these lost the race to its own stop and must not open a take.
  const endedIds = new Set();
  // The session's surfaces have been shown (one moment, ./screen-surfaces).
  // Until then every window is created hidden; afterwards a window created
  // for the session (a display plugged in) shows as soon as it is ready.
  let presented = false;

  function serialize(fn) {
    const next = chain.then(fn, fn);
    chain = next.catch(() => { });
    return next;
  }

  function isSupported() {
    if ((deps.platform || process.platform) !== "darwin") return false;
    try {
      return fs.existsSync(deps.helperPath());
    } catch {
      return false;
    }
  }

  function isActive() {
    return !!session;
  }

  // ── overlays ──────────────────────────────────────────────────────────
  async function createOverlay(display) {
    const bounds = display.bounds;
    const w = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      enableLargerThanScreen: true,
      alwaysOnTop: true,
      title: "Transcriptor Screen Mode",
      backgroundColor: "#00000000",
      webPreferences: {
        partition: OVERLAY_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: false,
        backgroundThrottling: false,
      },
    });
    const entry = { win: w, bounds, ready: false, ops: [] };
    overlays.set(display.id, entry);
    try {
      // An overlay that took the mouse would block the whole display; one
      // that is not content-protected would be in every screenshot. Either
      // failure means this overlay must not be shown.
      required("setIgnoreMouseEvents", () => w.setIgnoreMouseEvents(true));
      required("setContentProtection", () => w.setContentProtection(true));
      optional("overlay setAlwaysOnTop", () => w.setAlwaysOnTop(true, "screen-saver"));
      optional("overlay setVisibleOnAllWorkspaces", () => w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }));
      await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml())}`);
      if (w.isDestroyed()) throw new Error("overlay window was destroyed while loading");
      // The display bounds again: macOS may have nudged the window off the
      // menu bar while it was created.
      optional("overlay setBounds", () => w.setBounds(bounds, false));
      await w.webContents.executeJavaScript(`window.__setOrigin(${bounds.x}, ${bounds.y})`, true);
    } catch (e) {
      if (overlays.get(display.id) === entry) destroyOverlay(display.id);
      throw e;
    }
    entry.ready = true;
    if (presented) w.showInactive();
  }

  function required(what, fn) {
    try {
      fn();
    } catch (e) {
      throw new Error(`${what} failed: ${e?.message || e}`);
    }
  }

  function optional(what, fn) {
    try {
      fn();
    } catch (e) {
      log(`[screen-mode] ${what} failed: ${e?.message || e}`);
    }
  }

  function destroyOverlay(displayId) {
    const entry = overlays.get(displayId);
    overlays.delete(displayId);
    try { if (entry && !entry.win.isDestroyed()) entry.win.destroy(); } catch { }
  }

  // Displays come and go during a take (a projector plugged in, a lid
  // closed, the arrangement changed). Every display gets a frame; a
  // stroke already on a display that leaves stays in the session record.
  function watchDisplays() {
    const added = (_e, display) => {
      if (!session || overlays.has(display.id)) return;
      createOverlay(display).catch((e) => log(`[screen-mode] overlay for new display failed: ${e?.message || e}`));
    };
    const removed = (_e, display) => destroyOverlay(display.id);
    const changed = (_e, display) => {
      const entry = overlays.get(display.id);
      if (!entry || entry.win.isDestroyed()) return;
      entry.bounds = display.bounds;
      try { entry.win.setBounds(display.bounds, false); } catch { }
      overlayCall(entry, `window.__setOrigin(${display.bounds.x}, ${display.bounds.y})`);
      refreshLayout();
    };
    screen.on("display-added", added);
    screen.on("display-removed", removed);
    screen.on("display-metrics-changed", changed);
    displayListeners = { added, removed, changed };
  }

  function unwatchDisplays() {
    if (!displayListeners) return;
    screen.removeListener("display-added", displayListeners.added);
    screen.removeListener("display-removed", displayListeners.removed);
    screen.removeListener("display-metrics-changed", displayListeners.changed);
    displayListeners = null;
  }

  function queueOp(op) {
    for (const entry of overlays.values()) entry.ops.push(op);
    if (flushScheduled) return;
    flushScheduled = true;
    setTimeout(flushOps, 16);
  }

  function flushOps() {
    flushScheduled = false;
    for (const entry of overlays.values()) {
      if (!entry.ready || !entry.ops.length || entry.win.isDestroyed()) continue;
      const ops = entry.ops;
      entry.ops = [];
      entry.win.webContents.executeJavaScript(`window.__apply(${JSON.stringify(ops)})`, true).catch(() => { });
    }
  }

  // An overlay call whose answer the caller needs: rejects instead of
  // answering null.
  function overlayEval(entry, js) {
    if (!entry || !entry.ready || entry.win.isDestroyed()) {
      return Promise.reject(new Error("no overlay on this display"));
    }
    return entry.win.webContents.executeJavaScript(js, true);
  }

  function overlayCall(entry, js) {
    if (!entry || !entry.ready || entry.win.isDestroyed()) return Promise.resolve(null);
    return entry.win.webContents.executeJavaScript(js, true).catch((e) => {
      log(`[screen-mode] overlay call failed: ${e?.message || e}`);
      return null;
    });
  }

  // ── palette ───────────────────────────────────────────────────────────
  function visibleWindow(w) {
    return w && !w.isDestroyed() && w.isVisible() ? w : null;
  }

  // Our own controls, as the helper must know them: presses on these are
  // taps delivered in-process (`deliverTap`), never clicks through the
  // window server.
  function controlWindows() {
    return [visibleWindow(deps.capsuleWindow()), visibleWindow(palette)].filter(Boolean);
  }

  // The capsule's place, visible or prepared hidden for the shared showing:
  // the palette is placed above it before either is shown.
  function capsuleBounds() {
    const w = deps.capsuleWindow();
    return w && !w.isDestroyed() ? w.getBounds() : null;
  }

  function paletteBounds() {
    const size = paletteSize(SCREEN_MODE.colors.length);
    const capsule = capsuleBounds();
    if (capsule) {
      return {
        x: Math.round(capsule.x + (capsule.width - size.width) / 2),
        y: Math.round(capsule.y - size.height - PALETTE.marginAboveCapsule),
        ...size,
      };
    }
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    return {
      x: Math.round(wa.x + (wa.width - size.width) / 2),
      y: Math.round(wa.y + wa.height - size.height - 54),
      ...size,
    };
  }

  async function createPalette() {
    const w = new BrowserWindow({
      ...paletteBounds(),
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      alwaysOnTop: true,
      title: "Transcriptor Screen Colors",
      backgroundColor: "#00000000",
      webPreferences: {
        partition: OVERLAY_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: false,
      },
    });
    try {
      // A palette that is not content-protected would be in every shot.
      required("palette setContentProtection", () => w.setContentProtection(true));
    } catch (e) {
      w.destroy();
      throw e;
    }
    palette = w;
    optional("palette setAlwaysOnTop", () => w.setAlwaysOnTop(true, "screen-saver", 1));
    optional("palette setVisibleOnAllWorkspaces", () => w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }));
    const html = paletteHtml(SCREEN_MODE.colors, session ? session.color : SCREEN_MODE.colors[0]);
    await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    if (w.isDestroyed()) throw new Error("palette window was destroyed while loading");
    if (presented) w.showInactive();
    refreshLayout();
  }

  /**
   * The one moment the take becomes visible: main is told the session is
   * on (capsule layer, screen button, screenshot hotkey), then the capsule,
   * every ready overlay and the palette are shown back to back, with no
   * await between them.
   */
  function presentSurfaces(ready, pressedAt) {
    presented = true;
    announced = true;
    deps.onActiveChange(true);
    const showCapsule = ready.includes(SCREEN_SURFACE.CAPSULE) && typeof deps.showCapsule === "function";
    if (showCapsule) deps.showCapsule();
    let shownOverlays = 0;
    for (const entry of overlays.values()) {
      if (!entry.ready || entry.win.isDestroyed()) continue;
      entry.win.showInactive();
      shownOverlays += 1;
    }
    const showPalette = ready.includes(SCREEN_SURFACE.PALETTE) && palette && !palette.isDestroyed();
    if (showPalette) {
      try { palette.setBounds(paletteBounds(), false); } catch { }
      palette.showInactive();
    }
    refreshLayout();
    log(
      `[screen-mode] surfaces visible press_to_visible_ms=${Math.max(0, Date.now() - pressedAt)} ` +
      `capsule=${showCapsule ? 1 : 0} overlays=${shownOverlays} palette=${showPalette ? 1 : 0}`,
    );
  }

  function setColor(color) {
    if (!session || !SCREEN_MODE.colors.includes(color)) return;
    session.color = color;
    if (palette && !palette.isDestroyed()) {
      palette.webContents.executeJavaScript(`window.__select(${JSON.stringify(color)})`, true).catch(() => { });
    }
  }

  // Called by main whenever it moves or resizes the capsule, and here
  // when the palette or the helper appears: the helper must always know
  // where our own controls are.
  function refreshLayout() {
    if (!session) return;
    if (palette && !palette.isDestroyed()) {
      try { palette.setBounds(paletteBounds(), false); } catch { }
    }
    if (!helper) return;
    const rects = controlWindows().map((w) => {
      const b = w.getBounds();
      return [b.x, b.y, b.width, b.height];
    });
    const key = JSON.stringify(rects);
    if (key === lastControlsKey) return;
    lastControlsKey = key;
    sendHelper({ cmd: "controls", rects });
  }

  /**
   * A tap the helper took on one of our controls. The window server never
   * sees it, so the app is never activated and its main window never
   * comes forward.
   *   * On the palette: the colour of the dot under the point is read
   *     back and selected here — the palette page has no channel of its
   *     own to the main process.
   *   * On the capsule: whatever is at that point inside its page is
   *     clicked, and the page's own click handlers do the rest — the same
   *     handlers a real click runs.
   */
  function deliverTap(x, y) {
    const target = controlWindows().find((w) => {
      const b = w.getBounds();
      return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
    });
    if (!target) return;
    const b = target.getBounds();
    const localX = x - b.x;
    const localY = y - b.y;
    if (target === palette) {
      target.webContents.executeJavaScript(
        `(() => {
          const el = document.elementFromPoint(${localX}, ${localY});
          const dot = el && el.closest(".dot");
          return dot ? dot.dataset.c : null;
        })()`,
        true,
      ).then((color) => {
        if (color) setColor(color);
      }, (e) => log(`[screen-mode] palette tap failed: ${e?.message || e}`));
      return;
    }
    target.webContents.executeJavaScript(
      `(() => {
        const el = document.elementFromPoint(${localX}, ${localY});
        if (!el) return false;
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: ${localX}, clientY: ${localY} }));
        return true;
      })()`,
      true,
    ).catch((e) => log(`[screen-mode] tap delivery failed: ${e?.message || e}`));
  }

  // ── native helper ─────────────────────────────────────────────────────
  function sendHelper(obj) {
    if (!helper || !helper.stdin || helper.stdin.destroyed) return;
    try { helper.stdin.write(`${JSON.stringify(obj)}\n`); } catch { }
  }

  /**
   * Spawn the helper and wait for its `ready` (the tap is live). Rejects
   * when it fails to spawn, exits first (exit 2: no Accessibility grant,
   * `err.warning = "accessibility"`) or stays silent past the bound. After
   * `ready`, a helper that dies or errors mid-take is reported, not just
   * logged: from then on nothing draws.
   */
  function startHelper() {
    const bin = deps.helperPath();
    const child = childProcess.spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    helper = child;
    helperBuffer = "";
    lastControlsKey = "";
    const started = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        settle(new Error(`helper did not report ready within ${HELPER_READY_TIMEOUT_MS} ms`));
      }, HELPER_READY_TIMEOUT_MS);
      timer.unref?.();
      function settle(error) {
        if (helperStart !== pending) return;
        helperStart = null;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      }
      const pending = { child, settle };
      helperStart = pending;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      helperBuffer += chunk;
      let idx;
      while ((idx = helperBuffer.indexOf("\n")) >= 0) {
        const line = helperBuffer.slice(0, idx);
        helperBuffer = helperBuffer.slice(idx + 1);
        if (line.trim()) onHelperLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => log(`[screen-mode] helper stderr: ${String(d).trim()}`));
    child.on("error", (e) => {
      log(`[screen-mode] helper failed: ${e?.message || e}`);
      if (helperStart && helperStart.child === child) {
        helperStart.settle(new Error(`helper failed to start: ${e?.message || e}`));
        return;
      }
      if (helper === child) {
        helper = null;
        deps.onWarning(SCREEN_MODE_WARNING.HELPER);
      }
    });
    child.on("exit", (code, signal) => {
      log(`[screen-mode] helper exited code=${code} signal=${signal || ""}`);
      if (helperStart && helperStart.child === child) {
        const error = new Error(`helper exited before it was ready (code=${code} signal=${signal || ""})`);
        if (code === 2) error.warning = SCREEN_MODE_WARNING.ACCESSIBILITY;
        helperStart.settle(error);
        return;
      }
      // stopHelper() lets go of the child before it exits: that exit is ours.
      if (helper !== child) return;
      helper = null;
      deps.onWarning(SCREEN_MODE_WARNING.HELPER);
    });
    return started;
  }

  function stopHelper() {
    const child = helper;
    helper = null;
    if (!child) return;
    if (helperStart && helperStart.child === child) helperStart.settle(new Error("helper stopped before it was ready"));
    try { child.stdin.write(`${JSON.stringify({ cmd: "quit" })}\n`); } catch { }
    try { child.stdin.end(); } catch { }
    setTimeout(() => {
      try { if (child.exitCode === null) child.kill("SIGKILL"); } catch { }
    }, 1000).unref?.();
  }

  function onHelperLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!session) return;
    const t = msg.t;
    if (t === "ready") {
      log("[screen-mode] mouse helper ready");
      if (helperStart) helperStart.settle(null);
      refreshLayout();
      return;
    }
    if (t === "error") {
      log(`[screen-mode] helper error ${msg.code}`);
      return;
    }
    if (t === "press") {
      // One line per finished press: what the hardware sent and what the
      // rule made of it — the record any "this gesture did not draw"
      // report is diagnosed from.
      log(`[screen-mode] press outcome=${msg.outcome} clicks=${msg.clicks} drags=${msg.drags}`);
      return;
    }
    if (t === "tap-disabled") {
      // macOS switched the tap off and the helper switched it back on; the
      // press it cut was abandoned (a stroke ended, a held press handed to
      // the app). The other half of the "did not draw" record.
      log(`[screen-mode] tap disabled reason=${msg.reason} abandoned=${msg.abandoned}`);
      return;
    }
    const x = Number(msg.x);
    const y = Number(msg.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (t === "tap") {
      deliverTap(x, y);
    } else if (t === "start") {
      const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
      const stroke = beginStroke(session, { x, y, displayId: display.id, displayBounds: display.bounds });
      queueOp(["b", stroke.id, stroke.color, x, y]);
    } else if (t === "move") {
      const stroke = extendStroke(session, { x, y });
      if (stroke) queueOp(["m", stroke.id, x, y]);
    } else if (t === "end") {
      const stroke = endStroke(session, { x, y });
      if (stroke) queueOp(["m", stroke.id, x, y]);
    }
  }

  // ── capture ───────────────────────────────────────────────────────────
  function captureRegion(bounds, outFile) {
    if (typeof deps.captureRegion === "function") return deps.captureRegion(bounds, outFile);
    return new Promise((resolve, reject) => {
      const region = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
      childProcess.execFile(
        "/usr/sbin/screencapture",
        ["-x", "-t", "png", "-R", region, outFile],
        { timeout: 15000 },
        (err) => {
          if (err) return reject(err);
          if (!fs.existsSync(outFile)) return reject(new Error("screencapture wrote no file"));
          resolve();
        },
      );
    });
  }

  async function takeShotNow(reason) {
    if (!session) return null;
    flushOps();
    // The strokes this shot holds, decided once, now: helper lines keep
    // arriving while the images are made, and a stroke that finishes
    // during the awaits below is in none of them.
    const pending = pendingStrokes(session);
    const ids = pending.map((s) => s.id);
    const displayIds = [...new Set(pending.map((s) => s.displayId))];
    if (!displayIds.length) {
      displayIds.push(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id);
    }
    const allDisplays = screen.getAllDisplays();
    const at = Date.now();
    const files = [];
    const captured = new Set();
    const failures = [];
    for (const displayId of displayIds) {
      const display = allDisplays.find((d) => d.id === displayId);
      if (!display) {
        failures.push(`display ${displayId} is gone`);
        continue;
      }
      const ordinal = allDisplays.indexOf(display) + 1;
      const file = path.join(session.dir, shotFileName(session.shots.length + 1, ordinal, displayIds.length));
      const onDisplay = pending.filter((s) => s.displayId === displayId).map((s) => s.id);
      try {
        await captureRegion(display.bounds, file);
        if (onDisplay.length) {
          // The strokes are part of the image: without them painted in,
          // this file is not the shot the strokes are said to be in.
          const raw = fs.readFileSync(file).toString("base64");
          const composed = await overlayEval(
            overlays.get(displayId),
            `window.__composite(${JSON.stringify(`${PNG_DATA_URL_PREFIX}${raw}`)}, ${JSON.stringify(onDisplay)})`,
          );
          if (typeof composed !== "string" || !composed.startsWith(PNG_DATA_URL_PREFIX)) {
            throw new Error("the overlay returned no image");
          }
          fs.writeFileSync(file, Buffer.from(composed.slice(PNG_DATA_URL_PREFIX.length), "base64"));
        }
        files.push(file);
        captured.add(displayId);
      } catch (e) {
        failures.push(`display ${displayId}: ${e?.message || e}`);
        fs.rmSync(file, { force: true });
      }
    }
    if (failures.length) {
      // No screenshot is claimed for a display that was not captured: its
      // strokes stay pending and on the screen for the next shot.
      log(`[screen-mode] capture failed (${reason}): ${failures.join("; ")}`);
      deps.onWarning(SCREEN_MODE_WARNING.CAPTURE_FAILED);
    }
    if (!files.length) return null;
    const taken = pending.filter((s) => captured.has(s.displayId)).map((s) => s.id);
    const shot = recordShot(session, { at, files, strokeIds: taken, reason });
    // Only the strokes the shot took leave the screen. Queued ops are
    // kept: they belong to strokes still being drawn or begun since.
    for (const entry of overlays.values()) {
      overlayCall(entry, `window.__clear(${JSON.stringify(shot.strokeIds)})`);
      overlayCall(entry, "window.__flash()");
    }
    writeEvents();
    log(`[screen-mode] shot ${shot.index} reason=${reason} files=${files.length} strokes=${shot.strokeIds.length}`);
    return { index: shot.index, files };
  }

  function writeEvents() {
    if (!session) return;
    lastManifest = screenSessionManifest(session);
    try {
      fs.writeFileSync(path.join(session.dir, SCREEN_MODE.eventsFileName), `${JSON.stringify(lastManifest, null, 2)}\n`);
    } catch (e) {
      log(`[screen-mode] events.json write failed: ${e?.message || e}`);
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────
  function startFailed(id, error, warning = SCREEN_MODE_WARNING.START_FAILED) {
    log(`[screen-mode] start ${id} failed: ${error}`);
    deps.onWarning(warning);
    return { ok: false, outcome: SCREEN_START_OUTCOME.FAILED, error };
  }

  async function startNow(id, pressedAt) {
    if (endedIds.has(id)) {
      // Its stop got here first (the renderer finished the take while main
      // was still on its way to start it): nobody will ever finish it.
      // This is the one place "this take already ended" is decided.
      log(`[screen-mode] start ${id} refused: that take already ended`);
      return { ok: false, outcome: SCREEN_START_OUTCOME.ENDED };
    }
    if (session) {
      if (session.id === id) return { ok: true, outcome: SCREEN_START_OUTCOME.STARTED, id };
      // A new take while an old session is still up: the old take's
      // recording is over (main starts a session only for a confirmed new
      // recording), so its session is closed — screenshots kept staged —
      // instead of answering the new id with the old one.
      log(`[screen-mode] start ${id} while ${session.id} is live; finishing ${session.id}`);
      await finishNow({ id: session.id });
    }
    if (!isSupported()) return startFailed(id, "unsupported");
    const dir = path.join(deps.stagingRoot(), id);
    let expiry = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      session = createScreenSession({ id, dir });
      lastManifest = null;
      watchDisplays();
      // The surfaces and the helper come up side by side. The surfaces are
      // shown together the moment the last of them is ready; the helper's
      // `ready` is awaited only for the answer (drawing starts with it).
      const presenter = createSurfacePresenter({
        required: [SCREEN_SURFACE.OVERLAYS],
        optional: [SCREEN_SURFACE.CAPSULE, SCREEN_SURFACE.PALETTE],
        present: (ready) => {
          try {
            presentSurfaces(ready, pressedAt);
          } catch (e) {
            log(`[screen-mode] showing the surfaces failed: ${e?.message || e}`);
          }
        },
      });
      expiry = setTimeout(() => presenter.expire(), SURFACES_READY_TIMEOUT_MS);
      expiry.unref?.();
      let helperError = null;
      const helperDone = startHelper().catch((e) => {
        helperError = e;
        // A helper that cannot tap means a take that cannot draw: nothing
        // is shown rather than a frame that is taken down again.
        presenter.abort();
      });
      const prepareCapsule = typeof deps.prepareCapsule === "function" ? deps.prepareCapsule() : Promise.resolve(false);
      Promise.resolve(prepareCapsule).then(
        (ok) => presenter.settle(SCREEN_SURFACE.CAPSULE, ok === true),
        () => presenter.settle(SCREEN_SURFACE.CAPSULE, false),
      );
      Promise.allSettled(screen.getAllDisplays().map((d) => createOverlay(d))).then((results) => {
        for (const r of results) {
          if (r.status === "rejected") log(`[screen-mode] overlay failed: ${r.reason?.message || r.reason}`);
        }
        presenter.settle(SCREEN_SURFACE.OVERLAYS, [...overlays.values()].some((entry) => entry.ready));
      });
      // Without a palette the take still draws, in the default colour.
      createPalette().then(
        () => presenter.settle(SCREEN_SURFACE.PALETTE, true),
        (e) => {
          log(`[screen-mode] palette failed: ${e?.message || e}`);
          presenter.settle(SCREEN_SURFACE.PALETTE, false);
        },
      );
      const shown = await presenter.done;
      clearTimeout(expiry);
      if (shown === PRESENTER_STATE.FAILED) throw new Error("no overlay could be shown");
      await helperDone;
      if (helperError) throw helperError;
    } catch (e) {
      clearTimeout(expiry);
      teardown();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
      return startFailed(id, e?.message || String(e), e?.warning || SCREEN_MODE_WARNING.START_FAILED);
    }
    // Without Screen Recording, macOS does not fail a capture: it returns
    // the wallpaper with no windows on it. Say so up front — for every
    // state but "granted" ("not-determined" included) — instead of saving
    // screenshots of nothing.
    const captureAccess = typeof deps.screenCaptureAccess === "function" ? deps.screenCaptureAccess() : "granted";
    if (captureAccess !== "granted") {
      log(`[screen-mode] screen recording access=${captureAccess || "unknown"}`);
      deps.onWarning(SCREEN_MODE_WARNING.SCREEN_RECORDING);
    }
    refreshLayout();
    writeEvents();
    log(`[screen-mode] started ${id} displays=${overlays.size}`);
    return { ok: true, outcome: SCREEN_START_OUTCOME.STARTED, id };
  }

  function teardown() {
    unwatchDisplays();
    stopHelper();
    for (const entry of overlays.values()) {
      try { if (!entry.win.isDestroyed()) entry.win.destroy(); } catch { }
    }
    overlays = new Map();
    if (palette && !palette.isDestroyed()) {
      try { palette.destroy(); } catch { }
    }
    palette = null;
    session = null;
    presented = false;
    if (announced) {
      announced = false;
      deps.onActiveChange(false);
    }
  }

  async function finishNow({ id = "", discard = false } = {}) {
    // Whatever state it finds, this id has ended: a start for it that is
    // still on its way must not open it again.
    if (id) endedIds.add(id);
    if (!session) {
      return lastManifest && (!id || lastManifest.id === id)
        ? { ok: true, manifest: lastManifest }
        : { ok: false, error: "no-session" };
    }
    if (id && session.id !== id) return { ok: false, error: "session-mismatch" };
    endedIds.add(session.id);
    const dir = session.dir;
    session.endedAt = Date.now();
    if (!discard && pendingStrokes(session).length) {
      await takeShotNow("stop");
    }
    if (!discard) writeEvents();
    const manifest = discard ? null : lastManifest;
    teardown();
    if (discard) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
      lastManifest = null;
      log(`[screen-mode] discarded ${id || dir}`);
      return { ok: true, manifest: null };
    }
    log(`[screen-mode] finished ${manifest?.id} events=${manifest?.events?.length || 0}`);
    return { ok: true, manifest };
  }

  // Never rejects: whatever goes wrong on the way is a FAILED start the
  // user has been warned about, so main has one answer to read.
  /**
   * @param {string} id  the take's screen session id
   * @param {{pressedAt?: number}} [opts]  when the user pressed the key: the
   *   "surfaces visible" log line measures press → everything on screen
   */
  const start = (id, opts = {}) => serialize(async () => {
    const pressedAt = Number(opts?.pressedAt) > 0 ? Number(opts.pressedAt) : Date.now();
    try {
      return await startNow(id, pressedAt);
    } catch (e) {
      teardown();
      return startFailed(id, e?.message || String(e));
    }
  });
  const takeShot = (reason) => serialize(() => takeShotNow(reason));
  const finish = (opts) => serialize(() => finishNow(opts));

  return { isSupported, isActive, start, takeShot, finish, teardown, refreshLayout };
}

module.exports = {
  SCREEN_MODE_WARNING,
  SCREEN_START_OUTCOME,
  createScreenModeController,
  overlayHtml,
  paletteHtml,
  paletteSize,
};
