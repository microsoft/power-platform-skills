'use strict';
// Regression tests for the ten defects an adversarial peer review found in the AB#6686423 /
// AB#6686428 / AB#6686429 changes. Every one was a real bug in code I had already tested, mutation-
// tested and (for roleGrants) live-verified — so each is pinned here by the PROPERTY it broke, not
// by the shape of the fix.
const { test } = require('node:test');
const assert = require('node:assert');
const { validateAppSpec, choiceValueMap, labelText } = require('../lib/app-spec.js');
const { validateProvisionInput } = require('../lib/provision-input.js');
const { phaseInputs } = (() => { const m = require('../lib/phase-diff.js'); return { phaseInputs: m.PHASE_INPUTS || m.phaseInputs }; })();
const { runSdkBuild, subgridLabel, viewDef } = require('../lib/sdk-build.js');
const { notRoundTrippedSummary, notRoundTrippedWarning } = require('../download-model-app.js');

function base() {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
    app: { name: 'Contoso' },
    languageCode: 1033,
    entities: [{ schemaName: 'contoso_order', displayName: 'Order', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Main', subAreas: [] }] }] },
  };
}
const errorsFor = (mutate) => { const s = base(); mutate(s); return validateAppSpec(s, { profile: 'plan' }).errors || []; };

// --- Finding 1: roleGrants were invisible to --changed-only ---------------------------------------

test('#1 a roleGrant-only change is VISIBLE to the changed-only phase diff', async () => {
  // The security slice was `s.personas` alone, so a spec whose ONLY change was adding a roleGrant
  // diffed as "nothing changed": --changed-only reported "deployed app already matches the spec" and
  // never called AddPrivilegesRole. The table deployed and the role still had no access to it —
  // which IS the bug roleGrants[] exists to fix, reintroduced through the fast path.
  const { diffPhases } = require('../lib/phase-diff.js');
  const before = base();
  const after = base();
  after.roleGrants = [{ role: 'Viewer', privileges: [{ entity: 'contoso_order', access: ['read'], scope: 'organization' }] }];
  assert.ok(diffPhases(after, before).includes('security'), `security not in ${JSON.stringify(diffPhases(after, before))}`);
  // ...and EDITING an existing grant is a change too, not just adding the first one.
  const edited = JSON.parse(JSON.stringify(after));
  edited.roleGrants[0].privileges[0].access = ['read', 'write'];
  assert.ok(diffPhases(edited, after).includes('security'));
  // An untouched spec must still diff clean, or every build becomes a full build.
  assert.ok(!diffPhases(after, JSON.parse(JSON.stringify(after))).includes('security'));
});

// --- Finding 2: the role identity guard could be bypassed -----------------------------------------

const roleRow = (over = {}) => ({ roleid: '33333333-3333-3333-3333-333333333333', name: 'Shared', ismanaged: false, ...over });

function securitySdk(over = {}) {
  const calls = { addEntityPrivilegesToRole: [] };
  return {
    calls,
    queryRecords: async (entity) => {
      if (entity === 'businessunit') return [{ businessunitid: '44444444-4444-4444-4444-444444444444' }];
      if (entity === 'role') return [roleRow()];
      return [];
    },
    createPersonaRole: async (spec) => ({ roleId: '33333333-3333-3333-3333-333333333333', name: spec.name, reused: false, appliedPrivileges: [] }),
    addEntityPrivilegesToRole: async (roleId, privileges) => { calls.addEntityPrivilegesToRole.push({ roleId, privileges }); return []; },
    addSolutionComponent: async () => ({}),
    associateRecords: async () => ({}),
    disassociateRecords: async () => ({}),
    ...over,
  };
}
const applySecurity = (spec, sdk) => runSdkBuild(spec, { sdk, provisionSdk: sdk, apply: true, phases: ['security'] });

test('#2a a roleGrant pinned by roleId at a PERSONA role halts on the resolved id', async () => {
  // The static check compares NAMES, and a persona role does not exist at lint time, so a pinned id
  // aiming at the same role slipped through. The build then ran ReplacePrivilegesRole (removing
  // everything not on the persona) and AddPrivilegesRole against ONE role — and a failure between
  // the two leaves the access removed.
  const s = base();
  s.personas = [{ persona: 'Shared', jobs: [{ name: 'j', privileges: [{ entity: 'contoso_order', access: ['read'] }] }] }];
  s.roleGrants = [{ roleId: '33333333-3333-3333-3333-333333333333', privileges: [{ entity: 'contoso_order', access: ['write'], scope: 'organization' }] }];
  assert.strictEqual(validateAppSpec(s, { profile: 'plan' }).ok, true, 'a static check cannot see this — the apply path must');
  const sdk = securitySdk();
  await assert.rejects(() => applySecurity(s, sdk), (err) => {
    assert.strictEqual(err.code, 'role-grant-persona-overlap');
    assert.match(err.message, /also persona "Shared"/);
    return true;
  });
  assert.strictEqual(sdk.calls.addEntityPrivilegesToRole.length, 0, 'nothing may be granted once the overlap is known');
});

test('#2b a NAME and a roleId aliasing ONE role halt on the resolved id', async () => {
  // Two entries the static dedup could not see as one role. Splitting them across two SDK calls
  // hides the "entities sharing one privilege must request one depth" conflict, which the SDK
  // detects only WITHIN a call — so the later write silently wins.
  const s = base();
  s.roleGrants = [
    { role: 'Shared', privileges: [{ entity: 'contoso_order', access: ['read'], scope: 'user' }] },
    { roleId: '33333333-3333-3333-3333-333333333333', privileges: [{ entity: 'contoso_order', access: ['read'], scope: 'organization' }] },
  ];
  assert.strictEqual(validateAppSpec(s, { profile: 'plan' }).ok, true);
  await assert.rejects(() => applySecurity(s, securitySdk()), (err) => {
    assert.strictEqual(err.code, 'role-grant-duplicate-target');
    assert.match(err.message, /already targets/);
    return true;
  });
});

test('#2c two same-named roles in DIFFERENT business units are allowed', async () => {
  // The old dedup keyed on the bare name, so this valid pair was rejected. A role is identified by
  // (name, business unit) — that is the identity the SDK itself uses.
  const errs = errorsFor((s) => {
    s.roleGrants = [
      { role: 'Viewer', businessUnitId: '11111111-1111-1111-1111-111111111111', privileges: [{ entity: 'contoso_order', access: ['read'] }] },
      { role: 'Viewer', businessUnitId: '22222222-2222-2222-2222-222222222222', privileges: [{ entity: 'contoso_order', access: ['read'] }] },
    ];
  });
  assert.deepStrictEqual(errs.filter((e) => /duplicate roleGrant/.test(e)), [], JSON.stringify(errs));
  // ...but the SAME business unit (or both defaulting to root) is still a duplicate.
  assert.ok(errorsFor((s) => {
    s.roleGrants = [
      { role: 'Viewer', privileges: [{ entity: 'contoso_order', access: ['read'] }] },
      { role: 'viewer', privileges: [{ entity: 'contoso_order', access: ['write'] }] },
    ];
  }).some((e) => /duplicate roleGrant/.test(e)));
});

test('#2d the persona overlap check is business-unit aware', async () => {
  // A persona in BU-1 and a grant on a same-named role in BU-2 are DIFFERENT roles; rejecting that
  // pair was over-strict for the same reason #2c was.
  const errs = errorsFor((s) => {
    s.personas = [{ persona: 'Viewer', businessUnitId: '11111111-1111-1111-1111-111111111111', jobs: [{ name: 'j', privileges: [{ entity: 'contoso_order', access: ['read'] }] }] }];
    s.roleGrants = [{ role: 'Viewer', businessUnitId: '22222222-2222-2222-2222-222222222222', privileges: [{ entity: 'contoso_order', access: ['read'] }] }];
  });
  assert.deepStrictEqual(errs.filter((e) => /is a persona in this spec/.test(e)), [], JSON.stringify(errs));
  // Same BU (both root) is still caught statically.
  assert.ok(errorsFor((s) => {
    s.personas = [{ persona: 'Viewer', jobs: [{ name: 'j', privileges: [{ entity: 'contoso_order', access: ['read'] }] }] }];
    s.roleGrants = [{ role: 'Viewer', privileges: [{ entity: 'contoso_order', access: ['read'] }] }];
  }).some((e) => /is a persona in this spec/.test(e)));
  // And an EXPLICIT matching BU on both sides is caught too — a bug the name-only key hid, because
  // it could not tell "same BU, explicitly written" from "different BU".
  assert.ok(errorsFor((s) => {
    s.personas = [{ persona: 'Viewer', businessUnitId: '11111111-1111-1111-1111-111111111111', jobs: [{ name: 'j', privileges: [{ entity: 'contoso_order', access: ['read'] }] }] }];
    s.roleGrants = [{ role: 'Viewer', businessUnitId: '11111111-1111-1111-1111-111111111111', privileges: [{ entity: 'contoso_order', access: ['read'] }] }];
  }).some((e) => /is a persona in this spec/.test(e)), 'an explicit same-BU overlap must still be rejected');
});

// --- Finding 3: provision-entities bypassed localized-label validation ----------------------------

const provisionBase = (entityExtra) => ({
  solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
  entities: [{ schemaName: 'contoso_order', primaryAttribute: { schemaName: 'contoso_name' }, columns: [], ...entityExtra }],
  relationships: [],
});

test('#3 the provision-entities input rejects a language TAG, like the App Spec does', () => {
  // `provision-entities.js` is a SEPARATE entry point whose only gate is validateProvisionInput, and
  // it provisions the SOLUTION before the data model — so a label that fails only inside createTable
  // fails AFTER a write. Two entry points that disagree about what a label is teach two rules.
  const r = validateProvisionInput(provisionBase({ displayName: { 'es-ES': 'Pedido' } }));
  assert.strictEqual(r.ok, false, JSON.stringify(r.errors));
  assert.ok((r.errors || []).some((e) => /is not an LCID/.test(e)), JSON.stringify(r.errors));
});

test('#3b the provision-entities input enforces the localized-plural rule', () => {
  const r = validateProvisionInput(provisionBase({ displayName: { 1033: 'Order', 3082: 'Pedido' } }));
  assert.strictEqual(r.ok, false);
  assert.ok((r.errors || []).some((e) => /pluralName is required when displayName is a localized label/.test(e)), JSON.stringify(r.errors));
  // With the plural supplied it passes — the rule is about derivability, not about forbidding maps.
  assert.strictEqual(validateProvisionInput(provisionBase({ displayName: { 1033: 'Order', 3082: 'Pedido' }, pluralName: { 1033: 'Orders', 3082: 'Pedidos' } })).ok, true);
});

test('#3c a plain-string provision input is unaffected', () => {
  assert.strictEqual(validateProvisionInput(provisionBase({ displayName: 'Order' })).ok, true);
});

// --- Finding 4: localized Choice labels did not resolve in view filters ---------------------------

test('#4 a view filter naming a localized Choice option resolves to its option value', () => {
  // `options.indexOf(val)` returns -1 for an object option, so the LABEL was sent as the value of a
  // numeric picklist condition — an invalid or silently ineffective view filter.
  const s = base();
  s.entities[0].columns = [{ schemaName: 'contoso_status', type: 'Choice', options: [{ 1033: 'Open', 3082: 'Abierto' }, { 1033: 'Closed', 3082: 'Cerrado' }] }];
  s.views = [{ name: 'Open', entity: 'contoso_order', columns: ['contoso_name'], filters: [{ attr: 'contoso_status', op: 'eq', value: 'Abierto' }] }];
  const def = viewDef(s, s.views[0]);
  const json = JSON.stringify(def);
  assert.match(json, /100000000/, `the Spanish label did not resolve: ${json}`);
  assert.doesNotMatch(json, /"Abierto"/, 'the raw label must not reach a numeric picklist condition');
});

test('#4b a view filter on a GLOBAL choice resolves too', () => {
  // The inline-only lookup never resolved a column bound to a globalChoice at all.
  const s = base();
  s.globalChoices = [{ name: 'contoso_status', displayName: 'Status', options: ['Open', 'Closed'] }];
  s.entities[0].columns = [{ schemaName: 'contoso_status', type: 'Choice', globalChoice: 'contoso_status' }];
  s.views = [{ name: 'Closed', entity: 'contoso_order', columns: ['contoso_name'], filters: [{ attr: 'contoso_status', op: 'eq', value: 'Closed' }] }];
  assert.match(JSON.stringify(viewDef(s, s.views[0])), /100000001/);
});

// --- Finding 5: an ambiguous cross-language alias silently picked the wrong option ------------------

test('#5 a label string naming TWO options is rejected, not tie-broken', () => {
  // "Abierto" is option 0 in Spanish and option 1 in English. Any resolution rule is a coin flip, so
  // the SPEC is what must be fixed. Last-wins silently resolved it to the second option.
  const errs = errorsFor((s) => {
    s.entities[0].columns = [{ schemaName: 'contoso_status', type: 'Choice', options: [{ 1033: 'Open', 3082: 'Abierto' }, { 1033: 'Abierto', 3082: 'Cerrado' }] }];
  });
  const hit = errs.find((e) => /names BOTH options/.test(e));
  assert.ok(hit, JSON.stringify(errs));
  assert.match(hit, /'Abierto'/);
  assert.match(hit, /Rename one/);
});

test('#5b a duplicate plain label is caught by the same rule', () => {
  assert.ok(errorsFor((s) => {
    s.globalChoices = [{ name: 'contoso_p', displayName: 'P', options: ['Open', 'Open'] }];
  }).some((e) => /names BOTH options/.test(e)));
});

test('#5c the alias index is first-wins, so resolution is deterministic', () => {
  // Belt and braces: the validator rejects ambiguity, but a spec that bypassed validation must still
  // resolve predictably rather than to whichever option happened to be last.
  const entity = { schemaName: 'e', columns: [{ schemaName: 'c', type: 'Choice', options: [{ 1033: 'Open', 3082: 'Abierto' }, { 1033: 'Abierto', 3082: 'Cerrado' }] }] };
  assert.strictEqual(choiceValueMap(entity, {}).c.Abierto, 100000000);
});

// --- Finding 6: the not-round-tripped report failed open on an inventory read failure --------------

test('#6 a FAILED inventory read is reported as UNKNOWN, not as "the app has none"', () => {
  // The whole app-component block shared one broad catch, so a 403 on systemform produced
  // `forms: []` and `notRoundTripped: null` — an empty spec with nothing reporting why, which is
  // AB#6686423 reappearing inside its own fix.
  const s = notRoundTrippedSummary({ forms: [], views: [], charts: [], incomplete: [{ kind: 'forms', reason: 'HTTP 403' }] });
  assert.ok(s, 'a failed read must not summarise as null');
  assert.deepStrictEqual(s.incomplete, [{ kind: 'forms', reason: 'HTTP 403' }]);
  const w = notRoundTrippedWarning(s);
  assert.match(w, /could NOT be inventoried/);
  assert.match(w, /forms — HTTP 403/);
  assert.match(w, /UNKNOWN, not as "the app has none"/);
});

test('#6a readDescriptionInventory RECORDS a per-class read failure', async () => {
  // BEHAVIOURAL, through the real reader. The unit test above proves the summary reports an
  // `incomplete` entry; only this proves one is ever PRODUCED. It also pins the per-class catch: a
  // failing `systemform` query must not hide the views and charts that were read successfully.
  const { readDescriptionInventory } = require('../download-model-app.js');
  const APP = '11111111-1111-1111-1111-111111111111';
  const sdk = {
    queryRecords: async (logical, opts) => {
      const filter = (opts && opts.filter) || '';
      if (logical === 'appmodule') return [{ appmoduleidunique: APP }];
      if (logical === 'appmodulecomponent') {
        if (/componenttype eq 60/.test(filter)) throw new Error('HTTP 403 forbidden');
        if (/componenttype eq 26/.test(filter)) return [{ objectid: 'v-1', componenttype: 26 }];
        return [];
      }
      if (logical === 'savedquery') return [{ savedqueryid: 'v-1', name: 'Active Orders', returnedtypecode: 'contoso_order' }];
      return [];
    },
    dataverse: { get: async () => ({ status: 404, headers: {}, body: {} }) },
  };
  const inv = await readDescriptionInventory(sdk, APP, null);
  assert.deepStrictEqual((inv.incomplete || []).map((i) => i.kind), ['forms'], JSON.stringify(inv.incomplete));
  assert.match(inv.incomplete[0].reason, /403/);
  // The class that DID read is still present — one failed query must not blank the others.
  assert.deepStrictEqual(inv.views.map((v) => v.name), ['Active Orders']);
  // ...and the summary built from it reports both halves.
  const w = notRoundTrippedWarning(notRoundTrippedSummary(inv));
  assert.match(w, /1 view on 1 table\(s\)/);
  assert.match(w, /forms — HTTP 403/);
});

test('#6a2 an unreadable app-component list marks EVERY class unknown', async () => {
  // If the parent lookup itself fails, nothing was enumerated — reporting "no forms, no views, no
  // charts" would be three lies at once.
  const { readDescriptionInventory } = require('../download-model-app.js');
  const sdk = {
    queryRecords: async () => { throw new Error('HTTP 500'); },
    dataverse: { get: async () => ({ status: 500, headers: {}, body: {} }) },
  };
  const inv = await readDescriptionInventory(sdk, '11111111-1111-1111-1111-111111111111', null);
  assert.deepStrictEqual((inv.incomplete || []).map((i) => i.kind).sort(), ['charts', 'forms', 'views']);
});

test('#6b a partial failure reports BOTH what was found and what is unknown', () => {
  const s = notRoundTrippedSummary({
    forms: [{ name: 'Main', entity: 'contoso_order' }], views: [], charts: [],
    incomplete: [{ kind: 'views', reason: 'HTTP 500' }],
  });
  const w = notRoundTrippedWarning(s);
  assert.match(w, /1 form on 1 table\(s\)/);
  assert.match(w, /views — HTTP 500/);
});

test('#6c a clean read with nothing to report still summarises as null', () => {
  assert.strictEqual(notRoundTrippedSummary({ forms: [], views: [], charts: [], incomplete: [] }), null);
});

// --- Finding 7: the download discarded the localized primary-attribute label -----------------------

test('#7 the primary attribute keeps its real (and localized) label', () => {
  // It is excluded from columns[], so its label was hardcoded to 'Name' — a fresh-environment
  // rebuild lost both the real label and its translations, contradicting "the round trip closes".
  const { entityFromMetadata } = require('../download-model-app.js');
  const dv = (pairs) => ({ LocalizedLabels: pairs.map(([LanguageCode, Label]) => ({ Label, LanguageCode })) });
  const e = entityFromMetadata({
    logicalName: 'contoso_order', schemaName: 'contoso_order', displayName: 'Order', primaryNameAttribute: 'contoso_title',
    attributes: [{ logicalName: 'contoso_title', schemaName: 'contoso_title', attributeType: 'String', isCustomAttribute: true, DisplayName: dv([[1033, 'Order Title'], [3082, 'Título del pedido']]) }],
  }, 'contoso_order');
  assert.deepStrictEqual(e.primaryAttribute.displayName, { 1033: 'Order Title', 3082: 'Título del pedido' });
  // The primary column must still be kept OUT of columns[] — it is declared separately.
  assert.deepStrictEqual(e.columns.map((c) => c.schemaName), []);
  // A single-language primary stays a plain string.
  const single = entityFromMetadata({
    logicalName: 'new_order', schemaName: 'new_order', displayName: 'Order', primaryNameAttribute: 'new_title',
    attributes: [{ logicalName: 'new_title', schemaName: 'new_title', attributeType: 'String', isCustomAttribute: true, DisplayName: dv([[1033, 'Order Title']]) }],
  }, 'new_order');
  assert.strictEqual(single.primaryAttribute.displayName, 'Order Title');
  // And an UNLABELLED primary still falls back to 'Name' rather than to undefined.
  const none = entityFromMetadata({ logicalName: 'new_order', schemaName: 'new_order', displayName: 'Order', primaryNameAttribute: 'new_title', attributes: [] }, 'new_order');
  assert.strictEqual(none.primaryAttribute.displayName, 'Name');
});

// --- Finding 8: a localized child label reached form change detection as [object Object] ------------

test('#8 a sub-grid title resolves a localized child label instead of stringifying it', () => {
  // subgridLabel fed the form intent, which the projection stringifies for change detection — so two
  // DIFFERENT localized labels both became "[object Object]" and hashed identically.
  const s = base();
  s.languageCode = 3082;
  s.entities.push({ schemaName: 'contoso_line', displayName: { 1033: 'Line', 3082: 'Línea' }, pluralName: { 1033: 'Lines', 3082: 'Líneas' }, primaryAttribute: { schemaName: 'contoso_name' }, columns: [] });
  assert.strictEqual(subgridLabel(s, { childEntity: 'contoso_line' }), 'Líneas');
  // Falls through to the singular when there is no plural, and to the logical name when neither.
  s.entities[1].pluralName = undefined;
  assert.strictEqual(subgridLabel(s, { childEntity: 'contoso_line' }), 'Línea');
  assert.strictEqual(subgridLabel(s, { childEntity: 'contoso_missing' }), 'contoso_missing');
  // An explicit label always wins.
  assert.strictEqual(subgridLabel(s, { childEntity: 'contoso_line', label: 'Mine' }), 'Mine');
});

// --- Finding 9: several derive sites ignored the spec's authoring language -------------------------

test('#9 the AI prompt, design doc and schema facts all resolve in the SPEC language', () => {
  const s = base();
  s.languageCode = 3082;
  s.entities[0].displayName = { 1033: 'Order', 3082: 'Pedido' };
  s.entities[0].pluralName = { 1033: 'Orders', 3082: 'Pedidos' };
  s.entities[0].primaryAttribute.displayName = { 1033: 'Name', 3082: 'Nombre' };
  s.entities[0].columns = [{ schemaName: 'contoso_note', type: 'Text', displayName: { 1033: 'Note', 3082: 'Nota' } }];

  const { buildPromptSpec } = require('../lib/ai-prompt.js');
  const p = buildPromptSpec(s.entities[0], { spec: s });
  assert.match(p.instruction, /Pedido/, `AI prompt used the wrong language: ${p.instruction}`);
  assert.deepStrictEqual(p.columns.map((c) => c.display), ['Nota']);

  const { schemaFacts } = require('../lib/schema-facts.js');
  const facts = schemaFacts(s);
  const t = (facts.tables || facts.entities || [])[0];
  assert.strictEqual(t.displayName, 'Pedido');
  assert.strictEqual(t.primary.displayName, 'Nombre');

  const { renderAppSpecDoc } = require('../lib/app-spec-doc.js');
  assert.match(renderAppSpecDoc(s), /Nota/);
});

test('#9b a localized Choice option renders in the design doc instead of an empty cell', () => {
  // The doc treated any object option as the legacy `{label}` shape, so a localized option — an
  // object with no `label` key — rendered as "choices: —, —".
  const { renderAppSpecDoc } = require('../lib/app-spec-doc.js');
  const s = base();
  s.entities[0].columns = [{ schemaName: 'contoso_status', type: 'Choice', options: [{ 1033: 'Open', 3082: 'Abierto' }, { 1033: 'Closed', 3082: 'Cerrado' }] }];
  const doc = renderAppSpecDoc(s);
  assert.match(doc, /choices: Open, Closed/, doc.split('\n').filter((l) => /choices/.test(l)).join(' | '));
});

test('#9c a localized lookup label reaches relationship facts as a STRING', () => {
  const { schemaFacts } = require('../lib/schema-facts.js');
  const s = base();
  s.entities.push({ schemaName: 'contoso_line', displayName: 'Line', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] });
  s.relationships = [{ type: 'OneToMany', referenced: 'contoso_order', referencing: 'contoso_line', lookup: { schemaName: 'contoso_orderid', displayName: { 1033: 'Order', 3082: 'Pedido' } } }];
  const rels = schemaFacts(s).relationships || [];
  assert.strictEqual(typeof rels[0].lookup.displayName, 'string', JSON.stringify(rels[0]));
  assert.strictEqual(rels[0].lookup.displayName, 'Order');
  assert.strictEqual(JSON.stringify(schemaFacts(s)).includes('[object Object]'), false);
});

test('#9d a form wireframe renders localized field labels in the spec language', () => {
  const { renderFormWireframe } = require('../lib/form-preview.js');
  const s = base();
  s.languageCode = 3082;
  s.entities[0].primaryAttribute.displayName = { 1033: 'Name', 3082: 'Nombre' };
  s.entities[0].columns = [{ schemaName: 'contoso_note', type: 'Text', displayName: { 1033: 'Note', 3082: 'Nota' } }];
  s.forms = [{ entity: 'contoso_order', name: 'Main', formType: 'Main', tabs: [{ label: 'General', sections: [{ label: 'Details', fields: ['contoso_name', 'contoso_note'] }] }] }];
  const w = renderFormWireframe(s, s.forms[0]);
  assert.doesNotMatch(w, /\[object Object\]/);
  assert.match(w, /Nombre/);
  assert.match(w, /Nota/);
});
