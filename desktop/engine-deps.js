"use strict";

// Engine dependency policy + install lifecycle primitives — the single
// source of truth (SSOT) for everything GigaAM-engine-install related
// that can be pure. Unit-tested directly by engine-deps.test.js against
// the exact code Electron loads, mirroring the ./accelerator.js pattern.
//
// ── Why this module exists ────────────────────────────────────────────
//
// The engine stack (torch + gigaam + audio deps) installs into a
// --target directory (userData/engine-site) which is PREPENDED to
// PYTHONPATH for every backend interpreter invocation. Path-level
// precedence means ANY package name present in both the release-pinned
// bundle site-packages and engine-site silently shadows the pinned
// version — the bug class behind numpy/ml_dtypes hand-pruning
// (commit 7c7bb63). An empirical audit (2026-08-24) found ~20 such
// shadowed names, including runtime-critical ones (onnxruntime, cffi,
// sympy, typing_extensions).
//
// The invariant enforced here instead:
//
//   engine-site may only ADD names the bundle does not ship.
//   Every overlapping name is pruned from the staged install UNLESS a
//   staged distribution explicitly requires it AND the bundle copy does
//   not satisfy that requirement — in which case the install FAILS
//   LOUDLY with a precise conflict report instead of silently winning
//   or losing an import-resolution race.

const ENGINE_INSTALL_PHASES = Object.freeze({
  IDLE: "idle",
  PROBING: "probing",
  INSTALLING: "installing",
  DONE: "done",
  FAILED: "failed",
});

// Hosts the staged `pip install -r requirements-gigaam.txt` must reach:
// PyPI serves the wheels, github.com serves the pinned GigaAM checkout.
const ENGINE_NETWORK_HOSTS = Object.freeze([
  { host: "pypi.org", port: 443 },
  { host: "github.com", port: 443 },
]);

// Free-disk floor for the install (bytes): ~2 GB download, ~6-7 GB
// unpacked, plus pip's cache copy mid-install. Verified ceiling with
// headroom; see BUG-33.
const ENGINE_MIN_FREE_BYTES = 8 * 1024 * 1024 * 1024;

// ── PEP 508 environment markers ───────────────────────────────────────
//
// `Requires-Dist: sympy>=1.14; python_version >= "3.11"` is a real
// requirement here — Python 3.12 satisfies that marker. The old code
// dropped EVERY marked requirement on the floor with a doc comment
// claiming markers "do not constrain this platform", which is true only
// of the platform-scoped ones. A dropped requirement is invisible to
// collectRequirementIndex, so planEngineSitePrune sees an empty
// specifier list, concludes nobody cares, and prunes the staged copy in
// favour of a bundle copy that does NOT satisfy it — precisely the
// silent import-resolution loss this module exists to prevent, and the
// one place its own principle ("absence of declarations != permission")
// was broken.
//
// So markers are EVALUATED. What cannot be evaluated — an unknown
// variable, a shape this parser does not cover — is reported, never
// assumed away.

/** Marker variables this evaluator understands. */
const MARKER_VARIABLES = Object.freeze([
  "python_version",
  "python_full_version",
  "platform_system",
  "platform_machine",
  "platform_python_implementation",
  "implementation_name",
  "sys_platform",
  "os_name",
  "extra",
]);

/** The environment the engine install actually runs in. */
function defaultMarkerEnvironment(overrides = {}) {
  const sysPlatform = process.platform === "win32"
    ? "win32"
    : process.platform === "darwin" ? "darwin" : "linux";
  const platformSystem = process.platform === "win32"
    ? "Windows"
    : process.platform === "darwin" ? "Darwin" : "Linux";
  return {
    // Filled in by the caller from the interpreter that will run the
    // engine; the process running Electron is NOT that interpreter.
    python_version: "",
    python_full_version: "",
    platform_system: platformSystem,
    platform_machine: process.arch === "x64" ? "x86_64" : process.arch,
    platform_python_implementation: "CPython",
    implementation_name: "cpython",
    sys_platform: sysPlatform,
    os_name: process.platform === "win32" ? "nt" : "posix",
    // No extras are requested: requirements-gigaam.txt names packages,
    // not `pkg[extra]`. An `extra == "x"` marker is therefore false.
    extra: "",
    ...overrides,
  };
}

/** Compare two marker operands, version-aware for the version variables. */
function compareMarkerOperands(op, left, right, versionAware) {
  if (op === "in") return String(right).includes(String(left));
  if (op === "not in") return !String(right).includes(String(left));
  if (versionAware) {
    const c = compareVersions(left, right);
    switch (op) {
      case "==": return c === 0;
      case "!=": return c !== 0;
      case "<": return c < 0;
      case "<=": return c <= 0;
      case ">": return c > 0;
      case ">=": return c >= 0;
      default: return null;
    }
  }
  switch (op) {
    case "==": return String(left) === String(right);
    case "!=": return String(left) !== String(right);
    case "<": return String(left) < String(right);
    case "<=": return String(left) <= String(right);
    case ">": return String(left) > String(right);
    case ">=": return String(left) >= String(right);
    default: return null;
  }
}

const MARKER_CLAUSE_RE = new RegExp(
  `^\\s*(?:(${MARKER_VARIABLES.join("|")})\\s*(==|!=|<=|>=|<|>|not in|in)\\s*(['"])(.*?)\\3` +
  `|(['"])(.*?)\\5\\s*(==|!=|<=|>=|<|>|not in|in)\\s*(${MARKER_VARIABLES.join("|")}))\\s*$`,
);

/** One `<var> <op> "<value>"` (either order). null when not understood. */
function evaluateMarkerClause(clause, env) {
  const m = MARKER_CLAUSE_RE.exec(String(clause || ""));
  if (!m) return null;
  const variable = m[1] || m[8];
  const op = m[2] || m[7];
  const literal = m[1] ? m[4] : m[6];
  if (!(variable in env)) return null;
  const value = env[variable];
  // An empty python_version means "we do not know which interpreter this
  // will run on" — not "it is the empty string".
  if (value === "" && (variable === "python_version" || variable === "python_full_version")) return null;
  const versionAware = variable === "python_version" || variable === "python_full_version";
  const left = m[1] ? value : literal;
  const right = m[1] ? literal : value;
  return compareMarkerOperands(op, left, right, versionAware);
}

/**
 * Evaluate a PEP 508 marker expression.
 *
 * @returns {boolean|null} null when it cannot be decided — parentheses,
 *   an unknown variable, an unsupported shape. The caller must treat
 *   null as "this requirement may apply", never as "it does not".
 */
function evaluateEnvironmentMarker(marker, env = defaultMarkerEnvironment()) {
  const text = String(marker || "").trim();
  if (!text) return true;
  if (text.includes("(") || text.includes(")")) return null;
  // `or` binds loosest, then `and` — same as Python.
  let anyOr = false;
  for (const orPart of text.split(/\s+or\s+/)) {
    let allAnd = true;
    let undecided = false;
    for (const andPart of orPart.split(/\s+and\s+/)) {
      const value = evaluateMarkerClause(andPart, env);
      if (value === null) { undecided = true; break; }
      if (value === false) { allAnd = false; break; }
    }
    if (undecided) return null;
    if (allAnd) anyOr = true;
  }
  return anyOr;
}

/**
 * Parse one ``Requires-Dist:`` value into a constraint we understand.
 *
 * @returns {{name, spec, applies, unevaluatedMarker}|null}
 *   `applies` false means the marker excluded this environment;
 *   `unevaluatedMarker` means we could not decide and must say so.
 */
function parseRequirementLine(line, env = defaultMarkerEnvironment()) {
  const raw = String(line || "").trim();
  // Extras in the NAME (`pkg[extra]`) are satisfied by installing the extra.
  if (!raw || raw.includes("[")) return null;
  const semi = raw.indexOf(";");
  const head = semi >= 0 ? raw.slice(0, semi) : raw;
  const marker = semi >= 0 ? raw.slice(semi + 1).trim() : "";
  const match = head.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(.*)$/);
  if (!match) return null;
  const name = match[1].toLowerCase().replace(/_/g, "-");
  const specifier = (match[2] || "").trim();
  const verdict = evaluateEnvironmentMarker(marker, env);
  return {
    name,
    spec: specifier.replace(/\s+/g, ""),
    applies: verdict !== false,
    unevaluatedMarker: verdict === null,
  };
}

/**
 * Extract constraints from one METADATA body. Skips markers/extras and
 * duplicate declarations. Returns [{name, spec}] where spec may be ""
 * (unconstrained presence).
 */
function parseRequiresDist(metadataText, env = defaultMarkerEnvironment()) {
  const out = [];
  const seen = new Set();
  for (const line of String(metadataText || "").split(/\r?\n/)) {
    if (!line.startsWith("Requires-Dist:")) continue;
    const parsed = parseRequirementLine(line.slice("Requires-Dist:".length), env);
    if (!parsed) continue;
    // A marker that excluded this environment imposes nothing here.
    if (!parsed.applies) continue;
    const key = `${parsed.name}${parsed.spec}${parsed.unevaluatedMarker ? "?" : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  return out;
}

/**
 * PEP 440 ordering, to the depth this policy needs.
 *
 * The previous key split on `[.+~-]` and compared segment by segment, so
 * "1.0rc1" became [1, "0rc1"] and "1.0" became [1, 0]; a string never
 * equals a number, and the string branch put "0rc1" ABOVE "0". The
 * result was `1.0rc1 > 1.0` — backwards. A bundle pinned to a release
 * candidate would have been read as satisfying `>=1.0`, and the staged
 * copy of the FINAL release pruned in its favour.
 *
 * Ordering implemented here: epoch, then the numeric release segments,
 * then dev < a/alpha < b/beta < rc/c/pre/preview < final < post.
 */
const PRE_RELEASE_RANK = Object.freeze({ dev: 0, a: 1, alpha: 1, b: 2, beta: 2, c: 3, rc: 3, pre: 3, preview: 3 });
const FINAL_RANK = 4;
const POST_RANK = 5;

function versionKey(version) {
  const raw = String(version === undefined || version === null ? "0" : version).trim().toLowerCase();
  // Local version identifiers ("+cu121") do not participate in ordering
  // for our purposes.
  const withoutLocal = raw.split("+")[0];
  const m = /^(?:(\d+)!)?([0-9]+(?:\.[0-9]+)*)(.*)$/.exec(withoutLocal);
  if (!m) return { epoch: 0, release: [0], rank: FINAL_RANK, rankNum: 0, dev: Infinity };
  const epoch = Number(m[1] || 0);
  const release = m[2].split(".").map((n) => Number(n));
  const suffix = (m[3] || "").replace(/[._-]/g, "");
  let rank = FINAL_RANK;
  let rankNum = 0;
  // dev is lower than every pre-release; post is higher than final.
  const dev = /dev(\d*)$/.exec(suffix);
  // `post|rev|r` — but a bare "r" only when a digit or the end follows,
  // or it would swallow the "r" of "rc1" and rank a release candidate
  // ABOVE the final release.
  const post = /^(?:post|rev|r(?=\d|$))(\d*)/.exec(suffix);
  const pre = /^(dev|alpha|beta|preview|pre|rc|a|b|c)(\d*)/.exec(suffix);
  if (post) {
    rank = POST_RANK;
    rankNum = Number(post[1] || 0);
  } else if (pre) {
    rank = PRE_RELEASE_RANK[pre[1]];
    rankNum = Number(pre[2] || 0);
  }
  return {
    epoch,
    release,
    rank,
    rankNum,
    // A ".devN" tail lowers a version below the same version without it.
    dev: dev ? Number(dev[1] || 0) : Infinity,
  };
}

function compareVersions(a, b) {
  const ka = versionKey(a);
  const kb = versionKey(b);
  if (ka.epoch !== kb.epoch) return ka.epoch - kb.epoch;
  const len = Math.max(ka.release.length, kb.release.length);
  for (let i = 0; i < len; i += 1) {
    const sa = ka.release[i] ?? 0;
    const sb = kb.release[i] ?? 0;
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  if (ka.rank !== kb.rank) return ka.rank - kb.rank;
  if (ka.rankNum !== kb.rankNum) return ka.rankNum - kb.rankNum;
  if (ka.dev !== kb.dev) return ka.dev < kb.dev ? -1 : 1;
  // Everything that orders versions has compared equal, so they ARE the
  // same version ("1.0" and "1.0.0" differ only in how they were typed).
  return 0;
}

/**
 * Evaluate ONE PEP 440 specifier clause ("", ">=4.10.0", "==1.13.3",
 * "<14,>=13.0.3", "~=2.6", "==2.*") against a version. Wildcards are
 * prefix matches on the release segments ("==2.*" accepts 2.0.2 and
 * 2.1, rejects 3.0). Supported operators cover every constraint
 * observed in the torch/gigaam dependency trees; arbitrary equality
 * ("===") is treated as UNSATISFIABLE-by-analysis and reported rather
 * than guessed.
 */
function specifierSatisfied(spec, version) {
  const cleaned = String(spec || "").trim();
  if (!cleaned) return true;
  for (const clause of cleaned.split(",")) {
    const m = clause.match(/^(>=|<=|==|!=|~=|>|<|=)(.*)$/);
    if (!m) return false;
    const op = m[1];
    let target = m[2].trim();
    if (target.endsWith(".*")) {
      // Wildcard: release-segment prefix match. Only meaningful with
      // == / != per PEP 440; other operators with a wildcard refuse.
      const prefix = target.slice(0, -2);
      const vPrefix = String(version).slice(0, prefix.length + 1);
      const within = vPrefix === `${prefix}.` || String(version) === prefix;
      if (op === "==") { if (!within) return false; continue; }
      if (op === "!=") { if (within) return false; continue; }
      return false;
    }
    const cmp = compareVersions(version, target);
    switch (op) {
      case ">=": if (!(cmp >= 0)) return false; break;
      case "<=": if (!(cmp <= 0)) return false; break;
      case ">": if (!(cmp > 0)) return false; break;
      case "<": if (!(cmp < 0)) return false; break;
      case "~=": {
        // Compatible-release: >= prefix, and version within the same
        // leading segments as the target minus its last segment.
        const prefixSegs = target.split(".");
        prefixSegs.pop();
        const prefix = prefixSegs.join(".");
        if (!String(version).startsWith(prefix + ".") && String(version) !== prefix) return false;
        if (cmp < 0) return false;
        break;
      }
      case "!=": if (cmp === 0) return false; break;
      case "==":
      case "=": if (cmp !== 0) return false; break;
      default: return false;
    }
  }
  return true;
}

/**
 * Which files on disk belong to one installed distribution.
 *
 * The prune used to delete only the `.dist-info` directory and leave the
 * package itself — `numpy/`, `numpy.libs/`, every `.so` — sitting on a
 * PYTHONPATH that puts engine-site AHEAD of the bundle. So `import numpy`
 * still resolved to the engine-site copy, the log line said "pruned
 * duplicate numpy", and the release pins did not apply to any
 * overlapping package. That is the exact shadowing BUG-46 is about, and
 * the reason a diagnostic block elsewhere had to exist to tell the user
 * "engine-site is shadowing the bundle".
 *
 * pip writes the authoritative file list into `<dist-info>/RECORD`, so
 * that is what is read rather than guessing directory names. Paths that
 * try to leave the site directory are refused: RECORD is generated by
 * whatever wheel was installed, and a `../` in it must never let a prune
 * delete outside the tree it was given.
 *
 * @returns {{paths: string[], unsafe: string[]}} `paths` are relative to
 *   the site directory, deepest first so directories empty out before
 *   they are removed.
 */
function planDistributionRemoval(recordText, distInfoDirName) {
  const paths = [];
  const unsafe = [];
  const seen = new Set();
  const add = (rel) => {
    const normalized = String(rel || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!normalized) return;
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) {
      unsafe.push(normalized);
      return;
    }
    if (seen.has(normalized)) return;
    seen.add(normalized);
    paths.push(normalized);
  };
  for (const line of String(recordText || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // RECORD is CSV: path,hash,size. A path containing a comma is
    // quoted; anything else ends at the first comma.
    const quoted = /^"(.*?)",/.exec(trimmed);
    add(quoted ? quoted[1] : trimmed.split(",")[0]);
  }
  if (distInfoDirName) add(distInfoDirName);
  // Deepest first: a directory can only be removed once it is empty.
  paths.sort((a, b) => b.split("/").length - a.split("/").length || (a < b ? -1 : 1));
  return { paths, unsafe };
}

/**
 * Fallback file list for a distribution whose RECORD is missing or
 * unreadable — the conventional layout pip produces. Deliberately
 * conservative: it never guesses beyond these four shapes, and the
 * caller logs when nothing was found so a silent no-op cannot pass for
 * a prune.
 */
function guessDistributionPaths(name, version) {
  const out = [];
  for (const spelling of new Set([name, String(name).replace(/-/g, "_")])) {
    out.push(`${spelling}-${version}.dist-info`);
    out.push(spelling);
    out.push(`${spelling}.libs`);
    out.push(`${spelling}.py`);
  }
  return out;
}

/** Read every ``<name>-<version>.dist-info`` directory name into {name: version}. */
function distInfoInventory(readdirSync) {
  const inv = Object.create(null);
  for (const entry of readdirSync()) {
    const m = entry.match(/^(.+)-(\d[^/]*)\.dist-info$/i);
    if (!m) continue;
    const name = m[1].toLowerCase().replace(/_/g, "-");
    if (!(name in inv)) inv[name] = m[2];
  }
  return inv;
}

/**
 * Build the requirement index across ALL staged distributions: for each
 * constrained name, the union of specifiers any staged package declares.
 * A staged copy of X is shadowing-safe only if the BUNDLE copy of X
 * satisfies EVERY declaration (that is exactly pip's resolver contract,
 * restricted to the overlap surface this install can actually affect).
 */
function collectRequirementIndex(stagingDir, fsLike, env = defaultMarkerEnvironment()) {
  const index = new Map(); // name -> Array<spec>
  // Names carrying a requirement we could not evaluate. Not a specifier
  // — we cannot say what it demands — but not permission to prune either.
  const undecidable = new Set();
  for (const entry of fsLike.readdirSync(stagingDir)) {
    if (!/\.dist-info$/i.test(entry)) continue;
    const metaPath = `${stagingDir}/${entry}/METADATA`;
    let text;
    try {
      text = fsLike.readFileSync(metaPath, "utf8");
    } catch {
      continue; // malformed dist-info: absence of declarations ≠ permission
    }
    for (const req of parseRequiresDist(text, env)) {
      if (req.unevaluatedMarker) {
        undecidable.add(req.name);
        continue;
      }
      if (!req.spec) continue; // unconstrained mentions impose nothing
      const list = index.get(req.name) || [];
      list.push(req.spec);
      index.set(req.name, list);
    }
  }
  index.undecidable = undecidable;
  return index;
}

/**
 * Decide, for the overlap between a staged engine install and the
 * release-pinned bundle, which staged copies must be pruned and whether
 * any overlap is UNSAFE (bundle copy cannot satisfy a declared need).
 *
 * @param {Object} args
 * @param {Object.<string,string>} args.staged   name → version (staging)
 * @param {Object.<string,string>} args.bundle   name → version (bundle)
 * @param {Map<string,string[]>}   args.needs    name → specifier union
 * @returns {{prune: string[], conflicts: Array<{name,required,have}>}}
 */
function planEngineSitePrune({ staged, bundle, needs }) {
  const prune = [];
  const conflicts = [];
  const undecidable = (needs && needs.undecidable) || new Set();
  for (const name of Object.keys(staged)) {
    if (!(name in bundle)) continue; // pure addition — keep
    if (undecidable.has(name)) {
      // Some staged distribution requires this under a marker we cannot
      // evaluate (python_version, implementation_name, ...). Pruning
      // would be a guess about a constraint that may well apply here.
      conflicts.push({
        name,
        required: "a requirement under an environment marker this policy cannot evaluate",
        have: bundle[name],
      });
      continue;
    }
    const specs = (needs && needs.get(name)) || [];
    const unsatisfied = specs.filter((s) => !specifierSatisfied(s, bundle[name]));
    if (unsatisfied.length === 0) {
      prune.push(name); // bundle wins: satisfies everyone who cares
    } else {
      conflicts.push({
        name,
        required: unsatisfied.join(" & "),
        have: bundle[name],
      });
    }
  }
  prune.sort();
  conflicts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { prune, conflicts };
}

module.exports = {
  ENGINE_INSTALL_PHASES,
  ENGINE_NETWORK_HOSTS,
  ENGINE_MIN_FREE_BYTES,
  defaultMarkerEnvironment,
  evaluateEnvironmentMarker,
  parseRequiresDist,
  collectRequirementIndex,
  planEngineSitePrune,
  planDistributionRemoval,
  guessDistributionPaths,
  specifierSatisfied,
  compareVersions,
  distInfoInventory,
};
