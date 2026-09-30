'use strict';
// lib/deployed-baseline.js: the last-applied/downloaded spec is a sitemap baseline ONLY for the app and
// environment it describes (AB#6726727).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { baselinePath, confinedReader, writeBaseline, readBaseline } = require('../lib/deployed-baseline.js');

const ENV = 'https://contoso.crm.dynamics.com';
const spec = () => ({ solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A', uniqueName: 'new_a' }, pages: [{ key: 'home', name: 'Home', source: { kind: 'tsx', codeFile: 'pages/home.tsx' } }] });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-'));

test('a baseline is returned only for the app and environment it was written for', () => {
  const dir = tmp();
  try {
    const ws = path.join(dir, '.maker-workspace');
    fs.mkdirSync(path.join(dir, 'pages'));
    fs.writeFileSync(path.join(dir, 'pages', 'home.tsx'), 'export default () => null;');
    writeBaseline(ws, spec(), { appDir: dir, environment: ENV, appUniqueName: 'new_a' });
    const got = readBaseline(ws, { environment: ENV, appUniqueName: 'NEW_A' });
    assert.ok(got, 'same app (unique names are case-insensitive) and environment');
    assert.strictEqual(got.app.uniqueName, 'new_a');
    assert.match(got.pages[0].__contentSha, /^[0-9a-f]{64}$/, 'annotated like a build-written snapshot, so the dry-run diff does not over-report');
    assert.strictEqual(readBaseline(ws, { environment: 'https://fabrikam.crm.dynamics.com', appUniqueName: 'new_a' }), null, 'another environment');
    assert.strictEqual(readBaseline(ws, { environment: ENV, appUniqueName: 'new_b' }), null, 'another app');
    assert.strictEqual(readBaseline(ws, { environment: null, appUniqueName: 'new_a' }), null, 'an environment that could not be identified');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a snapshot with no stamps, or one that cannot be read, is not a baseline', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(baselinePath(dir), JSON.stringify(spec()));
    assert.strictEqual(readBaseline(dir, { environment: ENV, appUniqueName: 'new_a' }), null, 'written before the stamps existed');
    fs.writeFileSync(baselinePath(dir), '{ not json');
    assert.strictEqual(readBaseline(dir, { environment: ENV, appUniqueName: 'new_a' }), null);
    fs.writeFileSync(baselinePath(dir), '[]');
    assert.strictEqual(readBaseline(dir, { environment: ENV, appUniqueName: 'new_a' }), null);
    assert.strictEqual(readBaseline(path.join(dir, 'missing'), { environment: ENV, appUniqueName: 'new_a' }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the content reader stays inside the app folder', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'in.txt'), 'x');
    const read = confinedReader(dir);
    assert.strictEqual(String(read('in.txt')), 'x');
    assert.strictEqual(read('../outside.txt'), null);
    assert.strictEqual(read(path.resolve(dir, '..', 'x.txt')), null);
    assert.strictEqual(read('missing.txt'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
