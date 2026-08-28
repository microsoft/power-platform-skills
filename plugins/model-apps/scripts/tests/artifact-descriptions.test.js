'use strict';
// Descriptions on every artifact that accepts one.
//
// A description is the maker-facing "what is this for", and it is also the only grounding an agent
// has when it later inspects a deployed app it did not build. An app whose tables and columns are
// named `new_col3` and described nowhere is guessable by a human and opaque to a model, so the build
// engine writes descriptions at CREATE time rather than leaving them to a backfill nobody runs.
//
// Two invariants this file exists to protect, both discovered by MEASURING the vendored bundle
// rather than reading its types:
//
//   1. OMISSION IS NOT BLANKING. Every write site omits `description` when the spec has none. If a
//      site ever sends `description: ''` instead, a rebuild silently erases a description a maker
//      typed in the UI — a data-loss bug that no error message would ever surface.
//
//   2. SECURITY ROLES ARE EXCLUDED ON PURPOSE. The SDK hardcodes its own ownership marker into a
//      role's description and then uses an EXACT match on that string to decide whether it may touch
//      the role. Honouring an author-supplied role description would make the SDK disown its own
//      role and refuse to update it. See the guard test at the bottom.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { validateAppSpec } = require('../lib/app-spec.js');
const { viewDef, chartDef, businessRuleDef, compileFormIntent, personaRoleSpecFor } = require('../lib/sdk-build.js');
const { provisionDataModel, provisionSolution } = require('../lib/entity-provision.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const DESC = 'Tracks a customer support ticket from intake to resolution.';

// ------------------------------------------------------------------ spec fixtures

function baseSpec(over = {}) {
  return Object.assign({
    solution: { uniqueName: 'DESC', displayName: 'Desc', publisherPrefix: 'new' },
    app: { name: 'Desc App', description: '' },
    entities: [{
      schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets',
      primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' },
      columns: [{ schemaName: 'new_score', displayName: 'Score', type: 'Integer' }],
    }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'new_ticket', title: 'Tickets' }] }] }] },
  }, over);
}

// ------------------------------------------------------------------ 1. validation

test('a description is accepted on every artifact that supports one', () => {
  const spec = baseSpec({
    entities: [{
      schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets', description: DESC,
      primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' },
      columns: [{ schemaName: 'new_score', displayName: 'Score', type: 'Integer', description: 'Severity 1-5.' }],
    }],
    views: [{ name: 'Open', entity: 'new_ticket', columns: [{ name: 'new_subject' }], description: 'Unresolved tickets.' }],
    charts: [{ name: 'By Score', entity: 'new_ticket', chartType: 'Column', groupBy: 'new_score', description: 'Volume by severity.' }],
    forms: [{ name: 'Ticket', entity: 'new_ticket', description: 'Primary intake form.' }],
  });
  const res = validateAppSpec(spec);
  assert.deepStrictEqual(res.errors.filter((e) => /description/i.test(e)), [], 'no description should be rejected');
});

test('a non-string description is rejected rather than stringified into Dataverse', () => {
  // `description: 42` or an accidental object would otherwise be written as "42"/"[object Object]".
  for (const bad of [42, { text: 'x' }, ['x']]) {
    const spec = baseSpec();
    spec.entities[0].description = bad;
    const res = validateAppSpec(spec);
    assert.ok(res.errors.some((e) => /description must be a string/.test(e)), `${JSON.stringify(bad)} must be rejected`);
  }
});

test('a blank description is rejected — omit the field instead', () => {
  // An empty string is the one value that would BLANK an existing description on rebuild, so it is
  // refused at author time rather than silently dropped.
  const spec = baseSpec();
  spec.entities[0].description = '   ';
  assert.ok(validateAppSpec(spec).errors.some((e) => /must not be blank/.test(e)));
});

test('a description past the Dataverse ceiling is rejected, not silently truncated', () => {
  const spec = baseSpec();
  spec.entities[0].description = 'x'.repeat(2001);
  assert.ok(validateAppSpec(spec).errors.some((e) => /2001 characters \(max 2000\)/.test(e)));
  spec.entities[0].description = 'x'.repeat(2000);
  assert.deepStrictEqual(validateAppSpec(spec).errors.filter((e) => /description/.test(e)), [], '2000 is inclusive');
});

test('descriptions stay OPTIONAL — a spec without any still validates', () => {
  // Making them mandatory would fail every spec authored before they existed.
  assert.deepStrictEqual(validateAppSpec(baseSpec()).errors.filter((e) => /description/i.test(e)), []);
});

// ------------------------------------------------------------------ 2. def builders

test('viewDef and chartDef carry the authored description', () => {
  const spec = baseSpec();
  const v = viewDef(spec, { name: 'Open', entity: 'new_ticket', description: DESC, columns: ['new_subject'] });
  assert.strictEqual(v.description, DESC);
  const c = chartDef(spec, { name: 'By Score', entity: 'new_ticket', chartType: 'Column', groupBy: 'new_score', description: DESC });
  assert.strictEqual(c.description, DESC);
});

test('viewDef and chartDef fall back to empty when none is authored', () => {
  // These two send `description` unconditionally (the SDK requires the key), so the fallback must be
  // '' rather than undefined — but the spec can never REACH that path with a blank, because a blank
  // is a validation error above.
  const spec = baseSpec();
  assert.strictEqual(viewDef(spec, { name: 'V', entity: 'new_ticket', columns: ['new_subject'] }).description, '');
  assert.strictEqual(chartDef(spec, { name: 'C', entity: 'new_ticket', chartType: 'Column', groupBy: 'new_score' }).description, '');
});

test('businessRuleDef carries a description and OMITS the key when absent', () => {
  const rule = { name: 'Escalate', entity: 'new_ticket', conditions: [], actions: [] };
  const withDesc = businessRuleDef(Object.assign({ description: DESC }, rule));
  assert.strictEqual(withDesc.description, DESC);
  assert.ok(!('description' in businessRuleDef(rule)), 'absent description must not appear as a key');
});

test('compileFormIntent carries the form description through to the SDK def', () => {
  const spec = baseSpec();
  const intent = compileFormIntent(spec, { name: 'Ticket', entity: 'new_ticket', description: DESC }, {});
  assert.strictEqual(intent.description, DESC);
  const bare = compileFormIntent(spec, { name: 'Ticket', entity: 'new_ticket' }, {});
  assert.strictEqual(bare.description, undefined, 'absent stays undefined so createArtifact omits it');
});

// ------------------------------------------------------------------ 3. table + column write path

function provisionHarness() {
  const calls = [];
  const sdk = {
    createTable: async (o) => { calls.push(['createTable', o]); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s` }; },
    createColumn: async (e, o) => { calls.push(['createColumn', o]); return { logicalName: o.schemaName.toLowerCase() }; },
    createCustomerColumn: async (e, o) => ({ logicalName: o.schemaName.toLowerCase() }),
    createGlobalOptionSet: async (o) => { calls.push(['createGlobalOptionSet', o]); return { name: o.name, metadataId: 'gc-1' }; },
    createRelationship: async (o) => ({ schemaName: o.schemaName }),
    createAlternateKey: async (e, o) => ({ logicalName: o.schemaName.toLowerCase() }),
    insertStatusValue: async () => 100000001,
    updateTable: async () => undefined,
    setColumnVisualization: async () => undefined,
  };
  const provision = {
    findTables: async () => [],
    findColumns: async () => [],
    fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, relationships: [] }),
    // Nothing pre-exists, so provisionSolution takes the create path (an existing solution returns
    // early and would never reach createSolution).
    queryRecords: async (entity) => (entity === 'solution' || entity === 'publisher' ? [] : [{ solutionid: 's' }]),
    createPublisher: async () => ({ id: '33333333-3333-3333-3333-333333333333' }),
    createSolution: async (o) => { calls.push(['createSolution', o]); return { id: 'sol-1' }; },
  };
  return { sdk, provision, calls };
}

async function runProvision(spec, h) {
  const runner = {
    run: async (phase, label, fn, o = {}) => {
      try { return await fn(); } catch (err) { if (o.skipIf && o.skipIf(err)) return undefined; throw err; }
    },
    skip: () => {},
    mapLimit: async (items, _n, fn) => { const out = []; for (const it of items) out.push(await fn(it)); return out; },
  };
  await provisionSolution({ sdk: h.sdk, provision: h.provision, runner, solution: spec.solution });
  await provisionDataModel({ spec, sdk: h.sdk, provision: h.provision, runner, preResolvedLanguageCode: 1033 });
}

test('a table and a column are CREATED with their descriptions', async () => {
  const spec = baseSpec();
  spec.entities[0].description = DESC;
  spec.entities[0].columns[0].description = 'Severity 1-5.';
  const h = provisionHarness();
  await runProvision(spec, h);
  assert.strictEqual(h.calls.find((c) => c[0] === 'createTable')[1].description, DESC);
  assert.strictEqual(h.calls.find((c) => c[0] === 'createColumn')[1].description, 'Severity 1-5.');
});

test('a table and a column with NO description omit the key entirely', async () => {
  // The blanking guard: sending `description: ''` here would wipe whatever a maker had typed.
  const h = provisionHarness();
  await runProvision(baseSpec(), h);
  assert.ok(!('description' in h.calls.find((c) => c[0] === 'createTable')[1]));
  assert.ok(!('description' in h.calls.find((c) => c[0] === 'createColumn')[1]));
});

// ------------------------------------------------------------------ 3b. solution + global choice

test('a solution and a global choice are CREATED with their descriptions', async () => {
  const spec = baseSpec();
  spec.solution.description = 'Everything the support desk needs.';
  spec.globalChoices = [{ name: 'new_severity', displayName: 'Severity', options: ['Low', 'High'], description: 'Shared severity scale.' }];
  const h = provisionHarness();
  await runProvision(spec, h);
  assert.strictEqual(h.calls.find((c) => c[0] === 'createSolution')[1].description, 'Everything the support desk needs.');
  assert.strictEqual(h.calls.find((c) => c[0] === 'createGlobalOptionSet')[1].description, 'Shared severity scale.');
});

test('a solution and a global choice with NO description omit the key', async () => {
  const spec = baseSpec();
  spec.globalChoices = [{ name: 'new_severity', displayName: 'Severity', options: ['Low', 'High'] }];
  const h = provisionHarness();
  await runProvision(spec, h);
  assert.ok(!('description' in h.calls.find((c) => c[0] === 'createSolution')[1]));
  assert.ok(!('description' in h.calls.find((c) => c[0] === 'createGlobalOptionSet')[1]));
});

// ------------------------------------------------------------------ 3c. accepted-but-inert warnings

test('a description the SDK cannot write is WARNED about, not silently dropped', async () => {
  // Both of these validate fine and build fine — the value just never reaches Dataverse. Silence
  // here is the worst outcome: the author believes the description exists.
  const spec = baseSpec();
  spec.entities[0].columns.push({ schemaName: 'new_client', displayName: 'Client', type: 'Customer', description: 'Who reported it.' });
  spec.webResources = [{ name: 'new_lib.js', type: 'script', content: 'dmFy' }];
  spec.commands = [{ entity: 'new_ticket', label: 'Escalate', library: 'new_lib.js', function: 'esc', description: 'Escalates the ticket.' }];
  const res = validateAppSpec(spec);
  assert.deepStrictEqual(res.errors.filter((e) => /description/i.test(e)), [], 'neither is an error');
  assert.ok(res.warnings.some((w) => /Customer column/.test(w) && /NOT be written/.test(w)), 'Customer column warned');
  assert.ok(res.warnings.some((w) => /command/.test(w) && /NOT be written/.test(w)), 'command warned');
});

test('app.description may be empty (legacy shape) but a new surface may not', () => {
  // download-model-app emits `app.description: ""`; rejecting it would fail specs that already work.
  const spec = baseSpec();
  spec.app.description = '';
  assert.deepStrictEqual(validateAppSpec(spec).errors.filter((e) => /description/.test(e)), []);
  // The same emptiness on a surface introduced WITH this contract is still refused.
  spec.solution.description = '';
  assert.ok(validateAppSpec(spec).errors.some((e) => /solution: description must not be blank/.test(e)));
});

// ------------------------------------------------------------------ 4. real bundle: does it reach the wire?

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function sdkWithCapture() {
  const { createMakerSdk } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desc-'));
  dirs.push(dir);
  const writes = [];
  const httpClient = {
    get: async () => ({ status: 200, headers: {}, body: { value: [] } }),
    post: async (url, body) => {
      writes.push({ url: String(url), body });
      return { status: 200, headers: { 'odata-entityid': '/x(22222222-2222-2222-2222-222222222222)' }, body: {} };
    },
    postRaw: async (url, body) => { writes.push({ url: String(url), body }); return { status: 200, headers: {}, body: {} }; },
    patch: async (url, body) => { writes.push({ url: String(url), body }); return { status: 204, headers: {}, body: {} }; },
    put: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspacePath: dir, instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
  sdk.initWorkspace();
  return { sdk, writes };
}

test('REAL BUNDLE: description survives to the wire for every artifact we set it on', async () => {
  // The typed surface ACCEPTING a field proves nothing about the payload — a serializer that drops
  // it would leave every assertion above green while Dataverse received nothing. So push for real
  // against a recording client and look for the value in the request body.
  const MARK = 'WIRE_MARKER_UNIQUE';
  const cases = {
    view: { name: 'V', description: MARK, entityLogicalName: 'account', queryType: 0, isDefault: false, columns: [{ name: 'name', width: 100 }] },
    chart: { name: 'C', description: MARK, entityLogicalName: 'account', chartType: 'Column', isDefault: false, series: [{ field: 'name', aggregate: 'count' }], categories: [{ field: 'name' }] },
    form: { name: 'F', description: MARK, entityLogicalName: 'account', formType: 'main', status: 'draft' },
    dashboard: { name: 'D', description: MARK },
    businessRule: { name: 'BR', description: MARK, entityLogicalName: 'account', scope: 'Entity', status: 'Draft' },
    app: { name: 'A', uniqueName: 'cr_descapp', description: MARK, iconWebResourceId: '11111111-1111-1111-1111-111111111111' },
  };
  for (const [type, def] of Object.entries(cases)) {
    const { sdk, writes } = sdkWithCapture();
    const art = sdk.createArtifact(type, def);
    assert.strictEqual(art.description, MARK, `${type}: the typed surface keeps description`);
    // The push may fail late (the fake client returns no usable id); the write we care about has
    // already been recorded by then, so the outcome of the push is deliberately not asserted.
    try { await sdk.pushArtifact(type, art.id); } catch { /* payload already captured */ }
    assert.ok(writes.some((w) => JSON.stringify(w.body || '').includes(MARK)), `${type}: description must reach the wire`);
  }
});

// ------------------------------------------------------------------ 5. the two deliberate exclusions

test('REAL BUNDLE: a command does NOT accept a description — so the build never sends one', () => {
  // Pins why `commands[]` is absent from everything above. If a future bundle adds it, this fails
  // and the omission gets revisited on purpose instead of staying an unexplained gap.
  const { sdk } = sdkWithCapture();
  const art = sdk.createArtifact('command', { name: 'CMD', description: 'ignored', entityLogicalName: 'account', buttons: [] });
  assert.ok(!('description' in art), 'the command surface drops description; wiring one would be inert');
});

test('a persona NEVER sends a description — it would break the SDK ownership guard', () => {
  // The bundle builds its role payload as
  //     { name, description: SDK_ROLE_MARKER, 'businessunitid@odata.bind': ... }
  // and gates reuse on
  //     d.ismanaged !== true && (d.description ?? '') === SDK_ROLE_MARKER
  // so a role carrying an author's prose is treated as somebody else's role and the SDK THROWS
  // ("already exists ... and was not created by the SDK; refusing to modify or assign it").
  // Teardown and verify re-implement the same marker check, so all three would disagree at once.
  const spec = personaRoleSpecFor({
    persona: 'Agent', description: 'should be ignored',
    jobs: [{ name: 'Job', privileges: [{ entity: 'new_ticket', access: ['read'], scope: 'user' }] }],
  });
  assert.ok(!('description' in spec), 'persona description must not be forwarded to createPersonaRole');

  const bundle = fs.readFileSync(BUNDLE, 'utf8');
  assert.ok(
    bundle.includes('description:It.SDK_ROLE_MARKER'),
    'the bundle still hardcodes the marker as the role description — if this changes, revisit the exclusion'
  );
});
