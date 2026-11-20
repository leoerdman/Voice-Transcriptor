"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createLaunchApiToken,
  isSameOrigin,
  apiTokenForRequest,
} = require("./backend-auth");

const BASE = "http://127.0.0.1:8321";

test("a launch token is 32 random bytes, URL-safe, and differs per call", () => {
  const a = createLaunchApiToken();
  const b = createLaunchApiToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
});

test("origin comparison is exact, not a prefix match", () => {
  assert.equal(isSameOrigin(`${BASE}/`, BASE), true);
  assert.equal(isSameOrigin(`${BASE}/settings?x=1`, BASE), true);
  assert.equal(isSameOrigin("http://127.0.0.1:8321evil.com/", BASE), false);
  assert.equal(isSameOrigin("http://127.0.0.1:8322/", BASE), false);
  assert.equal(isSameOrigin("https://127.0.0.1:8321/", BASE), false);
  assert.equal(isSameOrigin("data:text/html,x", BASE), false);
  assert.equal(isSameOrigin("not a url", BASE), false);
  assert.equal(isSameOrigin(undefined, BASE), false);
});

test("the main window on the backend's page gets the token", () => {
  assert.equal(
    apiTokenForRequest({ token: "t0k", fromMainWindow: true, senderUrl: `${BASE}/`, backendBaseUrl: BASE }),
    "t0k",
  );
});

test("any other sender, origin or a backend without an address gets nothing", () => {
  const ask = (over) => apiTokenForRequest({
    token: "t0k", fromMainWindow: true, senderUrl: `${BASE}/`, backendBaseUrl: BASE, ...over,
  });
  assert.equal(ask({ fromMainWindow: false }), "");
  assert.equal(ask({ senderUrl: "https://example.com/" }), "");
  assert.equal(ask({ senderUrl: "data:text/html,<p>capsule</p>" }), "");
  assert.equal(ask({ backendBaseUrl: "" }), "");
  assert.equal(ask({ token: undefined }), "");
});
