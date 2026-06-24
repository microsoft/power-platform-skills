#!/usr/bin/env node

// Maps a Power Pages component (powerpagecomponent type + name) to the path of
// its serialized SOURCE FIELD file in the bound Azure DevOps repository.
//
// Dataverse Git serializes each site component under:
//   <rootFolder>/<gitFolder>/powerpagesites/<siteName>/<type-folder>/<slug>/[<subfolder>/]<slug><suffix>
// and splits the editable text field into its own file (verified 2026-06-17,
// see POC findings). The clone-based selective-merge flow needs this path to
// read incoming/base sides from the local clone's git objects and write the
// merged file back into the clone's working tree; there is no per-field ADO
// fetch/commit helper anymore.
//
// The ADO folder/file names are a SLUGIFIED form of the component name (spaces
// and slashes → hyphens). Because the exact slug rule is not documented, the
// robust resolver lists the component's type-folder in ADO and normalized-matches
// the slug, falling back to the computed path only when listing is unavailable.
//
// Output (JSON to stdout):
//   { found, path, field, type, typeLabel, slug, resolvedVia: "listing"|"computed", candidates? }
//   Binary/unsupported type: { supported: false, type, reason }
//
// Usage:
//   node map-component-to-git-path.js
//     --type <ppcType> --name <componentName>
//     --rootFolder <rootFolder> --gitFolder <gitFolder> --siteName <siteName>
//     [--field <source|value|copy|summary>]    // default: primary field per type
//     [--branch <branch>]                       // enables ADO listing resolution
//     --organization <org> --project <project> --repository <repo>
//     [--token <bearer>] | [--pat <PAT>]

'use strict';

const fs = require('fs');
const path = require('path');
const { createAdoClient } = require('./ado-client');
const { resolveAdoTokenOrAcquire } = require('./resolve-ado-token');
const { normalizeComponentType } = require('./component-type-map');

// Per-type serialization layout. `primaryField` is the default merge field; the
// `fields` map gives the filename suffix per editable field. `subfolder` (web
// pages) sits between the component folder and the file.
const TYPE_LAYOUT = Object.freeze({
  2: { typeFolder: 'web-pages', subfolder: 'content-pages', primaryField: 'copy',
       fields: { copy: '.webpage.copy.html', summary: '.webpage.summary.html' }, label: 'Web Page' },
  7: { typeFolder: 'content-snippets', primaryField: 'value',
       fields: { value: '.contentsnippet.value.html' }, label: 'Content Snippet' },
  8: { typeFolder: 'web-templates', primaryField: 'source',
       fields: { source: '.webtemplate.source.html' }, label: 'Web Template' },
  // Site Setting (9): the whole flat `.sitesetting.yml` IS the merge file (only the
  // `value:` line conflicts; metadata auto-merges). `flat` = no per-slug subfolder;
  // `format: 'flat-yml'` tells the resolver to synthesize OURS by value-substitution.
  9: { typeFolder: 'site-settings', primaryField: 'value', flat: true, format: 'flat-yml',
       fields: { value: '.sitesetting.yml' }, label: 'Site Setting' },
});

// Types whose source bytes are NOT a standalone text file and have no selective-merge
// path. Site Settings (9) used to be here — now handled via flat-yml-merge.js. Web
// Files (3) used to be here — now classified 'webfile' and routed to a runtime content
// sniff (text-detected → 3-way merge; binary → matrix). This map remains exported so
// callers that check it for historically-known binary types don't crash; it is now empty.
const BINARY_TYPES = Object.freeze({});

/**
 * Slugify a component name the way Dataverse Git names its folders/files:
 * non-filename-safe characters (whitespace, slashes, etc.) collapse to single
 * hyphens. Best-effort — the resolver does a tolerant normalized comparison on
 * top of this so minor rule differences still match.
 * @param {string} name
 * @returns {string}
 */
function slugifyComponentName(name) {
  return String(name)
    .trim()
    .replace(/[\\/\s:*?"<>|]+/g, '-')  // path-hostile chars → hyphen
    .replace(/-+/g, '-')                // collapse runs
    .replace(/^-|-$/g, '');             // trim hyphens
}

/** Aggressive normalization for tolerant matching (case + non-alphanumeric folded). */
function normalizeForMatch(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function siteRoot({ rootFolder, gitFolder, siteName }) {
  const parts = [rootFolder, gitFolder, 'powerpagesites', siteName]
    .filter((p) => p != null && String(p).length > 0)
    .map((p) => String(p).replace(/^\/+|\/+$/g, ''));
  return '/' + parts.join('/');
}

/**
 * Compute the (best-guess) source-file path purely from inputs — no network.
 * @returns {{ path, field, slug, typeFolder } | { supported:false, reason }}
 */
function buildSourceFilePath({ type, name, rootFolder, gitFolder, siteName, field } = {}) {
  // A1: accept type names ("webtemplate") identically to numbers (8).
  const ntype = normalizeComponentType(type);
  if (ntype != null) type = ntype;
  // Web File (type 3): the file in the repo IS the web file itself (e.g. theme.css).
  // No merge field — a runtime content sniff decides text vs binary at resolve time.
  if (type === 3) {
    const slug = slugifyComponentName(name);
    const root = siteRoot({ rootFolder, gitFolder, siteName });
    return { path: `${root}/web-files/${slug}`, kind: 'webfile', field: null, resolvedVia: 'computed' };
  }
  const layout = TYPE_LAYOUT[type];
  if (!layout) {
    return { supported: false, type, reason: BINARY_TYPES[type]
      ? `${BINARY_TYPES[type]} is binary/keep-accept in v1 (no standalone source file).`
      : `Unsupported component type ${type} for selective merge.` };
  }
  const useField = field || layout.primaryField;
  const suffix = layout.fields[useField];
  if (!suffix) {
    return { supported: false, type, reason: `Field '${useField}' is not a mergeable text field for ${layout.label}.` };
  }
  const slug = slugifyComponentName(name);
  const root = siteRoot({ rootFolder, gitFolder, siteName });
  // Flat-YML types (site settings) live DIRECTLY in their type-folder (no per-slug
  // subfolder): site-settings/<slug>.sitesetting.yml.
  const dir = layout.flat
    ? `${root}/${layout.typeFolder}`
    : `${root}/${layout.typeFolder}/${slug}${layout.subfolder ? '/' + layout.subfolder : ''}`;
  return { path: `${dir}/${slug}${suffix}`, field: useField, slug, typeFolder: layout.typeFolder, ...(layout.format ? { format: layout.format } : {}) };
}

/**
 * Build the source-file path DETERMINISTICALLY from the conflict row's
 * `componentpath` (the component folder, e.g. /powerpagesites/<site>/web-templates/<Slug>,
 * verified live 2026-06-19). This is authoritative — it comes from Dataverse's own
 * record — so it needs NO ADO folder listing and no slug-guessing. The full ADO
 * path = /<rootFolder>/<gitFolder> + componentpath + (web-page → /content-pages) +
 * /<lastSegment><fieldSuffix>.
 *
 * @returns {{ path, field, slug, typeFolder, resolvedVia } | { supported:false, reason }}
 */
function buildPathFromComponentPath({ componentPath, type, field, rootFolder, gitFolder } = {}) {
  // A1: accept type names ("webtemplate") identically to numbers (8) so a
  // string-typed inputs.json can never silently fall through to binary.
  const ntype = normalizeComponentType(type);
  if (ntype != null) type = ntype;
  // Web File (type 3): the conflict row's componentPath IS the file path
  // (/powerpagesites/<site>/web-files/<FileName>). Full ADO path = /<root>/<git> + componentPath.
  if (type === 3) {
    if (!componentPath || !String(componentPath).trim()) {
      return { supported: false, type, reason: 'No componentPath on the conflict row.' };
    }
    const cp = String(componentPath).replace(/^\/+|\/+$/g, '');
    const segs = [];
    for (const p of [rootFolder, gitFolder]) if (p != null && String(p).length) segs.push(String(p).replace(/^\/+|\/+$/g, ''));
    for (const s of cp.split('/').filter(Boolean)) segs.push(s);
    return { path: `/${segs.join('/')}`, kind: 'webfile', field: null, resolvedVia: 'componentpath' };
  }
  const layout = TYPE_LAYOUT[type];
  if (!layout) {
    return { supported: false, type, reason: BINARY_TYPES[type]
      ? `${BINARY_TYPES[type]} is binary/keep-accept in v1 (no standalone source file).`
      : `Unsupported component type ${type} for selective merge.` };
  }
  if (!componentPath || !String(componentPath).trim()) {
    return { supported: false, type, reason: 'No componentPath on the conflict row.' };
  }
  const useField = field || layout.primaryField;
  const suffix = layout.fields[useField];
  if (!suffix) {
    return { supported: false, type, reason: `Field '${useField}' is not a mergeable text field for ${layout.label}.` };
  }
  // Flat-YML components (site settings): the whole `.sitesetting.yml` IS the file. The
  // conflict row's componentpath is EITHER the full file path (website.yml style:
  // `/powerpagesites/<site>/site-settings/<Slug>.sitesetting.yml`) OR the slug folder
  // (`/.../site-settings/<Slug>`). Normalize both to the file and prepend root/git.
  if (layout.flat) {
    let cp = String(componentPath).replace(/^\/+|\/+$/g, '');
    if (!cp.toLowerCase().endsWith(suffix.toLowerCase())) cp = `${cp}${suffix}`;
    const segs = [];
    for (const p of [rootFolder, gitFolder]) if (p != null && String(p).length) segs.push(String(p).replace(/^\/+|\/+$/g, ''));
    for (const s of cp.split('/').filter(Boolean)) segs.push(s);
    const lastSeg = cp.split('/').pop();
    const slug = lastSeg.slice(0, lastSeg.length - suffix.length);
    return { path: `/${segs.join('/')}`, field: useField, slug, typeFolder: layout.typeFolder, format: layout.format, resolvedVia: 'componentpath' };
  }
  const cpSegs = String(componentPath).split('/').filter(Boolean);
  // Determine the slug + directory segments. For web pages the conflict row's
  // componentpath ALREADY ends with the layout subfolder (e.g.
  // `/powerpagesites/<site>/web-pages/Access-Denied/content-pages`), so the slug is
  // the segment BEFORE the subfolder and we must NOT re-append the subfolder (doing
  // both produced the live bug `.../content-pages/content-pages.webpage.copy.html`
  // → 404 → mis-flagged deleted-in-git; verified 2026-06-19 on sri-alm-dev-1). When
  // the componentpath does NOT include the subfolder, keep the original behavior:
  // slug = last segment, append the subfolder.
  let slug;
  const dirSegs = cpSegs.slice();
  if (layout.subfolder && cpSegs[cpSegs.length - 1] === layout.subfolder) {
    slug = cpSegs[cpSegs.length - 2];           // componentpath already includes the subfolder
  } else {
    slug = cpSegs[cpSegs.length - 1];
    if (layout.subfolder) dirSegs.push(layout.subfolder);
  }
  const segs = [];
  for (const p of [rootFolder, gitFolder]) if (p != null && String(p).length) segs.push(String(p).replace(/^\/+|\/+$/g, ''));
  for (const s of dirSegs) segs.push(s);
  return { path: `/${segs.join('/')}/${slug}${suffix}`, field: useField, slug, typeFolder: layout.typeFolder, resolvedVia: 'componentpath' };
}

/**
 * Resolve the source-file path robustly by listing the type-folder in ADO and
 * normalized-matching the component slug. Falls back to the computed path.
 *
 * @param {object} opts  buildSourceFilePath inputs + ADO client coords + branch.
 * @returns {Promise<object>}
 */
async function resolveSourceFilePath({
  type, name, rootFolder, gitFolder, siteName, field,
  branch, organization, project, repository,
  token = null, pat = null, tokenFile = null, apiVersion = '7.0', baseUrl = null,
} = {}) {
  // A1: accept type names ("webtemplate") identically to numbers (8).
  const ntype = normalizeComponentType(type);
  if (ntype != null) type = ntype;
  const computed = buildSourceFilePath({ type, name, rootFolder, gitFolder, siteName, field });
  if (computed.supported === false) return computed;

  // Web files (kind: 'webfile') have no type-folder to list in ADO — the path IS the
  // file itself. Return the computed path directly without making any ADO request.
  if (computed.kind === 'webfile') {
    return { found: null, path: computed.path, resolvedVia: 'computed', kind: 'webfile', field: null, type, typeLabel: 'Web File' };
  }

  const layout = TYPE_LAYOUT[type];
  const typeLabel = layout.label;
  const base = { field: computed.field, type, typeLabel, slug: computed.slug };

  // Without ADO coordinates we can only return the computed path.
  if (!branch || !organization || !project || !repository) {
    return { found: null, path: computed.path, resolvedVia: 'computed', ...base };
  }

  let resolvedToken = token;
  if (!pat) {
    const tr = resolveAdoTokenOrAcquire({ token, tokenFile, env: process.env });
    if (!tr.ok) throw new Error(`ADO auth required to resolve path: ${tr.error}`);
    resolvedToken = tr.token;
  }

  const client = createAdoClient({ organization, project, repository, pat, token: resolvedToken, baseUrl, apiVersion });
  const typeFolderPath = `${siteRoot({ rootFolder, gitFolder, siteName })}/${layout.typeFolder}`;
  const suffix = layout.fields[computed.field];

  const res = await client.get('/items', {
    query: {
      scopePath: typeFolderPath, recursionLevel: 'full',
      'versionDescriptor.version': branch, 'versionDescriptor.versionType': 'branch',
    },
  });

  if (res.statusCode === 404) {
    return { found: false, path: computed.path, resolvedVia: 'computed', reason: `Type folder not found in ADO (org '${organization}', repo '${repository}', branch '${branch}'): ${typeFolderPath}. Verify the binding coordinates.`, ...base };
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    // Listing failed — degrade to computed path rather than hard-fail.
    return { found: null, path: computed.path, resolvedVia: 'computed', warning: `ADO listing failed (HTTP ${res.statusCode}) for repo '${repository}' branch '${branch}' at ${typeFolderPath}`, ...base };
  }

  let items = [];
  try { items = JSON.parse(res.body).value || []; } catch { /* fall through */ }
  const sourceFiles = items
    .filter((i) => !i.isFolder && typeof i.path === 'string' && i.path.endsWith(suffix));
  const withBasename = sourceFiles.map((i) => ({
    item: i,
    basename: i.path.slice(i.path.lastIndexOf('/') + 1).slice(0, -suffix.length),
  }));

  const ok = (entry) => ({ found: true, path: entry.item.path, resolvedVia: 'listing', objectId: entry.item.objectId || null, ...base });
  const ambiguous = (entries, kind, key) => ({
    found: false, path: computed.path, resolvedVia: 'computed', ambiguous: true,
    reason: `Ambiguous: ${entries.length} ADO files ${kind} '${key}'. Refusing to guess which component '${name}' maps to.`,
    candidates: entries.map((x) => x.item.path), ...base,
  });

  // 1) Exact slug match wins (avoids the normalized-collision foot-gun where
  //    "Header Nav", "Header-Nav", "HeaderNav" all fold to the same key).
  const exact = withBasename.filter((x) => x.basename === computed.slug);
  if (exact.length === 1) return ok(exact[0]);
  if (exact.length > 1) return ambiguous(exact, 'share the exact slug', computed.slug);

  // 2) Tolerant normalized match — ONLY when unambiguous.
  const wantSlug = normalizeForMatch(computed.slug);
  const normMatches = withBasename.filter((x) => normalizeForMatch(x.basename) === wantSlug);
  if (normMatches.length === 1) return ok(normMatches[0]);
  if (normMatches.length > 1) return ambiguous(normMatches, 'normalize to the same slug', wantSlug);

  // 3) No match → computed fallback with candidates.
  return {
    found: false,
    path: computed.path,
    resolvedVia: 'computed',
    reason: 'No ADO file matched the component slug.',
    candidates: sourceFiles.slice(0, 10).map((i) => i.path),
    ...base,
  };
}

function parseArgs(argv) {
  const a = argv.slice(2);
  const o = { type: null, name: null, rootFolder: null, gitFolder: null, siteName: null, field: null,
    branch: null, organization: null, project: null, repository: null, token: null, pat: null, tokenFile: null, apiVersion: '7.0' };
  for (let i = 0; i < a.length; i++) {
    const n = a[i + 1];
    if (a[i] === '--type' && n) o.type = a[++i];
    else if (a[i] === '--name' && n) o.name = a[++i];
    else if (a[i] === '--rootFolder' && n) o.rootFolder = a[++i];
    else if (a[i] === '--gitFolder' && n) o.gitFolder = a[++i];
    else if (a[i] === '--siteName' && n) o.siteName = a[++i];
    else if (a[i] === '--field' && n) o.field = a[++i];
    else if (a[i] === '--branch' && n) o.branch = a[++i];
    else if (a[i] === '--organization' && n) o.organization = a[++i];
    else if (a[i] === '--project' && n) o.project = a[++i];
    else if (a[i] === '--repository' && n) o.repository = a[++i];
    else if (a[i] === '--token' && n) o.token = a[++i];
    else if (a[i] === '--pat' && n) o.pat = a[++i];
    else if (a[i] === '--tokenFile' && n) o.tokenFile = a[++i];
    else if (a[i] === '--apiVersion' && n) o.apiVersion = a[++i];
  }
  return o;
}

/**
 * Resolve a Web File's path to the ACTUAL bytes file inside the containerized layout
 * that `pac` git-integration now exports. A web file is serialized as a FOLDER:
 *   web-files/theme.css/
 *     theme.css              ← the real bytes (the inner "leaf")
 *     theme.css.webfile.yml  ← metadata sidecar
 * The mappers (buildSourceFilePath / buildPathFromComponentPath) return the FOLDER
 * path (e.g. `.../web-files/theme.css`). Writing OURS bytes to that folder throws
 * EISDIR. This resolves the folder → its inner leaf so staging/merge operate on a
 * real file. fs-aware so it stays correct for BOTH the containerized layout and the
 * legacy flat layout (where the web-file path is already the file).
 *
 * @param {object} args { repoDir, webFilePath, fsImpl?, pathImpl? }
 * @returns {string} the leaf file path (same leading-slash style as the input); when
 *   no repoDir is given or the path can't be resolved, returns webFilePath unchanged.
 */
function resolveWebFileLeaf({ repoDir, webFilePath, fsImpl = fs, pathImpl = path } = {}) {
  if (!repoDir || !webFilePath) return webFilePath;
  const hadLead = /^[/\\]/.test(String(webFilePath));
  const rel = String(webFilePath).replace(/^[/\\]+/, '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!rel) return webFilePath;
  const withLead = (p) => (hadLead ? '/' + p : p);
  const leafName = rel.split('/').filter(Boolean).pop() || '';
  const containerLeaf = `${rel}/${leafName}`;
  const abs = pathImpl.join(repoDir, rel.split('/').join(pathImpl.sep));
  let st = null;
  try { st = fsImpl.statSync(abs); } catch (_) { st = null; }
  // Legacy flat layout: the web-file path already IS the file.
  if (st && typeof st.isFile === 'function' && st.isFile()) return withLead(rel);
  // Containerized layout: the path is a folder holding the bytes + a .webfile.yml.
  if (st && typeof st.isDirectory === 'function' && st.isDirectory()) {
    // Prefer the same-name inner leaf (the standard pac layout).
    try {
      const innerSt = fsImpl.statSync(pathImpl.join(abs, leafName));
      if (innerSt && typeof innerSt.isFile === 'function' && innerSt.isFile()) return withLead(containerLeaf);
    } catch (_) { /* fall through to a directory scan */ }
    // Otherwise take the lone non-sidecar file in the folder (robust to a renamed leaf).
    try {
      const files = (fsImpl.readdirSync(abs) || []).filter((n) => !/\.webfile\.yml$/i.test(n));
      if (files.length === 1) return withLead(`${rel}/${files[0]}`);
    } catch (_) { /* fall through */ }
    return withLead(containerLeaf);
  }
  // Path not present yet (THEIRS-only / add-add): default to the container leaf, which
  // is the current pac git-integration export layout.
  return withLead(containerLeaf);
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  if (normalizeComponentType(args.type) == null || !args.name) {
    process.stderr.write('map-component-to-git-path: --type (name or number) and --name are required\n');
    process.exit(1);
  }
  resolveSourceFilePath(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => { process.stderr.write('map-component-to-git-path: ' + e.message + '\n'); process.exit(1); });
}

module.exports = {
  slugifyComponentName,
  normalizeForMatch,
  buildSourceFilePath,
  buildPathFromComponentPath,
  resolveWebFileLeaf,
  resolveSourceFilePath,
  siteRoot,
  TYPE_LAYOUT,
  BINARY_TYPES,
};
