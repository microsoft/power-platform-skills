'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  assertVerificationTools,
  normalizeSha256,
  parseAaptBadging,
  parseAaptResourceStrings,
  parseApksignerOutput,
  resolveTool,
  runTool,
  verifyApk,
} = require('../verify-android-apk');
const {
  APK_INPUT_PROOF_PATH,
  captureStableFileIdentity,
  embedAndroidInputProof,
  validateProject,
} = require('../validate-android-wrap-build');
const {
  PACKAGE,
  SIGNER_SHA256,
  VERIFIED_AT,
  addFakeApkSigningBlock,
  createAndroidProject,
  mockAndroidToolSpawn,
  writeStoredZip,
  writeInputSnapshot,
} = require('./fixtures/android-build-project');

const WORK = path.join(__dirname, '.verify-android-apk-work');
const FINGERPRINT = 'ab'.repeat(32);

test.afterEach(() => fs.rmSync(WORK, { recursive: true, force: true }));

function projectWithInputSnapshot(name) {
  const root = path.join(WORK, name);
  const fixture = createAndroidProject(root);
  writeInputSnapshot(root, validateProject(root).inputs);
  return fixture;
}

test('normalizes safe SHA-256 forms and rejects shorter fingerprints', () => {
  assert.strictEqual(normalizeSha256(FINGERPRINT, 'Signer'), `sha256:${FINGERPRINT}`);
  assert.strictEqual(
    normalizeSha256(`sha256:${FINGERPRINT.toUpperCase()}`, 'Signer'),
    `sha256:${FINGERPRINT}`,
  );
  assert.throws(() => normalizeSha256('AA:BB', 'Signer'), /64-character SHA-256/);
});

test('parses exactly one signer fingerprint and verified signature schemes', () => {
  const output = [
    'Verifies',
    'Verified using v1 scheme (JAR signing): true',
    'Verified using v2 scheme (APK Signature Scheme v2): true',
    'Verified using v3 scheme (APK Signature Scheme v3): false',
    `Signer #1 certificate SHA-256 digest: ${FINGERPRINT}`,
  ].join('\n');
  assert.deepStrictEqual(parseApksignerOutput(output), {
    certificateSha256: `sha256:${FINGERPRINT}`,
    schemes: { v1: true, v2: true, v3: false },
  });
});

test('rejects multiple signers or output without a verified scheme', () => {
  assert.throws(
    () => parseApksignerOutput([
      'Verified using v2 scheme (APK Signature Scheme v2): true',
      `Signer #1 certificate SHA-256 digest: ${FINGERPRINT}`,
      `Signer #2 certificate SHA-256 digest: ${'cd'.repeat(32)}`,
    ].join('\n')),
    /exactly one signer/,
  );
  assert.throws(
    () => parseApksignerOutput([
      'Verified using v2 scheme (APK Signature Scheme v2): false',
      `Signer #1 certificate SHA-256 digest: ${FINGERPRINT}`,
    ].join('\n')),
    /no verified Android signature scheme/,
  );
  assert.throws(
    () => parseApksignerOutput([
      'Verified using v1 scheme (JAR signing): true',
      `Signer #1 certificate SHA-256 digest: ${FINGERPRINT}`,
    ].join('\n')),
    /Signature Scheme v2 or newer/,
  );
});

test('parses exact APK package, version, label, and a packaged icon resource', () => {
  const output = [
    "package: name='com.contoso.fieldops' versionCode='7' versionName='1.2.3'",
    "sdkVersion:'26'",
    "targetSdkVersion:'35'",
    "application-label:'Field Ops'",
    "application-icon-160:'res/mipmap-mdpi-v4/ic_launcher.png'",
    "application-icon-640:'res/mipmap-xxxhdpi-v4/ic_launcher.png'",
    "application: label='Field Ops' icon='res/mipmap-mdpi-v4/ic_launcher.png'",
  ].join('\n');
  assert.deepStrictEqual(parseAaptBadging(output), {
    package: 'com.contoso.fieldops',
    versionCode: 7,
    versionName: '1.2.3',
    displayName: 'Field Ops',
    minSdkVersion: 26,
    targetSdkVersion: 35,
    packagedIconResource: 'res/mipmap-mdpi-v4/ic_launcher.png',
  });
});

test('parses exact Firebase project and Android app resources from the APK', () => {
  const output = [
    'spec resource 0x7f100001 com.contoso.fieldops:string/google_app_id: flags=0x00000000',
    '  resource 0x7f100001 com.contoso.fieldops:string/google_app_id: t=0x03 d=0x00000101',
    '    (string8) "1:123456789:android:abc123"',
    'spec resource 0x7f100002 com.contoso.fieldops:string/project_id: flags=0x00000000',
    '  resource 0x7f100002 com.contoso.fieldops:string/project_id: t=0x03 d=0x00000102',
    '    (string8) "field-ops-prod"',
  ].join('\n');
  assert.deepStrictEqual(parseAaptResourceStrings(output), {
    androidAppId: '1:123456789:android:abc123',
    projectId: 'field-ops-prod',
  });
});

test('rejects absent or ambiguous compiled Firebase resource identity', () => {
  assert.throws(() => parseAaptResourceStrings('no Firebase resources'), /exactly one google_app_id/);
  assert.throws(
    () => parseAaptResourceStrings([
      'resource 0x1 app:string/google_app_id:',
      '  (string8) "1:one:android:a"',
      'resource 0x2 app:string/google_app_id:',
      '  (string8) "1:two:android:b"',
      'resource 0x3 app:string/project_id:',
      '  (string8) "project"',
    ].join('\n')),
    /exactly one google_app_id/,
  );
});

test('rejects malformed or path-unsafe packaged icon metadata', () => {
  assert.throws(
    () => parseAaptBadging([
      "package: name='com.contoso.fieldops' versionCode='7' versionName='1.2.3'",
      "sdkVersion:'26'",
      "targetSdkVersion:'35'",
      "application-label:'Field Ops'",
      "application: label='Field Ops' icon='../outside.png'",
    ].join('\n')),
    /packaged application icon/,
  );
  assert.throws(
    () => parseAaptBadging("package: name='com.contoso.fieldops' versionCode='x' versionName='1.2.3'"),
    /application label metadata/,
  );
});

test('rejects missing or inconsistent packaged SDK metadata', () => {
  assert.throws(
    () => parseAaptBadging([
      "package: name='com.contoso.fieldops' versionCode='7' versionName='1.2.3'",
      "application-label:'Field Ops'",
      "application-icon-160:'res/mipmap-mdpi-v4/ic_launcher.png'",
    ].join('\n')),
    /minSdkVersion\/targetSdkVersion metadata/,
  );
  assert.throws(
    () => parseAaptBadging([
      "package: name='com.contoso.fieldops' versionCode='7' versionName='1.2.3'",
      "sdkVersion:'35'",
      "targetSdkVersion:'26'",
      "application-label:'Field Ops'",
      "application-icon-160:'res/mipmap-mdpi-v4/ic_launcher.png'",
    ].join('\n')),
    /minSdkVersion\/targetSdkVersion metadata/,
  );
});

test('discovers explicit Android SDK tools and fails clearly when absent', () => {
  fs.mkdirSync(WORK, { recursive: true });
  const tool = path.join(WORK, 'apksigner');
  fs.writeFileSync(tool, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.strictEqual(resolveTool('apksigner', tool, { env: { PATH: '' } }), fs.realpathSync(tool));
  assert.throws(
    () => resolveTool('aapt', null, { env: { PATH: '' } }),
    /aapt is required; install Android SDK Build-Tools/,
  );
  assert.throws(
    () => resolveTool('unzip', null, { env: { PATH: '' } }),
    /unzip is required; install unzip and ensure it is on PATH/,
  );
});

test('requires trusted same-version SDK Build-Tools outside the app project', () => {
  const root = path.join(WORK, 'project');
  const sdk = path.join(WORK, 'sdk', 'build-tools', '35.0.0');
  const otherSdk = path.join(WORK, 'sdk', 'build-tools', '34.0.0');
  fs.mkdirSync(path.join(root, '.tools'), { recursive: true });
  fs.mkdirSync(sdk, { recursive: true });
  fs.mkdirSync(otherSdk, { recursive: true });
  assert.doesNotThrow(() => assertVerificationTools(
    root,
    path.join(sdk, 'apksigner'),
    path.join(sdk, 'aapt'),
    '/usr/bin/unzip',
  ));
  assert.throws(
    () => assertVerificationTools(
      root,
      path.join(root, '.tools', 'apksigner'),
      path.join(root, '.tools', 'aapt'),
      '/usr/bin/unzip',
    ),
    /must not resolve inside the untrusted app project/,
  );
  assert.throws(
    () => assertVerificationTools(
      root,
      path.join(sdk, 'apksigner'),
      path.join(otherSdk, 'aapt'),
      '/usr/bin/unzip',
    ),
    /same Android SDK Build-Tools directory/,
  );
});

test('does not echo sensitive Android tool output on failure', () => {
  const fakeSpawn = () => ({
    status: 1,
    stdout: 'Signer subject: CN=Customer Name',
    stderr: 'command --ks-pass pass:do-not-print',
  });
  let error;
  try {
    runTool('/sdk/apksigner', ['verify'], 'apk-signature-invalid', { spawnSync: fakeSpawn });
  } catch (caught) {
    error = caught;
  }
  assert.strictEqual(error.code, 'apk-signature-invalid');
  assert.strictEqual(error.message, 'APK signature verification failed.');
  assert.doesNotMatch(error.message, /Customer Name|do-not-print|ks-pass/);
});

const artifactRaceCases = [
  {
    name: 'same-byte inode replacement',
    mutate(apkPath) {
      const stat = fs.statSync(apkPath);
      const replacement = `${apkPath}.replacement`;
      fs.copyFileSync(apkPath, replacement);
      fs.utimesSync(replacement, stat.atime, stat.mtime);
      fs.renameSync(replacement, apkPath);
    },
  },
  {
    name: 'mtime-only touch',
    mutate(apkPath) {
      const stat = fs.statSync(apkPath);
      fs.utimesSync(apkPath, stat.atime, new Date(stat.mtimeMs + 1));
    },
  },
  {
    name: 'truncation',
    mutate(apkPath) {
      fs.truncateSync(apkPath, fs.statSync(apkPath).size - 1);
    },
  },
  {
    name: 'same-size content swap with restored mtime',
    mutate(apkPath) {
      const stat = fs.statSync(apkPath);
      const descriptor = fs.openSync(apkPath, 'r+');
      try {
        const byte = Buffer.alloc(1);
        fs.readSync(descriptor, byte, 0, 1, 0);
        byte[0] ^= 0xff;
        fs.writeSync(descriptor, byte, 0, 1, 0);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.utimesSync(apkPath, stat.atime, stat.mtime);
    },
  },
];

for (const race of artifactRaceCases) {
  test(`rejects APK ${race.name} during signature verification`, () => {
    const fixture = projectWithInputSnapshot(`artifact-race-${race.name.replaceAll(' ', '-')}`);
    let mutated = false;
    const racingSpawn = (command, args, options) => {
      if (!mutated && path.basename(command) === 'apksigner') {
        race.mutate(fixture.apkPath);
        mutated = true;
      }
      return mockAndroidToolSpawn(command, args, options);
    };
    assert.throws(
      () => verifyApk({
        projectRoot: fixture.root,
        inputSnapshot: '.tmp/android-build-inputs.json',
        buildStart: '.tmp/android-build-start',
        expectedSignerSha256: SIGNER_SHA256,
        apksigner: fixture.tools.apksigner,
        aapt: fixture.tools.aapt,
        unzip: fixture.tools.unzip,
      }, { now: VERIFIED_AT, spawnSync: racingSpawn }),
      /changed during APK signature verification/,
    );
    assert.strictEqual(fs.existsSync(path.join(fixture.root, 'android-build.json')), false);
  });
}

test('rejects an APK symlink swap during signature verification', (context) => {
  const fixture = projectWithInputSnapshot('artifact-race-symlink');
  let unsupported = false;
  const racingSpawn = (command, args, options) => {
    if (path.basename(command) === 'apksigner') {
      const original = `${fixture.apkPath}.original`;
      fs.renameSync(fixture.apkPath, original);
      try {
        fs.symlinkSync(original, fixture.apkPath);
      } catch (error) {
        fs.renameSync(original, fixture.apkPath);
        if (error.code === 'EPERM' || error.code === 'EACCES') {
          unsupported = true;
          return mockAndroidToolSpawn(command, args, options);
        }
        throw error;
      }
    }
    return mockAndroidToolSpawn(command, args, options);
  };
  let error;
  try {
    verifyApk({
      projectRoot: fixture.root,
      inputSnapshot: '.tmp/android-build-inputs.json',
      buildStart: '.tmp/android-build-start',
      expectedSignerSha256: SIGNER_SHA256,
      apksigner: fixture.tools.apksigner,
      aapt: fixture.tools.aapt,
      unzip: fixture.tools.unzip,
    }, { now: VERIFIED_AT, spawnSync: racingSpawn });
  } catch (caught) {
    error = caught;
  }
  if (unsupported) {
    context.skip('file symlinks are unavailable on this platform');
    return;
  }
  assert.match(error?.message || '', /must not contain symlinks/);
  assert.strictEqual(fs.existsSync(path.join(fixture.root, 'android-build.json')), false);
});

test('verifies a fresh exact APK and writes strict non-secret android-build.json', () => {
  const fixture = projectWithInputSnapshot('success');
  const { root } = fixture;
  const document = verifyApk({
    projectRoot: root,
    buildStart: '.tmp/android-build-start',
    expectedSignerSha256: SIGNER_SHA256,
    apksigner: fixture.tools.apksigner,
    aapt: fixture.tools.aapt,
    unzip: fixture.tools.unzip,
  }, {
    now: VERIFIED_AT,
    spawnSync: mockAndroidToolSpawn,
  });
  assert.strictEqual(document.status, 'verified');
  assert.strictEqual(document.artifact.path, `dist/${PACKAGE}.apk`);
  assert.strictEqual(document.firebase.androidAppId, '1:123456789:android:abc123');
  assert.strictEqual(document.signing.certificateSha256, `sha256:${SIGNER_SHA256}`);
  assert.strictEqual(document.app.packagedIconSha256.length, 71);
  assert.match(document.inputs.digest, /^sha256:[0-9a-f]{64}$/);
  const artifactIdentity = captureStableFileIdentity(root, fixture.apkPath, 'Android APK');
  assert.strictEqual(document.artifact.sha256, artifactIdentity.sha256);
  assert.strictEqual(document.artifact.modifiedAtNs, artifactIdentity.modifiedAtNs);
  assert.strictEqual(document.artifact.changedAtNs, artifactIdentity.changedAtNs);
  assert.strictEqual(document.artifact.device, artifactIdentity.device);
  assert.strictEqual(document.artifact.inode, artifactIdentity.inode);
  assert.ok(document.inputs.files.some((file) => file.path === 'app/(app)/home.tsx'));
  assert.strictEqual(
    document.timestamps.inputsCapturedAt,
    '2026-08-24T09:59:59.000Z',
  );
  assert.strictEqual(
    document.timestamps.validUntil,
    '2026-08-25T10:05:00.000Z',
  );
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(root, 'android-build.json'), 'utf8')),
    document,
  );
  assert.deepStrictEqual(
    fs.readdirSync(path.join(root, '.tmp')).sort(),
    ['android-build-inputs.json', 'android-build-start'],
  );
  assert.doesNotMatch(JSON.stringify(document), /password|keystore|keyAlias|privateKey/i);
});

test('blocks an unexpected signer or compiled Firebase identity without writing handoff', () => {
  const fixture = projectWithInputSnapshot('mismatch');
  const { root } = fixture;
  assert.throws(
    () => verifyApk({
      projectRoot: root,
      buildStart: '.tmp/android-build-start',
      expectedSignerSha256: 'cd'.repeat(32),
      apksigner: fixture.tools.apksigner,
      aapt: fixture.tools.aapt,
      unzip: fixture.tools.unzip,
    }, { now: VERIFIED_AT, spawnSync: mockAndroidToolSpawn }),
    /signer certificate fingerprint differs/,
  );
  assert.strictEqual(fs.existsSync(path.join(root, 'android-build.json')), false);

  const wrongFirebaseSpawn = (command, args, options) => {
    const result = mockAndroidToolSpawn(command, args, options);
    if (path.basename(command) === 'aapt' && args[1] === 'resources') {
      result.stdout = result.stdout.replace('field-ops-prod', 'other-project');
    }
    return result;
  };
  assert.throws(
    () => verifyApk({
      projectRoot: root,
      buildStart: '.tmp/android-build-start',
      expectedSignerSha256: SIGNER_SHA256,
      apksigner: fixture.tools.apksigner,
      aapt: fixture.tools.aapt,
      unzip: fixture.tools.unzip,
    }, { now: VERIFIED_AT, spawnSync: wrongFirebaseSpawn }),
    /Produced APK Firebase project or Android app identity differs/,
  );
  assert.strictEqual(fs.existsSync(path.join(root, 'android-build.json')), false);
});

test('rejects a signed APK with a missing or non-canonical input proof', () => {
  const missing = createAndroidProject(path.join(WORK, 'missing-proof'));
  const missingSnapshot = validateProject(missing.root).inputs;
  writeInputSnapshot(missing.root, missingSnapshot, { embedProof: false });
  addFakeApkSigningBlock(missing.apkPath);
  fs.utimesSync(
    missing.apkPath,
    new Date('2026-08-24T10:00:06.000Z'),
    new Date('2026-08-24T10:00:06.000Z'),
  );
  assert.throws(
    () => verifyApk({
      projectRoot: missing.root,
      inputSnapshot: '.tmp/android-build-inputs.json',
      buildStart: '.tmp/android-build-start',
      expectedSignerSha256: SIGNER_SHA256,
      apksigner: missing.tools.apksigner,
      aapt: missing.tools.aapt,
      unzip: missing.tools.unzip,
    }, { now: VERIFIED_AT, spawnSync: mockAndroidToolSpawn }),
    /must contain exactly one .*android-build-input-proof\.json entry/,
  );

  const malformed = createAndroidProject(path.join(WORK, 'malformed-proof'));
  const malformedSnapshot = validateProject(malformed.root).inputs;
  writeInputSnapshot(malformed.root, malformedSnapshot, { embedProof: false });
  writeStoredZip(malformed.apkPath, {
    'res/mipmap-mdpi-v4/ic_launcher.png': Buffer.from('packaged-icon'),
    [APK_INPUT_PROOF_PATH]: `${JSON.stringify({
      schemaVersion: 1,
      algorithm: 'sha256',
      declaredInputsDigest: malformedSnapshot.digest,
      extra: true,
    })}\n`,
  });
  addFakeApkSigningBlock(malformed.apkPath);
  fs.utimesSync(
    malformed.apkPath,
    new Date('2026-08-24T10:00:06.000Z'),
    new Date('2026-08-24T10:00:06.000Z'),
  );
  assert.throws(
    () => verifyApk({
      projectRoot: malformed.root,
      inputSnapshot: '.tmp/android-build-inputs.json',
      buildStart: '.tmp/android-build-start',
      expectedSignerSha256: SIGNER_SHA256,
      apksigner: malformed.tools.apksigner,
      aapt: malformed.tools.aapt,
      unzip: malformed.tools.unzip,
    }, { now: VERIFIED_AT, spawnSync: mockAndroidToolSpawn }),
    /strict deterministic schema/,
  );
});

test('blocks when declared app inputs change after the pre-build snapshot', () => {
  const fixture = projectWithInputSnapshot('source-drift');
  fs.appendFileSync(
    path.join(fixture.root, 'app', '(app)', 'home.tsx'),
    'export const changedAfterSnapshot = true;\n',
  );
  assert.throws(
    () => verifyApk({
      projectRoot: fixture.root,
      inputSnapshot: '.tmp/android-build-inputs.json',
      buildStart: '.tmp/android-build-start',
      expectedSignerSha256: SIGNER_SHA256,
      apksigner: fixture.tools.apksigner,
      aapt: fixture.tools.aapt,
      unzip: fixture.tools.unzip,
    }, { now: VERIFIED_AT, spawnSync: mockAndroidToolSpawn }),
    /Declared Android app\/push inputs changed after the build snapshot/,
  );
  assert.strictEqual(fs.existsSync(path.join(fixture.root, 'android-build.json')), false);
});

test('rejects a copied older APK whose embedded digest predates the current snapshot', () => {
  const fixture = projectWithInputSnapshot('copied-old-apk');
  fs.appendFileSync(path.join(fixture.root, 'src', 'push.ts'), '// current source revision\n');
  const current = validateProject(fixture.root).inputs;
  writeInputSnapshot(fixture.root, current, { embedProof: false });
  fs.utimesSync(
    fixture.apkPath,
    new Date('2026-08-24T10:00:06.000Z'),
    new Date('2026-08-24T10:00:06.000Z'),
  );

  assert.throws(
    () => verifyApk({
      projectRoot: fixture.root,
      inputSnapshot: '.tmp/android-build-inputs.json',
      buildStart: '.tmp/android-build-start',
      expectedSignerSha256: SIGNER_SHA256,
      apksigner: fixture.tools.apksigner,
      aapt: fixture.tools.aapt,
      unzip: fixture.tools.unzip,
    }, { now: VERIFIED_AT, spawnSync: mockAndroidToolSpawn }),
    /input proof differs from the captured declared-input digest/,
  );
  assert.strictEqual(fs.existsSync(path.join(fixture.root, 'android-build.json')), false);
});

test('rejects an input proof inserted after the last whole-file signature', () => {
  const root = path.join(WORK, 'proof-after-signing');
  const fixture = createAndroidProject(root);
  const snapshot = validateProject(root).inputs;
  writeInputSnapshot(root, snapshot, { embedProof: false });
  addFakeApkSigningBlock(fixture.apkPath);
  embedAndroidInputProof(fixture.apkPath, snapshot);
  fs.utimesSync(
    fixture.apkPath,
    new Date('2026-08-24T10:00:06.000Z'),
    new Date('2026-08-24T10:00:06.000Z'),
  );

  assert.throws(
    () => verifyApk({
      projectRoot: root,
      inputSnapshot: '.tmp/android-build-inputs.json',
      buildStart: '.tmp/android-build-start',
      expectedSignerSha256: SIGNER_SHA256,
      apksigner: fixture.tools.apksigner,
      aapt: fixture.tools.aapt,
      unzip: fixture.tools.unzip,
    }, { now: VERIFIED_AT, spawnSync: mockAndroidToolSpawn }),
    /not covered by a final APK Signature Scheme v2\+ signing block/,
  );
  assert.strictEqual(fs.existsSync(path.join(root, 'android-build.json')), false);
});

test('blocks when declared inputs mutate during APK verification', () => {
  const fixture = projectWithInputSnapshot('source-race');
  let mutated = false;
  const mutatingSpawn = (command, args, options) => {
    if (!mutated && path.basename(command) === 'aapt' && args[1] === 'badging') {
      fs.appendFileSync(path.join(fixture.root, 'src', 'push.ts'), '// changed during verification\n');
      mutated = true;
    }
    return mockAndroidToolSpawn(command, args, options);
  };
  assert.throws(
    () => verifyApk({
      projectRoot: fixture.root,
      inputSnapshot: '.tmp/android-build-inputs.json',
      buildStart: '.tmp/android-build-start',
      expectedSignerSha256: SIGNER_SHA256,
      apksigner: fixture.tools.apksigner,
      aapt: fixture.tools.aapt,
      unzip: fixture.tools.unzip,
    }, { now: VERIFIED_AT, spawnSync: mutatingSpawn }),
    /Declared Android app\/push inputs changed during APK verification/,
  );
  assert.strictEqual(fs.existsSync(path.join(fixture.root, 'android-build.json')), false);
});
