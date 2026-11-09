#!/usr/bin/env node

// Validates one explicitly named analyze-performance HTML report.
//
// The generic Skill PostToolUse hook fires when the skill instructions are loaded,
// before this workflow renders a report. It therefore invokes this script without
// `--reportPath`, which must approve instead of inspecting historical files. Phase
// 6.3 calls this script explicitly with the report it just rendered; only that path
// is validated, so an old malformed/good report cannot affect the current run.

const fs = require('fs');
const path = require('path');
const { approve, block, runValidation } = require('../../../scripts/lib/validation-helpers');

// render-template.js leaves __KEY__ tokens verbatim when a required value was not
// supplied, so their presence in the output is a definitive render failure.
// See scripts/lib/render-template.js (placeholder = `__${key}__`).
const UNREPLACED_PLACEHOLDER = /__[A-Z][A-Z0-9_]+__/;
// Guard against a truncated/empty write masquerading as a real report.
const MIN_REPORT_BYTES = 500;

function getArg(name) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

function validateReport(reportPath) {
  const resolved = path.resolve(reportPath);
  if (!fs.existsSync(resolved)) {
    return `Performance report was not created at ${resolved}. Re-run /power-pages:analyze-performance.`;
  }

  let content = '';
  try {
    content = fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    return `Performance report could not be read at ${resolved}: ${error.message}`;
  }

  const reportBytes = Buffer.byteLength(content, 'utf8');
  if (reportBytes < MIN_REPORT_BYTES) {
    return `Performance report ${path.basename(resolved)} is suspiciously small (${reportBytes} bytes) — the render likely failed. Re-run /power-pages:analyze-performance.`;
  }
  if (UNREPLACED_PLACEHOLDER.test(content)) {
    return `Performance report ${path.basename(resolved)} has unreplaced template placeholders — the report data was not populated. Re-run the render step in /power-pages:analyze-performance.`;
  }

  return null;
}

const reportPath = getArg('reportPath');
if (reportPath) {
  const error = validateReport(reportPath);
  if (error) block(error);
  approve();
} else {
  // Hook mode: no report exists for the current invocation yet. Never inspect an
  // older report because that could block a prerequisite/review-mode run or mask
  // a missing current render.
  runValidation(() => approve());
}

module.exports = { validateReport };
