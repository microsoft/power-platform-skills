'use strict';
// Data-model provisioning fact extractor — the DATA-stage analogue of wire-facts.js. wire-facts
// normalizes the SERIALIZED wire payloads for forms/views/charts/sitemap (wire-facts.js:34-99);
// schema-facts normalizes the data model the engine PROVISIONS (createGlobalOptionSet / createTable /
// createColumn / createRelationship — entity-provision.js:167-291) into stable, comparable facts the
// offline eval harness diffs per build. Pure (no I/O, no SDK): it derives everything deterministically
// from the App Spec, reusing the SAME naming/value rules the engine uses, so a fact equals what WOULD
// be provisioned — not a naive spec echo. See docs/app-builder-design.md §13.2, §14.
const { columnTypeMap, choiceValueMap, relationshipSchemaName, manyToManySchemaName, quickCreateEnabledFor, labelText } = require('./app-spec.js');

const lc = (s) => String(s || '').toLowerCase();
const byKey = (k) => (a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0);

// A column the engine actually creates. Every App Spec type maps to a Dataverse attribute EXCEPT
// `Lookup` (columnTypeMap('Lookup').dv === null — lookups come from relationships[], not columns).
// `Customer` maps to dv:'lookup' and IS buildable (createCustomerColumn). This is the exact set
// entity-provision.js builds (entity-provision.js:212) and planFor plans (sdk-build.js:250).
function isBuildableColumn(c) {
  return columnTypeMap(c && c.type).dv !== null;
}

// Choice/MultiChoice { value, label } pairs via the engine's shared rule (value = 100000000 + index;
// inline options AND globalChoice refs) so the fact carries the exact values the build assigns
// (app-spec.js choiceValueMap). Sorted by value (its natural, stable order).
//
// `choiceValueMap` indexes a LOCALIZED option under every language it declares (so sample data in
// either language resolves), which means several keys can share one value. An eval fact must carry
// ONE label per value, so collapse to the LOWEST-LCID alias — V8 enumerates integer-like keys
// ascending, so that is the deterministic choice, not the author's write order.
function choiceFacts(entity, spec, columnLogical) {
  const map = choiceValueMap(entity, spec)[columnLogical];
  if (!map) return undefined;
  const byValue = new Map();
  for (const [label, value] of Object.entries(map)) if (!byValue.has(value)) byValue.set(value, label);
  return [...byValue.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.value - b.value);
}

function tableFacts(spec, e) {
  const primary = e.primaryAttribute || {};
  const columns = (e.columns || []).filter(isBuildableColumn).map((c) => {
    const columnLogical = lc(c.schemaName);
    const fact = { logicalName: columnLogical, type: c.type || 'Text', required: c.required === true };
    const choices = (c.type === 'Choice' || c.type === 'MultiChoice') ? choiceFacts(e, spec, columnLogical) : undefined;
    if (choices) fact.choices = choices;
    return fact;
  }).sort(byKey('logicalName'));
  return {
    logicalName: lc(e.schemaName),
    displayName: labelText(e.displayName, spec && spec.languageCode) || '',
    hasNotes: e.hasNotes === true,
    // Whether the build enables "Allow quick create" (IsQuickCreateEnabled) on this table — the EXACT
    // engine rule (explicit entities[].quickCreate OR an authored QuickCreate form), so the eval grades
    // provisioned intent, not a naive spec echo. See entity-provision.js updateTable step.
    quickCreate: quickCreateEnabledFor(spec, e),
    primary: { logicalName: lc(primary.schemaName), displayName: labelText(primary.displayName, spec && spec.languageCode) || '', autoNumber: !!primary.autoNumberFormat },
    columns,
    statusReasons: (e.statusReasons || []).map((sr) => ({ label: sr.label, state: sr.state || 'Active' })).sort(byKey('label')),
    alternateKeys: (e.alternateKeys || []).map((k) => ({ logicalName: lc(k.schemaName), columns: (k.columns || []).map(lc).sort() })).sort(byKey('logicalName')),
  };
}

function relationshipFacts(spec) {
  const prefix = spec.solution && spec.solution.publisherPrefix;
  const rels = [];
  for (const r of spec.relationships || []) {
    if (r.type === 'OneToMany') {
      rels.push({ kind: '1:n', schemaName: lc(relationshipSchemaName(r, prefix)), referenced: lc(r.referenced), referencing: lc(r.referencing),
        lookup: { logicalName: lc(r.lookup && r.lookup.schemaName), displayName: labelText(r.lookup && r.lookup.displayName, spec && spec.languageCode) || '' } });
    } else if (r.type === 'ManyToMany') {
      const fact = { kind: 'n:n', schemaName: lc(manyToManySchemaName(r, prefix)), entity1: lc(r.entity1), entity2: lc(r.entity2) };
      if (r.intersectEntityName) fact.intersect = lc(r.intersectEntityName);
      rels.push(fact);
    }
  }
  return rels.sort(byKey('schemaName'));
}

// The full normalized data-model fact set (stable order, lowercased identities). Deep-equal two of
// these to prove two builds provision the SAME data model — the DATA-stage eval oracle.
function schemaFacts(spec) {
  const s = spec || {};
  return {
    globalChoices: (s.globalChoices || []).map((g) => ({ name: lc(g.name), options: (g.options || []).map((label, i) => ({ value: 100000000 + i, label: labelText(label, s.languageCode) || '' })) })).sort(byKey('name')),
    tables: (s.entities || []).map((e) => tableFacts(s, e)).sort(byKey('logicalName')),
    relationships: relationshipFacts(s),
  };
}

module.exports = { schemaFacts, isBuildableColumn };
