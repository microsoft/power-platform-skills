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

// The page checks' slow reads (a `pac` listing, about five seconds, with no timeout of its own) start with the pass. A pass
// that fails must not wait for them: before the pass overlapped its reads, a failing first check threw at once, and a hung
// `pac` could never turn that into a hang.
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
  // The page check is listed late; it starts while an earlier table check is still waiting, and then waits on the pac
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
  const reader = laterCheckFails({ ...base, existenceIds: async () => { await gate; throw new Error('pac could not list the pages'); } }, () => { laterFailed += 1; });
  const pass = verifySpec(richSpec(), reader, { concurrency: 4 }).then(() => ({}), (error) => ({ error }));
  for (let i = 0; i < 300 && !laterFailed; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(laterFailed, 'a check listed after the page check has failed while the page reads are still out');
  for (let i = 0; i < 30; i += 1) await turn();
  open();
  const outcome = await pass;
  assert.match(outcome.error.message, /pac could not list the pages/);

  const oracleReader = laterCheckFails({ ...base, existenceIds: async () => { throw new Error('pac could not list the pages'); } }, () => {});
  const oracle = await verifySpec(richSpec(), oracleReader, { concurrency: 1 }).then(() => ({}), (error) => ({ error }));
  assert.match(oracle.error.message, /pac could not list the pages/, 'one at a time reaches the page check first and throws its failure');
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
// A pass that stops waiting for a page read leaves its pac run going — and, with a batch shim, the shim's process tree —
// and the folder its download writes to. The verify CLI exits the moment the pass throws, so the reader is asked to end
// them first and the pass waits for it.

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

// The reader that does the ending: it owns the pac client and the folders.
function pageReader(genpageCli, options = {}) {
  const sdk = { queryRecords: async (set) => (set === 'appmodule' ? [{ appmoduleid: 'app-1' }] : []), findTables: async () => [] };
  return readerFor(sdk, 'new_app', { genpageCli, ...options });
}

test('endPageReads ends the downloads in flight, removes their folders before it answers, and starts nothing after it', async () => {
  const folders = [];
  let aborted = 0;
  let failDownload;
  const genpageCli = {
    enumerateEnv: async () => ({ ok: true, ids: [] }),
    download: ({ outputDir }) => { folders.push(outputDir); return new Promise((_, reject) => { failDownload = reject; }); },
    // pac settles a moment after it is killed, so the reader has something to wait for.
    abort: () => { aborted += 1; setTimeout(() => failDownload(new Error('pac was ended')), 30); },
  };
  const reader = pageReader(genpageCli);
  const inFlight = reader.pageCode(PAGE_OVERVIEW).catch((error) => error);
  for (let i = 0; i < 200 && !folders.length; i += 1) await turn();
  assert.strictEqual(folders.length, 1, 'the download is out');
  assert.ok(fs.existsSync(folders[0]), 'and its folder exists while pac runs');

  await reader.endPageReads();
  assert.strictEqual(aborted, 1, 'the pac client was told to end its runs');
  assert.ok(!fs.existsSync(folders[0]), 'the folder is gone by the time endPageReads answers');
  assert.match((await inFlight).message, /pac was ended/);

  // Nothing starts afterwards: no download, no folder, no listing.
  const later = await reader.pageCode(PAGE_DETAIL).catch((error) => error);
  assert.match(later.message, /page reads were ended/);
  const batch = await reader.pageCodes([PAGE_OVERVIEW, PAGE_DETAIL]);
  assert.deepStrictEqual([...batch.values()].map((a) => /page reads were ended/.test(a.error && a.error.message)), [true, true], 'a batch is answered as each page\'s own failure');
  await assert.rejects(reader.existenceIds(), /page reads were ended/);
  assert.strictEqual(folders.length, 1, 'no second download was started');
});

test('endPageReads: a download that was waiting for the app id when the reads were ended makes no folder and starts no pac', async () => {
  let downloads = 0;
  let answerAppId;
  const sdk = { queryRecords: (set) => (set === 'appmodule' ? new Promise((resolve) => { answerAppId = () => resolve([{ appmoduleid: 'app-1' }]); }) : Promise.resolve([])), findTables: async () => [] };
  const reader = readerFor(sdk, 'new_app', { genpageCli: { enumerateEnv: async () => ({ ok: true, ids: [] }), download: async () => { downloads += 1; return true; }, abort: () => {} } });
  // The folders this reader makes are watched where it makes them, not by listing the temp directory: other test files, running
  // at the same time, make `verify-page-*` folders there too.
  const madeFolders = [];
  const mkdtempSync = fs.mkdtempSync;
  fs.mkdtempSync = (prefix, ...rest) => { madeFolders.push(String(prefix)); return mkdtempSync.call(fs, prefix, ...rest); };
  let answers;
  try {
    const waiting = reader.pageCodes([PAGE_OVERVIEW, PAGE_DETAIL]);
    for (let i = 0; i < 50 && !answerAppId; i += 1) await turn();
    const ending = reader.endPageReads();
    answerAppId();
    answers = await waiting;
    await ending;
  } finally {
    fs.mkdtempSync = mkdtempSync;
  }
  assert.strictEqual(downloads, 0, 'no pac was started for a pass that had ended');
  assert.deepStrictEqual(madeFolders.filter((prefix) => path.basename(prefix).startsWith('verify-page-')), [], 'and no folder was made');
  assert.ok([...answers.values()].every((a) => a.error), 'every page is answered as a failure of its own');
});

// The reader that was used for the pass that ended its page reads may be used for another: a listing that endPageReads cut short is
// the answer of the pass that ended it, and not one to hand the next.
test('a listing that endPageReads cut short is not what the next pass on the same reader is answered with', async () => {
  let listings = 0;
  let endListing;
  const genpageCli = {
    // The first listing hangs until its client is told to end its runs, as a pac listing does; the next one answers.
    enumerateEnv: () => {
      listings += 1;
      if (listings > 1) return Promise.resolve({ ok: true, ids: [PAGE_OVERVIEW] });
      return new Promise((resolve) => { endListing = () => resolve({ ok: false, ids: [], error: 'pac genpage list (env-wide) was ended: pac was ended' }); });
    },
    abort: () => endListing(),
  };
  const reader = pageReader(genpageCli);
  const cutShort = reader.existenceIds().catch((error) => error);
  await reader.endPageReads();
  assert.match((await cutShort).message, /was ended/, 'the pass that ended it is told so');
  reader.beginVerificationPass();
  assert.deepStrictEqual(await reader.existenceIds(), [PAGE_OVERVIEW], 'the next pass lists again');
  assert.strictEqual(listings, 2);
});

test('the next pass begins with the page reads usable again, and the wait for downloads that cannot be ended is bounded', async () => {
  const code = 'export default function P() { return null; }';
  const genpageCli = {
    enumerateEnv: async () => ({ ok: true, ids: [PAGE_OVERVIEW] }),
    download: async ({ outputDir, pageIds }) => { fs.mkdirSync(path.join(outputDir, pageIds[0]), { recursive: true }); fs.writeFileSync(path.join(outputDir, pageIds[0], 'page.tsx'), code); return true; },
  };
  const reader = pageReader(genpageCli);
  await reader.endPageReads();
  await assert.rejects(reader.pageCode(PAGE_OVERVIEW), /page reads were ended/);
  reader.beginVerificationPass();
  assert.strictEqual(await reader.pageCode(PAGE_OVERVIEW), code, 'a reader may be used for another pass');
  assert.deepStrictEqual(await reader.existenceIds(), [PAGE_OVERVIEW]);

  // A pac client that cannot end its runs (no `abort`) must not hold the pass for ever.
  const stuck = pageReader({ enumerateEnv: async () => ({ ok: true, ids: [] }), download: () => new Promise(() => {}) }, { endWaitMs: 50 });
  stuck.pageCode(PAGE_DETAIL).catch(() => {});
  for (let i = 0; i < 50; i += 1) await turn();
  const startedAt = Date.now();
  await stuck.endPageReads();
  assert.ok(Date.now() - startedAt < 1500, 'it answered after the bound');
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
