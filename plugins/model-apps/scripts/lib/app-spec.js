// App Spec schema + validator. The App Spec is the reviewable contract between
// the model-app-maker's LLM proposal and the deterministic builder.

// App Spec column type -> { dv: add-column.js type, kernel: blankForm field type }.
const TYPE_MAP = {
  Text: { dv: 'string', kernel: 'string' },
  Memo: { dv: 'memo', kernel: 'memo' },
  Choice: { dv: 'picklist', kernel: 'picklist' },
  Boolean: { dv: 'boolean', kernel: 'boolean' },
  Money: { dv: 'money', kernel: 'money' },
  DateTime: { dv: 'datetime', kernel: 'datetime' },
  Integer: { dv: 'integer', kernel: 'integer' },
  Decimal: { dv: 'decimal', kernel: 'decimal' },
  Lookup: { dv: null, kernel: 'lookup' }, // lookups come from relationships, not add-column
};

function columnTypeMap(t) {
  return TYPE_MAP[t] || TYPE_MAP.Text;
}

// Map a Choice column's option LABELS to the integer values the builder assigns
// (add-column.js is called with value = 100000000 + index, see build-steps.js).
// { columnLogicalName: { "Active": 100000001, ... } }.
function choiceValueMap(entity) {
  const map = {};
  for (const c of entity.columns || []) {
    if (c.type === 'Choice' && Array.isArray(c.options)) {
      const byLabel = {};
      c.options.forEach((label, i) => {
        byLabel[label] = 100000000 + i;
      });
      map[c.schemaName.toLowerCase()] = byLabel;
    }
  }
  return map;
}

// The sample records declared for an entity (keyed by schemaName, case-insensitive).
function sampleRecordsFor(spec, entity) {
  const sd = spec.sampleData || {};
  const key = Object.keys(sd).find((k) => k.toLowerCase() === entity.schemaName.toLowerCase());
  return (key && Array.isArray(sd[key]) && sd[key]) || [];
}

// Valid chart types (kernel buildChart ChartType values).
const CHART_TYPES = ['Column', 'Bar', 'Pie', 'Line'];

// Find the OneToMany relationship in the spec whose `referenced` = parentEntity and
// `referencing` = childEntity (case-insensitive on both schema names). Returns the
// relationship object (its `lookup.schemaName` is the @odata.bind nav-property; the
// sub-grid RelationshipName is relationshipSchemaName(rel)), or null when none exists.
function relationshipFor(spec, parentEntity, childEntity) {
  const p = String(parentEntity || '').toLowerCase();
  const c = String(childEntity || '').toLowerCase();
  return (
    (spec.relationships || []).find(
      (r) =>
        r.type === 'OneToMany' &&
        String(r.referenced || '').toLowerCase() === p &&
        String(r.referencing || '').toLowerCase() === c
    ) || null
  );
}

// The 1:N relationship's SCHEMA name (used for create-relationship.js and the
// sub-grid RelationshipName). This MUST be distinct from the lookup attribute's
// schema name — Dataverse rejects a relationship whose name collides with the
// lookup column on the referencing table. Defaults to `<referenced>_<referencing>`
// (both already publisher-prefixed), or an explicit `rel.schemaName` when provided.
function relationshipSchemaName(rel) {
  if (rel && rel.schemaName) {
    return rel.schemaName;
  }
  return `${String(rel.referenced || '').toLowerCase()}_${String(rel.referencing || '').toLowerCase()}`;
}

// Turn author-friendly sample records into Web-API bodies: Choice values written
// as labels ("Active") are resolved to their option ints; everything else passes
// through unchanged (so raw ints, strings, booleans, ISO dates all still work).
function resolveSampleRecords(entity, records) {
  const choices = choiceValueMap(entity);
  return (records || []).map((rec) => {
    const out = {};
    for (const [k, v] of Object.entries(rec)) {
      const labels = choices[k.toLowerCase()];
      out[k] = labels && typeof v === 'string' && labels[v] !== undefined ? labels[v] : v;
    }
    return out;
  });
}

function validateAppSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') {
    return { ok: false, errors: ['spec is not an object'] };
  }
  if (!spec.solution || !spec.solution.uniqueName) {
    errors.push('solution.uniqueName is required');
  }
  if (!spec.solution || !spec.solution.publisherPrefix) {
    errors.push('solution.publisherPrefix is required');
  }
  if (!spec.app || !spec.app.name) {
    errors.push('app.name is required');
  }
  const entityNames = new Set();
  const entityByLower = new Map(); // logical (lowercased schemaName) -> entity
  for (const e of spec.entities || []) {
    if (!e.schemaName) {
      errors.push('entity.schemaName is required');
    } else {
      entityNames.add(e.schemaName);
      entityByLower.set(e.schemaName.toLowerCase(), e);
    }
    if (!e.primaryAttribute || !e.primaryAttribute.schemaName) {
      errors.push(`entity ${e.schemaName}: primaryAttribute.schemaName required`);
    }
    for (const c of e.columns || []) {
      if (!c.schemaName) {
        errors.push(`entity ${e.schemaName}: a column is missing schemaName`);
      }
      if (c.type && !TYPE_MAP[c.type]) {
        errors.push(`entity ${e.schemaName}: column ${c.schemaName} has unknown type '${c.type}'`);
      }
      if (c.type === 'Choice' && (!Array.isArray(c.options) || !c.options.length)) {
        errors.push(`column ${c.schemaName}: Choice needs options[]`);
      }
    }
  }
  if (!entityNames.size) {
    errors.push('at least one entity is required');
  }
  for (const f of spec.forms || []) {
    if (!entityNames.has(f.entity)) {
      errors.push(`form references unknown entity '${f.entity}'`);
    }
    if (f.layout !== undefined && f.layout !== 'auto' && f.layout !== 'explicit') {
      errors.push(`form ${f.entity}: layout must be 'auto' or 'explicit'`);
    }
    if (f.subgrids !== undefined) {
      if (!Array.isArray(f.subgrids)) {
        errors.push(`form ${f.entity}: subgrids must be an array`);
      } else {
        for (const sg of f.subgrids) {
          if (!sg || !sg.childEntity) {
            errors.push(`form ${f.entity}: a subgrid is missing childEntity`);
            continue;
          }
          if (!entityByLower.has(String(sg.childEntity).toLowerCase())) {
            errors.push(`form ${f.entity}: subgrid references unknown childEntity '${sg.childEntity}'`);
            continue;
          }
          if (!relationshipFor(spec, f.entity, sg.childEntity)) {
            errors.push(
              `form ${f.entity}: no OneToMany relationship from '${f.entity}' to subgrid childEntity '${sg.childEntity}'`
            );
          }
        }
      }
    }
  }
  for (const ch of spec.charts || []) {
    if (!ch || !ch.entity || !entityByLower.has(String(ch.entity).toLowerCase())) {
      errors.push(`chart references unknown entity '${ch && ch.entity}'`);
      continue;
    }
    if (!ch.name) {
      errors.push(`chart on '${ch.entity}': name is required`);
    }
    if (!CHART_TYPES.includes(ch.chartType)) {
      errors.push(`chart '${ch.name || ch.entity}': chartType must be one of ${CHART_TYPES.join('|')}`);
    }
    const entity = entityByLower.get(String(ch.entity).toLowerCase());
    const choiceCol =
      entity &&
      (entity.columns || []).find(
        (c) => c.type === 'Choice' && c.schemaName.toLowerCase() === String(ch.groupBy || '').toLowerCase()
      );
    if (!choiceCol) {
      errors.push(`chart '${ch.name || ch.entity}': groupBy '${ch.groupBy}' is not a Choice column on '${ch.entity}'`);
    }
  }
  for (const v of spec.views || []) {
    if (!entityNames.has(v.entity)) {
      errors.push(`view references unknown entity '${v.entity}'`);
    }
  }
  for (const a of (spec.appShell && spec.appShell.areas) || []) {
    for (const g of a.groups || []) {
      for (const sa of g.subAreas || []) {
        if (sa.entity && !entityNames.has(sa.entity)) {
          errors.push(`sitemap subArea references unknown entity '${sa.entity}'`);
        }
      }
    }
  }
  if (spec.sampleData !== undefined) {
    if (typeof spec.sampleData !== 'object' || spec.sampleData === null || Array.isArray(spec.sampleData)) {
      errors.push('sampleData must be an object keyed by entity schemaName');
    } else {
      const lower = new Set([...entityNames].map((n) => n.toLowerCase()));
      for (const [k, v] of Object.entries(spec.sampleData)) {
        if (!lower.has(k.toLowerCase())) {
          errors.push(`sampleData references unknown entity '${k}'`);
        }
        if (!Array.isArray(v)) {
          errors.push(`sampleData['${k}'] must be an array of records`);
          continue;
        }
        for (const rec of v) {
          if (!rec || rec.$parent === undefined) {
            continue;
          }
          const p = rec.$parent;
          if (!p || typeof p !== 'object' || !p.entity || !lower.has(String(p.entity).toLowerCase())) {
            errors.push(`sampleData['${k}']: $parent.entity '${p && p.entity}' is unknown`);
            continue;
          }
          if (!p.match || typeof p.match !== 'object' || !Object.keys(p.match).length) {
            errors.push(`sampleData['${k}']: $parent.match must be a non-empty object`);
            continue;
          }
          if (!relationshipFor(spec, p.entity, k)) {
            errors.push(`sampleData['${k}']: no OneToMany relationship from $parent '${p.entity}' to '${k}'`);
          }
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  validateAppSpec,
  columnTypeMap,
  TYPE_MAP,
  choiceValueMap,
  sampleRecordsFor,
  resolveSampleRecords,
  relationshipFor,
  relationshipSchemaName,
  CHART_TYPES,
};
