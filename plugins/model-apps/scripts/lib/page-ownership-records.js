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
  // A pending record is one per create sent under the id — its name and source are part of what it identifies — where the others are one per page.
  const identity = [r.environmentFingerprint, r.appUniqueName, r.key, r.pageId, ...(r.kind === 'pending' ? [r.name, r.sourceSha256] : [])];
  return `${PREFIX}${r.kind}.${sha256(JSON.stringify(identity))}.json`;
}

// Example: { schemaVersion:2, kind:"created", appUniqueName:"contoso_app", key:"overview",
// pageId:"11111111-1111-4111-8111-111111111111", name:"Overview", environmentFingerprint:"<sha256>" }.
// Baselines and journals include adopted/downloaded ids; only an acknowledged CREATE writes "created".
// A "pending" record has the same shape plus `sourceSha256`, and is written BEFORE a create is sent, under the page id the build minted for it: it says "a create
// of this key under this id, carrying this name and this source, may have reached the environment", which is all a build that was cut short needs to find the page
// again and to tell it from any other page that comes to hold the id. It is intent, not ownership — it never authorizes anything (see readPendingCreations).
//   { schemaVersion:2, kind:"pending", appUniqueName:"contoso_app", key:"overview", pageId:"11111111-…", name:"Overview",
//     environmentFingerprint:"<sha256>", sourceSha256:"<sha256 of the page source that create sent>" }
// WHY the name and the source, and not the whole create: they are what a page read back serves exactly as it was written (the SDK stores both verbatim), so "this page holds
// what a create under this id sent" is decided by an exact comparison; a model, the data sources, the bindings and the prompt pass through projections that normalize them,
// and a proof that depended on them could refuse the very page it is meant to recognise. What a page holds beyond that is not part of recognising it — it is brought to
// what the build asks for by the ordinary update. One record per create that was sent under the id: a resumed create with another name or source adds a record, and
// the earlier one stays, because the page may hold either.
const SOURCE_HASH = FINGERPRINT; // both are a SHA-256 in lower-case hex
function validRecord(r) {
  return r && r.schemaVersion === 2 && FINGERPRINT.test(r.environmentFingerprint)
    && ['created', 'teardown', 'pending'].includes(r.kind)
    && Object.keys(r).length === (r.kind === 'pending' ? 8 : 7)
    && (r.kind !== 'pending' || (typeof r.sourceSha256 === 'string' && SOURCE_HASH.test(r.sourceSha256)))
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
    // resolveAppSource re-inspects the record after the lstat above and wraps a file that vanished
    // in between as APP_SOURCE_PATH with the original ENOENT as its cause. That is the same
    // retirement readAllRecords skips, so report it as ENOENT; every other refusal keeps its code.
    const vanished = cause.code === 'ENOENT' || (cause.code === 'APP_SOURCE_PATH' && cause.cause && cause.cause.code === 'ENOENT');
    if (vanished) error.code = 'ENOENT';
    else if (cause.code) error.code = cause.code;
    throw error;
  }
}

// The exact name recordName() produces: page-ownership.<kind>.<64 hex>.json. Anything else in the
// folder — an editor backup such as page-ownership.created.<hash>.backup.json, a temp file — is
// not a record and is ignored, rather than halting every build as a malformed one.
const RECORD_FILE = /^page-ownership\.(created|teardown|pending)\.[0-9a-f]{64}\.json$/;

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
    // A pending creation is intent, not ownership: it is not part of what a receipt proves, so it is not part of this state (readPendingCreations).
    if (r.kind === 'pending') continue;
    if (r.environmentFingerprint === fingerprint && r.appUniqueName === app) state[r.kind].push(r);
  }
  return state;
}

function saveRecord(workspaceDir, kind, appUniqueName, key, pageId, name, environment, sourceSha256) {
  if (!workspaceDir) throw new Error('a build workspace is required to persist local page ownership');
  const r = { schemaVersion: 2, kind, appUniqueName: String(appUniqueName || '').toLowerCase(), key: key || null, pageId: String(pageId || '').toLowerCase(), name, environmentFingerprint: environmentFingerprint(environment), ...(kind === 'pending' ? { sourceSha256 } : {}) };
  if (!validRecord(r)) throw new Error(kind === 'pending' ? 'a pending page creation needs an app unique name, page key, page GUID, the name sent and the SHA-256 of the source sent' : 'local page ownership record needs an app unique name, page key, page GUID and stored name');
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

// Written BEFORE a page create is sent, durably, under the id the create will use, with the name and the source hash it sends. A create whose answer never arrives — and
// whose page cannot be read back either — leaves the page on the environment with nothing local that names it; the next build then finds a page it has no link to, and creates another
// for the same spec entry. This record is the link: the next build reads the id it names (readPendingCreations), and either finds the page there — and adopts it only if it
// holds what a create under that id sent — or does not, and creates it under the SAME id.
function recordPagePending(workspaceDir, appUniqueName, key, pageId, name, environment, sourceSha256) {
  return saveRecord(workspaceDir, 'pending', appUniqueName, key, pageId, name, environment, sourceSha256);
}

// The creations this app started in this environment and never acknowledged, as Map<key, [{ pageId, sent: [{ name, sourceSha256 }] }]> — one entry per page id, `sent` the
// name and source hash of every create that was sent under it (a build resumed under the same id with another name or source adds one; the page may hold either).
// A pending record is INTENT, and grants nothing: it is not a creation receipt, so it never makes a page this build "owns" (readPageOwnership and creationIds do not see
// it) and never authorizes an update. A delete needs more than the record: teardown deletes a page found under a pending id only when its stored name is one the
// create sent. What a build may do with one is settle it — adopt the page it names, after proving it holds what was sent, or send the create again under that id.
function readPendingCreations(workspaceDir, appUniqueName, environment) {
  const pending = new Map();
  if (!workspaceDir) return pending;
  const fingerprint = environmentFingerprint(environment);
  const app = String(appUniqueName || '').toLowerCase();
  for (const r of readAllRecords(workspaceDir)) {
    if (r.kind !== 'pending' || r.environmentFingerprint !== fingerprint || r.appUniqueName !== app) continue;
    if (!pending.has(r.key)) pending.set(r.key, []);
    const entries = pending.get(r.key);
    let entry = entries.find((e) => e.pageId === r.pageId);
    if (!entry) { entry = { pageId: r.pageId, sent: [] }; entries.push(entry); }
    entry.sent.push({ name: r.name, sourceSha256: r.sourceSha256 });
  }
  // The files come back in the order of their hashed names: sorted, so what a message says does not depend on it.
  const byText = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  for (const entries of pending.values()) {
    entries.sort((a, b) => byText(a.pageId, b.pageId));
    for (const entry of entries) entry.sent.sort((a, b) => byText(`${a.name}\n${a.sourceSha256}`, `${b.name}\n${b.sourceSha256}`));
  }
  return pending;
}

// A pending record is consumed once what it stood for is SETTLED BY EVIDENCE: the page was created and acknowledged (a creation receipt now says so), adopted as the
// page that was sent, found and deleted by teardown, or the create is known to have written nothing (the SDK refused it before it sent anything). Never because a page
// is not in one listing: an absence is a snapshot, and a request still in flight can create the page after it — whatever the spec key has been bound to since. Consuming
// the record before then would forget a page that may exist, which is what it is written to prevent.
function completePendingCreations(workspaceDir, appUniqueName, pageIds, environment) {
  const root = workspaceRoot(workspaceDir);
  if (!root) return;
  const done = new Set(pageIds.map((id) => String(id).toLowerCase()));
  const fingerprint = environmentFingerprint(environment);
  const app = String(appUniqueName || '').toLowerCase();
  for (const r of readAllRecords(root)) {
    if (r.kind !== 'pending' || r.environmentFingerprint !== fingerprint || r.appUniqueName !== app || !done.has(r.pageId)) continue;
    const file = recordName(r);
    try {
      readRecord(root, file);
      fs.unlinkSync(path.join(root, file));
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
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
  // A pending record is the only pointer to a page whose create was cut short, so it is kept like a receipt — and says how it is settled. The record is kept, never dropped on
  // the evidence of one listing: the request that made it may still reach the service, and the page it makes would then have no local trace.
  const pending = records.some((r) => r.kind === 'pending')
    ? ' A "pending" record is a page creation that was started and never acknowledged — the page may exist, or may still appear: run the build again in the original app and environment (it adopts the page if it is there and is the one that was sent, creates it under the same id while its key has no page, and reports it as an unused page when the key is bound to another one — teardown deletes it too), or delete the record by hand once you have confirmed that no such page exists, here or in Maker, and that no request can still create it.'
    : '';
  return { ok: false, reason: `unconsumed local page ownership records remain: ${remaining}. Preserve the workspace; resume teardown in the original app and environment. Teardown consumes a record when it deletes the page or confirms its absence. A record whose page you have confirmed gone may be deleted by hand, then re-run --clear-workspace. Do not relabel records to another environment.${pending}` };
}

module.exports = { PREFIX, environmentFingerprint, workspaceRoot, readPageOwnership, recordPageCreation, recordPagePending, readPendingCreations, completePendingCreations, recordPageTeardown, creationIds, completePageDeletions, checkPageOwnershipClearable };
