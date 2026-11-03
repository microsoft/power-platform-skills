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
//
// The store-file reader and the verify manifest serve declared dashboards too (dashboards[].reconcile "declared"); the
// dashboard's own read and restore are in lib/declared-dashboard-io.js.
const path = require('node:path');
const { discoverManagedStore, managedManifestView, readManagedManifest, isStoreEnvironment, storeFileName, CODES } = require('./managed-bindings.js');
const { environmentFingerprint } = require('./page-ownership-records.js');
const { hydrateDeclaredForm } = require('./form-layout-reconcile.js');

const FORM = 'form';
// lib/dashboard-reconcile.js KIND; kept as a literal so verify's manifest read does not load the dashboard helper.
const DASHBOARD = 'dashboard';
// The declared workflow families (lib/rule-settlement.js, lib/bpf-settlement.js), as literals for the same reason.
const RULE = 'rule';
const BPF = 'bpf';
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
 * What verify reads for one workspace: managedManifestView of the store found there, with each committed FORM or DASHBOARD
 * group also carrying its `consumerState` and `publication` — read from the SAME discovery, so the view and the group state
 * are one revision. A declared dashboard's oracle (lib/dashboard-reconcile.js committedProjectionInput) reads its managed
 * tiles and catalog seed from the consumer state, as the form's reads its children. Like readManagedManifest: no store, or a
 * target no store can be kept for, is an empty view, and a store that cannot be trusted is one invalid entry
 * (readManagedManifest builds it), never an error of the verify run.
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
  // A pending business rule's or process flow's entry carries the row its attempt holds (`root`, the id reserved before anything
  // was sent; null when the attempt names none), so verify checks that row's presence and state by its id and never lets a
  // same-named row stand in for it (verify-spec.js boundWorkflowOf). The other families' pending entries are unchanged.
  const pendingRoots = new Map();
  for (const unit of found.loaded.units()) {
    if ((unit.family === RULE || unit.family === BPF) && unit.attempt && !unit.invalid) {
      pendingRoots.set(`${unit.family}\u0000${unit.key}`, unit.attempt.root || (unit.group && unit.group.root) || null);
    }
  }
  for (const p of view.pending) {
    const k = `${p.family}\u0000${p.key}`;
    if (pendingRoots.has(k)) p.root = clone(pendingRoots.get(k));
  }
  const committed = { [FORM]: committedUnits(found.loaded, FORM).groups, [DASHBOARD]: committedUnits(found.loaded, DASHBOARD).groups };
  for (const g of view.groups) {
    const full = committed[g.family] ? committed[g.family].get(g.key) : null;
    if (full) {
      g.consumerState = clone(full.consumerState);
      g.publication = clone(full.publication);
    }
  }
  return view;
}

/**
 * The explicit download's source (--include-managed --managed-manifest <file>): the groups of one `family` (a declared form's,
 * by default, or a declared dashboard's) in ONE binding store file, read only. The file must be the store a build keeps for
 * THIS environment, app and solution: its name is derived from
 * the three (managed-bindings.js storeFileName) and its envelope names them (parseEnvelope refuses another's). A copy of
 * another app's store, a manifest view saved to a file, or any other JSON is refused, so the flag can never lend one app's
 * declarations to another — and reading it creates no authority: the download writes no store and binds nothing.
 * Answers { groups: Map<key, group>, pending: [{key, code}], invalid: [{key, reason}] }; throws `managed-manifest-unusable`.
 */
function readManagedFormFile({ file, environment, appUniqueName, solutionUniqueName }, family = FORM) {
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
  return committedUnits(found.loaded, family);
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
 *   - every handler library the form names that the downloaded spec does not declare is downloaded with it (libraryEntry: this
 *     publisher's own unmanaged script, declared `external`), all or none; and
 *   - the downloaded spec still validates with it (`validate`, the download's own validator): a declaration naming a table, column
 *     or sub-grid child the download did not carry would make the whole spec unwritable, so that one form is left out instead.
 * Every other group — unread, stale, not valid here, or still pending or unusable in the store — is answered in `stale` with its
 * reason, never silently dropped. Answers { restored: [key], stale: [{ key, reason }], libraries?: [{ name, forms: [key] }] }
 * (`libraries` only when one was downloaded); a store file that cannot be used throws. `publisher` is the download's
 * { prefix, resolved } (runDownload); without it no library is downloaded.
 * `fragments`, when given, is an array a stale form is pushed onto (noteFormFragment) when its declaration is proved and left out
 * only for the handler libraries it names; the caller writes them to the fragments file (lib/managed-fragments.js).
 */
async function restoreManagedForms({ sdk, spec, file, environment, appUniqueName, solutionUniqueName, validate, fragments, publisher }) {
  const { groups, pending, invalid } = readManagedFormFile({ file, environment, appUniqueName, solutionUniqueName });
  const restored = [];
  const libraries = [];
  const libraryReads = new Map();
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
    // The handler libraries the form names and the spec does not declare: each is downloaded as the build would need it, or the
    // form is left out with why (all or nothing: a form is never restored with only some of its libraries).
    const wanted = librariesNotIn(spec, h.form);
    const libs = [];
    const refusals = [];
    for (const name of wanted) {
      const got = await libraryEntry(sdk, publisher, name, libraryReads);
      if (got.entry) libs.push(got.entry);
      else refusals.push(`its ${eventOf(h.form, name)} handler library '${name}' was not downloaded: ${got.why}`);
    }
    if (refusals.length) {
      const reason = refusals.join('; ');
      stale.push({ key, reason });
      noteFormFragment(fragments, { key, reason, spec, form: h.form, validate });
      continue;
    }
    const webResources = [...(Array.isArray(spec.webResources) ? spec.webResources : []), ...libs];
    const check = validate({ ...spec, ...(libs.length ? { webResources } : {}), forms: [...spec.forms, h.form] });
    if (!check || !check.ok) {
      const errors = ((check && check.errors) || []).slice(0, 3).map((x) => (typeof x === 'string' ? x : (x && x.message) || JSON.stringify(x)));
      const reason = `its declaration does not validate in the downloaded spec (${errors.join('; ') || 'invalid'})`;
      stale.push({ key, reason });
      noteFormFragment(fragments, { key, reason, spec, form: h.form, validate });
      continue;
    }
    // The form and its libraries are committed together. A new array, so the list runDownload counted is not grown under it.
    if (libs.length) spec.webResources = webResources;
    for (const lib of libs) libraries.push({ name: lib.name, forms: [key] });
    spec.forms.push(h.form);
    restored.push(key);
  }
  stale.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { restored, stale, ...(libraries.length ? { libraries } : {}) };
}

// The event a form handler names `library` on, for the reason a library was not downloaded.
function eventOf(form, library) {
  const folded = String(library).toLowerCase();
  const ev = (Array.isArray(form.events) ? form.events : []).find((e) => e && typeof e.library === 'string' && e.library.toLowerCase() === folded);
  return (ev && ev.event) || 'form';
}

/**
 * One handler library a restored form names, read from the environment and declared as a rebuild needs it, or why not.
 * The entry is `external: true`, as a path-referenced navigation icon's is (download-model-app.js iconWebResources): a build
 * reuses a library it finds without writing or comparing its content, creates it from this content only where it is missing,
 * and a teardown never deletes it. It is downloaded only when all of these hold, because each one is what makes that safe:
 *   - exactly one row answers the name (Dataverse matches it without regard to letter case);
 *   - the row is unmanaged (`ismanaged === false`; an absent flag is unknown, not unmanaged): a managed library belongs to a
 *     managed solution, and a build must not create an unmanaged copy of it where that solution is missing;
 *   - it is a script (webresourcetype 3, JScript), the only kind a form handler runs;
 *   - it has content, so a rebuild where it is missing creates it whole;
 *   - its name carries the app's own publisher prefix, read from the solution's publisher and verified (`publisher.resolved`):
 *     a build creates a missing web resource under the spec's publisher, and a name under another prefix stops that build.
 * The read, as the platform answers it:
 *   GET /webresourceset?$select=webresourceid,name,displayname,webresourcetype,content,ismanaged&$filter=name eq 'contoso_/scripts/item.js'&$top=2
 *   { "value": [ { "webresourceid": "…", "name": "contoso_/scripts/item.js", "displayname": "Item script", "webresourcetype": 3,
 *                  "content": "dmFyIEl0ZW0g…", "ismanaged": false } ] }
 * `reads` caches each name's answer for the run, so two forms naming one library read it once.
 */
async function libraryEntry(sdk, publisher, name, reads) {
  const folded = String(name).toLowerCase();
  if (!reads.has(folded)) reads.set(folded, readLibrary(sdk, publisher, name));
  return reads.get(folded);
}

const JSCRIPT = 3;

async function readLibrary(sdk, publisher, name) {
  const prefix = publisher && publisher.resolved === true && typeof publisher.prefix === 'string' && publisher.prefix ? publisher.prefix.toLowerCase() : null;
  if (!prefix) return { why: 'the app\'s publisher prefix was not verified, so it is not known to be this publisher\'s' };
  if (!String(name).toLowerCase().startsWith(`${prefix}_`)) return { why: `its name does not carry this publisher's prefix '${prefix}_'` };
  let rows;
  try {
    rows = await sdk.queryRecords('webresource', {
      select: ['webresourceid', 'name', 'displayname', 'webresourcetype', 'content', 'ismanaged'],
      filter: `name eq '${String(name).replace(/'/g, "''")}'`,
      top: 2,
    });
  } catch (e) {
    return { why: `it could not be read (${(e && e.message) || e})` };
  }
  const found = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.name === 'string' && r.name.toLowerCase() === String(name).toLowerCase());
  if (!found.length) return { why: 'it was not found' };
  if (found.length > 1) return { why: 'more than one web resource answers its name' };
  const row = found[0];
  if (row.ismanaged !== false) return { why: row.ismanaged === true ? 'it is managed' : 'whether it is managed is not known' };
  if (row.webresourcetype !== JSCRIPT) return { why: 'it is not a script' };
  if (typeof row.content !== 'string' || !row.content) return { why: 'it has no content' };
  return { entry: { name: row.name, ...(row.displayname ? { displayName: row.displayname } : {}), type: 'js', contentBase64: row.content, external: true } };
}

// The handler libraries a form's events name that `spec.webResources` does not declare, in event order, each once. Matched
// as the spec validator matches them (app-spec.js: the library name, case-insensitively).
function librariesNotIn(spec, form) {
  const declared = new Set((Array.isArray(spec.webResources) ? spec.webResources : []).map((w) => String((w && w.name) || '').toLowerCase()));
  const out = [];
  const seen = new Set();
  for (const ev of (Array.isArray(form && form.events) ? form.events : [])) {
    const name = ev && typeof ev.library === 'string' ? ev.library : '';
    const folded = name.toLowerCase();
    if (!name || declared.has(folded) || seen.has(folded)) continue;
    seen.add(folded);
    out.push(name);
  }
  return out;
}

// A proved form left out only for its handler libraries goes to the fragments file (lib/managed-fragments.js), ready to paste.
// "Only" is checked, not assumed: the spec must validate with the form and a stub for each missing library. The stubs are never
// written. Without a collector (a caller that keeps no fragments) nothing is noted.
function noteFormFragment(fragments, { key, reason, spec, form, validate }) {
  if (!Array.isArray(fragments)) return;
  const missing = librariesNotIn(spec, form);
  if (!missing.length) return;
  const { stubWebResource } = require('./managed-fragments.js');
  const webResources = [...(Array.isArray(spec.webResources) ? spec.webResources : []), ...missing.map(stubWebResource)];
  const check = validate({ ...spec, webResources, forms: [...spec.forms, form] });
  if (!check || !check.ok) return;
  fragments.push({ family: 'form', key, reason, needs: missing.map((name) => ({ webResource: name })), paste: { forms: [form] } });
}

module.exports = { readVerifyManifest, readManagedFormFile, readLiveForm, restoreManagedForms, committedUnits };
