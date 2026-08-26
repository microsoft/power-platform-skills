#!/usr/bin/env node

// Validates that the perf-checker skill produced its performance report.
// Runs as a PostToolUse (Stop-style) hook after a `perf-checker` Skill call
// completes — auto-discovered by scripts/lib/powerpages-hook-utils.js because it
// matches /^validate.*\.js$/ in this skill's scripts/ folder (no manual wiring).
//
// Fail-open by design: this hook fires on EVERY perf-checker invocation, but the
// skill has legitimate no-report exits (prerequisites not met / not a Power Pages
// project / review mode, which writes JSON to an external dir instead of docs/).
// So the only blocking condition is a report that WAS written but left with
// unreplaced template placeholders — a concrete "render silently failed" bug the
// user would otherwise ship. Everything else approves.

const fs = require('fs');
const path = require('path');
const { approve, block, runValidation, findProjectRoot } = require('../../../scripts/lib/validation-helpers');

// The report is timestamped (perf-check-<YYYY-MM-DD-HHMMSS>.html), so match by
// prefix rather than a fixed name. Example: perf-check-2026-05-14-053805.html
const REPORT_PREFIX = 'perf-check-';
const REPORT_SUFFIX = '.html';
// render-template.js leaves __KEY__ tokens verbatim when a required value was not
// supplied, so their presence in the output is a definitive render failure.
// See scripts/lib/render-template.js (placeholder = `__${key}__`).
const UNREPLACED_PLACEHOLDER = /__[A-Z][A-Z0-9_]+__/;
// Guard against a truncated/empty write masquerading as a real report.
const MIN_REPORT_BYTES = 500;

// The shared findProjectRoot helper intentionally recognizes only code-site and
// `.powerpages-site` layouts. perf-checker also supports classic PAC downloads,
// whose root contains `.portalconfig/` plus files such as `website.yml` and
// `sitesetting.yml`, so climb separately before deciding this was not a skill run.
function findPerfProjectRoot(startPath) {
  const standardRoot = findProjectRoot(startPath);
  if (standardRoot) return standardRoot;

  let current = path.resolve(startPath);
  while (true) {
    const hasPortalConfig = fs.existsSync(path.join(current, '.portalconfig'));
    const hasWebsite = fs.existsSync(path.join(current, 'website.yml'));
    const hasPortalContent = ['web-pages', 'web-templates', 'web-files']
      .some((name) => fs.existsSync(path.join(current, name)));

    if (hasPortalConfig || (hasWebsite && hasPortalContent)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

runValidation((cwd) => {
  const projectRoot = findPerfProjectRoot(cwd);
  if (!projectRoot) approve(); // Not a Power Pages project — not a perf-checker session.

  const docsDir = path.join(projectRoot, 'docs');
  if (!fs.existsSync(docsDir)) approve(); // No report yet (prereqs failed / review mode).

  let reports;
  try {
    reports = fs
      .readdirSync(docsDir)
      .filter((name) => name.startsWith(REPORT_PREFIX) && name.endsWith(REPORT_SUFFIX))
      // Timestamped names sort lexicographically in chronological order, so the
      // last entry is the newest report — the one this session most likely wrote.
      .sort();
  } catch {
    approve(); // Unreadable docs/ — don't block on an environment quirk.
  }

  if (!reports || reports.length === 0) approve(); // No perf report — nothing to validate.

  const latest = path.join(docsDir, reports[reports.length - 1]);
  let content = '';
  try {
    content = fs.readFileSync(latest, 'utf8');
  } catch {
    approve(); // Can't read it — fail open rather than block on I/O.
  }

  if (content.length < MIN_REPORT_BYTES) {
    block(`Performance report ${reports[reports.length - 1]} is suspiciously small (${content.length} bytes) — the render likely failed. Re-run /power-pages:perf-checker.`);
  }
  if (UNREPLACED_PLACEHOLDER.test(content)) {
    block(`Performance report ${reports[reports.length - 1]} has unreplaced template placeholders — the report data was not populated. Re-run the render step in /power-pages:perf-checker.`);
  }

  approve();
});
