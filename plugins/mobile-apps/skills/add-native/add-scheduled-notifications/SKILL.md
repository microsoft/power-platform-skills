---
name: add-scheduled-notifications
description: Internal implementation skill invoked by /add-native for notifications the device schedules itself at times the app defines (a date-time in its data, such as a due date, appointment or shift start, or a repeating daily or weekly time), using the template's expo-notifications, with no Firebase or backend.
user-invocable: false
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** - read first.

**Working directory:** before any project read or command, execute
[native-artifact-compatibility.md Step 0](${PLUGIN_ROOT}/shared/references/native-artifact-compatibility.md#0-bind-every-operation-to-the-app-root).
Inherit `/add-native`'s resolved absolute `working_dir`; bind every shell call and
file tool to it, even when this helper starts from another directory.

# Add Scheduled Notifications

Internal helper for `/add-native scheduled-notifications`, `/add-native local-notifications`, `/add-native recurring-notifications`, `/add-native reminder-notifications`, `/add-native reminders`, `/add-native due-date-reminders`, and `/add-native expo-notifications`.

The device shows notifications on its own at times the app defines:

- **once**, at a date-time from the app's data: a task's due date, an appointment, a shift start, an inspection deadline, a booking, an expiry date;
- **repeating**, daily or weekly at a time of day: a daily check-in, a weekly report.

The OS shows each at its time even when the app is closed, and it looks like a push notification. No Firebase or backend is involved, so it works on Android and iOS whether or not the app has push notifications.

It is not push: a device schedules only what it has loaded, so a change made elsewhere reaches a device the next time that device loads it. A notification that must reach users when something happens elsewhere (another user's action, a server event) is `push-notifications`, sent by Firebase or a backend.

Limits to state in the plan and summary:
- Android timing: the wrap base package has no exact-alarm permission, so Android delivers alarms within a window that can end up to an hour after their trigger time. The wrapper schedules each one early enough that its window ends at the intended time: it arrives by that time, never after it, and at most an hour early (at the time itself on an idle device). If the base package gains an exact-alarm permission, the wrapper detects it and schedules exactly. iOS is always exact.
- At most the 48 soonest are pending at a time across the app (iOS keeps at most 64 per app); later ones are scheduled by a later sync.
- Android 13 and later show notifications only with the Notifications permission: it must stay selected in the wrap wizard's permissions step.

Hard rules:
- Do not install packages or edit `app.config.js` or native config. The template already ships `expo-notifications`.
- Use `expo-notifications` only through `src/native/scheduledNotifications.ts`, which loads it lazily. Never import it anywhere else: it loads its native modules on import, so a static import crashes host apps built without them (for example an older preview app or wrap base) at startup.
- The wrapper sets the app's only notification handler, on Android only: expo-notifications hands a notification it judges to arrive with the app open to the handler instead of posting it, and it can judge a wrapped app open while the app is in the background or the phone is locked. Without the handler, such notifications never reach the lock screen. Never set a handler on iOS, where Firebase Messaging owns foreground presentation: there the wrapper shows notifications that come due with the app open as an in-app alert.
- Never schedule or cancel a notification from a screen directly; screens pass their source's notifications to `useScheduledNotifications`.

## 1. Verify app and package

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
test -f app.config.js && test -f power.config.json && test -f package.json && test -d src || { echo "BLOCKED: working_dir is not an initialized app" >&2; exit 1; }
node -e "const p=require('./package.json'); if (!p.dependencies?.['expo-notifications']) { console.error('MISSING: expo-notifications'); process.exit(1); } console.log('OK: expo-notifications present');"
```

If the package is missing, stop: the app was created from a template without notification support. Do not install it; tell the user that scheduled notifications need an app created from the current template.

## 2. Identify what is scheduled

Resolve from the approved plan, or ask once when standalone. An app can have several **sources** of notifications, for example appointments from Dataverse and a daily check-in time from a settings screen. For each source, record:

- **Group:** a short name, such as `appointments` or `check-in`. Each source keeps its own group in sync, so one source's sync never cancels another's notifications.
- **Notifications:** which records or settings produce one, for example open tasks (not done, not deleted). Something that drops out of the list has its notification cancelled.
- **When:**
  - Once, at a date-time field. To notify before it, subtract the lead time when mapping (for example 15 minutes before an appointment).
  - For several notices per record, use one notification per notice with distinct ids, such as `<id>:day-before` and `<id>:hour-before`.
  - A date-only field (Dataverse returns it as `YYYY-MM-DD`, which parses as UTC midnight) needs an explicit local time: build a `Date` for that day at the planned hour.
  - Repeating at a time of day: `daily: { hour, minute }`, or `weekly: { weekday, hour, minute }`, where weekday 1 is Sunday, in the device's time zone.
- **Text:** the title (usually the record's name) and optional body.
- **Owner:** the screen that loads the source (a list screen, or the settings screen for a user-set time) and keeps its group in sync. A device schedules only after that screen has loaded it.

Also record what users call these notifications (for example Reminders, Appointments, Shift alerts): it becomes the Android channel name in Step 3.

## 2a. Reconcile requested artifacts

Read and execute [native-artifact-compatibility.md](${PLUGIN_ROOT}/shared/references/native-artifact-compatibility.md)
Steps 1–3 for the scheduled notifications row before any writes or reuse. Inherit the current
approval/mode from `/add-native`; do not repeat a valid scoped approval.
Inspect `src/native/scheduledNotifications.ts` for `syncScheduledNotifications`,
`clearScheduledNotifications`, `requestScheduledNotificationPermission`,
`useScheduledNotifications`, `useScheduledNotificationSession`,
`ScheduledNotification`, `TimeOfDay`, and `ScheduledNotificationsResult`; the lazy
`expo-notifications` load; one-off, daily and weekly times; groups that preserve
each source's desired entries while allocating the app-wide 48-notification cap
by next occurrence; pending entries kept while their alarm may be in its delivery
window (late one-offs and, without exact alarms, repeating ones in their final
hour); delivered one-off occurrence state;
serialized syncs; the session hook's clear on sign-out and on unmount; the
Android-only handler that presents this module's notifications; and
the Android inexact-window adjustment with exact-alarm detection. Inspect `app/(app)/_layout.tsx` for one unconditional
`useScheduledNotificationSession` call, and each owner screen for its
`useScheduledNotifications` call. A wrapper that imports `expo-notifications`
statically, cancels notifications this module didn't schedule, replaces another
group's notifications when one group syncs, sets a notification handler
on iOS, or leaves Android presentation and timing to expo-notifications' defaults
is not compatible. An incompatible artifact outside
approval returns `NEEDS_CONTEXT` to the owner, or asks standalone.

## 3. Write `src/native/scheduledNotifications.ts`

Apply Step 2a's decision for `src/native/scheduledNotifications.ts`: create when requested
and missing, reuse unchanged only if compatible, or make only the approved scoped
update. Preserve custom code, exports, and callers; do not overwrite from the
example. Screens and layouts import this wrapper, not `expo-notifications` directly.
Set `ANDROID_CHANNEL_NAME` to what users call these notifications (Step 2).

```ts
// src/native/scheduledNotifications.ts
import { useEffect, useRef } from 'react';
import { Alert, AppState, PermissionsAndroid, Platform, type Permission } from 'react-native';
import type { NotificationTriggerInput } from 'expo-notifications';

declare const require: (id: string) => unknown;

type ExpoNotifications = typeof import('expo-notifications');
type AsyncStorageModule = typeof import('@react-native-async-storage/async-storage');

/** A time of day in the device's time zone. */
export interface TimeOfDay {
  /** 0–23. */
  hour: number;
  /** 0–59. */
  minute: number;
}

/**
 * A notification the device shows on its own: once at `date`, or repeating `daily` or `weekly`.
 * `id` is unique within its group: the record id, or `<id>:<notice>` for several notices per record.
 * `date` is an ISO 8601 date-time (Dataverse returns UTC) or a Date; `weekday` 1 is Sunday.
 */
export type ScheduledNotification = { id: string; title: string; body?: string } & (
  | { date: string | Date }
  | { daily: TimeOfDay }
  | { weekly: TimeOfDay & { weekday: number } }
);

/** `scheduled` counts the synced group's pending notifications; the rest wait for room under the cap. */
export type ScheduledNotificationsResult =
  | { ok: true; scheduled: number }
  | { ok: false; reason: 'UNAVAILABLE' | 'PERMISSION_DENIED' | 'SCHEDULE_FAILED'; message?: string };

/**
 * Every notification this module schedules has the identifier
 * `scheduled_<group>_<id>_<when>_<hash>`, where the hash covers the title, body, and how it is
 * scheduled: a notification whose time, text, or scheduling changes gets a new identifier, so each
 * group reconciles from identifiers alone (they round-trip on both platforms, unlike custom content
 * fields). Group names never contain `_`, so one group's prefix never matches another's.
 */
const IDENTIFIER_PREFIX = 'scheduled_';
/** Bump when the way notifications are scheduled changes, so updated apps replace older schedules. */
const SCHEDULE_VERSION = 1;
const DEFAULT_GROUP = 'default';
const ALL_GROUPS = '*';
const ANDROID_CHANNEL_ID = 'scheduled';
/** What users call these notifications; Android lists it in the app's notification settings. */
const ANDROID_CHANNEL_NAME = 'Scheduled notifications';
/**
 * iOS keeps at most 64 pending local notifications per app and silently drops the rest, so only the
 * soonest 48 across all groups are scheduled. Later ones are scheduled by a later sync.
 */
const MAX_SCHEDULED = 48;
/** One-off times sooner than this aren't newly scheduled: the alarm could land in the past. */
const MIN_LEAD_MS = 5_000;
/** Android delivers an inexact alarm within a window of 75% of the time until it, at most an hour. */
const INEXACT_WINDOW_FRACTION = 0.75;
const MAX_INEXACT_WINDOW_MS = 60 * 60 * 1000;

type When =
  | { kind: 'once'; ms: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number };

/** A notification as its group asked for it, normalized. */
interface Requested {
  id: string;
  title: string;
  body?: string;
  when: When;
}

interface ScheduleEntry extends Requested {
  identifier: string;
  /** Next time it shows, to choose the soonest under the cap. */
  nextMs: number;
}

/**
 * Kept across launches: each group's latest notifications, so the cap goes to the soonest across
 * every group whichever one syncs, and the one-off notifications this module scheduled, so one the
 * OS showed early (Android may show an inexact one up to an hour early) isn't scheduled again.
 */
interface StoredState {
  groups: Record<string, Requested[]>;
  scheduledOnce: string[];
}

/** This module's notifications already scheduled: those pending, and the one-offs it scheduled. */
interface Scheduled {
  pending: ReadonlySet<string>;
  once: ReadonlySet<string>;
}

const STORAGE_KEY = 'powerapps.scheduledNotifications';

/**
 * expo-notifications, or null where on-device notifications can't work: on web, and in a host app
 * built without its native modules. expo-notifications loads those modules on import, so a static
 * import would crash such hosts at startup; this lazy require fails safely instead.
 */
function loadNotifications(): ExpoNotifications | null {
  if (Platform.OS === 'web') return null;
  try {
    return require('expo-notifications') as ExpoNotifications;
  } catch {
    return null;
  }
}

function loadStorage(): AsyncStorageModule['default'] | null {
  try {
    return (require('@react-native-async-storage/async-storage') as AsyncStorageModule).default;
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function readState(): Promise<StoredState> {
  try {
    const stored: unknown = JSON.parse((await loadStorage()?.getItem(STORAGE_KEY)) ?? 'null');
    if (isRecord(stored) && isRecord(stored.groups) && Array.isArray(stored.scheduledOnce)) {
      return stored as unknown as StoredState;
    }
  } catch {
    // Unreadable state is rebuilt as the groups sync.
  }
  return { groups: {}, scheduledOnce: [] };
}

async function writeState(state: StoredState): Promise<void> {
  try {
    await loadStorage()?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Unsaved state is rebuilt as the groups sync; scheduling carries on without it.
  }
}

let exactAlarms: Promise<boolean> | undefined;

/**
 * Whether the device delivers this app's alarms exactly. iOS does. expo-notifications uses exact
 * alarms on Android below 12, or with an exact-alarm permission, which the wrap base package doesn't
 * declare today: USE_EXACT_ALARM, or SCHEDULE_EXACT_ALARM on Android 12 (granted by default there).
 */
function hasExactAlarms(): Promise<boolean> {
  exactAlarms ??= (async () => {
    if (Platform.OS !== 'android') return true;
    const sdk = Number(Platform.Version);
    if (sdk < 31) return true;
    try {
      if (await PermissionsAndroid.check('android.permission.USE_EXACT_ALARM' as Permission)) return true;
      return sdk <= 32 && (await PermissionsAndroid.check('android.permission.SCHEDULE_EXACT_ALARM' as Permission));
    } catch {
      return false;
    }
  })();
  return exactAlarms;
}

function normalizeGroup(group: string): string {
  return group.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-') || DEFAULT_GROUP;
}

/** 32-bit FNV-1a, so changed text produces a new identifier without putting the text in it. */
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

const isInRange = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;
const isTimeOfDay = ({ hour, minute }: TimeOfDay) => isInRange(hour, 0, 23) && isInRange(minute, 0, 59);

function toWhen(item: ScheduledNotification): When | null {
  if ('date' in item) {
    const ms = item.date instanceof Date ? item.date.getTime() : Date.parse(item.date);
    return Number.isFinite(ms) ? { kind: 'once', ms } : null;
  }
  if ('daily' in item) {
    return isTimeOfDay(item.daily) ? { kind: 'daily', hour: item.daily.hour, minute: item.daily.minute } : null;
  }
  const { weekday, hour, minute } = item.weekly;
  return isTimeOfDay(item.weekly) && isInRange(weekday, 1, 7) ? { kind: 'weekly', weekday, hour, minute } : null;
}

/** The next time `when` shows after `now`, in the device's time zone. */
function nextOccurrence(when: When, now: number): number {
  if (when.kind === 'once') return when.ms;
  const next = new Date(now);
  next.setHours(when.hour, when.minute, 0, 0);
  if (when.kind === 'weekly') next.setDate(next.getDate() + ((when.weekday - 1 - next.getDay() + 7) % 7));
  if (next.getTime() <= now) next.setDate(next.getDate() + (when.kind === 'daily' ? 1 : 7));
  return next.getTime();
}

/** The occurrence of repeating `when` one period before its occurrence at `ms`. */
function previousOccurrence(when: When, ms: number): number {
  const previous = new Date(ms);
  previous.setDate(previous.getDate() - (when.kind === 'weekly' ? 7 : 1));
  return previous.getTime();
}

function whenKey(when: When): string {
  if (when.kind === 'once') return String(when.ms);
  if (when.kind === 'daily') return `d${when.hour}-${when.minute}`;
  return `w${when.weekday}-${when.hour}-${when.minute}`;
}

function toRequested(item: ScheduledNotification): Requested | null {
  const when = toWhen(item);
  if (!item.id || !when) return null;
  const title = String(item.title ?? '').trim() || 'Notification';
  return { id: item.id, title, body: String(item.body ?? '').trim() || undefined, when };
}

function toEntry(group: string, { id, title, body }: Requested, when: When, nextMs: number, exact: boolean): ScheduleEntry {
  const hash = hashText(`${SCHEDULE_VERSION}|${exact ? 'exact' : 'inexact'}|${title}\n${body ?? ''}`);
  return { identifier: `${IDENTIFIER_PREFIX}${group}_${id}_${whenKey(when)}_${hash}`, id, title, body, when, nextMs };
}

/**
 * What to schedule for `requested`. Without exact alarms a repeating time triggers an hour early
 * (see toTrigger), so a repeating notification first scheduled within that hour misses that
 * occurrence, which is then scheduled as a one-off of its own at the same time. A repeating
 * notification already pending before that hour shows the occurrence itself, so it gets none, and
 * reconcile keeps it pending through that hour, so cap reallocation can't cancel it and bring the
 * fallback back. Such a one-off stays wanted until the occurrence after it passes: kept while late,
 * and not rescheduled once shown.
 */
function toEntries(group: string, requested: Requested, now: number, exact: boolean, scheduled: Scheduled): ScheduleEntry[] {
  const { when } = requested;
  const dueMs = nextOccurrence(when, now);
  const entry = toEntry(group, requested, when, dueMs, exact);
  if (when.kind === 'once' || exact) return [entry];
  const oneOff = (ms: number) => toEntry(group, requested, { kind: 'once', ms }, ms, exact);
  const previous = oneOff(previousOccurrence(when, dueMs));
  const next = oneOff(dueMs);
  const missesNext =
    scheduled.once.has(next.identifier) ||
    (!scheduled.pending.has(entry.identifier) && dueMs - MAX_INEXACT_WINDOW_MS <= now);
  if (missesNext) entry.nextMs = nextOccurrence(when, dueMs);
  const entries = [entry];
  if (scheduled.once.has(previous.identifier)) entries.push(previous);
  if (missesNext) entries.push(next);
  return entries;
}

/**
 * Where to trigger a one-off alarm for `dueMs` without exact alarms: Android delivers it anywhere
 * from its trigger time to the end of its window, and an idle device at the end, so the window must
 * end at the due time. The notification then arrives by the due time, never after it (at most an
 * hour early).
 */
function inexactTriggerMs(dueMs: number, now: number): number {
  const lead = dueMs - now;
  const trigger = lead / (1 + INEXACT_WINDOW_FRACTION);
  return now + (trigger * INEXACT_WINDOW_FRACTION <= MAX_INEXACT_WINDOW_MS ? trigger : lead - MAX_INEXACT_WINDOW_MS);
}

function toTrigger(
  notifications: ExpoNotifications,
  when: When,
  now: number,
  exact: boolean,
): NotificationTriggerInput {
  const types = notifications.SchedulableTriggerInputTypes;
  const channelId = ANDROID_CHANNEL_ID;
  if (when.kind === 'once') {
    return { type: types.DATE, date: exact ? when.ms : inexactTriggerMs(when.ms, now), channelId };
  }
  // Without exact alarms, a repeating time triggers an hour early, so its window ends on time.
  const earlier = exact ? 0 : 1;
  const hour = (when.hour - earlier + 24) % 24;
  if (when.kind === 'daily') return { type: types.DAILY, hour, minute: when.minute, channelId };
  const weekday = when.hour - earlier < 0 ? ((when.weekday + 5) % 7) + 1 : when.weekday;
  return { type: types.WEEKLY, weekday, hour, minute: when.minute, channelId };
}

async function ensurePermission(notifications: ExpoNotifications): Promise<boolean> {
  const current = await notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await notifications.requestPermissionsAsync()).granted;
}

let androidReady = false;

/**
 * Android only. A notification shows only through a channel; high importance shows it as a heads-up
 * banner. expo-notifications posts a notification itself only when it judges the app to be in the
 * background, and otherwise leaves it to the app's handler; a wrapped app can be judged open while
 * it is in the background or the screen is locked, so the handler presents this module's
 * notifications either way. It doesn't affect push, which Firebase Messaging's own service handles
 * on Android, and it isn't set on iOS, where Firebase Messaging owns foreground presentation.
 */
async function ensureAndroidSetup(notifications: ExpoNotifications): Promise<void> {
  if (Platform.OS !== 'android' || androidReady) return;
  notifications.setNotificationHandler({
    handleNotification: async ({ request }) => {
      const isOwn = request.identifier.startsWith(IDENTIFIER_PREFIX);
      return { shouldShowBanner: isOwn, shouldShowList: isOwn, shouldPlaySound: isOwn, shouldSetBadge: false };
    },
  });
  await notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
    name: ANDROID_CHANNEL_NAME,
    importance: notifications.AndroidImportance.HIGH,
    enableVibrate: true,
  });
  androidReady = true;
}

/**
 * Makes `group`'s notifications match `items` (group null cancels every group's), then keeps the
 * soonest MAX_SCHEDULED of every group's scheduled.
 */
async function reconcile(
  notifications: ExpoNotifications,
  group: string | null,
  items: readonly ScheduledNotification[],
): Promise<ScheduledNotificationsResult> {
  const pending = (await notifications.getAllScheduledNotificationsAsync())
    .map(({ identifier }) => identifier)
    .filter((identifier) => identifier.startsWith(IDENTIFIER_PREFIX));
  if (group === null) {
    await writeState({ groups: {}, scheduledOnce: [] });
    for (const identifier of pending) await notifications.cancelScheduledNotificationAsync(identifier);
    return { ok: true, scheduled: 0 };
  }

  const now = Date.now();
  const exact = await hasExactAlarms();
  const state = await readState();
  state.groups[group] = items.map(toRequested).filter((item): item is Requested => item !== null);
  const pendingIds = new Set(pending);
  const scheduled: Scheduled = { pending: pendingIds, once: new Set(state.scheduledOnce) };
  const wanted = new Map<string, ScheduleEntry>();
  for (const [name, requested] of Object.entries(state.groups)) {
    for (const item of requested) {
      for (const entry of toEntries(name, item, now, exact, scheduled)) wanted.set(entry.identifier, entry);
    }
  }
  const entries = [...wanted.values()];
  // A group without stored state (it couldn't be saved) keeps its pending notifications.
  const knownGroups = new Set(Object.keys(state.groups));
  const isKnown = (identifier: string) => knownGroups.has(identifier.slice(IDENTIFIER_PREFIX.length).split('_')[0]);
  const unknownCount = pending.filter((identifier) => !isKnown(identifier)).length;

  // A one-off this module scheduled that is no longer pending has been shown: Android may show an
  // inexact one early, and it mustn't be scheduled again while unchanged.
  const shown = new Set(state.scheduledOnce.filter((identifier) => wanted.has(identifier) && !pendingIds.has(identifier)));
  // Keep, while unchanged, a pending notification whose alarm may be in its delivery window, even when
  // sooner ones want its slot: cancelling it would lose that occurrence, or, if Android already showed
  // it early, bring back the final-hour fallback (see toEntries) and show it twice. That is a one-off
  // whose time has passed and, without exact alarms, a repeating one whose early trigger has passed.
  const inWindow = (entry: ScheduleEntry) =>
    pendingIds.has(entry.identifier) &&
    (entry.when.kind === 'once' ? entry.nextMs - now < MIN_LEAD_MS : !exact && entry.nextMs - MAX_INEXACT_WINDOW_MS <= now);
  const retained = entries.filter(inWindow);
  const upcoming = entries
    .filter((entry) => !inWindow(entry) && (entry.when.kind !== 'once' || entry.nextMs - now >= MIN_LEAD_MS))
    .filter((entry) => !shown.has(entry.identifier))
    .sort((a, b) => a.nextMs - b.nextMs)
    .slice(0, Math.max(0, MAX_SCHEDULED - unknownCount - retained.length));
  const selected = new Map([...retained, ...upcoming].map((entry) => [entry.identifier, entry]));

  for (const identifier of pending) {
    if (isKnown(identifier) && !selected.has(identifier)) await notifications.cancelScheduledNotificationAsync(identifier);
  }
  const isOnce = (identifier: string) => wanted.get(identifier)?.when.kind === 'once';
  state.scheduledOnce = [...shown, ...[...selected.keys()].filter((id) => pendingIds.has(id) && isOnce(id))];
  await writeState(state);
  const groupPrefix = `${IDENTIFIER_PREFIX}${group}_`;
  const scheduledInGroup = [...selected.keys()].filter((identifier) => identifier.startsWith(groupPrefix)).length;

  const missing = [...selected.values()].filter((entry) => !pendingIds.has(entry.identifier));
  if (missing.length === 0) return { ok: true, scheduled: scheduledInGroup };
  if (!(await ensurePermission(notifications))) return { ok: false, reason: 'PERMISSION_DENIED' };
  await ensureAndroidSetup(notifications);
  try {
    for (const entry of missing) {
      await notifications.scheduleNotificationAsync({
        identifier: entry.identifier,
        content: { title: entry.title, body: entry.body, sound: 'default', data: { id: entry.id } },
        trigger: toTrigger(notifications, entry.when, now, exact),
      });
      if (entry.when.kind === 'once') state.scheduledOnce.push(entry.identifier);
    }
  } finally {
    await writeState(state);
  }
  return { ok: true, scheduled: scheduledInGroup };
}

async function reconcileSafely(
  group: string | null,
  items: readonly ScheduledNotification[],
): Promise<ScheduledNotificationsResult> {
  const notifications = loadNotifications();
  if (!notifications) return { ok: false, reason: 'UNAVAILABLE' };
  try {
    return await reconcile(notifications, group, items);
  } catch (error) {
    return { ok: false, reason: 'SCHEDULE_FAILED', message: error instanceof Error ? error.message : String(error) };
  }
}

type Waiter = (result: ScheduledNotificationsResult) => void;
/** Pending work by group, in order: a group's newer call replaces its waiting one and moves last. */
const queue = new Map<string, { items: readonly ScheduledNotification[]; waiters: Waiter[] }>();
let draining = false;

async function drain(): Promise<void> {
  draining = true;
  try {
    while (queue.size > 0) {
      const [key, { items, waiters }] = [...queue][0];
      queue.delete(key);
      const result = await reconcileSafely(key === ALL_GROUPS ? null : key, items);
      waiters.forEach((resolve) => resolve(result));
    }
  } finally {
    draining = false;
  }
}

function enqueue(key: string, items: readonly ScheduledNotification[]): Promise<ScheduledNotificationsResult> {
  return new Promise((resolve) => {
    const waiters: Waiter[] = [resolve];
    // A clear replaces everything waiting before it; a group's call replaces that group's.
    for (const superseded of key === ALL_GROUPS ? [...queue.keys()] : [key]) {
      const entry = queue.get(superseded);
      if (entry) waiters.push(...entry.waiters);
      queue.delete(superseded);
    }
    queue.set(key, { items, waiters });
    if (!draining) void drain();
  });
}

/**
 * Makes `group`'s scheduled notifications match `items`, which must be every notification that
 * source wants (for example one per open task). New ones are scheduled; ones that dropped out,
 * changed time or changed text are cancelled or rescheduled. Every group's latest notifications are
 * kept, so the soonest 48 across all groups are scheduled whichever group syncs. Asks for
 * notification permission only when something new needs scheduling. Calls are serialized, and a
 * call made while one runs replaces the same group's call still waiting.
 */
export function syncScheduledNotifications(
  items: readonly ScheduledNotification[],
  group: string = DEFAULT_GROUP,
): Promise<ScheduledNotificationsResult> {
  return enqueue(normalizeGroup(group), items);
}

/** Cancels every notification this module scheduled, in every group, for example on sign-out. */
export function clearScheduledNotifications(): Promise<ScheduledNotificationsResult> {
  return enqueue(ALL_GROUPS, []);
}

/** Asks for permission to show notifications if it hasn't been decided yet; true when granted. */
export async function requestScheduledNotificationPermission(): Promise<boolean> {
  const notifications = loadNotifications();
  if (!notifications) return false;
  try {
    return await ensurePermission(notifications);
  } catch {
    return false;
  }
}

function syncAndReport(items: readonly ScheduledNotification[], group: string): void {
  void syncScheduledNotifications(items, group).then((result) => {
    if (__DEV__ && !result.ok) console.log('[scheduled-notifications]', group, result.reason, result.message ?? '');
  });
}

/**
 * Keeps `group`'s scheduled notifications in step with `items`: every notification the screen's
 * source wants, or undefined while it loads (nothing changes until it arrives). Pass a memoized
 * array, and mount it once per source, on the screen that loads it. Returning to the app re-syncs:
 * permission may have been granted meanwhile (Android denies a request made while another prompt
 * shows, such as the push notifications one), and passed times free room under the cap.
 */
export function useScheduledNotifications(
  items: readonly ScheduledNotification[] | undefined,
  group: string = DEFAULT_GROUP,
): void {
  const latest = useRef(items);

  useEffect(() => {
    latest.current = items;
    if (items) syncAndReport(items, group);
  }, [items, group]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && latest.current) syncAndReport(latest.current, group);
    });
    return () => subscription.remove();
  }, [group]);
}

/**
 * Mount once, in the signed-in layout. While the user is signed in, a notification from this module
 * that comes due with the app open shows like any other: on Android as a banner (its handler is in
 * place from the start of the session), and on iOS as an in-app alert, the same way open-app push
 * messages are, because Firebase Messaging owns foreground presentation there. Ending the session
 * cancels every group's notifications.
 */
export function useScheduledNotificationSession(isSignedIn: boolean): void {
  useEffect(() => {
    if (!isSignedIn) return undefined;
    // Runs on sign-out, and on unmount: sign-out navigation can unmount this layout before it
    // renders signed out, and the previous user's notifications must not stay scheduled.
    return () => {
      void clearScheduledNotifications();
    };
  }, [isSignedIn]);

  useEffect(() => {
    const notifications = isSignedIn ? loadNotifications() : null;
    if (!notifications) return undefined;
    if (Platform.OS === 'android') {
      ensureAndroidSetup(notifications).catch(() => undefined);
      return undefined;
    }
    let subscription: { remove: () => void } | undefined;
    try {
      subscription = notifications.addNotificationReceivedListener(({ request }) => {
        if (request.identifier.startsWith(IDENTIFIER_PREFIX)) {
          Alert.alert(request.content.title ?? 'Notification', request.content.body ?? undefined);
        }
      });
    } catch {
      subscription = undefined;
    }
    return () => subscription?.remove();
  }, [isSignedIn]);
}
```

## 4. Mount it

Apply Step 2a's decision for `app/(app)/_layout.tsx` and each owner screen: add the calls
when missing, reuse unchanged only if compatible, or make only the approved scoped update.

In `app/(app)/_layout.tsx`, call the session hook once, unconditionally, right after `useAuth()` and before any early return:

```tsx
import { useScheduledNotificationSession } from '../../src/native/scheduledNotifications';

export default function AppLayout() {
  const { isSignedIn, isLoading } = useAuth();
  useScheduledNotificationSession(isSignedIn);
  // …existing calls, redirect and return stay unchanged
}
```

On each owner screen, pass that source's notifications, memoized, with its group. For example, a task list notifying at each open task's due time, and a settings screen with a user-set daily check-in time:

```tsx
import { useScheduledNotifications } from '../../src/native/scheduledNotifications';

const taskNotifications = useMemo(
  () => openTasks?.map((task) => ({ id: task.id, title: task.name, body: 'Due now', date: task.dueDate })),
  [openTasks],
);
useScheduledNotifications(taskNotifications, 'tasks');

const checkInNotifications = useMemo(
  () =>
    settings
      ? [{ id: 'check-in', title: 'Daily check-in', daily: { hour: settings.checkInHour, minute: 0 } }]
      : undefined,
  [settings],
);
useScheduledNotifications(checkInNotifications, 'check-in');
```

During `/create-mobile-app`, this helper runs before the screens exist: add the layout call now, and return each owner screen's call to the owner, which records it in that screen's spec for the screen builder. Step 10b rewrites only the layout's `return`, so the layout call stays.

## 5. Type-check and summary

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
npx --no-install tsc --noEmit
```

Execute the shared compatibility contract's Step 4 after type-checking. Recheck
the lazy load, every export, one-off and repeating times, group isolation, the
shared cap, pending entries kept in their delivery window, delivered one-off state, the Android handler
and timing adjustment, the layout call, and each owner screen's call. Type-check success alone is
insufficient; do not fix screen/generated files. Only after the requested
artifact contract and TypeScript both pass, return the shared compatibility
result and actual created/updated/reused paths before reporting:

```text
Scheduled notifications : READY
Package present         : expo-notifications
Wrapper                 : src/native/scheduledNotifications.ts (Android channel "<name>")
Mounted in              : app/(app)/_layout.tsx (session); <owner screen> (<group>) for each source
Sources                 : <group>: <what> at <when>, titled <title>
Native config           : not changed
Limits                  : a device schedules after it loads each source; Android delivers within the hour before each time (exact once the base has an exact-alarm permission); 48 soonest pending
Wrap note               : keep the Notifications permission selected in the wrap wizard
```

Record each source (group, what, when, owner screen) in `memory-bank.md`.
