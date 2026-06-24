'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  stamp,
  withSchemaVersion,
  ageMs,
  describeAge,
  isStale,
} = require('../lib/artifact-timestamps');

const ISO_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('stamp sets createdAt and updatedAt in ISO-8601 UTC format', () => {
  const obj = stamp({}, { now: '2026-06-23T12:34:56.789Z' });

  assert.match(obj.createdAt, ISO_UTC_REGEX);
  assert.match(obj.updatedAt, ISO_UTC_REGEX);
  assert.equal(obj.createdAt, '2026-06-23T12:34:56.789Z');
  assert.equal(obj.updatedAt, '2026-06-23T12:34:56.789Z');
});

test('stamp preserves createdAt across stamps while updatedAt advances', () => {
  const obj = stamp({}, { now: '2026-06-23T12:00:00.000Z' });
  const firstCreatedAt = obj.createdAt;
  const firstUpdatedAt = obj.updatedAt;

  const result = stamp(obj, { now: '2026-06-23T12:05:00.000Z' });

  assert.equal(result, obj);
  assert.equal(obj.createdAt, firstCreatedAt);
  assert.notEqual(obj.updatedAt, firstUpdatedAt);
  assert.equal(obj.updatedAt, '2026-06-23T12:05:00.000Z');
});

test('stamp now accepts number, Date, and ISO string values', () => {
  const millis = Date.UTC(2026, 5, 23, 12, 34, 56, 789);

  assert.equal(stamp({}, { now: millis }).updatedAt, '2026-06-23T12:34:56.789Z');
  assert.equal(stamp({}, { now: new Date(millis) }).updatedAt, '2026-06-23T12:34:56.789Z');
  assert.equal(stamp({}, { now: '2026-06-23T12:34:56.789Z' }).updatedAt, '2026-06-23T12:34:56.789Z');
});

test('stamp does not clobber other fields', () => {
  const nested = { value: true };
  const obj = { name: 'artifact', count: 3, nested };

  stamp(obj, { now: '2026-06-23T12:34:56.789Z' });

  assert.equal(obj.name, 'artifact');
  assert.equal(obj.count, 3);
  assert.equal(obj.nested, nested);
});

test('stamp throws a clear error for null and non-object input', () => {
  assert.throws(() => stamp(null), /stamp: obj must be an object\./);
  assert.throws(() => stamp(undefined), /stamp: obj must be an object\./);
  assert.throws(() => stamp('artifact'), /stamp: obj must be an object\./);
});

test('ageMs computes age and returns null for a missing timestamp field', () => {
  const obj = { updatedAt: '2026-06-23T12:00:00.000Z' };

  assert.equal(ageMs(obj, { now: '2026-06-23T12:00:05.250Z' }), 5250);
  assert.equal(ageMs({}, { now: '2026-06-23T12:00:05.250Z' }), null);
});

test('ageMs returns null for an unparseable timestamp field', () => {
  assert.equal(ageMs({ updatedAt: 'not-a-date' }, { now: '2026-06-23T12:00:00.000Z' }), null);
});

test('describeAge handles seconds, minutes, hours, days, plurals, and unknown values', () => {
  assert.equal(describeAge(0), 'just now');
  assert.equal(describeAge(59_999), 'just now');
  assert.equal(describeAge(60_000), '1 minute ago');
  assert.equal(describeAge(2 * 60_000), '2 minutes ago');
  assert.equal(describeAge(60 * 60_000), '1 hour ago');
  assert.equal(describeAge(2 * 60 * 60_000), '2 hours ago');
  assert.equal(describeAge(24 * 60 * 60_000), '1 day ago');
  assert.equal(describeAge(2 * 24 * 60 * 60_000), '2 days ago');
  assert.equal(describeAge(null), 'unknown');
  assert.equal(describeAge(-1), 'unknown');
});

test('isStale is true past maxAge, false within maxAge, and true when missing', () => {
  const now = '2026-06-23T12:00:00.000Z';

  assert.equal(isStale({ updatedAt: '2026-06-23T11:59:00.000Z' }, { now, maxAgeMs: 30_000 }), true);
  assert.equal(isStale({ updatedAt: '2026-06-23T11:59:45.000Z' }, { now, maxAgeMs: 30_000 }), false);
  assert.equal(isStale({}, { now, maxAgeMs: 30_000 }), true);
});

test('isStale defaults maxAgeMs to seven days', () => {
  const now = '2026-06-23T12:00:00.000Z';

  assert.equal(isStale({ updatedAt: '2026-06-16T12:00:00.000Z' }, { now }), false);
  assert.equal(isStale({ updatedAt: '2026-06-16T11:59:59.999Z' }, { now }), true);
});

test('withSchemaVersion sets schemaVersion only when absent', () => {
  const missing = { name: 'artifact' };
  const present = { schemaVersion: '1.0.0' };

  assert.equal(withSchemaVersion(missing, '2.0.0'), missing);
  assert.equal(missing.schemaVersion, '2.0.0');
  assert.equal(withSchemaVersion(present, '2.0.0'), present);
  assert.equal(present.schemaVersion, '1.0.0');
});

test('withSchemaVersion does not set schemaVersion when version is omitted', () => {
  const obj = {};

  withSchemaVersion(obj);

  assert.equal(Object.prototype.hasOwnProperty.call(obj, 'schemaVersion'), false);
});
