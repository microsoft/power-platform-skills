'use strict';
// Which pages a build has PUBLISHED — with what content, and in what state their files were — kept in the build's workspace so that a rebuild does not publish a page that is already live.
//
// A full rebuild sends every page, and a page that already holds what the spec asks for is not written (lib/genpage-sdk.js `update`). It used to be PUBLISHED all the same, because the
// server holds nothing that says whether an earlier run's publish of a page finished: a page saved by a run whose publish failed, or was never seen to take effect, has to be published
// by the next one. Each of those is one PublishXml of several seconds, so an unchanged app paid one per page on every rebuild. The question cannot be asked of the server cheaply — the
// SDK can read a page's published copy, but only by reading the page's row and every one of its files, twice, to prove the read is one state — so the build keeps the answer itself.
//
// After a publish that was SEEN to take effect (`publish.kind` `verified`) it records, per page, two things:
//   fingerprint  the hash of the content the page was published with (`contentFingerprint`): what the build WROTE, which the next `update` compares with what the page holds
//   files        the versionnumber of EVERY file row of the page, as the PLAIN collection answers it right after that publish (genpage.fileVersions): what the page's published copy WAS
// A page skips its publish only when the page holds that content (the fingerprint, in `update`) AND the file rows read now are exactly the recorded set with the recorded versions
// (`sameFileVersions`, in the build). The fingerprint alone says what this workspace sent; it cannot say that nobody has published anything else since. A page published from another
// workspace, another machine or Maker, and then put back to the file's content as a draft, holds the content and is NOT live — and the fingerprint matches. The versions are what moved.
//
// MEASURED on a real environment (a page is a `uxagentprojects` row and its `uxagentprojectfiles` rows; `versionnumber` read with a plain GET):
//   1. Publishing new content moves the versionnumber of each file row whose content changed; a file row whose content did not change keeps its own. The PAGE row's versionnumber does not move for
//      a change to files and a publish (it moved in an SDK update only because that update also wrote the row).
//   2. A draft-only write of a file's content (no publish) moves that file's versionnumber in BOTH reads: a plain GET (the published layer) answers a new version, and RetrieveUnpublishedMultiple
//      answers another new version, with componentstate 1.
//   3. Publishing that draft moves it again; both layers then agree (componentstate 0). Nothing moves on its own.
// So a file row's version in the PLAIN read changes when anyone changes the file — saved or published — and stays put otherwise. The layer matters only in being the SAME one: the record is made
// with the plain read and checked with the plain read (genpage.fileVersions is the one reader), because the two layers answer different numbers for a draft (fact 2) and would never compare equal.
//
// Everything that is not a clear "yes" is a "no", and a "no" costs one publish: no file, a file that cannot be read or is damaged, one written for another app or environment, a page with
// no entry, an entry for other content (the spec changed, or the page's publish did not finish after it was written), an entry with no versions (one in the format an earlier build of this release wrote, or one whose
// versions could not be read after the publish), a read of the versions that fails or cannot be taken as one consistent set, a file row that was added, removed or moved, and a publish that
// was accepted but not seen to take effect. So the file is a cache that can only ever be wrong in one direction — a publish that did not need to happen — with one residual: what the
// versions of the FILE rows cannot show. The page row's own fields (its name, kept in the project row, not in a file) are not covered, so a page renamed from elsewhere and published, then
// renamed back as a draft, is not seen. The release before pages went through the SDK re-uploaded and re-published every page of a full rebuild (through the CLI), so the cost of a publish
// per page was paid on every rebuild; this record is what removes it, and the residual above is what it costs.
//
// One file per app and environment, beside the page-ownership records but not one of them — it grants and blocks nothing, and is not read by anything that decides what may be updated or
// deleted — named by the hash of that pair, so another app or environment in the same folder has a file of its own:
//   page-published.<64 hex>.json
//   { "schemaVersion": 2, "environmentFingerprint": "<sha256 of the origin>", "appUniqueName": "contoso_app",
//     "pages": { "11111111-1111-4111-8111-111111111111": { "fingerprint": "<sha256 of the content published>",
//                                                           "files": { "22222222-2222-4222-8222-222222222222": "1234567", … } } } }
// A file of schema version 1 (the format an earlier build of this release wrote — no release shipped it: `"pages": { "<id>": "<sha256>" }`, no versions) is read as entries with no `files`, which never skip a publish.
// Written atomically (a crash leaves the old file or the new one), so a half-written file is never read as a record.
const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('./hash.js');
const { writeFileAtomic } = require('./apply-snapshot-store.js');
const { environmentFingerprint, workspaceRoot } = require('./page-ownership-records.js');

const PREFIX = 'page-published.';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
// A versionnumber is a 64-bit integer (Edm.Int64); it is kept as the digits it was read as, so no precision is lost on the way through JSON.
const VERSION = /^[0-9]{1,19}$/;
// One 64-character hash, a GUID and a handful of file rows per page: a file much larger than any app's pages could need is not a record of this kind, and is not read.
const MAX_BYTES = 1 << 20;

function recordFile(root, fingerprint, app) {
  return path.join(root, `${PREFIX}${sha256(JSON.stringify([fingerprint, app]))}.json`);
}

// Where the record of `appUniqueName` in `environment` is kept — for a caller that has to point at it (a test, an operator's note), never to read it: readPublishedPages is the reader.
function publishedRecordPath(workspaceDir, appUniqueName, environment) {
  return recordFile(path.resolve(workspaceDir), environmentFingerprint(environment), String(appUniqueName || '').toLowerCase());
}

// The file rows of an entry as Map<row id, version>, or null when the entry has no usable set: absent, not an object, empty (a page always has file rows, so none is not a state anyone saw),
// or with a key that is not a row id or a value that is not a version — the set is then not trusted at all, never trimmed to the rows that look right.
function filesOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length) return null;
  const files = new Map();
  for (const [id, version] of entries) {
    if (!GUID.test(id) || typeof version !== 'string' || !VERSION.test(version)) return null;
    files.set(id, version);
  }
  return files;
}

// The pages `appUniqueName` is known to have published in `environment`, as Map<page id (lower case), { fingerprint, files }>: `files` is Map<file row id, version> or null for an entry that
// has none. It never throws and never fails a build: whatever stops the file from being read — a missing workspace, a link where the file should be, a damaged file — is an empty map,
// which is "nothing is known to be published".
function readPublishedPages(workspaceDir, appUniqueName, environment) {
  const known = new Map();
  if (!workspaceDir) return known;
  try {
    const root = workspaceRoot(workspaceDir);
    if (!root) return known;
    const fingerprint = environmentFingerprint(environment);
    const app = String(appUniqueName || '').toLowerCase();
    const file = recordFile(root, fingerprint, app);
    // A plain, unlinked file of a sane size, as the page-ownership records are read: a record that another location can alter, or a file that is not one, says nothing.
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > MAX_BYTES) return known;
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record || (record.schemaVersion !== 1 && record.schemaVersion !== 2) || record.environmentFingerprint !== fingerprint || record.appUniqueName !== app
      || !record.pages || typeof record.pages !== 'object' || Array.isArray(record.pages)) return known;
    for (const [id, entry] of Object.entries(record.pages)) {
      if (!GUID.test(id)) continue;
      if (record.schemaVersion === 1) {
        if (typeof entry === 'string' && HASH.test(entry)) known.set(id, { fingerprint: entry, files: null });
      } else if (entry && typeof entry === 'object' && typeof entry.fingerprint === 'string' && HASH.test(entry.fingerprint)) {
        known.set(id, { fingerprint: entry.fingerprint, files: filesOf(entry.files) });
      }
    }
  } catch { /* an unreadable record is "nothing is known": the pages are published, as they were before there was a record */ }
  return known;
}

// Replace the record of `appUniqueName` in `environment` with `published` (a Map of page id to { fingerprint, files }, `files` a Map<file row id, version> or absent). The caller keeps the whole map
// and prunes it to the pages the app still has, so the file stays as small as the app. Throws what the write throws — the caller decides it is only a warning: a record that could not be
// written costs the next build one publish per page.
function writePublishedPages(workspaceDir, appUniqueName, environment, published) {
  const root = workspaceRoot(workspaceDir, true);
  const fingerprint = environmentFingerprint(environment);
  const app = String(appUniqueName || '').toLowerCase();
  const pages = {};
  // Sorted, so the same pages are the same bytes whatever order they were published in.
  for (const [id, entry] of [...published].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!GUID.test(id) || !entry || !HASH.test(entry.fingerprint)) continue;
    const files = entry.files instanceof Map ? entry.files : (entry.files ? new Map(Object.entries(entry.files)) : null);
    const recorded = files ? filesOf(Object.fromEntries([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))) : null;
    pages[id] = { fingerprint: entry.fingerprint, ...(recorded ? { files: Object.fromEntries(recorded) } : {}) };
  }
  writeFileAtomic(recordFile(root, fingerprint, app), `${JSON.stringify({ schemaVersion: 2, environmentFingerprint: fingerprint, appUniqueName: app, pages })}\n`);
}

// Whether the file rows read now are exactly the ones recorded, each with the version it had: the same rows, no more and no fewer, and no version moved. `recorded` and `current` are
// Map<file row id, version>; anything else — no record, a read that was not one consistent set (`null`) — is not "the same", because a set nobody could read says nothing.
function sameFileVersions(recorded, current) {
  if (!(recorded instanceof Map) || !(current instanceof Map) || !recorded.size || recorded.size !== current.size) return false;
  for (const [id, version] of recorded) if (current.get(id) !== version) return false;
  return true;
}

module.exports = { PREFIX, readPublishedPages, writePublishedPages, publishedRecordPath, sameFileVersions };
