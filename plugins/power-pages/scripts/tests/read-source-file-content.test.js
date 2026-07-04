'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  readSourceFileContent,
  parseContentEnvelope,
  buildAttributeMetadataUrl,
  ENTITY_SET,
  DEFAULT_FILE_COLUMN,
} = require('../lib/read-source-file-content');

const BASE = 'https://org.crm.dynamics.com';
const ID = 'aaaaaaaa-1111-2222-3333-444444444444'; // == powerpagessourcefileid

// Build a _deps object injecting the metadata GET (makeRequest) and the binary
// filecontent/$value GET (httpGetBuffer). NO real network.
function makeDeps({ metaRow = undefined, metaStatus = 200, metaError = null, fileBuffer = null, fileError = null, fileStatus = null, capture = {} } = {}) {
  return {
    getAuthToken: () => 'tok',
    makeRequest: async ({ url }) => {
      capture.metaUrl = url;
      if (metaError) return { error: metaError };
      if (metaStatus !== 200) return { statusCode: metaStatus, body: JSON.stringify({ error: { message: `HTTP ${metaStatus}` } }) };
      return { statusCode: 200, body: JSON.stringify(metaRow === undefined ? {} : metaRow) };
    },
    httpGetBuffer: async (url, token) => {
      capture.fileUrl = url;
      capture.fileToken = token;
      if (fileError) { const r = { error: fileError }; if (fileStatus != null) r.statusCode = fileStatus; return r; }
      return { buffer: fileBuffer, statusCode: 200 };
    },
  };
}

// ── parseContentEnvelope ──────────────────────────────────────────────────────
test('parseContentEnvelope: extracts filename/mimetype/partialurl, never bytes', () => {
  const env = parseContentEnvelope(JSON.stringify({ filename: 'Home.tsx', mimetype: 'text/plain', partialurl: 'src/pages/Home.tsx' }));
  assert.deepEqual(env, { filename: 'Home.tsx', mimetype: 'text/plain', partialurl: 'src/pages/Home.tsx' });
});

test('parseContentEnvelope: garbage / null → all-null (fail soft)', () => {
  assert.deepEqual(parseContentEnvelope('not json'), { filename: null, mimetype: null, partialurl: null });
  assert.deepEqual(parseContentEnvelope(null), { filename: null, mimetype: null, partialurl: null });
});

// ── readSourceFileContent: env bytes come from filecontent/$value ──────────────
test('readSourceFileContent: reads bytes from powerpagessourcefiles(<id>)/filecontent/$value and classifies text', async () => {
  const capture = {};
  const bytes = Buffer.from('export const x = 1;\nexport const y = 2;\n', 'utf8');
  const res = await readSourceFileContent({
    envUrl: BASE,
    componentId: ID,
    token: 'tok',
    _deps: makeDeps({
      metaRow: { powerpagessourcefileid: ID, name: 'Home.tsx', content: JSON.stringify({ filename: 'Home.tsx', mimetype: 'text/plain', partialurl: 'src/pages/Home.tsx' }) },
      fileBuffer: bytes,
      capture,
    }),
  });
  assert.equal(res.error, undefined);
  assert.equal(res.id, ID);
  assert.equal(res.name, 'Home.tsx');
  assert.equal(res.partialurl, 'src/pages/Home.tsx');
  assert.equal(res.mergeStrategy, 'text');
  assert.equal(res.type, 'sourcefile');
  assert.equal(res.isText, true);
  assert.ok(Buffer.isBuffer(res.bytes));
  assert.equal(res.bytes.toString('utf8'), bytes.toString('utf8'));
  // The bytes endpoint is the filecontent/$value File-column route (NOT the content envelope).
  assert.equal(capture.fileUrl, `${BASE}/api/data/v9.2/${ENTITY_SET}(${ID})/${DEFAULT_FILE_COLUMN}/$value`);
  // The record key is the powerpagessourcefileid (== conflict componentId).
  assert.match(capture.metaUrl, new RegExp(`${ENTITY_SET}\\(${ID}\\)`));
});

test('readSourceFileContent: derives name from content.filename when name column absent', async () => {
  const res = await readSourceFileContent({
    envUrl: BASE, componentId: ID, token: 'tok',
    _deps: makeDeps({
      metaRow: { powerpagessourcefileid: ID, content: JSON.stringify({ filename: 'App.css', partialurl: 'src/App.css' }) },
      fileBuffer: Buffer.from('.a{color:red}\n', 'utf8'),
    }),
  });
  assert.equal(res.name, 'App.css');
  assert.equal(res.partialurl, 'src/App.css');
});

test('readSourceFileContent: 404 metadata → not-found error (wrong powerpagessourcefileid)', async () => {
  const res = await readSourceFileContent({
    envUrl: BASE, componentId: ID, token: 'tok',
    _deps: makeDeps({ metaStatus: 404 }),
  });
  assert.match(res.error, /not found/i);
  assert.equal(res.statusCode, 404);
});

test('readSourceFileContent: filecontent fetch error is surfaced', async () => {
  const res = await readSourceFileContent({
    envUrl: BASE, componentId: ID, token: 'tok',
    _deps: makeDeps({
      metaRow: { powerpagessourcefileid: ID, name: 'Home.tsx', content: '{}' },
      fileError: 'filecontent/$value returned HTTP 500', fileStatus: 500,
    }),
  });
  assert.match(res.error, /filecontent/);
  assert.equal(res.statusCode, 500);
});

test('readSourceFileContent: binary bytes sniff isText:false (fail-closed)', async () => {
  const res = await readSourceFileContent({
    envUrl: BASE, componentId: ID, token: 'tok',
    _deps: makeDeps({
      metaRow: { powerpagessourcefileid: ID, name: 'logo.png', content: '{}' },
      fileBuffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]), // NUL byte → binary
    }),
  });
  assert.equal(res.isText, false);
  assert.equal(res.mergeStrategy, 'text'); // strategy is by type; routing sniff is separate
});

test('readSourceFileContent: missing componentId → clear error', async () => {
  const res = await readSourceFileContent({ envUrl: BASE, token: 'tok', _deps: makeDeps({}) });
  assert.match(res.error, /componentId/);
});

// ── Bug 13: metadata-query guardrails (no live calls) ─────────────────────────
test('buildAttributeMetadataUrl: uses exact eq, never contains() (501 guard)', () => {
  const url = buildAttributeMetadataUrl({ base: BASE, entityLogicalName: 'powerpagessourcefile', attributeLogicalName: 'filecontent' });
  assert.doesNotMatch(url, /contains\(/i);
  assert.match(decodeURIComponent(url), /LogicalName eq 'powerpagessourcefile'/);
  assert.match(decodeURIComponent(url), /LogicalName eq 'filecontent'/);
  // base type query must NOT select MaxLength
  assert.doesNotMatch(url, /MaxLength/);
});

test('buildAttributeMetadataUrl: MaxLength only via typed cast (400 guard)', () => {
  const url = buildAttributeMetadataUrl({ base: BASE, entityLogicalName: 'powerpagessourcefile', attributeLogicalName: 'name', includeMaxLength: true });
  assert.doesNotMatch(url, /contains\(/i);
  // MaxLength must appear ONLY under the typed cast, never on the base AttributeMetadata type.
  assert.match(url, /Microsoft\.Dynamics\.CRM\.StringAttributeMetadata/);
  assert.match(decodeURIComponent(url), /Microsoft\.Dynamics\.CRM\.StringAttributeMetadata\([^)]*MaxLength/);
});

test('buildAttributeMetadataUrl: trims trailing slash on base', () => {
  const url = buildAttributeMetadataUrl({ base: `${BASE}/`, entityLogicalName: 'powerpagessourcefile' });
  assert.match(url, new RegExp(`^${BASE.replace(/[.]/g, '\\.')}/api/data/v9\\.2/EntityDefinitions`));
});
