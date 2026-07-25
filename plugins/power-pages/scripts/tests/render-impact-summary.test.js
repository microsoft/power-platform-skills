const test = require('node:test');
const assert = require('node:assert/strict');

const {
  renderImpactSummary,
  normalizeState,
  newStateFor,
  scopeLine,
  cascadeLines,
  actionCell,
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
  // The Action row is direction-colored: red 🔴 for a disable operation.
  assert.match(l[0], /^Action:\s+🔴 Disable OpenID Connect sign-in$/);
  assert.match(out, /^Environment:\s+Sachin-Jun-2nd\s+\(202c4f04-2eb7-eef3-a26d-14c77c8c13c5\)$/m);
  assert.match(out, /^Scope:\s+Every site in this environment$/m);
  assert.match(out, /^Sites in env:$/m);
  assert.match(out, /^Effect:\s+OpenID Connect sign-in will be disabled on all portals in Sachin-Jun-2nd\.$/m);
});

test('flips are marked ← CHANGED, already-terminal sites are not', () => {
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
  // The Sites table is a wrapped Unicode box, so the "← CHANGED" marker can land
  // on a cell's 2nd physical line — assert on the COUNT of changed rows instead
  // of a single-line "<name> ... CHANGED" regex. Exactly one site flips here.
  assert.equal((out.match(/CHANGED/g) || []).length, 1, 'exactly one row must be flagged CHANGED');
  assert.match(out, /←/, 'the changed marker uses the ← arrow');
  // All three sites must still appear as rows in the box.
  for (const name of ['Site 1', 'Site 2', 'Site 3']) {
    assert.ok(out.includes(name), `${name} must appear in the Sites box`);
  }
});

test('the Sites table renders as a bordered Unicode box with wrapped headers', () => {
  const out = renderImpactSummary({
    policy: 'EnableProtocolOpenIdConnect',
    direction: 'disable',
    scope: 'all',
    policyValue: 'None',
    env: { displayName: 'env', envId: 'e1' },
    sites: [
      {
        name: 'Portal_1',
        url: 'https://site-3axiv.powerappsportals.com',
        portalId: 'd1df518c-8e39-4bd5-8410-eb1c0c28e56c',
        currentState: 'Enabled',
      },
    ],
  });
  // Unicode box borders (not the old Markdown pipe table).
  assert.match(out, /┌─+┬─+┬─+┬─+┬─+┐/, 'top border present');
  assert.match(out, /└─+┴─+┴─+┴─+┴─+┘/, 'bottom border present');
  assert.ok(!/\|-+\|/.test(out), 'must not fall back to a Markdown divider row');
  // Narrow columns wrap their headers across two physical lines.
  assert.match(out, /│ Portal +│/, 'Portal Name header wraps to "Portal"');
  assert.match(out, /│ Name +│/, '…and "Name" on the next line');
  assert.match(out, /Current +│/, 'Current State header wraps to "Current"');
  assert.match(out, /State +│/, '…and "State" on the next line');
  // The changed marker wraps onto the New State cell's 2nd line.
  assert.match(out, /🔴 Disabled ←/, 'New State cell carries the ← marker');
  assert.match(out, /│ CHANGED +│/, 'CHANGED wraps to the next line of the cell');
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

test('disabling External Auth Providers lists every downstream sign-in method it turns off', () => {
  const out = renderImpactSummary({
    policy: 'EnableExternalAuthProviders',
    direction: 'disable',
    scope: 'all',
    policyValue: 'None',
    env: { displayName: 'env', envId: 'e1' },
    sites: [{ name: 'Site 1', currentState: 'Enabled' }],
  });
  // Heading + all 7 downstream methods, numbered, each marked Disabled.
  assert.match(out, /^Below Setting will get Disable$/m);
  const expected = [
    'OpenIdConnect',
    'SAML2.0',
    'OAuth2.0',
    'WS_Federation',
    'Facebook',
    'Google',
    'Microsoft',
  ];
  expected.forEach((name, i) => {
    // e.g. "1. OpenIdConnect  🔴 Disabled" (label is space-padded for alignment;
    // the 🔴 emoji carries the red cue on ANSI-stripping chat surfaces).
    assert.match(out, new RegExp(`^${i + 1}\\. ${name}\\s+🔴 Disabled$`, 'm'));
  });
  // The cascade block appears after the Side effect line, not before the table.
  assert.ok(out.indexOf('Below Setting will get Disable') > out.indexOf('Side effect:'));
});

test('disabling the OAuth 2.0 protocol lists only the OAuth-based social IdPs', () => {
  const out = renderImpactSummary({
    policy: 'EnableProtocolOpenAuth',
    direction: 'disable',
    scope: 'all',
    policyValue: 'None',
    env: { displayName: 'env', envId: 'e1' },
    sites: [{ name: 'Site 1', currentState: 'Enabled' }],
  });
  assert.match(out, /^The following OAuth 2\.0 identity providers will be disabled:$/m);
  assert.match(out, /^1\. Facebook\s+🔴 Disabled$/m);
  assert.match(out, /^2\. Google\s+🔴 Disabled$/m);
  assert.match(out, /^3\. Microsoft\s+🔴 Disabled$/m);
  // OAuth's cascade is the social IdPs only — it must NOT list the protocols.
  assert.ok(!/OpenIdConnect/.test(out), 'OAuth cascade must not list OpenIdConnect');
  assert.ok(!/WS_Federation/.test(out), 'OAuth cascade must not list WS_Federation');
});

test('enabling a parent shows the availability cascade, not the disable checklist', () => {
  const out = renderImpactSummary({
    policy: 'EnableProtocolOpenAuth',
    direction: 'enable',
    scope: 'all',
    policyValue: 'All',
    env: { displayName: 'env', envId: 'e1' },
    sites: [{ name: 'Site 1', currentState: 'Disabled' }],
  });
  // Enable must never claim the children "will get Disable" (they keep their state).
  assert.ok(!/Below Setting will get Disable/.test(out), 'enable must not show the disable cascade');
  // It surfaces the informational availability list instead.
  assert.match(out, /does not automatically enable individual identity providers/);
});

test('policies without a cascade dependency render no cascade block', () => {
  // Facebook is a leaf provider — disabling it has no downstream cascade.
  const out = renderImpactSummary({
    policy: 'EnableIdpOAuthFacebook',
    direction: 'disable',
    scope: 'all',
    policyValue: 'None',
    env: { displayName: 'env', envId: 'e1' },
    sites: [{ name: 'Site 1', currentState: 'Enabled' }],
  });
  assert.ok(!/Below Setting will get Disable/.test(out), 'leaf policy must not show a cascade');
});

test('cascadeLines helper is direction-gated and data-driven from the mapping', () => {
  const parent = findPolicy('EnableExternalAuthProviders');
  const leaf = findPolicy('EnableIdpOAuthGoogle');
  // disable + has cascade -> heading + one line per item.
  const disableLines = cascadeLines(parent, 'disable', { enabled: false });
  assert.equal(disableLines[0], ''); // leading blank line separates from the summary
  assert.equal(disableLines[1], 'Below Setting will get Disable');
  assert.equal(disableLines.length, 2 + parent.cascadeOnDisable.items.length);
  // enable + has cascade -> heading + one line per item + blank + footer note.
  const enableLines = cascadeLines(parent, 'enable', { enabled: false });
  assert.equal(enableLines[0], '');
  assert.equal(enableLines[1], parent.cascadeOnEnable.heading);
  assert.equal(
    enableLines.length,
    2 + parent.cascadeOnEnable.items.length + 2, // + blank + "Note:" footer
  );
  assert.match(enableLines[enableLines.length - 1], /^Note: Enabling the External Authentication policy/);
  // leaf policy -> no cascade in either direction.
  assert.deepEqual(cascadeLines(leaf, 'disable', { enabled: false }), []);
  assert.deepEqual(cascadeLines(leaf, 'enable', { enabled: false }), []);
});

test('enabling External Auth Providers lists the methods that become available + config note', () => {
  const out = renderImpactSummary({
    policy: 'EnableExternalAuthProviders',
    direction: 'enable',
    scope: 'all',
    policyValue: 'All',
    env: { displayName: 'env', envId: 'e1' },
    sites: [{ name: 'Site 1', currentState: 'Disabled' }],
  });
  assert.match(out, /^When enabled, the following authentication methods become available/m);
  // Protocol rows are label-only (no "Controlled by" note).
  assert.match(out, /^1\. OpenID Connect$/m);
  assert.match(out, /^2\. SAML 2\.0$/m);
  assert.match(out, /^3\. OAuth 2\.0$/m);
  assert.match(out, /^4\. WS-Federation$/m);
  // Social-provider rows carry the per-provider config annotation.
  assert.match(out, /^5\. Facebook\s+- Controlled by the Facebook setting\.$/m);
  assert.match(out, /^6\. Google\s+- Controlled by the Google setting\.$/m);
  assert.match(out, /^7\. Microsoft\s+- Controlled by the Microsoft setting\.$/m);
  // Footer note about per-provider configuration.
  assert.match(out, /^Note: Enabling the External Authentication policy restores support/m);
  // Enable path must never render the disable heading.
  assert.ok(!/Below Setting will get Disable/.test(out));
});

test('enabling the OAuth 2.0 protocol lists the social IdPs it does NOT auto-enable', () => {
  const out = renderImpactSummary({
    policy: 'EnableProtocolOpenAuth',
    direction: 'enable',
    scope: 'all',
    policyValue: 'All',
    env: { displayName: 'env', envId: 'e1' },
    sites: [{ name: 'Site 1', currentState: 'Disabled' }],
  });
  assert.match(out, /does not automatically enable individual identity providers/);
  assert.match(out, /^1\. Facebook\s+- Controlled by the Facebook setting\.$/m);
  assert.match(out, /^2\. Google\s+- Controlled by the Google setting\.$/m);
  assert.match(out, /^3\. Microsoft\s+- Controlled by the Microsoft setting\.$/m);
  // OAuth enable is IdP-only — no protocol rows, and no numbered disable-cascade
  // row (the Sites table legitimately shows a 🔴 Disabled current-state cell, so
  // scope the check to numbered cascade rows only).
  assert.ok(!/OpenID Connect/.test(out));
  assert.ok(!/^\d+\..*🔴 Disabled$/m.test(out));
});

test('cascade note text does not use the abbreviation "IDP"', () => {
  // The admin asked to drop "IDP" from the per-provider notes.
  for (const name of ['EnableExternalAuthProviders', 'EnableProtocolOpenAuth']) {
    const out = renderImpactSummary({
      policy: name,
      direction: 'enable',
      scope: 'all',
      policyValue: 'All',
      env: { displayName: 'env', envId: 'e1' },
      sites: [{ name: 'Site 1', currentState: 'Disabled' }],
    });
    assert.ok(!/\bIDP\b/.test(out), `${name} enable cascade must not contain "IDP"`);
  }
});

test('disable-cascade rows render the red state marker (🔴) for chat visibility', () => {
  // The 🔴 emoji is what makes the "red for Disable" cue visible where ANSI is
  // stripped; assert it is present on each disable-cascade row.
  const out = renderImpactSummary({
    policy: 'EnableProtocolOpenAuth',
    direction: 'disable',
    scope: 'all',
    policyValue: 'None',
    env: { displayName: 'env', envId: 'e1' },
    sites: [{ name: 'Site 1', currentState: 'Enabled' }],
  });
  assert.match(out, /^1\. Facebook\s+🔴 Disabled$/m);
});

test('cascadeLines renders a green 🟢 Enabled marker for enable items that declare a state', () => {
  // Mirror of the disable side: an enable item with { state: 'Enabled' } gets the
  // green "🟢 Enabled" marker, honoring "green for enable". Color is disabled so we
  // assert the emoji/label only (ANSI would otherwise wrap the span in a terminal).
  const policy = {
    cascadeOnEnable: {
      heading: 'Now enabled:',
      items: [{ label: 'OAuth 2.0', state: 'Enabled' }],
    },
  };
  const lines = cascadeLines(policy, 'enable', { enabled: false });
  assert.equal(lines[1], 'Now enabled:');
  assert.match(lines[2], /^1\. OAuth 2\.0\s+🟢 Enabled$/);
});

test('the Action line is colored by direction (red 🔴 disable / green 🟢 enable)', () => {
  // The Action row must reflect the same green=enable / red=disable cue as the
  // state cells; the emoji is the chat-visible carrier where ANSI is stripped.
  const disableOut = renderImpactSummary({
    policy: 'EnableProtocolOpenAuth',
    direction: 'disable',
    scope: 'all',
    policyValue: 'None',
    env: { displayName: 'env', envId: 'e1' },
    sites: [{ name: 'Site 1', currentState: 'Enabled' }],
  });
  assert.match(disableOut, /^Action:\s+🔴 Disable OAuth 2\.0 sign-in$/m);

  const enableOut = renderImpactSummary({
    policy: 'EnableProtocolOpenAuth',
    direction: 'enable',
    scope: 'all',
    policyValue: 'All',
    env: { displayName: 'env', envId: 'e1' },
    sites: [{ name: 'Site 1', currentState: 'Disabled' }],
  });
  assert.match(enableOut, /^Action:\s+🟢 Enable OAuth 2\.0 sign-in$/m);

  // Unit-level: actionCell adds ANSI red/green when color is forced on.
  const redAnsi = actionCell('disable', 'Disable X', { enabled: true });
  assert.ok(redAnsi.includes('\u001b[31m') && redAnsi.includes('🔴'));
  const greenAnsi = actionCell('enable', 'Enable X', { enabled: true });
  assert.ok(greenAnsi.includes('\u001b[32m') && greenAnsi.includes('🟢'));
});
