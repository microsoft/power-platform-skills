'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs, readJsonArg, label, requiredLevel } = require('../lib/dataverse-auth');

test('parseArgs: positional only', () => {
  const { positional, flags } = parseArgs(['a', 'b', 'c']);
  assert.deepEqual(positional, ['a', 'b', 'c']);
  assert.deepEqual(flags, {});
});

test('parseArgs: mix of positional and flags', () => {
  const { positional, flags } = parseArgs(['a', '--foo', 'bar', 'b', '--baz']);
  assert.deepEqual(positional, ['a', 'b']);
  assert.deepEqual(flags, { foo: 'bar', baz: true });
});

test('parseArgs: bool flag followed by another flag treats first as bool', () => {
  const { flags } = parseArgs(['--x', '--y', '1']);
  assert.deepEqual(flags, { x: true, y: '1' });
});

test('parseArgs: repeated flag overwrites', () => {
  const { flags } = parseArgs(['--foo', '1', '--foo', '2']);
  assert.equal(flags.foo, '2');
});

test('parseArgs: --key=value form', () => {
  const { positional, flags } = parseArgs(['x', '--foo=bar', '--baz=qux', 'y']);
  assert.deepEqual(positional, ['x', 'y']);
  assert.deepEqual(flags, { foo: 'bar', baz: 'qux' });
});

test('parseArgs: --key=value with empty value', () => {
  const { flags } = parseArgs(['--foo=']);
  assert.equal(flags.foo, '');
});

test('parseArgs: --key=value preserves additional = signs in value', () => {
  const { flags } = parseArgs(['--query=a=b=c']);
  assert.equal(flags.query, 'a=b=c');
});

test('parseArgs: mixed --key=value and --key value forms', () => {
  const { flags } = parseArgs(['--foo=bar', '--baz', 'qux']);
  assert.deepEqual(flags, { foo: 'bar', baz: 'qux' });
});

test('readJsonArg: inline JSON', () => {
  assert.deepEqual(readJsonArg('{"a":1}'), { a: 1 });
});

test('readJsonArg: file path with @ prefix', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tmp = path.join(os.tmpdir(), `dv-auth-test-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ from: 'file' }));
  try {
    assert.deepEqual(readJsonArg('@' + tmp), { from: 'file' });
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('readJsonArg: null and undefined pass through', () => {
  assert.equal(readJsonArg(null), null);
  assert.equal(readJsonArg(undefined), null);
});

test('label: builds Dataverse verbose Label object', () => {
  const out = label('Hello');
  assert.equal(out['@odata.type'], 'Microsoft.Dynamics.CRM.Label');
  assert.equal(out.LocalizedLabels.length, 1);
  assert.equal(out.LocalizedLabels[0].Label, 'Hello');
  assert.equal(out.LocalizedLabels[0].LanguageCode, 1033);
});

test('label: respects custom language code', () => {
  const out = label('Bonjour', 1036);
  assert.equal(out.LocalizedLabels[0].LanguageCode, 1036);
});

test('requiredLevel: defaults to None and is mutable', () => {
  const out = requiredLevel();
  assert.equal(out.Value, 'None');
  assert.equal(out.CanBeChanged, true);
});

test('requiredLevel: respects argument', () => {
  assert.equal(requiredLevel('ApplicationRequired').Value, 'ApplicationRequired');
});

test('emitResult: partial-failure object writes JSON to stdout (not [object Object])', () => {
  // Spawn a tiny script that calls emitResult(false, {errors:[...]}) and
  // verify that stdout contains the JSON payload — not the literal string
  // "[object Object]". Regression guard for the bulk-insert failure path.
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const libPath = path.join(__dirname, '..', 'lib', 'dataverse-auth.js');
  const code = `
    const { emitResult } = require(${JSON.stringify(libPath)});
    emitResult(false, { ok: false, count: 0, ids: [], errors: [{ index: 0, status: 400, message: 'bad row' }] });
  `;
  const res = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  assert.equal(res.status, 1, 'expected exit 1');
  assert.doesNotMatch(res.stdout, /\[object Object\]/, 'stdout must not be [object Object]');
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].index, 0);
  assert.equal(parsed.errors[0].status, 400);
  assert.equal(parsed.errors[0].message, 'bad row');
  assert.match(res.stderr, /Operation completed with 1 error/);
});

// --- AB#6686427: auth preflight — az tenant divergence from the selected PAC environment ---------
//
// The skill flow validates and selects a PAC profile, but every script authenticates through the
// INDEPENDENTLY active Azure CLI account. In a normal multi-tenant workflow `pac auth` and
// `az login` legitimately point at different tenants, and the result is an HTTP 401 that reads as a
// Dataverse permission problem — so the user troubleshoots roles and PAC profiles while the actual
// cause is the ambient az context. Worse, download's best-effort catches turn that 401 into a
// silently EMPTY spec (AB#6686423), so the failure does not even surface as an error.
//
// The preflight names the identity that will actually supply the token, before any real work.

const { preflightAuth } = require('../lib/dataverse-auth.js');

test('AB#6686427: preflight passes and reports the identity when WhoAmI succeeds', async () => {
  const r = await preflightAuth('https://contoso.crm.dynamics.com', {
    getToken: () => 'token',
    request: async () => ({ status: 200, data: { UserId: '00000000-0000-0000-0000-000000000001' } }),
    azIdentity: () => ({ user: 'maker@contoso.com', tenantId: 'aaaaaaaa-0000-0000-0000-000000000000' }),
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.match(r.identity.user, /maker@contoso\.com/);
});

test('AB#6686427: a 401 names the ACTIVE az identity, the target org, and the remediation', async () => {
  const r = await preflightAuth('https://contoso.crm.dynamics.com', {
    getToken: () => 'token',
    request: async () => ({ status: 401, data: {} }),
    azIdentity: () => ({ user: 'other@fabrikam.onmicrosoft.com', tenantId: 'bbbbbbbb-0000-0000-0000-000000000000' }),
  });
  assert.strictEqual(r.ok, false);
  // Naming only the status repeats the failure the user already saw; the point is to name the CAUSE.
  assert.match(r.error, /other@fabrikam\.onmicrosoft\.com/, 'must name the active az identity');
  assert.match(r.error, /bbbbbbbb-0000-0000-0000-000000000000/, 'must name the tenant supplying the token');
  assert.match(r.error, /contoso\.crm\.dynamics\.com/, 'must name the target org');
  assert.match(r.error, /az login/, 'must name the remediation');
});

test('AB#6686427: no token at all is reported as a sign-in problem, not a permission one', async () => {
  const r = await preflightAuth('https://contoso.crm.dynamics.com', {
    getToken: () => null,
    request: async () => { throw new Error('should not be called'); },
    azIdentity: () => null,
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /az login/);
  // Assert the CLAIM, not the vocabulary: the message may legitimately use the word "permissions"
  // to rule it OUT, which an over-crude /permission/ ban would fail. What must not happen is the
  // failure being ATTRIBUTED to privileges, sending the user to security roles.
  assert.match(r.error, /sign-in problem/, 'must name the real cause');
  assert.doesNotMatch(r.error, /insufficient|lacks? (the )?privilege|missing privilege|security role/i,
    'must not attribute a missing token to privileges');
});

test('AB#6686427: the preflight is a diagnostic and never throws', async () => {
  for (const opts of [
    { getToken: () => { throw new Error('az exploded'); }, request: async () => ({ status: 200, data: {} }), azIdentity: () => null },
    { getToken: () => 't', request: async () => { throw new Error('socket hang up'); }, azIdentity: () => null },
    { getToken: () => 't', request: async () => ({ status: 200, data: {} }), azIdentity: () => { throw new Error('az show failed'); } },
  ]) {
    let r;
    await assert.doesNotReject(async () => { r = await preflightAuth('https://contoso.crm.dynamics.com', opts); });
    assert.ok(typeof r.ok === 'boolean', 'always returns a structured verdict');
  }
});

test('AB#6686427: a non-401 failure is NOT reported as a tenant mismatch', async () => {
  // A 403 is a real privilege problem and a 500 is the service; blaming the az tenant for either
  // would send the user down exactly the wrong path — the mirror of the bug being fixed.
  for (const status of [403, 500]) {
    const r = await preflightAuth('https://contoso.crm.dynamics.com', {
      getToken: () => 'token',
      request: async () => ({ status, data: {} }),
      azIdentity: () => ({ user: 'maker@contoso.com', tenantId: 'aaaa' }),
    });
    assert.strictEqual(r.ok, false);
    assert.doesNotMatch(r.error, /az login --tenant/, `${status} must not be blamed on the az tenant`);
  }
});

// --- AB#6686424: a terminal 401 must explain itself ----------------------------------------------
//
// Both auth paths already retry a 401 once (dataverse-auth's loop, and sdk-http-client.js:130). The
// retry is not the gap: MEASURED, `az account get-access-token` serves from the MSAL cache, so an
// immediate re-call returns a byte-identical token (same sha256). A retry therefore cannot fix a
// token that is rejected for WHO it belongs to — only one that expired in a very narrow window.
//
// The reporter's own workaround was "refresh Azure CLI login and retry" — an `az login`, which is
// AB#6686427's cause. So what a surviving 401 needs is not another attempt, it is to say whose
// token was refused, so the reader stops looking at Dataverse roles.

test('AB#6686424: a terminal 401 names the identity whose token was refused', () => {
  const { ensureOk } = require('../lib/dataverse-auth.js');
  assert.throws(
    () => ensureOk({ status: 401, data: { error: { message: 'Unauthorized' } } }, 'read EntityDefinitions',
      { azIdentity: () => ({ user: 'other@fabrikam.onmicrosoft.com', tenantId: 'bbbb-tenant' }) }),
    (e) => {
      assert.match(e.message, /other@fabrikam\.onmicrosoft\.com/, 'names the account');
      assert.match(e.message, /bbbb-tenant/, 'names the tenant');
      assert.match(e.message, /az login/, 'names the remediation');
      return true;
    }
  );
});

test('AB#6686424: a NON-401 error is left exactly as it was', () => {
  // A 403 is a real privilege problem and a 400 is a bad request; attaching identity advice to
  // either would send the reader to `az login` for something az cannot fix.
  const { ensureOk } = require('../lib/dataverse-auth.js');
  for (const status of [400, 403, 404, 500]) {
    assert.throws(
      () => ensureOk({ status, data: { error: { message: 'boom' } } }, 'ctx', { azIdentity: () => ({ user: 'x', tenantId: 'y' }) }),
      (e) => {
        assert.doesNotMatch(e.message, /az login/, `${status} must not be blamed on the az identity`);
        assert.match(e.message, /boom/);
        return true;
      }
    );
  }
});

test('AB#6686424: an unreadable identity still produces a useful 401, never a crash', () => {
  const { ensureOk } = require('../lib/dataverse-auth.js');
  assert.throws(
    () => ensureOk({ status: 401, data: {} }, 'ctx', { azIdentity: () => { throw new Error('az gone'); } }),
    (e) => {
      assert.match(e.message, /401/);
      assert.match(e.message, /az login/);
      return true;
    }
  );
});

test('AB#6686424: a 2xx is returned untouched (no identity read on the happy path)', () => {
  const { ensureOk } = require('../lib/dataverse-auth.js');
  let called = 0;
  const res = { status: 200, data: { ok: 1 } };
  assert.strictEqual(ensureOk(res, 'ctx', { azIdentity: () => { called++; return null; } }), res);
  assert.strictEqual(called, 0, 'must not shell out to az on every successful call');
});
