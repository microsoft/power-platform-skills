const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeReaddir } = require('../../skills/migrate-datamodel/scripts/snapshot-site');
const script = path.join(__dirname, '../../skills/migrate-datamodel/scripts/snapshot-site.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const site = path.join(root, 'site');
  const output = path.join(root, 'reports');
  fs.mkdirSync(site);
  function write(relative, text) {
    const file = path.join(site, ...relative.split(/[\\/]/));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  function run() {
    const result = spawnSync(process.execPath, [script, '--site-root', site,
      '--output-dir', output, '--label', 'sdm', '--with-content-hash'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(fs.readFileSync(path.join(output, 'sdm-snapshot.json'), 'utf8'));
  }
  return { write, run };
}

test('missing optional snapshot directories remain empty', (t) => {
  t.mock.method(fs, 'readdirSync', () => {
    throw Object.assign(new Error('missing directory'), { code: 'ENOENT' });
  });
  assert.deepEqual(safeReaddir('missing'), []);
});

test('unreadable snapshot directories report errors rather than empty inventories', (t) => {
  t.mock.method(fs, 'readdirSync', () => {
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  });
  assert.throws(() => safeReaddir('restricted'), /Could not read snapshot directory restricted: permission denied/);
});

test('nested configuration and both setting layouts are captured with content hashes', (t) => {
    const { write, run } = fixture(t);
    write('.powerpages-site\\website.yml', 'adx_name: Contoso');
    write('.powerpages-site\\sitesetting.yml', '- adx_name: Aggregate\n  adx_value: "true"');
    write('.powerpages-site\\site-settings\\Individual.sitesetting.yml', 'adx_name: Individual\nadx_value: "false"');
    write('.powerpages-site\\web-templates\\header\\Header.webtemplate.yml', 'adx_name: Header');
    write('.powerpages-site\\web-templates\\header\\Header.webtemplate.source.html', '<header>Before</header>');
    const before = run();
    assert.equal(before.counts.siteSettings, 2);
    assert.deepEqual(before.inventory.siteSettings.map((record) => record.value), ['true', 'false']);
    assert.equal(before.counts.webTemplates, 1);
    assert.match(before.inventory.webTemplates[0].contentHash, /^[a-f0-9]{16}$/);
    write('.powerpages-site\\web-templates\\header\\Header.webtemplate.source.html', '<header>After</header>');
    assert.notEqual(run().inventory.webTemplates[0].contentHash, before.inventory.webTemplates[0].contentHash);
  });

test('malformed aggregate fields are reported instead of silently dropped', (t) => {
    const { write, run } = fixture(t);
    write('sitesetting.yml', '- adx_name: Example\n  malformed field without a colon');
    const snapshot = run();
    assert.equal(snapshot.counts.siteSettings, 0);
    assert.match(snapshot.parseErrors.siteSettings[0].message, /Invalid YAML line/);
  });

test('navigation retains inactive links, target, order and state while counting active links', (t) => {
    const { write, run } = fixture(t);
    write('weblink-sets\\main\\Main.en-US.weblinkset.yml', 'adx_name: Main');
    write('weblink-sets\\main\\Main.en-US.weblinkset.weblink.yml',
      '- adx_name: Home\n  adx_displayorder: 2\n  adx_pageid: page-id\n  statecode: 0\n' +
      '- adx_name: Hidden\n  adx_displayorder: 1\n  adx_externalurl: https://contoso.com\n  statecode: 1');
    const snapshot = run();
    assert.equal(snapshot.counts.webLinks, 2);
    assert.equal(snapshot.inventory.webLinkSets[0].linkCount, 1);
    assert.deepEqual(snapshot.inventory.webLinkSets[0].linkNames, ['Home']);
    const hidden = snapshot.inventory.webLinks.find((link) => link.name === 'Hidden');
    assert.equal(hidden.stateCode, 1);
    assert.equal(hidden.displayOrder, 1);
    assert.equal(hidden.externalUrl, 'https://contoso.com');
    assert.equal(snapshot.inventory.webLinks.find((link) => link.name === 'Home').pageId, 'page-id');
  });
