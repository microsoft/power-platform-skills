'use strict';
// The read-only side of declared dashboards (dashboards[].reconcile "declared"): what verify and the explicit managed
// download read about them. Nothing here writes, binds, clears a debt or publishes.
//
// Both hold a stored dashboard to its group's last proof through the helper's ONE read-only projection
// (lib/dashboard-reconcile.js projectDashboard over committedProjectionInput), never a looser copy of it. A dashboard is
// certified only when the projection finds its root and seed valid, every managed tile on it exactly once, and both of
// its hashes equal to the proof's: a tile in `missing` or `duplicated` is absent from both hashes, so the hashes alone
// would pass it. The declaration they compare with the spec and restore into a download is the group's
// originalDeclaration (committedDeclaration): the spec entry exactly as it was authored for the attempt that settled; the
// download adds to it only the root and tile ids the proof certified.
//
// What a read can show: a dashboard is a systemforms row, read here as the service answers it now, through an SDK whose
// workspace is the caller's own and throwaway (verify's isolated reader, the download's SDK), never the build's. It shows
// whether the row still is what the last build proved; it shows nothing about an edit that lands after it.
const { canonicalJson } = require('./reconcile-common.js');
const { KIND, projectDashboard, preservationMatches, committedProjectionInput, committedDeclaration, canonicalDeclaration } = require('./dashboard-reconcile.js');
const { readManagedFormFile } = require('./declared-form-io.js');

const bareId = (id) => String(id == null ? '' : id).toLowerCase().replace(/^\{|\}$/g, '');

// What each of projectDashboard's `invalid` codes means for a dashboard a build already proved.
const INVALID_MESSAGES = {
  'dashboard-interactive-unsupported': 'the dashboard is no longer a Standard dashboard',
  'dashboard-scope-unsupported': 'the dashboard now belongs to a table',
  'dashboard-seed-unrecognized': 'the group records a seed the build cannot read',
  'dashboard-seed-not-in-place': 'the tab and section the build created the dashboard with are not where it put them',
};

/**
 * A fresh read of one dashboard by its exact id through `sdk` (overwrite: a local copy must never pass for the stored row).
 * Answers the dashboard as the SDK reads it, or null when the SDK gives none; a read that fails throws, so the caller
 * reports it as unread, never as a pass.
 */
async function readLiveDashboard(sdk, id) {
  await sdk.fetchArtifact(KIND, id, { overwrite: true });
  const art = await sdk.getArtifact(KIND, id);
  return art && typeof art === 'object' ? art : null;
}

/**
 * Why `art` (the dashboard read by the group's bound id) is not what the committed dashboard `group` last proved, as
 * [{ code, message }]; [] when it is. `languageCode` must be that of the SDK that read it (sdk.languageCode), which picks the
 * label a tile's name is read from, as the build's proof did: a different one never certifies (the hashes differ).
 */
function dashboardProofIssues(group, art, languageCode) {
  const p = projectDashboard(art, { ...committedProjectionInput(group), languageCode });
  const proof = (group && group.proof) || {};
  const issues = [];
  for (const code of p.invalid) issues.push({ code, message: INVALID_MESSAGES[code] || code });
  const tiles = p.missing.filter((k) => k !== 'seed');
  if (tiles.length) issues.push({ code: 'dashboard-tile-missing', message: `the managed tile${tiles.length > 1 ? 's' : ''} ${tiles.join(', ')} ${tiles.length > 1 ? 'are' : 'is'} not on the dashboard` });
  if (p.duplicated.length) issues.push({ code: 'dashboard-tile-duplicated', message: `the managed tile${p.duplicated.length > 1 ? 's' : ''} ${p.duplicated.join(', ')} ${p.duplicated.length > 1 ? 'are' : 'is'} on the dashboard more than once` });
  if (p.semanticSha256 !== proof.semanticSha256) {
    issues.push({ code: 'dashboard-changed', message: 'the dashboard\'s name, description or managed tiles are not what its last build proved' });
  }
  if (!preservationMatches(p, proof.preservationSha256)) {
    issues.push({ code: 'dashboard-kept-content-changed', message: 'what the declaration does not own (another tile, a tab, a section, the layout, or a managed tile\'s other settings) is not what its last build proved' });
  }
  return issues;
}

/**
 * verify's check of one committed dashboard group the spec still declares: dashboardProofIssues, plus whether the spec's
 * declaration is the one the group settled (its originalDeclaration). A declaration changed since is not on the dashboard
 * yet, whatever the dashboard shows: it is reported so, and a build applies it. `group` must carry an originalDeclaration;
 * the caller lists one without it as unverified (committedDeclaration answers null), never passes or fails it here.
 */
function verifyDeclaredDashboard({ dashboard, group, art, languageCode }) {
  const issues = dashboardProofIssues(group, art, languageCode);
  if (canonicalJson(canonicalDeclaration(dashboard)) !== canonicalJson(committedDeclaration(group))) {
    issues.push({ code: 'dashboard-declaration-changed', message: 'the spec declares this dashboard differently from the declaration its last build settled; build again to apply it' });
  }
  return issues;
}

/**
 * The declaration a download restores: the original declaration, every authored value as authored, plus the ids its last
 * proof certified: the dashboard's `dashboardId` (the group's bound root) and each declared tile's `componentId` (the control
 * the group binds that tile to, consumerState.tiles under `<key>/<tile key>`). Without them a rebuild from the downloaded
 * folder, in a workspace with no binding store, could only look the dashboard up by its name: after a maker rename, with a
 * namesake made since, that finds ANOTHER dashboard, which an adoption approval would then bind and write. With them it
 * finds the proved rows by id, as the build would. They are identities, not consent: a fresh workspace still binds nothing
 * without `adopt:dashboard:<key>`. An authored id that is not the certified one (or a declared tile with no certified
 * control) is not overwritten or invented: the group is answered with its reason and not restored.
 * Answers { declaration } or { reason }.
 */
function withCertifiedIds(declaration, group, key, rootId) {
  const out = JSON.parse(JSON.stringify(declaration));
  if (out.dashboardId !== undefined && bareId(out.dashboardId) !== rootId) {
    return { reason: `its declaration pins dashboardId ${out.dashboardId}, not the dashboard it is bound to (${rootId})` };
  }
  if (out.dashboardId === undefined) out.dashboardId = rootId;
  const controls = new Map(committedProjectionInput(group).managed.map((m) => [m.key, m.id]));
  for (const tile of Array.isArray(out.tiles) ? out.tiles : []) {
    const certified = controls.get(`${key}/${tile && tile.key}`);
    if (!certified) return { reason: `its tile ${tile && tile.key} has no control its last build proved` };
    if (tile.componentId !== undefined && bareId(tile.componentId) !== certified) {
      return { reason: `its tile ${tile.key} pins componentId ${tile.componentId}, not the control it is bound to (${certified})` };
    }
    if (tile.componentId === undefined) tile.componentId = certified;
  }
  return { declaration: out };
}

/**
 * The explicit managed download's restore (--include-managed --managed-manifest <file>): for each committed dashboard group of
 * the store file (readManagedFormFile, family 'dashboard'), the declaration it was built from with the ids its last proof
 * certified (withCertifiedIds), put in `spec.dashboards` (mutated) in key order. The download reconstructs every dashboard of the app's site map as a plain entry pinned by its id
 * (`dashboardId`); a restored declaration REPLACES the plain entry of the same id, where it was, so the dashboard is declared
 * once, and is appended when there is none. A group is restored only when
 *   - the store keeps its original declaration (committedDeclaration),
 *   - a fresh read of its bound dashboard through `sdk` (the download's own throwaway SDK) answers,
 *   - that read certifies the group's last proof (dashboardProofIssues answers none),
 *   - its declaration takes the certified ids without overwriting an authored one (withCertifiedIds), and
 *   - the downloaded spec still validates with it (`validate`, the download's own validator).
 * Every other group — unread, changed since, not valid here, or still pending or unusable in the store — is answered in `stale`
 * with its reason, never silently dropped, and its dashboard stays as the plain download reconstructed it.
 * Answers { restored: [key], stale: [{ key, reason }] }; a store file that cannot be used throws `managed-manifest-unusable`.
 */
async function restoreManagedDashboards({ sdk, spec, file, environment, appUniqueName, solutionUniqueName, validate }) {
  const { groups, pending, invalid } = readManagedFormFile({ file, environment, appUniqueName, solutionUniqueName }, KIND);
  const restored = [];
  const stale = [
    ...pending.map((p) => ({ key: p.key, reason: `its last attempt is not settled (${p.code}); build again to settle it` })),
    ...invalid.map((p) => ({ key: p.key, reason: `its stored record is not usable (${p.reason})` })),
  ];
  if (!Array.isArray(spec.dashboards)) spec.dashboards = [];
  const base = groups.size ? validate(spec) : null;
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key);
    const id = bareId(group.root && group.root.id);
    if (!base || !base.ok) { stale.push({ key, reason: 'the downloaded spec does not validate on its own, so no dashboard is restored into it' }); continue; }
    const declaration = committedDeclaration(group);
    if (!declaration) { stale.push({ key, reason: 'the store keeps no original declaration for it; build again to record one' }); continue; }
    let art;
    try {
      art = await readLiveDashboard(sdk, id);
    } catch (e) {
      stale.push({ key, reason: `dashboard ${id} could not be read (${(e && e.message) || e})` });
      continue;
    }
    if (!art) { stale.push({ key, reason: `dashboard ${id} was not found` }); continue; }
    const issues = dashboardProofIssues(group, art, sdk.languageCode);
    if (issues.length) { stale.push({ key, reason: `dashboard ${id} is not what its last build proved (${issues.map((i) => i.code).join(', ')}); build again to prove it` }); continue; }
    const pinned = withCertifiedIds(declaration, group, key, id);
    if (pinned.reason) { stale.push({ key, reason: pinned.reason }); continue; }
    const at = spec.dashboards.findIndex((d) => d && bareId(d.dashboardId) === id);
    const next = at >= 0 ? spec.dashboards.map((d, i) => (i === at ? pinned.declaration : d)) : [...spec.dashboards, pinned.declaration];
    const check = validate({ ...spec, dashboards: next });
    if (!check || !check.ok) {
      const errors = ((check && check.errors) || []).slice(0, 3).map((x) => (typeof x === 'string' ? x : (x && x.message) || JSON.stringify(x)));
      stale.push({ key, reason: `its declaration does not validate in the downloaded spec (${errors.join('; ') || 'invalid'})` });
      continue;
    }
    spec.dashboards = next;
    restored.push(key);
  }
  stale.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { restored, stale };
}

module.exports = { readLiveDashboard, dashboardProofIssues, verifyDeclaredDashboard, restoreManagedDashboards };
