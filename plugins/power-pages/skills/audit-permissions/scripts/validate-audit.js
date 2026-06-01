#!/usr/bin/env node

// Validates that the permissions audit report was generated.
// Runs as a Stop hook to verify the skill produced output.

const fs = require('fs');
const path = require('path');
const { approve, block, runValidation, findPath, findProjectRoot } = require('../../../scripts/lib/validation-helpers');

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) approve(); // Not a Power Pages project — not an audit session

  // Check if audit report was generated in docs/
  const docsReport = path.join(projectRoot, 'docs', 'permissions-audit.html');
  if (fs.existsSync(docsReport)) {
    const content = fs.readFileSync(docsReport, 'utf8');
    if (content.includes('__FINDINGS_DATA__') || content.includes('__INVENTORY_DATA__')) {
      block('Audit report has unreplaced placeholders — data was not populated.');
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
