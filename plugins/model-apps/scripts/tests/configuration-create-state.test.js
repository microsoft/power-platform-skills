'use strict';
// The durable receipt of default configuration creates (#807): the strict parser, the fenced transitions, the approval offers, the
// quarantine of an unreadable receipt, and the stop codes. Every test works in a temporary workspace of its own.
const { makeTempDir } = require('./helpers/temp-dirs.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sha256 } = require('../lib/hash.js');
const S = require('../lib/configuration-create-state.js');

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
