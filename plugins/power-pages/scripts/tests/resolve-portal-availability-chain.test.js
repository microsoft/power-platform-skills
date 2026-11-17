'use strict';

// Tests for the ORDERED remediation chain added to resolve-portal-availability.js.
//
// Context (PR #309 review, defects 1 & 2): when a child auth policy is blocked
// env-wide, the old remediation offered "enable External Auth OR enable OAuth"
// as flat parallel options. OAuth 2.0 is itself gated by External Auth, so
// picking OAuth first hit the same hard block — a dead-end. computeAvailability
// now emits `remediationChain` (root-first ordered disabled parents) and `next`
// (chain[0], the ONLY parent to offer at a time) so the orchestrator walks the
// dependency order External Auth -> OAuth 2.0 -> child and never offers a
// parent whose own parent is still off.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const scriptsDir = path.join(
  __dirname,
  '..',
  '..',
  'skills',
  'manage-governance',
  'scripts'
);
const {
  loadMapping,
  transitiveParents,
  availabilityDepth,
  computeRemediationChain,
  computeAvailability,
} = require(path.join(scriptsDir, 'resolve-portal-availability.js'));

const mapping = loadMapping();

// One portal is enough to exercise env-wide blocking: a parent whose envValue is
// 'None' is Disabled on every portal, so the single portal lands in `unavailable`
// with that parent named — the union of which feeds the chain.
const PORTAL = { portalId: 'p1', name: 'Portal_1', url: 'https://p1.example.com' };

function availability(targetPolicy, parentStates) {
  return computeAvailability(
    { targetPolicy, portals: [PORTAL], parentStates },
    { mapping }
  );
}

// --- transitiveParents / availabilityDepth (the ordering primitives) ---

test('transitiveParents: social IdP has both ancestors; protocol has one; root has none', () => {
  assert.deepStrictEqual(
    [...transitiveParents('EnableIdpOAuthGoogle', mapping)].sort(),
    ['EnableExternalAuthProviders', 'EnableProtocolOpenAuth']
  );
  assert.deepStrictEqual(
    [...transitiveParents('EnableProtocolSAML20', mapping)],
    ['EnableExternalAuthProviders']
  );
  assert.deepStrictEqual([...transitiveParents('EnableExternalAuthProviders', mapping)], []);
});

test('availabilityDepth: root=0, OAuth 2.0=1, social IdP=2', () => {
  assert.strictEqual(availabilityDepth('EnableExternalAuthProviders', mapping), 0);
  assert.strictEqual(availabilityDepth('EnableProtocolOpenAuth', mapping), 1);
  assert.strictEqual(availabilityDepth('EnableIdpOAuthGoogle', mapping), 2);
});

test('computeRemediationChain sorts root-first regardless of input order', () => {
  // Feed the blockers in the WRONG (deepest-first) order; must come out root-first.
  const chain = computeRemediationChain(
    'EnableIdpOAuthGoogle',
    ['EnableProtocolOpenAuth', 'EnableExternalAuthProviders'],
    mapping
  );
  assert.deepStrictEqual(
    chain.map((c) => c.policyName),
    ['EnableExternalAuthProviders', 'EnableProtocolOpenAuth']
  );
  // carries the human subject label for the orchestrator prompt
  assert.strictEqual(chain[0].subject, 'External authentication providers');
});

// --- single-parent child (protocol) ---

test('single-parent child, parent off env-wide: chain=[External Auth], next=root', () => {
  const res = availability('EnableProtocolSAML20', {
    EnableExternalAuthProviders: { envValue: 'None' },
  });
  assert.strictEqual(res.available.length, 0);
  assert.deepStrictEqual(res.remediationChain.map((c) => c.policyName), [
    'EnableExternalAuthProviders',
  ]);
  assert.strictEqual(res.next.policyName, 'EnableExternalAuthProviders');
});

// --- two-parent social IdP, BOTH off: the dead-end case the fix targets ---

test('social IdP, both parents off: chain=[External Auth, OAuth 2.0] (never OAuth first)', () => {
  const res = availability('EnableIdpOAuthGoogle', {
    EnableExternalAuthProviders: { envValue: 'None' },
    EnableProtocolOpenAuth: { envValue: 'None' },
  });
  assert.strictEqual(res.available.length, 0);
  assert.deepStrictEqual(res.remediationChain.map((c) => c.policyName), [
    'EnableExternalAuthProviders',
    'EnableProtocolOpenAuth',
  ]);
  // The orchestrator offers ONLY next — the root — never the gated OAuth first.
  assert.strictEqual(res.next.policyName, 'EnableExternalAuthProviders');
});

// --- one parent already on: chain drops it (the auto-resume 2nd pass) ---

test('social IdP, External Auth already on but OAuth off: chain=[OAuth 2.0] only', () => {
  // This is the state after the admin enabled External Auth and the resolver
  // re-ran: the root is no longer blocking, so only OAuth remains in the chain.
  const res = availability('EnableIdpOAuthGoogle', {
    EnableExternalAuthProviders: { envValue: 'All' },
    EnableProtocolOpenAuth: { envValue: 'None' },
  });
  assert.strictEqual(res.available.length, 0);
  assert.deepStrictEqual(res.remediationChain.map((c) => c.policyName), [
    'EnableProtocolOpenAuth',
  ]);
  assert.strictEqual(res.next.policyName, 'EnableProtocolOpenAuth');
});

test('social IdP, both parents on: portal available, empty chain, next=null', () => {
  const res = availability('EnableIdpOAuthGoogle', {
    EnableExternalAuthProviders: { envValue: 'All' },
    EnableProtocolOpenAuth: { envValue: 'All' },
  });
  assert.strictEqual(res.available.length, 1);
  assert.strictEqual(res.unavailable.length, 0);
  assert.deepStrictEqual(res.remediationChain, []);
  assert.strictEqual(res.next, null);
});

// --- unread parent fail-open: a parent we cannot read never blocks or chains ---

test('unread parent is fail-open: not blocking, not in chain', () => {
  // External Auth on; OAuth env value is unreadable (Unknown) -> fail-open: the
  // portal stays AVAILABLE and the unread parent must NOT appear in the chain.
  const res = availability('EnableIdpOAuthGoogle', {
    EnableExternalAuthProviders: { envValue: 'All' },
    EnableProtocolOpenAuth: { envValue: 'garbage-unreadable' },
  });
  assert.strictEqual(res.available.length, 1);
  assert.deepStrictEqual(res.remediationChain, []);
  assert.strictEqual(res.next, null);
});

// --- leaf/independent policy: no parents, never a chain ---

test('leaf policy (Maker Copilot) has no dependencies, empty chain, next=null', () => {
  const res = availability('EnableMakerCopilotForExistingSites', {});
  assert.strictEqual(res.available.length, 1);
  assert.deepStrictEqual(res.dependencies, []);
  assert.deepStrictEqual(res.remediationChain, []);
  assert.strictEqual(res.next, null);
});
