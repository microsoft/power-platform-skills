#!/usr/bin/env node
'use strict';
// download-model-app: pull a DEPLOYED app back into an editable app-spec + page codeFiles (the edit
// flow's "pull everything" step). Reconstructs the app (sitemap -> appShell), ALL its generative
// pages (via pac list+download, incl. Maker-authored), its entities (minimal — the build reuses
// existing tables idempotently), the icon web resources, and its solution, via hydrate-spec.
//
// Usage: node download-model-app.js --env <orgUrl> --app <appId|uniqueName|displayName> --out <dir> [--allow-lossy-download]

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, validateFlags, emitResult, preflightAuth } = require('./lib/dataverse-auth.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { hydrateSpec, descriptionFromDataverse, withDescription } = require('./lib/hydrate-spec.js');
const { makeGenpageCli } = require('./lib/genpage-cli.js');
const { parseManifestBase64, manifestResourceName, reconcilePageIds } = require('./lib/page-manifest.js');
const { reverseResolveNavIds } = require('./lib/pageref-resolver.js');
const { fetchSitemap, sitemapGenPages } = require('./lib/sitemap-pages.js');
const { isRestrictedSolution } = require('./lib/system-solutions.js');
const { isPlatformIconRef, webResourceNameFromRef, validateAppSpec, normalizeLanguageCode, isLocalizedLabelMap, ambiguousChoiceAliases, relationshipSchemaName, manyToManySchemaName } = require('./lib/app-spec.js');
const { odataGuid } = require('./lib/ai-app-settings.js');

// webresourcetype (int) -> app-spec web-resource type.
const WR_TYPE = { 1: 'html', 2: 'css', 3: 'js', 4: 'xml', 5: 'png', 6: 'jpg', 7: 'gif', 8: 'xap', 9: 'xsl', 10: 'ico', 11: 'svg', 12: 'resx' };

// Reconstruct the app's dashboards (declared as DashBoard sitemap subareas) into app-spec
// dashboards[] entries. Each tile is reconstructed with ID PASSTHROUGH — it carries the deployed
// view/chart ids (+ target entity) directly, so a rebuild recreates the dashboard against the
// EXISTING views/charts without needing views[]/charts[] declared (which would else duplicate them).
// `warn` is optional and injected so the CLI can report WHY a dashboard could not be reconstructed.
// Without it this function swallowed every per-dashboard failure (`catch { continue }`) and returned
// a short list, so the subarea silently dropped and download failed downstream with "could not be
// round-tripped" and no cause. That is a diagnosis dead-end: live, the real reason was an SDK
// deserialization bug several layers down, and nothing surfaced it.
async function readDashboards(sdk, app, warn) {
  const strip = (g) => String(g || '').replace(/[{}]/g, '') || undefined;
  const ids = new Map(); // dashboardId -> subarea title (fallback name)
  for (const a of (app.siteMap && app.siteMap.areas) || []) {
    for (const g of a.groups || []) {
      for (const sa of g.subAreas || []) {
        if (sa.type === 'DashBoard' && sa.dashboardId) ids.set(String(sa.dashboardId).toLowerCase(), sa.title);
      }
    }
  }
  const out = [];
  for (const [id, title] of ids) {
    let art;
    // Keep going on a single unreadable dashboard — one bad artifact must not sink the whole
    // download — but SAY SO. A dropped subarea with no stated cause is what made this untraceable.
    try { art = await sdk.fetchArtifact('dashboard', id); } catch (e) {
      if (typeof warn === 'function') warn(`dashboard '${title || id}' (${id}) could not be read: ${e && e.message}`);
      continue;
    }
    let name = title || id;
    let description;
    try {
      const rows = await sdk.queryRecords('systemform', { select: ['name', 'description'], filter: `formid eq ${id}`, top: 1 });
      if (rows && rows[0] && rows[0].name) name = rows[0].name;
      description = rows && rows[0] && rows[0].description;
    } catch { /* keep fallback */ }
    const tiles = [];
    for (const c of art.components || []) {
      const p = c.parameters || {};
      const entity = p.TargetEntityType;
      const viewId = strip(p.ViewId);
      if (c.type === 'chart' || c.type === 'list') {
        // The two id-passthrough tile shapes, gated together because they share their required
        // parameters. EVERY one of these ids is load-bearing: a chart renders a visualization OVER a
        // view, so it needs both ids, and `entity` is required by both spec gates for either shape.
        // Emitting a tile missing any of them hands back a spec that fails its own lint — the exact
        // #572 defect class — so name the missing parameter and omit the tile rather than shipping
        // one a rebuild cannot honour.
        //
        // Collected as a LIST rather than reported one-at-a-time so a component missing several
        // parameters says so once, and — the reason this is not an `&& viewId` guard — so a tile
        // with no ViewId is reported too. Falling through to the unsupported-type branch would have
        // dropped it with no stated cause, which is the untraceability this whole block exists to end.
        const visualizationId = c.type === 'chart' ? strip(p.VisualizationId) : undefined;
        const missing = [];
        if (!entity) missing.push('TargetEntityType');
        if (!viewId) missing.push('ViewId');
        if (c.type === 'chart' && !visualizationId) missing.push('VisualizationId');
        if (!missing.length) {
          tiles.push(c.type === 'chart'
            ? { type: 'chart', name: c.name, entity, viewId, visualizationId }
            : { type: 'list', name: c.name, entity, viewId });
        } else if (typeof warn === 'function') {
          warn(`dashboard '${name}' ${c.type} tile '${c.name || viewId || '(unnamed)'}' carries no ${missing.join(' or ')}, so it cannot be rebuilt; it is omitted from dashboards[].`);
        }
      }
      else if (c.type === 'iframe' && p.Url) tiles.push({ type: 'iframe', name: c.name, url: p.Url });
      else if (c.type === 'webresource' && p.WebResourceName) tiles.push({ type: 'webresource', name: c.name, webResource: p.WebResourceName });
      // Everything else a dashboard can hold. Reported for the same reason as the branches above: the
      // dashboard-level "no recognizable tiles" warning below only fires when NOTHING survives, so a
      // dashboard with one good tile would otherwise drop its siblings in silence.
      else if (typeof warn === 'function') {
        const missingParam = c.type === 'iframe' ? 'Url' : c.type === 'webresource' ? 'WebResourceName' : null;
        warn(`dashboard '${name}' tile '${c.name || '(unnamed)'}' of type '${c.type}' `
          + (missingParam
            ? `carries no ${missingParam}, so it cannot be rebuilt; it is omitted from dashboards[].`
            : `is not a tile type the App Spec can express, so it is omitted from dashboards[].`));
      }
    }
    // A dashboard that read cleanly but yielded no usable tile is ALSO a silent drop — the subarea
    // disappears with nothing said. Distinguish it from the unreadable case above.
    if (tiles.length) out.push(withDescription({ id, name, tiles }, description));
    else if (typeof warn === 'function') {
      warn(`dashboard '${name}' (${id}) read OK but produced no recognizable tiles `
        + `(${(art.components || []).length} component(s)); its sitemap subarea will be dropped.`);
    }
  }
  return out;
}

// Reconstruct relationships[] from live metadata (#567).
//
// Derived from the CHILD ("referencing") side via `ManyToOneRelationships`, because that is how App
// Spec indexes a 1:N: `referencing` is the table that carries the lookup column. Reading from the
// parent side instead would miss the documented "bridge to a standard table" pattern — where the
// parent is `systemuser`/`account` and is therefore never one of the downloaded entities, so its
// metadata is never read — which references/app-spec-schema.md explicitly supports.
//
// This deliberately does NOT use the SDK's `fetchEntityMetadata().relationships` projection, which
// LIVE-MEASURED returns entries shaped:
//   {"schemaName":"cfo_workorder_SyncErrors","type":"OneToMany","relatedEntity":"syncerror","relatedAttribute":"regardingobjectid"}
// and is missing all three facts this needs: (1) no `IsCustomRelationship`, and on a 3-table app 20
// of 22 entries per table were platform plumbing (SyncErrors, AsyncOperations,
// MailboxTrackingFolders, BulkDeleteFailures, …) that must not become spec relationships; (2) no
// properly-cased lookup `SchemaName` — App Spec wants `cfo_CustomerId`, the projection lowercases
// to `cfo_customerid`; and (3) no ManyToMany entries.
//
// Returns { relationships, skipped } — `skipped` feeds the not-round-tripped report so a
// relationship this cannot express is DECLARED missing rather than silently absent, which was the
// whole complaint in #567.
async function readRelationships(sdk, logicals, publisherPrefix, warn) {
  const inApp = new Set((logicals || []).map((l) => String(l).toLowerCase()));
  const lc = (s) => String(s || '').toLowerCase();
  const relationships = [];
  const skipped = [];
  const seen = new Set(); // relationship SchemaName (lower) — a 1:N read from both ends, and every N:N, appears twice
  const parentOk = new Map(); // logical -> can a rebuild target be relied on to have this table?
  const note = (name, entity, reason) => {
    skipped.push({ name, entity, reason });
    if (typeof warn === 'function') warn(`relationship '${name}' on '${entity}' is not carried into the spec: ${reason}`);
  };

  // A parent OUTSIDE the app is only safe to declare when a fresh rebuild target is guaranteed to
  // have it — i.e. it is a stock table. A CUSTOM table this app does not include would not exist
  // there, so declaring the relationship would turn a silent omission into a failed build.
  // Three OUTCOMES, deliberately kept apart: the parent is in the app or is a stock table
  // ('rebuildable'); it is a confirmed custom table this app omits ('custom'); or its metadata could
  // not be read ('unknown'). Collapsing the last two into `false` made a transient 403/503 report
  // the confident and possibly wrong diagnosis "is a custom table this app does not include".
  const referencedRebuildability = async (logical) => {
    const key = lc(logical);
    if (inApp.has(key)) return 'rebuildable';
    if (parentOk.has(key)) return parentOk.get(key);
    let state = 'unknown';
    try {
      const res = await sdk.dataverse.get(`/${metadataEntityPath(logical)}?$select=IsCustomEntity`);
      if (res && res.status >= 200 && res.status < 300 && res.body) {
        state = res.body.IsCustomEntity === false ? 'rebuildable' : 'custom';
      }
    } catch { state = 'unknown'; }
    parentOk.set(key, state);
    return state;
  };

  for (const logical of logicals || []) {
    let rows = null;
    try {
      // `dataverse.get` RESOLVES on a non-2xx rather than throwing, so the status must be checked
      // explicitly — a bare try/catch would turn a 403 into "this table has no relationships".
      const res = await sdk.dataverse.get(`/${metadataEntityPath(logical)}/ManyToOneRelationships`
        + '?$select=SchemaName,ReferencedEntity,ReferencingEntity,ReferencingAttribute,IsCustomRelationship');
      if (!res || res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res && res.status}`);
      rows = ((res.body && res.body.value) || []).filter((r) => r && r.IsCustomRelationship);
    } catch (e) {
      // Report rather than swallow: "no relationships" and "the query failed" must not look alike.
      // `rows` stays null so the 1:N block below is skipped, but the N:N read still runs — an
      // earlier version `continue`d here, which meant a failed 1:N read ALSO skipped the N:N read
      // silently, leaving any N:N both unreconstructed and unmentioned.
      note('(all)', lc(logical), `their metadata could not be read (${e && e.message})`);
    }

    if (rows === null) rows = [];
    // Properly-cased lookup SchemaName + label. Best-effort: on failure the relationship still
    // round-trips using the lowercase logical name, which produces the same Dataverse column.
    // Skipped entirely when there is no relationship to label, so a table whose 1:N read failed
    // does not also pay for an attribute read whose result nothing would consume.
    const lookups = new Map();
    if (rows.length) {
      try {
        const res = await sdk.dataverse.get(`/${metadataEntityPath(logical)}/Attributes/Microsoft.Dynamics.CRM.LookupAttributeMetadata`
          + '?$select=LogicalName,SchemaName,DisplayName,Targets');
        for (const a of ((res && res.body && res.body.value) || [])) lookups.set(lc(a.LogicalName), a);
      } catch { /* fall back to the relationship's own ReferencingAttribute */ }
    }

    // POLYMORPHIC lookups. One lookup column that targets several tables surfaces as SEVERAL
    // relationships sharing ONE ReferencingAttribute — LIVE-MEASURED, `cfo_billto` with
    // Targets ["account","contact"] produced BOTH `cfo_cfo_workorder_account` and
    // `cfo_cfo_workorder_contact`. relationships[] has exactly one `referenced` per lookup, so
    // emitting both would declare the same lookup schema name twice and the rebuild would fail
    // creating the second. Skip the whole group and say so.
    const byAttr = new Map();
    for (const r of rows) {
      const k = lc(r.ReferencingAttribute);
      if (!byAttr.has(k)) byAttr.set(k, []);
      byAttr.get(k).push(r);
    }

    for (const [attr, group] of byAttr) {
      if (group.length > 1) {
        note(group.map((g) => g.SchemaName).sort().join(' + '), lc(logical),
          `lookup '${attr}' is polymorphic (targets ${group.map((g) => lc(g.ReferencedEntity)).sort().join(', ')}) and relationships[] declares exactly one referenced table per lookup`);
        continue;
      }
      const r = group[0];
      const key = lc(r.SchemaName);
      if (seen.has(key)) continue;
      const referenced = lc(r.ReferencedEntity);
      const referencing = lc(r.ReferencingEntity);
      const rebuildability = await referencedRebuildability(referenced);
      if (rebuildability !== 'rebuildable') {
        note(r.SchemaName, referencing, rebuildability === 'custom'
          ? `its parent table '${referenced}' is a custom table this app does not include, so a rebuild target would not have it`
          : `its parent table '${referenced}' could not be read, so whether a rebuild target would have it could not be determined`);
        continue;
      }
      seen.add(key);
      const a = lookups.get(attr);
      const lookup = { schemaName: (a && a.SchemaName) || r.ReferencingAttribute };
      const displayName = a && labelFromDataverse(a.DisplayName);
      if (displayName) lookup.displayName = displayName;
      // The deployed schema name is emitted ONLY when it differs from the one the build would
      // generate anyway AND it satisfies the publisher-prefix rule the lint enforces
      // (spec-lint.js "must start with the publisher prefix"). Emitting a foreign-prefix name would
      // hand back a spec that fails its own lint — the exact defect #572 is about — while omitting a
      // DIVERGENT name would make a rebuild into this same environment create a second relationship
      // beside the existing one instead of matching it.
      const auto = relationshipSchemaName({ referenced, referencing }, publisherPrefix);
      const deployed = r.SchemaName;
      const prefixOk = !publisherPrefix || lc(deployed).startsWith(`${lc(publisherPrefix)}_`);
      const rel = { type: 'OneToMany', referenced, referencing, lookup };
      if (deployed && lc(deployed) !== lc(auto)) {
        if (prefixOk) rel.schemaName = deployed;
        else if (typeof warn === 'function') {
          // RENAMED, not skipped. This relationship IS pushed below, so recording it in `skipped`
          // made the summary claim it was "absent from the rebuildable spec" — the opposite of what
          // happens. Warn through the plain channel so the rename stays visible without being
          // counted as a loss.
          warn(`relationship '${deployed}' on '${referencing}' does not start with this solution's publisher prefix '${publisherPrefix}_', so the spec rebuilds it under the generated name '${auto}' instead`);
        }
      }
      relationships.push(rel);
    }

    // Many-to-many. Both ends must be in the app: the intersect table is created by the platform,
    // so there is nothing to declare for a partner table a rebuild target would not have.
    // Attempted INDEPENDENTLY of the 1:N read above: a failed 1:N read says nothing about whether
    // N:N metadata is readable.
    try {
      const res = await sdk.dataverse.get(`/${metadataEntityPath(logical)}/ManyToManyRelationships`
        + '?$select=SchemaName,Entity1LogicalName,Entity2LogicalName,IsCustomRelationship');
      if (!res || res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res && res.status}`);
      for (const r of ((res.body && res.body.value) || []).filter((x) => x && x.IsCustomRelationship)) {
        const key = lc(r.SchemaName);
        if (seen.has(key)) continue;
        seen.add(key);
        const e1 = lc(r.Entity1LogicalName);
        const e2 = lc(r.Entity2LogicalName);
        if (!inApp.has(e1) || !inApp.has(e2)) {
          note(r.SchemaName, lc(logical), `it links '${e1}' to '${e2}' and this app does not include both tables`);
          continue;
        }
        // The deployed schema name is emitted ONLY when it differs from the one the build would
        // generate anyway AND it satisfies the publisher-prefix rule the lint enforces — the same
        // rule the 1:N branch above applies, for the same two reasons: a foreign-prefix name would
        // hand back a spec that fails its own lint, while omitting a DIVERGENT name makes a rebuild
        // into this same environment create a SECOND intersect relationship beside the existing one
        // instead of matching it.
        //
        // `manyToManySchemaName` SORTS the two entity names before composing, so `auto` is computed
        // from the same pair that is emitted rather than from the order Dataverse happened to report.
        const rel = { type: 'ManyToMany', entity1: e1, entity2: e2 };
        const auto = manyToManySchemaName({ entity1: e1, entity2: e2 }, publisherPrefix);
        const deployed = r.SchemaName;
        if (deployed && lc(deployed) !== lc(auto)) {
          if (!publisherPrefix || lc(deployed).startsWith(`${lc(publisherPrefix)}_`)) rel.schemaName = deployed;
          else if (typeof warn === 'function') {
            // RENAMED, not skipped — this relationship IS carried into the spec, so recording it as
            // skipped would claim it was absent from the rebuildable spec, the opposite of the truth.
            warn(`relationship '${deployed}' between '${e1}' and '${e2}' does not start with this solution's publisher prefix '${publisherPrefix}_', so the spec rebuilds it under the generated name '${auto}' instead`);
          }
        }
        relationships.push(rel);
      }
    } catch (e) {
      note('(many-to-many)', lc(logical), `their metadata could not be read (${e && e.message})`);
    }
  }

  // Deterministic order: the metadata endpoints carry no ordering guarantee, and this block is
  // written to a file that operators diff between runs, so an unstable order reads as a change that
  // did not happen.
  relationships.sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  skipped.sort((x, y) => (x.entity + x.name).localeCompare(y.entity + y.name));
  return { relationships, skipped };
}

// Render the relationships this download could NOT express in relationships[] (#567).
//
// Deliberately NOT folded into `notRoundTrippedSummary`. That report describes classes this download
// does not reconstruct AT ALL and whose members are all recorded under `descriptionInventory` — both
// of its standing sentences ("this download does not reconstruct …", "They are NOT lost: every one
// is listed under descriptionInventory") would be FALSE for relationships, which are now
// reconstructed apart from specific, individually-explained exceptions. A report whose value is that
// its claims are true cannot be extended with a claim that is not.
function relationshipsSkippedWarning(skipped) {
  if (!skipped || !skipped.length) return '';
  const lines = [
    `NOTE: ${skipped.length} relationship(s) could not be expressed in relationships[] and are absent from the rebuildable spec.`,
    '  They remain on the deployed app, so rebuilding into THIS environment leaves them untouched. Rebuilding into a',
    '  DIFFERENT environment will NOT recreate them — re-declare or re-create the ones you need there.',
  ];
  for (const s of skipped) lines.push(`    - ${s.entity}: ${s.name} — ${s.reason}`);
  return `${lines.join('\n')}\n`;
}

async function makeProvision(env, workspaceDir) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require('./vendor/cds-maker-sdk.cjs');
  const httpClient = createAzHttpClient(env);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(workspaceDir), instanceUrl: env, httpClient });
  await sdk.initWorkspace();
  return sdk;
}

// Resolve `--app` to an app GUID. Accepts the app's id, its immutable `uniquename`, or — as a
// convenience — its DISPLAY name. Identity order matters: an id and a uniquename are unique and
// authoritative, so they are tried first and a display-name query is never issued for them.
//
// A display NAME is resolved only as a LAST RESORT and FAILS CLOSED on ambiguity. Unlike a
// uniquename it is mutable and NOT unique — Dataverse happily holds two appmodules both named
// "Sales" — so silently taking the first match could download a different app than the operator
// meant. On multiple matches we return the candidate unique names instead of guessing.
// Display names were previously rejected outright with a bare "not found", which is a dead end for
// an operator holding the name the maker portal shows them (the unique name is not surfaced there).
//
// Returns { appId, matchedBy?, uniqueName? } on success, or { error } describing how to retry.
async function resolveAppId(sdk, appArg) {
  if (/^[0-9a-fA-F-]{36}$/.test(appArg)) return { appId: appArg };
  // OData string literals escape a single quote by DOUBLING it: O'Brien -> 'O''Brien'.
  const esc = String(appArg).replace(/'/g, "''");
  const byUnique = await sdk.queryRecords('appmodule', { select: ['appmoduleid'], filter: `uniquename eq '${esc}'`, top: 1 });
  if (byUnique && byUnique[0] && byUnique[0].appmoduleid) return { appId: byUnique[0].appmoduleid, matchedBy: 'uniqueName' };

  const byName = await sdk.queryRecords('appmodule', { select: ['appmoduleid', 'uniquename', 'name'], filter: `name eq '${esc}'`, top: 50 });
  const matches = (byName || []).filter((r) => r && r.appmoduleid);
  if (matches.length === 1) return { appId: matches[0].appmoduleid, matchedBy: 'displayName', uniqueName: matches[0].uniquename };
  if (matches.length > 1) {
    const names = matches.map((m) => m.uniquename).filter(Boolean).join(', ');
    return { error: `'${appArg}' is a DISPLAY name shared by ${matches.length} apps — display names are not unique, so re-run --app with one of these unique names: ${names}` };
  }
  return { error: `app '${appArg}' not found — --app takes the app's id (GUID), its unique name (e.g. new_myapp), or an unambiguous display name` };
}

// The distinct entity logical names + icon web-resource NAMES referenced by the app's sitemap. Returns
// TWO name sets:
//   `icons`     — BARE-NAME icon references (a locally-declared image web resource); fetched and
//                 re-emitted as webResources[] so the build recreates them (existing behavior).
//   `customRefs`— web-resource NAMES extracted from a PLATFORM icon/vectorIcon PATH reference
//                 (`/WebResources/<name>` or `$webresource:<name>`) on ANY area/subarea icon OR
//                 vectorIcon. These are fetched too — but re-declared ONLY when the WR is CUSTOM
//                 (unmanaged) — so a modern custom nav icon referenced by PATH survives a cross-env
//                 rebuild (previously the path was a dangling reference: the WR was never recreated on
//                 a target env that lacked it). An OOB/system path (a managed WR, or a virtual
//                 `/_imgs/...` image that isn't a real web resource) resolves to nothing / a managed WR
//                 and is left as a bare reference (it exists on every env / travels with its managed
//                 solution).
function collectSitemap(app) {
  const entities = new Set();
  const icons = new Set();
  const customRefs = new Set();
  const navRefs = new Set();   // web resources a URL SUBAREA targets (non-image types allowed)
  const addIcon = (v) => { if (!v) return; if (isPlatformIconRef(v)) { const n = webResourceNameFromRef(v); if (n) customRefs.add(n); } else icons.add(v); };
  for (const a of (app.siteMap && app.siteMap.areas) || []) {
    addIcon(a.icon); addIcon(a.vectorIcon);
    for (const g of a.groups || []) {
      for (const sa of g.subAreas || []) {
        if (sa.type === 'Entity' && sa.entity) entities.add(String(sa.entity).toLowerCase());
        addIcon(sa.icon); addIcon(sa.vectorIcon);
        // A URL subarea can TARGET a web resource rather than link out — the Site Map Designer's
        // "custom page backed by an HTML web resource" writes `$webresource:<name>`. Collected
        // SEPARATELY from icon refs because the type policy differs: such a page is `html`, which the
        // icon path's image-only gate excludes by design. Capturing it means the page travels with
        // the app instead of the rebuild emitting a nav entry the spec cannot recreate.
        // `webResourceNameFromRef` returns null for a real http(s) link, so those are untouched.
        if (sa.type === 'URL' && sa.url) {
          const wr = webResourceNameFromRef(sa.url);
          if (wr) navRefs.add(wr);
        }
      }
    }
  }
  return { entities: [...entities], icons: [...icons], customRefs: [...customRefs], navRefs: [...navRefs] };
}

// The entity logical names that are COMPONENTS of the app module, regardless of whether they appear
// in the sitemap. `collectSitemap` can only see tables the maker placed in navigation, but a
// model-driven app routinely includes tables reachable only through a lookup, sub-grid, or related
// view — an app built on account/contact typically also carries task, email, appointment, phonecall,
// systemuser, team and annotation with no sitemap entry of their own. Reconstructing entities from
// the sitemap alone silently dropped those (ADO 6603388), so the download→edit→rebuild round trip
// lost hidden app dependencies.
//
// The entity is derived from the app's VIEW / CHART / FORM components rather than from its
// `componenttype eq 1` (Entities) rows.
//
// CORRECTED (re-measured live): an earlier note here claimed the type-1 rows were
// UNUSABLE because "every row carries the same objectid — the MetadataId of the `entity` metadata
// table". That observation was real, but it was made against an app corrupted by the defect where every
// table had been pinned as an `entity` INSTANCE, pinning the `entity` metadata table itself. On a
// HEALTHY app the rows carry the REAL table
// MetadataIds — re-measured on a 3-table app, which returned three distinct ids resolving to its
// three tables — and `RetrieveAppComponents` answers 200, not the 0 rows previously recorded.
// `verify-spec` now relies on exactly that, so the old claim must not be left standing.
//
// The view/chart/form derivation is KEPT regardless, because it is not merely a workaround for that
// stale claim: it is the source that recovers tables reachable only through a lookup, sub-grid or
// related view, which is the gap this function exists to close. Type-1 rows are a
// legitimate additional source for a future change; they are simply not needed here.
//   componenttype 26 → savedquery.returnedtypecode
//   componenttype 59 → savedqueryvisualization.primaryentitytypecode
//   componenttype 60 → systemform.objecttypecode
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/appmodulecomponent
//
// `appId` is the appmoduleid; the parent lookup targets `appmoduleidunique`, so that is resolved
// first. Best-effort by design: any failure returns an empty list so the caller keeps today's
// sitemap-derived behavior rather than losing the download entirely.
const APP_COMPONENT_ENTITY_SOURCES = [
  { componentType: 26, set: 'savedquery', idField: 'savedqueryid', entityField: 'returnedtypecode' },
  { componentType: 59, set: 'savedqueryvisualization', idField: 'savedqueryvisualizationid', entityField: 'primaryentitytypecode' },
  { componentType: 60, set: 'systemform', idField: 'formid', entityField: 'objecttypecode' },
];
// Dataverse entity set -> the App Spec artifact class it inventories, so a failed read is reported
// in the author's vocabulary ("forms could not be inventoried") rather than Dataverse's.
const INVENTORY_KIND_BY_SET = { savedquery: 'views', savedqueryvisualization: 'charts', systemform: 'forms' };
// Dataverse honors `$top` as a HARD cap and omits `@odata.nextLink`, so this is the point past which
// components of one type stop being inspected. Generous for a real app (a 70-table app has ~1000
// views), and exceeded only with a warning.
const COMPONENT_PAGE_CAP = 1000;

async function appComponentEntities(sdk, appId) {
  if (!appId) return [];
  try {
    const appRows = await sdk.queryRecords('appmodule', { select: ['appmoduleidunique'], filter: `appmoduleid eq ${appId}`, top: 1 });
    const appUniqueId = appRows && appRows[0] && appRows[0].appmoduleidunique;
    if (!appUniqueId) return [];
    const parent = String(appUniqueId).replace(/[{}]/g, '');
    const found = new Set();
    for (const src of APP_COMPONENT_ENTITY_SOURCES) {
      const rows = await sdk.queryRecords('appmodulecomponent', {
        select: ['objectid', 'componenttype'],
        filter: `_appmoduleidunique_value eq ${parent} and componenttype eq ${src.componentType}`,
        top: COMPONENT_PAGE_CAP,
      });
      // `$top` is a HARD cap in Dataverse (the SDK refuses to combine `top` with `paginate` for
      // exactly this reason: `@odata.nextLink` is omitted, so the tail is lost with no signal). An
      // app with more than this many components of one type would silently lose the remainder —
      // the same silent-drop class as ADO 6603388, just at a higher threshold — so say so rather
      // than quietly returning a partial set.
      if ((rows || []).length >= COMPONENT_PAGE_CAP) {
        process.stderr.write(`WARNING: this app has at least ${COMPONENT_PAGE_CAP} ${src.set} components; only the first ${COMPONENT_PAGE_CAP} were inspected, so a table referenced only beyond that point may be missing from the spec.\n`);
      }
      const ids = [...new Set((rows || []).map((r) => r && r.objectid).filter(Boolean).map((id) => String(id).replace(/[{}]/g, '')))];
      // Chunk the OR-batched id lookups so a many-component app cannot build an over-long URL.
      for (let i = 0; i < ids.length; i += 20) {
        const filter = ids.slice(i, i + 20).map((id) => `${src.idField} eq ${id}`).join(' or ');
        const recs = await sdk.queryRecords(src.set, { select: [src.idField, src.entityField], filter, top: 1000 });
        // A dashboard is a `systemform` row too, and its `objecttypecode` is NOT an entity logical
        // name ('none' / ''). Filtering it here keeps a bogus name out of the metadata fetch loop
        // instead of relying on that fetch 404-ing into a bare catch.
        for (const r of recs || []) {
          const logical = r && r[src.entityField] ? String(r[src.entityField]).toLowerCase() : '';
          if (logical && logical !== 'none') found.add(logical);
        }
      }
    }
    return [...found];
  } catch {
    return []; // best-effort — never break the download over the component read
  }
}

async function rowsByIds(sdk, set, idField, ids, select, mapRow) {
  const out = [];
  const clean = [...new Set((ids || []).map((id) => String(id || '').replace(/[{}]/g, '')).filter(Boolean))];
  for (let i = 0; i < clean.length; i += 20) {
    const filter = clean.slice(i, i + 20).map((id) => `${idField} eq ${id}`).join(' or ');
    const rows = await sdk.queryRecords(set, { select, filter, top: 1000 });
    for (const r of rows || []) out.push(mapRow(r));
  }
  return out;
}

// Read the two app-shell settings the BUILD writes but the download previously dropped, so a
// downloaded spec round-trips them instead of silently reverting an app to the classic shell when it
// is rebuilt into a fresh environment (#514).
//
// Only an EXPLICIT app-scope override is emitted. An absent row means "inherits the environment", and
// the build treats an omitted field the same way — so omitting is the faithful representation, and
// emitting a value for an inherited setting would invent an override the app never had.
//
// Encoding, and the trap it hides:
//   NewLookAlwaysOn            stored as the string 'true' / 'false'
//   HeaderAndNavigationRefresh stored as a Number TRI-STATE where 2 = on, 1 = OFF, 0 = platform
//                              default. A truthy read reports 1 — which means disabled — as enabled,
//                              which is the same mistake that made `ai.appFeatures: false` disable a
//                              live app's features.
const SHELL_SETTINGS = {
  NewLookAlwaysOn: { field: 'newLook', decode: (v) => (String(v).toLowerCase() === 'true' ? true : (String(v).toLowerCase() === 'false' ? false : undefined)) },
  HeaderAndNavigationRefresh: { field: 'headerNavigationRefresh', decode: (v) => (String(v) === '2' ? true : (String(v) === '1' ? false : undefined)) },
};

async function readAppShellSettings(sdk, appId) {
  const out = {};
  try {
    const defs = await sdk.queryRecords('settingdefinition', {
      select: ['settingdefinitionid', 'uniquename'],
      filter: Object.keys(SHELL_SETTINGS).map((n) => `uniquename eq '${n}'`).join(' or '),
      top: 10,
    });
    const byId = new Map((defs || []).map((d) => [odataGuid(d.settingdefinitionid).toLowerCase(), d.uniquename]));
    if (!byId.size) return out;
    // Bound the read by the two DEFINITIONS, not by `$top`. Dataverse honours `$top` as a hard cap and
    // omits `@odata.nextLink` (see COMPONENT_PAGE_CAP above), so an app-scoped read that leans on a row
    // limit can return a partial page — and here a partial page is not a visible truncation but a WRONG
    // ANSWER, because an absent row is indistinguishable from "inherits the environment". The app would
    // round-trip without its override and rebuild into the classic shell, silently, which is the exact
    // loss this function exists to stop. Filtering server-side makes the result at most one row per
    // definition, so no number of unrelated settings on the app can push the shell rows off the page.
    const defFilter = [...byId.keys()].map((id) => `_settingdefinitionid_value eq ${id}`).join(' or ');
    const rows = await sdk.queryRecords('appsetting', {
      select: ['value', '_settingdefinitionid_value'],
      filter: `_parentappmoduleid_value eq ${odataGuid(appId)} and (${defFilter})`,
      top: 10,
    });
    for (const r of rows || []) {
      // Both sides of this join are normalized because a miss here is SILENT — an unrecognized id just
      // `continue`s and the setting vanishes from the spec. Measured live, Dataverse returns both
      // `settingdefinitionid` and `_settingdefinitionid_value` as bare lower-case GUIDs, so this is
      // belt-and-braces on a fail-quiet path rather than a fix for an observed mismatch.
      const name = byId.get(odataGuid(r && r._settingdefinitionid_value).toLowerCase());
      const spec = name && SHELL_SETTINGS[name];
      if (!spec) continue;
      const decoded = spec.decode(r.value);
      if (decoded !== undefined) out[spec.field] = decoded;
    }
  } catch {
    // Best-effort, like every other capture here: a tenant without these setting definitions, or a
    // caller without read access to appsettings, still gets a usable spec. Losing an optional shell
    // setting must never fail a download.
  }
  return out;
}

async function readDescriptionInventory(sdk, appId, solutionUniqueName) {
  // `incomplete[]` records an artifact class whose read FAILED. Without it the whole app-component
  // block shared one broad catch, so a 403 on `systemform` left `forms: []` — indistinguishable from
  // an app with no forms, which is EXACTLY the reported bug (AB#6686423) reappearing inside the fix
  // for it. It is a sibling key for the same reason `roleRestrictedForms` is: only the five
  // whitelisted keys reach `app-spec.json`, so this informs the CLI without changing the spec shape.
  const inventory = { views: [], charts: [], forms: [], businessRules: [], globalChoices: [], roleRestrictedForms: [], incomplete: [] };
  const fail = (kind, err) => inventory.incomplete.push({ kind, reason: (err && err.message) ? String(err.message).slice(0, 200) : 'read failed' });
  try {
    const appRows = await sdk.queryRecords('appmodule', { select: ['appmoduleidunique'], filter: `appmoduleid eq ${appId}`, top: 1 });
    const appUniqueId = appRows && appRows[0] && appRows[0].appmoduleidunique;
    const parent = appUniqueId ? String(appUniqueId).replace(/[{}]/g, '') : null;
    if (parent) {
      // Caught PER ARTIFACT CLASS, not once around the loop: one failed query must not hide the
      // other two, and the caller has to be told WHICH class it cannot vouch for.
      for (const src of APP_COMPONENT_ENTITY_SOURCES) {
        try {
          const rows = await sdk.queryRecords('appmodulecomponent', {
            select: ['objectid', 'componenttype'],
            filter: `_appmoduleidunique_value eq ${parent} and componenttype eq ${src.componentType}`,
            top: COMPONENT_PAGE_CAP,
          });
          // A FULL page is indistinguishable from a truncated one, so treat it as truncated. `$top` is
          // a HARD cap and Dataverse omits `@odata.nextLink` when it is honoured, so there is no
          // signal to read afterwards. `appComponentEntities` warns about the same cap on its own
          // query, but THIS list feeds `notRoundTrippedSummary`, which reports a count — so a
          // truncated read there is not merely a missing table, it is a smaller number presented as
          // the whole truth. Marking the class incomplete makes the report say it cannot vouch for
          // the class instead. A false positive at exactly the cap costs one honest
          // "could not be inventoried" line; the alternative is a silent undercount.
          if ((rows || []).length >= COMPONENT_PAGE_CAP) {
            fail(INVENTORY_KIND_BY_SET[src.set] || src.set,
              new Error(`more than ${COMPONENT_PAGE_CAP} app components of this type; the list was truncated, so this class is incomplete`));
          }
          const ids = (rows || []).map((r) => r && r.objectid).filter(Boolean);
          if (src.set === 'savedquery') {
            inventory.views.push(...await rowsByIds(sdk, 'savedquery', 'savedqueryid', ids, ['savedqueryid', 'name', 'returnedtypecode', 'description'], (r) =>
              withDescription({ id: r.savedqueryid, name: r.name, entity: r.returnedtypecode }, r.description)));
          } else if (src.set === 'savedqueryvisualization') {
            inventory.charts.push(...await rowsByIds(sdk, 'savedqueryvisualization', 'savedqueryvisualizationid', ids, ['savedqueryvisualizationid', 'name', 'primaryentitytypecode', 'description'], (r) =>
              withDescription({ id: r.savedqueryvisualizationid, name: r.name, entity: r.primaryentitytypecode }, r.description)));
          } else if (src.set === 'systemform') {
            // `formxml` is pulled ONLY to detect a role restriction — it is never stored. A form's
            // security roles live inside formxml as `<DisplayConditions>` (there is no
            // systemform↔role relationship), and `forms[]` is not reconstructed by this download at
            // all, so a restricted form would come back as one every role can see. That is a silent
            // WIDENING of access on a cross-environment rebuild, which is why it is worth one extra
            // column on a query this download already makes.
            //
            // The flag is kept OFF the form entries and on a sibling key, because
            // `sanitizeDescriptionInventory` whitelists exactly five keys — so this reaches the
            // download CLI for its warning without leaking a new field into `app-spec.json`.
            const rawForms = await rowsByIds(sdk, 'systemform', 'formid', ids, ['formid', 'name', 'objecttypecode', 'description', 'formxml'], (r) => r);
            for (const r of rawForms) {
              if (!r || !r.objecttypecode || r.objecttypecode === 'none') continue;
              inventory.forms.push(withDescription({ id: r.formid, name: r.name, entity: r.objecttypecode }, r.description));
              if (isRoleRestrictedFormXml(r.formxml)) {
                inventory.roleRestrictedForms.push({ name: r.name, entity: r.objecttypecode });
              }
            }
          }
        } catch (err) {
          fail(INVENTORY_KIND_BY_SET[src.set] || src.set, err);
        }
      }
    } else {
      // No app-component parent means NONE of the three classes could be enumerated.
      for (const src of APP_COMPONENT_ENTITY_SOURCES) fail(INVENTORY_KIND_BY_SET[src.set] || src.set, new Error('the app\'s component list could not be read'));
    }
  } catch (err) {
    for (const src of APP_COMPONENT_ENTITY_SOURCES) fail(INVENTORY_KIND_BY_SET[src.set] || src.set, err);
  }

  try {
    if (solutionUniqueName && !isRestrictedSolution(solutionUniqueName)) {
      const esc = String(solutionUniqueName).replace(/'/g, "''");
      const sols = await sdk.queryRecords('solution', { select: ['solutionid'], filter: `uniquename eq '${esc}'`, top: 1 });
      const solId = sols && sols[0] && sols[0].solutionid;
      if (solId) {
        // Solution component type 29 is Workflow — which is EVERY process kind, not just business
        // rules: classic workflows, actions, business process flows and modern flows all land here.
        // See component type values: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/solutioncomponent
        //
        // So the rows must be narrowed after the fetch. A business rule is `category 2`, and `type 1`
        // is the DEFINITION — activating one makes Dataverse create a second `type 2` copy of it, so
        // without the type filter every active rule would appear twice in the inventory.
        //
        // Filtered client-side rather than in the query because `rowsByIds` batches on the id column;
        // both fields are requested in the select so the decision is made on real values, and a row
        // that reports NEITHER field is dropped rather than assumed to be a rule — fail closed, since
        // mislabelling somebody's classic workflow as a business rule is the failure mode here.
        const comps = await sdk.queryRecords('solutioncomponent', { select: ['objectid', 'componenttype'], filter: `_solutionid_value eq ${solId} and componenttype eq 29`, top: 1000 });
        const ids = (comps || []).map((r) => r && r.objectid).filter(Boolean);
        const processes = await rowsByIds(sdk, 'workflow', 'workflowid', ids, ['workflowid', 'name', 'primaryentity', 'description', 'category', 'type'], (r) => r);
        for (const r of processes) {
          if (Number(r && r.category) !== 2 || Number(r && r.type) !== 1) continue;
          inventory.businessRules.push(withDescription({ id: r.workflowid, name: r.name, entity: r.primaryentity }, r.description));
        }
      }
    }
  } catch (err) {
    // FAIL CLOSED, not silent. This used to swallow the error as "an inspection aid, not a rebuild
    // prerequisite", which was defensible while nothing consumed the list. It is not any more:
    // `notRoundTrippedSummary` now reports business rules as a class that does not round-trip, and it
    // reports a class only when it has rows — so a 403 or 500 here leaves the list empty and the
    // report silently asserts the app HAS no business rules. "Unknown" and "none" must never look
    // alike in a report whose entire purpose is naming what was left behind.
    fail('businessRules', err);
  }

  try {
    // Global option sets are not app components, but their Description is another Dataverse Label. This
    // is intentionally an inventory, not `globalChoices[]`: without options we cannot safely claim a
    // rebuildable choice definition.
    //
    // Read through the RAW client, NOT `sdk.queryRecords`. `queryRecords` resolves its first argument
    // to an entity SET name via `EntityDefinitions(LogicalName='<arg>')?$select=EntitySetName`, and
    // `GlobalOptionSetDefinitions` is a metadata collection rather than a table, so that lookup 404s
    // and the catch below would swallow it — leaving this inventory permanently empty while the
    // download still reported success. Same trap, and same fix, as readEntityWithDescriptions.
    //
    // `dataverse.get` RESOLVES on a non-2xx instead of throwing, so an unsuccessful or malformed
    // response has to be REJECTED explicitly. Coercing it to `[]` (the previous `|| []`) put the
    // failure beyond the catch's reach, so a metadata 403 was indistinguishable from an environment
    // with no global choices — and now that the report consumes this list, that reads as a positive
    // claim rather than an absence of information.
    //
    // Only UNMANAGED option sets are inventoried. A managed one ships with its solution and exists in
    // any environment that has that solution installed, so naming it as "not round-tripped" is false:
    // there is nothing for a rebuild to recreate. Measured live on a stock environment: 149 global
    // option sets total, of which exactly 1 was unmanaged — so reporting all of them buried the two
    // real findings (a form and a view) under 148 lines the maker can neither act on nor recognise.
    //
    // The filter is CLIENT-side because `GlobalOptionSetDefinitions` rejects `$filter` outright —
    // `?$filter=IsManaged eq false` answers HTTP 405 `0x80060888 "The query parameter $filter is not
    // supported on GlobalOptionSetDefinitions"`. `IsCustomOptionSet` is deliberately NOT the
    // discriminator: 59 of those 149 were "custom", nearly all of them first-party managed-solution
    // choices (msdyn_*, mspp_*), so it reproduces most of the noise.
    //
    // An ABSENT `IsManaged` keeps the row. This inventory's whole purpose is to avoid asserting an
    // absence it cannot substantiate, so an unreadable flag degrades to "report it" rather than to a
    // silent drop.
    const res = await sdk.dataverse.get('/GlobalOptionSetDefinitions?$select=Name,Description,IsManaged');
    if (!res || res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res && res.status}`);
    if (!res.body || !Array.isArray(res.body.value)) throw new Error('the response carried no value[] array');
    inventory.globalChoices.push(
      ...res.body.value
        .filter((r) => r && r.IsManaged !== true)
        .map((r) => withDescription({ name: r.Name }, r.Description))
    );
  } catch (err) {
    fail('globalChoices', err);
  }

  return Object.fromEntries(Object.entries(inventory).filter(([, value]) => value.length));
}

// Read pac's downloaded page tree (<pagesRoot>/<pageId>/{page.tsx,config.json,prompt.txt}) into
// pages[] entries with codeFile paths relative to `outDir`.
function parseDownloadedPages(pagesRoot, outDir, nameById) {
  const pages = [];
  if (!fs.existsSync(pagesRoot)) return pages;
  for (const entry of fs.readdirSync(pagesRoot)) {
    const dir = path.join(pagesRoot, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    const tsx = path.join(dir, 'page.tsx');
    if (!fs.existsSync(tsx)) continue;
    let config = {};
    try { config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')); } catch { /* optional */ }
    let prompt = '';
    try { prompt = fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8').trim(); } catch { /* optional */ }
    pages.push({
      pageId: entry,
      name: (nameById && nameById.get(String(entry).toLowerCase())) || entry,
      dataSources: config.dataSources || [],
      prompt,
      codeFile: path.relative(outDir, tsx).replace(/\\/g, '/'),
    });
  }
  return pages;
}

// Assign a STABLE key to every downloaded page + carry the manifest's v2 semantics. `keyToId` (from
// reconcilePageIds — the authority: manifest-confirmed-live id → unique live-name, ambiguous already
// HALTed upstream) binds manifest keys to live ids; a page bound there reuses that key + purpose/
// navigatesTo/pageInput/dataSources. A page with NO binding (legacy app / Maker-authored) gets a FRESH
// unique slug key (design §7.3 — NOT the old name shape, which drifted on rename). Returns idToKey for
// reverse-normalizing nav literals. Mutates pages. This uses reconcilePageIds, NOT a name-collapsing Map.
function assignPageKeys(pages, manifest, keyToId) {
  const idToKey = new Map();
  const used = new Set();
  const manifestByKey = new Map(((manifest && manifest.pages) || []).map((m) => [m.key, m]));
  // Build idToKey (lowercase-id → key) from the reconciled binding so reverseResolveNavIds can
  // rewrite nav pageId literals back to their symbolic keys (structural, nav literals only).
  for (const [key, id] of (keyToId || new Map())) { idToKey.set(String(id).toLowerCase(), key); used.add(key); }
  // Slug-minter: converts a display name to a stable lowercase slug. De-dupes with a -N suffix when
  // the same slug has already been assigned to another page (collision on rename or duplicate names).
  const mint = (name) => {
    const base = String(name || 'page').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
    let k = base;
    let i = 2;
    while (used.has(k)) k = `${base}-${i++}`;
    used.add(k);
    return k;
  };
  // First pass: assign keys to pages that are bound (manifest-confirmed-live id) + carry v2 semantics.
  for (const p of pages) {
    const bound = idToKey.get(String(p.pageId).toLowerCase());
    if (!bound) continue;
    p.key = bound;
    const m = manifestByKey.get(bound);
    if (m) {
      if (m.purpose !== undefined) p.purpose = m.purpose;
      if (m.navigatesTo) p.navigatesTo = m.navigatesTo;
      if (m.pageInput !== undefined) p.pageInput = m.pageInput;
      // Only copy manifest dataSources when the download gave us nothing (pac may include them).
      if (m.dataSources && !(p.dataSources || []).length) p.dataSources = m.dataSources;
    }
  }
  // Second pass: pages that had no binding get a fresh unique slug key.
  for (const p of pages) {
    if (!p.key) {
      p.key = mint(p.name);
      idToKey.set(String(p.pageId).toLowerCase(), p.key);
    }
  }
  return idToKey;
}

// Entries of `a` whose pageId is absent from `b`. Used BOTH directions to require exact enumerated<->
// downloaded id equality (I3). A gap either way means pac downloaded a different set than exists —
// rebuilding from this spec would silently drop/add pages, so download FAILS instead.
function missingDownloads(a, b) {
  const have = new Set((b || []).map((p) => String(p.pageId).toLowerCase()));
  return (a || []).filter((p) => !have.has(String(p.pageId).toLowerCase()));
}

// Minimal entity spec (schemaName + primary name column). The build reuses existing tables/columns
// idempotently, so column fidelity isn't required to re-apply an edit.
//
// The primary-name attribute MUST come from real Dataverse metadata. It used to fall back to a
// `<first-segment-of-logical>_name` guess, which is wrong for most out-of-the-box tables — `account`
// became `account_name` (really `name`) and `contact` became `contact_name` (really `fullname`). The
// guess was invisible on custom tables (`co_ticket` → `co_name`, which happens to be right), so the
// bug only surfaced on an app built from standard tables (ADO 6603392). The SDK's
// fetchEntityMetadata now $selects and returns PrimaryNameAttribute/SchemaName, so consume those.
//
// `primaryAttribute` is REQUIRED by App Spec validation, so this cannot simply omit it when metadata
// is missing — that would emit a spec the user cannot rebuild from at all. Instead the caller treats a
// missing primary name as a hard download failure, which is actionable at the point it happens rather
// than as a confusing validation error later. Returns `null` for `primaryAttribute` so the caller can
// detect and report it.
// Dataverse `AttributeType` -> App Spec column type. Only types the App Spec can actually declare
// are mapped; anything else (Lookup, Owner, State, Status, Uniqueidentifier, Virtual, ...) is a
// column the author never wrote — a Lookup comes from `relationships[]`, and the rest are platform
// plumbing — so it is left out of the hydrated spec entirely.
// See: https://learn.microsoft.com/en-us/dotnet/api/microsoft.xrm.sdk.metadata.attributetypecode
const SPEC_TYPE_FROM_ATTRIBUTE_TYPE = {
  String: 'Text', Memo: 'Memo', Picklist: 'Choice', MultiSelectPicklist: 'MultiChoice',
  Boolean: 'Boolean', Money: 'Money', DateTime: 'DateTime', Integer: 'Integer',
  BigInt: 'BigInt', Decimal: 'Decimal', Double: 'Double', File: 'File', Image: 'Image',
};

// Types whose App Spec declaration REQUIRES a companion field this hydrator cannot supply: a
// `Choice`/`MultiChoice` column must carry `options[]` or a `globalChoice` reference, and reading
// those needs a per-column typed-metadata expand the download does not perform. (Verified to be the
// ONLY such dependency: every other companion rule in `validateAppSpec` / `spec-lint` — AutoNumber's
// format, Calculated/Rollup's formula, Customer's description — is a warning, not an error.)
//
// So the column is emitted WITHOUT a type rather than with one that makes the whole spec fail
// validation ("column X: Choice needs options[] or a globalChoice reference") — which is what
// happened the moment types started being carried, live.
//
// This is NOT free, and the cost is surfaced rather than described as harmless. On a rebuild into an
// org that does NOT already have the table, `provisionDataModel` decides create-vs-reuse from org
// DISCOVERY (not from `existing`) and computes buildable columns as `SDK_COLUMN_TYPE[c.type ||
// 'Text']` — so a type-less Choice column is created as TEXT. The now-asymmetric result (Memo, Money
// and DateTime round-trip while Choice quietly degrades) is harder to notice than the old
// everything-is-Text, so the affected columns are warned about by name.
const TYPES_NEEDING_COMPANION_DATA = new Set(['Choice', 'MultiChoice']);

// The two Dataverse attribute CASTS that carry an option set. `Attributes` is a heterogeneous
// collection, so `OptionSet` can only be `$expand`ed through a cast segment — an uncast
// `/Attributes?$expand=OptionSet` is rejected because most attribute types have no such property.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query-metadata-web-api
//
// `GlobalOptionSet` is deliberately NOT expanded, even though it is the obvious-looking way to tell a
// shared set from a local one. LIVE-MEASURED against a stock org: it is populated for a LOCAL set
// too, echoing that local set's own Name (`account.accountcategorycode` -> IsGlobal:false, yet
// GlobalOptionSet.Name === "account_accountcategorycode"). Keying off its presence, or off its Name,
// would classify every local set as global and emit a `globalChoice` reference to a shared set that
// does not exist — so the rebuild would bind the column to nothing. `OptionSet.IsGlobal` is the only
// honest discriminator, and `OptionSet.Options` is populated for BOTH kinds (confirmed on a
// global-bound column: `contact.mspp_userpreferredlcid` returned all 45 options through `OptionSet`).
const OPTION_SET_CASTS = [
  { cast: 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata', type: 'Choice' },
  { cast: 'Microsoft.Dynamics.CRM.MultiSelectPicklistAttributeMetadata', type: 'MultiChoice' },
];

// Dataverse `AttributeTypeName` -> App Spec type, for the choice types ONLY. This is POSITIVE type
// evidence that does not depend on the option-set read succeeding, and it is why a Choice column now
// survives a failed or empty cast read instead of disappearing.
//
// It exists because `AttributeType` LIES for a multi-select: LIVE-MEASURED, a MultiSelectPicklist
// reports `AttributeType: "Virtual"` — indistinguishable from the synthetic `<column>name` shadows —
// and only `AttributeTypeName: "MultiSelectPicklistType"` identifies it. Relying on cast membership
// instead meant an unusable option label, a 503, or even a 200 with an empty `value[]` silently
// DELETED a real MultiChoice column from the spec, which is the loss this whole change exists to end.
// `AttributeTypeName` is a base `AttributeMetadata` property, so selecting it is safe on every
// supported Web API version.
const SPEC_TYPE_FROM_ATTRIBUTE_TYPE_NAME = { PicklistType: 'Choice', MultiSelectPicklistType: 'MultiChoice' };

// The App Spec type an attribute can be proven to have WITHOUT a successful option-set read.
function choiceTypeFromTypeName(a) {
  const name = a && a.AttributeTypeName && a.AttributeTypeName.Value;
  return name ? SPEC_TYPE_FROM_ATTRIBUTE_TYPE_NAME[name] : undefined;
}

// One downloaded option set, or null when it carries nothing this spec can declare. Shape:
//   { name: 'new_ticket_new_status', isGlobal: false, options: [<Dataverse Label>, ...] }
//
// The RAW Label is kept rather than a flattened string because the same option has to be emitted TWO
// different ways depending on where it lands: an inline `columns[].options[]` may be a localized LCID
// map, while a `globalChoices[]` option may NOT be (validateAppSpec rejects it, because Dataverse
// stores only the base language for a shared set and reports nothing when it drops the rest).
// Deriving both from one source keeps them from drifting.
//
// Option ORDER is preserved exactly as Dataverse returned it and is NOT sorted by `Value`. Dataverse
// returns options in their DISPLAY order, and the App Spec assigns `value = 100000000 + index` — so
// the array order is what a rebuild reproduces on screen. Sorting by Value would silently reorder the
// picker for any set whose author arranged it by hand.
function optionSetFromRow(row) {
  const os = row && row.OptionSet;
  if (!os || !Array.isArray(os.Options) || !os.Options.length) return null;
  const name = typeof os.Name === 'string' && os.Name.trim() ? os.Name : null;
  const labels = os.Options.map((o) => o && o.Label);
  // EVERY option must yield a usable label. A partially readable set cannot be emitted: dropping the
  // unreadable ones would shift every later option's index, and therefore its value, so a rebuild
  // would silently re-point existing data. Refusing to type the column is the honest outcome, and it
  // falls through to the untyped warning that already exists for exactly this case.
  if (labels.some((l) => descriptionFromDataverse(l) === undefined)) return null;
  return { ...(name ? { name } : {}), isGlobal: os.IsGlobal === true, options: labels };
}

// One INLINE Choice option's App Spec label. Localization is PRESERVED here — unlike a
// `globalChoices[]` option, which must be a plain string — because `columns[].options[]` round-trips
// an LCID map correctly. `labelFromDataverse` reads only `LocalizedLabels`, so a Label carrying just
// a `UserLocalizedLabel` falls back to the single-string unwrap rather than emitting `undefined`,
// which would fail validation with "options[i] must be a non-empty string".
function choiceOptionLabel(label) {
  const localized = labelFromDataverse(label);
  return localized !== undefined ? localized : descriptionFromDataverse(label);
}

// Read the option sets for every Choice / MultiChoice column on one table, keyed by lower-cased
// attribute logical name. THROWS on a failed read so the caller records WHY, rather than silently
// emitting a spec whose Choice columns degraded to Text.
async function readOptionSets(sdk, logical) {
  const byLogical = new Map();
  let failed = null;
  for (const { cast, type } of OPTION_SET_CASTS) {
    const url = `/${metadataEntityPath(logical)}/Attributes/${cast}?$select=LogicalName&$expand=OptionSet($select=Name,IsGlobal,Options)`;
    try {
      const res = await sdk.dataverse.get(url);
      // `dataverse.get` RESOLVES on a non-2xx rather than throwing, so the status must be checked
      // explicitly — the same trap documented on the description reads above.
      if (!res || res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res && res.status}`);
      if (!res.body || !Array.isArray(res.body.value)) throw new Error('the response carried no value[] array');
      for (const row of res.body.value) {
        const key = String((row && row.LogicalName) || '').toLowerCase();
        if (!key) continue;
        // The CAST that returned the row is authoritative for the TYPE, and it is recorded even when
        // the OPTIONS could not be parsed (`optionSetFromRow` -> null). Conflating the two DELETED
        // the column: a MultiChoice reports `AttributeType: "Virtual"`, so discarding this entry
        // discarded the only evidence it was an authorable column at all, and it vanished from the
        // spec while the warning claimed it had merely lost its type.
        byLogical.set(key, { ...(optionSetFromRow(row) || {}), type });
      }
    } catch (err) {
      // Per-cast, NOT fatal. The two casts are independent reads; throwing here discarded an
      // already-valid Picklist map whenever the multi-select cast failed, so a single transient 503
      // stripped the type off every Choice column on the table. Keep what was read, report the rest.
      if (!failed) failed = (err && err.message) ? String(err.message).slice(0, 200) : 'read failed';
    }
  }
  return { byLogical, failed };
}

// Gather the SHARED option sets a downloaded table binds to, into `into` (name-keyed, so one set
// bound by several columns is declared once). Global sets must be declared in `spec.globalChoices[]`
// or a rebuild into a FRESH environment has nothing to bind the column to — `createGlobalOptionSet`
// is idempotent (it probes by Name and reuses), so declaring one that already exists is safe.
//
// Options are FLATTENED to a single string here, unlike the inline case: `validateAppSpec` rejects a
// localized `globalChoices[]` option outright, because Dataverse accepts the multi-language payload
// for a shared set and stores only the base language without reporting the loss.
function collectGlobalChoices(meta, into) {
  for (const a of (meta && meta.attributes) || []) {
    const os = a && a.optionSet;
    if (!os || !os.isGlobal || !os.name) continue;
    const key = String(os.name).toLowerCase();
    if (into.has(key)) continue;
    into.set(key, { name: os.name, options: os.options.map((l) => descriptionFromDataverse(l)) });
  }
  return into;
}

// Reduce the collected global-choice CANDIDATES to the ones an EMITTED column actually references,
// and canonicalize every reference to the declaration's own casing.
//
// Both halves close real defects. `collectGlobalChoices` scans RAW metadata, which runs before
// `entityFromMetadata` filters attributes and before an entity with no primary name is dropped — so
// a set bound only by a system attribute, or by a table that never made it into the spec, produced
// an ORPHAN declaration. That is not cosmetic: `provisionDataModel` calls `createGlobalOptionSet`
// for every declaration, so the rebuild wrote an option set into the target environment that nothing
// in the app uses.
//
// The casing half: declarations are de-duplicated on a lower-cased key, but each column kept the raw
// `OptionSet.Name` casing Dataverse happened to return for it. `entity-provision` then looks up
// `globalChoiceIds[c.globalChoice]` CASE-SENSITIVELY, so a second casing of the same set left that
// column unbound and it silently fell back to an EMPTY inline option list. Rewriting the references
// here keeps that fix in one place rather than relying on every consumer to normalize.
function finalizeGlobalChoices(entities, candidates) {
  const byKey = candidates instanceof Map ? candidates : new Map();
  const referenced = new Map(); // lower-cased name -> declaration
  for (const e of entities || []) {
    for (const c of (e && e.columns) || []) {
      if (!c || !c.globalChoice) continue;
      const key = String(c.globalChoice).toLowerCase();
      const decl = byKey.get(key);
      if (!decl) continue;
      c.globalChoice = decl.name;
      if (!referenced.has(key)) referenced.set(key, decl);
    }
  }
  return [...referenced.values()];
}

// Does this form's `formxml` restrict it to particular security roles?
//
// The roles live INSIDE formxml, as a `<DisplayConditions>` child of `<form>` — `systemform` has no
// role relationship at all — e.g.:
//
//   <DisplayConditions Order="2" FallbackForm="false"><Role Id="{GUID}" /></DisplayConditions>
//
// The unrestricted default is the sibling shape `<DisplayConditions ...><Everyone /></...>`, or no
// element at all. Only the `<Role>` form is a restriction, so match on that specifically rather than
// on the presence of `<DisplayConditions>`, which every form has.
//
// Attribute order and casing vary between platform-authored and SDK-authored xml, so this matches
// the element name case-insensitively and does not assume `Id` is the first attribute.
function isRoleRestrictedFormXml(formxml) {
  const xml = String(formxml || '');
  const block = xml.match(/<DisplayConditions[\s\S]*?<\/DisplayConditions>/i);
  if (!block) return false;
  return /<Role\b/i.test(block[0]);
}

// Which of the app's DEPLOYED artifact classes this download does not reconstruct. AB#6686423.
//
// `forms[]`, `views[]` and `charts[]` are emitted EMPTY by hydrateSpec (see the note there for why
// each is blocked). The artifacts themselves are already captured — `descriptionInventory` in the
// written app-spec.json lists every one of them by id, name and table — but until this reporter
// existed nothing SAID they were missing from the rebuildable part of the spec. The reported
// symptom was exactly that: "it emitted empty forms and views ... with nothing reporting the loss".
//
// This is a REPORT, not a gate. Blocking would be wrong: every app has forms and views, so a
// failure here would break every download, and the omission is not destructive in the environment
// the app was downloaded from — a rebuild there does not delete artifacts the spec omits. The loss
// is real only when rebuilding into a DIFFERENT environment, and the message says so rather than
// stating a blanket "dropped".
//
// Returns null when there is nothing to report, so a caller can skip the warning entirely.
function notRoundTrippedSummary(inventory) {
  // Data-driven, and the set is derived from what `hydrateSpec` actually emits — NOT from what is
  // convenient to format. `hydrateSpec` returns `views: []`, `charts: []`, `forms: []`,
  // `commands: []` and no `businessRules`/`globalChoices` key at all, so all of these are absent
  // from the rebuildable spec. Reporting only forms/views/charts contradicted the report's own
  // purpose and left a business rule — a real cross-environment loss — silent.
  //
  // `entityScoped: false` for global choices because they are ORG-wide: grouping one under a table
  // would invent a relationship the platform does not have.
  //
  // ⚠ `commands[]` is missing from this list for a different reason, and it is a KNOWN gap rather
  // than an oversight: `readDescriptionInventory` never collects commands, so there is no count to
  // report. Adding the class here would emit a permanent "0 commands" that reads as "this app has
  // none" — the exact false reassurance the `incomplete` channel exists to avoid. Inventory them
  // first, then add the class.
  const CLASSES = [
    { key: 'forms', label: 'form', entityScoped: true },
    { key: 'views', label: 'view', entityScoped: true },
    { key: 'charts', label: 'chart', entityScoped: true },
    { key: 'businessRules', label: 'business rule', entityScoped: true },
    { key: 'globalChoices', label: 'global choice', entityScoped: false },
  ];
  const classes = [];
  const orgScoped = []; // [{ key, label, names: [] }] — classes with no owning table
  const byEntity = new Map(); // table logical -> { <classKey>: [names] }
  const blankEntityRow = () => Object.fromEntries(CLASSES.filter((c) => c.entityScoped).map((c) => [c.key, []]));
  for (const { key, label, entityScoped } of CLASSES) {
    const rows = (inventory && Array.isArray(inventory[key]) ? inventory[key] : []).filter((r) => r && r.name);
    if (!rows.length) continue;
    classes.push({ kind: key, count: rows.length, label });
    if (!entityScoped) {
      orgScoped.push({ kind: key, label, names: rows.map((r) => String(r.name)).sort((a, b) => a.localeCompare(b)) });
      continue;
    }
    for (const r of rows) {
      const entity = String(r.entity || 'unknown').toLowerCase();
      if (!byEntity.has(entity)) byEntity.set(entity, blankEntityRow());
      byEntity.get(entity)[key].push(r.name);
    }
  }
  // A class whose read FAILED is reported too, and is the reason this cannot simply return null on an
  // empty inventory: "no forms were found" and "the forms query returned 403" look identical from
  // here, and treating the second as the first is precisely the silent-loss bug being fixed. An
  // UNKNOWN class is worse than a known-omitted one, so it is surfaced even when nothing was read.
  const incomplete = (inventory && Array.isArray(inventory.incomplete) ? inventory.incomplete : [])
    .filter((i) => i && i.kind)
    .map((i) => ({ kind: i.kind, reason: i.reason || 'read failed' }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
  if (!classes.length && !incomplete.length) return null;
  // Sorted at EVERY level, not just the table one. The rows arrive from `queryRecords`, i.e. in
  // whatever order Dataverse returned them, which carries no ordering guarantee — so two downloads
  // of an unchanged app could emit the same artifacts in a different order. This block is written
  // into the operator's output and compared between runs, so an unstable order reads as a change
  // that did not happen, which is the opposite of the point: the report exists to make a real
  // difference visible. `classes` is already deterministic (built from the fixed CLASSES list).
  const entityKeys = CLASSES.filter((c) => c.entityScoped).map((c) => c.key);
  return {
    classes,
    total: classes.reduce((n, c) => n + c.count, 0),
    entities: [...byEntity.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([entity, v]) => ({
        entity,
        ...Object.fromEntries(entityKeys.map((k) => [k, [...(v[k] || [])].sort((a, b) => String(a).localeCompare(String(b)))])),
      })),
    ...(orgScoped.length ? { orgScoped } : {}),
    ...(incomplete.length ? { incomplete } : {}),
  };
}

// Drop from the not-round-tripped inventory the global choices this download DOES now reconstruct
// (#564). The report's whole value is that its claims are true: a shared set emitted into
// `spec.globalChoices[]` IS carried forward, so listing it as "not round-tripped" would be the same
// class of false statement the report exists to prevent. Every other global choice in the
// environment stays listed — the app does not bind it, so a rebuild genuinely will not recreate it.
function roundTrippedAware(inventory, globalChoiceDecls) {
  if (!inventory || !Array.isArray(inventory.globalChoices) || !globalChoiceDecls || !globalChoiceDecls.size) return inventory;
  const declared = globalChoiceDecls;
  const remaining = inventory.globalChoices.filter((g) => !(g && g.name && declared.has(String(g.name).toLowerCase())));
  // Drop the key entirely when nothing is left: `notRoundTrippedSummary` skips an empty class, and an
  // empty array would otherwise be indistinguishable from "the read returned no rows".
  const { globalChoices, ...rest } = inventory;
  void globalChoices;
  return remaining.length ? { ...rest, globalChoices: remaining } : rest;
}

// Render `notRoundTrippedSummary` as the operator-facing warning. Kept separate from the computation
// so the wording is testable without a download, and so the same summary can be emitted as JSON.
function notRoundTrippedWarning(summary) {
  if (!summary) return '';
  const lines = [];
  if (summary.classes.length) {
    const counts = summary.classes.map((c) => `${c.count} ${c.label}${c.count === 1 ? '' : 's'}`).join(', ');
    // The class list is rendered from the summary rather than hardcoded. It used to read
    // "forms[], views[] or charts[]" regardless of what was actually reported, so once business
    // rules and global choices joined the inventory the sentence named the wrong things — a report
    // about silent loss quietly misdescribing its own contents.
    const names = summary.classes.map((c) => (c.kind === 'globalChoices' ? 'globalChoices[]' : `${c.kind}[]`)).join(', ');
    const tables = summary.entities.length;
    lines.push(
      `NOTE: this download does not reconstruct ${names} — ${counts}${tables ? ` on ${tables} table(s)` : ''} are absent from the rebuildable spec.`,
      '  They are NOT lost: every one is listed under `descriptionInventory` in app-spec.json, and they remain on the deployed app.',
      '  Rebuilding into THIS environment leaves them untouched. Rebuilding into a DIFFERENT environment will NOT recreate them —',
      `  re-declare the ones you need in ${names}, or copy them with a solution export.`,
    );
    for (const e of summary.entities) {
      const parts = [];
      for (const c of summary.classes) {
        const list = e[c.kind];
        if (Array.isArray(list) && list.length) parts.push(`${c.kind}: ${list.join(', ')}`);
      }
      if (parts.length) lines.push(`    ${e.entity} — ${parts.join('; ')}`);
    }
    // Org-scoped classes are listed separately and WITHOUT a table, because they do not belong to
    // one; filing a global choice under a table would assert a relationship Dataverse does not have.
    for (const o of summary.orgScoped || []) {
      lines.push(`    (environment-wide) ${o.kind}: ${o.names.join(', ')}`);
    }
  }
  if (summary.incomplete && summary.incomplete.length) {
    lines.push(
      `WARNING: ${summary.incomplete.length} artifact class(es) could NOT be inventoried, so this download cannot say what it left behind:`,
    );
    for (const i of summary.incomplete) lines.push(`    ${i.kind} — ${i.reason}`);
    lines.push('  Treat an empty list for those classes as UNKNOWN, not as "the app has none".');
  }
  return `${lines.join('\n')}\n`;
}

// Columns whose type could not be substantiated, so a `download -> rebuild into a fresh org` round
// trip does not silently create them as Text. `type` is absent for a Choice/MultiChoice (above), or
// for an attribute whose metadata carried no `attributeType` at all — an attribute with a type that
// simply has no App Spec equivalent is filtered out of `columns[]` entirely, so it never gets here.
function untypedColumnNames(entities) {
  const out = [];
  for (const e of entities || []) {
    for (const c of (e.columns || [])) {
      if (c && c.schemaName && c.type === undefined) out.push(`${e.schemaName}.${c.schemaName}`);
    }
  }
  return out;
}

function entityFromMetadata(meta, logical) {
  const primary = meta && (meta.primaryNameAttribute || meta.primaryNameLogicalName);
  const attrs = Array.isArray(meta && meta.attributes) ? meta.attributes : (Array.isArray(meta && meta.Attributes) ? meta.Attributes : []);
  const primaryLower = String(primary || '').toLowerCase();
  const columns = attrs.filter((a) => {
    if (!a) return false;
    const name = String(a.schemaName || a.SchemaName || a.logicalName || a.LogicalName || '').toLowerCase();
    // The primary name column is declared separately as `primaryAttribute`, so it must not ALSO
    // appear in `columns[]`.
    if (!name || name === primaryLower) return false;
    // CUSTOM attributes only. `fetchEntityMetadata` returns the FULL attribute list — `createdon`,
    // `versionnumber`, `importsequencenumber`, `owningbusinessunit` and the rest — and emitting
    // those as spec columns is not merely noisy, it is destructive: `columns[]` feeds
    // `defaultViewColumns`, which `enrichDefaultViews` uses to REPLACE the Active/Inactive views'
    // column set. A downloaded spec that listed system attributes would rewrite a customer's
    // default views to `Created On` / `Import Sequence Number` on the next rebuild, undoing fix #7
    // ("drop Created On from enriched default views") whose invariant is stated at
    // sdk-build.js `defaultViewColumns`: the set only ever contains DECLARED spec columns.
    const isCustom = a.isCustomAttribute !== undefined ? a.isCustomAttribute : a.IsCustomAttribute;
    if (isCustom === false) return false;
    // SYNTHETIC SHADOW attributes. Creating a lookup also creates a formatted-name attribute
    // (`<lookup>name`) which LIVE-MEASURED reports `AttributeType: "String"` AND
    // `IsCustomAttribute: true` — so neither the type map nor the custom-only filter above excludes
    // it, and a downloaded spec declared a REAL Text column named after a lookup's shadow. Measured
    // consequence: a fresh-environment rebuild created `<table>.<lookup>name (Text)`, an invented
    // column that also collides with the name the real lookup's own shadow needs. `IsLogical` (the
    // value is not stored on this table) is the distinguishing fact.
    //
    // Gated on positive TYPE EVIDENCE, not on "logical" alone: an attribute is dropped only when it
    // is logical AND nothing proves it is a real choice column (no parsed option set, and no
    // `AttributeTypeName` saying Picklist/MultiSelectPicklist). Keying only off `optionSet ===
    // undefined` dropped a genuine logical Choice whenever its option-set read failed, and the
    // untyped warning then promised a Text column that a rebuild would never create.
    //
    // HONESTY NOTE on the example this rule is often justified with: every logical choice attribute
    // found on stock tables — `address1_addresstypecode` and its five `address1_`/`address2_` twins
    // on account, plus the equivalents on contact/systemuser/businessunit, 23 in total — is
    // `IsCustomAttribute: false`, so the custom-only check above already drops them and they never
    // reach this rule. No CUSTOM logical choice column was found on a live org, so the exemption is
    // DEFENSIVE rather than demonstrated load-bearing. It is kept because dropping on "logical"
    // alone becomes a silent column deletion the moment such a column does exist, which is the exact
    // failure class this change exists to end.
    //
    // An ABSENT flag KEEPS the attribute, matching the `isCustom === false` rule above: "we could not
    // look" must not be turned into a deletion. The direction matters — `IsLogical` is absent for
    // EVERY attribute when the read fails, so dropping on absent would empty the table's `columns[]`
    // entirely. The residual cost is that a failed read re-enables the shadow leak, which is why the
    // label-read warning now names that consequence explicitly.
    const isLogical = a.IsLogical !== undefined ? a.IsLogical : a.isLogical;
    if (isLogical === true && a.optionSet === undefined && choiceTypeFromTypeName(a) === undefined) return false;
    // SHADOW-OF, the precise form of the same rule. `AttributeOf` names the attribute this one is a
    // projection of, so a non-empty value is positive proof the column was never authored — no type
    // inference and no relationship context needed.
    //
    // This is not redundant with the `IsLogical` rule above. LIVE-MEASURED on a polymorphic
    // (`Customer`-type) lookup `cfo_billto` targeting account + contact:
    //   cfo_billtoname      AttributeOf=cfo_billto  IsLogical=FALSE  AttributeType=String
    //   cfo_billtoyominame  AttributeOf=cfo_billto  IsLogical=FALSE  AttributeType=String
    //   cfo_customeridname  AttributeOf=cfo_customerid  IsLogical=TRUE  (single-target — already caught)
    // The polymorphic shadows are physically stored, so `IsLogical` is false and the rule above
    // cannot see them; they were emitted as real Text columns and a fresh-environment rebuild
    // invented two text fields where a lookup used to be (#574). A real column — including the
    // lookup itself — reports `AttributeOf: null`, so nothing authored is at risk.
    //
    // Absent KEEPS the attribute, matching every other rule here: when the label read fails no
    // attribute carries `AttributeOf`, and "we could not look" must not become a column deletion.
    if (a.AttributeOf) return false;
    // BASE-CURRENCY TWIN. Dataverse generates a `<money>_base` column beside every Money column. It
    // carries no `AttributeOf`, is not logical, and reports `IsCustomAttribute: true`, so every rule
    // above is blind to it — and emitting it meant a rebuild tried to CREATE a column the platform
    // generates for itself.
    //
    // `IsBaseCurrency` is the ONLY unambiguous signal. `IsValidForCreate: false` is NOT a substitute:
    // it is a per-column write capability this spec deliberately supports on authored columns
    // (`isValidForCreate` in app-spec-schema.md), so filtering on it turns a round-trip into a
    // deletion of a legitimately read-only column. LIVE-MEASURED on stock `opportunity`:
    //   estimatedvalue       IsBaseCurrency=false  IsValidForCreate=true
    //   estimatedvalue_base  IsBaseCurrency=TRUE   IsValidForCreate=false
    //   totalamount          IsBaseCurrency=false  IsValidForCreate=FALSE  <- real column, must KEEP
    // `totalamount` is exactly the column the capability flag would have wrongly deleted.
    //
    // Absent KEEPS the attribute, like every other rule here: `IsBaseCurrency` only rides along when
    // the Money cast read succeeded, and "we could not look" must never become a column deletion.
    if (a.IsBaseCurrency === true) return false;
    // Keep only attribute types the App Spec can declare (see the map above), PLUS any attribute the
    // option-set read matched, PLUS any attribute `AttributeTypeName` proves is a choice. That last
    // clause is what keeps a MultiChoice when the cast read failed or came back empty: its
    // `AttributeType` is `Virtual`, so nothing else would admit it.
    const at = a.attributeType || a.AttributeType;
    return at === undefined || SPEC_TYPE_FROM_ATTRIBUTE_TYPE[at] !== undefined || a.optionSet !== undefined || choiceTypeFromTypeName(a) !== undefined;
  }).map((a) => {
    const schemaName = (a && (a.schemaName || a.SchemaName || a.logicalName || a.LogicalName)) || '';
    // The SDK projects `attributeType`, NOT `type`. Reading `a.type` yielded `undefined` on every
    // column, which silently disabled every type-based filter downstream (`DEFAULT_VIEW_SKIP_TYPES`
    // skips Memo/File/Image; `SDK_COLUMN_TYPE` decides what an auto form layout places).
    const at = a && (a.attributeType || a.AttributeType);
    // The option set's own type WINS over the attributeType map, because for a MultiChoice the map
    // is wrong: Dataverse reports `Virtual`. `readOptionSets` always stamps `type` from the CAST
    // that returned the row — even when the options themselves were unparseable — so this covers
    // every attribute either cast saw.
    //
    // `choiceTypeFromTypeName` is deliberately NOT consulted here. It is load-bearing in the two
    // FILTER decisions below (keeping a column the casts never returned, and not mistaking a real
    // logical Choice for a shadow), but for the TYPE it would be redundant: whenever it could speak,
    // either `os.type` already said the same thing, or there is no option set and the column is left
    // untyped regardless. A mutation removing it from this expression was not detectable by any
    // test, which is the signal that it was decoration rather than logic.
    const os = (a && a.optionSet) || null;
    const mapped = (a && a.type) || (os && os.type) || SPEC_TYPE_FROM_ATTRIBUTE_TYPE[at];
    // Companion data for a Choice/MultiChoice (see TYPES_NEEDING_COMPANION_DATA). Present -> the
    // column carries its REAL type plus the `options[]`/`globalChoice` its declaration requires.
    // Absent -> it stays untyped and is named in the untyped-column warning, because emitting
    // `type: "Choice"` with neither companion produces a spec that fails its own validation.
    //
    // `os.options` can be absent even when `os` exists: the cast identified the column but its
    // labels were unreadable. That is deliberately treated as "no companion data" — the column is
    // kept (it IS a real column) but left untyped.
    const optionSet = TYPES_NEEDING_COMPANION_DATA.has(mapped) && os && Array.isArray(os.options) ? os : null;
    // A shared set is REFERENCED, not inlined, so a rebuild binds all its columns to one option set
    // instead of minting a private copy per column. An unnamed global set (no `Name` came back) has
    // nothing to reference, so it degrades to inline options rather than emitting a dangling ref.
    //
    // INLINE labels are additionally screened for an AMBIGUOUS alias, and that screen is the
    // difference between one bad column and no download at all. Option labels need not be unique
    // across options OR languages in Dataverse, so `["Open", {1033:"Closed", 3082:"Open"}]` is legal
    // — but "Open" then names two options, which `validateAppSpec` treats as an ERROR whenever
    // either side is localized (the collision is invisible on the page, so it cannot be a warning).
    // `runDownload` validates before writing and returns on failure, so emitting such a set aborted
    // the ENTIRE app's download, and `--allow-lossy-download` does not bypass that gate. Refusing to
    // type just this column falls back to the untyped warning that already exists for an unreadable
    // label, which is what the download did before types were carried at all.
    //
    // The shared `ambiguousChoiceAliases` is reused rather than reimplemented, so this screen and
    // the validator can never disagree about what "ambiguous" means.
    const inlineOptions = optionSet && !(optionSet.isGlobal && optionSet.name)
      ? optionSet.options.map(choiceOptionLabel)
      : null;
    const inlineIsAmbiguous = inlineOptions ? ambiguousChoiceAliases(inlineOptions).some((c) => c.hidden) : false;
    const usableOptionSet = inlineIsAmbiguous ? null : optionSet;
    const specType = TYPES_NEEDING_COMPANION_DATA.has(mapped) && !usableOptionSet ? undefined : mapped;
    const choice = !usableOptionSet ? {}
      : (usableOptionSet.isGlobal && usableOptionSet.name
        ? { globalChoice: usableOptionSet.name }
        : { options: inlineOptions });
    return withDescription({
      schemaName,
      // A column labelled in several languages round-trips as an LCID map; one language stays a
      // plain string (AB#6686428). Resolution order, and every step must yield a STRING or a map —
      // never a raw Dataverse Label object:
      //   1. the RAW `DisplayName` Label merged in by readEntityWithDescriptions (the only source
      //      that carries every language),
      //   2. the SDK's own already-flattened `displayName` string,
      //   3. a single-language Label unwrapped by descriptionFromDataverse.
      //
      // Step 2 is not optional tidiness. LIVE-MEASURED: a synthetic lookup `*name` column such as
      // `cfo_customeridname` carries `{"LocalizedLabels":[],"UserLocalizedLabel":null}` — a wholly
      // EMPTY Label. `labelFromDataverse` correctly returns undefined for it, and an `|| a.DisplayName`
      // tail would then emit that raw object as the column's displayName, producing a spec that fails
      // its own validation with "'LocalizedLabels' is not an LCID". Omitting the label entirely is the
      // right answer: Dataverse has none either.
      ...(columnDisplayName(a) !== undefined ? { displayName: columnDisplayName(a) } : {}),
      ...(specType ? { type: specType } : {}),
      ...choice,
    }, a && (a.description !== undefined ? a.description : a.Description));
  }).filter((c) => c.schemaName);
  // Table label + plural. When the table carries more than one language, BOTH must round-trip and
  // `pluralName` becomes required (validateAppSpec refuses to derive a plural from a label map), so
  // the plural is emitted whenever the display name is localized.
  const displayName = labelFromDataverse(meta && meta.DisplayName);
  const pluralName = labelFromDataverse(meta && meta.DisplayCollectionName);
  // The primary column's own label. It is EXCLUDED from `columns[]` (it is declared separately as
  // `primaryAttribute`), so its label has to be read from the un-filtered attribute list here —
  // otherwise a table whose primary column is called "Order Title" / "Título del pedido" downloads
  // as the hardcoded "Name", and a fresh-environment rebuild loses both the real label and its
  // translations. `'Name'` remains the fallback for a metadata read that carried no label at all.
  const primaryAttr = primaryLower ? attrs.find((a) => String((a && (a.logicalName || a.LogicalName || a.schemaName || a.SchemaName)) || '').toLowerCase() === primaryLower) : null;
  const primaryLabel = columnDisplayName(primaryAttr);
  return {
    schemaName: (meta && (meta.schemaName || meta.logicalName)) || logical,
    displayName: displayName !== undefined ? displayName : ((meta && meta.displayName) || logical),
    // Emitted when EITHER label is localized, not only when the singular is. `validateAppSpec`
    // requires `pluralName` beside a localized `displayName`, which is why the singular's shape is
    // checked — but a table can carry a single-language `DisplayName` and a multi-language
    // `DisplayCollectionName` (the two are independent in Dataverse, and an unprovisioned language is
    // dropped per-label on read). Keying only off the singular silently discarded those plural
    // translations and a rebuild then derived an English plural. Two PLAIN labels still omit it: a
    // plain plural is derivable and emitting it would add noise to every download.
    ...((isLocalizedLabelMap(displayName) || isLocalizedLabelMap(pluralName)) && pluralName !== undefined ? { pluralName } : {}),
    ...(descriptionFromDataverse(meta && (meta.description !== undefined ? meta.description : meta.Description)) ? { description: descriptionFromDataverse(meta && (meta.description !== undefined ? meta.description : meta.Description)) } : {}),
    // Never synthesized: a fabricated attribute name yields a spec that references a column Dataverse
    // does not have, which is exactly the bug this fixes.
    primaryAttribute: primary ? { schemaName: primary, displayName: primaryLabel !== undefined ? primaryLabel : 'Name' } : null,
    columns,
    // Flag every recovered table as pre-existing so a teardown of THIS downloaded spec never deletes the
    // table (+ its data). Download cannot prove which tables the app CREATED vs merely REFERENCED, and
    // deleting a customer's table/data is unrecoverable while an orphaned table is not — so fail safe.
    // (The build re-applies a downloaded spec by discovery regardless of this flag; and hydrate emits no
    // forms, so the build's `existing`-gated default-form promotion path is not reached here anyway.)
    existing: true,
  };
}

function metadataEntityPath(logical) {
  return `EntityDefinitions(LogicalName='${String(logical).replace(/'/g, "''")}')`;
}

async function readEntityWithDescriptions(sdk, logical) {
  const meta = { ...(await sdk.fetchEntityMetadata(logical)) };
  // The SDK's fetchEntityMetadata projection is enough for identity but carries NO descriptions —
  // measured against a live org, its entity keys are logicalName/schemaName/displayName/
  // entitySetName/primaryNameAttribute/primaryIdAttribute/isCustomEntity/attributes/relationships,
  // and each attribute is {logicalName, displayName, attributeType, isCustomAttribute, targets}.
  // So descriptions require a second read against the metadata endpoints.
  //
  // This deliberately does NOT go through `sdk.queryRecords`. That helper first resolves its
  // argument to an entity SET name via `EntityDefinitions(LogicalName='<arg>')?$select=EntitySetName`,
  // so handing it a metadata path produces a nested nonsense URL and a 404:
  //   .../EntityDefinitions(LogicalName='EntityDefinitions(LogicalName=''contoso_workitem'')')?$select=EntitySetName
  // Combined with the best-effort catch below, that failed silently for EVERY table — the download
  // reported success and dropped every table and column description. `sdk.dataverse` is the raw
  // client and takes an API-relative path verbatim.
  //
  // NOTE `dataverse.get` RESOLVES with `{ status, headers, body }` on a non-2xx rather than throwing
  // (a 404 returns status 404), so the status MUST be checked explicitly. A try/catch alone would
  // reintroduce exactly the silence this replaces.
  const entityPath = `/${metadataEntityPath(logical)}`;
  try {
    // DisplayName / DisplayCollectionName are read alongside Description so a table labelled in more
    // than one language round-trips (AB#6686428). The SDK's own `fetchEntityMetadata` projection
    // flattens `displayName` to ONE string, which is enough for identity but silently loses every
    // other language — a rebuild from such a spec would recreate the table English-only.
    const res = await sdk.dataverse.get(`${entityPath}?$select=LogicalName,Description,DisplayName,DisplayCollectionName`);
    if (res && res.status >= 200 && res.status < 300 && res.body) {
      meta.Description = res.body.Description;
      meta.DisplayName = res.body.DisplayName;
      meta.DisplayCollectionName = res.body.DisplayCollectionName;
    } else {
      // A non-2xx is NOT "this table has no extra languages" — it is "we could not look". Recorded so
      // the caller can say so; see the catch below for why silence here is the wrong default.
      meta.labelReadFailed = `HTTP ${res && res.status}`;
    }
  } catch (err) {
    meta.labelReadFailed = (err && err.message) ? String(err.message).slice(0, 200) : 'read failed';
  }
  try {
    // Merge onto the SDK's attribute list rather than replacing it: `fetchEntityMetadata` supplies
    // `targets` (lookup target tables) and `attributeType`, which this projection does not, and
    // entityFromMetadata/other callers rely on them.
    //
    // This read carries the SAME weight as the table-level one above: it is the only source of
    // multi-language labels for every non-primary COLUMN and for the primary attribute. Treating it
    // as "column descriptions are best-effort" was right when descriptions were all it fetched, and
    // became wrong the moment labels rode along — a 403 here returns a spec whose columns are
    // single-language, with nothing saying so. Same recording, same reason.
    // `IsLogical` rides along for the synthetic-shadow filter in entityFromMetadata: a lookup's
    // formatted-name attribute (`<lookup>name`) reports IsCustomAttribute TRUE and AttributeType
    // String, so nothing else distinguishes it from a real Text column the author wrote.
    // `AttributeOf` rides along for the same filter and is the STRONGER signal: it names the
    // attribute a shadow belongs to, and a POLYMORPHIC lookup's shadows report `IsLogical: false`
    // (live-measured), so `IsLogical` alone cannot see them.
    const res = await sdk.dataverse.get(`${entityPath}/Attributes?$select=LogicalName,Description,DisplayName,IsLogical,AttributeOf,AttributeTypeName`);
    if (!res || res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res && res.status}`);
    if (!res.body || !Array.isArray(res.body.value)) throw new Error('the response carried no value[] array');
    const rows = res.body.value;
    const byLogical = new Map(rows.filter((r) => r && r.LogicalName).map((r) => [String(r.LogicalName).toLowerCase(), r]));
    meta.attributes = (meta.attributes || []).map((a) => {
      const key = String((a && (a.logicalName || a.LogicalName)) || '').toLowerCase();
      const row = byLogical.get(key);
      return row ? { ...a, Description: row.Description, DisplayName: row.DisplayName, IsLogical: row.IsLogical, AttributeOf: row.AttributeOf, AttributeTypeName: row.AttributeTypeName } : a;
    });
  } catch (err) {
    // Recorded, not swallowed — and it does NOT overwrite a table-level failure already recorded
    // above, because the first reason is the more useful one to show and both describe the same
    // outcome for the operator: this table came back single-language.
    if (!meta.labelReadFailed) {
      meta.labelReadFailed = (err && err.message) ? String(err.message).slice(0, 200) : 'read failed';
    }
  }
  try {
    // Base-currency twins. `IsBaseCurrency` lives on MoneyAttributeMetadata, not on the base
    // attribute type, so it needs its own CAST read — the same shape the option-set reads below use.
    //
    // This is the only unambiguous way to recognise the `<money>_base` column Dataverse generates
    // beside every Money column. It reports no `AttributeOf`, is not logical, and is
    // `IsCustomAttribute: true`, so nothing else in the projection distinguishes it from a column the
    // author wrote — and emitting it made a rebuild try to create a column the platform owns.
    //
    // Best-effort on purpose: a failure leaves `IsBaseCurrency` absent on every attribute, and the
    // filter KEEPS an attribute whose flag it could not read. The cost of a failed read is the twin
    // reappearing, never a real column disappearing.
    const res = await sdk.dataverse.get(`${entityPath}/Attributes/Microsoft.Dynamics.CRM.MoneyAttributeMetadata?$select=LogicalName,IsBaseCurrency`);
    if (res && res.status >= 200 && res.status < 300 && res.body && Array.isArray(res.body.value)) {
      const baseCurrency = new Set(res.body.value
        .filter((r) => r && r.LogicalName && r.IsBaseCurrency === true)
        .map((r) => String(r.LogicalName).toLowerCase()));
      if (baseCurrency.size) {
        meta.attributes = (meta.attributes || []).map((a) => {
          const key = String((a && (a.logicalName || a.LogicalName)) || '').toLowerCase();
          return baseCurrency.has(key) ? { ...a, IsBaseCurrency: true } : a;
        });
      }
    }
  } catch {
    /* best-effort: absent IsBaseCurrency keeps the column, which is the safe direction */
  }
  try {
    // Choice / MultiChoice option sets (#564). A SEPARATE read from the attribute one above, and it
    // has to be: `OptionSet` can only be `$expand`ed through a type CAST, which the heterogeneous
    // `Attributes` collection cannot carry (see OPTION_SET_CASTS). Without it every Choice column
    // downloads WITHOUT a type, and a rebuild into a FRESH environment creates it as single-line
    // Text while a rebuild into the ORIGINAL environment silently reuses the real column — an
    // asymmetry that is much harder to notice than an outright failure.
    const { byLogical, failed } = await readOptionSets(sdk, logical);
    // Merged onto the attribute list, never replacing it: the SDK's own projection supplies
    // `attributeType`/`targets`, and the cast read returns ONLY picklist attributes.
    meta.attributes = (meta.attributes || []).map((a) => {
      const os = byLogical.get(String((a && (a.logicalName || a.LogicalName)) || '').toLowerCase());
      return os ? { ...a, optionSet: os } : a;
    });
    // A cast that failed is recorded WITHOUT discarding what the other one returned.
    if (failed) meta.optionSetReadFailed = failed;
  } catch (err) {
    // Recorded, not swallowed. "This table has no Choice columns" and "the option-set read returned
    // 403" are indistinguishable from the emitted spec — both yield untyped columns — so the reason
    // has to travel back with the metadata or the caller reports a degrade it cannot explain.
    meta.optionSetReadFailed = (err && err.message) ? String(err.message).slice(0, 200) : 'read failed';
  }
  return meta;
}

// Reconstruct an App Spec label from a Dataverse Label, preserving EVERY language. AB#6686428.
//
// Shape (see the Label reference linked in hydrate-spec.js):
//   { "LocalizedLabels": [{ "Label": "Baseline", "LanguageCode": 1033 },
//                         { "Label": "Línea base", "LanguageCode": 3082 }],
//     "UserLocalizedLabel": { "Label": "Baseline", "LanguageCode": 1033 } }
//
// Returns a plain STRING when the table is labelled in one language, and an LCID map only when there
// are genuinely two or more. That asymmetry is deliberate: emitting `{ "1033": "Baseline" }` for
// every single-language table would change the shape of every spec this tool has ever written, for
// no gain, and would make every download diff noisy. Returns undefined when there is nothing usable,
// so a caller can fall back to the SDK's flattened `displayName` rather than write an empty label.
//
// ⚠ KNOWN LIMITATION, accepted rather than overlooked: the LCID of a SINGLE label is not preserved.
// A table labelled only in 3082 downloads as a plain string, and a rebuild applies it at the target
// build's resolved language — correct when rebuilding into the same organization (its base language
// is the same), wrong when rebuilding into one with a different base, where Spanish text is stored
// as an English label. Fixing it means threading the org's base language into this pure function and
// emitting a one-entry map whenever the two differ, which changes the emitted shape for a case that
// is currently indistinguishable from the common one. `download` also deliberately never pins the
// org's LCID into the spec (that would make the spec non-portable), so there is no existing signal
// to key off. Pin `languageCode` in the spec before a cross-organization rebuild.
function labelFromDataverse(value) {
  if (!value || typeof value !== 'object') return undefined;
  const rows = Array.isArray(value.LocalizedLabels) ? value.LocalizedLabels : [];
  const usable = rows.filter((l) => l && typeof l.Label === 'string' && l.Label.trim() && Number.isInteger(Number(l.LanguageCode)) && Number(l.LanguageCode) > 0);
  if (!usable.length) return undefined;
  if (usable.length === 1) return usable[0].Label;
  const out = {};
  // NOT sorted, deliberately: V8 orders integer-like object keys ASCENDING regardless of insertion
  // order, so `JSON.stringify` of this map is already deterministic and two downloads of the same
  // table produce byte-identical output. A sort here would look like it earned that guarantee and
  // could never be shown to matter — verified: inserting 3082 then 1033 yields keys ["1033","3082"].
  for (const l of usable) out[String(Number(l.LanguageCode))] = l.Label;
  return out;
}

// The App Spec `displayName` for one downloaded column, or undefined when Dataverse has no usable
// label. GUARANTEES a string or an LCID map — never a raw Dataverse Label object, which would emit a
// spec that fails its own validation. See the call site for the live-measured shape that motivated it.
function columnDisplayName(a) {
  const localized = labelFromDataverse(a && a.DisplayName);
  if (localized !== undefined) return localized;
  // The SDK's `fetchEntityMetadata` projection already flattens this one to a string.
  if (typeof (a && a.displayName) === 'string' && a.displayName.trim()) return a.displayName;
  return descriptionFromDataverse(a && a.DisplayName);
}

// Image webresourcetypes (png/jpg/gif/ico/svg) — an icon reference must resolve to one of these to be
// re-declared. See WR_TYPE. Guards against re-declaring a non-image WR that a path happens to name.
const IMAGE_WR_TYPES = new Set([5, 6, 7, 10, 11]);

// Fetch the icon web resources referenced by the sitemap, looked up by NAME (the sitemap stores the
// web-resource name, not its id — sdk.getWebResource keys by id and 400s on a name). Returns
// `{ webResources, unresolved }`:
//   webResources — app-spec webResources[] entries (content as base64).
//     `icons`      (BARE names the author declared) → re-declared (any found WR). Deletable on teardown
//                  UNLESS the same name is ALSO a `customRefs` path reference, in which case it inherits
//                  `external:true` (a shared nav icon referenced both ways must keep teardown protection).
//     `customRefs` (names extracted from a PLATFORM path/`$webresource:` ref on an icon OR vectorIcon)
//                  → re-declared ONLY when the WR is (a) OWNED by this app (name starts with
//                  `ownPrefix + '_'`), (b) CUSTOM (unmanaged), and (c) an IMAGE type — so a modern custom
//                  nav icon survives a cross-env rebuild. Such an entry is flagged `external:true` so the
//                  build creates-if-missing / reuses-if-present, but TEARDOWN does NOT delete it: prefix +
//                  unmanaged does NOT prove the WR is exclusively this app's (a publisher's WRs are shared
//                  across all its solutions), and deleting a WR another app shares would break it (fail-safe
//                  — an orphan is recoverable, a deleted shared resource is not; mirrors the `existing:true`
//                  protection on downloaded tables). A FOREIGN-prefix / managed / OOB / non-existent ref is
//                  SKIPPED → left as a bare reference (re-creating a foreign prefix on a fresh env would
//                  hard-fail the build). Path refs are processed BEFORE bare names so this stricter
//                  classification wins on an overlap.
//   unresolved   — customRefs we could NOT safely round-trip (a custom nav icon that will dangle on a
//                  cross-env rebuild), so the caller surfaces a warning (the build-time portability warning
//                  is the backstop). Deduped by name.
//
// `prefixResolved` — whether `ownPrefix` is the app's REAL publisher customizationprefix (recovered from
//   Dataverse) or the unverified `'new'` fallback (recoverAppSolution's publisher read failed / found no
//   solution). This gates own-vs-foreign classification and MUST NOT be conflated with an app whose prefix
//   genuinely IS 'new': when the prefix is UNVERIFIED we cannot trust `startsWith(ownPrefix)`, so a genuine
//   own custom icon (e.g. `crba3_nav.svg` while the fallback prefix is `new`) would fail the own-prefix test
//   and — without this guard — be silently skipped with NO warning, re-introducing the exact broken-icon bug
//   this fix exists to prevent. So when `prefixResolved` is false we do NOT re-declare
//   any path-derived WR (an unknown non-'new' prefix would BuildHalt on a fresh env) but we PROBE every
//   customRef and surface each genuine CUSTOM (unmanaged image) one as `unresolved` — a managed/OOB/absent
//   ref is a system icon present in every env, so it stays silent (no false alarm).
async function iconWebResources(sdk, icons, customRefs, ownPrefix, prefixResolved, navRefs) {
  const out = [];
  const seen = new Set();                 // lowercased names actually re-declared into `out`
  const prefixLc = ownPrefix ? String(ownPrefix).toLowerCase() + '_' : null;
  const customRefSet = new Set((customRefs || []).map((n) => String(n).toLowerCase()));
  // `navRefs` are web resources a URL SUBAREA targets (the Site Map Designer's "custom page backed by
  // an HTML web resource"), as opposed to an icon. They take the SAME safety gates as a path-derived
  // icon — own prefix, unmanaged, has content, `external: true` so teardown never deletes it — but
  // NOT the image-type gate: such a page is `html` (type 1), which `IMAGE_WR_TYPES` excludes by
  // design. Without this distinction the page is never re-declared and a rebuild's nav entry points
  // at a resource the spec cannot recreate.
  const navRefSet = new Set((navRefs || []).map((n) => String(n).toLowerCase()));
  const allowedTypeFor = (key) => (navRefSet.has(key) ? null : IMAGE_WR_TYPES); // null = any type
  const candidateUnresolved = new Map();  // key -> original name; a path ref we could NOT re-declare in PASS 1
  const queryWr = async (name) =>
    (await sdk.queryRecords('webresource', { select: ['name', 'webresourcetype', 'content', 'ismanaged'], filter: `name eq '${String(name).replace(/'/g, "''")}'`, top: 1 }))?.[0];
  const isCustomImage = (wr) => !!(wr && wr.content && wr.ismanaged === false && IMAGE_WR_TYPES.has(wr.webresourcetype));

  // PASS 1 — path-derived custom icons (safety-gated). Done FIRST so a name referenced BOTH by a platform
  // path AND by a bare name is classified by the STRICTER path rules (and flagged `external`) before the
  // lenient bare pass can re-declare it as deletable — otherwise the overlap silently loses teardown
  // protection and a shared nav icon gets deleted.
  for (const name of [...(customRefs || []), ...(navRefs || [])]) {
    const key = String(name).toLowerCase();
    if (seen.has(key)) continue;
    const ownScoped = !!prefixLc && key.startsWith(prefixLc);
    // TRUSTED prefix: only an OWN-prefix ref is a candidate; a foreign/OOB ref is left as a bare reference
    // (never queried). UNTRUSTED prefix: fall through and probe EVERY ref to classify it (see below).
    if (prefixResolved && !ownScoped) continue;
    try {
      const wr = await queryWr(name);
      if (!prefixResolved) {
        // Unverified prefix — classify only, NEVER re-declare (an unknown non-'new' prefix would BuildHalt).
        // Flag a genuine custom icon as a candidate so a transient recovery failure degrades to a warning,
        // not a silent drop; a managed/OOB/absent ref exists in every env, so stay silent (no false alarm).
        if (isCustomImage(wr)) candidateUnresolved.set(key, name);
        continue;
      }
      if (!wr || !wr.content) { candidateUnresolved.set(key, name); continue; }         // own-prefix but absent on source → will dangle
      const allowed = allowedTypeFor(key);
      if (wr.ismanaged === true || (allowed && !allowed.has(wr.webresourcetype))) continue;   // managed / wrong type → leave as a bare reference
      seen.add(key);
      out.push({ name, type: WR_TYPE[wr.webresourcetype] || 'png', contentBase64: wr.content, external: true });
    } catch { candidateUnresolved.set(key, name); /* read failure → candidate (surface unless a bare pass resolves it) */ }
  }

  // PASS 2 — author-declared BARE names. A bare name MUST be re-declared (validation requires a bare icon
  // to be a declared image WR). Flag it `external` iff it is ALSO path-referenced (the shared-resource
  // signal), so the overlap keeps teardown protection. A read failure on a bare-only icon is a silent skip
  // (a hand-authored bare icon name that can't be read isn't a cross-env regression signal).
  for (const name of icons || []) {
    const key = String(name).toLowerCase();
    if (seen.has(key)) continue;
    try {
      const wr = await queryWr(name);
      if (!wr || !wr.content) continue;
      seen.add(key);
      const entry = { name, type: WR_TYPE[wr.webresourcetype] || 'png', contentBase64: wr.content };
      if (customRefSet.has(key)) entry.external = true; // also path-referenced → protect from teardown
      out.push(entry);
    } catch { /* a bare author icon that fails to read is skipped (unchanged) */ }
  }

  // A path ref is unresolved ONLY if it was never re-declared (a bare pass may have re-declared an
  // overlapping name — that resolves it, so it must not also warn). Dedup preserved by the Map key.
  const unresolved = [...candidateUnresolved].filter(([key]) => !seen.has(key)).map(([, name]) => name);
  return { webResources: out, unresolved };
}

// Count sitemap subareas hydrateSpec could not round-trip (present in the deployed sitemap but not in
// the reconstructed spec — e.g. classic DashBoard subareas). A rebuild from the spec drops these.
function droppedSubareaCount(app, spec) {
  const countSub = (areas) => (areas || []).reduce((n, a) => n + (a.groups || []).reduce((m, g) => m + (g.subAreas || []).length, 0), 0);
  return countSub(app && app.siteMap && app.siteMap.areas) - countSub(spec && spec.appShell && spec.appShell.areas);
}

// Recover the REAL unmanaged solution an app module belongs to. An app is a `solutioncomponent` of
// EVERY solution it lives in — always the built-in system solutions (Active/Default/Basic) AND the
// real unmanaged solution it was created in. The naive `top:1` query returns an arbitrary row (often
// 'Default', which is itself ismanaged=false, so an ismanaged filter does not exclude it), so the
// real solution was never recovered and a downloaded spec defaulted its solution to the restricted
// 'Default' — which teardown then 400s on, orphaning the real solution. So enumerate ALL memberships
// and pick the single unmanaged, non-system solution. Best-effort: returns null (caller keeps its own
// default) on no match or any query error — never throws.
//
// Returns `{ uniqueName, publisherPrefix? }`. The publisher prefix is read from the recovered
// solution's OWNING PUBLISHER via the SDK's `getSolution`, because it is the only authoritative
// source: the prefix was previously guessed from the app's uniquename, which breaks whenever the app
// name doesn't encode the solution's publisher — an app named `new_customermanagement` inside
// publisher `contoso`, an app with no prefix at all, or a publisher prefix longer than the guess's
// length bound all collapsed to the literal `'new'` (ADO 6603390). `getSolution` is best-effort on top
// of best-effort: if it fails or the publisher defines no prefix, we return the uniqueName alone and
// the caller falls back to the app-derived guess.
async function recoverAppSolution(sdk, appId) {
  try {
    // objectid == the appmoduleid. `top:500` is a safe over-provision (an app is realistically a
    // component of only a handful of solutions) that keeps us on the same proven query path as every
    // other queryRecords call in the skill (all pass an explicit top) — it just must not be the old
    // `top:1`, which returned an arbitrary single membership (often 'Default').
    const comps = await sdk.queryRecords('solutioncomponent', { select: ['_solutionid_value'], filter: `objectid eq ${appId}`, top: 500 });
    const solIds = [...new Set((comps || []).map((c) => c && c._solutionid_value).filter(Boolean))];
    if (!solIds.length) return null;
    // One OR-batched lookup for all candidate solutions (solutionid is a Guid, so it is unquoted in
    // the OData filter — mirrors the existing `solutionid eq ${id}` usage elsewhere in this file).
    const filter = solIds.map((id) => `solutionid eq ${id}`).join(' or ');
    const sols = await sdk.queryRecords('solution', { select: ['solutionid', 'uniquename', 'ismanaged', 'description'], filter, top: 500 });
    const real = (sols || []).find((s) => s && s.ismanaged === false && !isRestrictedSolution(s.uniquename));
    if (!real) return null;
    const out = withDescription({ uniqueName: real.uniquename }, real.description);
    // Authoritative publisher prefix for anything authored into THIS solution. Guarded on the method
    // existing so an older vendored bundle (pre-getSolution) degrades to the caller's fallback instead
    // of throwing away the solution we just recovered.
    if (typeof sdk.getSolution === 'function') {
      try {
        const info = await sdk.getSolution(real.uniquename);
        // An empty-string prefix is legitimate for some first-party publishers, but it is not usable as
        // a customization prefix, so treat it as "not recovered" and let the caller fall back.
        if (info && info.publisherPrefix) out.publisherPrefix = String(info.publisherPrefix).toLowerCase();
      } catch { /* best-effort — keep the recovered uniqueName */ }
    }
    return out;
  } catch {
    return null; // best-effort — a recovery failure must not break the download
  }
}

// Injectable download helper: all live-Dataverse work happens here so tests can inject mock deps.
// `sdk`        — the MakerSDK (fetchArtifact, queryRecords, fetchEntityMetadata)
// `genpageCli` — the genpage CLI wrapper (enumerateEnv, download)
// `outDir`     — output directory root
// `appId`      — the app's GUID (used for download + solution lookup)
// `appUnique`  — the app's unique name (for fetchSitemap + manifest lookup); may be undefined for
//                apps not found by unique name, in which case the sitemap read fails gracefully.
// Returns { ok:true, spec, pages, entities, webResources, droppedSubareas, droppedSubareaDetails,
// dashboardReconstructionError } or { ok:false, error }.
// Logical failures (no sitemap, enumeration down, missing download) return { ok:false } without
// throwing. Unexpected I/O errors propagate as thrown exceptions (caught by main().catch).
async function runDownload({ sdk, genpageCli, outDir, appId, appUnique, allowLossy = false }) {
  // `fetchArtifact('app')` FAILS CLOSED when the app's sitemap cannot be resolved, read, or proven to
  // still belong to this app (SDK code `APP_SITEMAP_UNRESOLVED`) — rather than returning an app whose
  // navigation is untrustworthy. That is a LOGICAL failure of exactly the class this function's
  // contract says it returns rather than throws (the sitemap IS the download's membership oracle), so
  // translate it instead of letting a raw SDK error escape. A newly created app is the common cause:
  // an unpublished appmodule is not readable, so the caller's fix is to publish it and retry.
  let app;
  try {
    app = await sdk.fetchArtifact('app', appId);
  } catch (e) {
    const code = e && e.code;
    if (code === 'APP_SITEMAP_UNRESOLVED' || code === 'APP_UPDATE_NO_ETAG') {
      return { ok: false, error: `cannot read app ${appId}: ${(e && e.message) || code}` };
    }
    throw e;
  }
  const { entities: entityLogicals, icons, customRefs, navRefs } = collectSitemap(app);

  // MEMBERSHIP: the authoritative set of pages owned by this app, from its SITEMAP XML (fail-closed,
  // discriminated). The app-scoped `pac genpage list --app-id` is sitemap-scoped anyway but returns
  // SITEMAP TITLES (not page names), misses headless nav-target pages, and cannot be trusted as the
  // "real names" source. The raw sitemap XML is the single authoritative membership record.
  const smResult = appUnique
    ? await fetchSitemap(sdk, appUnique)
    : { ok: false, reason: 'app-unique-unresolved' };
  if (!smResult.ok) {
    return { ok: false, error: `could not read the app sitemap during download (${smResult.reason}) — refusing to write a spec without the authoritative page set` };
  }
  // [{ pageId, title? }] — deduped by id; membership-only (title is the XML-decoded subarea label,
  // NOT the page's real name — the real name comes from the env-wide list below).
  const smPages = sitemapGenPages(smResult.xml);
  let pages = [];
  let manifest = null;

  if (smPages.length) {
    // Durable manifest (stable key→id bindings + v2 semantics). Best-effort: a missing or corrupt
    // manifest falls back to fresh key minting (no v2 semantics for a first-ever download).
    if (appUnique) {
      const rows = await sdk.queryRecords('webresource', { select: ['content'], filter: `name eq '${manifestResourceName(appUnique).replace(/'/g, "''")}'`, top: 1 });
      if (rows && rows[0] && rows[0].content) manifest = parseManifestBase64(rows[0].content);
    }

    // Real names from the ENV-WIDE list (addenda new-1: env names ≠ sitemap titles). The env-wide
    // `pac genpage list` returns each page's actual configured name; the sitemap title is what the
    // Maker chose for the subarea label, which can differ. Using the sitemap title as the page name
    // was the root of the name-vs-title mismatch (live-confirmed; see Plan-5 §Background).
    const envResult = await genpageCli.enumerateEnv();
    if (!envResult.ok) {
      return { ok: false, error: `page enumeration failed during download: ${envResult.error}` };
    }
    const envNameById = new Map(
      (envResult.pages || []).filter((p) => p.pageId && p.name)
        .map((p) => [String(p.pageId).toLowerCase(), p.name])
    );

    // Download EXACTLY the sitemap's pages (by id — headless-free, no env-wide over-pull). The
    // sitemap is the MEMBERSHIP authority: we pull precisely this app's pages, no more, no less.
    const pagesRoot = path.join(outDir, 'pages');
    fs.rmSync(pagesRoot, { recursive: true, force: true });
    fs.mkdirSync(pagesRoot, { recursive: true });
    const sitemapIds = smPages.map((p) => p.pageId);
    try {
      await genpageCli.download({ appId, outputDir: pagesRoot, pageIds: sitemapIds });
    } catch (e) {
      return { ok: false, error: `pac genpage download failed: ${e.message}` };
    }

    // Name resolver: env-wide name (real, stable) primary; sitemap title (XML-entity-decoded) as
    // fallback when the env-wide list doesn't cover an id (shouldn't happen in practice — env-wide
    // lists all pages — but guards against an eventual stale or truncated listing).
    const nameById = new Map(smPages.map((p) => {
      const id = String(p.pageId).toLowerCase();
      return [id, envNameById.get(id) || p.title || p.pageId];
    }));
    pages = parseDownloadedPages(pagesRoot, outDir, nameById);

    // Bidirectional exact equality: sitemap ids ↔ downloaded ids (I3). A gap either way means pac
    // fetched a different set than the sitemap declares — rebuilding from this spec would silently
    // drop or add pages, so download FAILS instead.
    const missing = missingDownloads(smPages, pages);
    if (missing.length) {
      return { ok: false, error: `sitemap page(s) not downloaded: ${missing.map((p) => p.title || p.pageId).join(', ')} — refusing to write a spec that would drop them` };
    }
    const extra = missingDownloads(pages, smPages);
    if (extra.length) {
      return { ok: false, error: `downloaded page(s) not in the sitemap: ${extra.map((p) => p.pageId).join(', ')} — inconsistent page set` };
    }

    // Reconcile by MEMBERSHIP. For download, existence AND membership are both the sitemap ids
    // (the pages we just pulled — if they were downloaded they exist; if not we already aborted
    // above). This differs from the build path, which uses the env-wide EXISTENCE set (because a
    // build must find crash-orphaned pages that are not yet in the sitemap).
    const { keyToId, conflicts } = reconcilePageIds(
      (manifest && manifest.pages) || [],
      manifest,
      sitemapIds, // existenceIds: confirmed present (we just downloaded them)
      sitemapIds  // sitemapIds: membership = same set as existence for the download path
    );
    if (conflicts.length) {
      return { ok: false, error: `page identity conflict during download: ${conflicts.map((c) => c.pageId || c.key).join(', ')} — cannot safely reconstruct` };
    }

    // Assign stable keys + carry v2 semantics (navigatesTo/purpose/pageInput) from the manifest.
    // Pages bound to manifest keys reuse their key and semantics; Maker-added pages (not in the
    // manifest) get a fresh slug key minted from their env-wide name.
    const idToKey = assignPageKeys(pages, manifest, keyToId);

    // Reverse-resolve nav pageId literals → symbolic PAGEREF_<key> tokens (structural, oracle-safe).
    for (const p of pages) {
      const abs = path.join(outDir, p.codeFile);
      const src = fs.readFileSync(abs, 'utf8');           // FAIL on a read error (no swallow)
      const rev = reverseResolveNavIds(src, idToKey);     // structural — nav pageId literals only
      if (rev !== src) fs.writeFileSync(abs, rev, 'utf8'); // FAIL on a write error (no swallow)
    }

    // Warn about manifest pages no longer in the sitemap (Maker-deleted in the live app). The
    // rebuilt spec drops these pages; the warning mirrors the droppedSubareaCount WARNING below.
    const liveSet = new Set(sitemapIds.map((id) => String(id).toLowerCase()));
    const goneManifestPages = ((manifest && manifest.pages) || []).filter(
      (mp) => mp.pageId && !liveSet.has(String(mp.pageId).toLowerCase())
    );
    if (goneManifestPages.length) {
      process.stderr.write(`WARNING: ${goneManifestPages.length} manifest page(s) are no longer in the app sitemap (deleted in Maker): ${goneManifestPages.map((p) => p.name || p.pageId).join(', ')} — the rebuilt spec drops them.\n`);
    }
  }

  // Entities: the sitemap's navigable tables UNIONED with the app's real entity components. The
  // sitemap alone misses tables reachable only via lookup/sub-grid/related view (ADO 6603388); the
  // component read is best-effort, so a failure degrades to exactly today's sitemap-derived set.
  const componentLogicals = await appComponentEntities(sdk, appId);
  const sitemapSet = new Set(entityLogicals);
  const allLogicals = [...new Set([...entityLogicals, ...componentLogicals])];
  const entities = [];
  const noPrimaryName = [];   // sitemap tables — a hard failure (the user asked for these)
  const droppedComponents = []; // component-only tables — dropped with a warning (best-effort input)
  const metadataErrors = new Map(); // logical -> error message (the read itself failed)
  // Tables whose LABEL read failed. Distinct from `metadataErrors`: the table itself was recovered
  // and the spec is usable, but only the SDK's flattened single-language `displayName` survived, so
  // a multi-language table silently downloads as English-only. Reported rather than swallowed.
  const labelReadFailures = new Map(); // logical -> reason
  // Tables whose OPTION-SET read failed (#564). Kept apart from `labelReadFailures` for the same
  // reason that one is kept apart from `metadataErrors`: the table is recovered and the spec is
  // usable, but every Choice/MultiChoice column on it comes back untyped, so a cross-environment
  // rebuild would create them as Text. Naming the reason is what makes that actionable.
  const optionSetReadFailures = new Map(); // logical -> reason
  // Shared option sets bound by a downloaded column, keyed by lower-cased name so a set used by
  // several tables is declared once.
  const globalChoiceDecls = new Map();
  for (const logical of allLogicals) {
    let e;
    // A metadata READ failure is not the same as metadata that reports no primary name, and it must
    // not be swallowed: a 429/503 on a sitemap table used to drop it silently, leaving its subarea
    // behind so validation later complained about a "sitemap subArea references unknown entity" —
    // the confusing downstream error the explicit branch below exists to avoid. Bucket it by origin
    // exactly like the no-primary-name case, so the user is told the table AND the reason.
    try {
      const meta = await readEntityWithDescriptions(sdk, logical);
      if (meta && meta.labelReadFailed) labelReadFailures.set(logical, meta.labelReadFailed);
      if (meta && meta.optionSetReadFailed) optionSetReadFailures.set(logical, meta.optionSetReadFailed);
      collectGlobalChoices(meta, globalChoiceDecls);
      e = entityFromMetadata(meta, logical);
    } catch (err) {
      metadataErrors.set(logical, (err && err.message) || String(err));
      (sitemapSet.has(logical) ? noPrimaryName : droppedComponents).push(logical);
      continue;
    }
    // `primaryAttribute` is REQUIRED by App Spec validation, so an entity without one cannot be
    // emitted — the spec would fail to validate and the user could not rebuild at all. Guessing the
    // name is what caused ADO 6603392, so the only honest options are fail or drop.
    //
    // Which one depends on WHERE the table came from. A sitemap table is one the user explicitly
    // navigated to: failing loudly names it and is actionable. A component-only table is a hidden
    // dependency this download newly discovered on a best-effort basis — aborting the whole download
    // over one (which previously downloaded fine, because it was never included) would be a
    // regression with no override flag, so drop it and say so. NOTE the SDK returns '' (not
    // undefined) for a missing PrimaryNameAttribute, which `entityFromMetadata` maps to null.
    if (!e.primaryAttribute) {
      (sitemapSet.has(logical) ? noPrimaryName : droppedComponents).push(logical);
      continue;
    }
    entities.push(e);
  }
  const withReason = (list) => list.map((l) => (metadataErrors.has(l) ? `${l} (metadata read failed: ${metadataErrors.get(l)})` : l)).join(', ');
  if (noPrimaryName.length) {
    // Overridable, like the dropped-subarea path: without an escape hatch a download that used to
    // succeed produces nothing at all, which is an availability regression on a READ-ONLY command.
    if (!allowLossy) {
      return { ok: false, error: `could not read the primary-name column for table(s): ${withReason(noPrimaryName)} — refusing to write a spec with a guessed or missing primary attribute (re-run with --allow-lossy-download to drop them instead)` };
    }
    process.stderr.write(`WARNING: ${noPrimaryName.length} sitemap table(s) were DROPPED because their primary-name column could not be read (${withReason(noPrimaryName)}) — --allow-lossy-download was set. Their navigation entries are dropped too; the spec will not rebuild them.\n`);
    for (const l of noPrimaryName) sitemapSet.delete(l);
  }
  if (droppedComponents.length) {
    process.stderr.write(`WARNING: ${droppedComponents.length} app component table(s) were omitted from the spec because Dataverse reported no primary-name column (${withReason(droppedComponents)}) — they are NOT in the app's navigation, and the deployed app still references them; declare them by hand if a rebuild needs them.\n`);
  }
  // AB#6686428: the label read is the ONLY source of multi-language labels. When it fails the table
  // is still recovered, so the download succeeds and the spec looks complete — but it carries the
  // SDK's flattened single-language `displayName` and every other language is gone. Silently
  // degrading there is the same shape as the bug this feature fixes, so say so. Not a gate: an
  // English-only spec is still a usable spec, and failing a read-only command over it would be worse.
  if (labelReadFailures.size) {
    const detail = [...labelReadFailures.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([l, r]) => `${l} (${r})`).join(', ');
    process.stderr.write(`WARNING: a label read failed for ${labelReadFailures.size} table(s) (${detail}). The table AND COLUMN labels for those tables fall back to ONE language, so anything labelled in several languages downloads as single-language and a rebuild would recreate it that way. That read also carries the flags that identify a lookup's synthetic '<lookup>name' column, so those tables may additionally have captured one as a real Text column — delete any you see before a cross-environment rebuild. Re-run the download to recover both.\n`);
  }
  // #564: the option-set read is the ONLY source of a Choice/MultiChoice column's type. When it
  // fails the table is still recovered and the spec still looks complete, but every choice column on
  // it comes back untyped — so a rebuild into a FRESH environment creates them as Text. Reported
  // with the reason, and separately from the untyped list below, because "we could not look" is a
  // different fact from "this column has no substantiated type", and only the first is re-runnable.
  if (optionSetReadFailures.size) {
    const detail = [...optionSetReadFailures.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([l, r]) => `${l} (${r})`).join(', ');
    process.stderr.write(`WARNING: the Choice/MultiChoice option-set read failed for ${optionSetReadFailures.size} table(s) (${detail}). Any choice column on those tables is captured WITHOUT its type or options, so rebuilding into a FRESH environment would create it as single-line Text. Re-run the download to recover them before a cross-environment rebuild.\n`);
  }
  // A column whose App Spec type could not be substantiated: a Choice/MultiChoice whose option set
  // the read did not return (see the failure warning above), or an attribute type the spec cannot
  // declare. Rebuilding into an org that ALREADY has the table reuses the column and this is inert;
  // rebuilding into a FRESH org creates it as Text, because the data-model phase falls back to
  // `c.type || 'Text'`. That silent downgrade is why this is announced by name.
  const untyped = untypedColumnNames(entities);
  if (untyped.length) {
    process.stderr.write(`WARNING: ${untyped.length} column(s) were captured WITHOUT a type (${untyped.join(', ')}) — most likely Choice/MultiChoice columns whose option set could not be read. Rebuilding this spec into an environment that already has the table is unaffected, but rebuilding into a FRESH environment would create them as single-line Text. Add the type and options[] (or a globalChoice reference) by hand before a cross-environment rebuild.\n`);
  }

  // App identity comes from the app's REAL, immutable uniquename (`appUnique`, captured from Dataverse as
  // `appmodule.uniquename`; guaranteed present here because runDownload bails at the sitemap gate above).
  // It is exactly what the build (appUniqueName → findArtifact) + teardown must match — NOT the mutable
  // display name (a rename would miss the existing app). Its leading segment is ALSO parsed as a
  // publisher-prefix FALLBACK, with a full `<prefix>_<name>` shape check (a bare token is not a valid app
  // uniquename — its leading segment must be followed by `_<name>`).
  //
  // This app-derived value is only a fallback: the app's name does not reliably encode the publisher of
  // the solution that owns it (ADO 6603390). The authoritative prefix is the recovered solution's owning
  // publisher, read below.
  const appPrefixMatch = /^([a-z][a-z0-9]{1,7})_.+$/.exec(String(appUnique || '').toLowerCase());
  const appDerivedPrefix = appPrefixMatch ? appPrefixMatch[1] : null;

  // Solution container (best-effort): the real unmanaged solution the appmodule belongs to, for a clean
  // teardown, plus its owning publisher's customization prefix. Falls back to the restricted 'Default'
  // when recovery finds nothing — that fallback cannot be torn down, but teardown skips it safely (see
  // system-solutions.js) rather than erroring.
  const recovered = await recoverAppSolution(sdk, appId);

  // Prefix precedence: the SOLUTION's publisher (authoritative) → the app-uniquename guess (fallback).
  // `prefixResolved` means "this prefix is trustworthy", which gates the icon own-vs-foreign
  // classification below; it must be true for BOTH trusted sources, or a genuine own-publisher custom
  // nav icon stops round-tripping. It stays false only for the unverified 'new' default.
  const solutionPrefix = (recovered && recovered.publisherPrefix) || null;
  const trustedPrefix = solutionPrefix || appDerivedPrefix;
  const solution = { uniqueName: 'Default', publisherPrefix: trustedPrefix || 'new', prefixResolved: !!trustedPrefix };
  if (recovered && recovered.uniqueName) solution.uniqueName = recovered.uniqueName;
  // `recoverAppSolution` already unwraps the solution's description; carry it across. This object is
  // built fresh (rather than spread from `recovered`) so an unrecovered solution still gets its
  // required defaults, which is why each field has to be copied deliberately — a field added to
  // `recoverAppSolution` and not copied here is silently dropped, as this one was.
  if (recovered && recovered.description) solution.description = recovered.description;

  // Icon web resources — looked up by NAME (the sitemap stores the web-resource name, not its id).
  // Bare-name icons are re-declared as-is; a CUSTOM (unmanaged) web resource referenced by a PLATFORM
  // path (e.g. a modern nav vectorIcon `/WebResources/<pub>/icons/x.svg`) is ALSO re-declared so the icon
  // survives a rebuild into a fresh env that lacks it — but ONLY when it belongs to THIS app's own
  // publisher (`solution.publisherPrefix`). A FOREIGN-prefix / OOB reference is left as a bare reference:
  // re-declaring it would make the build try to createWebResource under an unregistered prefix on a fresh
  // env → a hard BuildHalt, turning a cosmetic broken icon into a failed build.
  const { webResources, unresolved: unresolvedIcons } = await iconWebResources(sdk, icons, customRefs, solution.publisherPrefix, solution.prefixResolved, navRefs);
  if (unresolvedIcons && unresolvedIcons.length) {
    // A custom nav icon we couldn't safely round-trip: either an own-prefix WR that's absent on the source
    // env / failed to read, OR (when the publisher prefix couldn't be verified) any custom image icon we
    // can't classify as own-vs-foreign. Its sitemap reference round-trips but the WR isn't re-declared, so
    // the icon will dangle on a rebuild into a fresh env. Surface it now (the build-time portability
    // warning is the backstop). Without this, an unverified-prefix download would silently drop the icon.
    process.stderr.write(`WARNING: ${unresolvedIcons.length} custom nav-icon web resource(s) could not be captured (${unresolvedIcons.join(', ')}) — their sitemap reference is kept, but declare the web resource(s) in webResources[] if you rebuild into a fresh environment, or the icon will be missing there.\n`);
  }

  // Dashboards (declared as DashBoard sitemap subareas) — reconstructed with id-passthrough tiles.
  let dashboards = [];
  let dashboardReconstructionError = null;
  // Per-dashboard failures are collected rather than swallowed. They are the usual cause of a
  // "subarea could not be round-tripped" error further down, and without them that error names the
  // subarea but not the reason, which makes it undiagnosable without a debugger.
  const dashboardWarnings = [];
  try {
    dashboards = await readDashboards(sdk, app, (m) => {
      dashboardWarnings.push(m);
      process.stderr.write(`WARNING: ${m}\n`);
    });
  } catch (e) {
    dashboardReconstructionError = e.message;
    process.stderr.write(`(dashboards reconstruction skipped: ${e.message})\n`);
  }

  // Relationships (#567). Reconstructed from live metadata; anything that cannot be expressed in
  // relationships[] is collected in `relationshipsSkipped` and reported with the other
  // not-round-tripped classes, so an omission is stated rather than left to be discovered.
  let relationships = [];
  let relationshipsSkipped = [];
  try {
    const rel = await readRelationships(sdk, allLogicals, solution.publisherPrefix, (m) => {
      process.stderr.write(`WARNING: ${m}\n`);
    });
    relationships = rel.relationships;
    relationshipsSkipped = rel.skipped;
  } catch (e) {
    // A total failure must not sink the download, but it must not masquerade as "this app has no
    // relationships" either — that is precisely the silent absence #567 was filed about.
    relationshipsSkipped = [{ name: '(all)', entity: 'unknown', reason: `relationship metadata could not be read (${e && e.message})` }];
    process.stderr.write(`WARNING: relationships could not be reconstructed: ${e && e.message}\n`);
  }

  // Captured by the descriptionInventory accessor below so the role-restriction warning can read it
  // without making a second query.
  let capturedInventory;
  const read = {
    // Ensure the app's REAL uniquename reaches hydrateSpec (→ spec.app.uniqueName) even if the artifact
    // read didn't surface it: `appUnique` is the authoritative value (from the appmodule query) and is
    // guaranteed present here (the sitemap gate above bails when it's falsy). This is what lets a rebuild
    // resolve the EXISTING app by identity after a display-name rename instead of creating a duplicate.
    app: async () => ({ ...app, uniquename: (app && app.uniquename) || appUnique, ...(await readAppShellSettings(sdk, appId)) }),
    pages: async () => pages,
    entities: async () => entities,
    relationships: async () => relationships,
    webResources: async () => webResources,
    dashboards: async () => dashboards,
    solution: async () => solution,
    design: async () => (manifest ? manifest.design : undefined),
    // #564: the shared option sets the downloaded columns bind to. Reduced to the sets an EMITTED
    // column actually references (and canonicalized to one casing) — `globalChoiceDecls` is gathered
    // from RAW metadata, which includes attributes later filtered out and tables later dropped, and
    // every declaration here becomes a `createGlobalOptionSet` write in the target environment.
    // Declared so a rebuild into a FRESH environment can create them — `createGlobalOptionSet` probes
    // by Name and reuses, so declaring one the target org already has is a no-op, not a duplicate.
    globalChoices: async () => finalizeGlobalChoices(entities, globalChoiceDecls),
    // Captured on the way past so the role-restriction warning below can read it. The accessor stays
    // a function (hydrateSpec's contract) and is still called exactly once, so this adds no query.
    descriptionInventory: async () => {
      capturedInventory = await readDescriptionInventory(sdk, appId, solution.uniqueName);
      return capturedInventory;
    },
  };
  const spec = await hydrateSpec(read);

  // A form restricted to particular security roles. `forms[]` is not reconstructed by this download,
  // so nothing carries the restriction forward: rebuilding into a FRESH environment regenerates the
  // form with no `<DisplayConditions>`, and a form with none is offered to EVERY role. Every other
  // download gap loses a customization; this one silently WIDENS access, so it is named explicitly.
  const restricted = (capturedInventory && capturedInventory.roleRestrictedForms) || [];
  if (restricted.length) {
    process.stderr.write(`WARNING: ${restricted.length} form(s) are restricted to specific security roles (${restricted.map((f) => `${f.entity}.${f.name}`).join(', ')}). This download does not reconstruct forms[], so that restriction is NOT carried into the spec — rebuilding into a fresh environment would recreate them visible to EVERY role. Re-declare it with forms[].securityRoles before a cross-environment rebuild.\n`);
  }
  // AB#6686423: name the artifact classes this download leaves out of the rebuildable spec. The
  // reported failure was not that they are omitted — that is a documented limitation — but that
  // NOTHING said so, so a second session reading the spec could not tell "this app has no views"
  // from "this download does not carry views".
  const notRoundTripped = notRoundTrippedSummary(roundTrippedAware(capturedInventory, globalChoiceDecls));
  if (notRoundTripped) process.stderr.write(notRoundTrippedWarning(notRoundTripped));
  if (relationshipsSkipped.length) process.stderr.write(relationshipsSkippedWarning(relationshipsSkipped));
  const droppedSubareas = typeof spec.droppedSubareas === 'number' ? spec.droppedSubareas : droppedSubareaCount(app, spec);
  const droppedSubareaDetails = Array.isArray(spec.droppedSubareaDetails) ? spec.droppedSubareaDetails : [];
  return { ok: true, spec, pages, entities, webResources, droppedSubareas, droppedSubareaDetails, dashboardReconstructionError, dashboardWarnings, notRoundTripped, relationships, relationshipsSkipped };
}

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const USAGE = 'Usage: node download-model-app.js --env <url> --app <appId|uniqueName|displayName> --out <dir> [--allow-lossy-download]';
  // `--allow-lossy-download` is a real boolean switch, so it stays out of needValue; everything else
  // feeds a URL, an app id, or a path and must not receive `true`.
  const flagError = validateFlags(argv, {
    known: ['env', 'app', 'out', 'output', 'allow-lossy-download'],
    needValue: ['env', 'app', 'out', 'output'],
  });
  if (flagError) {
    process.stderr.write(`✗ ${flagError}\n${USAGE}\n`);
    process.exit(1);
  }
  const env = flags.env;
  const appArg = flags.app || positional[0];
  const outArg = flags.out || flags.output;
  const allowLossyDownload = flags['allow-lossy-download'] === true;
  if (!env || !appArg) {
    process.stderr.write(USAGE + '\n');
    process.exit(1);
  }
  const outDir = path.resolve(outArg || '.');
  fs.mkdirSync(outDir, { recursive: true });
  // AB#6686427 — prove the ambient Azure CLI identity can actually reach this org BEFORE any read.
  // Every read below is best-effort by design (a tenant without a setting definition, or a caller
  // without access to one artifact class, must still produce a usable spec), so an auth failure does
  // not surface as an error here — it degrades to an EMPTY spec: no forms, no views, no columns, and
  // guessed primary attributes, reported as a success. That is AB#6686423's symptom, and this is the
  // gate that stops it being mistaken for a round-trip gap.
  const auth = await preflightAuth(env);
  if (!auth.ok && !auth.inconclusive) { emitResult(false, { ok: false, error: auth.error }); return; }
  // An INCONCLUSIVE probe must not block: it goes through a client with a weaker retry policy than
  // the one the download itself uses, so a transient 5xx here would otherwise fail a run that would
  // have succeeded. Surface it and continue.
  if (auth.inconclusive) process.stderr.write(`⚠ ${auth.error}\n`);
  const sdk = await makeProvision(env, path.join(outDir, '.maker-workspace'));
  const resolved = await resolveAppId(sdk, appArg);
  if (resolved.error) { emitResult(false, { ok: false, error: resolved.error }); return; }
  const appId = resolved.appId;
  // Narrate a display-name match so the operator learns the app's stable identity: the unique name
  // is what every later build/teardown must be given, and it survives a rename of the display name.
  if (resolved.matchedBy === 'displayName') {
    process.stderr.write(`(resolved display name '${appArg}' to app unique name '${resolved.uniqueName}' — prefer the unique name, it is immutable)\n`);
  }

  // Resolve the app's unique name early — needed for fetchSitemap (MEMBERSHIP) + manifest lookup.
  const appRows = await sdk.queryRecords('appmodule', { select: ['uniquename'], filter: `appmoduleid eq ${appId}`, top: 1 });
  const appUnique = appRows && appRows[0] && appRows[0].uniquename;
  const genpageCli = makeGenpageCli(env);

  const result = await runDownload({ sdk, genpageCli, outDir, appId, appUnique, allowLossy: allowLossyDownload });
  if (!result.ok) { emitResult(false, result); return; }

  const { spec, pages, entities, webResources, droppedSubareas, droppedSubareaDetails, dashboardReconstructionError, dashboardWarnings, notRoundTripped } = result;
  if (droppedSubareas > 0 || dashboardReconstructionError) {
    const droppedList = (droppedSubareaDetails || [])
      .map((d) => `${d.type}${d.id ? `:${d.id}` : ''}${d.title ? ` (${d.title})` : ''}`)
      .join(', ');
    const dashboardMessage = dashboardReconstructionError ? ` Dashboard reconstruction failed: ${dashboardReconstructionError}.` : '';
    // Per-dashboard reasons, when there are any. Naming the subarea without saying WHY it dropped
    // sends the reader looking at their sitemap when the cause is an unreadable artifact.
    const causeMessage = (dashboardWarnings && dashboardWarnings.length)
      ? ` Cause: ${dashboardWarnings.join('; ')}.`
      : '';
    const message = `${droppedSubareas} sitemap subarea(s) could not be round-tripped${droppedList ? `: ${droppedList}` : ''}.${dashboardMessage}${causeMessage} A rebuild from this spec will DROP them from the app nav.`;
    if (!allowLossyDownload) {
      process.stderr.write(`ERROR: ${message}\nPass --allow-lossy-download to write the partial spec anyway.\n`);
      emitResult(false, { ok: false, error: message, droppedSubareas, droppedSubareaDetails, dashboardReconstructionError, ...(dashboardWarnings && dashboardWarnings.length ? { dashboardWarnings } : {}) });
      return;
    }
    process.stderr.write(`WARNING: ${message}\n`);
  }
  // `reconstructed: true` — this spec was rebuilt from a DEPLOYED app, not authored. Authoring-only
  // rules become warnings, because refusing to write a description of an app that already exists
  // leaves the author with no artifact at all (see the pageInput producer rule).
  const validation = validateAppSpec(spec, { profile: 'plan', reconstructed: true });
  if (!validation.ok) {
    emitResult(false, { ok: false, error: 'downloaded App Spec failed validation', errors: validation.errors });
    return;
  }
  for (const w of validation.warnings || []) process.stderr.write(`WARNING: ${w}\n`);
  // A defaulted `directEntry` must not be silent. hydrateSpec injects a conservative `emptyState` for
  // pages that predate the field (otherwise this download would have hard-failed above and written no
  // spec at all), but the author has to know a behaviour was chosen for them so they can change it.
  const defaulted = spec.directEntryDefaulted || [];
  if (defaulted.length) {
    process.stderr.write(
      `WARNING: ${defaulted.length} page(s) declare pageInput but predate directEntry — defaulted to `
      + `{ "behavior": "emptyState" }: ${defaulted.join(', ')}.\n`
      + '  Review each: change to "selector" if opening the page from the navigation should show a record picker.\n'
    );
  }
  const specPath = path.join(outDir, 'app-spec.json');
  preserveAuthoredLanguageCode(spec, specPath);
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  emitResult(true, { ok: true, spec: specPath, pages: pages.length, entities: entities.length, webResources: webResources.length, droppedSubareas, ...(notRoundTripped ? { notRoundTripped } : {}), ...(defaulted.length ? { directEntryDefaulted: defaulted } : {}) });
}

// Carry an AUTHOR-PINNED `languageCode` across a download, and only from the spec already on disk.
//
// Download deliberately does not read `languageCode` from Dataverse. An LCID copied out of the source
// org would be re-applied verbatim when the spec is rebuilt somewhere else, which is exactly how a
// spec starts failing in an org that has not provisioned that language (#447) — leaving it absent lets
// every target org resolve its own base language, which is the right default.
//
// But silently dropping a value the author WROTE is its own bug, and a quiet one: the next build
// resolves the org default, so newly created columns get one language while the ones from the pinned
// build keep another. A mixed-language app, no error anywhere. So the value is restored from the
// previous spec at this path — the author's own file — and never synthesized from the environment.
//
// Best-effort by design: a missing, unreadable or malformed previous spec just means there is nothing
// to preserve. Failing the download over it would be worse than the wart this fixes. Only a value that
// would itself pass validation is restored — carrying a broken one forward would fail the next build
// for a reason the operator did not cause on this run.
// Exported for tests.
function preserveAuthoredLanguageCode(spec, specPath, deps = {}) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const existsSync = deps.existsSync || fs.existsSync;
  if (!spec || spec.languageCode !== undefined) return spec;
  try {
    if (!existsSync(specPath)) return spec;
    const prior = JSON.parse(readFileSync(specPath, 'utf8'));
    // Assign the NORMALIZED value, not the raw one. `"1031"` and `" 1031 "` both validate, but a
    // downloaded spec is a generated artifact and should be canonical — writing the author's
    // whitespace or string form back out makes the file's diff noisy and its type inconsistent with
    // every other numeric field the download emits.
    const lcid = prior ? normalizeLanguageCode(prior.languageCode) : null;
    if (lcid !== null) spec.languageCode = lcid;
  } catch { /* no previous spec, or not parseable — nothing to preserve */ }
  return spec;
}

if (require.main === module) {
  main().catch((err) => emitResult(false, err));
}

module.exports = { untypedColumnNames, collectGlobalChoices, finalizeGlobalChoices, roundTrippedAware, isRoleRestrictedFormXml, notRoundTrippedSummary, notRoundTrippedWarning, relationshipsSkippedWarning, labelFromDataverse, columnDisplayName, resolveAppId, collectSitemap, appComponentEntities, parseDownloadedPages, assignPageKeys, missingDownloads, entityFromMetadata, readEntityWithDescriptions, readDescriptionInventory, readAppShellSettings, iconWebResources, readDashboards, readRelationships, droppedSubareaCount, recoverAppSolution, runDownload, preserveAuthoredLanguageCode };
