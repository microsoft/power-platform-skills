'use strict';
// Where a caller keeps its page turn records: one small JSON file per turn id, written once and never replaced, deleted or repaired by this code.
//
// The store is the caller's, not the page's: it says "under this turn id, this complete request was intended for this page" (lib/page-turn-intent.js), and the first record
// written for an id wins. Two runs that race to bind one id both read the winner back, so the loser compares against the winner rather than its own wish. A record this code
// cannot read as a complete current one (an earlier format, a hand-edited or truncated file) is left exactly where it is and refused — never overwritten, never taken as "no
// record" — because the attempt that wrote it may have been an unfinished create.
//
// A host that keeps turns elsewhere (a database, its own workspace) passes an adapter with the same two methods; the SDK holds what it returns to the same closed record
// shape, so an adapter cannot widen what a record means.
//   get(turnId)          -> record | null (null ONLY when no record exists)
//   bind(turnId, record) -> the record now held for the id (the caller's, or one that was there first)
const path = require('node:path');
const realFs = require('node:fs');
const { writeFileSafe } = require('./safe-fs.js');
const { normalizeTurnId, validateTurnRecord, incompleteRecord } = require('./page-turn-intent.js');

// The folder an app's turns are kept in, inside the app's workspace (the upload passes its --app-dir). The workspace is the caller's own, and nothing else writes here.
const appTurnsDir = (appDir) => path.join(appDir, '.maker-workspace', 'turns');

function makeTurnBindingStore(folder, { fs = realFs } = {}) {
  if (typeof folder !== 'string' || !folder.trim()) throw new TypeError('makeTurnBindingStore needs the folder to keep turn records in');
  const root = path.resolve(folder);
  const fileOf = (turnId) => {
    const id = normalizeTurnId(turnId);
    if (id === undefined) throw new TypeError('a turn record needs a turn id');
    return { id, file: path.join(root, `${id}.json`) };
  };
  function get(turnId) {
    const { id, file } = fileOf(turnId);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return null;
      throw e;
    }
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      throw incompleteRecord(id, 'it is not valid JSON');
    }
    return validateTurnRecord(record, id);
  }
  function bind(turnId, record) {
    const { id, file } = fileOf(turnId);
    const valid = validateTurnRecord(record, id);
    fs.mkdirSync(root, { recursive: true });
    try {
      // `exclusive`: created by a hard link from a finished sibling, so the file either appears whole or not at all, and a name that is taken — by a racing run's record or
      // anything else — is never replaced. A file system without hard links fails here (reason 'no-hard-links') rather than lose that promise.
      writeFileSafe(file, `${JSON.stringify(valid, null, 2)}\n`, { exclusive: true, fs });
    } catch (e) {
      if (!(e && e.reason === 'exists')) throw e;
    }
    const held = get(id);
    if (!held) throw incompleteRecord(id, 'it vanished right after it was written');
    return held;
  }
  return Object.freeze({ get, bind, folder: root });
}

const appTurnStore = (appDir, opts) => makeTurnBindingStore(appTurnsDir(appDir), opts);

module.exports = { makeTurnBindingStore, appTurnStore, appTurnsDir };
