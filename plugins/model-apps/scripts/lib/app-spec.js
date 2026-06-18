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
  return { ok: errors.length === 0, errors };
}

module.exports = { validateAppSpec, columnTypeMap, TYPE_MAP };
