const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectProjectContext, readWebsiteYml } = require('../lib/detect-project-context');
const { findProjectRoot } = require('../lib/validation-helpers');
const { createTempProject, writeProjectFile } = require('./test-utils');

test('detectProjectContext throws when neither config nor .powerpages-site/website.yml exists', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.throws(
    () => detectProjectContext({ projectRoot: dir }),
    /neither powerpages\.config\.json nor/
  );
});

test('detectProjectContext: SPA site (powerpages.config.json) reports siteType "spa"', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', JSON.stringify({
    siteName: 'SPA Site',
    websiteRecordId: 'aabbccdd-1234-5678-abcd-00000000000c',
    environmentUrl: 'https://org.crm.dynamics.com',
  }));

  const result = detectProjectContext({ projectRoot });
  assert.equal(result.siteType, 'spa');
  assert.equal(result.siteName, 'SPA Site');
  assert.equal(result.siteRoot, path.join(projectRoot, '.powerpages-site'));
});

test('detectProjectContext: non-SPA site resolves identity from .powerpages-site/website.yml', (t) => {
  const projectRoot = createTempProject(t);
  // No powerpages.config.json — this is a non-SPA Design Studio site.
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
  assert.equal(result.siteType, 'non-spa');
  assert.equal(result.websiteRecordId, '2ecc32f6-8665-f111-a826-000d3a5a7777');
  assert.equal(result.siteName, 'Application processing EDM site - permitapplication-elyyn');
  assert.equal(result.siteRoot, path.join(projectRoot, '.powerpages-site'));
  // Non-SPA sites carry no environment URL locally — callers re-confirm via `pac env who`.
  assert.equal(result.environmentUrl, null);
});

test('detectProjectContext: direct PAC root resolves non-SPA identity and siteRoot', (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-direct-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(projectRoot, '.portalconfig'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.portalconfig', 'manifest.yml'), 'modelVersion: 2\n');
  fs.writeFileSync(
    path.join(projectRoot, 'website.yml'),
    'id: 3ecc32f6-8665-f111-a826-000d3a5a7777\nname: Direct Non-SPA Site\n',
  );

  const result = detectProjectContext({ projectRoot });
  assert.equal(result.siteType, 'non-spa');
  assert.equal(result.projectRoot, projectRoot);
  assert.equal(result.siteRoot, projectRoot);
  assert.equal(result.siteName, 'Direct Non-SPA Site');
  assert.equal(result.websiteRecordId, '3ecc32f6-8665-f111-a826-000d3a5a7777');
  assert.equal(result.environmentUrl, null);
});

test('detectProjectContext retains enclosing manifests when starting inside nested PAC metadata', (t) => {
  const projectRoot = createTempProject(t);
  const nestedStart = path.join(projectRoot, '.powerpages-site', 'web-pages', 'home');
  fs.mkdirSync(nestedStart, { recursive: true });
  writeProjectFile(projectRoot, '.powerpages-site/.portalconfig/manifest.yml', 'modelVersion: 2\n');
  writeProjectFile(
    projectRoot,
    '.powerpages-site/website.yml',
    'id: 4ecc32f6-8665-f111-a826-000d3a5a7777\nname: Wrapped Non-SPA Site\n',
  );
  writeProjectFile(
    projectRoot,
    '.solution-manifest.json',
    JSON.stringify({ solution: { uniqueName: 'WrappedSolution' } }),
  );
  writeProjectFile(
    projectRoot,
    '.datamodel-manifest.json',
    JSON.stringify({ tables: [{ logicalName: 'contoso_item' }] }),
  );

  const resolvedProjectRoot = findProjectRoot(nestedStart);
  const result = detectProjectContext({ projectRoot: resolvedProjectRoot });

  assert.equal(resolvedProjectRoot, projectRoot);
  assert.equal(result.projectRoot, projectRoot);
  assert.equal(result.siteRoot, path.join(projectRoot, '.powerpages-site'));
  assert.equal(result.siteType, 'non-spa');
  assert.equal(result.solutionManifest.solution.uniqueName, 'WrappedSolution');
  assert.equal(result.datamodelManifest.tables[0].logicalName, 'contoso_item');
});

test('detectProjectContext: .powerpages-site/.portalconfig/ is the positive non-SPA signal (even without website.yml)', (t) => {
  const projectRoot = createTempProject(t);
  // A non-SPA site identified by its .portalconfig/ marker, with no website.yml
  // (rare, but .portalconfig is the authoritative signal — identity resolves at runtime).
  writeProjectFile(projectRoot, '.powerpages-site/.portalconfig/manifest.yml', 'foo: bar\n');

  const result = detectProjectContext({ projectRoot });
  assert.equal(result.siteType, 'non-spa', '.portalconfig/ marks a non-SPA site');
  assert.equal(result.siteName, null);
  assert.equal(result.websiteRecordId, null);
  assert.equal(result.environmentUrl, null);
});

test('detectProjectContext: SPA config wins over website.yml when both exist', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', JSON.stringify({
    siteName: 'Code Wins',
    websiteRecordId: 'config-guid',
    environmentUrl: 'https://org.crm.dynamics.com',
  }));
  writeProjectFile(projectRoot, '.powerpages-site/website.yml', 'id: yml-guid\nname: YAML Name\n');

  const result = detectProjectContext({ projectRoot });
  assert.equal(result.siteType, 'spa');
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
