const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  loadAggregateRecords,
  normalizeSiteSetting,
} = require('../lib/non-spa-metadata');
const { createTempNonSpaSite, writeProjectFile } = require('./test-utils');

const scriptPath = path.resolve(__dirname, '..', 'update-skill-tracking.js');

function runTracking(projectRoot) {
  return spawnSync(
    process.execPath,
    [
      scriptPath,
      '--projectRoot', projectRoot,
      '--skillName', 'EditSite',
      '--authoringTool', 'GitHub Copilot',
    ],
    { encoding: 'utf8' },
  );
}

test('writes tracking records to per-record site-setting storage', (t) => {
  const siteRoot = createTempNonSpaSite(t);

  const result = runTracking(siteRoot);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    fs.existsSync(path.join(siteRoot, 'site-settings', 'Site-AI-Skills-EditSite.sitesetting.yml')),
  );
  assert.ok(
    fs.existsSync(path.join(siteRoot, 'site-settings', 'Site-AI-Tools-AuthoringTool.sitesetting.yml')),
  );
});

test('creates tracking records in aggregate storage without using an empty per-record directory', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  const aggregatePath = writeProjectFile(
    siteRoot,
    'sitesetting.yml',
    '- adx_name: Search/Enabled\n  adx_sitesettingid: 778fa3d0-a2ef-4d2b-98b8-e6c7d8ce1444\n  adx_value: true\n',
  );
  const before = fs.readFileSync(aggregatePath, 'utf8');

  const result = runTracking(siteRoot);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Created Site\/AI\/Skills\/EditSite counter/);
  assert.ok(fs.readFileSync(aggregatePath, 'utf8').startsWith(before));
  assert.deepEqual(fs.readdirSync(path.join(siteRoot, 'site-settings')), []);
  const settings = loadAggregateRecords(aggregatePath).map(normalizeSiteSetting);
  assert.equal(settings.find(setting => setting.name === 'Site/AI/Skills/EditSite').value, '1');
  assert.equal(
    settings.find(setting => setting.name === 'Site/AI/Tools/AuthoringTool').value,
    'GitHubCopilot',
  );
});

test('increments aggregate counters while preserving unrelated fields and the existing authoring tool', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  const aggregatePath = writeProjectFile(
    siteRoot,
    'sitesetting.yml',
    [
      '- adx_custom: preserve-me',
      '  adx_name: Search/Enabled',
      '  adx_sitesettingid: 778fa3d0-a2ef-4d2b-98b8-e6c7d8ce1444',
      '  adx_value: true',
      '- adx_description: Existing counter',
      '  adx_name: Site/AI/Skills/EditSite',
      '  adx_sitesettingid: 888fa3d0-a2ef-4d2b-98b8-e6c7d8ce1444',
      '  adx_value: "4"',
      '- adx_custom: author-extra',
      '  adx_name: Site/AI/Tools/AuthoringTool',
      '  adx_sitesettingid: 998fa3d0-a2ef-4d2b-98b8-e6c7d8ce1444',
      '  adx_value: ClaudeCode',
      '',
    ].join('\n'),
  );

  const result = runTracking(siteRoot);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Updated Site\/AI\/Skills\/EditSite counter to 5/);
  assert.match(result.stdout, /AuthoringTool setting already exists/);
  const records = loadAggregateRecords(aggregatePath);
  const settings = records.map(normalizeSiteSetting);
  assert.equal(settings.find(setting => setting.name === 'Site/AI/Skills/EditSite').value, '5');
  assert.equal(
    settings.find(setting => setting.name === 'Site/AI/Tools/AuthoringTool').value,
    'ClaudeCode',
  );
  assert.equal(records.find(record => record.adx_name === 'Search/Enabled').adx_custom, 'preserve-me');
  assert.equal(
    records.find(record => record.adx_name === 'Site/AI/Tools/AuthoringTool').adx_custom,
    'author-extra',
  );
});

test('rejects mixed aggregate and per-record site-setting storage before writing', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  writeProjectFile(
    siteRoot,
    'sitesetting.yml',
    '- adx_name: Search/Enabled\n  adx_sitesettingid: 778fa3d0-a2ef-4d2b-98b8-e6c7d8ce1444\n  adx_value: true\n',
  );
  writeProjectFile(
    siteRoot,
    'site-settings/existing.sitesetting.yml',
    'id: 928fa3d0-a2ef-4d2b-98b8-e6c7d8ce1444\nname: Search/Enabled\nvalue: true\n',
  );

  const before = fs.readdirSync(path.join(siteRoot, 'site-settings')).sort();
  const result = runTracking(siteRoot);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Mixed site-setting serialization/);
  assert.deepEqual(fs.readdirSync(path.join(siteRoot, 'site-settings')).sort(), before);
});

test('preserves the no-op when site-setting storage is absent', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  fs.rmSync(path.join(siteRoot, 'site-settings'), { recursive: true });

  const result = runTracking(siteRoot);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(fs.existsSync(path.join(siteRoot, 'site-settings')), false);
});

test('leaves malformed aggregate storage unchanged when parsing fails', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  const aggregatePath = writeProjectFile(
    siteRoot,
    'sitesetting.yml',
    'adx_name: This is not a top-level sequence\n',
  );
  const before = fs.readFileSync(aggregatePath, 'utf8');

  const result = runTracking(siteRoot);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Failed to update aggregate site settings/);
  assert.equal(fs.readFileSync(aggregatePath, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.join(siteRoot, 'site-settings')), []);
});
