'use strict';

// Tests for the fail-fast guards added to buildRoute() and the newline
// flattening added to render-env-table's mdCell (PR #309 review comments
// #1 and #3).
//
// #1: getEnv/getStatus/getPortal/getDetails encode `policy` (and getPortal
// also `portalId`) directly into the gateway path. A missing value used to
// build `/governance/undefined` and 404 with a confusing URL; buildRoute now
// throws up front. `apply` is exempt — its policy travels in the POST body.
//
// #3: a raw CR/LF in an environment display name would spill the value onto a
// malformed new row in the single-line Markdown table; mdCell now flattens
// newline runs to a single space.

const { test } = require('node:test');
const assert = require('node:assert');

const routeMod = require('../../skills/manage-governance/scripts/governance-route.js');
const { buildRoute } = routeMod;

const envTableMod = require('../../skills/manage-governance/scripts/render-env-table.js');

test('buildRoute: apply needs no policy in the path', () => {
  const r = buildRoute({ op: 'apply', envId: 'env-1' });
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(r.path, '/governance');
});

test('buildRoute: valid getEnv builds the encoded policy path', () => {
  const r = buildRoute({ op: 'getEnv', envId: 'env-1', policy: 'EnableIdpOAuthGoogle' });
  assert.strictEqual(r.path, '/governance/EnableIdpOAuthGoogle');
});

test('buildRoute: getPortal builds the encoded portal + policy path', () => {
  const r = buildRoute({
    op: 'getPortal',
    envId: 'env-1',
    portalId: 'p-1',
    policy: 'EnableProtocolSAML20',
  });
  assert.strictEqual(r.path, '/websites/p-1/governance/EnableProtocolSAML20');
});

for (const op of ['getEnv', 'getStatus', 'getPortal', 'getDetails']) {
  test(`buildRoute: ${op} without policy throws instead of building /governance/undefined`, () => {
    assert.throws(
      () => buildRoute({ op, envId: 'env-1', portalId: 'p-1' }),
      /policy is required/,
    );
  });
}

test('buildRoute: getPortal without portalId throws', () => {
  assert.throws(
    () => buildRoute({ op: 'getPortal', envId: 'env-1', policy: 'EnableProtocolSAML20' }),
    /portalId is required/,
  );
});

test('buildRoute: missing op / envId still throw (unchanged)', () => {
  assert.throws(() => buildRoute({ envId: 'env-1', policy: 'p' }), /op is required/);
  assert.throws(() => buildRoute({ op: 'getEnv', policy: 'p' }), /envId is required/);
});

// #3 — mdCell newline flattening, asserted through the public renderEnvMarkdown.
test('renderEnvMarkdown: a newline in an env name does not break the table row', () => {
  const md = envTableMod.renderEnvMarkdown([
    { envId: 'env-1', displayName: 'Contoso\r\nProd', type: 'Default' },
  ]);
  // The malformed value must not introduce a stray line break inside the row —
  // every non-blank line of the table must still be a single pipe-delimited row.
  assert.ok(!md.includes('Contoso\nProd'), 'newline should be flattened, not preserved');
  assert.ok(md.includes('Contoso Prod'), 'CR/LF run should collapse to a single space');
});
