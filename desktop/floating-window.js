"use strict";

/**
 * Floating windows — the recording capsule and screen mode's overlay and
 * palette — ride above every Space, full-screen apps included, without
 * ever taking the app out of the Dock.
 *
 * Electron's `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`
 * gets a window over full-screen apps by turning the whole process into a
 * UIElement application (the same thing `app.dock.hide()` does). That is
 * what made the Dock lose Transcriptor's running indicator from the moment
 * the capsule was prewarmed, and it is also what hid the main window ~1.5 s
 * after every launch (`[main-window] event=hide reason=os-initiated`).
 *
 * The macOS-native way to float over full-screen apps is an NSPanel with
 * the non-activating style, which Electron builds for `type: "panel"`.
 * Such a window needs no process transformation, so every span call passes
 * `skipTransformProcessType: true` and the process stays a regular,
 * Dock-visible app for its whole life (window-lifecycle Rule 1).
 */

/**
 * BrowserWindow constructor options every floating window spreads in.
 * @param {string} [platform]
 * @returns {{ type?: "panel" }}
 */
function floatingWindowOptions(platform = process.platform) {
  return platform === "darwin" ? { type: "panel" } : {};
}

/**
 * Show `win` on every workspace and over full-screen apps.
 * @param {{ setVisibleOnAllWorkspaces: Function }} win
 */
function spanAllWorkspaces(win) {
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
}

module.exports = { floatingWindowOptions, spanAllWorkspaces };
