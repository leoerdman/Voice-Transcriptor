// Drives pickFrontWindow (FrontWindow.swift) through the window lists macOS
// hands it. Built and run by desktop/screen-input.test.js; prints one
// "ok <name>" per case and exits non-zero on the first failure.

import CoreGraphics
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("FAIL \(message)\n".data(using: .utf8)!)
  exit(1)
}

let ours = 100
let app = 200
let other = 300

func w(_ pid: Int, layer: Int = 0, alpha: Double = 1, _ x: Double, _ y: Double, _ width: Double, _ height: Double) -> ListedWindow {
  ListedWindow(pid: pid, layer: layer, alpha: alpha, bounds: CGRect(x: x, y: y, width: width, height: height))
}

func check(_ name: String, _ windows: [ListedWindow], _ expected: CGRect?) {
  let got = pickFrontWindow(windows, excluding: [ours], minSide: 40)
  if got != expected { fail("\(name): expected \(String(describing: expected)), got \(String(describing: got))") }
  print("ok \(name)")
}

check("the frontmost ordinary window is the front window", [
  w(app, 100, 80, 1000, 700),
  w(other, 0, 0, 1728, 1117),
], CGRect(x: 100, y: 80, width: 1000, height: 700))

check("screen mode's own overlay, palette and capsule are never it", [
  w(ours, layer: 1000, 0, 0, 1728, 1117),
  w(ours, layer: 1000, 800, 1000, 120, 30),
  w(app, 100, 80, 1000, 700),
], CGRect(x: 100, y: 80, width: 1000, height: 700))

check("Transcriptor's own ordinary window is skipped too", [
  w(ours, 0, 0, 900, 600),
  w(app, 100, 80, 1000, 700),
], CGRect(x: 100, y: 80, width: 1000, height: 700))

check("the menu bar, the Dock and panels are not windows to capture", [
  w(other, layer: 24, 0, 0, 1728, 25),
  w(other, layer: 20, 400, 1050, 900, 67),
  w(other, layer: 3, 50, 50, 300, 300),
  w(app, 100, 80, 1000, 700),
], CGRect(x: 100, y: 80, width: 1000, height: 700))

check("an invisible or tiny window is passed over", [
  w(other, alpha: 0, 0, 0, 1728, 1117),
  w(other, 10, 10, 20, 20),
  w(app, 100, 80, 1000, 700),
], CGRect(x: 100, y: 80, width: 1000, height: 700))

check("no window at all is no front window", [
  w(ours, layer: 1000, 0, 0, 1728, 1117),
], nil)
