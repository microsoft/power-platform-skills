#!/usr/bin/env node
/**
 * snapshot-site.js
 *
 * Walks a `pac pages download` site tree and builds a JSON snapshot of every
 * artifact it knows about. Pre-migration (modelVersion 1) and post-migration
 * (modelVersion 2) snapshots have the same shape, so they can be diffed by
 * diff-snapshots.js.
 *
 * USAGE
 *   node snapshot-site.js --site-root <path> --output-dir <path> --label sdm|edm
 *
 * OUTPUT
 *   <output-dir>/<label>-snapshot.json
 *
 * Identity fields per artifact are deliberately narrow (name + language +
 * statecode) so the diff is robust against harmless YAML reordering and
 * whitespace differences. Pass --with-content-hash to also include SHA-256 of
 * the companion content file (webpage copy HTML, snippet value HTML, web
 * template source, …) when one exists — stricter but can false-positive on
 * encoding/line-ending shifts.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseSimpleYaml } = require('../../../scripts/lib/powerpages-config');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[k] = true;
      } else {
        out[k] = next;
        i += 1;
      }
    }
  }
  return out;
}

function safeReaddir(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

function findFilesBySuffix(dir, suffix) {
  if (!fs.existsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((e) => e.isFile() && e.name.endsWith(suffix))
    .map((e) => path.join(dir, e.name));
}

function safeParseYaml(filePath, errors) {
  try {
    return parseSimpleYaml(fs.readFileSync(filePath, 'utf8'), filePath);
  } catch (e) {
    errors.push({ filePath, message: e.message });
    return null;
  }
}

function sha256OfFileIfExists(p) {
  if (!p || !fs.existsSync(p)) return null;
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex').slice(0, 16);
}

// Extract a language tag from a filename like "About-Footer.en-US.contentsnippet.yml".
// Returns null if the segment doesn't match a BCP-47-ish pattern.
function extractLanguageTag(filename, suffix) {
  const base = filename.slice(0, -suffix.length);
  const segments = base.split('.');
  if (segments.length < 2) return null;
  const last = segments[segments.length - 1];
  return /^[a-z]{2,3}(-[A-Z]{2,4})?$/i.test(last) ? last : null;
}

// Pull each top-level "- " block out of a collection YAML and turn each block
// into a flat record by line-parsing. parseSimpleYaml doesn't handle arrays
// of objects, so we do this directly. Sufficient for sitesetting.yml,
// webrole.yml, sitemarker.yml, and the *.weblinkset.weblink.yml sibling.
function parseCollectionFile(filePath, errors) {
  const records = [];
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    let current = null;
    for (const rawLine of lines) {
      if (/^- /.test(rawLine)) {
        if (current) records.push(current);
        current = {};
        const rest = rawLine.slice(2);
        addKeyValueToRecord(current, rest);
      } else if (current && /^\s+/.test(rawLine) && rawLine.trim()) {
        addKeyValueToRecord(current, rawLine.trim());
      }
    }
    if (current) records.push(current);
  } catch (e) {
    errors.push({ filePath, message: e.message });
  }
  return records;
}

function addKeyValueToRecord(rec, line) {
  const sep = line.indexOf(':');
  if (sep === -1) return;
  const key = line.slice(0, sep).trim();
  let value = line.slice(sep + 1).trim();
  if (!key) return;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  } else if (value === 'true') value = true;
  else if (value === 'false') value = false;
  else if (/^-?\d+$/.test(value)) value = Number(value);
  rec[key] = value;
}

// ── Per-artifact scanners ──────────────────────────────────────────────────

function scanWebPages(siteRoot, withContentHash) {
  const errors = [];
  const inventory = [];
  const root = path.join(siteRoot, 'web-pages');
  if (!fs.existsSync(root)) return { count: 0, inventory: [], parseErrors: [] };

  for (const slug of safeReaddir(root)) {
    if (!slug.isDirectory()) continue;
    const slugDir = path.join(root, slug.name);

    // Parent page: <Name>.webpage.yml at <slug>/ (not in content-pages/)
    for (const f of findFilesBySuffix(slugDir, '.webpage.yml')) {
      const rec = safeParseYaml(f, errors);
      if (!rec) continue;
      inventory.push({
        kind: 'parent',
        slug: slug.name,
        name: rec.adx_name || null,
        partialUrl: rec.adx_partialurl || null,
        isRoot: rec.adx_isroot === true || rec.adx_isroot === 'true',
        stateCode: typeof rec.statecode === 'number' ? rec.statecode : null,
        contentHash: withContentHash ? sha256OfFileIfExists(f.replace('.webpage.yml', '.webpage.copy.html')) : undefined,
      });
    }

    // Content (localized) pages under content-pages/<Name>.<lang>.webpage.yml
    const contentPagesDir = path.join(slugDir, 'content-pages');
    for (const f of findFilesBySuffix(contentPagesDir, '.webpage.yml')) {
      const rec = safeParseYaml(f, errors);
      if (!rec) continue;
      inventory.push({
        kind: 'content',
        slug: slug.name,
        name: rec.adx_name || null,
        partialUrl: rec.adx_partialurl || null,
        language: extractLanguageTag(path.basename(f), '.webpage.yml'),
        stateCode: typeof rec.statecode === 'number' ? rec.statecode : null,
        contentHash: withContentHash ? sha256OfFileIfExists(f.replace('.webpage.yml', '.webpage.copy.html')) : undefined,
      });
    }
  }
  return { count: inventory.length, inventory, parseErrors: errors };
}

function scanContentSnippets(siteRoot, withContentHash) {
  const errors = [];
  const inventory = [];
  const root = path.join(siteRoot, 'content-snippets');
  for (const slug of safeReaddir(root)) {
    if (!slug.isDirectory()) continue;
    const dir = path.join(root, slug.name);
    for (const f of findFilesBySuffix(dir, '.contentsnippet.yml')) {
      const rec = safeParseYaml(f, errors);
      if (!rec) continue;
      inventory.push({
        slug: slug.name,
        name: rec.adx_name || null,
        displayName: rec.adx_display_name || null,
        language: extractLanguageTag(path.basename(f), '.contentsnippet.yml'),
        stateCode: typeof rec.statecode === 'number' ? rec.statecode : null,
        contentHash: withContentHash ? sha256OfFileIfExists(f.replace('.contentsnippet.yml', '.contentsnippet.value.html')) : undefined,
      });
    }
  }
  return { count: inventory.length, inventory, parseErrors: errors };
}

function scanWebLinkSets(siteRoot) {
  const errors = [];
  const inventory = [];
  const root = path.join(siteRoot, 'weblink-sets');
  for (const slug of safeReaddir(root)) {
    if (!slug.isDirectory()) continue;
    const dir = path.join(root, slug.name);
    for (const f of findFilesBySuffix(dir, '.weblinkset.yml')) {
      // Skip the sibling weblink-collection file (ends with .weblinkset.weblink.yml)
      if (f.endsWith('.weblinkset.weblink.yml')) continue;
      const rec = safeParseYaml(f, errors);
      if (!rec) continue;
      const language = extractLanguageTag(path.basename(f), '.weblinkset.yml');

      // Read sibling weblinks file (collection format)
      const linksFile = f.replace('.weblinkset.yml', '.weblinkset.weblink.yml');
      const linkRecs = fs.existsSync(linksFile) ? parseCollectionFile(linksFile, errors) : [];
      const links = linkRecs
        .filter((r) => (r.statecode ?? 0) === 0) // active links only for nav count
        .map((r) => ({
          name: r.adx_name || null,
          displayOrder: typeof r.adx_displayorder === 'number' ? r.adx_displayorder : null,
        }))
        .sort((a, b) => (a.displayOrder ?? 999) - (b.displayOrder ?? 999) || String(a.name).localeCompare(String(b.name)));

      inventory.push({
        slug: slug.name,
        name: rec.adx_name || null,
        language,
        stateCode: typeof rec.statecode === 'number' ? rec.statecode : null,
        linkCount: links.length,
        linkNames: links.map((l) => l.name),
      });
    }
  }
  return { count: inventory.length, inventory, parseErrors: errors };
}

function scanWebTemplates(siteRoot, withContentHash) {
  const errors = [];
  const inventory = [];
  const root = path.join(siteRoot, 'web-templates');
  for (const slug of safeReaddir(root)) {
    if (!slug.isDirectory()) continue;
    const dir = path.join(root, slug.name);
    for (const f of findFilesBySuffix(dir, '.webtemplate.yml')) {
      const rec = safeParseYaml(f, errors);
      if (!rec) continue;
      inventory.push({
        slug: slug.name,
        name: rec.adx_name || null,
        stateCode: typeof rec.statecode === 'number' ? rec.statecode : null,
        contentHash: withContentHash ? sha256OfFileIfExists(f.replace('.webtemplate.yml', '.webtemplate.source.html')) : undefined,
      });
    }
  }
  return { count: inventory.length, inventory, parseErrors: errors };
}

// Flat folder: <root>/<Name>.<artifactKind>.yml (no per-name subfolder)
function scanFlatFolder(siteRoot, folder, suffix, identity) {
  const errors = [];
  const inventory = [];
  const dir = path.join(siteRoot, folder);
  for (const f of findFilesBySuffix(dir, suffix)) {
    const rec = safeParseYaml(f, errors);
    if (!rec) continue;
    const item = {};
    for (const [outKey, ymlKey] of Object.entries(identity)) {
      item[outKey] = rec[ymlKey] ?? null;
    }
    item.stateCode = typeof rec.statecode === 'number' ? rec.statecode : null;
    inventory.push(item);
  }
  return { count: inventory.length, inventory, parseErrors: errors };
}

// Per-slug subfolder: <root>/<slug>/<slug>.<artifactKind>.yml
function scanPerSlugFolder(siteRoot, folder, suffix, identity) {
  const errors = [];
  const inventory = [];
  const root = path.join(siteRoot, folder);
  for (const slug of safeReaddir(root)) {
    if (!slug.isDirectory()) continue;
    const dir = path.join(root, slug.name);
    for (const f of findFilesBySuffix(dir, suffix)) {
      const rec = safeParseYaml(f, errors);
      if (!rec) continue;
      const item = { slug: slug.name };
      for (const [outKey, ymlKey] of Object.entries(identity)) {
        item[outKey] = rec[ymlKey] ?? null;
      }
      item.stateCode = typeof rec.statecode === 'number' ? rec.statecode : null;
      inventory.push(item);
    }
  }
  return { count: inventory.length, inventory, parseErrors: errors };
}

// Top-level collection file (an array of records). PAC names: sitesetting.yml,
// webrole.yml, sitemarker.yml, websiteaccess.yml, publishingstate.yml, etc.
function scanTopLevelCollection(siteRoot, file, identity) {
  const errors = [];
  const inventory = [];
  const full = path.join(siteRoot, file);
  if (!fs.existsSync(full)) return { count: 0, inventory: [], parseErrors: [] };
  for (const rec of parseCollectionFile(full, errors)) {
    const item = {};
    for (const [outKey, ymlKey] of Object.entries(identity)) {
      item[outKey] = rec[ymlKey] ?? null;
    }
    item.stateCode = typeof rec.statecode === 'number' ? rec.statecode : null;
    inventory.push(item);
  }
  return { count: inventory.length, inventory, parseErrors: errors };
}

// ── Canonicalize inventory for stable diffs ────────────────────────────────

function sortInventory(arr, ...keys) {
  return arr.slice().sort((a, b) => {
    for (const k of keys) {
      const av = String(a[k] ?? '');
      const bv = String(b[k] ?? '');
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  const siteRoot = args['site-root'];
  const outputDir = args['output-dir'];
  const label = args['label'];
  const withContentHash = !!args['with-content-hash'];

  if (!siteRoot) { console.error('--site-root is required'); process.exit(1); }
  if (!outputDir) { console.error('--output-dir is required'); process.exit(1); }
  if (!label || !['sdm', 'edm'].includes(label)) {
    console.error('--label must be "sdm" or "edm"'); process.exit(1);
  }
  if (!fs.existsSync(siteRoot)) {
    console.error(`Site root not found: ${siteRoot}`); process.exit(1);
  }

  const categories = {
    webPages: scanWebPages(siteRoot, withContentHash),
    contentSnippets: scanContentSnippets(siteRoot, withContentHash),
    webLinkSets: scanWebLinkSets(siteRoot),
    webTemplates: scanWebTemplates(siteRoot, withContentHash),
    webFiles: scanFlatFolder(siteRoot, 'web-files', '.webfile.yml',
      { name: 'adx_name', partialUrl: 'adx_partialurl' }),
    pageTemplates: scanFlatFolder(siteRoot, 'page-templates', '.pagetemplate.yml',
      { name: 'adx_name' }),
    tablePermissions: scanFlatFolder(siteRoot, 'table-permissions', '.tablepermission.yml',
      { name: 'adx_entityname', permissionName: 'adx_name' }),
    basicForms: scanPerSlugFolder(siteRoot, 'basic-forms', '.basicform.yml',
      { name: 'adx_name' }),
    advancedForms: scanPerSlugFolder(siteRoot, 'advanced-forms', '.advancedform.yml',
      { name: 'adx_name' }),
    lists: scanPerSlugFolder(siteRoot, 'lists', '.entitylist.yml',
      { name: 'adx_name' }),
    polls: scanPerSlugFolder(siteRoot, 'polls', '.poll.yml',
      { name: 'adx_name' }),
    pollPlacements: scanPerSlugFolder(siteRoot, 'poll-placements', '.pollplacement.yml',
      { name: 'adx_name' }),
    cloudFlowConsumers: scanPerSlugFolder(siteRoot, 'cloud-flow-consumer', '.cloudflowconsumer.yml',
      { name: 'adx_name' }),
    columnPermissionProfiles: scanPerSlugFolder(siteRoot, 'column-permission-profiles', '.columnpermissionprofile.yml',
      { name: 'adx_name' }),
    siteSettings: scanTopLevelCollection(siteRoot, 'sitesetting.yml',
      { name: 'adx_name', value: 'adx_value' }),
    webRoles: scanTopLevelCollection(siteRoot, 'webrole.yml',
      { name: 'adx_name' }),
    siteMarkers: scanTopLevelCollection(siteRoot, 'sitemarker.yml',
      { name: 'adx_name' }),
    websiteAccesses: scanTopLevelCollection(siteRoot, 'websiteaccess.yml',
      { name: 'adx_name' }),
    publishingStates: scanTopLevelCollection(siteRoot, 'publishingstate.yml',
      { name: 'adx_name' }),
    webpageRules: scanTopLevelCollection(siteRoot, 'webpagerule.yml',
      { name: 'adx_name' }),
    websiteBindings: scanTopLevelCollection(siteRoot, 'websitebinding.yml',
      { name: 'adx_name' }),
    websiteLanguages: scanTopLevelCollection(siteRoot, 'websitelanguage.yml',
      { name: 'adx_name' }),
    ads: scanTopLevelCollection(siteRoot, 'ad.yml',
      { name: 'adx_name' }),
    adPlacements: scanTopLevelCollection(siteRoot, 'adplacement.yml',
      { name: 'adx_name' }),
    tags: scanTopLevelCollection(siteRoot, 'tag.yml',
      { name: 'adx_name' }),
    urlHistory: scanTopLevelCollection(siteRoot, 'urlhistory.yml',
      { name: 'adx_url_logicalname' }),
  };

  // Canonical sort keys per category.
  const sortKeys = {
    webPages: ['kind', 'slug', 'partialUrl', 'language'],
    contentSnippets: ['slug', 'language', 'name'],
    webLinkSets: ['slug', 'language', 'name'],
    webTemplates: ['slug', 'name'],
    webFiles: ['name', 'partialUrl'],
    pageTemplates: ['name'],
    tablePermissions: ['name', 'permissionName'],
    basicForms: ['slug', 'name'],
    advancedForms: ['slug', 'name'],
    lists: ['slug', 'name'],
    polls: ['slug', 'name'],
    pollPlacements: ['slug', 'name'],
    cloudFlowConsumers: ['slug', 'name'],
    columnPermissionProfiles: ['slug', 'name'],
    siteSettings: ['name'],
    webRoles: ['name'],
    siteMarkers: ['name'],
    websiteAccesses: ['name'],
    publishingStates: ['name'],
    webpageRules: ['name'],
    websiteBindings: ['name'],
    websiteLanguages: ['name'],
    ads: ['name'],
    adPlacements: ['name'],
    tags: ['name'],
    urlHistory: ['name'],
  };
  for (const [cat, keys] of Object.entries(sortKeys)) {
    if (categories[cat]) {
      categories[cat].inventory = sortInventory(categories[cat].inventory, ...keys);
    }
  }

  const counts = {};
  for (const [cat, data] of Object.entries(categories)) counts[cat] = data.count;

  const snapshot = {
    schemaVersion: 1,
    label,
    siteRoot: path.resolve(siteRoot),
    capturedAt: new Date().toISOString(),
    withContentHash,
    counts,
    inventory: Object.fromEntries(
      Object.entries(categories).map(([cat, data]) => [cat, data.inventory]),
    ),
    parseErrors: Object.fromEntries(
      Object.entries(categories)
        .map(([cat, data]) => [cat, data.parseErrors])
        .filter(([, errs]) => errs.length > 0),
    ),
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, `${label}-snapshot.json`);
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

  console.log(`✓ Wrote ${outPath}`);
  const totalErrors = Object.values(snapshot.parseErrors).reduce((n, errs) => n + errs.length, 0);
  console.log('');
  console.log(`  Category                    Count`);
  console.log(`  ──────────────────────────  ─────`);
  for (const [cat, n] of Object.entries(counts)) {
    if (n === 0) continue; // hide noisy zeros for sites that don't use every artifact
    console.log(`  ${cat.padEnd(26)}  ${String(n).padStart(5)}`);
  }
  if (totalErrors > 0) {
    console.log('');
    console.log(`  ⚠ ${totalErrors} YAML parse errors (see parseErrors in snapshot file)`);
  }
}

main();
