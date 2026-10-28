#!/usr/bin/env node
'use strict';
// Lists the BUILT-IN Dataverse operations a generative page may bind — exactly WhoAmI and RetrieveVersion — from the reviewed catalogue in
// lib/dataverse-operations.js. The genpage-customapi-builder agent offers them to the maker beside (not inside) the Custom APIs that
// list-custom-apis.js discovers, and writes a binding only for an operation the maker selects.
//
// It asks the environment NOTHING: no token, no request, no $metadata read, so it takes no environment URL. The catalogue is what is offered, not
// a check that an environment has an operation, that the page player can call it, or that the signed-in user may — every answer says so
// (`verification`), and a page's first call can still answer 404. See references/dataverse-operations.md.
//
// Usage:
//   node scripts/list-dataverse-operations.js            (no arguments and no options)
//
// Exit status, stdout and stderr — checked in this order:
//   3  feature flag "dataverse-operations" is OFF (also when an argument was given): stdout empty; stderr the one gate line
//      (lib/feature-flags.js dataverseOperationsDisabledMessage).
//   1  an argument was given: stdout empty; stderr "Usage: node scripts/list-dataverse-operations.js".
//   1  the catalogue could not be read, or is not exactly the reviewed pair: stdout empty; stderr
//      "The built-in operation catalogue could not be read. No built-in operations were offered."
//   0  stdout one JSON line:
//      { "ok": true, "catalogueVersion": 1,
//        "verification": { "mode": "catalogue-only", "environment": "not-checked", "runtime": "not-checked", "privileges": "not-checked" },
//        "operations": [ { "name": "WhoAmI", "displayName": "Current Dataverse identity", "isFunction": true, "bindingType": "Global",
//                          "parameters": [], "parameterKinds": {},
//                          "response": { "typeName": "Microsoft.Dynamics.CRM.WhoAmIResponse",
//                                        "properties": { "BusinessUnitId": "Edm.Guid", "UserId": "Edm.Guid", "OrganizationId": "Edm.Guid" } },
//                          "outputPrivacy": "identity", "invocation": "user-triggered", "requiresExplicitSelection": true },
//                        { "name": "RetrieveVersion", …, "response": { "typeName": "Microsoft.Dynamics.CRM.RetrieveVersionResponse",
//                          "properties": { "Version": "Edm.String" } }, "outputPrivacy": "service-version", … } ] }
// Only `name`, `isFunction`, `displayName` and `parameterKinds` of an operation ever go into a page's actionBindings (lib/dataverse-operations.js
// toActionBinding); the other members describe the operation to the author.
const { makeWritesBlocking } = require('./lib/output-redaction.js');
const { exitIfDataverseOperationsDisabled } = require('./lib/feature-flags.js');

const USAGE = 'Usage: node scripts/list-dataverse-operations.js';
const CATALOGUE_UNAVAILABLE = 'The built-in operation catalogue could not be read. No built-in operations were offered.';

// The pair this command may offer, held here as well as in the catalogue: a catalogue that answers anything else — a third operation, another
// order or spelling, a weakened contract — is a failure of the producer, and the command offers NOTHING rather than a partial or widened list.
const REVIEWED_PAIR = ['WhoAmI', 'RetrieveVersion'];
const DESCRIPTOR_KEYS = ['name', 'displayName', 'isFunction', 'bindingType', 'parameters', 'parameterKinds', 'response', 'outputPrivacy', 'invocation', 'requiresExplicitSelection'];
const VERIFICATION_KEYS = ['mode', 'environment', 'runtime', 'privileges'];

const isEntry = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameKeys = (value, keys) => isEntry(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

// The operation as this command prints it — its own copy, members in the documented order — or null when it is not a reviewed, unbound,
// zero-input Function offered for a user-triggered call that the maker must select.
function offered(operation, name) {
  if (!sameKeys(operation, DESCRIPTOR_KEYS) || operation.name !== name) return null;
  const { response } = operation;
  if (operation.isFunction !== true || operation.bindingType !== 'Global' || operation.invocation !== 'user-triggered' || operation.requiresExplicitSelection !== true) return null;
  if (!Array.isArray(operation.parameters) || operation.parameters.length !== 0 || !sameKeys(operation.parameterKinds, [])) return null;
  if (typeof operation.displayName !== 'string' || !operation.displayName || typeof operation.outputPrivacy !== 'string' || !operation.outputPrivacy) return null;
  if (!sameKeys(response, ['typeName', 'properties']) || typeof response.typeName !== 'string' || !isEntry(response.properties)) return null;
  const properties = Object.entries(response.properties);
  if (!properties.length || properties.some(([, type]) => typeof type !== 'string' || !/^Edm\.[A-Za-z]+$/.test(type))) return null;
  return {
    name: operation.name,
    displayName: operation.displayName,
    isFunction: true,
    bindingType: 'Global',
    parameters: [],
    parameterKinds: {},
    response: { typeName: response.typeName, properties: Object.fromEntries(properties) },
    outputPrivacy: operation.outputPrivacy,
    invocation: 'user-triggered',
    requiresExplicitSelection: true,
  };
}

// The success body, or null when the catalogue cannot be loaded or is not exactly the reviewed pair. The module is loaded here, after the gate
// and the arguments, so a disabled run never depends on it.
function listing() {
  let catalogue;
  try {
    catalogue = require('./lib/dataverse-operations.js').getDataverseOperationCatalogue();
  } catch {
    return null;
  }
  if (!sameKeys(catalogue, ['catalogueVersion', 'verification', 'operations']) || catalogue.catalogueVersion !== 1) return null;
  const { verification, operations } = catalogue;
  if (!sameKeys(verification, VERIFICATION_KEYS) || verification.mode !== 'catalogue-only'
    || ['environment', 'runtime', 'privileges'].some((key) => verification[key] !== 'not-checked')) return null;
  if (!Array.isArray(operations) || operations.length !== REVIEWED_PAIR.length) return null;
  const listed = operations.map((operation, index) => offered(operation, REVIEWED_PAIR[index]));
  if (listed.some((operation) => operation === null)) return null;
  return {
    ok: true,
    catalogueVersion: 1,
    verification: { mode: 'catalogue-only', environment: 'not-checked', runtime: 'not-checked', privileges: 'not-checked' },
    operations: listed,
  };
}

function main(argv) {
  // Every path below writes and then ends the process at once: on Linux and macOS a pipe's writes are queued, and the exit would cut them off.
  makeWritesBlocking(process.stdout, process.stderr);
  exitIfDataverseOperationsDisabled();
  if (argv.length) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
  }
  const body = listing();
  if (!body) {
    process.stderr.write(`${CATALOGUE_UNAVAILABLE}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(body)}\n`);
  process.exit(0);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { USAGE, CATALOGUE_UNAVAILABLE, REVIEWED_PAIR };
