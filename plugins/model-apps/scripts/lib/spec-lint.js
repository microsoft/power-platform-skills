// plugins/model-apps/scripts/lib/spec-lint.js
// Pure App Spec guardrail. Returns { ok, errors, warnings }. errors block the plan
// gate; warnings teach. Bakes in the modeling lessons hit live — notably the
// relationship schema-name vs lookup-name collision Dataverse rejects.
const { relationshipSchemaName } = require('./app-spec.js');

const CHOICE_OPTION_WARN = 12;

function lintAppSpec(spec) {
  const errors = [];
  const warnings = [];
  const E = (m) => errors.push(m);
  const W = (m) => warnings.push(m);
  const lc = (s) => String(s || '').toLowerCase();

  const prefix = spec.solution && spec.solution.publisherPrefix;
  const entityNames = new Set();

  for (const e of spec.entities || []) {
    const key = lc(e.schemaName);
    if (entityNames.has(key)) E(`Duplicate entity schemaName: ${e.schemaName}`);
    entityNames.add(key);

    if (prefix && e.schemaName && !lc(e.schemaName).startsWith(lc(prefix) + '_')) {
      W(`Entity ${e.schemaName} does not use the solution prefix '${prefix}_'`);
    }
    if (!e.primaryAttribute || !e.primaryAttribute.schemaName || !e.primaryAttribute.displayName) {
      E(`Entity ${e.schemaName} is missing a primaryAttribute (schemaName + displayName)`);
    }

    const cols = new Set();
    for (const c of e.columns || []) {
      const ck = lc(c.schemaName);
      if (cols.has(ck)) E(`Entity ${e.schemaName} has a duplicate column ${c.schemaName}`);
      cols.add(ck);
      if (c.type === 'Choice') {
        if (!(c.options && c.options.length)) E(`Choice column ${e.schemaName}.${c.schemaName} needs options[]`);
        else if (c.options.length > CHOICE_OPTION_WARN) {
          W(`Column ${e.schemaName}.${c.schemaName} has ${c.options.length} Choice options — consider a lookup table`);
        }
      }
    }
  }

  for (const r of spec.relationships || []) {
    if (r.type !== 'OneToMany') continue;
    if (!entityNames.has(lc(r.referenced))) E(`Relationship references unknown entity '${r.referenced}'`);
    if (!entityNames.has(lc(r.referencing))) E(`Relationship references unknown entity '${r.referencing}'`);
    if (!r.lookup || !r.lookup.schemaName) {
      E(`OneToMany ${r.referenced}->${r.referencing} is missing lookup.schemaName`);
      continue;
    }
    if (lc(relationshipSchemaName(r)) === lc(r.lookup.schemaName)) {
      E(`Relationship schema name '${relationshipSchemaName(r)}' collides with its lookup attribute name '${r.lookup.schemaName}' — Dataverse rejects this; use a distinct relationship name`);
    }
  }

  for (const f of spec.forms || []) {
    for (const sg of f.subgrids || []) {
      const ok = (spec.relationships || []).some(
        (r) => r.type === 'OneToMany' && lc(r.referenced) === lc(f.entity) && lc(r.referencing) === lc(sg.childEntity)
      );
      if (!ok) E(`Form ${f.entity} sub-grid for ${sg.childEntity} has no matching OneToMany relationship`);
    }
  }

  for (const ch of spec.charts || []) {
    const ent = (spec.entities || []).find((e) => lc(e.schemaName) === lc(ch.entity));
    if (!ent) { E(`Chart '${ch.name}' references unknown entity '${ch.entity}'`); continue; }
    const col = (ent.columns || []).find((c) => lc(c.schemaName) === lc(ch.groupBy));
    if (!col) W(`Chart '${ch.name}' groups by '${ch.groupBy}', which isn't a column on ${ch.entity}`);
    else if (col.type !== 'Choice') W(`Chart '${ch.name}' groups by a non-Choice column '${ch.groupBy}' — Choice columns chart best`);
  }

  dupWarn((spec.views || []).map((v) => v.name), 'view', W);
  dupWarn((spec.charts || []).map((c) => c.name), 'chart', W);
  dupWarn((spec.forms || []).map((f) => f.name).filter(Boolean), 'form', W);

  return { ok: errors.length === 0, errors, warnings };
}

function dupWarn(names, kind, W) {
  const seen = new Set();
  for (const n of names) {
    const k = String(n || '').toLowerCase();
    if (k && seen.has(k)) W(`Duplicate ${kind} name: ${n}`);
    seen.add(k);
  }
}

module.exports = { lintAppSpec };
