'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  main,
  validateContract,
} = require('../validate-sender-auth-contract');

const SCRIPT = path.join(__dirname, '..', 'validate-sender-auth-contract.js');
const TEST_WORK_ROOT = path.join(__dirname, '.validate-sender-auth-contract-work');
const NOW = new Date('2026-08-18T12:00:00.000Z');
const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SUBSCRIPTION = '99999999-8888-7777-6666-555555555555';

function proof(mode, overrides = {}) {
  return {
    firebaseProjectId: 'contoso-mobile-prod',
    verifiedAt: '2026-08-18T08:00:00.000Z',
    validUntil: '2026-08-19T08:00:00.000Z',
    verifier: mode === 'wif' ? 'setup-push-wif' : 'setup-push-service-account',
    steps: mode === 'wif'
      ? {
        entraTokenIssued: true,
        googleStsExchanged: true,
        serviceAccountImpersonated: true,
        fcmValidateOnly: true,
      }
      : {
        entraAuthorization: true,
        keyVaultSecretRead: true,
        googleTokenMinted: true,
        fcmValidateOnly: true,
      },
    ...overrides,
  };
}

function wifContract() {
  return {
    version: 1,
    mode: 'wif',
    firebaseProjectId: 'contoso-mobile-prod',
    wif: {
      googleProjectNumber: '123456789012',
      workloadIdentityPoolId: 'power-automate-push',
      workloadIdentityProviderId: 'entra-push',
      serviceAccountEmail: 'fcm-sender@contoso-mobile-prod.iam.gserviceaccount.com',
      entra: {
        tenantId: TENANT,
        clientId: CLIENT,
        audience: 'api://contoso-push-sender',
      },
      keyVaultSecretReference: {
        vaultUri: 'https://contoso-push.vault.azure.net/',
        secretName: 'entra-push-sender-client-secret',
      },
      observedClaimShape: {
        issuer: `https://sts.windows.net/${TENANT}/`,
        googleProviderIssuer: `https://sts.windows.net/${TENANT}`,
        audience: 'api://contoso-push-sender',
        appIdentityClaim: 'appid',
        appIdentityValue: CLIENT,
      },
    },
    proof: proof('wif'),
  };
}

function functionContract() {
  return {
    version: 1,
    mode: 'function-endpoint',
    firebaseProjectId: 'contoso-mobile-prod',
    functionEndpoint: {
      endpointUrl: 'https://contoso-push.azurewebsites.net/api/send',
      entra: {
        resourceAudience: 'api://contoso-push-function',
        applicationId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
      },
      connection: {
        referenceName: 'fcmSenderFunction',
        resourceId: `/subscriptions/${SUBSCRIPTION}/resourceGroups/mobile-prod/providers/Microsoft.Web/connections/fcm-sender`,
      },
      deploymentIdentity: {
        resourceId: `/subscriptions/${SUBSCRIPTION}/resourceGroups/mobile-prod/providers/Microsoft.Web/sites/contoso-push`,
        principalId: 'cccccccc-dddd-eeee-ffff-000000000000',
      },
    },
    proof: proof('function-endpoint'),
  };
}

function codes(contract, options = {}) {
  return validateContract(contract, { now: NOW, ...options }).map((entry) => entry.code);
}

test.after(() => {
  fs.rmSync(TEST_WORK_ROOT, { recursive: true, force: true });
});

test('accepts complete wif and function-endpoint contracts', () => {
  assert.deepStrictEqual(codes(wifContract()), []);
  assert.deepStrictEqual(codes(functionContract()), []);
});

test('requires the proof verifier that owns each sender-auth mode', () => {
  const wif = wifContract();
  wif.proof.verifier = 'setup-push-service-account';
  assert.ok(codes(wif).includes('proof-verifier-mismatch'));

  const endpoint = functionContract();
  endpoint.proof.verifier = 'setup-push-wif';
  assert.ok(codes(endpoint).includes('proof-verifier-mismatch'));
});

test('rejects unknown versions, modes, and mode-specific field conflicts', () => {
  const unknown = wifContract();
  unknown.version = 2;
  unknown.mode = 'service-account';
  assert.ok(codes(unknown).includes('unsupported-version'));
  assert.ok(codes(unknown).includes('unsupported-mode'));

  const conflict = wifContract();
  conflict.functionEndpoint = functionContract().functionEndpoint;
  assert.ok(codes(conflict).includes('mode-field-conflict'));

  const manual = wifContract();
  manual.mode = 'manual';
  delete manual.wif;
  manual.manualEndpoint = {
    url: 'https://customer.example/send',
  };
  assert.ok(codes(manual).includes('unsupported-mode'));
  assert.ok(codes(manual).includes('unknown-field'));
});

test('rejects secret fields, private keys, bearer tokens, raw JWTs, and embedded URL credentials', () => {
  for (const mutate of [
    (value) => { value.client_secret = 'not-allowed'; },
    (value) => { value.note = '-----BEGIN PRIVATE KEY-----'; },
    (value) => { value.note = 'Bearer secret-token-value'; },
    (value) => { value.note = 'eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJmY20ifQ.signature'; },
    (value) => { value.note = 'https://user:password@example.com/path'; },
  ]) {
    const contract = wifContract();
    mutate(contract);
    const result = codes(contract);
    assert.ok(
      result.includes('secret-field-forbidden')
      || result.includes('secret-value-forbidden')
      || result.includes('embedded-credentials-forbidden'),
    );
  }
});

test('rejects non-HTTPS or credential-bearing function endpoints', () => {
  const http = functionContract();
  http.functionEndpoint.endpointUrl = 'http://contoso.example/api/send';
  assert.ok(codes(http).includes('invalid-https-url'));

  const credentials = functionContract();
  credentials.functionEndpoint.endpointUrl = 'https://user:password@contoso.example/api/send';
  assert.ok(codes(credentials).includes('embedded-credentials-forbidden'));
  assert.ok(codes(credentials).includes('invalid-https-url'));
});

test('rejects malformed safe resource identifiers and inconsistent observed claims', () => {
  const contract = wifContract();
  contract.wif.googleProjectNumber = 'project-number';
  contract.wif.serviceAccountEmail = 'sender@example.com';
  contract.wif.entra.tenantId = 'not-a-guid';
  contract.wif.observedClaimShape.audience = 'api://different';
  contract.wif.observedClaimShape.appIdentityValue = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  const result = codes(contract);
  assert.ok(result.includes('malformed-resource-id'));
  assert.ok(result.includes('claim-audience-mismatch'));
  assert.ok(result.includes('claim-client-mismatch'));
});

test('rejects malformed function resource IDs and WIF issuer/provider mismatches', () => {
  const endpoint = functionContract();
  endpoint.functionEndpoint.connection.resourceId =
    '/subscriptions/not-a-guid/resourceGroups/mobile/providers/Microsoft.Web/connections/sender';
  delete endpoint.functionEndpoint.deploymentIdentity.principalId;
  const endpointResult = codes(endpoint);
  assert.ok(endpointResult.includes('malformed-resource-id'));
  assert.ok(endpointResult.includes('missing-field'));

  const wif = wifContract();
  wif.wif.observedClaimShape.issuer =
    'https://sts.windows.net/bbbbbbbb-cccc-dddd-eeee-ffffffffffff/';
  wif.wif.observedClaimShape.googleProviderIssuer = 'https://login.example/tenant';
  const wifResult = codes(wif);
  assert.ok(wifResult.includes('issuer-tenant-mismatch'));
});

test('requires Function connection and deployment IDs to identify their actual Azure resources', () => {
  const swapped = functionContract();
  swapped.functionEndpoint.connection.resourceId =
    `/subscriptions/${SUBSCRIPTION}/resourceGroups/mobile-prod/providers/Microsoft.Web/sites/contoso-push`;
  swapped.functionEndpoint.deploymentIdentity.resourceId =
    `/subscriptions/${SUBSCRIPTION}/resourceGroups/mobile-prod/providers/Microsoft.Web/connections/fcm-sender`;
  const swappedIssues = validateContract(swapped, { now: NOW });

  assert.ok(swappedIssues.some((entry) => (
    entry.code === 'malformed-resource-id'
    && entry.field === 'functionEndpoint.connection.resourceId'
  )));
  assert.ok(swappedIssues.some((entry) => (
    entry.code === 'malformed-resource-id'
    && entry.field === 'functionEndpoint.deploymentIdentity.resourceId'
  )));

  const nested = functionContract();
  nested.functionEndpoint.deploymentIdentity.resourceId += '/slots/staging';
  assert.ok(codes(nested).includes('malformed-resource-id'));
});

test('rejects incomplete, stale, future, or overlong proof metadata', () => {
  const incomplete = wifContract();
  incomplete.proof.steps.googleStsExchanged = false;
  assert.ok(codes(incomplete).includes('proof-step-incomplete'));

  const stale = wifContract();
  stale.proof.verifiedAt = '2026-08-16T08:00:00.000Z';
  stale.proof.validUntil = '2026-08-17T08:00:00.000Z';
  assert.ok(codes(stale).includes('stale-proof'));

  const future = wifContract();
  future.proof.verifiedAt = '2026-08-18T13:00:00.000Z';
  future.proof.validUntil = '2026-08-19T13:00:00.000Z';
  assert.ok(codes(future).includes('proof-from-future'));

  const overlong = wifContract();
  overlong.proof.validUntil = '2026-08-20T08:00:00.000Z';
  assert.ok(codes(overlong).includes('invalid-proof-window'));
});

test('rejects proof and expected Firebase project mismatches', () => {
  const proofMismatch = wifContract();
  proofMismatch.proof.firebaseProjectId = 'other-mobile-prod';
  assert.ok(codes(proofMismatch).includes('proof-project-mismatch'));

  assert.ok(codes(wifContract(), {
    expectedFirebaseProject: 'other-mobile-prod',
  }).includes('firebase-project-mismatch'));
});

test('CLI emits structured JSON and uses exit 0/2 for valid/invalid contracts', () => {
  const root = path.join(TEST_WORK_ROOT, 'cli-project');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'sender-auth.json');
  fs.writeFileSync(file, JSON.stringify(wifContract()));

  const valid = spawnSync(process.execPath, [
    SCRIPT,
    '--project-root', root,
    '--expected-firebase-project', 'contoso-mobile-prod',
    '--now', NOW.toISOString(),
  ], { encoding: 'utf8' });
  assert.strictEqual(valid.status, 0);
  assert.strictEqual(JSON.parse(valid.stdout).status, 'valid');

  const invalidContract = wifContract();
  invalidContract.proof.steps.fcmValidateOnly = false;
  fs.writeFileSync(file, JSON.stringify(invalidContract));
  const invalid = spawnSync(process.execPath, [
    SCRIPT,
    '--project-root', root,
    '--now', NOW.toISOString(),
  ], { encoding: 'utf8' });
  assert.strictEqual(invalid.status, 2);
  assert.strictEqual(JSON.parse(invalid.stdout).status, 'invalid');
});

test('CLI rejects paths outside the project and symbolic-link contract files', (t) => {
  const root = path.join(TEST_WORK_ROOT, 'safe-project');
  const outside = path.join(TEST_WORK_ROOT, 'outside.json');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(outside, JSON.stringify(wifContract()));

  assert.strictEqual(main([
    '--project-root', root,
    '--file', '../outside.json',
    '--now', NOW.toISOString(),
  ]), 1);

  const link = path.join(root, 'sender-auth.json');
  fs.symlinkSync(outside, link);
  t.after(() => fs.rmSync(link, { force: true }));
  assert.strictEqual(main([
    '--project-root', root,
    '--file', 'sender-auth.json',
    '--now', NOW.toISOString(),
  ]), 1);
});
