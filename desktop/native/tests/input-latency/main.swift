// The Core Audio input-latency terms (InputLatency.swift). Built and run by
// desktop/dictation-helper.test.js; prints one "ok <name>" per case and
// exits non-zero on the first failure. Only properties are read — no device
// is opened, no microphone permission is asked.

import CoreAudio
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("FAIL \(message)\n".data(using: .utf8)!)
  exit(1)
}

func run(_ name: String, _ body: () -> Void) {
  body()
  print("ok \(name)")
}

func near(_ a: Double, _ b: Double) -> Bool { abs(a - b) < 0.05 }

run("the built-in microphone's four terms add up to 62.8 ms at 44.1 kHz") {
  let parts = InputLatencyParts(deviceFrames: 13, safetyFrames: 36, bufferFrames: 512, streamFrames: 2210, sampleRate: 44_100)
  if !near(parts.totalMs, 62.8) { fail("got \(parts.totalMs)") }
}

run("the Bluetooth headset's terms add up to 30 ms at 16 kHz") {
  let parts = InputLatencyParts(deviceFrames: 160, safetyFrames: 0, bufferFrames: 320, streamFrames: 0, sampleRate: 16_000)
  if !near(parts.totalMs, 30) { fail("got \(parts.totalMs)") }
}

run("a rate that is not a rate gives no latency") {
  for rate in [0.0, -1.0, Double.nan, Double.infinity] {
    let parts = InputLatencyParts(deviceFrames: 1, safetyFrames: 1, bufferFrames: 1, streamFrames: 1, sampleRate: rate)
    if parts.totalMs != 0 { fail("rate \(rate) gave \(parts.totalMs)") }
  }
}

run("the protocol line carries the name, the transport and the rounded total") {
  let parts = InputLatencyParts(deviceFrames: 13, safetyFrames: 36, bufferFrames: 512, streamFrames: 2210, sampleRate: 44_100)
  let json = InputDeviceLatency(name: "MacBook Pro Microphone", transport: "built-in", parts: parts).json
  if json["name"] as? String != "MacBook Pro Microphone" { fail("name") }
  if json["transport"] as? String != "built-in" { fail("transport") }
  if json["latencyMs"] as? Double != 62.8 { fail("latencyMs \(String(describing: json["latencyMs"]))") }
  if json["streamFrames"] as? Int != 2210 { fail("streamFrames") }
  if (try? JSONSerialization.data(withJSONObject: json)) == nil { fail("not serialisable") }
}

run("transport codes become the words the log shows") {
  if InputLatency.transportName(kAudioDeviceTransportTypeBuiltIn) != "built-in" { fail("built-in") }
  if InputLatency.transportName(kAudioDeviceTransportTypeBluetooth) != "bluetooth" { fail("bluetooth") }
  if InputLatency.transportName(kAudioDeviceTransportTypeBluetoothLE) != "bluetooth" { fail("bluetooth le") }
  if InputLatency.transportName(0) != "other" { fail("other") }
}

run("reading this machine's input devices gives whole, positive figures") {
  // A CI runner may have no microphone at all: an empty list is fine, a
  // device with a nonsense latency is not.
  for device in InputLatency.inputDevices() {
    if device.name.isEmpty { fail("a device without a name") }
    let ms = device.parts.totalMs
    if !(ms > 0 && ms < 5_000) { fail("\(device.name): \(ms) ms") }
  }
}
