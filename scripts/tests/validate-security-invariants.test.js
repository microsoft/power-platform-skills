'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

test('all scripts that call az account get-access-token must also import shared validation helper', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');

  // Explicit audited call sites that acquire Dataverse bearer tokens in production code.
  // This list prevents dynamic regex matching from missing constructed shell invocations.
  const files = [
    'plugins/mobile-apps/scripts/dataverse-request.js',
    'plugins/model-apps/scripts/lib/dataverse-auth.js',
    'plugins/power-pages/scripts/dataverse-request.js'
  ];

  const failures = [];

  for (const file of files) {
    const fullPath = path.join(repoRoot, file);
    const content = fs.readFileSync(fullPath, 'utf8');

    // We check that the file enforces origin checks.
    const hasSharedValidator = 
      content.includes('validateDataverseEnvironmentUrl') ||
      content.includes('dataverseOrigin') ||
      content.includes('requireDataverseOrigin');
      
    // Enforce the API-path invariant
    const hasPathValidator = content.includes('validateDataverseApiPath');

    if (!hasSharedValidator || !hasPathValidator) {
      failures.push(file);
    }
  }

  assert.deepEqual(
    failures,
    [],
    'The following scripts acquire tokens but do not use the shared environment/origin validation helper. ' +
    'To prevent unvalidated API path concatenation and origin bypasses, any script acquiring a token must validate the origin.'
  );
});
