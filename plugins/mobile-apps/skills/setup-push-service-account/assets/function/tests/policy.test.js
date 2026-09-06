'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadPolicy,
  RequestError,
  validateRequest,
} = require('../src/policy');

const policy = {
  firebaseProjectId: 'contoso-mobile-prod',
  navigationDestinations: {
    notifications: {},
    'work-item-detail': {
      workItemId: { type: 'guid', required: true },
      tab: { type: 'enum', required: false, values: ['summary', 'activity'] },
    },
  },
  titles: ['You have a new notification.'],
  bodies: ['Open the app to view it.'],
};

function valid(overrides = {}) {
  return {
    topic: 'allUsers',
    title: 'You have a new notification.',
    body: 'Open the app to view it.',
    schemaVersion: '1',
    destination: 'notifications',
    params: '{}',
    validateOnly: true,
    ...overrides,
  };
}

test('accepts allUsers, lowercase OID, and allowlisted typed destinations', () => {
  assert.deepEqual(validateRequest(valid(), policy), valid());
  const oid = '11111111-2222-3333-4444-555555555555';
  assert.equal(validateRequest(valid({
    topic: oid,
    destination: 'work-item-detail',
    params: '{"tab":"summary","workItemId":"11111111-2222-4333-8444-555555555555"}',
  }), policy).topic, oid);
});

test('rejects topic, content, schema, destination, parameter, and field violations', () => {
  const cases = [
    valid({ topic: '11111111-2222-3333-4444-AAAAAAAAAAAA' }),
    valid({ title: 'Customer Contoso has an update' }),
    valid({ body: 'Confidential record details' }),
    valid({ schemaVersion: '2' }),
    valid({ destination: 'unknown' }),
    valid({ destination: 'work-item-detail', params: '{}' }),
    valid({ destination: 'work-item-detail', params: '{"workItemId":"not-a-guid"}' }),
    valid({
      destination: 'work-item-detail',
      params: '{"workItemId":"11111111-2222-4333-8444-555555555555","extra":"no"}',
    }),
    valid({
      destination: 'work-item-detail',
      params: '{ "workItemId": "11111111-2222-4333-8444-555555555555" }',
    }),
    valid({
      destination: 'work-item-detail',
      params: '{"tab":"summary\\\\admin","workItemId":"11111111-2222-4333-8444-555555555555"}',
    }),
    { ...valid(), deepLink: '/notifications' },
    { ...valid(), extra: 'field' },
  ];
  for (const input of cases) {
    assert.throws(() => validateRequest(input, policy), RequestError);
  }
});

test('rejects unsafe deployed policy settings', () => {
  assert.throws(() => loadPolicy({
    FIREBASE_PROJECT_ID: 'contoso-mobile-prod',
    ALLOWED_NAVIGATION_DESTINATIONS: '{"Bad Destination":{}}',
    ALLOWED_NOTIFICATION_TITLES: '["You have a new notification."]',
    ALLOWED_NOTIFICATION_BODIES: '["Open the app to view it."]',
  }));
  assert.throws(() => loadPolicy({
    FIREBASE_PROJECT_ID: '../project',
    ALLOWED_NAVIGATION_DESTINATIONS: '{"notifications":{}}',
    ALLOWED_NOTIFICATION_TITLES: '["You have a new notification."]',
    ALLOWED_NOTIFICATION_BODIES: '["Open the app to view it."]',
  }));
});
