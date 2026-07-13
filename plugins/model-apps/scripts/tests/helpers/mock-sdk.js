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
    seedRecordGraph: async (groups, opts) => {
      calls.push(['seedRecordGraph', groups, opts]);
      const createdIds = {};
      for (const g of groups) createdIds[g.entityLogical] = g.records.map((_, i) => `${g.entityLogical}-${i}`);
      return { createdIds };
    },
    enrichDefaultViews: async (logical, cols, opts) => { calls.push(['enrichDefaultViews', logical, cols, opts]); return { updated: [`defview-${logical}`] }; },
    createArtifact: (t, def) => { calls.push(['createArtifact', t]); return Object.assign({ id: `${t}-${++idc}` }, def); },
    createWebResource: async (o) => { calls.push(['createWebResource', o.name]); return { id: `wr-${++idc}`, name: o.name }; },
    pushArtifact: async (t, id) => ({ type: t, id, success: true }),
    setViewColumns: () => ({}),
    getArtifact: (t, id) => ({ id, columns: [] }),
    addField: async () => ({}),
    updateRecord: async () => undefined,
    addSubGrid: () => ({}),
    addFormEventHandler: () => ({}),
    addQuickViewControl: () => ({}),
    addDashboardTile: () => ({}),
    fetchArtifact: async (t, id) => ({ id }),
    addSolutionComponent: async () => undefined,
    publishArtifact: async () => undefined,
    getAiReadiness: async (opts) => { calls.push(['getAiReadiness', opts]); return { enabled: true }; },
    setAppAiFeatures: async (appUnique, flags, opts) => { calls.push(['setAppAiFeatures', appUnique, flags, opts]); return { applied: Object.keys(flags).filter((k) => flags[k]), skipped: [] }; },
    configureRowSummary: async (promptSpec, opts) => { calls.push(['configureRowSummary', promptSpec, opts]); return { modelId: 'model-' + promptSpec.entityLogicalName, aiSkillConfigId: 'skill-' + promptSpec.entityLogicalName }; },
    // Task 15: teardown SDK methods
    resolveArtifact: async (kind, identity) => { calls.push(['resolveArtifact', kind, identity]); return []; },
    deleteAppCascade: async (appModuleId, appModuleIdUnique) => { calls.push(['deleteAppCascade', appModuleId, appModuleIdUnique]); },
    // Task 17: build idempotency SDK method
    findArtifact: async (kind, identity) => { calls.push(['findArtifact', kind, identity]); return null; },
  };
  return { sdk, calls };
}

module.exports = { makeSimpleMockSdk };
