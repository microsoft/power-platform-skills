'use strict';

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
  parentChainForPolicy,
  statusColumnLabel,
  effectiveState,
  renderStatusTableMarkdown,
} = require(path.join(scriptsDir, 'render-status-table.js'));

const mapping = loadMapping();

// --- parentChainForPolicy ---

test('protocols depend only on External Auth', () => {
  for (const p of [
    'EnableProtocolOpenIdConnect',
    'EnableProtocolSAML20',
    'EnableProtocolWsFederation',
    'EnableProtocolOpenAuth',
  ]) {
    assert.deepStrictEqual(parentChainForPolicy(p, mapping), ['EnableExternalAuthProviders']);
  }
});

test('social IdPs depend on External Auth then OAuth, in that order', () => {
  for (const p of ['EnableIdpOAuthFacebook', 'EnableIdpOAuthGoogle', 'EnableIdpOAuthMicrosoft']) {
    assert.deepStrictEqual(parentChainForPolicy(p, mapping), [
      'EnableExternalAuthProviders',
      'EnableProtocolOpenAuth',
    ]);
  }
});

test('leaf / root policies have no parent columns', () => {
  assert.deepStrictEqual(parentChainForPolicy('EnableMakerCopilotForExistingSites', mapping), []);
  assert.deepStrictEqual(parentChainForPolicy('EnableAuthenticationLocalLogin', mapping), []);
  assert.deepStrictEqual(parentChainForPolicy('EnableExternalAuthProviders', mapping), []);
});

// --- statusColumnLabel ---

test('status column labels are the short human names', () => {
  assert.strictEqual(statusColumnLabel('EnableExternalAuthProviders', mapping), 'External Auth');
  assert.strictEqual(statusColumnLabel('EnableProtocolOpenAuth', mapping), 'OpenAuth Protocol');
  assert.strictEqual(statusColumnLabel('EnableProtocolOpenIdConnect', mapping), 'OpenID Connect');
  assert.strictEqual(statusColumnLabel('EnableProtocolSAML20', mapping), 'SAML 2.0');
  assert.strictEqual(statusColumnLabel('EnableProtocolWsFederation', mapping), 'WS-Federation');
  assert.strictEqual(statusColumnLabel('EnableIdpOAuthGoogle', mapping), 'Google');
  assert.strictEqual(statusColumnLabel('EnableIdpOAuthFacebook', mapping), 'Facebook');
  assert.strictEqual(statusColumnLabel('EnableIdpOAuthMicrosoft', mapping), 'Microsoft');
});

test('unknown policy falls back to its own name (no crash)', () => {
  assert.strictEqual(statusColumnLabel('NotAPolicy', mapping), 'NotAPolicy');
});

test('effective header uses per-policy override when present, else default template', () => {
  const { effectiveStatusLabel } = require(path.join(scriptsDir, 'render-status-table.js'));
  // OpenAuth Protocol overrides the whole effective-header string via effectiveStatusLabel.
  assert.strictEqual(effectiveStatusLabel('EnableProtocolOpenAuth', mapping), 'Effective OpenAuth State');
  // Google has no override -> default "Effective <label> Status".
  assert.strictEqual(effectiveStatusLabel('EnableIdpOAuthGoogle', mapping), 'Effective Google idp State');
});

// --- effectiveState ---

test('effective is Enabled only when own AND every parent are Enabled', () => {
  assert.strictEqual(effectiveState(['Enabled', 'Enabled', 'Enabled']), 'Enabled');
  assert.strictEqual(effectiveState(['Enabled']), 'Enabled');
});

test('effective is Disabled when own or any parent is Disabled', () => {
  // own on, parent off -> gated off (the key rule: child dark despite own=on)
  assert.strictEqual(effectiveState(['Enabled', 'Disabled']), 'Disabled');
  // own off, parents on
  assert.strictEqual(effectiveState(['Disabled', 'Enabled', 'Enabled']), 'Disabled');
  // one parent off among several
  assert.strictEqual(effectiveState(['Enabled', 'Enabled', 'Disabled']), 'Disabled');
});

test('effective is Unknown when any state is Unknown (fail visible on partial read)', () => {
  assert.strictEqual(effectiveState(['Enabled', 'Unknown']), 'Unknown');
  assert.strictEqual(effectiveState(['Unknown']), 'Unknown');
  assert.strictEqual(effectiveState([]), 'Unknown');
  // A single Disabled with no Unknown still resolves Disabled even if other
  // cells are Unknown? No — an Unknown present forces Unknown.
  assert.strictEqual(effectiveState(['Disabled', 'Unknown']), 'Unknown');
});

// --- renderStatusTableMarkdown ---

test('social IdP table has External Auth + OAuth parents + Effective (no own column)', () => {
  const md = renderStatusTableMarkdown(
    {
      policy: 'EnableIdpOAuthGoogle',
      portals: [
        {
          name: 'Portal_4',
          url: 'https://x',
          portalId: 'id4',
          own: true,
          parents: { EnableExternalAuthProviders: true, EnableProtocolOpenAuth: true },
        },
      ],
    },
    { mapping }
  );
  const lines = md.split('\n');
  assert.strictEqual(
    lines[0],
    '| # | Name | URL | Site ID | External Auth | OpenAuth Protocol | Effective Google idp State |'
  );
  // both parents on + own on -> effective enabled (own has no column)
  assert.match(lines[2], /🟢 Enabled \| 🟢 Enabled \| 🟢 Enabled \|$/);
});

test('social IdP effective is Disabled when OAuth parent is off even though own is on', () => {
  const md = renderStatusTableMarkdown(
    {
      policy: 'EnableIdpOAuthGoogle',
      portals: [
        {
          name: 'Portal_3',
          url: 'https://x',
          portalId: 'id3',
          own: true,
          parents: { EnableExternalAuthProviders: true, EnableProtocolOpenAuth: false },
        },
      ],
    },
    { mapping }
  );
  const row = md.split('\n')[2];
  // ExternalAuth 🟢, OAuth 🔴, Effective 🔴 (own on but gated off by OAuth)
  assert.match(row, /🟢 Enabled \| 🔴 Disabled \| 🔴 Disabled \|$/);
});

test('protocol table has External Auth parent + Effective (no OAuth/own columns)', () => {
  const md = renderStatusTableMarkdown(
    {
      policy: 'EnableProtocolOpenAuth',
      portals: [
        {
          name: 'Portal_1',
          url: 'https://x',
          portalId: 'id1',
          own: true,
          parents: { EnableExternalAuthProviders: false },
        },
      ],
    },
    { mapping }
  );
  const lines = md.split('\n');
  assert.strictEqual(
    lines[0],
    '| # | Name | URL | Site ID | External Auth | Effective OpenAuth State |'
  );
  // External Auth off, own on -> effective off
  assert.match(lines[2], /🔴 Disabled \| 🔴 Disabled \|$/);
});

test('unreadable parent renders Unknown and forces Effective Unknown', () => {
  const md = renderStatusTableMarkdown(
    {
      policy: 'EnableIdpOAuthGoogle',
      portals: [
        {
          name: 'Portal_1',
          url: 'https://x',
          portalId: 'id1',
          own: true,
          parents: { EnableExternalAuthProviders: false, EnableProtocolOpenAuth: null },
        },
      ],
    },
    { mapping }
  );
  const row = md.split('\n')[2];
  assert.match(row, /Unknown \|$/);
});

test('--no-icons style (icons:false) omits the emoji markers', () => {
  const md = renderStatusTableMarkdown(
    {
      policy: 'EnableIdpOAuthGoogle',
      portals: [
        {
          name: 'P',
          url: 'u',
          portalId: 'id',
          own: true,
          parents: { EnableExternalAuthProviders: true, EnableProtocolOpenAuth: true },
        },
      ],
    },
    { mapping, icons: false }
  );
  assert.ok(!/🟢|🔴/.test(md));
  assert.match(md.split('\n')[2], /Enabled \| Enabled \| Enabled \|$/);
});
