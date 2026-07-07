'use strict';
// A lightweight SDK mock sufficient to drive a full runSdkBuild through every phase — used by
// phase-sequence / journal evals (NOT the exhaustive per-phase mock in sdk-build.test.js). Records
// calls; returns benign successes so the build reaches the app-shell + publish phases.
function makeSimpleMockSdk() {
  const calls = [];
  let idc = 0;
  const sdk = {
    queryRecords: async (e) => (e === 'solution' ? [] : [{ publisherid: 'pub-1' }]),
    createPublisher: async () => ({ id: 'pub-new' }),
    createSolution: async (o) => { calls.push(['createSolution', o]); return { id: 'sol-1' }; },
    createTable: async (o) => { calls.push(['createTable', o]); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s` }; },
    createColumn: async (e, o) => { calls.push(['createColumn', e, o]); return { logicalName: o.schemaName.toLowerCase() }; },
    createCustomerColumn: async (e, o) => ({ logicalName: o.schemaName.toLowerCase() }),
    createGlobalOptionSet: async (o) => ({ name: o.name }),
    insertStatusValue: async () => 100000001,
    createAlternateKey: async (e, o) => ({ logicalName: o.schemaName.toLowerCase() }),
    createRelationship: async (o) => { calls.push(['createRelationship', o]); return { schemaName: o.schemaName }; },
    findTables: async () => [],
    findColumns: async () => [],
    fetchEntityMetadata: async (l) => ({ logicalName: l, displayName: l, entitySetName: `${l}s`, attributes: [], relationships: [] }),
    createRecordsBulk: async (e, rows) => rows.map((_, i) => `${e}-${i}`),
    createArtifact: (t, def) => { calls.push(['createArtifact', t]); return Object.assign({ id: `${t}-${++idc}` }, def); },
    pushArtifact: async (t, id) => ({ type: t, id, success: true }),
    setViewColumns: () => ({}),
    addSubGrid: () => ({}),
    addFormEventHandler: () => ({}),
    addQuickViewControl: () => ({}),
    addDashboardTile: () => ({}),
    fetchArtifact: async (t, id) => ({ id }),
    addSolutionComponent: async () => undefined,
    publishArtifact: async () => undefined,
  };
  return { sdk, calls };
}

module.exports = { makeSimpleMockSdk };
