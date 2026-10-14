'use strict';
// `<workspace>/last-applied.json`: the App Spec as last applied to — or downloaded from — ONE app in
// ONE environment.
//
// Two readers use it:
//   * the dry run's advisory "phases changed since the last apply" diff (build-model-app.js), and
//   * the sitemap rewrite's baseline (AB#6726727): a nav entry the spec has not changed since this
//     snapshot, but the environment has, is kept rather than reverted (sitemap-merge.js).
// The second is only sound against the app and environment the snapshot describes. The same spec
// folder can be pointed at another environment, where "live differs from the snapshot" says nothing
// about who changed what, so the snapshot records both and a baseline is returned only on an exact
// match. A snapshot written before these stamps existed is not a baseline for the same reason.
//
// Written after a successful full apply and by download, whose output IS the deployed state. Nothing
// here may fail a build or a download: without a baseline the spec wins, and the build says so.
//
// The snapshot is stored as schemaVersion 2 (migrateAppSpec), the shape every loaded spec has, so a
// page is always referenced by its key. Beside it, `__deployedIds` records the id each dashboard (by
// name) and page (by key) has in THIS environment, which the sitemap baseline lines entries up by
// (chromeByTargetKey, sitemap-merge.js). The spec's own `dashboardId` / `pageId` cannot serve: a spec
// downloaded from one environment keeps that environment's ids when it is built into another, where
// the build falls back to the name and resolves different ones.

const fs = require('node:fs');
const path = require('node:path');
const { annotateContentHashes, recordedContentSha } = require('./content-hash.js');
const { migrateAppSpec } = require('./app-spec.js');
const { writeFileAtomic } = require('./apply-snapshot-store.js');
const { resolveAppSource } = require('./app-source-path.js');

const FILE = 'last-applied.json';
// Stored beside the spec's own top-level keys. phase-diff.js compares only its per-phase slices, so
// no stamp can make the advisory diff report a change.
const ENVIRONMENT_KEY = '__environment';
const APP_KEY = '__appUniqueName';
const IDS_KEY = '__deployedIds';

function baselinePath(workspaceDir) {
  return path.join(workspaceDir, FILE);
}

/**
 * A `readFile(relPath)` for annotateContentHashes, confined to `appDir`: a page codeFile or
 * web-resource contentPath is resolved the way the build engine resolves it (relative to the app
 * folder), and one that escapes the folder — already rejected at validation — reads as null rather
 * than reaching an arbitrary file. A null hash reads as CHANGED (see content-hash.js), so an
 * unreadable source can never make the diff report a silent no-op. Bytes are raw, so the hash does
 * not depend on an encoding.
 */
function confinedReader(appDir) {
  const root = path.resolve(appDir || '.');
  return (relPath) => {
    try {
      return fs.readFileSync(resolveAppSource(root, relPath));
    } catch {
      return null;
    }
  };
}

/**
 * The id each dashboard (by name) and page (by key) of the migrated `spec` has in this environment,
 * as `{ dashboards: { <name>: id }, pages: { <key>: id } }`, from the first source that has it:
 *   - `fromSpec`: the spec's own `dashboardId` / `pageId` — a download's, read from this environment;
 *   - `created`: what this build resolved (its `result.created`);
 *   - `previous`: the ids the prior baseline recorded — a changed-only apply resolves only the pages
 *     it uploads, and an id it did not re-resolve is still the one it had.
 * An entry no source has is left out, so the next build resolves it itself.
 */
function deployedIdsFor(spec, { created, previous, fromSpec = false } = {}) {
  const own = (map, name) => (map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, name) ? map[name] : undefined);
  const prior = (previous && previous[IDS_KEY]) || {};
  const list = (v) => (Array.isArray(v) ? v : []);
  // Object.fromEntries defines each name as an own data property — a dashboard named `__proto__` is
  // recorded, not turned into the object's prototype.
  const dashboards = Object.fromEntries(list(spec && spec.dashboards)
    .filter((d) => d && typeof d.name === 'string' && d.name)
    .map((d) => [d.name, (fromSpec && d.dashboardId) || own(created && created.dashboards, d.name) || own(prior.dashboards, d.name)])
    .filter(([, id]) => typeof id === 'string' && id));
  const pages = Object.fromEntries(list(spec && spec.pages)
    .filter((p) => p && typeof p.key === 'string' && p.key)
    .map((p) => [p.key, (fromSpec && p.pageId) || own(created && created.pages, p.key) || own(prior.pages, p.key)])
    .filter(([, id]) => typeof id === 'string' && id));
  return { dashboards, pages };
}

/**
 * `spec` annotated with the hash of each page's source, as the baseline records it. What a page's `__contentSha` says is "the source an apply SENT", and the build's Griffel check judges a
 * later source against it (sdk-build.js griffelStanding), so it must not describe bytes the apply never looked at. When the apply measured its pages (`created.pageSourceShas`, the hash of
 * the source the pages phase READ and checked before it sent the page) that hash is the record. Hashing the files here instead — as the build ENDS — records a page a maker saved while
 * the build ran as applied, and the next build finds the edit "unchanged".
 * A page the apply did not send (a changed-only run sends only the pages it selects) keeps the record it had (`previous`): what was last sent is still what is deployed, whatever the file
 * says by now. With no record to keep it records the file as it is, as before — no record at all would be no stricter: the next build reads a missing record as `unrecorded` and goes on
 * with a warning (sdk-build.js), where a source that differs from a recorded hash is held. Without `created.pageSourceShas` — a download, whose files ARE the deployed
 * state, or any caller that measured nothing — every source is hashed as it is on disk.
 */
function annotateForBaseline(v2, appDir, { created, previous } = {}) {
  const annotated = annotateContentHashes(v2, confinedReader(appDir));
  const sent = created && created.pageSourceShas && typeof created.pageSourceShas === 'object' ? created.pageSourceShas : null;
  if (!sent || !annotated || !Array.isArray(annotated.pages)) return annotated;
  return {
    ...annotated,
    pages: annotated.pages.map((page) => {
      // An intent page has no source on disk, so it carries no hash to replace.
      if (!page || typeof page !== 'object' || !Object.prototype.hasOwnProperty.call(page, '__contentSha')) return page;
      const key = page.key || page.name;
      if (Object.prototype.hasOwnProperty.call(sent, key)) return { ...page, __contentSha: typeof sent[key] === 'string' && sent[key] ? sent[key] : null };
      const earlier = recordedContentSha(previous, key);
      return earlier === null ? page : { ...page, __contentSha: earlier };
    }),
  };
}

/**
 * Record `spec` as the state of `appUniqueName` in `environment` (a canonical origin, e.g.
 * `https://contoso.crm.dynamics.com`), with the deployed ids `deployedIdsFor` finds from `created`,
 * `previous` and — for a download — `fromSpec`, and each page's source hash as `annotateForBaseline` finds
 * it. Throws on a write error; callers treat it as non-fatal.
 */
function writeBaseline(workspaceDir, spec, { appDir, environment, appUniqueName, created, previous, fromSpec } = {}) {
  const v2 = migrateAppSpec(spec);
  const snapshot = {
    ...annotateForBaseline(v2, appDir, { created, previous }),
    [ENVIRONMENT_KEY]: environment || null,
    [APP_KEY]: appUniqueName || null,
    [IDS_KEY]: deployedIdsFor(v2, { created, previous, fromSpec }),
  };
  fs.mkdirSync(workspaceDir, { recursive: true });
  // Atomically, like the apply snapshot: a crash or a full disk part-way through a plain write left a
  // truncated file, which reads as no baseline — and without one the spec wins over every nav change made
  // in the designer. A failed write now leaves the previous snapshot of this app and environment, which is
  // still right about everything the latest apply did not change.
  writeFileAtomic(baselinePath(workspaceDir), JSON.stringify(snapshot));
}

/**
 * The snapshot, when it describes `appUniqueName` in `environment`; otherwise null (missing,
 * unreadable, another app or environment, or written before the stamps existed). Returned as
 * schemaVersion 2 whatever shape it was stored in.
 */
function readBaseline(workspaceDir, { environment, appUniqueName }) {
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(baselinePath(workspaceDir), 'utf8'));
  } catch {
    return null;
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  if (!environment || snapshot[ENVIRONMENT_KEY] !== environment) return null;
  // App unique names are case-insensitive in Dataverse.
  const app = typeof snapshot[APP_KEY] === 'string' ? snapshot[APP_KEY].toLowerCase() : '';
  if (!appUniqueName || app !== String(appUniqueName).toLowerCase()) return null;
  try {
    return migrateAppSpec(snapshot);
  } catch {
    return null;
  }
}

module.exports = { baselinePath, confinedReader, deployedIdsFor, writeBaseline, readBaseline };
