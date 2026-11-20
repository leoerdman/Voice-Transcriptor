"use strict";

// How the main window gets the backend's API token (Ultra-Audit 2026-11-20
// BM-01).
//
// The backend used to write the token into the HTML of its own
// unauthenticated `GET /` page. Anything that could reach the loopback
// port — another local process, another OS user on the same Mac, an agent
// handed only the narrow CLI token — could read the page and with it the
// FULL token: config and provider keys, the archive, delete-all. The
// weaker CLI credential was therefore cosmetic.
//
// The shell now owns the secret. It mints one token per launch, hands it
// to the backend in the child's environment (`TRANSCRIPTOR_API_TOKEN`,
// which `backend.main._load_or_create_api_token` already honours; a
// process environment is readable only by its own user), and gives it to
// the main window through the preload over a synchronous IPC call
// (`API_TOKEN_CHANNEL`). The page is served without it.
//
// One token per LAUNCH, not per backend spawn: the renderer reads the
// token once per page load, and the backend is restarted under a living
// page (engine install, crash recovery) — a fresh token per spawn would
// leave that page holding a dead one.
//
// Pure: no Electron — desktop/backend-auth.test.js.

const crypto = require("crypto");

/** The IPC channel the preload asks on. One fixed name, sync. */
const API_TOKEN_CHANNEL = "backend:api-token";

/** A fresh launch token: 32 random bytes, URL-safe (it travels in a header). */
function createLaunchApiToken(randomBytes = crypto.randomBytes) {
  return randomBytes(32).toString("base64url");
}

/**
 * Same protocol + host + port. URL parsing, not a prefix match:
 * "http://127.0.0.1:8321" prefix-matches "http://127.0.0.1:8321evil.com".
 */
function isSameOrigin(rawUrl, baseUrl) {
  if (typeof rawUrl !== "string" || typeof baseUrl !== "string") return false;
  let parsed;
  let base;
  try {
    parsed = new URL(rawUrl);
    base = new URL(baseUrl);
  } catch {
    return false;
  }
  return parsed.protocol === base.protocol
    && parsed.hostname === base.hostname
    && parsed.port === base.port;
}

/**
 * What an `API_TOKEN_CHANNEL` request is answered with: the token only for
 * the main window's own webContents showing a page of the backend's
 * origin; "" for anyone else (another window, a page the main window was
 * somehow navigated to, a request before the backend has an address).
 */
function apiTokenForRequest({ token, fromMainWindow, senderUrl, backendBaseUrl }) {
  if (!fromMainWindow) return "";
  if (!backendBaseUrl || !isSameOrigin(senderUrl, backendBaseUrl)) return "";
  return typeof token === "string" ? token : "";
}

module.exports = {
  API_TOKEN_CHANNEL,
  createLaunchApiToken,
  isSameOrigin,
  apiTokenForRequest,
};
