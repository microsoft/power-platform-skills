'use strict';
// The dashboards a build CREATED and has not yet seen join the app's solution, kept in the build's workspace so that the run that FOLLOWS an interrupted
// one adds that same dashboard to the solution instead of losing it.
//
// The build creates a dashboard (lib/sdk-build.js, the dashboards phase) with one request — the push POSTs the systemform row — and adds it to the app's
// solution with a second one (AddSolutionComponent). The solution is the only later proof that the dashboard is this app's: a dashboard's name is neither
// unique nor compared exactly, and teardown deletes only the dashboards the solution holds (sdk-build.js dashboardsInSolution). A run that stops between
// the two requests — the process is killed, the answer to the create is lost, or the membership add and the build's own undo of the create both fail —
// leaves the row outside the solution, and nothing durable remembered it. The next build looked the dashboard up by name: a dashboard that was created and
// never published is in no plain read (only RetrieveUnpublished answers it), so that build created a SECOND one; one that someone had published since was
// reused as a lone namesake without being added. Either way teardown kept it and a solution export left it out.
//
// The bundled SDK sends the workspace's own id as the row's key on the create (`systemform.formid`, minted by the client), so the build holds the id BEFORE
// the request. It notes it here before the push, keeps the id the push reports beside it when that is another one (the SDK prefers the id the service's
// answer names and moves its copy there), and clears it once the row is PROVEN in the solution (the membership add answered) or proven REMOVED by the
// build's own undo (the delete answered). A stranded dashboard — the add and the undo both failed — keeps it. The next build reads each recorded id in the
// saved layer before it looks any dashboard up by name (sdk-build.js recoverRecordedDashboard).
//
// What this record is NOT: proof about any row but the one its id names, deletion authority (teardown stays solution-membership based and never reads
// it), or a way to adopt a namesake. It is written only from the id the build minted for a create it is about to send and from the id that push
// reported — never from a downloaded `dashboardId`, a namesake, a solution member or any id a spec supplies.
//
// One file per environment, app and solution, named by the hash of the three, so another app built from the same folder, or the same app into another
// solution or environment, never sees it (an app that does not exist yet is still named: its unique name comes from the spec, not from the service):
//   dashboard-creation.<64 hex>.json
//   { "schemaVersion": 1, "environmentFingerprint": "<sha256 of the origin>", "appUniqueName": "contoso_app", "solutionUniqueName": "contososolution",
//     "dashboards": { "Ops Overview": { "id": "11111111-1111-4111-8111-111111111111" },
//                     "Sales": { "id": "33333333-3333-4333-8333-333333333333", "reportedId": "44444444-4444-4444-8444-444444444444" } } }
// `reportedId` appears only when the push reported another id than the one the build sent; both observations are kept, and they are not equal: the
// reported id is the row the create made, the sent one was never seen to make anything, so the next build recovers only the reported row and never
// adopts the sent one on its own (sdk-build.js recoverRecordedDashboard). Names are compared as Dataverse compares dashboard names (app-spec.js
// dashboardNameKey); the file keeps a name as the build wrote it, sorted by that comparison, so the same dashboards are the same bytes. Written atomically.
//
// A file that cannot be read — damaged, a link where the file should be, a folder, too large, one written for another environment, app or solution, or
// one holding an entry the build never writes (an id or a reported id that is no id, a reported id equal to the id, a key it does not write, two names
// Dataverse compares as one) — is "nothing is recorded", which is what the build did before there was a record: it finds dashboards by name. An entry
// is never skipped on its own: what it held may be the only trace of a dashboard outside its solution, and a record that went on being written would
// lose it (a note() would replace the file, a clear() of the last good entry would delete it). The run then writes no record of its own either, so a
// file it cannot read is never replaced or removed; the warning names it, for a person to look at and remove.
const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('./hash.js');
const { writeFileAtomic } = require('./apply-snapshot-store.js');
const { environmentFingerprint, workspaceRoot } = require('./page-ownership-records.js');
const { dashboardNameKey } = require('./app-spec.js');

const PREFIX = 'dashboard-creation.';
const SCHEMA_VERSION = 1;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A handful of names and ids: a file much larger than any spec's dashboards could need is not a record of this kind.
const MAX_BYTES = 1 << 20;

const lower = (value) => String(value == null ? '' : value).toLowerCase();
// An id as the record keeps it: bare (no braces) and lower case, or null for anything that is not a GUID.
function idOf(value) {
  const id = lower(value).trim().replace(/^\{|\}$/g, '');
  return GUID.test(id) ? id : null;
}
const recordFile = (root, fingerprint, app, solution) => path.join(root, `${PREFIX}${sha256(JSON.stringify([fingerprint, app, solution]))}.json`);
const byKey = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

// Where the record of `appUniqueName`'s dashboards in `solutionUniqueName` and `environment` is kept — for a caller that has to point at it (a message, a
// test), never to read it.
function dashboardCreationRecordPath(workspaceDir, environment, appUniqueName, solutionUniqueName) {
  return recordFile(path.resolve(workspaceDir), environmentFingerprint(environment), lower(appUniqueName), lower(solutionUniqueName));
}

// The recorded dashboards, as Map<dashboardNameKey(name), { name, id, reportedId? }>. Throws what stops the file from being read (the caller decides that is
// only a warning); a workspace or a file that does not exist is an empty map. An entry the build does not write makes the whole file unreadable.
function readDashboardCreations(workspaceDir, environment, appUniqueName, solutionUniqueName) {
  const known = new Map();
  const root = workspaceRoot(workspaceDir);
  if (!root) return known;
  const fingerprint = environmentFingerprint(environment);
  const app = lower(appUniqueName);
  const solution = lower(solutionUniqueName);
  const file = recordFile(root, fingerprint, app, solution);
  let stat;
  try { stat = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return known; throw e; }
  // A plain, unlinked file of a sane size, as the page and web-resource records are read: a record another location can alter, or a file that is not one,
  // says nothing.
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > MAX_BYTES) throw new Error(`${file} is not a plain file of a dashboard creation record`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!record || record.schemaVersion !== SCHEMA_VERSION || record.environmentFingerprint !== fingerprint || record.appUniqueName !== app || record.solutionUniqueName !== solution
    || !record.dashboards || typeof record.dashboards !== 'object' || Array.isArray(record.dashboards)) {
    throw new Error(`${file} is not a dashboard creation record this build can read`);
  }
  for (const [name, entry] of Object.entries(record.dashboards)) {
    // Exactly what the writer writes, or the whole record is unreadable (see the header): `{ "id": "<guid>" }` or `{ "id": "<guid>", "reportedId": "<another guid>" }`
    // under a name no other entry shares as Dataverse compares names. Reading only the id of an entry whose reported id is damaged could prove "absent" while the
    // row the service named exists; keeping one of two entries for the same name would drop the other's id.
    const key = dashboardNameKey(name);
    const shaped = Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).every((k) => k === 'id' || k === 'reportedId');
    const id = shaped ? idOf(entry.id) : null;
    const reportedId = shaped && entry.reportedId !== undefined ? idOf(entry.reportedId) : undefined;
    if (!key || !id || reportedId === null || reportedId === id || known.has(key)) {
      throw new Error(`${file} holds an entry this build does not write (dashboard '${name}')`);
    }
    known.set(key, { name, id, ...(reportedId ? { reportedId } : {}) });
  }
  return known;
}

// Replace the record with `entries` (the Map readDashboardCreations answers); an empty map removes the file.
function writeDashboardCreations(workspaceDir, environment, appUniqueName, solutionUniqueName, entries) {
  const fingerprint = environmentFingerprint(environment);
  const app = lower(appUniqueName);
  const solution = lower(solutionUniqueName);
  if (!entries.size) {
    const root = workspaceRoot(workspaceDir);
    if (!root) return;
    try { fs.unlinkSync(recordFile(root, fingerprint, app, solution)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return;
  }
  const root = workspaceRoot(workspaceDir, true);
  const dashboards = {};
  for (const [, { name, id, reportedId }] of [...entries].sort(byKey)) dashboards[name] = { id, ...(reportedId ? { reportedId } : {}) };
  writeFileAtomic(recordFile(root, fingerprint, app, solution), `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, environmentFingerprint: fingerprint, appUniqueName: app, solutionUniqueName: solution, dashboards })}\n`);
}

/**
 * The record for one run of the build: read once, then written through. `idsOf(name)` is every id an earlier run recorded for the dashboard — the one it
 * sent first, then the one the service reported when that was another — or undefined; `note(name, id)` records the id a create is about to be sent with,
 * `observe(name, reportedId)` the id its push reported, and `clear(name)` removes the dashboard; each answers whether that is now on disk. `path()` is the
 * file, for a message. None of them throws: a record that cannot be read or written is said once on `warn`, and a run without a workspace, an environment
 * or a solution (a caller that gives none; the CLI always gives all three) records nothing.
 */
function openDashboardCreations({ workspaceDir, environment, appUniqueName, solutionUniqueName, warn } = {}) {
  const usable = Boolean(workspaceDir) && Boolean(environment) && Boolean(solutionUniqueName);
  let entries;
  // False once the file was there and could not be read: nothing is written over it.
  let readable = true;
  let warned = false;
  const say = (message) => {
    if (warned || typeof warn !== 'function') return;
    warned = true;
    warn(message);
  };
  const where = () => {
    try { return dashboardCreationRecordPath(workspaceDir, environment, appUniqueName, solutionUniqueName); } catch { return 'the build workspace'; }
  };
  const load = () => {
    if (entries) return entries;
    entries = new Map();
    if (!usable) return entries;
    try { entries = readDashboardCreations(workspaceDir, environment, appUniqueName, solutionUniqueName); } catch (e) {
      readable = false;
      say(`the record of the dashboards earlier builds created and did not see join solution '${solutionUniqueName}' (${where()}) could not be read (${(e && e.message) || e}), so this build finds dashboards by name, as before, and records none of its own: a dashboard it creates is not found again if it stops before adding it to the solution. Remove the file once you have looked at it`);
    }
    return entries;
  };
  const save = (next) => {
    if (!usable || !readable) return false;
    try {
      writeDashboardCreations(workspaceDir, environment, appUniqueName, solutionUniqueName, next);
      entries = next;
      return true;
    } catch (e) {
      say(`the record of the dashboards this build creates (${where()}) could not be written (${(e && e.message) || e}): a dashboard it creates is not found again if it stops before adding it to solution '${solutionUniqueName}'`);
      return false;
    }
  };
  return {
    idsOf: (name) => {
      const entry = load().get(dashboardNameKey(name));
      return entry ? [entry.id, ...(entry.reportedId ? [entry.reportedId] : [])] : undefined;
    },
    note: (name, id) => {
      const sent = idOf(id);
      if (!usable || !sent) return false;
      const next = new Map(load());
      next.set(dashboardNameKey(name), { name: String(name), id: sent });
      return save(next);
    },
    observe: (name, reportedId) => {
      const reported = idOf(reportedId);
      const entry = load().get(dashboardNameKey(name));
      if (!entry || !reported) return false;
      if (reported === entry.id || reported === entry.reportedId) return true;
      const next = new Map(load());
      next.set(dashboardNameKey(name), { ...entry, reportedId: reported });
      return save(next);
    },
    clear: (name) => {
      if (!load().has(dashboardNameKey(name))) return false;
      const next = new Map(load());
      next.delete(dashboardNameKey(name));
      return save(next);
    },
    path: where,
  };
}

module.exports = { PREFIX, openDashboardCreations, readDashboardCreations, writeDashboardCreations, dashboardCreationRecordPath };
