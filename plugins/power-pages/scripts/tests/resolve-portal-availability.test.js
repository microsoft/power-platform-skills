const test = require('node:test');
const assert = require('node:assert/strict');

const {
  dependenciesForPolicy,
  canonicalizeEnvValue,
  computeSiteState,
  extractLists,
  resolvePortalStates,
  computeAvailability,
  renderAvailabilityMarkdown,
  renderAvailablePortalsMarkdown,
} = require('../../skills/manage-governance/scripts/resolve-portal-availability');
const mapping = require('../../skills/manage-governance/references/governance-mapping.json');

// --- Mapping data invariants: the parent/child tree is the requirement ------

test('mapping declares the External-Auth -> protocols -> OAuth -> social-IdP tree', () => {
  const deps = mapping.policyAvailabilityDependencies;
  assert.ok(deps, 'policyAvailabilityDependencies block must exist');
  assert.deepEqual(deps.parents.EnableExternalAuthProviders, [
    'EnableProtocolOpenIdConnect',
    'EnableProtocolSAML20',
    'EnableProtocolWsFederation',
    'EnableProtocolOpenAuth',
  ]);
  assert.deepEqual(deps.parents.EnableProtocolOpenAuth, [
    'EnableIdpOAuthFacebook',
    'EnableIdpOAuthGoogle',
    'EnableIdpOAuthMicrosoft',
  ]);
});

test('each protocol child depends on External Auth only', () => {
  for (const child of [
    'EnableProtocolOpenIdConnect',
    'EnableProtocolSAML20',
    'EnableProtocolWsFederation',
    'EnableProtocolOpenAuth',
  ]) {
    assert.deepEqual(dependenciesForPolicy(child, mapping), ['EnableExternalAuthProviders'], child);
  }
});

test('each social IdP depends on both External Auth and OAuth 2.0', () => {
  for (const child of ['EnableIdpOAuthFacebook', 'EnableIdpOAuthGoogle', 'EnableIdpOAuthMicrosoft']) {
    assert.deepEqual(
      dependenciesForPolicy(child, mapping),
      ['EnableExternalAuthProviders', 'EnableProtocolOpenAuth'],
      child
    );
  }
});

test('leaf / independent policies have no availability dependencies', () => {
  assert.deepEqual(dependenciesForPolicy('EnableMakerCopilotForExistingSites', mapping), []);
  assert.deepEqual(dependenciesForPolicy('EnableAuthenticationLocalLogin', mapping), []);
  assert.deepEqual(dependenciesForPolicy('EnableExternalAuthProviders', mapping), []);
});

test('the parent/child overview matches every per-policy availabilityDependsOn field', () => {
  // The top-level block is only an overview — assert it stays consistent with
  // the authoritative per-policy fields so the two can't silently drift.
  const parents = mapping.policyAvailabilityDependencies.parents;
  for (const [parent, children] of Object.entries(parents)) {
    for (const child of children) {
      assert.ok(
        dependenciesForPolicy(child, mapping).includes(parent),
        `${child}.availabilityDependsOn must include ${parent}`
      );
    }
  }
});

// --- canonicalizeEnvValue ---------------------------------------------------

test('canonicalizeEnvValue folds *Sites and casing to canonical, else Unknown', () => {
  assert.equal(canonicalizeEnvValue('All'), 'All');
  assert.equal(canonicalizeEnvValue('allsites'), 'All');
  assert.equal(canonicalizeEnvValue('None'), 'None');
  assert.equal(canonicalizeEnvValue('IncludeSites'), 'Include');
  assert.equal(canonicalizeEnvValue('IncludedSites'), 'Include');
  assert.equal(canonicalizeEnvValue('ExcludeSites'), 'Exclude');
  assert.equal(canonicalizeEnvValue('AllSitesExceptExcluded'), 'Exclude');
  assert.equal(canonicalizeEnvValue(''), 'Unknown');
  assert.equal(canonicalizeEnvValue(null), 'Unknown');
  assert.equal(canonicalizeEnvValue('garbage'), 'Unknown');
});

// --- computeSiteState (siteStateRules contract) -----------------------------

test('computeSiteState follows the siteStateRules table', () => {
  assert.equal(computeSiteState('All', {}), 'Enabled');
  assert.equal(computeSiteState('None', {}), 'Disabled');
  assert.equal(computeSiteState('Include', { inInclusion: true }), 'Enabled');
  assert.equal(computeSiteState('Include', { inInclusion: false }), 'Disabled');
  assert.equal(computeSiteState('Exclude', { inExclusion: true }), 'Disabled');
  assert.equal(computeSiteState('Exclude', { inExclusion: false }), 'Enabled');
  assert.equal(computeSiteState('Unknown', {}), 'Unknown');
});

// --- extractLists tolerance -------------------------------------------------

test('extractLists reads several field spellings and id shapes, lowercased', () => {
  const a = extractLists({ InclusionList: ['AAA', { id: 'BBB' }], ExclusionList: [{ portalId: 'CcC' }] });
  assert.deepEqual([...a.inclusion].sort(), ['aaa', 'bbb']);
  assert.deepEqual([...a.exclusion], ['ccc']);

  const b = extractLists({ details: { IncludedSites: ['X1'], ExcludedSites: [{ websiteId: 'Y2' }] } });
  assert.deepEqual([...b.inclusion], ['x1']);
  assert.deepEqual([...b.exclusion], ['y2']);

  const empty = extractLists(null);
  assert.equal(empty.inclusion.size, 0);
  assert.equal(empty.exclusion.size, 0);
});

// --- computeAvailability core scenarios -------------------------------------

const PORTALS = [
  { portalId: 'AAA', name: 'Site 1', websiteUrl: 'https://a' },
  { portalId: 'bbb', name: 'Site 2', websiteUrl: 'https://b' },
  { portalId: 'ccc', name: 'Site 3', websiteUrl: 'https://c' },
];

test('External Auth disabled env-wide makes every portal unavailable for a protocol child', () => {
  const part = computeAvailability({
    targetPolicy: 'EnableProtocolOpenIdConnect',
    portals: PORTALS,
    parentStates: { EnableExternalAuthProviders: { envValue: 'None' } },
  });
  assert.equal(part.available.length, 0);
  assert.equal(part.unavailable.length, 3);
  for (const p of part.unavailable) {
    assert.deepEqual(p.blockingParents, ['EnableExternalAuthProviders']);
    assert.deepEqual(p.blockedBy, ['External authentication providers']);
  }
});

test('External Auth Include partitions available vs unavailable by inclusion list', () => {
  const part = computeAvailability({
    targetPolicy: 'EnableProtocolSAML20',
    portals: PORTALS,
    parentStates: { EnableExternalAuthProviders: { envValue: 'Include', inclusion: ['aaa'] } },
  });
  assert.deepEqual(part.available.map((p) => p.name), ['Site 1']);
  assert.deepEqual(part.unavailable.map((p) => p.name), ['Site 2', 'Site 3']);
});

test('social IdP is unavailable when EITHER External Auth OR OAuth is disabled for the portal', () => {
  // External Auth: All. OAuth: Exclude Site 2 -> Site 2 gets OAuth Disabled.
  const part = computeAvailability({
    targetPolicy: 'EnableIdpOAuthGoogle',
    portals: PORTALS,
    parentStates: {
      EnableExternalAuthProviders: { envValue: 'All' },
      EnableProtocolOpenAuth: { envValue: 'Exclude', exclusion: ['bbb'] },
    },
  });
  assert.deepEqual(part.available.map((p) => p.name), ['Site 1', 'Site 3']);
  assert.deepEqual(part.unavailable.map((p) => p.name), ['Site 2']);
  assert.deepEqual(part.unavailable[0].blockingParents, ['EnableProtocolOpenAuth']);
  assert.deepEqual(part.unavailable[0].blockedBy, ['OAuth 2.0 sign-in']);
});

test('a social IdP portal blocked by BOTH parents lists both in blockedBy', () => {
  const part = computeAvailability({
    targetPolicy: 'EnableIdpOAuthMicrosoft',
    portals: [{ portalId: 'zzz', name: 'Blocked Site', websiteUrl: 'https://z' }],
    parentStates: {
      EnableExternalAuthProviders: { envValue: 'None' },
      EnableProtocolOpenAuth: { envValue: 'None' },
    },
  });
  assert.equal(part.available.length, 0);
  assert.deepEqual(part.unavailable[0].blockingParents, [
    'EnableExternalAuthProviders',
    'EnableProtocolOpenAuth',
  ]);
  assert.deepEqual(part.unavailable[0].blockedBy, [
    'External authentication providers',
    'OAuth 2.0 sign-in',
  ]);
});

test('leaf policy: every portal is available, no parent reads needed', () => {
  const part = computeAvailability({
    targetPolicy: 'EnableAuthenticationLocalLogin',
    portals: PORTALS,
    parentStates: {},
  });
  assert.deepEqual(part.dependencies, []);
  assert.equal(part.available.length, 3);
  assert.equal(part.unavailable.length, 0);
});

test('unknown/unread parent state is fail-open (portal stays available, parent recorded)', () => {
  const part = computeAvailability({
    targetPolicy: 'EnableProtocolWsFederation',
    portals: [{ portalId: 'AAA', name: 'Site 1', websiteUrl: 'https://a' }],
    parentStates: {}, // parent entirely absent -> Unknown
  });
  assert.equal(part.available.length, 1, 'a transient read miss must not hide the portal');
  assert.equal(part.unavailable.length, 0);
  assert.deepEqual(part.available[0].unreadParents, ['EnableExternalAuthProviders']);
});

test('parentStates accepts inclusion/exclusion as Set or array, case-insensitively', () => {
  const withSet = computeAvailability({
    targetPolicy: 'EnableProtocolOpenIdConnect',
    portals: PORTALS,
    parentStates: { EnableExternalAuthProviders: { envValue: 'Include', inclusion: new Set(['AAA']) } },
  });
  assert.deepEqual(withSet.available.map((p) => p.name), ['Site 1']);
});

// --- renderAvailabilityMarkdown ---------------------------------------------

test('renderAvailabilityMarkdown lists available first then unavailable below, with reason', () => {
  const part = computeAvailability({
    targetPolicy: 'EnableIdpOAuthGoogle',
    portals: PORTALS,
    parentStates: {
      EnableExternalAuthProviders: { envValue: 'Include', inclusion: ['aaa'] },
      EnableProtocolOpenAuth: { envValue: 'All' },
    },
  });
  const md = renderAvailabilityMarkdown(part);
  const lines = md.split('\n');
  assert.match(lines[0], /^\| # \| Portal Name \| Portal URL \| Portal ID \| Availability \|$/);
  assert.match(lines[1], /^\| --- \| --- \| --- \| --- \| --- \|$/);
  // Row 1 is the available site; the two unavailable ones come strictly after.
  assert.match(md, /^\| 1 \| Site 1 \| https:\/\/a \| AAA \| 🟢 Available \|$/m);
  assert.match(
    md,
    /^\| 2 \| Site 2 \| https:\/\/b \| bbb \| ⚪ Unavailable — blocked by External authentication providers \(Disabled\) \|$/m
  );
  const availIdx = md.indexOf('Site 1');
  const unavailIdx = md.indexOf('Site 2');
  assert.ok(availIdx < unavailIdx, 'available rows must render above unavailable rows');
});

test('renderAvailabilityMarkdown escapes pipes and can omit icons', () => {
  const part = {
    available: [{ portalId: 'p1', name: 'A|B', websiteUrl: 'https://x' }],
    unavailable: [],
  };
  const md = renderAvailabilityMarkdown(part, { icons: false });
  assert.match(md, /\| A\\\|B \|/);
  assert.match(md, /\| Available \|/);
  assert.ok(!/🟢/.test(md), 'icons:false suppresses the emoji marker');
});

// --- renderAvailablePortalsMarkdown (scope picker: available only) -----------

test('renderAvailablePortalsMarkdown lists ONLY the available portals (no unavailable rows)', () => {
  const part = computeAvailability({
    targetPolicy: 'EnableProtocolOpenAuth',
    portals: PORTALS,
    parentStates: { EnableExternalAuthProviders: { envValue: 'Include', inclusion: ['aaa'] } },
  });
  const md = renderAvailablePortalsMarkdown(part);
  // Header has NO Availability column — only the actionable set is shown.
  assert.match(md.split('\n')[0], /^\| # \| Portal Name \| Portal URL \| Portal ID \|$/);
  assert.match(md, /Site 1/);
  assert.doesNotMatch(md, /Site 2/); // the unavailable sites are omitted
  assert.doesNotMatch(md, /Site 3/);
});

test('renderAvailablePortalsMarkdown shows the parent-disabled message when NO site is available', () => {
  const part = computeAvailability({
    targetPolicy: 'EnableProtocolSAML20',
    portals: PORTALS,
    parentStates: { EnableExternalAuthProviders: { envValue: 'None' } },
  });
  const md = renderAvailablePortalsMarkdown(part);
  assert.match(md, /The External authentication providers Governance setting is off for this environment/);
  assert.match(md, /No sites are available to configure/);
  // It is a message, NOT a table.
  assert.doesNotMatch(md, /\| # \| Portal Name/);
});

test('renderAvailablePortalsMarkdown adds an info line when only a subset is available', () => {
  const part = computeAvailability({
    targetPolicy: 'EnableProtocolWsFederation',
    portals: PORTALS,
    parentStates: { EnableExternalAuthProviders: { envValue: 'Include', inclusion: ['aaa'] } },
  });
  const md = renderAvailablePortalsMarkdown(part);
  assert.match(md, /Showing 1 of 3 site\(s\)/);
  assert.match(md, /2 site\(s\) are hidden because the External authentication providers Governance setting is off/);
  // The consequence for the child is spelled out in Governance-setting terms.
  assert.match(md, /the WS-Federation sign-in Governance setting can't apply there/);
});

test('renderAvailablePortalsMarkdown names BOTH blocking parents for a social IdP when both disabled', () => {
  const part = computeAvailability({
    targetPolicy: 'EnableIdpOAuthGoogle',
    portals: [{ portalId: 'zzz', name: 'Blocked', websiteUrl: 'https://z' }],
    parentStates: {
      EnableExternalAuthProviders: { envValue: 'None' },
      EnableProtocolOpenAuth: { envValue: 'None' },
    },
  });
  const md = renderAvailablePortalsMarkdown(part);
  assert.match(md, /The External authentication providers or OAuth 2\.0 sign-in Governance setting is off for this environment/);
  // Enabling a social IdP needs BOTH parents on, so the enable instruction uses "both … and …".
  assert.match(md, /turn on both the External authentication providers and OAuth 2\.0 sign-in Governance settings first/);
});

test('renderAvailablePortalsMarkdown (social IdP subset) requires BOTH parents enabled and phrases them with and/or', () => {
  // Google depends on External Auth AND OAuth 2.0. A site is eligible only when
  // BOTH are enabled; blocked when EITHER is off.
  //   External Auth Include [AAA, bbb] -> Site1, Site2 on; Site3 off
  //   OAuth 2.0     Include [AAA, ccc] -> Site1, Site3 on; Site2 off
  // Intersection = only Site1 (AAA); Site2 blocked by OAuth 2.0, Site3 by External Auth.
  const part = computeAvailability({
    targetPolicy: 'EnableIdpOAuthGoogle',
    portals: PORTALS,
    parentStates: {
      EnableExternalAuthProviders: { envValue: 'Include', inclusion: ['AAA', 'bbb'] },
      EnableProtocolOpenAuth: { envValue: 'Include', inclusion: ['AAA', 'ccc'] },
    },
  });
  const md = renderAvailablePortalsMarkdown(part);
  assert.match(md, /Site 1/);
  assert.doesNotMatch(md, /Site 2/);
  assert.doesNotMatch(md, /Site 3/);
  assert.match(md, /Showing 1 of 3 site\(s\)/);
  // "only … where both … Governance settings are on" (AND — every parent must be on).
  assert.match(md, /only be configured on sites where both .* Governance settings are on/);
  // "hidden because … or … Governance setting is off on them" (OR — either parent off blocks).
  assert.match(md, /hidden because .* Governance setting is off on them/);
  // Both parent subjects are named regardless of order.
  assert.match(md, /External authentication providers/);
  assert.match(md, /OAuth 2\.0 sign-in/);
});

test('renderAvailablePortalsMarkdown shows a clean table (no info line) when ALL sites are available', () => {
  const part = computeAvailability({
    targetPolicy: 'EnableProtocolOpenIdConnect',
    portals: PORTALS,
    parentStates: { EnableExternalAuthProviders: { envValue: 'All' } },
  });
  const md = renderAvailablePortalsMarkdown(part);
  assert.match(md, /Site 1/);
  assert.match(md, /Site 2/);
  assert.match(md, /Site 3/);
  assert.doesNotMatch(md, /hidden because/);
});

// --- resolvePortalStates: batch per-portal state from ONE env + details read -
// This is the getDetails fast path — it must reproduce, locally and with zero
// per-portal network calls, exactly what a per-portal get-portal.js loop would
// return. See SKILL.md Phase 4.3.1 / 4.4.4 / 4.2.3 / 4.2.5.

test('resolvePortalStates: Include -> only listed sites Enabled (rest Disabled)', () => {
  // getDetails body shape observed live: IncludedSites array, ExcludedSites null.
  const details = {
    IncludedSites: [
      '096b20ff-2e33-4a10-bcf7-6903a7aa09f5',
      '214d497a-d8a8-4a28-90ac-4fd1c2fd4437',
    ],
    ExcludedSites: null,
  };
  const portals = [
    '096b20ff-2e33-4a10-bcf7-6903a7aa09f5', // listed -> Enabled
    'd1df518c-8e39-4bd5-8410-eb1c0c28e56c', // not listed -> Disabled
  ];
  const states = resolvePortalStates('Include', details, portals);
  assert.deepEqual(states, [
    { portalId: '096b20ff-2e33-4a10-bcf7-6903a7aa09f5', state: 'Enabled' },
    { portalId: 'd1df518c-8e39-4bd5-8410-eb1c0c28e56c', state: 'Disabled' },
  ]);
});

test('resolvePortalStates: Exclude -> listed sites Disabled, rest Enabled', () => {
  const details = { ExcludedSites: ['AAA'] };
  const states = resolvePortalStates('Exclude', details, ['aaa', 'bbb']);
  // Membership test is case-insensitive: 'AAA' in the list matches portal 'aaa'.
  assert.deepEqual(states, [
    { portalId: 'aaa', state: 'Disabled' },
    { portalId: 'bbb', state: 'Enabled' },
  ]);
});

test('resolvePortalStates: All / None ignore the lists entirely', () => {
  const all = resolvePortalStates('All', { IncludedSites: [] }, ['x', 'y']);
  assert.deepEqual(all.map((s) => s.state), ['Enabled', 'Enabled']);
  const none = resolvePortalStates('None', { IncludedSites: ['x'] }, ['x', 'y']);
  assert.deepEqual(none.map((s) => s.state), ['Disabled', 'Disabled']);
});

test('resolvePortalStates: accepts portal OBJECTS and passes name/url through', () => {
  const details = { IncludedSites: ['p1'] };
  const portals = [
    { portalId: 'p1', name: 'Portal_1', websiteUrl: 'https://p1.example' },
    { portalId: 'p2', name: 'Portal_2', url: 'https://p2.example' },
  ];
  const states = resolvePortalStates('Include', details, portals);
  assert.deepEqual(states, [
    { portalId: 'p1', state: 'Enabled', name: 'Portal_1', url: 'https://p1.example' },
    { portalId: 'p2', state: 'Disabled', name: 'Portal_2', url: 'https://p2.example' },
  ]);
});

test('resolvePortalStates: unknown env value -> Unknown (fail visible, never guess)', () => {
  const states = resolvePortalStates('Bogus', { IncludedSites: ['p1'] }, ['p1']);
  assert.deepEqual(states, [{ portalId: 'p1', state: 'Unknown' }]);
});

test('resolvePortalStates: reproduces the live OIDC read for Sachin-preprod-July', () => {
  // Regression guard for the exact case that motivated this path: env=Include,
  // details.IncludedSites=[Portal_3,4,5]. A per-portal get-portal loop returned
  // Enabled for 3/4/5 and Disabled for 1/2 — this must match without any
  // per-portal call.
  const details = {
    IncludedSites: [
      '096b20ff-2e33-4a10-bcf7-6903a7aa09f5', // Portal_3
      '214d497a-d8a8-4a28-90ac-4fd1c2fd4437', // Portal_4
      '76dbce65-52dd-4a9e-8b8c-2753e57c6214', // Portal_5
    ],
    ExcludedSites: null,
  };
  const portals = [
    'd1df518c-8e39-4bd5-8410-eb1c0c28e56c', // Portal_1
    'bf8ead09-df94-488a-b78c-d4065899e1a4', // Portal_2
    '096b20ff-2e33-4a10-bcf7-6903a7aa09f5', // Portal_3
    '214d497a-d8a8-4a28-90ac-4fd1c2fd4437', // Portal_4
    '76dbce65-52dd-4a9e-8b8c-2753e57c6214', // Portal_5
  ];
  const states = resolvePortalStates('Include', details, portals).map((s) => s.state);
  assert.deepEqual(states, ['Disabled', 'Disabled', 'Enabled', 'Enabled', 'Enabled']);
});
