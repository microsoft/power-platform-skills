const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  detectMetadataLayout,
  parseTopLevelSequence,
  upsertAggregateRecord,
} = require('../lib/non-spa-metadata');
const {
  createTempNonSpaSite,
  writeProjectFile,
} = require('./test-utils');

test('parseTopLevelSequence normalizes PAC aggregate records and arrays', () => {
  const records = parseTopLevelSequence(
    [
      '- adx_name: Members',
      '  adx_related_ids:',
      '  - 11111111-1111-4111-8111-111111111111',
      '  adx_webroleid: 22222222-2222-4222-8222-222222222222',
      '- adx_name: Reviewers',
      '  adx_webroleid: 33333333-3333-4333-8333-333333333333',
      '',
    ].join('\n'),
    'webrole.yml'
  );

  assert.equal(records.length, 2);
  assert.equal(records[0].adx_name, 'Members');
  assert.deepEqual(records[0].adx_related_ids, [
    '11111111-1111-4111-8111-111111111111',
  ]);
  assert.equal(records[1].adx_name, 'Reviewers');
});

test('detectMetadataLayout keeps role and setting storage independent', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  writeProjectFile(
    siteRoot,
    'webrole.yml',
    '- adx_name: Members\n  adx_webroleid: 11111111-1111-4111-8111-111111111111\n'
  );
  writeProjectFile(
    siteRoot,
    'site-settings/example.sitesetting.yml',
    'id: 22222222-2222-4222-8222-222222222222\nname: Example\nvalue: true\n'
  );

  const layout = detectMetadataLayout(siteRoot);

  assert.equal(layout.roles.mode, 'aggregate');
  assert.equal(layout.settings.mode, 'per-record');
  assert.equal(layout.tablePermissions.fieldFormat, 'adx');
});

test('detectMetadataLayout reports mixed storage without choosing a writer', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  writeProjectFile(
    siteRoot,
    'sitesetting.yml',
    '- adx_name: Existing\n  adx_sitesettingid: 11111111-1111-4111-8111-111111111111\n'
  );
  writeProjectFile(
    siteRoot,
    'site-settings/existing.sitesetting.yml',
    'id: 22222222-2222-4222-8222-222222222222\nname: Existing Per Record\nvalue: true\n'
  );

  const layout = detectMetadataLayout(siteRoot);

  assert.equal(layout.settings.mode, 'mixed');
  assert.equal(fs.existsSync(path.join(siteRoot, 'sitesetting.yml')), true);
  assert.equal(fs.existsSync(path.join(siteRoot, 'site-settings')), true);
});

test('upsertAggregateRecord updates one record without rewriting unrelated records', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  const aggregatePath = writeProjectFile(
    siteRoot,
    'sitesetting.yml',
    [
      '- adx_custom: preserve-me',
      '  adx_name: Search/Enabled',
      '  adx_value: true',
      '- adx_name: Site/AI/Skills/EditSite',
      '  adx_sitesettingid: 11111111-1111-4111-8111-111111111111',
      '  adx_value: "2"',
      '',
    ].join('\n'),
  );
  const unrelatedBlock = [
    '- adx_custom: preserve-me',
    '  adx_name: Search/Enabled',
    '  adx_value: true',
    '',
  ].join('\n');

  const result = upsertAggregateRecord(aggregatePath, {
    matchField: 'adx_name',
    matchValue: 'Site/AI/Skills/EditSite',
    fields: {},
    keyOrder: [],
    updates: { adx_value: '3' },
  });

  assert.deepEqual(result, { created: false });
  const updated = fs.readFileSync(aggregatePath, 'utf8');
  assert.ok(updated.startsWith(unrelatedBlock));
  assert.match(updated, /adx_value: "3"/);
});

test('upsertAggregateRecord rejects duplicate match keys without changing the file', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  const aggregatePath = writeProjectFile(
    siteRoot,
    'sitesetting.yml',
    [
      '- adx_name: Duplicate',
      '  adx_value: one',
      '- adx_name: Duplicate',
      '  adx_value: two',
      '',
    ].join('\n'),
  );
  const before = fs.readFileSync(aggregatePath, 'utf8');

  assert.throws(
    () => upsertAggregateRecord(aggregatePath, {
      matchField: 'adx_name',
      matchValue: 'Duplicate',
      fields: {},
      keyOrder: [],
      updates: { adx_value: 'three' },
    }),
    /duplicate "adx_name" value "Duplicate"/,
  );
  assert.equal(fs.readFileSync(aggregatePath, 'utf8'), before);
});
