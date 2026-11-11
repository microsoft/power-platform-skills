'use strict';
// The read-only seam the explicit managed download (--include-managed) shares between the families it restores from a build's
// binding store, and the not-round-tripped report it finalizes once they have run.
//
// Why a seam at all: the plain download names what it leaves out (download-model-app.js notRoundTrippedSummary) before anything
// is restored, so a family the managed download DOES restore (a proved view, a proved chart) would still be reported as left out
// — the same false statement the report exists to prevent. The CLI asks runDownload to defer the report (`deferReport`), restores
// what it can, subtracts the ids it restored — exact ids, never display names: two views of one table may share a name — and prints
// the report once. A library caller that does not ask gets the report as it always did.
//
// What a family adapter answers is one shape, so the CLI can name every item it left out the same way:
//   { restored: [key], omitted: [{ kind, id?, key?, name?, code, reason }] }
// `reason` is fixed text chosen by `code` (REASONS below), never a service answer, an XML fragment or an exception's text: an
// omission is printed and written to the result, and the service's own words can carry anything (a private value, a row's content).
//
// The source store is read, never written, and its bytes are fingerprinted before the first family reads it and again before the
// download publishes anything (storeRevision): a build that rewrote the store in between could have changed what the families
// proved, and the families read it independently, so the download stops instead of writing a mix of two revisions.
const crypto = require('node:crypto');
const fs = require('node:fs');
const { normalizeGuid } = require('./reconcile-common.js');

const codeError = (code, message) => Object.assign(new Error(message), { code });

// Every reason an item is left out, as the text the operator reads. Fixed so an omission can never echo what a service said.
const REASONS = Object.freeze({
  'pending': 'its last build did not finish proving it (an attempt is still pending in the binding store)',
  'invalid': 'its record in the binding store is not usable',
  'not-created': 'its build adopted it rather than created it, and an adopted row is not one the app authored',
  'publication-unsettled': 'its last publish was not confirmed, so the published layer may not be what the build saved',
  'unpublished-changes': 'its saved layer differs from its published layer (a change was saved and not published)',
  'unread': 'it could not be read from the service',
  'missing': 'the row the build created is no longer in the service',
  'wrong-table': 'the row the build created is on a different table now',
  'changed': 'it was changed since its last build proved it',
  'unsupported': 'it uses a shape the App Spec cannot declare exactly',
  'not-equivalent': 'the declaration rebuilt from it does not compile back to the row as it is',
  'key-mismatch': 'its current table and name no longer give the key its build bound it under (it was renamed)',
  'would-change': 'a rebuild from the declaration would change it',
  'invalid-in-spec': 'the declaration rebuilt from it does not validate in the downloaded spec',
  'ownership-unproven': 'no binding store record proves this app authored it, so it is not declared',
});

const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,400}$/;
const safeText = (v) => (typeof v === 'string' && SAFE_TEXT.test(v) ? v : undefined);

/**
 * One item left out, carrying only safe identity (a normalized GUID, the store key, the row's name) and the fixed reason of its
 * code. `fields` names withheld parts of an item that is otherwise reported (never their values). An unknown code is a bug in the
 * caller, so it throws rather than print a reason nobody wrote.
 */
function omission({ kind, id, key, name, fields, code }) {
  if (!Object.prototype.hasOwnProperty.call(REASONS, code)) throw new Error(`unknown omission code '${code}'`);
  const guid = id ? normalizeGuid(id) : '';
  const out = { kind: String(kind) };
  if (guid) out.id = guid;
  if (safeText(key)) out.key = key;
  if (safeText(name)) out.name = name;
  if (Array.isArray(fields)) {
    const named = fields.map(safeText).filter(Boolean);
    if (named.length) out.fields = named;
  }
  out.code = code;
  out.reason = REASONS[code];
  return out;
}

/**
 * The not-round-tripped inventory (download-model-app.js readDescriptionInventory) without the rows the managed restore put back
 * into the spec, matched by normalized id per class: `restoredIds` is `{ views: [id], charts: [id] }`. A class left with no row loses
 * its key, as roundTrippedAware drops an empty globalChoices: an empty list would read as "the read found none". The inventory is
 * not changed; with nothing restored it is returned as it is, so the report stays byte for byte what the plain download prints.
 */
function subtractRestored(inventory, restoredIds) {
  if (!inventory || !restoredIds) return inventory;
  let out = inventory;
  for (const [kind, ids] of Object.entries(restoredIds)) {
    if (!Array.isArray(ids) || !ids.length || !Array.isArray(inventory[kind])) continue;
    const gone = new Set(ids.map((id) => normalizeGuid(id)).filter(Boolean));
    const left = inventory[kind].filter((row) => !(row && row.id && gone.has(normalizeGuid(row.id))));
    if (left.length === inventory[kind].length) continue;
    if (out === inventory) out = { ...inventory };
    if (left.length) out[kind] = left;
    else delete out[kind];
  }
  return out;
}

/**
 * The fingerprint of the source store's bytes (sha256), or throws `managed-manifest-unusable` when it cannot be read. Compared with
 * `assertStoreUnchanged` before anything is published.
 */
function storeRevision(file, { fsImpl = fs } = {}) {
  let bytes;
  try {
    bytes = fsImpl.readFileSync(file);
  } catch (e) {
    throw codeError('managed-manifest-unusable', `the managed binding store ${file} could not be read (${(e && e.code) || 'error'})`);
  }
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assertStoreUnchanged(file, revision, { fsImpl = fs } = {}) {
  let now;
  try {
    now = storeRevision(file, { fsImpl });
  } catch {
    now = null;
  }
  if (now !== revision) {
    throw codeError('managed-manifest-changed', `the managed binding store ${file} changed while this download read it (a build ran against this app?), so what it proved cannot be told apart from what it proves now. Run the download again`);
  }
}

module.exports = { REASONS, omission, subtractRestored, storeRevision, assertStoreUnchanged };
