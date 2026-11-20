"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const path = require("node:path");

const {
  SCREEN_MODE,
  beginStroke,
  createScreenSession,
  endStroke,
  extendStroke,
  isScreenSessionId,
  pendingStrokes,
  recordShot,
  screenSessionId,
  screenSessionManifest,
  shotFileName,
  strokePosition,
} = require("./screen-mode");

const contract = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "contracts", "screen-session.json"), "utf8"),
);

const DISPLAY_1 = { x: 0, y: 0, width: 1000, height: 1000 };

function drawLine(session, from, to, at, displayBounds = DISPLAY_1) {
  beginStroke(session, { x: from[0], y: from[1], at, displayId: 1, displayBounds });
  extendStroke(session, { x: (from[0] + to[0]) / 2, y: (from[1] + to[1]) / 2, at: at + 50 });
  return endStroke(session, { x: to[0], y: to[1], at: at + 100 });
}

// A shot of everything pending when it began — what the controller does.
function shoot(session, { at, files = [], reason = "capsule" }) {
  return recordShot(session, { at, files, reason, strokeIds: pendingStrokes(session).map((s) => s.id) });
}

test("session ids sort chronologically and are recognised", () => {
  const a = screenSessionId(new Date(2026, 10, 20, 9, 5, 7, 3).getTime());
  const b = screenSessionId(new Date(2026, 10, 20, 10, 0, 0, 0).getTime());
  assert.equal(a, "screen-20261120-090507-003");
  assert.ok(a < b);
  assert.ok(isScreenSessionId(a));
  assert.ok(!isScreenSessionId("screen-notes"));
  assert.ok(!isScreenSessionId("../screen-20261120-090507-003"));
});

test("a stroke uses the colour selected when it began", () => {
  const s = createScreenSession({ id: "x", dir: "/tmp/x" });
  assert.equal(s.color, SCREEN_MODE.colors[0]);
  s.color = SCREEN_MODE.colors[2];
  const stroke = drawLine(s, [0, 0], [100, 0], 1000);
  assert.equal(stroke.color, SCREEN_MODE.colors[2]);
  assert.equal(s.activeStrokeId, 0);
});

test("a screenshot takes every finished stroke and leaves nothing pending", () => {
  // One rule decides what a stroke is: the native helper's drag
  // threshold. Nothing here second-guesses a stroke it reported.
  const s = createScreenSession({ id: "x", dir: "/tmp/x" });
  drawLine(s, [0, 0], [100, 0], 1000);
  drawLine(s, [10, 10], [12, 11], 2000);
  assert.equal(pendingStrokes(s).length, 2);
  const shot = shoot(s, { at: 3000, files: ["/tmp/x/shot-01.png"] });
  assert.equal(shot.index, 1);
  assert.deepEqual(shot.strokeIds, [1, 2]);
  assert.equal(pendingStrokes(s).length, 0);
  drawLine(s, [0, 0], [0, 200], 4000);
  const second = shoot(s, { at: 5000 });
  assert.equal(second.index, 2);
  assert.deepEqual(second.strokeIds, [3]);
});

test("a stroke still being drawn is not taken by a screenshot", () => {
  const s = createScreenSession({ id: "x", dir: "/tmp/x" });
  beginStroke(s, { x: 0, y: 0, at: 1, displayId: 1 });
  extendStroke(s, { x: 300, y: 0, at: 2 });
  assert.equal(pendingStrokes(s).length, 0);
  const shot = shoot(s, { at: 3 });
  assert.deepEqual(shot.strokeIds, []);
  assert.equal(s.strokes.length, 1, "the active stroke survives the shot");
});

test("a stroke's position is its centre in percent of its own display", () => {
  const display = { x: 0, y: 0, width: 1500, height: 900 };
  assert.deepEqual(strokePosition({ points: [[745, 445], [755, 455]] }, display), { xPct: 50, yPct: 50 });
  const secondary = { x: 1500, y: -200, width: 1000, height: 600 };
  assert.deepEqual(strokePosition({ points: [[1600, -140], [1600, -140]] }, secondary), { xPct: 10, yPct: 10 });
});

test("the manifest lists strokes and shots in time order with their shot number", () => {
  const s = createScreenSession({ id: "screen-1", dir: "/d", startedAt: 500 });
  drawLine(s, [0, 0], [200, 0], 1000);
  shoot(s, { at: 2000, files: ["/d/shot-01.png"] });
  const m = screenSessionManifest(s);
  assert.equal(m.id, "screen-1");
  assert.equal(m.dir, "/d");
  assert.deepEqual(m.events.map((e) => [e.type, e.at, e.shot]), [["stroke", 1000, 1], ["shot", 2000, 1]]);
  assert.deepEqual([m.events[0].xPct, m.events[0].yPct], [10, 0]);
  assert.deepEqual(m.events[1].files, ["/d/shot-01.png"]);
});

test("screenshot file names carry the display only when several were captured", () => {
  assert.equal(shotFileName(3, 1, 1), "shot-03.png");
  assert.equal(shotFileName(3, 2, 2), "shot-03-display2.png");
});

test("names shared with the backend match contracts/screen-session.json", () => {
  assert.equal(SCREEN_MODE.stagingDirName, contract.stagingDirName);
  assert.equal(SCREEN_MODE.eventsFileName, contract.eventsFileName);
  assert.ok(isScreenSessionId(contract.exampleSessionId));
  assert.ok(new RegExp(contract.sessionIdPattern).test(screenSessionId()));
  const shotName = new RegExp(contract.screenshotNamePattern);
  assert.ok(shotName.test(shotFileName(1, 1, 1)));
  assert.ok(shotName.test(shotFileName(12, 2, 3)));
});

test("the manifest has the contract's shape", () => {
  const s = createScreenSession({ id: contract.exampleSessionId, dir: "/d", startedAt: 1 });
  drawLine(s, [0, 0], [10, 10], 2);
  shoot(s, { at: 300, files: ["/d/shot-01.png"], reason: "capsule" });
  s.endedAt = 400; // the take stopped (the controller's finish)
  const m = screenSessionManifest(s);
  const keys = (o) => Object.keys(o).sort();
  assert.deepEqual(keys(m), keys(contract.manifest));
  assert.deepEqual(keys(m.events[0]), keys(contract.manifest.events[0]));
  assert.deepEqual(keys(m.events[1]), keys(contract.manifest.events[1]));
});

test("a running session's manifest has no end yet; a finished one does", () => {
  const s = createScreenSession({ id: "x", dir: "/d", startedAt: 1 });
  assert.equal("endedAt" in screenSessionManifest(s), false);
  s.endedAt = 99;
  assert.equal(screenSessionManifest(s).endedAt, 99);
});

test("a shot takes only the strokes it was made with; one finished meanwhile stays pending", () => {
  const s = createScreenSession({ id: "x", dir: "/d", startedAt: 1 });
  drawLine(s, [0, 0], [100, 0], 10);
  const capturedWith = pendingStrokes(s).map((st) => st.id);
  // While the screenshot is being taken, another stroke finishes.
  drawLine(s, [0, 50], [100, 50], 20);
  const shot = recordShot(s, { at: 30, files: ["/d/shot-01.png"], strokeIds: capturedWith, reason: "hotkey" });
  assert.deepEqual(shot.strokeIds, [1]);
  assert.deepEqual(pendingStrokes(s).map((st) => st.id), [2]);
});

test("a stroke's position comes from its display as it was when drawn, not as it is now", () => {
  const s = createScreenSession({ id: "x", dir: "/d", startedAt: 1 });
  const external = { x: 1000, y: 0, width: 1000, height: 1000 };
  drawLine(s, [1100, 100], [1300, 100], 10, external);
  shoot(s, { at: 50, files: ["/d/shot-01.png"] });
  // The display is unplugged / rearranged afterwards: nothing moves.
  external.x = 0;
  external.width = 1;
  const m = screenSessionManifest(s);
  assert.deepEqual([m.events[0].xPct, m.events[0].yPct], [20, 10]);
});
