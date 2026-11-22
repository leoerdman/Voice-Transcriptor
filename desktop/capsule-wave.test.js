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
const { createWaveScroller } = require("./capsule-wave-scroll");

function capsuleTokensSource() {
  const start = mainSource.indexOf("const RECORDING_STATUS_CAPSULE = ");
  const end = mainSource.indexOf("\n})());", start);
  assert.ok(start >= 0 && end > start, "RECORDING_STATUS_CAPSULE is declared in main.js");
  return mainSource.slice(start, end + "\n})());".length);
}

function capsuleHtml() {
  const src = `${capsuleTokensSource()}\n${topLevelFunctionSource("recordingStatusCapsuleHtml")}\nrecordingStatusCapsuleHtml();`;
  return vm.runInNewContext(src, { createWaveScroller });
}

function element() {
  const classes = new Set();
  const el = {
    style: {},
    textContent: "",
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      toggle(c, on) { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    addEventListener() {},
  };
  Object.defineProperty(el, "className", {
    get: () => [...classes].join(" "),
    set: (v) => { classes.clear(); String(v || "").split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
  });
  return el;
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
  // The page reads Date.now(); the test owns that clock and moves it one
  // 100 ms frame per step.
  let clock = 1000;
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
    Date: { now: () => clock },
    Math,
    Number,
    String,
  };
  vm.runInNewContext(script, sandbox);
  return {
    draws,
    element: (id) => sandbox.document.getElementById(id),
    setState: (next) => window.__setCapsuleState(next),
    step(ms = 100) {
      const fn = frame;
      frame = null;
      clock += ms;
      if (fn) fn(clock);
    },
  };
}

const { RECORDING_STATUS_CAPSULE_FOR_TEST: tokens } = vm.runInNewContext(
  `${capsuleTokensSource()}\n({ RECORDING_STATUS_CAPSULE_FOR_TEST: RECORDING_STATUS_CAPSULE })`,
  {},
);

test("a silent take shows a thin red line that comes in from the right edge", () => {
  const capsule = loadCapsule();
  // What the main process publishes at the press: "Starting" maps to the
  // recording mode (./recording-status), and nothing has been heard yet.
  capsule.setState({ status: "Starting", mode: "recording", level: 0, timerRunning: false });
  capsule.step();
  const lineAt = () => capsule.draws.find((d) => d.h === tokens.waveBaselineHeight && d.x + d.w === tokens.waveWidth);
  const first = lineAt();
  assert.ok(first, "a line is drawn in the first frame, anchored to the right edge");
  assert.ok(first.w < tokens.waveWidth, "not across the whole width at once");
  assert.ok(first.h <= 1, "the thinnest line, not a bar");
  assert.equal(first.y, (tokens.waveHeight - first.h) / 2, "centred");
  assert.match(first.color, /^rgba\(255,77,77,/, "in the recording red");

  // It grows leftward, frame by frame, until it spans the waveform.
  let previous = first.w;
  for (let i = 0; i < 5; i += 1) {
    capsule.step();
    const line = lineAt();
    assert.ok(line && line.w > previous, "it keeps growing to the left");
    previous = line.w;
  }
  for (let i = 0; i < 60; i += 1) capsule.step();
  const full = lineAt();
  assert.equal(full.x, 0, "and then runs across the whole waveform");
  assert.match(full.color, /^rgba\(255,77,77,/);
});

test("bars rise above the line, in the same colour", () => {
  const capsule = loadCapsule();
  capsule.setState({ status: "Recording", mode: "recording", level: 0.8 });
  for (let i = 0; i < 4; i += 1) capsule.step();
  const line = capsule.draws.find((d) => d.h === tokens.waveBaselineHeight);
  const bars = capsule.draws.filter((d) => d !== line);
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

test("a new take brings the line in from the right again, even with no idle state between takes", () => {
  const capsule = loadCapsule();
  capsule.setState({ status: "Recording", mode: "recording", level: 0, startedAt: 1000 });
  for (let i = 0; i < 60; i += 1) capsule.step();
  const lineOf = () => capsule.draws.find((d) => d.h === tokens.waveBaselineHeight);
  assert.equal(lineOf().x, 0, "the first take's line spans the waveform");
  capsule.setState({ status: "Starting", mode: "recording", level: 0, startedAt: 99000 });
  capsule.step();
  assert.ok(lineOf().x > 0, "the second take starts at the right edge");
});

test("the hidden (idle) capsule runs no CSS animation", () => {
  // The capsule window lives for the whole session (1.6.22). Idle used to
  // fall back to the "transcribing" icon, whose infinite box-shadow
  // animation kept the hidden window's compositor and the GPU process busy
  // (measured on the installed 1.6.23: ~13 % + ~27 % of a core at idle).
  const capsule = loadCapsule();
  capsule.setState({ status: "Transcribing", mode: "transcribing", level: 0 });
  assert.ok(capsule.element("stateIcon").classList.contains("transcribing"));
  capsule.setState({ status: "", mode: "idle", level: 0 });
  const icon = capsule.element("stateIcon");
  assert.ok(icon.classList.contains("idle"), "idle has its own class");
  assert.ok(!icon.classList.contains("transcribing"));
  const css = /<style>([\s\S]*)<\/style>/.exec(capsuleHtml())[1];
  assert.ok(!/#stateIcon\.idle[^{]*\{[^}]*animation/.test(css), "no animation is attached to the idle icon");
});

test("the bars keep running through a change of mode, a level jump and a stalled frame", () => {
  // User, 2026-11-23: "the waveform jumps left and right when I start
  // speaking and when I stop". Speech and silence flip the capsule between
  // "recording" and the auto-stop countdown, and the level jumps; the old
  // scroller zeroed its push clock on the mode switch and moved every bar.
  const capsule = loadCapsule();
  capsule.setState({ status: "Recording", mode: "recording", level: 0.8, startedAt: 1000 });
  for (let i = 0; i < 40; i += 1) capsule.step(16);
  const barsOf = () => capsule.draws.filter((d) => d.h > tokens.waveBaselineHeight).map((d) => d.x);
  const before = barsOf();
  assert.ok(before.length >= 3, "bars are on the strip");
  const speed = (tokens.waveBarWidth + tokens.waveBarGap) / tokens.waveLevelTickMs;

  capsule.setState({ status: "Auto stop in 5s", mode: "autostop", level: 0 });
  capsule.step(16);
  capsule.setState({ status: "Recording", mode: "recording", level: 0.9 });
  capsule.step(16);
  const after = barsOf();
  // The same bars, 32 ms further left (a new bar may have been born).
  for (let i = 0; i < before.length; i += 1) {
    const moved = before[i] - after[after.length - before.length + i];
    assert.ok(Math.abs(moved - speed * 32) < 0.35, `bar ${i} moved ${moved}px, expected ${(speed * 32).toFixed(2)}`);
  }

  // A 600 ms stall: the bars are where time puts them, evenly spaced.
  capsule.step(600);
  const gaps = barsOf().sort((a, b) => a - b).map((x, i, all) => (i ? x - all[i - 1] : null)).slice(1);
  const step = tokens.waveBarWidth + tokens.waveBarGap;
  for (const gap of gaps) assert.ok(Math.abs(gap - step) < 1e-6, `gap ${gap} is one step after a stall`);
});

test("a waking microphone is drawn as its own state: its icon, a dimmed wave that still follows the level", () => {
  // The take runs but the headset has delivered only digital silence
  // (frontend/src/mic-wake.ts, desktop/recording-status.js ``waking``).
  const capsule = loadCapsule();
  capsule.setState({ status: "Recording", mode: "recording", level: 0.8, startedAt: 1000 });
  for (let i = 0; i < 4; i += 1) capsule.step();
  assert.ok(capsule.element("stateIcon").classList.contains("rec"));
  capsule.setState({ status: "Microphone waking", mode: "waking", level: 0.8, startedAt: 1000 });
  for (let i = 0; i < 4; i += 1) capsule.step(100);
  const icon = capsule.element("stateIcon");
  assert.ok(icon.classList.contains("waking"), "its own icon class");
  assert.ok(!icon.classList.contains("rec"), "not the recording one");
  const line = capsule.draws.find((d) => d.h === tokens.waveBaselineHeight);
  assert.ok(line, "the line still runs: the take is live");
  assert.ok(!/^rgba\(255,77,77,/.test(line.color), "and it is not the recording red");
  const css = /<style>([\s\S]*)<\/style>/.exec(capsuleHtml())[1];
  assert.ok(/#stateIcon\.waking::before/.test(css), "the icon has a rule");
  assert.ok(!/#stateIcon\.waking::after[^{]*\{[^}]*animation/.test(css), "and no halo: it is not recording sound yet");
  // Sound arrives: back to the recording look.
  capsule.setState({ status: "Recording", mode: "recording", level: 0.2, startedAt: 1000 });
  assert.ok(capsule.element("stateIcon").classList.contains("rec"));
});

test("the line does not jump back when the take's start time arrives after the press", () => {
  // User, 2026-11-23: "the red line starts from the right, goes a little way
  // left, jumps back to the start and runs again". The press shows "Starting"
  // with no start time; the microphone's real start stamps one a moment later.
  const capsule = loadCapsule();
  capsule.setState({ status: "Starting", mode: "recording", level: 0, startedAt: 0 });
  const lineAt = () => capsule.draws.find((d) => d.h === tokens.waveBaselineHeight);
  capsule.step(16);
  let previous = lineAt().w;
  for (let i = 0; i < 12; i += 1) {
    if (i === 6) capsule.setState({ status: "Recording", mode: "recording", level: 0, startedAt: 1000 + 16 * 7 });
    capsule.step(16);
    const width = lineAt().w;
    assert.ok(width >= previous, `the line shrank at frame ${i}: ${previous} -> ${width}`);
    previous = width;
  }
});
