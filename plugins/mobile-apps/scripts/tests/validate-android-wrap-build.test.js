'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  assertAndroidInputProof,
  embedAndroidInputProof,
  inspectForbiddenKeys,
  parseMemoryIdentity,
  scanSigningMaterial,
  validateDeclaredInputsSnapshot,
  validatePng,
  validateProject,
  validateWrapShape,
  writeDeclaredInputsSnapshot,
} = require('../validate-android-wrap-build');
const {
  FIREBASE_APP_ID,
  PACKAGE,
  addFakeApkSigningBlock,
  createAndroidProject,
} = require('./fixtures/android-build-project');

const WORK = path.join(__dirname, '.android-wrap-build-work');
const EVAL_PATH = path.join(
  __dirname,
  '..',
  '..',
  'skills',
  'build-android',
  'evals',
  'evals.json',
);
const SKILL_PATH = path.join(
  __dirname,
  '..',
  '..',
  'skills',
  'build-android',
  'SKILL.md',
);
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';

test.afterEach(() => fs.rmSync(WORK, { recursive: true, force: true }));

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const payload = Buffer.concat([typeBuffer, data]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(payload));
  return Buffer.concat([header, payload, checksum]);
}

function writePng(filePath, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
}

function safeWrap() {
  return {
    bundleIdentifier: 'com.contoso.fieldops',
    displayName: 'Field Ops',
    version: '1.2.3',
    versionCode: 7,
    iconPath: './assets/icon.png',
    msal: { clientId: CLIENT_ID, tenantId: TENANT_ID },
    outputPath: './dist',
  };
}

test('build-android evals cover ten realistic safety and success branches', () => {
  const document = JSON.parse(fs.readFileSync(EVAL_PATH, 'utf8'));
  assert.strictEqual(document.skill_name, 'build-android');
  assert.deepStrictEqual(
    document.evals.map(({ coverage }) => coverage).sort(),
    [
      'captured-terminal-signing-boundary',
      'copied-apk-or-post-sign-proof',
      'firebase-package-app-drift',
      'forged-handoff-signature-metadata',
      'missing-android-sdk-tools',
      'project-local-keystore',
      'safe-config-restoration',
      'successful-physical-device-apk',
      'symlinked-keystore-and-output',
      'unsupported-aab-play-store',
    ],
  );
  for (const evaluation of document.evals) {
    assert.ok(evaluation.prompt.trim());
    assert.ok(evaluation.expected_output.trim());
    assert.deepStrictEqual(evaluation.files, []);
  }
});

test('documents the official APK platform, Android 8 floor, direct distribution, and safe OS boundary', () => {
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');
  assert.match(skill, /Android 8\.0 \/ API level 26/);
  assert.match(skill, /Direct APK\s+distribution is supported/);
  assert.match(skill, /Android.*APK platform[\s\S]*Google Play Store.*separate AAB platform/);
  assert.match(skill, /not a hard local-build OS\s+gate/);
  assert.match(skill, /apksigner.*request the password interactively/);
  assert.match(skill, /Never convert that password prompt into a captured/);
  assert.match(skill, /apksigner verify/);
  assert.match(skill, /android-build-input-proof\.json/);
  assert.match(skill, /declaredInputsDigest/);
  assert.match(skill, /final.*customer-managed `apksigner sign`/s);
  assert.match(skill, /Signature Scheme v2-or-newer/);
  assert.match(skill, /device\/inode \(where available\).*nanosecond mtime\/ctime/s);
  assert.match(skill, /Concurrent replacement, symlink swap, touch, truncation, or same-size content/);
  assert.match(skill, /does not trust editable `android-build\.json` signature or/);
  assert.match(skill, /independently reruns `apksigner verify`/);
  assert.match(skill, /power-apps\/maker\/common\/wrap\/code-sign-android/);
  assert.match(skill, /power-apps\/maker\/common\/wrap\/overview/);
});

test('accepts only the dependency-light safe Wrap projection', () => {
  assert.doesNotThrow(() => validateWrapShape(safeWrap()));
  assert.deepStrictEqual(inspectForbiddenKeys(safeWrap()), []);
});

test('rejects every credential-bearing Android signing field', () => {
  const wrap = safeWrap();
  wrap.android = {
    keystorePath: '/Users/example/release.jks',
    keystorePassword: 'not-read',
    keyAlias: 'not-read',
    keyPassword: 'not-read',
  };
  const fields = inspectForbiddenKeys(wrap);
  assert.deepStrictEqual(fields, [
    'android.keystorePath',
    'android.keystorePassword',
    'android.keyAlias',
    'android.keyPassword',
  ]);
  assert.throws(() => validateWrapShape(wrap), /forbidden credential fields/);
});

test('rejects a nonempty Android object even without recognizable secret keys', () => {
  const wrap = safeWrap();
  wrap.android = { signingMode: 'customer-managed' };
  assert.throws(() => validateWrapShape(wrap), /must not retain Android signing fields/);
});

test('scans regular and symlinked signing extensions without following symlinks', (context) => {
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(WORK, 'release.jks'), 'opaque');
  fs.mkdirSync(path.join(WORK, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(WORK, 'node_modules', 'ignored.jks'), 'ignored');
  try {
    fs.symlinkSync('/outside/customer.keystore', path.join(WORK, 'signing.keystore'));
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      context.skip('symlinks are unavailable on this platform');
      return;
    }
    throw error;
  }
  assert.deepStrictEqual(scanSigningMaterial(WORK), [
    { path: 'release.jks', symlink: false },
    { path: 'signing.keystore', symlink: true },
  ]);
});

test('validates PNG signature and Android minimum icon dimensions', () => {
  const icon = path.join(WORK, 'icon.png');
  writePng(icon, 432, 432);
  assert.deepStrictEqual(validatePng(icon), { width: 432, height: 432 });

  const tooSmall = path.join(WORK, 'small.png');
  writePng(tooSmall, 431, 431);
  assert.throws(() => validatePng(tooSmall), /at least 432x432/);

  const rectangular = path.join(WORK, 'rectangular.png');
  writePng(rectangular, 512, 432);
  assert.throws(() => validatePng(rectangular), /must be square/);

  const fake = path.join(WORK, 'fake.png');
  fs.writeFileSync(fake, 'not a png');
  assert.throws(() => validatePng(fake), /valid PNG/);
});

test('parses one exact memory identity and rejects conflicting handoff values', () => {
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(WORK, 'memory-bank.md'), [
    '| Display name | Field Ops |',
    '| Android bundle id | com.contoso.fieldops |',
    `| App registration (Entra) | ${CLIENT_ID} |`,
    '| Firebase project ID | field-ops-prod |',
    '| Android Firebase app ID | 1:123456789:android:abc123 |',
    '| Android package | com.contoso.fieldops |',
    '| Android client config path | firebase/google-services.json |',
    '| Android version name | 1.2.3 |',
    '| Android version code | 7 |',
    '| Android icon path | assets/icon.png |',
    `| Android icon SHA-256 | sha256:${'ab'.repeat(32)} |`,
    '',
  ].join('\n'));
  assert.deepStrictEqual(parseMemoryIdentity(WORK), {
    displayName: 'Field Ops',
    androidPackage: 'com.contoso.fieldops',
    clientId: CLIENT_ID,
    firebaseProjectId: 'field-ops-prod',
    firebaseAndroidAppId: '1:123456789:android:abc123',
    firebaseClientPath: 'firebase/google-services.json',
    versionName: '1.2.3',
    versionCode: '7',
    iconPath: 'assets/icon.png',
    iconSha256: `sha256:${'ab'.repeat(32)}`,
  });

  fs.appendFileSync(
    path.join(WORK, 'memory-bank.md'),
    '| Android package | com.contoso.other |\n',
  );
  assert.throws(() => parseMemoryIdentity(WORK), /conflicting the Android package values/);
});

test('rejects credential-shaped memory fields without exposing their values', () => {
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(WORK, 'memory-bank.md'), '| Keystore password | <redacted> |\n');
  let error;
  try {
    parseMemoryIdentity(WORK);
  } catch (caught) {
    error = caught;
  }
  assert.match(error.message, /forbidden credential fields: Keystore password/);
  assert.doesNotMatch(error.message, /redacted/);
});

test('allows design-system Brand tokens but rejects credential token fields', () => {
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(WORK, 'memory-bank.md'), '| Brand tokens | primary, accent |\n');
  assert.throws(() => parseMemoryIdentity(WORK), /missing the Entra app registration client ID/);
  fs.appendFileSync(path.join(WORK, 'memory-bank.md'), '| FCM token | <redacted> |\n');
  assert.throws(() => parseMemoryIdentity(WORK), /forbidden credential fields: FCM token/);
});

test('does not exempt signing material merely because it is under dist', () => {
  fs.mkdirSync(path.join(WORK, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(WORK, 'dist', 'release.p12'), 'opaque');
  assert.deepStrictEqual(scanSigningMaterial(WORK), [
    { path: 'dist/release.p12', symlink: false },
  ]);
});

test('validates package, version, and MSAL identity shapes', () => {
  const invalidPackage = safeWrap();
  invalidPackage.bundleIdentifier = 'not-a-package';
  assert.throws(() => validateWrapShape(invalidPackage), /valid Android package/);

  const invalidVersion = safeWrap();
  invalidVersion.version = '1.2';
  assert.throws(() => validateWrapShape(invalidVersion), /semantic version/);

  const invalidCode = safeWrap();
  invalidCode.versionCode = 0;
  assert.throws(() => validateWrapShape(invalidCode), /positive integer/);

  const invalidAuth = safeWrap();
  invalidAuth.msal.tenantId = 'common';
  assert.throws(() => validateWrapShape(invalidAuth), /GUID-shaped MSAL/);
});

test('validates the complete Expo, Wrap, Firebase, auth, memory, icon, and tool identity', () => {
  const root = path.join(WORK, 'complete');
  createAndroidProject(root);
  const result = validateProject(root);
  assert.strictEqual(result.status, 'ready');
  assert.strictEqual(result.app.package, PACKAGE);
  assert.strictEqual(result.app.versionName, '1.2.3');
  assert.strictEqual(result.firebase.androidAppId, FIREBASE_APP_ID);
  assert.strictEqual(result.wrap.artifactPath, `dist/${PACKAGE}.apk`);
  assert.strictEqual(result.wrap.packageVersion, '0.2.25');
  assert.match(result.inputs.digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(result.inputs.files.some((file) => file.path === 'app/(app)/home.tsx'));
  assert.ok(result.inputs.files.some((file) => file.path === 'src/push.ts'));
  assert.ok(result.inputs.files.some((file) => file.path === 'package-lock.json'));
  assert.ok(result.inputs.files.some((file) => file.path === 'index.js'));
  assert.ok(result.inputs.files.some((file) => file.path === 'firebase/google-services.json'));
  assert.deepStrictEqual(result.signing, {
    customerManagedRequired: true,
    projectLocalKeystoreAllowed: false,
    credentialFieldsRetained: false,
  });
});

test('declared input snapshot is deterministic and changes on source addition or content drift', () => {
    const root = path.join(WORK, 'input-digest');
    createAndroidProject(root);
    const first = validateProject(root).inputs;
    const second = validateProject(root).inputs;
    assert.deepStrictEqual(second, first);

    fs.appendFileSync(path.join(root, 'src', 'push.ts'), 'export const changed = true;\n');
    const changed = validateProject(root).inputs;
    assert.notStrictEqual(changed.digest, first.digest);
    assert.strictEqual(changed.fileCount, first.fileCount);

    fs.writeFileSync(path.join(root, 'app', 'new-route.tsx'), 'export default null;\n');
    const added = validateProject(root).inputs;
    assert.notStrictEqual(added.digest, changed.digest);
    assert.strictEqual(added.fileCount, changed.fileCount + 1);
});

test('declared input snapshot requires exactly one lockfile and rejects source symlinks', (context) => {
    const root = path.join(WORK, 'input-safety');
    createAndroidProject(root);
    fs.rmSync(path.join(root, 'package-lock.json'));
    assert.throws(() => validateProject(root), /Exactly one supported project lockfile/);

    createAndroidProject(root);
    fs.writeFileSync(path.join(root, 'yarn.lock'), 'lock');
    assert.throws(() => validateProject(root), /Exactly one supported project lockfile/);

    createAndroidProject(root);
    try {
      fs.symlinkSync(path.join(root, 'index.js'), path.join(root, 'src', 'linked.ts'));
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        context.skip('file symlinks are unavailable on this platform');
        return;
      }
      throw error;
    }
    assert.throws(() => validateProject(root), /Declared Android build input must not be a symlink/);
});

test('strict declared input schema rejects unknown fields and digest tampering', () => {
    const root = path.join(WORK, 'input-schema');
    createAndroidProject(root);
    const snapshot = validateProject(root).inputs;
    const extra = structuredClone(snapshot);
    extra.capturedAt = 'not-deterministic';
    assert.throws(() => validateDeclaredInputsSnapshot(extra), /unsupported fields/);

    const tampered = structuredClone(snapshot);
    tampered.files[0].sha256 = `sha256:${'00'.repeat(32)}`;
    assert.throws(() => validateDeclaredInputsSnapshot(tampered), /digest does not match/);
});

test('writes only the strict declared-input snapshot to a safe project path', () => {
    const root = path.join(WORK, 'input-write');
    createAndroidProject(root);
    const snapshot = validateProject(root).inputs;
    const output = writeDeclaredInputsSnapshot(
      root,
      '.tmp/android-build-inputs.json',
      snapshot,
    );
    assert.strictEqual(
      path.relative(root, output).split(path.sep).join('/'),
      '.tmp/android-build-inputs.json',
    );
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(output, 'utf8')), snapshot);
    assert.doesNotMatch(fs.readFileSync(output, 'utf8'), /Field Ops|clientId|tenantId/);
});

test('embeds the canonical input digest before final customer signing', () => {
  const root = path.join(WORK, 'input-proof');
  const fixture = createAndroidProject(root);
  const snapshot = validateProject(root).inputs;
  addFakeApkSigningBlock(fixture.apkPath);

  const result = embedAndroidInputProof(fixture.apkPath, snapshot);
  assert.deepStrictEqual(result, {
    path: 'assets/power-platform/android-build-input-proof.json',
    declaredInputsDigest: snapshot.digest,
    signingBlockPresent: false,
    embedded: true,
    removedPreviousSigningBlock: true,
    requiresFinalCustomerSigning: true,
  });
  assert.throws(
    () => assertAndroidInputProof(fixture.apkPath, snapshot.digest, { requireSigningBlock: true }),
    /not covered by a final APK Signature Scheme v2\+ signing block/,
  );

  addFakeApkSigningBlock(fixture.apkPath);
  assert.strictEqual(
    assertAndroidInputProof(
      fixture.apkPath,
      snapshot.digest,
      { requireSigningBlock: true },
    ).declaredInputsDigest,
    snapshot.digest,
  );
});

test('refuses to relabel an APK that already carries a different source digest', () => {
  const root = path.join(WORK, 'input-proof-stale');
  const fixture = createAndroidProject(root);
  const first = validateProject(root).inputs;
  embedAndroidInputProof(fixture.apkPath, first);
  fs.appendFileSync(path.join(root, 'src', 'push.ts'), '// newer source\n');
  const second = validateProject(root).inputs;
  assert.throws(
    () => embedAndroidInputProof(fixture.apkPath, second),
    /input proof differs from the captured declared-input digest/,
  );
});

test('blocks Firebase app identity drift on the exact package client record', () => {
  const root = path.join(WORK, 'firebase-drift');
  createAndroidProject(root);
  const firebasePath = path.join(root, 'firebase', 'google-services.json');
  const firebase = JSON.parse(fs.readFileSync(firebasePath, 'utf8'));
  firebase.client[0].client_info.mobilesdk_app_id = '1:123456789:android:other';
  fs.writeFileSync(firebasePath, JSON.stringify(firebase));
  assert.throws(() => validateProject(root), /Firebase Android identity differs from memory-bank/);
});

test('blocks exact script drift and credential-bearing auth fields', () => {
  const root = path.join(WORK, 'script-drift');
  createAndroidProject(root);
  const packagePath = path.join(root, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  packageJson.scripts['bundle:android'] = 'expo export:embed --platform android';
  fs.writeFileSync(packagePath, JSON.stringify(packageJson));
  assert.throws(() => validateProject(root), /bundle:android must equal js-bundle android/);

  createAndroidProject(root);
  const authPath = path.join(root, 'auth.config.json');
  const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  auth.clientSecret = 'not-read';
  fs.writeFileSync(authPath, JSON.stringify(auth));
  assert.throws(() => validateProject(root), /auth\.config\.json contains forbidden credential fields/);
});

test('blocks a symlinked output directory before build or artifact discovery', (context) => {
  const root = path.join(WORK, 'symlink-output');
  createAndroidProject(root);
  fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
  const external = path.join(WORK, 'external');
  fs.mkdirSync(external, { recursive: true });
  try {
    fs.symlinkSync(external, path.join(root, 'dist'), 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      context.skip('directory symlinks are unavailable on this platform');
      return;
    }
    throw error;
  }
  assert.throws(() => validateProject(root), /must not contain symlinks/);
});
