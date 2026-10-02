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

test('invalidates evidence when source or locale availability changes', (t) => {
  const projectRoot = createProject(t);
  const report = {
    summary: { errors: 0, failed: 0 },
    verification: {
      evidence: createVerificationEvidence(projectRoot, { version: 1 }),
    },
  };

  assert.deepEqual(validateReusableVerificationReport(projectRoot, report), []);
  fs.writeFileSync(path.join(projectRoot, 'src/App.tsx'), 'export const App = null;');
  assert.match(
    validateReusableVerificationReport(projectRoot, report).join('\n'),
    /evidence is stale/
  );
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
