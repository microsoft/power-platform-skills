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

function collectStrings(value, result = []) {
  if (typeof value === 'string') {
    result.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, result);
  } else if (isObject(value)) {
    for (const item of Object.values(value)) collectStrings(item, result);
  }
  return result;
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

  if (contract.webhookProof) {
    const trigger = triggers[contract.webhookProof.triggerName];
    if (
      trigger
      && trigger.type === 'OpenApiConnectionWebhook'
      && contract.webhookProof.evidenceSource === 'run_flow'
    ) {
      reasons.add('webhook-proof-must-use-organic-callback');
    }
  }

  for (const identity of contract.flowIdentities || []) {
    const callbackJobRoleMisused = identity.callbackWorkflowId
      && identity.dataverseWorkflowId
      && String(identity.callbackWorkflowId).toLowerCase()
        !== String(identity.dataverseWorkflowId).toLowerCase();
    const callbackRegistrationRoleMisused = identity.callbackRegistrationName
      && identity.runtimeResourceId
      && String(identity.callbackRegistrationName).toLowerCase()
        !== String(identity.runtimeResourceId).toLowerCase();
    const runtimeRoleMisused = identity.runtimeReadbackResourceId
      && identity.runtimeResourceId
      && String(identity.runtimeReadbackResourceId).toLowerCase()
        !== String(identity.runtimeResourceId).toLowerCase();
    if (callbackJobRoleMisused || callbackRegistrationRoleMisused || runtimeRoleMisused) {
      reasons.add('flow-id-role-misuse');
    }
  }

  for (const [actionName, targetKind] of Object.entries(contract.lookupTargets || {})) {
    if (targetKind !== 'fixed' || !Object.hasOwn(actions, actionName)) continue;
    const strings = collectStrings(actions[actionName]);
    if (strings.some((value) => /Microsoft\.Dynamics\.CRM\.lookuplogicalname/i.test(value))) {
      reasons.add('fixed-target-lookup-must-not-depend-on-logical-name-annotation');
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
