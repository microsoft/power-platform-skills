#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const DEFAULT_FIXTURE_DIR = path.resolve(
  __dirname,
  '..',
  'skills',
  'create-push-notification-flow',
  'evals',
  'fixtures',
);

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableJson(value[key])]),
    );
  }
  return value;
}

function equalJson(left, right) {
  return JSON.stringify(stableJson(left)) === JSON.stringify(stableJson(right));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasSecureInputsAndOutputs(action) {
  const properties = action
    && action.runtimeConfiguration
    && action.runtimeConfiguration.secureData
    && action.runtimeConfiguration.secureData.properties;
  return Array.isArray(properties)
    && properties.includes('inputs')
    && properties.includes('outputs');
}

function validateFixture(fixture) {
  const reasons = new Set();
  const requested = fixture.requested || {};
  const definition = requested.definition || {};
  const triggers = definition.triggers || {};
  const actions = definition.actions || {};
  const contract = fixture.contract || {};

  const nestedActions = Object.values(triggers).some(
    (trigger) => trigger && typeof trigger === 'object' && trigger.actions,
  );
  if (nestedActions) reasons.add('actions-must-be-top-level');

  for (const trigger of Object.values(triggers)) {
    if (trigger.type !== 'OpenApiConnectionWebhook') {
      reasons.add('trigger-must-use-open-api-connection-webhook');
    }
    const entityName = trigger.inputs
      && trigger.inputs.parameters
      && trigger.inputs.parameters['subscriptionRequest/entityname'];
    if (contract.triggerEntityName && entityName !== contract.triggerEntityName) {
      reasons.add('trigger-entity-name-must-be-singular');
    }
  }

  for (const [actionName, action] of Object.entries(actions)) {
    if (!isObject(action)) {
      continue;
    }
    const parameters = (action.inputs && action.inputs.parameters) || {};
    const expectedEntityName = contract.actionEntityNames
      && contract.actionEntityNames[actionName];
    if (expectedEntityName && parameters.entityName !== expectedEntityName) {
      reasons.add('action-entity-name-must-be-plural');
    }
    if (Object.values(parameters).some((value) => value === null)) {
      reasons.add('optional-update-fields-must-be-omitted');
    }
    for (const dependency of Object.keys(action.runAfter || {})) {
      if (!Object.hasOwn(actions, dependency)) {
        reasons.add('run-after-target-not-found');
      }
    }
  }

  if (contract.senderAuthMode) {
    const requiredActions = contract.requiredSenderActions || [];
    const forbiddenActions = contract.forbiddenSenderActions || [];
    const secureActions = contract.secureSenderActions || [];
    const connectionReferences = requested.connectionReferences || {};

    for (const actionName of requiredActions) {
      if (!Object.hasOwn(actions, actionName)) {
        reasons.add('sender-mode-required-action-missing');
      }
    }
    for (const actionName of forbiddenActions) {
      if (Object.hasOwn(actions, actionName)) {
        reasons.add('sender-mode-fallback-forbidden');
      }
    }
    for (const actionName of secureActions) {
      if (Object.hasOwn(actions, actionName) && !hasSecureInputsAndOutputs(actions[actionName])) {
        reasons.add('sender-sensitive-action-must-be-secure');
      }
    }
    for (const referenceName of contract.requiredConnectionReferences || []) {
      if (!Object.hasOwn(connectionReferences, referenceName)) {
        reasons.add('sender-mode-connection-required');
      }
    }
    for (const referenceName of contract.forbiddenConnectionReferences || []) {
      if (Object.hasOwn(connectionReferences, referenceName)) {
        reasons.add('sender-mode-fallback-forbidden');
      }
    }

    if (contract.senderAuthMode === 'function-endpoint') {
      const invokeAction = actions[contract.functionInvokeAction];
      if (!Object.hasOwn(actions, contract.functionInvokeAction)) {
        // The required-action check above owns the missing-action finding.
      } else if (!isObject(invokeAction)) {
        reasons.add('function-invoke-action-must-be-object');
      } else {
        if (invokeAction.type !== 'OpenApiConnection') {
          reasons.add('function-invoke-action-type-invalid');
        }
        if (!isObject(invokeAction.inputs)) {
          reasons.add('function-invoke-inputs-must-be-object');
        } else if (!isObject(invokeAction.inputs.host)) {
          reasons.add('function-invoke-host-must-be-object');
        } else {
          const { operationId, connectionName } = invokeAction.inputs.host;
          if (typeof operationId !== 'string' || operationId.trim() === '') {
            reasons.add('function-operation-id-required');
          }
          if (typeof connectionName !== 'string' || connectionName.trim() === '') {
            reasons.add('function-connection-reference-required');
          }
          if (
            typeof operationId === 'string'
            && operationId.trim() !== ''
            && operationId !== contract.functionOperationId
          ) {
            reasons.add('function-operation-or-connection-mismatch');
          }
          if (
            typeof connectionName === 'string'
            && connectionName.trim() !== ''
            && connectionName !== contract.functionConnectionReference
          ) {
            reasons.add('function-operation-or-connection-mismatch');
          }
        }
      }
      if (
        isObject(invokeAction)
        && isObject(invokeAction.inputs)
        && isObject(invokeAction.inputs.host)
        && !Object.hasOwn(connectionReferences, invokeAction.inputs.host.connectionName)
      ) {
        reasons.add('function-connection-reference-not-found');
      }
    }
  }

  if (fixture.live) {
    if (requested.state !== fixture.live.state) {
      reasons.add('live-state-mismatch');
    }
    if (!equalJson(requested.definition, fixture.live.definition)) {
      reasons.add('live-definition-mismatch');
    }
    if (!equalJson(requested.connectionReferences, fixture.live.connectionReferences)) {
      reasons.add('connection-reference-rewrite');
    }
  }

  return [...reasons].sort();
}

function loadFixtures(fixtureDir = DEFAULT_FIXTURE_DIR) {
  return fs.readdirSync(fixtureDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const fixturePath = path.join(fixtureDir, name);
      return {
        fixturePath,
        fixture: JSON.parse(fs.readFileSync(fixturePath, 'utf8')),
      };
    });
}

function main(argv = process.argv.slice(2)) {
  const fixtureDir = argv[0] ? path.resolve(argv[0]) : DEFAULT_FIXTURE_DIR;
  let failures = 0;

  for (const { fixturePath, fixture } of loadFixtures(fixtureDir)) {
    const actual = validateFixture(fixture);
    const expected = [...fixture.expected.reasons].sort();
    try {
      assert.deepStrictEqual(actual, expected);
      assert.strictEqual(fixture.expected.valid, actual.length === 0);
      process.stdout.write(`PASS ${path.basename(fixturePath)}\n`);
    } catch (error) {
      failures += 1;
      process.stderr.write(
        `FAIL ${path.basename(fixturePath)}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}\n`,
      );
    }
  }

  return failures === 0 ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  DEFAULT_FIXTURE_DIR,
  loadFixtures,
  main,
  validateFixture,
};
