'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createHookRuntime } = require('./helpers/hook-runtime');
const { loadTypescriptExample, typescriptBlock, typescriptSkipReason } = require('./helpers/typescript-example');

const example = typescriptBlock(
  path.resolve(__dirname, '../../skills/add-native/add-push-notifications/SKILL.md'),
  'src/native/pushNotifications.ts',
);

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const count = (calls, name) => calls.filter((call) => call === name).length;
const topicCalls = (calls) => calls.filter((call) => /^(un)?subscribe:/.test(call));

/**
 * A fresh instance of the example. `apps` is what Firebase's getApps() returns: none while push
 * notifications are off for the wrap or the Firebase files are still placeholders.
 */
function scenario({
  os = 'android',
  apps = [{}],
  appModuleMissing = false,
  notificationsMissing = false,
  granted = true,
  deviceRegistered = true,
  tokenFailures = 0,
  subscribeError,
} = {}) {
  const calls = [];
  const loaded = [];
  const alerts = [];
  const appState = [];
  const tokenRefresh = [];
  const messages = [];
  const heldTokens = [];
  let permission = granted;
  let failures = tokenFailures;
  const listen = (listeners, listener) => {
    listeners.push(listener);
    return () => listeners.splice(listeners.indexOf(listener), 1);
  };
  const messaging = {
    getMessaging: () => ({}),
    isDeviceRegisteredForRemoteMessages: () => deviceRegistered,
    registerDeviceForRemoteMessages: async () => { calls.push('registerDevice'); },
    getToken: async () => {
      calls.push('getToken');
      const held = heldTokens.shift();
      if (held) await held;
      if (failures > 0) {
        failures -= 1;
        throw new Error('SERVICE_NOT_AVAILABLE');
      }
      return 'token';
    },
    subscribeToTopic: async (_messaging, topic) => {
      calls.push(`subscribe:${topic}`);
      if (subscribeError) throw new Error(subscribeError);
    },
    unsubscribeFromTopic: async (_messaging, topic) => { calls.push(`unsubscribe:${topic}`); },
    onMessage: (_messaging, listener) => listen(messages, listener),
    onTokenRefresh: (_messaging, listener) => listen(tokenRefresh, listener),
  };
  const hooks = createHookRuntime();
  const api = loadTypescriptExample(example, {
    modules: {
      react: hooks.react,
      'react-native': {
        Platform: { OS: os },
        Alert: { alert: (...args) => alerts.push(args) },
        AppState: { addEventListener: (_event, listener) => ({ remove: listen(appState, listener) }) },
      },
      '@react-native-firebase/app': () => {
        loaded.push('app');
        if (appModuleMissing) throw new Error('Native module RNFBAppModule not found');
        return {
          getApps: () => {
            if (apps === 'throw') throw new Error('getApps failed');
            return apps;
          },
        };
      },
      '@react-native-firebase/messaging': () => {
        loaded.push('messaging');
        return messaging;
      },
      'expo-notifications': () => {
        loaded.push('notifications');
        if (notificationsMissing) throw new Error("Cannot find native module 'ExpoNotificationsEmitter'");
        return {
          requestPermissionsAsync: async () => {
            calls.push('request');
            return { granted: permission };
          },
          getPermissionsAsync: async () => {
            calls.push('check');
            return { granted: permission };
          },
        };
      },
    },
    globals: { __DEV__: false },
  });
  return {
    api,
    hooks,
    calls,
    loaded,
    alerts,
    appState,
    tokenRefresh,
    messages,
    grant: () => { permission = true; },
    resume: () => appState.slice().forEach((listener) => listener('active')),
    /** Keeps the next getToken() in flight until the returned function is called. */
    holdNextToken: () => {
      let release;
      heldTokens.push(new Promise((resolve) => { release = resolve; }));
      return release;
    },
  };
}

const run = (name, fn) => test(`push notifications: ${name}`, { skip: typescriptSkipReason }, fn);
const pushModules = (loaded) => loaded.filter((name) => name !== 'app');

run('unavailable hosts return UNAVAILABLE without loading the push modules or throwing', async () => {
  for (const options of [{ os: 'web' }, { appModuleMissing: true }, { apps: 'throw' }, { apps: [] }]) {
    const s = scenario(options);
    assert.deepEqual(await s.api.registerForPushNotifications(), { ok: false, reason: 'UNAVAILABLE' }, JSON.stringify(options));
    assert.equal(s.api.isPushNotificationsAvailable(), false);
    assert.deepEqual(pushModules(s.loaded), [], JSON.stringify(options));
  }
  const noNotifications = scenario({ notificationsMissing: true });
  assert.deepEqual(await noNotifications.api.registerForPushNotifications(), { ok: false, reason: 'UNAVAILABLE' });
});

run('registration asks permission, registers the device, gets the token and subscribes the topic', async () => {
  const s = scenario({ deviceRegistered: false });
  assert.deepEqual(await s.api.registerForPushNotifications(), { ok: true, value: 'token' });
  assert.equal(s.api.isPushNotificationsAvailable(), true);
  assert.deepEqual(s.calls, ['request', 'registerDevice', 'getToken', 'subscribe:allUsers']);

  const registered = scenario();
  assert.deepEqual(await registered.api.registerForPushNotifications('crew-7'), { ok: true, value: 'token' });
  assert.deepEqual(registered.calls, ['request', 'getToken', 'subscribe:crew-7']);
});

run('a denied permission stops before Firebase; token and topic failures are PUSH_FAILED', async () => {
  const denied = scenario({ granted: false });
  assert.deepEqual(await denied.api.registerForPushNotifications(), { ok: false, reason: 'PERMISSION_DENIED' });
  assert.deepEqual(denied.calls, ['request']);

  const token = scenario({ tokenFailures: 1 });
  assert.deepEqual(await token.api.registerForPushNotifications(), { ok: false, reason: 'PUSH_FAILED', message: 'SERVICE_NOT_AVAILABLE' });
  const topic = scenario({ subscribeError: 'TOO_MANY_TOPICS' });
  assert.deepEqual(await topic.api.registerForPushNotifications(), { ok: false, reason: 'PUSH_FAILED', message: 'TOO_MANY_TOPICS' });
});

run('showPushMessage alerts notification messages only', () => {
  const s = scenario();
  s.api.showPushMessage({ notification: { title: 'Job assigned', body: 'Site 42' } });
  s.api.showPushMessage({ data: { only: 'data' } });
  assert.deepEqual(s.alerts, [['Job assigned', 'Site 42']]);
});

run('signed out or unavailable, the hook does nothing', async () => {
  const signedOut = scenario();
  signedOut.hooks.mount().render(() => signedOut.api.usePushNotifications(false));
  const off = scenario({ apps: [] });
  off.hooks.mount().render(() => off.api.usePushNotifications(true));
  await settle();
  assert.deepEqual([signedOut.loaded, signedOut.appState.length], [[], 0]);
  assert.deepEqual([pushModules(off.loaded), off.calls, off.appState.length], [[], [], 0]);
});

run('the hook registers once and hands open-app messages to the latest handler', async () => {
  const s = scenario();
  const seen = [];
  const layout = s.hooks.mount();
  layout.render(() => s.api.usePushNotifications(true, (message) => seen.push(['first', message.messageId])));
  layout.render(() => s.api.usePushNotifications(true, (message) => seen.push(['second', message.messageId])));
  await settle();
  s.messages.forEach((listener) => listener({ messageId: 'm1' }));
  assert.deepEqual(seen, [['second', 'm1']]);
  assert.equal(count(s.calls, 'subscribe:allUsers'), 1);
  s.resume();
  await settle();
  assert.equal(count(s.calls, 'subscribe:allUsers'), 1);
  assert.equal(count(s.calls, 'check'), 0);
});

run('a token refresh resubscribes while signed in, and stops with the session', async () => {
  const s = scenario();
  const layout = s.hooks.mount();
  layout.render(() => s.api.usePushNotifications(true));
  await settle();
  s.tokenRefresh.forEach((listener) => listener('token-2'));
  await settle();
  assert.equal(count(s.calls, 'subscribe:allUsers'), 2);
  layout.unmount();
  await settle();
  assert.deepEqual([s.tokenRefresh.length, s.messages.length, s.appState.length], [0, 0, 0]);
  assert.equal(topicCalls(s.calls).at(-1), 'unsubscribe:allUsers');
});

run('denied permission: a resume only checks it, and registers once it is granted in Settings', async () => {
  const s = scenario({ granted: false });
  s.hooks.mount().render(() => s.api.usePushNotifications(true));
  await settle();
  s.resume();
  await settle();
  assert.equal(count(s.calls, 'request'), 1);
  assert.equal(count(s.calls, 'check'), 1);
  assert.equal(count(s.calls, 'subscribe:allUsers'), 0);

  s.grant();
  s.resume();
  s.resume();
  await settle();
  assert.equal(count(s.calls, 'subscribe:allUsers'), 1);
  s.resume();
  await settle();
  assert.equal(count(s.calls, 'subscribe:allUsers'), 1);
});

run('a transient Firebase failure is retried on return to the app', async () => {
  const s = scenario({ tokenFailures: 1 });
  s.hooks.mount().render(() => s.api.usePushNotifications(true));
  await settle();
  assert.equal(count(s.calls, 'subscribe:allUsers'), 0);
  s.resume();
  await settle();
  assert.equal(count(s.calls, 'subscribe:allUsers'), 1);
});

run('signing out mid-registration unsubscribes after it completes, and a later resume does nothing', async () => {
  const s = scenario();
  const release = s.holdNextToken();
  const layout = s.hooks.mount();
  layout.render(() => s.api.usePushNotifications(true));
  await settle();
  layout.render(() => s.api.usePushNotifications(false));
  release();
  await settle();
  assert.deepEqual(topicCalls(s.calls), ['subscribe:allUsers', 'unsubscribe:allUsers']);
  assert.equal(s.appState.length, 0);
  const calls = s.calls.length;
  s.resume();
  await settle();
  assert.equal(s.calls.length, calls);
});

run('a topic change unsubscribes the old topic before subscribing the new one', async () => {
  const s = scenario();
  const layout = s.hooks.mount();
  layout.render(() => s.api.usePushNotifications(true, undefined, 'crew-1'));
  await settle();
  layout.render(() => s.api.usePushNotifications(true, undefined, 'crew-2'));
  await settle();
  assert.deepEqual(topicCalls(s.calls), ['subscribe:crew-1', 'unsubscribe:crew-1', 'subscribe:crew-2']);
  assert.equal(s.appState.length, 1);
});

run("signing back in after a sign-out that unmounted the layout: the old session's cleanup finishes first", async () => {
  const s = scenario();
  const release = s.holdNextToken();
  const first = s.hooks.mount();
  first.render(() => s.api.usePushNotifications(true));
  await settle();
  // Sign-out redirects to /login, unmounting the signed-in layout; signing in mounts a new one.
  first.unmount();
  const second = s.hooks.mount();
  second.render(() => s.api.usePushNotifications(true));
  await settle();
  release();
  await settle();
  assert.deepEqual(topicCalls(s.calls), ['subscribe:allUsers', 'unsubscribe:allUsers', 'subscribe:allUsers']);
  assert.equal(s.appState.length, 1);
});
