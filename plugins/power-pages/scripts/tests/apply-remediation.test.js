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
  return { site, staged, manifestPath, writeManifest, run };
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
  assert.equal(fixture.run('--discard').status, 0);
  assert.equal(fs.existsSync(fixture.manifestPath), false);
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
