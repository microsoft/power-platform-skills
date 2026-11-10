'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { main, compareMetadata, writeReport, verifyReport, resolveMetadataRoot, tools } = require('../compare-site-configurations');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'site-configuration-comparison-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'first site');
  const target = path.join(root, 'second site');
  for (const dir of [source, target]) write(dir, 'website.yml', 'id: 00000000-0000-0000-0000-000000000001\nname: Example\n');
  return { root, source, target };
}

const receipt = output => output.replace(/\.html$/, '.receipt.json');

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

test('two SPA sites compare only .powerpages-site metadata, never application source', async t => {
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
  const output = path.join(root, 'spa-report.html');
  await writeReport(result, output);
  assert.equal(verifyReport(local, remote, output).modified, 1);
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

test('compares only Power Pages configuration and reports skipped differences by top-level folder', async t => {
  const { root, source, target } = fixture(t);
  write(source, 'web-pages/home/Home.webpage.yml', 'title: Local');
  write(target, 'web-pages/home/Home.webpage.yml', 'title: Remote');
  write(source, 'sitesetting.yml', '- adx_name: Search/Enabled\n  adx_value: true\n');
  write(target, 'sitesetting.yml', '- adx_name: Search/Enabled\n  adx_value: false\n');
  write(target, 'botconsumer.yml', '- adx_name: Bot Consumer\n');
  // Files other tools leave in a downloaded site folder never reach the site.
  write(source, 'docs/edit-site/current-plan.json', '{}');
  write(source, 'docs/edit-site/history/2026-11-05/plan.html', '<p>plan</p>');
  write(source, 'README.md', '# notes');
  write(target, 'unknown-folder/settings.yml', 'x: 1');
  const result = compareMetadata(source, target);
  assert.deepEqual(result.files.map(file => [file.relativePath, file.status]).sort(), [
    ['botconsumer.yml', 'deleted'],
    ['sitesetting.yml', 'modified'],
    [path.join('web-pages', 'home', 'Home.webpage.yml'), 'modified'],
  ]);
  assert.deepEqual(result.counts, { added: 0, modified: 2, deleted: 1 });
  assert.deepEqual(result.skipped, [
    { path: 'README.md', files: 1 }, { path: 'docs/', files: 2 }, { path: 'unknown-folder/', files: 1 },
  ]);
  const output = path.join(root, 'report.html');
  const cli = await main(['--source', source, '--target', target, '--output', output]);
  assert.deepEqual(cli.skipped, result.skipped);
  assert.ok(!fs.readFileSync(output, 'utf8').includes('current-plan.json'));

  const spa = path.join(root, 'spa');
  write(spa, '.powerpages-site/website.yml', fs.readFileSync(path.join(source, 'website.yml')));
  write(spa, '.powerpages-site/docs/notes.md', 'notes');
  write(spa, 'powerpages.config.json', '{}');
  const spaRemote = path.join(root, 'spa remote');
  write(spaRemote, '.powerpages-site/website.yml', fs.readFileSync(path.join(source, 'website.yml')));
  const spaResult = compareMetadata(spa, spaRemote, { targetCodeSite: true });
  assert.deepEqual(spaResult.files, []);
  assert.deepEqual(spaResult.skipped, [{ path: '.powerpages-site/docs/', files: 1 }]);
});

test('writes a JSON export in the format VS Code imports with Import Comparison', async t => {
  const { root, source, target } = fixture(t);
  write(target, 'website.yml', 'id: 00000000-0000-0000-0000-000000000002\n');
  write(source, 'web-pages/home.html', 'local\r\n');
  write(target, 'web-pages/home.html', 'remote\n');
  write(source, 'content-snippets/added.yml', 'added');
  write(target, 'site-settings/deleted.yml', 'deleted');
  write(source, 'web-files/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
  write(target, 'web-files/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 2]));
  write(source, 'web-files/icon.svg', '<svg>local</svg>');
  write(target, 'web-files/icon.svg', '<svg>remote</svg>');
  const output = path.join(root, 'report.html');
  const result = await main(['--source', source, '--target', target, '--output', output,
    '--targetEnvironment', 'https://contoso.crm.dynamics.com', '--targetEnvironmentId', '11111111-2222-3333-4444-555555555555',
    '--targetUrl', 'https://contoso.powerappsportals.com', '--sourceName', 'Dev', '--targetName', 'Test']);
  assert.equal(result.export, path.join(root, 'report.json'));
  const data = JSON.parse(fs.readFileSync(result.export, 'utf8'));
  assert.equal(data.version, '1.0');
  // Import rejects files from a newer extension; 2.0.115 is the first release that imports this format.
  assert.equal(data.extensionVersion, '2.0.115');
  assert.ok(!Number.isNaN(Date.parse(data.exportedAt)));
  assert.deepEqual(
    [data.localWebsiteId, data.localWebsiteName, data.remoteWebsiteId, data.remoteWebsiteName, data.environmentId, data.environmentName, data.websiteUrl],
    ['00000000-0000-0000-0000-000000000001', 'Dev', '00000000-0000-0000-0000-000000000002', 'Test',
      '11111111-2222-3333-4444-555555555555', 'https://contoso.crm.dynamics.com', 'https://contoso.powerappsportals.com']);
  const entry = name => data.files.find(file => file.relativePath === path.join(...name.split('/')));
  const base64 = (dir, name) => fs.readFileSync(path.join(dir, name)).toString('base64');
  assert.deepEqual(entry('web-pages/home.html'), {
    relativePath: path.join('web-pages', 'home.html'), status: 'modified',
    localContent: base64(source, 'web-pages/home.html'), remoteContent: base64(target, 'web-pages/home.html'),
  });
  assert.deepEqual([entry('content-snippets/added.yml').status, entry('content-snippets/added.yml').remoteContent], ['added', null]);
  assert.deepEqual([entry('site-settings/deleted.yml').status, entry('site-settings/deleted.yml').localContent], ['deleted', null]);
  assert.deepEqual([entry('web-files/logo.png').localContent, entry('web-files/logo.png').remoteContent], [null, null]);
  assert.equal(entry('web-files/icon.svg').localContent, base64(source, 'web-files/icon.svg'));
  assert.deepEqual(data.files.map(file => [file.relativePath, file.status]),
    JSON.parse(fs.readFileSync(receipt(output), 'utf8')).files.map(file => [file.relativePath, file.status]));

  // Two local folders have no environment; import still needs a GUID key.
  const local = await main(['--source', source, '--target', target, '--output', path.join(root, 'local.html')]);
  const localData = JSON.parse(fs.readFileSync(local.export, 'utf8'));
  assert.deepEqual([localData.environmentId, localData.environmentName], ['00000000-0000-0000-0000-000000000000', 'Local folder']);
});

test('skips the export when a site has no website ID, and verification catches a changed export', async t => {
  const { root, source, target } = fixture(t);
  write(source, 'web-pages/home.html', 'local');
  write(target, 'web-pages/home.html', 'remote');
  const output = path.join(root, 'report.html');
  await writeReport(compareMetadata(source, target), output);
  const exported = output.replace(/\.html$/, '.json');
  const original = fs.readFileSync(exported, 'utf8');
  fs.writeFileSync(exported, original.replace('"modified"', '"added"'));
  assert.throws(() => verifyReport(source, target, output), /Export does not match/);
  fs.writeFileSync(exported, original);
  assert.equal(verifyReport(source, target, output).export, exported);

  write(target, 'website.yml', 'name: No identity\n');
  const unnamed = path.join(root, 'unnamed.html');
  const result = await main(['--source', source, '--target', target, '--output', unnamed]);
  assert.match(result.exportSkipped, /website ID/);
  assert.equal(result.export, undefined);
  assert.ok(!fs.existsSync(unnamed.replace(/\.html$/, '.json')));
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
  // Tabs sit in a vertical sidebar beside the files instead of one overflowing row.
  assert.match(html, /<div class="tabs-header">[^]*?<\/div>\s*<div class="tabs-panels">\s*<div class="tab-content active" id="tab-all">/);
  assert.match(html, /\.tabs-header \{\s*display: flex;\s*flex-direction: column;/);
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
  assert.match(html, /<footer class="footer">\s*Generated by <a href="https:\/\/github\.com\/microsoft\/power-platform-skills\/tree\/main\/plugins\/power-pages" target="_blank" rel="noopener noreferrer">Power Pages AI Plugin<\/a>/);
  assert.ok(!html.includes('marketplace.visualstudio.com'));
  assert.ok(!html.includes('VS Code Extension'));
  assert.match(html, new RegExp(`Plugin Version:</strong></span>\\s*<span>${version.replace(/\./g, '\\.')}</span>`));
  assert.ok(!html.includes('Extension Version'));
  // Each column shows its own site's ID, read from website.yml (id or adx_websiteid).
  const idCell = id => `Website ID:</span>\\s*<span class="info-value">${id}</span>`;
  assert.match(html, new RegExp(`<h3>Local</h3>[^]*?${idCell('00000000-0000-0000-0000-000000000001')}[^]*?<h3>Remote</h3>[^]*?${idCell('00000000-0000-0000-0000-000000000002')}`));
  assert.match(html, /Environment:<\/span>\s*<span class="info-value">https:\/\/contoso\.crm\.dynamics\.com</);
  // A local second site has no environment, so the row is hidden rather than showing a folder path.
  const local = await writeReport(compareMetadata(source, target), path.join(root, 'local-report.html'));
  assert.ok(!fs.readFileSync(local, 'utf8').includes('Environment:'));
  assert.ok(fs.existsSync(receipt(output)));
  assert.equal(verifyReport(source, target, output).added, 1);
});

test('file diffs toggle through keyboard-operable buttons that keep aria-expanded in sync', async t => {
  const { root, source, target } = fixture(t);
  write(source, 'web-pages/home.html', 'local\n');
  write(target, 'web-pages/home.html', 'remote\n');
  write(source, 'content-snippets/local.yml', 'added\n');
  const html = fs.readFileSync(await writeReport(compareMetadata(source, target), path.join(root, 'report.html')), 'utf8');
  assert.ok(!html.includes('<div class="file-header"'));
  const headers = [...html.matchAll(/<button type="button" class="file-header" aria-expanded="false" aria-controls="(diff-[\w-]+)" onclick="toggleDiff\('\1'\)">/g)]
    .map(match => match[1]);
  // Two changed files, each listed in the All tab and in its component tab.
  assert.equal(headers.length, 4);
  for (const diffId of headers) {
    assert.ok(html.includes(`<div class="diff-container" id="${diffId}" style="display: none;">`));
    assert.ok(html.includes(`<span class="toggle-icon" id="${diffId.replace('diff-', 'icon-')}" aria-hidden="true">`));
  }
  assert.match(html, /\.file-header:focus-visible\s*\{\s*outline: 2px solid var\(--primary-color\);/);

  // Run the report's own script against a minimal DOM stub so the handlers,
  // not just the initial markup, are checked.
  const element = () => {
    const attrs = new Map();
    const classes = new Set();
    return {
      style: { display: 'none' },
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), has: c => classes.has(c) },
      setAttribute: (k, v) => attrs.set(k, v),
      getAttribute: k => attrs.get(k),
    };
  };
  const nodes = headers.map(diffId => ({ diffId, header: element(), diff: element(), icon: element() }));
  const document = {
    getElementById: id => nodes.find(n => n.diffId === id)?.diff || nodes.find(n => n.diffId.replace('diff-', 'icon-') === id)?.icon,
    querySelector: selector => nodes.find(n => selector === `[aria-controls="${n.diffId}"]`)?.header,
    querySelectorAll: selector => nodes.map(n => ({ '.file-header': n.header, '.diff-container': n.diff, '.toggle-icon': n.icon })[selector]),
  };
  const script = html.match(/<script>([^]*?)<\/script>/)[1];
  const context = vm.createContext({ document });
  vm.runInContext(script, context);
  const [first, second] = nodes;
  context.toggleDiff(first.diffId);
  assert.equal(first.header.getAttribute('aria-expanded'), 'true');
  assert.equal(first.diff.style.display, 'block');
  assert.ok(first.icon.classList.has('expanded'));
  assert.equal(second.header.getAttribute('aria-expanded'), undefined);
  context.toggleDiff(first.diffId);
  assert.equal(first.header.getAttribute('aria-expanded'), 'false');
  context.expandAll();
  assert.ok(nodes.every(n => n.header.getAttribute('aria-expanded') === 'true' && n.diff.style.display === 'block'));
  context.collapseAll();
  assert.ok(nodes.every(n => n.header.getAttribute('aria-expanded') === 'false' && n.diff.style.display === 'none'));
});

test('upstream report applies its exact 5 MiB and 20,000-line display limits', async t => {
  const { source, target } = fixture(t);
  write(source, 'web-files/large.txt', 'x'.repeat(5 * 1024 * 1024 + 1));
  write(target, 'web-files/large.txt', 'remote');
  write(source, 'web-files/boundary.txt', 'x'.repeat(5 * 1024 * 1024));
  write(source, 'web-files/many-lines.txt', 'local\n'.repeat(20001));
  write(target, 'web-files/many-lines.txt', 'remote\n'.repeat(20001));
  const comparison = compareMetadata(source, target);
  const contents = await tools.readFileContents(comparison.files);
  assert.equal(contents.find(file => file.result.relativePath === path.join('web-files', 'large.txt')).isTooLarge, true);
  assert.equal(contents.find(file => file.result.relativePath === path.join('web-files', 'boundary.txt')).isTooLarge, false);
  const html = tools.generateHtmlContent(contents.filter(file => file.result.relativePath !== path.join('web-files', 'boundary.txt')), 'Local', 'Remote', 'Example', '');
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
  const saved = JSON.parse(fs.readFileSync(receipt(output), 'utf8'));
  assert.equal(saved.sourceWebsiteId, id);
  assert.equal(saved.targetWebsiteId, id);
});

test('verification detects HTML changes, wrong roots, and inconsistent sidecar counts', async t => {
  const { root, source, target } = fixture(t);
  write(source, 'web-files/added.txt', 'local');
  const output = path.join(root, 'report.html');
  await writeReport(compareMetadata(source, target), output);
  assert.throws(() => verifyReport(target, source, output), /does not match/);
  const original = fs.readFileSync(output);
  fs.appendFileSync(output, '<p>changed</p>');
  assert.throws(() => verifyReport(source, target, output), /verification receipt/);
  fs.writeFileSync(output, original);
  const sidecar = fs.readFileSync(receipt(output), 'utf8');
  fs.writeFileSync(receipt(output), sidecar.replace('"added": 1', '"added": 2'));
  assert.throws(() => verifyReport(source, target, output), /inconsistent added/);
  // Phase 5 reads the files the sidecar names, so a renamed entry or a path
  // outside the selected sites must fail even when statuses and counts agree.
  const savedReceipt = JSON.parse(sidecar);
  for (const tamper of [
    entry => { entry.relativePath = 'other.txt'; },
    entry => { entry.localPath = path.join(root, 'outside.txt'); },
    entry => { entry.remotePath = path.join(source, 'web-files', 'added.txt'); },
  ]) {
    const changed = structuredClone(savedReceipt);
    tamper(changed.files[0]);
    fs.writeFileSync(receipt(output), JSON.stringify(changed));
    assert.throws(() => verifyReport(source, target, output), /outside the verified report or selected sites/);
  }
  fs.writeFileSync(receipt(output), sidecar);
  assert.equal((await main(['--source', source, '--target', target, '--output', output, '--verify', 'true'])).added, 1);
  assert.deepEqual(fs.readFileSync(output), original);
});

test('CLI rejects invalid arguments and fails nonzero instead of producing partial reports', async t => {
  const { root, source, target } = fixture(t);
  const base = ['--source', source, '--target', target, '--output', path.join(root, 'invalid.html')];
  for (const argv of [[], ['--open', 'yes'], ['--unknown', 'value'], ['--source', 'a', '--source', 'b'],
    [...base, '--targetUrl', 'javascript:alert(1)'], [...base, '--targetModel', 'Standard'],
    [...base, '--targetCodeSite', 'maybe'], [...base, '--targetEnvironmentId', 'contoso-dev']]) {
    await assert.rejects(main(argv));
  }
  const output = path.join(root, 'failed.html');
  const child = spawnSync(process.execPath, [path.join(__dirname, '../compare-site-configurations.js'),
    '--source', path.join(root, 'missing'), '--target', target, '--output', output], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /ENOENT/);
  assert.ok(!fs.existsSync(output));
});

test('rejects upstream read failures without writing HTML', async t => {
  const { root, source, target } = fixture(t);
  const output = path.join(root, 'report.html');
  write(source, 'web-files/local.txt', 'local content');
  const comparison = compareMetadata(source, target);
  t.mock.method(tools, 'readFileContents', async files => files.map(result => ({
    result, localContent: null, remoteContent: null, isBinary: false, isTooLarge: false,
  })));
  await assert.rejects(writeReport(comparison, output), /Could not read comparison content/);
  assert.ok(!fs.existsSync(output));
});
