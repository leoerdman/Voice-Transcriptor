// The hotkey tap: the shell's record / paste-last / screen-mode hotkeys,
// caught where the key event enters the session instead of through
// Electron's globalShortcut and a round trip into a window.
//
// One CGEventTap (key-down and key-up; an accelerator always names a
// non-modifier key and the modifiers ride on its events, so modifier
// changes are not tapped) on a thread of its own with its own run loop:
// the paste path sleeping on the command queue or the main run loop
// serving NSWorkspace can never make it late. The callback only matches
// (HotkeyMatcher.swift, under a lock) and hands the press to the output
// queue; the press's instant is taken from the event itself, so the shell
// measures from the real key-down.
//
// macOS disables a tap that is slow (`tapDisabledByTimeout`) or when user
// input demands it (`tapDisabledByUserInput`); it is switched straight
// back on and the shell is told, so a tap that will not come back sends
// the shell to globalShortcut. Under Secure Input (a password field,
// Terminal's Secure Keyboard Entry) no tap sees keys while Carbon hotkeys
// still work: the state is watched while the tap is armed and every change
// is reported, and the shell holds the keys through globalShortcut for as
// long as it lasts.

import AppKit
import Carbon
import CoreGraphics
import Foundation

private let ticksToNs: (UInt64) -> UInt64 = {
  var info = mach_timebase_info_data_t()
  mach_timebase_info(&info)
  let numer = UInt64(info.numer), denom = UInt64(max(info.denom, 1))
  return { ticks in
    let (product, overflow) = ticks.multipliedReportingOverflow(by: numer)
    return overflow ? ticks / denom * numer : product / denom
  }
}()

private func hotkeyTapCallback(
  proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
  guard let userInfo = userInfo else { return Unmanaged.passUnretained(event) }
  return Unmanaged<HotkeyTap>.fromOpaque(userInfo).takeUnretainedValue().handle(type, event)
}

final class HotkeyTap {
  static let shared = HotkeyTap()

  /// Guards everything below that both the command side and the tap
  /// thread touch.
  private let lock = NSLock()
  private var matcher = HotkeyMatcher()
  private var armed = false
  private var secureInput = false

  /// Set once, before the tap thread starts; read-only afterwards.
  private var tap: CFMachPort?

  /// Secure Input is polled this often while the tap is armed.
  private let secureInputPollSeconds = 0.25

  /// A `hotkeys` request: arm the tap with `chords`, or disarm it for an
  /// empty table (Settings is capturing a new key, nothing is bound).
  /// Answers the request's fields.
  func configure(_ chords: [HotkeyChord]) -> [String: Any] {
    lock.lock()
    matcher.setChords(chords)
    lock.unlock()
    if chords.isEmpty {
      setArmed(false)
      if let tap = tap { CGEvent.tapEnable(tap: tap, enable: false) }
      return ["active": false, "reason": "no-chords"]
    }
    if tap == nil && !create() {
      return ["active": false, "reason": AXIsProcessTrusted() ? "tap-create-failed" : "not-trusted"]
    }
    guard let tap = tap else { return ["active": false, "reason": "tap-create-failed"] }
    CGEvent.tapEnable(tap: tap, enable: true)
    guard CGEvent.tapIsEnabled(tap: tap) else {
      setArmed(false)
      return ["active": false, "reason": "tap-not-enabled"]
    }
    let secure = IsSecureEventInputEnabled()
    lock.lock()
    armed = true
    secureInput = secure
    lock.unlock()
    return ["active": true, "secureInput": secure]
  }

  private func setArmed(_ value: Bool) {
    lock.lock()
    armed = value
    lock.unlock()
  }

  /// The tap, its run loop source and the thread that runs it. Fails
  /// without Accessibility (the tap swallows events, so it is an active
  /// tap and needs the grant the paste already needs).
  private func create() -> Bool {
    let mask = (CGEventMask(1) << CGEventType.keyDown.rawValue) | (CGEventMask(1) << CGEventType.keyUp.rawValue)
    guard let port = CGEvent.tapCreate(
      tap: .cgSessionEventTap,
      place: .headInsertEventTap,
      options: .defaultTap,
      eventsOfInterest: mask,
      callback: hotkeyTapCallback,
      userInfo: Unmanaged.passUnretained(self).toOpaque()
    ) else { return false }
    tap = port
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
    let started = DispatchSemaphore(value: 0)
    let thread = Thread { [self] in
      let runLoop = CFRunLoopGetCurrent()
      CFRunLoopAddSource(runLoop, source, .commonModes)
      let timer = CFRunLoopTimerCreateWithHandler(
        kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + secureInputPollSeconds, secureInputPollSeconds, 0, 0
      ) { [self] _ in self.pollSecureInput() }
      CFRunLoopTimerSetTolerance(timer, secureInputPollSeconds / 2)
      CFRunLoopAddTimer(runLoop, timer, .commonModes)
      started.signal()
      CFRunLoopRun()
    }
    thread.name = "hotkey-tap"
    thread.qualityOfService = .userInteractive
    thread.start()
    started.wait()
    return true
  }

  /// Runs on the tap thread for every key event. Matches and hands over;
  /// nothing here may block or write.
  fileprivate func handle(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
    switch type {
    case .keyDown, .keyUp:
      break
    case .tapDisabledByTimeout:
      reenable("timeout")
      return Unmanaged.passUnretained(event)
    case .tapDisabledByUserInput:
      reenable("user-input")
      return Unmanaged.passUnretained(event)
    default:
      return Unmanaged.passUnretained(event)
    }
    // Our own ⌘V (Paste.swift) is never a hotkey.
    if event.getIntegerValueField(.eventSourceUserData) == syntheticMarker {
      return Unmanaged.passUnretained(event)
    }
    let callbackTicks = mach_absolute_time()
    let keyCode = UInt16(truncatingIfNeeded: event.getIntegerValueField(.keyboardEventKeycode))
    let verdict: KeyVerdict
    lock.lock()
    if type == .keyDown {
      verdict = matcher.keyDown(
        keyCode: keyCode,
        mods: HotkeyMods(eventFlags: event.flags),
        autorepeat: event.getIntegerValueField(.keyboardEventAutorepeat) != 0
      )
    } else {
      verdict = matcher.keyUp(keyCode: keyCode)
    }
    lock.unlock()
    switch verdict {
    case .pass:
      return Unmanaged.passUnretained(event)
    case .swallow:
      return nil
    case .fire(let id):
      let timestamp = event.timestamp
      emitDeferred {
        let press = pressInstantNs(
          eventTimestamp: timestamp, callbackNs: ticksToNs(callbackTicks), ticksToNs: ticksToNs
        )
        let nowNs = ticksToNs(mach_absolute_time())
        let ageMs = Double(nowNs > press.ns ? nowNs - press.ns : 0) / 1_000_000
        return [
          "t": "hotkey",
          "chord": id,
          "pressedAt": Date().timeIntervalSince1970 * 1000 - ageMs,
          "ageMs": (ageMs * 10).rounded() / 10,
          "clock": press.clock,
        ]
      }
      return nil
    }
  }

  private func reenable(_ reason: String) {
    lock.lock()
    let wanted = armed
    lock.unlock()
    guard wanted, let tap = tap else { return }
    CGEvent.tapEnable(tap: tap, enable: true)
    let back = CGEvent.tapIsEnabled(tap: tap)
    if !back { setArmed(false) }
    emitDeferred { ["t": "tap-disabled", "reason": reason, "reenabled": back] }
  }

  private func pollSecureInput() {
    lock.lock()
    let wanted = armed
    let was = secureInput
    lock.unlock()
    guard wanted else { return }
    let now = IsSecureEventInputEnabled()
    guard now != was else { return }
    lock.lock()
    secureInput = now
    lock.unlock()
    emit(["t": "secure-input", "on": now])
  }
}
