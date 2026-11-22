// Reads the ⌘V key out of the keyboard layouts macOS ships (KeyLayout.swift
// keyCode(typing:commandLayout:keyboardType:)). Built and run by
// desktop/dictation-helper.test.js; prints one "ok <name>" per case and
// exits non-zero on the first failure. Layouts are looked up among the
// installed ones, enabled or not — nothing about the user's own input
// sources is read or changed.

import Carbon
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("FAIL \(message)\n".data(using: .utf8)!)
  exit(1)
}

func run(_ name: String, _ body: (String) -> Void) {
  body(name)
  print("ok \(name)")
}

func layout(_ id: String) -> Data {
  let filter = [kTISPropertyInputSourceID as String: id] as CFDictionary
  guard let list = TISCreateInputSourceList(filter, true)?.takeRetainedValue() as? [TISInputSource],
        let source = list.first else { fail("\(id) is not installed") }
  guard let data = commandLayoutData(source) else { fail("\(id) has no layout data") }
  return data
}

let keyboard = UInt32(LMGetKbdType())

func expectV(_ id: String, _ code: CGKeyCode, _ name: String) {
  let found = keyCode(typing: "v", commandLayout: layout(id), keyboardType: keyboard)
  if found != code { fail("\(name): \(id) gave \(String(describing: found)), expected \(code)") }
}

run("QWERTY-family layouts keep V at code 9") { name in
  for id in ["com.apple.keylayout.US", "com.apple.keylayout.ABC", "com.apple.keylayout.German",
             "com.apple.keylayout.French", "com.apple.keylayout.Colemak"] {
    expectV(id, 9, name)
  }
}

run("Dvorak presses the key its layout calls V") { name in
  expectV("com.apple.keylayout.Dvorak", 47, name)
}

run("Dvorak – QWERTY ⌘ reads its ⌘ table: V stays at code 9") { name in
  expectV("com.apple.keylayout.DVORAK-QWERTYCMD", 9, name)
}

run("no layout data gives no key") { name in
  if keyCode(typing: "v", commandLayout: Data(), keyboardType: keyboard) != nil { fail("\(name): empty data matched") }
}

run("the paste key falls back to code 9 before the layout is read") { name in
  let key = PasteKey.current
  if key.code != qwertyVKeyCode || key.layout != "fallback" { fail("\(name): \(key)") }
}

run("reading the current layout gives a real key from it") { name in
  PasteKey.refresh()
  let key = PasteKey.current
  if key.code >= 128 || key.layout == "fallback" { fail("\(name): \(key)") }
}
