'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listEnvironments } = require('../lib/list-environments');

// A realistic `pac env list --json` row shape (verified 2026-06-13).
const PAC_ROWS = JSON.stringify([
  {
    OrganizationId: 'org-1', UniqueName: 'unqaaa', FriendlyName: 'Zeta Sandbox',
    EnvironmentIdentifier: { Type: 1, Id: 'env-zeta', IsDefault: false },
    EnvironmentUrl: 'https://zeta.crm.dynamics.com/', Geo: 'NA',
  },
  {
    OrganizationId: 'org-2', UniqueName: 'unqbbb', FriendlyName: 'Alpha Prod',
    EnvironmentIdentifier: { Type: 1, Id: 'env-alpha', IsDefault: true },
    EnvironmentUrl: 'https://alpha.crm.dynamics.com', Geo: 'EU',
  },
]);

test('maps pac rows to a clean shape and trims trailing slash on url', () => {
  const r = listEnvironments({ _execImpl: () => PAC_ROWS });
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  const zeta = r.environments.find((e) => e.environmentId === 'env-zeta');
  assert.equal(zeta.friendlyName, 'Zeta Sandbox');
  assert.equal(zeta.url, 'https://zeta.crm.dynamics.com', 'trailing slash trimmed');
  assert.equal(zeta.geo, 'NA');
  assert.equal(zeta.isDefault, false);
});

test('default environment sorts first; defaultUrl reflects it', () => {
  const r = listEnvironments({ _execImpl: () => PAC_ROWS });
  assert.equal(r.environments[0].friendlyName, 'Alpha Prod', 'default env first');
  assert.equal(r.environments[0].isDefault, true);
  assert.equal(r.defaultUrl, 'https://alpha.crm.dynamics.com');
});

test('non-default environments sort alphabetically by friendlyName', () => {
  const rows = JSON.stringify([
    { FriendlyName: 'Yankee', EnvironmentIdentifier: { Id: 'y', IsDefault: false }, EnvironmentUrl: 'https://y.crm.dynamics.com' },
    { FriendlyName: 'Bravo', EnvironmentIdentifier: { Id: 'b', IsDefault: false }, EnvironmentUrl: 'https://b.crm.dynamics.com' },
  ]);
  const r = listEnvironments({ _execImpl: () => rows });
  assert.deepEqual(r.environments.map((e) => e.friendlyName), ['Bravo', 'Yankee']);
});

test('graceful failure when pac throws (not logged in / missing): ok:false with hint', () => {
  const r = listEnvironments({ _execImpl: () => { throw new Error('pac: command not found'); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /pac env list failed/);
  assert.match(r.hint, /--envUrl/);
});

test('graceful failure when pac returns non-JSON', () => {
  const r = listEnvironments({ _execImpl: () => 'No environments found.' });
  assert.equal(r.ok, false);
  assert.match(r.hint, /--envUrl/);
});

test('graceful failure when pac returns a non-array JSON value', () => {
  const r = listEnvironments({ _execImpl: () => '{"unexpected":true}' });
  assert.equal(r.ok, false);
  assert.match(r.error, /did not return an array/);
});
