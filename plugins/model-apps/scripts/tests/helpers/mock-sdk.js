'use strict';
// A lightweight SDK mock sufficient to drive a full runSdkBuild through every phase — used by
// phase-sequence / journal evals (NOT the exhaustive per-phase mock in sdk-build.test.js). Records
// calls; returns benign successes so the build reaches the app-shell + publish phases.
// Minimal JsonPointer + form-seed helpers so the mock simulates the SDK's generic mutation surface
// (addElement/updateElement/removeElement/getArtifact) the build engine now uses.
function jpGet(o, p) { let c = o; for (const t of (p === '' ? [] : p.split('/').slice(1))) { if (c == null) return undefined; c = c[t]; } return c; }
function jpSet(o, p, v) { const ts = p.split('/').slice(1); const l = ts.pop(); let c = o; for (const t of ts) c = c[t]; c[l] = v; }
function jpRemove(o, p) { const ts = p.split('/').slice(1); const l = ts.pop(); let c = o; for (const t of ts) c = c[t]; if (Array.isArray(c)) c.splice(Number(l), 1); else delete c[l]; }
const jclone = (v) => JSON.parse(JSON.stringify(v));
function seedForm(id) { return { id, tabs: [{ columns: [{ sections: [{ name: 'section_general', columns: 1, rows: [] }] }] }], bag: { a: [], c: [] } }; }

function makeSimpleMockSdk() {
  const calls = [];
  let idc = 0;
  const store = {};
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
    createArtifact: (t, def) => {
      calls.push(['createArtifact', t]);
      const id = `${t}-${++idc}`;
      const art = t === 'form' ? Object.assign(seedForm(id), { name: def.name, entityLogicalName: def.entityLogicalName, formType: def.formType, status: def.status })
        : t === 'dashboard' ? Object.assign({ id, components: [] }, def) : Object.assign({ id }, def);
      art.id = id; store[`${t}:${id}`] = art; return jclone(art);
    },
    createWebResource: async (o) => { calls.push(['createWebResource', o.name]); return { id: `wr-${++idc}`, name: o.name }; },
    pushArtifact: async (t, id) => ({ type: t, id, saved: true, shipped: false, publish: { kind: 'notRequested' } }),
    getArtifact: (t, id) => store[`${t}:${id}`] || { id, columns: [] },
    fetchArtifact: async (t, id) => { if (!store[`${t}:${id}`]) store[`${t}:${id}`] = t === 'form' ? seedForm(id) : t === 'app' ? { id, siteMap: { areas: [] } } : { id, columns: [] }; return store[`${t}:${id}`]; },
    addElement: (t, id, ptr, el) => { const a = store[`${t}:${id}`] || (store[`${t}:${id}`] = { id }); const arr = jpGet(a, ptr); if (Array.isArray(arr)) arr.push(jclone(el)); return jclone(a); },
    updateElement: (t, id, ptr, patch) => { const a = store[`${t}:${id}`] || (store[`${t}:${id}`] = { id }); jpSet(a, ptr, jclone(patch)); return jclone(a); },
    removeElement: (t, id, ptr) => { const a = store[`${t}:${id}`]; if (a) jpRemove(a, ptr); return jclone(a || { id }); },
    updateRecord: async () => undefined,
    addSolutionComponent: async () => undefined,
    publishArtifact: async (type, id) => ({ type, id, shipped: true, publish: { kind: 'verified' } }),
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
