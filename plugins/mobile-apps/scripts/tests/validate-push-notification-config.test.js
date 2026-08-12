'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { main } = require('../validate-push-notification-config');

const TEST_WORK_ROOT = path.join(__dirname, '.validate-push-notification-config-work');
let fixtureIndex = 0;

function projectFixture() {
  fixtureIndex += 1;
  const root = path.join(TEST_WORK_ROOT, `fixture-${process.pid}-${fixtureIndex}`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      scripts: {
        postinstall: 'node scripts/patch-native-host-auth.js',
      },
      dependencies: {
        'expo-notifications': '~55.0.23',
        '@react-native-firebase/app': '25.1.0',
        '@react-native-firebase/messaging': '25.1.0',
        'expo-router': '55.0.14',
      },
    }),
  );
  fs.copyFileSync(
    path.resolve(__dirname, '../../template/app.config.js'),
    path.join(root, 'app.config.js'),
  );
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'patch-native-host-auth.js'), '');
  return root;
}

function evaluateExpoConfig(root, env = {}) {
  const configPath = path.join(root, 'app.config.js');
  const previous = {};

  for (const name of ['GOOGLE_SERVICES_JSON', 'GOOGLE_SERVICE_INFO_PLIST']) {
    previous[name] = process.env[name];
    if (Object.hasOwn(env, name)) process.env[name] = env[name];
    else delete process.env[name];
  }

  delete require.cache[require.resolve(configPath)];
  try {
    return require(configPath)({ config: {} });
  } finally {
    delete require.cache[require.resolve(configPath)];
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function writeFirebaseFile(root, relativePath) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{}');
}

function hasFirebasePlugins(config) {
  return config.plugins.includes('@react-native-firebase/app') &&
    config.plugins.includes('@react-native-firebase/messaging');
}

test.after(() => {
  fs.rmSync(TEST_WORK_ROOT, { recursive: true, force: true });
});

test('accepts the complete notification dependency and config surface', () => {
  const root = projectFixture();
  assert.strictEqual(main(['--project-root', root]), 0);
});

test('keeps Firebase plugins disabled when canonical client files are absent', () => {
  const config = evaluateExpoConfig(projectFixture());
  assert.strictEqual(hasFirebasePlugins(config), false);
  assert.strictEqual(config.android.googleServicesFile, undefined);
  assert.strictEqual(config.ios.googleServicesFile, undefined);
});

test('automatically wires an Android-only canonical client file', () => {
  const root = projectFixture();
  writeFirebaseFile(root, 'firebase/google-services.json');
  const config = evaluateExpoConfig(root);
  assert.strictEqual(hasFirebasePlugins(config), true);
  assert.strictEqual(config.android.googleServicesFile, './firebase/google-services.json');
  assert.strictEqual(config.ios.googleServicesFile, undefined);
});

test('automatically wires an iOS-only canonical client file', () => {
  const root = projectFixture();
  writeFirebaseFile(root, 'firebase/GoogleService-Info.plist');
  const config = evaluateExpoConfig(root);
  assert.strictEqual(hasFirebasePlugins(config), true);
  assert.strictEqual(config.android.googleServicesFile, undefined);
  assert.strictEqual(config.ios.googleServicesFile, './firebase/GoogleService-Info.plist');
});

test('automatically wires both canonical Firebase client files', () => {
  const root = projectFixture();
  writeFirebaseFile(root, 'firebase/google-services.json');
  writeFirebaseFile(root, 'firebase/GoogleService-Info.plist');
  const config = evaluateExpoConfig(root);
  assert.strictEqual(hasFirebasePlugins(config), true);
  assert.strictEqual(config.android.googleServicesFile, './firebase/google-services.json');
  assert.strictEqual(config.ios.googleServicesFile, './firebase/GoogleService-Info.plist');
});

test('uses explicit project-relative overrides and does not fall back from a missing override', () => {
  const root = projectFixture();
  writeFirebaseFile(root, 'firebase/google-services.json');
  writeFirebaseFile(root, 'config/android-firebase.json');
  writeFirebaseFile(root, 'config/ios-firebase.plist');

  const overridden = evaluateExpoConfig(root, {
    GOOGLE_SERVICES_JSON: './config/android-firebase.json',
    GOOGLE_SERVICE_INFO_PLIST: 'config/ios-firebase.plist',
  });
  assert.strictEqual(overridden.android.googleServicesFile, './config/android-firebase.json');
  assert.strictEqual(overridden.ios.googleServicesFile, './config/ios-firebase.plist');

  const missingOverride = evaluateExpoConfig(root, {
    GOOGLE_SERVICES_JSON: './config/missing.json',
  });
  assert.strictEqual(missingOverride.android.googleServicesFile, undefined);
  assert.strictEqual(hasFirebasePlugins(missingOverride), false);

  const absoluteOverride = evaluateExpoConfig(root, {
    GOOGLE_SERVICES_JSON: path.join(root, 'config/android-firebase.json'),
  });
  assert.strictEqual(absoluteOverride.android.googleServicesFile, undefined);
});

test('rejects a config path that escapes through a symlinked parent directory', (t) => {
  const root = projectFixture();
  const outside = path.join(TEST_WORK_ROOT, `outside-${process.pid}-${fixtureIndex}`);
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'google-services.json'), '{}');
  fs.symlinkSync(outside, path.join(root, 'firebase'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  const config = evaluateExpoConfig(root);
  assert.strictEqual(config.android.googleServicesFile, undefined);
  assert.strictEqual(hasFirebasePlugins(config), false);
});

test('blocks when Firebase Messaging is missing', () => {
  const root = projectFixture();
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  delete pkg.dependencies['@react-native-firebase/messaging'];
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  assert.strictEqual(main(['--project-root', root]), 2);
});

test('blocks Firebase Admin credential files anywhere in the project', () => {
  const root = projectFixture();
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config', 'firebase-adminsdk-sender.json'), '{}');
  assert.strictEqual(main(['--project-root', root]), 2);
});
