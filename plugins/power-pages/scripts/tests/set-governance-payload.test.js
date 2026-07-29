const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPolicyPayload } = require('../../skills/manage-governance/scripts/set-governance');

// buildPolicyPayload is the single seam where a canonical policyValue
// (All / None / Include / Exclude) is forward-mapped to the value that
// actually goes on the wire. As of the 2026-07 A059 gateway shift the wire
// vocabulary is the SHORT canonical form itself (All / Include / Exclude /
// None) — the older applyTo `*Sites` enums ("AllSites" etc.) are now rejected
// with HTTP 400 A059. So the forward-map is an identity map and each of these
// tests asserts the short form goes on the wire verbatim.

const ENV_LEVEL_POLICY = 'EnableMakerCopilotForExistingSites';

test('env-level policy env-wide enable posts short canonical "All"', () => {
  const [entry] = buildPolicyPayload(ENV_LEVEL_POLICY, [], null);
  assert.equal(entry.policyName, ENV_LEVEL_POLICY);
  assert.equal(entry.policyValue, 'All');
  assert.deepEqual(entry.ToBeAdded, []);
  assert.deepEqual(entry.ToBeRemoved, []);
});

test('env-level policy env-wide disable posts "None"', () => {
  const [entry] = buildPolicyPayload(ENV_LEVEL_POLICY, [], 'None');
  assert.equal(entry.policyValue, 'None');
  assert.deepEqual(entry.ToBeAdded, []);
});

test('env-level policy Include posts short canonical "Include" with ids', () => {
  const [entry] = buildPolicyPayload(ENV_LEVEL_POLICY, ['a', 'b'], 'Include');
  assert.equal(entry.policyValue, 'Include');
  assert.deepEqual(entry.ToBeAdded, ['a', 'b']);
});

test('env-level policy Exclude posts short canonical "Exclude"', () => {
  const [entry] = buildPolicyPayload(ENV_LEVEL_POLICY, ['a'], 'Exclude');
  assert.equal(entry.policyValue, 'Exclude');
  assert.deepEqual(entry.ToBeAdded, ['a']);
});

test('env-level policy defaults to Include enum when portalIds given and no override', () => {
  const [entry] = buildPolicyPayload(ENV_LEVEL_POLICY, ['a'], null);
  assert.equal(entry.policyValue, 'Include');
  assert.deepEqual(entry.ToBeAdded, ['a']);
});

test('single portalId string is accepted (legacy call shape)', () => {
  const [entry] = buildPolicyPayload(ENV_LEVEL_POLICY, 'single-id', 'Include');
  assert.deepEqual(entry.ToBeAdded, ['single-id']);
  assert.equal(entry.policyValue, 'Include');
});
