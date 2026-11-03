'use strict';
/**
 * The fragments file of an explicit managed download (download-model-app.js --include-managed --managed-manifest <store>).
 *
 * The managed restore (lib/declared-form-io.js restoreManagedForms, lib/declared-bpf-io.js restoreManagedBpfs) proves a
 * declared form or process flow against the environment and then has to leave some of them out of app-spec.json: the
 * declaration is proved, but it names something the download could not bring with it (the script library a form handler
 * calls, the persona a flow's securityRoles name), and a spec that names what it does not declare does not validate. Before
 * this file such an item was only named on stderr, and the maker had to rebuild the declaration from the spec it was built
 * from. Now each one is written here, ready to paste, with what it still needs.
 *
 * An item is written only when its declaration is PROVED and the dependency is its only blocker: the caller validates the
 * downloaded spec with the declaration and a stub for each missing dependency (see `stubWebResource` and `stubPersona`). The
 * stubs are never written anywhere. An item that is pending, unusable, unread, changed or invalid for any other reason gets
 * no fragment, because nothing proved it.
 *
 * The file:  <out>/.maker-workspace/managed-fragments.json  (the tool-owned folder the download's baseline is written to)
 *   { "kind": "model-apps.managed-download-fragments", "formatVersion": 1, "app": "<app unique name>", "note": "...",
 *     "items": [ { "family": "form" | "bpf", "key": "<store key>", "reason": "<why it was left out>",
 *                  "needs": [ { "webResource": "<name>" } | { "persona": "<name>" } ],
 *                  "paste": { "forms": [ <declaration> ] } | { "businessProcessFlows": [ <declaration> ] } } ] }
 * The items are sorted by family, then key, so two downloads of the same app write the same bytes. No environment, tenant or
 * user value is written: a declaration holds table, column and form names and ids that app-spec.json already holds.
 *
 * Ownership. The name is the download's, but the folder is the maker's app folder, so a file there may be one the download
 * did not write. The download never replaces, removes or writes through such a file:
 *   - `inspectFragmentsPath` answers absent | own | taken. `own` is a plain file with one name whose JSON carries this
 *     `kind` and format; everything else that is there (a maker's file, a folder, a link or junction at the file or at
 *     .maker-workspace, a hard link, a file that is not JSON) is `taken`, with why.
 *   - The download asks before it writes anything (download-model-app.js main) and refuses to start on `taken`, so a
 *     refusal leaves the app folder exactly as it was.
 *   - `settleFragments` asks again at the end: a missing file is CREATED exclusively (a name taken meanwhile is refused by the
 *     file system, never replaced), an own file is replaced through a temporary file and a rename (lib/safe-fs.js
 *     writeFileSafe, which refuses a link or a hard link planted there), and an own file is removed when there is nothing
 *     left to write, so a list from an earlier download cannot outlive it.
 */
const fs = require('fs');
const path = require('path');
const { assertSafeOutputDir, assertPlainFileTarget, writeFileSafe, removeFileSafe } = require('./safe-fs.js');

const FRAGMENTS_KIND = 'model-apps.managed-download-fragments';
const FRAGMENTS_FORMAT = 1;
const WORKSPACE_DIR = '.maker-workspace';
const FRAGMENTS_FILE = 'managed-fragments.json';
// An own file is small (declarations only); a larger file at this name is not one the download wrote, and is not read.
const MAX_OWN_BYTES = 16 * 1024 * 1024;
const NOTE = 'Managed items the download proved but left out of app-spec.json for what it could not bring. Add each "paste" entry to the same array in app-spec.json, together with what its "needs" lists (from the spec it was built from), then build.';

const fragmentsPath = (outDir) => path.join(path.resolve(outDir), WORKSPACE_DIR, FRAGMENTS_FILE);

function codeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * What is at the fragments name now. Inspect only: nothing is created, opened for writing or followed.
 * Answers { state: 'absent' } | { state: 'own' } | { state: 'taken', why }.
 */
function inspectFragmentsPath(file) {
  const dir = path.dirname(file);
  try {
    fs.lstatSync(dir);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { state: 'absent' };
    return { state: 'taken', why: `${WORKSPACE_DIR} could not be inspected (${(e && e.code) || e})` };
  }
  // A link or junction at .maker-workspace would put the file outside the app folder; a file there is no folder at all.
  try {
    assertSafeOutputDir(dir);
  } catch (e) {
    return { state: 'taken', why: (e && e.message) || String(e) };
  }
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { state: 'absent' };
    return { state: 'taken', why: `it could not be inspected (${(e && e.code) || e})` };
  }
  try {
    assertPlainFileTarget(file);
  } catch (e) {
    return { state: 'taken', why: (e && e.message) || String(e) };
  }
  if (st.size > MAX_OWN_BYTES) return { state: 'taken', why: 'it is larger than any fragments file a download writes' };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { state: 'taken', why: 'it is not a JSON file' };
  }
  if (!parsed || typeof parsed !== 'object' || parsed.kind !== FRAGMENTS_KIND || parsed.formatVersion !== FRAGMENTS_FORMAT) {
    return { state: 'taken', why: 'it is not a managed download fragments file' };
  }
  return { state: 'own' };
}

// The refusal for a name the download did not write. `written` says what is already on disk, for the end-of-run check.
function takenError(file, why, written = 'Nothing was written') {
  return codeError('managed-fragments-path-taken', `${file} exists and was not written by a download (${why}); move or delete it and run again. ${written}.`);
}

// Refuse a taken name before the download writes anything. Answers the path.
function assertFragmentsPathFree(outDir) {
  const file = fragmentsPath(outDir);
  const seen = inspectFragmentsPath(file);
  if (seen.state === 'taken') throw takenError(file, seen.why);
  return file;
}

const byFamilyThenKey = (a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

// The file's text: LF, 2-space indent, items sorted.
function fragmentsText(app, items) {
  const sorted = [...items].sort(byFamilyThenKey);
  return `${JSON.stringify({ kind: FRAGMENTS_KIND, formatVersion: FRAGMENTS_FORMAT, app: app || '', note: NOTE, items: sorted }, null, 2)}\n`;
}

/**
 * Write, replace or remove the fragments file for `items` (see the header for the ownership rules). Called after the spec
 * validated and before app-spec.json is written, so a refusal here leaves app-spec.json as it was.
 * Answers { file, keys: [{ family, key }] } when items were written, or null when there were none.
 * Throws `managed-fragments-path-taken` for a name the download did not write, `managed-fragments-unwritable` for a write
 * or removal that failed.
 */
function settleFragments(outDir, { app, items }) {
  const file = fragmentsPath(outDir);
  const written = 'app-spec.json was not written';
  const seen = inspectFragmentsPath(file);
  if (seen.state === 'taken') throw takenError(file, seen.why, written);
  const list = Array.isArray(items) ? items : [];
  try {
    if (!list.length) {
      if (seen.state === 'own') removeFileSafe(file);
      return null;
    }
    const text = fragmentsText(app, list);
    if (seen.state === 'absent') {
      assertSafeOutputDir(path.dirname(file), { create: true });
      writeFileSafe(file, text, { exclusive: true, encoding: 'utf8' });
    } else {
      writeFileSafe(file, text, { encoding: 'utf8' });
    }
  } catch (e) {
    // An exclusive create whose name was taken after the look: someone else's file, never replaced.
    if (e && e.code === 'IO_ERROR' && e.reason === 'exists') throw takenError(file, 'it appeared while the download ran', written);
    throw codeError('managed-fragments-unwritable', `${file} could not be written (${(e && e.message) || e}). ${written}.`);
  }
  return { file, keys: [...list].sort(byFamilyThenKey).map((i) => ({ family: i.family, key: i.key })) };
}

// The stand-ins a proof validates with: shape only, never written.
const stubWebResource = (name) => ({ name, type: 'js', content: '' });
const stubPersona = (name, entity) => ({ persona: name, jobs: [{ name: 'stub', privileges: [{ entity: String(entity || 'account').toLowerCase(), access: ['read'] }] }] });

module.exports = {
  FRAGMENTS_KIND,
  FRAGMENTS_FORMAT,
  fragmentsPath,
  inspectFragmentsPath,
  assertFragmentsPathFree,
  settleFragments,
  fragmentsText,
  stubWebResource,
  stubPersona,
};
