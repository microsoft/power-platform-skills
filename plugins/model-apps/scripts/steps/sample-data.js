const { sampleRecordsFor, resolveSampleRecords, relationshipFor } = require('../lib/app-spec.js');
const recs = require('../lib/dataverse-records.js');
const { topoOrderEntities } = require('./_graph.js');

// Does a resolved sample record satisfy the $parent.match? Compares against the
// ORIGINAL author-written record (match values are author labels/values, not the
// choice-resolved ints), so we match on the raw record map.
function recordMatches(rawRecord, match) {
  return Object.entries(match).every(([k, v]) => {
    const rk = Object.keys(rawRecord).find((x) => x.toLowerCase() === k.toLowerCase());
    return rk !== undefined && rawRecord[rk] === v;
  });
}

// --- 2. Sample data (opt-in): resolve choice labels -> ints, then bulk-create.
// Runs right after entities are created + published, so the columns resolve.
// Supports RELATIONAL data: entities are inserted parent-before-child (topological),
// created ids are captured per entity keyed by the record's match fields, and any
// record carrying $parent:{entity,match} gets a "<navprop>@odata.bind" lookup bound
// to the parent record's id (navprop = the OneToMany lookup schema name).
async function sampleData(spec, opts, deps, result) {
  result.created.records = {};
  // entitySetName cache so a $parent reference can resolve a parent's collection.
  const entitySets = {};
  const setNameFor = async (logical) => {
    if (!entitySets[logical]) {
      entitySets[logical] = await recs.getEntitySetName(deps.dv, logical);
    }
    return entitySets[logical];
  };
  // Per-entity list of { raw, id } so a child can match a parent record -> its id.
  const createdByEntity = {};

  for (const e of topoOrderEntities(spec)) {
    const records = sampleRecordsFor(spec, e);
    if (!records.length) {
      continue;
    }
    deps.step(`sample data: ${records.length} record(s) for ${e.schemaName}`);
    const entityLogical = e.schemaName.toLowerCase();
    const resolved = resolveSampleRecords(e, records); // choice labels -> ints, drops $parent
    // Bind each record's $parent (if any) as an @odata.bind lookup.
    const bodies = resolved.map((rec, i) => {
      const raw = records[i];
      const body = Object.assign({}, rec);
      delete body.$parent; // never send the directive to the Web API
      const parent = raw && raw.$parent;
      if (parent && parent.entity && parent.match) {
        const parentLogical = parent.entity.toLowerCase();
        const hits = createdByEntity[parentLogical] || [];
        const hit = hits.find((h) => recordMatches(h.raw, parent.match));
        const rel = relationshipFor(spec, parent.entity, e.schemaName);
        if (hit && hit.id && rel) {
          const navprop = rel.lookup.schemaName;
          body[`${navprop}@odata.bind`] = `/${entitySets[parentLogical]}(${hit.id})`;
        } else {
          deps.log(
            `sample data: could not bind $parent for a ${e.schemaName} record ` +
              `(parent ${parent.entity} match=${JSON.stringify(parent.match)})`
          );
        }
      }
      return body;
    });
    const entitySet = await setNameFor(entityLogical);
    const r = deps.runScript('create-record.js', [opts.env, entitySet, '--body', JSON.stringify(bodies)]);
    // create-record.js returns `ids` positionally aligned 1:1 with the records we
    // sent: ids[i] is the created id for records[i], or null if that record failed.
    // (See create-record.js createBatch — failed slots are null, never collapsed out,
    // so the index never shifts.) That alignment is load-bearing here: children
    // resolve their parent by matching raw fields, then read that parent's id.
    const ids = (r && r.ids) || [];
    result.created.records[e.schemaName] = ids;
    // Record raw->id pairs so children can resolve this as a parent. Only keep
    // successfully-created records (id != null): a child must never bind to a parent
    // that failed to insert, which would otherwise corrupt the relational graph.
    createdByEntity[entityLogical] = records
      .map((raw, i) => ({ raw, id: ids[i] }))
      .filter((pair) => pair.id != null);
  }
}

module.exports = { sampleData, recordMatches };
