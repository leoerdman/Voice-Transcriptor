// The press classifier of screen mode's mouse helper — pure, no CGEvent.
//
// One rule decides what every left-button press is:
//
//   * it starts on one of our own controls (capsule, palette) → TAP: the
//     press and its release are swallowed and reported as a tap at the
//     press point; the app clicks the control inside its own page. The
//     window server never delivers a click to our windows, so macOS never
//     activates Transcriptor and never raises its main window — which a
//     click it delivers to ANY window of an inactive app does, panel or
//     not (measured 2026-11-20: `type: "panel"` did not prevent it);
//   * it ends before moving `dragThreshold` points → CLICK: the held press
//     and the release are replayed, so the app underneath gets an ordinary
//     click (its click count travels with the held event untouched);
//   * it moves `dragThreshold` points while held → STROKE: everything is
//     swallowed and reported for the overlay to draw;
//   * a drag arrives with no press this tap held → STROKE all the same.
//     A drag means the button is down, whatever produced the press: a
//     trackpad's double-tap-and-drag, drag lock or three-finger drag can
//     start the movement without a press this tap saw as its own. Its
//     release is swallowed AND passed on (`strokeEndPassingUp`): an app
//     that saw a press must see it end, and one that did not ignores a
//     stray release.
//
// The click count plays no part in the decision, so a double-tap-and-drag
// whose second press this tap does see is a press that moves: a stroke.
//
// Compiled into the helper (main.swift) and, on its own, into the test
// binary desktop/screen-input.test.js builds.

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
    /// The stroke ends at the event's point; the release is passed on.
    case strokeEndPassingUp
    /// Swallow; one of our controls was tapped at `at`.
    case tap(at: CGPoint)
  }

  /// What the last finished press was, for the helper's one log line.
  enum Outcome: String { case click, stroke, tap, controlDrag, orphanStroke }

  let dragThreshold: Double
  var controls: [CGRect] = []

  private enum Phase { case idle, held, drawing, onControl, orphanDrawing }
  private var phase: Phase = .idle
  private var downPoint = CGPoint.zero
  private var controlMoved = false
  private(set) var lastOutcome: Outcome? = nil
  private(set) var drags = 0

  init(dragThreshold: Double) {
    self.dragThreshold = dragThreshold
  }

  private func farFromDown(_ p: CGPoint) -> Bool {
    let dx = p.x - downPoint.x
    let dy = p.y - downPoint.y
    return (dx * dx + dy * dy).squareRoot() >= dragThreshold
  }

  mutating func classify(_ kind: Kind, at p: CGPoint) -> Decision {
    switch kind {
    case .down:
      downPoint = p
      drags = 0
      controlMoved = false
      lastOutcome = nil
      phase = controls.contains(where: { $0.contains(p) }) ? .onControl : .held
      return .hold
    case .dragged:
      drags += 1
      switch phase {
      case .onControl:
        if farFromDown(p) { controlMoved = true }
        return .hold
      case .held:
        if !farFromDown(p) { return .hold }
        phase = .drawing
        return .strokeStart(from: downPoint)
      case .drawing, .orphanDrawing:
        return .strokeMove
      case .idle:
        phase = .orphanDrawing
        return .strokeStart(from: p)
      }
    case .up:
      let was = phase
      phase = .idle
      switch was {
      case .onControl:
        // A press that wandered off a control is not a tap on it.
        lastOutcome = controlMoved ? .controlDrag : .tap
        return controlMoved ? .hold : .tap(at: downPoint)
      case .held:
        lastOutcome = .click
        return .replayClick
      case .drawing:
        lastOutcome = .stroke
        return .strokeEnd
      case .orphanDrawing:
        lastOutcome = .orphanStroke
        return .strokeEndPassingUp
      case .idle:
        return .pass
      }
    }
  }
}
