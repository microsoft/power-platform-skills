'use strict';
// A lightweight SDK mock sufficient to drive a full runSdkBuild through every phase — used by
// phase-sequence / journal evals (NOT the exhaustive per-phase mock in sdk-build.test.js). Records
// calls; returns benign successes so the build reaches the app-shell + publish phases.
// Minimal JsonPointer + form-seed helpers so the mock simulates the SDK's generic mutation surface
// (addElement/updateElement/removeElement/getArtifact) the build engine now uses.
//
// The generic surface is `async` HERE because it is async in the REAL SDK. That fidelity is
// load-bearing, not cosmetic: when this mock returned plain values, an engine call that forgot its
// `await` still behaved correctly under the mock (`await` on a non-promise is a no-op), so every
// mock-driven test passed while the real bundle silently fed a Promise into a pure helper. Keeping
// the mock synchronous made ~1500 tests blind to that entire class. Do not "simplify" these back.
function jpGet(o, p) { let c = o; for (const t of (p === '' ? [] : p.split('/').slice(1))) { if (c == null) return undefined; c = c[t]; } return c; }
function jpSet(o, p, v) { const ts = p.split('/').slice(1); const l = ts.pop(); let c = o; for (const t of ts) c = c[t]; c[l] = v; }
function jpRemove(o, p) { const ts = p.split('/').slice(1); const l = ts.pop(); let c = o; for (const t of ts) c = c[t]; if (Array.isArray(c)) c.splice(Number(l), 1); else delete c[l]; }
const jclone = (v) => JSON.parse(JSON.stringify(v));
// The <DisplayConditions> the bundle gives every form it CREATES, as an entry of the form's root bag: offered to everyone,
// eligible as a fallback, and with no `Order` — a new form takes no slot in the maker's form order, so the build gives it
// one. The bundle's own entry sits at index 3, after the typed `tabs` and the header and footer it also adds.
// form-order-real-bundle.test.js compares all of this with the bundle.
const newFormDisplayConditions = () => ({ i: 3, node: { n: 'DisplayConditions', a: [['FallbackForm', 'true']], c: [{ n: 'Everyone', a: [], c: [] }] } });
// What `getFormSecurityRoles` answers for a stored <DisplayConditions> node, as the bundle reads it: `order` is left out
// when the element has none, `fallbackForm` is true only for "true", a role id is bare and lower-case, and a form with no
// element answers undefined (no display condition at all, which is not "offered to everyone").
function rolesOfDisplayConditions(node) {
  if (!node) return undefined;
  const attribute = (name) => { const pair = (node.a || []).find((p) => p[0] === name); return pair ? pair[1] : undefined; };
  const children = node.c || [];
  const roleIds = children.filter((c) => c.n === 'Role').map((c) => String(((c.a || []).find((p) => p[0] === 'Id') || [])[1] || '').replace(/[{}]/g, '').toLowerCase()).filter(Boolean);
  const order = attribute('Order');
  return {
    ...(children.some((c) => c.n === 'Everyone') ? { everyone: true } : {}),
    ...(roleIds.length ? { roleIds } : {}),
    fallbackForm: attribute('FallbackForm') === 'true',
    ...(order !== undefined && order !== '' ? { order: Number(order) } : {}),
  };
}
// What a form stores after `setFormSecurityRoles(formId, opts)`, as the bundle applies it to the roles `stored` holds
// (undefined: no element). `everyone` or a role list REPLACES the element and keeps the order and the fallback setting
// unless they are given; an order or fallback setting alone edits the existing element and is refused when there is none;
// `{}` removes the element.
function applyRolesWrite(stored, opts) {
  const roleIds = (opts.roleIds || []).map((id) => String(id).replace(/[{}]/g, '').toLowerCase());
  if (opts.everyone && roleIds.length) throw new Error('setFormSecurityRoles: `everyone` and `roleIds` are mutually exclusive — the platform models <Everyone /> as a replacement for the <Role> list, not an addition to it.');
  if (!opts.everyone && !roleIds.length) {
    if (opts.order === undefined && opts.fallbackForm === undefined) return undefined;
    if (!stored) throw new Error('setFormSecurityRoles: `order`/`fallbackForm` were supplied without `roleIds` or `everyone`, but this form has no <DisplayConditions> to attach them to. Pass the roles as well.');
    return { ...stored, ...(opts.order !== undefined ? { order: opts.order } : {}), ...(opts.fallbackForm !== undefined ? { fallbackForm: opts.fallbackForm } : {}) };
  }
  const prior = stored || {};
  return {
    ...(opts.everyone ? { everyone: true } : { roleIds }),
    fallbackForm: opts.fallbackForm !== undefined ? opts.fallbackForm : prior.fallbackForm === true,
    ...(opts.order !== undefined ? { order: opts.order } : (prior.order !== undefined ? { order: prior.order } : {})),
  };
}
function seedForm(id, created) { return { id, tabs: [{ columns: [{ sections: [{ name: 'section_general', columns: 1, rows: [] }] }] }], bag: { a: [], c: created ? [newFormDisplayConditions()] : [] } }; }

function makeSimpleMockSdk() {
  const calls = [];
  let idc = 0;
  const store = {};
  const createdForms = new Set();
  // The roles a form THIS mock created holds once it is pushed (see getFormSecurityRoles); an entry of undefined is a
  // form whose <DisplayConditions> was removed.
  const storedRoles = new Map();
  const sdk = {
    queryRecords: async (e) => (e === 'solution' ? [] : [{ publisherid: 'pub-1' }]),
    createPublisher: async () => ({ id: 'pub-new' }),
    createSolution: async (o) => { calls.push(['createSolution', o]); return { id: 'sol-1' }; },
    createTable: async (o) => { calls.push(['createTable', o]); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s` }; },
    createColumn: async (e, o) => { calls.push(['createColumn', e, o]); return { logicalName: o.schemaName.toLowerCase() }; },
    setColumnVisualization: async (e, c, v) => { calls.push(['setColumnVisualization', e, c, v]); },
    getColumnVisualization: async () => 'None',
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
      const art = t === 'form' ? Object.assign(seedForm(id, true), { name: def.name, entityLogicalName: def.entityLogicalName, formType: def.formType, status: def.status })
        : t === 'dashboard' ? Object.assign({ id, components: [] }, def) : Object.assign({ id }, def);
      art.id = id; store[`${t}:${id}`] = art;
      if (t === 'form') createdForms.add(id);
      return jclone(art);
    },
    createWebResource: async (o) => { calls.push(['createWebResource', o.name]); return { id: `wr-${++idc}`, name: o.name }; },
    pushArtifact: async (t, id) => {
      // A form this mock created is stored as its local copy says at its FIRST push: the build edits that copy before it
      // (createInPlace writes the order into it), and later changes to a form reach the environment through their own calls.
      if (t === 'form' && createdForms.has(id) && !storedRoles.has(id)) {
        const entry = ((store[`form:${id}`] || {}).bag.c || []).find((e) => e && e.node && e.node.n === 'DisplayConditions');
        storedRoles.set(id, rolesOfDisplayConditions(entry && entry.node));
      }
      return { type: t, id, saved: true, shipped: false, publish: { kind: 'notRequested' } };
    },
    getArtifact: async (t, id) => { await Promise.resolve(); return store[`${t}:${id}`] || { id, columns: [] }; },
    fetchArtifact: async (t, id) => { if (!store[`${t}:${id}`]) store[`${t}:${id}`] = t === 'form' ? seedForm(id) : t === 'app' ? { id, siteMap: { areas: [] } } : { id, columns: [] }; return store[`${t}:${id}`]; },
    addElement: async (t, id, ptr, el) => { await Promise.resolve(); const a = store[`${t}:${id}`] || (store[`${t}:${id}`] = { id }); const arr = jpGet(a, ptr); if (Array.isArray(arr)) arr.push(jclone(el)); return jclone(a); },
    updateElement: async (t, id, ptr, patch) => { await Promise.resolve(); const a = store[`${t}:${id}`] || (store[`${t}:${id}`] = { id }); jpSet(a, ptr, jclone(patch)); return jclone(a); },
    removeElement: async (t, id, ptr) => { await Promise.resolve(); const a = store[`${t}:${id}`]; if (a) jpRemove(a, ptr); return jclone(a || { id }); },
    updateRecord: async () => undefined,
    addSolutionComponent: async () => undefined,
    publishArtifact: async (type, id) => ({ type, id, shipped: true, publish: { kind: 'verified' } }),
    // A form's <DisplayConditions>, read back as the bundle reads them. A form this mock created holds what its local copy
    // said at its first push — the element the bundle gives every new form, with NO order — so the forms phase writes the
    // order of every Main form it sets, the first of a table included, and a rebuild finds it in place. A form the mock
    // never created already exists in the environment, and is answered as the first form of its table (order 0).
    getFormSecurityRoles: async (formId) => {
      if (!storedRoles.has(formId)) return { everyone: true, fallbackForm: true, order: 0 };
      const stored = storedRoles.get(formId);
      return stored === undefined ? undefined : jclone(stored);
    },
    setFormSecurityRoles: async (formId, opts) => {
      calls.push(['setFormSecurityRoles', formId, opts]);
      if (storedRoles.has(formId)) storedRoles.set(formId, applyRolesWrite(storedRoles.get(formId), opts));
    },
    getAiReadiness: async (opts) => { calls.push(['getAiReadiness', opts]); return { enabled: true }; },
    // The real SDK writes every requested value (Off included) and lists each one it proves; the
    // build encodes flags to setting values first, so no feature arrives here as a falsy boolean.
    setAppAiFeatures: async (appUnique, flags, opts) => { calls.push(['setAppAiFeatures', appUnique, flags, opts]); return { applied: Object.keys(flags), skipped: [] }; },
    configureRowSummary: async (promptSpec, opts) => { calls.push(['configureRowSummary', promptSpec, opts]); return { modelId: 'model-' + promptSpec.entityLogicalName, aiSkillConfigId: 'skill-' + promptSpec.entityLogicalName }; },
    // Teardown SDK methods
    resolveArtifact: async (kind, identity) => { calls.push(['resolveArtifact', kind, identity]); return []; },
    deleteAppCascade: async (appModuleId, appModuleIdUnique) => { calls.push(['deleteAppCascade', appModuleId, appModuleIdUnique]); },
    // Build idempotency SDK method
    findArtifact: async (kind, identity) => { calls.push(['findArtifact', kind, identity]); return null; },
  };
  return { sdk, calls };
}

module.exports = { makeSimpleMockSdk, newFormDisplayConditions, rolesOfDisplayConditions, applyRolesWrite };
