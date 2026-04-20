const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectProjectContext } = require('../lib/detect-project-context');
const { createTempProject, writeProjectFile } = require('./test-utils');

test('detectProjectContext throws when powerpages.config.json is missing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.throws(
    () => detectProjectContext({ projectRoot: dir }),
    /powerpages.config.json not found/
  );
});

test('detectProjectContext returns siteName and websiteRecordId from config', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', JSON.stringify({
    siteName: 'My Test Site',
    websiteRecordId: 'aabbccdd-1234-5678-abcd-000000000001',
    environmentUrl: 'https://org.crm.dynamics.com',
  }));

  const result = detectProjectContext({ projectRoot });
  assert.equal(result.siteName, 'My Test Site');
  assert.equal(result.websiteRecordId, 'aabbccdd-1234-5678-abcd-000000000001');
  assert.equal(result.environmentUrl, 'https://org.crm.dynamics.com');
  assert.equal(result.projectRoot, projectRoot);
});

test('detectProjectContext returns null for missing optional manifests', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', JSON.stringify({
    siteName: 'Site',
    websiteRecordId: 'aabbccdd-1234-5678-abcd-000000000002',
    environmentUrl: 'https://org.crm.dynamics.com',
  }));

  const result = detectProjectContext({ projectRoot });
  assert.equal(result.solutionManifest, null);
  assert.equal(result.datamodelManifest, null);
});

test('detectProjectContext reads .solution-manifest.json when present', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', JSON.stringify({
    siteName: 'Site',
    websiteRecordId: 'aabbccdd-1234-5678-abcd-000000000003',
    environmentUrl: 'https://org.crm.dynamics.com',
  }));
  writeProjectFile(projectRoot, '.solution-manifest.json', JSON.stringify({
    solution: { uniqueName: 'TestSolution', solutionId: 'sol-guid' },
  }));

  const result = detectProjectContext({ projectRoot });
  assert.ok(result.solutionManifest);
  assert.equal(result.solutionManifest.solution.uniqueName, 'TestSolution');
});

test('detectProjectContext gracefully handles malformed .solution-manifest.json', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', JSON.stringify({
    siteName: 'Site',
    websiteRecordId: 'aabbccdd-1234-5678-abcd-000000000004',
    environmentUrl: 'https://org.crm.dynamics.com',
  }));
  writeProjectFile(projectRoot, '.solution-manifest.json', '{ invalid json ');

  const result = detectProjectContext({ projectRoot });
  assert.equal(result.solutionManifest, null);
});
