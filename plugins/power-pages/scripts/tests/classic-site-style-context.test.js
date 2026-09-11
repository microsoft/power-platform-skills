const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, ids } = require('./style-site-fixtures');
const { inspectSite, safePath, assertOutsideSite, parseArgs } = require('../lib/classic-site-style-context');
const { main } = require('../../skills/style-site/scripts/inspect-style-context');

for (const options of [{ major: 3 }, { major: 5, prefix: '', nested: true, wrapped: true }]) {
  test(`discovers classic assets and localization (${JSON.stringify(options)})`, (t) => {
    const f = fixture(t, options);
    const context = main(['--siteRoot', f.project]);
    assert.equal(context.siteId, ids.site);
    assert.equal(context.homePageId, ids.home);
    assert.equal(context.bootstrap.major, options.major);
    assert.equal(context.pages.find((page) => page.id === ids.locale).cssPath, f.cssPath);
    assert.ok(context.webFiles.every((file) => file.assetPresent));
    assert.equal(context.webFiles.find((file) => file.id === f.assets['custom.css'].id).isDefault, false);
  });
}

test('does not infer Bootstrap when assets lack version evidence or conflict with settings', (t) => {
  const f = fixture(t);
  f.put('sitesetting.yml', '- adx_name: Site/BootstrapV5Enabled\n  adx_value: true\n');
  assert.equal(inspectSite(f.root).bootstrap.major, null);
  fs.unlinkSync(path.join(f.root, 'sitesetting.yml'));
  f.put(f.assets['bootstrap.min.css'].path, '.btn { color: red; }');
  assert.equal(inspectSite(f.root).bootstrap.major, null);
});

test('conflicting minor versions remain unresolved even when the Bootstrap major agrees', (t) => {
  const f = fixture(t, { major: 5 });
  f.put('web-files/bootstrap.css.webfile.yml', f.yml('webfile', {
    id: '88888888-8888-4888-8888-888888888888', name: 'bootstrap.css',
    partialurl: 'bootstrap.css', parentpageid: ids.home, displayorder: 0,
  }) + 'filename: bootstrap.css\nmimetype: text/css\n');
  f.put('web-files/bootstrap.css', '/*! Bootstrap v5.3.3 */');
  assert.equal(inspectSite(f.root).bootstrap.major, null);
});

test('rejects code sites, ambiguous root relationships and malformed metadata', (t) => {
  const f = fixture(t);
  f.put('powerpages.config.json', '{}');
  assert.throws(() => inspectSite(f.root), /Code\/SPA/);
  fs.unlinkSync(path.join(f.root, 'powerpages.config.json'));
  f.put('web-pages/second/Second.webpage.yml', f.yml('webpage', { id: ids.state, partialurl: '/' }));
  assert.throws(() => inspectSite(f.root), /exactly one site root/);
  fs.unlinkSync(path.join(f.root, 'web-pages/second/Second.webpage.yml'));
  f.put('web-pages/broken/Broken.webpage.yml', 'invalid');
  assert.throws(() => inspectSite(f.root), /Invalid YAML/);
});

test('refuses Windows/POSIX traversal and outputs in the upload tree', (t) => {
  const f = fixture(t);
  for (const unsafe of ['../outside.css', '..\\outside.css', '/root.css', 'C:\\root.css', 'file.css:stream', 'a/../b.css']) {
    assert.throws(() => safePath(f.root, unsafe), /path|Path/i);
  }
  assert.throws(() => assertOutsideSite(f.root, path.join(f.root, 'preview.html')), /outside/);
  assert.equal(assertOutsideSite(f.root, path.join(f.work, 'preview.html')), path.join(f.work, 'preview.html'));
});

test('CLI argument parsing rejects unknown, duplicate, or missing values', () => {
  assert.throws(() => parseArgs(['--siteRoot'], ['siteRoot']), /Missing/);
  assert.throws(() => parseArgs(['--siteRoot', 'a', '--siteRoot', 'b'], ['siteRoot']), /duplicate/);
  assert.throws(() => parseArgs(['--upload'], ['siteRoot']), /Unknown/);
});

test('refuses linked site assets', (t) => {
  const f = fixture(t);
  const link = path.join(f.root, 'web-files', 'linked.css');
  try { fs.symlinkSync(path.join(f.work, 'missing.css'), link); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Symlink privilege unavailable'); throw error; }
  assert.throws(() => inspectSite(f.root), /Symlink/);
  assert.throws(() => safePath(f.root, 'web-files/linked.css'), /Symlinks/);
});

test('preserves UTF-8 bytes by refusing legacy encodings instead of replacing characters', (t) => {
  const f = fixture(t);
  f.put(f.cssPath, Buffer.from([0xff, 0xfe, 0x61, 0x00]));
  assert.throws(() => inspectSite(f.root), /encoding/);
});
