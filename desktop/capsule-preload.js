// The recording capsule's bridge to the main process (Ultra-Audit
// 2026-11-20 DM-10, capsule half; the debt item "Preload для капсулы
// статуса" of BUGSAUDIT-2026-09-04 §6).
//
// The capsule used to talk to main by setting document.title to a magic
// prefix that main intercepted in page-title-updated. That channel is
// lossy: Chromium coalesces title changes, and setting the SAME title
// twice fires nothing — so after a stop that did not take (a stale
// stop), a second click on the capsule's stop button produced no event at
// all and the recording could not be stopped from the capsule.
//
// Three verbs, send-only, fixed channels, no payload: the capsule cannot
// name a channel or receive anything back. Main checks that the sender is
// the capsule window's own webContents.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__capsule", {
  /** Stop the recording (the capsule's core was clicked while recording). */
  stop: () => ipcRenderer.send("capsule:stop"),
  /** Screen mode: take a screenshot with the drawings. */
  shot: () => ipcRenderer.send("capsule:shot"),
  /** A pointer went down on the capsule (activate suppression). */
  pointer: () => ipcRenderer.send("capsule:pointer"),
});
