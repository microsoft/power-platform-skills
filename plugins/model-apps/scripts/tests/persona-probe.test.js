'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { planProbes, interpretOutcome, summarize, isMutating } = require('../lib/persona-probe.js');

// A two-persona spec: Dispatcher touches workorder + technician, Technician only workorder.
// That asymmetry is what makes the negative probes meaningful.
function spec() {
  return {
    personas: [
      {
        persona: 'Dispatcher',
        jobs: [
          { name: 'Assign work', privileges: [
            { entity: 'co_workorder', access: ['read', 'write'], scope: 'businessUnit' },
            { entity: 'co_technician', access: ['read'], scope: 'organization' },
          ] },
        ],
      },
      {
        persona: 'Technician',
        jobs: [
          { name: 'Do work', privileges: [
            { entity: 'co_workorder', access: ['read'], scope: 'user' },
          ] },
        ],
      },
    ],
  };
}

const find = (probes, persona, entity, expect) =>
  probes.find((p) => p.persona === persona && p.entity === entity && p.expect === expect);

test('plans an allow probe for each declared read privilege', () => {
  const { probes } = planProbes(spec());
  assert.ok(find(probes, 'Dispatcher', 'co_workorder', 'allow'), 'dispatcher workorder read');
  assert.ok(find(probes, 'Dispatcher', 'co_technician', 'allow'), 'dispatcher technician read');
  assert.ok(find(probes, 'Technician', 'co_workorder', 'allow'), 'technician workorder read');
});

test('plans a DENY probe for an entity another persona declares but this one does not', () => {
  // The whole point: Technician never declares co_technician, so it must not be readable.
  const { probes } = planProbes(spec());
  const deny = find(probes, 'Technician', 'co_technician', 'deny');
  assert.ok(deny, 'expected a deny probe for Technician -> co_technician');
  assert.strictEqual(deny.access, 'read');
  assert.match(deny.reason, /another persona declares/);
});

test('never plans a deny probe for an entity the persona DOES declare', () => {
  const { probes } = planProbes(spec());
  assert.strictEqual(find(probes, 'Dispatcher', 'co_workorder', 'deny'), undefined);
  assert.strictEqual(find(probes, 'Technician', 'co_workorder', 'deny'), undefined);
});

test('never plans a deny probe for appmodule', () => {
  // The build injects appmodule read for every persona, so a negative result would be a false
  // finding on every single run.
  const { probes } = planProbes(spec());
  assert.strictEqual(probes.some((p) => p.entity === 'appmodule' && p.expect === 'deny'), false);
});

test('mutating privileges are planned only when opted in', () => {
  const readOnly = planProbes(spec());
  assert.strictEqual(readOnly.probes.some((p) => p.mutating), false, 'read-only run must plan no mutations');
  assert.match(readOnly.warnings.join(' '), /were NOT probed/);
  // The warning must not claim a plan existed — in a read-only run these are never turned into
  // probes at all, and "planned but not executed" misdescribes that to an operator.
  assert.doesNotMatch(readOnly.warnings.join(' '), /planned/i);

  const withMutations = planProbes(spec(), { includeMutations: true });
  const write = withMutations.probes.find((p) => p.entity === 'co_workorder' && p.access === 'write');
  assert.ok(write, 'expected the declared write privilege to be planned');
  assert.strictEqual(write.mutating, true);
});

test('a spec with no personas warns instead of throwing', () => {
  const r = planProbes({ personas: [] });
  assert.deepStrictEqual(r.probes, []);
  assert.match(r.warnings.join(' '), /no personas/);
});

test('isMutating classifies the access tokens', () => {
  assert.strictEqual(isMutating('read'), false);
  for (const a of ['create', 'write', 'delete', 'append', 'appendTo', 'assign', 'share']) {
    assert.strictEqual(isMutating(a), true, `${a} should be mutating`);
  }
});

// ── interpretOutcome ─────────────────────────────────────────────────────────────────────────────

const allow = { persona: 'P', entity: 'e', access: 'read', expect: 'allow' };
const deny = { persona: 'P', entity: 'e', access: 'read', expect: 'deny' };

test('allow: 2xx passes, 403 fails', () => {
  assert.strictEqual(interpretOutcome(allow, { status: 200, rowCount: 3 }).result, 'pass');
  assert.strictEqual(interpretOutcome(allow, { status: 403 }).result, 'fail');
});

test('allow: an empty 200 still passes — a scoped read legitimately sees nothing', () => {
  const f = interpretOutcome(allow, { status: 200, rowCount: 0 });
  assert.strictEqual(f.result, 'pass');
  assert.match(f.detail, /no rows visible/);
});

test('deny: 403 passes, visible rows fail', () => {
  assert.strictEqual(interpretOutcome(deny, { status: 403 }).result, 'pass');
  const f = interpretOutcome(deny, { status: 200, rowCount: 2 });
  assert.strictEqual(f.result, 'fail');
  assert.match(f.detail, /broader than the spec/);
});

test('deny: an EMPTY 200 is inconclusive, never a pass', () => {
  // The trap this guards: "denied by scope" and "authorized but the table is empty" are the same
  // response. Calling it a pass would manufacture confidence in the one direction that matters.
  const f = interpretOutcome(deny, { status: 200, rowCount: 0 });
  assert.strictEqual(f.result, 'inconclusive');
  assert.match(f.detail, /cannot distinguish/);
});

test('401 is inconclusive on both directions — it is an auth problem, not a role finding', () => {
  assert.strictEqual(interpretOutcome(allow, { status: 401 }).result, 'inconclusive');
  assert.strictEqual(interpretOutcome(deny, { status: 401 }).result, 'inconclusive');
});

test('a transport failure with no status is inconclusive, not a fail', () => {
  const f = interpretOutcome(allow, { status: null, error: 'ETIMEDOUT' });
  assert.strictEqual(f.result, 'inconclusive');
  assert.match(f.detail, /ETIMEDOUT/);
});

test('allow: 404 fails — the entity set is not reachable for this persona', () => {
  assert.strictEqual(interpretOutcome(allow, { status: 404 }).result, 'fail');
});

// ── summarize ────────────────────────────────────────────────────────────────────────────────────

test('summarize fails only on failures, but still surfaces inconclusives', () => {
  const s = summarize([
    { result: 'pass' }, { result: 'pass' }, { result: 'inconclusive' },
  ]);
  assert.strictEqual(s.ok, true, 'inconclusive alone must not fail the run');
  assert.strictEqual(s.counts.inconclusive, 1);
  assert.strictEqual(s.inconclusive.length, 1);

  const bad = summarize([{ result: 'pass' }, { result: 'fail' }]);
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.failures.length, 1);
});

test('summarize counts every result so an all-inconclusive run cannot look clean', () => {
  const s = summarize([{ result: 'inconclusive' }, { result: 'inconclusive' }]);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.counts.pass, 0);
  assert.strictEqual(s.total, 2);
  assert.strictEqual(s.inconclusive.length, 2, 'caller can see the run proved nothing');
});

// ── executeProbes ────────────────────────────────────────────────────────────────────────────────

const { executeProbes } = require('../lib/persona-probe.js');

function io(overrides = {}) {
  return {
    principalFor: () => ({ header: 'MSCRMCallerID', value: 'user-1' }),
    entitySetName: async (e) => `${e}s`,
    readOne: async () => ({ status: 200, rowCount: 1 }),
    ...overrides,
  };
}

const oneAllow = [{ persona: 'P', entity: 'co_workorder', access: 'read', expect: 'allow' }];

test('executeProbes sends the impersonation header for the persona', async () => {
  const calls = [];
  await executeProbes(oneAllow, io({ readOne: async (set, headers) => { calls.push({ set, headers }); return { status: 200, rowCount: 1 }; } }));
  assert.strictEqual(calls[0].set, 'co_workorders');
  assert.deepStrictEqual(calls[0].headers, { MSCRMCallerID: 'user-1' });
});

test('executeProbes uses CallerObjectId when the principal supplies it', async () => {
  const calls = [];
  await executeProbes(oneAllow, io({
    principalFor: () => ({ header: 'CallerObjectId', value: 'entra-oid' }),
    readOne: async (set, headers) => { calls.push(headers); return { status: 200, rowCount: 1 }; },
  }));
  assert.deepStrictEqual(calls[0], { CallerObjectId: 'entra-oid' });
});

test('a persona with no test user is inconclusive, never a failure', async () => {
  // Reporting "no test user" as a role failure would send the operator to edit a security role that
  // is probably fine.
  const f = await executeProbes(oneAllow, io({ principalFor: () => null }));
  assert.strictEqual(f[0].result, 'inconclusive');
  assert.match(f[0].detail, /no test user/);
});

test('an unresolvable entity set is inconclusive', async () => {
  const f = await executeProbes(oneAllow, io({ entitySetName: async () => null }));
  assert.strictEqual(f[0].result, 'inconclusive');
  assert.match(f[0].detail, /entity set name/);
});

test('a throwing entitySetName is contained, not propagated', async () => {
  const f = await executeProbes(oneAllow, io({ entitySetName: async () => { throw new Error('metadata boom'); } }));
  assert.strictEqual(f[0].result, 'inconclusive');
});

test('a throwing readOne becomes an inconclusive finding carrying the message', async () => {
  const f = await executeProbes(oneAllow, io({ readOne: async () => { throw new Error('ECONNRESET'); } }));
  assert.strictEqual(f[0].result, 'inconclusive');
  assert.match(f[0].detail, /ECONNRESET/);
});

test('entity-set and principal lookups are cached across probes', async () => {
  // The negative probes are O(personas x entities), so an uncached metadata read per probe would
  // multiply the run time for no benefit.
  let setLookups = 0;
  let principalLookups = 0;
  const probes = [
    { persona: 'P', entity: 'co_workorder', access: 'read', expect: 'allow' },
    { persona: 'P', entity: 'co_workorder', access: 'read', expect: 'deny' },
    { persona: 'P', entity: 'co_workorder', access: 'read', expect: 'allow' },
  ];
  await executeProbes(probes, io({
    entitySetName: async (e) => { setLookups++; return `${e}s`; },
    principalFor: () => { principalLookups++; return { header: 'MSCRMCallerID', value: 'u' }; },
  }));
  assert.strictEqual(setLookups, 1, 'entity set resolved once');
  assert.strictEqual(principalLookups, 1, 'principal resolved once per persona');
});

test('executeProbes returns one finding per probe, in order', async () => {
  const probes = [
    { persona: 'P', entity: 'a', access: 'read', expect: 'allow' },
    { persona: 'P', entity: 'b', access: 'read', expect: 'deny' },
  ];
  const f = await executeProbes(probes, io({ readOne: async (set) => (set === 'as' ? { status: 200, rowCount: 1 } : { status: 403 }) }));
  assert.strictEqual(f.length, 2);
  assert.strictEqual(f[0].result, 'pass');
  assert.strictEqual(f[1].result, 'pass');
  assert.strictEqual(f[1].probe.entity, 'b');
});

// ── probe-persona CLI seams ──────────────────────────────────────────────────────────────────────

const { checkImpersonation, makePrincipalResolver } = require('../probe-persona.js');

const ROOT = 'https://contoso.crm.dynamics.com/api/data/v9.2';

function httpStub(responses) {
  const calls = [];
  return {
    calls,
    get: async (url, options) => {
      calls.push({ url, headers: (options && options.headers) || null });
      const r = responses.shift();
      if (typeof r === 'function') return r();
      return r;
    },
  };
}

test('checkImpersonation passes when the effective user differs from the caller', async () => {
  const http = httpStub([
    { status: 200, body: { UserId: 'CALLER-1' } },
    { status: 200, body: { UserId: 'TARGET-9' } },
  ]);
  const r = await checkImpersonation(http, ROOT, 'MSCRMCallerID', 'target-9');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(http.calls[1].headers, { MSCRMCallerID: 'target-9' });
});

test('checkImpersonation FAILS when the header is accepted but ignored', async () => {
  // The most dangerous failure mode for this tool: the run would execute entirely as the signed-in
  // System Administrator, every allow-probe would pass, and the report would look authoritative
  // while proving nothing at all.
  const http = httpStub([
    { status: 200, body: { UserId: 'CALLER-1' } },
    { status: 200, body: { UserId: 'caller-1' } }, // same user, different casing
  ]);
  const r = await checkImpersonation(http, ROOT, 'CallerObjectId', 'oid-9', 'target-9');
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /accepted but IGNORED/);
});

test('checkImpersonation PASSES when the persona test user IS the signed-in user', async () => {
  // A persona whose test user is the caller is a legitimate configuration — a single-account dev
  // environment, or an admin validating their own persona. Judging the header purely by
  // "effective == caller" false-fails that setup and blocks the tool for no reason. The target
  // systemuserid is the real oracle, and it is always known because assignTo.users[] carries it.
  const http = httpStub([
    { status: 200, body: { UserId: 'CALLER-1' } },
    { status: 200, body: { UserId: 'CALLER-1' } },
  ]);
  const r = await checkImpersonation(http, ROOT, 'MSCRMCallerID', 'caller-1', 'caller-1');
  assert.strictEqual(r.ok, true, 'impersonating yourself is valid, not a dropped header');
  assert.strictEqual(r.effectiveId, 'caller-1');
});

test('checkImpersonation FAILS when the effective user is neither the caller nor the target', async () => {
  const http = httpStub([
    { status: 200, body: { UserId: 'CALLER-1' } },
    { status: 200, body: { UserId: 'SOMEONE-ELSE' } },
  ]);
  const r = await checkImpersonation(http, ROOT, 'MSCRMCallerID', 'target-9', 'target-9');
  assert.strictEqual(r.ok, false, 'probes would describe the wrong user');
  assert.match(r.detail, /unexpected principal/);
});

test('checkImpersonation reports the missing privilege on a 403', async () => {
  const http = httpStub([
    { status: 200, body: { UserId: 'CALLER-1' } },
    { status: 403 },
  ]);
  const r = await checkImpersonation(http, ROOT, 'MSCRMCallerID', 'target-9');
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /prvActOnBehalfOfAnotherUser/);
  assert.match(r.detail, /DIRECTLY/);
});

test('checkImpersonation fails clearly when the plain WhoAmI fails', async () => {
  const http = httpStub([{ status: 401 }]);
  const r = await checkImpersonation(http, ROOT, 'MSCRMCallerID', 'target-9');
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /az login/);
});

test('principal resolver prefers CallerObjectId when an object id is known', async () => {
  const s = { personas: [{ persona: 'Dispatcher', assignTo: { users: ['USER-1'] } }] };
  const cache = new Map([['user-1', 'entra-oid-1']]);
  const resolve = makePrincipalResolver(s, null, cache);
  assert.deepStrictEqual(resolve('Dispatcher'), { header: 'CallerObjectId', value: 'entra-oid-1', systemUserId: 'USER-1' });
});

test('principal resolver falls back to MSCRMCallerID with the systemuserid', async () => {
  // assignTo.users[] already holds systemuserid GUIDs, so this path needs no directory lookup.
  const s = { personas: [{ persona: 'Dispatcher', assignTo: { users: ['user-1'] } }] };
  const resolve = makePrincipalResolver(s, null, new Map());
  assert.deepStrictEqual(resolve('Dispatcher'), { header: 'MSCRMCallerID', value: 'user-1', systemUserId: 'user-1' });
});

test('the resolver always carries a systemUserId, even under CallerObjectId', async () => {
  // The canary compares WhoAmI().UserId (a systemuserid) to the target. Under CallerObjectId the
  // header value is an Entra object id, which is NOT comparable — so the systemuserid must travel
  // alongside it or the canary loses its only reliable oracle.
  const s = { personas: [{ persona: 'D', assignTo: { users: ['USER-1'] } }] };
  for (const cache of [new Map([['user-1', 'entra-oid-1']]), new Map()]) {
    const p = makePrincipalResolver(s, null, cache)('D');
    assert.ok(p.systemUserId, `${p.header} must still carry the systemuserid`);
    assert.strictEqual(p.systemUserId.toLowerCase(), 'user-1');
  }
});

test('principal resolver returns null when the persona declares no test user', async () => {
  const s = { personas: [{ persona: 'Dispatcher' }, { persona: 'Tech', assignTo: { users: [] } }] };
  const resolve = makePrincipalResolver(s, null, new Map());
  assert.strictEqual(resolve('Dispatcher'), null);
  assert.strictEqual(resolve('Tech'), null);
  assert.strictEqual(resolve('Nobody'), null);
});

test('a mutating probe is NEVER executed as a read', async () => {
  // Regression guard for a real review finding: executeProbes called readOne for every planned
  // probe, so with --allow-mutations a `write` probe was exercised as a GET and a 200 was reported
  // as PASS — a false pass on the privilege the maker specifically opted in to test.
  const calls = [];
  const probes = [
    { persona: 'P', entity: 'co_workorder', access: 'write', expect: 'allow', mutating: true },
    { persona: 'P', entity: 'co_workorder', access: 'read', expect: 'allow', mutating: false },
  ];
  const f = await executeProbes(probes, io({ readOne: async (set) => { calls.push(set); return { status: 200, rowCount: 1 }; } }));

  assert.strictEqual(calls.length, 1, 'only the read probe may reach the wire');
  assert.strictEqual(f[0].result, 'inconclusive', 'the write probe must not be a pass');
  assert.match(f[0].detail, /cannot be proven by a read/);
  assert.strictEqual(f[1].result, 'pass');
});

test('a mutating probe does not even resolve a principal or entity set', async () => {
  // It short-circuits before any IO, so --allow-mutations cannot add round trips either.
  let touched = 0;
  const probes = [{ persona: 'P', entity: 'e', access: 'delete', expect: 'allow', mutating: true }];
  const f = await executeProbes(probes, io({
    principalFor: () => { touched++; return { header: 'MSCRMCallerID', value: 'u' }; },
    entitySetName: async () => { touched++; return 'es'; },
    readOne: async () => { touched++; return { status: 200, rowCount: 1 }; },
  }));
  assert.strictEqual(touched, 0, 'no IO for a probe that will not be executed');
  assert.strictEqual(f[0].result, 'inconclusive');
});

test('summarize: an all-mutating run reports zero passes, not success', async () => {
  const probes = [
    { persona: 'P', entity: 'a', access: 'create', expect: 'allow', mutating: true },
    { persona: 'P', entity: 'b', access: 'delete', expect: 'allow', mutating: true },
  ];
  const s = summarize(await executeProbes(probes, io()));
  assert.strictEqual(s.counts.pass, 0);
  assert.strictEqual(s.counts.inconclusive, 2);
  assert.strictEqual(s.ok, true, 'still not a failure — but the caller can see nothing was proven');
});
