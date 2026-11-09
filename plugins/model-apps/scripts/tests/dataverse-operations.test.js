'use strict';
// lib/dataverse-operations.js: the reviewed catalogue of built-in Dataverse operations a generative page may bind — exactly WhoAmI and
// RetrieveVersion — and the one projection of a descriptor onto the four-key `actionBindings` wire entry.
//
// What these pin: a name is recognized only by an exact match (no case, prefix, namespace or display-name folding, and no inherited name such as
// `__proto__`); a caller cannot widen or alter what a later caller reads; the wire entry has exactly the four keys a page list may state, so a
// built-in beside a Custom API leaves the list statable (a spread descriptor would leave the whole list out of an App Spec); an altered
// descriptor is refused, never repaired; and a refusal names a fixed code and a fixed sentence, never the text it was given.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ops = require('../lib/dataverse-operations.js');
const { statableBindings } = require('../lib/page-bindings.js');

const WHO_AM_I = {
  name: 'WhoAmI',
  displayName: 'Current Dataverse identity',
  isFunction: true,
  bindingType: 'Global',
  parameters: [],
  parameterKinds: {},
  response: {
    typeName: 'Microsoft.Dynamics.CRM.WhoAmIResponse',
    properties: { BusinessUnitId: 'Edm.Guid', UserId: 'Edm.Guid', OrganizationId: 'Edm.Guid' },
  },
  outputPrivacy: 'identity',
  invocation: 'user-triggered',
  requiresExplicitSelection: true,
};
const RETRIEVE_VERSION = {
  name: 'RetrieveVersion',
  displayName: 'Dataverse server version',
  isFunction: true,
  bindingType: 'Global',
  parameters: [],
  parameterKinds: {},
  response: {
    typeName: 'Microsoft.Dynamics.CRM.RetrieveVersionResponse',
    properties: { Version: 'Edm.String' },
  },
  outputPrivacy: 'service-version',
  invocation: 'user-triggered',
  requiresExplicitSelection: true,
};
const VERIFICATION = { mode: 'catalogue-only', environment: 'not-checked', runtime: 'not-checked', privileges: 'not-checked' };
const NOT_IN_CATALOGUE = 'Only WhoAmI and RetrieveVersion are offered by this feature. Other Dataverse operations require separately reviewed support.';
const INVALID_CONTRACT = 'The selected built-in operation must be an explicitly declared, unbound Function with no inputs.';
const CUSTOM_API_ROW = { name: 'new_ApproveOrder', isFunction: false, boundEntityLogicalName: 'salesorder', displayName: 'Approve Order', parameterKinds: { Comment: 'String' } };

// Every own object and array under `value`, so a test can hold each of them to being frozen.
function everyObject(value, out = []) {
  if (value && typeof value === 'object') {
    out.push(value);
    for (const key of Object.keys(value)) everyObject(value[key], out);
  }
  return out;
}

test('the catalogue is revision 1, catalogue-only, and holds exactly WhoAmI then RetrieveVersion with their reviewed contracts', () => {
  const catalogue = ops.getDataverseOperationCatalogue();
  assert.deepStrictEqual(Object.keys(catalogue), ['catalogueVersion', 'verification', 'operations']);
  assert.equal(catalogue.catalogueVersion, 1);
  assert.deepStrictEqual(catalogue.verification, VERIFICATION);
  assert.deepStrictEqual(catalogue.operations, [WHO_AM_I, RETRIEVE_VERSION]);
  // The descriptor's own key order is the order the listing prints.
  assert.deepStrictEqual(Object.keys(catalogue.operations[0]), Object.keys(WHO_AM_I));
  assert.equal(ops.CATALOGUE_VERSION, 1);
  assert.deepStrictEqual(ops.REVIEWED_OPERATION_NAMES, ['WhoAmI', 'RetrieveVersion']);
});

test('an exact name finds its frozen descriptor; anything else — case, spacing, namespace, prefix, display name, an inherited name, a non-string — finds nothing', () => {
  assert.deepStrictEqual(ops.getReviewedDataverseOperation('WhoAmI'), WHO_AM_I);
  assert.deepStrictEqual(ops.getReviewedDataverseOperation('RetrieveVersion'), RETRIEVE_VERSION);
  for (const name of [
    'whoami', 'WHOAMI', 'Whoami', ' WhoAmI', 'WhoAmI ', 'WhoAmI\n', 'Microsoft.Dynamics.CRM.WhoAmI', 'mscrm.WhoAmI', 'WhoAm', 'WhoAmIResponse', 'WhoAmI()',
    'Who*', '*', '%', '', 'retrieveversion', 'RetrieveVersions', 'Microsoft.Dynamics.CRM.RetrieveVersion', 'Current Dataverse identity', 'Dataverse server version',
    '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'CalculateRollupField', 'IncrementKnowledgeArticleViewCount', 'QualifyLead',
    'RetrieveUserPrivileges', 'new_ApproveOrder',
  ]) {
    assert.equal(ops.getReviewedDataverseOperation(name), null, JSON.stringify(name));
  }
  for (const value of [undefined, null, 0, 42, true, {}, [], ['WhoAmI'], { name: 'WhoAmI' }, { toString: () => 'WhoAmI' }, Object('WhoAmI'), Symbol('WhoAmI')]) {
    assert.equal(ops.getReviewedDataverseOperation(value), null, String(typeof value));
  }
});

test('no caller can widen or alter what a later caller reads: the catalogue and every descriptor are frozen through and through', () => {
  const catalogue = ops.getDataverseOperationCatalogue();
  for (const object of everyObject(catalogue)) assert.ok(Object.isFrozen(object), `frozen: ${JSON.stringify(object).slice(0, 60)}`);
  assert.throws(() => { catalogue.operations.push({ ...WHO_AM_I, name: 'CalculateRollupField' }); }, TypeError);
  assert.throws(() => { catalogue.operations[0].isFunction = false; }, TypeError);
  assert.throws(() => { catalogue.operations[0].parameterKinds.Target = 'String'; }, TypeError);
  assert.throws(() => { catalogue.operations[1].response.properties.Extra = 'Edm.String'; }, TypeError);
  assert.throws(() => { catalogue.verification.environment = 'checked'; }, TypeError);
  assert.throws(() => { ops.getReviewedDataverseOperation('WhoAmI').parameters.push('x'); }, TypeError);
  assert.deepStrictEqual(ops.getDataverseOperationCatalogue().operations, [WHO_AM_I, RETRIEVE_VERSION]);
  assert.equal(ops.getReviewedDataverseOperation('CalculateRollupField'), null);
});

test('toActionBinding gives a fresh four-key wire entry built from the catalogue, never the descriptor spread onto the wire', () => {
  for (const [descriptor, displayName] of [[WHO_AM_I, 'Current Dataverse identity'], [RETRIEVE_VERSION, 'Dataverse server version']]) {
    const canonical = ops.getReviewedDataverseOperation(descriptor.name);
    for (const input of [canonical, structuredClone(descriptor), JSON.parse(JSON.stringify(descriptor))]) {
      const wire = ops.toActionBinding(input);
      assert.deepStrictEqual(Object.keys(wire), ['name', 'isFunction', 'displayName', 'parameterKinds']);
      assert.deepStrictEqual(wire, { name: descriptor.name, isFunction: true, displayName, parameterKinds: {} });
      assert.equal(Object.isFrozen(wire), false, 'the caller owns the result');
      // Mutating one result changes neither the catalogue nor the next result.
      wire.parameterKinds.Injected = 'String';
      wire.displayName = 'changed';
      assert.deepStrictEqual(ops.toActionBinding(input), { name: descriptor.name, isFunction: true, displayName, parameterKinds: {} });
      assert.deepStrictEqual(ops.getReviewedDataverseOperation(descriptor.name), descriptor);
    }
  }
});

test('toActionBinding refuses an altered descriptor or an unknown name with a fixed code and sentence, and never echoes what it was given', () => {
  const altered = [
    (d) => { d.displayName = 'Who am I'; },
    (d) => { d.isFunction = false; },
    (d) => { delete d.isFunction; },
    (d) => { d.isFunction = 'true'; },
    (d) => { d.bindingType = 'Entity'; },
    (d) => { d.boundEntityLogicalName = 'account'; },
    (d) => { d.parameters = [{ name: 'Target', type: 'String' }]; },
    (d) => { d.parameterKinds = { Target: 'String' }; },
    (d) => { d.response.properties.Extra = 'Edm.String'; },
    (d) => { d.response.typeName = 'Microsoft.Dynamics.CRM.OtherResponse'; },
    (d) => { d.outputPrivacy = 'none'; },
    (d) => { d.invocation = 'on-load'; },
    (d) => { d.requiresExplicitSelection = false; },
    (d) => { d.ghp_SecretLookingKey0123456789abcdefABCDEF = 'x'; },
    (d) => { delete d.response; },
  ];
  for (const [index, alter] of altered.entries()) {
    const descriptor = structuredClone(WHO_AM_I);
    alter(descriptor);
    assert.throws(() => ops.toActionBinding(descriptor), (error) => {
      assert.equal(error.code, 'invalid_operation_contract', `altered ${index}`);
      assert.equal(error.message, INVALID_CONTRACT);
      return true;
    });
  }
  for (const input of [
    { ...structuredClone(WHO_AM_I), name: 'whoami' },
    { ...structuredClone(WHO_AM_I), name: 'CalculateRollupField' },
    { ...structuredClone(WHO_AM_I), name: 'contoso_ghp_0123456789abcdefABCDEF0123456789' },
    { name: '__proto__' }, {},
  ]) {
    assert.throws(() => ops.toActionBinding(input), (error) => {
      assert.equal(error.code, 'not_in_catalogue');
      assert.equal(error.message, NOT_IN_CATALOGUE);
      assert.doesNotMatch(String(error.stack), /ghp_|whoami\b|CalculateRollupField/);
      return true;
    });
  }
  for (const input of [null, undefined, 'WhoAmI', ['WhoAmI'], [WHO_AM_I], 7]) {
    assert.throws(() => ops.toActionBinding(input), (error) => {
      assert.equal(error.code, 'invalid_operation_contract', JSON.stringify(input));
      assert.equal(error.message, INVALID_CONTRACT);
      return true;
    });
  }
});

test('validateReviewedDataverseBinding accepts exactly the projection of a reviewed operation and refuses everything else a new row could hold', () => {
  for (const descriptor of [WHO_AM_I, RETRIEVE_VERSION]) {
    const row = ops.toActionBinding(descriptor);
    assert.deepStrictEqual(ops.validateReviewedDataverseBinding(row), { ok: true });
    assert.deepStrictEqual(ops.validateReviewedDataverseBinding(JSON.parse(JSON.stringify(row))), { ok: true });
  }
  const contract = { ok: false, code: 'invalid_operation_contract', message: INVALID_CONTRACT };
  const row = () => ops.toActionBinding(WHO_AM_I);
  for (const [label, entry] of [
    ['isFunction false', { ...row(), isFunction: false }],
    ['isFunction absent', (({ isFunction, ...rest }) => rest)(row())],
    ['isFunction not a boolean', { ...row(), isFunction: 'true' }],
    ['a bound target', { ...row(), boundEntityLogicalName: 'systemuser' }],
    ['a parameter', { ...row(), parameterKinds: { Target: 'Guid' } }],
    ['parameterKinds absent', (({ parameterKinds, ...rest }) => rest)(row())],
    ['a display name that is not the catalogue\'s', { ...row(), displayName: 'Who am I' }],
    ['descriptor keys on the wire', { ...row(), bindingType: 'Global' }],
    ['the whole descriptor', structuredClone(WHO_AM_I)],
    ['an unknown wire key', { ...row(), extra: true }],
    ['an own __proto__ key', JSON.parse('{"name":"WhoAmI","isFunction":true,"displayName":"Current Dataverse identity","parameterKinds":{},"__proto__":{}}')],
    ['not an object', 'WhoAmI'],
    ['an array', [row()]],
    ['null', null],
  ]) {
    assert.deepStrictEqual(ops.validateReviewedDataverseBinding(entry), contract, label);
  }
  for (const name of ['whoami', 'Microsoft.Dynamics.CRM.WhoAmI', 'CalculateRollupField', 'QualifyLead', '__proto__', '']) {
    assert.deepStrictEqual(ops.validateReviewedDataverseBinding({ ...row(), name }),
      { ok: false, code: 'not_in_catalogue', message: NOT_IN_CATALOGUE }, name);
  }
});

test('a built-in projected by toActionBinding beside a Custom API keeps the page list statable; the same descriptor spread onto the wire leaves the WHOLE list out', () => {
  const composed = [CUSTOM_API_ROW, ops.toActionBinding(WHO_AM_I), ops.toActionBinding(RETRIEVE_VERSION)];
  const kept = statableBindings('actionBindings', composed);
  assert.equal(kept.problem, null);
  assert.deepStrictEqual(kept.stated, composed);
  // What a composer that spreads the descriptor writes: the unrelated Custom API row is lost from the spec with it.
  const spread = [CUSTOM_API_ROW, { ...ops.getReviewedDataverseOperation('WhoAmI') }];
  const lost = statableBindings('actionBindings', spread);
  assert.equal(lost.stated, null);
  assert.equal(lost.problem.entry, 1);
});

test('the authoring codes are fixed sentences that name no environment, and the catalogue is not gated by the feature flag', () => {
  assert.deepStrictEqual(Object.keys(ops.AUTHORING_CODES).sort(), [
    'catalogue_unavailable', 'duplicate_operation', 'explicit_trigger_required', 'invalid_operation_contract', 'not_in_catalogue', 'selection_required',
  ]);
  assert.equal(ops.AUTHORING_CODES.not_in_catalogue, NOT_IN_CATALOGUE);
  assert.equal(ops.AUTHORING_CODES.invalid_operation_contract, INVALID_CONTRACT);
  assert.equal(ops.AUTHORING_CODES.duplicate_operation, 'Select each built-in operation once; duplicate bindings are not supported.');
  assert.equal(ops.AUTHORING_CODES.selection_required, 'Select a built-in operation explicitly before generating its binding or call.');
  assert.equal(ops.AUTHORING_CODES.explicit_trigger_required, 'This version supports user-triggered built-in operation calls only.');
  assert.equal(ops.AUTHORING_CODES.catalogue_unavailable, 'The built-in operation catalogue could not be read. No built-in operations were offered.');
  assert.ok(Object.isFrozen(ops.AUTHORING_CODES));
  // Recognition is not gated: download and rebuild classify carried names whatever the flag says.
  const before = process.env.GENPAGE_ENABLE_DATAVERSE_OPERATIONS;
  try {
    process.env.GENPAGE_ENABLE_DATAVERSE_OPERATIONS = '0';
    assert.deepStrictEqual(ops.getReviewedDataverseOperation('WhoAmI'), WHO_AM_I);
    assert.deepStrictEqual(ops.toActionBinding(WHO_AM_I).name, 'WhoAmI');
  } finally {
    if (before === undefined) delete process.env.GENPAGE_ENABLE_DATAVERSE_OPERATIONS;
    else process.env.GENPAGE_ENABLE_DATAVERSE_OPERATIONS = before;
  }
});
