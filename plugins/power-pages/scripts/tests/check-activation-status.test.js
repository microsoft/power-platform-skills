const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createTempProject, writeProjectFile } = require('./test-utils');
const {
  readWebsiteIdFromYaml,
  extractWebsiteIdsByName,
  matchWebsite,
} = require('../check-activation-status');

// readWebsiteIdFromYaml -------------------------------------------------------

test('readWebsiteIdFromYaml returns the top-level id when website.yml is well-formed', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/website.yml',
    [
      'id: 39a4d5c5-2db4-4117-a08c-62bdb8cc2af7',
      'adx_name: Faq 1',
      'adx_websiteurl: https://faq-5t31u.powerappsportals.com',
      '',
    ].join('\n'),
  );
  assert.equal(
    readWebsiteIdFromYaml(projectRoot),
    '39a4d5c5-2db4-4117-a08c-62bdb8cc2af7',
  );
});

test('readWebsiteIdFromYaml strips surrounding quotes from the id value', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/website.yml',
    'id: "39a4d5c5-2db4-4117-a08c-62bdb8cc2af7"\n',
  );
  assert.equal(
    readWebsiteIdFromYaml(projectRoot),
    '39a4d5c5-2db4-4117-a08c-62bdb8cc2af7',
  );
});

test('readWebsiteIdFromYaml ignores indented id keys nested under other blocks', (t) => {
  const projectRoot = createTempProject(t);
  // A nested `id:` under an indented block would correspond to a child record. The
  // top-level id is the website record id; indented ones are something else (e.g. a
  // related entity) and must not be used as the website record id.
  writeProjectFile(
    projectRoot,
    '.powerpages-site/website.yml',
    [
      'children:',
      '  - id: 11111111-1111-1111-1111-111111111111',
      'id: 39a4d5c5-2db4-4117-a08c-62bdb8cc2af7',
      '',
    ].join('\n'),
  );
  assert.equal(
    readWebsiteIdFromYaml(projectRoot),
    '39a4d5c5-2db4-4117-a08c-62bdb8cc2af7',
  );
});

test('readWebsiteIdFromYaml returns null when website.yml is absent', (t) => {
  const projectRoot = createTempProject(t);
  assert.equal(readWebsiteIdFromYaml(projectRoot), null);
});

test('readWebsiteIdFromYaml returns null when website.yml has no id line', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/website.yml',
    'adx_name: Faq 1\n',
  );
  assert.equal(readWebsiteIdFromYaml(projectRoot), null);
});

test('readWebsiteIdFromYaml returns null when the id value is not a GUID', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/website.yml',
    'id: not-a-guid\n',
  );
  assert.equal(readWebsiteIdFromYaml(projectRoot), null);
});

// extractWebsiteIdsByName -----------------------------------------------------

const PAC_LIST_TWO_ROWS_SAME_NAME = [
  'Website Name      Website Record ID                     Website ID',
  '----------------  ------------------------------------  ----------',
  'Faq 1             edb7a30a-6d48-f111-bec7-6045bd001091  src-id',
  'Faq 1             39a4d5c5-2db4-4117-a08c-62bdb8cc2af7  tgt-id',
  'Other Site        00000000-0000-0000-0000-000000000001  oth-id',
  '',
].join('\n');

const PAC_LIST_ONE_ROW = [
  'Website Name      Website Record ID                     Website ID',
  '----------------  ------------------------------------  ----------',
  'Faq 1             39a4d5c5-2db4-4117-a08c-62bdb8cc2af7  tgt-id',
  '',
].join('\n');

test('extractWebsiteIdsByName returns both GUIDs when two sites share a name (migration drift)', () => {
  const ids = extractWebsiteIdsByName(PAC_LIST_TWO_ROWS_SAME_NAME, 'Faq 1');
  assert.deepEqual(ids.map((id) => id.toLowerCase()), [
    'edb7a30a-6d48-f111-bec7-6045bd001091',
    '39a4d5c5-2db4-4117-a08c-62bdb8cc2af7',
  ]);
});

test('extractWebsiteIdsByName returns a single GUID when the name is unique', () => {
  const ids = extractWebsiteIdsByName(PAC_LIST_ONE_ROW, 'Faq 1');
  assert.deepEqual(ids.map((id) => id.toLowerCase()), [
    '39a4d5c5-2db4-4117-a08c-62bdb8cc2af7',
  ]);
});

test('extractWebsiteIdsByName matches case-insensitively', () => {
  const ids = extractWebsiteIdsByName(PAC_LIST_ONE_ROW, 'fAq 1');
  assert.equal(ids.length, 1);
});

test('extractWebsiteIdsByName ignores header and separator rows', () => {
  const ids = extractWebsiteIdsByName(PAC_LIST_ONE_ROW, 'Website Name');
  assert.deepEqual(ids, []);
});

test('extractWebsiteIdsByName returns an empty array when the name does not appear', () => {
  const ids = extractWebsiteIdsByName(PAC_LIST_ONE_ROW, 'Nonexistent');
  assert.deepEqual(ids, []);
});

test('extractWebsiteIdsByName tolerates empty or missing inputs', () => {
  assert.deepEqual(extractWebsiteIdsByName('', 'Faq 1'), []);
  assert.deepEqual(extractWebsiteIdsByName(null, 'Faq 1'), []);
  assert.deepEqual(extractWebsiteIdsByName(PAC_LIST_ONE_ROW, ''), []);
});

test('extractWebsiteIdsByName dedupes a GUID that appears on two rows containing the name', () => {
  // Defensive — `pac pages list` shouldn't emit a duplicate row, but we still dedupe.
  const repeated = PAC_LIST_ONE_ROW + PAC_LIST_ONE_ROW;
  const ids = extractWebsiteIdsByName(repeated, 'Faq 1');
  assert.equal(ids.length, 1);
});

// matchWebsite ----------------------------------------------------------------

const TWO_WEBSITES_SAME_NAME = [
  {
    name: 'Faq 1',
    websiteRecordId: 'edb7a30a-6d48-f111-bec7-6045bd001091',
    websiteUrl: 'https://faq-5t31u.powerappsportals.com',
  },
  {
    name: 'Faq 1',
    websiteRecordId: '39a4d5c5-2db4-4117-a08c-62bdb8cc2af7',
    websiteUrl: null,
  },
];

test('matchWebsite returns the GUID-matched record when websiteRecordId is provided, even on name collision', () => {
  const match = matchWebsite(
    TWO_WEBSITES_SAME_NAME,
    '39a4d5c5-2db4-4117-a08c-62bdb8cc2af7',
    'Faq 1',
  );
  assert.ok(match);
  assert.equal(match.websiteRecordId, '39a4d5c5-2db4-4117-a08c-62bdb8cc2af7');
});

test('matchWebsite ignores name when GUID is provided but does not match any record', () => {
  // This is the key safety: when a GUID is known the function MUST NOT silently fall
  // back to a name match — that would re-introduce the source/target confusion the YAML
  // id was designed to prevent.
  const match = matchWebsite(
    TWO_WEBSITES_SAME_NAME,
    '00000000-0000-0000-0000-000000000000',
    'Faq 1',
  );
  assert.equal(match, null);
});

test('matchWebsite GUID match is case-insensitive', () => {
  const match = matchWebsite(
    TWO_WEBSITES_SAME_NAME,
    '39A4D5C5-2DB4-4117-A08C-62BDB8CC2AF7',
    'Faq 1',
  );
  assert.ok(match);
  assert.equal(
    match.websiteRecordId.toLowerCase(),
    '39a4d5c5-2db4-4117-a08c-62bdb8cc2af7',
  );
});

test('matchWebsite returns ambiguous when no GUID is provided and the name matches multiple records', () => {
  const match = matchWebsite(TWO_WEBSITES_SAME_NAME, null, 'Faq 1');
  assert.ok(match);
  assert.equal(match.ambiguous, true);
  assert.equal(match.candidates.length, 2);
});

test('matchWebsite returns the single record when no GUID is provided and name is unique', () => {
  const websites = [
    {
      name: 'My Site',
      websiteRecordId: '11111111-1111-1111-1111-111111111111',
      websiteUrl: 'https://my-site.powerappsportals.com',
    },
  ];
  const match = matchWebsite(websites, null, 'My Site');
  assert.ok(match);
  assert.equal(match.websiteRecordId, '11111111-1111-1111-1111-111111111111');
});

test('matchWebsite returns null when neither GUID nor name match', () => {
  assert.equal(matchWebsite(TWO_WEBSITES_SAME_NAME, null, 'Nothing'), null);
  assert.equal(matchWebsite([], null, 'Faq 1'), null);
});

test('matchWebsite returns null when the websites argument is not an array', () => {
  assert.equal(matchWebsite(null, 'any-id', 'any-name'), null);
  assert.equal(matchWebsite(undefined, null, 'any-name'), null);
});
