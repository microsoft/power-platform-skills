'use strict';
// The normalized page turn request (lib/page-turn-intent.js): what a caller-held turn id is bound to, and the closed record that keeps it.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeTurnId, normalizeTurnRequest, makeTurnRecord, validateTurnRecord, hashEffectiveInputs, strictJsonCopy, turnDifference,
} = require('../lib/page-turn-intent.js');

const ENV = 'https://contoso.crm.dynamics.com';
const TURN = '6f1c2a4e-9b3d-47a1-b85c-0e2f7d914a63';
const PAGE = '77777777-7777-4777-8777-777777777777';
const BUNDLED = { kind: 'bundled', sdkBundleSha256: 'a'.repeat(64), typescriptVersion: '5.0.0', typescriptSha256: 'b'.repeat(64) };
const SOURCE = 'export default function Page() { return null; }\n';
const BINDING = { logicalName: 'contoso_service', connectorId: '/providers/Microsoft.PowerApps/apis/shared_contoso', dataset: 'after' };

const req = (args = {}, { operation = 'update', compilerIdentity = BUNDLED, environment = ENV } = {}) => normalizeTurnRequest({ operation, environment, args: { source: SOURCE, ...args }, compilerIdentity });
const code = (c) => (e) => e.code === c && e.outcome === 'nothing';

test('a turn id: only an omitted one is "none"; a GUID is taken with braces and capitals, as lower case; anything else is refused', () => {
  assert.strictEqual(normalizeTurnId(undefined), undefined);
  assert.strictEqual(normalizeTurnId(`{${TURN.toUpperCase()}}`), TURN);
  assert.strictEqual(normalizeTurnId(` ${TURN} `), TURN);
  for (const bad of [null, '', '  ', 'turn-1', 42, `{${TURN}`, {}]) assert.throws(() => normalizeTurnId(bad), code('GENPAGE_TURN_ID_INVALID'), JSON.stringify(bad));
});

test('the binding mode is part of the request: the same content merged into the page\'s entries and put in place of them are two requests', () => {
  const merged = req({ connectorBindings: [BINDING], specBindings: true });
  const replaced = req({ connectorBindings: [BINDING], specBindings: false });
  assert.strictEqual(merged.contentSha256, replaced.contentSha256, 'the content is the same');
  assert.notStrictEqual(merged.requestSha256, replaced.requestSha256);
  assert.deepStrictEqual([merged.request.bindingMode, replaced.request.bindingMode], ['spec-merge', 'replace']);
  assert.strictEqual(req({ connectorBindings: [BINDING] }).requestSha256, replaced.requestSha256, 'an omitted mode is replace');
  assert.throws(() => req({ specBindings: 'yes' }), code('GENPAGE_ARGUMENT_INVALID'));
});

test('every part of the request moves its hash — publication, receipt, messages, an omitted list against an empty one — and key order does not', () => {
  const base = req({ dataSources: ['account'], connectorBindings: [BINDING], prompt: 'change' });
  const variants = {
    draft: req({ dataSources: ['account'], connectorBindings: [BINDING], prompt: 'change', publish: false }),
    receipt: req({ dataSources: ['account'], connectorBindings: [BINDING], prompt: 'change', publishedFingerprint: 'c'.repeat(64) }),
    prompt: req({ dataSources: ['account'], connectorBindings: [BINDING], prompt: 'change ' }),
    defaultPrompt: req({ dataSources: ['account'], connectorBindings: [BINDING] }),
    agentMessage: req({ dataSources: ['account'], connectorBindings: [BINDING], prompt: 'change', agentMessage: '' }),
    emptyList: req({ dataSources: [], connectorBindings: [BINDING], prompt: 'change' }),
    noList: req({ connectorBindings: [BINDING], prompt: 'change' }),
    otherEnvironment: req({ dataSources: ['account'], connectorBindings: [BINDING], prompt: 'change' }, { environment: 'https://fabrikam.crm.dynamics.com' }),
  };
  const hashes = new Set([base.requestSha256, ...Object.values(variants).map((v) => v.requestSha256)]);
  assert.strictEqual(hashes.size, Object.keys(variants).length + 1, 'every variant is a request of its own');
  const reordered = req({ prompt: 'change', connectorBindings: [{ dataset: 'after', connectorId: BINDING.connectorId, logicalName: BINDING.logicalName }], dataSources: ['account'] });
  assert.strictEqual(reordered.requestSha256, base.requestSha256);
  assert.strictEqual(req({ dataSources: ['account'], connectorBindings: [BINDING], prompt: 'change' }, { environment: 'https://CONTOSO.crm.dynamics.com/' }).requestSha256, base.requestSha256, 'the environment is its origin');
  for (const bad of ['http://contoso.crm.dynamics.com', 'https://contoso.crm.dynamics.com/api', 'contoso']) assert.throws(() => req({}, { environment: bad }), code('GENPAGE_ARGUMENT_INVALID'), bad);
});

test('the compiler is part of the request: the bundled one and a host\'s, and two hosts\', are three requests', () => {
  const hashes = new Set([BUNDLED, { kind: 'host', value: 'host compiler 1' }, { kind: 'host', value: 'host compiler 2' }].map((compilerIdentity) => req({}, { compilerIdentity }).requestSha256));
  assert.strictEqual(hashes.size, 3);
});

test('what is bound is what is sent: the normalized arguments are a frozen copy, and a list JSON cannot carry exactly is refused', () => {
  const list = [{ ...BINDING }];
  const out = req({ connectorBindings: list });
  list[0].dataset = 'changed later';
  assert.strictEqual(out.args.connectorBindings[0].dataset, 'after');
  assert.ok(Object.isFrozen(out.args) && Object.isFrozen(out.args.connectorBindings[0]));
  const cyclic = { ...BINDING };
  cyclic.self = cyclic;
  const sparse = [BINDING];
  sparse.length = 2;
  const getter = { ...BINDING };
  Object.defineProperty(getter, 'dataset', { get: () => 'after', enumerable: true });
  for (const [what, bad] of Object.entries({ cyclic, sparse, getter, nan: { ...BINDING, n: NaN }, fn: { ...BINDING, f() {} }, undef: { ...BINDING, u: undefined }, map: { ...BINDING, m: new Map() }, symbol: { ...BINDING, [Symbol('s')]: 1 } })) {
    assert.throws(() => strictJsonCopy(Array.isArray(bad) ? bad : [bad], 'connectorBindings'), code('GENPAGE_BINDING_INVALID'), what);
  }
  const proto = JSON.parse('{"__proto__": {"x": 1}, "a": -0}');
  const copy = strictJsonCopy(proto, 'value');
  assert.deepStrictEqual(Object.keys(copy), ['__proto__', 'a'], '"__proto__" stays a member');
  assert.strictEqual(Object.getPrototypeOf(copy), Object.prototype);
  assert.ok(Object.is(copy.a, 0));
});

test('an upload\'s context is a closed shape, and it is part of the request', () => {
  const context = { operation: 'upload-update', appId: null, solution: 'ContosoSolution', overwriteDeployed: false, navigation: null };
  assert.notStrictEqual(req({ turnContext: context }).requestSha256, req({}).requestSha256);
  assert.notStrictEqual(req({ turnContext: { ...context, overwriteDeployed: true } }).requestSha256, req({ turnContext: context }).requestSha256);
  assert.throws(() => req({ turnContext: { ...context, extra: 1 } }), code('GENPAGE_ARGUMENT_INVALID'));
  assert.throws(() => req({ turnContext: { ...context, operation: 'upload-create' } }), code('GENPAGE_ARGUMENT_INVALID'), 'an update is not an upload create');
});

test('a turn record is closed and adds up: an earlier format, a member too many and a digest that does not match are refused with the migration advice', () => {
  const r = req({ prompt: 'change' });
  const record = makeTurnRecord({ turnId: TURN, operation: 'update', environmentFingerprint: r.environmentFingerprint, pageId: PAGE.toUpperCase(), requestSha256: r.requestSha256, effectiveInputsSha256: hashEffectiveInputs({ turn: { prompt: 'change', agentMessage: 'done' } }) });
  assert.strictEqual(record.pageId, PAGE);
  assert.deepStrictEqual(validateTurnRecord(JSON.parse(JSON.stringify(record)), TURN), record);
  assert.strictEqual(turnDifference(record, record), '');
  const incomplete = (why) => (e) => code('GENPAGE_TURN_STATE_INCOMPLETE')(e) && why.test(e.message) && /Do not use a new ID merely to retry an unresolved create/.test(e.message);
  assert.throws(() => validateTurnRecord({ formatVersion: 1, turnId: TURN, pageId: PAGE, requestSha256: r.requestSha256 }, TURN), incomplete(/format 1/));
  assert.throws(() => validateTurnRecord({ ...record, note: 'x' }, TURN), incomplete(/members/));
  assert.throws(() => validateTurnRecord({ ...record, pageId: '88888888-8888-4888-8888-888888888888' }, TURN), incomplete(/digest/));
  assert.throws(() => validateTurnRecord(record, '0d3c1b2a-4e5f-4a6b-8c7d-9e0f1a2b3c4d'), incomplete(/names turn/));
  assert.throws(() => validateTurnRecord([], TURN), incomplete(/not a JSON object/));
});
