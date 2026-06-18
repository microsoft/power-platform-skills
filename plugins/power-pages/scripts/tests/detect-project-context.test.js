const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectProjectContext, readWebsiteYml } = require('../lib/detect-project-context');
const { createTempProject, writeProjectFile } = require('./test-utils');

test('detectProjectContext throws when neither config nor .powerpages-site/website.yml exists', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.throws(
    () => detectProjectContext({ projectRoot: dir }),
    /neither powerpages\.config\.json nor/
  );
});

test('detectProjectContext: code site (powerpages.config.json) reports siteType "code"', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', JSON.stringify({
    siteName: 'Code Site',
    websiteRecordId: 'aabbccdd-1234-5678-abcd-00000000000c',
    environmentUrl: 'https://org.crm.dynamics.com',
  }));

  const result = detectProjectContext({ projectRoot });
  assert.equal(result.siteType, 'code');
  assert.equal(result.siteName, 'Code Site');
});

test('detectProjectContext: declarative (data-model) site resolves identity from .powerpages-site/website.yml', (t) => {
  const projectRoot = createTempProject(t);
  // No powerpages.config.json — this is a declarative ("data-model") design-studio site.
  writeProjectFile(
    projectRoot,
    '.powerpages-site/website.yml',
    [
      'defaultlanguage: 32cc32f6-8665-f111-a826-000d3a5a7777',
      'id: 2ecc32f6-8665-f111-a826-000d3a5a7777',
      'name: Application processing EDM site - permitapplication-elyyn',
      'statecode: 0',
      '',
    ].join('\n')
  );

  const result = detectProjectContext({ projectRoot });
  assert.equal(result.siteType, 'data-model');
  assert.equal(result.websiteRecordId, '2ecc32f6-8665-f111-a826-000d3a5a7777');
  assert.equal(result.siteName, 'Application processing EDM site - permitapplication-elyyn');
  // Data-model sites carry no environment URL locally — callers re-confirm via `pac env who`.
  assert.equal(result.environmentUrl, null);
});

test('detectProjectContext: .powerpages-site/.portalconfig/ is the positive declarative signal (even without website.yml)', (t) => {
  const projectRoot = createTempProject(t);
  // A declarative site identified by its .portalconfig/ marker, with no website.yml
  // (rare, but .portalconfig is the authoritative signal — identity resolves at runtime).
  writeProjectFile(projectRoot, '.powerpages-site/.portalconfig/manifest.yml', 'foo: bar\n');

  const result = detectProjectContext({ projectRoot });
  assert.equal(result.siteType, 'data-model', '.portalconfig/ marks a declarative site');
  assert.equal(result.siteName, null);
  assert.equal(result.websiteRecordId, null);
  assert.equal(result.environmentUrl, null);
});

test('detectProjectContext: config site wins over website.yml when both exist (code-site precedence)', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', JSON.stringify({
    siteName: 'Code Wins',
    websiteRecordId: 'config-guid',
    environmentUrl: 'https://org.crm.dynamics.com',
  }));
  writeProjectFile(projectRoot, '.powerpages-site/website.yml', 'id: yml-guid\nname: YAML Name\n');

  const result = detectProjectContext({ projectRoot });
  assert.equal(result.siteType, 'code');
  assert.equal(result.websiteRecordId, 'config-guid');
});

test('readWebsiteYml: extracts id + name, strips quotes, ignores other keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yml-test-'));
  const p = path.join(dir, 'website.yml');
  fs.writeFileSync(p, 'id: "abc-123"\nname: \'Quoted Site\'\nstatecode: 0\n');
  try {
    const site = readWebsiteYml(p);
    assert.deepEqual(site, { id: 'abc-123', name: 'Quoted Site' });
    assert.equal(readWebsiteYml(path.join(dir, 'missing.yml')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
