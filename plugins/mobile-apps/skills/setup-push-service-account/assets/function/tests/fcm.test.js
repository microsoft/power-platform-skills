'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_ATTEMPTS,
  buildFcmRequest,
  errorForStatus,
  sendFcm,
} = require('../src/fcm');

const request = {
  topic: 'allUsers',
  title: 'You have a new notification.',
  body: 'Open the app to view it.',
  schemaVersion: '1',
  deepLink: '/notifications',
  validateOnly: true,
};

test('constructs the expected string-data FCM validate_only request', () => {
  assert.deepEqual(buildFcmRequest(request), {
    message: {
      topic: 'allUsers',
      notification: {
        title: 'You have a new notification.',
        body: 'Open the app to view it.',
      },
      data: {
        schemaVersion: '1',
        deepLink: '/notifications',
      },
    },
    validate_only: true,
  });
});

test('maps errors without retaining response bodies', () => {
  assert.deepEqual(errorForStatus(403), { code: 'FCM_FORBIDDEN', retryable: false });
  assert.deepEqual(errorForStatus(503), { code: 'FCM_TRANSIENT', retryable: true });
  assert.equal(JSON.stringify(errorForStatus(400)).includes('secret'), false);
});

test('bounds transient retries and returns only a sanitized category', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return {
      ok: false,
      status: 503,
      json: async () => ({ error: { message: 'Bearer token and private key' } }),
    };
  };
  const result = await sendFcm({
    accessToken: 'not-logged',
    firebaseProjectId: 'contoso-mobile-prod',
    request,
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(attempts, MAX_ATTEMPTS);
  assert.deepEqual(result, {
    ok: false,
    error: { code: 'FCM_TRANSIENT', retryable: true },
  });
});
