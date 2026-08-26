'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compileActionBindings } = require('../compile-screen-build-pack');
const { validateScreenActionContract } = require('../validate-screen-action-contract');

function context() {
  return {
    screenContract: {
      schemaVersion: 1,
      primaryScreen: { route: '/(app)/home', primaryAction: 'Browse' },
      keyFlow: { route: '/(app)/items/[itemId]', outcome: 'Act on the selected item.' },
      requiredScreens: [
        { id: 'BrowseItems', route: '/(app)/items', productRole: 'durable-destination' },
        { id: 'ItemDetail', route: '/(app)/items/[itemId]', routeParameters: [{ name: 'itemId', source: 'path', required: true }], productRole: 'nested-detail', capabilityComposition: [] },
        { id: 'Selection', route: '/(app)/selection', productRole: 'durable-destination' },
        { id: 'CaptureCode', route: '/(app)/capture', productRole: 'immersive-modal', capabilityComposition: [{ capability: 'barcode-scanner' }] },
      ],
    },
    domainModel: {
      entities: [
        { key: 'Item', fields: [{ key: 'id', type: 'id' }, { key: 'availableUnits', type: 'whole-number', minimum: 0 }] },
        { key: 'SelectionEntry', fields: [{ key: 'id', type: 'id' }, { key: 'itemId', type: 'reference' }, { key: 'quantity', type: 'whole-number', minimum: 1 }] },
      ],
      operations: [
        { key: 'listItems', entity: 'Item', kind: 'list', filterFields: [], writeFields: [], hook: 'useItems' },
        { key: 'createSelection', entity: 'SelectionEntry', kind: 'create', writeFields: ['itemId', 'quantity'], hook: 'useCreateSelection' },
        { key: 'updateSelection', entity: 'SelectionEntry', kind: 'update', writeFields: ['quantity'], hook: 'useUpdateSelection' },
      ],
    },
    executionContract: { connectorOperations: [{ id: 'connector-send-record' }] },
  };
}

function contract() {
  return {
    schemaVersion: 1,
    kind: 'mobile-screen-actions',
    decisionOwner: 'model',
    actions: [
      { id: 'open-browse', screenId: 'Home', label: 'Browse', semanticRole: 'primary', placement: 'inline', executor: { kind: 'route', target: 'BrowseItems', intent: 'navigate' }, inputs: [] },
      { id: 'add-selection', screenId: 'ItemDetail', label: 'Add selection', semanticRole: 'primary', placement: 'inline', executor: { kind: 'operation', target: 'createSelection', mode: 'mutation' }, inputs: [
        { target: 'itemId', source: { kind: 'route', path: 'itemId' } },
        { target: 'quantity', source: { kind: 'state', path: 'quantity' } },
      ], availability: [{ left: { kind: 'record', path: 'availableUnits' }, operator: 'gt', right: { kind: 'constant', value: 0 }, reason: 'No units are currently available.' }], pendingLabel: 'Adding', failureMessage: 'Could not add the selection.' },
      { id: 'review-selection', screenId: 'Selection', label: 'Review selection', semanticRole: 'secondary', placement: 'header', executor: { kind: 'local', target: 'review-selection' }, inputs: [], controlHint: { kind: 'icon-button', iconIntent: 'bag', labelMode: 'accessible-only', badge: { source: { kind: 'state', path: 'selectionCount' } } } },
      { id: 'change-quantity', screenId: 'Selection', label: 'Change quantity', semanticRole: 'secondary', placement: 'row', executor: { kind: 'operation', target: 'updateSelection', mode: 'mutation' }, inputs: [
        { target: 'id', source: { kind: 'record', path: 'id' } },
        { target: 'quantity', source: { kind: 'state', path: 'quantity' } },
      ], controlHint: {
        kind: 'stepper', field: 'quantity', step: 1, commit: 'immediate',
        minimum: { kind: 'field-constraint', path: 'quantity.minimum' },
        maximum: { kind: 'record', path: 'availableUnits' },
      } },
      { id: 'scan-code', screenId: 'CaptureCode', label: 'Scan code', semanticRole: 'secondary', placement: 'inline', executor: { kind: 'native', target: 'barcode-scanner', command: 'scan' }, inputs: [] },
    ],
  };
}

test('accepts model-owned route, mutation, local, native, and stepper actions', () => {
  assert.deepEqual(validateScreenActionContract(contract(), context()), { valid: true, errors: [] });
});

test('compiles action targets into route and typed operation handler metadata', () => {
  const value = context();
  const screens = [
    { id: 'Home', route: '/(app)/home' },
    ...value.screenContract.requiredScreens.map((screen) => ({ id: screen.id, route: screen.route })),
  ];
  const bindings = compileActionBindings(contract().actions, screens, value.domainModel, { screens: [] }, value.executionContract);
  const route = bindings.find((binding) => binding.id === 'open-browse');
  const mutation = bindings.find((binding) => binding.id === 'add-selection');
  assert.equal(route.handlerName, 'handleOpenBrowse');
  assert.equal(route.executor.route, '/(app)/items');
  assert.equal(mutation.handlerName, 'handleAddSelection');
  assert.equal(mutation.executor.hook, 'useCreateSelection');
  assert.equal(mutation.executor.operationKind, 'create');
  assert.deepEqual(mutation.executor.writeFields, ['itemId', 'quantity']);
  assert.equal(mutation.availabilityName, 'isAddSelectionAvailable');
  assert.equal(mutation.availability[0].left.path, 'availableUnits');
  assert.equal(bindings.find((binding) => binding.id === 'review-selection').executor.commandName, 'executeReviewSelection');
  assert.equal(bindings.find((binding) => binding.id === 'review-selection').controlHint.iconName, 'bag-handle-outline');
  assert.equal(bindings.find((binding) => binding.id === 'review-selection').controlHint.badge.valueName, 'reviewSelectionBadgeValue');
});

test('rejects unsupported icons and decorative constant badges', () => {
  const value = contract();
  value.actions[2].controlHint.iconIntent = 'invented-symbol';
  value.actions[2].controlHint.badge.source = { kind: 'constant', value: 3 };
  value.actions[0].controlHint = { kind: 'icon-button', iconIntent: 'browse', labelMode: 'accessible-only' };
  const errors = validateScreenActionContract(value, context()).errors.join('\n');
  assert.match(errors, /iconIntent is unsupported/);
  assert.match(errors, /badge requires a dynamic/);
  assert.match(errors, /cannot hide a primary action label/);
});

test('rejects unresolved operations, inputs, routes, and native capabilities', () => {
  const value = contract();
  value.actions[0].executor.target = 'MissingScreen';
  value.actions[1].executor.target = 'missingOperation';
  value.actions[3].inputs[1].target = 'missingField';
  value.actions[4].executor.target = 'camera';
  const errors = validateScreenActionContract(value, context()).errors.join('\n');
  assert.match(errors, /route target does not resolve/);
  assert.match(errors, /unresolved operation requires entity and operationKind/);
  assert.match(errors, /inputs target missingField/);
  assert.match(errors, /native capability is not planned/);
});

test('rejects a route input on a screen with no matching route parameter', () => {
  const value = contract();
  value.actions[0].inputs = [{ target: 'itemId', source: { kind: 'route', path: 'itemId' } }];
  assert.match(validateScreenActionContract(value, context()).errors.join('\n'), /route source does not resolve: itemId/);
});

test('requires exactly one executable primary action on primary and key-flow screens', () => {
  const value = contract();
  value.actions = value.actions.filter((action) => action.screenId !== 'ItemDetail');
  assert.match(validateScreenActionContract(value, context()).errors.join('\n'), /ItemDetail requires exactly one executable primary action/);
});

test('validates sequence references and cycles without domain assumptions', () => {
  const value = contract();
  value.actions.push({ id: 'complete-flow', screenId: 'Selection', label: 'Complete', semanticRole: 'secondary', placement: 'inline', executor: { kind: 'sequence', steps: ['review-selection', 'change-quantity'], policy: 'ordered-retry-safe' }, inputs: [] });
  assert.equal(validateScreenActionContract(value, context()).valid, true);
  value.actions.find((action) => action.id === 'complete-flow').executor.steps = ['open-browse'];
  assert.match(validateScreenActionContract(value, context()).errors.join('\n'), /belongs to another screen/);
  value.actions.find((action) => action.id === 'complete-flow').executor.steps = ['complete-flow'];
  const errors = validateScreenActionContract(value, context()).errors.join('\n');
  assert.match(errors, /cannot reference itself/);
  assert.match(errors, /contains a cycle/);
});

test('rejects Journey enabled actions without same-screen executable entries before approval', () => {
  const value = context();
  value.workflowJourney = {
    stateActions: [{
      screenId: 'ItemDetail', state: 'complete', primaryAction: 'continue-browsing',
      enabledActions: ['continue-browsing'], disabledActions: [], hiddenActions: [],
    }],
  };
  assert.match(validateScreenActionContract(contract(), value).errors.join('\n'), /ItemDetail\/complete enables continue-browsing without a same-screen executable action/);
});
