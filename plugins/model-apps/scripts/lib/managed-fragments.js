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
 *   - `settleFragments` decides first whether anything is due. With nothing due it removes an own file (so a list from an
 *     earlier download cannot outlive it) and leaves anything else at the name alone: a maker's file there never stops a
 *     download that has nothing to write there. With items due it refuses `taken`.
 *   - It is called after the restore and the validation and BEFORE the download publishes anything (download-model-app.js main
 *     stages the page tree and writes it, the spec and the baseline only after this), so a refusal or a failed write leaves the
 *     app folder as it was.
 *   - Writing never renames over the name: a missing file is CREATED exclusively (lib/safe-fs.js writeFileSafe `exclusive`, a
 *     hard link that the file system refuses when the name is taken). An own file is first proved writable (opened for
 *     writing; a read-only file is refused), then moved aside to a hidden sibling and checked there to be the very file that
 *     was inspected (the same file id, one name, the same bytes); only then is the new file created, exclusively, at the
 *     vacant name. A file that changed or was swapped in after the look is put back without replacing anything (a hard link
 *     again) and refused; a file that took the vacant name meanwhile is kept and refused. Removal is the same move aside and
 *     check, then the aside is unlinked. So the only name the download ever unlinks is a hidden one it made, holding the
 *     bytes it inspected as its own.
 *   - Because the exclusive create needs a second name for a file, a folder on a file system without hard links (FAT, some
 *     network shares) cannot hold the file: the write fails (`managed-fragments-unwritable`), and an own file is put back.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { assertSafeOutputDir, assertPlainFileTarget, writeFileSafe } = require('./safe-fs.js');

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
 * Answers { state: 'absent' } | { state: 'own', bytes, id } | { state: 'taken', why }. For an own file, `bytes` are the bytes read
 * and `id` the file's device and id (read with `bigint`: a Windows file id is 64 bits), which a replacement or removal checks again
 * on the file it moved aside before it trusts this answer.
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
    st = fs.lstatSync(file, { bigint: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return { state: 'absent' };
    return { state: 'taken', why: `it could not be inspected (${(e && e.code) || e})` };
  }
  try {
    assertPlainFileTarget(file);
  } catch (e) {
    return { state: 'taken', why: (e && e.message) || String(e) };
  }
  if (st.size > BigInt(MAX_OWN_BYTES)) return { state: 'taken', why: 'it is larger than any fragments file a download writes' };
  let bytes;
  let parsed;
  try {
    bytes = fs.readFileSync(file);
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { state: 'taken', why: 'it is not a JSON file' };
  }
  if (!parsed || typeof parsed !== 'object' || parsed.kind !== FRAGMENTS_KIND || parsed.formatVersion !== FRAGMENTS_FORMAT) {
    return { state: 'taken', why: 'it is not a managed download fragments file' };
  }
  return { state: 'own', bytes, id: { dev: st.dev, ino: st.ino } };
}

const NOTHING_WRITTEN = 'Nothing was written';

// The refusal for a name the download did not write.
function takenError(file, why) {
  return codeError('managed-fragments-path-taken', `${file} exists and was not written by a download (${why}); move or delete it and run again. ${NOTHING_WRITTEN}.`);
}

function unwritableError(file, e, kept) {
  const where = kept ? ` The file that was there is kept as ${kept}: move it back to ${path.basename(file)}.` : '';
  return codeError('managed-fragments-unwritable', `${file} could not be written (${(e && e.message) || (e && e.code) || e}).${where} ${NOTHING_WRITTEN}.`);
}

const byFamilyThenKey = (a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

// The file's text: LF, 2-space indent, items sorted.
function fragmentsText(app, items) {
  const sorted = [...items].sort(byFamilyThenKey);
  return `${JSON.stringify({ kind: FRAGMENTS_KIND, formatVersion: FRAGMENTS_FORMAT, app: app || '', note: NOTE, items: sorted }, null, 2)}\n`;
}

// A hidden sibling name unique to this process and call: where an own file is moved while it is checked and replaced.
const asideName = (file) => path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.aside`);

// Whether `aside` is still the own file inspected: a regular file with one name, the same device and file id (a file system that
// gives files no id, 0, is answered by the bytes alone), and the same bytes. Any doubt is "no".
function stillInspected(aside, seen) {
  try {
    const st = fs.lstatSync(aside, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n) return false;
    if (seen.id.ino !== 0n && (st.ino !== seen.id.ino || st.dev !== seen.id.dev)) return false;
    return fs.readFileSync(aside).equals(seen.bytes);
  } catch {
    return false;
  }
}

// Gives `aside` its name back without replacing anything that took the name meanwhile: a hard link (which fails with EEXIST on a
// taken name, POSIX link(2) / Windows CreateHardLinkW), then the aside name is dropped; what is not a file (a link or folder swapped in)
// is renamed back only into a name seen vacant. Answers null when it is back, else the code of what stopped it (the aside then stays).
function putBack(file, aside) {
  try {
    const st = fs.lstatSync(aside);
    if (st.isFile()) {
      try {
        fs.linkSync(aside, file);
      } catch (e) {
        if (e && e.code === 'EEXIST') return 'EEXIST';
        // No hard links here (FAT, some shares): only a rename is left, into a name that is vacant.
        return renameIntoVacant(file, aside);
      }
      try { fs.unlinkSync(aside); } catch { /* the file is back under its name; the aside is a second name of it */ }
      return null;
    }
    return renameIntoVacant(file, aside);
  } catch (e) {
    return (e && e.code) || String(e);
  }
}

function renameIntoVacant(file, aside) {
  try {
    fs.lstatSync(file);
    return 'EEXIST';
  } catch (e) {
    if (!(e && e.code === 'ENOENT')) return (e && e.code) || String(e);
  }
  try {
    fs.renameSync(aside, file);
    return null;
  } catch (e) {
    return (e && e.code) || String(e);
  }
}

// Moves the own file `seen` describes out of its name, and proves the file moved is that file. Answers { aside } when it is,
// { vanished: true } when the name was empty by then, or { changed: true, kept } when what was there is not the file inspected:
// it is put back (kept null) or, when that cannot be done without replacing something, left at `kept`. Throws
// managed-fragments-unwritable when the file cannot be written or moved (a read-only file is refused here, before it moves).
function setAside(file, seen) {
  // The write is proved possible before anything moves: a file the maker made read-only is not replaced or removed.
  try {
    fs.closeSync(fs.openSync(file, 'r+'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return { vanished: true };
    throw unwritableError(file, e);
  }
  const aside = asideName(file);
  try {
    fs.renameSync(file, aside);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { vanished: true };
    throw unwritableError(file, e);
  }
  if (stillInspected(aside, seen)) return { aside };
  return { changed: true, kept: putBack(file, aside) ? aside : null };
}

// Drops the aside name of an own file. Best-effort: what was asked is done, so a name that stays is a warning.
function dropAside(aside, onWarning) {
  try {
    fs.unlinkSync(aside);
  } catch (e) {
    if (e && e.code === 'ENOENT') return;
    if (typeof onWarning === 'function') onWarning(`the earlier fragments file, moved to ${aside}, could not be removed (${(e && e.code) || e}): delete it`);
  }
}

// Creates the file at a vacant name, exclusively: a name taken meanwhile is the file system's refusal, never replaced.
function createFragments(file, text, onWarning) {
  try {
    assertSafeOutputDir(path.dirname(file), { create: true });
    writeFileSafe(file, text, { exclusive: true, encoding: 'utf8', onWarning });
  } catch (e) {
    if (e && e.code === 'IO_ERROR' && e.reason === 'exists') throw takenError(file, 'it appeared while the download ran');
    throw unwritableError(file, e);
  }
}

/**
 * Write, replace or remove the fragments file for `items` (see the header for the ownership rules). Called after the spec
 * validated and before the download publishes anything, so a refusal here leaves the app folder as it was.
 * `onWarning(sentence)` is told of a leftover hidden name the download could not remove after a write that succeeded.
 * Answers { file, keys: [{ family, key }] } when items were written, or null when there were none.
 * Throws `managed-fragments-path-taken` for a name the download did not write (only when items are due), and
 * `managed-fragments-unwritable` for a write or removal that failed.
 */
function settleFragments(outDir, { app, items, onWarning } = {}) {
  const file = fragmentsPath(outDir);
  const list = Array.isArray(items) ? items : [];
  const seen = inspectFragmentsPath(file);
  if (!list.length) {
    // Nothing is due: only an own file is removed; an absent name, or anything the download did not write, is left alone.
    if (seen.state !== 'own') return null;
    const moved = setAside(file, seen);
    if (moved.changed && moved.kept) throw takenError(file, `it changed while the download ran, and could not be put back without replacing what took its name; it is kept as ${moved.kept}`);
    if (moved.aside) dropAside(moved.aside, onWarning);
    return null;
  }
  if (seen.state === 'taken') throw takenError(file, seen.why);
  const text = fragmentsText(app, list);
  if (seen.state === 'absent') {
    createFragments(file, text, onWarning);
  } else {
    const moved = setAside(file, seen);
    if (moved.changed) {
      throw takenError(file, moved.kept
        ? `it changed while the download ran, and could not be put back without replacing what took its name; it is kept as ${moved.kept}`
        : 'it changed while the download ran');
    }
    if (moved.vanished) {
      createFragments(file, text, onWarning);
    } else {
      try {
        writeFileSafe(file, text, { exclusive: true, encoding: 'utf8', onWarning });
      } catch (e) {
        // A file that took the vacant name meanwhile is someone else's: it is kept, and the earlier own file (checked) is dropped.
        if (e && e.code === 'IO_ERROR' && e.reason === 'exists') {
          dropAside(moved.aside, onWarning);
          throw takenError(file, 'it appeared while the download ran');
        }
        const left = putBack(file, moved.aside);
        throw unwritableError(file, e, left ? moved.aside : null);
      }
      dropAside(moved.aside, onWarning);
    }
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
  settleFragments,
  fragmentsText,
  stubWebResource,
  stubPersona,
};
