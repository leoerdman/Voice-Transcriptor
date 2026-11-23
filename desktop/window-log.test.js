"use strict";

// P3-4: the window a paste is heading to may be identified in main.log by
// its app (name + bundle id), its process and its platform window handle —
// never by its title. A title is the text its user is reading in another
// application: a mail subject, a document name, a chat partner. The log is
// kept for a week and asked from users when they report a problem.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  windowLogFields,
  windowLogSummary,
  redactWindowTitles,
} = require("./private-log");
const { mainSource, topLevelFunctionSource } = require("./main-source");

const SECRET = "Quarterly layoffs — Mail";

/**
 * Every argument list of the log gates, as text, cut out balanced and
 * quote-aware. A line-window heuristic is not enough here: the HEAD leaks
 * sat three lines above their `traceStep`, while a window wide enough to
 * see them would also flag the AppleScript builder that legitimately
 * receives a title as a parameter.
 */
function logCallArguments(source) {
  const names = /(appendMainLog|traceStep|traceEnd|createTrace|logPasteTrace)\s*\(/g;
  const calls = [];
  let m;
  while ((m = names.exec(source)) !== null) {
    let i = names.lastIndex;
    let depth = 1;
    const start = i;
    while (i < source.length && depth > 0) {
      const c = source[i];
      if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        i += 1;
        while (i < source.length && source[i] !== quote) {
          if (source[i] === "\\") i += 1;
          i += 1;
        }
        if (i >= source.length) break;
      } else if (c === "(") {
        depth += 1;
      } else if (c === ")") {
        depth -= 1;
      }
      i += 1;
    }
    calls.push(source.slice(start, i - 1));
  }
  return calls;
}

test("a foreign window's summary keeps identity and drops the title", () => {
  const summary = windowLogSummary({
    appName: "Mail",
    pid: 4242,
    bundleId: "com.apple.mail",
    windowTitle: SECRET,
  });
  assert.ok(!summary.includes(SECRET), summary);
  assert.match(summary, /app="Mail"/);
  assert.match(summary, /pid=4242/);
  assert.match(summary, /bundleId="com.apple.mail"/);

  // The other platforms' handles: Linux's X11 window id and class,
  // Windows' hwnd, and the frontmost-app answer that spells it `name`.
  const linux = windowLogSummary({ appName: "code", windowId: "0x3e00007", className: "Code", windowTitle: SECRET });
  assert.ok(!linux.includes(SECRET), linux);
  assert.match(linux, /windowId="0x3e00007"/);
  assert.match(linux, /class="Code"/);
  const win = windowLogSummary({ appName: "chrome", hwnd: "0x000A1B2C", windowTitle: SECRET });
  assert.ok(!win.includes(SECRET), win);
  assert.match(win, /hwnd="0x000A1B2C"/);
  const front = windowLogFields({ name: "Preview", pid: 9, bundleId: "com.apple.Preview", windowTitle: SECRET });
  assert.ok(!JSON.stringify(front).includes(SECRET));
  assert.deepEqual(front, { app: "Preview", pid: 9, bundleId: "com.apple.Preview" });
});

test("the structured log gates strip a window title wherever it is nested", () => {
  const details = {
    target: { appName: "Mail", windowTitle: SECRET, windowId: "7" },
    frontBeforeWindowTitle: SECRET,
    list: [{ window_title: SECRET }, { safe: "kept" }],
    bundleId: "com.apple.mail",
  };
  assert.deepEqual(redactWindowTitles(details), {
    target: { appName: "Mail", windowId: "7" },
    list: [{}, { safe: "kept" }],
    bundleId: "com.apple.mail",
  });
  // A Date is a value, not a container to walk into.
  const when = new Date(0);
  assert.equal(redactWindowTitles({ when }).when, when);
  // One object shared by two fields is redacted once, not passed through
  // as its original on the second encounter.
  const shared = { appName: "Mail", windowTitle: SECRET };
  const twice = redactWindowTitles({ a: shared, b: shared });
  assert.ok(!JSON.stringify(twice).includes(SECRET), JSON.stringify(twice));
  // A cycle resolves to the redacted copy rather than the original.
  const cyclic = { appName: "Mail", windowTitle: SECRET };
  cyclic.self = cyclic;
  const cut = redactWindowTitles(cyclic);
  assert.equal(cut.self, cut);
  assert.ok(!("windowTitle" in cut));
});

test("main.js has no window-title log path left", () => {
  // No log gate may receive a window title in its own arguments. This is
  // what the HEAD code failed: three `front_before` traces passed one,
  // and the post-stop line got one through the summary formatter.
  const leaks = logCallArguments(mainSource).filter((args) => /(?<!redact)windowTitle/i.test(args));
  assert.deepEqual(
    leaks.map((args) => args.replace(/\s+/g, " ").slice(0, 100)),
    [],
    "a log gate receives a window title",
  );
  // The formatter that carried the title is gone from main.js: every
  // window-bearing log line now goes through the module.
  assert.equal(
    topLevelFunctionSource("pasteTargetSummary"),
    "",
    "the title-carrying summary must stay deleted",
  );
  // ...and every structured gate asks the module to redact, so a future
  // traceStep that passes a whole window object still cannot leak.
  for (const fn of ["createTrace", "traceStep", "traceEnd", "logPasteTrace"]) {
    assert.match(topLevelFunctionSource(fn), /redactWindowTitles\(/, `${fn} must redact window titles`);
  }
});

test("the post-stop enqueue line names the target by identity", () => {
  // P3-4's own line: the queue entry is built from the captured target.
  const line =
    `[post-stop-queue] enqueue pending=1 rec=7 ` +
    windowLogSummary({ appName: "Mail", pid: 4, bundleId: "com.apple.mail", windowTitle: SECRET });
  assert.ok(!line.includes(SECRET), line);
  assert.match(mainSource, /\$\{windowLogSummary\(task\.target\)\}/);
});
