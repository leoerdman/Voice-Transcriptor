"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const path = require("node:path");

const {
  BADGE_LINE_GAP,
  SCREEN_MODE,
  SHOT_AREA,
  badgeAt,
  beginStroke,
  createScreenSession,
  cropFileName,
  deleteStroke,
  endStroke,
  extendStroke,
  fitWithin,
  isScreenSessionId,
  liveBadge,
  liveBadges,
  numberBadgeCenter,
  pendingClicks,
  pendingStrokes,
  planShot,
  previewFileName,
  recordClick,
  recordShot,
  screenSessionId,
  screenSessionManifest,
  shotFileName,
  strokeCropRect,
  strokePlacement,
  strokeShape,
  unshotStrokes,
  windowRegion,
} = require("./screen-mode");

const contract = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "contracts", "screen-session.json"), "utf8"),
);

const DISPLAY_1 = { x: 0, y: 0, width: 1000, height: 1000 };

function drawPen(session, points, at = 1000, displayBounds = DISPLAY_1) {
  session.tool = "pen";
  const [first, ...rest] = points;
  beginStroke(session, { x: first[0], y: first[1], at, displayId: 1, displayBounds });
  rest.forEach((p, i) => extendStroke(session, { x: p[0], y: p[1], at: at + 10 * (i + 1) }));
  return endStroke(session, { x: points[points.length - 1][0], y: points[points.length - 1][1], at: at + 10 * points.length });
}

function circle(cx, cy, r, steps = 24, sweep = 1) {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = (i / steps) * Math.PI * 2 * sweep;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

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

test("a stroke's place is its box and centre in whole percent of the captured area", () => {
  const display = { x: 0, y: 0, width: 1500, height: 900 };
  assert.deepEqual(strokePlacement({ points: [[745, 445], [755, 455]] }, display), {
    box: { x: 50, y: 49, w: 1, h: 1 }, xPct: 50, yPct: 50,
  });
  const secondary = { x: 1500, y: -200, width: 1000, height: 600 };
  assert.deepEqual(strokePlacement({ points: [[1600, -140], [1600, -140]] }, secondary), {
    box: { x: 10, y: 10, w: 0, h: 0 }, xPct: 10, yPct: 10,
  });
});

test("a stroke partly outside the captured window is cut to it", () => {
  const win = { x: 100, y: 100, width: 400, height: 200 };
  // From inside the window to well past its right edge.
  const place = strokePlacement({ points: [[300, 150], [900, 250]] }, win);
  assert.deepEqual(place.box, { x: 50, y: 25, w: 50, h: 50 });
  assert.deepEqual([place.xPct, place.yPct], [75, 50]);
});

test("the manifest lists strokes and shots in time order with their shot number", () => {
  const s = createScreenSession({ id: "screen-1", dir: "/d", startedAt: 500 });
  drawLine(s, [0, 0], [200, 0], 1000);
  shoot(s, { at: 2000, files: ["/d/shot-01.png"] });
  const m = screenSessionManifest(s);
  assert.equal(m.id, "screen-1");
  assert.equal(m.dir, "/d");
  assert.equal(m.version, 3);
  assert.deepEqual(m.events.map((e) => [e.type, e.at, e.shot]), [["stroke", 1000, 1], ["shot", 2000, 1]]);
  assert.deepEqual([m.events[0].xPct, m.events[0].yPct], [10, 0]);
  // A rectangle dragged flat (200 × 0) is a line.
  assert.deepEqual([m.events[0].n, m.events[0].tool, m.events[0].shape], [1, "rect", "line"]);
  assert.equal(m.events[1].area, "display");
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
  const derivedName = new RegExp(contract.derivedImageNamePattern);
  assert.ok(shotName.test(shotFileName(1, 1, 1)));
  assert.ok(shotName.test(shotFileName(12, 2, 3)));
  // The cheap copies have names of their own: never taken for a screenshot.
  for (const name of [previewFileName(1), previewFileName(12), cropFileName(1, 1), cropFileName(3, 12)]) {
    assert.ok(derivedName.test(name), name);
    assert.ok(!shotName.test(name), name);
  }
  assert.ok(!derivedName.test(shotFileName(1, 1, 1)));
});

test("the file names the transcript's header states are this side's names (contract fileNameForms)", () => {
  const form = (template, nn, k) => template.replace("NN", nn).replace("K", String(k));
  assert.equal(shotFileName(7, 1, 1), form(contract.fileNameForms.shot, "07"));
  assert.equal(shotFileName(12, 1, 1), form(contract.fileNameForms.shot, "12"));
  assert.equal(previewFileName(7), form(contract.fileNameForms.preview, "07"));
  assert.equal(cropFileName(7, 3), form(contract.fileNameForms.crop, "07", 3));
});

test("the manifest has the contract's shape (v3)", () => {
  const s = createScreenSession({ id: contract.exampleSessionId, dir: "/d", startedAt: 1, recordClicks: true });
  drawLine(s, [0, 0], [10, 10], 2);
  recordClick(s, { x: 40, y: 62, at: 200 });
  recordShot(s, {
    at: 300,
    files: ["/d/shot-01.png"],
    strokeIds: [1],
    reason: "capsule",
    area: SHOT_AREA.WINDOW,
    preview: "/d/shot-01-preview.jpg",
    regions: { 1: { x: 0, y: 0, width: 100, height: 100 } },
    crops: { 1: "/d/shot-01-n1.jpg" },
    clicks: { 1: { x: 0, y: 0, width: 100, height: 100 } },
  });
  s.endedAt = 400; // the take stopped (the controller's finish)
  const m = screenSessionManifest(s);
  const keys = (o) => Object.keys(o).sort();
  const ofType = (events, type) => events.find((e) => e.type === type);
  assert.equal(m.version, contract.manifest.version);
  assert.equal(m.version, SCREEN_MODE.manifestVersion);
  assert.deepEqual(keys(m), keys(contract.manifest));
  assert.deepEqual(m.events.map((e) => e.type), contract.manifest.events.map((e) => e.type));
  for (const type of ["stroke", "click", "shot"]) {
    assert.deepEqual(keys(ofType(m.events, type)), keys(ofType(contract.manifest.events, type)), type);
  }
  assert.deepEqual(keys(m.events[0].box), keys(contract.manifest.events[0].box));
  assert.deepEqual([ofType(m.events, "click").xPct, ofType(m.events, "click").yPct], [40, 62]);
  assert.ok(SCREEN_MODE.tools.includes(contract.manifest.events[0].tool));
  assert.ok(Object.values(SHOT_AREA).includes(ofType(contract.manifest.events, "shot").area));
  // The v1 example the readers still accept is a subset of v2.
  const v1Stroke = contract.manifestV1.events.find((e) => e.type === "stroke");
  for (const key of Object.keys(v1Stroke)) assert.ok(key in m.events[0], key);
});

test("a stroke with no close-up and a shot with no preview leave those fields out", () => {
  const s = createScreenSession({ id: "x", dir: "/d", startedAt: 1 });
  drawLine(s, [0, 0], [900, 900], 2);
  shoot(s, { at: 300, files: ["/d/shot-01.png"] });
  const m = screenSessionManifest(s);
  assert.equal("crop" in m.events[0], false);
  assert.equal("preview" in m.events[1], false);
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

// ── tools, numbers, shapes ─────────────────────────────────────────────
test("every take starts with the rectangle; a rectangle is its two corners, stretched any way", () => {
  const s = createScreenSession({ id: "x", dir: "/d" });
  assert.equal(s.tool, "rect");
  assert.equal(SCREEN_MODE.tools[0], "rect");
  beginStroke(s, { x: 500, y: 500, at: 1, displayId: 1, displayBounds: DISPLAY_1 });
  extendStroke(s, { x: 600, y: 650, at: 2 });
  extendStroke(s, { x: 300, y: 200, at: 3 }); // dragged back past the start
  const rect = endStroke(s, { x: 350, y: 250, at: 4 });
  assert.equal(rect.tool, "rect");
  assert.deepEqual(rect.points, [[500, 500], [350, 250]]);
  assert.equal(strokeShape(rect), "rect");
});

test("a rectangle with one side no thicker than the pen's straightness tolerance is a line; with both, a dot", () => {
  const rect = (x1, y1, x2, y2) => {
    const s = createScreenSession({ id: "x", dir: "/d" });
    beginStroke(s, { x: x1, y: y1, at: 1, displayId: 1, displayBounds: DISPLAY_1 });
    return strokeShape(endStroke(s, { x: x2, y: y2, at: 2 }));
  };
  const tol = SCREEN_MODE.shape.lineMinDeviation;
  assert.equal(rect(100, 100, 400, 100 + tol), "line", "flat, any length");
  assert.equal(rect(100, 100, 100 + tol - 1, 500), "line", "upright");
  assert.equal(rect(100, 100, 400, 100 + tol + 1), "rect", "just thicker: a box");
  assert.equal(rect(100, 100, 600, 140), "rect", "a long flat box around one line of text is a box");
  assert.equal(rect(100, 100, 100 + tol, 100 + tol), "dot");
});

test("strokes are numbered 1, 2, 3 in each shot, and the next shot starts at 1 again", () => {
  const s = createScreenSession({ id: "x", dir: "/d" });
  const ns = () => s.strokes.map((st) => st.n);
  drawLine(s, [0, 0], [100, 100], 10);
  drawLine(s, [200, 0], [300, 100], 20);
  drawLine(s, [400, 0], [500, 100], 30);
  assert.deepEqual(ns(), [1, 2, 3]);
  shoot(s, { at: 40, files: ["/d/shot-01.png"] });
  drawLine(s, [0, 0], [100, 100], 50);
  drawLine(s, [0, 0], [100, 100], 60);
  assert.deepEqual(ns(), [1, 2, 3, 1, 2]);
  const m = screenSessionManifest((shoot(s, { at: 70, files: ["/d/shot-02.png"] }), s));
  assert.deepEqual(
    m.events.filter((e) => e.type === "stroke").map((e) => [e.shot, e.n]),
    [[1, 1], [1, 2], [1, 3], [2, 1], [2, 2]],
    "every stroke keeps its own number: none are merged",
  );
});

test("strokes left on the screen after a shot are numbered again from 1", () => {
  const s = createScreenSession({ id: "x", dir: "/d" });
  drawLine(s, [0, 0], [100, 100], 10); // 1, captured
  drawLine(s, [0, 0], [100, 100], 20); // 2, its display failed: kept
  beginStroke(s, { x: 5, y: 5, at: 25, displayId: 1 }); // 3, begun during the capture
  assert.deepEqual(s.strokes.map((st) => st.n), [1, 2, 3]);
  recordShot(s, { at: 30, files: ["/d/shot-01.png"], strokeIds: [1], reason: "hotkey" });
  assert.deepEqual(unshotStrokes(s).map((st) => [st.id, st.n]), [[2, 1], [3, 2]]);
  endStroke(s, { x: 50, y: 50, at: 35 });
  drawLine(s, [0, 0], [100, 100], 40);
  assert.equal(s.strokes[3].n, 3, "a new stroke follows the ones still on the screen");
});

test("a pen stroke's shape: dot, line, loop or curve", () => {
  const shape = (points) => strokeShape(drawPen(createScreenSession({ id: "x", dir: "/d" }), points));
  assert.equal(shape([[100, 100], [104, 103], [108, 101]]), "dot");
  assert.equal(shape([[100, 100], [150, 103], [200, 98], [300, 102]]), "line");
  assert.equal(shape([[100, 100], [160, 160], [240, 240]]), "line", "a diagonal is a line too");
  assert.equal(shape(circle(300, 300, 80)), "loop");
  assert.equal(shape(circle(300, 300, 80, 24, 0.9)), "loop", "a ring that does not quite close is still a loop");
  assert.equal(shape(circle(300, 300, 80, 24, 0.5)), "curve", "a half circle is not a loop");
  assert.equal(shape([[100, 100], [200, 200], [300, 100], [400, 200]]), "curve");
  // Out and back along one line: it ends where it began but encloses nothing.
  assert.equal(shape([[100, 100], [300, 102], [100, 101]]), "line");
});

test("a pen stroke's number sits up-left of where the stroke began", () => {
  const view = { x: 0, y: 0, width: 1000, height: 800 };
  const r = 10;
  const gap = 5;
  const c = numberBadgeCenter("pen", [[500, 400], [300, 200]], view, r, gap);
  assert.ok(c.x < 500 && c.y < 400, "up and to the left of the start");
  assert.ok(Math.abs(Math.hypot(500 - c.x, 400 - c.y) - (r + gap)) < 1e-9, "its edge `gap` from the start");
});

test("a pen stroke's number does not move while the stroke is drawn, whichever way it goes (user, 2026-11-21)", () => {
  const view = { x: 0, y: 0, width: 1000, height: 800 };
  const start = [400, 300];
  const at = numberBadgeCenter("pen", [start], view, 10, 5);
  for (const end of [[700, 300], [100, 300], [400, 700], [400, 50], [700, 700], [100, 50]]) {
    const ring = [start, end, [end[0], start[1]], start];
    assert.deepEqual(numberBadgeCenter("pen", [start, end], view, 10, 5), at, `line towards ${end}`);
    assert.deepEqual(numberBadgeCenter("pen", ring, view, 10, 5), at, `ring through ${end}`);
  }
});

test("near the edge of the view a pen number takes the next corner around the start, never off the picture", () => {
  const view = { x: 0, y: 0, width: 1000, height: 800 };
  const r = 10;
  const top = numberBadgeCenter("pen", [[100, 5], [400, 300]], view, r, 5);
  assert.ok(top.y > 5 && top.x < 100, "below-left when there is no room above");
  const corner = numberBadgeCenter("pen", [[2, 2], [400, 300]], view, r, 5);
  assert.ok(corner.x > 2 && corner.y > 2, "below-right in the very corner");
  const edge = numberBadgeCenter("pen", [[995, 795]], view, r, 5);
  assert.ok(edge.x + r <= 1000 && edge.y + r <= 800, "up-left stays inside at the far corner");
});

// The distance from a circle's centre to a segment (a rectangle's side).
function toSegment(c, a, b) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const t = Math.max(0, Math.min(1, ((c.x - a[0]) * dx + (c.y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(c.x - (a[0] + t * dx), c.y - (a[1] + t * dy));
}

test("a rectangle's number sits outside its top-right corner, clear of both lines, however it was dragged (user, 2026-11-21)", () => {
  const view = { x: 0, y: 0, width: 1000, height: 800 };
  const r = 10;
  const gap = 5;
  // The same box (300..500 × 200..400), dragged from each of its corners.
  for (const [from, to] of [[[300, 200], [500, 400]], [[500, 400], [300, 200]], [[500, 200], [300, 400]], [[300, 400], [500, 200]]]) {
    const c = numberBadgeCenter("rect", [from, to], view, r, gap);
    assert.ok(c.x > 500 && c.y < 200, `up and to the right of the top-right corner (${from} → ${to})`);
    assert.ok(Math.abs(c.x - 500 - (200 - c.y)) < 1e-9, "on the corner's diagonal");
    assert.ok(Math.abs(Math.hypot(c.x - 500, c.y - 200) - (r + gap)) < 1e-9, "its edge `gap` from the corner");
    assert.ok(toSegment(c, [300, 200], [500, 200]) >= r + gap - 1e-9, "clear of the top line");
    assert.ok(toSegment(c, [500, 200], [500, 400]) >= r + gap - 1e-9, "clear of the right line");
  }
  // It follows the corner while the box is dragged.
  assert.notDeepEqual(
    numberBadgeCenter("rect", [[300, 200], [600, 400]], view, r, gap),
    numberBadgeCenter("rect", [[300, 200], [500, 400]], view, r, gap),
  );
});

test("near the edge of the view a rectangle's number takes the next place around its top-right corner, clear of the lines, never off the picture", () => {
  const view = { x: 0, y: 0, width: 1000, height: 800 };
  const r = 10;
  const gap = 5;
  const e = r + gap;
  const inside = (c) => c.x - r >= 0 && c.y - r >= 0 && c.x + r <= 1000 && c.y + r <= 800;
  const clear = (c, [x0, y0, x1, y1]) => (
    toSegment(c, [x0, y0], [x1, y0]) >= e - 1e-9 && toSegment(c, [x1, y0], [x1, y1]) >= e - 1e-9
  );
  // Against the right edge: above the top line, left of the corner.
  const a = numberBadgeCenter("rect", [[600, 300], [995, 500]], view, r, gap);
  assert.ok(inside(a) && clear(a, [600, 300, 995, 500]) && a.y < 300 && a.x < 995, "up-left of the corner with no room to the right");
  // Against the top edge: right of the right line, below the corner.
  const b = numberBadgeCenter("rect", [[300, 5], [500, 400]], view, r, gap);
  assert.ok(inside(b) && clear(b, [300, 5, 500, 400]) && b.x > 500 && b.y > 5, "down-right of the corner with no room above");
  // In the top-right corner of the view: inside the box's corner.
  const c = numberBadgeCenter("rect", [[600, 3], [997, 400]], view, r, gap);
  assert.ok(inside(c) && clear(c, [600, 3, 997, 400]) && c.x < 997 && c.y > 3, "inside the corner when nothing outside fits");
  // A view too small for any place: pulled inside, never off the picture.
  const tiny = { x: 0, y: 0, width: 30, height: 30 };
  const d = numberBadgeCenter("rect", [[2, 2], [28, 28]], tiny, r, gap);
  assert.ok(d.x - r >= 0 && d.y - r >= 0 && d.x + r <= 30 && d.y + r <= 30);
});

test("the number is placed by the same function the overlay page embeds", () => {
  // Self-contained: it still works after a round trip through its source.
  // eslint-disable-next-line no-new-func
  const copy = new Function(`return (${numberBadgeCenter.toString()})`)();
  const view = { x: 0, y: 0, width: 300, height: 300 };
  for (const tool of SCREEN_MODE.tools) {
    assert.deepEqual(copy(tool, [[100, 100], [200, 200]], view, 10, 5), numberBadgeCenter(tool, [[100, 100], [200, 200]], view, 10, 5), tool);
  }
  // eslint-disable-next-line no-new-func
  const fit = new Function(`return (${fitWithin.toString()})`)();
  assert.deepEqual(fit(3456, 2234, 1568, 1150000), fitWithin(3456, 2234, 1568, 1150000));
});

// ── deleting a stroke by its number ────────────────────────────────────
test("a stroke's live number is the rule's circle inside its display, and a point hits the topmost one", () => {
  const s = createScreenSession({ id: "x", dir: "/d" });
  const rect = drawLine(s, [300, 200], [500, 400], 10);
  const badge = liveBadge(rect);
  const r = SCREEN_MODE.badge.radius;
  assert.equal(BADGE_LINE_GAP, SCREEN_MODE.badge.gap + SCREEN_MODE.strokeWidth / 2, "clear of the painted line");
  assert.deepEqual({ x: badge.x, y: badge.y }, numberBadgeCenter("rect", rect.points, DISPLAY_1, r, BADGE_LINE_GAP));
  assert.equal(badge.radius, r);
  assert.equal(badgeAt([badge], badge.x + r - 0.5, badge.y)?.id, rect.id, "inside the circle");
  assert.equal(badgeAt([badge], badge.x + r * 0.8, badge.y + r * 0.8), null, "the corner of its square is outside");
  const over = { ...badge, id: 99, x: badge.x + 4 };
  assert.equal(badgeAt([badge, over], badge.x + 2, badge.y).id, 99, "the later number is on top");
});

test("only finished strokes still on the screen have numbers to hit", () => {
  const s = createScreenSession({ id: "x", dir: "/d" });
  drawLine(s, [100, 100], [200, 200], 10); // id 1, shot
  shoot(s, { at: 20, files: ["/d/shot-01.png"] });
  drawLine(s, [300, 100], [400, 200], 30); // id 2
  drawLine(s, [500, 100], [600, 200], 40); // id 3, taken off the screen by a shot in progress
  beginStroke(s, { x: 700, y: 100, at: 50, displayId: 1, displayBounds: DISPLAY_1 }); // id 4, being drawn
  assert.deepEqual(liveBadges(s, new Set([3])).map((b) => b.id), [2]);
});

test("deleting a stroke by its number takes it out of the record and closes up the numbers on the screen", () => {
  const s = createScreenSession({ id: "x", dir: "/d" });
  drawLine(s, [0, 0], [100, 100], 10); // id 1, shot 1
  shoot(s, { at: 15, files: ["/d/shot-01.png"] });
  drawLine(s, [0, 0], [100, 100], 20); // id 2, number 1
  drawLine(s, [200, 0], [300, 100], 30); // id 3, number 2
  drawLine(s, [400, 0], [500, 100], 40); // id 4, number 3
  const gone = deleteStroke(s, 3);
  assert.equal(gone.id, 3);
  assert.equal(gone.n, 2, "it goes with the number the user tapped");
  assert.equal(s.strokes.some((st) => st.id === 3), false, "out of the session record");
  assert.deepEqual(unshotStrokes(s).map((st) => [st.id, st.n]), [[2, 1], [4, 2]], "consecutive again");
  assert.equal(s.strokes.find((st) => st.id === 1).n, 1, "a stroke in a screenshot keeps its number");
  drawLine(s, [600, 0], [700, 100], 50);
  assert.equal(s.strokes[s.strokes.length - 1].n, 3, "the next stroke follows the ones left");
});

test("a stroke in a screenshot, or still being drawn, cannot be deleted", () => {
  const s = createScreenSession({ id: "x", dir: "/d" });
  drawLine(s, [0, 0], [100, 100], 10);
  shoot(s, { at: 15, files: ["/d/shot-01.png"] });
  assert.equal(deleteStroke(s, 1), null);
  beginStroke(s, { x: 5, y: 5, at: 20, displayId: 1, displayBounds: DISPLAY_1 });
  assert.equal(deleteStroke(s, 2), null);
  assert.equal(deleteStroke(s, 42), null);
  assert.equal(s.strokes.length, 2);
});

test("the manifest of a shot after a deletion has no trace of the deleted stroke, and its numbers are 1..k", () => {
  const s = createScreenSession({ id: "x", dir: "/d" });
  drawLine(s, [0, 0], [100, 100], 10);
  drawLine(s, [200, 0], [300, 100], 20);
  drawLine(s, [400, 0], [500, 100], 30);
  deleteStroke(s, 1);
  const shot = shoot(s, { at: 40, files: ["/d/shot-01.png"] });
  assert.deepEqual(shot.strokeIds, [2, 3]);
  const m = screenSessionManifest(s);
  assert.deepEqual(m.events.filter((e) => e.type === "stroke").map((e) => [e.at, e.n]), [[20, 1], [30, 2]]);
  assert.equal(m.events.find((e) => e.type === "shot").strokes, 2);
});

// ── what a shot captures ───────────────────────────────────────────────
const DISPLAYS = [
  { id: 1, bounds: { x: 0, y: 0, width: 1728, height: 1117 } },
  { id: 2, bounds: { x: 1728, y: 0, width: 1920, height: 1080 } },
];

function strokeAt(id, points, displayId = 1) {
  return { id, displayId, points };
}

test("a shot captures the front window, cut to its display, when every stroke touches it", () => {
  const frontWindow = { x: 200, y: 80, width: 1000, height: 700 };
  const plan = planShot({
    strokes: [strokeAt(1, [[300, 200], [400, 260]]), strokeAt(2, [[1150, 700], [1300, 900]])], // 2 runs past the edge
    frontWindow,
    displays: DISPLAYS,
    cursorDisplayId: 1,
  });
  assert.deepEqual(plan, [{ displayId: 1, region: frontWindow, area: "window", strokeIds: [1, 2] }]);
});

test("a stroke wholly outside the front window makes it a whole-display shot", () => {
  const plan = planShot({
    strokes: [strokeAt(1, [[300, 200], [400, 260]]), strokeAt(2, [[1500, 1000], [1600, 1050]])],
    frontWindow: { x: 200, y: 80, width: 1000, height: 700 },
    displays: DISPLAYS,
    cursorDisplayId: 1,
  });
  assert.deepEqual(plan, [{ displayId: 1, region: DISPLAYS[0].bounds, area: "display", strokeIds: [1, 2] }]);
});

test("no front window: every display with strokes, whole; none drawn: the display under the cursor", () => {
  const plan = planShot({
    strokes: [strokeAt(1, [[300, 200], [400, 260]]), strokeAt(2, [[2000, 200], [2100, 300]], 2)],
    frontWindow: null,
    displays: DISPLAYS,
    cursorDisplayId: 1,
  });
  assert.deepEqual(plan.map((t) => [t.displayId, t.area, t.strokeIds]), [[1, "display", [1]], [2, "display", [2]]]);
  assert.deepEqual(
    planShot({ strokes: [], frontWindow: null, displays: DISPLAYS, cursorDisplayId: 2 }),
    [{ displayId: 2, region: DISPLAYS[1].bounds, area: "display", strokeIds: [] }],
  );
  assert.deepEqual(
    planShot({ strokes: [], frontWindow: { x: 1800, y: 100, width: 800, height: 600 }, displays: DISPLAYS, cursorDisplayId: 1 }),
    [{ displayId: 2, region: { x: 1800, y: 100, width: 800, height: 600 }, area: "window", strokeIds: [] }],
    "nothing drawn and a front window: the window",
  );
});

test("a window across two displays is captured on the one holding most of it; a sliver is no window", () => {
  assert.deepEqual(
    windowRegion({ x: 1500, y: 100, width: 1000, height: 500 }, DISPLAYS),
    { displayId: 2, region: { x: 1728, y: 100, width: 772, height: 500 } },
  );
  assert.equal(windowRegion({ x: 1700, y: 100, width: 50, height: 20 }, DISPLAYS), null);
  assert.equal(windowRegion(null, DISPLAYS), null);
  assert.equal(windowRegion({ x: 5000, y: 5000, width: 400, height: 400 }, DISPLAYS), null);
});

test("a stroke drawn on a window placed relative to that window, not the display", () => {
  const s = createScreenSession({ id: "x", dir: "/d", startedAt: 1 });
  drawLine(s, [700, 380], [900, 480], 10); // the middle of the window below
  const win = { x: 200, y: 80, width: 1200, height: 700 };
  recordShot(s, { at: 20, files: ["/d/shot-01.png"], strokeIds: [1], reason: "capsule", area: "window", regions: { 1: win } });
  const stroke = screenSessionManifest(s).events[0];
  assert.deepEqual(stroke.box, { x: 42, y: 43, w: 17, h: 14 });
  assert.deepEqual([stroke.xPct, stroke.yPct], [50, 50]);
});

// ── the cheap copies ───────────────────────────────────────────────────
test("a close-up is the stroke's box plus a margin, cut to the area; none when it would cover most of it", () => {
  const area = { x: 100, y: 100, width: 1000, height: 800 };
  // 200×100 box: 15% is 30 and 15 — the 40 px floor wins on both.
  assert.deepEqual(strokeCropRect({ points: [[500, 400], [700, 500]] }, area), { x: 360, y: 260, width: 280, height: 180 });
  // 600×400 box (over half the area with its margin).
  assert.deepEqual(strokeCropRect({ points: [[300, 300], [900, 700]] }, area), null, "covers over half the area");
  // 300×200 box: 15% is 45 across, the 40 px floor down.
  assert.deepEqual(strokeCropRect({ points: [[400, 300], [700, 500]] }, area), { x: 255, y: 160, width: 390, height: 280 });
  // At the area's corner the margin stops at the edge.
  assert.deepEqual(strokeCropRect({ points: [[100, 100], [150, 140]] }, area), { x: 0, y: 0, width: 90, height: 80 });
});

test("the preview fits the long side and the pixel budget; nothing is scaled up", () => {
  const p = fitWithin(3456, 2234, SCREEN_MODE.preview.maxSide, SCREEN_MODE.preview.maxPixels);
  assert.ok(Math.max(p.width, p.height) <= 1568);
  assert.ok(p.width * p.height <= 1150000);
  assert.ok(Math.abs(p.width / p.height - 3456 / 2234) < 0.01, "aspect kept");
  assert.deepEqual(fitWithin(800, 600, 1568, 1150000), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(2048, 512, SCREEN_MODE.crop.maxSide, 0), { width: 1024, height: 256 });
});

test("strokes drawn in the same millisecond keep their order in the manifest", () => {
  const s = createScreenSession({ id: "x", dir: "/d" });
  for (let i = 0; i < 5; i += 1) {
    beginStroke(s, { x: i * 100, y: 0, at: 1000, displayId: 1, displayBounds: DISPLAY_1 });
    endStroke(s, { x: i * 100 + 50, y: 50, at: 1000 });
  }
  shoot(s, { at: 1000, files: ["/d/shot-01.png"] });
  assert.deepEqual(screenSessionManifest(s).events.map((e) => e.n ?? e.type), [1, 2, 3, 4, 5, "shot"]);
});

// ── clicks ─────────────────────────────────────────────────────────────
test("a click is recorded only when the take's setting is on", () => {
  const off = createScreenSession({ id: "x", dir: "/d" });
  assert.equal(recordClick(off, { x: 10, y: 10, at: 5 }), null);
  assert.equal(off.clicks.length, 0);
  shoot(off, { at: 10, files: ["/d/shot-01.png"] });
  assert.equal(screenSessionManifest(off).events.some((e) => e.type === "click"), false);
  const on = createScreenSession({ id: "x", dir: "/d", recordClicks: true });
  assert.ok(recordClick(on, { x: 10, y: 10, at: 5 }));
  assert.deepEqual(pendingClicks(on).map((c) => c.at), [5]);
});

test("a click belongs to the next shot, placed in percent of the captured area that holds it", () => {
  const s = createScreenSession({ id: "x", dir: "/d", startedAt: 1, recordClicks: true });
  const win = { x: 100, y: 100, width: 400, height: 200 };
  recordClick(s, { x: 300, y: 150, at: 10 }); // inside the window
  recordClick(s, { x: 900, y: 900, at: 20 }); // outside every captured area
  recordShot(s, { at: 30, files: ["/d/shot-01.png"], strokeIds: [], reason: "hotkey", area: SHOT_AREA.WINDOW, clicks: { 1: win, 2: null } });
  recordClick(s, { x: 5, y: 5, at: 40 }); // after the last shot
  const clicks = screenSessionManifest(s).events.filter((e) => e.type === "click");
  assert.deepEqual(clicks, [
    { type: "click", at: 10, shot: 1, xPct: 50, yPct: 25 },
    { type: "click", at: 20, shot: 1 },
    { type: "click", at: 40 },
  ]);
  assert.deepEqual(pendingClicks(s).map((c) => c.at), [40]);
});

test("a click the shot did not take (made while it was captured) stays pending", () => {
  const s = createScreenSession({ id: "x", dir: "/d", recordClicks: true });
  recordClick(s, { x: 1, y: 1, at: 10 });
  recordClick(s, { x: 2, y: 2, at: 20 });
  recordShot(s, { at: 15, files: ["/d/shot-01.png"], strokeIds: [], reason: "hotkey", clicks: { 1: DISPLAY_1 } });
  assert.deepEqual(pendingClicks(s).map((c) => c.id), [2]);
});

test("in the manifest a click comes before the shot taken at the same moment", () => {
  const s = createScreenSession({ id: "x", dir: "/d", recordClicks: true });
  recordClick(s, { x: 1, y: 1, at: 10 });
  recordShot(s, { at: 10, files: ["/d/shot-01.png"], strokeIds: [], reason: "hotkey", clicks: { 1: DISPLAY_1 } });
  assert.deepEqual(screenSessionManifest(s).events.map((e) => e.type), ["click", "shot"]);
});
