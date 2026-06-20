// Order the entities so that any entity referenced by a OneToMany relationship is
// inserted before the entity that references it (parents before children). A simple
// Kahn topological sort over the relationship edges; entities not in any relationship
// keep their declared order. Cycles (shouldn't happen for 1:N hierarchies) fall back
// to declared order for the unresolved tail.
function topoOrderEntities(spec) {
  const entities = spec.entities || [];
  const byLower = new Map(entities.map((e) => [e.schemaName.toLowerCase(), e]));
  // edge: referenced (parent) -> referencing (child). child depends on parent.
  const deps = new Map(entities.map((e) => [e.schemaName.toLowerCase(), new Set()]));
  for (const rel of spec.relationships || []) {
    if (rel.type !== 'OneToMany') {
      continue;
    }
    const parent = String(rel.referenced || '').toLowerCase();
    const child = String(rel.referencing || '').toLowerCase();
    if (byLower.has(parent) && byLower.has(child) && parent !== child) {
      deps.get(child).add(parent);
    }
  }
  const ordered = [];
  const done = new Set();
  // Preserve declared order among ready nodes for determinism.
  let progressed = true;
  while (ordered.length < entities.length && progressed) {
    progressed = false;
    for (const e of entities) {
      const key = e.schemaName.toLowerCase();
      if (done.has(key)) {
        continue;
      }
      const unmet = [...deps.get(key)].some((d) => !done.has(d));
      if (!unmet) {
        ordered.push(e);
        done.add(key);
        progressed = true;
      }
    }
  }
  // Append any remaining (cyclic) entities in declared order.
  for (const e of entities) {
    if (!done.has(e.schemaName.toLowerCase())) {
      ordered.push(e);
    }
  }
  return ordered;
}

module.exports = { topoOrderEntities };
