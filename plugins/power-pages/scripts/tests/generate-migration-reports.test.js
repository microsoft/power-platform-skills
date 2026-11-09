const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '../../skills/migrate-datamodel/scripts/generate-migration-reports.js');
const fetchXml = '<fetch><entity name="adx_webpage"><attribute name="adx_name" /></entity></fetch>';
const liquid = "{{ entities['adx_contentsnippet'] }}";

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-remediation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const site = path.join(root, 'site');
  const output = path.join(root, 'reports');
  fs.mkdirSync(site);
  const run = (...flags) => spawnSync(process.execPath, [
    script, '--site-name', 'Contoso', '--website-id', '00000000-0000-0000-0000-000000000001',
    '--site-path', site, '--output-dir', output, ...flags,
  ], { encoding: 'utf8', timeout: 10000 });
  const manifestPath = path.join(output, 'remediation-diff.json');
  const manifest = () => JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return { site, output, run, manifestPath, manifest };
}

test('both diff formats terminate on reordered/repeated lines and preserve the inputs', () => {
  // Run in a bounded child: a regression in the cursor loop must fail this test
  // rather than hang the entire test runner.
  const worker = `
    const assert = require('node:assert/strict');
    const {diffLines, unifiedDiff, structuredDiff} = require(${JSON.stringify(script)});
    for (const [before, after] of [
      ['A\\nB', 'B\\nA'], ['A\\nB\\nA', 'B\\nA\\nB'],
      ['A', 'A\\nB'], ['A\\nB', 'A'], ['', 'A'], ['A', ''], ['A', 'A'],
    ]) {
      const lines = diffLines(before, after);
      assert.equal(lines.filter(l => l.type !== 'added').map(l => l.text).join('\\n'), before);
      assert.equal(lines.filter(l => l.type !== 'removed').map(l => l.text).join('\\n'), after);
      const structured = structuredDiff(before, after);
      assert.equal(structured.linesAdded, lines.filter(l => l.type === 'added').length);
      assert.equal(structured.linesRemoved, lines.filter(l => l.type === 'removed').length);
      assert.equal(unifiedDiff(before, after, 'sample').length > 0, before !== after);
    }
  `;
  const result = spawnSync(process.execPath, ['-e', worker], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});

test('separate remediation passes retain every file without changing live source', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.site, 'fetch.html'), fetchXml);
  fs.writeFileSync(path.join(fixture.site, 'liquid.html'), liquid);
  assert.equal(fixture.run('--automate-fetchxml').status, 0);
  assert.deepEqual(fixture.manifest().files.map((entry) => entry.relativePath), ['fetch.html']);
  const second = fixture.run('--automate-liquid');
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(fixture.manifest().files.map((entry) => entry.relativePath), ['fetch.html', 'liquid.html']);
  assert.equal(fs.readFileSync(path.join(fixture.site, 'fetch.html'), 'utf8'), fetchXml);
  assert.equal(fs.readFileSync(path.join(fixture.site, 'liquid.html'), 'utf8'), liquid);
});

test('both passes on one file preserve FetchXML and Liquid changes and reruns are idempotent', (t) => {
  const fixture = setup(t);
  const original = `${fetchXml}\n${liquid}`;
  fs.writeFileSync(path.join(fixture.site, 'combined.html'), original);
  assert.equal(fixture.run('--automate-fetchxml').status, 0);
  assert.equal(fixture.run('--automate-liquid').status, 0);
  const stagedPath = path.join(fixture.output, 'remediation-staged', 'combined.html');
  const staged = fs.readFileSync(stagedPath, 'utf8');
  assert.match(staged, /name="powerpagecomponent"/);
  assert.match(staged, /SDM\u2192EDM SUGGESTION/);
  assert.equal(fixture.manifest().files[0].kind, 'fetchxml+liquid');
  const repeated = fixture.run('--automate-liquid');
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(fs.readFileSync(stagedPath, 'utf8'), staged);
  assert.equal(fs.readFileSync(path.join(fixture.site, 'combined.html'), 'utf8'), original);
});

test('zero-rewrite rerun removes obsolete manifest and staged proposals', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.site, 'page.html'), fetchXml);
  assert.equal(fixture.run('--automate-fetchxml').status, 0);
  assert.ok(fs.existsSync(fixture.manifestPath));
  fs.writeFileSync(path.join(fixture.site, 'page.html'), '<p>Already remediated</p>');
  const rerun = fixture.run('--automate-fetchxml');
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(fs.existsSync(fixture.manifestPath), false);
  assert.equal(fs.existsSync(path.join(fixture.output, 'remediation-staged', 'page.html')), false);
});

test('a different site cannot reuse an existing remediation manifest', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.site, 'page.html'), fetchXml);
  assert.equal(fixture.run('--automate-fetchxml').status, 0);
  const original = fs.readFileSync(fixture.manifestPath, 'utf8');
  const otherSite = path.join(fixture.site, 'other');
  fs.mkdirSync(otherSite);
  const result = fixture.run('--automate-liquid', '--site-path', otherSite);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match the selected site root/);
  assert.equal(fs.readFileSync(fixture.manifestPath, 'utf8'), original);
});

test('null saved remediation inputs produce clear errors before proposals are removed', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.site, 'page.html'), fetchXml);
  assert.equal(fixture.run('--automate-fetchxml').status, 0);
  const stagedPath = path.join(fixture.output, 'remediation-staged', 'page.html');
  const staged = fs.readFileSync(stagedPath, 'utf8');
  for (const payload of [null, { siteRoot: fixture.site, files: [null] }]) {
    fs.writeFileSync(fixture.manifestPath, JSON.stringify(payload));
    const result = fixture.run('--automate-fetchxml');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match|Unknown remediation kind/);
    assert.doesNotMatch(result.stderr, /TypeError|Cannot read properties/);
    assert.equal(fs.readFileSync(stagedPath, 'utf8'), staged);
  }
});
