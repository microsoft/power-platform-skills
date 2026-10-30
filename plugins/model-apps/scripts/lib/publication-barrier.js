'use strict';
// The run-wide table publication barrier for declared views, charts and Quick Find lists.
//
// A Dataverse table publish (PublishXml naming the table, or the SDK's publish of any one view, form
// or chart of it) ships EVERYTHING saved on that table, whoever saved it. So when a declared artifact
// on table T ends refused or unknown after something was saved — a created chart whose title was not
// stored, a created view that could not be read back, a write whose outcome was not reported — no
// publish of T may run for the rest of the build: not the artifact's own, and not one that other work
// owes T (a sibling view's reconcile, the default-view enrichment, the tables published before the app,
// the publish phase, the settle of a halt). The saved rows stay saved and unpublished, with their
// solution and undo bookkeeping; nothing is deleted or rolled back. The build reports each withheld
// table and what blocked it, and the run stays incomplete (nonzero) through the artifact's own
// refusal or unknown.
//
// The barrier is created once per run and handed to every attempt, so a retry after a transient halt
// cannot publish a table an earlier attempt withheld. It is inert until `noteResult` blocks a table:
// every `allow*` call then answers exactly what it was given, so a run that never meets one of these
// failures sends the same requests as before.
//
// Which results block: a result with a refusal or an unknown that still carries `pendingPublish`
// entries (marked `withheld` by commitPublication, reconcile-common.js). The helpers record such an
// entry at every point where a write was sent and may have been stored (saved, created, or a write
// whose outcome was not reported), and never for a refusal or unknown that is reached before anything
// is sent, so a plan-level refusal does not block its table.

/** Lowercased table logical name, or '' for anything that is not a non-empty string. */
function tableKey(table) {
  return typeof table === 'string' ? table.trim().toLowerCase() : '';
}

function createPublicationBarrier() {
  // table -> { table, blockedBy: [label], skipped: [path] }
  const blocked = new Map();
  // `type:id` -> table, for owed publish targets ([type, id, names?]) that carry no table of their own.
  const targetTables = new Map();
  const skip = (entry, path) => {
    if (path && !entry.skipped.includes(path)) entry.skipped.push(path);
  };

  const barrier = {
    /** True once any table is blocked. */
    get active() {
      return blocked.size > 0;
    },
    /** Block `table` because `label` ended refused or unknown with saved or possibly-saved state. */
    block(table, label) {
      const t = tableKey(table);
      if (!t) return false;
      let entry = blocked.get(t);
      if (!entry) {
        entry = { table: t, blockedBy: [], skipped: [] };
        blocked.set(t, entry);
      }
      if (label && !entry.blockedBy.includes(label)) entry.blockedBy.push(label);
      return true;
    },
    /**
     * Note one declared artifact's settled FeatureResult. A clean result, or one whose refusal/unknown
     * came before anything was sent (no `pendingPublish` entry), blocks nothing. Returns the tables
     * this result blocked.
     */
    noteResult(result, label) {
      if (!result) return [];
      if (!(result.refused || []).length && !(result.unknown || []).length) return [];
      const codes = [...(result.refused || []), ...(result.unknown || [])].map((x) => x && x.code).filter(Boolean);
      const what = codes.length ? `${label} (${[...new Set(codes)].join(', ')})` : String(label || 'a declared artifact');
      const tables = [];
      for (const p of result.pendingPublish || []) {
        const t = tableKey(p && p.scope && p.scope.table);
        if (t && barrier.block(t, what) && !tables.includes(t)) tables.push(t);
      }
      return tables;
    },
    /** Whether `table` is blocked. Records nothing. */
    blocks(table) {
      return blocked.has(tableKey(table));
    },
    /** The blocked tables, in the order they were blocked. */
    blockedTables() {
      return [...blocked.keys()];
    },
    /** May `table` be published by `path`? A refusal is recorded against the table as skipped by `path`. */
    allow(table, path) {
      const entry = blocked.get(tableKey(table));
      if (!entry) return true;
      skip(entry, path);
      return false;
    },
    /** The tables of `tables` that may be published by `path`, in their order; the list itself when nothing is blocked. */
    allowTables(tables, path) {
      const list = Array.isArray(tables) ? tables : [...(tables || [])];
      if (!blocked.size) return list;
      return list.filter((t) => barrier.allow(t, path));
    },
    /** Remember that the owed publish `target` ([type, id, names?]) publishes `table`. */
    noteTarget(table, target) {
      const t = tableKey(table);
      if (t && Array.isArray(target) && target[0] && target[1]) targetTables.set(`${target[0]}:${String(target[1]).toLowerCase()}`, t);
    },
    /** May the owed publish `target` run? False when the table it was noted for is blocked. */
    allowTarget(target, path) {
      if (!blocked.size || !Array.isArray(target)) return true;
      const t = targetTables.get(`${target[0]}:${String(target[1]).toLowerCase()}`);
      return t ? barrier.allow(t, path) : true;
    },
    /** What was withheld: [{ table, blockedBy: [label], skipped: [path] }], copies. */
    withheld() {
      return [...blocked.values()].map((e) => ({ table: e.table, blockedBy: e.blockedBy.slice(), skipped: e.skipped.slice() }));
    },
  };
  return barrier;
}

/** The line a build reports for one withheld table (an entry of `withheld()`). */
function describeWithheld(entry) {
  const by = (entry.blockedBy || []).join('; ') || 'a declared artifact';
  return `table ${entry.table} was not published: ${by} ended refused or unknown after saving, and a publish of the table would put that saved state live — its saved changes stay saved and unpublished; repair and rerun`;
}

module.exports = { createPublicationBarrier, describeWithheld };
