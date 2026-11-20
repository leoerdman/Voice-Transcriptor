"use strict";

// One registrar for IPC channels that answer a single window
// (Ultra-Audit 2026-11-20 DM-28, review item #4).
//
// Every channel the main window's preload exposes answers only that
// window's webContents, and the capsule's three verbs answer only the
// capsule. The rule used to be a first line copied into each handler
// (`if (!isFromMainWindow(event)) return refusedSender(...)`), so a new
// handler was unguarded unless its author remembered the line, and the
// only proof was a test that grepped the 260 characters after each
// channel name. Here the check is not a line a handler writes: a channel
// registered through this registrar cannot reach its handler from any
// other sender, because the registrar is what calls the handler.
//
// Pure: Electron's ipcMain and the sender predicate are injected —
// desktop/ipc-sender-guard.test.js drives it with fakes.

/**
 * @param {{handle: Function, on: Function}} ipcMain Electron's ipcMain (or a fake)
 * @param {{
 *   isAllowedSender: (event: object) => boolean,
 *   onRefused: (channel: string, event: object) => any,
 * }} rules ``onRefused``'s return value is the answer an invoke
 *   (``handle``) channel gives a refused sender; a send-only (``on``)
 *   channel has no answer, so there it is only called.
 * @returns {{handle: (channel: string, handler: Function) => void,
 *            on: (channel: string, listener: Function) => void}}
 */
function createSenderGuardedIpc(ipcMain, { isAllowedSender, onRefused }) {
  if (typeof isAllowedSender !== "function") throw new TypeError("isAllowedSender must be a function");
  if (typeof onRefused !== "function") throw new TypeError("onRefused must be a function");
  return {
    handle(channel, handler) {
      ipcMain.handle(channel, (event, ...args) => {
        if (!isAllowedSender(event)) return onRefused(channel, event);
        return handler(event, ...args);
      });
    },
    on(channel, listener) {
      ipcMain.on(channel, (event, ...args) => {
        if (!isAllowedSender(event)) {
          onRefused(channel, event);
          return;
        }
        listener(event, ...args);
      });
    },
  };
}

module.exports = { createSenderGuardedIpc };
