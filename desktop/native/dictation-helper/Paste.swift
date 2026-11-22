// The native paste: the general pasteboard, the frontmost app, the user's
// modifier keys, ⌘V through CGEventPost and the accessibility read that
// verifies it where the target exposes one.
//
// It replaces, per paste, a JXA process that polled the modifier flags
// (~240 ms to start) and an osascript "key code 9" / Edit › Paste (~157 ms)
// — the shell keeps those as its fallback (desktop/main.js).

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// MARK: - Pasteboard

/// The pasteboard reads and writes the paste needs. The helper uses the
/// general pasteboard (`systemPasteboard`); the tests use a private named
/// one, so a round trip is checked without touching the user's clipboard.
struct PasteboardIO {
  let board: NSPasteboard

  var changeCount: Int { board.changeCount }

  func snapshot() -> PasteboardSnapshot {
    let count = board.changeCount
    let items = (board.pasteboardItems ?? []).map { item -> PasteboardSnapshot.Item in
      PasteboardSnapshot.Item(entries: item.types.compactMap { type in
        item.data(forType: type).map { PasteboardSnapshot.Entry(type: type.rawValue, data: $0) }
      })
    }
    return PasteboardSnapshot(items: items, changeCount: count)
  }

  /// Puts a snapshot back exactly: an empty one clears the pasteboard.
  @discardableResult
  func write(_ snapshot: PasteboardSnapshot) -> Bool {
    board.clearContents()
    let items = snapshot.items.compactMap { saved -> NSPasteboardItem? in
      guard !saved.entries.isEmpty else { return nil }
      let item = NSPasteboardItem()
      for entry in saved.entries {
        item.setData(entry.data, forType: NSPasteboard.PasteboardType(entry.type))
      }
      return item
    }
    return items.isEmpty ? true : board.writeObjects(items)
  }

  /// The transcript, as plain text; returns the count the write made.
  func writeText(_ text: String) -> Int? {
    board.clearContents()
    guard board.setString(text, forType: .string) else { return nil }
    return board.changeCount
  }
}

let systemPasteboard = PasteboardIO(board: NSPasteboard.general)

// MARK: - Frontmost app

struct FrontApp {
  var pid: Int32
  var bundleId: String
  var name: String

  var json: [String: Any] { ["pid": Int(pid), "bundleId": bundleId, "name": name] }

  /// LaunchServices' front app, kept current by the main run loop the
  /// helper runs (NSWorkspace updates it from its notifications).
  static func current() -> FrontApp? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    return FrontApp(
      pid: app.processIdentifier,
      bundleId: app.bundleIdentifier ?? "",
      name: app.localizedName ?? ""
    )
  }
}

// MARK: - Permissions

/// Accessibility is what CGEventPost into another app and an active
/// keyboard tap both need. Read once and again when the shell asks (its
/// capability probe), never per paste — except while it is missing, when
/// a paste re-reads it so a grant made a second ago is used at once.
enum Permissions {
  private static let lock = NSLock()
  private static var cachedPost: Bool? = nil

  static func refresh() -> [String: Any] {
    let post = CGPreflightPostEventAccess()
    lock.lock(); cachedPost = post; lock.unlock()
    return [
      "accessibility": AXIsProcessTrusted(),
      "postEvents": post,
      "listenEvents": CGPreflightListenEventAccess(),
    ]
  }

  static var canPost: Bool {
    lock.lock()
    let cached = cachedPost
    lock.unlock()
    if cached == true { return true }
    return refresh()["postEvents"] as? Bool ?? false
  }
}

// MARK: - Modifier keys

let modifierMask: CGEventFlags = [.maskCommand, .maskAlternate, .maskControl, .maskShift, .maskSecondaryFn]

/// Waits until the user's own modifier keys are up (the paste-last hotkey
/// fires while its chord is still held, and ⌘V would reach the target as
/// ⌘⌥⇧V), polling the combined session state; gives up at the deadline and
/// pastes anyway — a stuck flag must not swallow the transcript.
func awaitModifierRelease(deadlineMs: Int, pollMs: Int) -> (cleared: Bool, flags: UInt64, waitedMs: Int) {
  let started = DispatchTime.now().uptimeNanoseconds
  let interval = UInt32(max(1, pollMs)) * 1000
  while true {
    let flags = CGEventSource.flagsState(.combinedSessionState).intersection(modifierMask)
    let waited = Int((DispatchTime.now().uptimeNanoseconds - started) / 1_000_000)
    if flags.isEmpty { return (true, 0, waited) }
    if waited >= deadlineMs { return (false, flags.rawValue, waited) }
    usleep(interval)
  }
}

// MARK: - ⌘V

let commandKeyCode: CGKeyCode = 55

/// ⌘V as four events — ⌘ down, V down, V up, ⌘ up — from a private event
/// source, so the user's physical keys never leak into their flags, each
/// marked as ours so the helper's own keyboard tap lets it through.
/// `vKey` is the key the current layout reads as ⌘V (KeyLayout.swift
/// PasteKey); the AppleScript fallback, with no layout to read, presses
/// the QWERTY position `key code 9`.
func postCommandV(vKey: CGKeyCode, gapMs: Int) -> Bool {
  let source = CGEventSource(stateID: .privateState)
  let specs: [(CGKeyCode, Bool, CGEventFlags)] = [
    (commandKeyCode, true, .maskCommand),
    (vKey, true, .maskCommand),
    (vKey, false, .maskCommand),
    (commandKeyCode, false, []),
  ]
  var events: [CGEvent] = []
  for (key, down, flags) in specs {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down) else { return false }
    event.flags = flags
    event.setIntegerValueField(.eventSourceUserData, value: syntheticMarker)
    events.append(event)
  }
  for (index, event) in events.enumerated() {
    if index > 0 && gapMs > 0 { usleep(UInt32(gapMs) * 1000) }
    event.post(tap: .cghidEventTap)
  }
  return true
}

// MARK: - Verification

/// The focused element's text length, in UTF-16 units (what AX counts),
/// or nil when the target exposes none. Each AX call is bounded at
/// 0.25 s: an app whose accessibility hangs must not hold the paste.
func focusedTextLength() -> Int? {
  let system = AXUIElementCreateSystemWide()
  AXUIElementSetMessagingTimeout(system, 0.25)
  var focused: CFTypeRef?
  guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
        let element = focused, CFGetTypeID(element) == AXUIElementGetTypeID() else { return nil }
  let field = element as! AXUIElement
  AXUIElementSetMessagingTimeout(field, 0.25)
  var count: CFTypeRef?
  if AXUIElementCopyAttributeValue(field, kAXNumberOfCharactersAttribute as CFString, &count) == .success,
     let number = count as? NSNumber {
    return number.intValue
  }
  var value: CFTypeRef?
  if AXUIElementCopyAttributeValue(field, kAXValueAttribute as CFString, &value) == .success,
     let text = value as? String {
    return (text as NSString).length
  }
  return nil
}

/// After the chord: did the focused element grow by exactly the pasted
/// length? The chord is delivered asynchronously, so the length is polled
/// for a short while instead of read once.
func awaitPasteGrowth(before: Int, expected: Int, pollMs: Int, polls: Int) -> (verdict: String, after: Int?) {
  var after: Int? = nil
  for attempt in 0..<max(1, polls) {
    if attempt > 0 { usleep(UInt32(max(1, pollMs)) * 1000) }
    after = focusedTextLength()
    guard let now = after else { return ("unreadable", nil) }
    if now - before == expected { return ("verified", now) }
  }
  return ("unverified", after)
}
