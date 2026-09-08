'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  capturePreBuildSnapshot,
  captureStableFile,
  parseArgs: parseWriteArgs,
  writeHandoff,
} = require('../write-ios-build-handoff');
const {
  parseArgs,
  validateDocumentShape,
  validateHandoff,
} = require('../validate-ios-build-handoff');

const TEST_ROOT = path.join(__dirname, '.validate-ios-build-handoff-work');
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_ID = 'ABCD1234EF';
const INPUTS_CAPTURED_AT = new Date('2026-09-08T09:59:00.000Z');
const GENERATED_AT = new Date('2026-09-08T10:05:00.000Z');

test.after(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

function write(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function createProject(name, mode = 'development') {
  const root = path.join(TEST_ROOT, name);
  fs.rmSync(root, { recursive: true, force: true });
  const bundleIdentifier = 'com.contoso.fieldops';
  const apnsEnvironment = mode === 'development' ? 'development' : 'production';
  write(root, 'app/home.tsx', 'export default function Home() { return null; }\n');
  write(root, 'src/push.ts', 'export const pushEnabled = true;\n');
  write(root, 'firebase/runtime.ts', 'export const configured = true;\n');
  write(root, 'firebase.json', '{"react-native":{"messaging_auto_init_enabled":true}}\n');
  write(root, 'index.js', "import './src/push';\n");
  write(root, 'app.json', '{"expo":{"extra":{"powerappsNative":{"schemaVersion":1}}}}\n');
  write(root, 'babel.config.js', 'module.exports = { presets: ["babel-preset-expo"] };\n');
  write(root, 'metro.config.js', 'module.exports = {};\n');
  write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n');
  write(root, 'tsconfig.paths.json', '{"compilerOptions":{"baseUrl":"."}}\n');
  write(root, 'tamagui.config.ts', 'export default {};\n');
  write(root, 'native-runtime.json', '{"ios":1}\n');
  write(root, 'fingerprint.config.js', 'module.exports = {};\n');
  write(root, 'power.config.json', '{"environmentId":"00000000-0000-0000-0000-000000000000"}\n');
  write(root, 'brand/tokens.ts', 'export const tokens = {};\n');
  write(root, 'branding/splash.png', 'splash');
  write(root, 'plugins/with-ios-settings.js', 'module.exports = (config) => config;\n');
  write(root, 'package-lock.json', '{"name":"field-ops","lockfileVersion":3}\n');
  write(root, 'package.json', JSON.stringify({
    name: 'field-ops',
    main: 'index.js',
    scripts: { 'build:ios': 'wrap ios', 'bundle:ios': 'js-bundle ios' },
    dependencies: { '@microsoft/power-apps-native-host': '0.3.3' },
  }));
  write(root, 'auth.config.json', JSON.stringify({
    msal: { clientId: CLIENT_ID, tenantId: TENANT_ID },
  }));
  write(root, 'wrap.config.json', JSON.stringify({
    bundleIdentifier,
    displayName: 'Field Ops',
    version: '1.2.3',
    versionCode: 7,
    iconPath: './assets/icon.png',
    msal: { clientId: CLIENT_ID, tenantId: TENANT_ID },
    ios: {
      simulator: false,
      signing: { exportMethod: mode, teamId: TEAM_ID },
    },
    outputPath: './dist',
  }));
  write(root, 'assets/icon.png', 'png');
  write(root, 'app.config.js', `
module.exports = {
  name: process.env.APP_DISPLAY_NAME,
  version: process.env.APP_VERSION,
  icon: process.env.APP_ICON_PATH,
  splash: { image: './branding/splash.png' },
  plugins: ['./plugins/with-ios-settings.js'],
  ios: {
    bundleIdentifier: process.env.IOS_BUNDLE_IDENTIFIER,
    googleServicesFile: './firebase/GoogleService-Info.plist',
    entitlements: { 'aps-environment': process.env.APNS_ENVIRONMENT },
  },
};
`);
  write(root, 'firebase/GoogleService-Info.plist', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PROJECT_ID</key><string>field-ops-prod</string>
<key>GOOGLE_APP_ID</key><string>1:123456789:ios:abc123</string>
<key>BUNDLE_ID</key><string>${bundleIdentifier}</string>
</dict></plist>`);
  write(root, 'node_modules/@microsoft/power-apps-native-host/package.json', JSON.stringify({
    name: '@microsoft/power-apps-native-host',
    version: '0.3.3',
  }));
  const markerPath = write(root, '.tmp/ios-build-start', '');
  const artifactPath = write(root, 'dist/FieldOps.ipa', 'opaque ipa bytes; never opened as an archive');
  fs.utimesSync(markerPath, new Date('2026-09-08T10:00:00.000Z'), new Date('2026-09-08T10:00:00.000Z'));
  fs.utimesSync(artifactPath, new Date('2026-09-08T10:01:00.000Z'), new Date('2026-09-08T10:01:00.000Z'));
  return { root, artifactPath };
}

function writeArgs(root, mode = 'development') {
  return {
    projectRoot: root,
    file: 'ios-build.json',
    artifact: 'dist/FieldOps.ipa',
    buildStart: '.tmp/ios-build-start',
    inputSnapshot: '.tmp/ios-build-inputs.json',
    mode,
    expectedTeamId: TEAM_ID,
    validHours: 24,
  };
}

function validateArgs(root) {
  return {
    projectRoot: root,
    file: 'ios-build.json',
    maxAgeHours: 24,
  };
}

function captureInputs(root, mode = 'development', now = INPUTS_CAPTURED_AT) {
  const document = capturePreBuildSnapshot({
    projectRoot: root,
    writeInputSnapshot: '.tmp/ios-build-inputs.json',
    mode,
    expectedTeamId: TEAM_ID,
  }, { now });
  fs.utimesSync(path.join(root, '.tmp/ios-build-inputs.json'), now, now);
  return document;
}

function createHandoff(name, mode = 'development') {
  const fixture = createProject(name, mode);
  captureInputs(fixture.root, mode);
  const document = writeHandoff(writeArgs(fixture.root, mode), { now: GENERATED_AT });
  return { ...fixture, document };
}

test('writes and validates the strict non-secret iOS handoff without opening the IPA archive', () => {
  const { root, document } = createHandoff('valid');
  assert.strictEqual(document.platform, 'ios');
  assert.strictEqual(document.status, 'ready');
  assert.strictEqual(document.purpose, 'registered-physical-device-testing');
  assert.strictEqual(document.artifact.path, 'dist/FieldOps.ipa');
  assert.match(document.artifact.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(document.firebase.iosAppId, '1:123456789:ios:abc123');
  assert.strictEqual(document.build.apnsEnvironment, 'development');
  assert.strictEqual(document.tooling.wrapVersion, '0.3.3');
  assert.strictEqual(
    document.timestamps.validUntil,
    '2026-09-09T10:05:00.000Z',
  );
  const paths = document.inputs.files.map((file) => file.path);
  assert.deepStrictEqual(paths, [...paths].sort((left, right) => Buffer.compare(
    Buffer.from(left),
    Buffer.from(right),
  )));
  assert.ok(paths.includes('src/push.ts'));
  assert.ok(paths.includes('firebase/GoogleService-Info.plist'));
  assert.ok(paths.includes('assets/icon.png'));
  assert.ok(paths.includes('app.json'));
  assert.ok(paths.includes('babel.config.js'));
  assert.ok(paths.includes('metro.config.js'));
  assert.ok(paths.includes('tsconfig.json'));
  assert.ok(paths.includes('tsconfig.paths.json'));
  assert.ok(paths.includes('tamagui.config.ts'));
  assert.ok(paths.includes('native-runtime.json'));
  assert.ok(paths.includes('fingerprint.config.js'));
  assert.ok(paths.includes('power.config.json'));
  assert.ok(paths.includes('brand/tokens.ts'));
  assert.ok(paths.includes('branding/splash.png'));
  assert.ok(paths.includes('plugins/with-ios-settings.js'));
  assert.ok(!paths.includes('ios-build.json'));
  assert.strictEqual(
    document.timestamps.inputsCapturedAt,
    '2026-09-08T09:59:00.000Z',
  );
  assert.strictEqual(
    document.timestamps.buildStartedAt,
    '2026-09-08T10:00:00.000Z',
  );

  const result = validateHandoff(validateArgs(root), {
    now: new Date('2026-09-08T11:00:00.000Z'),
  });
  assert.strictEqual(result.status, 'valid');
  assert.strictEqual(
    result.continuity,
    'pre/post-build-project-inputs-and-fresh-artifact-identity',
  );
  assert.match(result.attestation, /no-signing-profile-certificate/);
  assert.match(result.attestation, /embedded-input-digest/);
});

test('accepts ad-hoc only with ad-hoc export and production APNs', () => {
  const { root, document } = createHandoff('ad-hoc', 'ad-hoc');
  assert.deepStrictEqual(document.build, {
    mode: 'ad-hoc',
    appleTeamId: TEAM_ID,
    exportMethod: 'ad-hoc',
    apnsEnvironment: 'production',
  });
  assert.strictEqual(
    validateHandoff(validateArgs(root), { now: GENERATED_AT }).status,
    'valid',
  );
});

test('requires fresh build marker and validity windows no longer than 24 hours', () => {
  const { root, artifactPath } = createProject('not-fresh');
  captureInputs(root);
  fs.utimesSync(artifactPath, new Date('2026-09-08T09:59:00.000Z'), new Date('2026-09-08T09:59:00.000Z'));
  assert.throws(
    () => writeHandoff(writeArgs(root), { now: GENERATED_AT }),
    /after the current build-start marker/,
  );
  assert.throws(
    () => parseWriteArgs([
      '--artifact', 'dist/FieldOps.ipa',
      '--build-start', '.tmp/ios-build-start',
      '--input-snapshot', '.tmp/ios-build-inputs.json',
      '--mode', 'development',
      '--expected-team-id', TEAM_ID,
      '--valid-hours', '25',
    ]),
    /no more than 24/,
  );
  assert.throws(() => parseArgs(['--max-age-hours', '25']), /no more than 24/);
});

test('requires a separate pre-build snapshot and preserves it as the handoff input proof', () => {
  const { root } = createProject('pre-build-required');
  const args = writeArgs(root);
  delete args.inputSnapshot;
  assert.throws(
    () => writeHandoff(args, { now: GENERATED_AT }),
    /path must be a normalized project-relative path|input snapshot/i,
  );
  assert.throws(
    () => parseWriteArgs([
      '--artifact', 'dist/FieldOps.ipa',
      '--build-start', '.tmp/ios-build-start',
      '--mode', 'development',
      '--expected-team-id', TEAM_ID,
    ]),
    /--input-snapshot is required/,
  );
});

test('blocks handoff writing when build-time mutation changes the pre-build snapshot', () => {
  const { root } = createProject('build-mutated-input');
  const snapshot = captureInputs(root);
  fs.appendFileSync(path.join(root, 'metro.config.js'), '// build mutated config\n');
  assert.throws(
    () => writeHandoff(writeArgs(root), { now: GENERATED_AT }),
    /differ from the snapshot captured before npm run build:ios/,
  );
  assert.strictEqual(fs.existsSync(path.join(root, 'ios-build.json')), false);
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(root, '.tmp/ios-build-inputs.json'), 'utf8')).inputs.digest,
    snapshot.inputs.digest,
  );
});

test('blocks snapshots captured after the build-start marker', () => {
  const { root } = createProject('snapshot-after-build-start');
  const afterBuildStart = new Date('2026-09-08T10:00:02.000Z');
  captureInputs(root, 'development', afterBuildStart);
  assert.throws(
    () => writeHandoff(writeArgs(root), { now: GENERATED_AT }),
    /must be captured and preserved before the iOS build-start marker/,
  );
});

test('rejects missing, malformed, unknown, and credential-shaped handoff fields', () => {
  const { root, document } = createHandoff('schema');
  const handoffPath = path.join(root, 'ios-build.json');

  fs.rmSync(handoffPath);
  assert.throws(() => validateHandoff(validateArgs(root)), /does not exist|Required project path/);

  fs.writeFileSync(handoffPath, '{');
  assert.throws(() => validateHandoff(validateArgs(root)), /valid JSON/);

  const unknown = structuredClone(document);
  unknown.build.notes = 'unexpected';
  assert.throws(() => validateDocumentShape(unknown), /unsupported fields: notes/);

  const credential = structuredClone(document);
  credential.build.provisioningProfile = 'must-not-appear';
  assert.throws(
    () => validateDocumentShape(credential),
    /forbidden credential-shaped fields: build\.provisioningProfile/,
  );

  const missing = structuredClone(document);
  delete missing.artifact.sha256;
  assert.throws(() => validateDocumentShape(missing), /missing required fields: sha256/);
});

test('rejects stale and overlong handoff timestamps', () => {
  const { root, document } = createHandoff('stale');
  assert.throws(
    () => validateHandoff(validateArgs(root), {
      now: new Date('2026-09-09T10:05:00.001Z'),
    }),
    /expired/,
  );

  document.timestamps.validUntil = '2026-09-09T10:05:00.001Z';
  fs.writeFileSync(path.join(root, 'ios-build.json'), `${JSON.stringify(document, null, 2)}\n`);
  assert.throws(
    () => validateHandoff(validateArgs(root), { now: GENERATED_AT }),
    /no longer than 24 hours/,
  );
});

test('rejects an artifact modified before build start even within the former skew window', () => {
  const { root, document } = createHandoff('artifact-before-build-start');
  document.timestamps.buildStartedAt = '2026-09-08T10:03:00.000Z';
  fs.writeFileSync(
    path.join(root, 'ios-build.json'),
    `${JSON.stringify(document, null, 2)}\n`,
  );
  assert.throws(
    () => validateHandoff(validateArgs(root), { now: GENERATED_AT }),
    /pre-build snapshot, build, artifact, and handoff ordering/,
  );
});

test('rejects path escape and symlink substitution', (context) => {
  const escaped = createHandoff('escape');
  escaped.document.artifact.path = '../outside.ipa';
  fs.writeFileSync(
    path.join(escaped.root, 'ios-build.json'),
    `${JSON.stringify(escaped.document, null, 2)}\n`,
  );
  assert.throws(
    () => validateHandoff(validateArgs(escaped.root), { now: GENERATED_AT }),
    /normalized project-relative path|escapes the project/,
  );

  const linked = createHandoff('symlink');
  const replacement = write(linked.root, 'dist/replacement.ipa', 'replacement');
  fs.rmSync(linked.artifactPath);
  try {
    fs.symlinkSync(replacement, linked.artifactPath);
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      context.skip('file symlinks are unavailable on this platform');
      return;
    }
    throw error;
  }
  assert.throws(
    () => validateHandoff(validateArgs(linked.root), { now: GENERATED_AT }),
    /must not contain symlinks|non-symlink/,
  );
});

test('rejects IPA hash, size, and mtime drift', () => {
  const hash = createHandoff('artifact-hash');
  fs.writeFileSync(hash.artifactPath, 'opaque jpa bytes; never opened as an archive');
  fs.utimesSync(
    hash.artifactPath,
    new Date(hash.document.artifact.modifiedAt),
    new Date(hash.document.artifact.modifiedAt),
  );
  assert.throws(
    () => validateHandoff(validateArgs(hash.root), { now: GENERATED_AT }),
    /IPA hash, size, or modification time changed/,
  );

  const size = createHandoff('artifact-size');
  fs.appendFileSync(size.artifactPath, 'more');
  assert.throws(
    () => validateHandoff(validateArgs(size.root), { now: GENERATED_AT }),
    /IPA hash, size, or modification time changed/,
  );

  const mtime = createHandoff('artifact-mtime');
  fs.utimesSync(
    mtime.artifactPath,
    new Date('2026-09-08T10:02:00.000Z'),
    new Date('2026-09-08T10:02:00.000Z'),
  );
  assert.throws(
    () => validateHandoff(validateArgs(mtime.root), { now: GENERATED_AT }),
    /IPA hash, size, or modification time changed/,
  );
});

test('rejects a hash-matching artifact outside the freshly evaluated outputPath', () => {
  const { root, document } = createHandoff('artifact-outside-output');
  const outsidePath = write(root, 'outside/FieldOps.ipa', 'opaque external-to-output IPA');
  fs.utimesSync(
    outsidePath,
    new Date('2026-09-08T10:01:00.000Z'),
    new Date('2026-09-08T10:01:00.000Z'),
  );
  const outside = captureStableFile(root, 'outside/FieldOps.ipa', 'outside IPA', {
    extension: '.ipa',
  });
  document.artifact = {
    path: outside.path,
    sha256: outside.sha256,
    sizeBytes: outside.sizeBytes,
    modifiedAt: outside.modifiedAt,
  };
  fs.writeFileSync(
    path.join(root, 'ios-build.json'),
    `${JSON.stringify(document, null, 2)}\n`,
  );
  assert.throws(
    () => validateHandoff(validateArgs(root), { now: GENERATED_AT }),
    /must remain inside the freshly evaluated Wrap outputPath/,
  );
});

test('rejects atomic replacement of ios-build.json during validation', () => {
  const { root } = createHandoff('handoff-replacement-race');
  const handoffPath = path.join(root, 'ios-build.json');
  const original = fs.readFileSync(handoffPath);
  const originalStat = fs.statSync(handoffPath);
  assert.throws(
    () => validateHandoff(validateArgs(root), {
      now: GENERATED_AT,
      beforeFinalHandoffCheck() {
        const replacementPath = path.join(root, '.ios-build-replacement.json');
        fs.writeFileSync(replacementPath, original);
        fs.utimesSync(replacementPath, originalStat.atime, originalStat.mtime);
        fs.renameSync(replacementPath, handoffPath);
      },
    }),
    /ios-build\.json changed or was replaced during handoff validation/,
  );
});

test('rejects declared-input additions, removals, and content drift', () => {
  const addition = createHandoff('input-addition');
  write(addition.root, 'src/new-push-input.ts', 'export {};\n');
  assert.throws(
    () => validateHandoff(validateArgs(addition.root), { now: GENERATED_AT }),
    /added: src\/new-push-input\.ts/,
  );

  const removal = createHandoff('input-removal');
  fs.rmSync(path.join(removal.root, 'src/push.ts'));
  assert.throws(
    () => validateHandoff(validateArgs(removal.root), { now: GENERATED_AT }),
    /removed: src\/push\.ts/,
  );

  const content = createHandoff('input-content');
  fs.appendFileSync(path.join(content.root, 'app/home.tsx'), '// drift\n');
  assert.throws(
    () => validateHandoff(validateArgs(content.root), { now: GENERATED_AT }),
    /input content changed/,
  );

  const icon = createHandoff('input-icon');
  fs.appendFileSync(path.join(icon.root, 'assets/icon.png'), 'changed');
  assert.throws(
    () => validateHandoff(validateArgs(icon.root), { now: GENERATED_AT }),
    /input content changed/,
  );

  const rootConfig = createHandoff('input-root-config');
  fs.appendFileSync(path.join(rootConfig.root, 'tamagui.config.ts'), '// drift\n');
  assert.throws(
    () => validateHandoff(validateArgs(rootConfig.root), { now: GENERATED_AT }),
    /input content changed/,
  );
});
