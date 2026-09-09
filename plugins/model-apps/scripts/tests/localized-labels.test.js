'use strict';
// AB#6686428 / #537(b) — localized Dataverse metadata labels.
//
// The reported gap: "the whole-app App Spec cannot express multiple Dataverse metadata labels for
// tables, plural names, primary fields, columns, lookups, or Choice options. Download also does not
// round-trip existing localized labels." The build created English labels only; the Spanish UI
// therefore fell back to English, and every create/edit needed a manual metadata patch afterwards.
//
// The shape is an LCID map ON THE FIELD, not a sibling `localizedLabels` block:
//
//     "displayName": { "1033": "Project Baseline", "3082": "Línea base del proyecto" }
//
// That is the vendored SDK's own label shape (measured on the wire: createTable, createColumn,
// createGlobalOptionSet, createRelationship and createAlternateKey each serialize a map into a
// multi-entry LocalizedLabels array), so the spec passes it through instead of pre-flattening. It
// also keeps the label beside the name it labels, which a table-level block could not do for a
// Choice OPTION or a lookup's display name without inventing a parallel addressing scheme.
const { test } = require('node:test');
const assert = require('node:assert');
const { validateAppSpec, labelText, labelAliases, isLocalizedLabelMap, localizedLabelLcids, validateLabel, choiceValueMap } = require('../lib/app-spec.js');
const { labelFromDataverse, columnDisplayName, entityFromMetadata } = require('../download-model-app.js');

const ES = { 1033: 'Project Baseline', 3082: 'Línea base del proyecto' };

function base() {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
    app: { name: 'Contoso' },
    languageCode: 1033,
    entities: [{
      schemaName: 'contoso_projectbaseline',
      displayName: 'Project Baseline',
      primaryAttribute: { schemaName: 'contoso_title', displayName: 'Title' },
      columns: [],
    }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Main', subAreas: [] }] }] },
  };
}

const errorsFor = (mutate, profile = 'plan') => { const s = base(); mutate(s); return validateAppSpec(s, { profile }).errors || []; };
const warningsFor = (mutate) => { const s = base(); mutate(s); return validateAppSpec(s, { profile: 'plan' }).warnings || []; };

// --- labelText ------------------------------------------------------------------------------------

test('labelText returns a plain string unchanged', () => {
  assert.strictEqual(labelText('Baseline'), 'Baseline');
});

test('labelText prefers the requested language, then 1033, then the lowest declared LCID', () => {
  assert.strictEqual(labelText(ES, 3082), 'Línea base del proyecto');
  // No requested language -> 1033. This step is load-bearing, not decorative: V8 orders
  // integer-like keys ASCENDING, so without it a { 1031, 1033 } label would resolve to GERMAN.
  assert.strictEqual(labelText({ 1031: 'Projektbasislinie', 1033: 'Project Baseline' }), 'Project Baseline');
  assert.strictEqual(labelText({ 3082: 'Línea base', 1033: 'Baseline' }), 'Baseline');
  // Neither the requested language nor 1033 exists -> the lowest declared, rather than an empty cell.
  assert.strictEqual(labelText({ 3082: 'Línea base' }, 1031), 'Línea base');
  assert.strictEqual(labelText({ 3082: 'Línea base', 1031: 'Basislinie' }, 1049), 'Basislinie');
});

test('labelText returns "" for nothing usable, so callers can fall back to a schema name', () => {
  for (const v of [undefined, null, {}, [], 42, { 'en-US': 'x' }]) assert.strictEqual(labelText(v), '', JSON.stringify(v));
});

test('localizedLabelLcids reports only canonical LCID keys', () => {
  assert.deepStrictEqual(localizedLabelLcids(ES), [1033, 3082]);
  assert.deepStrictEqual(localizedLabelLcids({ '01033': 'x', 'en-US': 'y' }), []);
  assert.deepStrictEqual(localizedLabelLcids('Baseline'), []);
  assert.strictEqual(isLocalizedLabelMap('Baseline'), false);
  assert.strictEqual(isLocalizedLabelMap([]), false);
});

// --- validation: the shape ------------------------------------------------------------------------

test('a localized label on every VERIFIED surface validates', () => {
  // The exact list the bug asks for, minus global choices: table, plural, primary field, column,
  // lookup, alternate key, and INLINE Choice options. `globalChoices[]` is covered by its own test
  // below — it is rejected, because Dataverse silently stores only the base language there.
  const s = base();
  s.entities[0].displayName = ES;
  s.entities[0].pluralName = { 1033: 'Project Baselines', 3082: 'Líneas base del proyecto' };
  s.entities[0].primaryAttribute.displayName = { 1033: 'Title', 3082: 'Título' };
  s.entities[0].columns = [
    { schemaName: 'contoso_note', type: 'Text', displayName: { 1033: 'Note', 3082: 'Nota' } },
    { schemaName: 'contoso_status', type: 'Choice', displayName: { 1033: 'Status', 3082: 'Estado' }, options: [{ 1033: 'Open', 3082: 'Abierto' }, { 1033: 'Closed', 3082: 'Cerrado' }] },
  ];
  s.entities[0].alternateKeys = [{ schemaName: 'contoso_key', columns: ['contoso_title'], displayName: { 1033: 'Key', 3082: 'Clave' } }];
  s.entities.push({ schemaName: 'contoso_project', displayName: 'Project', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] });
  s.relationships = [{ type: 'OneToMany', referenced: 'contoso_project', referencing: 'contoso_projectbaseline', lookup: { schemaName: 'contoso_projectid', displayName: { 1033: 'Project', 3082: 'Proyecto' } } }];
  const r = validateAppSpec(s, { profile: 'deploy' });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('a LOCALIZED global choice is REJECTED — the platform silently drops it', () => {
  // Measured 0/4 on an org with 1033 and 3082 provisioned, INCLUDING through a raw
  // `POST /GlobalOptionSetDefinitions` that bypasses the SDK — so this is a platform limitation, not
  // a serialization bug. Accepting it would reproduce the exact defect this feature exists to end:
  // a green build with the author's second language silently gone. Rejecting is loud, lands BEFORE
  // any write, and the message names the verified workaround.
  const forDisplayName = errorsFor((s) => {
    s.globalChoices = [{ name: 'contoso_status', displayName: { 1033: 'Status', 3082: 'Estado' }, options: ['Open'] }];
  });
  assert.ok(forDisplayName.some((e) => /displayName cannot be localized/.test(e)), JSON.stringify(forDisplayName));
  assert.ok(forDisplayName.some((e) => /inline\s+Choice/i.test(e)), 'the error must name the workaround');

  const forOption = errorsFor((s) => {
    s.globalChoices = [{ name: 'contoso_status', displayName: 'Status', options: [{ 1033: 'Open', 3082: 'Abierto' }] }];
  });
  assert.ok(forOption.some((e) => /options\[0\] cannot be localized/.test(e)), JSON.stringify(forOption));

  // Counterfactual: a PLAIN global choice is untouched, and so is an INLINE localized Choice —
  // rejecting either would break the verified path and the workaround the message recommends.
  assert.deepStrictEqual(errorsFor((s) => {
    s.globalChoices = [{ name: 'contoso_status', displayName: 'Status', options: ['Open', 'Closed'] }];
    s.entities[0].columns = [{ schemaName: 'contoso_p', type: 'Choice', displayName: { 1033: 'P', 3082: 'P' }, options: [{ 1033: 'High', 3082: 'Alta' }] }];
  }), []);
});

test('the second entry point rejects a localized global choice identically', () => {
  // `provision-entities.js` has its own gate. Two gates that disagree about what a label IS teach
  // the author two different rules for one field.
  const { validateProvisionInput } = require('../lib/provision-input.js');
  const r = validateProvisionInput({
    solution: { uniqueName: 'S', publisherPrefix: 'new' }, languageCode: 1033, entities: [], relationships: [],
    globalChoices: [{ name: 'new_p', displayName: { 1033: 'P', 3082: 'Pr' }, options: ['High'] }],
  });
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.ok(r.errors.some((e) => /cannot be localized/.test(e)), JSON.stringify(r.errors));
});

test('a plain-string label still validates — every existing spec is unaffected', () => {
  assert.strictEqual(validateAppSpec(base(), { profile: 'deploy' }).ok, true);
});

test('a language TAG is rejected rather than guessed', () => {
  // es-ES is 3082 or 1034 depending on sort order. Guessing wrong would not fail — it would label
  // everything in the wrong language, which is far worse than a validation error.
  const errs = errorsFor((s) => { s.entities[0].displayName = { 'es-ES': 'Línea base' }; });
  const hit = errs.find((e) => /is not an LCID/.test(e));
  assert.ok(hit, JSON.stringify(errs));
  assert.match(hit, /not a language tag/);
});

test('a non-canonical integer key is rejected', () => {
  // "01033" is not what Dataverse round-trips, and accepting it would produce two spec keys that
  // mean one language.
  assert.ok(errorsFor((s) => { s.entities[0].displayName = { '01033': 'x' }; }).some((e) => /is not an LCID/.test(e)));
});

test('an out-of-range LCID is rejected', () => {
  assert.ok(errorsFor((s) => { s.entities[0].displayName = { 70000: 'x' }; }).some((e) => /out of range/.test(e)));
});

test('an EMPTY localized label is rejected — the SDK rejects it too', () => {
  const errs = errorsFor((s) => { s.entities[0].displayName = {}; });
  assert.ok(errs.some((e) => /empty localized label/.test(e)), JSON.stringify(errs));
});

test('a blank or non-string label value is rejected per LCID', () => {
  for (const bad of ['', '   ', 42, null]) {
    const errs = errorsFor((s) => { s.entities[0].displayName = { 1033: 'Baseline', 3082: bad }; });
    assert.ok(errs.some((e) => /label for LCID 3082 must be a non-empty string/.test(e)), `${JSON.stringify(bad)}: ${JSON.stringify(errs)}`);
  }
});

test('an array is rejected — it is not a label of either shape', () => {
  assert.ok(errorsFor((s) => { s.entities[0].displayName = ['Baseline']; }).some((e) => /must be a string, or a localized label keyed by LCID/.test(e)));
});

test('validateLabel survives a value whose keys cannot be read', () => {
  // A validator that CRASHES on a hostile spec is worse than one that rejects it: the author gets a
  // stack trace instead of the list of everything else wrong with their spec.
  const errors = [];
  validateLabel(new Proxy({}, { ownKeys() { throw new Error('trap'); } }), 'entity x: displayName', errors);
  assert.deepStrictEqual(errors, ['entity x: displayName could not be read as a localized label']);
});

// --- the plural rule ------------------------------------------------------------------------------

test('a localized displayName REQUIRES an explicit pluralName', () => {
  // The fallback appends "s" (`${displayName}s`). That is not a plural rule outside English, and on
  // a label map it would produce "[object Object]s". Refusing is the only honest option.
  const errs = errorsFor((s) => { s.entities[0].displayName = ES; });
  const hit = errs.find((e) => /pluralName is required when displayName is a localized label/.test(e));
  assert.ok(hit, JSON.stringify(errs));
  assert.match(hit, /cannot be derived by appending "s"/);
});

test('a plain displayName still derives its plural, unchanged', () => {
  assert.strictEqual(validateAppSpec(base(), { profile: 'deploy' }).ok, true);
});

// --- the base-language advisory -------------------------------------------------------------------

test('a localized label omitting the base language WARNS but does not fail', () => {
  // The reporter's own workaround note says both labels must be sent "because a single-language PUT
  // can overwrite 1033". The base label is what every user without a matching UI language sees, so
  // omitting it is nearly always a mistake — but a deliberately Spanish-only table is legal.
  const s = base();
  s.languageCode = 1033;
  s.entities[0].displayName = { 3082: 'Línea base del proyecto' };
  s.entities[0].pluralName = { 3082: 'Líneas base' };
  const r = validateAppSpec(s, { profile: 'deploy' });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  const hit = (r.warnings || []).find((w) => /no label for the spec's languageCode 1033/.test(w));
  assert.ok(hit, JSON.stringify(r.warnings));
  assert.match(hit, /Add "1033" alongside 3082/, 'the warning must say what to add');
});

test('no base-language warning when the base language IS present', () => {
  // A warning that fires on every correct spec is a warning nobody reads.
  const ws = warningsFor((s) => { s.entities[0].displayName = ES; s.entities[0].pluralName = { 1033: 'Baselines', 3082: 'Líneas base' }; });
  assert.deepStrictEqual(ws.filter((w) => /no label for the spec's languageCode/.test(w)), []);
});

// --- render + derive sites ------------------------------------------------------------------------

test('a localized label never reaches a rendered document as [object Object]', () => {
  const { renderAppSpecDoc } = require('../lib/app-spec-doc.js');
  const { renderAppPreview } = require('../lib/app-preview.js');
  const s = base();
  s.languageCode = 3082;
  s.entities[0].displayName = ES;
  s.entities[0].pluralName = { 1033: 'Project Baselines', 3082: 'Líneas base del proyecto' };
  s.entities[0].primaryAttribute.displayName = { 1033: 'Title', 3082: 'Título' };
  s.entities[0].columns = [{ schemaName: 'contoso_note', type: 'Text', displayName: { 1033: 'Note', 3082: 'Nota' } }];
  for (const [name, text, expect] of [
    ['plan doc', renderAppSpecDoc(s), /Título/],
    // The console preview renders table names but shows the primary column by SCHEMA name, so the
    // table label is the assertion that fits it.
    ['app preview', renderAppPreview(s), /Línea base del proyecto/],
  ]) {
    assert.doesNotMatch(text, /\[object Object\]/, `${name} rendered a raw label object`);
    assert.match(text, expect, `${name} did not resolve the label to languageCode 3082`);
  }
});

test('eval schema facts resolve a localized table label to a string', () => {
  const { schemaFacts } = require('../lib/schema-facts.js');
  const s = base();
  s.entities[0].displayName = ES;
  s.entities[0].pluralName = { 1033: 'Project Baselines', 3082: 'Líneas base' };
  const facts = schemaFacts(s);
  const e = (facts.tables || facts.entities || [])[0] || {};
  assert.strictEqual(typeof e.displayName, 'string', JSON.stringify(facts).slice(0, 400));
  assert.strictEqual(e.displayName, 'Project Baseline');
  assert.strictEqual(JSON.stringify(facts).includes('[object Object]'), false);
});

test('eval choice facts carry ONE label per value, not one per language', () => {
  // choiceValueMap indexes a localized option under every language so sample data resolves in
  // either. An eval fact compares against Dataverse, where the option has ONE value — emitting a
  // duplicate fact per language would make every bilingual choice look like twice as many options.
  const { schemaFacts } = require('../lib/schema-facts.js');
  const s = base();
  s.entities[0].columns = [{ schemaName: 'contoso_status', type: 'Choice', options: [{ 1033: 'Open', 3082: 'Abierto' }, { 1033: 'Closed', 3082: 'Cerrado' }] }];
  const facts = schemaFacts(s);
  const table = (facts.tables || facts.entities || [])[0] || {};
  const col = ((table.columns || []).find((c) => /contoso_status/i.test(c.logicalName || c.schemaName || ''))) || {};
  const opts = col.choices || col.options || [];
  assert.strictEqual(opts.length, 2, JSON.stringify(col));
  assert.deepStrictEqual(opts.map((o) => o.value), [100000000, 100000001]);
  assert.deepStrictEqual(opts.map((o) => o.label), ['Open', 'Closed'], 'the first-declared language must win');
});

test('a localized Choice option resolves from EITHER language for sampleData', () => {
  // THE regression this guards: `choiceValueMap` used to key on `String(label)`, which turns a label
  // map into the literal key "[object Object]" — so every sample record referencing a localized
  // option would fail to resolve, silently, at build time.
  const entity = { schemaName: 'contoso_projectbaseline', columns: [{ schemaName: 'contoso_status', type: 'Choice', options: [{ 1033: 'Open', 3082: 'Abierto' }, { 1033: 'Closed', 3082: 'Cerrado' }] }] };
  const map = choiceValueMap(entity, {})['contoso_status'];
  assert.strictEqual(map.Open, 100000000);
  assert.strictEqual(map.Abierto, 100000000, 'the Spanish label must resolve to the SAME value');
  assert.strictEqual(map.Closed, 100000001);
  assert.strictEqual(map.Cerrado, 100000001);
  assert.strictEqual('[object Object]' in map, false);
});

test('labelAliases is the one rule both sample data and surfaces use', () => {
  // DRY: two different resolvers disagreeing about what a label can be CALLED would mean a spec that
  // validates for sample data and not for surfaces, or vice versa.
  assert.deepStrictEqual(labelAliases('Open'), ['Open']);
  assert.deepStrictEqual(labelAliases({ 1033: 'Open', 3082: 'Abierto' }), ['Open', 'Abierto']);
  assert.deepStrictEqual(labelAliases('   '), []);
  assert.deepStrictEqual(labelAliases(undefined), []);
});

test('a surface named in EITHER language resolves', () => {
  // `surfaces[]` is the machine-readable claim that a job is satisfied by these screens. On a
  // bilingual spec, naming the Spanish label is as legitimate as naming the English one — matching
  // only the resolved language would report a real surface as unresolved.
  const { resolveSurfaces } = require('../lib/surface-resolver.js');
  const mk = (surface) => {
    const s = base();
    s.entities[0].displayName = ES;
    s.entities[0].pluralName = { 1033: 'Project Baselines', 3082: 'Líneas base' };
    s.personas = [{ persona: 'Manager', jobs: [{ name: 'Manage', surfaces: [surface], privileges: [{ entity: 'contoso_projectbaseline', access: ['read'] }] }] }];
    return resolveSurfaces(s);
  };
  for (const name of ['Project Baseline', 'Línea base del proyecto', 'contoso_projectbaseline']) {
    const res = mk(name);
    const unresolved = (res.unresolved || res.filter?.((r) => !r.resolved) || []).length;
    assert.strictEqual(unresolved, 0, `'${name}' did not resolve: ${JSON.stringify(res).slice(0, 300)}`);
  }
});

// --- download round-trip --------------------------------------------------------------------------

const dvLabel = (pairs) => ({ LocalizedLabels: pairs.map(([LanguageCode, Label]) => ({ Label, LanguageCode })) });

test('labelFromDataverse returns a STRING for one language and a MAP for several', () => {
  // The asymmetry is deliberate: emitting { "1033": "Order" } for every single-language table would
  // change the shape of every spec this tool has ever written, and make every download diff noisy.
  assert.strictEqual(labelFromDataverse(dvLabel([[1033, 'Order']])), 'Order');
  assert.deepStrictEqual(labelFromDataverse(dvLabel([[1033, 'Order'], [3082, 'Pedido']])), { 1033: 'Order', 3082: 'Pedido' });
});

test('labelFromDataverse emits deterministic key order without needing a sort', () => {
  // V8 orders integer-like object keys ASCENDING regardless of insertion order, so two downloads of
  // the same table serialize identically with no sort step. Pinned because the alternative — a sort
  // that can never be shown to matter — reads as if it earned the guarantee.
  assert.strictEqual(JSON.stringify(labelFromDataverse(dvLabel([[3082, 'Pedido'], [1033, 'Order']]))), '{"1033":"Order","3082":"Pedido"}');
  assert.strictEqual(JSON.stringify(labelFromDataverse(dvLabel([[1033, 'Order'], [3082, 'Pedido']]))), '{"1033":"Order","3082":"Pedido"}');
});

test('labelAliases order follows ascending LCID, not the author write order', () => {
  // Pinned because `choiceFacts` collapses a multi-alias option to its FIRST alias, so the eval fact
  // it emits depends on this ordering being predictable.
  assert.deepStrictEqual(labelAliases({ 3082: 'Abierto', 1033: 'Open' }), ['Open', 'Abierto']);
});

test('labelFromDataverse returns undefined for nothing usable, so a caller can fall back', () => {
  for (const v of [undefined, null, 'Order', {}, dvLabel([]), { LocalizedLabels: [{ Label: '  ', LanguageCode: 1033 }] }]) {
    assert.strictEqual(labelFromDataverse(v), undefined, JSON.stringify(v));
  }
  // A row with a junk LanguageCode is skipped rather than keyed under NaN.
  assert.strictEqual(labelFromDataverse({ LocalizedLabels: [{ Label: 'x', LanguageCode: 'en-US' }] }), undefined);
});

test('entityFromMetadata round-trips a bilingual table, plural and column', () => {
  const meta = {
    logicalName: 'contoso_projectbaseline', schemaName: 'contoso_projectbaseline',
    displayName: 'Project Baseline', primaryNameAttribute: 'contoso_title',
    DisplayName: dvLabel([[1033, 'Project Baseline'], [3082, 'Línea base del proyecto']]),
    DisplayCollectionName: dvLabel([[1033, 'Project Baselines'], [3082, 'Líneas base del proyecto']]),
    attributes: [{ logicalName: 'contoso_note', schemaName: 'contoso_note', attributeType: 'String', isCustomAttribute: true, DisplayName: dvLabel([[1033, 'Note'], [3082, 'Nota']]) }],
  };
  const e = entityFromMetadata(meta, 'contoso_projectbaseline');
  assert.deepStrictEqual(e.displayName, { 1033: 'Project Baseline', 3082: 'Línea base del proyecto' });
  // The plural is emitted BECAUSE the display name is localized — validateAppSpec then requires it.
  assert.deepStrictEqual(e.pluralName, { 1033: 'Project Baselines', 3082: 'Líneas base del proyecto' });
  assert.deepStrictEqual(e.columns[0].displayName, { 1033: 'Note', 3082: 'Nota' });
});

test('a downloaded bilingual entity VALIDATES — the round trip closes', () => {
  // The whole point: download -> rebuild must not fail on its own output. Without the pluralName
  // emission above, this spec would be rejected by the localized-plural rule.
  const meta = {
    logicalName: 'contoso_projectbaseline', schemaName: 'contoso_projectbaseline',
    displayName: 'Project Baseline', primaryNameAttribute: 'contoso_title',
    DisplayName: dvLabel([[1033, 'Project Baseline'], [3082, 'Línea base del proyecto']]),
    DisplayCollectionName: dvLabel([[1033, 'Project Baselines'], [3082, 'Líneas base del proyecto']]),
    attributes: [],
  };
  const s = base();
  s.entities = [entityFromMetadata(meta, 'contoso_projectbaseline')];
  const r = validateAppSpec(s, { profile: 'plan', reconstructed: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('a single-language table still downloads as a plain string', () => {
  const meta = {
    logicalName: 'new_order', schemaName: 'new_order', displayName: 'Order', primaryNameAttribute: 'new_name',
    DisplayName: dvLabel([[1033, 'Order']]), DisplayCollectionName: dvLabel([[1033, 'Orders']]), attributes: [],
  };
  const e = entityFromMetadata(meta, 'new_order');
  assert.strictEqual(e.displayName, 'Order');
  // No plural is emitted for a plain label — it was never in the spec before and adding it would
  // change every existing download.
  assert.strictEqual('pluralName' in e, false, JSON.stringify(e));
});

test('a metadata read that returned no labels falls back to the SDK display name', () => {
  // The raw metadata read is best-effort (it is wrapped in a catch). Losing it must degrade to the
  // previous behaviour, not to an empty label.
  const e = entityFromMetadata({ logicalName: 'new_order', schemaName: 'new_order', displayName: 'Order', primaryNameAttribute: 'new_name', attributes: [] }, 'new_order');
  assert.strictEqual(e.displayName, 'Order');
});

// --- the regression LIVE testing caught that the unit tests above did not --------------------------

test('an EMPTY Dataverse Label never emits the raw object as a column displayName', () => {
  // FOUND BY RUNNING A REAL DOWNLOAD, not by review. A synthetic lookup `*name` column carries
  // EXACTLY this shape — measured on a live org for cfo_customeridname / cfo_billtoname:
  //
  //     {"LocalizedLabels":[],"UserLocalizedLabel":null}
  //
  // Merging the raw `DisplayName` into the attribute list (which this change does, to carry every
  // language) made that object reachable by the pre-existing `|| a.DisplayName` fallback, so the
  // download emitted it verbatim and the spec failed its OWN validation with
  // "'LocalizedLabels' is not an LCID". A download that cannot write a valid spec is worse than one
  // that loses a label, so this is the load-bearing case.
  const EMPTY = { LocalizedLabels: [], UserLocalizedLabel: null };
  assert.strictEqual(labelFromDataverse(EMPTY), undefined);
  assert.strictEqual(columnDisplayName({ logicalName: 'cfo_customeridname', DisplayName: EMPTY }), undefined,
    'an unlabelled column must be OMITTED, not labelled with the raw Label object');

  const e = entityFromMetadata({
    logicalName: 'cfo_workorder', schemaName: 'cfo_workorder', displayName: 'Work Order', primaryNameAttribute: 'cfo_title',
    attributes: [
      { logicalName: 'cfo_customeridname', schemaName: 'cfo_customeridname', attributeType: 'String', isCustomAttribute: true, DisplayName: EMPTY },
      { logicalName: 'cfo_title2', schemaName: 'cfo_title2', attributeType: 'String', isCustomAttribute: true, displayName: 'Title 2', DisplayName: EMPTY },
    ],
  }, 'cfo_workorder');
  const unlabelled = e.columns.find((c) => c.schemaName === 'cfo_customeridname');
  assert.strictEqual('displayName' in unlabelled, false, JSON.stringify(unlabelled));
  // ...but the SDK's own flattened string is still used when it has one.
  assert.strictEqual(e.columns.find((c) => c.schemaName === 'cfo_title2').displayName, 'Title 2');

  // And the whole spec must validate — the property the live run actually broke.
  const s = base();
  s.entities = [e];
  const r = validateAppSpec(s, { profile: 'plan', reconstructed: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('columnDisplayName never returns a raw Label object for any shape', () => {
  // Exhaustive over the shapes a live metadata read can produce, because ONE leak fails the download.
  const shapes = [
    { DisplayName: { LocalizedLabels: [], UserLocalizedLabel: null } },
    { DisplayName: { LocalizedLabels: [{ Label: '   ', LanguageCode: 1033 }] } },
    { DisplayName: { LocalizedLabels: [{ Label: 'x', LanguageCode: 'en-US' }] } },
    { DisplayName: {} },
    { DisplayName: null },
    {},
    { displayName: '', DisplayName: { LocalizedLabels: [] } },
    { displayName: '   ', DisplayName: { LocalizedLabels: [] } },
  ];
  for (const a of shapes) {
    const got = columnDisplayName(a);
    assert.ok(got === undefined || typeof got === 'string' || isLocalizedLabelMap(got), `${JSON.stringify(a)} -> ${JSON.stringify(got)}`);
    if (isLocalizedLabelMap(got)) assert.deepStrictEqual(localizedLabelLcids(got).length > 0, true);
  }
  // A UserLocalizedLabel with no LocalizedLabels is still a real label and must survive.
  assert.strictEqual(columnDisplayName({ DisplayName: { LocalizedLabels: [], UserLocalizedLabel: { Label: 'Owner', LanguageCode: 1033 } } }), 'Owner');
});

// --- the unprovisioned-language guard -------------------------------------------------------------
//
// THE most important test in this file. LIVE-MEASURED against a 1033-only organization: `createTable`
// carrying `DisplayName: { 1033, 3082 }` returns SUCCESS and stores ONLY the 1033 label. Dataverse
// does not warn, error or report the drop anywhere. Without this guard the feature would recreate the
// exact bug it was built to fix — a green build with the request silently gone.

test('a localized label naming an UNPROVISIONED language HALTS before any write', async () => {
  const { provisionDataModel, BuildHalt } = require('../lib/entity-provision.js');
  const writes = [];
  const s = base();
  s.entities[0].displayName = ES;              // asks for 3082
  s.entities[0].pluralName = { 1033: 'Project Baselines', 3082: 'Líneas base' };
  const sdk = { createTable: async (o) => { writes.push(o); return { logicalName: 'x', entitySetName: 'xs' }; } };
  const runner = { run: async (p, l, fn) => fn(), skip: () => {}, mapLimit: async (i, n, fn) => Promise.all(i.map(fn)) };
  await assert.rejects(
    () => provisionDataModel({
      spec: s, sdk, provision: { findTables: async () => [], findColumns: async () => [], queryRecords: async () => [] },
      runner, preResolvedLanguageCode: 1033, provisionedLanguages: async () => [1033],
    }),
    (err) => {
      assert.ok(err instanceof BuildHalt, `expected a BuildHalt, got ${err && err.name}`);
      assert.strictEqual(err.code, 'localized-label-language-not-provisioned');
      assert.match(err.message, /3082 \(first used by entity contoso_projectbaseline displayName\)/, err.message);
      // The message must state WHY silence is the danger, or the reader assumes a warning would suffice.
      assert.match(err.message, /silently store only the provisioned one/);
      assert.match(err.message, /Provisioned languages: 1033/);
      return true;
    },
  );
  // BEFORE any write, not as a post-hoc verify: a partial data model is the outcome being avoided.
  assert.deepStrictEqual(writes, [], 'the build wrote a table before checking the label languages');
});

test('the guard names EVERY unprovisioned language, sorted, with where each came from', async () => {
  const { localizedLabelLcidsInSpec, checkLocalizedLabelLanguages } = require('../lib/entity-provision.js');
  const s = base();
  s.entities[0].displayName = { 1033: 'Baseline', 3082: 'Línea base' };
  s.entities[0].pluralName = { 1033: 'Baselines', 1031: 'Basislinien' };
  s.entities[0].columns = [
    // A column DISPLAY NAME and a Choice OPTION carry different unprovisioned LCIDs, so a guard that
    // walks only one of the two is caught. (1040 = it-IT on the column, 1036 = fr-FR on the option.)
    { schemaName: 'contoso_note', type: 'Text', displayName: { 1033: 'Note', 1040: 'Nota' } },
    { schemaName: 'contoso_status', type: 'Choice', options: [{ 1033: 'Open', 1036: 'Ouvert' }] },
  ];
  s.entities[0].alternateKeys = [{ schemaName: 'contoso_key', columns: ['contoso_title'], displayName: { 1033: 'Key', 1043: 'Sleutel' } }];
  s.entities.push({ schemaName: 'contoso_project', displayName: 'Project', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] });
  s.relationships = [{ type: 'OneToMany', referenced: 'contoso_project', referencing: 'contoso_projectbaseline', lookup: { schemaName: 'contoso_projectid', displayName: { 1033: 'Project', 1053: 'Projekt' } } }];
  s.globalChoices = [{ name: 'contoso_p', displayName: { 1033: 'P', 3082: 'P' }, options: [{ 1033: 'High', 1045: 'Wysoki' }] }];
  // Every authorable label site must be walked, or a spec passes the guard and still loses a language.
  assert.deepStrictEqual(localizedLabelLcidsInSpec(s).map((w) => w.lcid), [1031, 1033, 1036, 1040, 1043, 1045, 1053, 3082]);
  await assert.rejects(
    () => checkLocalizedLabelLanguages(s, async () => [1033]),
    (err) => {
      for (const lcid of [1031, 1036, 1040, 1043, 1045, 1053, 3082]) assert.match(err.message, new RegExp(String(lcid)), `${lcid} missing from: ${err.message}`);
      assert.match(err.message, /1031 \(first used by entity contoso_projectbaseline pluralName\)/);
      assert.match(err.message, /1036 \(first used by entity contoso_projectbaseline column contoso_status option\)/);
      assert.match(err.message, /1040 \(first used by entity contoso_projectbaseline column contoso_note displayName\)/);
      assert.match(err.message, /1043 \(first used by entity contoso_projectbaseline alternate key contoso_key\)/);
      assert.match(err.message, /1045 \(first used by globalChoice contoso_p option\)/);
      assert.match(err.message, /1053 \(first used by relationship lookup contoso_projectid\)/);
      return true;
    },
  );
});

test('the guard passes when every requested language IS provisioned', async () => {
  const { checkLocalizedLabelLanguages } = require('../lib/entity-provision.js');
  const s = base();
  s.entities[0].displayName = ES;
  s.entities[0].pluralName = { 1033: 'Baselines', 3082: 'Líneas base' };
  await checkLocalizedLabelLanguages(s, async () => [1033, 3082]); // must not throw
});

test('the guard is best-effort: an unreadable probe leaves the build unchanged', async () => {
  // Identical policy to the existing `checkProvisioned`: a diagnostic that cannot answer must never
  // block work that would otherwise succeed.
  const { checkLocalizedLabelLanguages } = require('../lib/entity-provision.js');
  const s = base();
  s.entities[0].displayName = ES;
  s.entities[0].pluralName = { 1033: 'Baselines', 3082: 'Líneas base' };
  for (const probe of [undefined, async () => { throw new Error('403'); }, async () => [], async () => null]) {
    await checkLocalizedLabelLanguages(s, probe); // must not throw
  }
});

test('the guard costs nothing for a spec with only plain labels', async () => {
  // No localized labels -> the probe is never even called, so an all-string spec pays no round trip.
  const { checkLocalizedLabelLanguages } = require('../lib/entity-provision.js');
  let called = 0;
  await checkLocalizedLabelLanguages(base(), async () => { called += 1; return [1033]; });
  assert.strictEqual(called, 0);
});

test('the localized label reaches the SDK UNFLATTENED', async () => {
  // The plugin must not pre-flatten: the SDK's serializer is what turns a map into a multi-entry
  // LocalizedLabels array. Flattening here would silently restore the English-only behaviour while
  // every validation and document still claimed two languages.
  const { provisionDataModel } = require('../lib/entity-provision.js');
  const calls = [];
  const s = base();
  s.entities[0].displayName = ES;
  s.entities[0].pluralName = { 1033: 'Project Baselines', 3082: 'Líneas base' };
  s.entities[0].primaryAttribute.displayName = { 1033: 'Title', 3082: 'Título' };
  const sdk = {
    createTable: async (o) => { calls.push(o); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s` }; },
    createColumn: async (e, o) => ({ logicalName: o.schemaName.toLowerCase() }),
    updateTable: async () => undefined,
  };
  const provision = {
    findTables: async () => [],
    findColumns: async () => [],
    fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, relationships: [] }),
    queryRecords: async () => [],
  };
  const runner = {
    run: async (phase, label, fn, o = {}) => { try { return await fn(); } catch (err) { if (o.skipIf && o.skipIf(err)) return undefined; throw err; } },
    skip: () => {},
    mapLimit: async (items, _n, fn) => { const out = []; for (const it of items) out.push(await fn(it)); return out; },
  };
  await provisionDataModel({ spec: s, sdk, provision, runner, preResolvedLanguageCode: 1033 });
  const t = calls[0];
  assert.ok(t, 'createTable was never called');
  assert.deepStrictEqual(t.displayName, ES, 'displayName was flattened before reaching the SDK');
  assert.deepStrictEqual(t.pluralName, { 1033: 'Project Baselines', 3082: 'Líneas base' });
  assert.deepStrictEqual(t.primaryColumnDisplayName, { 1033: 'Title', 3082: 'Título' });
});

test('a localized COLUMN, lookup, alternate key and Choice label all reach the SDK unflattened', async () => {
  const { provisionDataModel } = require('../lib/entity-provision.js');
  const seen = { column: null, relationship: null, key: null, choice: null };
  const s = base();
  s.entities[0].columns = [{ schemaName: 'contoso_note', type: 'Text', displayName: { 1033: 'Note', 3082: 'Nota' } }];
  s.entities[0].alternateKeys = [{ schemaName: 'contoso_key', columns: ['contoso_title'], displayName: { 1033: 'Key', 3082: 'Clave' } }];
  s.entities.push({ schemaName: 'contoso_project', displayName: 'Project', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] });
  s.relationships = [{ type: 'OneToMany', referenced: 'contoso_project', referencing: 'contoso_projectbaseline', lookup: { schemaName: 'contoso_projectid', displayName: { 1033: 'Project', 3082: 'Proyecto' } } }];
  s.globalChoices = [{ name: 'contoso_priority', displayName: { 1033: 'Priority', 3082: 'Prioridad' }, options: [{ 1033: 'High', 3082: 'Alta' }] }];
  const sdk = {
    createTable: async (o) => ({ logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s` }),
    createColumn: async (e, o) => { if (o.schemaName === 'contoso_note') seen.column = o; return { logicalName: o.schemaName.toLowerCase() }; },
    createRelationship: async (o) => { seen.relationship = o; return { schemaName: o.schemaName }; },
    createAlternateKey: async (e, o) => { seen.key = o; return { logicalName: o.schemaName.toLowerCase() }; },
    createGlobalOptionSet: async (o) => { seen.choice = o; return { name: o.name, metadataId: 'gc-1' }; },
    updateTable: async () => undefined,
  };
  const provision = {
    findTables: async () => [],
    findColumns: async () => [],
    fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, relationships: [] }),
    queryRecords: async () => [],
  };
  const runner = {
    run: async (phase, label, fn, o = {}) => { try { return await fn(); } catch (err) { if (o.skipIf && o.skipIf(err)) return undefined; throw err; } },
    skip: () => {},
    mapLimit: async (items, _n, fn) => { const out = []; for (const it of items) out.push(await fn(it)); return out; },
  };
  await provisionDataModel({ spec: s, sdk, provision, runner, preResolvedLanguageCode: 1033 });
  assert.deepStrictEqual(seen.column && seen.column.displayName, { 1033: 'Note', 3082: 'Nota' }, JSON.stringify(seen.column));
  assert.deepStrictEqual(seen.relationship && seen.relationship.lookupDisplayName, { 1033: 'Project', 3082: 'Proyecto' }, JSON.stringify(seen.relationship));
  assert.deepStrictEqual(seen.key && seen.key.displayName, { 1033: 'Key', 3082: 'Clave' }, JSON.stringify(seen.key));
  assert.deepStrictEqual(seen.choice && seen.choice.displayName, { 1033: 'Priority', 3082: 'Prioridad' }, JSON.stringify(seen.choice));
  assert.deepStrictEqual(seen.choice && seen.choice.options, [{ value: 100000000, label: { 1033: 'High', 3082: 'Alta' } }], JSON.stringify(seen.choice));
});
// --- the poisoning-read hazard: the probe must never be resolved by a broad read ------------------
//
// The rest of this class of test lives in bpf-security-roles.test.js (the narrow-probe tests landed
// there while that file was the active workspace). They belong together; see
// "the table existence probe is a NARROW metadata read" there.

test('an INCONCLUSIVE existence probe HALTS a localized table rather than falling back', async () => {
  // `findTables` can safely prove PRESENCE, but a MISS is followed immediately by `createTable` --
  // with the poisoning read already on the wire. So for a localized entity an unresolved probe must
  // stop the build, not be answered by the very read that loses the label. Fail-closed for the same
  // reason as the unprovisioned-language halt: once the table exists, a lost label is a manual fix.
  const { provisionDataModel } = require('../lib/entity-provision.js');
  let findTablesCalled = 0;
  const args = (displayName) => ({
    spec: {
      solution: { uniqueName: 'c', publisherPrefix: 'c' },
      languageCode: 1033,
      entities: [{ schemaName: 'c_t', displayName, pluralName: displayName, primaryAttribute: { schemaName: 'c_n' }, columns: [] }],
      relationships: [],
    },
    sdk: { createTable: async () => ({ logicalName: 'c_t', entitySetName: 'c_ts' }), updateTable: async () => undefined, updateColumn: async () => undefined },
    provision: {
      dataverse: { get: async () => ({ status: 503, headers: {}, body: {} }) },
      findTables: async () => { findTablesCalled += 1; return []; },
      findColumns: async () => [],
      fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: 'c_ts', relationships: [] }),
      queryRecords: async () => [],
    },
    runner: {
      run: async (ph, l, fn, o = {}) => { try { return await fn(); } catch (e) { if (o.skipIf && o.skipIf(e)) return undefined; throw e; } },
      skip: () => {},
      mapLimit: async (items, _n, fn) => { const out = []; for (const it of items) out.push(await fn(it)); return out; },
    },
    warn: () => {},
    preResolvedLanguageCode: 1033,
  });

  await assert.rejects(
    () => provisionDataModel(args({ 1033: 'Table', 3082: 'Tabla' })),
    (err) => err.code === 'table-probe-inconclusive' && /localized/.test(err.message),
    'a localized entity must halt on an unresolved probe');
  assert.strictEqual(findTablesCalled, 0, 'and it must NOT have issued the poisoning read to get there');

  // The halt must name a REAL phase. `stages.js` is the single source of truth for the 16 phase
  // names, and a halt tagged with one that is not in it makes the error report and the logs
  // disagree with every other halt in the file — which both use `data-model`.
  const { PHASES } = require('../lib/stages.js');
  let halted;
  await provisionDataModel(args({ 1033: 'Table', 3082: 'Tabla' })).catch((e) => { halted = e; });
  assert.ok(PHASES.includes(halted.phase), `phase '${halted.phase}' is not one of ${JSON.stringify(PHASES)}`);
  assert.strictEqual(halted.phase, 'data-model');

  // The counterfactual: a PLAIN label has nothing to lose, so the old fallback still applies and the
  // build proceeds. Tightening this path too would fail builds that are entirely correct.
  await provisionDataModel(args('Table'));
  assert.strictEqual(findTablesCalled, 1, 'a plain-label entity still falls back rather than halting');
});
