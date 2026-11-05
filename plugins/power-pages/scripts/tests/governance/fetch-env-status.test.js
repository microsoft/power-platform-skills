const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pickHeadline,
  parseFlags,
} = require('../../../skills/manage-governance/scripts/fetch-env-status');
const listPortals = require('../../../skills/manage-governance/scripts/list-portals');

// --- pickHeadline: mirrors SKILL.md Phase 4.3.1 headline rule ---
// Green when at least one site is effectively Enabled; red when off everywhere
// (including the zero-site case, where nothing is enabled).

test('pickHeadline is green when at least one site is effectively enabled', () => {
  const h = pickHeadline(1);
  assert.match(h, /\u{1F7E2} Enabled for these Sites:$/u);
});

test('pickHeadline is green for many enabled sites', () => {
  assert.match(pickHeadline(5), /\u{1F7E2} Enabled for these Sites:$/u);
});

test('pickHeadline is red when nothing is enabled', () => {
  const h = pickHeadline(0);
  assert.match(h, /\u{1F534} Disabled for these Sites:$/u);
});

test('pickHeadline treats the zero-site env (count 0) as red/off', () => {
  // An env with no sites has effectiveEnabledCount 0, so the setting is "off
  // everywhere" — the red headline, not the green one.
  assert.match(pickHeadline(0), /\u{1F534} Disabled/u);
});

// --- parseFlags: CLI surface ---

test('parseFlags reads --policy and --envId', () => {
  const f = parseFlags(['node', 'fetch-env-status.js', '--policy', 'EnableIdpOAuthFacebook', '--envId', 'env-guid']);
  assert.equal(f.policy, 'EnableIdpOAuthFacebook');
  assert.equal(f.envId, 'env-guid');
});

test('parseFlags sets json and help booleans', () => {
  const f = parseFlags(['node', 'x', '--policy', 'P', '--json', '--help']);
  assert.equal(f.json, true);
  assert.equal(f.help, true);
});

test('parseFlags leaves envId undefined when omitted (falls back to PAC env)', () => {
  const f = parseFlags(['node', 'x', '--policy', 'P']);
  assert.equal(f.envId, undefined);
});

// --- fetchPortalsPaged export: the seam that lets the site-list fetch join the
// parallel batch instead of being a separate prior step ---

test('list-portals.js exports fetchPortalsPaged for the batched Fetch Env', () => {
  assert.equal(typeof listPortals.fetchPortalsPaged, 'function');
});
