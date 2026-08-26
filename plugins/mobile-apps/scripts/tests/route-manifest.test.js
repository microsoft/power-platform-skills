'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildRouteManifest,
  updateRouteStatus,
  validateRouteManifest,
} = require('../route-manifest');

function pack() {
  return {
    schemaVersion: 2,
    revision: 'a'.repeat(64),
    navigation: {
      initialDestinationId: 'home',
      routingPolicy: { launchRoute: '/(app)/home' },
      destinations: [
        { id: 'home', rootScreenId: 'Home', route: '/(app)/home' },
        { id: 'records', rootScreenId: 'Records', route: '/(app)/records' },
      ],
      flows: [{ id: 'flow-detail', ownerDestinationId: 'records', screenIds: ['RecordDetail'] }],
      globalRoutePolicy: { profileScreenId: 'Profile', profileRoute: '/(app)/profile' },
    },
    journey: {
      actions: [
        { id: 'open-detail', target: 'RecordDetail', stageId: 'review' },
        { id: 'finish-review', target: 'RecordDetail', stageId: 'review' },
      ],
    },
    screens: [
      { id: 'Home', route: '/(app)/home', file: 'app/(app)/home.tsx', productRole: 'durable-destination', header: { title: 'Home' }, navigation: { role: 'durable-destination', destinationId: 'home' }, routeParameters: [], data: { operations: [] }, journey: { stageId: null } },
      { id: 'Records', route: '/(app)/records', file: 'app/(app)/records/index.tsx', productRole: 'durable-destination', header: { title: 'Records' }, navigation: { role: 'durable-destination', destinationId: 'records' }, routeParameters: [], data: { operations: [{ id: 'list-records' }] }, journey: { stageId: null } },
      { id: 'RecordDetail', route: '/(app)/records/[id]', file: 'app/(app)/records/[id].tsx', productRole: 'nested-detail', header: { title: 'Record' }, navigation: { role: 'nested-detail', destinationId: 'records', deepLinkable: true }, routeParameters: [{ name: 'id', source: 'path', required: true }], data: { operations: [{ id: 'get-record' }] }, journey: { stageId: 'review' } },
      { id: 'Profile', route: '/(app)/profile', file: 'app/(app)/profile.tsx', productRole: 'global-utility', header: { title: 'Profile' }, navigation: { role: 'global-utility', destinationId: 'home', deepLinkable: true }, routeParameters: [], data: { operations: [] }, journey: { stageId: null } },
    ],
  };
}

test('route manifest records every planned screen, owner, operation, and reachability result', () => {
  const value = pack();
  const manifest = buildRouteManifest(value);
  assert.deepEqual(validateRouteManifest(manifest, value), []);
  assert.equal(manifest.routes.length, value.screens.length);
  assert.equal(manifest.routes.every((route) => route.reachable), true);
  const detail = manifest.routes.find((route) => route.id === 'RecordDetail');
  assert.equal(detail.ownerDestinationId, 'records');
  assert.deepEqual(detail.routeParameters, [{ name: 'id', source: 'path', required: true }]);
  assert.deepEqual(detail.dataOperations, ['get-record']);
  assert.deepEqual(detail.incomingActions, ['open-detail', 'finish-review']);
  assert.deepEqual(detail.outgoingActions, ['open-detail', 'finish-review']);
});

test('route status updates are bounded to known screens and validated states', () => {
  const value = pack();
  const initial = buildRouteManifest(value);
  const updated = updateRouteStatus(initial, ['Home', 'RecordDetail'], 'type-safe', 'captured');
  assert.equal(updated.routes.find((route) => route.id === 'Home').buildStatus, 'type-safe');
  assert.equal(updated.routes.find((route) => route.id === 'RecordDetail').evidenceStatus, 'captured');
  assert.equal(updated.routes.find((route) => route.id === 'Profile').buildStatus, 'planned');
  assert.deepEqual(validateRouteManifest(updated, value), []);
  assert.throws(() => updateRouteStatus(initial, ['Missing'], 'building'), /Unknown route manifest screens/);
  assert.throws(() => updateRouteStatus(initial, ['Home'], 'complete'), /Unsupported route build status/);
});

test('route manifest rejects omitted and unreachable planned screens', () => {
  const value = pack();
  const manifest = buildRouteManifest(value);
  manifest.routes.find((route) => route.id === 'Profile').reachable = false;
  manifest.routes = manifest.routes.filter((route) => route.id !== 'RecordDetail');
  const errors = validateRouteManifest(manifest, value).join('\n');
  assert.match(errors, /omits screen RecordDetail/);
  assert.match(errors, /unreachable planned screen/);
});

test('final route validation rejects planned or building screens', () => {
  const value = pack();
  const manifest = buildRouteManifest(value);
  assert.match(validateRouteManifest(manifest, value, { requireComplete: true }).join('\n'), /incomplete screens/);
  const completed = updateRouteStatus(manifest, value.screens.map((screen) => screen.id), 'type-safe');
  assert.deepEqual(validateRouteManifest(completed, value, { requireComplete: true }), []);
});
