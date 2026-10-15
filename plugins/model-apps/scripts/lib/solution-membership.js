'use strict';
// What a solution already holds, read once per build, so a rebuild adds only the components it is missing.
//
// The build re-asserts the solution membership of every component it REUSES — views, forms, charts, business
// rules, the process flow, the app, its sitemap, the page manifest, persona roles — on every run. That is
// deliberate: a component whose add failed after its create (or one made by a build of a different solution)
// is reused forever, and without the re-assert it would stay out of the exported solution with nothing saying
// so. AddSolutionComponent treats an already-present component as success, so the re-assert was always safe;
// it was also one write per component on a rebuild that changed nothing.
//
// One read answers all of them: the `solutioncomponent` rows of this solution, restricted to the component
// types the build adds and to tables. Two things count as proof, and nothing else does:
//   1. A row for (type, id). The add is provably unnecessary and is skipped.
//   2. For a VIEW, CHART or FORM (types 26, 59, 60): a row showing that the solution holds the component's TABLE
//      with ALL its subcomponents (`rootcomponentbehavior` 0). Such a component is a member WITHOUT a row of its
//      own. A table created inside a solution is added that way ("Include all objects"), and the platform does not
//      list its forms, views and charts one by one — the SDK's own solution reader says so ("members the solution
//      does not list one by one"), and a live rebuild showed the consequence: the explicit AddSolutionComponent of
//      such a view leaves no row, so a read that looked only for rows sent those adds again on every rebuild.
// A component with neither is added exactly as before. Caveats, all in the safe direction:
//   * Only behavior 0 proves anything about subcomponents. A table held at 1 ("Do not include subcomponents": the
//     table's own metadata only) or 2 ("Include As Shell Only": just the subcomponents added one by one, each with
//     a row of its own) carries none of its views, forms or charts, so those still need the row and are added
//     without it. A table row with no behavior (null) is no proof either.
//   * Other kinds are never inferred from a table. Business rules, flows, roles, the app, its sitemap and the
//     page manifest are root components that get a row of their own when added, and are judged by it alone.
//   * The set is a snapshot taken at first use. A component added during this run is recorded (`note`), so a
//     second assert of it in the same run is skipped too; one removed from the solution by someone else mid-build
//     is a race this does not try to win.
//   * ANY failure to read — no such solution, a built-in container (it holds every unmanaged customization, so
//     membership proves nothing), a page that cannot be followed, or a table whose MetadataId cannot be resolved —
//     proves nothing, and the component is added as it always was. The optimisation may never be the reason a
//     component is left out.
//
// Row shapes (OData JSON; ids are lower-case and unbraced):
//   a component  { "solutioncomponentid": "…", "objectid": "3f2a9c6e-…", "componenttype": 26, "rootcomponentbehavior": null }
//   a table      { "solutioncomponentid": "…", "objectid": "<the table's MetadataId>", "componenttype": 1, "rootcomponentbehavior": 0 }
// `objectid` is the component's own id (a savedquery id for type 26, a systemform id for 60, a
// savedqueryvisualization id for 59, …) and, for a table, its MetadataId — which is why a view's table is resolved
// to a MetadataId before it can be looked up. `rootcomponentbehavior` is an Edm.Int32 choice, null on components
// that are not roots: 0 Include Subcomponents, 1 Do not include subcomponents, 2 Include As Shell Only.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/solutioncomponent
const { odataLit } = require('./odata.js');
const { isRestrictedSolution } = require('./system-solutions.js');

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bare = (value) => String(value === undefined || value === null ? '' : value).replace(/[{}]/g, '').trim().toLowerCase();
const keyOf = (type, id) => `${Number(type)}:${bare(id)}`;

// A table's component type code: its solutioncomponent `objectid` is the table's MetadataId.
const TABLE = 1;
// The component types a table held with all its subcomponents carries without listing them. These are the three
// the SDK's own solution reader documents for it (forms, views, charts); widening the set to a kind that gets a
// row of its own when added — a role, a workflow, a web resource — would skip adds the platform needs.
const TABLE_SUBCOMPONENT_TYPES = new Set([26, 59, 60]);
// `rootcomponentbehavior` 0 — Include Subcomponents. The SDK's reader also accepts the string form, and a bare
// `Number(value) === 0` would read null and '' as 0, which is exactly the mistake that would fake a proof.
const isWholeTable = (behavior) => behavior === 0 || behavior === '0';

// What `solutionUniqueName` holds among `componentTypes`: `{ members, wholeTables }` — `members` a Set of
// `<type>:<id>` keys, `wholeTables` a Set of the bare MetadataIds of the tables held with all their
// subcomponents — or null when it cannot be known (see above). `read` is anything with the SDK's
// `queryRecords`. Throws on a failed read; createSolutionMembership turns that into null.
async function readSolutionMembers(read, solutionUniqueName, componentTypes) {
  if (!read || typeof read.queryRecords !== 'function') return null;
  if (!solutionUniqueName || isRestrictedSolution(solutionUniqueName)) return null;
  const types = [...new Set((componentTypes || []).map(Number).filter(Number.isInteger))];
  if (!types.length) return null;
  const solutions = await read.queryRecords('solution', { select: ['solutionid'], filter: `uniquename eq '${odataLit(solutionUniqueName)}'`, top: 1 });
  const solutionId = bare(solutions && solutions[0] && solutions[0].solutionid);
  // Interpolated unquoted into an Edm.Guid comparison below, so it must be a GUID and nothing else.
  if (!GUID_RE.test(solutionId)) return null;
  // Tables are read in the same query when a view, chart or form is among the kinds asked about: they are what
  // can vouch for those without a row of their own.
  const asked = types.some((type) => TABLE_SUBCOMPONENT_TYPES.has(type)) ? [...new Set([...types, TABLE])] : types;
  // Restricted to the types the build adds: a solution also holds a row per column, relationship and option set
  // of every table in it, none of which this build re-asserts. `paginate` follows @odata.nextLink, so a large
  // solution is read in full, and a paging fault throws (and so reads as unknown) rather than as a short list.
  const rows = await read.queryRecords('solutioncomponent', {
    select: ['objectid', 'componenttype', 'rootcomponentbehavior'],
    filter: `_solutionid_value eq ${solutionId} and (${asked.map((type) => `componenttype eq ${type}`).join(' or ')})`,
    paginate: true,
  });
  if (!Array.isArray(rows)) return null;
  const members = new Set();
  const wholeTables = new Set();
  for (const row of rows) {
    const id = bare(row && row.objectid);
    const type = Number(row && row.componenttype);
    // A component type is a positive integer; `Number(null)` and `Number('')` are 0, which is no type at all.
    if (!id || !Number.isInteger(type) || type <= 0) continue;
    members.add(keyOf(type, id));
    if (type === TABLE && isWholeTable(row.rootcomponentbehavior)) wholeTables.add(id);
  }
  return { members, wholeTables };
}

// A lazily-read, memoised view of one solution's membership. The read starts at the first `has`, so a build
// that never asks — it reuses nothing and deploys no pages, whose manifest always asks — never pays for it, and
// concurrent callers share the one read.
//
// `resolveTableId(logicalName)` answers a table's MetadataId. It is called only for a view, chart or form that
// has no row of its own while the solution holds some table with all its subcomponents, once per table (a
// failure is remembered too, not retried per component), and a throw or an answer that is no GUID simply proves
// nothing. Without it the table check is off and only rows count.
function createSolutionMembership({ read, solutionUniqueName, componentTypes, resolveTableId }) {
  let pending;
  let known = null;
  const members = () => {
    if (!pending) {
      pending = Promise.resolve()
        .then(() => readSolutionMembers(read, solutionUniqueName, componentTypes))
        .catch(() => null)
        .then((held) => { known = held; return held; });
    }
    return pending;
  };
  const tableIds = new Map();
  const tableIdOf = (table) => {
    const logical = String(table).trim().toLowerCase();
    if (!tableIds.has(logical)) {
      tableIds.set(logical, Promise.resolve()
        .then(() => resolveTableId(logical))
        .then((id) => (GUID_RE.test(bare(id)) ? bare(id) : null), () => null));
    }
    return tableIds.get(logical);
  };
  return {
    // True only when the solution is PROVEN to hold the component: it has a row, or — for a view, chart or form
    // given with its `table` — the solution holds that table with all its subcomponents.
    async has(componentId, componentType, { table } = {}) {
      const held = await members();
      if (!held) return false;
      if (held.members.has(keyOf(componentType, componentId))) return true;
      if (!table || typeof resolveTableId !== 'function' || !held.wholeTables.size) return false;
      if (!TABLE_SUBCOMPONENT_TYPES.has(Number(componentType))) return false;
      const tableId = await tableIdOf(table);
      return !!tableId && held.wholeTables.has(tableId);
    },
    // Records a component this run added, so a repeated assert of it is skipped. Never invents membership
    // the read did not establish: with nothing known there is nothing to add to.
    note(componentId, componentType) {
      if (known) known.members.add(keyOf(componentType, componentId));
    },
  };
}

// Add a component to the solution unless it is already proven to be in it. Returns whether the add was made.
// A failure of the add propagates, exactly as a direct `addSolutionComponent` would — each call site keeps its
// own policy (fail the phase, or warn and carry on). `table` is the logical name of the table a view, chart or
// form belongs to; it is only evidence for the membership check and never reaches the add.
async function ensureSolutionComponent(sdk, membership, { componentId, componentType, solutionUniqueName }, { table } = {}) {
  if (membership && await membership.has(componentId, componentType, { table })) return false;
  await sdk.addSolutionComponent({ componentId, componentType, solutionUniqueName });
  if (membership) membership.note(componentId, componentType);
  return true;
}

module.exports = { readSolutionMembers, createSolutionMembership, ensureSolutionComponent };
