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
 * Event-driven, no polling: the exclusion rectangles and the palette are
 * re-laid-out when main moves the capsule (`refreshLayout`), overlays
 * follow displays being added, removed or rearranged, and a renderer that
 * dies or reloads mid-take ends the session through main's webContents
 * hooks (`finish`), not through a timer asking whether it is still alive.
 *
 * The rules — session record, region words, prune list, manifest — are
 * ./screen-mode.js. This module is the I/O around them.
 *
 * Screenshots: `screencapture -x -R` of each display that has strokes (or
 * the display under the cursor when none does). The overlays, the palette
 * and the capsule are content-protected while screen mode runs, so the
 * capture is the screen itself; the strokes are then painted onto it at
 * the image's own pixel scale by the overlay that drew them.
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

const OVERLAY_PARTITION = "screen-mode-overlay";
const PALETTE = Object.freeze({ dot: 18, gap: 8, padX: 10, height: 30, marginAboveCapsule: 8 });

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
  let strokes = new Map();
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
  // ops: ["b", id, color, gx, gy] begin, ["m", id, gx, gy] move.
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
  window.__hasStrokes = () => strokes.size > 0;
  window.__clear = () => { strokes = new Map(); redraw(); return true; };
  window.__flash = () => {
    const f = document.getElementById("flash");
    f.style.transition = "none"; f.style.opacity = ".35";
    requestAnimationFrame(() => { f.style.transition = "opacity .25s ease-out"; f.style.opacity = "0"; });
    return true;
  };
  // Paint this overlay's strokes onto a capture of its display, at the
  // capture's own pixel scale, and hand back a PNG data URL.
  window.__composite = (dataUrl) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = img.naturalWidth / Math.max(1, innerWidth);
      const out = document.createElement("canvas");
      out.width = img.naturalWidth;
      out.height = img.naturalHeight;
      const c = out.getContext("2d");
      c.drawImage(img, 0, 0);
      for (const s of strokes.values()) drawStroke(c, s, scale);
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
  document.getElementById("pill").addEventListener("click", (e) => {
    const b = e.target.closest(".dot");
    if (!b) return;
    document.title = "__screen_palette__" + b.dataset.c + "__" + Date.now();
  });
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
 * @param {() => string} [deps.screenCaptureAccess]  macOS media access status for "screen"
 * @param {(bounds: object, outFile: string) => Promise<void>} [deps.captureRegion]  replaces screencapture (tests)
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

  function serialize(fn) {
    const next = chain.then(fn, fn);
    chain = next.catch(() => { });
    return next;
  }

  function isSupported() {
    if (process.platform !== "darwin") return false;
    try {
      return fs.existsSync(deps.helperPath());
    } catch {
      return false;
    }
  }

  function isActive() {
    return !!session;
  }

  function displayBoundsById() {
    const out = {};
    for (const d of screen.getAllDisplays()) out[d.id] = d.bounds;
    return out;
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
    try { w.setIgnoreMouseEvents(true); } catch { }
    try { w.setContentProtection(true); } catch { }
    try { w.setAlwaysOnTop(true, "screen-saver"); } catch { }
    try { w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { }
    await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml())}`);
    if (w.isDestroyed()) return;
    // The display bounds again: macOS may have nudged the window off the
    // menu bar while it was created.
    try { w.setBounds(bounds, false); } catch { }
    await w.webContents.executeJavaScript(`window.__setOrigin(${bounds.x}, ${bounds.y})`, true);
    entry.ready = true;
    w.showInactive();
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

  function capsuleBounds() {
    const w = visibleWindow(deps.capsuleWindow());
    return w ? w.getBounds() : null;
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
    palette = w;
    try { w.setContentProtection(true); } catch { }
    try { w.setAlwaysOnTop(true, "screen-saver", 1); } catch { }
    try { w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { }
    w.webContents.on("page-title-updated", (event, title) => {
      const raw = String(title || "");
      if (!raw.startsWith("__screen_palette__")) return;
      event.preventDefault();
      const color = raw.slice("__screen_palette__".length).split("__")[0];
      setColor(color);
    });
    const html = paletteHtml(SCREEN_MODE.colors, session ? session.color : SCREEN_MODE.colors[0]);
    await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    if (!w.isDestroyed()) w.showInactive();
    refreshLayout();
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
   * A tap the helper took on one of our controls: click whatever is at
   * that point inside the control's own page. The window server never
   * sees it, so the app is never activated and its main window never
   * comes forward. The page's own click handlers do the rest — the same
   * handlers a real click runs.
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

  function startHelper() {
    const bin = deps.helperPath();
    const child = childProcess.spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    helper = child;
    helperBuffer = "";
    lastControlsKey = "";
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
    child.on("error", (e) => log(`[screen-mode] helper spawn failed: ${e?.message || e}`));
    child.on("exit", (code, signal) => {
      if (helper === child) helper = null;
      log(`[screen-mode] helper exited code=${code} signal=${signal || ""}`);
      if (code === 2) {
        deps.onWarning("accessibility");
      }
    });
  }

  function stopHelper() {
    const child = helper;
    helper = null;
    if (!child) return;
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
    const x = Number(msg.x);
    const y = Number(msg.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (t === "tap") {
      deliverTap(x, y);
    } else if (t === "start") {
      const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
      const stroke = beginStroke(session, { x, y, displayId: display.id });
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
    const pending = pendingStrokes(session);
    const displayIds = [...new Set(pending.map((s) => s.displayId))];
    if (!displayIds.length) {
      displayIds.push(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id);
    }
    const allDisplays = screen.getAllDisplays();
    const at = Date.now();
    const files = [];
    for (const displayId of displayIds) {
      const display = allDisplays.find((d) => d.id === displayId);
      if (!display) continue;
      const ordinal = allDisplays.indexOf(display) + 1;
      const file = path.join(session.dir, shotFileName(session.shots.length + 1, ordinal, displayIds.length));
      try {
        await captureRegion(display.bounds, file);
        const entry = overlays.get(displayId);
        const hasStrokes = await overlayCall(entry, "window.__hasStrokes()");
        if (hasStrokes) {
          const raw = fs.readFileSync(file).toString("base64");
          const composed = await overlayCall(entry, `window.__composite(${JSON.stringify(`data:image/png;base64,${raw}`)})`);
          if (typeof composed === "string" && composed.startsWith("data:image/png;base64,")) {
            fs.writeFileSync(file, Buffer.from(composed.slice("data:image/png;base64,".length), "base64"));
          }
        }
        files.push(file);
      } catch (e) {
        log(`[screen-mode] capture failed display=${displayId}: ${e?.message || e}`);
        if (/could not create image|not permitted|denied/i.test(String(e?.message || ""))) {
          deps.onWarning("screen-recording");
        }
      }
    }
    // A capture that failed (no Screen Recording permission) still closes
    // the batch: the strokes keep their times and places in the record and
    // the transcript, and the screen is cleared as the user asked.
    if (!files.length && !pending.length) return null;
    const shot = recordShot(session, { at, files, reason });
    for (const entry of overlays.values()) {
      entry.ops = [];
      overlayCall(entry, "window.__clear()");
      overlayCall(entry, "window.__flash()");
    }
    writeEvents();
    log(`[screen-mode] shot ${shot.index} reason=${reason} files=${files.length} strokes=${shot.strokeIds.length}`);
    return { index: shot.index, files };
  }

  function writeEvents() {
    if (!session) return;
    lastManifest = screenSessionManifest(session, { displayBoundsById: displayBoundsById() });
    try {
      fs.writeFileSync(path.join(session.dir, SCREEN_MODE.eventsFileName), `${JSON.stringify(lastManifest, null, 2)}\n`);
    } catch (e) {
      log(`[screen-mode] events.json write failed: ${e?.message || e}`);
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────
  async function startNow(id) {
    if (session) return { ok: true, id: session.id };
    if (!isSupported()) return { ok: false, error: "unsupported" };
    const dir = path.join(deps.stagingRoot(), id);
    fs.mkdirSync(dir, { recursive: true });
    session = createScreenSession({ id, dir });
    lastManifest = null;
    try {
      startHelper();
      watchDisplays();
      await Promise.all(screen.getAllDisplays().map((d) => createOverlay(d)));
      await createPalette();
    } catch (e) {
      log(`[screen-mode] start failed: ${e?.message || e}`);
    }
    // Once the overlays exist: main lifts the capsule above them, shows its
    // screen button and binds the screenshot hotkey.
    deps.onActiveChange(true);
    // Without Screen Recording, macOS does not fail a capture: it returns
    // the wallpaper with no windows on it. Say so up front instead of
    // saving screenshots of nothing.
    const captureAccess = typeof deps.screenCaptureAccess === "function" ? deps.screenCaptureAccess() : "granted";
    if (captureAccess === "denied" || captureAccess === "restricted") deps.onWarning("screen-recording");
    refreshLayout();
    writeEvents();
    log(`[screen-mode] started ${id} displays=${overlays.size}`);
    return { ok: true, id };
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
    const wasActive = !!session;
    session = null;
    if (wasActive) deps.onActiveChange(false);
  }

  async function finishNow({ id = "", discard = false } = {}) {
    if (!session) {
      return lastManifest && (!id || lastManifest.id === id)
        ? { ok: true, manifest: lastManifest }
        : { ok: false, error: "no-session" };
    }
    if (id && session.id !== id) return { ok: false, error: "session-mismatch" };
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

  const start = (id) => serialize(() => startNow(id));
  const takeShot = (reason = "button") => serialize(() => takeShotNow(reason));
  const finish = (opts) => serialize(() => finishNow(opts));

  return { isSupported, isActive, start, takeShot, finish, teardown, refreshLayout };
}

module.exports = { createScreenModeController, overlayHtml, paletteHtml, paletteSize };
