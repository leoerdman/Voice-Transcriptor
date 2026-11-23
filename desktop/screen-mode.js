"use strict";

/**
 * Screen mode — the pure half.
 *
 * Screen mode is a recording during which the user can draw on the screen
 * and take screenshots. Everything here is data and rules: the session
 * record (strokes, clicks, screenshots, their wall-clock times), the names of the
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
 * verbatim into the overlay page, so the number the user sees live, the
 * one painted into the image and the circle a press must hit to delete
 * its stroke (`liveBadge`) are placed by one rule: they are
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
  // 1.5 times thinner than the first 4 (user, 2026-11-21).
  strokeWidth: 2.5,
  // The number in a circle of the stroke's colour (DIP); the digit is
  // always black — every palette colour is bright (user, 2026-11-21).
  badge: Object.freeze({ digitColor: "#000000", radius: 10, gap: 3, fontSize: 12, fontWeight: 700, fontFamily: "-apple-system, system-ui, sans-serif" }),
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
  // Stroke shapes (DIP, see strokeShape).
  shape: Object.freeze({ dotMaxSize: 12, loopGapRatio: 0.35, loopMinAspect: 0.2, loopMinLength: 2, lineDeviationRatio: 0.08, lineMinDeviation: 6 }),
  // A plain click, painted into the screenshot that follows it (when the
  // "record clicks" setting is on): a small ring with no number, in two
  // neutral tones — a dark ring inside a light halo — so it reads on any
  // background and is never taken for a stroke, which is one palette
  // colour (DIP).
  clickMark: Object.freeze({ radius: 7, ring: 1.75, halo: 4, ringColor: "#000000", haloColor: "rgba(255,255,255,0.9)" }),
  // 3: click events (`type: "click"`) and a thin rectangle read as a line.
  manifestVersion: 3,
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

/**
 * `recordClicks` is the take's "record clicks" setting, read once when the
 * take started (the renderer reports it with the take — Settings owns it):
 * off, a click leaves no trace anywhere.
 */
function createScreenSession({ id, dir, startedAt = Date.now(), color = SCREEN_MODE.colors[0], tool = SCREEN_MODE.tools[0], recordClicks = false }) {
  return {
    id,
    dir,
    startedAt,
    color,
    tool,
    recordClicks: recordClicks === true,
    endedAt: 0,
    strokes: [],
    clicks: [],
    shots: [],
    activeStrokeId: 0,
    nextStrokeId: 1,
    // The number the next stroke on the screen gets (see beginStroke).
    nextStrokeN: 1,
    nextClickId: 1,
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
 * Its number (`n`, drawn beside it and named in its mark) is the next
 * one since the last shot — 1, 2, 3… — and it is the stroke's for good: a
 * deleted stroke's number is neither taken over by the strokes after it
 * nor given again, so what the user has said about "3" stays about 3
 * (user, 2026-11-21: "чтобы id не менялись").
 */
function beginStroke(session, { x, y, at = Date.now(), displayId = 0, displayBounds = null }) {
  const n = session.nextStrokeN++;
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

/**
 * A plain click — the helper's `click`: a press that never moved past the
 * drag threshold and was replayed to the app underneath (a press on our
 * own palette or capsule is a tap and never gets here). Recorded only
 * when the take's setting says so; null otherwise. Like a stroke, it
 * belongs to the next screenshot.
 */
function recordClick(session, { x, y, at = Date.now() }) {
  if (!session.recordClicks) return null;
  const click = { id: session.nextClickId++, at, x, y, shot: 0, region: null };
  session.clicks.push(click);
  return click;
}

/** Clicks not in any shot yet. */
function pendingClicks(session) {
  return session.clicks.filter((c) => c.shot === 0);
}

/** The first of `regions` (global DIP) that holds the point, or null. */
function regionHolding(regions, x, y) {
  return regions.find((r) => r && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) || null;
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
 * What a stroke is, decided once, here, from its points. For the
 * rectangle tool — `rect`, but `line` when one side is no thicker than
 * `lineMinDeviation` and `dot` when both are. For the pen — `dot` (tiny),
 * `loop` (a closed ring: it ends near where it began, relative to its
 * size, and goes round), `line` (every point close to its main axis),
 * otherwise `curve`.
 *
 * The rectangle's line threshold is the pen's own absolute tolerance for
 * "straight" (6 DIP), not a share of the captured area: at 6 DIP the
 * rectangle's two long edges (each `strokeWidth` wide) nearly touch and it
 * looks — and was dragged — as a line, whatever the area; a share of a 5K
 * display (1.5 % ≈ 40 DIP) would call a real box around one line of small
 * text a line. The pen's ratio rule is not used: a long flat box (500×40)
 * around a text line is a box.
 */
function strokeShape(stroke) {
  const rule = SCREEN_MODE.shape;
  const b = strokeBounds(stroke);
  const size = Math.max(b.width, b.height);
  if (stroke.tool === "rect") {
    if (size <= rule.lineMinDeviation) return "dot";
    return Math.min(b.width, b.height) <= rule.lineMinDeviation ? "line" : "rect";
  }
  if (size <= rule.dotMaxSize) return "dot";
  const pts = stroke.points;
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
 * Where a stroke's number goes — one rule for the screen live, the
 * composed screenshot and the press that hits a number to delete it.
 *   * rectangle — outside its TOP-RIGHT corner (of the box as normalised,
 *     whichever way it was dragged): diagonally up and to the right, its
 *     edge `gap` from the corner, so clear of both lines (user,
 *     2026-11-21). It follows that corner while the box is dragged;
 *   * pen — beside the point where the stroke BEGAN, and nowhere else: up
 *     and to the left of it, its edge `gap` from that point. It depends
 *     on the start alone, so it stays put while the stroke is drawn:
 *     placed by the stroke's middle or its box, it slid around the start
 *     as the line grew (user, 2026-11-21: "пускай она просто около начала
 *     полоски стоит").
 * When the first place would leave `view` (the stroke's display live, the
 * captured area in the image), the next one around the same point that
 * fits — mirrored left-right first, then up-down, then both — and the
 * first one pulled inside `view` when none does: never off the picture.
 * Around a rectangle's corner the mirrored places stand off every line
 * they border by the whole `radius + gap` (above the top line, right of
 * the right line, inside the corner): a diagonal offset there would lay
 * the circle on the line it runs along.
 * Self-contained: embedded verbatim in the overlay page.
 *
 * @param {string} tool        "rect" | "pen"
 * @param {number[][]} points  the stroke's points, in the same space as `view`
 * @param {{x:number,y:number,width:number,height:number}} view
 * @param {number} radius
 * @param {number} gap         space between the circle and the line's centre
 *                             (half the line width included)
 */
function numberBadgeCenter(tool, points, view, radius, gap) {
  const fits = (c) => (
    c.x - radius >= view.x && c.y - radius >= view.y &&
    c.x + radius <= view.x + view.width && c.y + radius <= view.y + view.height
  );
  const e = radius + gap;
  const d = e * Math.SQRT1_2;
  let candidates;
  if (tool === "rect") {
    let right = -Infinity;
    let top = Infinity;
    for (const p of points) {
      if (p[0] > right) right = p[0];
      if (p[1] < top) top = p[1];
    }
    candidates = [
      { x: right + d, y: top - d },
      { x: right - d, y: top - e },
      { x: right + e, y: top + d },
      { x: right - e, y: top + e },
    ];
  } else {
    const start = points[0];
    candidates = [
      { x: start[0] - d, y: start[1] - d },
      { x: start[0] + d, y: start[1] - d },
      { x: start[0] - d, y: start[1] + d },
      { x: start[0] + d, y: start[1] + d },
    ];
  }
  for (const c of candidates) if (fits(c)) return c;
  return {
    x: Math.min(Math.max(candidates[0].x, view.x + radius), view.x + view.width - radius),
    y: Math.min(Math.max(candidates[0].y, view.y + radius), view.y + view.height - radius),
  };
}

/**
 * The space between a number's circle and the centre of the line it sits
 * beside: the badge's gap plus half the line's width, so the circle clears
 * the painted line. One value for the overlay page and the hit-test.
 */
const BADGE_LINE_GAP = SCREEN_MODE.badge.gap + SCREEN_MODE.strokeWidth / 2;

/**
 * A stroke's number on the screen, where the overlay draws it live: the
 * circle's centre in global DIP, kept inside the display the stroke was
 * drawn on (its `displayBounds`, the view the overlay is handed with it).
 */
function liveBadge(stroke) {
  const radius = SCREEN_MODE.badge.radius;
  const c = numberBadgeCenter(stroke.tool, stroke.points, stroke.displayBounds, radius, BADGE_LINE_GAP);
  return { id: stroke.id, x: c.x, y: c.y, radius };
}

/**
 * The numbers a press or the pointer can hit: those of the finished
 * strokes still on the screen. A stroke being drawn holds the button, and
 * one a shot has already taken off the screen (`offScreen` ids) is not
 * there to hit. In drawing order, so the last one is on top.
 */
function liveBadges(session, offScreen = new Set()) {
  return pendingStrokes(session).filter((s) => !offScreen.has(s.id)).map(liveBadge);
}

/** The topmost of `badges` whose circle holds the point, or null. */
function badgeAt(badges, x, y) {
  for (let i = badges.length - 1; i >= 0; i -= 1) {
    const b = badges[i];
    if (Math.hypot(x - b.x, y - b.y) <= b.radius) return b;
  }
  return null;
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
 * `clicks` maps each click the shot takes (those pending when the capture
 * began) to the captured region it lies in — null for a click outside
 * every captured area: it is still this shot's, with no place.
 *
 * The screen is clean after a shot, so the next image starts at 1: the
 * strokes still on it (finished after the capture began, or kept from a
 * display that failed) take 1..k and the next stroke k+1. Returns the shot
 * record.
 */
function recordShot(session, { at = Date.now(), files, strokeIds, reason, area = SHOT_AREA.DISPLAY, preview = "", regions = {}, crops = {}, clicks = {} }) {
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
  startNextPicture(session);
  for (const click of pendingClicks(session)) {
    if (!Object.prototype.hasOwnProperty.call(clicks, click.id)) continue;
    click.shot = index;
    click.region = clicks[click.id] ? { ...clicks[click.id] } : null;
  }
  const shot = { index, at, files: files.slice(), strokeIds: taken, reason, area, preview };
  session.shots.push(shot);
  return shot;
}

/**
 * A shot cleared the screen: the next picture is numbered from 1. The
 * strokes it did not take are its first ones, 1..k in drawing order.
 */
function startNextPicture(session) {
  const left = unshotStrokes(session);
  left.forEach((stroke, i) => { stroke.n = i + 1; });
  session.nextStrokeN = left.length + 1;
}

/**
 * The user deleted a stroke by its number (a tap on its circle). Only a
 * finished stroke still on the screen can go: one in a screenshot is part
 * of that picture, and one being drawn holds the button. It leaves the
 * session record — so no screenshot, manifest or transcript mark ever has
 * it. The other strokes keep their numbers and its number is not given
 * again (beginStroke): the picture and the text simply skip it. Returns
 * the deleted stroke, or null when there was none to delete.
 */
function deleteStroke(session, id) {
  const stroke = pendingStrokes(session).find((s) => s.id === id);
  if (!stroke) return null;
  session.strokes.splice(session.strokes.indexOf(stroke), 1);
  return stroke;
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
 * merged: each one has its own number. A click carries its shot and its
 * point in whole percent of that shot's captured area — no shot when no
 * screenshot followed it, no point when it lay outside the captured area.
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
  for (const click of session.clicks) {
    const r = click.region;
    const pct = (v) => Math.max(0, Math.min(100, Math.round(v * 100)));
    events.push({
      type: "click",
      at: click.at,
      ...(click.shot ? { shot: click.shot } : {}),
      ...(r && r.width > 0 && r.height > 0
        ? { xPct: pct((click.x - r.x) / r.width), yPct: pct((click.y - r.y) / r.height) }
        : {}),
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
  // In time order; at the same moment a stroke or a click comes before
  // its shot, and events of one kind keep their order (strokes by number).
  // The sort is stable, so a tie between two strokes must answer 0, never
  // "first".
  const rank = (e) => (e.type === "shot" ? 1 : 0);
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
  regionHolding,
  screenSessionId,
  screenSessionManifest,
  shotFileName,
  strokeCropRect,
  strokePlacement,
  strokeShape,
  unshotStrokes,
  windowRegion,
};
