const test = require('node:test');
const assert = require('node:assert/strict');

const {
  renderImpactSummary,
  normalizeState,
  newStateFor,
  scopeLine,
  cascadeLines,
  actionCell,
} = require('../../../skills/manage-governance/scripts/render-impact-summary');
const mapping = require('../../../skills/manage-governance/references/governance-mapping.json');

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
  assert.match(l[0], /^\*\*Action:\*\*\s+🔴 Disable OpenID Connect sign-in$/);
  assert.match(out, /^\*\*Environment:\*\*\s+Sachin-Jun-2nd\s+\(202c4f04-2eb7-eef3-a26d-14c77c8c13c5\)$/m);
  assert.match(out, /^\*\*Scope:\*\*\s+Every site in this environment$/m);
  assert.match(out, /^\*\*Sites in environment:\*\*$/m);
  assert.match(out, /^\*\*Effect:\*\*\s+OpenID Connect sign-in will be disabled on all sites in Sachin-Jun-2nd\.$/m);
  // The API-mapping companion line: env-wide disable -> None (no ToBeAdded list).
  assert.match(out, /^\*\*Policy value:\*\*\s+None$/m);
});

test('Policy value line derives Include + ToBeAdded ids for a specific-site enable', () => {
  const out = renderImpactSummary({
    policy: 'EnableProtocolOpenIdConnect',
    direction: 'enable',
    scope: 'specific',
    // policyValue intentionally omitted — must be derived (enable+specific -> Include).
    env: { displayName: 'Env', envId: 'e1' },
    sites: [
      { name: 'P3', url: 'https://c', portalId: 'aaa', currentState: 'Disabled' },
      { name: 'P4', url: 'https://d', portalId: 'bbb', currentState: 'Disabled' },
    ],
  });
  assert.match(out, /^\*\*Policy value:\*\*\s+Include, ToBeAdded = \[aaa, bbb\]$/m);
});

test('Policy value line uses the explicit req.policyValue when provided (Exclude for specific disable)', () => {
  const out = renderImpactSummary({
    policy: 'EnableProtocolOpenIdConnect',
    direction: 'disable',
    scope: 'specific',
    policyValue: 'Exclude',
    env: { displayName: 'Env', envId: 'e1' },
    sites: [{ name: 'P1', url: 'https://a', portalId: 'xyz', currentState: 'Enabled' }],
  });
  assert.match(out, /^\*\*Policy value:\*\*\s+Exclude, ToBeAdded = \[xyz\]$/m);
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
  // Exactly one known current state flips; Unknown is not asserted as changed.
  assert.equal((out.match(/CHANGED/g) || []).length, 1, 'exactly one row must be flagged CHANGED');
  assert.match(out, /←/, 'the changed marker uses the ← arrow');
  // All three sites must still appear in the table.
  for (const name of ['Site 1', 'Site 2', 'Site 3']) {
    assert.ok(out.includes(name), `${name} must appear in the Sites table`);
  }
});

test('the Sites table renders as a GitHub-flavored Markdown table with single-line rows', () => {
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
  // Markdown pipe table — a header row, a `---` delimiter row, then data rows.
  // We deliberately DROPPED the fixed-width Unicode box (it misaligned in chat
  // because the state emoji are double-width), so the box borders must be gone.
  assert.ok(!/[┌┬┐└┴┘├┼┤─│]/.test(out), 'must NOT render Unicode box-drawing characters');
  assert.match(
    out,
    /^\| Site Name \| URL \| Site ID \| Current State \| New State \|$/m,
    'Markdown header row present'
  );
  assert.match(out, /^\| --- \| --- \| --- \| --- \| --- \|$/m, 'Markdown delimiter row present');
  // The whole site row — including the double-width emoji and the ← CHANGED
  // marker — renders on ONE physical line as a single pipe row.
  assert.match(
    out,
    /^\| Portal_1 \| https:\/\/site-3axiv\.powerappsportals\.com \| d1df518c-8e39-4bd5-8410-eb1c0c28e56c \| 🟢 Enabled \| 🔴 Disabled ← CHANGED \|$/m,
    'the site row is a single Markdown line with every cell inline'
  );
});

test('Markdown table cells escape a literal pipe so columns never shift', () => {
  // A site name containing '|' must be backslash-escaped, otherwise it would be
  // read as an extra column separator and break the row's alignment.
  const out = renderImpactSummary({
    policy: 'EnableProtocolOpenIdConnect',
    direction: 'disable',
    scope: 'all',
    policyValue: 'None',
    env: { displayName: 'env', envId: 'e1' },
    sites: [{ name: 'A|B', url: 'https://x', portalId: 'p1', currentState: 'Enabled' }],
  });
  assert.match(out, /\| A\\\|B \|/, 'a literal pipe in a cell is escaped as \\|');
});

test('impact Markdown separates paragraphs, table, warning, and cascade without hard-wrapping cells', () => {
  const out = renderImpactSummary({
    policy: 'EnableExternalAuthProviders',
    direction: 'disable',
    scope: 'all',
    env: { displayName: 'Test environment', envId: 'test-env' },
    sites: [{
      name: 'Long|Site\r\nPreview',
      url: `https://${'long-site-'.repeat(8)}.example.com`,
      portalId: '11111111-2222-3333-4444-555555555555',
      currentState: 'Enabled',
    }],
  });
  const table = out.split('\n').filter((line) => line.startsWith('|'));
  assert.equal(table.length, 3, 'one header, separator, and complete data row');
  assert.match(table[2], /Long\\\|Site Preview/);
  assert.ok(table[2].includes('11111111-2222-3333-4444-555555555555'));
  assert.match(out, /\*\*Scope:\*\*[^\n]+\n\n\*\*Sites in environment:\*\*\n\n\|/);
  assert.match(out, /\| 🔴 Disabled ← CHANGED \|\n\n\*\*Effect:\*\*/);
  assert.match(out, /\n\n\*\*Policy value:\*\* None\n\n> \*\*Side effect:\*\*/);
  const heading = findPolicy('EnableExternalAuthProviders').cascadeOnDisable.heading;
  assert.ok(out.includes(`\n\n**${heading}**\n\n1. `), 'list needs separation from its heading');
  assert.equal(out.split('\n').filter((line) => /^\d+\. /.test(line)).length, 7);
  assert.ok(!out.includes('```'), 'render Markdown, not a code block');
  assert.ok(!out.includes('\u001b['), 'default Markdown must not include ANSI');
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
  assert.match(disabled, /^> \*\*Side effect:\*\*\s+Disabling this signs out/m);

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
  assert.match(out, /^\*\*Sites covered:\*\*$/m);
  assert.match(out, /^\*\*Scope:\*\*\s+Only Site 1, Site 2$/m);
  assert.match(out, /Effect:.*listed sites in env: Site 1, Site 2\.$/m);
});

test('never leaks the internal policyValue terms into the plain-language block', () => {
  const out = renderImpactSummary({
    policy: 'EnableProtocolOpenIdConnect',
    direction: 'enable',
    scope: 'all',
    policyValue: 'All',
    env: { displayName: 'env', envId: 'e1' },
    sites: [{ name: 'Site 1', currentState: 'Disabled' }],
  });
  // The dedicated `Policy value:` line intentionally shows the technical
  // All/None/Include/Exclude value the admin approves (the user explicitly asked
  // to see it). Everything ELSE — Action / Scope / Effect / Sites — is
  // plain-language and must never leak those internal terms. So scrub only the
  // Policy value line before scanning the rest.
  const plain = out
    .split('\n')
    .filter((line) => !/^\*\*Policy value:/.test(line))
    .join('\n');
  for (const term of ['All', 'Include', 'None', 'Exclude']) {
    assert.ok(
      !new RegExp('\\b' + term + '\\b').test(plain),
      `plain-language block must not leak internal term '${term}'`
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
  assert.ok(out.includes(`**${findPolicy('EnableExternalAuthProviders').cascadeOnDisable.heading}**`));
  const expected = [
    'Authentication Using OpenID Connect (OIDC) Protocol',
    'Authentication Using SAML 2.0 Protocol',
    'Authentication Using OAuth 2.0 Protocol',
    'Facebook Authentication',
    'Google Authentication',
    'Microsoft Authentication',
    'Authentication Using WS-Federation Protocol',
  ];
  expected.forEach((name, i) => {
    const row = out.split('\n').find((line) => line.startsWith(`${i + 1}. `));
    assert.equal(row, `${i + 1}. ${name} — 🔴 Disabled`);
  });
  assert.ok(!out.includes('undefined'));
  // The cascade block appears after the Side effect line, not before the table.
  assert.ok(out.indexOf(findPolicy('EnableExternalAuthProviders').cascadeOnDisable.heading) > out.indexOf('Side effect:'));
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
  assert.ok(out.includes(findPolicy('EnableProtocolOpenAuth').cascadeOnDisable.heading));
  assert.match(out, /^1\. Facebook — 🔴 Disabled$/m);
  assert.match(out, /^2\. Google — 🔴 Disabled$/m);
  assert.match(out, /^3\. Microsoft — 🔴 Disabled$/m);
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
  assert.ok(!out.includes(findPolicy('EnableProtocolOpenAuth').cascadeOnDisable.heading), 'enable must not show the disable cascade');
  // It surfaces the informational availability list instead.
  assert.match(out, /must also be enabled individually through its corresponding governance setting/);
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
  assert.ok(!/sign-in methods will be disabled/.test(out), 'leaf policy must not show a cascade');
});

test('cascadeLines helper is direction-gated and data-driven from the mapping', () => {
  const parent = findPolicy('EnableExternalAuthProviders');
  const leaf = findPolicy('EnableIdpOAuthGoogle');
  // disable + has cascade -> heading + one line per item.
  const disableLines = cascadeLines(parent, 'disable', { enabled: false });
  assert.equal(disableLines[0], ''); // leading blank line separates from the summary
  assert.equal(disableLines[1], `**${parent.cascadeOnDisable.heading}**`);
  assert.equal(disableLines[2], '');
  assert.equal(disableLines.length, 3 + 7);
  // enable + has cascade -> heading + one line per item + blank + footer note.
  const enableLines = cascadeLines(parent, 'enable', { enabled: false });
  assert.equal(enableLines[0], '');
  assert.equal(enableLines[1], `**${parent.cascadeOnEnable.heading}**`);
  assert.equal(
    enableLines.length,
    3 + 7 + 2, // heading separators, seven expanded entries, and footer
  );
  assert.match(enableLines[enableLines.length - 1], /^\*\*Note:\*\* Enabling the External Authentication policy/);
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
  assert.ok(out.includes(findPolicy('EnableExternalAuthProviders').cascadeOnEnable.heading));
  const rows = out.split('\n').filter((line) => /^\d+\./.test(line));
  assert.deepEqual(rows, [
    '1. Authentication Using OpenID Connect (OIDC) Protocol',
    '2. Authentication Using SAML 2.0 Protocol',
    '3. Authentication Using OAuth 2.0 Protocol',
    '4. Facebook Authentication',
    '5. Google Authentication',
    '6. Microsoft Authentication',
    '7. Authentication Using WS-Federation Protocol',
  ]);
  assert.ok(!out.includes('undefined'));
  assert.ok(!rows.some((line) => /Enabled|Disabled/.test(line)), 'availability does not force-enable children');
  // Footer note about per-provider configuration.
  assert.match(out, /^\*\*Note:\*\* Enabling the External Authentication policy restores support/m);
  // Enable path must never render the disable heading.
  assert.ok(!out.includes(findPolicy('EnableExternalAuthProviders').cascadeOnDisable.heading));
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
  assert.match(out, /must also be enabled individually through its corresponding governance setting/);
  assert.match(out, /^1\. Facebook — Controlled by the Facebook governance setting\.$/m);
  assert.match(out, /^2\. Google — Controlled by the Google governance setting\.$/m);
  assert.match(out, /^3\. Microsoft — Controlled by the Microsoft governance setting\.$/m);
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
  assert.match(out, /^1\. Facebook — 🔴 Disabled$/m);
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
  assert.equal(lines[1], '**Now enabled:**');
  assert.equal(lines[2], '');
  assert.match(lines[3], /^1\. OAuth 2\.0 — 🟢 Enabled$/);
});

test('cascadeLines preserves notes and states in recursively grouped entries', () => {
  const policy = {
    cascadeOnEnable: {
      items: [{ Protocol: [{ Providers: [{ label: 'Provider', state: 'Enabled', note: 'Configured.' }] }] }],
    },
  };
  const rows = cascadeLines(policy, 'enable', { enabled: false }).slice(3);
  assert.deepEqual(rows, [
    '1. Protocol',
    '2. Providers',
    '3. Provider — 🟢 Enabled - Configured.',
  ]);
});

test('cascadeLines rejects malformed entries instead of rendering undefined or omitting impact', () => {
  for (const item of [null, '', {}, { note: 'Missing label' }, { Protocol: 'not an array' }]) {
    assert.throws(
      () => cascadeLines({ cascadeOnDisable: { items: [item] } }, 'disable', { enabled: false }),
      /invalid cascade item/,
    );
  }
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
  assert.match(disableOut, /^\*\*Action:\*\*\s+🔴 Disable OAuth 2\.0 sign-in$/m);

  const enableOut = renderImpactSummary({
    policy: 'EnableProtocolOpenAuth',
    direction: 'enable',
    scope: 'all',
    policyValue: 'All',
    env: { displayName: 'env', envId: 'e1' },
    sites: [{ name: 'Site 1', currentState: 'Disabled' }],
  });
  assert.match(enableOut, /^\*\*Action:\*\*\s+🟢 Enable OAuth 2\.0 sign-in$/m);

  // Unit-level: actionCell adds ANSI red/green when color is forced on.
  const redAnsi = actionCell('disable', 'Disable X', { enabled: true });
  assert.ok(redAnsi.includes('\u001b[31m') && redAnsi.includes('🔴'));
  const greenAnsi = actionCell('enable', 'Enable X', { enabled: true });
  assert.ok(greenAnsi.includes('\u001b[32m') && greenAnsi.includes('🟢'));
});
