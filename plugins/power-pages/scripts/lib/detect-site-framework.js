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

// `powerpages.config.json` means "Power Pages code site". `.powerpages-site/`
// marks a declarative design-studio site from `pac pages download`; it has no
// SPA framework, but still matters as a site boundary and when deciding whether
// a child workspace identifies exactly one site.
const CONFIG_MARKER = "powerpages.config.json";
const DECLARATIVE_MARKER = ".powerpages-site";

// Ordered marker list — the FIRST match wins, so order is load-bearing:
//
//   * `astro` wins over every other match because an Astro site can legitimately
//     declare React/Vue tooling for island components. Such a site is still an
//     Astro scaffold.
//   * `@angular/core` (not `angular`) is the Angular marker — `angular` is the
//     long-dead AngularJS 1.x package name and would be a false positive.
//   * React and Vue use their scaffold build plugins instead of their runtime
//     packages. A React application can legitimately consume Vue (and vice
//     versa); the Vite plugin is the stronger fingerprint of how the site was
//     scaffolded.
//
// For non-Astro sites exactly ONE marker must match; ambiguity reports null.
// Kept in sync with the four scaffolds under skills/create-site/assets/.
const FRAMEWORK_MARKERS = [
  ["astro", "astro"],
  ["angular", "@angular/core"],
  ["vue", "@vitejs/plugin-vue"],
  ["react", "@vitejs/plugin-react"],
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
 * scan ONE level of immediate children. Declarative markers do not produce a
 * framework, but they stop an upward walk and participate in child ambiguity.
 *
 * The child scan is not optional polish: `create-site`'s recommended target
 * location is "New folder in current directory", which puts the config in a
 * CHILD of the host session cwd that later hooks report. (The skill's
 * `cd "<PROJECT_ROOT>"` calls run in Bash-tool subshells and never move the host
 * cwd.) An upward-only walk would miss the most common layout on every
 * subsequent skill run, biasing the metric toward users who scaffolded in place.
 *
 * Why not call `findProjectRoot` directly: its child fallback returns the first
 * matching directory. Hook payloads do not identify which child a skill will
 * target, so a multi-site cwd is ambiguous and must report null. This detector
 * scans children once and counts both site types before attributing a framework.
 */
function findCodeSiteRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, CONFIG_MARKER))) return current;
    // A nearer declarative site is the project under work. Continuing upward
    // could incorrectly attribute an enclosing code site's framework.
    if (fs.existsSync(path.join(current, DECLARATIVE_MARKER))) return null;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // A first-hit helper is correct for project discovery but not telemetry
  // attribution. Count code and declarative children in one pass; exactly one
  // total site must exist, and it must be a code site.
  let childRoot = null;
  let siteCount = 0;
  try {
    for (const entry of fs.readdirSync(startDir, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.name === "node_modules" ||
        entry.name === ".git"
      ) {
        continue;
      }
      const candidate = path.join(startDir, entry.name);
      const isCodeSite = fs.existsSync(path.join(candidate, CONFIG_MARKER));
      const isDeclarativeSite = fs.existsSync(
        path.join(candidate, DECLARATIVE_MARKER)
      );
      if (!isCodeSite && !isDeclarativeSite) continue;
      siteCount += 1;
      if (siteCount > 1) return null;
      childRoot = isCodeSite ? candidate : null;
    }
  } catch {
    return null;
  }
  return childRoot;
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

    const matches = FRAMEWORK_MARKERS.filter(([, marker]) =>
      Object.prototype.hasOwnProperty.call(deps, marker)
    ).map(([framework]) => framework);
    if (matches.includes("astro")) return "astro";
    return matches.length === 1 ? matches[0] : null;
  } catch {
    // Fail closed — an unexpected fs/permission error must not surface to the
    // hook, which would silently downgrade the run to "no telemetry event".
    return null;
  }
}

module.exports = { detectSiteFramework, FRAMEWORK_MARKERS };
