'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { prepareExecutionPreflight } = require('../prepare-mobile-plan-execution-contract');

const experienceContract = { schemaVersion: 1 };

test('preserves every confirmed brief item and resolves supported native packages', () => {
  const brief = '- Browse products offline.\n- Scan a receipt with the camera.\n- Keep the app accessible.';
  const result = prepareExecutionPreflight(brief, experienceContract, {
    dependencies: { 'expo-camera': '55.0.18' },
  });
  assert.equal(result.requirements.length, 3);
  assert.deepEqual(result.requirements.map((item) => item.source), [
    'Browse products offline.',
    'Scan a receipt with the camera.',
    'Keep the app accessible.',
  ]);
  assert.equal(result.nativeCapabilities[0].support.status, 'supported');
  assert.equal(result.nativeCapabilities[0].support.templateVersion, '55.0.18');
  assert.deepEqual(result.blockers, []);
});

test('blocks an unavailable native capability before plan approval', () => {
  const result = prepareExecutionPreflight('- Let users sign forms with pen input.', experienceContract, { dependencies: {} });
  assert.equal(result.nativeCapabilities[0].capability, 'pen-input');
  assert.equal(result.nativeCapabilities[0].support.status, 'unsupported');
  assert.match(result.blockers[0], /power-apps-native-pen-input.*absent/);
});

test('records connector discovery needs and exact pure-JavaScript calendar dependency', () => {
  const result = prepareExecutionPreflight('- Send an Outlook email.\n- Show a month calendar view.', experienceContract, { dependencies: {} }, { operations: [{
    id: 'connector-outlook-send-email', connector: 'Office 365 Outlook', apiName: 'office365', service: 'Office365OutlookService', operation: 'SendEmail',
    input: { to: 'record.email', subject: 'form.subject' }, output: { type: 'SendEmailResult' }, failure: { state: 'offline', userAction: 'Retry' },
  }] });
  assert.equal(result.connectorHints[0].apiName, 'office365');
  assert.equal(result.connectorHints[0].status, 'operation-metadata-required');
  assert.equal(result.connectorOperations[0].operation, 'SendEmail');
  assert.deepEqual(result.javascriptDependencies[0], {
    package: 'react-native-calendars',
    version: '1.1314.0',
    classification: 'pure-js',
    resolution: 'approved-before-build',
    requiredBy: [result.requirements[1].id],
  });
});

test('blocks connector planning until foreground operation metadata is supplied', () => {
  const result = prepareExecutionPreflight('- Send an Outlook email.', experienceContract, { dependencies: {} });
  assert.match(result.blockers.join('\n'), /office365 requires read-only operation metadata/);
  assert.deepEqual(result.connectorOperations, []);
});

test('splits dense critical constraints into independently traceable requirements', () => {
  const source = 'Keep an offline catalog with CDN caching, a cart, and accessibility.';
  const result = prepareExecutionPreflight(source, experienceContract, { dependencies: {} });
  assert.ok(result.requirements.some((item) => /offline/i.test(item.source)));
  assert.ok(result.requirements.some((item) => /cdn/i.test(item.source)));
  assert.ok(result.requirements.some((item) => /cart/i.test(item.source)));
  assert.ok(result.requirements.some((item) => /accessibility/i.test(item.source)));
});