#!/usr/bin/env node

// Maps a Power Pages component (powerpagecomponent type + name) to the path of
// its serialized SOURCE FIELD file in the bound Azure DevOps repository.
//
// Dataverse Git serializes each site component under:
//   <rootFolder>/<gitFolder>/powerpagesites/<siteName>/<type-folder>/<slug>/[<subfolder>/]<slug><suffix>
// and splits the editable text field into its own file (verified 2026-06-17,
// see POC findings). The selective-merge flow needs this path to (a) fetch the
// incoming/base versions of the field via ado-get-file.js and (b) commit the
// merged field back via ado-commit-file.js.
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

const { createAdoClient } = require('./ado-client');
const { resolveAdoTokenOrAcquire } = require('./resolve-ado-token');

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
});

// Types whose source bytes are NOT a standalone text file (handled as binary /
// keep-accept in v1): 3 = Web File (bytes in annotation), 9 = Site Setting
// (value embedded in the .sitesetting.yml).
const BINARY_TYPES = Object.freeze({ 3: 'Web File', 9: 'Site Setting' });

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
  const dir = `${root}/${layout.typeFolder}/${slug}${layout.subfolder ? '/' + layout.subfolder : ''}`;
  return { path: `${dir}/${slug}${suffix}`, field: useField, slug, typeFolder: layout.typeFolder };
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
  const computed = buildSourceFilePath({ type, name, rootFolder, gitFolder, siteName, field });
  if (computed.supported === false) return computed;

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
    if (a[i] === '--type' && n) o.type = parseInt(a[++i], 10);
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

if (require.main === module) {
  const args = parseArgs(process.argv);
  if (!Number.isInteger(args.type) || !args.name) {
    process.stderr.write('map-component-to-git-path: --type and --name are required\n');
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
  resolveSourceFilePath,
  siteRoot,
  TYPE_LAYOUT,
  BINARY_TYPES,
};
