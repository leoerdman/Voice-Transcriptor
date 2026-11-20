// The front window, for a screenshot of what the user is looking at.
//
// Screen mode's shot is the front window of the front app, not the whole
// display with its menu bar and Dock (desktop/screen-mode.js, planShot).
// macOS lists every on-screen window front to back
// (CGWindowListCopyWindowInfo); the front window is the first ordinary
// one (layer 0 — not the menu bar, the Dock, a panel, nor screen mode's
// own overlay, palette and capsule, which sit at the screen-saver level)
// that is visible, big enough to be a window, and not owned by an
// excluded process (Transcriptor itself, this helper). Screen mode never
// activates the app (taps on its controls are delivered in-process), so
// the app the user was working in still owns that first window.
//
// Window bounds are readable without Screen Recording; no window title or
// app name is read — the shot needs a rectangle, nothing else.
//
// Coordinates are global points, top-left origin of the main display —
// the space Electron's `screen` module uses on macOS.

import CoreGraphics
import Foundation

struct ListedWindow {
  let pid: Int
  let layer: Int
  let alpha: Double
  let bounds: CGRect
}

/// The rule: the first (frontmost) listed window that qualifies.
func pickFrontWindow(_ windows: [ListedWindow], excluding: Set<Int>, minSide: Double) -> CGRect? {
  for w in windows {
    if w.layer != 0 || w.alpha <= 0 || excluding.contains(w.pid) { continue }
    if w.bounds.width < minSide || w.bounds.height < minSide { continue }
    return w.bounds
  }
  return nil
}

/// Every on-screen window, front to back, as the rule reads it.
func onScreenWindows() -> [ListedWindow] {
  guard let list = CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
  ) as? [[String: Any]] else { return [] }
  return list.compactMap { info in
    guard let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.intValue,
          let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue,
          let raw = info[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary) else { return nil }
    let alpha = (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
    return ListedWindow(pid: pid, layer: layer, alpha: alpha, bounds: bounds)
  }
}
