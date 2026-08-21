'use strict';
// Thin wiring test for build-model-app.js: validation gate, dry-run, and that apply
// threads through to the SDK engine (runSdkBuild). The engine's per-phase behavior is
// covered exhaustively in sdk-build.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { buildModelApp, isTransientHalt, discoverOpDiffState, parseLanguageCode } = require(path.join(__dirname, '..', 'build-model-app.js'));
const { resolveLanguageCode } = require(path.join(__dirname, '..', 'lib', 'entity-provision.js'));
const { validateAppSpec, normalizeLanguageCode } = require(path.join(__dirname, '..', 'lib', 'app-spec.js'));

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

test('a PRE-EXISTING duplicate page name does NOT block the build — it warns and proceeds (repro: form-only edit on an app with dupe pages)', async () => {
  // Two deployed pages share a name (both carry a pageId → pre-existing). The build did not create them,
  // so an unrelated build must still succeed; the dup name degrades to a warning (narrated + on the result).
  const dupePages = {
    schemaVersion: 2,
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    app: { name: 'A' },
    entities: [{ schemaName: 'new_o', displayName: 'O', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    pages: [
      { key: 'supplier-scorecard', name: 'Supplier Scorecard', pageId: '067e0090-250f-4de7-a054-24c4a070f958', source: { kind: 'tsx', codeFile: 'a.tsx' } },
      { key: 'supplier-scorecard-2', name: 'Supplier Scorecard', pageId: '5df2bb50-47ae-47e7-a335-cade1b463c11', source: { kind: 'tsx', codeFile: 'b.tsx' } },
    ],
    appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [
      { page: 'supplier-scorecard', title: 'Supplier Scorecard' },
      { page: 'supplier-scorecard-2', title: 'Supplier Scorecard' },
      { entity: 'new_o', title: 'O' },
    ] }] }] },
  };
  const { sdk } = mockSdk();
  const cap = logCapture();
  const r = await buildModelApp(dupePages, { apply: false, env: 'https://x', profile: 'deploy' }, { sdk, log: cap.log });
  assert.strictEqual(r.dryRun, true, 'the build is NOT blocked by a pre-existing dupe page name');
  assert.ok((r.warnings || []).some((w) => /pre-existing duplicate page name 'Supplier Scorecard'/.test(w)), 'the warning is attached to the result');
  assert.ok(cap.logs.some((l) => /⚠.*pre-existing duplicate page name/.test(l)), 'the warning is narrated with a ⚠ marker');
});

test('apply threads through to the SDK engine (solution + tables created)', async () => {
  const { sdk, calls } = mockSdk();
  const r = await buildModelApp(desk, { apply: true, env: 'https://x' }, { sdk });
  assert.strictEqual(r.ok, true);
  assert.ok(calls.some((c) => c[0] === 'createSolution'));  assert.ok(calls.filter((c) => c[0] === 'createTable').length >= 1);
});

// R3 — auto-verify after a successful --apply (opt-in; deps.verify injected)
test('data-model languageCode defaults to the org base language and reaches table/column labels', async () => {
  const { sdk, calls } = mockSdk();
  sdk.queryRecords = async (set) => {
    if (set === 'organization') return [{ languagecode: 1031 }];
    if (set === 'solution') return [];
    return [{ publisherid: 'pub-1' }];
  };
  const r = await buildModelApp(desk, { apply: true, env: 'https://x' }, { sdk });
  assert.strictEqual(r.ok, true);
  assert.ok(calls.some((c) => c[0] === 'createTable' && c[1] && c[1].languageCode === 1031), 'table create carries the org language');
  assert.ok(calls.some((c) => c[0] === 'createColumn' && c[2] && c[2].languageCode === 1031), 'column create carries the org language');
});

test('languageCode option overrides the org base language', async () => {
  const { sdk, calls } = mockSdk();
  sdk.queryRecords = async (set) => {
    if (set === 'organization') return [{ languagecode: 1031 }];
    if (set === 'solution') return [];
    return [{ publisherid: 'pub-1' }];
  };
  const r = await buildModelApp(desk, { apply: true, env: 'https://x', languageCode: 3082 }, { sdk });
  assert.strictEqual(r.ok, true);
  assert.ok(calls.some((c) => c[0] === 'createTable' && c[1] && c[1].languageCode === 3082), 'table create uses the override');
  assert.ok(calls.some((c) => c[0] === 'createColumn' && c[2] && c[2].languageCode === 3082), 'column create uses the override');
});

test('language resolution falls back cleanly when the provision stub has no queryRecords', async () => {
  const lc = await resolveLanguageCode({ provision: {}, spec: {} });
  assert.strictEqual(lc, 1033);
});

test('language resolution ignores an invalid override and still honors a valid spec languageCode', async () => {
  const lc = await resolveLanguageCode({ provision: {}, spec: { languageCode: 1031 }, languageCode: 0 });
  assert.strictEqual(lc, 1031);
});

test('language resolution warns when org-language discovery fails but still falls back', async () => {
  const warnings = [];
  const lc = await resolveLanguageCode({
    provision: { queryRecords: async () => { throw new Error('boom'); } },
    spec: {},
    warn: (msg) => warnings.push(msg),
  });
  assert.strictEqual(lc, 1033);
  // The warning must carry the underlying cause, not just announce that a fallback happened.
  assert.ok(warnings.some((w) => /base language/i.test(w) && /boom/.test(w)));
});

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

test('discoverOpDiffState resolves an explicit-layout form by (entity, name, TYPE) — no name-ambiguity halt on same-named Main/QuickView/Card', async () => {
  // The reported bug: a table with same-named Main + Quick View + Card forms made the name-only lookup
  // match multiple rows → AmbiguousArtifactError → the preflight halted. The type-scoped query must
  // return exactly the Main form and let discovery proceed.
  const formQueries = [];
  const provision = {
    queryRecords: async (set, o) => {
      const filter = (o && o.filter) || '';
      if (set === 'solution' || set === 'appmodule') return []; // no collision
      if (set === 'systemform') {
        formQueries.push(filter);
        // A name-ONLY query would (like the live env) match 3 same-named forms; the TYPE-scoped query
        // returns exactly one. Assert the caller scoped by type, then return the single Main row.
        assert.match(filter, /type eq 2/, 'form resolution scopes by type (Main=2), not name alone');
        return [{ formid: 'main-form-1' }];
      }
      return [{ publisherid: 'pub-1' }];
    },
    fetchArtifact: async () => ({ id: 'main-form-1' }),
    getArtifact: () => ({ id: 'main-form-1', tabs: [] }),
  };
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'zava' },
    app: { name: 'Zava' },
    entities: [{ schemaName: 'zava_javavendor', primaryAttribute: { schemaName: 'zava_name' }, columns: [] }],
    // Explicit-layout Main form named "Information" (the same name as the auto Quick View / Card forms).
    forms: [{ entity: 'zava_javavendor', name: 'Information', formType: 'Main', layout: 'explicit', tabs: [{ name: 't', sections: [{ name: 's', fields: ['zava_name'] }] }] }],
    appShell: { areas: [] },
  };
  const state = await discoverOpDiffState(spec, provision);
  assert.strictEqual(state.forms.length, 1, 'the Main form resolved (discovery did not halt on a name collision)');
  assert.ok(formQueries.length >= 1 && /name eq 'Information'/.test(formQueries[0]), 'resolved by (entity, name, type)');
});

test('I1: apply refuses ANY partial phase range except the full build or exactly --stage data', async () => {
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A' }, entities: [{ schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' }, columns: [] }], pages: [{ key: 'p', name: 'P', source: { kind: 'tsx', codeFile: 'p.tsx' } }], appShell: { areas: [] } };
  for (const phases of [['pages'], ['views', 'charts'], ['app-shell', 'pages', 'ai-features']]) {
    const r = await buildModelApp(spec, { apply: true, phases }, { log: () => {} });
    assert.strictEqual(r.ok, false, `should reject apply with phases=${phases}`);
    assert.ok(/partial|full build|stage data/i.test(r.errors.join(' ')));
  }
});

test('I1 exception: a changed-only pages-only fast apply is NOT refused (fastApply seam); other partials still are', async () => {
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A' }, entities: [{ schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' }, columns: [] }], pages: [{ key: 'p', name: 'P', source: { kind: 'tsx', codeFile: 'p.tsx' } }], appShell: { areas: [] } };
  // pages-only WITH the changed-only fastApply seam is the ONE sanctioned partial range — the I1 gate must
  // let it through (a stub runBuild proves it reached the build, not the gate rejection).
  const okDeps = { log: () => {}, runBuild: async () => ({ ok: true, dryRun: false, created: { app: 'app-1' } }) };
  const rOk = await buildModelApp(spec, { apply: true, phases: ['pages'], changedOnly: { fastApply: true, resolvedAppId: 'app-1', skipSitemapFinalize: true } }, okDeps);
  assert.strictEqual(rOk.ok, true, 'the changed-only pages-only fast apply must pass the I1 gate');
  // The SAME seam does NOT whitelist an arbitrary partial range (only exactly ['pages']).
  const rBad = await buildModelApp(spec, { apply: true, phases: ['views', 'pages'], changedOnly: { fastApply: true } }, { log: () => {} });
  assert.strictEqual(rBad.ok, false, 'the fastApply seam must not whitelist a non-pages partial range');
});

// ---------------------------------------------------------------------------
// Task 10: mandatory fail-closed page verify gate + RECONCILIATION 1/2
// ---------------------------------------------------------------------------

const { PHASES, STAGES } = require('../lib/stages.js');

// A minimal page-bearing spec (implemented tsx pages). Used in the mandatory gate tests.
function pageBearingSpec() {
  return {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    app: { name: 'A' },
    schemaVersion: 2,
    entities: [{ schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    pages: [{ key: 'p', name: 'P', source: { kind: 'tsx', codeFile: 'p.tsx' } }],
    appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ page: 'p', title: 'P' }] }] }] },
  };
}

test('page verify is MANDATORY even without --verify: a failing page verify exits non-zero (C6)', async () => {
  // The build is apply:true, phases:PHASES (full build) with a page-bearing spec. Even without
  // opts.verify:true, the gate must run because the pages phase is applied.
  const deps = {
    log: () => {},
    runBuild: async () => ({ ok: true, dryRun: false, created: { app: 'app-1' } }),
    verify: async () => ({ ok: false, checks: [{ kind: 'page', name: 'P' }], missing: [{ kind: 'page', name: 'P' }] }),
  };
  const r = await buildModelApp(pageBearingSpec(), { apply: true, phases: PHASES, verify: false }, deps);
  assert.strictEqual(r.verify.ok, false, 'page verify ran and failed despite --verify not being set');
});

test('page verify is FAIL-CLOSED: a verify that throws is fatal for a page-bearing spec (C6 unableToRun)', async () => {
  // An enumeration/download failure in the verifier MUST produce r.verify={ok:false,unableToRun:true}
  // — not a warning that leaves r.verify undefined.
  const deps = {
    log: () => {},
    runBuild: async () => ({ ok: true, dryRun: false, created: { app: 'app-1' } }),
    verify: async () => { throw new Error('page enumeration failed during verify'); },
  };
  const r = await buildModelApp(pageBearingSpec(), { apply: true, phases: PHASES, verify: false }, deps);
  assert.strictEqual(r.verify.ok, false);
  assert.ok(r.verify.unableToRun, 'an unrunnable verify is fatal for pages');
});

test('page verify is FAIL-CLOSED: a page-bearing spec with NO verifier wired is unable-to-run (C6)', async () => {
  // No deps.verify at all — the gate must not silently skip for a page-bearing spec.
  const deps = {
    log: () => {},
    runBuild: async () => ({ ok: true, dryRun: false, created: { app: 'app-1' } }),
  };
  const r = await buildModelApp(pageBearingSpec(), { apply: true, phases: PHASES, verify: false }, deps);
  assert.strictEqual(r.verify.ok, false);
  assert.ok(r.verify.unableToRun);
});

test('RECONCILIATION 2: --stage data apply of a page-bearing spec does NOT trigger mandatory page verify', async () => {
  // pages phase is NOT included in STAGES.data → mandatory verify must NOT be triggered.
  // A build that fails verify with r.verify.ok===false would mean the gate fired; we assert it did not.
  const deps = {
    log: () => {},
    runBuild: async () => ({ ok: true, dryRun: false, created: {} }),
    // No deps.verify wired — if the gate fires it would set r.verify.ok:false, so we can detect it.
  };
  const r = await buildModelApp(pageBearingSpec(), { apply: true, phases: STAGES.data, verify: false }, deps);
  assert.ok(!r.verify, '--stage data apply must NOT set r.verify when no pages phase ran');
  assert.strictEqual(r.ok, true, 'the build itself succeeded');
});

test('unableToRun is propagated from verifySpec into r.verify (RECONCILIATION 1)', async () => {
  // verifySpec can itself return unableToRun:true (reader-incapacity). The build gate must
  // propagate that flag into r.verify so callers can distinguish reader-incapacity from a
  // normal failed check.
  const deps = {
    log: () => {},
    runBuild: async () => ({ ok: true, dryRun: false, created: { app: 'app-1' } }),
    verify: async () => ({ ok: false, checks: [{ kind: 'page-verify', name: 'pages', present: false }], missing: [{ kind: 'page-verify', name: 'pages' }], unableToRun: true }),
  };
  const r = await buildModelApp(pageBearingSpec(), { apply: true, phases: PHASES, verify: false }, deps);
  assert.strictEqual(r.verify.ok, false);
  assert.strictEqual(r.verify.unableToRun, true, 'unableToRun propagated from verifySpec result');
});

// -- verify wiring -----------------------------------------------------------------------------
// Asserted against SOURCE because the wiring lives inside main(), which is not exported, and the
// failure mode is SILENT: verify-spec skips role-privileges unless BOTH readers are present, so
// omitting httpClient/envUrl made --apply --verify report a clean PASS having never checked what
// any persona role actually grants. Found live -- the standalone verifier ran 10 checks against the
// same app where the build inline verify ran 8. A behavioural test would need a live SDK; this pins
// the exact regression at zero cost.
test('build --verify wires the role-privilege readers (httpClient + envUrl)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'build-model-app.js'), 'utf8');
  const call = src.split(/\r?\n/).find((l) => l.includes('verify: (s) => verifySpec'));
  assert.ok(call, 'expected the deps.verify wiring line');
  assert.match(call, /httpClient/, 'entityPrivileges needs the raw client');
  assert.match(call, /envUrl: env/, 'entityPrivileges needs the org url to build an absolute request');
});

test('makeSdk returns the httpClient so the caller can wire verify', () => {
  // Returning the SAME instance rather than constructing a second one keeps token acquisition and
  // retry state shared; a second client would re-acquire a token per verify run.
  const src = fs.readFileSync(path.join(__dirname, '..', 'build-model-app.js'), 'utf8');
  assert.match(src, /return \{ sdk, provisionSdk, httpClient, cleanup \}/, 'makeSdk must expose httpClient');
  assert.match(src, /const \{ sdk, provisionSdk, httpClient, cleanup \} = makeSdk\(/, 'main must destructure it');
});

// #447 follow-up: an LCID reaches Dataverse as a label LanguageCode, so a value that merely SURVIVES
// a `Number()` cast is not good enough. `Number(true) === 1` and `Number([1033]) === 1033` both pass
// a naive positive-integer check, so a spec containing `"languageCode": true` would have built every
// label with the invalid LCID 1 and failed deep in the data-model phase with an opaque Dataverse 400.
test('languageCode rejects non-numeric JSON types instead of coercing them to a bogus LCID', () => {
  const base = { app: { name: 'A' }, entities: [], solution: { uniqueName: 'x', publisherPrefix: 'new' } };
  const bad = [true, [1033], '1e3', '12.5', {}, 1033.5, -1, 0];
  for (const v of bad) {
    const r = validateAppSpec({ ...base, languageCode: v });
    assert.ok(
      (r.errors || []).some((e) => /languageCode must be a positive integer LCID/.test(e)),
      `languageCode=${JSON.stringify(v)} must be REJECTED (Number() would coerce it to ${Number(v)})`
    );
  }
  // A real number and the string form the CLI always produces must still be accepted.
  for (const v of [1033, 1031, '1031', ' 1033 ']) {
    const r = validateAppSpec({ ...base, languageCode: v });
    assert.ok(!(r.errors || []).some((e) => /languageCode/.test(e)), `languageCode=${JSON.stringify(v)} must be accepted`);
  }
});

test('resolveLanguageCode does not accept a coerced non-numeric override', async () => {
  // `true` must NOT win over a valid spec value; it is not a language.
  const lc = await resolveLanguageCode({ provision: {}, spec: { languageCode: 1031 }, languageCode: true });
  assert.strictEqual(lc, 1031, 'a boolean override must be ignored, not coerced to LCID 1');
  const lc2 = await resolveLanguageCode({ provision: {}, spec: { languageCode: true } });
  assert.strictEqual(lc2, 1033, 'a boolean spec value must fall through to the default, not become LCID 1');
});

test('parseLanguageCode (CLI) rejects the same coercible values', () => {
  for (const v of ['abc', '0', '-1', '1e3', '12.5']) {
    assert.throws(() => parseLanguageCode(v), /positive integer LCID/, `--language-code ${v} must throw`);
  }
  assert.strictEqual(parseLanguageCode('1031'), 1031);
  assert.strictEqual(parseLanguageCode(undefined), undefined);
});

// #447 follow-up: 1033 is the exact value that breaks a non-English org, so EVERY path that falls
// back to it must say so. Previously only the read-threw path warned; an empty result set or a null
// languagecode returned 1033 silently and the build then died on a DateTime/Memo column with an
// opaque Dataverse 400 that pointed nowhere near language resolution.
test('every fallback to the default LCID warns, not just the read-threw path', async () => {
  const cases = [
    ['no reader supplied', {}],
    ['empty result set', { queryRecords: async () => [] }],
    ['null languagecode', { queryRecords: async () => [{ languagecode: null }] }],
    ['non-LCID languagecode', { queryRecords: async () => [{ languagecode: 'de-DE' }] }],
    ['read threw', { queryRecords: async () => { throw new Error('boom'); } }],
  ];
  for (const [name, provision] of cases) {
    const warnings = [];
    const lc = await resolveLanguageCode({ provision, spec: {}, warn: (m) => warnings.push(m) });
    assert.strictEqual(lc, 1033, name + ': falls back to the default');
    assert.strictEqual(warnings.length, 1, name + ': must emit exactly one warning');
    assert.match(warnings[0], /base language/i, name + ': warning explains what could not be determined');
    assert.match(warnings[0], /--language-code/, name + ': warning names the escape hatch');
  }
});

test('a successful org read does NOT warn', async () => {
  const warnings = [];
  const lc = await resolveLanguageCode({
    provision: { queryRecords: async () => [{ languagecode: 1031 }] },
    spec: {},
    warn: (m) => warnings.push(m),
  });
  assert.strictEqual(lc, 1031);
  assert.deepStrictEqual(warnings, [], 'the happy path must be silent');
});

test('the org language read asks for the right column and a single row', async () => {
  // Pins the query itself, not just its result. The read is wrapped in try/catch and degrades to
  // 1033, so a wrong $select would surface live as an HTTP 400 swallowed into a warning -- a
  // regression a result-only assertion cannot see.
  let seen = null;
  await resolveLanguageCode({
    provision: { queryRecords: async (set, opts) => { seen = { set, opts }; return [{ languagecode: 1031 }]; } },
    spec: {},
  });
  assert.strictEqual(seen.set, 'organization', 'logical name (the SDK resolves the entity set itself)');
  assert.deepStrictEqual(seen.opts.select, ['languagecode']);
  assert.strictEqual(seen.opts.top, 1);
});

// #447 follow-up: the unit tests above call resolveLanguageCode() directly with a `warn`, which
// proves the FUNCTION warns but says nothing about whether the CLI is wired to it. The chain is
// build-model-app `deps.warn` -> runBuild `opts.warn` -> provisionDataModel -> resolveLanguageCode,
// and a break anywhere in it silently costs the user the only diagnostic they get before an opaque
// Dataverse 400. This asserts the whole chain end to end through the public buildModelApp entry.
test('deps.warn reaches language resolution — the CLI warning wiring, not just the function', async () => {
  const { sdk } = mockSdk();
  sdk.queryRecords = async (set) => {
    if (set === 'organization') throw new Error('org read blocked');
    if (set === 'solution') return [];
    return [{ publisherid: 'pub-1' }];
  };
  const warnings = [];
  const r = await buildModelApp(desk, { apply: true, env: 'https://x' }, { sdk, warn: (m) => warnings.push(m) });
  assert.strictEqual(r.ok, true, 'a failed language read must not fail the build');
  assert.ok(
    warnings.some((w) => /base language/i.test(w) && /--language-code/.test(w)),
    'the fallback warning must actually reach deps.warn; got: ' + JSON.stringify(warnings)
  );
});

test('a healthy org language read produces no warning through the CLI path', async () => {
  const { sdk, calls } = mockSdk();
  sdk.queryRecords = async (set) => {
    if (set === 'organization') return [{ languagecode: 1031 }];
    if (set === 'solution') return [];
    return [{ publisherid: 'pub-1' }];
  };
  const warnings = [];
  const r = await buildModelApp(desk, { apply: true, env: 'https://x' }, { sdk, warn: (m) => warnings.push(m) });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(warnings, [], 'the happy path must not warn');
  assert.ok(calls.some((c) => c[0] === 'createColumn' && c[2] && c[2].languageCode === 1031));
});

// An LCID is a 16-bit value, so anything above 0xFFFF cannot be one. Without an upper bound these
// cleared the positive-integer check and reached the wire, failing in exactly the opaque way the
// normalizer's own comment claims it prevents.
test('normalizeLanguageCode bounds the LCID to 16 bits', () => {
  for (const bad of [65536, 1e20, Number.MAX_SAFE_INTEGER, '65536', '99999']) {
    assert.strictEqual(normalizeLanguageCode(bad), null, `${bad} is above 0xFFFF and must be rejected`);
  }
  assert.strictEqual(normalizeLanguageCode(65535), 65535, 'the boundary itself is valid');
  assert.strictEqual(normalizeLanguageCode(1033), 1033);
});

// "You gave me nothing" and "you gave me something I could not use" are different facts. Only the
// second means the caller believes they pinned a language and is wrong, so it must not be silent.
test('a supplied-but-invalid language override is reported, not silently discarded', async () => {
  const warnings = [];
  const lc = await resolveLanguageCode({ provision: {}, spec: {}, languageCode: 'de-DE', warn: (m) => warnings.push(m) });
  assert.strictEqual(lc, 1033, 'still falls through rather than failing the build');
  assert.ok(warnings.some((w) => /ignoring --language-code 'de-DE'/.test(w)), 'the discarded value is named: ' + JSON.stringify(warnings));

  const w2 = [];
  await resolveLanguageCode({ provision: {}, spec: { languageCode: '1O33' }, warn: (m) => w2.push(m) });
  assert.ok(w2.some((w) => /ignoring languageCode '1O33'/.test(w)), 'a bad spec value is named too: ' + JSON.stringify(w2));

  // Absent must stay silent — only the org-discovery fallback warning applies there.
  const w3 = [];
  await resolveLanguageCode({ provision: { queryRecords: async () => [{ languagecode: 1031 }] }, spec: {}, warn: (m) => w3.push(m) });
  assert.deepStrictEqual(w3, [], 'omitting the override is not a problem and must not warn');
});

// #456: the two flag spellings are aliases, so passing both with DIFFERENT values means the user
// believes one is in effect and is wrong about which. `a ?? b` silently prefers the kebab form and
// discards the other, producing a build nobody asked for with no indication why.
test('a conflicting --language-code / --languageCode pair is rejected, not silently resolved', () => {
  const { readAliasedFlag } = require(path.join(__dirname, '..', 'lib', 'dataverse-auth.js'));
  assert.throws(
    () => readAliasedFlag({ 'language-code': '1031', languageCode: '1036' }, 'language-code', 'languageCode'),
    /disagree/,
    'two different values must be an error'
  );
  // Agreeing duplicates are harmless, and either alone is fine.
  assert.strictEqual(readAliasedFlag({ 'language-code': '1031', languageCode: '1031' }, 'language-code', 'languageCode'), '1031');
  assert.strictEqual(readAliasedFlag({ 'language-code': '1031' }, 'language-code', 'languageCode'), '1031');
  assert.strictEqual(readAliasedFlag({ languageCode: '1036' }, 'language-code', 'languageCode'), '1036');
  assert.strictEqual(readAliasedFlag({}, 'language-code', 'languageCode'), undefined);
});
