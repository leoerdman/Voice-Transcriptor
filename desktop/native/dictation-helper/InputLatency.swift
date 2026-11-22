// How far behind the room an audio INPUT device's samples arrive — what
// Core Audio itself says about it, which Chromium's `track.getSettings()
// .latency` does not.
//
// Chromium reports the device's callback buffer (2.9 ms for the built-in
// microphone). Core Audio reports four more terms, each in frames of the
// device's own rate (measured 2026-11-23, MacBook Pro Microphone, 44.1 kHz):
//
//   kAudioDevicePropertyLatency      13 frames   the device's own
//   kAudioDevicePropertySafetyOffset 36 frames   how close to "now" the
//                                                driver lets a read go
//   kAudioDevicePropertyBufferFrameSize 512      the delivery buffer
//   kAudioStreamPropertyLatency    2210 frames   the stream's (the
//                                                converter / DSP chain)
//
// 2771 frames — 62.8 ms — against the 2.9 ms Chromium shows. The renderer
// positions a stop's tail by this lag (frontend/src/capture-latency.ts);
// the shorter figure made the tail begin ~60 ms before the press.
//
// Still a lower bound: a Bluetooth headset's radio link and its own DSP are
// in none of these properties (the renderer keeps a floor for them).
//
// Reading properties needs no microphone permission and opens no device.

import CoreAudio
import Foundation

/// The four terms Core Audio exposes, in frames of `sampleRate`.
struct InputLatencyParts {
  var deviceFrames: UInt32
  var safetyFrames: UInt32
  var bufferFrames: UInt32
  var streamFrames: UInt32
  var sampleRate: Double

  /// Their sum in milliseconds; 0 for a rate that is not a rate.
  var totalMs: Double {
    guard sampleRate.isFinite, sampleRate > 0 else { return 0 }
    let frames = Double(deviceFrames) + Double(safetyFrames) + Double(bufferFrames) + Double(streamFrames)
    return frames / sampleRate * 1000
  }
}

/// One input device, as the renderer needs to find its track again: Chromium
/// names a track "<Core Audio name> (<transport>)" and salts the device id,
/// so the name is the only thing both sides can compare.
struct InputDeviceLatency {
  var name: String
  var transport: String
  var parts: InputLatencyParts

  var json: [String: Any] {
    [
      "name": name,
      "transport": transport,
      "latencyMs": (parts.totalMs * 10).rounded() / 10,
      "sampleRate": parts.sampleRate,
      "deviceFrames": Int(parts.deviceFrames),
      "safetyFrames": Int(parts.safetyFrames),
      "bufferFrames": Int(parts.bufferFrames),
      "streamFrames": Int(parts.streamFrames),
    ]
  }
}

enum InputLatency {
  private static func address(
    _ selector: AudioObjectPropertySelector,
    _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
  ) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
  }

  private static func value<T: Numeric>(_ object: AudioObjectID, _ addr: AudioObjectPropertyAddress, _ initial: T) -> T? {
    var addr = addr
    var out = initial
    var size = UInt32(MemoryLayout<T>.size)
    let status = withUnsafeMutablePointer(to: &out) { AudioObjectGetPropertyData(object, &addr, 0, nil, &size, $0) }
    return status == noErr ? out : nil
  }

  private static func ids(_ object: AudioObjectID, _ addr: AudioObjectPropertyAddress) -> [AudioObjectID] {
    var addr = addr
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(object, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
    var list = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &list) == noErr else { return [] }
    return list
  }

  private static func name(_ device: AudioObjectID) -> String? {
    var addr = address(kAudioObjectPropertyName)
    var ref: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &ref) == noErr else { return nil }
    return ref?.takeRetainedValue() as String?
  }

  /// The transport as a word; the renderer matches the name, this is for the log.
  static func transportName(_ code: UInt32) -> String {
    switch code {
    case kAudioDeviceTransportTypeBuiltIn: return "built-in"
    case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "bluetooth"
    case kAudioDeviceTransportTypeUSB: return "usb"
    case kAudioDeviceTransportTypeVirtual: return "virtual"
    case kAudioDeviceTransportTypeAggregate: return "aggregate"
    default: return "other"
    }
  }

  /// Every device with at least one input stream. A device whose terms
  /// cannot be read is left out — "unknown" is not "zero".
  static func inputDevices() -> [InputDeviceLatency] {
    let devices = ids(AudioObjectID(kAudioObjectSystemObject), address(kAudioHardwarePropertyDevices))
    var found: [InputDeviceLatency] = []
    for device in devices {
      let input = kAudioObjectPropertyScopeInput
      let streams = ids(device, address(kAudioDevicePropertyStreams, input))
      guard !streams.isEmpty,
            let label = name(device),
            let rate: Float64 = value(device, address(kAudioDevicePropertyNominalSampleRate), Float64(0)),
            let deviceFrames: UInt32 = value(device, address(kAudioDevicePropertyLatency, input), UInt32(0)),
            let safety: UInt32 = value(device, address(kAudioDevicePropertySafetyOffset, input), UInt32(0)),
            let buffer: UInt32 = value(device, address(kAudioDevicePropertyBufferFrameSize, input), UInt32(0))
      else { continue }
      // The streams' own latencies are alternatives of one device, not a
      // chain: the largest is the one a reader can be held to.
      let streamFrames = streams
        .compactMap { value($0, address(kAudioStreamPropertyLatency), UInt32(0)) as UInt32? }
        .max() ?? 0
      let transport: UInt32 = value(device, address(kAudioDevicePropertyTransportType), UInt32(0)) ?? 0
      let parts = InputLatencyParts(
        deviceFrames: deviceFrames, safetyFrames: safety, bufferFrames: buffer,
        streamFrames: streamFrames, sampleRate: rate
      )
      found.append(InputDeviceLatency(name: label, transport: transportName(transport), parts: parts))
    }
    return found
  }
}
