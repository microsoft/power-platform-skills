'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const camera = fs.readFileSync(
  path.resolve(__dirname, '../../skills/add-native/add-camera/SKILL.md'),
  'utf8',
).replace(/\r\n?/g, '\n');

const example = /```typescript\n(\/\/ src\/native\/camera\.ts[\s\S]*?)\n```/.exec(camera)?.[1];
assert.ok(example, 'Expected the actual camera.ts example');

function cameraFunctions(ImagePicker, warnings) {
  // Only signatures/type declarations are omitted. Execute the actual JS bodies
  // so assertions catch rejected permissions in the prescribed example, not just prose.
  const functions = [
    ['requestPermission', 'request', 'PermissionResult'],
    ['permissionGranted', 'request', 'boolean'],
    ['requestCameraPermission', '', 'boolean'],
    ['requestMediaLibraryPermission', '', 'boolean'],
    ['takePhoto', 'options', 'PhotoResult'],
    ['pickImage', 'options', 'PhotoResult'],
  ].map(([name, parameters, result]) => {
    const pattern = new RegExp(
      `(?:export )?async function ${name}\\([\\s\\S]*?\\): Promise<${result}> \\{\\n([\\s\\S]*?)\\n\\}`,
    );
    const match = pattern.exec(example);
    assert.ok(match, `Missing function body: ${name}`);
    return `async function ${name}(${parameters}) {\n${match[1]}\n}`;
  });
  return vm.runInNewContext(`${functions.join('\n')}\n({
    requestCameraPermission, requestMediaLibraryPermission, takePhoto, pickImage
  })`, {
    ImagePicker,
    Error,
    console: { warn: (message) => warnings.push(message) },
  });
}

for (const [operation, publicPermission, permissionApi, launchApi] of [
  ['takePhoto', 'requestCameraPermission', 'requestCameraPermissionsAsync', 'launchCameraAsync'],
  ['pickImage', 'requestMediaLibraryPermission', 'requestMediaLibraryPermissionsAsync', 'launchImageLibraryAsync'],
]) {
  function harness(request, launch) {
    let launches = 0;
    const warnings = [];
    const api = {
      [permissionApi]: request,
      [launchApi]: launch && (async (...args) => {
        launches += 1;
        return launch(...args);
      }),
    };
    return { functions: cameraFunctions(api, warnings), warnings, launches: () => launches };
  }

  test(`${operation} maps permission rejection without launching or throwing`, async () => {
    const h = harness(
      async () => { throw new Error('native permission unavailable'); },
      async () => ({ canceled: true }),
    );
    const result = await h.functions[operation]();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'error');
    assert.equal(result.message, 'native permission unavailable');
    assert.equal(h.launches(), 0);
    assert.equal(await h.functions[publicPermission](), false);
    assert.deepEqual(h.warnings, ['Device permission request failed (error).']);
  });

  test(`${operation} distinguishes denied permission from failed or missing APIs`, async () => {
    const denied = harness(async () => ({ status: 'denied' }), async () => ({ canceled: true }));
    assert.equal((await denied.functions[operation]()).reason, 'permission-denied');
    assert.equal(await denied.functions[publicPermission](), false);
    assert.equal(denied.launches(), 0);
    assert.deepEqual(denied.warnings, []);

    const missing = harness(undefined, async () => ({ canceled: true }));
    assert.equal((await missing.functions[operation]()).reason, 'unsupported');
    assert.equal(await missing.functions[publicPermission](), false);
    assert.equal(missing.launches(), 0);
    assert.deepEqual(missing.warnings, ['Device permission request failed (unsupported).']);
  });

  test(`${operation} preserves successful output and cancellation behavior`, async () => {
    const granted = async () => ({ status: 'granted' });
    const h = harness(granted, async (options) => {
      assert.equal(options.quality, 0.6);
      return { canceled: false, assets: [{ uri: 'file:///photo.jpg', width: 100, height: 80 }] };
    });
    const result = await h.functions[operation]({ quality: 0.6 });
    assert.equal(result.ok, true);
    assert.equal(result.uri, 'file:///photo.jpg');
    assert.equal(result.width, 100);
    assert.equal(await h.functions[publicPermission](), true);
    assert.deepEqual(h.warnings, []);

    const cancelled = harness(granted, async () => ({ canceled: true }));
    assert.equal((await cancelled.functions[operation]()).reason, 'cancelled');
  });

  test(`${operation} maps missing or rejecting launch APIs to failure results`, async () => {
    const granted = async () => ({ status: 'granted' });
    const missing = harness(granted, undefined);
    assert.equal((await missing.functions[operation]()).reason, 'unsupported');
    const rejected = harness(granted, async () => { throw new Error('launch failed'); });
    assert.equal((await rejected.functions[operation]()).reason, 'error');
  });
}

const packageCheck = /node - '<approved-artifact-keys-json>' <<'NODE'\n([\s\S]*?)\nNODE/.exec(camera)?.[1];
assert.ok(packageCheck, 'Expected artifact-scoped package prerequisite script');

function checkPackages(artifacts, dependencies) {
  return vm.runInNewContext(packageCheck, {
    require: (name) => {
      assert.equal(name, './package.json');
      return { dependencies };
    },
    process: {
      argv: ['node', '-', JSON.stringify(artifacts)],
      exit: (code) => { throw new Error(`exit ${code}`); },
    },
    console: { log: () => {}, error: () => {} },
  });
}

test('scanner-only and upload-only prerequisites do not require capture packages', () => {
  assert.doesNotThrow(() => checkPackages(['scanner'], { 'expo-camera': 'installed' }));
  assert.doesNotThrow(() => checkPackages(['upload'], { 'expo-file-system': 'installed' }));
  assert.doesNotThrow(() => checkPackages(['photo', 'gallery'], { 'expo-image-picker': 'installed' }));
});

test('combined artifact prerequisites require the union and reject invalid scope', () => {
  assert.throws(() => checkPackages(['photo', 'scanner'], { 'expo-camera': 'installed' }), /exit 1/);
  assert.doesNotThrow(() => checkPackages(['photo', 'scanner'], {
    'expo-camera': 'installed',
    'expo-image-picker': 'installed',
  }));
  for (const invalid of [[], ['unknown'], ['__proto__'], [1], 'scanner']) {
    assert.throws(() => checkPackages(invalid, {}), /Expected a nonempty approved artifact list/);
  }
});

test('scanner permission failures are handled and rendered, not left as rejected effects', () => {
  const scanner = /```tsx\n(\/\/ src\/native\/barcodeScanner\.tsx[\s\S]*?)\n```/.exec(camera)?.[1];
  assert.ok(scanner);
  assert.match(scanner, /async function requestScannerPermission\(\)[\s\S]*try[\s\S]*await requestPermission\(\);[\s\S]*catch[\s\S]*setPermissionError/);
  assert.match(scanner, /if \(permissionError\)[\s\S]*<Text>\{permissionError\}<\/Text>/);
  assert.match(scanner, /!permissionAttemptedRef\.current/);
  assert.doesNotMatch(scanner, /^\s+requestPermission\(\);$/m);
});

test('camera summary reports only fulfilled requested artifacts and conditional examples', () => {
  const summary = camera.slice(camera.indexOf('### Step 7 — Summary'), camera.indexOf('## Notes'));
  assert.match(summary, /<fulfilled requested capabilities only>/);
  assert.match(summary, /<one row per requested path: created \/ updated \/ reused>/);
  assert.match(summary, /Do not list `camera\.ts` for scanner-only or upload-only results/);
  assert.doesNotMatch(summary, /Camera \+ image picker wrappers generated|Camera wrapper\s+: src\/native\/camera\.ts/);
  for (const capability of ['capture and custom Image upload', 'gallery picking', 'scanner support']) {
    assert.ok(summary.includes(`Include this usage only when ${capability} `));
  }
});
