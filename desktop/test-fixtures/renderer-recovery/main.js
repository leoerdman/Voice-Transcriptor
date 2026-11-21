"use strict";

// Electron probe for ./window-liveness (run by window-liveness.electron.test.js,
// never shipped). It replays the 2026-11-21 incident against real Chromium:
// a page served by a local HTTP "backend" loses its renderer
// (`forcefullyCrashRenderer`) while the backend is down too; the backend
// comes back; the page must load again and actually paint.
//
// PROBE_NO_RECOVERY=1 skips `watch` — the negative control: the probe must
// then report failure.
//
// PROBE_LATE_BACKEND_EXIT=1 replays the exact order of the incident log:
// the renderer's loss arrives while the state still says "serving", and
// the backend's exit is observed only afterwards.
//
// Prints one line `PROBE {json}` and exits.

const http = require("node:http");
const { app, BrowserWindow } = require("electron");
const { createWindowLiveness } = require("../../window-liveness");
const { createBackendServing, loadWhenServing } = require("../../backend-serving");

const MARK = "rgb(0, 200, 0)";
const PAGE = `<!doctype html><meta charset="utf-8"><title>probe</title>
<body style="margin:0;background:${MARK}"><script>window.__probeEpoch = Date.now();</script></body>`;
const VERDICT_MS = Number(process.env.PROBE_VERDICT_MS || 8000);

const result = { loads: 0, loadsWhileDown: 0, crashed: false, restored: false, painted: false, logs: [] };
function finish(ok, why) {
  process.stdout.write(`PROBE ${JSON.stringify({ ok, why, ...result })}\n`);
  app.exit(ok ? 0 : 1);
}

// The centre pixel of a capture of the window is the page's body colour.
// toBitmap is BGRA; size comes from the bitmap itself (Retina doubles it).
async function paintsMark(win, label) {
  const img = await win.webContents.capturePage();
  const { width, height } = img.getSize();
  const px = img.toBitmap();
  const w = width > 0 ? Math.round(Math.sqrt(px.length / 4 * (width / height))) : 0;
  const h = w > 0 ? Math.round(px.length / 4 / w) : 0;
  const i = (Math.floor(h / 2) * w + Math.floor(w / 2)) * 4;
  const bgra = w > 0 ? [px[i], px[i + 1], px[i + 2], px[i + 3]] : [];
  result.logs.push(`${label}: size=${width}x${height} bitmap=${w}x${h} bgra=${bgra.join(",")}`);
  // Green dominates. Not exact values: macOS converts the page's sRGB into
  // the display's colour profile (rgb(0,200,0) captures as about 90,197,58).
  return w > 0 && bgra[1] > 150 && bgra[1] - bgra[0] > 60 && bgra[1] - bgra[2] > 60;
}

// The probe's /api/health: does the backend answer at all? Polls until it
// does or `timeoutMs` runs out (main uses waitForBackendHealth).
function waitHealthy(url, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get(url, (res) => { res.resume(); resolve(); }).on("error", () => {
        if (Date.now() - started > timeoutMs) reject(new Error("backend did not answer"));
        else setTimeout(tick, 100);
      });
    };
    tick();
  });
}

let server = null;
function startBackend(port) {
  return new Promise((resolve) => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
    });
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}
function stopBackend() {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

app.whenReady().then(async () => {
  const serving = createBackendServing();
  const port = await startBackend(0);
  serving.markServing();
  const url = `http://127.0.0.1:${port}/`;
  let backendUp = true;

  const win = new BrowserWindow({ width: 200, height: 120, x: 0, y: 0, show: true, webPreferences: { sandbox: true } });
  const liveness = createWindowLiveness({ log: (l) => result.logs.push(l), isQuitting: () => false });
  if (process.env.PROBE_NO_RECOVERY !== "1") {
    liveness.watch(win, {
      name: "probe",
      restore: (w) => loadWhenServing({
        serving,
        load: () => w.loadURL(url),
        confirmServing: async () => {
          await waitHealthy(url, 10000);
          serving.markServing();
        },
      }),
    });
  }

  win.webContents.on("did-finish-load", async () => {
    // Chromium's own error page (a load against the closed port) also
    // finishes loading; only our page runs the probe's script.
    let ours = false;
    try { ours = await win.webContents.executeJavaScript("window.__probeEpoch > 0", true); } catch { }
    if (!ours) return;
    result.loads += 1;
    if (!backendUp) result.loadsWhileDown += 1;
    if (!result.crashed) return;
    result.restored = true;
    try {
      // The new page paints: its body colour comes back from a capture of
      // the window, not from the DOM alone.
      await new Promise((r) => setTimeout(r, 300));
      result.painted = await paintsMark(win, "after");
    } catch (e) {
      result.logs.push(`paint check failed: ${e?.message || e}`);
    }
    finish(result.paintedBefore && result.painted && result.loadsWhileDown === 0, result.painted ? "restored-and-painted" : "restored-not-painted");
  });

  await win.loadURL(url);
  await new Promise((r) => setTimeout(r, 300));
  result.paintedBefore = await paintsMark(win, "before");

  // The incident: renderer and backend die together.
  backendUp = false;
  await stopBackend();
  result.crashed = true;
  if (process.env.PROBE_LATE_BACKEND_EXIT === "1") {
    win.webContents.forcefullyCrashRenderer();
    // main hears the backend's exit 50 ms after the renderer's loss.
    setTimeout(() => serving.markDown(), 50);
  } else {
    serving.markDown();
    win.webContents.forcefullyCrashRenderer();
  }

  // The backend restarts a little later, on the same port.
  setTimeout(async () => {
    await startBackend(port);
    backendUp = true;
    serving.markServing();
  }, 1000);

  setTimeout(() => finish(false, "page-not-restored"), VERDICT_MS);
});
