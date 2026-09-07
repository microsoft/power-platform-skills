'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { compilePersistenceContract } = require('../compile-persistence-contract');
const { generatePrototype } = require('../lib/prototype-generator');
const { revision } = require('../lib/prototype-files');
const { projectDataAccess, validateDataAccess } = require('../lib/prototype-registry');
const { projectSamplePhoto, resolveImagePresentation, validateImageAsset } = require('../lib/prototype-images');
const { sampleImageAsset } = require('./helpers/prototype-image-fixtures');
const { configurePrototypeAuthoring } = require('../lib/prototype-authoring');

const PLUGIN = path.resolve(__dirname, '../..');
const MODULES = process.env.MOBILE_PROTOTYPE_TEMPLATE_MODULES && path.resolve(process.env.MOBILE_PROTOTYPE_TEMPLATE_MODULES);
const installed = { skip: !MODULES && 'Set MOBILE_PROTOTYPE_TEMPLATE_MODULES to installed template dependencies for native/API/type checks' };

function write(root, file, value) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function photo(asset = sampleImageAsset()) {
  return projectSamplePhoto(asset, { conceptId: 'destination', recordId: 'fronalpstock', field: 'photo' });
}

function project(t, modules = MODULES) {
  const root = path.join(path.resolve(PLUGIN, '../..'), `.prototype-images-work-${crypto.randomUUID()}`);
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'package.json', fs.readFileSync(path.join(PLUGIN, 'template/package.json'), 'utf8'));
  write(root, 'tamagui.config.ts', fs.readFileSync(path.join(PLUGIN, 'template/tamagui.config.ts'), 'utf8'));
  if (modules) fs.symlinkSync(modules, path.join(root, 'node_modules'), 'dir');
  const appInstanceId = '22222222-2222-4222-8222-222222222222';
  write(root, 'app.json', { expo: { extra: { telemetry: { appInstanceId } } } });
  const persistence = compilePersistenceContract({
    dataEntities: [{ name: 'Destination', role: 'primary', realization: 'local-configuration' }],
  }, {
    schemaVersion: 1, connectors: [], nativeCapabilities: [],
    conceptOwners: [{ conceptId: 'destination', owner: 'local', reason: 'Local sample destinations for the approved prototype.' }],
  });
  const asset = sampleImageAsset();
  const facts = {
    schemaVersion: 1, contractType: 'scenario-facts',
    scopeRevision: persistence.scopeRevision, persistenceRevision: persistence.persistenceRevision,
    records: [{
      id: 'fronalpstock', conceptId: 'destination',
      fields: { name: 'Fronalpstock panorama trail', photo: { mediaAssetKey: asset.key } },
    }],
    relationships: [], scenarios: [], mediaAssets: [asset], screenBindings: [], invariants: [],
  };
  facts.scenarioRevision = revision(facts);
  write(root, '.tmp/scenario-facts.json', facts);
  write(root, '.tmp/persistence-contract.json', persistence);
  write(root, '.tmp/prototype-domain.json', {
    schemaVersion: 1, appInstanceId, schemaVersionNumber: 1,
    entities: [{
      id: 'Destination', label: 'Destination',
      fields: [{ id: 'name', label: 'Name', type: 'text', required: true }, { id: 'photo', label: 'Photo', type: 'photo' }],
      operations: ['list', 'get', 'create', 'update', 'delete'],
    }],
    actions: [],
  });
  write(root, '.tmp/prototype-bindings.json', { schemaVersion: 1, entities: [{ entityId: 'Destination', conceptId: 'destination' }] });
  write(root, '.tmp/prototype-rules.json', { schemaVersion: 1, rules: [] });
  const generated = generatePrototype(root);
  return { root, generated, facts };
}

test('image presentation uses canonical accessibility/provenance and preserves captured local sources', () => {
  const reference = photo();
  const result = resolveImagePresentation(reference, 'Do not replace the canonical alt', 'Do not replace the canonical fallback');
  assert.equal(result.uri, reference.uri);
  assert.equal(result.alt, reference.sample.asset.alt);
  assert.equal(result.fallback, reference.sample.asset.fallback);
  assert.deepEqual(result.asset, reference.sample.asset);
  for (const uri of ['file:///documents/capture.jpg', 'content://media/image/42']) {
    const capture = resolveImagePresentation({ status: 'ready', id: 'capture', uri }, 'Captured photo', 'Capture unavailable');
    assert.equal(capture.uri, uri);
    assert.equal(capture.alt, 'Captured photo');
    assert.equal(capture.fallback, 'Capture unavailable');
    assert.equal(capture.asset, null);
  }
  for (const input of [
    null, undefined, { status: 'pending' }, { status: 'cancelled' }, { status: 'failed', message: 'Private native details' },
    { status: 'ready', id: reference.id, uri: reference.uri },
    { ...reference, uri: 'https://unlicensed.invalid/photo.jpg' },
    { status: 'ready', id: 'invalid', uri: 'javascript:alert(1)' },
    { status: 'ready', id: 'inline', uri: 'data:image/png;base64,AA==' },
  ]) {
    assert.deepEqual(resolveImagePresentation(input, 'Photo description', 'Photo unavailable'), {
      uri: null, asset: null, alt: 'Photo description', fallback: 'Photo unavailable',
    });
  }
});

test('generated image files and registry are deterministic app-owned outputs, not another fixture store', (t) => {
  const { root, generated, facts } = project(t);
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  assert.equal(generatePrototype(root, { check: true }).ok, true);
  const imagePath = 'src/data/PrototypeImage.tsx';
  assert.ok(generated.files.includes(imagePath));
  assert.match(read('src/data/index.ts'), /export \* from '\.\/PrototypeImage'/);
  assert.equal(read('src/data/repositories/prototype-images.js'), fs.readFileSync(path.join(PLUGIN, 'scripts/lib/prototype-images.js'), 'utf8'));
  const registry = JSON.parse(read('.tmp/data-access-registry.json'));
  const projection = projectDataAccess(registry, ['Destination']);
  const signature = 'PrototypeImage(props: PrototypeImageProps): React.JSX.Element';
  assert.equal(projection.media.imageModule, '@/data/PrototypeImage');
  assert.ok(projection.media.signatures.includes(signature));
  assert.equal(validateDataAccess(registry, projection, [signature]).media.imageModule, '@/data/PrototypeImage');
  assert.deepEqual(JSON.parse(read('.tmp/scenario-facts.json')), facts);
  assert.equal(fs.existsSync(path.join(root, 'power.config.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'src/generated')), false);
  assert.equal(fs.existsSync(path.join(root, 'assets')), false);
  assert.doesNotMatch(read(imagePath), /fetch\(|fixtures|source\.unsplash|picsum/);
  assert.doesNotMatch(read(imagePath), /onLoadEnd/);
  const before = Object.fromEntries(generated.files.map((file) => [file, read(file)]));
  generatePrototype(root);
  for (const [file, content] of Object.entries(before)) assert.equal(read(file), content);
  fs.appendFileSync(path.join(root, imagePath), '\n// App-owned edit\n');
  assert.throws(() => generatePrototype(root), /changed outside its compiler/);
});

// Drive the real generated component's callbacks with host primitives and a
// minimal hook boundary. No test renderer/native binary or new dependency is
// introduced; the separate compiler test uses the actual installed RN types.
function imageComponent(root) {
  const requireFromApp = Module.createRequire(path.join(root, 'package.json'));
  const ts = requireFromApp('typescript');
  const React = requireFromApp('react');
  let slots = [];
  let cursor = 0;
  let key;
  let tree;
  let failCredit = false;
  const opened = [];
  const useState = (initial) => {
    const slot = cursor++;
    const mountedSlots = slots;
    if (!(slot in mountedSlots)) mountedSlots[slot] = initial;
    return [mountedSlots[slot], (next) => { mountedSlots[slot] = typeof next === 'function' ? next(mountedSlots[slot]) : next; }];
  };
  const filename = path.join(root, 'src/data/PrototypeImage.tsx');
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const compiled = new Module(filename);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = compiled.require.bind(compiled);
  compiled.require = (specifier) => {
    if (specifier === 'react') return { ...React, useState };
    if (specifier === 'tamagui') return { useTheme: () => ({
      color2: { get: () => 'white' }, color11: { get: () => 'black' }, color12: { get: () => 'black' },
    }) };
    if (specifier === 'react-native') return {
      ActivityIndicator: 'ActivityIndicator', Image: 'Image', Pressable: 'Pressable', Text: 'Text', View: 'View',
      StyleSheet: { create: (styles) => styles, absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } },
      Linking: { async openURL(url) { opened.push(url); if (failCredit) throw new Error('Unavailable'); } },
    };
    return originalRequire(specifier);
  };
  compiled._compile(source, filename);
  const nodes = () => {
    const result = [];
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      result.push(node);
      visit(node.props?.children);
    };
    visit(tree);
    return result;
  };
  return {
    opened,
    failCredit() { failCredit = true; },
    render(props) {
      const frame = compiled.exports.PrototypeImage(props);
      if (frame.key !== key) { key = frame.key; slots = []; }
      cursor = 0;
      tree = frame.type(frame.props);
      return tree;
    },
    all(type) { return nodes().filter((node) => node.type === type); },
    roles(role) { return nodes().filter((node) => node.props?.accessibilityRole === role); },
  };
}

test('generated image callbacks show loading, accessible success and credited failure without success-shaped errors', installed, async (t) => {
  const { root } = project(t);
  const h = imageComponent(root);
  const reference = photo();
  const props = { photo: reference, alt: 'Caller label' };
  h.render(props);
  assert.equal(h.all('Image')[0].props.source.uri, reference.uri);
  assert.equal(h.all('Image')[0].props.resizeMode, 'contain');
  assert.equal(h.all('Image')[0].props.accessible, false);
  assert.equal(h.all('ActivityIndicator').length, 1);
  const pending = h.roles('image').find((node) => node.type === 'View');
  assert.equal(pending.props.accessibilityState.busy, true);
  assert.match(pending.props.accessibilityLabel, /Panoramic.*Loading image/);
  const callbacks = h.all('Image')[0].props;
  callbacks.onLoadStart();
  h.render(props);
  assert.equal(h.all('ActivityIndicator').length, 1);
  callbacks.onLoad();
  h.render(props);
  assert.equal(h.all('ActivityIndicator').length, 0);
  assert.equal(h.all('Image')[0].props.accessible, true);
  assert.equal(h.all('Image')[0].props.accessibilityLabel, reference.sample.asset.alt);
  assert.ok(h.all('Text').some((node) => JSON.stringify(node.props.children).includes('Hannes Röst')));
  assert.ok(h.all('Text').some((node) => node.props.children === reference.sample.asset.provenance.changes));
  assert.equal(h.roles('link').length, 2);
  h.roles('link')[0].props.onPress();
  h.roles('link')[1].props.onPress();
  assert.deepEqual(h.opened, [reference.sample.asset.provenance.sourcePage, reference.sample.asset.provenance.licenseUrl]);
  callbacks.onError({ nativeEvent: { error: 'Sensitive platform/network detail' } });
  callbacks.onLoad(); // A late success must not undo a reported failure.
  h.render(props);
  assert.equal(h.all('Image').length, 0);
  assert.equal(h.all('ActivityIndicator').length, 0);
  assert.match(h.roles('image')[0].props.accessibilityLabel, /Mountain panorama unavailable/);
  assert.equal(h.roles('image')[0].props.accessibilityState.busy, false);
  assert.equal(h.roles('link').length, 2);
  assert.equal(h.all('Text').some((node) => String(node.props.children).includes('Sensitive')), false);
  h.failCredit();
  h.roles('link')[0].props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  h.render(props);
  assert.equal(h.roles('alert').length, 1);
});

test('generated image state resets on source/record changes and captured files never borrow sample attribution', installed, (t) => {
  const { root } = project(t);
  const h = imageComponent(root);
  const initial = photo();
  h.render({ photo: initial, alt: 'Scenery' });
  const old = h.all('Image')[0].props;
  old.onError();
  h.render({ photo: initial, alt: 'Scenery' });
  assert.equal(h.all('Image').length, 0);
  const capture = { status: 'ready', id: 'capture-one', uri: 'file:///documents/candidate-review/capture.jpg' };
  const props = { photo: capture, alt: 'Captured trail photo', fallback: 'Captured photo unavailable' };
  h.render(props);
  old.onLoad(); // The unmounted source cannot mark the candidate capture loaded.
  h.render(props);
  assert.equal(h.all('Image')[0].props.source.uri, capture.uri);
  assert.equal(h.all('ActivityIndicator').length, 1);
  assert.equal(h.roles('link').length, 0);
  h.all('Image')[0].props.onError();
  h.render(props);
  assert.equal(h.roles('image')[0].props.accessibilityLabel, 'Captured trail photo. Captured photo unavailable');
  h.render({ photo: { ...capture, uri: 'content://media/image/42' }, alt: 'Library photo' });
  assert.equal(h.all('Image')[0].props.source.uri, 'content://media/image/42');
  for (const missing of [null, { status: 'cancelled' }, { status: 'failed' }, { status: 'pending' }]) {
    h.render({ photo: missing, alt: 'Photo', fallback: 'No photo selected' });
    assert.equal(h.all('Image').length, 0);
    assert.equal(h.all('ActivityIndicator').length, 0);
    assert.equal(h.roles('image')[0].props.accessibilityLabel, 'Photo. No photo selected');
  }
  h.render({ photo: initial, alt: 'Scenery' });
  h.all('Image')[0].props.onLoad();
  h.render({ photo: initial, alt: 'Scenery' });
  assert.equal(h.all('ActivityIndicator').length, 0);
  const anotherRecord = structuredClone(initial);
  anotherRecord.sample.recordId = 'second-destination';
  h.render({ photo: anotherRecord, alt: 'Scenery' });
  assert.equal(h.all('ActivityIndicator').length, 1);
  anotherRecord.sample.asset.provenance.attributionRequired = false;
  h.render({ photo: anotherRecord, alt: 'Scenery' });
  assert.equal(h.roles('link').length, 2);
});

test('image validation also works with the installed React Native URL implementation without rewriting source identity', installed, (t) => {
  const { root } = project(t);
  const req = Module.createRequire(path.join(root, 'package.json'));
  const babel = req('@babel/core');
  const load = (file, dependencies, globals = {}) => {
    const source = babel.transformSync(fs.readFileSync(path.join(MODULES, 'react-native/Libraries/Blob', file), 'utf8'), {
      babelrc: false, configFile: false,
      plugins: [req.resolve('@babel/plugin-transform-flow-strip-types'), req.resolve('@babel/plugin-transform-modules-commonjs')],
    }).code;
    const module = { exports: {} };
    vm.runInNewContext(source, { module, exports: module.exports, require: (name) => dependencies[name], ...globals });
    return module.exports;
  };
  const parameters = load('URLSearchParams.js', {});
  const native = load('URL.js', { './NativeBlobModule': null, './URLSearchParams': parameters }, { URLSearchParams: parameters.URLSearchParams });
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/data/repositories/prototype-images.js'), 'utf8'), { module, URL: native.URL });
  const reference = photo();
  assert.equal(module.exports.resolveImagePresentation(reference, 'Fallback').uri, reference.uri);
  assert.equal(module.exports.validateImageAsset(reference.sample.asset), reference.sample.asset);
  const fixed = sampleImageAsset();
  // Syntax-only coverage for the existing catalogue's queryless photo URL,
  // not an asserted source/license pairing or another generated fixture.
  fixed.source.value = 'https://images.unsplash.com/photo-1542291026-7eec264c27ff';
  assert.equal(validateImageAsset(fixed), fixed);
  assert.equal(module.exports.validateImageAsset(fixed), fixed);
});

test('canonical repository images, actual screen wiring and gated startup compile together against installed template packages', installed, (t) => {
  const { root, generated, facts } = project(t);
  write(root, 'tsconfig.json', {
    extends: 'expo/tsconfig.base',
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, baseUrl: '.', paths: { '@/*': ['src/*'] } },
    include: ['src/**/*.ts', 'src/**/*.tsx', 'app/**/*.tsx', 'image-consumer.tsx'],
  });
  write(root, '.tmp/compiled-screen-build-pack.json', {
    contractType: 'compiled-screen-build-pack', screens: [{ screenId: 'home', route: '/home' }],
  });
  write(root, 'app/_layout.tsx', `import { Slot } from 'expo-router';
import { PrototypeProvider } from '../src/data/PrototypeProvider';
export default function RootLayout() { return <PrototypeProvider><Slot /></PrototypeProvider>; }
`);
  write(root, 'app/(app)/home.tsx', `import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PrototypeImage, useEntity } from '@/data';
import { useAuthoringScreen, useAuthoringTarget } from '@/authoring';
export const authoringTargets = [{ id: 'destination-photo', label: 'Destination photo', role: 'surface' }] as const;
export default function Home() {
  const query = useEntity('Destination', ${JSON.stringify(facts.records[0].id)});
  const screen = useAuthoringScreen('home', { ready: !query.isPending, hasUnsavedChanges: false });
  const target = useAuthoringTarget('destination-photo', { screen, recordRef: query.data
    ? { conceptId: 'destination', recordId: query.data.id } : undefined });
  return <SafeAreaView style={{ flex: 1 }}><ScrollView><View ref={target.ref}>
    {query.isPending ? <Text>Loading destination</Text>
      : query.isError ? <Text accessibilityRole="alert">Destination unavailable</Text>
      : !query.data ? <Text>Destination not found</Text>
      : <PrototypeImage photo={query.data.photo} alt={\`Photo of \${query.data.name}\`} fallback="No photo selected" />}
  </View></ScrollView></SafeAreaView>;
}
`);
  const wiring = {
    screenSources: [{ screenId: 'home', sourceFile: 'app/(app)/home.tsx' }],
    readyScreenIds: ['home'], wireScreenIds: ['home'],
  };
  assert.deepEqual(configurePrototypeAuthoring(root, wiring).wiredScreenIds, ['home']);
  assert.equal(configurePrototypeAuthoring(root, { ...wiring, check: true }).publicationReady, false);
  assert.match(fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8'),
    /<AuthoringProvider configureDataPreview=\{configureDataPreview\}><RootLayout \/>/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.tmp/scenario-facts.json'))), facts);
  write(root, 'image-consumer.tsx', `import { PrototypeImage, useEntity, type PhotoReference, type SampleImageProvenance } from './src/data';
export function DestinationPhoto() {
  const query = useEntity('Destination', 'fronalpstock');
  const photo: PhotoReference | null | undefined = query.data?.photo;
  const provenance: SampleImageProvenance | undefined = photo?.status === 'ready' ? photo.sample?.asset.provenance : undefined;
  return <PrototypeImage photo={photo} alt={provenance ? 'Destination' : 'Captured destination photo'} fallback="No photo selected" style={{ width: 320 }} />;
}
`);
  const compiled = spawnSync(process.execPath, [path.join(MODULES, 'typescript/lib/tsc.js'), '--project', 'tsconfig.json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
  });
  assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
  const checked = spawnSync(process.execPath, [
    path.join(PLUGIN, 'scripts/validate-mobile-files.js'), '--project-root', root,
    ...generated.files.filter((file) => /[.](?:ts|tsx|js)$/.test(file)).flatMap((file) => ['--file', file]),
    '--file', 'app/_layout.tsx', '--file', 'app/(app)/home.tsx',
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' } });
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
});
