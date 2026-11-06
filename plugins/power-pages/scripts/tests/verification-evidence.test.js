'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  computeVerificationInputFingerprint,
  createVerificationEvidence,
  validateReusableVerificationReport,
} = require('../lib/verification-evidence');
const { createTempProject, writeProjectFile } = require('./test-utils');

function createProject(t) {
  const root = createTempProject(t);
  writeProjectFile(root, 'package.json', '{"scripts":{"build":"vite build"}}');
  writeProjectFile(root, 'src/App.tsx', 'export const App = () => <main>Hello</main>;');
  writeProjectFile(root, '.powerpages-localization.json', JSON.stringify({
    locales: ['en-US', 'ar-SA'],
    unavailableLocales: [],
    updatedAt: '2026-09-01T00:00:00.000Z',
    bidirectionalReadiness: { status: 'pending-remediation' },
  }));
  return root;
}

function createSuccessfulReport(projectRoot, spec) {
  return {
    summary: {
      cases: 1,
      passed: 1,
      review: 0,
      failed: 0,
      errors: 0,
      reviewFindings: 0,
    },
    findings: [],
    results: [{
      id: 'home--default--desktop--en',
      type: 'component-state',
      status: 'passed',
      findings: [],
    }],
    verification: {
      profile: 'standard',
      evidence: createVerificationEvidence(projectRoot, spec),
    },
  };
}

test('ignores readiness-only manifest changes when fingerprinting build inputs', (t) => {
  const projectRoot = createProject(t);
  const before = computeVerificationInputFingerprint(projectRoot);
  const manifestPath = path.join(projectRoot, '.powerpages-localization.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.updatedAt = '2026-09-02T00:00:00.000Z';
  manifest.bidirectionalReadiness = { status: 'ready' };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  assert.equal(computeVerificationInputFingerprint(projectRoot), before);
});

test('availability-neutral fingerprint ignores only locale availability changes', (t) => {
  const projectRoot = createProject(t);
  const manifestPath = path.join(projectRoot, '.powerpages-localization.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.managedFiles = ['src/i18n/localeAvailability.ts'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  writeProjectFile(
    projectRoot,
    'src/i18n/localeAvailability.ts',
    'const hidden = new Set([]);\n'
  );
  const fullBefore = computeVerificationInputFingerprint(projectRoot);
  const neutralBefore = computeVerificationInputFingerprint(projectRoot, {
    excludeAvailability: true,
  });
  assert.equal(
    createVerificationEvidence(projectRoot, {})
      .inputFingerprintWithoutAvailability,
    neutralBefore
  );

  // Keeping ar-SA unavailable edits only the two availability inputs.
  manifest.unavailableLocales = ['ar-SA'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  writeProjectFile(
    projectRoot,
    'src/i18n/localeAvailability.ts',
    "const hidden = new Set(['ar-SA']);\n"
  );
  assert.notEqual(computeVerificationInputFingerprint(projectRoot), fullBefore);
  assert.equal(
    computeVerificationInputFingerprint(projectRoot, {
      excludeAvailability: true,
    }),
    neutralBefore
  );

  writeProjectFile(projectRoot, 'src/App.tsx', 'export const App = null;');
  assert.notEqual(
    computeVerificationInputFingerprint(projectRoot, {
      excludeAvailability: true,
    }),
    neutralBefore
  );
});

test('availability-neutral fingerprint covers an availability file the manifest does not list', (t) => {
  const projectRoot = createProject(t);
  writeProjectFile(
    projectRoot,
    'src/i18n/localeAvailability.ts',
    'const hidden = new Set([]);\n'
  );
  const before = computeVerificationInputFingerprint(projectRoot, {
    excludeAvailability: true,
  });

  writeProjectFile(
    projectRoot,
    'src/i18n/localeAvailability.ts',
    "const hidden = new Set(['ar-SA']);\n"
  );

  assert.notEqual(
    computeVerificationInputFingerprint(projectRoot, {
      excludeAvailability: true,
    }),
    before
  );
});

test('invalidates evidence when source or locale availability changes', (t) => {
  const projectRoot = createProject(t);
  const spec = { version: 1 };
  const report = createSuccessfulReport(projectRoot, spec);

  assert.deepEqual(
    validateReusableVerificationReport(projectRoot, report),
    []
  );
  fs.writeFileSync(path.join(projectRoot, 'src/App.tsx'), 'export const App = null;');
  assert.match(
    validateReusableVerificationReport(projectRoot, report).join('\n'),
    /evidence is stale/
  );
});

test('invalidates evidence when any supported Astro config changes', (t) => {
  for (const configName of [
    'astro.config.js',
    'astro.config.mjs',
    'astro.config.ts',
  ]) {
    const projectRoot = createProject(t);
    const configPath = writeProjectFile(
      projectRoot,
      configName,
      "export default { output: 'static' };\n"
    );
    const before = computeVerificationInputFingerprint(projectRoot);

    fs.writeFileSync(
      configPath,
      "export default { output: 'static', trailingSlash: 'always' };\n"
    );

    assert.notEqual(
      computeVerificationInputFingerprint(projectRoot),
      before,
      `${configName} must affect the verification fingerprint`
    );
  }
});

test('reuses only reports from a full standard or extensive run', (t) => {
  const projectRoot = createProject(t);
  const spec = { version: 1, targetCaseIds: ['navigation--open'] };

  for (const profile of ['standard', 'extensive']) {
    const report = createSuccessfulReport(projectRoot, spec);
    report.verification.profile = profile;
    assert.deepEqual(validateReusableVerificationReport(projectRoot, report), []);
  }
  for (const profile of ['targeted', undefined]) {
    const report = createSuccessfulReport(projectRoot, spec);
    report.verification.profile = profile;
    assert.match(
      validateReusableVerificationReport(projectRoot, report).join('\n'),
      /targeted repair evidence cannot be reused/
    );
  }
});

test('rejects failed and unsupported reports', (t) => {
  const projectRoot = createProject(t);
  assert.match(
    validateReusableVerificationReport(projectRoot, {
      summary: { errors: 1, failed: 1 },
    }).join('\n'),
    /failed checks/
  );
});

test('rejects missing or contradictory detailed report evidence', (t) => {
  const projectRoot = createProject(t);
  const spec = { version: 1 };
  const truncated = createSuccessfulReport(projectRoot, spec);
  delete truncated.results;
  assert.match(
    validateReusableVerificationReport(
      projectRoot,
      truncated
    ).join('\n'),
    /must contain detailed results and findings/
  );

  const contradictory = createSuccessfulReport(projectRoot, spec);
  contradictory.results[0].status = 'failed';
  contradictory.findings.push({
    caseId: contradictory.results[0].id,
    rule: 'synthetic-failure',
    severity: 'error',
    message: 'Synthetic failure.',
    selector: 'main',
  });
  const errors = validateReusableVerificationReport(
    projectRoot,
    contradictory
  ).join('\n');
  assert.match(errors, /summary does not match its detailed evidence/);
  assert.match(errors, /contains failed checks/);
});
