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
  for (const e of spec.entities || []) {
    if (!e.schemaName) {
      errors.push('entity.schemaName is required');
    } else {
      entityNames.add(e.schemaName);
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
};
