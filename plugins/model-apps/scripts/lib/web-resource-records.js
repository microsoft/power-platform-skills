'use strict';
// The web resources a build WROTE and could not confirm were published, kept in the build's workspace so that the next run writes them again.
//
// The bundled SDK writes a web resource, publishes it, and reads its PUBLISHED content back (a plain GET by id); when the publish fails or the
// read-back cannot confirm what was written, it throws WEB_RESOURCE_UNVERIFIED — after the row exists, with the row's id (`error.id`). What the
// build does with the error is in lib/sdk-build.js (writeOwnedWebResource, persistPageManifest). What it needs from a run that FOLLOWS — the
// build's own re-run of a transient halt, and a new invocation — is to know that the row of that name is one this plugin wrote and could not
// confirm, so that it writes the content again by id (`updateWebResource(id, { content })`, which publishes and verifies again) instead of
// reusing it untouched as it reuses any web resource that exists. (The page manifest is compared with its published copy on every run, and kept
// where that copy already holds what the run would write; for it the record supplies the id of a manifest no plain read finds, and keeps its
// name from being created again.) The server holds nothing that says so: a same-named row can be another
// maker's; its name alone grants no right to overwrite it. So the build keeps the id of its own write rather than inferring ownership from content or a name.
//
// Under the customization lock, a later accepted publish was observed publishing the OLD content after earlier lock-refused publishes,
// although the content PATCH had answered 204.
// Publishing again alone therefore may not recover the write: the content is written again once the lock frees. This does not claim every failure lost content.
//
// One file per environment, named by the hash of the environment's fingerprint (a web resource's name is unique in an environment, so the name
// is the identity and no app is part of the key):
//   web-resource-unconfirmed.<64 hex>.json
//   { "schemaVersion": 1, "environmentFingerprint": "<sha256 of the origin>",
//     "webResources": { "contoso_/scripts/form.js": "11111111-1111-4111-8111-111111111111", … },
//     "revisions": { "contoso_/scripts/form.js": "0f1e2d3c4b5a6978", … } }
// An entry is written BEFORE anything else the build does about the error (the add to the solution, the halt), and removed only once a write by
// that id was verified and the row is in the solution again. A file that cannot be read — damaged, a link where the file should be, too large —
// is "nothing is recorded", which is what the build did before there was a record: the rows are reused as they are. Written atomically.
//
// Builds that share a workspace and an environment share this file, and each change replaces it whole. So a change is never made to what a run
// read earlier — another build may have written its own entry since, and writing the earlier copy back dropped it (A notes `a`, B notes `b`: only
// `b` was left; A then clears `a`: the file went, `b` with it). A change takes the record's writer lease (lib/record-lease.js), reads the file as it
// is then, applies its one change to that, and writes it: a note adds or replaces one entry, a clear removes one, and neither touches another
// build's. Reads take no lease.
//
// An id alone does not tell one build's entry from another's: the row is the same row, so a build that writes it again and cannot confirm that
// write either records the SAME id. A clear by a build that verified an EARLIER write of it would then remove the newer entry — the only trace of a
// write nothing has confirmed — and the next build would reuse the row untouched. So each note also records a revision, minted for that note
// (`revisions`, 16 hex characters, beside `webResources` so that the name-to-id map keeps its shape), and a clear removes an entry only while it
// holds the id AND the revision this build knows; an entry noted since by another build is left for that build, or for the next run, to write
// again. An entry with no revision — one written before there were revisions — is matched by its id alone, as it always was.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sha256 } = require('./hash.js');
const { writeFileAtomic } = require('./apply-snapshot-store.js');
const { environmentFingerprint, workspaceRoot } = require('./page-ownership-records.js');
const { withRecordLease } = require('./record-lease.js');

const PREFIX = 'web-resource-unconfirmed.';
const SCHEMA_VERSION = 1;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVISION = /^[0-9a-f]{16}$/;
// A handful of names and ids: a file much larger than any spec's web resources could need is not a record of this kind.
const MAX_BYTES = 1 << 20;

const recordFile = (root, fingerprint) => path.join(root, `${PREFIX}${sha256(fingerprint)}.json`);
// Names are compared as Dataverse compares them, without regard to case; the record keeps the name as the build wrote it.
const keyOf = (name) => String(name).toLowerCase();
const mintRevision = () => crypto.randomBytes(8).toString('hex');
// The same entry: the same id and the same revision — none on either side is the same as none.
const sameEntry = (a, b) => Boolean(a) && Boolean(b) && a.id === b.id && (a.rev || '') === (b.rev || '');

// Where the record of `environment` is kept — for a caller that has to point at it (a message, a test), never to read it.
function unconfirmedRecordPath(workspaceDir, environment) {
  return recordFile(path.resolve(workspaceDir), environmentFingerprint(environment));
}

// The recorded web resources of `environment`, as Map<lower-cased name, { name, id, rev? }>. Throws what stops the file from being read (the caller
// decides that is only a warning); a workspace or a file that does not exist is an empty map. A revision that is missing or not one the build
// writes is no revision: the entry is then matched by its id alone.
function readUnconfirmedWebResources(workspaceDir, environment) {
  const known = new Map();
  const root = workspaceRoot(workspaceDir);
  if (!root) return known;
  const fingerprint = environmentFingerprint(environment);
  const file = recordFile(root, fingerprint);
  let stat;
  try { stat = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return known; throw e; }
  // A plain, unlinked file of a sane size, as the page records are read: a record another location can alter, or a file that is not one, says nothing.
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > MAX_BYTES) throw new Error(`${file} is not a plain file of a web-resource record`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!record || record.schemaVersion !== SCHEMA_VERSION || record.environmentFingerprint !== fingerprint
    || !record.webResources || typeof record.webResources !== 'object' || Array.isArray(record.webResources)) {
    throw new Error(`${file} is not a web-resource record this build can read`);
  }
  const revisions = record.revisions && typeof record.revisions === 'object' && !Array.isArray(record.revisions) ? record.revisions : {};
  for (const [name, id] of Object.entries(record.webResources)) {
    if (!(name && typeof id === 'string' && GUID.test(id))) continue;
    const rev = Object.prototype.hasOwnProperty.call(revisions, name) && typeof revisions[name] === 'string' && REVISION.test(revisions[name]) ? revisions[name] : undefined;
    known.set(keyOf(name), { name, id, ...(rev ? { rev } : {}) });
  }
  return known;
}

// Replace the record of `environment` with `entries` (the Map readUnconfirmedWebResources answers); an empty map removes the file. It takes no lease:
// a caller that shares the workspace with another build holds the record's lease across its read and this write (openUnconfirmedWebResources).
function writeUnconfirmedWebResources(workspaceDir, environment, entries) {
  const fingerprint = environmentFingerprint(environment);
  if (!entries.size) {
    const root = workspaceRoot(workspaceDir);
    if (!root) return;
    try { fs.unlinkSync(recordFile(root, fingerprint)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return;
  }
  const root = workspaceRoot(workspaceDir, true);
  const webResources = {};
  const revisions = {};
  // Sorted, so the entries are written in the same order whatever order they were recorded in.
  for (const { name, id, rev } of [...entries.values()].sort((a, b) => (keyOf(a.name) < keyOf(b.name) ? -1 : 1))) {
    webResources[name] = id;
    if (rev) revisions[name] = rev;
  }
  // No revision, no key: a record of entries without one is written exactly as before there were revisions.
  const record = { schemaVersion: SCHEMA_VERSION, environmentFingerprint: fingerprint, webResources, ...(Object.keys(revisions).length ? { revisions } : {}) };
  writeFileAtomic(recordFile(root, fingerprint), `${JSON.stringify(record)}\n`);
}

/**
 * The record for one run of the build: read once, then each change made to the file as it is then, under the record's writer lease. `idOf(name)`
 * is the id an earlier run recorded for the name (what this run read, with its own changes); `note(name, id)` records one, under a revision minted
 * for that note, and answers whether that is now on disk; `clear(name)` removes the entry this run knows — the same id and revision — and leaves
 * one another build has noted since, the same id included. `note` does not replace an entry another build recorded since this run read the record,
 * under another id: that is said once, and it answers false. None of them throws: a workspace that cannot be written, or a lease another build holds
 * past the bounded wait, is said once on `warn`, and a run without a workspace or an environment (a caller that gives neither; the CLI always gives
 * both) records nothing — `note` then answers false. `lease` is for tests: the lib/record-lease.js seams.
 */
function openUnconfirmedWebResources({ workspaceDir, environment, warn, lease } = {}) {
  const usable = Boolean(workspaceDir) && Boolean(environment);
  let entries;
  let warned = false;
  const say = (message) => {
    if (warned || typeof warn !== 'function') return;
    warned = true;
    warn(message);
  };
  const unreadable = (e) => `the record of the web resources an earlier build could not confirm were published could not be read (${(e && e.message) || e}), so this build reuses every web resource that exists as it is`;
  const load = () => {
    if (entries) return entries;
    entries = new Map();
    if (!usable) return entries;
    try { entries = readUnconfirmedWebResources(workspaceDir, environment); } catch (e) { say(unreadable(e)); }
    return entries;
  };
  // One change, made under the record's lease to the record as it is on disk now — never to this run's copy, which another build may have changed
  // since. `apply(disk, file)` changes the Map it is given and answers true when there is something to write, false when there is not, null when the
  // record holds another build's newer entry that this change leaves as it is, or the reason this run's change is refused (a string, said once).
  // Answers true when the change is made, null when another build's entry was left, false otherwise. `create` is false for a removal: a workspace
  // that is not there holds nothing to remove, and is not made for it.
  const change = (apply, create = true) => {
    if (!usable) return false;
    let verdict;
    try {
      const root = workspaceRoot(workspaceDir, create);
      if (!root) return true;
      const file = recordFile(root, environmentFingerprint(environment));
      const leased = withRecordLease(root, path.basename(file), () => {
        let disk;
        // Unreadable now, as a first read can be (load, above): nothing is recorded, and a change replaces the file — what a note always did.
        try { disk = readUnconfirmedWebResources(workspaceDir, environment); } catch (e) { say(unreadable(e)); disk = new Map(); }
        const answer = apply(disk, file);
        if (answer === true) writeUnconfirmedWebResources(workspaceDir, environment, disk);
        return answer;
      }, lease);
      if (!leased.ok) throw new Error(leased.reason);
      verdict = leased.value;
    } catch (e) {
      say(`the record of the web resources this build could not confirm were published could not be written (${(e && e.message) || e})`);
      return false;
    }
    if (typeof verdict === 'string') { say(verdict); return false; }
    return verdict === null ? null : true;
  };
  return {
    idOf: (name) => { const entry = load().get(keyOf(name)); return entry ? entry.id : undefined; },
    note: (name, id) => {
      if (!usable || !GUID.test(String(id).toLowerCase())) return false;
      const key = keyOf(name);
      // A revision of its own, even for an id the record holds already: this note is another write nothing has confirmed, and a clear by a build that
      // verified an earlier write must not take it (see the header).
      const entry = { name: String(name), id: String(id).toLowerCase(), rev: mintRevision() };
      const known = load().get(key);
      const made = change((disk, file) => {
        const held = disk.get(key);
        // Another build recorded this name since this run read the record, under another id: that entry is the other build's way back to the row it
        // wrote, and replacing it would lose it. Under the same id it is the same row, and this note — a later write of it — takes its place.
        if (held && held.id !== entry.id && !sameEntry(held, known)) {
          return `the record of the web resources builds could not confirm were published (${file}) already holds '${held.name}' as ${held.id}, which another build recorded since this one read it; it is left as it is, and this build's write of '${entry.name}' (${entry.id}) is not recorded`;
        }
        disk.set(key, entry);
        return true;
      });
      if (made === true) entries.set(key, entry);
      return made === true;
    },
    clear: (name) => {
      const key = keyOf(name);
      const known = load().get(key);
      if (!known) return;
      const made = change((disk) => {
        const held = disk.get(key);
        if (!held) return false;
        // Only the entry this run knows — its id AND its revision. One another build has noted since, the same row's id included, is a write that this
        // run's verification came before: it stays, for that build or the next run to write again.
        if (!sameEntry(held, known)) return null;
        disk.delete(key);
        return true;
      }, false);
      // Removed, or left for the build that noted it since: either way this run's own entry is no longer in the record.
      if (made !== false) entries.delete(key);
    },
  };
}

module.exports = { PREFIX, openUnconfirmedWebResources, readUnconfirmedWebResources, writeUnconfirmedWebResources, unconfirmedRecordPath };
