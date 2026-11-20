// Drives PressClassifier through the press sequences a mouse and a
// trackpad really produce. Built and run by desktop/screen-input.test.js;
// prints one "ok <name>" per case and exits non-zero on the first failure.

import CoreGraphics
import Foundation

typealias D = PressClassifier.Decision

func run(_ name: String, controls: [CGRect] = [], _ steps: [(PressClassifier.Kind, Double, Double, D)]) {
  var c = PressClassifier(dragThreshold: 5)
  c.controls = controls
  for (i, step) in steps.enumerated() {
    let got = c.classify(step.0, at: CGPoint(x: step.1, y: step.2))
    if got != step.3 {
      FileHandle.standardError.write("FAIL \(name) step \(i): expected \(step.3), got \(got)\n".data(using: .utf8)!)
      exit(1)
    }
  }
  print("ok \(name)")
}

run("a click is replayed to the app underneath", [
  (.down, 100, 100, .hold),
  (.up, 100, 100, .replayClick),
])

run("a jitter under the threshold is still a click", [
  (.down, 100, 100, .hold),
  (.dragged, 102, 101, .hold),
  (.up, 102, 101, .replayClick),
])

run("press and drag is a stroke from the press point", [
  (.down, 100, 100, .hold),
  (.dragged, 103, 100, .hold),
  (.dragged, 110, 100, .strokeStart(from: CGPoint(x: 100, y: 100))),
  (.dragged, 140, 120, .strokeMove),
  (.up, 150, 120, .strokeEnd),
])

// Trackpad tap-to-click "double-tap and drag": tap (down/up), then a
// second press that is held and moves. The first tap reaches the app as a
// click; the second press draws.
run("double-tap and drag draws", [
  (.down, 200, 200, .hold),
  (.up, 200, 200, .replayClick),
  (.down, 200, 200, .hold),
  (.dragged, 220, 210, .strokeStart(from: CGPoint(x: 200, y: 200))),
  (.dragged, 260, 230, .strokeMove),
  (.up, 260, 230, .strokeEnd),
])

run("a double-click without moving stays two clicks", [
  (.down, 50, 50, .hold),
  (.up, 50, 50, .replayClick),
  (.down, 50, 50, .hold),
  (.up, 50, 50, .replayClick),
])

let capsule = CGRect(x: 600, y: 900, width: 134, height: 30)

// The capsule's screen button, tapped: never delivered through the window
// server (which would activate the app and raise its main window).
run("a press on our own control is a tap delivered in-process", controls: [capsule], [
  (.down, 720, 915, .hold),
  (.up, 720, 915, .tap(at: CGPoint(x: 720, y: 915))),
  (.down, 100, 100, .hold),
  (.up, 100, 100, .replayClick),
])

run("a jitter on a control is still a tap", controls: [capsule], [
  (.down, 720, 915, .hold),
  (.dragged, 722, 916, .hold),
  (.up, 722, 916, .tap(at: CGPoint(x: 720, y: 915))),
])

run("a press that wanders off a control taps nothing", controls: [capsule], [
  (.down, 720, 915, .hold),
  (.dragged, 720, 700, .hold),
  (.up, 720, 700, .hold),
])

run("a drag that ends on a control is still a stroke", controls: [capsule], [
  (.down, 100, 100, .hold),
  (.dragged, 300, 500, .strokeStart(from: CGPoint(x: 100, y: 100))),
  (.dragged, 610, 910, .strokeMove),
  (.up, 610, 910, .strokeEnd),
])

// A trackpad drag whose press this tap never saw as its own (drag lock,
// three-finger drag, a double-tap-drag that starts with the movement).
run("a drag with no press seen still draws, and its release passes on", [
  (.dragged, 300, 300, .strokeStart(from: CGPoint(x: 300, y: 300))),
  (.dragged, 340, 320, .strokeMove),
  (.up, 340, 320, .strokeEndPassingUp),
])

run("a release with no press seen passes", [
  (.up, 1, 1, .pass),
])
