'use strict';

// Spec builders shared by the tests of the two column rules a build depends on (column-autonumber-gate.test.js and column-required-gate.test.js): one
// small spec with one table, as the App Spec gate and the provision-entities input gate each take it, and the doubles the CLI's testable core runs
// against, which record every call so a test can say that nothing was called.

// The profiles whose spec is going to be built, or planned for a build. The structural profile (teardown's) is not one of them.
const BUILDING_PROFILES = ['design', 'plan', 'deploy'];

const column = (extra) => ({ schemaName: 'new_ref', displayName: 'Reference', ...extra });
const nameColumn = (extra = {}) => ({ schemaName: 'new_name', displayName: 'Name', ...extra });

// The smallest App Spec that validates under every profile, with one table whose columns and name column the test gives.
function appSpec({ columns = [], primaryAttribute = nameColumn() } = {}) {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    app: { name: 'A' },
    entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute, columns }],
    forms: [],
  };
}

// The same table as the input of the provision-entities CLI (the App Spec subset /genpage and /app-builder pass through first).
function provisionInput({ columns = [], primaryAttribute = nameColumn() } = {}) {
  return {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute, columns }],
    relationships: [],
  };
}

// An error message from where `from` begins: the two gates word the table and the column differently (`entity new_ticket: column new_ref ...` and
// `entity 'new_ticket': column 'new_ref' ...`) and share what follows.
const tail = (message, from) => message.slice(message.indexOf(from));

// The CLI's testable core takes the SDK and the discovery client as dependencies. Both are watched: `touched` lists every method called on either, in order.
function watchedDeps() {
  const touched = [];
  const watch = (target) => new Proxy(target, { get: (t, key) => (typeof t[key] === 'function' ? (...args) => { touched.push(String(key)); return t[key](...args); } : t[key]) });
  const sdk = {
    queryRecords: async () => [{ solutionid: 's' }], createPublisher: async () => ({ id: 'p' }), createSolution: async () => ({ id: 's' }),
    createTable: async (o) => ({ logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: `tbl-${o.schemaName}` }),
    updateTable: async () => ({}), updateColumn: async () => ({}),
    createColumn: async (l, o) => ({ logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }),
    createGlobalOptionSet: async () => ({ metadataId: 'g' }), insertStatusValue: async () => 1, createAlternateKey: async () => ({}),
    createCustomerColumn: async (l, o) => ({ logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }),
    createRelationship: async (o) => ({ schemaName: o.schemaName, metadataId: `rel-${o.schemaName}` }),
  };
  const provision = { findTables: async () => [], findColumns: async () => [], fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, relationships: [] }), queryRecords: async () => [{ solutionid: 's' }] };
  return { touched, sdk: watch(sdk), provision: watch(provision) };
}

module.exports = { BUILDING_PROFILES, column, nameColumn, appSpec, provisionInput, tail, watchedDeps };
