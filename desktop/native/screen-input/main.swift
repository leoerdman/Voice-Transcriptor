// screen-input — the mouse half of screen mode.
//
// Screen mode turns the whole screen into a drawing surface WITHOUT taking
// the screen away from the user: a plain click must still reach whatever
// app is under the cursor, scrolling and hovering must keep working, and
// only a press-and-drag draws. A transparent Electron window cannot make
// that distinction — it either receives the mouse (and blocks every click,
// scroll and hover underneath) or ignores it (and can never see a drag).
//
// This helper sits in front of the window server with a CGEventTap and
// decides per press:
//
//   * left button down  -> held back (swallowed) until we know what it is;
//   * moved < threshold  -> still undecided, keep holding;
//   * button up first    -> it was a CLICK: the held "down" and this "up"
//                           are re-posted, so the app underneath receives
//                           an ordinary click (click count preserved);
//   * moved >= threshold -> it is a STROKE: every drag event is swallowed
//                           and reported on stdout for the overlay to draw.
//
// Presses that start inside an excluded rectangle (the capsule and the
// colour palette — our own controls) are passed through untouched.
// The decision itself is PressClassifier (PressClassifier.swift);
// this file is the event tap and the protocol around it.
//
// Protocol — one JSON object per line.
//   stdin : {"cmd":"exclude","rects":[[x,y,w,h],...]}   global points
//           {"cmd":"quit"}
//   stdout: {"t":"ready"}
//           {"t":"start","x":..,"y":..} {"t":"move","x":..,"y":..} {"t":"end","x":..,"y":..}
//           {"t":"error","code":"tap-unavailable"}            then exit 2
//
// Coordinates are CGEvent global points: top-left origin of the main
// display, the same space Electron's `screen` module uses on macOS.

import CoreGraphics
import Foundation

// What counts as a stroke is decided here and only here
// (PressClassifier.swift): a press that moves this far.
let dragThreshold: Double = 5.0
// Marks the events this helper re-posts so its own tap lets them through.
let syntheticMarker: Int64 = 0x5652_5343  // "VRSC"

final class State {
  let lock = NSLock()
  var classifier = PressClassifier(dragThreshold: dragThreshold)
  var heldDown: CGEvent? = nil
  var tap: CFMachPort? = nil
}

let state = State()
let stdoutLock = NSLock()

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object),
        var line = String(data: data, encoding: .utf8) else { return }
  line += "\n"
  stdoutLock.lock()
  FileHandle.standardOutput.write(line.data(using: .utf8)!)
  stdoutLock.unlock()
}

func emitPoint(_ kind: String, _ p: CGPoint) {
  emit(["t": kind, "x": (p.x * 10).rounded() / 10, "y": (p.y * 10).rounded() / 10])
}

func repost(_ event: CGEvent) {
  event.setIntegerValueField(.eventSourceUserData, value: syntheticMarker)
  event.post(tap: .cgSessionEventTap)
}

let callback: CGEventTapCallBack = { _, type, event, _ in
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if let tap = state.tap { CGEvent.tapEnable(tap: tap, enable: true) }
    return Unmanaged.passUnretained(event)
  }
  if event.getIntegerValueField(.eventSourceUserData) == syntheticMarker {
    return Unmanaged.passUnretained(event)
  }
  let kind: PressClassifier.Kind
  switch type {
  case .leftMouseDown: kind = .down
  case .leftMouseDragged: kind = .dragged
  case .leftMouseUp: kind = .up
  default: return Unmanaged.passUnretained(event)
  }
  let p = event.location
  state.lock.lock()
  let decision = state.classifier.classify(kind, at: p)
  state.lock.unlock()
  switch decision {
  case .pass:
    return Unmanaged.passUnretained(event)
  case .hold:
    if kind == .down { state.heldDown = event.copy() }
    return nil
  case .replayClick:
    // A click: hand the app underneath the press it never saw, then the
    // release, in order, both marked so this tap lets them through.
    if let held = state.heldDown { repost(held) }
    state.heldDown = nil
    if let up = event.copy() { repost(up) }
    return nil
  case .strokeStart(let from):
    state.heldDown = nil
    emitPoint("start", from)
    emitPoint("move", p)
    return nil
  case .strokeMove:
    emitPoint("move", p)
    return nil
  case .strokeEnd:
    emitPoint("end", p)
    return nil
  }
}

let mask: CGEventMask =
  (1 << CGEventType.leftMouseDown.rawValue) |
  (1 << CGEventType.leftMouseDragged.rawValue) |
  (1 << CGEventType.leftMouseUp.rawValue)

guard let tap = CGEvent.tapCreate(
  tap: .cgSessionEventTap,
  place: .headInsertEventTap,
  options: .defaultTap,
  eventsOfInterest: mask,
  callback: callback,
  userInfo: nil
) else {
  emit(["t": "error", "code": "tap-unavailable"])
  exit(2)
}
state.tap = tap

// stdin reader: exclusion rectangles and quit. EOF (the app died or
// closed the pipe) is a quit too — the tap must never outlive its owner,
// or the user's mouse would stay captured.
Thread.detachNewThread {
  while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let cmd = obj["cmd"] as? String else { continue }
    if cmd == "quit" { break }
    if cmd == "exclude", let rects = obj["rects"] as? [[Double]] {
      let parsed = rects.compactMap { r -> CGRect? in
        r.count == 4 ? CGRect(x: r[0], y: r[1], width: r[2], height: r[3]) : nil
      }
      state.lock.lock()
      state.classifier.excluded = parsed
      state.lock.unlock()
    }
  }
  CGEvent.tapEnable(tap: tap, enable: false)
  exit(0)
}

let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
emit(["t": "ready"])
CFRunLoopRun()
