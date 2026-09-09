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

test('dataverseRequest USES a preset token and skips the CLI entirely', async () => {
  // The receiving half of the preflight optimisation. Passing the token is pointless if this side
  // fetches its own anyway, and that is invisible from the caller.
  const { dataverseRequest } = require('../lib/dataverse-auth.js');
  let cliCalls = 0;
  let sentAuth;
  const res = await dataverseRequest('https://contoso.crm.dynamics.com', 'GET', 'WhoAmI', null, {
    token: 'tok-abc',
    getToken: () => { cliCalls += 1; return 'tok-from-cli'; },
    request: async ({ headers }) => { sentAuth = headers.Authorization; return { statusCode: 200, body: '{}' }; },
  });
  assert.strictEqual(cliCalls, 0, 'a preset token must skip `az account get-access-token` altogether');
  assert.strictEqual(sentAuth, 'Bearer tok-abc');
  assert.strictEqual(res.status, 200);

  // Counterfactual: with no preset token it still acquires one, or the seam would have broken the
  // normal path while looking green.
  cliCalls = 0;
  await dataverseRequest('https://contoso.crm.dynamics.com', 'GET', 'WhoAmI', null, {
    getToken: () => { cliCalls += 1; return 'tok-from-cli'; },
    request: async ({ headers }) => { sentAuth = headers.Authorization; return { statusCode: 200, body: '{}' }; },
  });
  assert.strictEqual(cliCalls, 1);
  assert.strictEqual(sentAuth, 'Bearer tok-from-cli');
});

test('a path-bearing or query-bearing env is refused, not silently trimmed to its origin', async () => {
  // `dataverseRequest` appends `/api/data/...` to whatever it is given, so a trimmed
  // `https://org.crm.dynamics.com/some/path` would probe `.../some/path/api/data/...` and report a
  // result about a URL nobody asked for. This function decides where a bearer token may be sent, so
  // "close enough" is the wrong disposition.
  for (const bad of [
    'https://contoso.crm.dynamics.com/some/path',
    'https://contoso.crm.dynamics.com/?q=1',
    'https://contoso.crm.dynamics.com/#frag',
  ]) {
    let tokenAsked = 0;
    let requested = 0;
    const r = await preflightAuth(bad, {
      getToken: () => { tokenAsked += 1; return 'token'; },
      request: async () => { requested += 1; return { status: 200, data: {} }; },
      azIdentity: () => ({ user: 'maker@contoso.com', tenantId: 't' }),
    });
    assert.strictEqual(r.ok, false, `${bad} must be refused: ${JSON.stringify(r)}`);
    assert.match(r.error, /ORIGIN/, r.error);
    assert.strictEqual(tokenAsked, 0, `${bad}: no token may be acquired for a rejected target`);
    assert.strictEqual(requested, 0, `${bad}: and nothing may be sent`);
  }
  // Counterfactual: a bare origin, and an origin with only a trailing slash, are both fine.
  for (const good of ['https://contoso.crm.dynamics.com', 'https://contoso.crm.dynamics.com/']) {
    const r = await preflightAuth(good, {
      getToken: () => 'token',
      request: async () => ({ status: 200, data: { UserId: 'u' } }),
      azIdentity: () => ({ user: 'maker@contoso.com', tenantId: 't' }),
    });
    assert.strictEqual(r.ok, true, `${good} must be accepted: ${JSON.stringify(r)}`);
  }
});

// --- emitResult: a single explained failure must not be dressed as a partial one -----------------
test('both CLIs report an auth-preflight failure with the SAME payload shape', () => {
  // `emitResult` reserves `errors: [...]` for a genuine PARTIAL failure and summarises it as a COUNT.
  // `build-model-app.js` wrapped its single preflight message in that array while
  // `download-model-app.js` passed it as `error`, so the two sibling CLIs printed different things
  // for the identical failure — and the one users hit on an apply printed the count, replacing a
  // message written specifically to say which identity to sign in as.
  //
  // Asserted on the SOURCE because the alternative is spawning both CLIs against a live tenant.
  const fs = require('node:fs');
  const path = require('node:path');
  for (const cli of ['build-model-app.js', 'download-model-app.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', cli), 'utf8');
    const line = src.split('\n').find((l) => /emitResult\(false,.*auth\.error/.test(l));
    assert.ok(line, `${cli}: expected an emitResult call carrying auth.error`);
    assert.match(line, /error:\s*auth\.error/, `${cli}: a single explained failure must use \`error\`: ${line.trim()}`);
    assert.doesNotMatch(line, /errors:\s*\[/, `${cli}: \`errors: [...]\` is for PARTIAL failures and prints only a count: ${line.trim()}`);
  }
});

test('emitResult prints a single error message instead of "unknown error(s)"', () => {
  // The auth preflight, the app-id resolver and friends all fail with { ok:false, error:"<what to
  // do>" } and no `errors` array. The old branch printed "Operation completed with unknown error(s)"
  // for every one of them — burying a message written specifically to tell the operator what to do,
  // under boilerplate that is also untrue: nothing completed, and it is not unknown.
  const { emitResult } = require('../lib/dataverse-auth.js');
  const run = (payload) => {
    const out = [];
    const err = [];
    const so = process.stdout.write;
    const se = process.stderr.write;
    const ex = process.exit;
    process.stdout.write = (s) => { out.push(String(s)); return true; };
    process.stderr.write = (s) => { err.push(String(s)); return true; };
    // `emitResult` ends the process by contract, so the exit is turned into a throw and swallowed.
    process.exit = () => { throw new Error('__exit__'); };
    try { emitResult(false, payload); } catch (e) { if (e.message !== '__exit__') throw e; } finally {
      process.stdout.write = so; process.stderr.write = se; process.exit = ex;
    }
    return { out: out.join(''), err: err.join('') };
  };

  const single = run({ ok: false, error: 'no Azure CLI access token could be obtained; run az login' });
  assert.match(single.err, /run az login/, 'the actionable message must reach stderr');
  assert.doesNotMatch(single.err, /unknown error/, 'and must not be replaced by boilerplate');
  assert.match(single.out, /"ok":false/, 'the structured payload still goes to stdout for callers');

  // The genuine PARTIAL-failure contract is unchanged: a count, with the detail on stdout.
  const partial = run({ ok: false, errors: [{ row: 1 }, { row: 2 }] });
  assert.match(partial.err, /completed with 2 error\(s\)/, partial.err);

  // Neither shape: say so honestly rather than claiming a count we do not have.
  const opaque = run({ ok: false });
  assert.match(opaque.err, /unstructured error/, opaque.err);
  assert.doesNotMatch(opaque.err, /completed with/, 'nothing completed');
});

test('AB#6686427: the preflight HANDS its token to the request instead of fetching a second one', async () => {
  // `preflightAuth` deliberately acquires a token itself so it can tell "not signed in" apart from
  // "signed in but rejected" — two different diagnoses with two different fixes. Without passing it
  // on, `dataverseRequest` shells out to `az account get-access-token` again for the same origin,
  // and that call cold-starts the Azure CLI's Python runtime: seconds, on a path a user waits on.
  let tokenCalls = 0;
  let sawToken;
  const r = await preflightAuth('https://contoso.crm.dynamics.com', {
    getToken: () => { tokenCalls += 1; return 'tok-abc'; },
    request: async (_url, _m, _p, _b, opts) => { sawToken = opts && opts.token; return { status: 200, data: { UserId: 'u' } }; },
    azIdentity: () => ({ user: 'maker@contoso.com', tenantId: 'aaaaaaaa-0000-0000-0000-000000000000' }),
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(tokenCalls, 1, 'exactly one token acquisition');
  assert.strictEqual(sawToken, 'tok-abc', 'and the SAME token must reach the request');
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

test('AB#6686427: a non-401 failure is INCONCLUSIVE, not a block and not a tenant mismatch', async () => {
  // A 403 is a real privilege problem and a 500 is the service; blaming the az tenant for either
  // would send the user down exactly the wrong path — the mirror of the bug being fixed.
  //
  // They must also NOT BLOCK. This probe goes through `dataverseRequest`, which retries fewer
  // statuses and fewer times than the `createAzHttpClient` the real download uses (that one also
  // retries 504). A transient 5xx the download would have ridden out must not be turned into a hard
  // failure by a diagnostic sitting in front of it. Found in review.
  for (const status of [403, 429, 500, 504]) {
    const r = await preflightAuth('https://contoso.crm.dynamics.com', {
      getToken: () => 'token',
      request: async () => ({ status, data: { error: { message: 'upstream detail' } } }),
      azIdentity: () => ({ user: 'maker@contoso.com', tenantId: 'aaaa' }),
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.inconclusive, true, `${status} must be inconclusive, never blocking`);
    assert.doesNotMatch(r.error, /az login --tenant/, `${status} must not be blamed on the az tenant`);
    assert.match(r.error, /upstream detail/, 'the server message explains a 403 and must survive');
  }
});

test('AB#6686427: a non-HTTPS or malformed env is refused BEFORE any token is acquired', async () => {
  // The preflight runs ahead of createAzHttpClient's credential boundary and goes through
  // dataverseRequest, whose transport falls back to plain `http` for a non-HTTPS scheme. Without
  // this gate a malformed --env could put a bearer token on the wire in clear text. Found in review.
  for (const bad of ['http://contoso.crm.dynamics.com', 'not-a-url', 'ftp://x/y', '']) {
    let tokenAsked = 0;
    const r = await preflightAuth(bad, {
      getToken: () => { tokenAsked++; return 'token'; },
      request: async () => { throw new Error('must not reach the wire'); },
      azIdentity: () => null,
    });
    assert.strictEqual(r.ok, false, `${bad} must be refused`);
    assert.strictEqual(r.inconclusive, undefined, 'a bad target is definitive, not inconclusive');
    assert.strictEqual(tokenAsked, 0, `no token may be acquired for ${bad}`);
    assert.match(r.error, /https/i);
  }
});

test('AB#6686427: a CLAIMS CHALLENGE 401 is not blamed on the tenant', async () => {
  // Conditional Access / CAE answer 401 with `WWW-Authenticate: ... error="insufficient_claims"`,
  // and `az login --tenant` does not fix it. Asserting tenant divergence as a certainty would be the
  // same misattribution this bug is about, pointed somewhere new. Found in review.
  const r = await preflightAuth('https://contoso.crm.dynamics.com', {
    getToken: () => 'token',
    request: async () => ({ status: 401, data: null, headers: { 'www-authenticate': 'Bearer error="insufficient_claims", claims="eyJ..."' } }),
    azIdentity: () => ({ user: 'maker@contoso.com', tenantId: 'aaaa' }),
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /claims/i);
  assert.doesNotMatch(r.error, /az login --tenant/, 'a claims challenge is not a tenant problem');
});

test('AB#6686427: the happy path does not shell out to az for an identity nobody asked for', async () => {
  // The caller only reads `auth.ok`; paying for an `az account show` subprocess on every successful
  // run is pure cost. Found in review.
  let idReads = 0;
  const r = await preflightAuth('https://contoso.crm.dynamics.com', {
    getToken: () => 'token',
    request: async () => ({ status: 200, data: { UserId: 'u' } }),
    azIdentity: () => { idReads++; return { user: 'maker@contoso.com', tenantId: 'aaaa' }; },
  });
  assert.strictEqual(r.ok, true);
  assert.ok(idReads <= 1, `identity read at most once on success, got ${idReads}`);
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

test('AB#6686424: a bodyless error does not print "null" as the server message', () => {
  // Found by LIVE verification, not by the unit fixtures: a real Dataverse 401 often carries no body
  // at all, so `data` is null and the message read "HTTP 401 — null". Every unit fixture supplied a
  // message, so nothing caught it.
  const { ensureOk } = require('../lib/dataverse-auth.js');
  for (const [status, data] of [[401, null], [500, null], [404, undefined]]) {
    assert.throws(
      () => ensureOk({ status, data }, 'ctx', { azIdentity: () => null }),
      (e) => {
        assert.doesNotMatch(e.message, /— null|— undefined/, `${status} must not print a bare null: ${e.message}`);
        assert.match(e.message, /no response body/);
        return true;
      }
    );
  }
});
