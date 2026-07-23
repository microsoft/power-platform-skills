'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  MAX_YAML_LINES,
  PROVENANCE_PATH,
  PowerAppsYamlValidationError,
  SCHEMA_PATH,
  parseYamlDocument,
  validatePowerAppsYamlSource,
} = require('../lib/power-apps-yaml-schema.js');

const SCRIPT_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(SCRIPT_ROOT, 'validate-power-apps-yaml.js');
const EXTRACTOR = path.join(SCRIPT_ROOT, 'extract-msapp-brief.v2.cjs');
const ADAPTER = path.join(SCRIPT_ROOT, 'adapt-app-brief-for-mobile-plugin.js');
const PACKAGE_VALIDATOR = path.join(SCRIPT_ROOT, 'validate-mobile-plugin-input.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'power-apps-yaml');
const RUNTIME_BUNDLE = path.join(SCRIPT_ROOT, 'lib', 'vendor', 'power-apps-yaml-runtime.cjs');
const RUNTIME_LOCK = path.join(SCRIPT_ROOT, 'lib', 'vendor', 'power-apps-yaml-runtime.lock.json');

function fixture(name) {
  return path.join(FIXTURES, name);
}

function makeTemp(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function collectCodes(error) {
  assert.ok(error instanceof PowerAppsYamlValidationError);
  return error.report.errors.map((row) => row.code);
}

test('official Power Apps YAML v3 schema snapshot matches immutable provenance', () => {
  const provenance = JSON.parse(fs.readFileSync(PROVENANCE_PATH, 'utf8'));
  const bytes = fs.readFileSync(SCHEMA_PATH);
  assert.equal(bytes.length, 19539);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), 'fc2816840271186d3b3057a1316bdb682bf6d95f4ae4849eab1fd47e2149ed13');
  assert.equal(provenance.sourceCommit, 'a03a42b966f7308cd3f888304e56330edea155ec');
  assert.equal(provenance.sha256, 'fc2816840271186d3b3057a1316bdb682bf6d95f4ae4849eab1fd47e2149ed13');
  assert.equal(provenance.compatibilityCorrections.length, 1);
});

test('offline YAML validator runtime matches its reproducible bundle lock', () => {
  const lock = JSON.parse(fs.readFileSync(RUNTIME_LOCK, 'utf8'));
  const bundle = fs.readFileSync(RUNTIME_BUNDLE);
  assert.equal(bundle.length, lock.bundleBytes);
  assert.equal(crypto.createHash('sha256').update(bundle).digest('hex'), lock.bundleSha256);
  assert.deepEqual(lock.runtimePackages, {
    ajv: '8.20.0',
    'fast-deep-equal': '3.1.3',
    'fast-uri': '3.1.3',
    'json-schema-traverse': '1.0.0',
    yaml: '2.9.0',
  });
});

test('valid split source passes per-file and logical official-schema validation', () => {
  const report = validatePowerAppsYamlSource(fixture('valid-split'));
  assert.equal(report.valid, true);
  assert.equal(report.schema.version, '3.0');
  assert.equal(report.sourceFileCount, 5);
  assert.deepEqual(report.sectionCounts, {
    App: 1,
    Screens: 1,
    ComponentDefinitions: 1,
    DataSources: 1,
    EditorState: 1,
  });
});

test('schema drift, duplicate keys, malformed YAML, aliases, and duplicate logical entities fail closed', () => {
  const cases = [
    ['invalid-unknown-field', /SCHEMA_ADDITIONALPROPERTIES/],
    ['invalid-duplicate-key', /DUPLICATE_KEY|YAML_PARSE_ERROR/],
    ['invalid-malformed', /MULTILINE_IMPLICIT_KEY/],
    ['invalid-alias', /YAML_ALIAS_FORBIDDEN/],
    ['invalid-duplicate-logical', /LOGICAL_DUPLICATE_ENTITY/],
  ];
  for (const [name, expected] of cases) {
    assert.throws(
      () => validatePowerAppsYamlSource(fixture(name)),
      (error) => expected.test(collectCodes(error).join('\n')),
      name
    );
  }
});

test('tags, directives, anchors, merge keys, and complex mapping keys fail before conversion', () => {
  const cases = [
    ['tag', 'Screens:\n  !!str Home:\n    Children: []\n', 'YAML_TAG_FORBIDDEN'],
    ['directive', '%YAML 1.1\n---\nScreens:\n  Home:\n    Children: []\n', 'YAML_DIRECTIVE_FORBIDDEN'],
    ['anchor', 'Screens:\n  Home: &screen\n    Children: []\n', 'YAML_ANCHOR_FORBIDDEN'],
    ['merge', 'Screens:\n  Home:\n    <<: *screen\n', 'YAML_MERGE_KEY_FORBIDDEN'],
    ['complex-key', 'Screens:\n  ? [Home, Other]\n  : { Children: [] }\n', 'YAML_COMPLEX_KEY_FORBIDDEN'],
    ['quoted-key', 'Screens:\n  "Home":\n    Children: []\n', 'YAML_QUOTED_KEY_FORBIDDEN'],
    ['flow-map', 'Screens: { Home: { Children: [] } }\n', 'YAML_FLOW_MAP_FORBIDDEN'],
    ['flow-sequence', 'EditorState:\n  ScreensOrder: [Home, Other]\n', 'YAML_FLOW_SEQUENCE_FORBIDDEN'],
  ];
  for (const [name, yaml, expectedCode] of cases) {
    const parsed = parseYamlDocument(yaml, `${name}.pa.yaml`);
    assert.ok(parsed.errors.some((row) => row.code === expectedCode), `${name}: ${JSON.stringify(parsed.errors)}`);
  }
});

test('pre-parse line limits reject oversized input before AST construction', () => {
  const yaml = `${'\n'.repeat(MAX_YAML_LINES)}Screens: {}`;
  const parsed = parseYamlDocument(yaml, 'oversized.pa.yaml');
  assert.equal(parsed.document, null);
  assert.equal(parsed.nodeCount, 0);
  assert.equal(parsed.errors[0].code, 'YAML_LINE_LIMIT');
});

test('logical merge safely accounts prototype-shaped entity names', (t) => {
  const root = makeTemp(t, 'power-apps-yaml-prototype-');
  fs.mkdirSync(path.join(root, 'Src'));
  fs.writeFileSync(path.join(root, 'Src', 'One.pa.yaml'), 'Screens:\n  __proto__:\n    Children: []\n');
  fs.writeFileSync(path.join(root, 'Src', 'Two.pa.yaml'), 'Screens:\n  __proto__:\n    Properties:\n      Fill: =Color.White\n');
  const report = validatePowerAppsYamlSource(root, { throwOnError: false });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((row) => row.code === 'LOGICAL_DUPLICATE_ENTITY'));
});

test('empty source is rejected without persisting an absolute path', (t) => {
  const root = makeTemp(t, 'power-apps-yaml-empty-');
  fs.mkdirSync(path.join(root, 'Src'));
  assert.throws(
    () => validatePowerAppsYamlSource(root),
    (error) => /contains no current/.test(error.message) && !error.message.includes(root)
  );
});

test('validator CLI emits stable relative diagnostics and nonzero status', () => {
  const result = spawnSync(process.execPath, [CLI, '--source', fixture('invalid-unknown-field'), '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.valid, false);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].file, 'Src/Home.pa.yaml');
  assert.equal(report.errors[0].line, 3);
  assert.equal(report.errors[0].code, 'SCHEMA_ADDITIONALPROPERTIES');
  assert.match(report.errors[0].message, /FutureSchemaField/);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('extractor validates before semantic extraction and records schema provenance', (t) => {
  const tmp = makeTemp(t, 'power-apps-yaml-extractor-');
  const validOut = path.join(tmp, 'valid-out');
  const valid = spawnSync(process.execPath, [EXTRACTOR, '--extracted', fixture('valid-split'), '--out', validOut], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr || valid.stdout);
  const brief = JSON.parse(fs.readFileSync(path.join(validOut, 'app-brief.json'), 'utf8'));
  assert.deepEqual(brief.source.schemaValidation, {
    schema: 'power-apps-yaml-validation-report-v1',
    version: '3.0',
    id: 'http://powerapps.com/schemas/pa-yaml/v3.0/pa.schema',
    sourceCommit: 'a03a42b966f7308cd3f888304e56330edea155ec',
    sha256: 'fc2816840271186d3b3057a1316bdb682bf6d95f4ae4849eab1fd47e2149ed13',
    sourceTreeSha256: '300605f4281641d82510e5e7ae57ac8b9f2536dd4ba05f6b0d2cd79914e87270',
    sourceFileCount: 5,
    sourceInputSha256: '666c7fd02ebdfe50690afdc341fb4f3301196d7641013a67bb1a11472cd80f98',
    sourceInputFileCount: 5,
    sectionCounts: {
      App: 1,
      Screens: 1,
      ComponentDefinitions: 1,
      DataSources: 1,
      EditorState: 1,
    },
  });

  const adaptedOut = path.join(tmp, 'adapted-out');
  const adapted = spawnSync(process.execPath, [
    ADAPTER,
    '--input', path.join(validOut, 'app-brief.json'),
    '--screens-dir', path.join(validOut, 'screens'),
    '--out-dir', adaptedOut,
  ], { encoding: 'utf8' });
  assert.equal(adapted.status, 0, adapted.stderr || adapted.stdout);
  const pluginInput = JSON.parse(fs.readFileSync(path.join(adaptedOut, 'mobile-plugin-input.json'), 'utf8'));
  assert.deepEqual(pluginInput.source.powerAppsYamlSchemaValidation, brief.source.schemaValidation);

  const validPackage = spawnSync(process.execPath, [PACKAGE_VALIDATOR, '--dir', adaptedOut, '--json'], { encoding: 'utf8' });
  assert.equal(validPackage.status, 0, validPackage.stderr || validPackage.stdout);
  const validPackageWithSource = spawnSync(process.execPath, [PACKAGE_VALIDATOR, '--dir', adaptedOut, '--source-root', fixture('valid-split'), '--json'], { encoding: 'utf8' });
  assert.equal(validPackageWithSource.status, 0, validPackageWithSource.stderr || validPackageWithSource.stdout);
  const changedSource = path.join(tmp, 'changed-source');
  fs.cpSync(fixture('valid-split'), changedSource, { recursive: true });
  const changedHomePath = path.join(changedSource, 'Src', 'Home.pa.yaml');
  fs.writeFileSync(changedHomePath, fs.readFileSync(changedHomePath, 'utf8').replace('="Orders"', '="Changed Orders"'));
  const mismatchedSource = spawnSync(process.execPath, [PACKAGE_VALIDATOR, '--dir', adaptedOut, '--source-root', changedSource, '--json'], { encoding: 'utf8' });
  assert.equal(mismatchedSource.status, 1);
  assert.match(JSON.parse(mismatchedSource.stdout).errors.join('\n'), /sourceTreeSha256 differs/);
  const changedSidecarSource = path.join(tmp, 'changed-sidecar-source');
  fs.cpSync(fixture('valid-split'), changedSidecarSource, { recursive: true });
  fs.mkdirSync(path.join(changedSidecarSource, 'References'), { recursive: true });
  fs.writeFileSync(path.join(changedSidecarSource, 'References', 'Themes.json'), JSON.stringify({
    CurrentTheme: 'changed-theme',
    CustomThemes: [],
  }));
  const mismatchedSidecar = spawnSync(process.execPath, [PACKAGE_VALIDATOR, '--dir', adaptedOut, '--source-root', changedSidecarSource, '--json'], { encoding: 'utf8' });
  assert.equal(mismatchedSidecar.status, 1);
  const mismatchedSidecarErrors = JSON.parse(mismatchedSidecar.stdout).errors.join('\n');
  assert.match(mismatchedSidecarErrors, /sourceInputSha256 differs/);
  assert.doesNotMatch(mismatchedSidecarErrors, /sourceTreeSha256 differs/);
  const pluginInputPath = path.join(adaptedOut, 'mobile-plugin-input.json');
  delete pluginInput.source.powerAppsYamlSchemaValidation;
  fs.writeFileSync(pluginInputPath, JSON.stringify(pluginInput, null, 2));
  const missingPackageAttestation = spawnSync(process.execPath, [PACKAGE_VALIDATOR, '--dir', adaptedOut, '--json'], { encoding: 'utf8' });
  assert.equal(missingPackageAttestation.status, 1);
  assert.match(JSON.parse(missingPackageAttestation.stdout).errors.join('\n'), /powerAppsYamlSchemaValidation is missing/);
  pluginInput.source.powerAppsYamlSchemaValidation = { ...brief.source.schemaValidation, sha256: '0'.repeat(64) };
  fs.writeFileSync(pluginInputPath, JSON.stringify(pluginInput, null, 2));
  const tamperedPackageAttestation = spawnSync(process.execPath, [PACKAGE_VALIDATOR, '--dir', adaptedOut, '--json'], { encoding: 'utf8' });
  assert.equal(tamperedPackageAttestation.status, 1);
  assert.match(JSON.parse(tamperedPackageAttestation.stdout).errors.join('\n'), /sha256 must equal/);

  const tamperedBriefPath = path.join(tmp, 'brief-without-attestation.json');
  const tamperedBrief = JSON.parse(JSON.stringify(brief));
  delete tamperedBrief.source.schemaValidation;
  fs.writeFileSync(tamperedBriefPath, JSON.stringify(tamperedBrief));
  const rejectedAdaptation = spawnSync(process.execPath, [
    ADAPTER,
    '--input', tamperedBriefPath,
    '--screens-dir', path.join(validOut, 'screens'),
    '--out-dir', path.join(tmp, 'tampered-adapted-out'),
  ], { encoding: 'utf8' });
  assert.equal(rejectedAdaptation.status, 1);
  assert.match(rejectedAdaptation.stderr, /source\.schemaValidation is missing/i);
  assert.doesNotMatch(rejectedAdaptation.stderr, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const invalidOut = path.join(tmp, 'invalid-out');
  const invalid = spawnSync(process.execPath, [EXTRACTOR, '--extracted', fixture('invalid-unknown-field'), '--out', invalidOut], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /FutureSchemaField|unknown field/);
  assert.equal(fs.existsSync(invalidOut), false, 'schema failure must happen before output creation');
});

test('nested official modules are extracted from the same validated inventory', (t) => {
  const root = makeTemp(t, 'power-apps-yaml-nested-');
  fs.mkdirSync(path.join(root, 'Src', 'Screens'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Src', 'Screens', 'Home.pa.yaml'), 'Screens:\n  Home:\n    Children: []\n');
  const output = path.join(root, 'brief');
  const result = spawnSync(process.execPath, [EXTRACTOR, '--extracted', root, '--out', output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const brief = JSON.parse(fs.readFileSync(path.join(output, 'app-brief.json'), 'utf8'));
  assert.deepEqual(brief.screens.map((screen) => screen.name), ['Home']);
});
