'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');

const scriptPath = path.join(__dirname, '..', 'lint-pcf.js');
const fixture = path.join(__dirname, 'fixtures', 'pcf-manifests', 'field-virtual.xml');

async function run(argv) {
  const cli = loadCli(scriptPath, { argv });
  assert.equal(typeof cli.main, 'function');
  try {
    await cli.main();
  } catch (err) {
    if (!String(err && err.message).startsWith('process.exit(')) throw err;
  }
  return cli;
}

test('lint-pcf rejects unknown flags with usage and a did-you-mean hint', async () => {
  const cli = await run(['--manifes', fixture]);

  assert.equal(cli.exitCode, 1);
  assert.match(cli.stderrText(), /did you mean --manifest/i);
  assert.match(cli.stderrText(), /Usage: node scripts[/\\]lint-pcf\.js/i);
  assert.equal(cli.stdoutText(), '');
});

test('lint-pcf rejects valued --strict before reading manifests', async () => {
  const cli = await run(['--manifest', 'D:\\tmp\\ControlManifest.Input.xml', '--strict=false']);

  assert.equal(cli.exitCode, 1);
  assert.match(cli.stderrText(), /--strict does not take a value/);
  assert.equal(cli.stdoutText(), '');
});

test('lint-pcf fails with structured JSON when a project contains no manifests', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-lint-empty-project-'));
  try {
    const cli = await run(['--project', dir]);

    assert.equal(cli.exitCode, 1);
    const payload = JSON.parse(cli.stdoutText());
    assert.equal(payload.ok, false);
    assert.deepEqual(payload.results, []);
    assert.match(payload.error, /No ControlManifest\.Input\.xml files were found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lint-pcf emits JSON and exits 1 for a virtual manifest targeting Pages', async () => {
  const cli = await run(['--manifest', fixture, '--hosts', 'pages']);

  assert.equal(cli.exitCode, 1);
  const payload = JSON.parse(cli.stdoutText());
  assert.equal(payload.ok, false);
  assert.equal(payload.results.length, 1);
  assert.equal(path.basename(payload.results[0].manifest), 'field-virtual.xml');
  assert.ok(payload.results[0].errors.some((finding) => finding.code === 'PCF_PAGES_VIRTUAL'));
});

test('lint-pcf --strict exits 1 when only warnings are present', async () => {
  const tmp = path.join(__dirname, 'fixtures', 'pcf-manifests', 'strict-warning.xml');
  fs.writeFileSync(tmp, '<?xml version="1.0"?><manifest><control namespace="Contoso.Controls" constructor="Warn" version="1.0.0" display-name-key="Warn" description-key="Warn"><resources><code path="index.ts" /></resources><external-service-usage enabled="true"><domain>api.contoso.com</domain></external-service-usage></control></manifest>');
  try {
    const cli = await run(['--manifest', tmp, '--strict']);
    assert.equal(cli.exitCode, 1);
    const payload = JSON.parse(cli.stdoutText());
    assert.equal(payload.ok, false);
    assert.ok(payload.results[0].warnings.some((finding) => finding.code === 'PCF_EXTERNAL_SERVICE'));
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('lint-pcf compares against an old manifest when --against is supplied', async () => {
  const oldFile = path.join(__dirname, 'fixtures', 'pcf-manifests', 'against-old.xml');
  const newFile = path.join(__dirname, 'fixtures', 'pcf-manifests', 'against-new.xml');
  fs.writeFileSync(oldFile, '<?xml version="1.0"?><manifest><control namespace="Contoso.Controls" constructor="Diff" version="1.0.0" display-name-key="Diff" description-key="Diff"><property name="value" usage="input" of-type="SingleLine.Text" /><resources><code path="index.ts" /></resources></control></manifest>');
  fs.writeFileSync(newFile, '<?xml version="1.0"?><manifest><control namespace="Contoso.Controls" constructor="Diff" version="1.0.0" display-name-key="Diff" description-key="Diff"><property name="value" usage="input" of-type="SingleLine.Text" required="true" /><resources><code path="index.ts" /></resources></control></manifest>');
  try {
    const cli = await run(['--manifest', newFile, '--against', oldFile]);
    assert.equal(cli.exitCode, 1);
    const payload = JSON.parse(cli.stdoutText());
    assert.ok(payload.results[0].diff.breaking.some((finding) => finding.code === 'PCF_DIFF_REQUIRED_ADDED'));
  } finally {
    fs.unlinkSync(oldFile);
    fs.unlinkSync(newFile);
  }
});

test('lint-pcf reports an invalid --against manifest instead of producing a misleading diff', async () => {
  const oldFile = path.join(__dirname, 'fixtures', 'pcf-manifests', 'against-invalid.xml');
  fs.writeFileSync(oldFile, '<manifest></manifest>');
  try {
    const cli = await run(['--manifest', path.join(__dirname, 'fixtures', 'pcf-manifests', 'field-standard.xml'), '--against', oldFile]);
    assert.equal(cli.exitCode, 1);
    const payload = JSON.parse(cli.stdoutText());
    assert.equal(payload.ok, false);
    assert.ok(payload.results[0].errors.some((finding) => finding.code === 'PCF_NO_CONTROL'));
    assert.match(payload.results[0].errors[0].message, /against/i);
  } finally {
    fs.unlinkSync(oldFile);
  }
});
