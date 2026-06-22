'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseEnvList } = require('../lib/list-environments');

// Real `pac env list` table shape on PAC 2.8.1 (the command that replaced the
// invalid `pac env list --output json`). Header row + "Connected as" banner must
// be skipped; the active env carries a leading `*`.
const SAMPLE = [
  'Connected as admin@contoso.onmicrosoft.com',
  'Active Display Name                            Environment ID                       Environment URL                                           Unique Name',
  '       1841 Community V2 Fresh                 d664a1f5-5c5b-efbf-9cc9-c1923c437109 https://1841communityv2fresh.crm.dynamics.com/            unq78bd16d6e4baf01189f56045bd003',
  '*      Contoso Dev                            e8ccb697-db78-e2d6-b721-ef23eedbc302 https://contosodev.crm4.dynamics.com/                     unqe4574a3ea1bff01195c56045bd03c',
  '       281025                                 a33797f3-ca8b-e81b-97f9-01dec883d806 https://org9cf0ed45.crm.dynamics.com/                     unqb66c441afcb3f01195c56045bd021',
].join('\n');

test('parseEnvList extracts each env row with display name, GUID, URL (trailing slash stripped), unique name', () => {
  const rows = parseEnvList(SAMPLE);
  assert.equal(rows.length, 3, 'header + banner lines must be skipped, 3 data rows kept');

  assert.deepEqual(rows[0], {
    displayName: '1841 Community V2 Fresh',
    environmentId: 'd664a1f5-5c5b-efbf-9cc9-c1923c437109',
    environmentUrl: 'https://1841communityv2fresh.crm.dynamics.com', // trailing / stripped
    uniqueName: 'unq78bd16d6e4baf01189f56045bd003',
    active: false,
  });

  // Display names with spaces are preserved; the active `*` marker is parsed, not
  // leaked into the display name.
  assert.equal(rows[1].displayName, 'Contoso Dev');
  assert.equal(rows[1].active, true);
  assert.equal(rows[1].environmentUrl, 'https://contosodev.crm4.dynamics.com');

  // Numeric-leading display names are fine (anchored on the GUID, not the name).
  assert.equal(rows[2].displayName, '281025');
  assert.equal(rows[2].active, false);
});

test('parseEnvList returns [] for empty / banner-only / malformed input', () => {
  assert.deepEqual(parseEnvList(''), []);
  assert.deepEqual(parseEnvList(null), []);
  assert.deepEqual(parseEnvList('Connected as x@y.com\nActive Display Name Environment ID Environment URL Unique Name'), []);
  // A pac error banner with no table rows.
  assert.deepEqual(parseEnvList('Error: An unknown argument --output was passed.'), []);
});

test('parseEnvList ignores rows without all three anchor tokens (GUID + URL + uniqueName)', () => {
  // A wrapped/partial line missing the URL must not produce a half-populated row.
  const partial = 'Connected as a@b.com\n       Half Row                  d664a1f5-5c5b-efbf-9cc9-c1923c437109   unqonly';
  assert.deepEqual(parseEnvList(partial), []);
});
