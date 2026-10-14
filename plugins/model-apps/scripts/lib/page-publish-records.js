'use strict';
// Which pages a build has PUBLISHED, and with what content — kept in the build's workspace so that a rebuild does not publish a page that is already live.
//
// A full rebuild sends every page, and a page that already holds what the spec asks for is not written (lib/genpage-sdk.js `update`). It used to be PUBLISHED all the same, because the
// server holds nothing that says whether an earlier run's publish of a page finished: a page saved by a run whose publish failed, or was never seen to take effect, has to be published
// by the next one. Each of those is one PublishXml of several seconds, so an unchanged app paid one per page on every rebuild. The question cannot be asked of the server cheaply — the
// SDK can read a page's published copy, but only by reading the page's row and every one of its files, twice, to prove the read is one state — so the build keeps the answer itself.
// After a publish that was SEEN to take effect (`publish.kind` `verified`) it records the hash of the content the page was published with (`contentFingerprint`), and hands that hash back
// to the next `update`, which publishes a page it finds already holding the content only when the hash it was given is not that content's.
//
// Everything that is not a clear "yes" is a "no", and a "no" costs one publish: no file, a file that cannot be read or is damaged, one written for another app or environment, a page
// with no entry, an entry for other content (the spec changed, or the page's publish did not finish after it was written), and a publish that was accepted but not seen to take effect.
// So the file is a cache that can only ever be wrong in one direction — a publish that did not need to happen — except in one case: the page's PUBLISHED copy was changed outside this
// workspace while its draft was left equal to the file. A maker's save changes the draft, which then differs from the file, and the rebuild writes and publishes it; and before pages went
// through the SDK an unchanged page was not published at all, so this is no new exposure.
//
// One file per app and environment, beside the page-ownership records but not one of them — it grants and blocks nothing, and is not read by anything that decides what may be updated or
// deleted — named by the hash of that pair, so another app or environment in the same folder has a file of its own:
//   page-published.<64 hex>.json
//   { "schemaVersion": 1, "environmentFingerprint": "<sha256 of the origin>", "appUniqueName": "contoso_app",
//     "pages": { "11111111-1111-4111-8111-111111111111": "<sha256 of the content published>" } }
// Written atomically (a crash leaves the old file or the new one), so a half-written file is never read as a record.
const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('./hash.js');
const { writeFileAtomic } = require('./apply-snapshot-store.js');
const { environmentFingerprint, workspaceRoot } = require('./page-ownership-records.js');

const PREFIX = 'page-published.';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
// One 64-character hash and a GUID per page: a file much larger than any app's pages could need is not a record of this kind, and is not read.
const MAX_BYTES = 1 << 20;

function recordFile(root, fingerprint, app) {
  return path.join(root, `${PREFIX}${sha256(JSON.stringify([fingerprint, app]))}.json`);
}

// Where the record of `appUniqueName` in `environment` is kept — for a caller that has to point at it (a test, an operator's note), never to read it: readPublishedPages is the reader.
function publishedRecordPath(workspaceDir, appUniqueName, environment) {
  return recordFile(path.resolve(workspaceDir), environmentFingerprint(environment), String(appUniqueName || '').toLowerCase());
}

// The pages `appUniqueName` is known to have published in `environment`, as Map<page id (lower case), content fingerprint>. It never throws and never fails a build: whatever stops the
// file from being read — a missing workspace, a link where the file should be, a damaged file — is an empty map, which is "nothing is known to be published".
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
    if (!record || record.schemaVersion !== 1 || record.environmentFingerprint !== fingerprint || record.appUniqueName !== app
      || !record.pages || typeof record.pages !== 'object' || Array.isArray(record.pages)) return known;
    for (const [id, hash] of Object.entries(record.pages)) {
      if (GUID.test(id) && typeof hash === 'string' && HASH.test(hash)) known.set(id, hash);
    }
  } catch { /* an unreadable record is "nothing is known": the pages are published, as they were before there was a record */ }
  return known;
}

// Replace the record of `appUniqueName` in `environment` with `published` (a Map of page id to content fingerprint). The caller keeps the whole map and prunes it to the pages the app still
// has, so the file stays as small as the app. Throws what the write throws — the caller decides it is only a warning: a record that could not be written costs the next build one publish per page.
function writePublishedPages(workspaceDir, appUniqueName, environment, published) {
  const root = workspaceRoot(workspaceDir, true);
  const fingerprint = environmentFingerprint(environment);
  const app = String(appUniqueName || '').toLowerCase();
  const pages = {};
  // Sorted, so the same pages are the same bytes whatever order they were published in.
  for (const [id, hash] of [...published].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (GUID.test(id) && HASH.test(hash)) pages[id] = hash;
  }
  writeFileAtomic(recordFile(root, fingerprint, app), `${JSON.stringify({ schemaVersion: 1, environmentFingerprint: fingerprint, appUniqueName: app, pages })}\n`);
}

module.exports = { PREFIX, readPublishedPages, writePublishedPages, publishedRecordPath };
