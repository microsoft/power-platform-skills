// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Test-only HTTP interception; the installed resolver exposes no endpoint/auth injection flags.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { sample } from './helpers.mjs';

let fetches = 0;
globalThis.fetch = async request => {
  fetches++;
  assert.equal(request.method, 'GET');
  assert.equal(request.redirect, 'manual');
  assert.equal(request.url, `https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/${sample.EnvironmentId}?api-version=2020-10-01`);
  assert.ok(request.headers.has('authorization'));
  assert.equal(request.headers.get('x-ms-client-request-id'), null);
  assert.equal(request.headers.get('x-ms-client-session-id'), null);
  return Response.json({ name: sample.EnvironmentId, properties: { tenantId: sample.TenantId } });
};
process.once('exit', () => {
  if (process.env.FIXTURE_REPORT) writeFileSync(process.env.FIXTURE_REPORT, JSON.stringify({ fetches }));
});
