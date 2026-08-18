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
  deepLinkPrefixes: ['/(app)/', '/notifications', 'contoso://'],
  titles: ['You have a new notification.'],
  bodies: ['Open the app to view it.'],
};

function valid(overrides = {}) {
  return {
    topic: 'allUsers',
    title: 'You have a new notification.',
    body: 'Open the app to view it.',
    schemaVersion: '1',
    deepLink: '/notifications',
    validateOnly: true,
    ...overrides,
  };
}

test('accepts allUsers, lowercase OID, and allowlisted internal links', () => {
  assert.deepEqual(validateRequest(valid(), policy), valid());
  const oid = '11111111-2222-3333-4444-555555555555';
  assert.equal(validateRequest(valid({
    topic: oid,
    deepLink: '/(app)/work-items/11111111-2222-3333-4444-555555555555',
  }), policy).topic, oid);
  assert.equal(validateRequest(valid({ deepLink: 'contoso://notifications' }), policy).deepLink, 'contoso://notifications');
});

test('rejects topic, content, schema, link, and field violations', () => {
  const cases = [
    valid({ topic: '11111111-2222-3333-4444-AAAAAAAAAAAA' }),
    valid({ title: 'Customer Contoso has an update' }),
    valid({ body: 'Confidential record details' }),
    valid({ schemaVersion: '2' }),
    valid({ deepLink: 'https://example.com' }),
    valid({ deepLink: '/(app)/../admin' }),
    valid({ deepLink: '/(app)/%2e%2e/admin' }),
    { ...valid(), extra: 'field' },
  ];
  for (const input of cases) {
    assert.throws(() => validateRequest(input, policy), RequestError);
  }
});

test('rejects unsafe deployed policy settings', () => {
  assert.throws(() => loadPolicy({
    FIREBASE_PROJECT_ID: 'contoso-mobile-prod',
    ALLOWED_DEEP_LINK_PREFIXES: '["https://example.com"]',
    ALLOWED_NOTIFICATION_TITLES: '["You have a new notification."]',
    ALLOWED_NOTIFICATION_BODIES: '["Open the app to view it."]',
  }));
  assert.throws(() => loadPolicy({
    FIREBASE_PROJECT_ID: '../project',
    ALLOWED_DEEP_LINK_PREFIXES: '["/notifications"]',
    ALLOWED_NOTIFICATION_TITLES: '["You have a new notification."]',
    ALLOWED_NOTIFICATION_BODIES: '["Open the app to view it."]',
  }));
});
