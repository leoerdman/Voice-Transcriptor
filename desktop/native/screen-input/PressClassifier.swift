// The press classifier of screen mode's mouse helper — pure, no CGEvent.
//
// One rule decides what every left-button press is:
//
//   * it starts on one of our own controls (capsule, palette) → PASS:
//     the press, its drags and its release go through untouched;
//   * it ends before moving `dragThreshold` points → CLICK: the held press
//     and the release are replayed, so the app underneath gets an ordinary
//     click (its click count travels with the held event untouched);
//   * it moves `dragThreshold` points while held → STROKE: everything is
//     swallowed and reported for the overlay to draw.
//
// The click count plays no part in the decision. That is what makes a
// trackpad double-tap-and-drag draw: the first tap is a click like any
// other, and the second press — click count 2, button held — is a press
// that moves, so it is a stroke. The same holds for three-finger drag and
// drag lock, which arrive as an ordinary held press followed by drags.
//
// Compiled into the helper (main.swift) and, on its own, into the
// test binary desktop/screen-input.test.js builds.

import CoreGraphics

struct PressClassifier {
  enum Kind { case down, dragged, up }

  enum Decision: Equatable {
    /// Let the event through unchanged.
    case pass
    /// Swallow the event (held press, or a drag under the threshold).
    case hold
    /// Swallow and replay the held press, then this release, as a click.
    case replayClick
    /// Swallow; a stroke began at `from` and continues to the point.
    case strokeStart(from: CGPoint)
    /// Swallow; the stroke continues to the event's point.
    case strokeMove
    /// Swallow; the stroke ends at the event's point.
    case strokeEnd
  }

  let dragThreshold: Double
  var excluded: [CGRect] = []

  private var holding = false
  private var downPoint = CGPoint.zero
  private var drawing = false
  private var passthrough = false

  init(dragThreshold: Double) {
    self.dragThreshold = dragThreshold
  }

  mutating func classify(_ kind: Kind, at p: CGPoint) -> Decision {
    switch kind {
    case .down:
      if excluded.contains(where: { $0.contains(p) }) {
        passthrough = true
        holding = false
        drawing = false
        return .pass
      }
      passthrough = false
      holding = true
      drawing = false
      downPoint = p
      return .hold
    case .dragged:
      if passthrough || !holding { return .pass }
      if drawing { return .strokeMove }
      let dx = p.x - downPoint.x
      let dy = p.y - downPoint.y
      if (dx * dx + dy * dy).squareRoot() < dragThreshold { return .hold }
      drawing = true
      return .strokeStart(from: downPoint)
    case .up:
      if passthrough {
        passthrough = false
        return .pass
      }
      if !holding { return .pass }
      holding = false
      if drawing {
        drawing = false
        return .strokeEnd
      }
      return .replayClick
    }
  }
}
