'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePagesListVerbose, diffPagesListVerbose, isInactiveState } = require('../lib/pages-list-diff');
const { parseArgs } = require('../diff-pages-list');

const ID1 = '11111111-1111-1111-1111-111111111111';
const ID2 = '22222222-2222-2222-2222-222222222222';
const ID3 = '33333333-3333-3333-3333-333333333333';

test('parsePagesListVerbose extracts site names and website record IDs from table rows', () => {
  const output = `
Website Name        Website Record ID                         State
------------------  ------------------------------------      ----------
Contoso Portal      ${ID1}      Inactive
Partner Hub         ${ID2}      Active
`;

  assert.deepEqual(parsePagesListVerbose(output), [
    { siteName: 'Contoso Portal', websiteRecordId: ID1, state: 'Inactive' },
    { siteName: 'Partner Hub', websiteRecordId: ID2, state: 'Active' },
  ]);
});

test('parsePagesListVerbose handles indexed GUID-before-name PAC output', () => {
  const output = `
Index  Website Id                             Friendly Name      State
1      ${ID1}      Contoso Portal     Inactive
`;

  assert.deepEqual(parsePagesListVerbose(output), [
    { siteName: 'Contoso Portal', websiteRecordId: ID1, state: 'Inactive' },
  ]);
});

test('diffPagesListVerbose returns the single imported site added after import', () => {
  const before = `Contoso Portal      ${ID1}      Active`;
  const after = `${before}\nTemplate Site      ${ID2}      Inactive`;

  assert.deepEqual(diffPagesListVerbose(before, after), {
    status: 'found',
    siteName: 'Template Site',
    websiteRecordId: ID2,
    state: 'Inactive',
    inactive: true,
    added: [{ siteName: 'Template Site', websiteRecordId: ID2, state: 'Inactive' }],
  });
});

test('diffPagesListVerbose marks found rows inactive only when the verbose state indicates it', () => {
  assert.equal(diffPagesListVerbose(`A ${ID1}`, `A ${ID1}\nB ${ID2} Active`).inactive, false);
  assert.equal(isInactiveState('Not Provisioned'), true);
  assert.equal(isInactiveState('Active'), false);
});

test('diffPagesListVerbose reports none or multiple when the import row is ambiguous', () => {
  assert.deepEqual(diffPagesListVerbose(`A ${ID1}`, `A ${ID1}`), { status: 'none', added: [] });
  assert.deepEqual(diffPagesListVerbose(`A ${ID1}`, `A ${ID1}\nB ${ID2}\nC ${ID3}`), {
    status: 'multiple',
    added: [
      { siteName: 'B', websiteRecordId: ID2, state: null },
      { siteName: 'C', websiteRecordId: ID3, state: null },
    ],
  });
});

test('diffPagesListVerbose can match an existing template site when import creates no new row', () => {
  const before = `Template Site      ${ID1}      Inactive`;
  const after = `Template Site      ${ID1}      Inactive`;

  assert.deepEqual(diffPagesListVerbose(before, after, { expectedSiteName: 'Template Site' }), {
    status: 'existing',
    siteName: 'Template Site',
    websiteRecordId: ID1,
    state: 'Inactive',
    inactive: true,
    added: [],
    warning: 'No new site appeared in pac pages list; matched an existing site by expected template site name.',
  });
});

test('diffPagesListVerbose can match an existing template site by normalized aliases when import updates the solution', () => {
  const before = `311 Portal React      ${ID1}      Inactive`;
  const after = before;

  assert.deepEqual(diffPagesListVerbose(before, after, { expectedSiteName: '311 Portal' }), {
    status: 'existing',
    siteName: '311 Portal React',
    websiteRecordId: ID1,
    state: 'Inactive',
    inactive: true,
    added: [],
    warning: 'No new site appeared in pac pages list; matched an existing site by expected template site name.',
  });
});

test('diffPagesListVerbose can match an existing template site using alternate expected names', () => {
  const before = `311 Portal React      ${ID1}      Inactive`;
  const after = before;

  assert.equal(diffPagesListVerbose(before, after, { expectedSiteNames: ['Supplier Portal', '311 Portal'] }).status, 'existing');
});

test('diffPagesListVerbose reports ambiguous existing template site matches', () => {
  const before = `Template Site      ${ID1}      Inactive\nTemplate Site      ${ID2}      Inactive`;
  const after = before;

  assert.deepEqual(diffPagesListVerbose(before, after, { expectedSiteName: 'Template Site' }), {
    status: 'existing-multiple',
    added: [],
    existing: [
      { siteName: 'Template Site', websiteRecordId: ID1, state: 'Inactive' },
      { siteName: 'Template Site', websiteRecordId: ID2, state: 'Inactive' },
    ],
  });
});

test('parsePagesListVerbose ignores malformed lines without GUIDs', () => {
  assert.deepEqual(parsePagesListVerbose(`not a row\nBroken Portal not-a-guid Inactive\nValid Site ${ID1} Inactive`), [
    { siteName: 'Valid Site', websiteRecordId: ID1, state: 'Inactive' },
  ]);
});

test('parseArgs reads before and after snapshot file paths', () => {
  assert.deepEqual(parseArgs(['--before', '/tmp/before.txt', '--after', '/tmp/after.txt', '--expectedSiteName', 'Template Site']), {
    before: '/tmp/before.txt',
    after: '/tmp/after.txt',
    expectedSiteName: 'Template Site',
    expectedSiteNames: ['Template Site'],
  });
});

test('parseArgs keeps repeated expected site names as fallback aliases', () => {
  assert.deepEqual(parseArgs([
    '--before', '/tmp/before.txt',
    '--after', '/tmp/after.txt',
    '--expectedSiteName', '311 Portal',
    '--expectedSiteName', '311 Portal React',
  ]), {
    before: '/tmp/before.txt',
    after: '/tmp/after.txt',
    expectedSiteName: '311 Portal React',
    expectedSiteNames: ['311 Portal', '311 Portal React'],
  });
});
