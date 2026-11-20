"use strict";

/**
 * Screen mode — the pure half.
 *
 * Screen mode is a recording during which the user can draw on the screen
 * and take screenshots. Everything here is data and rules: the session
 * record (strokes, screenshots, their wall-clock times), the names of the
 * session folder and its screenshots, and the manifest (`events.json`)
 * handed to the renderer at stop. No Electron, no filesystem, so
 * `node --test` drives it directly (desktop/screen-mode.test.js).
 *
 * Ownership, so nothing here is decided twice:
 *   * the shell only WRITES a session into the staging folder; the backend
 *     moves it beside the recording on save and owns its retention and
 *     deletion (backend/screen_sessions.py) — one rule with the audio;
 *   * the shell records WHERE a stroke was (percent of its display); the
 *     words for it are the renderer's (frontend/src/screen-annotations.ts);
 *   * what counts as a stroke is decided once, by the native helper's drag
 *     threshold (desktop/native/screen-input/).
 * The names shared with the backend are pinned by
 * contracts/screen-session.json.
 *
 * The Electron half — overlay windows, the colour palette, the native
 * mouse helper, screen capture — is ./screen-mode-controller.js.
 *
 * Times are epoch milliseconds (`Date.now()`), never offsets: the renderer
 * owns the recording clock (`startAt`, the first audio sample) and turns
 * an epoch time into a position in the audio itself. Main and renderer
 * share the system clock, so nothing has to be translated between them.
 */

const SCREEN_MODE = Object.freeze({
  // The palette, in order. The first is the default colour.
  colors: Object.freeze(["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#bf5af2", "#ffffff"]),
  strokeWidth: 4,
  borderColor: "#ff3b30",
  borderWidth: 3,
  // Shared with the backend — contracts/screen-session.json.
  stagingDirName: "screen-sessions",
  sessionDirPrefix: "screen-",
  eventsFileName: "events.json",
});

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

function createScreenSession({ id, dir, startedAt = Date.now(), color = SCREEN_MODE.colors[0] }) {
  return {
    id,
    dir,
    startedAt,
    color,
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

/** Begin a stroke at a global point. Returns the new stroke. */
function beginStroke(session, { x, y, at = Date.now(), displayId = 0 }) {
  const stroke = {
    id: session.nextStrokeId++,
    color: session.color,
    displayId,
    startedAt: at,
    endedAt: at,
    points: [[x, y]],
    shot: 0,
  };
  session.strokes.push(stroke);
  session.activeStrokeId = stroke.id;
  return stroke;
}

function extendStroke(session, { x, y, at = Date.now() }) {
  const stroke = strokeById(session, session.activeStrokeId);
  if (!stroke) return null;
  stroke.points.push([x, y]);
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
 * Strokes drawn since the last screenshot. Every finished stroke counts:
 * the native helper only reports a stroke once the press has moved past
 * its drag threshold, so there is no second "too short" rule here.
 */
function pendingStrokes(session) {
  return session.strokes.filter((s) => s.shot === 0 && s.id !== session.activeStrokeId);
}

/**
 * Where on its display a stroke was drawn: the centre of its bounds as a
 * percentage of the display (0..100 each way), relative to that display's
 * own origin. The renderer turns this into words.
 */
function strokePosition(stroke, displayBounds) {
  const b = strokeBounds(stroke);
  const db = displayBounds && displayBounds.width > 0 && displayBounds.height > 0
    ? displayBounds
    : { x: 0, y: 0, width: 1, height: 1 };
  const cx = Math.max(0, Math.min(1, (b.x + b.width / 2 - db.x) / db.width));
  const cy = Math.max(0, Math.min(1, (b.y + b.height / 2 - db.y) / db.height));
  return { xPct: Math.round(cx * 100), yPct: Math.round(cy * 100) };
}

/**
 * Record a screenshot: the strokes it contains are stamped with its
 * number. Returns the shot record; `files` is filled by the caller once
 * the images are written.
 */
function recordShot(session, { at = Date.now(), files = [], reason = "button" } = {}) {
  const index = session.shots.length + 1;
  const strokeIds = [];
  for (const stroke of pendingStrokes(session)) {
    stroke.shot = index;
    strokeIds.push(stroke.id);
  }
  const shot = { index, at, files, strokeIds, reason };
  session.shots.push(shot);
  return shot;
}

function shotFileName(index, displayOrdinal, displayCount) {
  const n = String(index).padStart(2, "0");
  return displayCount > 1 ? `shot-${n}-display${displayOrdinal}.png` : `shot-${n}.png`;
}

/**
 * The manifest the renderer turns into transcript marks, and the
 * `events.json` written beside the screenshots. One shape for both.
 */
function screenSessionManifest(session, { displayBoundsById = {} } = {}) {
  const events = [];
  for (const stroke of session.strokes) {
    if (!stroke.shot) continue;
    const position = strokePosition(stroke, displayBoundsById[stroke.displayId]);
    events.push({
      type: "stroke",
      at: stroke.startedAt,
      endedAt: stroke.endedAt,
      color: stroke.color,
      shot: stroke.shot,
      xPct: position.xPct,
      yPct: position.yPct,
    });
  }
  for (const shot of session.shots) {
    events.push({
      type: "shot",
      at: shot.at,
      shot: shot.index,
      files: shot.files.slice(),
      strokes: shot.strokeIds.length,
      reason: shot.reason,
    });
  }
  events.sort((a, b) => a.at - b.at || (a.type === "stroke" ? -1 : 1));
  return {
    version: 1,
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
  strokeBounds,
  strokePosition,
};
