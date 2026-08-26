'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { compileActionBindings } = require('../compile-screen-build-pack');
const { snapshotGeneratedServiceSurface } = require('../snapshot-generated-service-surface');
const { validateScreenActionContract } = require('../validate-screen-action-contract');

function project(context, methods = ['getAll', 'create']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-service-surface-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serviceRoot = path.join(root, 'src', 'generated', 'services');
  fs.mkdirSync(serviceRoot, { recursive: true });
  fs.writeFileSync(path.join(serviceRoot, 'Cr1_itemsv2Service.ts'), `export class Cr1_itemsv2Service {\n${methods.map((method) => `  static async ${method}(_input?: unknown) { return {}; }`).join('\n')}\n}\n`);
  const schema = { tables: [{ logicalName: 'cr1_items', adaptedLogicalName: 'cr1_itemsv2', displayName: 'Items', plannedDecision: 'adapt', serviceRequired: true }] };
  return { root, schema };
}

function actionContract() {
  return {
    schemaVersion: 1,
    kind: 'mobile-screen-actions',
    decisionOwner: 'model',
    actions: [{
      id: 'save-choice', screenId: 'Home', label: 'Save choice', semanticRole: 'primary', placement: 'inline',
      executor: { kind: 'operation', target: 'saveChoice', entity: 'cr1_itemsv2', operationKind: 'create', mode: 'mutation' },
      inputs: [{ target: 'cr1_name', source: { kind: 'form', path: 'name' } }],
    }],
  };
}

const screenContract = { schemaVersion: 1, primaryScreen: { route: '/(app)/home', primaryAction: 'Save choice' }, keyFlow: null };

test('snapshots adapted generated service names and methods', (context) => {
  const value = project(context);
  const surface = snapshotGeneratedServiceSurface(value.root, value.schema);
  assert.deepEqual(surface.entries, [{
    entity: 'cr1_itemsv2', aliases: ['cr1_items', 'cr1_itemsv2'], displayName: 'Items', status: 'available',
    service: 'Cr1_itemsv2Service', serviceModule: '@/generated/services/Cr1_itemsv2Service', methods: ['create', 'getAll'],
  }]);
});

test('resolves generated services from exact irregular entity-set metadata', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-service-entity-set-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serviceRoot = path.join(root, 'src', 'generated', 'services');
  fs.mkdirSync(serviceRoot, { recursive: true });
  fs.writeFileSync(path.join(serviceRoot, 'Cr1_inquiriesService.ts'), 'export const Cr1_inquiriesService = { async getAll() {}, async create() {} };\n');
  const surface = snapshotGeneratedServiceSurface(root, {
    tables: [{ logicalName: 'cr1_inquiry', entitySetName: 'cr1_inquiries', displayName: 'Inquiry', plannedDecision: 'reuse', serviceRequired: true }],
  });
  assert.equal(surface.entries[0].status, 'available');
  assert.equal(surface.entries[0].service, 'Cr1_inquiriesService');
  assert.ok(surface.entries[0].aliases.includes('cr1_inquiries'));
});

test('operation intent is provisional at plan time and resolved at build time', (context) => {
  const value = project(context);
  const contract = actionContract();
  assert.equal(validateScreenActionContract(contract, { screenContract, phase: 'plan' }).valid, true);
  const surface = snapshotGeneratedServiceSurface(value.root, value.schema);
  assert.equal(validateScreenActionContract(contract, { screenContract, serviceSurface: surface, phase: 'build' }).valid, true);
  const bindings = compileActionBindings(contract.actions, [{ id: 'Home', route: '/(app)/home' }], null, { screens: [] }, null, surface);
  assert.equal(bindings[0].executor.provider, 'generated-service');
  assert.equal(bindings[0].executor.serviceModule, '@/generated/services/Cr1_itemsv2Service');
  assert.equal(bindings[0].executor.serviceMethod, 'create');
});

test('build validation rejects a generated service missing the required method', (context) => {
  const value = project(context, ['getAll']);
  const surface = snapshotGeneratedServiceSurface(value.root, value.schema);
  assert.match(validateScreenActionContract(actionContract(), { screenContract, serviceSurface: surface, phase: 'build' }).errors.join('\n'), /does not resolve on generated service/);
});
