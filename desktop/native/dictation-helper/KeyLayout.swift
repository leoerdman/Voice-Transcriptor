// Which key the native paste presses for ⌘V.
//
// A virtual key code names a key's position, not its letter: code 9 is
// where V sits on QWERTY, and on Dvorak that position is K — ⌘K, not a
// paste. An app reads ⌘-chords through the keyboard layout's own ⌘ table,
// so the paste presses whatever key that table turns into "v":
//
//   * the layout is the current ASCII-capable one
//     (TISCopyCurrentASCIICapableKeyboardLayoutInputSource): the selected
//     layout when it types Latin, otherwise the last Latin one selected —
//     the one macOS applies key equivalents with while Russian, Greek… is
//     active;
//   * the translation carries the ⌘ modifier state, so a layout whose ⌘
//     table differs from its plain one is read the way apps read it.
//     "Dvorak – QWERTY ⌘" is exactly that (its uchr maps the ⌘ state to the
//     QWERTY table): plain V is code 47, ⌘V is code 9 — and code 9 is what
//     it gets. There is no separate "QWERTY ⌘" property to consult; the
//     layout data itself says it.
//
// Code 9 stays the answer whenever it does give "v" (every QWERTY-family
// layout, Colemak, AZERTY, QWERTZ), and the fallback when nothing does.
//
// The answer is cached and recomputed on the main thread when the
// selected input source changes (TIS calls belong on the main thread);
// the paste, on the command queue, only reads the cache.
//
// Tested by desktop/native/tests/key-layout (driven from
// desktop/dictation-helper.test.js) against the layouts macOS ships.

import Carbon
import Foundation

/// The QWERTY position of V (kVK_ANSI_V): what the paste pressed before
/// layouts were read, and the fallback when a layout gives no "v".
let qwertyVKeyCode: CGKeyCode = 9

/// The key code `layout` (a `kTISPropertyUnicodeKeyLayoutData` blob)
/// turns into `character` under the ⌘ modifier, or nil when no key does.
/// Code 9 wins a tie, so a layout that has V there keeps it.
func keyCode(typing character: String, commandLayout layout: Data, keyboardType: UInt32) -> CGKeyCode? {
  let wanted = character.lowercased()
  // Carbon's modifier state as UCKeyTranslate takes it: (cmdKey >> 8) & 0xFF.
  let commandState = UInt32((cmdKey >> 8) & 0xFF)
  return layout.withUnsafeBytes { raw -> CGKeyCode? in
    guard let base = raw.baseAddress, raw.count > 0 else { return nil }
    let uchr = base.assumingMemoryBound(to: UCKeyboardLayout.self)
    func types(_ code: UInt16) -> Bool {
      var deadKeys: UInt32 = 0
      var length = 0
      var chars = [UniChar](repeating: 0, count: 4)
      let status = UCKeyTranslate(
        uchr, code, UInt16(kUCKeyActionDown), commandState, keyboardType,
        OptionBits(kUCKeyTranslateNoDeadKeysBit), &deadKeys, chars.count, &length, &chars
      )
      return status == noErr && String(utf16CodeUnits: chars, count: length).lowercased() == wanted
    }
    if types(UInt16(qwertyVKeyCode)) { return qwertyVKeyCode }
    // 0…127: the keyboard's keys; above are no real key positions.
    for code in UInt16(0)..<128 where types(code) { return CGKeyCode(code) }
    return nil
  }
}

/// The ⌘-table layout data of an input source, or nil (an input method
/// with no uchr of its own).
func commandLayoutData(_ source: TISInputSource) -> Data? {
  guard let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
  return Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
}

/// The paste key for the current layout, cached between layout changes.
enum PasteKey {
  private static let lock = NSLock()
  private static var cached: (code: CGKeyCode, layout: String)? = nil

  /// The key code ⌘V is pressed with, and the layout it was read from
  /// ("fallback" before the first read or when the layout gave nothing).
  static var current: (code: CGKeyCode, layout: String) {
    lock.lock(); defer { lock.unlock() }
    return cached ?? (qwertyVKeyCode, "fallback")
  }

  /// Reads the current ASCII-capable layout. Main thread only.
  static func refresh() {
    dispatchPrecondition(condition: .onQueue(.main))
    let source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource().takeRetainedValue()
    let id = TISGetInputSourceProperty(source, kTISPropertyInputSourceID)
      .map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? "unknown"
    let code = commandLayoutData(source).flatMap {
      keyCode(typing: "v", commandLayout: $0, keyboardType: UInt32(LMGetKbdType()))
    }
    lock.lock()
    cached = code.map { ($0, id) } ?? (qwertyVKeyCode, "fallback")
    lock.unlock()
  }

  /// Reads the layout now and again whenever the selected input source
  /// changes. Call once, on the main thread, before its run loop starts.
  static func watch() {
    refresh()
    DistributedNotificationCenter.default().addObserver(
      forName: NSNotification.Name(kTISNotifySelectedKeyboardInputSourceChanged as String),
      object: nil,
      queue: .main
    ) { _ in refresh() }
  }
}
