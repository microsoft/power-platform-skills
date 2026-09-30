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

const fs = require('node:fs');
const path = require('node:path');
const { annotateContentHashes } = require('./content-hash.js');

const FILE = 'last-applied.json';
// Stored beside the spec's own top-level keys. phase-diff.js compares only its per-phase slices, so
// neither stamp can make the advisory diff report a change.
const ENVIRONMENT_KEY = '__environment';
const APP_KEY = '__appUniqueName';

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
      const abs = path.resolve(root, relPath);
      const rel = path.relative(root, abs);
      if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
      return fs.readFileSync(abs);
    } catch {
      return null;
    }
  };
}

/**
 * Record `spec` as the state of `appUniqueName` in `environment` (a canonical origin, e.g.
 * `https://contoso.crm.dynamics.com`). Throws on a write error; callers treat it as non-fatal.
 */
function writeBaseline(workspaceDir, spec, { appDir, environment, appUniqueName }) {
  const snapshot = {
    ...annotateContentHashes(spec, confinedReader(appDir)),
    [ENVIRONMENT_KEY]: environment || null,
    [APP_KEY]: appUniqueName || null,
  };
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(baselinePath(workspaceDir), JSON.stringify(snapshot));
}

/**
 * The snapshot, when it describes `appUniqueName` in `environment`; otherwise null (missing,
 * unreadable, another app or environment, or written before the stamps existed).
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
  return snapshot;
}

module.exports = { baselinePath, confinedReader, writeBaseline, readBaseline };
