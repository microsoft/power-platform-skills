'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseManifest, lintManifest, diffManifests, findManifests } = require('../lib/pcf-manifest.js');
const { loadMatrix } = require('../lib/pcf-matrix.js');
const { planScaffold } = require('../lib/pcf-scaffold.js');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'pcf-manifests');
const MATRIX = loadMatrix();
const REACT_BASELINE = MATRIX.platformLibraries.React.recommendedBaseline.version;
const FLUENT_V8 = MATRIX.platformLibraries.Fluent.documentedDeclarations.find((item) => item.family === 'v8').version;
const FLUENT_V9 = MATRIX.platformLibraries.Fluent.recommendedBaseline.version;
const FLUENT_OUT_OF_RANGE = MATRIX.baselineExclusions[0].version;

function m(controlAttrs = {}, inner = '') {
  const attrs = {
    namespace: 'Contoso.Controls',
    constructor: 'StarRating',
    version: '1.0.0',
    'display-name-key': 'StarRating',
    'description-key': 'StarRating description',
    ...controlAttrs,
  };
  const rendered = Object.entries(attrs)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ` ${key}="${String(value)}"`)
    .join('');
  return `<?xml version="1.0" encoding="utf-8" ?><manifest><control${rendered}>${inner}</control></manifest>`;
}

function lint(xml, options = {}) {
  const parsed = parseManifest(xml);
  assert.deepEqual(parsed.errors, []);
  return lintManifest(parsed.model, { matrix: MATRIX, ...options });
}

function codes(result) {
  return [...result.errors, ...result.warnings].map((finding) => finding.code).sort();
}

function assertHas(result, code, severity = null) {
  const all = [...result.errors, ...result.warnings];
  const finding = all.find((item) => item.code === code);
  assert.ok(finding, `${code} missing from ${all.map((item) => item.code).join(', ')}`);
  assert.match(finding.message, /.+/);
  assert.match(finding.fix || finding.message, /fix|add|remove|set|use|choose|guard|bump|rename|change|declare|replace|exactly|increase/i);
  if (severity) assert.equal(finding.severity, severity);
}

test('parseManifest extracts the PCF manifest model shape', () => {
  const xml = m(
    { 'control-type': 'virtual' },
    `
    <external-service-usage enabled="true"><domain>api.contoso.com</domain></external-service-usage>
    <type-group name="numbers"><type>Whole.None</type><type>Currency</type></type-group>
    <property name="value" display-name-key="Value" description-key="Value" of-type-group="numbers" usage="bound" required="true" default-value="1" />
    <data-set name="rows" cds-data-set-options="displayCommandBar:true">
      <property-set name="amount" usage="bound" of-type="Currency" required="false" />
    </data-set>
    <resources>
      <code path="index.ts" order="1" />
      <css path="css/control.css" order="1" />
      <resx path="strings/control.1033.resx" version="1.0.0" />
      <img path="img/icon.svg" />
      <platform-library name="React" version="${REACT_BASELINE}" />
      <dependency type="css" name="theme" />
    </resources>
    <feature-usage><uses-feature name="WebAPI" required="false" /></feature-usage>
    <event name="OnChange" />
  `,
  );

  const { model, errors } = parseManifest(xml);

  assert.deepEqual(errors, []);
  assert.deepEqual(model.control, {
    namespace: 'Contoso.Controls',
    constructor: 'StarRating',
    version: '1.0.0',
    displayNameKey: 'StarRating',
    descriptionKey: 'StarRating description',
    controlType: 'virtual',
  });
  assert.deepEqual(model.properties, [{
    name: 'value',
    displayNameKey: 'Value',
    usage: 'bound',
    ofType: undefined,
    ofTypeGroup: 'numbers',
    required: true,
    defaultValue: '1',
  }]);
  assert.deepEqual(model.typeGroups, { numbers: ['Whole.None', 'Currency'] });
  assert.deepEqual(model.dataSets, [{
    name: 'rows',
    cdsDataSetOptions: 'displayCommandBar:true',
    propertySets: [{ name: 'amount', usage: 'bound', ofType: 'Currency', ofTypeGroup: undefined, required: false }],
  }]);
  assert.deepEqual(model.resources.code, [{ path: 'index.ts' }]);
  assert.deepEqual(model.resources.css, [{ path: 'css/control.css' }]);
  assert.deepEqual(model.resources.resx, [{ path: 'strings/control.1033.resx' }]);
  assert.deepEqual(model.resources.img, [{ path: 'img/icon.svg' }]);
  assert.deepEqual(model.resources.platformLibraries, [{ name: 'React', version: REACT_BASELINE }]);
  assert.deepEqual(model.resources.dependencies, [{ type: 'css', name: 'theme' }]);
  assert.deepEqual(model.features, [{ name: 'WebAPI', required: false }]);
  assert.deepEqual(model.externalServiceUsage, { enabled: true, domains: ['api.contoso.com'] });
  assert.deepEqual(model.events, [{ name: 'OnChange' }]);
});

test('parseManifest reports missing or malformed XML control roots', () => {
  assertHas({ errors: parseManifest('<manifest></manifest>').errors, warnings: [] }, 'PCF_NO_CONTROL', 'error');
  assertHas({ errors: parseManifest('<manifest><control></manifest>').errors, warnings: [] }, 'PCF_NO_CONTROL', 'error');
});

test('lintManifest reports a missing constructor attribute instead of reading Object.prototype.constructor', () => {
  assertHas(lint(m({ constructor: undefined }, '<resources><code path="index.ts" /></resources>')), 'PCF_ATTR_MISSING', 'error');
});

const lintCases = [
  ['PCF_ATTR_MISSING', m({ namespace: undefined }, '<resources><code path="index.ts" /></resources>'), 'error', ['model']],
  ['PCF_VERSION_FORMAT', m({ version: '1.0' }, '<resources><code path="index.ts" /></resources>'), 'error', ['model']],
  ['PCF_KEY_APOSTROPHE', m({ 'display-name-key': "Don't" }, '<resources><code path="index.ts" /></resources>'), 'warning', ['model']],
  ['PCF_CODE_RESOURCE', m({}, '<resources><code path="a.ts" /><code path="b.ts" /></resources>'), 'error', ['model']],
  ['PCF_PROPERTY_DUPLICATE', m({}, '<property name="value" usage="bound" of-type="SingleLine.Text" /><property name="value" usage="input" of-type="SingleLine.Text" /><resources><code path="index.ts" /></resources>'), 'error', ['model']],
  ['PCF_PROPERTY_USAGE', m({}, '<property name="value" usage="bad" of-type="SingleLine.Text" /><resources><code path="index.ts" /></resources>'), 'error', ['model']],
  ['PCF_PROPERTY_TYPE_MISSING', m({}, '<property name="value" usage="bound" /><resources><code path="index.ts" /></resources>'), 'error', ['model']],
  ['PCF_TYPE_GROUP_UNKNOWN', m({}, '<property name="value" usage="bound" of-type-group="missing" /><resources><code path="index.ts" /></resources>'), 'error', ['model']],
  ['PCF_TYPE_UNSUPPORTED', m({}, '<property name="file" usage="bound" of-type="File" /><resources><code path="index.ts" /></resources>'), 'error', ['model']],
  ['PCF_DEFAULT_ON_BOUND', m({}, '<property name="value" usage="bound" of-type="SingleLine.Text" default-value="x" /><resources><code path="index.ts" /></resources>'), 'error', ['model']],
  ['PCF_OBJECT_NOT_OUTPUT', m({}, '<property name="value" usage="input" of-type="Object" /><resources><code path="index.ts" /></resources>'), 'error', ['model']],
  ['PCF_PROPERTYSET_USAGE', m({}, '<data-set name="rows"><property-set name="value" usage="bad" of-type="SingleLine.Text" /></data-set><resources><code path="index.ts" /></resources>'), 'error', ['model']],
  ['PCF_TYPE_UNSUPPORTED', m({}, '<data-set name="rows"><property-set name="file" usage="bound" of-type="File" /></data-set><resources><code path="index.ts" /></resources>'), 'error', ['model']],
  ['PCF_DATASET_NO_PROPERTYSET', m({}, '<data-set name="rows"></data-set><resources><code path="index.ts" /></resources>'), 'warning', ['model']],
  ['PCF_FEATURE_DUPLICATE', m({}, '<resources><code path="index.ts" /></resources><feature-usage><uses-feature name="WebAPI" /><uses-feature name="WebAPI" /></feature-usage>'), 'error', ['model']],
  ['PCF_VIRTUAL_NO_REACT', m({ 'control-type': 'virtual' }, '<resources><code path="index.ts" /></resources>'), 'warning', ['model']],
  ['PCF_PLATFORM_LIB_UNKNOWN', m({}, `<resources><code path="index.ts" /><platform-library name="Vue" version="${REACT_BASELINE}" /></resources>`), 'error', ['model']],
  ['PCF_PLATFORM_LIB_RANGE', m({}, `<resources><code path="index.ts" /><platform-library name="Fluent" version="${FLUENT_OUT_OF_RANGE}" /></resources>`), 'warning', ['model']],
  ['PCF_PLATFORM_LIB_KNOWN_BAD', m({ 'control-type': 'virtual' }, `<resources><code path="index.ts" /><platform-library name="React" version="${REACT_BASELINE}" /><platform-library name="Fluent" version="${FLUENT_OUT_OF_RANGE}" /></resources>`), 'error', ['model']],
  ['PCF_FLUENT_8_AND_9', m({}, `<resources><code path="index.ts" /><platform-library name="Fluent" version="${FLUENT_V8}" /><platform-library name="Fluent" version="${FLUENT_V9}" /></resources>`), 'error', ['model']],
  ['PCF_PAGES_PLATFORM_LIBRARY', m({}, `<resources><code path="index.ts" /><platform-library name="React" version="${REACT_BASELINE}" /></resources>`), 'error', ['pages']],
  ['PCF_PAGES_VIRTUAL', m({ 'control-type': 'virtual' }, `<resources><code path="index.ts" /><platform-library name="React" version="${REACT_BASELINE}" /></resources>`), 'error', ['pages']],
  ['PCF_PAGES_REQUIRED_FEATURE', m({}, '<resources><code path="index.ts" /></resources><feature-usage><uses-feature name="WebAPI" required="true" /></feature-usage>'), 'error', ['pages']],
  ['PCF_PAGES_FEATURE_OPTIONAL', m({}, '<resources><code path="index.ts" /></resources><feature-usage><uses-feature name="Device.pickFile" required="false" /></feature-usage>'), 'warning', ['pages']],
  ['PCF_PAGES_FIELD_TYPE', m({}, '<property name="value" usage="bound" of-type="Object" /><resources><code path="index.ts" /></resources>'), 'error', ['pages']],
  ['PCF_PAGES_DATASET_TYPES', m({}, '<data-set name="rows"><property-set name="value" usage="bound" of-type="SingleLine.Text" /></data-set><resources><code path="index.ts" /></resources>'), 'warning', ['pages']],
  ['PCF_PAGES_EVENTS', m({}, '<resources><code path="index.ts" /></resources><event name="OnChange" />'), 'warning', ['pages']],
  ['PCF_EXTERNAL_SERVICE', m({}, '<external-service-usage enabled="true"><domain>api.contoso.com</domain></external-service-usage><resources><code path="index.ts" /></resources>'), 'warning', ['model']],
];

for (const [code, xml, severity, hosts] of lintCases) {
  test(`lintManifest reports ${code}`, () => {
    assertHas(lint(xml, { hosts }), code, severity);
  });
}

test('pac pcf init field standard template lints clean for model and pages', () => {
  const xml = fs.readFileSync(path.join(FIXTURES, 'field-standard.xml'), 'utf8');
  const model = parseManifest(xml).model;

  assert.deepEqual(lintManifest(model, { hosts: ['model'], matrix: MATRIX }), { ok: true, errors: [], warnings: [] });
  assert.deepEqual(lintManifest(model, { hosts: ['pages'], matrix: MATRIX }), { ok: true, errors: [], warnings: [] });
});

test('pac pcf init react template with the excluded Fluent version reports the observed rejection', () => {
  const xml = fs.readFileSync(path.join(FIXTURES, 'field-virtual.xml'), 'utf8');

  assertHas(lint(xml, { hosts: ['model'] }), 'PCF_PLATFORM_LIB_KNOWN_BAD', 'error');
});

test('diffManifests reports breaking changes and unchanged version warnings', () => {
  const before = parseManifest(m({}, '<property name="value" usage="input" of-type="SingleLine.Text" /><resources><code path="index.ts" /></resources>')).model;
  const after = parseManifest(m({}, '<property name="value" usage="input" of-type="SingleLine.Text" required="true" /><resources><code path="index.ts" /></resources>')).model;
  const diff = diffManifests(before, after);

  assert.deepEqual(diff.breaking.map((finding) => finding.code), ['PCF_DIFF_REQUIRED_ADDED']);
  assert.deepEqual(diff.compatible.map((finding) => finding.code), ['PCF_DIFF_VERSION_NOT_BUMPED']);
});

const diffCases = [
  ['PCF_DIFF_PROPERTY_REMOVED', '<property name="value" usage="input" of-type="SingleLine.Text" />', ''],
  ['PCF_DIFF_TYPE_CHANGED', '<property name="value" usage="input" of-type="SingleLine.Text" />', '<property name="value" usage="input" of-type="Whole.None" />'],
  ['PCF_DIFF_USAGE_CHANGED', '<property name="value" usage="input" of-type="SingleLine.Text" />', '<property name="value" usage="bound" of-type="SingleLine.Text" />'],
  ['PCF_DIFF_CONTROL_TYPE_CHANGED', '', '', { 'control-type': 'standard' }, { 'control-type': 'virtual' }],
  ['PCF_DIFF_IDENTITY_CHANGED', '', '', { namespace: 'Contoso.Controls' }, { namespace: 'Contoso.Other' }],
];

for (const [code, beforeInner, afterInner, beforeAttrs = {}, afterAttrs = {}] of diffCases) {
  test(`diffManifests reports ${code}`, () => {
    const before = parseManifest(m(beforeAttrs, `${beforeInner}<resources><code path="index.ts" /></resources>`)).model;
    const after = parseManifest(m(afterAttrs, `${afterInner}<resources><code path="index.ts" /></resources>`)).model;
    assert.ok(diffManifests(before, after).breaking.some((finding) => finding.code === code));
  });
}

function generatedDatasetModel() {
  const plan = planScaffold({ template: 'dataset-standard', namespace: 'Contoso.Controls', name: 'DatasetGate' });
  const xml = plan.files.find((file) => file.relPath === path.join('DatasetGate', 'ControlManifest.Input.xml')).content;
  const parsed = parseManifest(xml);
  assert.deepEqual(parsed.errors, []);
  return parsed.model;
}

const datasetDiffCases = [
  ['dataset removal', 'PCF_DIFF_PROPERTY_REMOVED', (model) => { model.dataSets = []; }, /Dataset.*sampleDataSet/],
  ['dataset rename', 'PCF_DIFF_PROPERTY_REMOVED', (model) => { model.dataSets[0].name = 'renamedRows'; }, /Dataset.*sampleDataSet/],
  ['property-set removal', 'PCF_DIFF_PROPERTY_REMOVED', (model) => { model.dataSets[0].propertySets = []; }, /sampleDataSet.*sampleProperty/],
  ['property-set rename', 'PCF_DIFF_PROPERTY_REMOVED', (model) => { model.dataSets[0].propertySets[0].name = 'renamedColumn'; }, /sampleDataSet.*sampleProperty/],
  ['property-set type change', 'PCF_DIFF_TYPE_CHANGED', (model) => { model.dataSets[0].propertySets[0].ofType = 'Currency'; }, /sampleDataSet.*sampleProperty.*SingleLine\.Text/],
  ['property-set usage change', 'PCF_DIFF_USAGE_CHANGED', (model) => { model.dataSets[0].propertySets[0].usage = 'input'; }, /sampleDataSet.*sampleProperty.*bound.*input/],
  ['property-set becoming required', 'PCF_DIFF_REQUIRED_ADDED', (model) => { model.dataSets[0].propertySets[0].required = true; }, /sampleDataSet.*sampleProperty/],
  ['new required property-set', 'PCF_DIFF_REQUIRED_ADDED', (model) => {
    model.dataSets[0].propertySets.push({ name: 'requiredColumn', ofType: 'SingleLine.Text', usage: 'bound', required: true });
  }, /sampleDataSet.*requiredColumn/],
];

for (const [name, code, change, message] of datasetDiffCases) {
  test(`diffManifests detects ${name} after a version bump`, () => {
    const before = generatedDatasetModel();
    const after = structuredClone(before);
    after.control.version = '0.0.2';
    change(after);

    const diff = diffManifests(before, after);

    assert.deepEqual(diff.breaking.map((finding) => finding.code), [code]);
    assert.equal(diff.breaking[0].severity, 'error');
    assert.match(diff.breaking[0].message, message);
    assert.deepEqual(diff.compatible, []);
  });
}

test('diffManifests compares resolved property-set type-group members rather than group names', () => {
  const before = generatedDatasetModel();
  before.typeGroups.columns = ['SingleLine.Text', 'SingleLine.TextArea'];
  const propertySet = before.dataSets[0].propertySets[0];
  propertySet.ofType = undefined;
  propertySet.ofTypeGroup = 'columns';
  const after = structuredClone(before);
  after.control.version = '0.0.2';
  after.typeGroups.columns = ['SingleLine.Text'];

  const diff = diffManifests(before, after);

  assert.deepEqual(diff.breaking.map((finding) => finding.code), ['PCF_DIFF_TYPE_CHANGED']);
  assert.match(diff.breaking[0].message, /sampleDataSet.*sampleProperty.*SingleLine\.TextArea/);
  assert.deepEqual(diff.compatible, []);

  const renamed = structuredClone(before);
  renamed.control.version = '0.0.2';
  renamed.typeGroups.renamedColumns = renamed.typeGroups.columns;
  delete renamed.typeGroups.columns;
  renamed.dataSets[0].propertySets[0].ofTypeGroup = 'renamedColumns';
  assert.deepEqual(diffManifests(before, renamed).breaking, [], 'a group rename preserving support is compatible');

  const expanded = structuredClone(before);
  expanded.control.version = '0.0.2';
  expanded.typeGroups.columns.push('SingleLine.Email');
  expanded.dataSets[0].propertySets.push({ name: 'optionalColumn', ofType: 'SingleLine.Text', usage: 'bound', required: false });
  assert.deepEqual(diffManifests(before, expanded).breaking, [], 'additional type support and optional columns are compatible');
});

test('diffManifests scopes same-named property-sets to their dataset', () => {
  const before = generatedDatasetModel();
  const second = structuredClone(before.dataSets[0]);
  second.name = 'secondaryRows';
  before.dataSets.push(second);
  const after = structuredClone(before);
  after.control.version = '0.0.2';
  after.dataSets[1].propertySets[0].ofType = 'Currency';

  const diff = diffManifests(before, after);

  assert.deepEqual(diff.breaking.map((finding) => finding.code), ['PCF_DIFF_TYPE_CHANGED']);
  assert.match(diff.breaking[0].message, /secondaryRows.*sampleProperty/);
  assert.doesNotMatch(diff.breaking[0].message, /sampleDataSet/);
});


test('diffManifests does not warn when a changed manifest bumps the version', () => {
  const before = parseManifest(m({}, '<resources><code path="index.ts" /></resources>')).model;
  const after = parseManifest(m({ version: '1.0.1' }, '<property name="optional" usage="input" of-type="SingleLine.Text" /><resources><code path="index.ts" /></resources>')).model;

  assert.deepEqual(diffManifests(before, after).compatible, []);
});

test('diffManifests reports a breaking change when a property type-group removes a supported type', () => {
  const before = parseManifest(m({}, '<type-group name="numbers"><type>Whole.None</type><type>Currency</type></type-group><property name="value" usage="bound" of-type-group="numbers" /><resources><code path="index.ts" /></resources>')).model;
  const after = parseManifest(m({ version: '1.0.1' }, '<type-group name="numbers"><type>SingleLine.Text</type></type-group><property name="value" usage="bound" of-type-group="numbers" /><resources><code path="index.ts" /></resources>')).model;

  const diff = diffManifests(before, after);

  assert.ok(diff.breaking.some((finding) => finding.code === 'PCF_DIFF_TYPE_CHANGED' && /Whole\.None|Currency/.test(finding.message)));
});

test('diffManifests warns when the manifest version decreases', () => {
  const before = parseManifest(m({ version: '1.0.1' }, '<resources><code path="index.ts" /></resources>')).model;
  const after = parseManifest(m({}, '<resources><code path="index.ts" /></resources>')).model;

  assert.deepEqual(diffManifests(before, after).compatible.map((finding) => finding.code), ['PCF_DIFF_VERSION_NOT_BUMPED']);
});

test('findManifests recursively finds manifests while skipping generated output folders', () => {
  const files = new Map([
    ['project\\ControlManifest.Input.xml', '<manifest />'],
    ['project\\node_modules\\x\\ControlManifest.Input.xml', '<manifest />'],
    ['project\\src\\ControlManifest.Input.xml', '<manifest />'],
    ['project\\src\\generated\\ControlManifest.Input.xml', '<manifest />'],
  ]);
  const dirs = new Map([
    ['project', ['ControlManifest.Input.xml', 'node_modules', 'src']],
    ['project\\node_modules', ['x']],
    ['project\\node_modules\\x', ['ControlManifest.Input.xml']],
    ['project\\src', ['ControlManifest.Input.xml', 'generated']],
    ['project\\src\\generated', ['ControlManifest.Input.xml']],
  ]);
  const fakePath = path.win32;
  const fakeFs = {
    readdirSync(dir, opts) {
      assert.equal(opts.withFileTypes, true);
      return (dirs.get(dir) || []).map((name) => ({
        name,
        isDirectory: () => dirs.has(fakePath.join(dir, name)),
        isFile: () => files.has(fakePath.join(dir, name)),
      }));
    },
  };

  assert.deepEqual(findManifests('project', { fs: fakeFs, path: fakePath }), [
    'project\\ControlManifest.Input.xml',
    'project\\src\\ControlManifest.Input.xml',
  ]);
});
