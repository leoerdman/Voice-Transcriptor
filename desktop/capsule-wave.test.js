"use strict";

// The capsule's waveform, run for real: the page main.js serves to the
// capsule window is built from main.js's own source and its script is
// executed against a recording canvas. What the user sees in the first
// frames of a take is asserted on the draw calls, not on the source text.
//
// User, 2026-11-20: "the thinnest red line must run at once when I start
// recording, even if I say nothing". A silent level gave bars of height 0,
// which drew nothing at all until speech arrived.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const { mainSource, topLevelFunctionSource } = require("./main-source");

function capsuleTokensSource() {
  const start = mainSource.indexOf("const RECORDING_STATUS_CAPSULE = ");
  const end = mainSource.indexOf("\n})());", start);
  assert.ok(start >= 0 && end > start, "RECORDING_STATUS_CAPSULE is declared in main.js");
  return mainSource.slice(start, end + "\n})());".length);
}

function capsuleHtml() {
  const src = `${capsuleTokensSource()}\n${topLevelFunctionSource("recordingStatusCapsuleHtml")}\nrecordingStatusCapsuleHtml();`;
  return vm.runInNewContext(src, {});
}

function element() {
  return {
    style: {},
    textContent: "",
    className: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
  };
}

/** Run the capsule page's script; returns its hooks and the canvas log. */
function loadCapsule() {
  const html = capsuleHtml();
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const draws = [];
  const ctx = {
    fillStyle: "",
    setTransform() {},
    clearRect() { draws.length = 0; },
    fillRect(x, y, w, h) { draws.push({ x, y, w, h, color: this.fillStyle }); },
    beginPath() {},
    roundRect(x, y, w, h) { draws.push({ x, y, w, h, color: this.fillStyle }); },
    fill() {},
  };
  const elements = new Map();
  const canvas = { ...element(), width: 0, height: 0, getContext: () => ctx };
  let frame = null;
  const window = { devicePixelRatio: 1, __capsule: { pointer() {}, shot() {}, stop() {} } };
  const sandbox = {
    window,
    document: {
      hidden: false,
      addEventListener() {},
      getElementById(id) {
        if (id === "wave") return canvas;
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
    },
    requestAnimationFrame(fn) { frame = fn; return 1; },
    cancelAnimationFrame() { frame = null; },
    setTimeout() { return 0; },
    Date,
    Math,
    Number,
    String,
  };
  vm.runInNewContext(script, sandbox);
  let clock = 1000;
  return {
    draws,
    setState: (next) => window.__setCapsuleState(next),
    step() {
      const fn = frame;
      frame = null;
      clock += 100;
      if (fn) fn(clock);
    },
  };
}

const { RECORDING_STATUS_CAPSULE_FOR_TEST: tokens } = vm.runInNewContext(
  `${capsuleTokensSource()}\n({ RECORDING_STATUS_CAPSULE_FOR_TEST: RECORDING_STATUS_CAPSULE })`,
  {},
);

test("a silent take shows a thin red line across the waveform from the press", () => {
  const capsule = loadCapsule();
  // What the main process publishes at the press: "Starting" maps to the
  // recording mode (./recording-status), and nothing has been heard yet.
  capsule.setState({ status: "Starting", mode: "recording", level: 0, timerRunning: false });
  capsule.step();
  const line = capsule.draws.find((d) => d.w === tokens.waveWidth);
  assert.ok(line, "a full-width line is drawn in the first frame");
  assert.equal(line.h, tokens.waveBaselineHeight);
  assert.ok(line.h <= 1, "the thinnest line, not a bar");
  assert.equal(line.y, (tokens.waveHeight - line.h) / 2, "centred");
  assert.match(line.color, /^rgba\(255,77,77,/, "in the recording red");

  // Still silent a while later: still the line, still red.
  for (let i = 0; i < 5; i += 1) capsule.step();
  assert.ok(capsule.draws.some((d) => d.w === tokens.waveWidth && /^rgba\(255,77,77,/.test(d.color)));
});

test("bars rise above the line, in the same colour", () => {
  const capsule = loadCapsule();
  capsule.setState({ status: "Recording", mode: "recording", level: 0.8 });
  for (let i = 0; i < 4; i += 1) capsule.step();
  const line = capsule.draws.find((d) => d.w === tokens.waveWidth);
  const bars = capsule.draws.filter((d) => d.w !== tokens.waveWidth);
  assert.ok(line);
  assert.ok(bars.length > 0, "speech draws bars");
  assert.ok(bars.every((b) => b.h > line.h && b.color === line.color));
});

test("an inactive capsule erases the line", () => {
  const capsule = loadCapsule();
  capsule.setState({ status: "Starting", mode: "recording", level: 0 });
  capsule.step();
  assert.ok(capsule.draws.length > 0);
  capsule.setState({ status: "", mode: "idle", level: 0 });
  assert.equal(capsule.draws.length, 0, "nothing is left on the canvas");
});
