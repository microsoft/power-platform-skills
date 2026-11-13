'use strict';
// The durable receipt of default configuration creates (#807): the strict parser, the fenced transitions, the approval offers, the
// quarantine of an unreadable receipt, and the stop codes. Every test works in a temporary workspace of its own.
const { makeTempDir } = require('./helpers/temp-dirs.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { sha256 } = require('../lib/hash.js');
const S = require('../lib/configuration-create-state.js');
const { withAppBuildLease, buildLockName } = require('../lib/app-operation-lease.js');

// The fixture kind table: the eight receipt kinds with the plan's closed field maps (public field name -> type) and the fixed names of
// each kind's private inputs.
const KIND_TABLE = {
  'env-definition': { root: true, parentKinds: [], publicFields: { schemaname: 'string', displayname: 'string', type: 'integer', description: 'nullable-string' }, privateFields: ['defaultValue', 'valueSchema'] },
  'env-value': { root: false, parentKinds: ['env-definition'], publicFields: { schemaname: 'string' }, privateFields: ['value'] },
  'connection-reference': { root: true, parentKinds: [], publicFields: { connectionreferencelogicalname: 'string', connectorid: 'string', displayname: 'nullable-string' }, privateFields: ['connectionId'] },
  'custom-api': { root: true, parentKinds: [], publicFields: { uniquename: 'string', bindingtype: 'integer', isfunction: 'boolean', plugintypeid: 'nullable-guid' }, privateFields: [] },
  'api-request': { root: false, parentKinds: ['custom-api'], publicFields: { uniquename: 'string', type: 'integer', isoptional: 'boolean' }, privateFields: [] },
  'api-response': { root: false, parentKinds: ['custom-api'], publicFields: { uniquename: 'string', type: 'integer' }, privateFields: [] },
  'duplicate-rule': { root: true, parentKinds: [], publicFields: { name: 'string', baseentityname: 'string', matchingentityname: 'string', iscasesensitive: 'boolean' }, privateFields: [] },
  'rule-condition': { root: false, parentKinds: ['duplicate-rule'], publicFields: { baseattributename: 'string', matchingattributename: 'string', operatorcode: 'integer' }, privateFields: [] },
};
const kt = { kindTable: KIND_TABLE };
const CONTEXT = S.createStateContext({ environmentUrl: 'https://contoso.crm.dynamics.com', solutionUniqueName: 'ContosoSolution', appUniqueName: 'contoso_app', authoringLanguageCode: 1033 });
const OTHER_CONTEXT = S.createStateContext({ environmentUrl: 'https://fabrikam.crm.dynamics.com', solutionUniqueName: 'ContosoSolution', appUniqueName: 'contoso_app', authoringLanguageCode: 1033 });
const FAST = { attempts: 1, sleep() {} };
const G = () => crypto.randomUUID();
const H = (s) => sha256(String(s));

function envUnit({ key = 'contoso_Setting', rootRole = 'create', value = true } = {}) {
  const defId = G();
  const rows = [{ kind: 'env-definition', key, id: defId, parentId: null, role: rootRole, public: { schemaname: key, displayname: 'Setting', type: 100000000, description: null }, privateFields: ['defaultValue', 'valueSchema'] }];
  if (value) rows.push({ kind: 'env-value', key: `${key}.value`, id: G(), parentId: defId, role: 'create', public: { schemaname: key }, privateFields: ['value'] });
  return { root: { kind: 'env-definition', key, id: defId }, publicIntentSha256: H(`intent ${key}`), publicPlanSha256: H(`plan ${key}`), publicationRequired: false, rows };
}
function apiUnit({ key = 'contoso_DoThing' } = {}) {
  const apiId = G();
  return {
    root: { kind: 'custom-api', key, id: apiId }, publicIntentSha256: H(`intent ${key}`), publicPlanSha256: H(`plan ${key}`), publicationRequired: false,
    rows: [
      { kind: 'custom-api', key, id: apiId, parentId: null, role: 'create', public: { uniquename: key, bindingtype: 0, isfunction: false, plugintypeid: null }, privateFields: [] },
      { kind: 'api-request', key: `${key}.Input`, id: G(), parentId: apiId, role: 'create', public: { uniquename: `${key}.Input`, type: 10, isoptional: false }, privateFields: [] },
      { kind: 'api-response', key: `${key}.Output`, id: G(), parentId: apiId, role: 'create', public: { uniquename: `${key}.Output`, type: 10 }, privateFields: [] },
    ],
  };
}
function ruleUnit({ key = 'contoso_rule', publicationRequired = true, rootRole = 'create' } = {}) {
  const ruleId = G();
  return {
    root: { kind: 'duplicate-rule', key, id: ruleId }, publicIntentSha256: H(`intent ${key}`), publicPlanSha256: H(`plan ${key}`), publicationRequired,
    rows: [
      { kind: 'duplicate-rule', key, id: ruleId, parentId: null, role: rootRole, public: { name: key, baseentityname: 'account', matchingentityname: 'account', iscasesensitive: false }, privateFields: [] },
      { kind: 'rule-condition', key: `${key}.name`, id: G(), parentId: ruleId, role: 'create', public: { baseattributename: 'name', matchingattributename: 'name', operatorcode: 0 }, privateFields: [] },
    ],
  };
}

const ws = () => makeTempDir('cc-state-');
const stateFile = (dir) => path.join(dir, S.STATE_FILE);
const readRaw = (dir) => JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'));
const writeRaw = (dir, obj) => fs.writeFileSync(stateFile(dir), S.serializeCreateState(obj));
const prepare = (dir, unit, extra = {}) => S.prepareCreateUnit(dir, { kindTable: KIND_TABLE, context: CONTEXT, unit, ...extra });
const unitOf = (dir, unitId) => S.readConfigurationCreateState(dir, kt).units.find((u) => u.unitId === unitId);
const createRows = (u) => u.rows.filter((r) => r.role === 'create');

function throwsCode(fn, code, extra) {
  let caught;
  try { fn(); } catch (e) { caught = e; }
  assert.ok(caught, `expected ${code}, nothing was thrown`);
  assert.equal(caught.code, code, caught.message);
  assert.equal(caught.name, 'ConfigurationCreateHalt');
  assert.equal(caught.retry, 'never');
  assert.equal(caught.transient, false);
  if (extra) for (const [k, v] of Object.entries(extra)) assert.deepEqual(caught[k], v, `${k} of ${caught.message}`);
  return caught;
}

// Replaces one node:fs function for the length of `fn` (the modules call fs through the module object, so the patch reaches them).
function withFsPatch(name, impl, fn) {
  const real = fs[name];
  fs[name] = (...args) => impl(real, ...args);
  try { return fn(); } finally { fs[name] = real; }
}

// Drives a unit through every create row to verified.
function verifyAll(handle, unit) {
  for (const r of unit.rows.filter((x) => x.role === 'create')) {
    S.sealCreateRow(handle, r.id);
    S.markCreateRowVerified(handle, r.id);
  }
}

test('the halt builder covers exactly the nineteen stop codes and carries only safe fields', () => {
  assert.equal(S.CONFIGURATION_CREATE_STOP_CODES.length, 19);
  assert.ok(S.CONFIGURATION_CREATE_STOP_CODES.every((c) => c.startsWith('configuration-create-')));
  for (const code of S.CONFIGURATION_CREATE_STOP_CODES) {
    const e = S.configurationCreateHalt(code);
    assert.ok(e instanceof Error);
    assert.equal(e.code, code);
    assert.equal(e.retry, 'never');
    assert.equal(e.transient, false);
    assert.match(e.message, /Next step: \S/);
  }
  const unitId = G();
  const e = S.configurationCreateHalt('configuration-create-pending', { unitId, rootId: 'not-a-guid', rootKind: 'contoso-unknown', dispatched: true, transition: 'seal' });
  assert.equal(e.unitId, unitId);
  assert.equal(e.rootId, null);
  assert.equal(e.rootKind, null);
  assert.equal(e.dispatched, true);
  assert.equal(e.transition, 'seal');
  assert.match(e.message, /dispatched a create before this stop/);
  assert.equal(S.configurationCreateHalt('configuration-create-pending', { unitId: unitId.toUpperCase() }).unitId, null, 'only canonical lower-case GUIDs are kept');
  assert.throws(() => S.configurationCreateHalt('configuration-create-nonsense'), TypeError);
});

test('the kind table is held to the closed contract', () => {
  const clone = () => JSON.parse(JSON.stringify(KIND_TABLE));
  const bad = [
    (t) => { delete t['rule-condition']; },
    (t) => { t['env-value'].root = true; },
    (t) => { t['env-value'].parentKinds = ['custom-api', 'custom-api']; },
    (t) => { t['env-definition'].publicFields.defaultValue = 'string'; },
    (t) => { t['custom-api'].publicFields.uniquename = 'text'; },
    (t) => { t['custom-api'].extra = true; },
  ];
  for (const mutate of bad) {
    const t = clone();
    mutate(t);
    throwsCode(() => S.validateKindTable(t), 'configuration-create-shape-refused');
  }
  assert.equal(S.validateKindTable(KIND_TABLE), KIND_TABLE);
});

test('a unit runs prepare, seal, verify and complete, and the emptied receipt stays on disk in canonical form', () => {
  const dir = ws();
  const unit = envUnit();
  const h = prepare(dir, unit);
  assert.ok(S.isLiveCreateHandle(h));
  let saved = unitOf(dir, h.unitId);
  assert.equal(saved.state, 'open');
  assert.deepEqual(saved.rows.map((r) => r.dispatch), ['prepared', 'prepared']);
  assert.deepEqual(saved.rows[0].privateFields, ['defaultValue', 'valueSchema']);
  const rowId = unit.rows[1].id;
  S.sealCreateRow(h, rowId);
  assert.equal(unitOf(dir, h.unitId).rows[1].dispatch, 'dispatched', 'the seal is saved before the request is sent');
  S.markCreateRowVerified(h, rowId);
  S.sealCreateRow(h, unit.rows[0].id);
  S.markCreateRowVerified(h, unit.rows[0].id);
  saved = unitOf(dir, h.unitId);
  assert.deepEqual(saved.rows.map((r) => r.dispatch), ['verified', 'verified']);
  S.completeCreateUnit(h);
  assert.equal(S.isLiveCreateHandle(h), false);
  const bytes = fs.readFileSync(stateFile(dir));
  const state = S.parseCreateState(bytes, kt);
  assert.deepEqual(state.units, []);
  assert.equal(state.revision, 6);
  assert.equal(bytes.toString('utf8'), S.serializeCreateState(state));
});

test('a new duplicate rule is published through its own sealed slot before the unit completes', () => {
  const dir = ws();
  const unit = ruleUnit();
  const h = prepare(dir, unit);
  throwsCode(() => S.sealNewRulePublication(h), 'configuration-create-state-invalid', { transition: 'publication-seal' });
  const h2 = prepare(dir, ruleUnit({ key: 'contoso_rule2' }));
  verifyAll(h2, unitOf(dir, h2.unitId));
  throwsCode(() => S.markNewRulePublicationAcknowledged(h2), 'configuration-create-state-invalid', { transition: 'publication-acknowledge' });
  assert.equal(S.isLiveCreateHandle(h2), false, 'a refused step kills the handle');
  const h3 = prepare(dir, ruleUnit({ key: 'contoso_rule3' }));
  const u3 = unitOf(dir, h3.unitId);
  verifyAll(h3, u3);
  throwsCode(() => S.completeCreateUnit(h3), 'configuration-create-state-invalid', { transition: 'complete' });
  const h4 = prepare(dir, ruleUnit({ key: 'contoso_rule4' }));
  verifyAll(h4, unitOf(dir, h4.unitId));
  S.sealNewRulePublication(h4);
  assert.equal(unitOf(dir, h4.unitId).publication.dispatch, 'dispatched');
  throwsCode(() => S.sealNewRulePublication(h4), 'configuration-create-state-invalid');
  const h5 = prepare(dir, ruleUnit({ key: 'contoso_rule5' }));
  verifyAll(h5, unitOf(dir, h5.unitId));
  S.sealNewRulePublication(h5);
  throwsCode(() => S.completeCreateUnit(h5), 'configuration-create-state-invalid', { transition: 'complete' });
  const h6 = prepare(dir, ruleUnit({ key: 'contoso_rule6' }));
  verifyAll(h6, unitOf(dir, h6.unitId));
  S.sealNewRulePublication(h6);
  S.markNewRulePublicationAcknowledged(h6);
  assert.equal(unitOf(dir, h6.unitId).publication.dispatch, 'acknowledged');
  S.completeCreateUnit(h6);
  assert.equal(unitOf(dir, h6.unitId), undefined);
});

test('each refused row transition is refused and kills its handle', () => {
  const dir = ws();
  const cases = [
    ['verify before seal', (h, u) => S.markCreateRowVerified(h, createRows(u)[0].id), 'verify'],
    ['seal twice', (h, u) => { S.sealCreateRow(h, createRows(u)[0].id); S.sealCreateRow(h, createRows(u)[0].id); }, 'seal'],
    ['seal a preserved row', (h, u) => S.sealCreateRow(h, u.rows[0].id), 'seal'],
    ['seal an unknown row', (h) => S.sealCreateRow(h, G()), 'seal'],
    ['complete before verify', (h) => S.completeCreateUnit(h), 'complete'],
    ['publication without a slot', (h, u) => { verifyAll(h, u); S.sealNewRulePublication(h); }, 'publication-seal'],
  ];
  for (const [name, run, transition] of cases) {
    const unit = envUnit({ key: `contoso_${name.replace(/\W/g, '')}`, rootRole: 'preserved' });
    const h = prepare(dir, unit);
    throwsCode(() => run(h, unitOf(dir, h.unitId)), 'configuration-create-state-invalid', { transition });
    assert.equal(S.isLiveCreateHandle(h), false, name);
    throwsCode(() => S.sealCreateRow(h, unit.rows[1].id), 'configuration-create-state-invalid');
  }
});

test('a stale or forged handle cannot seal', () => {
  const dir = ws();
  const unit = envUnit();
  const h = prepare(dir, unit);
  throwsCode(() => S.sealCreateRow({ unitId: h.unitId, attemptId: h.attemptId }, unit.rows[0].id), 'configuration-create-state-invalid', { transition: 'seal' });
  // Another writer changed this unit on disk: the handle's unit record no longer matches.
  const raw = readRaw(dir);
  raw.units[0].rows[1].dispatch = 'dispatched';
  writeRaw(dir, raw);
  throwsCode(() => S.sealCreateRow(h, unit.rows[0].id), 'configuration-create-state-invalid');
  assert.equal(readRaw(dir).units[0].rows[0].dispatch, 'prepared', 'nothing was sealed');
  assert.equal(S.isLiveCreateHandle(h), false);
});

test('a handle of a cancelled attempt cannot seal, and a re-prepared attempt does not revive it', () => {
  const dir = ws();
  const unit = envUnit();
  const h = prepare(dir, unit);
  const { revision } = S.readConfigurationCreateState(dir, kt);
  const offer = S.prepareResolutionOffer(dir, { kindTable: KIND_TABLE, context: CONTEXT, unitId: h.unitId, mode: 'cancel-unsent', expectedRevision: revision });
  const res = S.resolveResolutionOffer(dir, { kindTable: KIND_TABLE, context: CONTEXT, unitId: h.unitId, mode: 'cancel-unsent', token: offer.token });
  assert.equal(res.removed, true);
  prepare(dir, unit);
  throwsCode(() => S.sealCreateRow(h, unit.rows[0].id), 'configuration-create-state-invalid');
  assert.ok(readRaw(dir).units[0].rows.every((r) => r.dispatch === 'prepared'));
});

test('a new epoch fences every older handle, while another unit of the same epoch does not', () => {
  const dir = ws();
  const a = envUnit({ key: 'contoso_A' });
  const ha = prepare(dir, a);
  const hb = prepare(dir, apiUnit());
  S.sealCreateRow(ha, a.rows[0].id);
  assert.equal(S.isLiveCreateHandle(hb), true, 'a change to another unit leaves this handle live');
  const raw = readRaw(dir);
  raw.epoch = G();
  writeRaw(dir, raw);
  throwsCode(() => S.sealCreateRow(hb, unitOf(dir, hb.unitId).rows[0].id), 'configuration-create-state-invalid');
});

test('an emptied receipt rebinds to a new context with a new epoch; units of another context stop the prepare', () => {
  const dir = ws();
  const h = prepare(dir, envUnit({ value: false }));
  const before = readRaw(dir).epoch;
  throwsCode(() => S.prepareCreateUnit(dir, { kindTable: KIND_TABLE, context: OTHER_CONTEXT, unit: apiUnit() }), 'configuration-create-context-mismatch', { unitId: h.unitId });
  verifyAll(h, unitOf(dir, h.unitId));
  S.completeCreateUnit(h);
  S.prepareCreateUnit(dir, { kindTable: KIND_TABLE, context: OTHER_CONTEXT, unit: apiUnit() });
  const after = readRaw(dir);
  assert.notEqual(after.epoch, before);
  assert.equal(after.environmentFingerprint, OTHER_CONTEXT.environmentFingerprint);
});

test('a root or row that a saved unit already holds is pending, whether the unit is open or deferred', () => {
  const dir = ws();
  const unit = envUnit();
  const h = prepare(dir, unit);
  const again = envUnit();
  throwsCode(() => prepare(dir, again), 'configuration-create-pending', { unitId: h.unitId, rootKind: 'env-definition' });
  const sameId = apiUnit();
  sameId.rows[1].id = unit.rows[1].id;
  throwsCode(() => prepare(dir, sameId), 'configuration-create-pending');
  const { revision } = S.readConfigurationCreateState(dir, kt);
  const offer = S.prepareResolutionOffer(dir, { kindTable: KIND_TABLE, context: CONTEXT, unitId: h.unitId, mode: 'defer', expectedRevision: revision });
  S.resolveResolutionOffer(dir, { kindTable: KIND_TABLE, context: CONTEXT, unitId: h.unitId, mode: 'defer', token: offer.token });
  throwsCode(() => prepare(dir, envUnit()), 'configuration-create-pending', { unitId: h.unitId });
});

test('an unsupported unit shape is refused before anything is saved', () => {
  const dir = ws();
  const cases = [
    (u) => { u.rows[0].public.extra = 'x'; },
    (u) => { delete u.rows[0].public.displayname; },
    (u) => { u.rows[0].public.type = 1.5; },
    (u) => { u.rows[0].privateFields = ['defaultValue']; },
    (u) => { u.rows[1].parentId = G(); },
    (u) => { u.rows[1].kind = 'api-request'; u.rows[1].public = { uniquename: 'x', type: 1, isoptional: false }; u.rows[1].privateFields = []; },
    (u) => { u.rows[0].role = 'preserved'; u.rows[1].role = 'preserved'; },
    (u) => { u.publicationRequired = true; },
    (u) => { u.rows[0].id = u.rows[0].id.toUpperCase(); },
    (u) => { u.root.id = G(); },
    (u) => { u.rows[1].dispatch = 'verified'; },
    (u) => { u.extra = 1; },
  ];
  for (const mutate of cases) {
    const unit = envUnit();
    mutate(unit);
    throwsCode(() => prepare(dir, unit), 'configuration-create-shape-refused', { transition: 'prepare' });
  }
  assert.equal(fs.existsSync(stateFile(dir)), false);
});

// ── The strict parser ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function validState() {
  const dir = ws();
  prepare(dir, envUnit());
  prepare(dir, ruleUnit());
  return readRaw(dir);
}
const parseObj = (obj) => S.parseCreateState(Buffer.from(S.serializeCreateState(obj)), kt);

test('the parser accepts exactly what the module writes', () => {
  const obj = validState();
  const state = parseObj(obj);
  assert.equal(state.units.length, 2);
  assert.ok(Object.isFrozen(state.units[0].rows[0].public));
});

test('the parser refuses unknown keys, duplicates, broken parentage, unknown enums and an unknown schema', () => {
  const cases = {
    'unknown state key': (o) => { o.note = 'x'; },
    'unknown unit key': (o) => { o.units[0].note = 'x'; },
    'unknown row key': (o) => { o.units[0].rows[0].note = 'x'; },
    'unknown public field': (o) => { o.units[0].rows[0].public.extra = 'x'; },
    'duplicate row id in a unit': (o) => { o.units[0].rows[1].id = o.units[0].rows[0].id; },
    'duplicate row id across units': (o) => { o.units[1].rows[1].id = o.units[0].rows[1].id; },
    'duplicate unit id': (o) => { o.units[1].unitId = o.units[0].unitId; },
    'child under a missing parent': (o) => { o.units[0].rows[1].parentId = G(); },
    'child under the wrong parent kind': (o) => { o.units[1].rows[1].parentId = o.units[0].rows[0].id; },
    'root row with a parent': (o) => { o.units[0].rows[0].parentId = o.units[0].rows[1].id; },
    'two root rows': (o) => { o.units[0].rows[1] = { ...o.units[1].rows[0], id: G() }; },
    'duplicate active roots by key': (o) => { o.units[1] = JSON.parse(JSON.stringify(o.units[0])); o.units[1].unitId = G(); o.units[1].root.id = G(); o.units[1].rows[0].id = o.units[1].root.id; o.units[1].rows[1].id = G(); o.units[1].rows[1].parentId = o.units[1].root.id; },
    'unknown dispatch word': (o) => { o.units[0].rows[0].dispatch = 'sent'; },
    'preserved row with a dispatch state': (o) => { o.units[0].rows[0].role = 'preserved'; },
    'unknown unit state': (o) => { o.units[0].state = 'closed'; },
    'unknown root kind': (o) => { o.units[0].root.kind = 'env-value'; },
    'unknown row kind': (o) => { o.units[0].rows[1].kind = 'contoso-thing'; },
    'publication on a non-rule unit': (o) => { o.units[0].publication = { dispatch: 'prepared' }; },
    'publication dispatched before verification': (o) => { o.units[1].publication.dispatch = 'dispatched'; },
    'upper-case GUID': (o) => { o.epoch = o.epoch.toUpperCase(); },
    'negative revision': (o) => { o.revision = -1; },
    'unknown schema': (o) => { o.schema = 2; },
    'missing schema': (o) => { delete o.schema; },
    'private value smuggled as a private field name': (o) => { o.units[0].rows[0].privateFields = ['defaultValue', 'valueSchema', 'value']; },
    'offer with an unknown mode': (o) => { o.units[0].offer = { mode: 'adopt', nonceSha256: H(1), observedPublicSha256: null, publicIntentSha256: o.units[0].publicIntentSha256, privateAcknowledgmentRequired: false }; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const o = validState();
    mutate(o);
    throwsCode(() => parseObj(o), 'configuration-create-state-invalid', undefined);
    void name;
  }
});

test('the parser refuses bytes that are not exactly the canonical form', () => {
  const o = validState();
  const canonical = S.serializeCreateState(o);
  const bad = {
    compact: Buffer.from(`${JSON.stringify(o)}\n`),
    'no final newline': Buffer.from(canonical.slice(0, -1)),
    'byte-order mark': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonical)]),
    'duplicate JSON key': Buffer.from(canonical.replace('"schema": 1,', '"schema": 1,\n  "schema": 1,')),
    truncated: Buffer.from(canonical.slice(0, canonical.length / 2)),
    'invalid UTF-8': Buffer.concat([Buffer.from(canonical.slice(0, 20)), Buffer.from([0xc3, 0x28]), Buffer.from(canonical.slice(20))]),
    'number too large for a double': Buffer.from(canonical.replace(/"revision": \d+/, '"revision": 1e400')),
    'too deep': Buffer.from(`{"schema":1,"units":${'['.repeat(13)}${']'.repeat(13)}}`),
  };
  for (const [name, bytes] of Object.entries(bad)) {
    const e = throwsCode(() => S.parseCreateState(bytes, kt), 'configuration-create-state-invalid');
    if (name === 'number too large for a double') assert.match(e.message, /not finite/);
    if (name === 'too deep') assert.match(e.message, /deeper than the limit/);
  }
});

test('the parser refuses a file over 16 MiB, 128 units or 4096 rows without truncating it', () => {
  const big = Buffer.alloc(S.LIMITS.maxBytes + 1, 0x20);
  assert.match(throwsCode(() => S.parseCreateState(big, kt), 'configuration-create-state-invalid').message, /larger than 16 MiB/);
  const o = validState();
  const template = o.units[0];
  o.units = [];
  for (let i = 0; i <= S.LIMITS.maxUnits; i += 1) {
    const u = JSON.parse(JSON.stringify(template));
    u.unitId = G(); u.root.key = `contoso_S${i}`; u.root.id = G();
    u.rows[0].id = u.root.id; u.rows[0].key = u.root.key; u.rows[1].id = G(); u.rows[1].parentId = u.root.id;
    o.units.push(u);
  }
  assert.match(throwsCode(() => parseObj(o), 'configuration-create-state-invalid').message, /more units than the limit/);
  o.units = [template];
  for (let i = 0; i < S.LIMITS.maxRows; i += 1) template.rows.push({ ...template.rows[1], key: `v${i}`, id: G() });
  assert.match(throwsCode(() => parseObj(o), 'configuration-create-state-invalid').message, /more rows than the limit/);
});

test('valid JSON nested far past the depth limit is a typed invalid state that can be quarantined', () => {
  const dir = ws();
  const bytes = Buffer.from(`${'['.repeat(20000)}0${']'.repeat(20000)}`);
  fs.writeFileSync(stateFile(dir), bytes);
  assert.match(throwsCode(() => S.parseCreateState(bytes, kt), 'configuration-create-state-invalid').message, /deeper than the limit/);
  const marker = Buffer.from(`${'{"a":'.repeat(20000)}0${'}'.repeat(20000)}`);
  const id = G();
  fs.writeFileSync(path.join(dir, `${S.QUARANTINE_FILE_PREFIX}${id}.json`), marker);
  const found = S.discoverConfigurationCreateState(dir, kt);
  assert.equal(found.sidecar.status, 'invalid');
  assert.deepEqual(found.quarantines.map((q) => q.status), ['invalid']);
  fs.unlinkSync(path.join(dir, `${S.QUARANTINE_FILE_PREFIX}${id}.json`));
  const res = S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, invalidate: OK_INVALIDATE });
  assert.equal(res.halt.code, 'configuration-create-reconciled');
  assert.ok(fs.readFileSync(path.join(dir, `${S.ARCHIVE_FILE_PREFIX}${res.quarantineId}.bin`)).equals(bytes));
  assert.equal(S.discoverConfigurationCreateState(dir, kt).blocking, false);
});

test('admission refuses a unit beyond the unit, row or byte limit, counting its later transitions, and keeps the saved file', () => {
  const dir = ws();
  for (let i = 0; i < S.LIMITS.maxUnits; i += 1) prepare(dir, envUnit({ key: `contoso_S${i}`, value: false }));
  const before = fs.readFileSync(stateFile(dir));
  throwsCode(() => prepare(dir, envUnit({ key: 'contoso_Last', value: false })), 'configuration-create-shape-refused');
  assert.ok(fs.readFileSync(stateFile(dir)).equals(before), 'nothing was truncated or rewritten');

  const rowsDir = ws();
  const many = envUnit();
  for (let i = 0; i < S.LIMITS.maxRows; i += 1) many.rows.push({ ...many.rows[1], key: `v${i}`, id: G() });
  throwsCode(() => prepare(rowsDir, many), 'configuration-create-shape-refused');

  // A unit whose prepared form fits the byte limit, but whose dispatched form with an offer does not.
  const bytesDir = ws();
  const probe = envUnit({ value: false });
  prepare(bytesDir, probe);
  const small = fs.statSync(stateFile(bytesDir)).size;
  const sized = ws();
  const huge = envUnit({ value: false });
  huge.rows[0].public.description = 'x'.repeat(S.LIMITS.maxBytes - small - 64);
  const preparedSize = small + huge.rows[0].public.description.length - 'null'.length + 2;
  assert.ok(preparedSize <= S.LIMITS.maxBytes, 'the prepared form alone would fit');
  // Admission itself refuses it, not the size check every save makes afterwards.
  assert.match(throwsCode(() => prepare(sized, huge), 'configuration-create-shape-refused').message, /no room for this unit and its later transitions/);
  assert.equal(fs.existsSync(stateFile(sized)), false);
});

test('a save whose later transitions could pass the byte limit is refused and keeps the saved file', () => {
  const dir = ws();
  prepare(dir, envUnit({ value: false }));
  const before = fs.readFileSync(stateFile(dir));
  const e = throwsCode(() => S.withCreateStateTransaction(dir, kt, (draft) => {
    draft.units[0].rows[0].public.description = 'x'.repeat(S.LIMITS.maxBytes);
    return draft;
  }), 'configuration-create-shape-refused');
  assert.match(e.message, /would exceed its size limit/);
  assert.ok(fs.readFileSync(stateFile(dir)).equals(before));
});

test('admission reserves room to defer every admitted unit, with several open units at the exact byte limit', () => {
  // The largest form two admitted units can reach: both deferred, every create row dispatched, an accept-current offer on each and
  // the largest revision. A description sized to that form fills the 16 MiB exactly.
  const twoUnits = () => [envUnit({ key: 'contoso_First', value: false }), envUnit({ key: 'contoso_Second' })];
  const sampleDir = ws();
  for (const u of twoUnits()) prepare(sampleDir, u);
  const worst = readRaw(sampleDir);
  worst.revision = Number.MAX_SAFE_INTEGER;
  for (const u of worst.units) {
    u.state = 'deferred';
    for (const r of u.rows) if (r.role === 'create') r.dispatch = 'dispatched';
    u.offer = { mode: 'accept-current', nonceSha256: 'f'.repeat(64), observedPublicSha256: 'f'.repeat(64), publicIntentSha256: 'f'.repeat(64), privateAcknowledgmentRequired: false };
  }
  worst.units[1].rows[0].public.description = '';
  const padding = S.LIMITS.maxBytes - Buffer.byteLength(S.serializeCreateState(worst));
  const admit = (dir, extra) => {
    const [first, second] = twoUnits();
    second.rows[0].public.description = 'x'.repeat(padding + extra);
    return [prepare(dir, first), prepare(dir, second)];
  };
  assert.match(throwsCode(() => admit(ws(), 1), 'configuration-create-shape-refused').message, /no room for this unit and its later transitions/);
  const dir = ws();
  const handles = admit(dir, 0);
  const second = unitOf(dir, handles[1].unitId);
  for (const r of createRows(second)) S.sealCreateRow(handles[1], r.id);
  for (const h of handles) {
    const { revision } = S.readConfigurationCreateState(dir, kt);
    const { token } = S.prepareResolutionOffer(dir, { ...kt, context: CONTEXT, unitId: h.unitId, mode: 'defer', expectedRevision: revision });
    assert.equal(S.resolveResolutionOffer(dir, { ...kt, context: CONTEXT, unitId: h.unitId, mode: 'defer', token }).deferred, true);
  }
  for (const h of handles) {
    const { revision } = S.readConfigurationCreateState(dir, kt);
    S.prepareResolutionOffer(dir, { ...kt, context: CONTEXT, unitId: h.unitId, mode: 'accept-current', observedPublicSha256: 'a'.repeat(64), expectedRevision: revision });
  }
  assert.deepEqual(S.readConfigurationCreateState(dir, kt).units.map((u) => u.state), ['deferred', 'deferred']);
});

// ── Persistence ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('a failed write, rename or read-back is persistence-uncertain, says the row was not dispatched, and kills the handle', () => {
  const failures = {
    write: ['openSync', (real, p, ...rest) => { if (String(p).endsWith('.tmp')) { const e = new Error('disk full'); e.code = 'ENOSPC'; throw e; } return real(p, ...rest); }],
    rename: ['renameSync', (real, from, to) => { if (String(to).endsWith(S.STATE_FILE)) { const e = new Error('denied'); e.code = 'EACCES'; throw e; } return real(from, to); }],
  };
  for (const [name, [fn, impl]] of Object.entries(failures)) {
    const dir = ws();
    const unit = envUnit();
    const h = prepare(dir, unit);
    const e = withFsPatch(fn, impl, () => throwsCode(() => S.sealCreateRow(h, unit.rows[0].id), 'configuration-create-persistence-uncertain', { transition: 'seal', dispatched: false }));
    assert.match(e.message, /did not dispatch/, name);
    assert.equal(S.isLiveCreateHandle(h), false);
    assert.equal(readRaw(dir).units[0].rows[0].dispatch, 'prepared', `${name}: the old file is still in place`);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], `${name}: no temporary file is left`);
  }
  const dir = ws();
  const unit = envUnit();
  const h = prepare(dir, unit);
  let renamed = false;
  withFsPatch('renameSync', (real, from, to) => { real(from, to); if (String(to).endsWith(S.STATE_FILE)) renamed = true; }, () => {
    withFsPatch('readFileSync', (real, p, ...rest) => (renamed && String(p).endsWith(S.STATE_FILE) ? Buffer.from('changed') : real(p, ...rest)), () => {
      throwsCode(() => S.sealCreateRow(h, unit.rows[0].id), 'configuration-create-persistence-uncertain', { dispatched: false });
    });
  });
  assert.equal(S.isLiveCreateHandle(h), false);
});

test('a held state lease is state-busy and names the lock', () => {
  const dir = ws();
  const unit = envUnit();
  const h = prepare(dir, unit, { leaseDeps: FAST });
  fs.writeFileSync(path.join(dir, `${S.STATE_FILE}.lock`), 'held by another build');
  const e = throwsCode(() => S.sealCreateRow(h, unit.rows[0].id), 'configuration-create-state-busy');
  assert.ok(e.message.includes(`${S.STATE_FILE}.lock`));
  throwsCode(() => prepare(dir, apiUnit(), { leaseDeps: FAST }), 'configuration-create-state-busy');
  fs.unlinkSync(path.join(dir, `${S.STATE_FILE}.lock`));
  assert.equal(readRaw(dir).units.length, 1);
});

test('a state change must be synchronous, and a change that answers nothing writes nothing', () => {
  const dir = ws();
  prepare(dir, envUnit());
  const before = fs.readFileSync(stateFile(dir));
  assert.deepEqual(S.withCreateStateTransaction(dir, kt, () => undefined).changed, false);
  throwsCode(() => S.withCreateStateTransaction(dir, kt, (draft) => Promise.resolve(draft)), 'configuration-create-state-invalid');
  assert.ok(fs.readFileSync(stateFile(dir)).equals(before));
});

// ── Offers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function offerFor(dir, unitId, mode, extra = {}) {
  const { revision } = S.readConfigurationCreateState(dir, kt);
  return S.prepareResolutionOffer(dir, { kindTable: KIND_TABLE, context: CONTEXT, unitId, mode, expectedRevision: revision, ...extra });
}
const resolve = (dir, unitId, mode, token, extra = {}) => S.resolveResolutionOffer(dir, { kindTable: KIND_TABLE, context: CONTEXT, unitId, mode, token, ...extra });

test('an offer saves only the hash of a random nonce, and its token is single-use', () => {
  const dir = ws();
  const h = prepare(dir, apiUnit());
  const obs = H('observation');
  const a = offerFor(dir, h.unitId, 'accept-current', { observedPublicSha256: obs });
  const b = offerFor(dir, h.unitId, 'accept-current', { observedPublicSha256: obs });
  const [, nonceA] = a.token.split('.');
  const [, nonceB] = b.token.split('.');
  assert.match(a.token, /^\d+\.[0-9a-f]{64}$/);
  assert.notEqual(nonceA, nonceB);
  const text = fs.readFileSync(stateFile(dir), 'utf8');
  assert.ok(!text.includes(nonceB), 'the nonce itself is never saved');
  assert.ok(text.includes(sha256(Buffer.from(nonceB, 'hex'))));
  assert.equal(a.privateAcknowledgmentRequired, false);
  throwsCode(() => resolve(dir, h.unitId, 'accept-current', a.token, { observedPublicSha256: obs }), 'configuration-create-approval-stale');
  const res = resolve(dir, h.unitId, 'accept-current', b.token, { observedPublicSha256: obs });
  assert.equal(res.removed, true);
  throwsCode(() => resolve(dir, h.unitId, 'accept-current', b.token, { observedPublicSha256: obs }), 'configuration-create-approval-stale');
});

test('any change to the saved state makes an offer stale, and every mismatch is approval-stale', () => {
  const dir = ws();
  const unit = apiUnit();
  const h = prepare(dir, unit);
  const obs = H('observation');
  const o1 = offerFor(dir, h.unitId, 'accept-current', { observedPublicSha256: obs });
  prepare(dir, envUnit());
  throwsCode(() => resolve(dir, h.unitId, 'accept-current', o1.token, { observedPublicSha256: obs }), 'configuration-create-approval-stale');
  assert.equal(readRaw(dir).units[0].offer, null, 'a change clears every saved offer');
  const o2 = offerFor(dir, h.unitId, 'accept-current', { observedPublicSha256: obs });
  const [rev] = o2.token.split('.');
  throwsCode(() => resolve(dir, h.unitId, 'defer', o2.token), 'configuration-create-approval-stale');
  const o3 = offerFor(dir, h.unitId, 'accept-current', { observedPublicSha256: obs });
  throwsCode(() => resolve(dir, h.unitId, 'accept-current', o3.token, { observedPublicSha256: H('another observation') }), 'configuration-create-approval-stale');
  const o4 = offerFor(dir, h.unitId, 'accept-current', { observedPublicSha256: obs });
  throwsCode(() => resolve(dir, h.unitId, 'accept-current', `${o4.revision}.${'0'.repeat(64)}`, { observedPublicSha256: obs }), 'configuration-create-approval-stale');
  throwsCode(() => resolve(dir, h.unitId, 'accept-current', 'not a token', { observedPublicSha256: obs }), 'configuration-create-approval-stale');
  throwsCode(() => resolve(dir, G(), 'accept-current', o4.token, { observedPublicSha256: obs }), 'configuration-create-approval-stale');
  throwsCode(() => S.prepareResolutionOffer(dir, { kindTable: KIND_TABLE, context: CONTEXT, unitId: h.unitId, mode: 'defer', expectedRevision: Number(rev) - 1 }), 'configuration-create-approval-stale');
  throwsCode(() => offerFor(dir, h.unitId, 'accept-current'), 'configuration-create-shape-refused');
  throwsCode(() => S.prepareResolutionOffer(dir, { kindTable: KIND_TABLE, context: OTHER_CONTEXT, unitId: h.unitId, mode: 'defer', expectedRevision: S.readConfigurationCreateState(dir, kt).revision }), 'configuration-create-context-mismatch');
  assert.equal(unitOf(dir, h.unitId).state, 'open');
});

test('a sensitive unit needs the private-state acknowledgment to be accepted', () => {
  const dir = ws();
  const h = prepare(dir, envUnit());
  const obs = H('observation');
  const offer = offerFor(dir, h.unitId, 'accept-current', { observedPublicSha256: obs });
  assert.equal(offer.privateAcknowledgmentRequired, true);
  throwsCode(() => resolve(dir, h.unitId, 'accept-current', offer.token, { observedPublicSha256: obs }), 'configuration-create-private-review-required');
  assert.equal(unitOf(dir, h.unitId).state, 'open');
  const again = offerFor(dir, h.unitId, 'accept-current', { observedPublicSha256: obs });
  assert.equal(resolve(dir, h.unitId, 'accept-current', again.token, { observedPublicSha256: obs, acceptCurrentPrivateState: true }).removed, true);
});

test('cancel needs a wholly prepared unit; defer keeps a tombstone that can be accepted later but not deferred again', () => {
  const dir = ws();
  const unit = apiUnit();
  const h = prepare(dir, unit);
  S.sealCreateRow(h, unit.rows[0].id);
  throwsCode(() => offerFor(dir, h.unitId, 'cancel-unsent'), 'configuration-create-pending');
  const d = offerFor(dir, h.unitId, 'defer');
  const res = resolve(dir, h.unitId, 'defer', d.token);
  assert.equal(res.deferred, true);
  const saved = unitOf(dir, h.unitId);
  assert.equal(saved.state, 'deferred');
  assert.deepEqual(saved.rows.map((r) => r.id), unit.rows.map((r) => r.id), 'every row identity is kept');
  throwsCode(() => S.markCreateRowVerified(h, unit.rows[0].id), 'configuration-create-state-invalid');
  throwsCode(() => offerFor(dir, h.unitId, 'defer'), 'configuration-create-approval-stale');
  const obs = H('observation');
  const a = offerFor(dir, h.unitId, 'accept-current', { observedPublicSha256: obs });
  assert.equal(resolve(dir, h.unitId, 'accept-current', a.token, { observedPublicSha256: obs }).removed, true);
});

// ── Discovery ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('discovery ignores lease and temporary names but treats any other entry as blocking evidence', () => {
  const dir = ws();
  prepare(dir, envUnit());
  fs.writeFileSync(path.join(dir, `${S.STATE_FILE}.lock.reclaim`), '');
  fs.writeFileSync(path.join(dir, `${S.STATE_FILE}.123.456.abc.tmp`), 'partial');
  let found = S.discoverConfigurationCreateState(dir, kt);
  assert.equal(found.blocking, false);
  assert.equal(found.sidecar.status, 'valid');
  fs.writeFileSync(path.join(dir, 'configuration-create-state.v1.json.bak'), '{}');
  found = S.discoverConfigurationCreateState(dir, kt);
  assert.equal(found.unknownEntries, 1);
  assert.equal(found.blocking, true);
  assert.deepEqual(S.discoverConfigurationCreateState(path.join(dir, 'absent')), { root: null, sidecar: { status: 'absent' }, quarantines: [], orphanArchives: [], unknownEntries: 0, blocking: false });
});

test('a state file that cannot be read is invalid, never absent', () => {
  const dir = ws();
  fs.mkdirSync(stateFile(dir));
  const found = S.discoverConfigurationCreateState(dir, kt);
  assert.equal(found.sidecar.status, 'invalid');
  assert.equal(found.blocking, true);
  throwsCode(() => S.readConfigurationCreateState(dir, kt), 'configuration-create-state-invalid');
});

test('saved units cannot be read without the kind table, and that is not a verdict that the file is invalid', () => {
  const dir = ws();
  prepare(dir, envUnit());
  throwsCode(() => S.readConfigurationCreateState(dir), 'configuration-create-shape-refused');
  throwsCode(() => S.assertConfigurationCreateWorkspaceClearable(dir), 'configuration-create-workspace-in-use');
});

// ── Quarantine ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const CANARY = 'CANARY-7f3c-private-default-value';
const OK_INVALIDATE = () => ({ ok: true });
function unreadable(dir) {
  const bytes = Buffer.from(`{"schema": 1, "units": [{"unitId": "${G()}", "value": "${CANARY}"`);
  fs.writeFileSync(stateFile(dir), bytes);
  return bytes;
}
function assertNoCanary(text, where) {
  assert.ok(!text.includes(CANARY), `${where} holds the canary`);
  assert.ok(!text.includes(sha256(CANARY)), `${where} holds the canary's hash`);
}

test('quarantine keeps the exact bytes in an archive beside a tombstone that holds no ids, content or digest', () => {
  const dir = ws();
  const original = unreadable(dir);
  const ids = [...original.toString('utf8').matchAll(/[0-9a-f]{8}-[0-9a-f-]{27}/g)].map((m) => m[0]);
  throwsCode(() => S.quarantineUnreadableReceipt(dir, { invalidate: OK_INVALIDATE }), 'configuration-create-state-invalid', { transition: 'quarantine' });
  const calls = [];
  const res = S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, invalidate: (root) => { calls.push(root); return { ok: true }; } });
  assert.equal(calls.length, 1, 'the apply snapshot is invalidated first');
  assert.equal(res.halt.code, 'configuration-create-reconciled');
  assert.equal(fs.existsSync(stateFile(dir)), false);
  const archive = fs.readFileSync(path.join(dir, `${S.ARCHIVE_FILE_PREFIX}${res.quarantineId}.bin`));
  assert.ok(archive.equals(original), 'the archive holds the original bytes exactly');
  const markerText = fs.readFileSync(path.join(dir, `${S.QUARANTINE_FILE_PREFIX}${res.quarantineId}.json`), 'utf8');
  const marker = JSON.parse(markerText);
  assert.deepEqual(Object.keys(marker), ['schema', 'quarantineId', 'state', 'dispatch', 'scope', 'archive']);
  assert.equal(marker.state, 'deferred');
  assert.equal(marker.dispatch, 'unknown');
  assertNoCanary(markerText, 'the marker');
  assert.ok(!markerText.includes(sha256(original)), 'the marker holds no digest of the archive');
  for (const id of ids) assert.ok(!markerText.includes(id), 'the marker reconstructs no id from the lost receipt');
  assertNoCanary(res.halt.message, 'the reconciled halt');
  const found = S.discoverConfigurationCreateState(dir, kt);
  assert.equal(found.blocking, false);
  assert.deepEqual(found.quarantines, [{ quarantineId: res.quarantineId, status: 'valid', state: 'deferred', archive: true }]);
});

test('quarantine refuses a readable or absent receipt and a failed snapshot invalidation', () => {
  const dir = ws();
  throwsCode(() => S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, invalidate: OK_INVALIDATE }), 'configuration-create-approval-stale');
  const h = prepare(dir, envUnit());
  throwsCode(() => S.quarantineUnreadableReceipt(dir, { ...kt, acknowledgeUnknownDispatch: true, invalidate: OK_INVALIDATE }), 'configuration-create-pending', { unitId: h.unitId });
  const other = ws();
  const original = unreadable(other);
  throwsCode(() => S.quarantineUnreadableReceipt(other, { acknowledgeUnknownDispatch: true, invalidate: () => ({ ok: false }) }), 'configuration-create-persistence-uncertain');
  assert.ok(fs.readFileSync(stateFile(other)).equals(original));
  assert.deepEqual(fs.readdirSync(other).filter((n) => n !== S.STATE_FILE), [], 'nothing was archived or marked');
});

test('an interrupted quarantine leaves an archiving barrier that blocks and that a continuation finishes', () => {
  // Interrupted before the copy reached the archive name.
  const dir = ws();
  const original = unreadable(dir);
  withFsPatch('copyFileSync', () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, () => {
    throwsCode(() => S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, invalidate: OK_INVALIDATE }), 'configuration-create-persistence-uncertain', { transition: 'quarantine' });
  });
  let found = S.discoverConfigurationCreateState(dir, kt);
  assert.equal(found.blocking, true);
  const [q] = found.quarantines;
  assert.equal(q.state, 'archiving');
  assert.ok(fs.readFileSync(stateFile(dir)).equals(original));
  throwsCode(() => S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, invalidate: OK_INVALIDATE }), 'configuration-create-state-invalid');
  S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, quarantineId: q.quarantineId, invalidate: OK_INVALIDATE });
  found = S.discoverConfigurationCreateState(dir, kt);
  assert.equal(found.blocking, false);
  assert.ok(fs.readFileSync(path.join(dir, `${S.ARCHIVE_FILE_PREFIX}${q.quarantineId}.bin`)).equals(original));

  // Interrupted after the archive was in place but before the original was removed.
  const dir2 = ws();
  const original2 = unreadable(dir2);
  withFsPatch('unlinkSync', (real, p) => { if (String(p).endsWith(S.STATE_FILE)) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return real(p); }, () => {
    throwsCode(() => S.quarantineUnreadableReceipt(dir2, { acknowledgeUnknownDispatch: true, invalidate: OK_INVALIDATE }), 'configuration-create-persistence-uncertain');
  });
  const [q2] = S.discoverConfigurationCreateState(dir2, kt).quarantines;
  assert.equal(q2.state, 'archiving');
  assert.equal(q2.archive, true);
  S.quarantineUnreadableReceipt(dir2, { acknowledgeUnknownDispatch: true, quarantineId: q2.quarantineId.toUpperCase(), invalidate: OK_INVALIDATE });
  assert.equal(fs.existsSync(stateFile(dir2)), false);
  assert.ok(fs.readFileSync(path.join(dir2, `${S.ARCHIVE_FILE_PREFIX}${q2.quarantineId}.bin`)).equals(original2));
});

test('quarantine never overwrites a file that took the archive name while the copy was made', () => {
  const dir = ws();
  const original = unreadable(dir);
  let archive;
  // `<archive>.<pid>.<ms>.<random>.tmp` is the temporary copy; plant a foreign file at `<archive>` right after it is written.
  withFsPatch('copyFileSync', (real, from, to, flags) => {
    real(from, to, flags);
    archive = String(to).replace(/\.\d+\.\d+\.[0-9a-z]*\.tmp$/, '');
    fs.writeFileSync(archive, 'foreign');
  }, () => {
    throwsCode(() => S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, invalidate: OK_INVALIDATE }), 'configuration-create-persistence-uncertain', { transition: 'quarantine' });
  });
  assert.ok(archive.endsWith('.bin'));
  assert.equal(fs.readFileSync(archive, 'utf8'), 'foreign');
  assert.ok(fs.readFileSync(stateFile(dir)).equals(original));
});

// Plants a foreign file at a quarantine name at the very moment that name is installed (the real rename or link runs right after), as
// a sync client or a person could; the install must refuse rather than replace it.
function withForeignAtInstall(isTarget, fn) {
  const planted = [];
  const plant = (real) => (from, to, ...rest) => {
    if (planted.length === 0 && isTarget(path.basename(String(to)))) {
      fs.writeFileSync(String(to), 'FOREIGN EVIDENCE');
      planted.push(String(to));
    }
    return real(from, to, ...rest);
  };
  return withFsPatch('renameSync', (real, ...args) => plant(real)(...args), () => withFsPatch('linkSync', (real, ...args) => plant(real)(...args), () => fn(planted)));
}

test('quarantine never replaces a file that takes the archive or a fresh marker name as it is installed', () => {
  const dir = ws();
  const original = unreadable(dir);
  withForeignAtInstall((name) => /^configuration-create-state\.unreadable\.[0-9a-f-]{36}\.bin$/.test(name), (planted) => {
    throwsCode(() => S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, invalidate: OK_INVALIDATE }), 'configuration-create-persistence-uncertain', { transition: 'quarantine' });
    assert.equal(planted.length, 1, 'the archive was installed');
    assert.equal(fs.readFileSync(planted[0], 'utf8'), 'FOREIGN EVIDENCE');
  });
  assert.ok(fs.readFileSync(stateFile(dir)).equals(original));
  const found = S.discoverConfigurationCreateState(dir, kt);
  assert.equal(found.blocking, true);
  assert.equal(found.quarantines[0].state, 'archiving');

  const dir2 = ws();
  const original2 = unreadable(dir2);
  withForeignAtInstall((name) => /^configuration-create-state\.quarantine\.[0-9a-f-]{36}\.json$/.test(name), (planted) => {
    throwsCode(() => S.quarantineUnreadableReceipt(dir2, { acknowledgeUnknownDispatch: true, invalidate: OK_INVALIDATE }), 'configuration-create-persistence-uncertain', { transition: 'quarantine' });
    assert.equal(planted.length, 1, 'the fresh marker was installed');
    assert.equal(fs.readFileSync(planted[0], 'utf8'), 'FOREIGN EVIDENCE');
  });
  assert.ok(fs.readFileSync(stateFile(dir2)).equals(original2));
  assert.deepEqual(fs.readdirSync(dir2).filter((n) => n.includes('.unreadable.')), [], 'nothing was archived');

  // Without hard links there is no atomic no-replace: refuse, never fall back to a replacing rename.
  const dir3 = ws();
  const original3 = unreadable(dir3);
  const renamedOnto = [];
  withFsPatch('linkSync', () => { throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' }); }, () => withFsPatch('renameSync', (real, from, to) => { renamedOnto.push(path.basename(String(to))); return real(from, to); }, () => {
    throwsCode(() => S.quarantineUnreadableReceipt(dir3, { acknowledgeUnknownDispatch: true, invalidate: OK_INVALIDATE }), 'configuration-create-persistence-uncertain', { transition: 'quarantine' });
  }));
  assert.ok(renamedOnto.every((n) => n.endsWith('.tmp')), 'no quarantine name was renamed onto');
  assert.ok(fs.readFileSync(stateFile(dir3)).equals(original3));
  assert.deepEqual(fs.readdirSync(dir3).filter((n) => !n.endsWith('.tmp')), [S.STATE_FILE]);
});

// The staged name installNoReplace gives a quarantine file before it links it: `<marker or archive name>.<pid>.<ms>.<random>.tmp`.
const STAGED_MARKER_RE = /^configuration-create-state\.quarantine\.[0-9a-f-]{36}\.json\.\d+\.\d+\.[0-9a-z]*\.tmp$/;
const STAGED_ARCHIVE_RE = /^configuration-create-state\.unreadable\.[0-9a-f-]{36}\.bin\.\d+\.\d+\.[0-9a-z]*\.tmp$/;
const markerOf = (dir, id) => path.join(dir, `${S.QUARANTINE_FILE_PREFIX}${id}.json`);
const archiveOf = (dir, id) => path.join(dir, `${S.ARCHIVE_FILE_PREFIX}${id}.bin`);
const tmpNames = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
// Every unlink of a staged name `re` matches fails with EBUSY: `times` failures, then the file system is healthy again.
function withStagedUnlinkBusy(re, times, fn) {
  let left = times;
  return withFsPatch('unlinkSync', (real, p) => {
    if (left > 0 && re.test(path.basename(String(p)))) { left -= 1; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }
    return real(p);
  }, fn);
}
function assertFinished(dir, id, original) {
  const found = S.discoverConfigurationCreateState(dir, kt);
  assert.equal(found.blocking, false);
  assert.deepEqual(found.quarantines, [{ quarantineId: id, status: 'valid', state: 'deferred', archive: true }]);
  assert.equal(fs.lstatSync(markerOf(dir, id)).nlink, 1, 'the marker has one name');
  assert.equal(fs.lstatSync(archiveOf(dir, id)).nlink, 1, 'the archive has one name');
  assert.ok(fs.readFileSync(archiveOf(dir, id)).equals(original));
  assert.equal(fs.existsSync(stateFile(dir)), false);
  assert.deepEqual(tmpNames(dir), [], 'no staged name is left');
}

test('a staged name that stays after an install halts the quarantine, and a continuation on healthy storage removes it and finishes', () => {
  for (const [what, re] of [['marker', STAGED_MARKER_RE], ['archive', STAGED_ARCHIVE_RE]]) {
    const dir = ws();
    const original = unreadable(dir);
    withStagedUnlinkBusy(re, Infinity, () => {
      throwsCode(() => S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, invalidate: OK_INVALIDATE }), 'configuration-create-persistence-uncertain', { transition: 'quarantine', reason: 'a quarantine file was installed, but its staged copy could not be removed' });
    });
    const [q] = S.discoverConfigurationCreateState(dir, kt).quarantines;
    assert.equal(q.state, 'archiving', `${what}: the barrier stays`);
    const installed = what === 'marker' ? markerOf(dir, q.quarantineId) : archiveOf(dir, q.quarantineId);
    assert.equal(fs.lstatSync(installed).nlink, 2, `${what}: the staged name still holds the installed file`);
    assert.ok(fs.readFileSync(stateFile(dir)).equals(original), `${what}: the original is kept`);
    S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, quarantineId: q.quarantineId, invalidate: OK_INVALIDATE });
    assertFinished(dir, q.quarantineId, original);
  }

  // One lock on the staged marker name, then healthy storage: the quarantine finishes, by its retry or by the continuation.
  const dir = ws();
  const original = unreadable(dir);
  let id;
  withStagedUnlinkBusy(STAGED_MARKER_RE, 1, () => {
    try { id = S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, invalidate: OK_INVALIDATE }).quarantineId; } catch (e) {
      assert.equal(e.code, 'configuration-create-persistence-uncertain', e.message);
    }
  });
  if (!id) {
    id = S.discoverConfigurationCreateState(dir, kt).quarantines[0].quarantineId;
    S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, quarantineId: id, invalidate: OK_INVALIDATE });
  }
  assertFinished(dir, id, original);
});

test('a crash between the link and the removal of the staged name leaves a quarantine that a continuation finishes', () => {
  const child = String.raw`
    const fs = require('node:fs');
    const S = require(process.argv[1]);
    const re = new RegExp(process.argv[3]);
    const real = fs.unlinkSync;
    fs.unlinkSync = (p) => { if (re.test(require('node:path').basename(String(p)))) process.exit(70); return real(p); };
    S.quarantineUnreadableReceipt(process.argv[2], { acknowledgeUnknownDispatch: true, invalidate: () => ({ ok: true }) });
    process.exit(0);`;
  for (const [what, re] of [['marker', STAGED_MARKER_RE], ['archive', STAGED_ARCHIVE_RE]]) {
    const dir = ws();
    const original = unreadable(dir);
    const run = spawnSync(process.execPath, ['-e', child, require.resolve('../lib/configuration-create-state.js'), dir, re.source], { encoding: 'utf8' });
    assert.equal(run.status, 70, `${what}: the child stopped right after the link: ${run.stderr}`);
    // The dead child's record lease is left behind; taking over a lease is record-lease.js's own subject, so the test removes it.
    fs.rmSync(path.join(dir, `${S.STATE_FILE}.lock`), { force: true });
    const [q] = S.discoverConfigurationCreateState(dir, kt).quarantines;
    assert.equal(q.state, 'archiving');
    assert.equal(tmpNames(dir).filter((n) => re.test(n)).length, 1, `${what}: the staged name was left`);
    S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, quarantineId: q.quarantineId, invalidate: OK_INVALIDATE });
    assertFinished(dir, q.quarantineId, original);
  }
});

test('a continuation removes no hard link and no file that it cannot prove is its own staged name', () => {
  // The staged name stayed, and somebody else also linked the marker: three names, none removed, the marker is not replaced.
  const dir = ws();
  const original = unreadable(dir);
  withStagedUnlinkBusy(STAGED_MARKER_RE, Infinity, () => {
    throwsCode(() => S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, invalidate: OK_INVALIDATE }), 'configuration-create-persistence-uncertain');
  });
  const [q] = S.discoverConfigurationCreateState(dir, kt).quarantines;
  const foreign = path.join(dir, 'marker-backup.json');
  fs.linkSync(markerOf(dir, q.quarantineId), foreign);
  throwsCode(() => S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, quarantineId: q.quarantineId, invalidate: OK_INVALIDATE }), 'configuration-create-persistence-uncertain', { reason: 'the saved file is not a plain file that can be replaced' });
  assert.ok(fs.existsSync(foreign));
  assert.equal(tmpNames(dir).filter((n) => STAGED_MARKER_RE.test(n)).length, 1, 'the staged name is kept beside a foreign link');
  assert.equal(fs.lstatSync(markerOf(dir, q.quarantineId)).nlink, 3);
  assert.equal(S.discoverConfigurationCreateState(dir, kt).quarantines[0].state, 'archiving');
  const kept = fs.existsSync(stateFile(dir)) ? stateFile(dir) : archiveOf(dir, q.quarantineId);
  assert.ok(fs.readFileSync(kept).equals(original), 'the original bytes are kept');

  // The marker's only other name is a foreign link, and a file with the staged name and the same bytes is a separate file: neither is removed.
  const dir2 = ws();
  const original2 = unreadable(dir2);
  withFsPatch('copyFileSync', () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, () => {
    throwsCode(() => S.quarantineUnreadableReceipt(dir2, { acknowledgeUnknownDispatch: true, invalidate: OK_INVALIDATE }), 'configuration-create-persistence-uncertain');
  });
  const [q2] = S.discoverConfigurationCreateState(dir2, kt).quarantines;
  const marker2 = markerOf(dir2, q2.quarantineId);
  const foreign2 = path.join(dir2, 'marker-backup.json');
  fs.linkSync(marker2, foreign2);
  const lookalike = `${marker2}.1.2.abc.tmp`;
  fs.copyFileSync(marker2, lookalike);
  throwsCode(() => S.quarantineUnreadableReceipt(dir2, { acknowledgeUnknownDispatch: true, quarantineId: q2.quarantineId, invalidate: OK_INVALIDATE }), 'configuration-create-persistence-uncertain', { reason: 'the saved file is not a plain file that can be replaced' });
  assert.ok(fs.existsSync(foreign2) && fs.existsSync(lookalike));
  assert.equal(fs.lstatSync(marker2).nlink, 2);
  // Once the foreign link is gone the continuation finishes, and the separate look-alike file is still not touched.
  fs.unlinkSync(foreign2);
  S.quarantineUnreadableReceipt(dir2, { acknowledgeUnknownDispatch: true, quarantineId: q2.quarantineId, invalidate: OK_INVALIDATE });
  assert.ok(fs.readFileSync(archiveOf(dir2, q2.quarantineId)).equals(original2));
  assert.ok(fs.existsSync(lookalike), 'a separate file is never removed');
});

test('an archive name that is a folder or cannot be read is never a verified quarantine, and a continuation does not adopt it', () => {
  const quarantined = () => {
    const dir = ws();
    unreadable(dir);
    const { quarantineId } = S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, invalidate: OK_INVALIDATE });
    return { dir, quarantineId, archive: path.join(dir, `${S.ARCHIVE_FILE_PREFIX}${quarantineId}.bin`), marker: path.join(dir, `${S.QUARANTINE_FILE_PREFIX}${quarantineId}.json`) };
  };
  const denyArchive = (archive, fn) => {
    const deny = (real, file, ...rest) => {
      if (path.resolve(String(file)) === archive) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      return real(file, ...rest);
    };
    return withFsPatch('openSync', deny, () => withFsPatch('readFileSync', deny, fn));
  };

  // A folder at the archive name of a deferred quarantine.
  const a = quarantined();
  fs.unlinkSync(a.archive);
  fs.mkdirSync(a.archive);
  for (const found of [S.discoverConfigurationCreateState(a.dir, kt), S.discoverConfigurationQuarantines(a.dir)]) {
    assert.equal(found.quarantines[0].archive, false);
  }
  assert.equal(S.discoverConfigurationCreateState(a.dir, kt).blocking, true);
  throwsCode(() => S.quarantineUnreadableReceipt(a.dir, { acknowledgeUnknownDispatch: true, quarantineId: a.quarantineId, invalidate: OK_INVALIDATE }), 'configuration-create-state-invalid');
  assert.ok(fs.statSync(a.archive).isDirectory());

  // An archive this user cannot read.
  const b = quarantined();
  denyArchive(b.archive, () => {
    const found = S.discoverConfigurationCreateState(b.dir, kt);
    assert.equal(found.quarantines[0].archive, false);
    assert.equal(found.blocking, true);
  });

  // An orphan archive that cannot be read, or that is a folder: its marker is not restored.
  const c = quarantined();
  const archived = fs.readFileSync(c.archive);
  fs.unlinkSync(c.marker);
  let invalidations = 0;
  denyArchive(c.archive, () => {
    throwsCode(() => S.quarantineUnreadableReceipt(c.dir, { acknowledgeUnknownDispatch: true, quarantineId: c.quarantineId, invalidate: () => { invalidations += 1; return { ok: true }; } }), 'configuration-create-state-invalid', { transition: 'quarantine' });
  });
  assert.equal(invalidations, 0);
  assert.equal(fs.existsSync(c.marker), false);
  assert.ok(fs.readFileSync(c.archive).equals(archived));
  const d = quarantined();
  fs.unlinkSync(d.marker);
  fs.unlinkSync(d.archive);
  fs.mkdirSync(d.archive);
  assert.deepEqual(S.discoverConfigurationCreateState(d.dir, kt).orphanArchives, [d.quarantineId]);
  throwsCode(() => S.quarantineUnreadableReceipt(d.dir, { acknowledgeUnknownDispatch: true, quarantineId: d.quarantineId, invalidate: OK_INVALIDATE }), 'configuration-create-state-invalid');
  assert.equal(fs.existsSync(d.marker), false);
  // The readable orphan of the same shape is adopted, as before.
  S.quarantineUnreadableReceipt(c.dir, { acknowledgeUnknownDispatch: true, quarantineId: c.quarantineId, invalidate: OK_INVALIDATE });
  assert.equal(S.discoverConfigurationCreateState(c.dir, kt).blocking, false);
});

test('a continuation keeps both files when the state file and its archive differ', () => {
  const dir = ws();
  unreadable(dir);
  withFsPatch('unlinkSync', (real, p) => { if (String(p).endsWith(S.STATE_FILE)) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return real(p); }, () => {
    throwsCode(() => S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, invalidate: OK_INVALIDATE }), 'configuration-create-persistence-uncertain');
  });
  const [q] = S.discoverConfigurationCreateState(dir, kt).quarantines;
  fs.writeFileSync(stateFile(dir), 'something else');
  throwsCode(() => S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, quarantineId: q.quarantineId, invalidate: OK_INVALIDATE }), 'configuration-create-state-invalid');
  assert.equal(fs.readFileSync(stateFile(dir), 'utf8'), 'something else');
  assert.ok(fs.existsSync(path.join(dir, `${S.ARCHIVE_FILE_PREFIX}${q.quarantineId}.bin`)));
});

test('an orphan archive blocks until its marker is restored', () => {
  const dir = ws();
  unreadable(dir);
  const { quarantineId } = S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, invalidate: OK_INVALIDATE });
  fs.unlinkSync(path.join(dir, `${S.QUARANTINE_FILE_PREFIX}${quarantineId}.json`));
  let found = S.discoverConfigurationCreateState(dir, kt);
  assert.deepEqual(found.orphanArchives, [quarantineId]);
  assert.equal(found.blocking, true);
  S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, quarantineId, invalidate: OK_INVALIDATE });
  found = S.discoverConfigurationCreateState(dir, kt);
  assert.equal(found.blocking, false);
  assert.equal(found.quarantines[0].state, 'deferred');
  // A marker whose archive is gone blocks as well.
  fs.unlinkSync(path.join(dir, `${S.ARCHIVE_FILE_PREFIX}${quarantineId}.bin`));
  assert.equal(S.discoverConfigurationCreateState(dir, kt).blocking, true);
  // A hand-edited marker is invalid.
  fs.writeFileSync(path.join(dir, `${S.QUARANTINE_FILE_PREFIX}${quarantineId}.json`), '{}');
  assert.equal(S.discoverConfigurationCreateState(dir, kt).quarantines[0].status, 'invalid');
});

test('teardown and clearing are refused while any configuration create evidence remains', () => {
  S.assertConfigurationCreateWorkspaceClearable(path.join(ws(), 'absent'), kt);
  const empty = ws();
  const h = prepare(empty, envUnit({ value: false }));
  throwsCode(() => S.assertConfigurationCreateWorkspaceClearable(empty, kt), 'configuration-create-workspace-in-use', { unitId: h.unitId });
  verifyAll(h, unitOf(empty, h.unitId));
  S.completeCreateUnit(h);
  S.assertConfigurationCreateWorkspaceClearable(empty, kt);

  const deferred = ws();
  const hd = prepare(deferred, apiUnit());
  resolve(deferred, hd.unitId, 'defer', offerFor(deferred, hd.unitId, 'defer').token);
  throwsCode(() => S.assertConfigurationCreateWorkspaceClearable(deferred, kt), 'configuration-create-workspace-in-use');

  const bad = ws();
  unreadable(bad);
  throwsCode(() => S.assertConfigurationCreateWorkspaceClearable(bad, kt), 'configuration-create-workspace-in-use');
  S.quarantineUnreadableReceipt(bad, { acknowledgeUnknownDispatch: true, invalidate: OK_INVALIDATE });
  throwsCode(() => S.assertConfigurationCreateWorkspaceClearable(bad, kt), 'configuration-create-workspace-in-use');

  const unknown = ws();
  fs.writeFileSync(path.join(unknown, 'configuration-create-state.v2.json'), '{}');
  throwsCode(() => S.assertConfigurationCreateWorkspaceClearable(unknown, kt), 'configuration-create-workspace-in-use');
});

// ── Quarantine across processes ──────────────────────────────────────────────────────────────────────────────────────────────────────
// The quarantine is safe among processes that hold the leases the build's quarantine command takes: the app's build lease around it and
// the record lease inside it. These tests run each quarantine in its own OS process (helpers/configuration-quarantine-crash-child.js)
// that holds the real leases and ends with no unwinding at a chosen file system step, and the next run is this process, which takes the
// dead process's leases over through the production lease code, as the next command would. Nothing removes a lock file by hand.
const CRASH_CHILD = path.join(__dirname, 'helpers', 'configuration-quarantine-crash-child.js');
const CRASH_EXIT = 80;
const QUARANTINE_APP = 'contoso_app';
const CHILD_ENV = (() => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return env; })();
const ARCHIVE_RE = /^configuration-create-state\.unreadable\.[0-9a-f-]{36}\.bin$/;

function runQuarantineChild(input) {
  return new Promise((resolve) => {
    const arg = Buffer.from(JSON.stringify({ appUniqueName: QUARANTINE_APP, ...input })).toString('base64');
    const child = spawn(process.execPath, [CRASH_CHILD, arg], { env: CHILD_ENV, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => {
      const last = stdout.trim().split('\n').pop();
      let out = null;
      try { out = JSON.parse(last); } catch { /* reported below */ }
      resolve({ status, out, stderr, stdout });
    });
  });
}
// Runs `fn` over `items` with at most `size` at once; every item runs, and the first failure is thrown once all have settled.
async function inPool(items, size, fn) {
  const failures = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try { await fn(item); } catch (e) { failures.push(e); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  if (failures.length > 0) throw failures[0];
}
const samePoint = (a, b) => a.fn === b.fn && a.phase === b.phase && JSON.stringify(a.labels) === JSON.stringify(b.labels);
const describePoint = (p) => `${p.phase} ${p.fn}(${p.labels.join(', ')}) #${p.n}`;
const lastLabel = (p) => p.labels[p.labels.length - 1];
// The original bytes are in the workspace at the state file or at an installed archive name; a staged copy alone does not count.
function originalSurvives(dir, original) {
  return fs.readdirSync(dir).some((n) => (n === S.STATE_FILE || ARCHIVE_RE.test(n)) && fs.readFileSync(path.join(dir, n)).equals(original));
}
function snapshotFiles(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map((n) => [n, fs.readFileSync(path.join(dir, n)).toString('base64')]));
}
async function crashAt(dir, original, input, expected) {
  const run = await runQuarantineChild({ dir, ...input });
  assert.equal(run.status, CRASH_EXIT, `the quarantine process did not stop at ${JSON.stringify(input)}: ${run.stdout}${run.stderr}`);
  if (expected) assert.ok(samePoint(run.out.stopped, expected), `stopped at ${describePoint(run.out.stopped)}, not ${describePoint(expected)}`);
  const where = describePoint(run.out.stopped);
  assert.ok(originalSurvives(dir, original), `${where}: the original bytes survive the crash`);
  assert.ok(fs.existsSync(path.join(dir, buildLockName(QUARANTINE_APP))), `${where}: the dead process still holds the build lease`);
  assert.ok(fs.existsSync(path.join(dir, `${S.STATE_FILE}.lock`)), `${where}: the dead process still holds the record lease`);
  return where;
}
// The next command: takes the build lease (over from the dead process), then quarantines.
async function nextQuarantine(dir, quarantineId) {
  const warnings = [];
  try {
    const out = await withAppBuildLease({ workspaceDir: dir, appUniqueName: QUARANTINE_APP, warn: (m) => warnings.push(m) },
      () => S.quarantineUnreadableReceipt(dir, { acknowledgeUnknownDispatch: true, quarantineId, invalidate: OK_INVALIDATE }));
    return { out, warnings };
  } catch (error) {
    return { error, warnings };
  }
}
// What a person does after a crash: run the quarantine again; if it names an interrupted quarantine, finish that one by its id.
async function recoverAfterCrash(dir, original, where) {
  const first = await nextQuarantine(dir);
  assert.ok(first.warnings.some((w) => w.startsWith(`released the build lock for '${QUARANTINE_APP}'`)), `${where}: the next run took over the dead build lease: ${first.warnings.join(' | ')}`);
  if (!first.error) {
    assert.equal(first.out.halt.code, 'configuration-create-reconciled');
    return first.out.quarantineId;
  }
  const e = first.error;
  assert.equal(e.name, 'ConfigurationCreateHalt', `${where}: ${e.stack}`);
  assert.ok(originalSurvives(dir, original), `${where}: the original bytes survive the refused run`);
  const named = /--quarantine-id ([0-9a-f-]{36})/.exec(e.nextStep || '');
  if (!named) {
    // The crash came after the last step that mattered: there is nothing left to quarantine.
    assert.equal(e.code, 'configuration-create-approval-stale', `${where}: ${e.message}`);
    const [q] = S.discoverConfigurationCreateState(dir, kt).quarantines;
    return q && q.quarantineId;
  }
  assert.equal(e.code, 'configuration-create-state-invalid', `${where}: ${e.message}`);
  const second = await nextQuarantine(dir, named[1]);
  assert.ok(!second.error, `${where}: the continuation failed: ${second.error && second.error.message}`);
  assert.equal(second.out.halt.code, 'configuration-create-reconciled');
  return second.out.quarantineId;
}
// Finished: one deferred quarantine with the exact bytes, nothing blocking, and each installed file under one name. A crash can leave a
// temporary or staged copy that discovery ignores; it is debris, not a quarantine name.
function assertQuarantined(dir, id, original, where) {
  assert.ok(id, `${where}: a quarantine finished`);
  const found = S.discoverConfigurationCreateState(dir, kt);
  assert.equal(found.blocking, false, `${where}: the workspace is not blocked`);
  assert.deepEqual(found.quarantines, [{ quarantineId: id, status: 'valid', state: 'deferred', archive: true }], where);
  assert.deepEqual(found.orphanArchives, [], `${where}: no archive without a marker`);
  assert.ok(fs.readFileSync(archiveOf(dir, id)).equals(original), `${where}: the archive holds the original bytes`);
  assert.equal(fs.lstatSync(markerOf(dir, id)).nlink, 1, `${where}: the marker has one name`);
  assert.equal(fs.lstatSync(archiveOf(dir, id)).nlink, 1, `${where}: the archive has one name`);
  assert.equal(fs.existsSync(stateFile(dir)), false, `${where}: the state file is gone`);
}
// The points a crash grid stops at: every `after` checkpoint, plus the `before` of the first (the process dies before it changes a file).
const crashPoints = (trace) => [trace[0], ...trace.filter((p) => p.phase === 'after')];

test('a quarantine process that dies at any file step leaves the bytes, and the next leased run finishes it', async () => {
  const traced = ws();
  const tracedOriginal = unreadable(traced);
  const full = await runQuarantineChild({ dir: traced });
  assert.equal(full.status, 0, full.stderr);
  assert.equal(full.out.halt, 'configuration-create-reconciled', full.stdout);
  assertQuarantined(traced, full.out.quarantineId, tracedOriginal, 'the uninterrupted run');
  const { trace } = full.out;
  // The grid must reach every install and removal the protocol makes, or it proves nothing.
  for (const [fn, last] of [['linkSync', 'marker'], ['linkSync', 'archive'], ['unlinkSync', 'state'], ['renameSync', 'marker'], ['unlinkSync', 'marker-stage'], ['unlinkSync', 'archive-stage']]) {
    assert.ok(trace.some((p) => p.phase === 'after' && p.fn === fn && lastLabel(p) === last), `the run reached ${fn}(${last}): ${trace.map(describePoint).join('; ')}`);
  }
  await inPool(crashPoints(trace), 4, async (point) => {
    const dir = ws();
    const original = unreadable(dir);
    const where = await crashAt(dir, original, { stop: point.n }, point);
    assertQuarantined(dir, await recoverAfterCrash(dir, original, where), original, where);
  });
});

test('a continuation that dies at any file step is itself finished by the next leased run', async () => {
  // The first quarantine dies right after it installs the marker, or right after it installs the archive; the continuation by its id then
  // dies at each of its own steps.
  for (const last of ['marker', 'archive']) {
    const setUp = async () => {
      const dir = ws();
      const original = unreadable(dir);
      await crashAt(dir, original, { stopMatch: { fn: 'linkSync', phase: 'after', last } });
      const [q] = S.discoverConfigurationCreateState(dir, kt).quarantines;
      assert.equal(q.state, 'archiving');
      return { dir, original, id: q.quarantineId };
    };
    const traced = await setUp();
    const full = await runQuarantineChild({ dir: traced.dir, quarantineId: traced.id });
    assert.equal(full.out && full.out.halt, 'configuration-create-reconciled', `${last}: ${full.stdout}${full.stderr}`);
    assertQuarantined(traced.dir, traced.id, traced.original, `the uninterrupted continuation after ${last}`);
    const { trace } = full.out;
    assert.ok(trace.some((p) => p.fn === 'unlinkSync' && lastLabel(p) === `${last}-stage`), `${last}: the continuation removed the staged name`);
    assert.ok(trace.some((p) => p.fn === 'renameSync' && lastLabel(p) === 'marker'), `${last}: the continuation wrote the deferred marker`);
    await inPool(crashPoints(trace), 4, async (point) => {
      const { dir, original, id } = await setUp();
      const where = `after ${last}, the continuation: ${await crashAt(dir, original, { quarantineId: id, stop: point.n }, point)}`;
      const finished = await recoverAfterCrash(dir, original, where);
      assert.equal(finished, id, `${where}: the same quarantine finished`);
      assertQuarantined(dir, id, original, where);
    });
  }
});

// Starts a quarantine process that stops, holding both leases, right after it installs its marker; answers once it is there.
async function pausedQuarantine(dir) {
  const signals = ws();
  const ready = path.join(signals, 'ready');
  const release = path.join(signals, 'release');
  const done = runQuarantineChild({ dir, pause: { match: { fn: 'linkSync', phase: 'after', last: 'marker' }, ready, release } });
  let settled = null;
  done.then((r) => { settled = r; });
  const end = Date.now() + 60000;
  while (!fs.existsSync(ready)) {
    if (settled) assert.fail(`the quarantine process ended before it paused: ${settled.stdout}${settled.stderr}`);
    if (Date.now() > end) assert.fail('the quarantine process never paused');
    await new Promise((r) => setTimeout(r, 20));
  }
  return { done, release: () => fs.writeFileSync(release, 'go') };
}

test('a second quarantine is refused by a live build lease and waits on a live record lease, and neither touches the first one\'s files', async () => {
  // Another build command: refused at once by the build lease, before the quarantine runs.
  const dir = ws();
  const original = unreadable(dir);
  const first = await pausedQuarantine(dir);
  let finished;
  try {
    const before = snapshotFiles(dir);
    let ran = false;
    await assert.rejects(withAppBuildLease({ workspaceDir: dir, appUniqueName: QUARANTINE_APP, warn() {} }, () => { ran = true; }), (e) => e.code === 'build-locked');
    assert.equal(ran, false, 'the second quarantine never ran');
    assert.deepEqual(snapshotFiles(dir), before, 'the refused run changed no file, lock files included');
  } finally {
    first.release();
    finished = await first.done;
  }
  assert.equal(finished.out && finished.out.halt, 'configuration-create-reconciled', finished.stdout + finished.stderr);
  assertQuarantined(dir, finished.out.quarantineId, original, 'the first quarantine');

  // A quarantine that holds only the record lease: it waits while the first holds it, and then finds nothing left to quarantine.
  const dir2 = ws();
  const original2 = unreadable(dir2);
  const holder = await pausedQuarantine(dir2);
  let waits = 0;
  let unchangedWhileHeld = null;
  let invalidated = 0;
  let second;
  try {
    const before = snapshotFiles(dir2);
    second = (() => {
      try {
        return S.quarantineUnreadableReceipt(dir2, {
          acknowledgeUnknownDispatch: true,
          invalidate: () => { invalidated += 1; return { ok: true }; },
          leaseDeps: {
            attempts: 6000,
            sleep(ms) {
              waits += 1;
              if (waits === 1) {
                unchangedWhileHeld = JSON.stringify(snapshotFiles(dir2)) === JSON.stringify(before);
                holder.release();
              }
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
            },
          },
        });
      } catch (e) { return e; }
    })();
  } finally {
    holder.release();
  }
  const held = await holder.done;
  assert.ok(waits >= 1, 'the second quarantine waited for the record lease');
  assert.equal(unchangedWhileHeld, true, 'the waiting quarantine changed no file while the first held the lease');
  assert.equal(held.out && held.out.halt, 'configuration-create-reconciled', held.stdout + held.stderr);
  assert.equal(second.code, 'configuration-create-approval-stale', second.message);
  assert.equal(invalidated, 0, 'the second quarantine invalidated nothing');
  assertQuarantined(dir2, held.out.quarantineId, original2, 'the first quarantine');
});

// ── Privacy ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('a private value handed to the receipt by mistake is refused and never reaches the file or a message', () => {
  const dir = ws();
  const messages = [];
  const cases = [
    (u) => { u.rows[0].public.defaultValue = CANARY; },
    (u) => { u.rows[1].value = CANARY; },
    (u) => { u.rows[1].public[CANARY] = 'x'; },
    (u) => { u.rows[0].privateFields = [CANARY, 'valueSchema']; },
  ];
  for (const mutate of cases) {
    const unit = envUnit();
    mutate(unit);
    messages.push(throwsCode(() => prepare(dir, unit), 'configuration-create-shape-refused').message);
  }
  prepare(dir, envUnit());
  assertNoCanary(fs.readFileSync(stateFile(dir), 'utf8'), 'the receipt');
  // An unreadable receipt holding the canary: discovery, every refusal and the quarantine name none of it.
  const bad = ws();
  unreadable(bad);
  const found = S.discoverConfigurationCreateState(bad, kt);
  messages.push(JSON.stringify(found));
  messages.push(throwsCode(() => S.readConfigurationCreateState(bad, kt), 'configuration-create-state-invalid').message);
  messages.push(throwsCode(() => S.assertConfigurationCreateWorkspaceClearable(bad, kt), 'configuration-create-workspace-in-use').message);
  const { halt } = S.quarantineUnreadableReceipt(bad, { acknowledgeUnknownDispatch: true, invalidate: OK_INVALIDATE });
  messages.push(halt.message);
  for (const name of fs.readdirSync(bad).filter((n) => !n.startsWith(S.ARCHIVE_FILE_PREFIX))) {
    messages.push(name, fs.readFileSync(path.join(bad, name), 'utf8'));
  }
  for (const m of messages) assertNoCanary(m, 'a message or file');
});
