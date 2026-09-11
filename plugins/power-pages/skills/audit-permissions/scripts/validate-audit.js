#!/usr/bin/env node

// Validates that the permissions audit report was generated.
// Runs as a PostToolUse(Skill) hook to verify the skill produced output.

const fs = require('fs');
const path = require('path');
const { approve, block, runValidation, findPath, findProjectRoot } = require('../../../scripts/lib/validation-helpers');

// Mirrors PLACEHOLDER_RE in scripts/lib/render-template.js. Matching the grammar rather
// than specific token names keeps this check working when a template renames a key or
// adds a context prefix, which is how `__FINDINGS_DATA__` -> `__JSON_FINDINGS_DATA__`
// silently disabled it before.
const PLACEHOLDER_RE = /__(?:(?:HTML|ATTR|JSON|RAW)_)?[A-Z][A-Z0-9_]*__/g;

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) approve(); // Not a Power Pages project — not an audit session

  // Check if audit report was generated in docs/
  const docsReport = path.join(projectRoot, 'docs', 'permissions-audit.html');
  if (fs.existsSync(docsReport)) {
    const content = fs.readFileSync(docsReport, 'utf8');
    const unreplaced = [...new Set(content.match(PLACEHOLDER_RE) || [])];
    if (unreplaced.length > 0) {
      block(`Audit report has unreplaced placeholders (${unreplaced.join(', ')}) — data was not populated.`);
    }
    approve();
  }

  // Check temp directory as fallback
  const tempDir = process.env.TEMP || process.env.TMP || '/tmp';
  const tempReport = path.join(tempDir, 'permissions-audit.html');
  if (fs.existsSync(tempReport)) {
    approve();
  }

  // No report found — this may not be an audit session, so don't block
  approve();
});
