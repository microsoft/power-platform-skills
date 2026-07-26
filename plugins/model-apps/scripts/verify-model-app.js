#!/usr/bin/env node
'use strict';
// verify-model-app: reconcile an App Spec against the DEPLOYED app and report any missing artifacts
// (entities/columns/views/charts/forms/sitemap subareas + icons). Read-only. Exit non-zero if
// anything declared is missing — catches silent partial builds.
//
// Usage: node verify-model-app.js --env <orgUrl> --spec @<app-folder>/app-spec.json [--workspace <dir>]

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, readJsonArg, emitResult } = require('./lib/dataverse-auth.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { verifySpec } = require('./lib/verify-spec.js');
const { appUniqueName } = require('./lib/sdk-build.js');
const { validateAppSpec, migrateAppSpec } = require('./lib/app-spec.js');
const { odataLit } = require('./lib/odata.js');
const { makeGenpageCli } = require('./lib/genpage-cli.js');

function makeProvision(env, workspaceDir) {
  const { createMakerSdk } = require('./vendor/cds-maker-sdk.cjs');
  const httpClient = createAzHttpClient(env);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const sdk = createMakerSdk({ workspacePath: workspaceDir, instanceUrl: env, httpClient });
  sdk.initWorkspace();
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

  // Per-id page code cache. Downloads by specific id on demand rather than pulling all pages at once
  // (the old all-pages downloadP). Each id gets its own output dir to avoid directory collision.
  const codeById = new Map();

  const base = {
    findTable: async (logical) => { const l = String(logical).toLowerCase(); const t = await sdk.findTables(l); return (t || []).find((x) => String(x.logicalName).toLowerCase() === l) || null; },
    findColumns: async (logical) => sdk.findColumns(logical),
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
    // sitemapXml (string, fail-closed '') for entity/icon hasElement checks — from the discriminated sitemap
    // read. Returning '' on failure suppresses entity/icon checks without aborting the whole verify.
    sitemapXml: async () => { const r = await memoSitemap(); return r.ok ? r.xml : ''; },
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
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const env = flags.env;
  const specArg = flags.spec || positional[0];
  if (!env || !specArg) {
    process.stderr.write('Usage: node verify-model-app.js --env <url> --spec @<app-folder>/app-spec.json [--workspace <dir>]\n');
    process.exit(1);
  }
  const specPath = path.resolve(typeof specArg === 'string' && specArg.startsWith('@') ? specArg.slice(1) : specArg);
  const spec = migrateAppSpec(readJsonArg('@' + specPath));
  // Validate the spec up front (consistent with teardown) so malformed input yields a structured
  // error instead of a later throw when dereferencing spec.entities / schemaName.
  const v = validateAppSpec(spec, { profile: 'deploy' });
  if (!v.ok) { emitResult(false, { ok: false, errors: v.errors }); return; }
  const workspaceDir = flags.workspace || path.join(path.dirname(specPath), '.maker-workspace');
  const sdk = makeProvision(env, workspaceDir);
  const genpageCli = makeGenpageCli(env);
  const r = await verifySpec(spec, readerFor(sdk, appUniqueName(spec), { genpageCli, workspaceDir }));
  for (const c of r.checks) process.stderr.write(`  ${c.present ? '✓' : '✗'} ${c.kind}: ${c.name}\n`);
  process.stderr.write(`\n${r.ok ? '✓ verify PASS' : `✗ verify FAIL — ${r.missing.length} missing`} (${r.checks.length - r.missing.length}/${r.checks.length} present)\n`);
  // Include `errors` (alias of missing) so emitResult's failure note reports an accurate count.
  const missing = r.missing.map((m) => `${m.kind}:${m.name}`);
  emitResult(r.ok, { ok: r.ok, present: r.checks.length - r.missing.length, total: r.checks.length, missing, errors: missing });
}

if (require.main === module) {
  main().catch((err) => emitResult(false, err));
}

module.exports = { sitemapXmlFor, readerFor, appIdFor };
