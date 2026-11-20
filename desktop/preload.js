const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("__transcriptorFilePathForFile", (file) => {
  try {
    if (!file || typeof webUtils?.getPathForFile !== "function") return "";
    return String(webUtils.getPathForFile(file) || "");
  } catch {
    return "";
  }
});

// Engine lifecycle bridge (Settings → Local models → "Install engine").
// Invoke-only surface: the renderer can query the install state machine
// and request an install; everything else (gates, progress phases,
// backend restart) is owned by the main process. No raw ipcRenderer and
// no arbitrary channels are exposed.
contextBridge.exposeInMainWorld("__transcriptorEngine", {
  getStatus: () => ipcRenderer.invoke("engine:get-status"),
  install: () => ipcRenderer.invoke("engine:install"),
});

// Accessibility/paste-capability bridge (D-009). Same invoke-only shape
// as the engine bridge above: `getStatus()` resolves
// `{ state, repairable, title, fix }` — `state` is one of "unknown" /
// "untrusted" / "active" / "broken" (desktop/paste-capability.js), and
// `title`/`fix` are non-empty exactly when there is something the user
// can act on (empty for "active"/"unknown", so an idle renderer badge
// can hide on an empty `fix` without inspecting `state` itself).
//
// `repair()` is the one action behind that note: macOS keys a permission
// grant to the code signature that asked for it, so a rebuild can leave
// the row switched on in System Settings and refused in practice. Main
// drops the row (`tccutil reset`) so macOS asks again, re-probes, and
// resolves the new state in the same shape. The renderer names no
// service, no bundle id and no command — it asks for a repair and is
// told what the state became.
contextBridge.exposeInMainWorld("__transcriptorPasteCapability", {
  getStatus: () => ipcRenderer.invoke("paste-capability:get-status"),
  repair: () => ipcRenderer.invoke("permissions:repair"),
});

// Transcript hand-off bridge (BUGS_AUDIT_2026-09-03 §6.7/§6.8).
//
// The renderer knows the instant a recording's text exists; the main
// process used to find out by injecting `executeJavaScript` into the
// renderer every 30 ms for up to 32 s — hundreds of synchronous
// evaluations landing exactly while the renderer finalizes Deepgram and
// runs the paste upscale. It now says so once, when it happens:
//
//   window.transcriptor.recordingFinal({
//     recordingId,          // the renderer's monotonic recording id
//     text,                 // best-known text (false) / paste-ready text (true)
//     final,                // true ONLY for the paste-ready text
//     source,               // free-form label, trace log only
//   })
//
// `final:false` is published with the status-only output (pre-upscale
// text — never pasted, §6.8) and is kept as the best-known text for the
// deadline-expiry recovery (§6.9). `final:true` is published at the one
// site that produces paste-ready text.
//
// Send-only, one fixed channel, no raw ipcRenderer: the renderer cannot
// name a channel or receive anything back. Payload fields are copied
// onto a fresh plain object so a renderer-side getter or exotic value
// cannot ride along, and the whole call is swallowed on failure — this
// runs on the renderer's own finalization path, which must not break
// because an IPC clone was refused. The main process validates the
// shape it receives (desktop/recording-final-slot.js); nothing here
// judges the payload, so there is only one definition of "well formed".
// The renderer also needs to hear ONE thing from main: that the machine
// is going to sleep or lock. It keeps a microphone capture warm for a
// while after a recording (UI_TOKENS.capture.warmHoldMs) so the next one
// starts without a getUserMedia round trip, and a warm capture carried
// across a suspend comes back attached to a device that may not exist
// any more. powerMonitor is a main-process API, so main is the only one
// that can say it — see notifyRendererSystemSuspend in desktop/main.js,
// which sends on both "suspend" and "lock-screen".
//
// Same shape rules as the send side: one fixed channel, no raw
// ipcRenderer, and the payload is copied onto a fresh plain object so
// the renderer never touches the IPC event itself.
contextBridge.exposeInMainWorld("transcriptor", {
  /**
   * Subscribe to "the system is suspending or locking".
   *
   *   const off = window.transcriptor.onSystemSuspend(({ reason }) => …)
   *
   * `reason` is "suspend" or "lock-screen". Returns an unsubscribe
   * function; calling it twice is harmless. A listener that throws is
   * swallowed — this runs on a power event, which must not be broken by
   * one bad subscriber.
   */
  onSystemSuspend: (callback) => {
    if (typeof callback !== "function") return () => { };
    const listener = (_event, payload) => {
      try {
        const p = payload && typeof payload === "object" ? payload : {};
        callback({ reason: String(p.reason || "") });
      } catch {
        // A subscriber's failure is not the power event's problem.
      }
    };
    ipcRenderer.on("system-suspend", listener);
    return () => {
      try {
        ipcRenderer.removeListener("system-suspend", listener);
      } catch {
        // Already removed, or the bridge is torn down.
      }
    };
  },
  recordingFinal: (payload) => {
    try {
      const p = payload && typeof payload === "object" ? payload : {};
      ipcRenderer.send("recording-final", {
        recordingId: p.recordingId,
        text: p.text,
        final: p.final,
        source: p.source,
      });
      return true;
    } catch {
      return false;
    }
  },
  /**
   * End the screen-mode side of a recording that is stopping:
   *
   *   const { ok, manifest } = await window.transcriptor.screenFinish({ id, discard })
   *
   * Main takes a last screenshot if strokes are still on screen, removes
   * the overlays and returns the session manifest (screenshots + stroke
   * events with epoch times) the renderer turns into transcript marks.
   * `discard` drops the session's files — the take itself was discarded.
   */
  screenFinish: (payload) => {
    const p = payload && typeof payload === "object" ? payload : {};
    return ipcRenderer.invoke("screen-mode:finish", {
      id: String(p.id || ""),
      discard: p.discard === true,
    });
  },
});
