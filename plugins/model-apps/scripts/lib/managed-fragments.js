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
 * The file:  <out>/.maker-workspace/managed-fragments-<UTC time>-<random>.json, e.g. managed-fragments-20261103T171412Z-3fa9c2.json
 *   (the tool-owned folder the download's baseline is written to)
 *   { "kind": "model-apps.managed-download-fragments", "formatVersion": 1, "app": "<app unique name>", "note": "...",
 *     "items": [ { "family": "form" | "bpf", "key": "<store key>", "reason": "<why it was left out>",
 *                  "needs": [ { "webResource": "<name>" } | { "persona": "<name>" } ],
 *                  "paste": { "forms": [ <declaration> ] } | { "businessProcessFlows": [ <declaration> ] } } ] }
 * The items are sorted by family, then key, so two downloads of the same app write the same bytes. No environment, tenant or
 * user value is written: a declaration holds table, column and form names and ids that app-spec.json already holds.
 *
 * Ownership. WHY a new name every time: the folder is the maker's app folder, so any name in it may hold a file the download did
 * not write, or come to hold one while the download runs. Replacing or removing a file there safely needs the file system to
 * say "this is still the file I looked at" at the moment of the change, and no portable call does (rename replaces, a hard
 * link needs support the folder may lack, and a check before the move is always a step behind). So the download never
 * replaces, renames over, removes or links anything here. It only ever CREATES a file, once per download, under a name it has
 * never used, with an exclusive create (open `wx`: O_CREAT|O_EXCL, CREATE_NEW on Windows), which the file system itself refuses
 * when a file or folder already has that name. A name that holds anything (a link too, which Windows would otherwise follow when
 * its target is missing; see createExclusive) is left exactly as it is and another name is tried. With nothing due nothing is
 * written and nothing is removed.
 *   - Files from earlier downloads stay; each is the record of the download that wrote it, and the result and the WARNING name
 *     the one this download wrote. Deleting them is the maker's choice.
 *   - It is called after the restore and the validation and BEFORE the download publishes anything (download-model-app.js main
 *     stages the page tree and writes it, the spec and the baseline only after this), so a failure here leaves every output that
 *     was there as it was.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { assertSafeOutputDir } = require('./safe-fs.js');
const { redactFileData } = require('./output-redaction.js');

const FRAGMENTS_KIND = 'model-apps.managed-download-fragments';
const FRAGMENTS_FORMAT = 1;
const WORKSPACE_DIR = '.maker-workspace';
// Names tried before giving up: each is new (time and 24 random bits), so a second one is needed only when something took the
// first between two downloads in the same second, or a maker made a file of that very name.
const MAX_ATTEMPTS = 8;
const NOTE = 'Managed items the download proved but left out of app-spec.json for what it could not bring. Add each "paste" entry to the same array in app-spec.json, together with what its "needs" lists (from the spec it was built from), then build.';

function codeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// 2026-11-03T17:14:12.667Z -> 20261103T171412Z (ISO 8601 basic format, UTC, to the second).
const utcStamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const fragmentsName = (date, suffix) => `managed-fragments-${utcStamp(date)}-${suffix}.json`;

const byFamilyThenKey = (a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

// The file's text: LF, 2-space indent, items sorted.
function fragmentsText(app, items) {
  const sorted = [...items].sort(byFamilyThenKey);
  return `${JSON.stringify({ kind: FRAGMENTS_KIND, formatVersion: FRAGMENTS_FORMAT, app: app || '', note: NOTE, items: sorted }, null, 2)}\n`;
}

// Creates `file` with `text`, exclusively. Answers 'taken' when the name exists (nothing there is touched); throws the failure to
// create; answers { partial: error } when the file was created but writing it failed (it is the download's own, half-written).
// WHY the lstat before and the identity check after the open: on Windows an exclusive create (CREATE_NEW) FOLLOWS a symbolic
// link whose target does not exist and creates the target, where POSIX O_EXCL refuses any link. So a name holding anything,
// a dangling link included, is passed over first; and a link put there between that look and the open (it would have to guess
// the random name) is caught by comparing what was opened with what the name holds, before a byte is written.
// `shownFile` names the file in the error text only (see settleFragments); every operation goes through `file`.
function createExclusive(file, text, shownFile = file) {
  try {
    fs.lstatSync(file);
    return 'taken';
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (e) {
    if (e && e.code === 'EEXIST') return 'taken';
    throw e;
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    // ino only: on Windows lstat reports dev 0 while fstat reports the volume serial, and both names are in one folder (one volume).
    if (!named.isFile() || named.ino !== opened.ino) {
      throw codeError('managed-fragments-unwritable', `the managed fragments file could not be made at ${shownFile}: a link or another file took the name while it was made, so nothing was written to it (if it was a link, an empty file may have been made where it points). No other output was written.`);
    }
    // Through redactFileData like every guarded writer (lib/safe-fs.js writeFileSafe, which this file wrote through before): a
    // declaration holds no token, but the file is written raw through its descriptor, so the guard is applied here.
    fs.writeFileSync(fd, redactFileData(text));
    fs.fsyncSync(fd);
  } catch (e) {
    if (e && e.code === 'managed-fragments-unwritable') throw e;
    return { partial: e };
  } finally {
    try { fs.closeSync(fd); } catch { /* the write's own outcome is what is reported */ }
  }
  return null;
}

function unwritableError(where, e, extra = '') {
  return codeError('managed-fragments-unwritable', `the managed fragments file could not be written in ${where} (${(e && e.message) || (e && e.code) || e}).${extra} No other output was written.`);
}

/**
 * Writes `items` to a NEW fragments file (see the header: created exclusively, never over anything). Called after the spec
 * validated and before the download publishes anything, so a failure here leaves every other output as it was.
 * Answers { file, keys: [{ family, key }] } when items were written, or null when there were none (nothing written, nothing
 * removed). Throws `managed-fragments-unwritable` when .maker-workspace is not a plain folder in <out> (a link, a junction, a
 * file) or no new file could be made there. `now` and `suffix` are seams for the tests.
 */
function settleFragments(outDir, { app, items, now = () => new Date(), suffix = () => crypto.randomBytes(3).toString('hex') } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return null;
  // Two forms of one folder. Every filesystem operation (the create, the link and identity checks) goes through `dir`, the real
  // path assertSafeOutputDir answers for the folder it actually checked: a parent junction or symlink retargeted after that
  // check cannot move the write into a folder nobody checked. `shown` is the same folder in the form of the <out> the caller
  // gave (a parent link kept, an 8.3 short name such as C:\Users\RUNNER~1 not expanded), as every other output of the
  // download is reported; it is used ONLY for what is reported (the result, the warning, the error text), never for I/O.
  const shown = path.join(path.resolve(outDir), WORKSPACE_DIR);
  let dir;
  try {
    // Created when missing; refused when it is a link or junction (a write there would land outside <out>) or not a folder.
    dir = assertSafeOutputDir(shown, { create: true });
  } catch (e) {
    throw unwritableError(shown, e);
  }
  const text = fragmentsText(app, list);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const name = fragmentsName(now(), suffix());
    let outcome;
    try {
      outcome = createExclusive(path.join(dir, name), text, path.join(shown, name));
    } catch (e) {
      throw e && e.code === 'managed-fragments-unwritable' ? e : unwritableError(shown, e);
    }
    if (outcome === 'taken') continue;
    const file = path.join(shown, name);
    if (outcome && outcome.partial) throw unwritableError(shown, outcome.partial, ` A partial file was left at ${file}; delete it.`);
    return { file, keys: [...list].sort(byFamilyThenKey).map((i) => ({ family: i.family, key: i.key })) };
  }
  throw unwritableError(shown, `every name tried (${MAX_ATTEMPTS}) was taken`);
}

// The stand-ins a proof validates with: shape only, never written.
const stubWebResource = (name) => ({ name, type: 'js', content: '' });
const stubPersona = (name, entity) => ({ persona: name, jobs: [{ name: 'stub', privileges: [{ entity: String(entity || 'account').toLowerCase(), access: ['read'] }] }] });

module.exports = {
  FRAGMENTS_KIND,
  FRAGMENTS_FORMAT,
  settleFragments,
  fragmentsText,
  stubWebResource,
  stubPersona,
};
