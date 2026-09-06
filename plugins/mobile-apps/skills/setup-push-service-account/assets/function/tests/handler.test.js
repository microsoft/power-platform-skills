'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleSend, safeFailure } = require('../src/handler');
const { CredentialError } = require('../src/credentials');

const policy = {
  firebaseProjectId: 'contoso-mobile-prod',
  navigationDestinations: {
    notifications: {},
  },
  titles: ['You have a new notification.'],
  bodies: ['Open the app to view it.'],
};

function request(body) {
  return { json: async () => body };
}

const valid = {
  topic: 'allUsers',
  title: 'You have a new notification.',
  body: 'Open the app to view it.',
  schemaVersion: '1',
  destination: 'notifications',
  params: '{}',
  validateOnly: true,
};

test('returns a bounded success without exposing an access token', async () => {
  const response = await handleSend(request(valid), {}, {
    loadPolicy: () => policy,
    getGoogleAccessToken: async () => 'sensitive-token',
    sendFcm: async ({ accessToken }) => {
      assert.equal(accessToken, 'sensitive-token');
      return { ok: true, providerMessageId: 'projects/p/messages/123' };
    },
  });
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify(response).includes('sensitive-token'), false);
});

test('redacts unexpected error details and stack traces', () => {
  const response = safeFailure(new Error('private_key Bearer sensitive-token'));
  assert.deepEqual(response.jsonBody, {
    ok: false,
    error: { code: 'INTERNAL_ERROR' },
  });
});

test('maps credential stages to stable categories without raw details', () => {
  assert.deepEqual(
    safeFailure(new CredentialError('KEY_VAULT_CONFIGURATION_INVALID')).jsonBody,
    { ok: false, error: { code: 'KEY_VAULT_CONFIGURATION_INVALID' } },
  );
  assert.deepEqual(
    safeFailure(new CredentialError('KEY_VAULT_UNAVAILABLE')).jsonBody,
    { ok: false, error: { code: 'KEY_VAULT_UNAVAILABLE' } },
  );
  assert.deepEqual(
    safeFailure(new CredentialError('FIREBASE_CREDENTIAL_INVALID')).jsonBody,
    { ok: false, error: { code: 'FIREBASE_CREDENTIAL_INVALID' } },
  );
  assert.deepEqual(
    safeFailure(new CredentialError('GOOGLE_AUTH_FAILED')).jsonBody,
    { ok: false, error: { code: 'GOOGLE_AUTH_FAILED' } },
  );
});
