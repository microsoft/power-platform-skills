'use strict';

// Verify runs its independent reads side by side. These tests prove three things about that:
//   * the reads really overlap (and stay bounded);
//   * the report is the one the old one-at-a-time run produced, whichever read answers first;
//   * nothing is read twice because two checks happened to ask together, and a failure stays loud.
// `concurrency: 1` is the old run (one read at a time, in the old order) and is the oracle.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifySpec } = require('../lib/verify-spec.js');
const { resolveRoleBusinessUnit } = require('../lib/sdk-build.js');
const { readerFor } = require('../verify-model-app.js');
const { SDK_ROLE_MARKER } = require('../lib/app-spec.js');
const { turn, hash, instrument, callKeys } = require('./helpers/read-probe.js');

// --- a spec and reader that reach most sections of verify ------------------------------------------

const TABLES = ['new_t0', 'new_t1', 'new_t2', 'new_t3', 'new_t4'];
const ROOT_BU = '00000000-0000-4000-8000-0000000000b1';
const PAGE_OVERVIEW = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
const PAGE_DETAIL = '5c0a4889-45fd-46ea-91a8-ff876914d644';
const formId = (table, which) => `${String(TABLES.indexOf(table) + 1).padStart(8, '0')}-0000-4000-8000-00000000000${which}`;
const persona = (name, over = {}) => ({ persona: name, jobs: [{ name: 'work', privileges: [{ entity: 'new_t0', access: ['read'] }] }], ...over });

function richSpec() {
  return {
    solution: { uniqueName: 'verify_checks', publisherPrefix: 'new' },
    app: { name: 'Verify Checks', uniqueName: 'new_verifychecks' },
    schemaVersion: 2,
    entities: TABLES.map((t) => ({ schemaName: t, columns: [{ schemaName: `${t}_a` }, { schemaName: `${t}_b` }] })),
    views: TABLES.map((t) => ({ entity: t, name: `Active ${t}` })),
    charts: TABLES.slice(0, 3).map((t) => ({ entity: t, name: `Chart ${t}` })),
    forms: TABLES.flatMap((t) => [
      { entity: t, name: `${t} Main`, formType: 'Main' },
      { entity: t, name: `${t} Alt`, formType: 'Main' },
    ]),
    relationships: [
      { type: 'OneToMany', referenced: 'new_t0', referencing: 'new_t1', lookup: { schemaName: 'new_T0Id' } },
      { type: 'OneToMany', referenced: 'new_t0', referencing: 'new_t2', lookup: { schemaName: 'new_T0Id' } },
    ],
    commands: [
      { entity: 'new_t0', label: 'Go', library: 'a.js', function: 'A.go' },
      { entity: 'new_t2', label: 'Go', library: 'b.js', function: 'B.go' },
    ],
    businessRules: [{ entity: 'new_t0', name: 'Rule A' }, { entity: 'new_t1', name: 'Rule B' }],
    personas: [persona('Agent'), persona('Dispatcher'), persona('Auditor', { appAccess: false })],
    pages: [
      { key: 'overview', name: 'Overview', navigatesTo: [{ targetKey: 'detail' }], source: { kind: 'tsx', codeFile: 'overview.tsx' } },
      { key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'detail.tsx' } },
    ],
    appShell: {
      areas: [{
        label: 'Main',
        groups: [{
          label: 'G',
          subAreas: [
            ...TABLES.map((t) => ({ entity: t, title: t })),
            { page: 'overview', title: 'Overview' },
            { page: 'detail', title: 'Detail' },
          ],
        }],
      }],
    },
  };
}

function richReader() {
  const sitemap = '<SiteMap><Area><Group>'
    + TABLES.slice(0, 3).map((t) => `<SubArea Entity="${t}"/>`).join('')
    + `<SubArea Id="s1" GenPageId="${PAGE_OVERVIEW}"/><SubArea Id="s2" GenPageId="${PAGE_DETAIL}"/></Group></Area></SiteMap>`;
  return {
    findTable: async (logical) => (logical === 'new_t3' ? null : { logicalName: logical }),
    findColumns: async (logical) => [{ logicalName: `${logical}_a` }],
    queryRecords: async (set, opts = {}) => {
      const filter = String((opts && opts.filter) || '');
      if (set === 'savedquery') return /returnedtypecode eq 'new_t3'/.test(filter) ? [] : [{ savedqueryid: 'sq' }];
      if (set === 'savedqueryvisualization') return /'new_t2'/.test(filter) ? [] : [{ savedqueryvisualizationid: 'sv' }];
      if (set === 'businessunit') return [{ businessunitid: ROOT_BU }];
      if (set === 'role') {
        // A role is found only in the root business unit, as in a real environment.
        if (!filter.includes(`_businessunitid_value eq ${ROOT_BU}`)) return [];
        const name = /name eq '([^']+)'/.exec(filter);
        return name ? [{ roleid: `role-${name[1]}`, description: SDK_ROLE_MARKER, ismanaged: false }] : [];
      }
      if (set === 'workflow') return /Rule A/.test(filter) ? [{ workflowid: 'wf', statecode: 1 }] : [];
      if (set === 'systemform') {
        const byId = /formid eq ([0-9a-fA-F-]{36})/.exec(filter);
        if (byId) return [{ formid: byId[1], name: 'form', objecttypecode: 'x', type: 2 }];
        const entity = /objecttypecode eq '([^']+)'/.exec(filter);
        const name = /name eq '([^']+)'/.exec(filter);
        if (!entity || !name) return [];
        const which = / Main$/.test(name[1].replace(/''/g, "'")) ? 1 : 2;
        return [{ formid: formId(entity[1], which), name: name[1], objecttypecode: entity[1], type: 2 }];
      }
      return [];
    },
    formDefaultState: async (_entity, id) => ({ isDefault: String(id).endsWith('1') }),
    formTopology: async (_entity, id) => `<form><DisplayConditions Order="${String(id).endsWith('1') ? 0 : 1}" FallbackForm="true"><Everyone /></DisplayConditions><tabs /></form>`,
    servedMainForms: async (entity) => [
      { id: formId(entity, 1), name: `${entity} Main` },
      { id: formId(entity, 2), name: `${entity} Alt` },
    ],
    sitemapXml: async () => sitemap,
    entityRelationships: async () => [],
    commandBar: async (entity) => entity !== 'new_t2',
    appRoleIds: async () => ({ ok: true, roleIds: ['role-Agent'] }),
    // Every persona holds the same table privilege, so the same two privilege sets are asked for by all of them.
    entityPrivileges: async (entity) => [{ Name: `prvRead${entity}`, PrivilegeId: `${entity}-read`, PrivilegeType: 'Read' }],
    rolePrivileges: async () => [{ privilegeId: 'new_t0-read', depth: 'Global' }, { privilegeId: 'appmodule-read', depth: 'Global' }],
    appEntityComponents: async () => ({ ok: true, present: TABLES.slice(0, 2) }),
    sitemapPageIds: async () => [PAGE_OVERVIEW, PAGE_DETAIL],
    existenceIds: async () => [PAGE_OVERVIEW, PAGE_DETAIL],
    manifest: async () => ({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: PAGE_OVERVIEW }, { key: 'detail', name: 'Detail', pageId: PAGE_DETAIL }] }),
    pageCode: async (id) => (String(id).toLowerCase() === PAGE_OVERVIEW ? `Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "${PAGE_DETAIL}", data: {} });` : ''),
  };
}

const runRich = (opts, instrumentation) => {
  const probe = instrument(richReader(), instrumentation);
  return verifySpec(richSpec(), probe.read, opts).then((result) => ({ result, stats: probe.stats }));
};

test('the fixture reaches most of verify and reports a mix of passes and failures', async () => {
  const { result } = await runRich({ concurrency: 1 }, { latency: () => 0 });
  const kinds = new Set(result.checks.map((c) => c.kind));
  assert.ok(result.checks.length >= 60, `${result.checks.length} checks`);
  for (const kind of ['entity', 'column', 'view', 'chart', 'form', 'form-default', 'form-default-unique', 'form-order', 'form-order-served', 'relationship', 'command', 'business-rule', 'role', 'role-privileges', 'app-role', 'subarea', 'app-table-component', 'page', 'page-subarea']) {
    assert.ok(kinds.has(kind), `the fixture should produce '${kind}' checks (got ${[...kinds].join(', ')})`);
  }
  assert.ok(result.checks.some((c) => c.present) && result.missing.length > 0, 'some checks pass and some fail');
});

test('independent reads overlap — up to 4 at a time, never more — and one at a time when asked', async () => {
  const wide = await runRich(undefined, { latency: () => 2 });
  assert.strictEqual(wide.stats.maxInFlight, 4, 'the default overlaps four reads');
  const eight = await runRich({ concurrency: 8 }, { latency: () => 2 });
  assert.ok(eight.stats.maxInFlight > 4 && eight.stats.maxInFlight <= 8, `width 8 overlapped ${eight.stats.maxInFlight}`);
  const two = await runRich({ concurrency: 2 }, { latency: () => 2 });
  assert.strictEqual(two.stats.maxInFlight, 2);
  const one = await runRich({ concurrency: 1 }, { latency: () => 2 });
  assert.strictEqual(one.stats.maxInFlight, 1, 'concurrency 1 is the old one-at-a-time run');
});

test('the overlapped run reads exactly what the one-at-a-time run reads and reports the same', async () => {
  const sequential = await runRich({ concurrency: 1 }, { latency: () => 0 });
  const overlapped = await runRich(undefined, { latency: () => 1 });
  assert.deepStrictEqual(callKeys(overlapped.stats), callKeys(sequential.stats), 'same reads, none added and none dropped');
  assert.deepStrictEqual(overlapped.result, sequential.result, 'same report, in the same order');
});

test('the report does not depend on which read answers first (random latencies, several widths)', async () => {
  const baseline = await runRich({ concurrency: 1 }, { latency: () => 0 });
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const latency = (call) => hash(`${seed}:${JSON.stringify([call.name, call.args])}`) % 5;
    for (const concurrency of [2, 3, 4, 7]) {
      const run = await runRich({ concurrency }, { latency });
      assert.deepStrictEqual(run.result, baseline.result, `seed ${seed}, width ${concurrency}`);
      assert.deepStrictEqual(callKeys(run.stats), callKeys(baseline.stats), `seed ${seed}, width ${concurrency}: same reads`);
    }
  }
});

test('the concurrency option must be a positive integer', async () => {
  for (const bad of [0, -1, 1.5, '4', NaN, null]) {
    await assert.rejects(runRich({ concurrency: bad }, { latency: () => 0 }), /verify concurrency must be a positive integer/, String(bad));
  }
  await assert.doesNotReject(runRich({ concurrency: undefined }, { latency: () => 0 }));
});

test('a read that fails ends the run — nothing starts after it — and the failure first in report order is the one thrown', async () => {
  const entities = Array.from({ length: 12 }, (_, i) => ({ schemaName: `new_e${i}`, columns: [] }));
  const spec = { entities, views: [], charts: [], forms: [], appShell: { areas: [] } };
  const run = async (concurrency, failures) => {
    const started = [];
    let startedAtFirstFailure = null;
    const read = {
      findTable: async (logical) => ({ logicalName: logical }),
      findColumns: async (logical) => {
        started.push(logical);
        const failure = failures[logical];
        for (let turns = failure ? failure.turns : 1; turns > 0; turns--) await turn();
        if (failure) {
          if (startedAtFirstFailure === null) startedAtFirstFailure = started.length;
          throw new Error(failure.message);
        }
        return [];
      },
      queryRecords: async () => [],
      sitemapXml: async () => '',
    };
    const outcome = await verifySpec(spec, read, { concurrency }).then((result) => ({ result }), (error) => ({ error }));
    return { ...outcome, started, startedAtFirstFailure };
  };
  // Table 5 fails at once; table 2, earlier in the report, fails a few turns later.
  const failures = { new_e2: { turns: 8, message: 'boom e2' }, new_e5: { turns: 0, message: 'boom e5' } };

  const oracle = await run(1, failures);
  assert.strictEqual(oracle.error.message, 'boom e2', 'one at a time stops at the first failing table');
  assert.deepStrictEqual(oracle.started, ['new_e0', 'new_e1', 'new_e2']);

  const overlapped = await run(4, failures);
  assert.strictEqual(overlapped.error.message, 'boom e2', 'the failure first in report order wins, as it does one at a time');
  assert.strictEqual(overlapped.started.length, overlapped.startedAtFirstFailure, 'no read starts once one has failed');
  assert.ok(overlapped.started.length < entities.length, 'the rest of the run was not started');
});

test('a failure in an earlier section outranks one in a later section that happened sooner', async () => {
  const spec = { entities: [{ schemaName: 'new_e0', columns: [] }], views: [{ entity: 'new_e0', name: 'V' }], charts: [], forms: [], appShell: { areas: [] } };
  const read = {
    findTable: async (logical) => ({ logicalName: logical }),
    findColumns: async () => { for (let i = 0; i < 6; i++) await turn(); throw new Error('entity read failed'); },
    queryRecords: async () => { throw new Error('view read failed'); },
    sitemapXml: async () => '',
  };
  for (const concurrency of [1, 4]) {
    await assert.rejects(verifySpec(spec, read, { concurrency }), /entity read failed/, `width ${concurrency}`);
  }
});

// The page checks' slow reads (the environment's page listing, and every page's source) start with the pass. A pass
// that fails must not wait for them: before the pass overlapped its reads, a failing first check threw at once, and a slow
// read could never turn that into a hang.
const answersWithin = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ waitedMs: ms }), ms);
  promise.then((value) => { clearTimeout(timer); resolve({ value }); }, (error) => { clearTimeout(timer); resolve({ error }); });
});

test('a verify that fails on its first check does not wait for a page read that never answers', async () => {
  const reader = {
    ...richReader(),
    findTable: async () => { throw new Error('the environment could not be read'); },
    existenceIds: () => new Promise(() => {}),
  };
  const outcome = await answersWithin(verifySpec(richSpec(), reader, { concurrency: 4 }), 2000);
  assert.ok(outcome.error, `the pass ended with the check's failure instead of waiting ${outcome.waitedMs} ms for the page read`);
  assert.match(outcome.error.message, /the environment could not be read/);
});

test('a verify whose page check is waiting for a read that never answers still ends when an earlier check fails', async () => {
  // The page check is listed late; it starts while an earlier table check is still waiting, and then waits on the page
  // listing that never answers. When the earlier check fails, the pass must neither wait for that listing nor lose the
  // earlier check's error to it.
  let failEarlier;
  const earlier = new Promise((resolve, reject) => { failEarlier = () => reject(new Error('table new_t4 could not be read')); });
  const base = richReader();
  const sets = [];
  const reader = {
    ...base,
    findTable: (logical) => (logical === 'new_t4' ? earlier : base.findTable(logical)),
    queryRecords: async (set, opts) => { sets.push(set); return base.queryRecords(set, opts); },
    existenceIds: () => new Promise(() => {}),
  };
  const pass = verifySpec(richSpec(), reader, { concurrency: 4 });
  // Every task after the page check (the persona roles, say) has started: so has the page check, and it is waiting.
  for (let i = 0; i < 200 && !sets.includes('role'); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(sets.includes('role'), 'the pass got past the page check');
  failEarlier();
  const outcome = await answersWithin(pass, 2000);
  assert.ok(outcome.error, `the pass ended with the earlier check's failure instead of waiting ${outcome.waitedMs} ms`);
  assert.match(outcome.error.message, /table new_t4 could not be read/);
});

test('a page read that is merely slow is still waited for when nothing has failed', async () => {
  let release;
  const slow = new Promise((resolve) => { release = () => resolve([PAGE_OVERVIEW, PAGE_DETAIL]); });
  const reader = { ...richReader(), existenceIds: () => slow };
  const pass = verifySpec(richSpec(), reader, { concurrency: 4 });
  const early = await answersWithin(pass, 150);
  assert.ok(early.waitedMs, 'the report is not produced before the page checks have their answers');
  release();
  const result = await pass;
  assert.ok(result.checks.some((c) => c.kind === 'page'), 'and once the listing answers, the page checks report');
});

// A check listed after the page check that fails: the persona check reads the reader's `appRoleIds` outside any guard (every
// read there is guarded and reported as a finding), so a reader whose `appRoleIds` throws when it is looked up makes it fail.
// A getter, so that it is the lookup that fails and the reader can still be copied.
const laterCheckFails = (reader, onFail) => Object.defineProperty(reader, 'appRoleIds', { get() { onFail(); throw new Error('a later check failed'); } });

test('a failure in a check listed AFTER the page check does not discard the page check\'s own failure: the earlier one in the report is the one thrown, as one at a time', async () => {
  // A check listed after the page check fails while the page reads are still out, and the page reads then fail too: the page
  // check's failure is the lower-numbered one, so it is the one the pass throws.
  const base = richReader();
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  let laterFailed = 0;
  const reader = laterCheckFails({ ...base, existenceIds: async () => { await gate; throw new Error('the page listing failed'); } }, () => { laterFailed += 1; });
  const pass = verifySpec(richSpec(), reader, { concurrency: 4 }).then(() => ({}), (error) => ({ error }));
  for (let i = 0; i < 300 && !laterFailed; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(laterFailed, 'a check listed after the page check has failed while the page reads are still out');
  for (let i = 0; i < 30; i += 1) await turn();
  open();
  const outcome = await pass;
  assert.match(outcome.error.message, /the page listing failed/);

  const oracleReader = laterCheckFails({ ...base, existenceIds: async () => { throw new Error('the page listing failed'); } }, () => {});
  const oracle = await verifySpec(richSpec(), oracleReader, { concurrency: 1 }).then(() => ({}), (error) => ({ error }));
  assert.match(oracle.error.message, /the page listing failed/, 'one at a time reaches the page check first and throws its failure');
});

test('a failure in a check listed after the page check still waits for the page reads — and throws that failure when the page check itself passes', async () => {
  const base = richReader();
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  let laterFailed = 0;
  let endCalls = 0;
  const reader = laterCheckFails({ ...base, existenceIds: async () => { await gate; return [PAGE_OVERVIEW, PAGE_DETAIL]; }, endPageReads: async () => { endCalls += 1; } }, () => { laterFailed += 1; });
  const pass = verifySpec(richSpec(), reader, { concurrency: 4 }).then(() => ({}), (error) => ({ error }));
  for (let i = 0; i < 300 && !laterFailed; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(laterFailed, 'the later check has failed');
  const early = await answersWithin(pass, 100);
  assert.ok(early.waitedMs, 'the pass is still waiting for the page reads: whether the page check fails is still open');
  open();
  const outcome = await pass;
  assert.match(outcome.error.message, /a later check failed/);
  assert.strictEqual(endCalls, 0, 'nothing was given up on, so there is nothing to end');
});

// --- ending what a pass gave up on ---------------------------------------------------------------------------
// A pass that stops waiting for a page read leaves that read going: a request already sent finishes by itself, and a read still
// to start would begin behind a pass that no longer needs it. The verify CLI exits the moment the pass throws, so the reader is
// asked to end its page reads first — to start no more — and the pass waits for that answer.

test('a pass that gave up on a page read asks the reader to end its page reads, and waits for that before it throws', async () => {
  let started = 0;
  let finished = 0;
  const reader = {
    ...richReader(),
    findTable: async () => { throw new Error('the environment could not be read'); },
    existenceIds: () => new Promise(() => {}),
    endPageReads: async () => { started += 1; for (let i = 0; i < 25; i += 1) await turn(); finished += 1; },
  };
  const outcome = await answersWithin(verifySpec(richSpec(), reader, { concurrency: 4 }), 2000);
  assert.match(outcome.error.message, /the environment could not be read/);
  assert.strictEqual(started, 1, 'asked once');
  assert.strictEqual(finished, 1, 'and the pass did not throw until the reader said it had ended them');
});

test('nothing the reader\'s endPageReads throws replaces the failure that ended the pass', async () => {
  const reader = {
    ...richReader(),
    findTable: async () => { throw new Error('the environment could not be read'); },
    existenceIds: () => new Promise(() => {}),
    endPageReads: async () => { throw new Error('could not end the page reads'); },
  };
  const outcome = await answersWithin(verifySpec(richSpec(), reader, { concurrency: 4 }), 2000);
  assert.match(outcome.error.message, /the environment could not be read/);
});

test('a pass that gave up on nothing does not end the reader\'s page reads — a reader may be used for another pass', async () => {
  let ended = 0;
  const reader = { ...richReader(), endPageReads: async () => { ended += 1; } };
  await verifySpec(richSpec(), reader, { concurrency: 4 });
  await verifySpec(richSpec(), reader, { concurrency: 1 });
  assert.strictEqual(ended, 0);
  // Nor one whose page reads had answered by the time another check failed.
  const answered = { ...reader, findTable: async (logical) => { for (let i = 0; i < 400; i += 1) await turn(); throw new Error(`late failure for ${logical}`); } };
  await assert.rejects(verifySpec(richSpec(), answered, { concurrency: 4 }), /late failure/);
  assert.strictEqual(ended, 0, 'the page reads had answered: nothing was given up on');
});

// The reader that does the ending: it owns the page reads and the memo of the environment's page listing.
function pageReader(genpage, options = {}) {
  const sdk = { queryRecords: async (set) => (set === 'appmodule' ? [{ appmoduleid: 'app-1' }] : []), findTables: async () => [] };
  return readerFor(sdk, 'new_app', { genpage, ...options });
}

test('endPageReads starts nothing after it — no read of a page, no listing — and does not cancel a read in flight on a backend that has no workspace of its own to close', async () => {
  const reads = [];
  let finishRead;
  const genpage = {
    enumerateEnv: async () => ({ ok: true, ids: [] }),
    read: (id) => { reads.push(id); return new Promise((resolve) => { finishRead = () => resolve({ source: `// ${id}` }); }); },
  };
  const reader = pageReader(genpage);
  const inFlight = reader.pageCode(PAGE_OVERVIEW);
  for (let i = 0; i < 200 && !reads.length; i += 1) await turn();
  assert.strictEqual(reads.length, 1, 'the read is out');

  await reader.endPageReads();
  finishRead();
  assert.strictEqual(await inFlight, `// ${PAGE_OVERVIEW}`, 'the read in flight was not cancelled: it is a request, and finishes by itself');

  // Nothing starts afterwards: no read, no listing.
  const later = await reader.pageCode(PAGE_DETAIL).catch((error) => error);
  assert.match(later.message, /page reads were ended/);
  const batch = await reader.pageCodes([PAGE_DETAIL, PAGE_DETAIL.toUpperCase()]);
  assert.deepStrictEqual([...batch.values()].map((a) => /page reads were ended/.test(a.error && a.error.message)), [true], 'a batch is answered as each page\'s own failure');
  await assert.rejects(reader.existenceIds(), /page reads were ended/);
  assert.strictEqual(reads.length, 1, 'no second read was started');
});

// The guarantee the page reads had when each was a process with a folder of its own, and still has: the pass that gave up on a page read does not leave
// the read's workspace behind. A read writes the page — its source included — into the workspace the backend made for it, and is a request, which cannot be
// taken back. So the reader asks the backend to close that workspace: the read still in flight is refused its next write, and the folder is removed (once
// the storage calls under way have settled) before endPageReads answers — a verify CLI that exits right after has left no folder of page sources behind.
test('endPageReads closes and removes the workspace the page reads were writing into before it answers — the read in flight is cut short and cannot put it back — and starts nothing after it', async () => {
  const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
  const { FakeGenPageServer, INSTANCE } = require('./helpers/fake-genpage-server.js');
  const server = new FakeGenPageServer();
  server.seedPage(PAGE_OVERVIEW, { name: 'Overview', source: 'export default function Overview() { return null; }\n' });
  const http = server.http();
  let release;
  let reached;
  const held = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { reached = resolve; });
  // The read stops at the download of the page's source: its workspace exists by then — the SDK is initialized — and the page is not in it yet.
  const gated = { ...http, get: async (url, options) => { if (/\/filecontent\/\$value/.test(url)) { reached(); await held; } return http.get(url, options); } };
  const folders = [];
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: gated, mkdtempSync: (prefix) => { const dir = fs.mkdtempSync(prefix); folders.push(dir); return dir; } });
  const reader = pageReader(genpage);
  try {
    const inFlight = reader.pageCode(PAGE_OVERVIEW).catch((error) => error);
    await arrived;
    assert.strictEqual(folders.length, 1, 'the read made one workspace');
    assert.ok(fs.existsSync(folders[0]), 'and it exists while the read runs');

    await reader.endPageReads();
    assert.ok(!fs.existsSync(folders[0]), 'the workspace is gone by the time endPageReads answers');

    release();
    const outcome = await inFlight;
    assert.ok(outcome instanceof Error, 'the read that was in flight is cut short — it fails instead of finishing');
    for (let i = 0; i < 30; i += 1) await turn();
    assert.ok(!fs.existsSync(folders[0]), 'and nothing it did afterwards put the folder back: no manifest, no page artifact, no page source');

    // Nothing starts afterwards: no read, no listing, no workspace.
    await assert.rejects(reader.pageCode(PAGE_DETAIL), /page reads were ended/);
    await assert.rejects(reader.existenceIds(), /page reads were ended/);
    assert.strictEqual(folders.length, 1, 'no second workspace was made');

    // The backend is not closed by it: the next pass makes a workspace of its own, and the page is read from the server.
    reader.beginVerificationPass();
    assert.strictEqual(await reader.pageCode(PAGE_OVERVIEW), 'export default function Overview() { return null; }\n');
    assert.strictEqual(folders.length, 2, 'the next pass reads through a new workspace');
  } finally {
    await genpage.dispose();
    for (const dir of folders) assert.ok(!fs.existsSync(dir), `${dir} is removed when the owner disposes the backend`);
  }
});

test('endPageReads waits for the backend to close its workspace only for a bounded time, and nothing it throws is the pass\'s failure', { timeout: 30000 }, async () => {
  // A backend that cannot answer must not hold the pass for ever.
  const stuck = pageReader({ enumerateEnv: async () => ({ ok: true, ids: [] }), discardWorkspaces: () => new Promise(() => {}) }, { endWaitMs: 50 });
  const startedAt = Date.now();
  await stuck.endPageReads();
  assert.ok(Date.now() - startedAt < 1500, 'it answered after the bound');
  // A backend that fails to close it is not a reason for the pass to fail with another error.
  await pageReader({ enumerateEnv: async () => ({ ok: true, ids: [] }), discardWorkspaces: () => { throw new Error('the workspace could not be closed'); } }).endPageReads();
  await pageReader({ enumerateEnv: async () => ({ ok: true, ids: [] }), discardWorkspaces: async () => { throw new Error('the workspace could not be closed'); } }).endPageReads();
});

// endPageReads' wait is bounded, so it can give up while the cleanup it started is still waiting on a storage call — and that cleanup goes on. The owner's
// dispose() is verify's last act before the process exits, so it has to JOIN that cleanup: answering while the page's source is still on disk would end the
// process with the source left behind.
test('the final dispose() joins the cleanup a bounded endPageReads left draining — it answers only once the workspace, and the page source in it, are gone', { timeout: 30000 }, async () => {
  const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
  const { createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
  const { FakeGenPageServer, INSTANCE } = require('./helpers/fake-genpage-server.js');
  const server = new FakeGenPageServer();
  server.seedPage(PAGE_OVERVIEW, { name: 'Overview', source: 'export default function Overview() { return null; }\n' });
  let release;
  let reached;
  const held = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { reached = resolve; });
  let stopped = false;
  const folders = [];
  // The write that stores the page's artifact — its source included — has put the file on disk and has not answered yet.
  const stopAtThePageWrite = (dir) => {
    const inner = createNodeWorkspaceStorage(dir);
    const storage = {};
    for (const method of ['readText', 'writeTextAtomic', 'deleteFile', 'deleteByPrefix', 'ensureContainer', 'exists']) {
      if (typeof inner[method] === 'function') storage[method] = (...args) => inner[method](...args);
    }
    storage.writeTextAtomic = async (segments, text) => {
      await inner.writeTextAtomic(segments, text);
      if (!stopped && segments[0] === 'gen-pages') { stopped = true; reached(); await held; }
    };
    return storage;
  };
  const genpage = makeGenpageSdk(INSTANCE, {
    httpClient: server.http(),
    mkdtempSync: (prefix) => { const dir = fs.mkdtempSync(prefix); folders.push(dir); return dir; },
    createStorage: stopAtThePageWrite,
  });
  const reader = pageReader(genpage, { endWaitMs: 20 });
  const reading = reader.pageCode(PAGE_OVERVIEW).catch((error) => error);
  try {
    await arrived;
    await reader.endPageReads();
    const source = path.join(folders[0], 'gen-pages', `${PAGE_OVERVIEW}.json`);
    assert.ok(fs.existsSync(source), 'endPageReads gave up on the cleanup while the page source is on disk');

    let answered = false;
    const disposing = genpage.dispose().then((outcome) => { answered = true; return outcome; });
    for (let i = 0; i < 40; i += 1) await turn();
    assert.strictEqual(answered, false, 'dispose() does not answer while that cleanup is still waiting: it has joined it');
    assert.ok(fs.existsSync(source));

    release();
    assert.deepStrictEqual(await disposing, { left: [] });
    assert.ok(!fs.existsSync(folders[0]), 'the workspace — and the page source in it — is gone when dispose() answers');
  } finally {
    release();
    await reading;
    await genpage.dispose();
    for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The reader that was used for the pass that ended its page reads may be used for another: the listing the ended pass was
// still waiting for is the answer of that pass, and not one to hand the next.
test('a listing the pass that ended its reads was waiting for is not what the next pass on the same reader is answered with', async () => {
  let listings = 0;
  const answers = [];
  const genpage = {
    enumerateEnv: () => {
      listings += 1;
      return new Promise((resolve) => { answers.push(resolve); });
    },
  };
  const reader = pageReader(genpage);
  const first = reader.existenceIds().catch((error) => error);
  for (let i = 0; i < 50 && !answers.length; i += 1) await turn();
  await reader.endPageReads();
  reader.beginVerificationPass();
  const next = reader.existenceIds();
  for (let i = 0; i < 50 && answers.length < 2; i += 1) await turn();
  assert.strictEqual(listings, 2, 'the next pass lists again instead of waiting for the ended pass\'s listing');
  answers[1]({ ok: true, ids: [PAGE_OVERVIEW] });
  answers[0]({ ok: true, ids: ['the-stale-listing'] });
  assert.deepStrictEqual(await next, [PAGE_OVERVIEW]);
  assert.deepStrictEqual(await first, ['the-stale-listing'], 'the ended pass still gets its own answer');
});

test('the next pass begins with the page reads usable again', async () => {
  const code = 'export default function P() { return null; }';
  const genpage = {
    enumerateEnv: async () => ({ ok: true, ids: [PAGE_OVERVIEW] }),
    read: async () => ({ source: code }),
  };
  const reader = pageReader(genpage);
  await reader.endPageReads();
  await assert.rejects(reader.pageCode(PAGE_OVERVIEW), /page reads were ended/);
  reader.beginVerificationPass();
  assert.strictEqual(await reader.pageCode(PAGE_OVERVIEW), code, 'a reader may be used for another pass');
  assert.deepStrictEqual(await reader.existenceIds(), [PAGE_OVERVIEW]);
});

test('a reader with no page backend exposes no page reads at all, so verify fails closed for a page-bearing spec rather than reporting a false pass', () => {
  const reader = pageReader(undefined);
  for (const method of ['existenceIds', 'sitemapPageIds', 'manifest', 'pageCode', 'pageCodes', 'endPageReads']) {
    assert.strictEqual(reader[method], undefined, method);
  }
});

test('the root business unit is read once, and every caller asking at the same time gets it', async () => {
  let reads = 0;
  const lookup = async () => { reads += 1; await turn(); return [{ businessunitid: ROOT_BU }]; };
  const cache = {};
  const together = await Promise.all([
    resolveRoleBusinessUnit(lookup, undefined, cache),
    resolveRoleBusinessUnit(lookup, undefined, cache),
    resolveRoleBusinessUnit(lookup, '', cache),
  ]);
  assert.deepStrictEqual(together, [ROOT_BU, ROOT_BU, ROOT_BU], 'a caller that asks while the lookup is under way must not be told there is no business unit');
  assert.strictEqual(await resolveRoleBusinessUnit(lookup, undefined, cache), ROOT_BU);
  assert.strictEqual(reads, 1);

  // A lookup that fails stays one answer for everyone — unresolved, which callers fail closed on — not a retry per caller.
  let failedReads = 0;
  const failing = async () => { failedReads += 1; await turn(); throw new Error('429 throttled'); };
  const failedCache = {};
  assert.deepStrictEqual(await Promise.all([1, 2, 3].map(() => resolveRoleBusinessUnit(failing, undefined, failedCache))), [null, null, null]);
  assert.strictEqual(failedReads, 1);

  const explicit = '11111111-1111-4111-8111-111111111111';
  assert.strictEqual(await resolveRoleBusinessUnit(failing, explicit, {}), explicit, 'an explicit business unit needs no read');
  assert.strictEqual(failedReads, 1);
});

test('personas verified at the same time all find their roles after one business-unit lookup', async () => {
  const { result, stats } = await runRich(undefined, { latency: () => 2 });
  assert.deepStrictEqual(result.checks.filter((c) => c.kind === 'role').map((c) => [c.name, c.present]), [['Agent', true], ['Dispatcher', true], ['Auditor', true]]);
  assert.strictEqual(stats.calls.filter((c) => c.name === 'queryRecords' && c.args[0] === 'businessunit').length, 1);
});

test('a table\'s privileges are read once per pass, however many personas ask for them', async () => {
  const sequential = await runRich({ concurrency: 1 }, { latency: () => 0 });
  const { result, stats } = await runRich(undefined, { latency: () => 2 });
  const asked = (name) => stats.calls.filter((c) => c.name === name).map((c) => c.args[0]).sort();
  assert.deepStrictEqual(asked('entityPrivileges'), ['appmodule', 'new_t0'], 'five reads before: Agent and Dispatcher each asked for both, Auditor for one');
  assert.deepStrictEqual(asked('rolePrivileges'), ['role-Agent', 'role-Auditor', 'role-Dispatcher']);
  assert.ok(result.checks.filter((c) => c.kind === 'role-privileges').length === 3 && result.checks.filter((c) => c.kind === 'role-privileges').every((c) => c.present));
  assert.deepStrictEqual(result, sequential.result);
});

// --- the reader: the SDK's first read of a table must not be asked for twice ------------------------------

// Models what the vendored SDK does before the first record read of a table: one metadata GET for the table's
// EntitySetName, whose ANSWER (not the request in flight) is cached.
function entitySetCachingSdk({ failFirstRead = new Set() } = {}) {
  const cached = new Set();
  const log = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const sdk = {
    queryRecords: async (set, query) => {
      log.push(['read', set]);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (!cached.has(set)) {
          log.push(['entity-set-name', set]);
          await turn();
          if (failFirstRead.has(set)) { failFirstRead.delete(set); throw new Error(`HTTP 503 resolving ${set}`); }
          cached.add(set);
        }
        await turn();
        return [{ set, query }];
      } finally {
        inFlight -= 1;
      }
    },
    other: () => 'other',
  };
  return { sdk, log, stats: () => ({ maxInFlight }) };
}

test('reads of one table that start together resolve its EntitySetName once; other tables are not held up', async () => {
  const { sdk, log, stats } = entitySetCachingSdk();
  const read = readerFor(sdk, 'new_app', {});
  const answers = await Promise.all([
    read.queryRecords('savedquery', { n: 1 }), read.queryRecords('savedquery', { n: 2 }),
    read.queryRecords('savedquery', { n: 3 }), read.queryRecords('savedquery', { n: 4 }),
    read.queryRecords('role', { n: 5 }), read.queryRecords('role', { n: 6 }),
  ]);
  assert.deepStrictEqual(answers.map((a) => a[0].query.n), [1, 2, 3, 4, 5, 6], 'each read gets its own answer');
  assert.deepStrictEqual(log.filter((e) => e[0] === 'entity-set-name').map((e) => e[1]).sort(), ['role', 'savedquery'], 'one lookup per table, not one per read');
  assert.strictEqual(log.filter((e) => e[0] === 'read').length, 6, 'every read is still made');
  assert.ok(stats().maxInFlight >= 4, 'the later reads of a table overlap once its name is known, and tables overlap each other');
});

test('a first read that fails shares nothing — the next read of the table tries again and reports its own outcome', async () => {
  const { sdk, log } = entitySetCachingSdk({ failFirstRead: new Set(['role']) });
  const read = readerFor(sdk, 'new_app', {});
  const outcomes = await Promise.allSettled([read.queryRecords('role', { n: 1 }), read.queryRecords('role', { n: 2 }), read.queryRecords('role', { n: 3 })]);
  assert.strictEqual(outcomes[0].status, 'rejected');
  assert.match(outcomes[0].reason.message, /HTTP 503 resolving role/);
  assert.strictEqual(outcomes[1].status, 'fulfilled');
  assert.strictEqual(outcomes[2].status, 'fulfilled');
  assert.strictEqual(log.filter((e) => e[0] === 'entity-set-name').length, 2, 'one lookup failed, the next waiting read did it again, the third reused its answer');
});

test('the reader reaches every other SDK member unchanged — methods keep their `this`, properties are the SDK\'s own', async () => {
  class FakeSdk {
    constructor() {
      this.calls = [];
      this.dataverse = { get: async () => ({ status: 200, body: { value: [] } }) };
    }
    async queryRecords(set) { this.calls.push(`query:${set}`); return []; }
    async findColumns(logical) { this.calls.push(`columns:${logical}`); return [{ logicalName: 'a' }]; }
  }
  const sdk = new FakeSdk();
  const read = readerFor(sdk, 'new_app', {});
  assert.deepStrictEqual(await read.findColumns('new_t'), [{ logicalName: 'a' }]);
  await read.queryRecords('role', {});
  await read.queryRecords('role', {});
  assert.deepStrictEqual(sdk.calls, ['columns:new_t', 'query:role', 'query:role'], 'the calls landed on the SDK itself, not on a copy');
});

// --- the real SDK bundle behind the reader ---------------------------------------------------------------

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');

function recordingHttpClient() {
  const gets = [];
  const stats = { inFlight: 0, maxInFlight: 0 };
  const reply = (body) => ({ status: 200, headers: {}, body });
  const httpClient = {
    get: async (url) => {
      gets.push(url);
      stats.inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      try {
        for (let i = 0; i < 3; i++) await turn();
        const decoded = decodeURIComponent(url);
        const meta = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(decoded);
        if (meta) return reply({ LogicalName: meta[1], EntitySetName: `${meta[1]}s` });
        if (/\/businessunits\?/.test(decoded)) return reply({ value: [{ businessunitid: ROOT_BU }] });
        if (/\/roles\?/.test(decoded)) {
          const name = /name eq '([^']+)'/.exec(decoded);
          return reply({ value: name && decoded.includes(`_businessunitid_value eq ${ROOT_BU}`) ? [{ roleid: `role-${name[1]}`, description: SDK_ROLE_MARKER, ismanaged: false }] : [] });
        }
        if (/\/savedquerys\?|\/savedqueryvisualizations\?/.test(decoded)) return reply({ value: [{ savedqueryid: 'sq', savedqueryvisualizationid: 'sv' }] });
        return reply({ value: [] });
      } finally {
        stats.inFlight -= 1;
      }
    },
    post: async () => { throw new Error('verify must not write'); },
    patch: async () => { throw new Error('verify must not write'); },
    put: async () => { throw new Error('verify must not write'); },
    delete: async () => { throw new Error('verify must not write'); },
  };
  return { httpClient, gets, stats };
}

async function verifyThroughRealSdk(concurrency) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-parallel-real-'));
  try {
    const { httpClient, gets, stats } = recordingHttpClient();
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
    await sdk.initWorkspace();
    const spec = {
      solution: { uniqueName: 'verify_checks', publisherPrefix: 'new' },
      app: { name: 'Verify Checks', uniqueName: 'new_verifychecks' },
      entities: [],
      views: TABLES.map((t) => ({ entity: t, name: `Active ${t}` })),
      charts: TABLES.slice(0, 3).map((t) => ({ entity: t, name: `Chart ${t}` })),
      forms: [],
      personas: [persona('Agent'), persona('Dispatcher'), persona('Auditor', { appAccess: false })],
      appShell: { areas: [] },
    };
    const result = await verifySpec(spec, readerFor(sdk, 'new_verifychecks', {}), { concurrency });
    return { result, gets: [...gets].sort(), stats };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('through the real SDK, overlapping reads send the same requests as the one-at-a-time run, EntitySetName included', async () => {
  const sequential = await verifyThroughRealSdk(1);
  const overlapped = await verifyThroughRealSdk(4);
  assert.strictEqual(sequential.stats.maxInFlight, 1);
  assert.ok(overlapped.stats.maxInFlight >= 2 && overlapped.stats.maxInFlight <= 4, `${overlapped.stats.maxInFlight} requests overlapped`);
  assert.deepStrictEqual(overlapped.gets, sequential.gets, 'the same requests, none added by the overlap');
  const nameLookups = overlapped.gets.map((u) => /EntityDefinitions\(LogicalName='([^']+)'\)\?\$select=EntitySetName$/.exec(decodeURIComponent(u))).filter(Boolean).map((m) => m[1]);
  assert.deepStrictEqual(nameLookups, [...new Set(nameLookups)], 'no table\'s EntitySetName was asked for twice');
  assert.ok(nameLookups.includes('savedquery') && nameLookups.includes('role'), 'the tables the checks share were looked up');
  assert.deepStrictEqual(overlapped.result, sequential.result);
  assert.ok(overlapped.result.checks.filter((c) => c.kind === 'role').every((c) => c.present), 'roles are found in the root business unit');
});
