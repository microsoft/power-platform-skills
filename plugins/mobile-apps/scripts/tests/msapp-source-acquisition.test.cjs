'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { crc32 } = require('../lib/safe-zip.js');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const ACQUISITION_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'extract-msapp-source.js');
const MODERNIZE_SKILL = path.join(PLUGIN_ROOT, 'skills', 'modernize-canvas-app', 'SKILL.md');
const HANDOFF_CONTRACT = path.join(PLUGIN_ROOT, 'skills', 'create-mobile-app', 'mobile-plugin-handoff-contract.md');
const SCREEN_BUILDER = path.join(PLUGIN_ROOT, 'agents', 'screen-builder.md');
const WORKFLOW_BUILDER = path.join(PLUGIN_ROOT, 'agents', 'workflow-builder.md');

function writeStoredZip(file, rows) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const row of rows) {
    const name = Buffer.from(row.name, 'utf8');
    const data = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data || '', 'utf8');
    const checksum = row.declaredCrc32 == null ? crc32(data) : row.declaredCrc32;
    const flags = row.flags == null ? 0x0800 : row.flags;
    const method = row.method == null ? 0 : row.method;
    const compressed = method === 8 ? zlib.deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = row.mode == null ? 0o100644 : row.mode;
    central.writeUInt32LE(((mode & 0xffff) * 0x10000) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }

  const localData = Buffer.concat(localParts);
  const centralData = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(rows.length, 8);
  eocd.writeUInt16LE(rows.length, 10);
  eocd.writeUInt32LE(centralData.length, 12);
  eocd.writeUInt32LE(localData.length, 16);
  fs.writeFileSync(file, Buffer.concat([localData, centralData, eocd]));
}

function runAcquisition(args) {
  return spawnSync(process.execPath, [ACQUISITION_SCRIPT, ...args], { encoding: 'utf8' });
}

function makeTemp(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('modern local MSAPP extracts directly and resolves current source without PAC', (t) => {
  const tmp = makeTemp(t, 'modern-msapp-direct-');
  const msapp = path.join(tmp, 'FieldOps.msapp');
  const output = path.join(tmp, 'extracted');
  writeStoredZip(msapp, [
    { name: 'Src/App.pa.yaml', data: 'App:\n  Properties:\n    StartScreen: =Home\n', method: 8 },
    { name: 'Src/Home.pa.yaml', data: 'Screens:\n  Home:\n    Children: []\n', method: 8 },
    { name: 'Properties.json', data: '{}', method: 8 },
  ]);

  const result = runAcquisition(['--msapp', msapp, '--out', output]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.acquisition, 'safe-direct-msapp-extraction');
  assert.equal(parsed.sourceRoot, fs.realpathSync(output));
  assert.equal(parsed.currentSourceFiles, 2);
  assert.ok(fs.existsSync(path.join(output, 'Src', 'App.pa.yaml')));
  assert.equal(
    fs.readFileSync(path.join(output, '.mobile-app-modernizer-source'), 'utf8'),
    'Owned by modernize-canvas-app source acquisition. Generated artifacts only.\n'
  );
});

test('direct extraction resolves one wrapped Canvas source root deterministically', (t) => {
  const tmp = makeTemp(t, 'modern-msapp-wrapper-');
  const msapp = path.join(tmp, 'Wrapped.msapp');
  const output = path.join(tmp, 'extracted');
  writeStoredZip(msapp, [
    { name: 'solution/canvas/MyApp/Src/App.pa.yaml', data: 'App:\n  Properties: {}\n' },
    { name: 'solution/canvas/MyApp/Src/Home.pa.yaml', data: 'Screens:\n  Home:\n    Children: []\n' },
  ]);

  const result = runAcquisition(['--msapp', msapp, '--out', output]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).sourceRoot, path.join(fs.realpathSync(output), 'solution', 'canvas', 'MyApp'));
});

test('valid old package without current PA YAML returns only the documented fallback signal', (t) => {
  const tmp = makeTemp(t, 'old-msapp-fallback-');
  const msapp = path.join(tmp, 'Old.msapp');
  const output = path.join(tmp, 'extracted');
  writeStoredZip(msapp, [
    { name: 'Src/App.fx.yaml', data: 'App:\n  OnStart: =Set(var_ready, true)\n' },
    { name: 'CanvasManifest.json', data: '{}' },
  ]);

  const result = runAcquisition(['--msapp', msapp, '--out', output]);
  assert.equal(result.status, 3, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.acquisition, 'no-current-source');
  assert.equal(parsed.fallbackEligible, true);
  assert.equal(parsed.reason, 'retired-fx-yaml-only');
  assert.equal(fs.existsSync(output), false);
  assert.match(result.stderr, /NO_CURRENT_SOURCE/);
});

test('unsafe archive path is blocked and cannot become a PAC fallback', (t) => {
  const tmp = makeTemp(t, 'unsafe-msapp-path-');
  const msapp = path.join(tmp, 'Unsafe.msapp');
  const output = path.join(tmp, 'extracted');
  writeStoredZip(msapp, [
    { name: '../escaped.txt', data: 'must not write' },
    { name: 'Src/App.pa.yaml', data: 'App:\n  Properties: {}\n' },
  ]);

  const result = runAcquisition(['--msapp', msapp, '--out', output]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsafe ZIP entry path/);
  assert.doesNotMatch(result.stdout, /fallbackEligible/);
  assert.equal(fs.existsSync(path.join(tmp, 'escaped.txt')), false);
  assert.equal(fs.existsSync(output), false);
});

test('symlink entries are blocked before extraction', (t) => {
  const tmp = makeTemp(t, 'unsafe-msapp-symlink-');
  const msapp = path.join(tmp, 'Symlink.msapp');
  const output = path.join(tmp, 'extracted');
  writeStoredZip(msapp, [
    { name: 'Src/App.pa.yaml', data: 'App:\n  Properties: {}\n' },
    { name: 'Src/Linked.pa.yaml', data: '../../outside.pa.yaml', mode: 0o120777 },
  ]);

  const result = runAcquisition(['--msapp', msapp, '--out', output]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Symbolic links are not allowed/);
  assert.doesNotMatch(result.stdout, /fallbackEligible/);
  assert.equal(fs.existsSync(output), false);
});

test('encrypted, unsupported-compression, colliding, and corrupt entries fail closed', (t) => {
  const tmp = makeTemp(t, 'unsafe-msapp-variants-');
  const cases = [
    {
      name: 'encrypted',
      rows: [{ name: 'Src/App.pa.yaml', data: 'App:\n  Properties: {}\n', flags: 0x0801 }],
      error: /Encrypted ZIP entries are not supported/,
    },
    {
      name: 'unsupported-compression',
      rows: [{ name: 'Src/App.pa.yaml', data: 'App:\n  Properties: {}\n', method: 99 }],
      error: /Unsupported ZIP compression method/,
    },
    {
      name: 'case-collision',
      rows: [
        { name: 'Src/App.pa.yaml', data: 'App:\n  Properties: {}\n' },
        { name: 'src/app.pa.yaml', data: 'App:\n  Properties: {}\n' },
      ],
      error: /Case-insensitive ZIP path collision/,
    },
    {
      name: 'directory-case-collision',
      rows: [
        { name: 'Src/App.pa.yaml', data: 'App:\n  Properties: {}\n' },
        { name: 'src/Components/Widget.pa.yaml', data: 'ComponentDefinitions: {}\n' },
      ],
      error: /Case-insensitive ZIP path collision/,
    },
    {
      name: 'windows-reserved-name',
      rows: [{ name: 'Src/CON.pa.yaml', data: 'App:\n  Properties: {}\n' }],
      error: /not cross-platform safe/,
    },
    {
      name: 'file-directory-collision',
      rows: [
        { name: 'Src', data: 'not a directory' },
        { name: 'Src/App.pa.yaml', data: 'App:\n  Properties: {}\n' },
      ],
      error: /file\/directory path collision/,
    },
    {
      name: 'crc-corruption',
      rows: [{ name: 'Src/App.pa.yaml', data: 'App:\n  Properties: {}\n', declaredCrc32: 1 }],
      error: /ZIP CRC mismatch/,
    },
  ];

  for (const fixture of cases) {
    const msapp = path.join(tmp, `${fixture.name}.msapp`);
    const output = path.join(tmp, `${fixture.name}-out`);
    writeStoredZip(msapp, fixture.rows);
    const result = runAcquisition(['--msapp', msapp, '--out', output]);
    assert.equal(result.status, 1, fixture.name);
    assert.match(result.stderr, fixture.error, fixture.name);
    assert.doesNotMatch(result.stdout, /fallbackEligible/, fixture.name);
    assert.equal(fs.existsSync(output), false, fixture.name);
  }
});

test('existing and downloaded trees must resolve exactly one current source root', (t) => {
  const tmp = makeTemp(t, 'canvas-source-root-');
  fs.mkdirSync(path.join(tmp, 'wrapper', 'Src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'wrapper', 'Src', 'App.pa.yaml'), 'App:\n  Properties: {}\n');
  const success = runAcquisition(['--find-source-root', tmp]);
  assert.equal(success.status, 0, success.stderr || success.stdout);
  assert.equal(JSON.parse(success.stdout).sourceRoot, path.join(fs.realpathSync(tmp), 'wrapper'));

  fs.mkdirSync(path.join(tmp, 'other', 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'other', 'src', 'App.pa.yaml'), 'App:\n  Properties: {}\n');
  const ambiguous = runAcquisition(['--find-source-root', tmp]);
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /multiple Canvas source roots found/);
});

test('workflow instructions enforce safe acquisition order and AI implementation ownership', () => {
  const modernize = fs.readFileSync(MODERNIZE_SKILL, 'utf8');
  const localSection = modernize.slice(modernize.indexOf('#### Local .msapp'), modernize.indexOf('#### App from an environment'));
  assert.ok(localSection.indexOf('extract-msapp-source.js') < localSection.indexOf('pac canvas unpack'));
  assert.match(localSection, /DIRECT_EXIT=3[\s\S]*only[\s\S]*deprecated compatibility fallback/i);
  assert.match(localSection, /Any other nonzero exit[\s\S]*STOP[\s\S]*Never hand[\s\S]*archive to PAC/i);
  assert.match(localSection, /Open it in current Power Apps Studio, save and publish it/i);

  for (const file of [MODERNIZE_SKILL, HANDOFF_CONTRACT, SCREEN_BUILDER, WORKFLOW_BUILDER]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /deterministic code preserves business\/data\/connector contracts[.;] AI owns all React Native implementation/i, file);
    assert.match(text, /do not (?:build|look for|request|build or invoke).*deterministic Canvas-to-TypeScript operation emitter/i, file);
  }
});
