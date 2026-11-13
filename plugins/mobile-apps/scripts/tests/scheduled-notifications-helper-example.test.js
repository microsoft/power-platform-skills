'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createHookRuntime } = require('./helpers/hook-runtime');
const { clockDate, loadTypescriptExample, typescriptBlock, typescriptSkipReason } = require('./helpers/typescript-example');

const example = typescriptBlock(
  path.resolve(__dirname, '../../skills/add-native/add-scheduled-notifications/SKILL.md'),
  'src/native/scheduledNotifications.ts',
);

const MIN = 60_000;
const STATE_KEY = 'powerapps.scheduledNotifications';
// Friday 2026-10-16 (expo weekday 6), local time: daily and weekly times are in the device's zone.
const at = (hour, minute, dayOffset = 0) => new Date(2026, 9, 16 + dayOffset, hour, minute, 0, 0).getTime();
const iso = (ms) => new Date(ms).toISOString();
const nine = [{ id: 'nine', title: 'Nine', daily: { hour: 9, minute: 0 } }];
const ours = (store) => [...store.keys()].filter((identifier) => identifier.startsWith('scheduled_'));
const inGroup = (store, group) => ours(store).filter((identifier) => identifier.startsWith(`scheduled_${group}_`));
const idOf = (identifier) => identifier.split('_')[2];
const triggerTypes = (store) => [...store.values()].map((request) => request.trigger.type).sort();
const stateOf = (storage) => JSON.parse(storage.get(STATE_KEY));
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * A fresh instance of the example on a device: `store` holds pending requests and `storage` the
 * AsyncStorage values, so passing them to a second scenario models an app restart.
 */
function scenario({
  os = 'android',
  sdk = 34,
  exactPermissions = [],
  missingModule = false,
  granted = true,
  canAskAgain = true,
  requestGrants = true,
  store = new Map(),
  storage = new Map(),
  storageFails = false,
  now = at(12, 0),
} = {}) {
  const clock = { now };
  const log = { loads: 0, gets: 0, requests: 0, schedules: [], cancels: [], channels: [], handlers: [], alerts: [] };
  const appState = [];
  const received = [];
  let permission = { granted, canAskAgain };
  const notifications = {
    SchedulableTriggerInputTypes: { DATE: 'date', DAILY: 'daily', WEEKLY: 'weekly' },
    AndroidImportance: { HIGH: 4 },
    getPermissionsAsync: async () => ({ ...permission }),
    requestPermissionsAsync: async () => {
      log.requests += 1;
      permission = { granted: requestGrants, canAskAgain: requestGrants };
      return { ...permission };
    },
    setNotificationChannelAsync: async (id, channel) => { log.channels.push([id, channel.importance]); },
    setNotificationHandler: (handler) => { log.handlers.push(handler); },
    getAllScheduledNotificationsAsync: async () => {
      log.gets += 1;
      return [...store.values()];
    },
    cancelScheduledNotificationAsync: async (identifier) => {
      log.cancels.push(identifier);
      store.delete(identifier);
    },
    scheduleNotificationAsync: async (request) => {
      log.schedules.push(request);
      store.set(request.identifier, { identifier: request.identifier, content: request.content, trigger: request.trigger });
      return request.identifier;
    },
    addNotificationReceivedListener: (listener) => {
      received.push(listener);
      return { remove: () => received.splice(received.indexOf(listener), 1) };
    },
  };
  const hooks = createHookRuntime();
  const api = loadTypescriptExample(example, {
    modules: {
      react: hooks.react,
      'react-native': {
        Platform: { OS: os, Version: sdk },
        PermissionsAndroid: { check: async (name) => exactPermissions.includes(name) },
        Alert: { alert: (...args) => log.alerts.push(args) },
        AppState: {
          addEventListener: (_event, listener) => {
            appState.push(listener);
            return { remove: () => appState.splice(appState.indexOf(listener), 1) };
          },
        },
      },
      'expo-notifications': () => {
        log.loads += 1;
        if (missingModule) throw new Error("Cannot find native module 'ExpoNotificationsEmitter'");
        return notifications;
      },
      '@react-native-async-storage/async-storage': {
        default: {
          getItem: async (key) => storage.get(key) ?? null,
          setItem: async (key, value) => {
            if (storageFails) throw new Error('disk full');
            storage.set(key, value);
          },
        },
      },
    },
    globals: { __DEV__: false, Date: clockDate(clock) },
  });
  const item = (id, minutes, title = `Item ${id}`) => ({ id, title, date: iso(clock.now + minutes * MIN) });
  const sync = (items, group) => api.syncScheduledNotifications(items, group);
  return { api, clock, store, storage, log, hooks, appState, received, item, sync, setPermission: (next) => { permission = next; } };
}

const run = (name, fn) => test(`scheduled notifications: ${name}`, { skip: typescriptSkipReason }, fn);

run('web and hosts without the native module return UNAVAILABLE without loading it or throwing', async () => {
  const web = scenario({ os: 'web' });
  assert.deepEqual(await web.sync([web.item('a', 10)]), { ok: false, reason: 'UNAVAILABLE' });
  assert.equal(web.log.loads, 0);

  const missing = scenario({ missingModule: true });
  assert.deepEqual(await missing.sync([missing.item('a', 10)]), { ok: false, reason: 'UNAVAILABLE' });
  assert.equal(await missing.api.requestScheduledNotificationPermission(), false);
});

run('one-off times: the 48 soonest future items as DATE triggers on the channel', async () => {
  const s = scenario();
  const items = Array.from({ length: 60 }, (_, i) => s.item(`r${i}`, 60 - i));
  assert.deepEqual(await s.sync(items), { ok: true, scheduled: 48 });
  const ids = s.log.schedules.map((request) => request.content.data.id);
  assert.ok(!ids.includes('r0') && ids.includes('r59'));
  const { trigger } = s.log.schedules[0];
  assert.equal(trigger.type, 'date');
  assert.equal(trigger.channelId, 'scheduled');
  assert.deepEqual(s.log.channels, [['scheduled', 4]]);
});

run('past, too-soon, invalid and id-less items are skipped; an untitled one gets a neutral title', async () => {
  const s = scenario();
  const result = await s.sync([
    s.item('past', -5),
    { id: 'soon', title: 'x', date: iso(s.clock.now + 2000) },
    { id: 'bad', title: 'x', date: 'not a date' },
    { id: '', title: 'x', date: iso(s.clock.now + MIN) },
    { id: 'untitled', title: '  ', date: iso(s.clock.now + 3 * MIN) },
  ]);
  assert.deepEqual(result, { ok: true, scheduled: 1 });
  assert.equal([...s.store.values()][0].content.title, 'Notification');
});

run('daily and weekly times with exact delivery: their triggers, invalid times skipped, unchanged resyncs a no-op', async () => {
  const s = scenario({ os: 'ios' });
  const items = [
    { id: 'standup', title: 'Standup', daily: { hour: 9, minute: 30 } },
    { id: 'report', title: 'Weekly report', weekly: { weekday: 6, hour: 16, minute: 0 } },
    { id: 'bad-hour', title: 'x', daily: { hour: 24, minute: 0 } },
    { id: 'bad-day', title: 'x', weekly: { weekday: 8, hour: 9, minute: 0 } },
    { id: 'fraction', title: 'x', daily: { hour: 9.5, minute: 0 } },
  ];
  assert.deepEqual(await s.sync(items, 'routine'), { ok: true, scheduled: 2 });
  const byId = Object.fromEntries([...s.store.values()].map((request) => [request.content.data.id, request.trigger]));
  assert.deepEqual(byId.standup, { type: 'daily', hour: 9, minute: 30, channelId: 'scheduled' });
  assert.deepEqual(byId.report, { type: 'weekly', weekday: 6, hour: 16, minute: 0, channelId: 'scheduled' });
  const scheduled = s.log.schedules.length;
  await s.sync(items, 'routine');
  assert.equal(s.log.schedules.length, scheduled);
  assert.equal(s.log.cancels.length, 0);
  await s.sync([{ id: 'standup', title: 'Standup', daily: { hour: 9, minute: 45 } }], 'routine');
  assert.equal(inGroup(s.store, 'routine').length, 1);
  assert.equal([...s.store.values()][0].trigger.minute, 45);
});

run('the cap picks the soonest across one-off and repeating times', async () => {
  const s = scenario({ os: 'ios' });
  const items = [
    { id: 'daily', title: 'D', daily: { hour: 12, minute: 10 } },
    ...Array.from({ length: 50 }, (_, i) => s.item(`r${i}`, 60 * (i + 1))),
  ];
  await s.sync(items);
  const ids = ours(s.store).map(idOf);
  assert.equal(ids.length, 48);
  assert.ok(ids.includes('daily'));
  assert.ok(!ids.includes('r47') && !ids.includes('r49'));
});

run("a group's sync replaces only that group's notifications; group names never collide", async () => {
  const s = scenario();
  await s.sync([s.item('t1', 10), s.item('t2', 20)], 'tasks');
  await s.sync([{ id: 'c', title: 'Check-in', daily: { hour: 18, minute: 0 } }], 'check-in');
  await s.sync([], 'tasks');
  assert.equal(inGroup(s.store, 'tasks').length, 0);
  assert.equal(inGroup(s.store, 'check-in').length, 1);

  await s.sync([s.item('x', 10)], 'a');
  await s.sync([s.item('y', 10)], 'A b_c');
  assert.equal(inGroup(s.store, 'a-b-c').length, 1);
  await s.sync([], 'a');
  assert.equal(inGroup(s.store, 'a').length, 0);
  assert.equal(inGroup(s.store, 'a-b-c').length, 1);
});

run('the 48 cap goes to the soonest across groups, and the result counts the synced group', async () => {
  const s = scenario();
  await s.sync(Array.from({ length: 40 }, (_, i) => s.item(`a${i}`, i + 1)), 'one');
  const result = await s.sync(Array.from({ length: 20 }, (_, i) => s.item(`b${i}`, i + 1)), 'two');
  assert.deepEqual(result, { ok: true, scheduled: 20 });
  assert.equal(ours(s.store).length, 48);
  assert.equal(inGroup(s.store, 'one').length, 28);
  assert.ok(!inGroup(s.store, 'one').map(idOf).includes('a28'));
});

run("one group's distant notifications can't crowd out another's sooner one, across a restart, and syncs settle", async () => {
  const store = new Map();
  const storage = new Map();
  const first = scenario({ store, storage });
  const far = Array.from({ length: 48 }, (_, i) => first.item(`far${i}`, (30 + i) * 24 * 60));
  await first.sync(far, 'far');

  const second = scenario({ store, storage });
  const soon = [second.item('soon', 10)];
  assert.deepEqual(await second.sync(soon, 'near'), { ok: true, scheduled: 1 });
  assert.equal(ours(store).length, 48);
  assert.equal(inGroup(store, 'near').length, 1);
  assert.ok(!inGroup(store, 'far').map(idOf).includes('far47'));
  const { schedules, cancels } = second.log;
  const counts = [schedules.length, cancels.length];
  await second.sync(soon, 'near');
  await second.sync(far, 'far');
  assert.deepEqual([schedules.length, cancels.length], counts);
});

run('retitled, moved and removed one-offs are rescheduled or cancelled', async () => {
  const s = scenario();
  const a = s.item('a', 10, 'Old');
  const b = s.item('b', 20);
  await s.sync([a, b, s.item('c', 30)]);
  const before = (id) => ours(s.store).find((identifier) => idOf(identifier) === id);
  const [aOld, bOld, cOld] = ['a', 'b', 'c'].map(before);
  await s.sync([{ ...a, title: 'New' }, { ...b, date: iso(s.clock.now + 40 * MIN) }]);
  assert.ok([aOld, bOld, cOld].every((identifier) => s.log.cancels.includes(identifier)));
  assert.equal(ours(s.store).length, 2);
});

run('a pending one-off past its time is kept while unchanged, and counts against the cap', async () => {
  const s = scenario({ os: 'ios' });
  const due = Array.from({ length: 48 }, (_, i) => ({ id: `due${i}`, title: 'x', date: iso(at(12, 10)) }));
  await s.sync(due, 'g');
  s.clock.now = at(12, 10) + 1000;
  const later = Array.from({ length: 48 }, (_, i) => ({ id: `later${i}`, title: 'x', date: iso(at(13, 0)) }));
  await s.sync([...due, ...later], 'g');
  assert.equal(ours(s.store).length, 48);
  assert.equal(s.log.cancels.length, 0);
});

run('a one-off Android showed early is not scheduled again, even after an app restart', async () => {
  const store = new Map();
  const storage = new Map();
  const first = scenario({ store, storage });
  const items = [{ id: 'a', title: 'A', date: iso(at(12, 30)) }];
  await first.sync(items, 'g');
  store.delete(ours(store)[0]);

  const second = scenario({ store, storage, now: at(12, 10) });
  assert.deepEqual(await second.sync(items, 'g'), { ok: true, scheduled: 0 });
  assert.equal(second.log.schedules.length, 0);
});

run('final hour without exact alarms: a daily time pending since before it gets no extra one-off', async () => {
  const s = scenario({ now: at(7, 0) });
  await s.sync(nine, 'r');
  assert.deepEqual(triggerTypes(s.store), ['daily']);
  const scheduled = s.log.schedules.length;
  s.clock.now = at(8, 30);
  assert.deepEqual(await s.sync(nine, 'r'), { ok: true, scheduled: 1 });
  assert.equal(ours(s.store).length, 1);
  assert.equal(s.log.schedules.length, scheduled);
  assert.equal(s.log.cancels.length, 0);
});

run('final hour without exact alarms: a daily time first scheduled inside it gets a one-off, never shown twice', async () => {
  const s = scenario({ now: at(8, 30) });
  assert.deepEqual(await s.sync(nine, 'r'), { ok: true, scheduled: 2 });
  const requests = [...s.store.values()];
  const oneOff = requests.find((request) => request.trigger.type === 'date');
  const daily = requests.find((request) => request.trigger.type === 'daily');
  assert.ok(oneOff.trigger.date > at(8, 30) && oneOff.trigger.date <= at(9, 0));
  assert.deepEqual([daily.trigger.hour, daily.trigger.minute], [8, 0]);
  const scheduled = s.log.schedules.length;

  s.clock.now = at(8, 45);
  await s.sync(nine, 'r');
  assert.equal(s.log.cancels.length, 0);
  s.store.delete(oneOff.identifier);
  s.clock.now = at(8, 55);
  await s.sync(nine, 'r');
  s.clock.now = at(9, 5);
  await s.sync(nine, 'r');
  assert.equal(s.log.schedules.length, scheduled);
  assert.ok(stateOf(s.storage).scheduledOnce.includes(oneOff.identifier));

  s.clock.now = at(9, 5, 1);
  await s.sync(nine, 'r');
  assert.deepEqual(stateOf(s.storage).scheduledOnce, []);
  assert.equal(ours(s.store).length, 1);
  assert.equal(s.log.schedules.length, scheduled);
});

run('final hour without exact alarms: a fallback one-off still pending past its time is kept', async () => {
  const s = scenario({ now: at(8, 30) });
  await s.sync(nine, 'r');
  s.clock.now = at(9, 1);
  await s.sync(nine, 'r');
  assert.equal(s.log.cancels.length, 0);
  assert.equal(ours(s.store).length, 2);
});

run('final hour without exact alarms: weekly times follow the same rules', async () => {
  const weekly = [{ id: 'w', title: 'W', weekly: { weekday: 6, hour: 16, minute: 0 } }];
  const fresh = scenario({ now: at(15, 30) });
  await fresh.sync(weekly, 'w');
  assert.deepEqual(triggerTypes(fresh.store), ['date', 'weekly']);

  const early = scenario({ now: at(14, 0) });
  await early.sync(weekly, 'w');
  early.clock.now = at(15, 30);
  await early.sync(weekly, 'w');
  assert.deepEqual(triggerTypes(early.store), ['weekly']);
});

run('with exact delivery (iOS or an exact-alarm permission) a repeating time never gets a fallback one-off', async () => {
  for (const options of [{ os: 'ios' }, { exactPermissions: ['android.permission.USE_EXACT_ALARM'] }]) {
    const s = scenario({ ...options, now: at(8, 30) });
    await s.sync(nine, 'r');
    assert.deepEqual([...s.store.values()].map((request) => [request.trigger.type, request.trigger.hour]), [['daily', 9]]);
  }
});

run('cap reallocation in the final hour never cancels a repeating time or replays an occurrence it already showed', async () => {
  const s = scenario({ now: at(7, 0) });
  await s.sync(nine, 'r');
  const [daily] = inGroup(s.store, 'r');

  // Its early trigger shows today's 09:00 occurrence at 08:00. At 08:10 another group needs 48
  // slots for 08:20, and at 08:11 it no longer does.
  s.clock.now = at(8, 10);
  await s.sync(Array.from({ length: 48 }, (_, i) => ({ id: `b${i}`, title: 'x', date: iso(at(8, 20)) })), 'burst');
  assert.ok(s.store.has(daily));
  assert.equal(ours(s.store).length, 48);
  assert.equal(inGroup(s.store, 'burst').length, 47);

  s.clock.now = at(8, 11);
  await s.sync([], 'burst');
  assert.deepEqual(inGroup(s.store, 'r'), [daily]);
  assert.ok(!s.log.cancels.includes(daily));
  assert.ok(!s.log.schedules.some((request) => request.identifier.startsWith('scheduled_r_') && request.trigger.type === 'date'));
});

run('a repeating time evicted before its final hour gets its fallback one-off once room frees inside it', async () => {
  const s = scenario({ now: at(7, 0) });
  await s.sync(nine, 'r');
  s.clock.now = at(7, 50);
  await s.sync(Array.from({ length: 48 }, (_, i) => ({ id: `b${i}`, title: 'x', date: iso(at(7, 55)) })), 'burst');
  assert.equal(inGroup(s.store, 'r').length, 0);

  s.clock.now = at(8, 10);
  await s.sync([], 'burst');
  assert.deepEqual(triggerTypes(s.store), ['daily', 'date']);
});

run("other modules' notifications, such as push, are never touched, even by a clear", async () => {
  const s = scenario();
  s.store.set('push-uuid-1', { identifier: 'push-uuid-1', content: {} });
  await s.sync([s.item('a', 10)], 'x');
  await s.api.clearScheduledNotifications();
  assert.ok(s.store.has('push-uuid-1'));
  assert.equal(ours(s.store).length, 0);
});

run('permission is asked only when something new needs scheduling, and a denial is reported', async () => {
  const s = scenario({ granted: false, canAskAgain: true, requestGrants: false });
  assert.deepEqual(await s.sync([]), { ok: true, scheduled: 0 });
  assert.equal(s.log.requests, 0);
  assert.deepEqual(await s.sync([s.item('a', 10)]), { ok: false, reason: 'PERMISSION_DENIED' });
  assert.equal(s.log.requests, 1);
  s.setPermission({ granted: false, canAskAgain: false });
  await s.sync([s.item('a', 10)]);
  assert.equal(s.log.requests, 1);
});

run("syncs run one at a time: a group's newest call wins, other groups still run, each caller gets a result", async () => {
  const s = scenario();
  const results = await Promise.all([
    s.sync([s.item('a', 10)], 'g'),
    s.sync([s.item('b', 10)], 'g'),
    s.sync([s.item('c', 10), s.item('d', 20)], 'g'),
    s.sync([s.item('x', 10)], 'other'),
  ]);
  assert.deepEqual(inGroup(s.store, 'g').map(idOf).sort(), ['c', 'd']);
  assert.deepEqual(inGroup(s.store, 'other').map(idOf), ['x']);
  assert.deepEqual(results.map((result) => result.scheduled), [1, 2, 2, 1]);
  assert.equal(s.log.gets, 3);
});

run('a clear replaces the syncs waiting before it, and a sync after it runs after it', async () => {
  const s = scenario();
  await s.sync([s.item('old', 10)], 'g');
  await Promise.all([
    s.sync([s.item('a', 10)], 'g'),
    s.sync([s.item('b', 10)], 'h'),
    s.api.clearScheduledNotifications(),
    s.sync([s.item('c', 10)], 'g'),
  ]);
  assert.deepEqual(ours(s.store).map(idOf), ['c']);
});

run('screen hook: syncs when its items change, re-syncs on return to the app, and stops after unmount', async () => {
  const s = scenario();
  const items = [s.item('a', 10)];
  const screen = s.hooks.mount();
  screen.render(() => s.api.useScheduledNotifications(undefined, 'tasks'));
  await flush();
  assert.equal(s.log.gets, 0);
  screen.render(() => s.api.useScheduledNotifications(items, 'tasks'));
  await flush();
  assert.equal(inGroup(s.store, 'tasks').length, 1);
  screen.render(() => s.api.useScheduledNotifications(items, 'tasks'));
  await flush();
  const gets = s.log.gets;
  s.appState.forEach((listener) => listener('active'));
  await flush();
  assert.equal(s.log.gets, gets + 1);
  screen.unmount();
  assert.equal(s.appState.length, 0);
});

run("session hook on iOS: alerts only this module's notifications while signed in; signing out clears every group", async () => {
  const s = scenario({ os: 'ios' });
  const layout = s.hooks.mount();
  layout.render(() => s.api.useScheduledNotificationSession(false));
  assert.equal(s.received.length, 0);
  layout.render(() => s.api.useScheduledNotificationSession(true));
  await s.sync([s.item('a', 10, 'Site visit')], 'jobs');
  await s.sync([{ id: 'c', title: 'Check-in', daily: { hour: 18, minute: 0 } }], 'check-in');
  const [own] = inGroup(s.store, 'jobs');
  s.received.forEach((listener) => listener({ request: { identifier: own, content: { title: 'Site visit', body: 'Starts now' } } }));
  s.received.forEach((listener) => listener({ request: { identifier: 'fcm-123', content: { title: 'Push', body: 'x' } } }));
  assert.deepEqual(s.log.alerts, [['Site visit', 'Starts now']]);
  layout.render(() => s.api.useScheduledNotificationSession(false));
  await flush();
  assert.equal(ours(s.store).length, 0);
  assert.equal(s.received.length, 0);
});

run('session hook: a sign-out that unmounts the signed-in layout before it renders signed out still clears every group', async () => {
  const s = scenario();
  const layout = s.hooks.mount();
  layout.render(() => s.api.useScheduledNotificationSession(true));
  await s.sync([s.item('a', 10)], 'jobs');
  await s.sync([{ id: 'c', title: 'C', daily: { hour: 18, minute: 0 } }], 'check-in');
  assert.equal(ours(s.store).length, 2);
  layout.unmount();
  await flush();
  assert.equal(ours(s.store).length, 0);
  assert.deepEqual(stateOf(s.storage), { groups: {}, scheduledOnce: [] });
});

run("session hook: re-renders while signed in and a cold start that stays signed out don't clear", async () => {
  const s = scenario();
  const layout = s.hooks.mount();
  layout.render(() => s.api.useScheduledNotificationSession(true));
  await s.sync([s.item('a', 10)], 'jobs');
  layout.render(() => s.api.useScheduledNotificationSession(true));
  await flush();
  assert.equal(ours(s.store).length, 1);

  const cold = scenario({ store: s.store, storage: s.storage });
  const signedOut = cold.hooks.mount();
  signedOut.render(() => cold.api.useScheduledNotificationSession(false));
  signedOut.render(() => cold.api.useScheduledNotificationSession(false));
  await flush();
  assert.equal(cold.log.cancels.length, 0);
  assert.equal(ours(s.store).length, 1);
});

run('Android without exact alarms: the delivery window ends by the due time for leads from 6 s to 2 days', async () => {
  const s = scenario();
  const now = s.clock.now;
  const leads = [6e3, 30e3, 2 * MIN, 30 * MIN, 120 * MIN, 140 * MIN, 180 * MIN, 24 * 60 * MIN, 48 * 60 * MIN];
  await s.sync(leads.map((lead, i) => ({ id: `l${i}`, title: 'x', date: iso(now + lead) })));
  for (const [i, lead] of leads.entries()) {
    const request = [...s.store.values()].find((pending) => pending.content.data.id === `l${i}`);
    const futurity = request.trigger.date - now;
    const window = futurity < 10e3 ? 0 : Math.min(0.75 * futurity, 60 * MIN);
    assert.ok(request.trigger.date > now, `lead ${lead}: triggers in the future`);
    assert.ok(request.trigger.date + window <= now + lead + 1, `lead ${lead}: window ends by the due time`);
    assert.ok(request.trigger.date >= now + lead - 60 * MIN - 1, `lead ${lead}: at most an hour early`);
  }
});

run('exact alarms are detected below Android 12, with USE_EXACT_ALARM, or with SCHEDULE_EXACT_ALARM on Android 12', async () => {
  const due = at(12, 30);
  const trigger = async (options) => {
    const s = scenario(options);
    await s.sync([{ id: 'a', title: 'x', date: iso(due) }]);
    return [...s.store.values()][0].trigger.date;
  };
  assert.equal(await trigger({ sdk: 30 }), due);
  assert.equal(await trigger({ exactPermissions: ['android.permission.USE_EXACT_ALARM'] }), due);
  assert.equal(await trigger({ sdk: 32, exactPermissions: ['android.permission.SCHEDULE_EXACT_ALARM'] }), due);
  assert.ok((await trigger({ exactPermissions: ['android.permission.SCHEDULE_EXACT_ALARM'] })) < due);
  assert.ok((await trigger({})) < due);
  assert.equal(await trigger({ os: 'ios' }), due);
});

run('Android without exact alarms: repeating times trigger an hour early, wrapping midnight and the week', async () => {
  const s = scenario();
  await s.sync([
    { id: 'd', title: 'x', daily: { hour: 0, minute: 30 } },
    { id: 'w1', title: 'x', weekly: { weekday: 1, hour: 0, minute: 15 } },
    { id: 'w4', title: 'x', weekly: { weekday: 4, hour: 10, minute: 0 } },
  ]);
  const triggers = Object.fromEntries([...s.store.values()].map((request) => [request.content.data.id, request.trigger]));
  assert.deepEqual([triggers.d.hour, triggers.d.minute], [23, 30]);
  assert.deepEqual([triggers.w1.weekday, triggers.w1.hour, triggers.w1.minute], [7, 23, 15]);
  assert.deepEqual([triggers.w4.weekday, triggers.w4.hour], [4, 9]);
});

run("the Android handler is set once and presents only this module's notifications; iOS gets none", async () => {
  const s = scenario();
  await s.sync([s.item('a', 10)]);
  await s.sync([s.item('a', 10), s.item('b', 20)]);
  assert.equal(s.log.handlers.length, 1);
  const own = await s.log.handlers[0].handleNotification({ request: { identifier: ours(s.store)[0] } });
  const other = await s.log.handlers[0].handleNotification({ request: { identifier: 'someone-else' } });
  assert.deepEqual(own, { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false });
  assert.deepEqual(other, { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false });

  const ios = scenario({ os: 'ios' });
  await ios.sync([ios.item('a', 10)]);
  ios.hooks.mount().render(() => ios.api.useScheduledNotificationSession(true));
  assert.equal(ios.log.handlers.length, 0);

  const signedIn = scenario();
  signedIn.hooks.mount().render(() => signedIn.api.useScheduledNotificationSession(true));
  await flush();
  assert.equal(signedIn.log.handlers.length, 1);
  assert.equal(signedIn.received.length, 0);
});

run('identifiers change when exact-alarm availability changes, so schedules are replaced', async () => {
  const inexact = scenario();
  const exact = scenario({ exactPermissions: ['android.permission.USE_EXACT_ALARM'] });
  await inexact.sync([inexact.item('x', 30)]);
  await exact.sync([exact.item('x', 30)]);
  assert.notEqual(ours(inexact.store)[0], ours(exact.store)[0]);
});

run('state that cannot be saved never blocks scheduling', async () => {
  const s = scenario({ storageFails: true });
  assert.deepEqual(await s.sync([s.item('a', 10), s.item('b', 20)], 'g'), { ok: true, scheduled: 2 });
  assert.equal(ours(s.store).length, 2);
});
