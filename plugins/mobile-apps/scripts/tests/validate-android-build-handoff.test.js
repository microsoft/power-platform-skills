'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  parseArgs,
  parseTimestamp,
  validateDocumentShape,
  validateHandoff,
} = require('../validate-android-build-handoff');
const { verifyApk } = require('../verify-android-apk');
const {
  captureStableFileIdentity,
  declaredInputDigest,
  validateProject,
} = require('../validate-android-wrap-build');
const path = require('node:path');
const fs = require('node:fs');
const {
  SIGNER_SHA256,
  VERIFIED_AT,
  createAndroidProject,
  mockAndroidToolSpawn,
  removeFakeApkSigningBlock,
  writeInputSnapshot,
} = require('./fixtures/android-build-project');

const FINGERPRINT = `sha256:${'ab'.repeat(32)}`;
const ARTIFACT_HASH = `sha256:${'cd'.repeat(32)}`;
const ICON_HASH = `sha256:${'ef'.repeat(32)}`;
const PACKAGED_ICON_HASH = `sha256:${'12'.repeat(32)}`;
const INPUT_FILES = [{
  path: 'app/index.tsx',
  sizeBytes: 1,
  sha256: `sha256:${'34'.repeat(32)}`,
}];
const INPUT_SNAPSHOT = {
  schemaVersion: 1,
  algorithm: 'sha256',
  digest: declaredInputDigest(INPUT_FILES),
  fileCount: INPUT_FILES.length,
  totalBytes: 1,
  files: INPUT_FILES,
};
const HANDOFF_ROOT = path.join(__dirname, '.validate-android-handoff-work');
const STALE_ROOT = path.join(__dirname, '.validate-android-handoff-stale-work');
const SOURCE_ROOT = path.join(__dirname, '.validate-android-handoff-source-work');
const BINDING_ROOT = path.join(__dirname, '.validate-android-handoff-binding-work');

test.after(() => {
  for (const root of [HANDOFF_ROOT, STALE_ROOT, SOURCE_ROOT, BINDING_ROOT]) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(
      path.join(path.dirname(root), `${path.basename(root)}-tools`),
      { recursive: true, force: true },
    );
  }
});

function handoff() {
  return {
    schemaVersion: 1,
    platform: 'android',
    purpose: 'direct-physical-device-testing',
    status: 'verified',
    artifact: {
      path: 'dist/com.contoso.fieldops.apk',
      sha256: ARTIFACT_HASH,
      sizeBytes: 123456,
      modifiedAt: '2026-08-24T10:00:05.000Z',
      modifiedAtNs: '1787565605000000000',
      changedAtNs: '1787565605000000001',
      device: '1',
      inode: '2',
    },
    app: {
      package: 'com.contoso.fieldops',
      displayName: 'Field Ops',
      versionName: '1.2.3',
      versionCode: 7,
      minSdkVersion: 26,
      targetSdkVersion: 35,
      sourceIconPath: 'assets/icon.png',
      sourceIconSha256: ICON_HASH,
      packagedIconResource: 'res/mipmap-mdpi-v4/ic_launcher.png',
      packagedIconSha256: PACKAGED_ICON_HASH,
    },
    firebase: {
      projectId: 'field-ops-prod',
      androidAppId: '1:123456789:android:abc123',
      package: 'com.contoso.fieldops',
      clientConfigPath: 'firebase/google-services.json',
    },
    auth: {
      clientId: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
    },
    signing: {
      verified: true,
      verificationTool: 'apksigner',
      certificateSha256: FINGERPRINT,
      schemes: { v1: true, v2: true, v3: false },
    },
    tooling: {
      metadataTool: 'aapt',
      wrapPackage: '@microsoft/power-apps-native-host',
      wrapVersion: '0.2.25',
    },
    timestamps: {
      inputsCapturedAt: '2026-08-24T09:59:59.000Z',
      buildStartedAt: '2026-08-24T10:00:00.000Z',
      verifiedAt: '2026-08-24T10:05:00.000Z',
      validUntil: '2026-08-25T10:05:00.000Z',
    },
    inputs: structuredClone(INPUT_SNAPSHOT),
  };
}

function updateDocumentArtifactIdentity(root, artifactPath, document) {
  const identity = captureStableFileIdentity(root, artifactPath, 'Android APK');
  document.artifact.sha256 = identity.sha256;
  document.artifact.sizeBytes = identity.sizeBytes;
  document.artifact.modifiedAt = identity.modifiedAt;
  document.artifact.modifiedAtNs = identity.modifiedAtNs;
  document.artifact.changedAtNs = identity.changedAtNs;
  document.artifact.device = identity.device;
  document.artifact.inode = identity.inode;
}

function validateFixtureHandoff(root, fixture, now, options = {}) {
  return validateHandoff({
    projectRoot: root,
    file: 'android-build.json',
    maxAgeHours: 24,
    apksigner: fixture.tools.apksigner,
    aapt: fixture.tools.aapt,
    unzip: fixture.tools.unzip,
    expectedSignerSha256: SIGNER_SHA256,
  }, {
    now,
    spawnSync: mockAndroidToolSpawn,
    ...options,
  });
}

function createVerifiedHandoff(root) {
  const fixture = createAndroidProject(root);
  writeInputSnapshot(root, validateProject(root).inputs);
  verifyApk({
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
  return {
    fixture,
    documentPath: path.join(root, 'android-build.json'),
  };
}

test('accepts the exact strict non-secret android-build schema', () => {
  assert.doesNotThrow(() => validateDocumentShape(handoff()));
});

test('rejects unknown fields so credentials cannot hide in the handoff', () => {
  const document = handoff();
  document.signing.keystorePassword = 'not-read';
  assert.throws(
    () => validateDocumentShape(document),
    /signing contains unsupported fields: keystorePassword/,
  );
});

test('rejects credential-shaped top-level or nested keys', () => {
  const document = handoff();
  document.secret = 'not-read';
  assert.throws(
    () => validateDocumentShape(document),
    /android-build\.json contains unsupported fields: secret/,
  );
});

test('requires verified APK signature proof and one true signature scheme', () => {
  const notVerified = handoff();
  notVerified.signing.verified = false;
  assert.throws(() => validateDocumentShape(notVerified), /signing and metadata proof is invalid/);

  const noScheme = handoff();
  noScheme.signing.schemes = { v1: false, v2: false };
  assert.throws(() => validateDocumentShape(noScheme), /verified whole-file APK signature scheme/);

  const v1Only = handoff();
  v1Only.signing.schemes = { v1: true, v2: false };
  assert.throws(() => validateDocumentShape(v1Only), /v2 or newer/);
});

test('requires direct physical-device scope rather than store/AAB scope', () => {
  const document = handoff();
  document.purpose = 'google-play';
  assert.throws(() => validateDocumentShape(document), /direct physical-device Android build/);
});

test('requires strict ISO timestamps and max proof age no greater than 24 hours', () => {
  assert.strictEqual(
    parseTimestamp('2026-08-24T10:05:00.000Z', 'verifiedAt'),
    Date.parse('2026-08-24T10:05:00.000Z'),
  );
  assert.throws(() => parseTimestamp('2026-08-24 10:05:00', 'verifiedAt'), /ISO timestamp/);
  assert.strictEqual(parseArgs([
    '--max-age-hours',
    '12',
    '--expected-signer-sha256',
    SIGNER_SHA256,
  ]).maxAgeHours, 12);
  assert.throws(
    () => parseArgs(['--max-age-hours', '25', '--expected-signer-sha256', SIGNER_SHA256]),
    /no more than 24/,
  );
  assert.throws(() => parseArgs([]), /expected-signer-sha256 is required/);
});

test('requires exact SHA-256 fingerprints and positive size/version fields', () => {
  const shortSigner = handoff();
  shortSigner.signing.certificateSha256 = 'sha256:abcd';
  assert.throws(() => validateDocumentShape(shortSigner), /64-character SHA-256/);

  const emptyArtifact = handoff();
  emptyArtifact.artifact.sizeBytes = 0;
  assert.throws(() => validateDocumentShape(emptyArtifact), /positive integer/);

  const invalidVersion = handoff();
  invalidVersion.app.versionCode = 0;
  assert.throws(() => validateDocumentShape(invalidVersion), /positive integer/);

  const invalidIdentity = handoff();
  invalidIdentity.artifact.modifiedAtNs = '1.5';
  assert.throws(() => validateDocumentShape(invalidIdentity), /decimal integer string/);
});

test('validates a fresh handoff and detects subsequent APK replacement', () => {
  const root = HANDOFF_ROOT;
  const fixture = createAndroidProject(root);
  writeInputSnapshot(root, validateProject(root).inputs);
  verifyApk({
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
  const result = validateFixtureHandoff(
    root,
    fixture,
    new Date('2026-08-24T11:00:00.000Z'),
  );
  assert.strictEqual(result.status, 'valid');

  fs.writeFileSync(fixture.apkPath, 'replaced artifact');
  assert.throws(
    () => validateFixtureHandoff(
      root,
      fixture,
      new Date('2026-08-24T11:00:00.000Z'),
    ),
    /APK changed after android-build\.json/,
  );
});

test('rejects an otherwise valid handoff after its 24-hour proof expires', () => {
  const root = STALE_ROOT;
  const fixture = createAndroidProject(root);
  writeInputSnapshot(root, validateProject(root).inputs);
  verifyApk({
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
  assert.throws(
    () => validateFixtureHandoff(
      root,
      fixture,
      new Date('2026-08-25T10:05:01.000Z'),
    ),
    /expired or older than the allowed proof age/,
  );
});

test('rejects handoff when declared source changes but APK identity stays the same', () => {
  const root = SOURCE_ROOT;
  const fixture = createAndroidProject(root);
  writeInputSnapshot(root, validateProject(root).inputs);
  verifyApk({
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
  fs.appendFileSync(path.join(root, 'src', 'push.ts'), '// post-verification drift\n');
  assert.throws(
    () => validateFixtureHandoff(
      root,
      fixture,
      new Date('2026-08-24T11:00:00.000Z'),
    ),
    /Declared Android app\/push inputs changed after android-build\.json/,
  );
});

test('rejects a handoff when proof was inserted after the last whole-file signature', () => {
  const root = path.join(BINDING_ROOT, 'proof-after-signing');
  const fixture = createAndroidProject(root);
  writeInputSnapshot(root, validateProject(root).inputs);
  verifyApk({
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

  removeFakeApkSigningBlock(fixture.apkPath);
  const modified = new Date('2026-08-24T10:00:06.000Z');
  fs.utimesSync(fixture.apkPath, modified, modified);
  const documentPath = path.join(root, 'android-build.json');
  const document = JSON.parse(fs.readFileSync(documentPath, 'utf8'));
  updateDocumentArtifactIdentity(root, fixture.apkPath, document);
  fs.writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`);

  assert.throws(
    () => validateFixtureHandoff(
      root,
      fixture,
      new Date('2026-08-24T11:00:00.000Z'),
    ),
    /not covered by a final APK Signature Scheme v2\+ signing block/,
  );
});

test('rejects a substituted signed APK carrying an older declared-input digest', () => {
  const root = path.join(BINDING_ROOT, 'current');
  const fixture = createAndroidProject(root);
  writeInputSnapshot(root, validateProject(root).inputs);
  verifyApk({
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

  const replacementRoot = path.join(BINDING_ROOT, 'older');
  const replacement = createAndroidProject(replacementRoot);
  fs.appendFileSync(path.join(replacementRoot, 'src', 'push.ts'), '// older different source\n');
  writeInputSnapshot(replacementRoot, validateProject(replacementRoot).inputs);
  fs.copyFileSync(replacement.apkPath, fixture.apkPath);
  const modified = new Date('2026-08-24T10:00:06.000Z');
  fs.utimesSync(fixture.apkPath, modified, modified);

  const documentPath = path.join(root, 'android-build.json');
  const document = JSON.parse(fs.readFileSync(documentPath, 'utf8'));
  updateDocumentArtifactIdentity(root, fixture.apkPath, document);
  fs.writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`);

  assert.throws(
    () => validateFixtureHandoff(
      root,
      fixture,
      new Date('2026-08-24T11:00:00.000Z'),
    ),
    /input proof differs from the captured declared-input digest/,
  );
});

test('rejects forged signer identity in an otherwise valid handoff', () => {
  const root = path.join(BINDING_ROOT, 'forged-signer');
  const { fixture, documentPath } = createVerifiedHandoff(root);
  const document = JSON.parse(fs.readFileSync(documentPath, 'utf8'));
  document.signing.certificateSha256 = `sha256:${'cd'.repeat(32)}`;
  fs.writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`);

  assert.throws(
    () => validateFixtureHandoff(
      root,
      fixture,
      new Date('2026-08-24T11:00:00.000Z'),
    ),
    /Fresh APK signature proof differs from the expected customer identity/,
  );
});

test('rejects a forged handoff even when its signer field matches an unexpected APK signer', () => {
  const root = path.join(BINDING_ROOT, 'forged-handoff-and-signer');
  const { fixture, documentPath } = createVerifiedHandoff(root);
  const forgedSigner = 'cd'.repeat(32);
  const document = JSON.parse(fs.readFileSync(documentPath, 'utf8'));
  document.signing.certificateSha256 = `sha256:${forgedSigner}`;
  fs.writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`);
  const forgedSignerSpawn = (command, args, options) => {
    const result = mockAndroidToolSpawn(command, args, options);
    if (path.basename(command) === 'apksigner') {
      result.stdout = result.stdout.replace(SIGNER_SHA256, forgedSigner);
    }
    return result;
  };

  assert.throws(
    () => validateFixtureHandoff(
      root,
      fixture,
      new Date('2026-08-24T11:00:00.000Z'),
      { spawnSync: forgedSignerSpawn },
    ),
    /Fresh APK signature proof differs from the expected customer identity/,
  );
});

test('rejects forged packaged SDK metadata in android-build.json', () => {
  const root = path.join(BINDING_ROOT, 'forged-metadata');
  const { fixture, documentPath } = createVerifiedHandoff(root);
  const document = JSON.parse(fs.readFileSync(documentPath, 'utf8'));
  document.app.minSdkVersion = 25;
  document.app.targetSdkVersion = 34;
  fs.writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`);

  assert.throws(
    () => validateFixtureHandoff(
      root,
      fixture,
      new Date('2026-08-24T11:00:00.000Z'),
    ),
    /Fresh APK package\/version\/SDK\/icon metadata differs/,
  );
});

test('rejects forged packaged icon hash in android-build.json', () => {
  const root = path.join(BINDING_ROOT, 'forged-icon');
  const { fixture, documentPath } = createVerifiedHandoff(root);
  const document = JSON.parse(fs.readFileSync(documentPath, 'utf8'));
  document.app.packagedIconSha256 = `sha256:${'ef'.repeat(32)}`;
  fs.writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`);

  assert.throws(
    () => validateFixtureHandoff(
      root,
      fixture,
      new Date('2026-08-24T11:00:00.000Z'),
    ),
    /Fresh packaged APK icon differs/,
  );
});

test('rejects fresh packaged metadata that differs from the recorded handoff', () => {
  const root = path.join(BINDING_ROOT, 'tampered-packaged-metadata');
  const { fixture } = createVerifiedHandoff(root);
  const tamperedMetadataSpawn = (command, args, options) => {
    const result = mockAndroidToolSpawn(command, args, options);
    if (path.basename(command) === 'aapt' && args[1] === 'badging') {
      result.stdout = result.stdout.replace("targetSdkVersion:'35'", "targetSdkVersion:'34'");
    }
    return result;
  };

  assert.throws(
    () => validateFixtureHandoff(
      root,
      fixture,
      new Date('2026-08-24T11:00:00.000Z'),
      { spawnSync: tamperedMetadataSpawn },
    ),
    /Fresh APK package\/version\/SDK\/icon metadata differs/,
  );
});

test('rejects fresh packaged Firebase identity that differs from the handoff', () => {
  const root = path.join(BINDING_ROOT, 'tampered-packaged-firebase');
  const { fixture } = createVerifiedHandoff(root);
  const tamperedFirebaseSpawn = (command, args, options) => {
    const result = mockAndroidToolSpawn(command, args, options);
    if (path.basename(command) === 'aapt' && args[1] === 'resources') {
      result.stdout = result.stdout.replace('field-ops-prod', 'forged-project');
    }
    return result;
  };

  assert.throws(
    () => validateFixtureHandoff(
      root,
      fixture,
      new Date('2026-08-24T11:00:00.000Z'),
      { spawnSync: tamperedFirebaseSpawn },
    ),
    /Fresh APK Firebase\/package identity differs/,
  );
});

test('rejects a same-size APK mutation during handoff validation', () => {
  const root = path.join(BINDING_ROOT, 'handoff-race');
  const fixture = createAndroidProject(root);
  writeInputSnapshot(root, validateProject(root).inputs);
  verifyApk({
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

  let mutated = false;
  assert.throws(
    () => validateFixtureHandoff(
      root,
      fixture,
      new Date('2026-08-24T11:00:00.000Z'),
      {
      onArtifactPhase(phase, artifactPath) {
        if (phase !== 'embedded-input-proof' || mutated) return;
        const stat = fs.statSync(artifactPath);
        const descriptor = fs.openSync(artifactPath, 'r+');
        try {
          const byte = Buffer.alloc(1);
          fs.readSync(descriptor, byte, 0, 1, 0);
          byte[0] ^= 0xff;
          fs.writeSync(descriptor, byte, 0, 1, 0);
        } finally {
          fs.closeSync(descriptor);
        }
        fs.utimesSync(artifactPath, stat.atime, stat.mtime);
        mutated = true;
      },
      },
    ),
    /changed during embedded input-proof handoff validation/,
  );
});
