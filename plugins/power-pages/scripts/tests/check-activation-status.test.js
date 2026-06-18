'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveSiteIdentity } = require('../check-activation-status');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'check-activation-test-'));
}
const GUID = '11111111-2222-3333-4444-555555555555';
// Fails the test if invoked — used to assert pac pages list is NOT shelled out.
const throwExec = () => { throw new Error('pac pages list must NOT be called'); };

test('EDM site: resolves identity from .powerpages-site/website.yml and SKIPS pac pages list', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.powerpages-site'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.powerpages-site', 'website.yml'), `id: ${GUID}\nname: ContosoEDM\n`);

  const r = resolveSiteIdentity(dir, { execSync: throwExec });
  assert.equal(r.error, undefined);
  assert.equal(r.siteName, 'ContosoEDM');
  assert.equal(r.websiteRecordId, GUID);
  assert.equal(r.source, 'website.yml');
  assert.equal(r.usedPacList, false, 'EDM site must NOT shell out to pac pages list');
});

test('EDM website.yml with an inline comment is parsed cleanly (comment stripped)', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.powerpages-site'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.powerpages-site', 'website.yml'), `id: ${GUID}  # site guid\nname: ContosoEDM\n`);

  const r = resolveSiteIdentity(dir, { execSync: throwExec });
  assert.equal(r.websiteRecordId, GUID, 'inline comment must not corrupt the GUID');
});

test('code site with websiteRecordId in config: resolves from config, skips pac pages list', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'powerpages.config.json'), JSON.stringify({ siteName: 'ContosoSPA', websiteRecordId: GUID }));

  const r = resolveSiteIdentity(dir, { execSync: throwExec });
  assert.equal(r.siteName, 'ContosoSPA');
  assert.equal(r.websiteRecordId, GUID);
  assert.equal(r.source, 'config');
  assert.equal(r.usedPacList, false);
});

test('code site WITHOUT websiteRecordId: falls back to pac pages list to find the GUID', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'powerpages.config.json'), JSON.stringify({ siteName: 'ContosoSPA' }));

  const fakePac = () => `Website Name        Website Record ID\n----------  ----------\nContosoSPA   ${GUID}\n`;
  const r = resolveSiteIdentity(dir, { execSync: fakePac });
  assert.equal(r.siteName, 'ContosoSPA');
  assert.equal(r.websiteRecordId, GUID);
  assert.equal(r.usedPacList, true, 'code site without a GUID must consult pac pages list');
});

test('neither marker present: returns a "Site name not found" error (no crash)', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = resolveSiteIdentity(dir, { execSync: throwExec });
  assert.match(r.error, /Site name not found/);
  assert.match(r.error, /website\.yml/);
});

test('malformed powerpages.config.json: returns a parse error (does not throw)', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'powerpages.config.json'), '{not valid json,,,');
  const r = resolveSiteIdentity(dir, { execSync: throwExec });
  assert.match(r.error, /Failed to parse/);
});

test('pac pages list failure is non-fatal: identity returns with null websiteRecordId', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'powerpages.config.json'), JSON.stringify({ siteName: 'ContosoSPA' }));
  const r = resolveSiteIdentity(dir, { execSync: () => { throw new Error('pac not installed'); } });
  assert.equal(r.siteName, 'ContosoSPA');
  assert.equal(r.websiteRecordId, null);
  assert.equal(r.usedPacList, true);
});
