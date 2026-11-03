'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { main, compareMetadata, writeReport, verifyReport, resolveMetadataRoot, tools } = require('../compare-site-metadata');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'site-metadata-comparison-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'first site');
  const target = path.join(root, 'second site');
  for (const dir of [source, target]) write(dir, 'website.yml', 'id: 00000000-0000-0000-0000-000000000001\nname: Example\n');
  return { root, source, target };
}

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('uses upstream local-versus-remote statuses and excludes hidden metadata', t => {
  const { source, target } = fixture(t);
  write(source, 'web-pages/home.html', 'local page');
  write(target, 'web-pages/home.html', 'remote page');
  write(source, 'content-snippets/local.yml', 'local snippet');
  write(target, 'site-settings/remote.yml', 'remote setting');
  write(source, '.portalconfig/local.yml', 'hidden local');
  write(target, '.portalconfig/local.yml', 'hidden remote');
  const result = compareMetadata(source, target);
  assert.deepEqual(result.files, tools.compareFiles(target, source));
  assert.deepEqual(result.counts, { added: 1, modified: 1, deleted: 1 });
  assert.equal(result.files.find(file => file.relativePath === path.join('content-snippets', 'local.yml')).status, 'added');
  assert.equal(result.files.find(file => file.relativePath === path.join('site-settings', 'remote.yml')).status, 'deleted');
  assert.equal(tools.getComponentTypeFromPath('site-languages/en-US.yml'), 'website-languages');
});

test('inherits upstream text normalization and binary extension rules, including SVG display', async t => {
  const { source, target } = fixture(t);
  write(source, 'web-pages/text.html', 'hello\r\nworld\rnext\n');
  write(target, 'web-pages/text.html', 'hello\nworld\nnext\n');
  write(source, 'web-files/text.svg', '<text>local</text>\r\n');
  write(target, 'web-files/text.svg', '<text>remote</text>\n');
  write(source, 'web-files/image.png', Buffer.from('fake image\r\n'));
  write(target, 'web-files/image.png', Buffer.from('fake image\n'));
  const result = compareMetadata(source, target);
  assert.equal(result.counts.modified, 2);
  assert.equal(result.files.some(file => file.relativePath.includes('text.html')), false);
  const content = await tools.readFileContents(result.files);
  assert.equal(content.every(file => file.isBinary), true);
});

test('uses upstream case-insensitive path matching and preserves whitespace and ID changes', t => {
  const { source, target } = fixture(t);
  write(source, 'web-pages/HOME.HTML', 'same');
  write(target, 'web-pages/home.html', 'same');
  assert.deepEqual(compareMetadata(source, target).files, []);
  write(source, 'web-pages/HOME.HTML', 'same ');
  write(target, 'website.yml', 'id: 00000000-0000-0000-0000-000000000002\n');
  assert.equal(compareMetadata(source, target).counts.modified, 2);
});

test('two SPA sites compare only .powerpages-site metadata, never application source', t => {
  const { root, source } = fixture(t);
  const local = path.join(root, 'local code');
  const remote = path.join(root, 'remote code');
  for (const dir of [local, remote]) {
    write(dir, '.powerpages-site/website.yml', fs.readFileSync(path.join(source, 'website.yml')));
    write(dir, 'powerpages.config.json', '{"sourceExcludePatterns":["private/**"]}');
  }
  write(local, '.gitignore', 'ignored/**\n');
  write(local, 'ignored/file.js', 'ignored');
  write(local, 'private/secret.js', 'excluded by sourceExcludePatterns');
  write(local, 'node_modules/dependency/index.js', 'ignored dependency');
  write(local, 'src/main.js', 'local source');
  write(remote, 'src/main.js', 'remote source');
  write(remote, 'dist/index.js', 'build output');
  write(local, '.powerpages-site/web-pages/home.html', 'local page');
  write(remote, '.powerpages-site/web-pages/home.html', 'remote page');
  write(remote, '.powerpages-site/site-settings/remote.yml', 'remote setting');
  const result = compareMetadata(local, remote);
  // The extension would also diff src/ and .gitignore here because the second
  // folder contains source; the skill keeps to site metadata.
  assert.deepEqual(result.files.map(file => [file.relativePath, file.status]).sort(), [
    ['.powerpages-site/site-settings/remote.yml', 'deleted'],
    ['.powerpages-site/web-pages/home.html', 'modified'],
  ]);
});

test('metadata-only remote code sites omit local source exactly as the extension does', t => {
  const { root, source } = fixture(t);
  const local = path.join(root, 'local code');
  const remote = path.join(root, 'remote code');
  for (const dir of [local, remote]) write(dir, '.powerpages-site/website.yml', fs.readFileSync(path.join(source, 'website.yml')));
  write(local, 'powerpages.config.json', '{}');
  write(local, 'src/main.js', 'local-only application source');
  assert.deepEqual(compareMetadata(local, remote, { targetCodeSite: true }).files, []);
});

test('mixed code and non-code comparisons compare metadata only in either direction', t => {
  const { root, source, target } = fixture(t);
  const code = path.join(root, 'code');
  write(code, '.powerpages-site/website.yml', fs.readFileSync(path.join(source, 'website.yml')));
  write(code, 'powerpages.config.json', '{}');
  write(code, 'src/main.js', 'not included');
  assert.deepEqual(compareMetadata(code, target).files, []);
  assert.deepEqual(compareMetadata(source, code).files, []);
});

test('rejects missing, empty and ambiguous site roots instead of comparing an empty download', t => {
  const { root, source, target } = fixture(t);
  assert.throws(() => compareMetadata(path.join(root, 'missing'), target), /ENOENT/);
  write(source, 'website.yml', ' \n');
  assert.throws(() => compareMetadata(source, target), /nonempty/);
  write(target, '.powerpages-site/website.yml', 'id: ambiguous');
  assert.throws(() => resolveMetadataRoot(target), /Select one site/);
});

test('writes the original HTML, with English component tabs, inline diffs and an external verification receipt', async t => {
  const { root, source, target } = fixture(t);
  const hostile = '</script><img src=x onerror=alert(1)>';
  write(source, 'web-pages/home.html', 'first\nlocal line\nlast\n');
  write(target, 'web-pages/home.html', 'first\nremote line\nlast\n');
  write(source, 'content-snippets/local.yml', hostile);
  write(target, 'website.yml', 'adx_websiteid: 00000000-0000-0000-0000-000000000002\nadx_name: Example\n');
  const comparison = compareMetadata(source, target, {
    sourceName: 'Local site', targetName: 'Remote site',
    targetEnvironment: 'https://contoso.crm.dynamics.com',
  });
  const output = await writeReport(comparison, path.join(root, 'report.html'));
  const html = fs.readFileSync(output, 'utf8');
  assert.match(html, /<title>Site Comparison Report - Remote site<\/title>/);
  assert.match(html, /Added Locally/);
  assert.match(html, /Deleted Locally/);
  assert.match(html, /data-tab="web-pages">Web Pages \(1\)/);
  assert.match(html, /data-tab="site-settings">Site Settings \(0\)/);
  assert.match(html, /diff-deleted[^]*?- remote line/);
  assert.match(html, /diff-added[^]*?\+ local line/);
  assert.match(html, /&lt;\/script&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!html.includes(hostile));
  assert.ok(!html.includes('comparison-data'));
  assert.ok(!html.includes('--cp-'));
  // The data model is unknown for local folders, so the report omits that field.
  assert.ok(!html.includes('Data Model'));
  const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../.plugin/plugin.json'), 'utf8'));
  assert.match(html, /Power Pages AI Plugin - Power Platform Skills/);
  assert.match(html, new RegExp(`Plugin Version:</strong></span>\\s*<span>${version.replace(/\./g, '\\.')}</span>`));
  assert.ok(!html.includes('Extension Version'));
  // Each column shows its own site's ID, read from website.yml (id or adx_websiteid).
  const idCell = id => `Website ID:</span>\\s*<span class="info-value">${id}</span>`;
  assert.match(html, new RegExp(`<h3>Local</h3>[^]*?${idCell('00000000-0000-0000-0000-000000000001')}[^]*?<h3>Remote</h3>[^]*?${idCell('00000000-0000-0000-0000-000000000002')}`));
  assert.match(html, /Environment:<\/span>\s*<span class="info-value">https:\/\/contoso\.crm\.dynamics\.com</);
  // A local second site has no environment, so the row is hidden rather than showing a folder path.
  const local = await writeReport(compareMetadata(source, target), path.join(root, 'local-report.html'));
  assert.ok(!fs.readFileSync(local, 'utf8').includes('Environment:'));
  assert.ok(fs.existsSync(`${output}.json`));
  assert.equal(verifyReport(source, target, output).added, 1);
});

test('upstream report applies its exact 5 MiB and 20,000-line display limits', async t => {
  const { source, target } = fixture(t);
  write(source, 'large.txt', 'x'.repeat(5 * 1024 * 1024 + 1));
  write(target, 'large.txt', 'remote');
  write(source, 'boundary.txt', 'x'.repeat(5 * 1024 * 1024));
  write(source, 'many-lines.txt', 'local\n'.repeat(20001));
  write(target, 'many-lines.txt', 'remote\n'.repeat(20001));
  const comparison = compareMetadata(source, target);
  const contents = await tools.readFileContents(comparison.files);
  assert.equal(contents.find(file => file.result.relativePath === 'large.txt').isTooLarge, true);
  assert.equal(contents.find(file => file.result.relativePath === 'boundary.txt').isTooLarge, false);
  const html = tools.generateHtmlContent(contents.filter(file => file.result.relativePath !== 'boundary.txt'), 'Local', 'Remote', 'Example', '');
  assert.match(html, /File is too large to display diff \(exceeds 5MB\)/);
  assert.match(html, /File is too large for detailed diff comparison/);
});

test('output must be new HTML outside both complete site projects', async t => {
  const { root, source, target } = fixture(t);
  const comparison = compareMetadata(source, target);
  await assert.rejects(writeReport(comparison, path.join(source, 'report.html')), /outside/);
  await assert.rejects(writeReport(comparison, path.join(target, 'report.html')), /outside/);
  await assert.rejects(writeReport(comparison, path.join(root, 'report.txt')), /\.html/);
  const output = path.join(root, 'report.html');
  await writeReport(comparison, output);
  await assert.rejects(writeReport(comparison, output), /already exists/);
  const code = path.join(root, 'code');
  write(code, '.powerpages-site/website.yml', fs.readFileSync(path.join(source, 'website.yml')));
  write(code, 'powerpages.config.json', '{}');
  await assert.rejects(writeReport(compareMetadata(code, target), path.join(code, 'report.html')), /outside/);
});

test('CLI reports counts and opens an encoded file URL without modifying either site', async t => {
  const { root, source, target } = fixture(t);
  const before = fs.readFileSync(path.join(source, 'website.yml'));
  const output = path.join(root, 'report & comparison.html');
  let opened;
  const result = await main(['--source', source, '--target', target, '--output', output, '--open', 'true'], {
    openInDefaultBrowser(url) { opened = url; },
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual([result.added, result.modified, result.deleted], [0, 0, 0]);
  assert.equal(opened, pathToFileURL(output).href);
  assert.deepEqual(fs.readFileSync(path.join(source, 'website.yml')), before);
  assert.deepEqual(fs.readFileSync(path.join(target, 'website.yml')), before);
  assert.equal(fs.readdirSync(source).length, 1);
});

test('browser failure is explicit while the report stays available', async t => {
  const { root, source, target } = fixture(t);
  const output = path.join(root, 'report.html');
  await assert.rejects(main(['--source', source, '--target', target, '--output', output, '--open', 'true'], {
    openInDefaultBrowser() { throw new Error('headless'); },
  }), /Report saved.*headless/);
  assert.ok(fs.statSync(output).size > 0);
});

test('downloaded snapshot identities must match the explicitly selected website record IDs', async t => {
  const { root, source, target } = fixture(t);
  const output = path.join(root, 'report.html');
  const id = '00000000-0000-0000-0000-000000000001';
  const argv = ['--source', source, '--target', target, '--output', output, '--sourceWebsiteId', id, '--targetWebsiteId', id];
  write(target, 'website.yml', 'adx_websiteid: 00000000-0000-0000-0000-000000000002\n');
  await assert.rejects(main(argv), /target website.yml identity/);
  assert.ok(!fs.existsSync(output));
  write(target, 'website.yml', `id: ${id}\nadx_websiteid: 00000000-0000-0000-0000-000000000002\n`);
  await assert.rejects(main(argv), /target website.yml identity/);
  write(target, 'website.yml', `adx_websiteid: '${id}' # PAC alias\n`);
  assert.equal((await main(argv)).status, 'ok');
  const receipt = JSON.parse(fs.readFileSync(`${output}.json`, 'utf8'));
  assert.equal(receipt.sourceWebsiteId, id);
  assert.equal(receipt.targetWebsiteId, id);
});

test('verification detects HTML changes, wrong roots, and inconsistent sidecar counts', async t => {
  const { root, source, target } = fixture(t);
  write(source, 'added.txt', 'local');
  const output = path.join(root, 'report.html');
  await writeReport(compareMetadata(source, target), output);
  assert.throws(() => verifyReport(target, source, output), /does not match/);
  const original = fs.readFileSync(output);
  fs.appendFileSync(output, '<p>changed</p>');
  assert.throws(() => verifyReport(source, target, output), /verification receipt/);
  fs.writeFileSync(output, original);
  const sidecar = fs.readFileSync(`${output}.json`, 'utf8');
  fs.writeFileSync(`${output}.json`, sidecar.replace('"added": 1', '"added": 2'));
  assert.throws(() => verifyReport(source, target, output), /inconsistent added/);
  fs.writeFileSync(`${output}.json`, sidecar);
  assert.equal((await main(['--source', source, '--target', target, '--output', output, '--verify', 'true'])).added, 1);
  assert.deepEqual(fs.readFileSync(output), original);
});

test('CLI rejects invalid arguments and fails nonzero instead of producing partial reports', async t => {
  const { root, source, target } = fixture(t);
  const base = ['--source', source, '--target', target, '--output', path.join(root, 'invalid.html')];
  for (const argv of [[], ['--open', 'yes'], ['--unknown', 'value'], ['--source', 'a', '--source', 'b'],
    [...base, '--targetUrl', 'javascript:alert(1)'], [...base, '--targetModel', 'Standard'],
    [...base, '--targetCodeSite', 'maybe']]) {
    await assert.rejects(main(argv));
  }
  const output = path.join(root, 'failed.html');
  const child = spawnSync(process.execPath, [path.join(__dirname, '../compare-site-metadata.js'),
    '--source', path.join(root, 'missing'), '--target', target, '--output', output], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /ENOENT/);
  assert.ok(!fs.existsSync(output));
});

test('rejects upstream read failures without writing HTML', async t => {
  const { root, source, target } = fixture(t);
  const output = path.join(root, 'report.html');
  write(source, 'local.txt', 'local content');
  const comparison = compareMetadata(source, target);
  t.mock.method(tools, 'readFileContents', async files => files.map(result => ({
    result, localContent: null, remoteContent: null, isBinary: false, isTooLarge: false,
  })));
  await assert.rejects(writeReport(comparison, output), /Could not read comparison content/);
  assert.ok(!fs.existsSync(output));
});
