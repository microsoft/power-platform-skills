'use strict';
// The read-only side of declared forms (forms[].reconcile "declared"): what verify and the explicit managed download
// read about them. Nothing here writes, binds, clears a debt or publishes. It imports the store's readers and none of
// its writers (managed-bindings.js discoverManagedStore, managedManifestView, readManagedManifest).
//
// Why the form helper's oracle needs more than the manifest view: verifyDeclaredForm and hydrateDeclaredForm
// (lib/form-layout-reconcile.js) hold a stored form to the children of the group's last proof and restore the declaration
// the group keeps, both in the group's consumer state (`consumerState.children`, `consumerState.declaration`), which
// managedManifestView leaves out. They take the group of a snapshot unit, never store.readGroup: verify and download read
// a discovery of the store, not an open store.
const path = require('node:path');
const { discoverManagedStore, managedManifestView, readManagedManifest, isStoreEnvironment, storeFileName, CODES } = require('./managed-bindings.js');
const { environmentFingerprint } = require('./page-ownership-records.js');
const { hydrateDeclaredForm } = require('./form-layout-reconcile.js');

const FORM = 'form';
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const codeError = (code, message) => Object.assign(new Error(message), { code });

// The committed groups of one family in a discovered store, by key. A unit with an attempt pending, or one whose stored record
// is not usable, is not committed: it proves nothing yet and is listed apart (`pending`, `invalid`), never read as settled.
function committedUnits(loaded, family) {
  const groups = new Map();
  const pending = [];
  const invalid = [];
  if (!loaded) return { groups, pending, invalid };
  for (const unit of loaded.units()) {
    if (unit.family !== family) continue;
    if (unit.invalid) invalid.push({ key: unit.key, reason: String(unit.invalid) });
    else if (unit.attempt) pending.push({ key: unit.key, code: CODES.pending });
    else if (unit.group && unit.group.family === family) groups.set(unit.key, unit.group);
  }
  return { groups, pending, invalid };
}

/**
 * What verify reads for one workspace: managedManifestView of the store found there, with each committed FORM group also
 * carrying its `consumerState` and `publication` — read from the SAME discovery, so the view and the form state are one
 * revision. Like readManagedManifest: no store, or a target no store can be kept for, is an empty view, and a store that
 * cannot be trusted is one invalid entry (readManagedManifest builds it), never an error of the verify run.
 */
function readVerifyManifest(args) {
  if (!isStoreEnvironment(args && args.environment)) return managedManifestView(null);
  let found;
  try {
    found = discoverManagedStore(args);
  } catch {
    return readManagedManifest(args);
  }
  if (found.absent) return managedManifestView(null);
  const view = managedManifestView(found.loaded);
  const { groups } = committedUnits(found.loaded, FORM);
  for (const g of view.groups) {
    const full = g.family === FORM ? groups.get(g.key) : null;
    if (full) {
      g.consumerState = clone(full.consumerState);
      g.publication = clone(full.publication);
    }
  }
  return view;
}

/**
 * The explicit download's source (--include-managed --managed-manifest <file>): the form groups of ONE binding store file,
 * read only. The file must be the store a build keeps for THIS environment, app and solution: its name is derived from
 * the three (managed-bindings.js storeFileName) and its envelope names them (parseEnvelope refuses another's). A copy of
 * another app's store, a manifest view saved to a file, or any other JSON is refused, so the flag can never lend one app's
 * declarations to another — and reading it creates no authority: the download writes no store and binds nothing.
 * Answers { groups: Map<key, group>, pending: [{key, code}], invalid: [{key, reason}] }; throws `managed-manifest-unusable`.
 */
function readManagedFormFile({ file, environment, appUniqueName, solutionUniqueName }) {
  if (typeof file !== 'string' || file === '') throw codeError('managed-manifest-unusable', '--managed-manifest needs the path of the managed binding store file');
  if (!isStoreEnvironment(environment)) throw codeError('managed-manifest-unusable', `no managed binding store is kept for ${environment}`);
  if (!appUniqueName || !solutionUniqueName) throw codeError('managed-manifest-unusable', 'the app and its solution must be known to read its managed binding store');
  const full = path.resolve(file);
  const expected = storeFileName(environmentFingerprint(environment), appUniqueName, solutionUniqueName);
  if (path.basename(full).toLowerCase() !== expected.toLowerCase()) {
    throw codeError('managed-manifest-unusable', `${path.basename(full)} is not the managed binding store of app ${appUniqueName} in solution ${solutionUniqueName} on this environment (that file is named ${expected}, in the build's .maker-workspace folder)`);
  }
  let found;
  try {
    found = discoverManagedStore({ workspaceDir: path.dirname(full), environment, appUniqueName, solutionUniqueName });
  } catch (e) {
    throw codeError('managed-manifest-unusable', `the managed binding store ${full} could not be read: ${(e && e.message) || e}`);
  }
  if (found.absent) throw codeError('managed-manifest-unusable', `the managed binding store ${full} was not found`);
  return committedUnits(found.loaded, FORM);
}

/**
 * A fresh read of one form from the service through `sdk` (overwrite: a local copy must never pass for the stored form),
 * as the form helper reads it after its own push: the identity, type, table, tabs and handler bag. `sdk` must be one whose
 * workspace is the caller's own and throwaway (verify's isolated reader, the download's SDK), never the build's. Answers
 * the form, or null when the SDK gives no form; a read that fails throws, so the caller reports it as unread, never as a pass.
 */
async function readLiveForm(sdk, formId) {
  await sdk.fetchArtifact(FORM, formId, { overwrite: true });
  const form = await sdk.getArtifact(FORM, formId);
  return form && Array.isArray(form.tabs) ? form : null;
}

/**
 * The explicit managed download's restore: for each committed form group of the store file (readManagedFormFile), the declared
 * form its proof still certifies, appended to `spec.forms` (mutated), in key order so two downloads of the same app write the same
 * spec. A group is restored only when
 *   - a fresh read of its bound form through `sdk` (the download's own throwaway SDK) answers,
 *   - the form helper's hydrate (hydrateDeclaredForm) certifies it: the same id, type and table, every proved child where it was,
 *     the layout, handlers and hosts exactly as the proof saw them; and
 *   - the downloaded spec still validates with it (`validate`, the download's own validator): a declaration naming a table, column
 *     or sub-grid child the download did not carry would make the whole spec unwritable, so that one form is left out instead.
 * Every other group — unread, stale, not valid here, or still pending or unusable in the store — is answered in `stale` with its
 * reason, never silently dropped. Answers { restored: [key], stale: [{ key, reason }] }; a store file that cannot be used throws.
 */
async function restoreManagedForms({ sdk, spec, file, environment, appUniqueName, solutionUniqueName, validate }) {
  const { groups, pending, invalid } = readManagedFormFile({ file, environment, appUniqueName, solutionUniqueName });
  const restored = [];
  const stale = [
    ...pending.map((p) => ({ key: p.key, reason: `its last attempt is not settled (${p.code}); build again to settle it` })),
    ...invalid.map((p) => ({ key: p.key, reason: `its stored record is not usable (${p.reason})` })),
  ];
  if (!Array.isArray(spec.forms)) spec.forms = [];
  const base = validate(spec);
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key);
    const formId = group.root && group.root.id;
    if (!base || !base.ok) { stale.push({ key, reason: 'the downloaded spec does not validate on its own, so no form is added to it' }); continue; }
    let liveForm;
    try {
      liveForm = await readLiveForm(sdk, formId);
    } catch (e) {
      stale.push({ key, reason: `form ${formId} could not be read (${(e && e.message) || e})` });
      continue;
    }
    const h = hydrateDeclaredForm(group, { formId, liveForm });
    if (!h.form) { stale.push({ key, reason: h.stale }); continue; }
    const check = validate({ ...spec, forms: [...spec.forms, h.form] });
    if (!check || !check.ok) {
      const errors = ((check && check.errors) || []).slice(0, 3).map((x) => (typeof x === 'string' ? x : (x && x.message) || JSON.stringify(x)));
      stale.push({ key, reason: `its declaration does not validate in the downloaded spec (${errors.join('; ') || 'invalid'})` });
      continue;
    }
    spec.forms.push(h.form);
    restored.push(key);
  }
  stale.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { restored, stale };
}

module.exports = { readVerifyManifest, readManagedFormFile, readLiveForm, restoreManagedForms, committedUnits };
