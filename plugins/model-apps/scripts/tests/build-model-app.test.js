'use strict';
// Thin wiring test for build-model-app.js: validation gate, dry-run, and that apply
// threads through to the SDK engine (runSdkBuild). The engine's per-phase behavior is
// covered exhaustively in sdk-build.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { buildModelApp, isTransientHalt } = require(path.join(__dirname, '..', 'build-model-app.js'));

const desk = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'app-spec.support-desk.json'), 'utf8')
);

// Minimal JsonPointer + form-seed helpers so the mock can simulate the SDK's generic mutation
// surface (addElement/updateElement/removeElement/getArtifact) the build engine now uses.
function jpGet(o, p) { let c = o; for (const t of (p === '' ? [] : p.split('/').slice(1))) { if (c == null) return undefined; c = c[t]; } return c; }
function jpSet(o, p, v) { const ts = p.split('/').slice(1); const l = ts.pop(); let c = o; for (const t of ts) c = c[t]; c[l] = v; }
function jpRemove(o, p) { const ts = p.split('/').slice(1); const l = ts.pop(); let c = o; for (const t of ts) c = c[t]; if (Array.isArray(c)) c.splice(Number(l), 1); else delete c[l]; }
const jclone = (v) => JSON.parse(JSON.stringify(v));
function seedForm(id) { return { id, tabs: [{ columns: [{ sections: [{ name: 'section_general', columns: 1, rows: [] }] }] }], bag: { a: [], c: [] } }; }

function mockSdk() {
  const calls = [];
  let idc = 0;
  const store = {};
  const sdk = {
    queryRecords: async (e) => (e === 'solution' ? [] : [{ publisherid: 'pub-1' }]),
    createPublisher: async () => ({ id: 'pub-new' }),
    createSolution: async (o) => { calls.push(['createSolution', o]); return { id: 'sol-1' }; },
    createTable: async (o) => { calls.push(['createTable', o]); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s` }; },
    createColumn: async (e, o) => { calls.push(['createColumn', e, o]); return { logicalName: o.schemaName.toLowerCase() }; },
    createRelationship: async (o) => { calls.push(['createRelationship', o]); return { schemaName: o.schemaName }; },
    findTables: async () => [],
    findColumns: async () => [],
    fetchEntityMetadata: async (l) => ({ logicalName: l, displayName: l, entitySetName: `${l}s`, attributes: [], relationships: [] }),
    createRecordsBulk: async (e, rows) => { calls.push(['createRecordsBulk', e]); return rows.map((_, i) => `${e}-${i}`); },
    seedRecordGraph: async (groups) => { calls.push(['seedRecordGraph', groups]); const createdIds = {}; for (const g of groups) createdIds[g.entityLogical] = g.records.map((_, i) => `${g.entityLogical}-${i}`); return { createdIds }; },
    enrichDefaultViews: async (logical) => { calls.push(['enrichDefaultViews', logical]); return { updated: [`defview-${logical}`] }; },
    createArtifact: (t, def) => {
      calls.push(['createArtifact', t]);
      const id = `${t}-${++idc}`;
      const art = t === 'form' ? Object.assign(seedForm(id), { name: def.name, entityLogicalName: def.entityLogicalName, formType: def.formType, status: def.status })
        : t === 'dashboard' ? Object.assign({ id, components: [] }, def) : Object.assign({ id }, def);
      art.id = id; store[`${t}:${id}`] = art; return jclone(art);
    },
    createWebResource: async (o) => { calls.push(['createWebResource', o.name]); return { id: `wr-${++idc}`, name: o.name }; },
    pushArtifact: async (t, id) => ({ type: t, id, success: true }),
    fetchArtifact: async (t, id) => { if (!store[`${t}:${id}`]) store[`${t}:${id}`] = t === 'form' ? seedForm(id) : t === 'app' ? { id, siteMap: { areas: [] } } : { id, columns: [] }; return store[`${t}:${id}`]; },
    getArtifact: (t, id) => store[`${t}:${id}`] || { id, columns: [] },
    addElement: (t, id, ptr, el) => { const a = store[`${t}:${id}`] || (store[`${t}:${id}`] = { id }); const arr = jpGet(a, ptr); if (Array.isArray(arr)) arr.push(jclone(el)); return jclone(a); },
    updateElement: (t, id, ptr, patch) => { const a = store[`${t}:${id}`] || (store[`${t}:${id}`] = { id }); jpSet(a, ptr, jclone(patch)); return jclone(a); },
    removeElement: (t, id, ptr) => { const a = store[`${t}:${id}`]; if (a) jpRemove(a, ptr); return jclone(a || { id }); },
    updateRecord: async () => undefined,
    addSolutionComponent: async () => undefined,
    publishArtifact: async () => undefined,
    findArtifact: async (kind, identity) => null,
  };
  return { sdk, calls };
}
const logCapture = () => { const logs = []; return { log: (m) => logs.push(m), logs }; };

test('rejects an invalid spec before any build', async () => {
  const { sdk, calls } = mockSdk();
  const r = await buildModelApp({ entities: [] }, { apply: true, env: 'https://x' }, { sdk });
  assert.strictEqual(r.ok, false);
  assert.ok(Array.isArray(r.errors) && r.errors.length);
  assert.strictEqual(calls.length, 0, 'no SDK writes on a bad spec');
});

test('dry-run returns the plan and never touches the SDK', async () => {
  const { sdk, calls } = mockSdk();
  const r = await buildModelApp(desk, { apply: false, env: 'https://x' }, { sdk });
  assert.strictEqual(r.dryRun, true);
  assert.ok(r.plan.some((p) => /solution/.test(p)));
  assert.ok(r.plan.some((p) => /form for/.test(p)));
  assert.strictEqual(calls.length, 0);
});

test('apply threads through to the SDK engine (solution + tables created)', async () => {
  const { sdk, calls } = mockSdk();
  const r = await buildModelApp(desk, { apply: true, env: 'https://x' }, { sdk });
  assert.strictEqual(r.ok, true);
  assert.ok(calls.some((c) => c[0] === 'createSolution'));  assert.ok(calls.filter((c) => c[0] === 'createTable').length >= 1);
});

// R3 — auto-verify after a successful --apply (opt-in; deps.verify injected)
test('auto-verify (opts.verify) runs the injected reconcile and attaches r.verify on pass', async () => {
  const { sdk } = mockSdk();
  let received = null;
  const verify = async (s) => { received = s; return { ok: true, checks: [{ kind: 'entity', name: 'a', present: true }, { kind: 'form', name: 'b', present: true }], missing: [] }; };
  const r = await buildModelApp(desk, { apply: true, env: 'https://x', verify: true }, { sdk, verify });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(received, desk, 'the injected verifier received the spec');
  assert.deepStrictEqual(r.verify, { ok: true, present: 2, total: 2, missing: [] });
});

test('auto-verify surfaces a silent partial build (verify FAIL) in r.verify and the log; the build itself still succeeded', async () => {
  const { sdk } = mockSdk();
  const cap = logCapture();
  const verify = async () => ({ ok: false, checks: [{ kind: 'entity', name: 'a', present: true }, { kind: 'view', name: 'v', present: false }], missing: [{ kind: 'view', name: 'v' }] });
  const r = await buildModelApp(desk, { apply: true, env: 'https://x', verify: true }, { sdk, verify, log: cap.log });
  assert.strictEqual(r.ok, true, 'the build itself succeeded — verify is a separate signal');
  assert.strictEqual(r.verify.ok, false);
  assert.deepStrictEqual(r.verify.missing, ['view:v']);
  assert.ok(cap.logs.some((l) => /verify FAIL/.test(l)), 'the failure is narrated');
  assert.ok(cap.logs.some((l) => /view: v/.test(l)), 'the missing artifact is listed');
});

test('auto-verify is opt-in — no reconcile runs without opts.verify', async () => {
  const { sdk } = mockSdk();
  let called = false;
  const verify = async () => { called = true; return { ok: true, checks: [], missing: [] }; };
  const r = await buildModelApp(desk, { apply: true, env: 'https://x' }, { sdk, verify });
  assert.strictEqual(called, false, 'verify is opt-in via --verify');
  assert.strictEqual(r.verify, undefined);
});

test('a verify that throws is a warning, not a build failure', async () => {
  const { sdk } = mockSdk();
  const cap = logCapture();
  const verify = async () => { throw new Error('reader boom'); };
  const r = await buildModelApp(desk, { apply: true, env: 'https://x', verify: true }, { sdk, verify, log: cap.log });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.verify, undefined, 'no verify result attached when it could not run');
  assert.ok(cap.logs.some((l) => /verify step could not run/.test(l)));
});

test('apply emits one status-marked [n/total] line per step, with phase headers + a summary', async () => {
  const { sdk } = mockSdk();
  const cap = logCapture();
  await buildModelApp(desk, { apply: true, env: 'https://x' }, { sdk, log: cap.log });
  const lines = cap.logs.filter((l) => /\[\d+\/\d+\]/.test(l));
  assert.ok(lines.length >= 6);
  const parse = (l) => l.match(/\[(\d+)\/(\d+)\]/).slice(1, 3).map(Number);
  const totals = new Set(lines.map((l) => parse(l)[1]));
  assert.strictEqual(totals.size, 1, 'one consistent total');
  const total = [...totals][0];
  const ns = lines.map((l) => parse(l)[0]);
  assert.strictEqual(new Set(ns).size, ns.length, 'each step reported exactly once');
  assert.ok(Math.min(...ns) >= 1 && Math.max(...ns) <= total, 'every n within [1,total]');
  assert.ok(cap.logs.some((l) => /✓/.test(l)), 'completed steps are marked ✓');
  assert.ok(cap.logs.some((l) => /▶ /.test(l)), 'phases are grouped under ▶ headers');
  assert.ok(cap.logs.some((l) => /build complete — \d+ created/.test(l)), 'a closing summary is printed');
});

test('dry-run lists the plan grouped by phase with a ▢ marker (no summary)', async () => {
  const { sdk } = mockSdk();
  const cap = logCapture();
  await buildModelApp(desk, { apply: false, env: 'https://x' }, { sdk, log: cap.log });
  assert.ok(cap.logs.some((l) => /▶ /.test(l)), 'plan is grouped under phase headers');
  assert.ok(cap.logs.some((l) => /\[\d+\/\d+\] ▢ /.test(l)), 'plan items use the ▢ marker');
  assert.ok(!cap.logs.some((l) => /build complete/.test(l)), 'no summary on a dry-run');
});

test('--sample-data threads through (records created); without it, none', async () => {
  const withSd = mockSdk();
  await buildModelApp(desk, { apply: true, sampleData: true, env: 'https://x' }, { sdk: withSd.sdk });
  assert.ok(withSd.calls.some((c) => c[0] === 'seedRecordGraph'), 'records seeded with --sample-data');

  const without = mockSdk();
  await buildModelApp(desk, { apply: true, env: 'https://x' }, { sdk: without.sdk });
  assert.ok(!without.calls.some((c) => c[0] === 'seedRecordGraph'), 'no records without --sample-data');
});

test('build journal: tees step events and closes with a completion summary', async () => {
  const { sdk } = mockSdk();
  const events = [];
  let closed = null;
  const journal = { path: 'x', record: (e) => events.push(e), close: (s) => { closed = s; } };
  await buildModelApp(desk, { apply: true, env: 'https://x' }, { sdk, journal });
  assert.ok(events.some((e) => e.status === 'ok'), 'ok steps journaled');
  assert.ok(closed && closed.status === 'complete', 'journal closed with a completion summary');
});

test('build journal: records a halt (with the failing phase) when the build throws', async () => {
  const { sdk } = mockSdk();
  sdk.createTable = async () => { throw new Error('boom'); };
  let closed = null;
  const journal = { path: 'x', record: () => {}, close: (s) => { closed = s; } };
  await assert.rejects(buildModelApp(desk, { apply: true, env: 'https://x' }, { sdk, journal }));
  assert.ok(closed && closed.status === 'halt', 'journal closed with a halt record');
  assert.strictEqual(closed.phase, 'data-model', 'halt records the failing phase');
});

test('isTransientHalt classifies lock/timeout/429/503 as transient, others not', () => {
  assert.ok(isTransientHalt({ cause: { statusCode: 429 } }));
  assert.ok(isTransientHalt({ cause: { statusCode: 503 } }));
  assert.ok(isTransientHalt({ message: 'Microsoft.Crm.ObjectModel.CustomizationLockException: ...' }));
  assert.ok(isTransientHalt({ cause: { message: 'SQL timeout expired' } }));
  assert.ok(isTransientHalt({ message: 'More than one concurrent Delete requests detected' }));
  // recoverable is a re-runnable-phase flag, NOT a transient signal — must not trigger a retry alone.
  assert.ok(!isTransientHalt({ recoverable: true }));
  assert.ok(!isTransientHalt({ message: 'validation failed', cause: { statusCode: 400 } }));
  assert.ok(!isTransientHalt(null));
});

test('transient auto-retry: a transient halt is retried and then succeeds', async () => {
  const { sdk, calls } = mockSdk();
  let firstTable = true;
  const realCreateTable = sdk.createTable;
  sdk.createTable = async (o) => {
    if (firstTable) { firstTable = false; const e = new Error('CustomizationLockException: try again later'); e.recoverable = true; throw e; }
    return realCreateTable(o);
  };
  const events = [];
  const journal = { path: 'x', record: (e) => events.push(e), close: () => {} };
  const r = await buildModelApp(desk, { apply: true, env: 'https://x', retryDelayMs: 0 }, { sdk, journal });
  assert.strictEqual(r.ok, true, 'build succeeded after a retry');
  assert.ok(events.some((e) => e.status === 'retry'), 'a retry was journaled');
  assert.ok(calls.some((c) => c[0] === 'createSolution'), 'the build ran to completion');
});

test('transient auto-retry: a non-transient halt is NOT retried', async () => {
  const { sdk } = mockSdk();
  let attempts = 0;
  sdk.createTable = async () => { attempts += 1; const e = new Error('bad request'); e.recoverable = false; throw e; };
  await assert.rejects(buildModelApp(desk, { apply: true, env: 'https://x', retryDelayMs: 0 }, { sdk }));
  assert.strictEqual(attempts, 1, 'no retry on a non-transient error');
});

test('transient auto-retry: no retries in dry-run', async () => {
  const { sdk } = mockSdk();
  const r = await buildModelApp(desk, { apply: false, env: 'https://x' }, { sdk });
  assert.strictEqual(r.dryRun, true);
});

// Minimal explicit-layout form fixtures for the destructive gate (match formFieldLogicals' walk).
const cell = (fn) => ({ control: { fieldName: fn } });
const formOf = (fields) => ({ tabs: [{ columns: [{ sections: [{ rows: fields.map((f) => ({ cells: [cell(f)] })) }] }] }] });

test('envTruthy: only 1/true (case-insensitive) count as set', () => {
  const { envTruthy } = require(path.join(__dirname, '..', 'build-model-app.js'));
  assert.strictEqual(envTruthy('1'), true);
  assert.strictEqual(envTruthy('true'), true);
  assert.strictEqual(envTruthy('TRUE'), true);
  assert.strictEqual(envTruthy('0'), false);
  assert.strictEqual(envTruthy('yes'), false);
  assert.strictEqual(envTruthy(undefined), false);
  assert.strictEqual(envTruthy(''), false);
});

test('collision gate: a non-interactive run refuses an existing app without --allow-destructive', async () => {
  const { sdk, calls } = mockSdk();
  sdk.queryRecords = async (set) => (set === 'appmodule' ? [{ appmoduleid: 'app-x' }] : set === 'solution' ? [] : [{ publisherid: 'pub-1' }]);
  const r = await buildModelApp(desk, { apply: true, env: 'https://x', retryDelayMs: 0, nonInteractive: true }, { sdk, provisionSdk: sdk });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /allow-destructive/.test(e)), 'halt names --allow-destructive');
  assert.ok(!calls.some((c) => c[0] === 'createSolution'), 'halted before any write');
});

test('collision gate: --allow-destructive lets a non-interactive run proceed to update the app', async () => {
  const { sdk, calls } = mockSdk();
  sdk.queryRecords = async (set) => (set === 'appmodule' ? [{ appmoduleid: 'app-x' }] : set === 'solution' ? [] : [{ publisherid: 'pub-1' }]);
  const r = await buildModelApp(desk, { apply: true, env: 'https://x', retryDelayMs: 0, nonInteractive: true, allowDestructive: true }, { sdk, provisionSdk: sdk });
  assert.notStrictEqual(r.ok, false, 'not halted by the gate');
  assert.ok(calls.some((c) => c[0] === 'createSolution'), 'proceeded past the gate into the build');
});

test('destructive gate: build halts on a form-field removal without --allow-destructive', async () => {
  const { sdk, calls } = mockSdk();
  const def = Object.assign(formOf(['new_name']), { __explicitLayout: true, __primaryField: 'new_name' });
  const deployedForm = formOf(['new_name', 'new_priority']);
  const state = { collision: { appExists: false, solutionExists: false }, forms: [{ label: 'form "Ticket" (new_ticket)', deployedForm, def }], sitemap: null };
  const r = await buildModelApp(desk, { apply: true, env: 'https://x', retryDelayMs: 0 }, { sdk, provisionSdk: sdk, discoverOpDiffState: async () => state });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /allow-destructive/.test(e) && /new_priority/.test(e)), 'names the field it would remove');
  assert.ok(!calls.some((c) => c[0] === 'createSolution'), 'halted before any write');
});

test('destructive gate: --allow-destructive lets the same build proceed', async () => {
  const { sdk, calls } = mockSdk();
  const def = Object.assign(formOf(['new_name']), { __explicitLayout: true, __primaryField: 'new_name' });
  const deployedForm = formOf(['new_name', 'new_priority']);
  const state = { collision: { appExists: false }, forms: [{ label: 'form "Ticket" (new_ticket)', deployedForm, def }], sitemap: null };
  const r = await buildModelApp(desk, { apply: true, env: 'https://x', retryDelayMs: 0, allowDestructive: true }, { sdk, provisionSdk: sdk, discoverOpDiffState: async () => state });
  assert.notStrictEqual(r.ok, false);
  assert.ok(calls.some((c) => c[0] === 'createSolution'), 'proceeded past the gate into the build');
});

test('destructive gate: build halts on a dropped sitemap target without --allow-destructive', async () => {
  // Integration coverage that the sitemap-removal classifier is wired through buildModelApp (op-diff.test
  // covers the classifier in isolation; this proves the gate actually halts the build).
  const { sdk, calls } = mockSdk();
  const state = { collision: { appExists: true, appUnique: 'new_supportdesk' }, forms: [], sitemap: { deployedTargets: ['entity:new_customer', 'entity:new_ticket'], wantTargets: ['entity:new_customer'] } };
  const r = await buildModelApp(desk, { apply: true, env: 'https://x', retryDelayMs: 0, allowDestructive: false }, { sdk, provisionSdk: sdk, discoverOpDiffState: async () => state });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /allow-destructive/.test(e) && /new_ticket/.test(e)), 'names the dropped nav target');
  assert.ok(!calls.some((c) => c[0] === 'createSolution'), 'halted before any write');
});

test('safety gate is FAIL-CLOSED: a discovery error halts the build (no unauthorized write)', async () => {
  // The core fail-closed invariant (design §11): if preflight discovery throws (transient 429/timeout/
  // auth), we cannot verify the apply is non-destructive, so the build must REFUSE to write rather than
  // swallow the error and proceed — which would silently disable the gate exactly when the env is unhealthy.
  const { sdk, calls } = mockSdk();
  const r = await buildModelApp(desk, { apply: true, env: 'https://x', retryDelayMs: 0 }, { sdk, provisionSdk: sdk, discoverOpDiffState: async () => { throw new Error('429 EntityCustomization lock'); } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /could not run/.test(e) && /allow-destructive/.test(e)), 'explains it could not verify safety and names the escape hatch');
  assert.ok(!calls.some((c) => c[0] === 'createSolution'), 'halted before any write');
});

test('safety gate: --allow-destructive lets a build proceed even when discovery fails', async () => {
  // With destruction already authorized, a discovery failure is moot (the gate would not block anything),
  // so the build proceeds rather than being blocked by an unrelated transient read error.
  const { sdk, calls } = mockSdk();
  const r = await buildModelApp(desk, { apply: true, env: 'https://x', retryDelayMs: 0, allowDestructive: true }, { sdk, provisionSdk: sdk, discoverOpDiffState: async () => { throw new Error('429 transient'); } });
  assert.notStrictEqual(r.ok, false, 'not blocked by the discovery failure when already authorized');
  assert.ok(calls.some((c) => c[0] === 'createSolution'), 'proceeded into the build');
});

test('collision preflight: warns and journals when the app already exists', async () => {
  const { sdk } = mockSdk();
  sdk.queryRecords = async (set) => (set === 'appmodule' ? [{ appmoduleid: 'app-x' }] : set === 'solution' ? [] : [{ publisherid: 'pub-1' }]);
  const logs = [];
  const events = [];
  const journal = { path: 'x', record: (e) => events.push(e), close: () => {} };
  await buildModelApp(desk, { apply: true, env: 'https://x', retryDelayMs: 0 }, { sdk, provisionSdk: sdk, journal, log: (m) => logs.push(m) });
  assert.ok(logs.some((l) => /already exist/.test(l)), 'collision warning logged');
  assert.ok(events.some((e) => e.status === 'collision'), 'collision journaled');
});

test('collision preflight: silent when nothing collides', async () => {
  const { sdk } = mockSdk();
  const logs = [];
  await buildModelApp(desk, { apply: true, env: 'https://x', retryDelayMs: 0 }, { sdk, provisionSdk: sdk, log: (m) => logs.push(m) });
  assert.ok(!logs.some((l) => /already exist/.test(l)), 'no false-positive collision warning');
});

test('I1: apply refuses ANY partial phase range except the full build or exactly --stage data', async () => {
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A' }, entities: [{ schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' }, columns: [] }], pages: [{ key: 'p', name: 'P', source: { kind: 'tsx', codeFile: 'p.tsx' } }], appShell: { areas: [] } };
  for (const phases of [['pages'], ['views', 'charts'], ['app-shell', 'pages', 'ai-features']]) {
    const r = await buildModelApp(spec, { apply: true, phases }, { log: () => {} });
    assert.strictEqual(r.ok, false, `should reject apply with phases=${phases}`);
    assert.ok(/partial|full build|stage data/i.test(r.errors.join(' ')));
  }
});
