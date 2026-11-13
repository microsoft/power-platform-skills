const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '../../skills/migrate-datamodel/scripts/apply-remediation.js');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-apply-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const site = path.join(root, 'site');
  const output = path.join(root, 'reports');
  const staged = path.join(output, 'remediation-staged');
  fs.mkdirSync(site);
  fs.mkdirSync(staged, { recursive: true });
  const manifestPath = path.join(output, 'remediation-diff.json');
  const writeManifest = (value) => fs.writeFileSync(manifestPath,
    JSON.stringify(value && typeof value === 'object' ? { siteRoot: site, ...value } : value));
  const run = (...args) => spawnSync(process.execPath, [
    script, '--site-root', site, '--output-dir', output, ...args,
  ], { encoding: 'utf8' });
  const injectFailure = (body) => spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    ${body}
    process.argv = [process.execPath, ${JSON.stringify(script)}, '--site-root',
      ${JSON.stringify(site)}, '--output-dir', ${JSON.stringify(output)}];
    require(${JSON.stringify(script)});
  `], { encoding: 'utf8' });
  return { site, output, staged, manifestPath, writeManifest, run, injectFailure };
}

test('valid staged remediation still supports dry-run, apply and discard', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.site, 'page.html'), 'original');
  fs.writeFileSync(path.join(fixture.staged, 'page.html'), 'approved proposal');
  fixture.writeManifest({ files: [{ relativePath: 'page.html' }] });
  assert.equal(fixture.run('--dry-run').status, 0);
  assert.equal(fs.readFileSync(path.join(fixture.site, 'page.html'), 'utf8'), 'original');
  assert.equal(fixture.run().status, 0);
  assert.equal(fs.readFileSync(path.join(fixture.site, 'page.html'), 'utf8'), 'approved proposal');
  assert.equal(fs.existsSync(fixture.staged), false);
  assert.deepEqual(fs.readdirSync(fixture.output).filter((name) => name.startsWith('remediation-backup-')), []);
  assert.equal(fixture.run('--discard').status, 0);
  assert.equal(fs.existsSync(fixture.manifestPath), false);
});

test('hard-linked files cannot bypass apply containment', (t) => {
  const fixture = setup(t);
  const outside = path.join(path.dirname(fixture.site), 'outside.html');
  fs.writeFileSync(outside, 'outside original');
  fs.linkSync(outside, path.join(fixture.site, 'page.html'));
  fs.writeFileSync(path.join(fixture.staged, 'page.html'), 'proposal');
  fixture.writeManifest({ files: [{ relativePath: 'page.html' }] });
  const result = fixture.run();
  assert.equal(result.status, 4);
  assert.match(result.stderr, /hard-linked file/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside original');
});

for (const linkedRoot of ['site', 'staged']) {
  test(`apply rejects ${linkedRoot} descendant junctions without changing outside files`, (t) => {
    const fixture = setup(t);
    const outside = path.join(path.dirname(fixture.site), 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'page.html'), 'outside original');
    const otherRoot = linkedRoot === 'site' ? fixture.staged : fixture.site;
    fs.mkdirSync(path.join(otherRoot, 'link'));
    fs.writeFileSync(path.join(otherRoot, 'link', 'page.html'), 'inside original');
    fs.symlinkSync(outside, path.join(fixture[linkedRoot], 'link'),
      process.platform === 'win32' ? 'junction' : 'dir');
    fixture.writeManifest({ files: [{ relativePath: path.join('link', 'page.html') }] });
    const result = fixture.run();
    assert.equal(result.status, 4);
    assert.match(result.stderr, /symbolic link or junction/);
    assert.equal(fs.readFileSync(path.join(outside, 'page.html'), 'utf8'), 'outside original');
    assert.equal(fs.readFileSync(path.join(otherRoot, 'link', 'page.html'), 'utf8'), 'inside original');
    assert.ok(fs.existsSync(fixture.manifestPath));
  });
}

test('a linked staged root is rejected before copying or cleanup', (t) => {
  const fixture = setup(t);
  const outside = path.join(path.dirname(fixture.site), 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'page.html'), 'proposal');
  fs.rmdirSync(fixture.staged);
  fs.symlinkSync(outside, fixture.staged, process.platform === 'win32' ? 'junction' : 'dir');
  fixture.writeManifest({ files: [{ relativePath: 'page.html' }] });
  assert.equal(fixture.run().status, 4);
  assert.equal(fs.readFileSync(path.join(outside, 'page.html'), 'utf8'), 'proposal');
});

test('late copy failure restores overwritten files, removes new files and directories, and retains proposals', (t) => {
  const fixture = setup(t);
  const paths = ['existing.html', path.join('new-folder', 'new.html'), 'failure.html'];
  fs.writeFileSync(path.join(fixture.site, paths[0]), 'original');
  for (const relativePath of paths) {
    const stagedPath = path.join(fixture.staged, relativePath);
    fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
    fs.writeFileSync(stagedPath, 'proposal');
  }
  fixture.writeManifest({ files: paths.map((relativePath) => ({ relativePath })) });
  const result = fixture.injectFailure(`
    const copy = fs.copyFileSync;
    fs.copyFileSync = (from, to) => {
      if (path.basename(to) === 'failure.html') {
        fs.writeFileSync(to, 'partially copied');
        throw new Error('injected disk failure');
      }
      return copy(from, to);
    };
  `);
  assert.equal(result.status, 4);
  assert.match(result.stderr, /injected disk failure.*Original files restored/s);
  assert.equal(fs.readFileSync(path.join(fixture.site, paths[0]), 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(fixture.site, 'new-folder')), false);
  assert.equal(fs.existsSync(path.join(fixture.site, 'failure.html')), false);
  assert.ok(fs.existsSync(fixture.staged));
  assert.ok(fs.existsSync(fixture.manifestPath));
});

test('a failed copy that truncates an existing destination restores that destination too', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.site, 'page.html'), 'original');
  fs.writeFileSync(path.join(fixture.staged, 'page.html'), 'proposal');
  fixture.writeManifest({ files: [{ relativePath: 'page.html' }] });
  const result = fixture.injectFailure(`
    fs.copyFileSync = (from, to) => {
      fs.writeFileSync(to, '');
      throw new Error('injected truncation');
    };
  `);
  assert.equal(result.status, 4);
  assert.equal(fs.readFileSync(path.join(fixture.site, 'page.html'), 'utf8'), 'original');
});

test('rollback errors are explicit and retain recovery inputs', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.site, 'page.html'), 'original');
  fs.writeFileSync(path.join(fixture.staged, 'page.html'), 'proposal');
  fixture.writeManifest({ files: [{ relativePath: 'page.html' }] });
  const result = fixture.injectFailure(`
    fs.copyFileSync = () => { throw new Error('injected copy failure'); };
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, ...args) => {
      if (path.basename(file) === 'page.html') throw new Error('injected restore failure');
      return write(file, ...args);
    };
  `);
  assert.equal(result.status, 4);
  assert.match(result.stderr, /Rollback incomplete; manual recovery required/);
  assert.match(result.stderr, /injected restore failure/);
  assert.ok(fs.existsSync(fixture.staged));
  assert.ok(fs.existsSync(fixture.manifestPath));
  const backups = fs.readdirSync(fixture.output).filter((name) => name.startsWith('remediation-backup-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(fixture.output, backups[0], '0.bin'), 'utf8'), 'original');
  const recovery = JSON.parse(fs.readFileSync(path.join(fixture.output, backups[0], 'manifest.json'), 'utf8'));
  assert.equal(recovery.files[0].relativePath, 'page.html');
});

test('backup failure aborts before any live write', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.site, 'page.html'), 'original');
  fs.writeFileSync(path.join(fixture.staged, 'page.html'), 'proposal');
  fixture.writeManifest({ files: [{ relativePath: 'page.html' }] });
  const result = fixture.injectFailure(`
    fs.writeFileSync = () => { throw new Error('injected backup failure'); };
  `);
  assert.equal(result.status, 4);
  assert.match(result.stderr, /Could not prepare backup.*No live files changed/s);
  assert.equal(fs.readFileSync(path.join(fixture.site, 'page.html'), 'utf8'), 'original');
});

test('missing manifest and empty file list remain explicit nothing-to-apply results', (t) => {
  const fixture = setup(t);
  assert.equal(fixture.run().status, 3);
  fixture.writeManifest({ files: [] });
  assert.equal(fixture.run().status, 3);
});

test('null or malformed remediation entries produce validation errors without touching source', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.site, 'page.html'), 'original');
  for (const payload of [null, {}, { files: null }, { files: [null] },
    { files: [{}] }, { files: [{ relativePath: {} }] }, { files: [{ relativePath: '' }] }]) {
    fixture.writeManifest(payload);
    const result = fixture.run();
    assert.equal(result.status, 4);
    assert.match(result.stderr, /must contain/);
    assert.doesNotMatch(result.stderr, /TypeError|Cannot read properties/);
    assert.equal(fs.readFileSync(path.join(fixture.site, 'page.html'), 'utf8'), 'original');
  }
});

test('all staged files are checked before any live file is overwritten', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.site, 'page.html'), 'original');
  fs.writeFileSync(path.join(fixture.staged, 'page.html'), 'proposal');
  fixture.writeManifest({ files: [{ relativePath: 'page.html' }, { relativePath: 'missing.html' }] });
  const result = fixture.run();
  assert.equal(result.status, 4);
  assert.match(result.stderr, /Staged file missing or not a file/);
  assert.equal(fs.readFileSync(path.join(fixture.site, 'page.html'), 'utf8'), 'original');
  assert.ok(fs.existsSync(fixture.staged));
});

test('traversal paths are rejected without copying or deleting files', (t) => {
  const fixture = setup(t);
  fixture.writeManifest({ files: [{ relativePath: path.join('..', 'outside.html') }] });
  const result = fixture.run();
  assert.equal(result.status, 4);
  assert.match(result.stderr, /must stay inside/);
  assert.ok(fs.existsSync(fixture.staged));
});

test('a different or missing manifest site identity cannot receive staged files', (t) => {
  const fixture = setup(t);
  const otherSite = path.join(path.dirname(fixture.site), 'other-site');
  fs.mkdirSync(otherSite);
  fs.writeFileSync(path.join(fixture.staged, 'page.html'), 'proposal');
  fs.writeFileSync(path.join(fixture.site, 'page.html'), 'original');
  for (const siteRoot of [otherSite, null, 'relative-site']) {
    fixture.writeManifest({ siteRoot, files: [{ relativePath: 'page.html' }] });
    const result = fixture.run();
    assert.equal(result.status, 4);
    assert.match(result.stderr, /siteRoot|does not match/);
    assert.equal(fs.readFileSync(path.join(fixture.site, 'page.html'), 'utf8'), 'original');
    assert.ok(fs.existsSync(fixture.staged));
  }
});
