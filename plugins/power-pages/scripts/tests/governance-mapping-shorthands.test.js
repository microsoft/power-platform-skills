const test = require('node:test');
const assert = require('node:assert/strict');

const mapping = require('../../skills/manage-governance/references/governance-mapping.json');

// Build a shorthand -> policyName index from the committed mapping data. This is
// exactly what the orchestrator relies on when resolving a user's phrasing to a
// policy, so asserting against it proves the DATA (not just parser logic) covers
// the abbreviations/synonyms used across the 270 governance test cases.
function shorthandIndex() {
  const idx = new Map();
  for (const p of mapping.policies) {
    for (const s of p.userShorthands || []) {
      idx.set(String(s).toLowerCase(), p.policyName);
    }
  }
  return idx;
}

// Abbreviations/synonyms that appear in PowerPages_Policy_TestCases_270.csv and
// were previously missing from userShorthands (fb, gmail, msa, external idps,
// third-party providers, oauth2, ws-fed, password login). Each MUST resolve to
// its expected policy for the skill to handle those rows without asking.
const REQUIRED_SHORTHANDS = {
  fb: 'EnableIdpOAuthFacebook',
  gmail: 'EnableIdpOAuthGoogle',
  msa: 'EnableIdpOAuthMicrosoft',
  oauth2: 'EnableProtocolOpenAuth',
  'oauth 2.0': 'EnableProtocolOpenAuth',
  'ws-fed': 'EnableProtocolWsFederation',
  'password login': 'EnableAuthenticationLocalLogin',
  'external idps': 'EnableExternalAuthProviders',
  'external idp': 'EnableExternalAuthProviders',
  'third-party identity providers': 'EnableExternalAuthProviders',
  'third-party providers': 'EnableExternalAuthProviders',
};

test('every 270-case synonym resolves to the expected policy via userShorthands', () => {
  const idx = shorthandIndex();
  for (const [phrase, expected] of Object.entries(REQUIRED_SHORTHANDS)) {
    assert.equal(
      idx.get(phrase),
      expected,
      `shorthand "${phrase}" should map to ${expected} but mapped to ${idx.get(phrase)}`
    );
  }
});

test('additive edit preserved every original committed shorthand', () => {
  // Guard the additive-only constraint: the pre-existing shorthands must still
  // be present (we only appended, never removed/restructured).
  const idx = shorthandIndex();
  const ORIGINAL = {
    facebook: 'EnableIdpOAuthFacebook',
    google: 'EnableIdpOAuthGoogle',
    microsoft: 'EnableIdpOAuthMicrosoft',
    'oauth 2.0 protocol': 'EnableProtocolOpenAuth',
    wsfed: 'EnableProtocolWsFederation',
    'username and password': 'EnableAuthenticationLocalLogin',
    'external identity providers': 'EnableExternalAuthProviders',
  };
  for (const [phrase, expected] of Object.entries(ORIGINAL)) {
    assert.equal(idx.get(phrase), expected, `original shorthand "${phrase}" must remain`);
  }
});

test('mapping still exposes all 12 policies and its committed top-level keys', () => {
  assert.equal(mapping.policies.length, 12);
  for (const key of [
    'policyModes',
    'policies',
    'intentToPolicyValue',
    'ambiguousPhrasings',
    'effectLineTemplates',
    'scopePicker',
    'consentGate',
    'uiConstants',
  ]) {
    assert.ok(key in mapping, `committed top-level key '${key}' must be present`);
  }
});
