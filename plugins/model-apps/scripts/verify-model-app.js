#!/usr/bin/env node
'use strict';
// verify-model-app: reconcile an App Spec against the DEPLOYED app and report any missing artifacts
// (entities/columns/views/charts/forms/sitemap subareas + icons). Read-only WITH RESPECT TO DATAVERSE
// (it only READS the org — no create/update/delete), though it does write a local SDK workspace/cache
// directory (--workspace, default <spec-dir>/.maker-workspace). Exit non-zero if anything declared is
// missing — catches silent partial builds.
//
// Usage: node verify-model-app.js --env <orgUrl> --spec @<app-folder>/app-spec.json [--workspace <dir>]

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, validateFlags, readJsonArg, emitResult } = require('./lib/dataverse-auth.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { verifySpec } = require('./lib/verify-spec.js');
const { appUniqueName } = require('./lib/sdk-build.js');
const { validateAppSpec, migrateAppSpec } = require('./lib/app-spec.js');
const { odataLit } = require('./lib/odata.js');
const { makeGenpageCli } = require('./lib/genpage-cli.js');
const { depthFromMask } = require('./lib/role-privileges.js');

async function makeProvision(env, workspaceDir) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require('./vendor/cds-maker-sdk.cjs');
  const httpClient = createAzHttpClient(env);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(workspaceDir), instanceUrl: env, httpClient });
  await sdk.initWorkspace();
  // Only the SDK is returned. The raw `httpClient` used to come back with it because the role
  // privilege check had no SDK surface to read `EntityDefinitions(...)?$select=Privileges`; the
  // vendored bundle now exposes `getEntityPrivileges`, so that escape hatch is gone. Handing the
  // raw transport back with no caller is worse than useless — it advertises a bypass of the SDK
  // that this file deliberately no longer takes.
  return sdk;
}

// Resolve the app's sitemap XML: appmodule (by unique name) -> appmodulecomponents (type 62) ->
// sitemaps. Returns '' when the app / sitemap can't be found.
async function sitemapXmlFor(sdk, appUnique) {
  const apps = await sdk.queryRecords('appmodule', { select: ['appmoduleid', 'appmoduleidunique'], filter: `uniquename eq '${odataLit(appUnique)}'`, top: 1 });
  const app = apps && apps[0];
  if (!app) return '';
  const comps = await sdk.queryRecords('appmodulecomponent', { select: ['objectid', 'componenttype'], filter: `_appmoduleidunique_value eq ${app.appmoduleidunique} and componenttype eq 62`, top: 1 });
  const smId = comps && comps[0] && comps[0].objectid;
  if (!smId) return '';
  const sms = await sdk.queryRecords('sitemap', { select: ['sitemapxml'], filter: `sitemapid eq ${smId}`, top: 1 });
  return (sms && sms[0] && sms[0].sitemapxml) || '';
}

// Resolve the app module id (needed by genpage enumerate/download).
async function appIdFor(sdk, appUnique) {
  const rows = await sdk.queryRecords('appmodule', { select: ['appmoduleid'], filter: `uniquename eq '${odataLit(appUnique)}'`, top: 1 });
  return rows && rows[0] && rows[0].appmoduleid;
}

async function appRoleIdsFor(sdk, appUnique) {
  try {
    const appId = await appIdFor(sdk, appUnique);
    if (!appId) return { ok: false, reason: `app '${appUnique}' could not be resolved` };
    if (!sdk.dataverse || typeof sdk.dataverse.get !== 'function') return { ok: false, reason: 'SDK dataverse reader is unavailable' };
    // The SDK has associate/disassociate helpers for `appmoduleroles_association`, but no modeled
    // read for that N:N membership. Read the relationship navigation property directly so verify
    // proves the deployed app<->role rows the model-driven app launcher uses, rather than inferring
    // access from role existence or from the build result.
    // See appmodule relationships: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/appmodule
    const res = await sdk.dataverse.get(`/appmodules(${appId})/appmoduleroles_association?$select=roleid`);
    if (!res || res.status < 200 || res.status >= 300) return { ok: false, reason: `HTTP ${res && res.status}` };
    return {
      ok: true,
      roleIds: ((res.body && res.body.value) || [])
        .map((r) => r && r.roleid)
        .filter(Boolean)
        .map((id) => String(id).toLowerCase()),
    };
  } catch (err) {
    return { ok: false, reason: (err && err.message) ? String(err.message).slice(0, 200) : 'read failed' };
  }
}

// Which of `wanted` (table logical names) are real TABLE components of the app
// (`appmodulecomponent` componenttype 1), plus whether the app carries an `entity` PLACEHOLDER row.
//
// Returns `{ ok: true, present, placeholder }` or `{ ok: false, reason }`. The caller fails the check
// on `ok: false` rather than passing, because "we could not look" and "the app is fine" must never be
// the same answer here.
//
// Direction matters, and an earlier version had it backwards. Resolving every COMPONENT id to a
// logical name meant: a read per component (unbounded by anything the spec controls), a whole-answer
// failure whenever one foreign id would not resolve — reported as an opaque GUID an operator cannot
// act on — and a cap on the component query. This resolves only the tables the SPEC asks about, so
// the cost is bounded by the spec (LIVE-MEASURED ~100 ms per table), a component pointing at a
// deleted table is simply not one of ours, and every message names a table.
//
// `paginate: true`, never `top`. Dataverse honours `$top` as a HARD cap and omits
// `@odata.nextLink`, so a capped page silently truncates — and for a membership check a row that
// fell off the end reads as NOT PRESENT, i.e. verify reports a correctly built app as broken. The
// same trap was already found live on `roleprivileges` in this file (see `rolePrivileges` below);
// using `top` here would have reintroduced it, and would additionally have hidden the placeholder
// rows this check exists to find, since those are exactly what accumulates in a corrupted app.
//
// An EMPTY component list is returned as `ok: true` with nothing present, NOT as a read failure:
// that is the reported defect itself (a sitemap naming tables the app does not contain). It cannot
// mask a permissions problem, because the sitemap is read from the SAME `appmodulecomponent` table
// (componenttype 62) and would fail visibly first.
async function appEntityComponentsFor(sdk, appUnique, wanted) {
  try {
    const apps = await sdk.queryRecords('appmodule', { select: ['appmoduleid', 'appmoduleidunique'], filter: `uniquename eq '${odataLit(appUnique)}'`, top: 1 });
    const app = apps && apps[0];
    if (!app || !app.appmoduleidunique) return { ok: false, reason: `app '${appUnique}' could not be resolved` };
    const rows = await sdk.queryRecords('appmodulecomponent', {
      select: ['objectid', 'componenttype'],
      filter: `_appmoduleidunique_value eq ${app.appmoduleidunique} and componenttype eq 1`,
      paginate: true,
    });
    const ids = new Set((rows || []).map((r) => r && r.objectid).filter(Boolean).map((s) => String(s).toLowerCase()));
    // A type-1 `objectid` is a table's MetadataId, not a row id. `fetchEntityMetadata` resolves by
    // LOGICAL NAME and is a disk-cached projection, so this goes through the raw client instead.
    // A 404 means the table does not exist at all, which the separate `entity` existence check
    // already reports — so it is "not a component", not a read failure.
    const metadataId = async (logical) => {
      const res = await sdk.dataverse.get(`/EntityDefinitions(LogicalName='${odataLit(logical)}')?$select=MetadataId`);
      if (res && res.status === 404) return null;
      if (!res || res.status < 200 || res.status >= 300 || !res.body || !res.body.MetadataId) {
        throw new Error(`could not resolve table '${logical}' (HTTP ${res && res.status})`);
      }
      return String(res.body.MetadataId).toLowerCase();
    };
    const present = [];
    for (const logical of wanted || []) {
      const id = await metadataId(logical);
      if (id && ids.has(id)) present.push(logical);
    }
    // The known corruption: a table pinned as an `entity` INSTANCE pins the `entity` METADATA table.
    const entityId = await metadataId('entity');
    return { ok: true, present, placeholder: !!(entityId && ids.has(entityId)) };
  } catch (err) {
    return { ok: false, reason: (err && err.message) ? String(err.message).slice(0, 200) : 'read failed' };
  }
}

function readerFor(sdk, appUnique, opts) {
  opts = opts || {};
  const genpageCli = opts.genpageCli;
  const workspaceDir = opts.workspaceDir;
  const { fetchSitemap: _fetchSitemap, sitemapGenPageIds: _sitemapGenPageIds } = require('./lib/sitemap-pages.js');
  const { manifestResourceName: _manifestResourceName, parseManifestBase64: _parseManifestBase64 } = require('./lib/page-manifest.js');

  let appIdP;
  // Lazily resolve the app module id — only needed when page reads are requested.
  const appId = () => (appIdP || (appIdP = appIdFor(sdk, appUnique)));

  // Memoize fetchSitemap: both sitemapXml and sitemapPageIds share one live query (Imp7 — one snapshot).
  let sitemapP;
  const memoSitemap = () => (sitemapP || (sitemapP = _fetchSitemap(sdk, appUnique)));
  // Memoized app TABLE components — one live read per verify run, keyed by the wanted-table set.
  const appComponentsP = new Map();

  // Per-id page code cache. Downloads by specific id on demand rather than pulling all pages at once
  // (the old all-pages downloadP). Each id gets its own output dir to avoid directory collision.
  const codeById = new Map();

  const base = {
    findTable: async (logical) => { const l = String(logical).toLowerCase(); const t = await sdk.findTables(l); return (t || []).find((x) => String(x.logicalName).toLowerCase() === l) || null; },
    findColumns: async (logical) => sdk.findColumns(logical),
    // Grid data visualization (preview) for one column. Passed straight through — including the raw
    // 404 the SDK emits on an environment where the preview is not provisioned, which verify-spec
    // interprets (it must stay distinguishable from the legitimate 'None' answer).
    columnVisualization: async (logical, columnLogical) => sdk.getColumnVisualization(String(logical).toLowerCase(), String(columnLogical).toLowerCase()),
    queryRecords: (set, o) => sdk.queryRecords(set, o),
    // entityRelationships(childLogical): the relationship SCHEMA NAMES defined on a child entity, for the
    // content-verify relationship-existence check. Best-effort — a metadata read failure yields [] so the
    // check simply can't confirm (never a false pass: [] => the declared relationship reads as missing,
    // which is the fail-closed direction for a read-only reconcile). Reads OneToMany + ManyToMany schema
    // names from the entity metadata (the shape download's fetchEntityMetadata already returns).
    entityRelationships: async (childLogical) => {
      const meta = await sdk.fetchEntityMetadata(String(childLogical).toLowerCase());
      const rels = (meta && (meta.relationships || meta.Relationships)) || [];
      return rels
        .map((r) => r && (r.schemaName || r.SchemaName || r.name))
        .filter(Boolean)
        .map((n) => String(n).toLowerCase());
    },
    // commandBar(entity): truthy when a command bar (appaction set) exists for the entity — the identity
    // the build/teardown use (resolveArtifact('command', { entity })). Best-effort — a resolve failure
    // reads as absent (fail-closed for a read-only check).
    commandBar: async (entity) => {
      const items = await sdk.resolveArtifact('command', { entity: String(entity).toLowerCase() });
      return !!(items && items[0] && items[0].id);
    },
    // rolePrivileges(roleId): what the deployed role actually GRANTS, as [{ privilegeId, depth }].
    // The `roleprivileges` intersect row carries `privilegedepthmask` — a BITMASK (1 Basic /
    // 2 Local / 4 Deep / 8 Global), which is NOT the same encoding as the `Depth` name the SDK
    // writes via ReplacePrivilegesRole, so it is translated here into the depth NAME the pure
    // comparison speaks in. A role with no privileges legitimately returns [];  a READ FAILURE
    // must propagate (verify-spec turns a non-array into a fail-closed finding) rather than look
    // like an empty grant.
    // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/roleprivileges
    rolePrivileges: async (roleId) => {
      const rows = await sdk.queryRecords('roleprivileges', {
        select: ['privilegeid', 'privilegedepthmask'],
        filter: `roleid eq ${roleId}`,
        // Follow @odata.nextLink to completion rather than capping with `top`. Verified live: a
        // System Administrator role returned EXACTLY 5000 rows against the previous `top: 5000`,
        // i.e. it was silently truncated at the cap. A truncated page is the worst shape for this
        // check — a declared privilege that simply fell off the end reads as NOT HELD, so verify
        // reports a correctly configured role as missing privileges. Not combined with `top`:
        // Dataverse honors $top as a hard cap and omits @odata.nextLink, and the SDK rejects
        // paginate+top for exactly that reason.
        paginate: true,
      });
      return (rows || []).map((r) => ({
        privilegeId: String((r && r.privilegeid) || ''),
        // `privilegedepthmask` is a BITMASK and can carry several bits at once (7, 15, …), so the
        // depth is the HIGHEST bit set — see depthFromMask in lib/role-privileges.js for why an
        // exact-match lookup made correctly configured roles report as too shallow.
        depth: depthFromMask(r && r.privilegedepthmask),
      }));
    },
    // retrieveSetting(name, { appUniqueName }): the EFFECTIVE app-scoped value of a Dataverse setting,
    // for the AI app-feature reconcile. Wired here (not in the pure core) so the reader stays injectable
    // and existence-only callers skip the check entirely. Errors PROPAGATE: verifySpec catches them per
    // feature and reports the read failure as a not-present check, which is the fail-closed direction —
    // a verify that cannot prove a feature is in effect must not claim it is.
    retrieveSetting: async (name, opts) => sdk.retrieveSetting(name, opts || {}),
    // formDefaultState(entity, formId): the selected Main form's actual default flag. The identity
    // check in verify-spec proves the form row exists; this separate read proves the platform state
    // that chooses which form opens by default. Errors propagate to verify-spec as a fail-closed
    // finding, because a missing proof is not evidence that promotion succeeded.
    // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/systemform
    formDefaultState: async (_entity, formId) => {
      const rows = await sdk.queryRecords('systemform', {
        select: ['formid', 'isdefault'],
        filter: `formid eq ${formId}`,
        top: 1,
      });
      const row = rows && rows[0];
      return row ? { isDefault: row.isdefault === true } : null;
    },
    // formTopology(entity, formId): the deployed FormXml, so verify can prove the LAYOUT and not just
    // that a form row exists. Errors propagate to verify-spec, which reports the read failure as a
    // not-present check — a layout nobody could read is unverified, not correct.
    formTopology: async (_entity, formId) => {
      const rows = await sdk.queryRecords('systemform', {
        select: ['formid', 'formxml'],
        filter: `formid eq ${formId}`,
        top: 1,
      });
      const row = rows && rows[0];
      return (row && row.formxml) || null;
    },
    // dashboardComponents(dashboardId): the deployed dashboard's tiles, parsed by the SDK's own
    // dashboard deserializer — the path download already reads them through — so verify sees each
    // tile's TargetEntityType / ViewId / VisualizationId exactly as a rebuild would, instead of
    // regex-parsing FormXML a second way. Errors propagate: verify reports unreadable tiles as
    // unverified, never as correct.
    dashboardComponents: async (dashboardId) => {
      await sdk.fetchArtifact('dashboard', dashboardId);
      const art = await sdk.getArtifact('dashboard', dashboardId);
      return (art && art.components) || [];
    },
    // sitemapXml (string, fail-closed '') for entity/icon hasElement checks — from the discriminated sitemap
    // read. Returning '' on failure suppresses entity/icon checks without aborting the whole verify.
    sitemapXml: async () => { const r = await memoSitemap(); return r.ok ? r.xml : ''; },
    // The app's TABLE components, so verify can tell "the sitemap shows this table" from
    // "the app module actually contains it". Memoized per wanted-set — one live read per verify run.
    appEntityComponents: (wanted) => {
      const key = (wanted || []).join(',');
      if (!appComponentsP.has(key)) appComponentsP.set(key, appEntityComponentsFor(sdk, appUnique, wanted));
      return appComponentsP.get(key);
    },
    appRoleIds: () => appRoleIdsFor(sdk, appUnique),
  };

  // entityPrivileges(logical): the privilege set a table exposes, as [{ PrivilegeId, PrivilegeType, ... }].
  // Read through the SDK's `getEntityPrivileges`, which resolves the SAME source the SDK uses when it
  // WRITES a role, so the comparison cannot disagree with the write about which PrivilegeId means
  // "Read on account".
  //
  // This used to be a raw `httpClient` read of `EntityDefinitions(LogicalName='x')?$select=Privileges`,
  // because the SDK had no privilege READ at all — it could create and delete roles but never see what
  // a table exposes — and `fetchEntityMetadata` PROJECTS `Privileges` away permanently by design (its
  // `$select` never asks for them, and it is a disk-cached best-effort projection, the wrong contract
  // for a security read). That escape hatch is now retired: the vendored bundle carries the dedicated
  // method, which is the condition AGENTS.md set for making this switch.
  //
  // Two shape differences the mapping below absorbs:
  //  * The SDK returns camelCase `{ name, privilegeId, privilegeType, access?, scopes }`; the pure
  //    comparison in lib/role-privileges.js reads Dataverse's PascalCase `{ Name, PrivilegeId,
  //    PrivilegeType }`, which is also what the eventual `ReplacePrivilegesRole` payload speaks. The
  //    comparison keeps the wire vocabulary and the adaptation happens here, at the seam.
  //  * The SDK THROWS for a table that exposes no privileges (an unknown or non-securable table is an
  //    error, not an answer) where the raw read returned null. verify-spec wraps every call site in a
  //    try/catch and reports an unreadable entity as a FINDING, so both land in the same fail-closed
  //    place — an absent privilege set is never read as "nothing missing".
  //
  // Still conditional on a wired SDK for the same reason as before: when the reader cannot be built
  // it must be ABSENT rather than broken, so verify-spec skips the role-privileges check entirely
  // (it requires both `rolePrivileges` and `entityPrivileges`) instead of reporting a false failure.
  base.entityPrivileges = async (logical) => {
    const rows = await sdk.getEntityPrivileges(String(logical).toLowerCase());
    return (rows || []).map((p) => ({ Name: p.name, PrivilegeId: p.privilegeId, PrivilegeType: p.privilegeType }));
  };

  // Only expose page-authority readers when a genpageCli is wired — absent it, verifySpec fails closed
  // for a page-bearing spec (Imp7/C6: missing methods → unableToRun).
  if (genpageCli) {
    let existenceP;
    let manifestP;

    // MEMBERSHIP: the app's live sitemap page ids. Fail-closed: throw when the sitemap is unreadable.
    // verifySpec catches reader-incapacity via the method-presence check, not a try/catch here; a throw
    // propagates to the build gate which converts it to a non-zero exit (design §13.1).
    base.sitemapPageIds = async () => {
      const r = await memoSitemap();
      if (!r.ok) throw new Error(`could not read the app sitemap during verify (${r.reason})`);
      return _sitemapGenPageIds(r.xml);
    };

    // EXISTENCE: env-wide generative-page id set. Memoized (one enumerateEnv per verify run). Throw on
    // failure — fail-closed: an unknown environment means we cannot tell deployed from absent.
    base.existenceIds = () => (existenceP || (existenceP = (async () => {
      const e = await genpageCli.enumerateEnv();
      if (!e.ok) throw new Error(e.error);
      return e.ids;
    })()));

    // IDENTITY: the durable page manifest web resource. Returns null when absent OR corrupt — verifySpec
    // treats null as unableToRun (page-identity) on a page-bearing spec (Imp7). Memoized (one read).
    base.manifest = () => (manifestP || (manifestP = (async () => {
      const name = _manifestResourceName(appUnique);
      const rows = await sdk.queryRecords('webresource', { select: ['content'], filter: `name eq '${odataLit(name)}'`, top: 1 });
      const b64 = rows && rows[0] && rows[0].content;
      // parseManifestBase64 returns null on bad base64, bad JSON, wrong schemaVersion, corrupt entries, or
      // duplicate keys/pageIds (Imp11). A null manifest on a page-bearing spec → unableToRun in verifySpec.
      return b64 ? _parseManifestBase64(b64) : null;
    })()));

    // pageCode(id): download THAT page by id (pageIds:[id]) into a per-id cached directory. Caches result
    // so repeated calls for the same id never re-download. Fail-closed: a download failure rejects (throws)
    // so the caller receives a page-code miss rather than silently receiving empty code.
    base.pageCode = async (pageId) => {
      const key = String(pageId).toLowerCase();
      if (codeById.has(key)) return codeById.get(key);
      const id = await appId();
      // Per-id output dir so parallel/sequential calls for different ids don't clobber each other.
      const outDir = path.join(workspaceDir, 'verify-pages', key);
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir, { recursive: true });
      // Fail-closed: genpageCli.download throws on pac exit != 0 (design §13.1).
      await genpageCli.download({ appId: id, outputDir: outDir, pageIds: [pageId] });
      // pac writes to <outDir>/<pageId>/page.tsx; scan subdirs to be case-tolerant (pac may differ in casing).
      let code = '';
      for (const entry of fs.readdirSync(outDir)) {
        const tsx = path.join(outDir, entry, 'page.tsx');
        if (fs.existsSync(tsx)) { code = fs.readFileSync(tsx, 'utf8'); break; }
      }
      codeById.set(key, code);
      return code;
    };
  }
  return base;
}

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const USAGE = 'Usage: node verify-model-app.js --env <url> --spec @<app-folder>/app-spec.json [--workspace <dir>]';
  // Reject an unknown or value-less flag before any network work: an unrecognised flag is dropped
  // by parseArgs AND swallows the token after it, so `--workspce x` would silently verify against
  // the default workspace and report drift the caller cannot explain.
  const flagError = validateFlags(argv, { known: ['env', 'spec', 'workspace'], needValue: ['env', 'spec', 'workspace'] });
  if (flagError) {
    process.stderr.write(`✗ ${flagError}\n${USAGE}\n`);
    process.exit(1);
  }
  // Each is now either absent or a non-empty string, so a boolean can no longer reach
  // createAzHttpClient / path.resolve / fs.mkdirSync.
  const env = flags.env;
  const specArg = flags.spec || positional[0];
  const workspaceArg = flags.workspace;
  if (!env || !specArg) {
    process.stderr.write(USAGE + '\n');
    process.exit(1);
  }
  const specPath = path.resolve(specArg.startsWith('@') ? specArg.slice(1) : specArg);
  const spec = migrateAppSpec(readJsonArg('@' + specPath));
  // Validate the spec up front (consistent with teardown) so malformed input yields a structured
  // error instead of a later throw when dereferencing spec.entities / schemaName.
  const v = validateAppSpec(spec, { profile: 'deploy' });
  if (!v.ok) { emitResult(false, { ok: false, errors: v.errors }); return; }
  const workspaceDir = workspaceArg || path.join(path.dirname(specPath), '.maker-workspace');
  const sdk = await makeProvision(env, workspaceDir);
  const genpageCli = makeGenpageCli(env);
  const r = await verifySpec(spec, readerFor(sdk, appUniqueName(spec), { genpageCli, workspaceDir }));
  // Show `detail` on a failing check. Without it a READ that failed (throttling, auth expiry, a 5xx)
  // is indistinguishable from an artifact that is genuinely absent — verifySpec records the cause
  // but the operator saw only "✗ view: Active Orders" and would chase a phantom deployment drift.
  for (const c of r.checks) process.stderr.write(`  ${c.present ? '✓' : '✗'} ${c.kind}: ${c.name}${!c.present && c.detail ? ` — ${c.detail}` : ''}\n`);
  process.stderr.write(`\n${r.ok ? '✓ verify PASS' : `✗ verify FAIL — ${r.missing.length} missing`} (${r.checks.length - r.missing.length}/${r.checks.length} present)\n`);
  // Include `errors` (alias of missing) so emitResult's failure note reports an accurate count.
  const missing = r.missing.map((m) => `${m.kind}:${m.name}${m.detail ? ` (${m.detail})` : ''}`);
  emitResult(r.ok, { ok: r.ok, present: r.checks.length - r.missing.length, total: r.checks.length, missing, errors: missing });
}

if (require.main === module) {
  main().catch((err) => emitResult(false, err));
}

module.exports = { sitemapXmlFor, readerFor, appIdFor, appRoleIdsFor };
