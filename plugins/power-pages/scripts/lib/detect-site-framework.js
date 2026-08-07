"use strict";

// Detects which SPA framework a Power Pages **code site** is built with, for
// telemetry only (emitted inside the dynamic `eventInfo` column — see
// shared/telemetry/README.md "What is sent").
//
// Runs on the telemetry hot path (PreToolUse(Skill) + UserPromptSubmit), so it
// is fail-closed and cheap: every failure mode returns null rather than
// throwing, because telemetry must never change a hook's exit code.

const fs = require("node:fs");
const path = require("node:path");
const { findPath } = require("./validation-helpers");

// The one marker that means "Power Pages code site". `findProjectRoot` also
// matches `.powerpages-site/` (declarative design-studio sites from
// `pac pages download`), but those have no SPA framework and no package.json,
// so this module resolves the root against the code-site marker ONLY — matching
// how detect-project-context.js decides `siteType: "code"`.
const CONFIG_MARKER = "powerpages.config.json";

// Ordered marker list — the FIRST match wins, so order is load-bearing:
//
//   * `astro` is checked before everything else because an Astro site can
//     legitimately declare `@astrojs/react` + `react` (or the Vue equivalent)
//     for island components. Such a site is an Astro site, not a React one.
//   * `@angular/core` (not `angular`) is the Angular marker — `angular` is the
//     long-dead AngularJS 1.x package name and would be a false positive.
//
// Kept in sync with the four scaffolds under skills/create-site/assets/.
const FRAMEWORK_MARKERS = [
  ["astro", "astro"],
  ["angular", "@angular/core"],
  ["vue", "vue"],
  ["react", "react"],
];

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    // Missing, unreadable, or malformed → indistinguishable from "no site" for
    // telemetry purposes. Callers omit the field entirely rather than guess.
    return null;
  }
}

/**
 * Resolves the root of the Power Pages code site containing `startDir`.
 *
 * Same two-phase shape as `validation-helpers.findProjectRoot` — walk UP, then
 * scan ONE level of immediate children (via that module's `findPath`, so the
 * skip rules for `node_modules`/`.git` stay in one place) — but matched against
 * the code-site marker only.
 *
 * The child scan is not optional polish: `create-site`'s recommended target
 * location is "New folder in current directory", which puts the config in a
 * CHILD of the host session cwd that later hooks report. (The skill's
 * `cd "<PROJECT_ROOT>"` calls run in Bash-tool subshells and never move the host
 * cwd.) An upward-only walk would miss the most common layout on every
 * subsequent skill run, biasing the metric toward users who scaffolded in place.
 *
 * Why not call `findProjectRoot` directly: it matches EITHER marker, so it costs
 * a second full child scan for `.powerpages-site/` whose result this module then
 * throws away — on a large cwd that scan is the dominant cost of a miss, and a
 * miss is exactly what a non-Pages directory produces. Matching one marker also
 * avoids a wrong answer when a declarative site sits *closer* than the enclosing
 * code site: `findProjectRoot` would stop at the declarative root and report no
 * framework even though the cwd is inside a code site.
 */
function findCodeSiteRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, CONFIG_MARKER))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const childHit = findPath(startDir, CONFIG_MARKER);
  return childHit ? path.dirname(childHit) : null;
}

/**
 * Resolves the framework of the Power Pages code site containing `startDir`.
 *
 * Known limitation: a site scaffolded into an unrelated absolute path ("Any
 * other directory") is unreachable from cwd and reports null.
 *
 * @param {string} startDir - Directory to resolve from (the hook's cwd).
 * @returns {"astro"|"angular"|"vue"|"react"|null} null when `startDir` is not
 *   inside a Power Pages code site, or the framework is not recognized.
 */
function detectSiteFramework(startDir) {
  try {
    const dir = startDir || process.cwd();

    let projectRoot;
    try {
      projectRoot = findCodeSiteRoot(dir);
    } catch {
      projectRoot = null;
    }
    if (!projectRoot) return null;

    const pkg = readJson(path.join(projectRoot, "package.json"));
    if (!pkg || typeof pkg !== "object") return null;

    // DECLARED dependencies only — deliberately not resolved `node_modules`.
    // A site that was never `npm install`ed, or one whose deps are hoisted by a
    // workspace root, still lists its own direct framework dependency here.
    const deps = Object.assign(
      {},
      pkg.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : null,
      pkg.devDependencies && typeof pkg.devDependencies === "object" ? pkg.devDependencies : null
    );

    for (const [framework, marker] of FRAMEWORK_MARKERS) {
      if (Object.prototype.hasOwnProperty.call(deps, marker)) return framework;
    }

    return null;
  } catch {
    // Fail closed — an unexpected fs/permission error must not surface to the
    // hook, which would silently downgrade the run to "no telemetry event".
    return null;
  }
}

module.exports = { detectSiteFramework, FRAMEWORK_MARKERS };
