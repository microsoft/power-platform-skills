const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const policies = require('../../skills/manage-governance/scripts/policies');
const mapping = require('../../skills/manage-governance/references/governance-mapping.json');

const {
  SUPPORTED_POLICIES,
  ENV_VALUE_ALIASES,
  isSupportedPolicy,
  normalizeEnvValue,
  classifyStatus,
} = policies;

const NEW_AUTH_ENABLE_POLICIES = [
  'EnableProtocolOpenIdConnect',
  'EnableProtocolSAML20',
  'EnableProtocolWsFederation',
  'EnableProtocolOpenAuth',
  'EnableIdpOAuthFacebook',
  'EnableIdpOAuthGoogle',
  'EnableIdpOAuthMicrosoft',
  'EnableAuthenticationLocalLogin',
  'EnableExternalAuthProviders',
];

test('SUPPORTED_POLICIES includes maker copilot and the nine auth Enable* policies', () => {
  assert.deepEqual([...SUPPORTED_POLICIES], [
    'EnableMakerCopilotForExistingSites',
    ...NEW_AUTH_ENABLE_POLICIES,
  ]);
});

test('SUPPORTED_POLICIES is frozen', () => {
  assert.equal(Object.isFrozen(SUPPORTED_POLICIES), true);
});

test('isSupportedPolicy recognizes EnableMakerCopilotForExistingSites', () => {
  assert.equal(isSupportedPolicy('EnableMakerCopilotForExistingSites'), true);
});

test('isSupportedPolicy recognizes each new auth Enable* policy and rejects mis-casing', () => {
  for (const name of NEW_AUTH_ENABLE_POLICIES) {
    assert.equal(isSupportedPolicy(name), true, `should support ${name}`);
    assert.equal(isSupportedPolicy(name.toLowerCase()), false, `should reject mis-cased ${name}`);
  }
});

test('isSupportedPolicy rejects unknown and mis-cased policy names', () => {
  assert.equal(isSupportedPolicy('EnableMakerCopilotForNewSites'), false);
  assert.equal(isSupportedPolicy('enablemakercopilotforexistingsites'), false);
  assert.equal(isSupportedPolicy(''), false);
  assert.equal(isSupportedPolicy(undefined), false);
});

test('normalizeEnvValue maps env-level applyTo vocabulary to canonical policyValue', () => {
  assert.equal(normalizeEnvValue('AllSites'), 'All');
  assert.equal(normalizeEnvValue('IncludedSites'), 'Include');
  assert.equal(normalizeEnvValue('AllSitesExceptExcluded'), 'Exclude');
  assert.equal(normalizeEnvValue('ExcludedSites'), 'Exclude');
});

test('normalizeEnvValue is case-insensitive on the alias key', () => {
  assert.equal(normalizeEnvValue('allsites'), 'All');
  assert.equal(normalizeEnvValue('ALLSITES'), 'All');
  assert.equal(normalizeEnvValue('  AllSites  '), 'All');
});

test('normalizeEnvValue passes canonical policyValues through unchanged', () => {
  for (const v of ['All', 'None', 'Include', 'Exclude']) {
    assert.equal(normalizeEnvValue(v), v);
  }
});

test('normalizeEnvValue passes unknown values through and preserves null/undefined', () => {
  assert.equal(normalizeEnvValue('SomethingElse'), 'SomethingElse');
  assert.equal(normalizeEnvValue(null), null);
  assert.equal(normalizeEnvValue(undefined), undefined);
});

test('ENV_VALUE_ALIASES stays consistent with mapping.readValueAliases', () => {
  // Every alias declared in the mapping JSON (except the identity None mapping)
  // must be honored by the code-side normalizer.
  for (const [raw, canonical] of Object.entries(mapping.readValueAliases)) {
    assert.equal(normalizeEnvValue(raw), canonical, `alias ${raw} -> ${canonical}`);
  }
  // And the code-side alias table keys should be lowercase for the lookup.
  for (const key of Object.keys(ENV_VALUE_ALIASES)) {
    assert.equal(key, key.toLowerCase());
  }
});

test('governance-mapping declares a policy entry for every supported policy', () => {
  const mapped = new Set(mapping.policies.map((p) => p.policyName));
  for (const name of SUPPORTED_POLICIES) {
    assert.equal(mapped.has(name), true, `mapping missing policy ${name}`);
  }
});

test('maker copilot mapping entry has the required render fields', () => {
  const maker = mapping.policies.find(
    (p) => p.policyName === 'EnableMakerCopilotForExistingSites'
  );
  assert.ok(maker, 'maker copilot policy entry present');
  assert.equal(maker.policyMode, 'uniformGovernance');
  assert.ok(maker.displayName);
  assert.ok(maker.subject);
  assert.ok(maker.summaryLabel);
  assert.ok(Array.isArray(maker.userShorthands) && maker.userShorthands.length > 0);
  assert.ok(maker.stateParaphrase.Enabled);
  assert.ok(maker.stateParaphrase.Disabled);
  assert.ok(maker.sideEffectCallout);
});

test('each new auth Enable* policy is configured like the reference EnableProtocolOpenIdConnect policy', () => {
  const oidc = mapping.policies.find(
    (p) => p.policyName === 'EnableProtocolOpenIdConnect'
  );
  assert.ok(oidc, 'reference OIDC protocol policy entry present');
  for (const name of NEW_AUTH_ENABLE_POLICIES) {
    const entry = mapping.policies.find((p) => p.policyName === name);
    assert.ok(entry, `mapping missing policy ${name}`);
    // Same uniformGovernance mode and full field set as the reference policy.
    assert.equal(entry.policyMode, oidc.policyMode, `${name} policyMode`);
    assert.ok(entry.displayName, `${name} displayName`);
    assert.ok(entry.subject, `${name} subject`);
    assert.ok(entry.summaryLabel, `${name} summaryLabel`);
    assert.ok(
      Array.isArray(entry.userShorthands) && entry.userShorthands.length > 0,
      `${name} userShorthands`
    );
    assert.ok(entry.stateParaphrase.Enabled, `${name} stateParaphrase.Enabled`);
    assert.ok(entry.stateParaphrase.Disabled, `${name} stateParaphrase.Disabled`);
    assert.ok(entry.sideEffectCallout, `${name} sideEffectCallout`);
    // These are Enable* auth policies: the sign-out side effect fires when the
    // auth path is turned OFF (disable = None / Exclude).
    assert.deepEqual(
      entry.sideEffectCallout.policyValueTriggers,
      ['None', 'Exclude'],
      `${name} sideEffect triggers`
    );
    assert.ok(
      entry.sideEffectCallout.message && entry.sideEffectCallout.message.length > 0,
      `${name} sideEffect message`
    );
  }
});

test('new auth Enable* policies use the canonical vocabulary (not the applyTo *Sites contract)', () => {
  // Only Maker Copilot carries the applyTo read-alias contract; the nine auth
  // Enable* policies must NOT be listed anywhere that would give them the
  // *Sites write vocab. There is no applyTo policy list in the mapping.
  assert.equal(mapping.applyToWriteVocab, undefined);
  // The nine policies resolve to the canonical policyValues via the uniform
  // intentToPolicyValue table (shared with every other policy).
  const values = mapping.intentToPolicyValue.map((r) => r.policyValue).sort();
  assert.deepEqual(values, ['All', 'Exclude', 'Include', 'None']);
});

test('classifyStatus unaffected by the new policy plumbing', () => {
  assert.equal(classifyStatus('Succeeded'), 'success');
  assert.equal(classifyStatus('Failed'), 'failure');
  assert.equal(classifyStatus('InProgress'), 'in-progress');
  assert.equal(classifyStatus(''), 'unknown');
});

test('policies module path resolves under manage-governance skill', () => {
  const resolved = require.resolve('../../skills/manage-governance/scripts/policies');
  assert.equal(resolved, path.resolve(
    __dirname,
    '../../skills/manage-governance/scripts/policies.js'
  ));
});
