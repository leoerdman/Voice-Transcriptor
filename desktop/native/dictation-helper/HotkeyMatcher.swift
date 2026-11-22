// The rule of the hotkey tap (HotkeyTap.swift), kept pure so it can be
// tested without a keyboard: which key events are ours, which pass.
//
// A chord is what an Electron accelerator names — one key plus an exact
// set of modifiers — translated by the shell (desktop/accelerator.js
// macHotkeyChord, the one key-code table). Like Electron's globalShortcut,
// a modifier matches from either side of the keyboard ("Alt" is left or
// right Option): the device-independent flags are compared, never the
// left/right bits, and Caps Lock, Fn and the numeric-pad flag (which macOS
// sets on every arrow key) are ignored.
//
// A press that matches is swallowed and fires once. Its autorepeats and
// its key-up are swallowed too and fire nothing, so holding the hotkey
// never toggles twice and the app underneath never sees half a press.
// Everything else passes untouched.
//
// Tested by desktop/native/tests/hotkey-matcher (driven from
// desktop/dictation-helper.test.js).

import CoreGraphics
import Foundation

struct HotkeyMods: OptionSet, Hashable {
  let rawValue: UInt8
  static let cmd = HotkeyMods(rawValue: 1 << 0)
  static let alt = HotkeyMods(rawValue: 1 << 1)
  static let ctrl = HotkeyMods(rawValue: 1 << 2)
  static let shift = HotkeyMods(rawValue: 1 << 3)

  init(rawValue: UInt8) { self.rawValue = rawValue }

  /// The four modifiers an accelerator can name, from an event's flags.
  init(eventFlags: CGEventFlags) {
    var mods: HotkeyMods = []
    if eventFlags.contains(.maskCommand) { mods.insert(.cmd) }
    if eventFlags.contains(.maskAlternate) { mods.insert(.alt) }
    if eventFlags.contains(.maskControl) { mods.insert(.ctrl) }
    if eventFlags.contains(.maskShift) { mods.insert(.shift) }
    self = mods
  }

  /// The protocol's names ("cmd", "alt", "ctrl", "shift"); nil for any
  /// other name — a chord the helper cannot read is refused, not guessed.
  init?(names: [String]) {
    var mods: HotkeyMods = []
    for name in names {
      switch name {
      case "cmd": mods.insert(.cmd)
      case "alt": mods.insert(.alt)
      case "ctrl": mods.insert(.ctrl)
      case "shift": mods.insert(.shift)
      default: return nil
      }
    }
    self = mods
  }
}

struct HotkeyChord: Equatable {
  /// What the shell calls it ("record", "paste", "screen"); echoed in
  /// the `hotkey` event.
  let id: String
  let keyCode: UInt16
  let mods: HotkeyMods

  /// `[{"chord":"record","keyCode":123,"mods":["alt"]}, …]` → chords; nil
  /// when any entry is malformed, so a half-read table is never armed.
  static func parseList(_ raw: Any?) -> [HotkeyChord]? {
    guard let list = raw as? [[String: Any]] else { return nil }
    var chords: [HotkeyChord] = []
    for entry in list {
      guard let id = entry["chord"] as? String, !id.isEmpty,
            let code = (entry["keyCode"] as? NSNumber)?.intValue, (0...0xFFFF).contains(code),
            let names = entry["mods"] as? [String],
            let mods = HotkeyMods(names: names) else { return nil }
      chords.append(HotkeyChord(id: id, keyCode: UInt16(code), mods: mods))
    }
    return chords
  }
}

enum KeyVerdict: Equatable {
  case pass
  case swallow
  /// Swallowed, and the chord with this id was pressed.
  case fire(String)
}

struct HotkeyMatcher {
  private(set) var chords: [HotkeyChord] = []
  /// Keys whose press was ours: their repeats and key-up are swallowed.
  private var held: Set<UInt16> = []

  /// A new table. Keys already held stay held: their press was swallowed,
  /// so their key-up must be too.
  mutating func setChords(_ chords: [HotkeyChord]) {
    self.chords = chords
  }

  private func match(_ keyCode: UInt16, _ mods: HotkeyMods) -> HotkeyChord? {
    chords.first { $0.keyCode == keyCode && $0.mods == mods }
  }

  mutating func keyDown(keyCode: UInt16, mods: HotkeyMods, autorepeat: Bool) -> KeyVerdict {
    if autorepeat {
      if held.contains(keyCode) { return .swallow }
      // A repeat of a chord whose first press this tap never saw (it was
      // re-enabled mid-hold): ours, but not a new press.
      if match(keyCode, mods) != nil {
        held.insert(keyCode)
        return .swallow
      }
      return .pass
    }
    // A fresh press is judged on its own: a key still marked held lost its
    // key-up (the tap was off), and keeping the mark would swallow the
    // key-up of a press the app did see — a stuck key.
    held.remove(keyCode)
    guard let chord = match(keyCode, mods) else { return .pass }
    held.insert(keyCode)
    return .fire(chord.id)
  }

  mutating func keyUp(keyCode: UInt16) -> KeyVerdict {
    held.remove(keyCode) != nil ? .swallow : .pass
  }
}

// MARK: - When the key went down

/// The press's instant on the uptime clock, in nanoseconds.
///
/// `CGEventGetTimestamp` is documented in nanoseconds but on Apple silicon
/// it carries mach ticks; the unit is decided by plausibility — the press
/// cannot be after the callback that saw it, nor seconds before it. A
/// timestamp that fits neither reading gives the callback's own instant.
func pressInstantNs(
  eventTimestamp: UInt64,
  callbackNs: UInt64,
  ticksToNs: (UInt64) -> UInt64,
  windowNs: UInt64 = 5_000_000_000
) -> (ns: UInt64, clock: String) {
  func plausible(_ ns: UInt64) -> Bool { ns <= callbackNs && callbackNs - ns <= windowNs }
  if eventTimestamp > 0 {
    let asTicks = ticksToNs(eventTimestamp)
    if plausible(asTicks) { return (asTicks, "event") }
    if plausible(eventTimestamp) { return (eventTimestamp, "event") }
  }
  return (callbackNs, "callback")
}
