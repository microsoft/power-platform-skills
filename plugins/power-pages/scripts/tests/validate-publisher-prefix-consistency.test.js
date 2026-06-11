'use strict';

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');
const os      = require('node:os');
const Module  = require('node:module');

const realLoad = Module._load;

function mockMakeRequest(mock) {
  const cache = path.join(path.dirname(require.resolve('../lib/validation-helpers')), 'validation-helpers.js');
  Module._load = function (request, parent, isMain) {
    if (request === './validation-helpers') {
      return {
        getAuthToken: () => 'fake-token',
        getEnvironmentUrl: () => 'https://x.crm.dynamics.com',
        makeRequest: mock,
      };
    }
    return realLoad(request, parent, isMain);
  };
  delete require.cache[require.resolve('../lib/validate-publisher-prefix-consistency')];
}
function restore() { Module._load = realLoad; }

function tmpFile(t, obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubprefix-'));
  const f = path.join(dir, 'snap.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return f;
}

const SOLUTION_RESP = JSON.stringify({
  value: [{
    solutionid: 'sol-1', uniquename: 'InternLearning',
    publisherid: { customizationprefix: 'sri', uniquename: 'sripub' },
  }],
});

test('extractSchemaName: prefers componentName when present', () => {
  const { extractSchemaName } = require('../lib/validate-publisher-prefix-consistency');
  assert.equal(extractSchemaName({ componentName: 'sri_account' }), 'sri_account');
});

test('extractSchemaName: falls back to last path segment, strips extension', () => {
  const { extractSchemaName } = require('../lib/validate-publisher-prefix-consistency');
  assert.equal(extractSchemaName({ componentpath: '/a/b/sri_lookup.xml' }), 'sri_lookup');
  assert.equal(extractSchemaName({ filePath:     '/a/b/sri_other.json' }), 'sri_other');
});

test('isSystemPrefix: matches known Microsoft / system prefixes case-insensitively', () => {
  const { isSystemPrefix } = require('../lib/validate-publisher-prefix-consistency');
  assert.equal(isSystemPrefix('msdyn'), true);
  assert.equal(isSystemPrefix('MSDYN'), true);
  assert.equal(isSystemPrefix('cdm'), true);
  assert.equal(isSystemPrefix('sri'), false);
});

test('validatePublisherPrefixConsistency: requires --pending-file', async () => {
  const { validatePublisherPrefixConsistency } = require('../lib/validate-publisher-prefix-consistency');
  const r = await validatePublisherPrefixConsistency({});
  assert.match(r.error, /--pending-file is required/);
});

test('validatePublisherPrefixConsistency: requires --solutionUniqueName', async (t) => {
  const snap = tmpFile(t, { items: [] });
  const { validatePublisherPrefixConsistency } = require('../lib/validate-publisher-prefix-consistency');
  const r = await validatePublisherPrefixConsistency({ pendingFile: snap, envUrl: 'https://x.crm.dynamics.com', token: 't' });
  assert.match(r.error, /--solutionUniqueName/);
});

test('validatePublisherPrefixConsistency: WARNs on prefix mismatch', async (t) => {
  mockMakeRequest(async () => ({ statusCode: 200, body: SOLUTION_RESP }));
  t.after(restore);
  const snap = tmpFile(t, { items: [
    { componentName: 'cr_other',    componentType: 'Entity'    },
    { componentName: 'sri_account', componentType: 'Entity'    },
  ] });
  const { validatePublisherPrefixConsistency } = require('../lib/validate-publisher-prefix-consistency');
  const r = await validatePublisherPrefixConsistency({
    pendingFile: snap, envUrl: 'https://x.crm.dynamics.com', token: 't',
    solutionUniqueName: 'InternLearning',
  });
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].details.actualPrefix, 'cr');
  assert.equal(r.warnings[0].details.expectedPrefix, 'sri');
});

test('validatePublisherPrefixConsistency: emits info for skipped system prefixes', async (t) => {
  mockMakeRequest(async () => ({ statusCode: 200, body: SOLUTION_RESP }));
  t.after(restore);
  const snap = tmpFile(t, { items: [
    { componentName: 'msdyn_workflow' },
    { componentName: 'cdm_lookup'     },
  ] });
  const { validatePublisherPrefixConsistency } = require('../lib/validate-publisher-prefix-consistency');
  const r = await validatePublisherPrefixConsistency({
    pendingFile: snap, envUrl: 'https://x.crm.dynamics.com', token: 't',
    solutionUniqueName: 'InternLearning',
  });
  assert.equal(r.warnings.length, 0);
  const infoSkip = r.info.find((x) => x.key === 'publisher-prefix-system-skipped');
  assert.ok(infoSkip);
  assert.equal(infoSkip.details.skippedSystemCount, 2);
});

test('validatePublisherPrefixConsistency: returns {error} when solution not found', async (t) => {
  mockMakeRequest(async () => ({ statusCode: 200, body: '{"value":[]}' }));
  t.after(restore);
  const snap = tmpFile(t, { items: [] });
  const { validatePublisherPrefixConsistency } = require('../lib/validate-publisher-prefix-consistency');
  const r = await validatePublisherPrefixConsistency({
    pendingFile: snap, envUrl: 'https://x.crm.dynamics.com', token: 't',
    solutionUniqueName: 'NotThere',
  });
  assert.match(r.error, /not found/);
});

test('validatePublisherPrefixConsistency: returns {error} on HTTP non-200', async (t) => {
  mockMakeRequest(async () => ({ statusCode: 401, body: '{"error":{"message":"auth failed"}}' }));
  t.after(restore);
  const snap = tmpFile(t, { items: [] });
  const { validatePublisherPrefixConsistency } = require('../lib/validate-publisher-prefix-consistency');
  const r = await validatePublisherPrefixConsistency({
    pendingFile: snap, envUrl: 'https://x.crm.dynamics.com', token: 't',
    solutionUniqueName: 'InternLearning',
  });
  assert.equal(r.statusCode, 401);
  assert.match(r.error, /auth failed/);
});
