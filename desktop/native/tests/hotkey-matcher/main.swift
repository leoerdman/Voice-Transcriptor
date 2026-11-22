// Drives HotkeyMatcher through the key sequences a keyboard produces, and
// pressInstantNs through both timestamp units. Built and run by
// desktop/dictation-helper.test.js; prints one "ok <name>" per case and
// exits non-zero on the first failure.

import CoreGraphics
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("FAIL \(message)\n".data(using: .utf8)!)
  exit(1)
}

func expect(_ condition: Bool, _ name: String, _ what: String) {
  if !condition { fail("\(name): \(what)") }
}

func run(_ name: String, _ body: (String) -> Void) {
  body(name)
  print("ok \(name)")
}

// kVK_LeftArrow, kVK_RightArrow, kVK_ANSI_V, kVK_ANSI_A
let left: UInt16 = 0x7B, right: UInt16 = 0x7C, keyV: UInt16 = 0x09, keyA: UInt16 = 0x00
// The left/right device bits macOS sets beside the generic flag.
let rightOption = CGEventFlags(rawValue: 0x40), leftOption = CGEventFlags(rawValue: 0x20)

func table() -> HotkeyMatcher {
  var matcher = HotkeyMatcher()
  matcher.setChords([
    HotkeyChord(id: "record", keyCode: left, mods: [.alt]),
    HotkeyChord(id: "screen", keyCode: right, mods: [.alt]),
    HotkeyChord(id: "paste", keyCode: keyV, mods: [.alt, .shift]),
  ])
  return matcher
}

run("a chord fires once and its key-up is swallowed") { name in
  var m = table()
  expect(m.keyDown(keyCode: left, mods: [.alt], autorepeat: false) == .fire("record"), name, "down")
  expect(m.keyUp(keyCode: left) == .swallow, name, "up")
  expect(m.keyUp(keyCode: left) == .pass, name, "a second up is not ours")
}

run("modifiers must match exactly") { name in
  var m = table()
  expect(m.keyDown(keyCode: left, mods: [], autorepeat: false) == .pass, name, "bare Left")
  expect(m.keyUp(keyCode: left) == .pass, name, "bare Left up")
  expect(m.keyDown(keyCode: left, mods: [.alt, .shift], autorepeat: false) == .pass, name, "Alt+Shift+Left")
  expect(m.keyDown(keyCode: left, mods: [.alt, .cmd], autorepeat: false) == .pass, name, "Cmd+Alt+Left")
  expect(m.keyDown(keyCode: keyV, mods: [.alt], autorepeat: false) == .pass, name, "Alt+V without Shift")
  expect(m.keyDown(keyCode: keyV, mods: [.shift, .alt], autorepeat: false) == .fire("paste"), name, "Alt+Shift+V")
}

run("holding the chord never fires twice") { name in
  var m = table()
  expect(m.keyDown(keyCode: left, mods: [.alt], autorepeat: false) == .fire("record"), name, "down")
  for _ in 0..<5 {
    expect(m.keyDown(keyCode: left, mods: [.alt], autorepeat: true) == .swallow, name, "repeat")
  }
  // Option let go first: the key is still ours until it comes up.
  expect(m.keyDown(keyCode: left, mods: [], autorepeat: true) == .swallow, name, "repeat after Option up")
  expect(m.keyUp(keyCode: left) == .swallow, name, "up")
}

run("a repeat of a press the tap never saw is swallowed but does not fire") { name in
  var m = table()
  expect(m.keyDown(keyCode: left, mods: [.alt], autorepeat: true) == .swallow, name, "repeat")
  expect(m.keyUp(keyCode: left) == .swallow, name, "up")
}

run("other keys and their repeats pass untouched") { name in
  var m = table()
  expect(m.keyDown(keyCode: keyA, mods: [.alt], autorepeat: false) == .pass, name, "Alt+A")
  expect(m.keyDown(keyCode: keyA, mods: [.alt], autorepeat: true) == .pass, name, "Alt+A repeat")
  expect(m.keyUp(keyCode: keyA) == .pass, name, "Alt+A up")
  expect(m.keyDown(keyCode: left, mods: [], autorepeat: true) == .pass, name, "bare Left repeat")
}

run("a lost key-up never makes the next ordinary press stick") { name in
  var m = table()
  expect(m.keyDown(keyCode: left, mods: [.alt], autorepeat: false) == .fire("record"), name, "down")
  // The key-up went by while the tap was off; now a plain Left.
  expect(m.keyDown(keyCode: left, mods: [], autorepeat: false) == .pass, name, "plain down")
  expect(m.keyUp(keyCode: left) == .pass, name, "its up reaches the app too")
}

run("either Option key is Alt, as in an Electron accelerator") { name in
  var m = table()
  let viaRight = HotkeyMods(eventFlags: [.maskAlternate, rightOption])
  let viaLeft = HotkeyMods(eventFlags: [.maskAlternate, leftOption])
  expect(viaRight == [.alt] && viaLeft == [.alt], name, "mods \(viaRight) \(viaLeft)")
  expect(m.keyDown(keyCode: right, mods: viaRight, autorepeat: false) == .fire("screen"), name, "right Option")
  expect(m.keyUp(keyCode: right) == .swallow, name, "up")
  expect(m.keyDown(keyCode: right, mods: viaLeft, autorepeat: false) == .fire("screen"), name, "left Option")
}

run("Fn, the numeric-pad flag and Caps Lock do not count as modifiers") { name in
  let arrow = HotkeyMods(eventFlags: [.maskAlternate, .maskSecondaryFn, .maskNumericPad, .maskAlphaShift])
  expect(arrow == [.alt], name, "mods \(arrow)")
  let all = HotkeyMods(eventFlags: [.maskCommand, .maskControl, .maskShift, .maskAlternate])
  expect(all == [.cmd, .ctrl, .shift, .alt], name, "mods \(all)")
}

run("a new table keeps a held key's key-up swallowed") { name in
  var m = table()
  expect(m.keyDown(keyCode: left, mods: [.alt], autorepeat: false) == .fire("record"), name, "down")
  m.setChords([])
  expect(m.keyDown(keyCode: left, mods: [.alt], autorepeat: true) == .swallow, name, "repeat")
  expect(m.keyUp(keyCode: left) == .swallow, name, "up")
  expect(m.keyDown(keyCode: left, mods: [.alt], autorepeat: false) == .pass, name, "an empty table passes all")
}

run("the protocol's chord list is read whole or refused") { name in
  let good = HotkeyChord.parseList([
    ["chord": "record", "keyCode": 123, "mods": ["alt"]],
    ["chord": "paste", "keyCode": 9, "mods": ["alt", "shift"]],
  ])
  expect(good == [
    HotkeyChord(id: "record", keyCode: 123, mods: [.alt]),
    HotkeyChord(id: "paste", keyCode: 9, mods: [.alt, .shift]),
  ], name, "parsed \(String(describing: good))")
  expect(HotkeyChord.parseList([]) == [], name, "empty table")
  expect(HotkeyChord.parseList([["chord": "record", "keyCode": 123, "mods": ["hyper"]]]) == nil, name, "unknown mod")
  expect(HotkeyChord.parseList([["chord": "record", "mods": ["alt"]]]) == nil, name, "no key code")
  expect(HotkeyChord.parseList("record") == nil, name, "not a list")
}

run("the press instant reads the event timestamp in either unit") { name in
  // Apple silicon: 125/3 ns per tick.
  let toNs: (UInt64) -> UInt64 = { $0 * 125 / 3 }
  let callbackNs: UInt64 = 1_000_000_000_000
  let pressNs = callbackNs - 7_000_000
  let asTicks = pressInstantNs(eventTimestamp: pressNs * 3 / 125, callbackNs: callbackNs, ticksToNs: toNs)
  expect(asTicks.clock == "event" && callbackNs - asTicks.ns < 8_000_000 && asTicks.ns <= callbackNs, name, "ticks \(asTicks)")
  let asNs = pressInstantNs(eventTimestamp: pressNs, callbackNs: callbackNs, ticksToNs: toNs)
  expect(asNs == (pressNs, "event"), name, "ns \(asNs)")
  let future = pressInstantNs(eventTimestamp: callbackNs + 1, callbackNs: callbackNs, ticksToNs: { $0 })
  expect(future == (callbackNs, "callback"), name, "future \(future)")
  let none = pressInstantNs(eventTimestamp: 0, callbackNs: callbackNs, ticksToNs: toNs)
  expect(none == (callbackNs, "callback"), name, "zero \(none)")
  let stale = pressInstantNs(eventTimestamp: callbackNs - 60_000_000_000, callbackNs: callbackNs, ticksToNs: { $0 })
  expect(stale == (callbackNs, "callback"), name, "stale \(stale)")
}
