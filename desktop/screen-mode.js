"use strict";

/**
 * Screen mode — the pure half.
 *
 * Screen mode is a recording during which the user can draw on the screen
 * and take screenshots. Everything here is data and rules: the session
 * record (strokes, screenshots, their wall-clock times), the names of the
 * session folder and its images, what a shot captures (the front window
 * or the display), each stroke's number, shape and place, and the
 * manifest (`events.json`) handed to the renderer at stop. No Electron,
 * no filesystem, so `node --test` drives it directly
 * (desktop/screen-mode.test.js).
 *
 * Ownership, so nothing here is decided twice:
 *   * the shell only WRITES a session into the staging folder; the backend
 *     moves it beside the recording on save and owns its retention and
 *     deletion (backend/screen_sessions.py) — one rule with the audio;
 *   * the shell records WHAT a stroke is and WHERE it was (its shape, its
 *     number on the picture, its box in percent of the captured area);
 *     the words for it are the renderer's (frontend/src/screen-annotations.ts);
 *   * what counts as a stroke is decided once, by the native helper's drag
 *     threshold (desktop/native/screen-input/).
 * The names shared with the backend are pinned by
 * contracts/screen-session.json.
 *
 * The Electron half — overlay windows, the tool palette, the native
 * mouse helper, screen capture — is ./screen-mode-controller.js. Two
 * functions here (`numberBadgeCenter`, `fitWithin`) are also embedded
 * verbatim into the overlay page, so the number the user sees live and
 * the one painted into the image are placed by one rule: they are
 * self-contained on purpose (no outside names).
 *
 * Times are epoch milliseconds (`Date.now()`), never offsets: the renderer
 * owns the recording clock (`startAt`, the first audio sample) and turns
 * an epoch time into a position in the audio itself. Main and renderer
 * share the system clock, so nothing has to be translated between them.
 */

const SCREEN_MODE = Object.freeze({
  // The palette, in order. The first is the default colour. Colours only
  // tell strokes apart; they carry no meaning.
  colors: Object.freeze(["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#bf5af2", "#ffffff"]),
  // The tools, in palette order. Every take starts with the first.
  tools: Object.freeze(["rect", "pen"]),
  strokeWidth: 4,
  borderColor: "#ff3b30",
  borderWidth: 3,
  // The number in a circle of the stroke's colour (DIP).
  badge: Object.freeze({ radius: 10, gap: 3, fontSize: 12, fontWeight: 700, fontFamily: "-apple-system, system-ui, sans-serif" }),
  // The front window is the captured area only if it is at least this
  // big on its display (DIP): a sliver is not "the window the user means".
  // The helper is handed it with every request, so a tiny window on top is
  // passed over there by the same number.
  minWindowSide: 40,
  // The agent's cheap copies. The preview stays inside the size an image
  // is read at without being scaled again (long side and pixel count);
  // a stroke's close-up is its box plus a margin, from the image with the
  // drawings, and is skipped when it would cover most of the area anyway
  // (the preview already shows that stroke at that scale).
  preview: Object.freeze({ maxSide: 1568, maxPixels: 1150000, quality: 0.8 }),
  crop: Object.freeze({ marginRatio: 0.15, minMargin: 40, maxSide: 1024, maxAreaShare: 0.5, quality: 0.8 }),
  // Pen shapes (DIP, see strokeShape).
  shape: Object.freeze({ dotMaxSize: 12, loopGapRatio: 0.35, loopMinAspect: 0.2, loopMinLength: 2, lineDeviationRatio: 0.08, lineMinDeviation: 6 }),
  manifestVersion: 2,
  // Shared with the backend — contracts/screen-session.json.
  stagingDirName: "screen-sessions",
  sessionDirPrefix: "screen-",
  eventsFileName: "events.json",
});

/** What a shot captured: the front window, or the whole display. */
const SHOT_AREA = Object.freeze({ WINDOW: "window", DISPLAY: "display" });

/** A sortable, filesystem-safe session id: screen-YYYYMMDD-HHMMSS-mmm. */
function screenSessionId(now = Date.now()) {
  const d = new Date(now);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${SCREEN_MODE.sessionDirPrefix}${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
  );
}

function isScreenSessionId(name) {
  return /^screen-\d{8}-\d{6}-\d{3}$/.test(String(name || ""));
}

function createScreenSession({ id, dir, startedAt = Date.now(), color = SCREEN_MODE.colors[0], tool = SCREEN_MODE.tools[0] }) {
  return {
    id,
    dir,
    startedAt,
    color,
    tool,
    endedAt: 0,
    strokes: [],
    shots: [],
    activeStrokeId: 0,
    nextStrokeId: 1,
  };
}

function strokeById(session, id) {
  return session.strokes.find((s) => s.id === id) || null;
}

/** Strokes not in any shot yet — on the screen, finished or being drawn. */
function unshotStrokes(session) {
  return session.strokes.filter((s) => s.shot === 0);
}

/**
 * Begin a stroke at a global point. Returns the new stroke.
 *
 * `displayBounds` are the bounds of the display the stroke is drawn on AT
 * THIS MOMENT. Where a stroke was is a fact about when it was drawn: a
 * display unplugged or rearranged later must not move it.
 *
 * Its number (`n`, drawn beside it and named in its mark) follows the
 * strokes already on the screen: 1, 2, 3… since the last shot.
 */
function beginStroke(session, { x, y, at = Date.now(), displayId = 0, displayBounds = null }) {
  const n = unshotStrokes(session).reduce((max, s) => Math.max(max, s.n), 0) + 1;
  const stroke = {
    id: session.nextStrokeId++,
    n,
    tool: session.tool,
    color: session.color,
    displayId,
    displayBounds: displayBounds
      ? { x: displayBounds.x, y: displayBounds.y, width: displayBounds.width, height: displayBounds.height }
      : null,
    startedAt: at,
    endedAt: at,
    points: [[x, y]],
    shot: 0,
    region: null,
    crop: "",
  };
  session.strokes.push(stroke);
  session.activeStrokeId = stroke.id;
  return stroke;
}

/**
 * A pen stroke keeps every point; a rectangle is its two corners — where
 * the press began and where the pointer is now (so it stretches in any
 * direction while it is drawn).
 */
function extendStroke(session, { x, y, at = Date.now() }) {
  const stroke = strokeById(session, session.activeStrokeId);
  if (!stroke) return null;
  if (stroke.tool === "rect") stroke.points = [stroke.points[0], [x, y]];
  else stroke.points.push([x, y]);
  stroke.endedAt = at;
  return stroke;
}

function endStroke(session, { x, y, at = Date.now() }) {
  const stroke = extendStroke(session, { x, y, at });
  session.activeStrokeId = 0;
  return stroke;
}

function strokeBounds(stroke) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of stroke.points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * What a stroke is, decided once, here, from its points: `rect` for the
 * rectangle tool; for the pen — `dot` (tiny), `loop` (a closed ring: it
 * ends near where it began, relative to its size, and goes round), `line`
 * (every point close to its main axis), otherwise `curve`.
 */
function strokeShape(stroke) {
  if (stroke.tool === "rect") return "rect";
  const rule = SCREEN_MODE.shape;
  const pts = stroke.points;
  const b = strokeBounds(stroke);
  const size = Math.max(b.width, b.height);
  if (size <= rule.dotMaxSize) return "dot";
  let length = 0;
  for (let i = 1; i < pts.length; i += 1) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const [x0, y0] = pts[0];
  const [x1, y1] = pts[pts.length - 1];
  const chord = Math.hypot(x1 - x0, y1 - y0);
  if (
    chord <= rule.loopGapRatio * size &&
    Math.min(b.width, b.height) >= rule.loopMinAspect * size &&
    length >= rule.loopMinLength * size
  ) {
    return "loop";
  }
  // A line: every point close to the stroke's main axis (through its
  // centroid) — so a line drawn out and back over itself is a line too.
  let cx = 0;
  let cy = 0;
  for (const [x, y] of pts) {
    cx += x;
    cy += y;
  }
  cx /= pts.length;
  cy /= pts.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of pts) {
    sxx += (x - cx) * (x - cx);
    syy += (y - cy) * (y - cy);
    sxy += (x - cx) * (y - cy);
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  let lo = Infinity;
  let hi = -Infinity;
  let across = 0;
  for (const [x, y] of pts) {
    const along = (x - cx) * ux + (y - cy) * uy;
    lo = Math.min(lo, along);
    hi = Math.max(hi, along);
    across = Math.max(across, Math.abs((y - cy) * ux - (x - cx) * uy));
  }
  if (across <= Math.max(rule.lineMinDeviation, rule.lineDeviationRatio * (hi - lo))) return "line";
  return "curve";
}

/**
 * Where a stroke's number goes: the centre of a circle of `radius` that
 * must not cover what the stroke marks and must stay inside `view` (the
 * display live, the captured area in the image).
 *   * rectangle — outside its top-left corner (diagonally, then above,
 *     then to the left); inside the corner only when none of those fits;
 *   * pen — just past where the stroke began, on the side away from the
 *     stroke's middle (outside a ring, beyond the start of a line).
 * Self-contained: embedded verbatim in the overlay page.
 *
 * @param {string} tool
 * @param {number[][]} points  the stroke's points, in the same space as `view`
 * @param {{x:number,y:number,width:number,height:number}} view
 * @param {number} radius
 * @param {number} gap         space between the circle and the stroke's
 *                             centre line (half the line width included)
 */
function numberBadgeCenter(tool, points, view, radius, gap) {
  const fits = (c) => (
    c.x - radius >= view.x && c.y - radius >= view.y &&
    c.x + radius <= view.x + view.width && c.y + radius <= view.y + view.height
  );
  const clamp = (c) => ({
    x: Math.min(Math.max(c.x, view.x + radius), view.x + view.width - radius),
    y: Math.min(Math.max(c.y, view.y + radius), view.y + view.height - radius),
  });
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }
  const off = radius + gap;
  let candidates;
  if (tool === "rect") {
    // Diagonally off the corner, its edge `gap` from the corner point; the
    // circle then clears both sides' lines, which start at the corner.
    const diagonal = off * Math.SQRT1_2;
    candidates = [
      { x: minX - diagonal, y: minY - diagonal },
      { x: minX + radius, y: minY - off },
      { x: minX - off, y: minY + radius },
      { x: minX + off, y: minY + off },
    ];
  } else {
    const start = points[0];
    let dx = start[0] - (minX + maxX) / 2;
    let dy = start[1] - (minY + maxY) / 2;
    const len = Math.hypot(dx, dy);
    if (len < 1) {
      dx = -Math.SQRT1_2;
      dy = -Math.SQRT1_2;
    } else {
      dx /= len;
      dy /= len;
    }
    candidates = [
      { x: start[0] + dx * off, y: start[1] + dy * off },
      { x: start[0] - off * Math.SQRT1_2, y: start[1] - off * Math.SQRT1_2 },
      { x: start[0] + off * Math.SQRT1_2, y: start[1] + off * Math.SQRT1_2 },
    ];
  }
  for (const c of candidates) if (fits(c)) return c;
  return clamp(candidates[0]);
}

/**
 * The size an image of `width`×`height` is scaled down to so that its
 * long side is at most `maxSide` and it has at most `maxPixels` pixels
 * (never scaled up). Self-contained: embedded verbatim in the overlay page.
 */
function fitWithin(width, height, maxSide, maxPixels) {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const scale = Math.min(1, maxSide / Math.max(w, h), maxPixels > 0 ? Math.sqrt(maxPixels / (w * h)) : 1);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  return r > x && btm > y ? { x, y, width: r - x, height: btm - y } : null;
}

// A stroke's bounds touch a region (a perfectly straight stroke has zero
// width or height, so the test is inclusive).
function touches(bounds, region) {
  return (
    bounds.x <= region.x + region.width && bounds.x + bounds.width >= region.x &&
    bounds.y <= region.y + region.height && bounds.y + bounds.height >= region.y
  );
}

/**
 * The front window as a capture region: the part of it on the display
 * that holds most of it, in whole points. Null when there is no front
 * window or that part is too small to be the window the user means.
 *
 * @param {{x:number,y:number,width:number,height:number}|null} frontWindow  global DIP
 * @param {{id:number, bounds:object}[]} displays
 */
function windowRegion(frontWindow, displays) {
  if (!frontWindow || !(frontWindow.width > 0) || !(frontWindow.height > 0)) return null;
  let best = null;
  for (const d of displays) {
    const part = intersect(frontWindow, d.bounds);
    if (part && (!best || part.width * part.height > best.region.width * best.region.height)) {
      best = { displayId: d.id, region: part };
    }
  }
  if (!best) return null;
  const r = best.region;
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  const region = { x, y, width: Math.round(r.x + r.width) - x, height: Math.round(r.y + r.height) - y };
  if (region.width < SCREEN_MODE.minWindowSide || region.height < SCREEN_MODE.minWindowSide) return null;
  return { displayId: best.displayId, region };
}

/**
 * What a shot captures — decided once, when it is asked for.
 *
 *   * The front window (of the front app; never our own overlay, palette
 *     or capsule), cut to its display, when every stroke it holds touches
 *     that window: one image, `area: "window"`, no menu bar, no Dock.
 *   * Otherwise — no front window, or a stroke lying wholly outside it —
 *     every display that has strokes (or, with none, the display under
 *     the cursor), whole: `area: "display"`. A shot never claims a stroke
 *     its image does not show.
 *
 * @returns {{displayId:number, region:object|null, area:string, strokeIds:number[]}[]}
 *   `region` is global DIP; null for a display that is gone (a failure).
 */
function planShot({ strokes, frontWindow, displays, cursorDisplayId }) {
  const win = windowRegion(frontWindow, displays);
  if (win && strokes.every((s) => touches(strokeBounds(s), win.region))) {
    return [{ displayId: win.displayId, region: win.region, area: SHOT_AREA.WINDOW, strokeIds: strokes.map((s) => s.id) }];
  }
  const displayIds = [...new Set(strokes.map((s) => s.displayId))];
  if (!displayIds.length) displayIds.push(cursorDisplayId);
  return displayIds.map((displayId) => {
    const display = displays.find((d) => d.id === displayId);
    return {
      displayId,
      region: display ? { ...display.bounds } : null,
      area: SHOT_AREA.DISPLAY,
      strokeIds: strokes.filter((s) => s.displayId === displayId).map((s) => s.id),
    };
  });
}

// A stroke's bounds cut to a region (a stroke partly outside the captured
// area is described by the part the image shows).
function clippedBounds(stroke, region) {
  const b = strokeBounds(stroke);
  const clampX = (v) => Math.min(Math.max(v, region.x), region.x + region.width);
  const clampY = (v) => Math.min(Math.max(v, region.y), region.y + region.height);
  const x0 = clampX(b.x);
  const y0 = clampY(b.y);
  return { x: x0, y: y0, width: clampX(b.x + b.width) - x0, height: clampY(b.y + b.height) - y0 };
}

function usableRegion(region) {
  return region && region.width > 0 && region.height > 0 ? region : { x: 0, y: 0, width: 1, height: 1 };
}

/**
 * Where a stroke is in the captured area: its box and its centre in whole
 * percent of that area (0..100), relative to the area's own origin. The
 * renderer turns this into words.
 */
function strokePlacement(stroke, captureRegion) {
  const r = usableRegion(captureRegion);
  const c = clippedBounds(stroke, r);
  const pct = (v) => Math.max(0, Math.min(100, Math.round(v * 100)));
  const x = pct((c.x - r.x) / r.width);
  const y = pct((c.y - r.y) / r.height);
  return {
    box: {
      x,
      y,
      w: Math.min(100 - x, pct(c.width / r.width)),
      h: Math.min(100 - y, pct(c.height / r.height)),
    },
    xPct: pct((c.x + c.width / 2 - r.x) / r.width),
    yPct: pct((c.y + c.height / 2 - r.y) / r.height),
  };
}

/**
 * The close-up of one stroke: its box (cut to the captured area) plus a
 * margin of ~15% each way and never less than `minMargin`, cut to the
 * area again; relative to the area's origin, in DIP. Null when it would
 * cover `maxAreaShare` of the area or more — the preview already shows
 * that stroke at that scale, and a second copy of it would only cost.
 */
function strokeCropRect(stroke, captureRegion) {
  const rule = SCREEN_MODE.crop;
  const r = usableRegion(captureRegion);
  const c = clippedBounds(stroke, r);
  const mx = Math.max(rule.minMargin, c.width * rule.marginRatio);
  const my = Math.max(rule.minMargin, c.height * rule.marginRatio);
  const part = intersect({ x: c.x - mx, y: c.y - my, width: c.width + 2 * mx, height: c.height + 2 * my }, r);
  if (!part || part.width * part.height >= rule.maxAreaShare * r.width * r.height) return null;
  const x = Math.floor(part.x - r.x);
  const y = Math.floor(part.y - r.y);
  return {
    x,
    y,
    width: Math.min(r.width - x, Math.ceil(part.x + part.width - r.x) - x),
    height: Math.min(r.height - y, Math.ceil(part.y + part.height - r.y) - y),
  };
}

/**
 * Strokes drawn since the last screenshot. Every finished stroke counts:
 * the native helper only reports a stroke once the press has moved past
 * its drag threshold, so there is no second "too short" rule here.
 */
function pendingStrokes(session) {
  return session.strokes.filter((s) => s.shot === 0 && s.id !== session.activeStrokeId);
}

/**
 * Record a screenshot: the strokes it contains are stamped with its
 * number. `strokeIds` are the strokes the images were actually made with
 * — decided once, by the caller, when the capture began; a stroke that
 * finished while the images were being taken is not in them and stays
 * pending. `reason` says what asked for the shot (`capsule`, `hotkey`,
 * `stop`), for the log and events.json. `area` is what was captured
 * (`SHOT_AREA`), `regions` the captured region (global DIP) each stroke
 * is placed in, `crops` each stroke's close-up file and `preview` the
 * downscaled copy of the first image (absent ones are left out).
 *
 * The screen is clean after a shot, so the strokes still on it (finished
 * after the capture began, or kept from a display that failed) are
 * numbered again from 1: the next image starts at 1 too. Returns the shot
 * record.
 */
function recordShot(session, { at = Date.now(), files, strokeIds, reason, area = SHOT_AREA.DISPLAY, preview = "", regions = {}, crops = {} }) {
  const index = session.shots.length + 1;
  const wanted = new Set(strokeIds);
  const taken = [];
  for (const stroke of pendingStrokes(session)) {
    if (!wanted.has(stroke.id)) continue;
    stroke.shot = index;
    stroke.region = regions[stroke.id] ? { ...regions[stroke.id] } : stroke.displayBounds;
    stroke.crop = crops[stroke.id] || "";
    taken.push(stroke.id);
  }
  unshotStrokes(session).forEach((stroke, i) => { stroke.n = i + 1; });
  const shot = { index, at, files: files.slice(), strokeIds: taken, reason, area, preview };
  session.shots.push(shot);
  return shot;
}

function shotFileName(index, displayOrdinal, displayCount) {
  const n = String(index).padStart(2, "0");
  return displayCount > 1 ? `shot-${n}-display${displayOrdinal}.png` : `shot-${n}.png`;
}

/** The downscaled copy of a shot's first image (contracts: derivedImageNamePattern). */
function previewFileName(index) {
  return `shot-${String(index).padStart(2, "0")}-preview.jpg`;
}

/** The close-up of stroke number `n` of a shot (contracts: derivedImageNamePattern). */
function cropFileName(index, n) {
  return `shot-${String(index).padStart(2, "0")}-n${n}.jpg`;
}

/**
 * The manifest the renderer turns into transcript marks, and the
 * `events.json` written beside the screenshots. One shape for both;
 * contracts/screen-session.json holds an example of it. Strokes are never
 * merged: each one has its own number.
 */
function screenSessionManifest(session) {
  const events = [];
  for (const stroke of session.strokes) {
    if (!stroke.shot) continue;
    const place = strokePlacement(stroke, stroke.region || stroke.displayBounds);
    events.push({
      type: "stroke",
      at: stroke.startedAt,
      endedAt: stroke.endedAt,
      color: stroke.color,
      shot: stroke.shot,
      n: stroke.n,
      tool: stroke.tool,
      shape: strokeShape(stroke),
      box: place.box,
      xPct: place.xPct,
      yPct: place.yPct,
      ...(stroke.crop ? { crop: stroke.crop } : {}),
    });
  }
  for (const shot of session.shots) {
    events.push({
      type: "shot",
      at: shot.at,
      shot: shot.index,
      files: shot.files.slice(),
      ...(shot.preview ? { preview: shot.preview } : {}),
      area: shot.area,
      strokes: shot.strokeIds.length,
      reason: shot.reason,
    });
  }
  // In time order; at the same moment a stroke comes before its shot, and
  // events of one kind keep their order (strokes by number). The sort is
  // stable, so a tie between two strokes must answer 0, never "first".
  const rank = (e) => (e.type === "stroke" ? 0 : 1);
  events.sort((a, b) => a.at - b.at || rank(a) - rank(b));
  return {
    version: SCREEN_MODE.manifestVersion,
    id: session.id,
    dir: session.dir,
    startedAt: session.startedAt,
    // Set when the take stops (the controller's finish). Together with the
    // archived audio clock it is the take's time frame.
    ...(session.endedAt ? { endedAt: session.endedAt } : {}),
    events,
  };
}

module.exports = {
  SCREEN_MODE,
  SHOT_AREA,
  beginStroke,
  createScreenSession,
  cropFileName,
  endStroke,
  extendStroke,
  fitWithin,
  isScreenSessionId,
  numberBadgeCenter,
  pendingStrokes,
  planShot,
  previewFileName,
  recordShot,
  screenSessionId,
  screenSessionManifest,
  shotFileName,
  strokeBounds,
  strokeCropRect,
  strokePlacement,
  strokeShape,
  unshotStrokes,
  windowRegion,
};
