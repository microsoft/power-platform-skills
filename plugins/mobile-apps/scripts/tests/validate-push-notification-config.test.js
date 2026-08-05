'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../validate-push-notification-config');

function projectFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-config-'));
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
  fs.writeFileSync(
    path.join(root, 'app.config.js'),
    [
      'const HAS_FIREBASE_CLIENT_CONFIG = true;',
      "const plugins = ['expo-notifications', '@react-native-firebase/app', '@react-native-firebase/messaging'];",
      "const android = { googleServicesFile: './google-services.json' };",
      "const ios = { googleServicesFile: './GoogleService-Info.plist', entitlements: { 'aps-environment': 'development' } };",
    ].join('\n'),
  );
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'patch-native-host-auth.js'), '');
  return root;
}

test('accepts the complete notification dependency and config surface', () => {
  const root = projectFixture();
  assert.strictEqual(main(['--project-root', root]), 0);
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
