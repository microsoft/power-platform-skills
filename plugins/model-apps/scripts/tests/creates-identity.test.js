'use strict';
// The stable create identity (lib/creates-identity.js) is FROZEN: the same spec must give the same ids in every process, release
// and machine, forever — a changed id is a second row on the next run. These goldens pin every root kind, every scope and every
// child kind to its exact UUID, so any change to the namespace, the encoding, a canonical rule or a registry fails here first.
// The values were checked against an independent UUIDv5 implementation (Python's uuid.uuid5 over the same JSON input).
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const I = require('../lib/creates-identity.js');
const { intentFor } = require('../lib/creates-capabilities.js');

const SOL = { kind: 'solution', solution: 'ContosoCore' };
const TABLE = { kind: 'table', solution: 'ContosoCore', table: 'contoso_Order' };
const APP = { kind: 'app', solution: 'ContosoCore', app: 'contoso_SalesHub' };
const PARENT = '11111111-2222-5333-8444-555555555555';

const ROOTS = {
  view: [TABLE, [0, 'active orders'], '497d8c71-813c-5be5-a9c8-327d81fcbbf5'],
  form: [TABLE, [2, 'order main'], 'aafea7fa-670b-5f9d-81a3-38403aa39741'],
  chart: [TABLE, ['orders by owner'], '2180e980-3c3c-5106-99c6-e5e617535372'],
  dashboard: [SOL, [0, '', 'sales overview'], '46faa245-5bef-59d5-95dd-409d7262a920'],
  businessRule: [TABLE, ['require-total'], '005348d9-52c3-5af1-9585-7f16f17169a3'],
  bpf: [TABLE, ['order-flow'], 'aa276ecd-8cff-52a8-80f0-091ef6cc5de0'],
  app: [APP, [], '700e4c3d-1e4f-5096-b525-a4c6d7feac51'],
  appaction: [TABLE, [0, 'grid', 'refresh'], 'ead2d419-ee34-5a0a-ac99-4cf9e56fa828'],
  genPage: [APP, ['welcome'], 'a1e4bb8d-77cf-55a6-abcb-60a89e256131'],
  fieldSecurityProfile: [SOL, ['pii-readers'], 'c45814e2-7169-5adc-a795-f6cdd72c43a9'],
  environmentVariable: [SOL, ['contoso_apiurl'], 'd0e1470b-2b38-5ee5-bf10-046c4c5a9df6'],
  connectionReference: [SOL, ['contoso_sharedsql'], '1863f37d-8b74-552b-9546-7a637efd918b'],
  customApi: [SOL, ['contoso_recalc'], 'c6ace132-4bf1-5645-84fe-30f6f1960fe4'],
  duplicateRule: [SOL, ['dup-email'], 'f90903ed-3b76-53d0-86fc-333d2ed4252e'],
};
const CHILDREN = {
  sitemap: [[], '21811e54-1263-505b-8f97-6850770b11b6'],
  fieldPermission: [['contoso_order', 'contoso_ssn'], '9ccb3b06-5367-5476-bf65-fc98405631dc'],
  environmentVariableValue: [['value'], 'ef5db351-e43f-58c5-9ee4-915f115c59f5'],
  customApiRequestParameter: [['target'], 'b2535a0d-2194-5b48-a0aa-fed57a7aa863'],
  customApiResponseProperty: [['target'], 'bcfcf63e-b1d0-5f94-b96b-a64eaa79d8c9'],
  duplicateRuleCondition: [['email-exact'], '52ed5b32-d59d-5a8e-82da-2cafcc5a3e00'],
  bpfStage: [['qualify'], 'd3f607ce-82d7-5fe5-a9bc-0be480ca5bdc'],
  bpfStep: [['qualify', 'budget'], 'ab1acc72-9b9c-55ba-81ad-4385f4ccb097'],
  // The declared form and dashboard document ids (checked with Python's uuid.uuid5 over the same compact JSON input).
  formTab: [['general'], '1860fa5a-0a05-5321-908b-2cfa90792785'],
  formSection: [['general', 'details'], '74e5aef3-14de-5432-aa7a-b8b2ab51acb0'],
  formCell: [['order main', 'contoso_total'], '11ed89f0-f796-504b-899d-fba334ec611c'],
  formControl: [['order main', 'contoso_total'], '2266e82e-448a-5014-b174-73637bb010b0'],
  formHostSection: [['subgrid', 'contoso_order_lines'], '8f01be86-36ee-590b-916b-c6fab698fce0'],
  formHostCell: [['quickView', 'contoso_customerid'], '1f2aa3b1-e797-57c8-8315-bee930f618ec'],
  formHostControl: [['subgrid', 'contoso_order_lines'], '1ee46629-d584-5248-afe8-0a1e0e93e7b4'],
  formSpacer: [['details-1'], '45dab51d-18c4-5e1b-b87d-359952915955'],
  dashboardSeedTab: [['seed-tab'], 'bf01d9af-1d34-5c51-9cf1-ffa04c62d9f4'],
  dashboardSeedSection: [['seed-section'], 'bde1d88b-91e8-5b03-b82d-cf8ddf541b87'],
  dashboardCell: [['open-orders', 'cell'], '191a44ca-4cea-54c5-b40d-f3383f7d4d06'],
  dashboardControl: [['open-orders', 'control'], '32da3d4d-f4d8-5754-9181-2edfc7678e3b'],
};

const root = (kind, scope, keyParts) => I.stableCreateIdV1({ scope, kind, keyParts });

test('UUIDv5 is the RFC 9562 algorithm (the DNS-namespace vector), and the namespace is the published one', () => {
  assert.strictEqual(I.uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com'), '2ed6657d-e927-568b-95e1-2665a8aea6a2');
  assert.strictEqual(I.NAMESPACE, '720af730-457f-5a30-bd2b-9161508cb517');
  assert.strictEqual(I.uuidV5(I.URL_NAMESPACE, I.NAMESPACE_URL), I.NAMESPACE);
  assert.strictEqual(I.ALGORITHM_VERSION, 1);
});

test('golden: every root kind gives its frozen id', () => {
  assert.deepStrictEqual(Object.keys(ROOTS).sort(), Object.keys(I.ROOT_KINDS).sort(), 'every registered root kind has a golden');
  for (const [kind, [scope, keyParts, id]] of Object.entries(ROOTS)) assert.strictEqual(root(kind, scope, keyParts), id, kind);
});

test('golden: every child kind gives its frozen id under its actual parent', () => {
  assert.deepStrictEqual(Object.keys(CHILDREN).sort(), Object.keys(I.CHILD_KINDS).sort(), 'every registered child kind has a golden');
  for (const [kind, [parts, id]] of Object.entries(CHILDREN)) assert.strictEqual(I.stableChildIdV1(PARENT, kind, parts), id, kind);
  // The parent's spelling does not matter; its value does.
  assert.strictEqual(I.stableChildIdV1(PARENT.toUpperCase(), 'bpfStage', ['qualify']), CHILDREN.bpfStage[1]);
  assert.notStrictEqual(I.stableChildIdV1('11111111-2222-5333-8444-555555555556', 'bpfStage', ['qualify']), CHILDREN.bpfStage[1]);
});

test('a fresh process derives the same ids (nothing is stored, nothing is random)', () => {
  const lib = path.join(__dirname, '..', 'lib', 'creates-identity.js');
  const code = `const I=require(${JSON.stringify(lib)});process.stdout.write(JSON.stringify([I.stableCreateIdV1(${JSON.stringify({ scope: TABLE, kind: 'view', keyParts: [0, 'active orders'] })}),I.stableChildIdV1(${JSON.stringify(PARENT)},'fieldPermission',['contoso_order','contoso_ssn'])]))`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), [ROOTS.view[2], CHILDREN.fieldPermission[1]]);
});

test('scope, subtype, kind and direction each separate identities; one table shared by two scopes does not', () => {
  const v = ROOTS.view[2];
  assert.notStrictEqual(root('view', { ...TABLE, table: 'contoso_invoice' }, [0, 'active orders']), v, 'same name on another table');
  assert.notStrictEqual(root('view', { ...TABLE, solution: 'Other' }, [0, 'active orders']), v, 'another solution');
  assert.notStrictEqual(root('view', TABLE, [4, 'active orders']), v, 'another query type');
  assert.notStrictEqual(root('form', TABLE, [0, 'active orders']), v, 'another kind');
  assert.notStrictEqual(root('form', TABLE, [6, 'order main']), ROOTS.form[2], 'Main and Quick View with one name');
  assert.notStrictEqual(root('appaction', APP, [0, 'grid', 'refresh']), ROOTS.appaction[2], 'table- vs app-scoped command');
  // Direction: a child id is not a root id and a parent/child pair is not symmetric.
  const p = ROOTS.customApi[2];
  const req = I.stableChildIdV1(p, 'customApiRequestParameter', ['target']);
  const res = I.stableChildIdV1(p, 'customApiResponseProperty', ['target']);
  assert.notStrictEqual(req, res, 'a request parameter and a response property sharing a name');
  assert.notStrictEqual(I.stableChildIdV1(req, 'customApiRequestParameter', ['target']), req);
});

test('aliases converge, delimiters cannot collide, order matters', () => {
  // Logical names are case-insensitive in Dataverse: one table, one identity.
  assert.strictEqual(root('view', { ...TABLE, table: 'CONTOSO_ORDER', solution: 'contosocore' }, [0, 'active orders']), ROOTS.view[2]);
  // A display name folds as the build's name lookup does (case, width, trailing spaces); a meaningful space does not.
  const caps = intentFor('view', { key: 'v', scope: TABLE, declaration: { queryType: 0, name: 'Active Orders  ' } });
  assert.strictEqual(root('view', TABLE, caps.keyParts), ROOTS.view[2]);
  const spaced = intentFor('view', { key: 'v', scope: TABLE, declaration: { queryType: 0, name: 'Active  Orders' } });
  assert.notStrictEqual(root('view', TABLE, spaced.keyParts), ROOTS.view[2]);
  // An explicit key is byte for byte (no folding at all).
  const keyed = intentFor('fieldSecurityProfile', { key: 'p', scope: SOL, declaration: { key: 'PII-Readers' } });
  assert.notStrictEqual(root('fieldSecurityProfile', SOL, keyed.keyParts), ROOTS.fieldSecurityProfile[2]);
  // The JSON array encoding keeps parts apart: no delimiter can make two keys one.
  assert.notStrictEqual(I.stableChildIdV1(PARENT, 'fieldPermission', ['a.b', 'c']), I.stableChildIdV1(PARENT, 'fieldPermission', ['a', 'b.c']));
  assert.notStrictEqual(root('dashboard', SOL, [0, 'a', 'b|c']), root('dashboard', SOL, [0, 'a|b', 'c']));
  assert.notStrictEqual(root('dashboard', SOL, [0, '', '1']), root('dashboard', SOL, [0, '', 1]), 'a number is not its string');
  assert.notStrictEqual(I.stableChildIdV1(PARENT, 'fieldPermission', ['x', 'y']), I.stableChildIdV1(PARENT, 'fieldPermission', ['y', 'x']));
});

test('golden: a display name folds case, accents, widths and trailing spaces to one frozen id', () => {
  // Literal vectors, checked against Python's uuid.uuid5 over
  // ["model-apps.create",1,"table","contosocore","account","view",0,"cafe sales"]. A fold that kept accents or full widths
  // (a plain lowercase and trim) would give each spelling its own id, and so a second view on the next run.
  const ACCOUNT = { kind: 'table', solution: 'contosocore', table: 'account' };
  const idOf = (name) => root('view', ACCOUNT, intentFor('view', { key: 'v', scope: ACCOUNT, declaration: { queryType: 0, name } }).keyParts);
  for (const name of ['Cafe Sales', 'Caf\u00e9 Sales', '\uff23\uff41\uff46\uff45 Sales', 'CAFE SALES  ']) {
    assert.strictEqual(idOf(name), '75458ea7-387e-5fa9-8af6-762422d5861a', JSON.stringify(name));
  }
  // A meaningful inner space is kept.
  assert.strictEqual(idOf('Cafe  Sales'), '8187cb1f-ad55-5382-82bb-52d8218019b0');
});

test('a duplicate-rule condition keeps its id when its criteria change; only its key identifies it', () => {
  const parent = ROOTS.duplicateRule[2];
  const before = intentFor('duplicateRule', { key: 'r', scope: SOL, declaration: { key: 'dup-email' }, children: [{ locator: 'c1', childKind: 'duplicateRuleCondition', declaration: { key: 'email-exact', attribute: 'emailaddress1', operator: 0 } }] });
  const after = intentFor('duplicateRule', { key: 'r', scope: SOL, declaration: { key: 'dup-email' }, children: [{ locator: 'c1', childKind: 'duplicateRuleCondition', declaration: { key: 'email-exact', attribute: 'emailaddress2', operator: 1, ignoreBlank: true } }] });
  const id = (intent) => I.stableChildIdV1(parent, 'duplicateRuleCondition', intent.children.c1.keyParts);
  assert.strictEqual(id(before), id(after));
  assert.strictEqual(id(before), I.stableChildIdV1(parent, 'duplicateRuleCondition', ['email-exact']));
});

test('a child created with its parent and one added later get the same id', () => {
  // The one rule for both: the intent's child slot under the ACTUAL parent id. There is no second "update-added" rule.
  const composite = intentFor('customApi', { key: 'a', scope: SOL, declaration: { uniqueName: 'contoso_Recalc' }, children: [{ locator: 'Target', childKind: 'customApiRequestParameter', declaration: { uniqueName: 'Target' } }] });
  const later = intentFor('customApi', { key: 'a', scope: SOL, declaration: { uniqueName: 'contoso_recalc' }, children: [{ locator: 'target', childKind: 'customApiRequestParameter', declaration: { uniqueName: 'target' } }] });
  const parent = root('customApi', SOL, composite.keyParts);
  assert.strictEqual(parent, ROOTS.customApi[2]);
  assert.strictEqual(I.stableChildIdV1(parent, 'customApiRequestParameter', composite.children.Target.keyParts), I.stableChildIdV1(parent, 'customApiRequestParameter', later.children.target.keyParts));
  // An established (imported, legacy) parent id: children derive under IT, not under a derived replacement.
  const legacy = '0f0f0f0f-1111-4222-8333-444444444444';
  assert.notStrictEqual(I.stableChildIdV1(legacy, 'customApiRequestParameter', ['target']), I.stableChildIdV1(parent, 'customApiRequestParameter', ['target']));
});

test('invalid identity input is refused before anything could be sent', () => {
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'no error'; };
  assert.strictEqual(code(() => root('view', TABLE, [0])), 'create-identity-invalid', 'too few key parts');
  assert.strictEqual(code(() => root('view', SOL, [0, 'x'])), 'create-identity-invalid', 'wrong scope');
  assert.strictEqual(code(() => root('view', { ...TABLE, table: ' contoso_order' }, [0, 'x'])), 'create-identity-invalid', 'surrounding space is not trimmed into a valid name');
  assert.strictEqual(code(() => root('view', TABLE, [-1, 'x'])), 'create-identity-invalid');
  assert.strictEqual(code(() => root('view', TABLE, [0, null])), 'create-identity-invalid');
  assert.strictEqual(code(() => root('securityRole', SOL, ['x'])), 'create-identity-unsupported', 'a kind with no caller id');
  assert.strictEqual(code(() => I.stableChildIdV1('not-a-guid', 'bpfStage', ['a'])), 'create-identity-invalid');
  assert.strictEqual(code(() => I.stableChildIdV1(PARENT, 'wfomNode', ['a'])), 'create-identity-unsupported', 'a rule node is not a child kind');
  assert.strictEqual(code(() => I.stableChildIdV1(PARENT, 'formCell', ['a'])), 'create-identity-invalid', 'a field cell needs its form key and its field');
  assert.throws(() => I.stableChildIdV1(PARENT, 'bpfStep', ['budget']), /bpfStep has 1 part\(s\); expected 2/, 'a step keeps its stage key although its parent is the stage');
  assert.strictEqual(code(() => intentFor('view', { key: 'v', scope: TABLE, declaration: { queryType: 0, name: '   ' } })), 'create-identity-invalid');
  const err = (() => { try { root('view', TABLE, [0]); } catch (e) { return e; } })();
  assert.strictEqual(err.transient, false, 'an identity stop is never retried');
  assert.ok(I.CREATE_STOP_CODES.includes(err.code));
});

test('createIdentity: absent is legacy; only exactly "stable-v1" turns it on; anything else is an error', () => {
  assert.strictEqual(I.readCreateIdentityMode({}), 'legacy');
  assert.strictEqual(I.readCreateIdentityMode(undefined), 'legacy');
  assert.strictEqual(I.readCreateIdentityMode({ createIdentity: 'stable-v1' }), 'stable-v1');
  for (const bad of [null, true, false, 'stable-v2', 'STABLE-V1', ' stable-v1', {}, 1]) {
    assert.throws(() => I.readCreateIdentityMode({ createIdentity: bad }), (e) => e.code === 'create-identity-invalid', JSON.stringify(bad));
  }
});
