'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  parsePlistStrings,
  validateAndroidConfig,
  validateIosConfig,
} = require('../validate-firebase-client-config');

const SCRIPT = path.join(__dirname, '..', 'validate-firebase-client-config.js');
const EXPECTED = {
  projectId: 'field-service-prod',
  appId: '1:123456789:android:abc123',
  identifier: 'com.contoso.fieldservice',
};

function androidConfig(overrides = {}) {
  return {
    project_info: { project_id: EXPECTED.projectId },
    client: [{
      client_info: {
        mobilesdk_app_id: EXPECTED.appId,
        android_client_info: { package_name: EXPECTED.identifier },
      },
    }],
    ...overrides,
  };
}

function plist(values = {}) {
  const merged = {
    PROJECT_ID: EXPECTED.projectId,
    GOOGLE_APP_ID: '1:123456789:ios:def456',
    BUNDLE_ID: 'com.contoso.fieldservice',
    ...values,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>PROJECT_ID</key>
  <string>${merged.PROJECT_ID}</string>
  <key>GOOGLE_APP_ID</key>
  <string>${merged.GOOGLE_APP_ID}</string>
  <key>BUNDLE_ID</key>
  <string>${merged.BUNDLE_ID}</string>
  <key>IS_ADS_ENABLED</key>
  <false/>
</dict>
</plist>
`;
}

function createFixture() {
  return fs.mkdtempSync(path.join(__dirname, '.firebase-config-fixture-'));
}

function run(root, args) {
  return spawnSync(process.execPath, [
    SCRIPT,
    '--project-root', root,
    ...args,
  ], {
    cwd: path.join(__dirname, '..', '..'),
    encoding: 'utf8',
  });
}

function androidArgs() {
  return [
    '--platform', 'android',
    '--candidate', 'firebase/google-services.download.json',
    '--destination', 'firebase/google-services.json',
    '--expected-project-id', EXPECTED.projectId,
    '--expected-app-id', EXPECTED.appId,
    '--expected-identifier', EXPECTED.identifier,
  ];
}

function iosArgs() {
  return [
    '--platform', 'ios',
    '--candidate', 'firebase/GoogleService-Info.download.plist',
    '--destination', 'firebase/GoogleService-Info.plist',
    '--expected-project-id', EXPECTED.projectId,
    '--expected-app-id', '1:123456789:ios:def456',
    '--expected-identifier', EXPECTED.identifier,
  ];
}

test('validates Android project, app ID, and package on one client record', () => {
  assert.deepStrictEqual(
    validateAndroidConfig(Buffer.from(JSON.stringify(androidConfig())), EXPECTED),
    [],
  );

  const splitIdentity = androidConfig({
    client: [
      {
        client_info: {
          mobilesdk_app_id: EXPECTED.appId,
          android_client_info: { package_name: 'com.contoso.other' },
        },
      },
      {
        client_info: {
          mobilesdk_app_id: '1:123456789:android:other',
          android_client_info: { package_name: EXPECTED.identifier },
        },
      },
    ],
  });
  assert.strictEqual(
    validateAndroidConfig(Buffer.from(JSON.stringify(splitIdentity)), EXPECTED)[0].code,
    'android-app-identity-mismatch',
  );
});

test('rejects Android Firebase Admin service-account JSON', () => {
  const admin = {
    type: 'service_account',
    project_id: EXPECTED.projectId,
    private_key_id: 'not-a-real-key',
    private_key: '-----BEGIN PRIVATE KEY-----',
    client_email: 'firebase-adminsdk@example.invalid',
  };
  const issues = validateAndroidConfig(Buffer.from(JSON.stringify(admin)), EXPECTED);
  assert.strictEqual(issues[0].code, 'admin-service-account-forbidden');
});

test('parses official iOS plist scalar shape and validates all expected identities', () => {
  const iosExpected = {
    projectId: EXPECTED.projectId,
    appId: '1:123456789:ios:def456',
    identifier: EXPECTED.identifier,
  };
  assert.deepStrictEqual(parsePlistStrings(Buffer.from(plist())), iosExpected);
  assert.deepStrictEqual(validateIosConfig(Buffer.from(plist()), iosExpected), []);

  const firebasePlist = plist().replace(
    '<plist version="1.0">',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">',
  );
  assert.deepStrictEqual(parsePlistStrings(Buffer.from(firebasePlist)), iosExpected);
  assert.deepStrictEqual(validateIosConfig(Buffer.from(firebasePlist), iosExpected), []);
});

test('rejects custom plist DTD or entity declarations without expansion', () => {
  const customDtd = plist().replace(
    '<plist version="1.0">',
    '<!DOCTYPE plist SYSTEM "https://example.invalid/custom.dtd">\n<plist version="1.0">',
  );
  assert.strictEqual(
    validateIosConfig(Buffer.from(customDtd), {
      projectId: EXPECTED.projectId,
      appId: '1:123456789:ios:def456',
      identifier: EXPECTED.identifier,
    })[0].code,
    'plist-declaration-forbidden',
  );

  const malicious = `<?xml version="1.0"?>
<!DOCTYPE plist [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<plist version="1.0"><dict>
<key>PROJECT_ID</key><string>&xxe;</string>
<key>GOOGLE_APP_ID</key><string>1:123456789:ios:def456</string>
<key>BUNDLE_ID</key><string>${EXPECTED.identifier}</string>
</dict></plist>`;
  const issues = validateIosConfig(Buffer.from(malicious), {
    projectId: EXPECTED.projectId,
    appId: '1:123456789:ios:def456',
    identifier: EXPECTED.identifier,
  });
  assert.strictEqual(issues[0].code, 'plist-declaration-forbidden');
});

test('reports each iOS identity mismatch deterministically', () => {
  const issues = validateIosConfig(Buffer.from(plist({
    PROJECT_ID: 'wrong-project',
    GOOGLE_APP_ID: 'wrong-app',
    BUNDLE_ID: 'com.contoso.wrong',
  })), {
    projectId: EXPECTED.projectId,
    appId: '1:123456789:ios:def456',
    identifier: EXPECTED.identifier,
  });
  assert.deepStrictEqual(issues.map((entry) => entry.code), [
    'project-id-mismatch',
    'ios-app-id-mismatch',
    'ios-bundle-id-mismatch',
  ]);
});

test('CLI returns ready when the canonical Android config is absent', (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'firebase'));
  fs.writeFileSync(
    path.join(root, 'firebase', 'google-services.download.json'),
    `${JSON.stringify(androidConfig(), null, 2)}\n`,
  );

  const result = run(root, androidArgs());
  assert.strictEqual(result.status, 0);
  assert.strictEqual(JSON.parse(result.stdout).status, 'ready');
  assert.strictEqual(fs.existsSync(path.join(root, 'firebase', 'google-services.json')), false);
});

test('CLI validates an iOS candidate without creating the canonical file', (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'firebase'));
  fs.writeFileSync(path.join(root, 'firebase', 'GoogleService-Info.download.plist'), plist());

  const result = run(root, iosArgs());
  assert.strictEqual(result.status, 0);
  assert.strictEqual(JSON.parse(result.stdout).status, 'ready');
  assert.strictEqual(fs.existsSync(path.join(root, 'firebase', 'GoogleService-Info.plist')), false);
});

test('CLI reuses only a byte-for-byte exact validated existing file', (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'firebase'));
  const content = `${JSON.stringify(androidConfig(), null, 2)}\n`;
  fs.writeFileSync(path.join(root, 'firebase', 'google-services.download.json'), content);
  fs.writeFileSync(path.join(root, 'firebase', 'google-services.json'), content);

  const result = run(root, androidArgs());
  assert.strictEqual(result.status, 0);
  assert.strictEqual(JSON.parse(result.stdout).status, 'reuse');
});

test('CLI blocks a semantically valid but non-identical existing file', (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'firebase'));
  fs.writeFileSync(
    path.join(root, 'firebase', 'google-services.download.json'),
    `${JSON.stringify(androidConfig(), null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, 'firebase', 'google-services.json'),
    JSON.stringify(androidConfig()),
  );

  const result = run(root, androidArgs());
  assert.strictEqual(result.status, 2);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.status, 'conflict');
  assert.strictEqual(output.reason, 'existing-content-differs');
});

test('CLI blocks invalid candidates and does not overwrite the destination', (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'firebase'));
  const existing = `${JSON.stringify(androidConfig(), null, 2)}\n`;
  fs.writeFileSync(path.join(root, 'firebase', 'google-services.json'), existing);
  fs.writeFileSync(
    path.join(root, 'firebase', 'google-services.download.json'),
    JSON.stringify(androidConfig({ project_info: { project_id: 'wrong-project' } })),
  );

  const result = run(root, androidArgs());
  assert.strictEqual(result.status, 2);
  assert.strictEqual(JSON.parse(result.stdout).status, 'invalid');
  assert.strictEqual(
    fs.readFileSync(path.join(root, 'firebase', 'google-services.json'), 'utf8'),
    existing,
  );
});

test('CLI rejects project-root traversal and symlink candidates', (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'firebase'));
  const target = path.join(root, 'firebase', 'target.json');
  fs.writeFileSync(target, JSON.stringify(androidConfig()));
  fs.symlinkSync(target, path.join(root, 'firebase', 'google-services.download.json'));

  const symlink = run(root, androidArgs());
  assert.strictEqual(symlink.status, 1);
  assert.strictEqual(JSON.parse(symlink.stdout).issues[0].code, 'file-symbolic-link');

  const traversal = run(root, [
    ...androidArgs().map((value) => (
      value === 'firebase/google-services.download.json' ? '../outside.json' : value
    )),
  ]);
  assert.strictEqual(traversal.status, 1);
  assert.strictEqual(JSON.parse(traversal.stdout).issues[0].code, 'file-outside-project-root');
});

test('CLI rejects a dangling destination symlink rather than replacing it', (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'firebase'));
  fs.writeFileSync(
    path.join(root, 'firebase', 'google-services.download.json'),
    JSON.stringify(androidConfig()),
  );
  fs.symlinkSync(
    path.join(root, 'firebase', 'missing-target.json'),
    path.join(root, 'firebase', 'google-services.json'),
  );

  const result = run(root, androidArgs());
  assert.strictEqual(result.status, 1);
  assert.strictEqual(JSON.parse(result.stdout).issues[0].code, 'file-symbolic-link');
});
