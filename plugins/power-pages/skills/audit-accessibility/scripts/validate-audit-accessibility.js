#!/usr/bin/env node

// Validates the result of the audit-accessibility skill.
// Runs as a PostToolUse(Skill) hook (see hooks/run-skill-posttool-validation.js).
//
// The hook fires when the skill is INVOKED, not when it finishes, so this validator
// must approve when there is nothing to check yet. It only inspects the result marker
// the skill writes in Phase 6.4:
//
//   docs/accessibility/last-audit.json
//   {
//     "schemaVersion": 1, "skill": "audit-accessibility",
//     "status": "Completed" | "Incomplete",
//     "outcome": "passed" | "passed-with-warnings" | "failed",
//     "baseUrl": "https://contoso.powerappsportals.com/",
//     "finishedAt": "<ISO timestamp>",
//     "signedIn": false, "sessionRemoved": true,
//     "reportFile": "docs/accessibility/accessibility-audit.md",
//     "summary": { "pagesAudited": 12, "violations": 9, "blocking": 3, ... }
//   }
//
// Accessibility violations are the skill's normal output, so this validator never
// blocks because the site failed the audit. It blocks only when the marker or report is
// malformed (including a wrong schemaVersion or skill, or non-boolean session fields),
// misreports the outcome, or a signed-in session was left on disk.

const fs = require('fs');
const path = require('path');
const { approve, block, runValidation, findProjectRoot } = require('../../../scripts/lib/validation-helpers');

const MARKER_REL = path.join('docs', 'accessibility', 'last-audit.json');
const STATUSES = new Set(['Completed', 'Incomplete']);
const OUTCOMES = new Set(['passed', 'passed-with-warnings', 'failed']);

// Strings that indicate session material leaked into a committed file. The capture
// script stores Playwright storage state under a temp `pp-a11y-auth-*` directory as
// `storage-state.json`; neither name has any reason to appear in the report.
const SESSION_LEAK_PATTERNS = ['storage-state.json', 'pp-a11y-auth-'];

// The exact {{...}} tokens in the report template, so an unfilled template is caught
// without rejecting real report content: fixes for declarative sites legitimately quote
// Liquid such as {{ page.title }} or {% include %}. Read from the template itself so the
// two can't drift; the template ships inside the plugin, beside this script.
const TEMPLATE_PATH = path.join(__dirname, '..', 'references', 'report-template.md');
function templatePlaceholders() {
  try {
    return [...new Set(fs.readFileSync(TEMPLATE_PATH, 'utf8').match(/\{\{[^{}]*\}\}/g) || [])];
  } catch {
    return [];
  }
}

// runValidation() approves when the callback throws, so every read that a malformed
// marker can steer (a directory, a broken link, a permission error) must turn into a
// validation error instead of an exception.
function readRegularFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true };
    return { error: err.code || err.message };
  }
  if (!stat.isFile()) return { error: 'not a regular file' };
  try {
    return { text: fs.readFileSync(file, 'utf8') };
  } catch (err) {
    return { error: err.code || err.message };
  }
}

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd) || cwd;
  const markerPath = path.join(projectRoot, MARKER_REL);
  const markerFile = readRegularFile(markerPath);
  if (markerFile.missing) approve();
  if (markerFile.error) block(`${MARKER_REL} can't be read (${markerFile.error}). Rewrite it using the schema in Phase 6.4 of the audit-accessibility skill.`);
  const markerRaw = markerFile.text;
  let marker;
  try {
    marker = JSON.parse(markerRaw);
  } catch {
    block(`${MARKER_REL} is not valid JSON. Rewrite it using the schema in Phase 6.4 of the audit-accessibility skill.`);
  }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    block(`${MARKER_REL} must contain a JSON object.`);
  }

  const errors = [];

  // Another tool (or an older skill version) writing to the same path must not pass as
  // this skill's result.
  if (marker.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1 (found ${JSON.stringify(marker.schemaVersion)})`);
  }
  if (marker.skill !== 'audit-accessibility') {
    errors.push(`skill must be "audit-accessibility" (found ${JSON.stringify(marker.skill)})`);
  }

  if (!STATUSES.has(marker.status)) {
    errors.push(`status must be "Completed" or "Incomplete" (found ${JSON.stringify(marker.status)})`);
  }

  if (marker.status === 'Completed') {
    if (!marker.baseUrl) errors.push('Completed audit is missing baseUrl');
    if (!marker.finishedAt) errors.push('Completed audit is missing finishedAt');
    if (!marker.summary || typeof marker.summary !== 'object') {
      errors.push('Completed audit is missing summary');
    } else if (!Number.isInteger(marker.summary.blocking) || marker.summary.blocking < 0) {
      // Without a real count the outcome rule below cannot run, so `summary: {}` with
      // outcome "passed" would slip through.
      errors.push(`summary.blocking must be a non-negative integer (found ${JSON.stringify(marker.summary.blocking)})`);
    }
    if (!OUTCOMES.has(marker.outcome)) {
      errors.push(`outcome must be "passed", "passed-with-warnings", or "failed" (found ${JSON.stringify(marker.outcome)})`);
    }
  }

  // A pass with blocking issues would hide real barriers from the user.
  const blocking = Number(marker.summary && marker.summary.blocking);
  if (Number.isFinite(blocking) && blocking > 0 && marker.outcome && marker.outcome !== 'failed') {
    errors.push(`outcome is "${marker.outcome}" but summary.blocking is ${blocking}; use "failed"`);
  }

  // A strict boolean, so "signedIn": "true" or 1 can't skip the session-cleanup rule
  // below, which only fires on signedIn === true.
  if (marker.signedIn !== undefined && typeof marker.signedIn !== 'boolean') {
    errors.push(`signedIn must be true or false (found ${JSON.stringify(marker.signedIn)})`);
  }
  if (marker.sessionRemoved !== undefined && typeof marker.sessionRemoved !== 'boolean') {
    errors.push(`sessionRemoved must be true or false (found ${JSON.stringify(marker.sessionRemoved)})`);
  }

  if (marker.signedIn === true && marker.sessionRemoved !== true) {
    errors.push('A signed-in session file may still be on disk. Run `a11y-capture-auth.js --remove <authState>` and set sessionRemoved to true.');
  }

  if (SESSION_LEAK_PATTERNS.some((p) => markerRaw.includes(p))) {
    errors.push(`${MARKER_REL} references the session file. Remove session paths from the marker.`);
  }

  if (marker.reportFile !== undefined && marker.reportFile !== null) {
    checkReport(projectRoot, marker.reportFile, errors);
  } else if (marker.status === 'Completed') {
    errors.push('Completed audit is missing reportFile');
  }

  if (errors.length > 0) {
    block('Accessibility audit validation failed:\n- ' + errors.join('\n- '));
  }

  approve();
});

function checkReport(projectRoot, reportFile, errors) {
  if (typeof reportFile !== 'string' || !reportFile.trim()) {
    errors.push('reportFile must be a relative path string');
    return;
  }
  const reportPath = path.resolve(projectRoot, reportFile);
  const rel = path.relative(projectRoot, reportPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    errors.push(`reportFile must be inside the project (found ${reportFile})`);
    return;
  }
  const file = readRegularFile(reportPath);
  if (file.missing) {
    errors.push(`reportFile not found: ${reportFile}`);
    return;
  }
  if (file.error) {
    errors.push(`reportFile can't be read (${file.error}): ${reportFile}`);
    return;
  }
  const report = file.text;
  const unfilled = templatePlaceholders().filter((token) => report.includes(token));
  if (unfilled.length > 0) {
    errors.push(`${reportFile} contains unreplaced template placeholders: ${unfilled.slice(0, 3).join(', ')}`);
  }
  if (SESSION_LEAK_PATTERNS.some((p) => report.includes(p))) {
    errors.push(`${reportFile} references the session file. Remove session paths from the report.`);
  }
}
