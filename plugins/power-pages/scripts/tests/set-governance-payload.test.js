const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPolicyPayload } = require('../../skills/manage-governance/scripts/set-governance');

// buildPolicyPayload is the single seam where a canonical policyValue
// (All / None / Include / Exclude) is forward-mapped to the value that
// actually goes on the wire. Env-level policies (Maker Copilot + the nine
// auth Enable* toggles) must emit the applyTo enum vocabulary ("AllSites"
// etc.); posting the short canonical form makes the gateway silently reject
// the upsert. The two legacy Disable* auth policies keep the canonical form.

const ENV_LEVEL_POLICY = 'EnableMakerCopilotForExistingSites';
const LEGACY_POLICY = 'PowerPages_DisableAuthenticationOpenIdConnect';

test('env-level policy env-wide enable posts applyTo enum "AllSites"', () => {
  const [entry] = buildPolicyPayload(ENV_LEVEL_POLICY, [], null);
  assert.equal(entry.policyName, ENV_LEVEL_POLICY);
  assert.equal(entry.policyValue, 'AllSites');
  assert.deepEqual(entry.ToBeAdded, []);
  assert.deepEqual(entry.ToBeRemoved, []);
});

test('env-level policy env-wide disable posts "None"', () => {
  const [entry] = buildPolicyPayload(ENV_LEVEL_POLICY, [], 'None');
  assert.equal(entry.policyValue, 'None');
  assert.deepEqual(entry.ToBeAdded, []);
});

test('env-level policy Include posts applyTo enum "IncludeSites" with ids', () => {
  const [entry] = buildPolicyPayload(ENV_LEVEL_POLICY, ['a', 'b'], 'Include');
  assert.equal(entry.policyValue, 'IncludeSites');
  assert.deepEqual(entry.ToBeAdded, ['a', 'b']);
});

test('env-level policy Exclude posts applyTo enum "ExcludeSites"', () => {
  const [entry] = buildPolicyPayload(ENV_LEVEL_POLICY, ['a'], 'Exclude');
  assert.equal(entry.policyValue, 'ExcludeSites');
  assert.deepEqual(entry.ToBeAdded, ['a']);
});

test('env-level policy defaults to Include enum when portalIds given and no override', () => {
  const [entry] = buildPolicyPayload(ENV_LEVEL_POLICY, ['a'], null);
  assert.equal(entry.policyValue, 'IncludeSites');
  assert.deepEqual(entry.ToBeAdded, ['a']);
});

test('legacy Disable* policy keeps canonical vocabulary (env-wide)', () => {
  const [entry] = buildPolicyPayload(LEGACY_POLICY, [], null);
  assert.equal(entry.policyValue, 'All');
});

test('legacy Disable* policy keeps canonical vocabulary (Include)', () => {
  const [entry] = buildPolicyPayload(LEGACY_POLICY, ['a', 'b'], 'Include');
  assert.equal(entry.policyValue, 'Include');
  assert.deepEqual(entry.ToBeAdded, ['a', 'b']);
});

test('legacy Disable* policy None passes through', () => {
  const [entry] = buildPolicyPayload(LEGACY_POLICY, [], 'None');
  assert.equal(entry.policyValue, 'None');
});

test('single portalId string is accepted (legacy call shape)', () => {
  const [entry] = buildPolicyPayload(ENV_LEVEL_POLICY, 'single-id', 'Include');
  assert.deepEqual(entry.ToBeAdded, ['single-id']);
  assert.equal(entry.policyValue, 'IncludeSites');
});
