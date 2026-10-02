'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('./hash.js');
const { resolveAppSource } = require('./app-source-path.js');
const { writeFileAtomic } = require('./apply-snapshot-store.js');
const { assertSafeOutputDir } = require('./safe-fs.js');

const PREFIX = 'page-ownership.';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const nonempty = (s) => typeof s === 'string' && s.trim().length > 0;

function environmentFingerprint(environment) {
  let url;
  try { url = new URL(environment); } catch {
    throw new Error('a target HTTPS environment origin is required for page ownership');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('page ownership requires a target HTTPS environment origin without credentials');
  }
  // The SDK manifest stores instanceUrl verbatim and can describe an earlier target. Bind to the
  // caller's current origin instead; URL.origin drops path/trailing slash and canonicalizes the host.
  // This fingerprint stores no routing URL and does not replace the transport's URL validation.
  // See https://url.spec.whatwg.org/#dom-url-origin
  return sha256(url.origin.toLowerCase());
}

function workspaceRoot(workspaceDir, create = false) {
  if (!workspaceDir) {
    if (create) throw new Error('a build workspace is required to persist local page ownership');
    return null;
  }
  const root = path.resolve(workspaceDir);
  // A workspace that was never created holds no records. Any other failure to inspect it is
  // surfaced: records this run cannot see must never be read as "none".
  if (!create) {
    try { fs.lstatSync(root); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  // Receipts authorize deletes, so the folder that holds them must be the folder that was named:
  // safe-fs refuses a final component that is a symbolic link or junction (UNSAFE_OUTPUT).
  assertSafeOutputDir(root, { create });
  return root;
}

function recordName(r) {
  const identity = [r.environmentFingerprint, r.appUniqueName, r.key, r.pageId];
  return `${PREFIX}${r.kind}.${sha256(JSON.stringify(identity))}.json`;
}

// Example: { schemaVersion:2, kind:"created", appUniqueName:"contoso_app", key:"overview",
// pageId:"11111111-1111-4111-8111-111111111111", name:"Overview", environmentFingerprint:"<sha256>" }.
// Baselines and journals include adopted/downloaded ids; only an acknowledged CREATE writes "created".
function validRecord(r) {
  return r && r.schemaVersion === 2 && FINGERPRINT.test(r.environmentFingerprint)
    && ['created', 'teardown'].includes(r.kind)
    && Object.keys(r).length === 7
    && nonempty(r.appUniqueName) && r.appUniqueName === r.appUniqueName.toLowerCase()
    && nonempty(r.pageId) && GUID.test(r.pageId) && nonempty(r.name)
    && (nonempty(r.key) || (r.kind === 'teardown' && r.key === null));
}

function readRecord(root, file) {
  const target = path.join(root, file);
  try {
    const stat = fs.lstatSync(target);
    // Authority records must be regular, unlinked local files, not aliases another location can alter.
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('not a plain file');
    const r = JSON.parse(fs.readFileSync(resolveAppSource(root, file), 'utf8'));
    if (!validRecord(r) || recordName(r) !== file) throw new Error('unsupported version or malformed contents/identity');
    return r;
  } catch (cause) {
    const error = new Error(`${target} is not a readable page-ownership record (${cause.code || cause.message}) - inspect it; delete it only if no page it names still exists`, { cause });
    if (cause.code) error.code = cause.code;
    throw error;
  }
}

// The exact name recordName() produces: page-ownership.<kind>.<64 hex>.json. Anything else in the
// folder — an editor backup such as page-ownership.created.<hash>.backup.json, a temp file — is
// not a record and is ignored, rather than halting every build as a malformed one.
const RECORD_FILE = /^page-ownership\.(created|teardown)\.[0-9a-f]{64}\.json$/;

function readAllRecords(workspaceDir) {
  const records = [];
  const root = workspaceRoot(workspaceDir);
  if (!root) return records;
  for (const file of fs.readdirSync(root).filter((f) => RECORD_FILE.test(f))) {
    try {
      records.push(readRecord(root, file));
    } catch (e) {
      // A record that vanished between the listing and the read was retired by a concurrent
      // teardown (it consumes a record only after the page is deleted or confirmed absent), so it
      // grants nothing and blocks nothing. Every other failure is a record this run saw but could
      // not interpret: never create a replacement page past it.
      if (e && e.code === 'ENOENT') continue;
      throw e;
    }
  }
  return records;
}

function readPageOwnership(workspaceDir, appUniqueName, environment) {
  const state = { created: [], teardown: [] };
  if (!workspaceDir) return state;
  const fingerprint = environmentFingerprint(environment);
  const app = String(appUniqueName || '').toLowerCase();
  for (const r of readAllRecords(workspaceDir)) {
    if (r.environmentFingerprint === fingerprint && r.appUniqueName === app) state[r.kind].push(r);
  }
  return state;
}

function saveRecord(workspaceDir, kind, appUniqueName, key, pageId, name, environment) {
  if (!workspaceDir) throw new Error('a build workspace is required to persist local page ownership');
  const r = { schemaVersion: 2, kind, appUniqueName: String(appUniqueName || '').toLowerCase(), key: key || null, pageId: String(pageId || '').toLowerCase(), name, environmentFingerprint: environmentFingerprint(environment) };
  if (!validRecord(r)) throw new Error('local page ownership record needs an app unique name, page key, page GUID and stored name');
  const root = workspaceRoot(workspaceDir, true);
  const file = recordName(r);
  let existing;
  try { existing = readRecord(root, file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (existing) {
    if (kind === 'created' && existing.name !== name) throw new Error(`creation receipt for ${pageId} has a different page name`);
    return existing;
  }
  // One immutable record per tuple avoids losing another page's proof when writers overlap.
  // Atomic, fsynced writes make a record durable before the remote manifest or app is changed.
  writeFileAtomic(path.join(root, file), JSON.stringify(r) + '\n');
  return r;
}

function recordPageCreation(workspaceDir, appUniqueName, key, pageId, name, environment) {
  return saveRecord(workspaceDir, 'created', appUniqueName, key, pageId, name, environment);
}

function recordPageTeardown(workspaceDir, appUniqueName, items, environment) {
  for (const item of items) saveRecord(workspaceDir, 'teardown', appUniqueName, item.key, item.id, item.name, environment);
}

function creationIds(state) {
  const out = new Map();
  for (const r of state.created) {
    if (!out.has(r.key)) out.set(r.key, new Set());
    out.get(r.key).add(r.pageId);
  }
  return out;
}

function completePageDeletions(workspaceDir, appUniqueName, ids, environment) {
  const root = workspaceRoot(workspaceDir);
  if (!root) return;
  const done = new Set(ids.map((id) => String(id).toLowerCase()));
  const state = readPageOwnership(root, appUniqueName, environment);
  for (const r of [...state.created, ...state.teardown]) {
    if (!done.has(r.pageId)) continue;
    const file = recordName(r);
    try {
      readRecord(root, file);
      fs.unlinkSync(path.join(root, file));
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

function checkPageOwnershipClearable(workspaceDir) {
  let records;
  try { records = readAllRecords(workspaceDir); } catch (e) {
    return { ok: false, reason: `local page ownership records could not be checked (${e.message}); preserve this workspace and resolve its records before clearing` };
  }
  if (!records.length) return { ok: true };
  const root = path.resolve(workspaceDir);
  const remaining = records.map((r) => `${path.join(root, recordName(r))}: ${r.appUniqueName}/${r.key || '(navigation)'}, page ${r.pageId}, ${r.kind}, environment ${r.environmentFingerprint}`).join('; ');
  return { ok: false, reason: `unconsumed local page ownership records remain: ${remaining}. Preserve the workspace; resume teardown in the original app and environment. Teardown consumes a record when it deletes the page or confirms its absence. A record whose page you have confirmed gone may be deleted by hand, then re-run --clear-workspace. Do not relabel records to another environment.` };
}

module.exports = { PREFIX, environmentFingerprint, readPageOwnership, recordPageCreation, recordPageTeardown, creationIds, completePageDeletions, checkPageOwnershipClearable };
