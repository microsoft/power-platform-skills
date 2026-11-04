'use strict';
// Protected configuration (`configurationIdentity: "stable-v1"`): the opt-in, the whole-plan read-only preflight that stops an
// unsupported edit before the build changes anything, and the build-side hookup of the configuration create driver.

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAppSpec, CONFIGURATION_IDENTITY_MIN_VERSION } = require('../lib/app-spec.js');
const { lintAppSpec } = require('../lib/spec-lint.js');

const SOL = 'ContosoSol';
function baseSpec(extra = {}) {
  return {
    solution: { uniqueName: SOL, displayName: 'Contoso', publisherPrefix: 'contoso' },
    app: { name: 'Configured', uniqueName: 'contoso_configured' },
    entities: [{ schemaName: 'contoso_item', displayName: 'Item', existing: true, primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' } }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'contoso_item', title: 'Items' }] }] }] },
    environmentVariables: [{ schemaName: 'contoso_ApiBase', type: 'string', defaultValue: 'https://example.invalid' }],
    ...extra,
  };
}

test('configurationIdentity takes exactly "stable-v1" and asks for a 2.23.0 floor', () => {
  const errorsOf = (spec) => validateAppSpec(spec).errors.filter((e) => /configurationIdentity/.test(e));
  assert.equal(CONFIGURATION_IDENTITY_MIN_VERSION, '2.23.0');
  assert.deepEqual(errorsOf(baseSpec()), []);
  assert.deepEqual(errorsOf(baseSpec({ configurationIdentity: 'stable-v1' })), []);
  for (const bad of ['stable-v2', 'Stable-V1', true, null, '', 1]) {
    const errors = errorsOf(baseSpec({ configurationIdentity: bad }));
    assert.equal(errors.length, 1, JSON.stringify(bad));
    assert.match(errors[0], /^create-identity-invalid: configurationIdentity must be "stable-v1" or absent/);
  }
  // No alias: another spelling is not the opt-in (and createIdentity alone does not turn it on).
  assert.deepEqual(errorsOf(baseSpec({ createIdentity: 'stable-v1' })), []);
  const floor = (spec) => lintAppSpec(spec).warnings.filter((w) => /when using configurationIdentity/.test(w));
  assert.equal(floor(baseSpec({ configurationIdentity: 'stable-v1' })).length, 1, 'no floor: older plugins ignore the field');
  assert.equal(floor(baseSpec({ configurationIdentity: 'stable-v1', minimumPluginVersion: '2.22.0' })).length, 1);
  assert.deepEqual(floor(baseSpec({ configurationIdentity: 'stable-v1', minimumPluginVersion: '2.23.0' })), []);
  assert.deepEqual(floor(baseSpec()), [], 'no opt-in, no warning');
  assert.equal(lintAppSpec(baseSpec({ configurationIdentity: 'stable-v1' })).errors.length, 0, 'a warning, never an error');
});
