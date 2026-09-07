'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createNativeCatalog, readNativeCatalog, validateNativeSelection } = require('../lib/native-capability-catalog');
const { revision } = require('../lib/prototype-files');
const policy = require('../native-capabilities.json');

const packageJson = { dependencies: { 'expo-camera': '55.0.18', 'expo-image-picker': '55.0.20', 'expo-haptics': '55.0.16' } };
const runtime = { schemaVersion: 1, platform: 'ios', binaryId: 'demo-binary-1', capabilities: { camera: true, 'barcode-scanner': false } };

test('catalogue lists template capabilities without a device-probe prerequisite', () => {
  const catalog = createNativeCatalog(packageJson);
  assert.equal(catalog.items.find((item) => item.id === 'camera').availability, 'available');
  assert.equal(catalog.items.find((item) => item.id === 'pen-input'), undefined);
  assert.equal(catalog.items.find((item) => item.id === 'haptics').availability, 'blocked');
  assert.equal(catalog.runtime, undefined);
  assert.equal(catalog.items.find((item) => item.id === 'camera').requiredMethods, undefined);
});

test('template policy determines Add availability and preserves source-bound selection', () => {
  const catalog = createNativeCatalog(packageJson, { runtime });
  const selected = validateNativeSelection(catalog, { kind: 'native', capabilityId: 'camera', catalogRevision: catalog.catalogRevision });
  assert.equal(selected.title, 'Camera');
  assert.equal(catalog.items.find((item) => item.id === 'barcode-scanner').availability, 'available');
  assert.throws(() => validateNativeSelection(catalog, { kind: 'native', capabilityId: 'haptics', catalogRevision: catalog.catalogRevision }), /excluded/);
  assert.throws(() => validateNativeSelection(catalog, { kind: 'native', capabilityId: 'camera', catalogRevision: 'a'.repeat(64) }), /changed/);
});

test('native inventory binds dependencies rather than transient device observations', () => {
  const first = createNativeCatalog(packageJson, { runtime });
  const second = createNativeCatalog({ dependencies: { ...packageJson.dependencies, 'expo-camera': '55.0.19' } }, { runtime });
  const third = createNativeCatalog(packageJson, { runtime: { ...runtime, binaryId: 'demo-binary-2' } });
  assert.notEqual(first.catalogRevision, second.catalogRevision);
  assert.equal(first.catalogRevision, third.catalogRevision);
  assert.equal(first.catalogRevision, createNativeCatalog(packageJson, { runtime }).catalogRevision);
});

test('minimum-version controls require an actual installed supported version', () => {
  const pkg = '@microsoft/power-apps-native-pdf-viewer';
  const options = { runtime: { ...runtime, capabilities: { 'pdf-viewer': true } } };
  const missing = createNativeCatalog({ dependencies: { [pkg]: '^0.2.9' } }, options);
  assert.equal(missing.items.find((item) => item.id === 'pdf-viewer').availability, 'requires-version-check');
  const old = createNativeCatalog({ dependencies: { [pkg]: '^0.2.9' } }, { ...options, installedVersions: { [pkg]: '0.2.8' } });
  assert.equal(old.items.find((item) => item.id === 'pdf-viewer').availability, 'requires-version-check');
  const available = createNativeCatalog({ dependencies: { [pkg]: '^0.2.9' } }, { ...options, installedVersions: { [pkg]: '0.2.9' } });
  assert.equal(available.items.find((item) => item.id === 'pdf-viewer').availability, 'available');
});

test('app edits cannot invent native controls absent from the pinned template', () => {
  const appPackageJson = { dependencies: { ...packageJson.dependencies, '@microsoft/power-apps-native-pen-input': '1.0.0' } };
  assert.equal(createNativeCatalog(packageJson, { appPackageJson }).items.some((item) => item.id === 'pen-input'), false);
  const missing = createNativeCatalog(packageJson, { appPackageJson: { dependencies: {} } });
  assert.equal(missing.items.find((item) => item.id === 'camera').availability, 'not-shipped');
  assert.match(missing.items.find((item) => item.id === 'camera').reason, /will not be installed automatically/);
});

test('capture policy names the actual native picker APIs and compiler-owned prototype output', () => {
  const expected = {
    camera: ['requestCameraPermissionsAsync', 'launchCameraAsync'],
    'image-picker': ['requestMediaLibraryPermissionsAsync', 'launchImageLibraryAsync'],
  };
  for (const [id, methods] of Object.entries(expected)) {
    const entry = policy.capabilities.find((item) => item.id === id);
    assert.equal(entry.package, 'expo-image-picker');
    assert.equal(entry.nativeModule, 'ExponentImagePicker');
    assert.deepEqual(entry.requiredMethods, methods);
    assert.equal(entry.wrapper, 'src/native/camera.ts');
    assert.equal(entry.prototypeWrapper, 'src/data/capture.ts');
  }
  const pickerOnly = { dependencies: { 'expo-image-picker': '55.0.20' } };
  const local = createNativeCatalog(pickerOnly, { runtime, prototype: true });
  const legacy = createNativeCatalog(pickerOnly, { runtime });
  assert.equal(local.items.find((item) => item.id === 'camera').availability, 'available');
  assert.equal(local.items.find((item) => item.id === 'camera').wrapper, 'src/data/capture.ts');
  assert.equal(local.items.find((item) => item.id === 'camera').nativeModule, undefined);
  assert.equal(legacy.items.find((item) => item.id === 'camera').availability, 'not-shipped');
  assert.match(legacy.items.find((item) => item.id === 'camera').reason, /expo-camera/);
  assert.notEqual(local.catalogRevision, legacy.catalogRevision);
});

test('catalogue discovery uses the actual profile and does not invent an imagePicker wrapper', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tmp'));
  fs.mkdirSync(path.join(root, 'src/data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson));
  const profilePath = path.join(root, '.tmp/prototype-profile.json');
  fs.writeFileSync(profilePath, JSON.stringify({ schemaVersion: 1, profile: 'prototype' }));
  fs.writeFileSync(path.join(root, 'src/data/capture.ts'), 'export const capturePhoto = () => undefined;\n');
  const local = readNativeCatalog(root, { runtime });
  for (const id of ['camera', 'image-picker']) {
    const entry = local.items.find((item) => item.id === id);
    assert.equal(entry.wrapper, 'src/data/capture.ts');
    assert.equal(entry.alreadyUsed, false);
  }
  fs.writeFileSync(profilePath, JSON.stringify({ schemaVersion: 1, profile: 'connector' }));
  assert.deepEqual(readNativeCatalog(root, { runtime }), local);
  fs.writeFileSync(profilePath, JSON.stringify({ schemaVersion: 1, profile: 'connected' }));
  const connected = readNativeCatalog(root, { runtime });
  assert.equal(connected.items.find((item) => item.id === 'image-picker').wrapper, 'src/native/camera.ts');
  assert.equal(connected.items.find((item) => item.id === 'image-picker').alreadyUsed, false);
  assert.notEqual(local.catalogRevision, connected.catalogRevision);
  fs.writeFileSync(profilePath, '{"schemaVersion":1,"profile":"unknown"}');
  assert.throws(() => readNativeCatalog(root, { runtime }), /valid prototype profile/);
});

test('an always-generated capture wrapper marks only enabled capture sources as already added', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-capture-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tmp'));
  fs.mkdirSync(path.join(root, 'src/data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson));
  fs.writeFileSync(path.join(root, '.tmp/prototype-profile.json'), '{"schemaVersion":1,"profile":"prototype"}');
  fs.writeFileSync(path.join(root, 'src/data/capture.ts'), 'export const capturePhoto = () => undefined;\n');
  const registryPath = path.join(root, '.tmp/data-access-registry.json');
  const writeRegistry = (sources) => {
    const registry = { schemaVersion: 1, contractType: 'data-access-registry', media: { captureSources: sources } };
    registry.registryRevision = revision(registry);
    fs.writeFileSync(registryPath, JSON.stringify(registry));
  };
  writeRegistry([]);
  const before = readNativeCatalog(root);
  assert.equal(before.items.find((item) => item.id === 'camera').alreadyUsed, false);
  writeRegistry(['camera']);
  const camera = readNativeCatalog(root);
  assert.equal(camera.items.find((item) => item.id === 'camera').alreadyUsed, true);
  assert.equal(camera.items.find((item) => item.id === 'image-picker').alreadyUsed, false);
  assert.notEqual(before.catalogRevision, camera.catalogRevision);
  writeRegistry(['camera', 'library']);
  assert.equal(readNativeCatalog(root).items.find((item) => item.id === 'image-picker').alreadyUsed, true);
  const changed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  changed.media.captureSources = [];
  fs.writeFileSync(registryPath, JSON.stringify(changed));
  assert.throws(() => readNativeCatalog(root), /revision|stale/i);
});
