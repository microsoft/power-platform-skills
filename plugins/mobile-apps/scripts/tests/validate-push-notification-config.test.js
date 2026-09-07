'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  evaluateExpoConfig: evaluateConfigFile,
  main,
} = require('../validate-push-notification-config');

const TEST_WORK_ROOT = path.join(__dirname, '.validate-push-notification-config-work');
const TEMPLATE_ROOT = path.resolve(__dirname, '../../template');
const PROJECT_ID = 'mobile-client-test';
const ANDROID_APP_ID = '1:123456789:android:abc123';
const IOS_APP_ID = '1:123456789:ios:def456';
const IDENTIFIER = 'com.contoso.powerappsapp';
let fixtureIndex = 0;

function projectFixture() {
  fixtureIndex += 1;
  const root = path.join(TEST_WORK_ROOT, `fixture-${process.pid}-${fixtureIndex}`);
  fs.mkdirSync(root, { recursive: true });
  for (const relativePath of [
    'app.config.js',
    'firebase.json',
    'index.js',
    'scripts/patch-native-host-auth.js',
  ]) {
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(TEMPLATE_ROOT, relativePath), destination);
  }
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      main: 'index.js',
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
  return root;
}

function withEnvironment(env, callback) {
  const names = [
    'APNS_ENVIRONMENT',
    'GOOGLE_SERVICES_JSON',
    'GOOGLE_SERVICE_INFO_PLIST',
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) {
    if (Object.hasOwn(env, name)) process.env[name] = env[name];
    else delete process.env[name];
  }
  try {
    return callback();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function evaluateExpoConfig(root, env = {}) {
  return withEnvironment(env, () => (
    evaluateConfigFile(path.join(root, 'app.config.js'))
  ));
}

function writeFirebaseFile(root, relativePath) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (relativePath.endsWith('.plist')) {
    fs.writeFileSync(filePath, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>PROJECT_ID</key><string>${PROJECT_ID}</string>
<key>GOOGLE_APP_ID</key><string>${IOS_APP_ID}</string>
<key>BUNDLE_ID</key><string>${IDENTIFIER}</string>
</dict></plist>`);
  } else {
    fs.writeFileSync(filePath, JSON.stringify({
      project_info: { project_id: PROJECT_ID },
      client: [{
        client_info: {
          mobilesdk_app_id: ANDROID_APP_ID,
          android_client_info: { package_name: IDENTIFIER },
        },
      }],
    }));
  }
}

function completeClientIntegration(root) {
  writeFirebaseFile(root, 'firebase/google-services.json');
  writeFirebaseFile(root, 'firebase/GoogleService-Info.plist');
  fs.mkdirSync(path.join(root, 'src/native'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/navigation'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/navigation/linkContract.ts'), `
import { router } from 'expo-router';

export type NavigationResult =
  | { ok: true; value: { schemaVersion: '1'; destination: 'notifications'; params: {} } }
  | {
      ok: false;
      reason:
        | 'unsupported-version'
        | 'unknown-destination'
        | 'invalid-params'
        | 'unapproved-origin'
        | 'malformed-link';
    };

export const parsePushNavigationIntent = (
  data?: Record<string, string | undefined>,
): NavigationResult => {
  if (data?.schemaVersion !== '1') return { ok: false, reason: 'unsupported-version' };
  if (data.destination !== 'notifications') return { ok: false, reason: 'unknown-destination' };
  try {
    const params = JSON.parse(data.params || '');
    if (!params || Array.isArray(params) || Object.keys(params).length !== 0) {
      return { ok: false, reason: 'invalid-params' };
    }
    return {
      ok: true,
      value: { schemaVersion: '1', destination: 'notifications', params: {} },
    };
  } catch {
    return { ok: false, reason: 'malformed-link' };
  }
};

export const parseNavigationUrl = (value: string): NavigationResult => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'powerapps-standalone-app:' && url.origin !== 'https://mobile.contoso.com') {
      return { ok: false, reason: 'unapproved-origin' };
    }
    return parsePushNavigationIntent({
      schemaVersion: '1',
      destination: url.pathname.split('/').filter(Boolean).at(-1),
      params: '{}',
    });
  } catch {
    return { ok: false, reason: 'malformed-link' };
  }
};

export const navigateTo = (intent: {
  schemaVersion: '1';
  destination: 'notifications';
  params: {};
}): NavigationResult => {
  router.navigate('/notifications');
  return { ok: true, value: intent };
};
`);
  fs.writeFileSync(path.join(root, 'src/native/pushNotifications.ts'), `
import * as Notifications from 'expo-notifications';
import messaging from '@react-native-firebase/messaging';
import { Linking, Platform } from 'react-native';
import { parsePushNavigationIntent } from '../navigation/linkContract';

export type PushResult =
  | { ok: true; value?: string }
  | {
      ok: false;
      reason:
        | 'unsupported'
        | 'permission-denied'
        | 'missing-oid'
        | 'unsupported-version'
        | 'unknown-destination'
        | 'invalid-params'
        | 'unapproved-origin'
        | 'malformed-link'
        | 'firebase-error'
        | 'notification-error';
    };

export async function getPushPermissionState(): Promise<PushResult> {
  try {
    const permission = await Notifications.getPermissionsAsync();
    return permission.granted
      ? { ok: true }
      : { ok: false, reason: 'permission-denied' };
  } catch {
    return { ok: false, reason: 'notification-error' };
  }
}

export async function requestPushPermission(): Promise<PushResult> {
  if (Platform.OS === 'web') return { ok: false, reason: 'unsupported' };
  try {
    const permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted) return { ok: false, reason: 'permission-denied' };
    if (!messaging().isDeviceRegisteredForRemoteMessages) {
      await messaging().registerDeviceForRemoteMessages();
    }
    await messaging().setAutoInitEnabled(true);
    const token = await messaging().getToken();
    if (!token) return { ok: false, reason: 'firebase-error' };
    return syncPushTopic(null);
  } catch {
    return { ok: false, reason: 'firebase-error' };
  }
}

export async function openPushSettings(): Promise<PushResult> {
  try {
    await Linking.openSettings();
    return { ok: true };
  } catch {
    return { ok: false, reason: 'notification-error' };
  }
}

export async function syncPushTopic(oid: string | null): Promise<PushResult> {
  try {
    const topic = oid ? oid.toLowerCase() : 'allUsers';
    if (oid === '') return { ok: false, reason: 'missing-oid' };
    await messaging().subscribeToTopic(topic);
    await messaging().unsubscribeFromTopic(topic === 'allUsers' ? 'previousOid' : 'allUsers');
    return { ok: true, value: topic };
  } catch {
    return { ok: false, reason: 'firebase-error' };
  }
}

export async function disablePushNotifications(): Promise<PushResult> {
  try {
    await messaging().unsubscribeFromTopic('allUsers');
    return { ok: true };
  } catch {
    return { ok: false, reason: 'firebase-error' };
  }
}

export function registerNotificationHandlers(): () => void {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
    const unsubscribeForeground = messaging().onMessage(async (message) => {
      parsePushNavigationIntent(message.data);
    });
    const unsubscribeRefresh = messaging().onTokenRefresh(async () => {
      await syncPushTopic(null);
    });
    const responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
      parsePushNavigationIntent(response.notification.request.content.data);
    });
    return () => {
      unsubscribeForeground();
      unsubscribeRefresh();
      responseSubscription.remove();
    };
  } catch {
    return () => {};
  }
}

export async function handleBackgroundNotification(message: {
  data?: Record<string, string | undefined>;
}): Promise<PushResult> {
  try {
    return parsePushNavigationIntent(message.data);
  } catch {
    return { ok: false, reason: 'notification-error' };
  }
}

export async function consumeInitialNotificationIntent(): Promise<PushResult> {
  try {
    const response = await Notifications.getLastNotificationResponseAsync();
    return parsePushNavigationIntent(response?.notification.request.content.data);
  } catch {
    return { ok: false, reason: 'notification-error' };
  }
}
`);
  fs.writeFileSync(path.join(root, 'index.js'), `
'use strict';
const { Platform } = require('react-native');
if (Platform.OS !== 'web') {
  const messaging = require('@react-native-firebase/messaging').default;
  const { handleBackgroundNotification } = require('./src/native/pushNotifications');
  messaging().setBackgroundMessageHandler(handleBackgroundNotification);
}
require('expo-router/entry');
`);
  fs.mkdirSync(path.join(root, 'app/settings'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/hooks/usePushNotificationLifecycle.ts'), `
import { useEffect } from 'react';
import {
  registerNotificationHandlers,
  syncPushTopic,
} from '../native/pushNotifications';

export function usePushNotificationLifecycle(oid: string | null) {
  useEffect(() => {
    void syncPushTopic(oid);
    return registerNotificationHandlers();
  }, [oid]);
}
`);
  fs.writeFileSync(path.join(root, 'app/_layout.tsx'), `
import { usePushNotificationLifecycle } from '../src/hooks/usePushNotificationLifecycle';
export default function Layout() {
  usePushNotificationLifecycle(null);
  return null;
}
`);
  fs.writeFileSync(path.join(root, 'app/login.tsx'), `
import { requestPushPermission } from '../src/native/pushNotifications';
export const Login = () => <Button onPress={requestPushPermission} />;
`);
  fs.writeFileSync(path.join(root, 'app/settings/notifications.tsx'), `
import {
  openPushSettings,
  disablePushNotifications,
} from '../../src/native/pushNotifications';
export const NotificationSettings = () => (
  <>
    <Button onPress={openPushSettings} />
    <Button onPress={disablePushNotifications} />
  </>
);
`);
  fs.writeFileSync(path.join(root, 'memory-bank.md'), [
    `| Firebase project ID | ${PROJECT_ID} |`,
    `| Android Firebase app ID | ${ANDROID_APP_ID} |`,
    `| Android package | ${IDENTIFIER} |`,
    '| Android client config path | firebase/google-services.json |',
    `| iOS Firebase app ID | ${IOS_APP_ID} |`,
    `| iOS bundle ID | ${IDENTIFIER} |`,
    '| iOS client config path | firebase/GoogleService-Info.plist |',
    '',
  ].join('\n'));
}

function writeHostDeclaration(root, content, variant = 'module') {
  const declarationPath = path.join(
    root,
    'node_modules/@microsoft/power-apps-native-host/lib/typescript',
    variant,
    'auth/AuthContext.d.ts',
  );
  fs.mkdirSync(path.dirname(declarationPath), { recursive: true });
  fs.writeFileSync(declarationPath, content);
}

function mutateJson(filePath, mutate) {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  mutate(value);
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function replaceInFile(filePath, from, to) {
  const source = fs.readFileSync(filePath, 'utf8');
  assert.ok(source.includes(from), `fixture must contain ${from}`);
  fs.writeFileSync(filePath, source.replace(from, to));
}

function replaceAllInFile(filePath, from, to) {
  const source = fs.readFileSync(filePath, 'utf8');
  assert.ok(source.includes(from), `fixture must contain ${from}`);
  fs.writeFileSync(filePath, source.split(from).join(to));
}

function replaceFunctionBody(root, name, body) {
  const filePath = path.join(root, 'src/native/pushNotifications.ts');
  const source = fs.readFileSync(filePath, 'utf8');
  const signature = new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${name}\\b`).exec(source);
  assert.ok(signature, `fixture must define ${name}`);
  const open = source.indexOf('{', signature.index + signature[0].length);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let close = -1;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) {
      close = index;
      break;
    }
  }
  assert.ok(close > open, `fixture must have a complete ${name} body`);
  fs.writeFileSync(filePath, `${source.slice(0, open + 1)}\n${body}\n${source.slice(close)}`);
}

function hasFirebasePlugins(config) {
  return config.plugins.includes('@react-native-firebase/app') &&
    config.plugins.includes('@react-native-firebase/messaging');
}

test.after(() => {
  fs.rmSync(TEST_WORK_ROOT, { recursive: true, force: true });
});

test('accepts the complete consent-first iOS notification contract', () => {
  const root = projectFixture();
  writeFirebaseFile(root, 'firebase/GoogleService-Info.plist');
  writeHostDeclaration(
    root,
    'interface AuthState { user: { oid: string; username: string; } | null; }',
  );
  writeHostDeclaration(
    root,
    'interface AuthState { user: { oid: string; tenantId: string; } | null; }',
    'commonjs',
  );
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', root])), 0);
  assert.strictEqual(
    withEnvironment({ APNS_ENVIRONMENT: 'production' }, () => (
      main(['--project-root', root])
    )),
    0,
  );
});

test('strict mode rejects the fresh no-op template and accepts completed generated integration', () => {
  const fresh = projectFixture();
  writeFirebaseFile(fresh, 'firebase/google-services.json');
  writeFirebaseFile(fresh, 'firebase/GoogleService-Info.plist');
  assert.strictEqual(
    withEnvironment({}, () => main(['--project-root', fresh, '--strict-client-integration'])),
    2,
  );

  const completed = projectFixture();
  completeClientIntegration(completed);
  assert.strictEqual(
    withEnvironment({}, () => main(['--project-root', completed, '--strict-client-integration'])),
    0,
  );
});

test('strict mode rejects a placeholder that merely exports the complete surface', () => {
  const root = projectFixture();
  completeClientIntegration(root);
  fs.writeFileSync(path.join(root, 'src/native/pushNotifications.ts'), `
export const getPushPermissionState = async () => ({ ok: true });
export const requestPushPermission = async () => ({ ok: true });
export const openPushSettings = async () => ({ ok: true });
export const syncPushTopic = async () => ({ ok: true });
export const disablePushNotifications = async () => ({ ok: true });
export const registerNotificationHandlers = () => () => {};
export const handleBackgroundNotification = async () => ({ ok: true });
export const consumeInitialNotificationIntent = async () => ({ ok: true });
`);
  assert.strictEqual(
    withEnvironment({}, () => main(['--project-root', root, '--strict-client-integration'])),
    2,
  );
});

test('strict mode rejects dead native evidence and canned outcomes in required functions', () => {
  const cases = [
    ['literal-false permission evidence', 'getPushPermissionState', `
  try {
    if (false) {
      const permission = await Notifications.getPermissionsAsync();
      return permission.granted ? { ok: true } : { ok: false, reason: 'permission-denied' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'notification-error' };
  }`],
    ['constant-false request evidence', 'requestPushPermission', `
  const nativePushEnabled = false;
  try {
    if (nativePushEnabled) {
      const permission = await Notifications.requestPermissionsAsync();
      if (!permission.granted) return { ok: false, reason: 'permission-denied' };
      await messaging().registerDeviceForRemoteMessages();
      await messaging().setAutoInitEnabled(true);
      const token = await messaging().getToken();
      if (!token) return { ok: false, reason: 'firebase-error' };
      return syncPushTopic(null);
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'firebase-error' };
  }`],
    ['calls after unconditional return', 'syncPushTopic', `
  try {
    return { ok: true, value: oid ? oid.toLowerCase() : 'allUsers' };
    await messaging().subscribeToTopic('allUsers');
    await messaging().unsubscribeFromTopic('oldTopic');
    if (oid === '') return { ok: false, reason: 'missing-oid' };
  } catch {
    return { ok: false, reason: 'firebase-error' };
  }`],
    ['negated-true dead settings evidence', 'openPushSettings', `
  try {
    if (!true) await Linking.openSettings();
    return { ok: true };
  } catch {
    return { ok: false, reason: 'notification-error' };
  }`],
    ['constant-comparison dead cleanup evidence', 'disablePushNotifications', `
  try {
    if (1 === 2) await messaging().unsubscribeFromTopic('allUsers');
    return { ok: true };
  } catch {
    return { ok: false, reason: 'firebase-error' };
  }`],
    ['ignored permission result plus canned success', 'getPushPermissionState', `
  try {
    const permission = await Notifications.getPermissionsAsync();
    void permission;
    return { ok: true };
  } catch {
    return { ok: false, reason: 'notification-error' };
  }`],
    ['uncaught permission query', 'getPushPermissionState', `
  const permission = await Notifications.getPermissionsAsync();
  try {
    return permission.granted
      ? { ok: true }
      : { ok: false, reason: 'permission-denied' };
  } catch {
    return { ok: false, reason: 'notification-error' };
  }`],
    ['ignored token result plus canned delegation', 'requestPushPermission', `
  try {
    const permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted) return { ok: false, reason: 'permission-denied' };
    await messaging().registerDeviceForRemoteMessages();
    await messaging().setAutoInitEnabled(true);
    await messaging().getToken();
    return syncPushTopic(null);
  } catch {
    return { ok: false, reason: 'firebase-error' };
  }`],
    ['ignored cold-start response plus canned valid intent', 'consumeInitialNotificationIntent', `
  try {
    await Notifications.getLastNotificationResponseAsync();
    return parsePushNavigationIntent({ schemaVersion: '1', destination: 'notifications', params: '{}' });
  } catch {
    return { ok: false, reason: 'notification-error' };
  }`],
    ['always-success native operation', 'openPushSettings', `
  try {
    await Linking.openSettings();
    return { ok: true };
  } catch {
    return { ok: true };
  }`],
    ['throw-only operation', 'disablePushNotifications', `
  throw new Error('not implemented');`],
  ];

  for (const [variant, functionName, body] of cases) {
    const root = projectFixture();
    completeClientIntegration(root);
    replaceFunctionBody(root, functionName, body);
    assert.strictEqual(
      withEnvironment({}, () => main(['--project-root', root, '--strict-client-integration'])),
      2,
      variant,
    );
  }
});

test('strict mode accepts reachable result-dependent native operation variants', () => {
  const root = projectFixture();
  completeClientIntegration(root);
  replaceInFile(
    path.join(root, 'src/native/pushNotifications.ts'),
    `return permission.granted
      ? { ok: true }
      : { ok: false, reason: 'permission-denied' };`,
    `if (permission.status === 'granted' || permission.granted) {
      return { ok: true };
    }
    return { ok: false, reason: 'permission-denied' };`,
  );
  replaceInFile(
    path.join(root, 'src/native/pushNotifications.ts'),
    "if (!token) return { ok: false, reason: 'firebase-error' };",
    "if (token.trim().length === 0) return { ok: false, reason: 'firebase-error' };",
  );
  assert.strictEqual(
    withEnvironment({}, () => main(['--project-root', root, '--strict-client-integration'])),
    0,
  );
});

test('strict mode rejects every missing critical push integration category', () => {
  const wrapperPath = (root) => path.join(root, 'src/native/pushNotifications.ts');
  const cases = [
    ['notification package imports', (root) => {
      replaceInFile(
        wrapperPath(root),
        "import * as Notifications from 'expo-notifications';",
        '',
      );
    }],
    ['permission query', (root) => {
      replaceInFile(wrapperPath(root), 'Notifications.getPermissionsAsync()', 'readPermission()');
    }],
    ['permission request', (root) => {
      replaceInFile(wrapperPath(root), 'Notifications.requestPermissionsAsync()', 'askPermission()');
    }],
    ['remote registration before token', (root) => {
      replaceInFile(
        wrapperPath(root),
        'await messaging().registerDeviceForRemoteMessages();',
        'await prepareRemoteMessages();',
      );
    }],
    ['auto-init after consent', (root) => {
      replaceInFile(
        wrapperPath(root),
        'await messaging().setAutoInitEnabled(true);',
        'await enableMessaging();',
      );
    }],
    ['token acquisition', (root) => {
      replaceInFile(wrapperPath(root), 'await messaging().getToken();', 'await readToken();');
    }],
    ['token refresh', (root) => {
      replaceInFile(wrapperPath(root), 'messaging().onTokenRefresh(', 'messaging().onTokenChanged(');
    }],
    ['topic subscription', (root) => {
      replaceInFile(wrapperPath(root), 'messaging().subscribeToTopic(', 'messaging().subscribe(');
    }],
    ['topic unsubscription', (root) => {
      replaceAllInFile(
        wrapperPath(root),
        'messaging().unsubscribeFromTopic(',
        'messaging().unsubscribe(',
      );
    }],
    ['foreground handling', (root) => {
      replaceInFile(wrapperPath(root), 'messaging().onMessage(', 'messaging().onForegroundMessage(');
    }],
    ['foreground presentation', (root) => {
      replaceInFile(
        wrapperPath(root),
        'Notifications.setNotificationHandler(',
        'Notifications.configurePresentation(',
      );
    }],
    ['background handling', (root) => {
      replaceInFile(
        wrapperPath(root),
        'return parsePushNavigationIntent(message.data);',
        'return { ok: true };',
      );
    }],
    ['warm response handling', (root) => {
      replaceInFile(
        wrapperPath(root),
        'Notifications.addNotificationResponseReceivedListener(',
        'Notifications.addResponseListener(',
      );
    }],
    ['cold-start handling', (root) => {
      replaceInFile(
        wrapperPath(root),
        'Notifications.getLastNotificationResponseAsync()',
        'readInitialResponse()',
      );
    }],
    ['shared navigation contract', (root) => {
      replaceInFile(
        path.join(root, 'src/navigation/linkContract.ts'),
        'export const parseNavigationUrl',
        'const parseNavigationUrl',
      );
    }],
    ['legacy deepLink field', (root) => {
      replaceInFile(
        wrapperPath(root),
        'data?: Record<string, string | undefined>;',
        'data?: Record<string, string | undefined> & { deepLink?: string };',
      );
    }],
    ['non-throwing discriminated results', (root) => {
      replaceAllInFile(wrapperPath(root), "'unsupported'", "'not-supported'");
    }],
    ['lifecycle topic sync', (root) => {
      replaceInFile(
        path.join(root, 'src/hooks/usePushNotificationLifecycle.ts'),
        'void syncPushTopic(oid);',
        '',
      );
    }],
    ['single lifecycle mount', (root) => {
      replaceInFile(
        path.join(root, 'app/_layout.tsx'),
        'usePushNotificationLifecycle(null);',
        'usePushNotificationLifecycle(null);\n  usePushNotificationLifecycle(null);',
      );
    }],
  ];

  for (const [category, mutate] of cases) {
    const root = projectFixture();
    completeClientIntegration(root);
    mutate(root);
    assert.strictEqual(
      withEnvironment({}, () => main(['--project-root', root, '--strict-client-integration'])),
      2,
      category,
    );
  }
});

test('strict identity validation blocks wrong package, bundle, project, and memory handoff', () => {
  const wrongPackage = projectFixture();
  completeClientIntegration(wrongPackage);
  const androidPath = path.join(wrongPackage, 'firebase/google-services.json');
  mutateJson(androidPath, (config) => {
    config.client[0].client_info.android_client_info.package_name = 'com.contoso.wrong';
  });
  assert.strictEqual(
    withEnvironment({}, () => main(['--project-root', wrongPackage, '--strict-client-integration'])),
    2,
  );

  const wrongBundle = projectFixture();
  completeClientIntegration(wrongBundle);
  replaceInFile(
    path.join(wrongBundle, 'firebase/GoogleService-Info.plist'),
    IDENTIFIER,
    'com.contoso.wrong',
  );
  assert.strictEqual(
    withEnvironment({}, () => main(['--project-root', wrongBundle, '--strict-client-integration'])),
    2,
  );

  const wrongProject = projectFixture();
  completeClientIntegration(wrongProject);
  mutateJson(path.join(wrongProject, 'firebase/google-services.json'), (config) => {
    config.project_info.project_id = 'different-project';
  });
  assert.strictEqual(
    withEnvironment({}, () => main(['--project-root', wrongProject, '--strict-client-integration'])),
    2,
  );

  const wrongHandoff = projectFixture();
  completeClientIntegration(wrongHandoff);
  fs.writeFileSync(path.join(wrongHandoff, 'memory-bank.md'), '| Firebase project ID | stale-project |\n');
  assert.strictEqual(
    withEnvironment({}, () => main(['--project-root', wrongHandoff, '--strict-client-integration'])),
    2,
  );
});

test('accepts an uninstalled native host but validates every declaration that exists', () => {
  const root = projectFixture();
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', root])), 0);

  writeHostDeclaration(root, 'interface AuthState { user: null; }');
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', root])), 2);

  writeHostDeclaration(root, 'interface AuthState { user: { oid: string; } | null; }');
  writeHostDeclaration(root, 'interface AuthState { user: { username: string; } | null; }', 'commonjs');
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', root])), 2);
});

test('keeps Firebase plugins disabled when canonical client files are absent', () => {
  const root = projectFixture();
  const config = evaluateExpoConfig(root);
  assert.strictEqual(hasFirebasePlugins(config), false);
  assert.strictEqual(config.android.googleServicesFile, undefined);
  assert.strictEqual(config.ios.googleServicesFile, undefined);
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', root])), 0);
});

test('activates Firebase plugins only for regular project-local client files', () => {
  const root = projectFixture();
  writeFirebaseFile(root, 'firebase/google-services.json');
  writeFirebaseFile(root, 'firebase/GoogleService-Info.plist');
  const config = evaluateExpoConfig(root);
  assert.strictEqual(hasFirebasePlugins(config), true);
  assert.strictEqual(config.android.googleServicesFile, './firebase/google-services.json');
  assert.strictEqual(config.ios.googleServicesFile, './firebase/GoogleService-Info.plist');
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', root])), 0);
});

test('supports a valid project-relative iOS plist override', () => {
  const root = projectFixture();
  writeFirebaseFile(root, 'config/ios-firebase.plist');
  assert.strictEqual(
    withEnvironment({ GOOGLE_SERVICE_INFO_PLIST: 'config/ios-firebase.plist' }, () => (
      main(['--project-root', root])
    )),
    0,
  );
});

test('blocks missing, absolute, and escaping iOS plist overrides', () => {
  const root = projectFixture();
  assert.strictEqual(
    withEnvironment({ GOOGLE_SERVICE_INFO_PLIST: './config/missing.plist' }, () => (
      main(['--project-root', root])
    )),
    2,
  );
  assert.strictEqual(
    withEnvironment({ GOOGLE_SERVICE_INFO_PLIST: path.join(root, 'missing.plist') }, () => (
      main(['--project-root', root])
    )),
    2,
  );
  assert.strictEqual(
    withEnvironment({ GOOGLE_SERVICE_INFO_PLIST: '../outside.plist' }, () => (
      main(['--project-root', root])
    )),
    2,
  );
});

test('blocks an iOS plist symlink and a path escaping through a symlinked parent', (t) => {
  const root = projectFixture();
  const outside = path.join(TEST_WORK_ROOT, `outside-${process.pid}-${fixtureIndex}`);
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'GoogleService-Info.plist'), '{}');
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  fs.mkdirSync(path.join(root, 'firebase'));
  fs.symlinkSync(
    path.join(outside, 'GoogleService-Info.plist'),
    path.join(root, 'firebase/GoogleService-Info.plist'),
  );
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', root])), 2);

  fs.rmSync(path.join(root, 'firebase'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(root, 'firebase'));
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', root])), 2);
});

test('blocks Firebase plugin activation without a validated config relationship', () => {
  const root = projectFixture();
  replaceInFile(
    path.join(root, 'app.config.js'),
    'const firebasePlugins = HAS_FIREBASE_CLIENT_CONFIG',
    'const firebasePlugins = true',
  );
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', root])), 2);
});

test('blocks missing and duplicate required Firebase plugins', () => {
  const missing = projectFixture();
  writeFirebaseFile(missing, 'firebase/GoogleService-Info.plist');
  replaceInFile(
    path.join(missing, 'app.config.js'),
    "'@react-native-firebase/messaging',",
    '',
  );
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', missing])), 2);

  const duplicate = projectFixture();
  writeFirebaseFile(duplicate, 'firebase/GoogleService-Info.plist');
  replaceInFile(
    path.join(duplicate, 'app.config.js'),
    "'@react-native-firebase/messaging',",
    "'@react-native-firebase/messaging',\n      '@react-native-firebase/messaging',",
  );
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', duplicate])), 2);
});

test('blocks missing or incorrect static RNFirebase build properties', () => {
  const root = projectFixture();
  writeFirebaseFile(root, 'firebase/GoogleService-Info.plist');
  replaceInFile(path.join(root, 'app.config.js'), "useFrameworks: 'static'", "useFrameworks: 'dynamic'");
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', root])), 2);
});

test('requires an explicitly resolvable APNs environment and remote notification mode', () => {
  const root = projectFixture();
  assert.strictEqual(
    withEnvironment({ APNS_ENVIRONMENT: 'staging' }, () => main(['--project-root', root])),
    2,
  );

  replaceInFile(
    path.join(root, 'app.config.js'),
    "          'remote-notification',",
    "          'fetch',",
  );
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', root])), 2);
});

test('blocks missing or malformed consent-first RNFirebase configuration', () => {
  const missing = projectFixture();
  fs.rmSync(path.join(missing, 'firebase.json'));
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', missing])), 2);

  const malformed = projectFixture();
  fs.writeFileSync(path.join(malformed, 'firebase.json'), '{');
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', malformed])), 2);

  const autoInit = projectFixture();
  mutateJson(path.join(autoInit, 'firebase.json'), (config) => {
    config['react-native'].messaging_auto_init_enabled = true;
  });
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', autoInit])), 2);

  const autoRegister = projectFixture();
  mutateJson(path.join(autoRegister, 'firebase.json'), (config) => {
    delete config['react-native'].messaging_ios_auto_register_for_remote_messages;
  });
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', autoRegister])), 2);
});

test('requires a safe package main entry that registers before Expo Router', () => {
  const missing = projectFixture();
  mutateJson(path.join(missing, 'package.json'), (pkg) => {
    pkg.main = 'missing.js';
  });
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', missing])), 2);

  const escaping = projectFixture();
  mutateJson(path.join(escaping, 'package.json'), (pkg) => {
    pkg.main = '../outside.js';
  });
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', escaping])), 2);

  const symlink = projectFixture();
  fs.rmSync(path.join(symlink, 'index.js'));
  fs.symlinkSync(path.join(TEMPLATE_ROOT, 'index.js'), path.join(symlink, 'index.js'));
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', symlink])), 2);

  const late = projectFixture();
  const entryPath = path.join(late, 'index.js');
  const entry = fs.readFileSync(entryPath, 'utf8');
  fs.writeFileSync(
    entryPath,
    `${entry.match(/require\('expo-router\/entry'\);/)[0]}\n${entry.replace(
      "require('expo-router/entry');",
      '',
    )}`,
  );
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', late])), 2);
});

test('blocks malformed, missing, duplicate, or web-unsafe background registration', () => {
  const malformed = projectFixture();
  replaceInFile(
    path.join(malformed, 'index.js'),
    'messaging().setBackgroundMessageHandler(unconfiguredBackgroundHandler);',
    'messaging().setBackgroundMessageHandler();',
  );
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', malformed])), 2);

  const missing = projectFixture();
  replaceInFile(
    path.join(missing, 'index.js'),
    'messaging().setBackgroundMessageHandler(unconfiguredBackgroundHandler);',
    '',
  );
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', missing])), 2);

  const duplicate = projectFixture();
  replaceInFile(
    path.join(duplicate, 'index.js'),
    'messaging().setBackgroundMessageHandler(unconfiguredBackgroundHandler);',
    [
      'messaging().setBackgroundMessageHandler(unconfiguredBackgroundHandler);',
      'messaging().setBackgroundMessageHandler(unconfiguredBackgroundHandler);',
    ].join('\n'),
  );
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', duplicate])), 2);

  const webUnsafe = projectFixture();
  replaceInFile(
    path.join(webUnsafe, 'index.js'),
    "if (Platform.OS !== 'web') {",
    '{',
  );
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', webUnsafe])), 2);

  const outsideGuard = projectFixture();
  replaceInFile(
    path.join(outsideGuard, 'index.js'),
    "if (Platform.OS !== 'web') {",
    "if (Platform.OS !== 'web') {}\n{",
  );
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', outsideGuard])), 2);
});

test('blocks missing notification dependencies and forbidden credentials', () => {
  const dependency = projectFixture();
  mutateJson(path.join(dependency, 'package.json'), (pkg) => {
    delete pkg.dependencies['@react-native-firebase/messaging'];
  });
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', dependency])), 2);

  const credential = projectFixture();
  fs.mkdirSync(path.join(credential, 'config'));
  fs.writeFileSync(path.join(credential, 'config/firebase-adminsdk-sender.json'), '{}');
  assert.strictEqual(withEnvironment({}, () => main(['--project-root', credential])), 2);
});
