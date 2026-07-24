const test = require('node:test');
const assert = require('node:assert/strict');

const {
  renderImpactSummary,
  normalizeState,
  newStateFor,
  scopeLine,
  sideEffectLine,
} = require('../../skills/manage-governance/scripts/render-impact-summary');
const mapping = require('../../skills/manage-governance/references/governance-mapping.json');

function findPolicy(name) {
  return mapping.policies.find((p) => p.policyName === name);
}

test('renderImpactSummary emits the required consent-gate rows in order', () => {
  const out = renderImpactSummary({
    policy: 'EnableProtocolOpenIdConnect',
    direction: 'disable',
    scope: 'all',
    policyValue: 'None',
    env: { displayName: 'Sachin-Jun-2nd', envId: '202c4f04-2eb7-eef3-a26d-14c77c8c13c5' },
    sites: [
      { name: 'Site 1', url: 'https://a', portalId: '3e13', currentState: 'Enabled' },
      { name: 'Site 2', url: 'https://b', portalId: 'ea51', currentState: 'Enabled' },
    ],
  });
  const l = out.split('\n');
  // Must start at Action: with no lead-in (SKILL.md forbids any heading first).
  assert.match(l[0], /^Action:\s+Disable OpenID Connect sign-in$/);
  assert.match(out, /^Environment:\s+Sachin-Jun-2nd\s+\(202c4f04-2eb7-eef3-a26d-14c77c8c13c5\)$/m);
  assert.match(out, /^Scope:\s+Every site in this environment$/m);
  assert.match(out, /^Sites in env:$/m);
  assert.match(out, /^Effect:\s+OpenID Connect sign-in will be disabled on all portals in Sachin-Jun-2nd\.$/m);
});

test('flips are marked <- CHANGED, already-terminal sites are not', () => {
  const out = renderImpactSummary({
    policy: 'EnableProtocolOpenIdConnect',
    direction: 'disable',
    scope: 'all',
    env: { displayName: 'env', envId: 'e1' },
    sites: [
      { name: 'Site 1', currentState: 'Enabled' }, // Enabled -> Disabled = changed
      { name: 'Site 2', currentState: 'Disabled' }, // already Disabled = no change
      { name: 'Site 3', currentState: 'garbage' }, // Unknown = never flagged
    ],
  });
  const rows = out.split('\n').filter((r) => r.includes('Site '));
  assert.match(rows[0], /Site 1 .*<- CHANGED/);
  assert.ok(!/<- CHANGED/.test(rows[1]), 'already-disabled site must not be flagged');
  assert.ok(!/<- CHANGED/.test(rows[2]), 'unknown-state site must not be flagged');
});

test('Side effect line only renders when policyValue is a per-policy trigger', () => {
  // Enable* toggles trigger the sign-out callout on None/Exclude (disable).
  const disabled = renderImpactSummary({
    policy: 'EnableIdpOAuthFacebook',
    direction: 'disable',
    scope: 'all',
    policyValue: 'None',
    env: { displayName: 'env', envId: 'e1' },
    sites: [{ name: 'Site 1', currentState: 'Enabled' }],
  });
  assert.match(disabled, /^Side effect:\s+Disabling this signs out/m);

  // Enabling (All) must NOT surface the sign-out warning.
  const enabled = renderImpactSummary({
    policy: 'EnableIdpOAuthFacebook',
    direction: 'enable',
    scope: 'all',
    policyValue: 'All',
    env: { displayName: 'env', envId: 'e1' },
    sites: [{ name: 'Site 1', currentState: 'Disabled' }],
  });
  assert.ok(!/Side effect:/.test(enabled), 'enable must not show a sign-out side effect');
});

test('legacy Disable* block rule triggers side effect on All/Include (turning the block on)', () => {
  const p = findPolicy('PowerPages_DisableAuthenticationOpenIdConnect');
  assert.deepEqual(p.sideEffectCallout.policyValueTriggers, ['All', 'Include']);
  const line = sideEffectLine(p, 'All');
  assert.ok(line && /sign(s|ed) out/i.test(line));
  assert.equal(sideEffectLine(p, 'None'), null);
});

test('specific scope renders the Sites covered label and lists names in the Effect line', () => {
  const out = renderImpactSummary({
    policy: 'EnableProtocolSAML20',
    direction: 'enable',
    scope: 'specific',
    policyValue: 'Include',
    env: { displayName: 'env', envId: 'e1' },
    sites: [
      { name: 'Site 1', currentState: 'Disabled' },
      { name: 'Site 2', currentState: 'Disabled' },
    ],
  });
  assert.match(out, /^Sites covered:$/m);
  assert.match(out, /^Scope:\s+Only Site 1, Site 2$/m);
  assert.match(out, /Effect:.*listed portals in env: Site 1, Site 2\.$/m);
});

test('never leaks the internal policyValue terms to the user-facing block', () => {
  const out = renderImpactSummary({
    policy: 'EnableProtocolOpenIdConnect',
    direction: 'enable',
    scope: 'all',
    policyValue: 'All',
    env: { displayName: 'env', envId: 'e1' },
    sites: [{ name: 'Site 1', currentState: 'Disabled' }],
  });
  for (const term of ['All', 'Include', 'None', 'Exclude']) {
    assert.ok(
      !new RegExp('\\b' + term + '\\b').test(out),
      `consent block must not leak internal term '${term}'`
    );
  }
});

test('unknown policy throws (guards against a bad caller)', () => {
  assert.throws(
    () => renderImpactSummary({ policy: 'NotAPolicy', direction: 'enable', env: {} }),
    /unknown policy/
  );
});

test('normalizeState maps live-read variants, falling back to Unknown', () => {
  assert.equal(normalizeState('Enabled'), 'Enabled');
  assert.equal(normalizeState('disabled'), 'Disabled');
  assert.equal(normalizeState('blocked'), 'Disabled');
  assert.equal(normalizeState(''), 'Unknown');
  assert.equal(normalizeState(null), 'Unknown');
  assert.equal(normalizeState('None'), 'Unknown');
});

test('newStateFor / scopeLine helpers behave per direction and scope', () => {
  assert.equal(newStateFor('disable'), 'Disabled');
  assert.equal(newStateFor('enable'), 'Enabled');
  assert.equal(scopeLine('all', ['Site 1']), 'Every site in this environment');
  assert.equal(scopeLine('specific', ['Site 1', 'Site 2']), 'Only Site 1, Site 2');
});
