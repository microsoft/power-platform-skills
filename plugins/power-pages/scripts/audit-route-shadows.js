#!/usr/bin/env node

// Audits the deployed `.powerpages-site/web-pages/` records for partial-URL
// collisions with planned SPA routes. Implement Phase 7.3.d runs this BEFORE
// the SPA route implementation step (Phase 7.5) so the migration knows whether
// any deployed legacy webpage would shadow a migrated SPA route at runtime —
// the exact failure mode behind defect #5 in the migration retrospective
// (`/profile` served the legacy Power Pages page instead of the SPA).
//
// Two collision classes are reported:
//
//   1. `deployed-webpage-shadow`  — a `.powerpages-site/web-pages/<page>.webpage.yml`
//      exists whose `adx_partialurl` matches a planned SPA route. Even with a SPA
//      route registered, Power Pages serves the deployed webpage record at that
//      URL. Resolution: delete the webpage YAML before activating, or rename the
//      webpage to a non-conflicting URL.
//
//   2. `server-rendered-route`    — the planned SPA route lands on a URL that
//      Power Pages always serves server-side (`/profile`, `/sign-in`, etc.) per
//      `lib/powerpages-odata.js#SERVER_RENDERED_ROUTE_SHADOWS`. These can't be
//      pure-SPA routes; the migration must implement them as the documented
//      Power-Pages-aware pattern (auth callbacks, profile editor wired to the
//      Web API, etc.), not as a generic SPA route.
//
// Usage:
//   node audit-route-shadows.js \
//     --projectRoot "<target SPA project root>" \
//     --canonicalModel "<path to canonical-site-model.json>" \
//     [--output <path.json>]
//
// Exit codes:
//   0 — clean (no shadows found)
//   1 — fatal error (missing inputs)
//   2 — shadows found; the audit report is still written

const fs = require('fs');
const path = require('path');
const { findPath } = require('./lib/validation-helpers');
const { lookupRouteShadow } = require('./lib/powerpages-odata');

const ADX_PARTIAL_URL = /^\s*adx_partialurl\s*:\s*(?:["']?)([^#\n"']+?)(?:["']?)\s*(?:#.*)?$/i;
const ADX_PAGE_TEMPLATE = /^\s*adx_pagetemplateid\s*:\s*(?:["']?)([^#\n"']+?)(?:["']?)\s*(?:#.*)?$/i;
const ADX_NAME = /^\s*adx_name\s*:\s*(?:["']?)([^#\n"']+?)(?:["']?)\s*(?:#.*)?$/i;

function normalizeUrl(u) {
  if (!u) return '';
  return String(u).toLowerCase().replace(/^\/+|\/+$/g, '');
}

// Parses a deployed webpage YAML for the fields we need. Line-by-line scan to
// stay dependency-free; we only care about the top-level adx_* fields, never
// nested children.
function readWebpageYaml(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const out = { partialUrl: null, pageTemplate: null, name: null };
  for (const raw of content.split(/\r?\n/)) {
    // Skip indented (nested) lines so we don't catch adx_partialurl on a child.
    if (raw.startsWith(' ') || raw.startsWith('\t')) continue;
    let m;
    if (!out.partialUrl && (m = raw.match(ADX_PARTIAL_URL))) out.partialUrl = m[1].trim();
    else if (!out.pageTemplate && (m = raw.match(ADX_PAGE_TEMPLATE))) out.pageTemplate = m[1].trim();
    else if (!out.name && (m = raw.match(ADX_NAME))) out.name = m[1].trim();
  }
  return out;
}

function walkWebpageYamls(webPagesRoot) {
  const out = [];
  if (!fs.existsSync(webPagesRoot)) return out;
  const stack = [webPagesRoot];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && full.endsWith('.webpage.yml')) out.push(full);
    }
  }
  return out;
}

// Pull every SPA route URL from the canonical model. Covers both `routes[]` (the
// canonical place) and `componentMapping[].route` (legacy plan shape). Returns
// a Map keyed by normalized URL so the audit can join in O(1).
function collectSpaRoutes(model) {
  const out = new Map();
  for (const r of model.routes || []) {
    const url = normalizeUrl(r.route || r.partialUrl || r.url);
    if (url) out.set(url, { route: r.route || r.url, source: 'routes[]' });
  }
  for (const cm of model.componentMapping || []) {
    const url = normalizeUrl(cm.route || cm.partialUrl || cm.url);
    if (url && !out.has(url)) out.set(url, { route: cm.route || cm.url, source: 'componentMapping[]' });
  }
  return out;
}

function auditRouteShadows({ projectRoot, canonicalModel }) {
  const findings = [];
  const spaRoutes = collectSpaRoutes(canonicalModel);

  // Class 1 — deployed-webpage-shadow. Walk .powerpages-site/web-pages/ and
  // flag any partialurl that joins to a planned SPA route. The default page
  // template GUID for code-site scaffolds is harmless (it's the empty SPA
  // shell); a non-default template means the deployed webpage actually renders
  // legacy content at that URL.
  const webPagesRoot = path.join(projectRoot, '.powerpages-site', 'web-pages');
  for (const ymlPath of walkWebpageYamls(webPagesRoot)) {
    const parsed = readWebpageYaml(ymlPath);
    if (!parsed || !parsed.partialUrl) continue;
    const url = normalizeUrl(parsed.partialUrl);
    if (!spaRoutes.has(url)) continue;
    const planned = spaRoutes.get(url);
    findings.push({
      kind: 'deployed-webpage-shadow',
      severity: 'blocker',
      url: '/' + url,
      webpageYaml: path.relative(projectRoot, ymlPath),
      webpageName: parsed.name,
      pageTemplate: parsed.pageTemplate,
      plannedSource: planned.source,
      remediation:
        `Delete or rename "${path.relative(projectRoot, ymlPath)}" before deploy. ` +
        `Even with the SPA's "${planned.route}" route registered, Power Pages serves the ` +
        `deployed webpage record at "/${url}" instead of the migrated SPA component.`,
    });
  }

  // Class 2 — server-rendered-route. These collisions don't depend on the
  // .powerpages-site contents; they're a property of the Power Pages runtime.
  for (const [url, planned] of spaRoutes) {
    const shadow = lookupRouteShadow(url);
    if (!shadow) continue;
    findings.push({
      kind: 'server-rendered-route',
      severity: 'blocker',
      url: '/' + url,
      knownTemplate: shadow.knownTemplate,
      plannedSource: planned.source,
      remediation:
        `Power Pages always server-renders "/${url}" (template "${shadow.knownTemplate}"). ` +
        `Implement this route using the documented Power-Pages-aware pattern ` +
        `(auth callbacks, profile editor wired to Web API, etc.) rather than as a plain SPA route.`,
    });
  }

  return findings;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--projectRoot') args.projectRoot = argv[++i];
    else if (argv[i] === '--canonicalModel') args.canonicalModel = argv[++i];
    else if (argv[i] === '--output') args.output = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = args.projectRoot || process.cwd();
  if (!args.canonicalModel) {
    // Try a default location relative to projectRoot.
    const guess = findPath(projectRoot, 'migration-artifacts/canonical-site-model.json');
    if (guess) args.canonicalModel = guess;
  }
  if (!args.canonicalModel || !fs.existsSync(args.canonicalModel)) {
    process.stderr.write('Usage: audit-route-shadows.js --projectRoot <path> --canonicalModel <path.json> [--output <path.json>]\n');
    process.exit(1);
  }
  let canonicalModel;
  try {
    canonicalModel = JSON.parse(fs.readFileSync(args.canonicalModel, 'utf8'));
  } catch (e) {
    process.stderr.write(`Could not parse canonical model: ${e.message}\n`);
    process.exit(1);
  }
  const findings = auditRouteShadows({ projectRoot, canonicalModel });
  const result = { version: 1, capturedAt: new Date().toISOString(), findings };
  if (args.output) {
    fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
    fs.writeFileSync(args.output, JSON.stringify(result, null, 2));
  }
  process.stdout.write(JSON.stringify(result, null, 2));
  process.exit(findings.length > 0 ? 2 : 0);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  auditRouteShadows,
  readWebpageYaml,
  collectSpaRoutes,
  normalizeUrl,
};
