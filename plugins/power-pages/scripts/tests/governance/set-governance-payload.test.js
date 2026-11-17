const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPolicyPayload } = require('../../../skills/manage-governance/scripts/set-governance');

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

for (const scope of ['Include', 'Exclude']) {
  test(`removal-only ${scope} edit preserves the mode and sends only the removal delta`, () => {
    assert.deepEqual(buildPolicyPayload(ENV_LEVEL_POLICY, [], scope, ['old-a', 'old-b']), [{
      policyName: ENV_LEVEL_POLICY,
      policyValue: scope,
      ToBeAdded: [],
      ToBeRemoved: ['old-a', 'old-b'],
    }]);
  });

  test(`${scope} edit keeps independent addition and removal deltas without mutating input arrays`, () => {
    const additions = Object.freeze(['new-a', '', null, 'new-b']);
    const removals = Object.freeze(['old-a', null, '', 'old-b']);
    assert.deepEqual(buildPolicyPayload(ENV_LEVEL_POLICY, additions, scope, removals), [{
      policyName: ENV_LEVEL_POLICY,
      policyValue: scope,
      ToBeAdded: ['new-a', 'new-b'],
      ToBeRemoved: ['old-a', 'old-b'],
    }]);
    assert.deepEqual(additions, ['new-a', '', null, 'new-b']);
    assert.deepEqual(removals, ['old-a', null, '', 'old-b']);
  });
}

test('removals alone default to Include rather than accidentally applying to All sites', () => {
  assert.deepEqual(buildPolicyPayload(ENV_LEVEL_POLICY, null, null, ['old-site']), [{
    policyName: ENV_LEVEL_POLICY,
    policyValue: 'Include',
    ToBeAdded: [],
    ToBeRemoved: ['old-site'],
  }]);
});

test('a single removal ID is accepted without being split into characters', () => {
  assert.deepEqual(buildPolicyPayload(ENV_LEVEL_POLICY, '', 'Exclude', 'old-site'), [{
    policyName: ENV_LEVEL_POLICY,
    policyValue: 'Exclude',
    ToBeAdded: [],
    ToBeRemoved: ['old-site'],
  }]);
});

test('omitted, empty, and filtered-empty removals preserve the env-wide default', () => {
  for (const removals of [undefined, null, '', [], ['', null]]) {
    assert.deepEqual(buildPolicyPayload(ENV_LEVEL_POLICY, [], null, removals), [{
      policyName: ENV_LEVEL_POLICY,
      policyValue: 'All',
      ToBeAdded: [],
      ToBeRemoved: [],
    }]);
  }
});
