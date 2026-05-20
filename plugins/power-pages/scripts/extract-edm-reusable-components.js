#!/usr/bin/env node

// Catalogs reusable building blocks in a PAC-downloaded EDM source so the migration
// can factor them into SPA components instead of inlining the same source content
// across multiple SPA files. Each reusable artifact gets exactly one SPA component
// in implement Phase 7.6; inlining is a Phase 8 drift item.
//
// Reusable source kinds covered:
//
//   - content-snippet  — `content-snippets/<name>.contentsnippet.yml` (reused via
//                        Liquid `{% snippet 'Name' %}` and `{{ snippets["Name"] }}`)
//   - web-template     — `web-templates/<name>.webtemplate.yml` (reused via
//                        Liquid `{% include 'Name' %}` and as a page-template body)
//   - weblink-set      — `weblink-sets/<name>.weblinkset.yml` (reused via
//                        Liquid `{% include 'weblink_set' webLinks: weblinks["Name"] %}`)
//
// For each artifact, this script:
//   1. Reads the artifact's `adx_name` (the canonical reference label).
//   2. Greps every other source file (web-pages, web-templates, content-snippets,
//      page-templates) for references to that name in the patterns above.
//   3. Emits a finding with `reuseCount`, `referencedBy[]`, and a `spaTarget` shape
//      whose `componentName` is derived from `adx_name` via kebab → PascalCase. No
//      agent inference; the component name is mechanical.
//
// Usage:
//   node extract-edm-reusable-components.js \
//     --edmRoot ./legacy-site \
//     --output ./migration-artifacts/edm-reusable-components.json
//     [--framework react|vue|angular|astro]
//
// Exit codes:
//   0 — output written
//   1 — fatal error (missing flags, non-readable edmRoot)

const fs = require('fs');
const path = require('path');

// -- adx_name extraction ------------------------------------------------------

// PAC YAML uses `adx_name: <value>` (sometimes `adx_displayname: <value>` for the
// human-facing label). We pick `adx_name` because that's what Liquid `{% snippet 'X' %}`
// references — the display name can drift but the snippet/template key cannot.
const ADX_NAME_LINE = /^\s*adx_name\s*:\s*(?:["']?)([^#\n"']+?)(?:["']?)\s*(?:#.*)?$/i;

function readAdxName(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(ADX_NAME_LINE);
      if (m && !line.startsWith(' ') && !line.startsWith('\t')) {
        return m[1].trim();
      }
    }
  } catch {
    // Unreadable / binary files skip silently — partial exports happen in the wild.
  }
  return null;
}

// -- Reference-pattern builders -----------------------------------------------

// Reference patterns for a given source kind + adx_name. Returns an array of
// case-insensitive RegExp objects. We match LOOSELY — over-collecting is safe
// because the count is the signal; a false-positive reference still means the
// snippet was discussed in that file. Under-collecting would silently lose reuse.
function referencePatterns(kind, adxName) {
  // Escape regex metacharacters in the name. Snippets often have spaces, hyphens,
  // and apostrophes — escape them all rather than rely on a name allowlist.
  const escaped = adxName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  switch (kind) {
    case 'content-snippet':
      // {% snippet 'Name' %} / {% snippet "Name" %} / {{ snippets["Name"] }} /
      // {{ snippets['Name'] }} / {{ snippets.Name }} for snippet names that happen
      // to be valid identifiers
      return [
        new RegExp(`\\{%\\s*snippet\\s+['"]${escaped}['"]\\s*%\\}`, 'i'),
        new RegExp(`snippets\\s*\\[\\s*['"]${escaped}['"]\\s*\\]`, 'i'),
      ];
    case 'web-template':
      // {% include 'Template Name' %} / {% block name: 'Template Name' %} /
      // page records use `adx_pagetemplateid` with a name lookup; we count by
      // string match in page-template records too.
      return [
        new RegExp(`\\{%\\s*include\\s+['"]${escaped}['"]`, 'i'),
        new RegExp(`\\{%\\s*block\\s+name:\\s*['"]${escaped}['"]`, 'i'),
        // page-templates/*.pagetemplate.yml records `adx_webtemplateid: ` then the
        // referenced template's `adx_name` on a sibling YAML line.
        new RegExp(`adx_webtemplateid\\s*:.*\\n[\\s\\S]{0,200}?adx_name\\s*:\\s*["']?${escaped}["']?`, 'i'),
      ];
    case 'weblink-set':
      // {% include 'weblink_set' webLinks: weblinks["Name"] %}
      // {% include 'weblink-set' webLinks: weblinks['Name'] %}
      // {{ weblinks["Name"] }}
      return [
        new RegExp(`weblinks\\s*\\[\\s*['"]${escaped}['"]\\s*\\]`, 'i'),
        new RegExp(`webLinks:\\s*weblinks\\s*\\[\\s*['"]${escaped}['"]\\s*\\]`, 'i'),
      ];
    default:
      return [];
  }
}

// -- componentName derivation -------------------------------------------------

// "Newsletter CTA" → "NewsletterCTA"
// "header-nav" → "HeaderNav"
// "primary nav" → "PrimaryNav"
// Numbers preserved, leading non-alphanumeric stripped so the result is a valid
// JS identifier in every supported framework.
function toComponentName(adxName) {
  if (!adxName) return null;
  const cleaned = adxName.replace(/[^a-z0-9 _\-/]+/gi, ' ');
  const parts = cleaned.split(/[\s_\-/]+/).filter(Boolean);
  if (!parts.length) return null;
  return parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join('')
    .replace(/^[^A-Za-z]+/, ''); // no leading digit
}

const SPA_KIND_BY_SOURCE = {
  'content-snippet': 'content',
  'web-template': 'layout',
  'weblink-set': 'navigation',
};

// -- File walking -------------------------------------------------------------

function walkFiles(dir, extensions = null) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
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
      else if (entry.isFile()) {
        if (!extensions || extensions.some((ext) => full.toLowerCase().endsWith(ext))) {
          out.push(full);
        }
      }
    }
  }
  return out;
}

// Files the reference scan reads. We only scan text-like extensions where Liquid
// references can appear; web-files/ binaries and non-text are skipped.
const REFERENCEABLE_EXTENSIONS = ['.html', '.yml', '.yaml', '.js', '.liquid', '.txt', '.css'];

function listReferenceableFiles(edmRoot) {
  const out = [];
  for (const rel of ['web-pages', 'web-templates', 'content-snippets', 'page-templates', 'weblink-sets']) {
    out.push(...walkFiles(path.join(edmRoot, rel), REFERENCEABLE_EXTENSIONS));
  }
  return out;
}

// -- Per-kind scanners --------------------------------------------------------

// Locate every <kind> source file, read its adx_name, count references across the
// rest of the source tree. Self-references are excluded — a snippet file naming
// itself doesn't count as a reuse.
function scanKind(edmRoot, kind, dirName, fileSuffix, allReferenceableFiles, framework) {
  const folder = path.join(edmRoot, dirName);
  if (!fs.existsSync(folder)) return [];
  const findings = [];
  const sourceFiles = walkFiles(folder).filter((f) => f.toLowerCase().endsWith(fileSuffix));
  for (const sourceFile of sourceFiles) {
    const adxName = readAdxName(sourceFile);
    if (!adxName) continue;
    const patterns = referencePatterns(kind, adxName);
    const referencedBy = [];
    for (const candidate of allReferenceableFiles) {
      // A source file can't reuse itself.
      if (candidate === sourceFile) continue;
      // Don't count a snippet's own sidecar (e.g., the .yml's adjacent .liquid).
      // We detect "adjacent" by sharing the same directory + basename prefix.
      const sourceDir = path.dirname(sourceFile);
      const sourceBase = path.basename(sourceFile, fileSuffix);
      if (path.dirname(candidate) === sourceDir && path.basename(candidate).startsWith(sourceBase)) {
        continue;
      }
      let content;
      try {
        content = fs.readFileSync(candidate, 'utf8');
      } catch {
        continue;
      }
      if (patterns.some((re) => re.test(content))) {
        referencedBy.push(path.relative(edmRoot, candidate));
      }
    }
    findings.push({
      sourceArtifact: path.relative(edmRoot, sourceFile),
      sourceKind: kind,
      reuseCount: referencedBy.length,
      referencedBy,
      spaTarget: {
        componentName: toComponentName(adxName),
        kind: SPA_KIND_BY_SOURCE[kind],
        framework: framework || null,
        // i18n is true when the source includes localized variants. Detection here
        // is intentionally conservative: a sibling file with a 2-letter or 5-char
        // locale prefix (e.g. en-US, fr) in the basename is the signal.
        i18n: hasLocalizedSiblings(sourceFile, fileSuffix),
        props: [],
      },
      evidence: [path.relative(edmRoot, sourceFile)],
    });
  }
  return findings;
}

function hasLocalizedSiblings(sourceFile, fileSuffix) {
  try {
    const dir = path.dirname(sourceFile);
    const baseWithoutSuffix = path.basename(sourceFile, fileSuffix);
    return fs
      .readdirSync(dir)
      .some((sibling) => /\.[a-z]{2}(-[a-z]{2})?\./i.test(sibling) && sibling.startsWith(baseWithoutSuffix));
  } catch {
    return false;
  }
}

// -- Main extractor -----------------------------------------------------------

function extractReusableComponents(edmRoot, opts = {}) {
  const framework = opts.framework || null;
  const allReferenceableFiles = listReferenceableFiles(edmRoot);
  const findings = [
    ...scanKind(edmRoot, 'content-snippet', 'content-snippets', '.contentsnippet.yml', allReferenceableFiles, framework),
    ...scanKind(edmRoot, 'web-template', 'web-templates', '.webtemplate.yml', allReferenceableFiles, framework),
    ...scanKind(edmRoot, 'weblink-set', 'weblink-sets', '.weblinkset.yml', allReferenceableFiles, framework),
  ];
  // Sort by sourceKind, then by reuseCount desc, then by sourceArtifact for
  // diff-stable output across analyze re-runs.
  findings.sort((a, b) => {
    if (a.sourceKind !== b.sourceKind) return a.sourceKind.localeCompare(b.sourceKind);
    if (a.reuseCount !== b.reuseCount) return b.reuseCount - a.reuseCount;
    return a.sourceArtifact.localeCompare(b.sourceArtifact);
  });
  return findings;
}

// -- CLI ----------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--edmRoot') args.edmRoot = argv[++i];
    else if (argv[i] === '--output') args.output = argv[++i];
    else if (argv[i] === '--framework') args.framework = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.edmRoot) {
    process.stderr.write('Usage: extract-edm-reusable-components.js --edmRoot <path> [--output <path.json>] [--framework <react|vue|angular|astro>]\n');
    process.exit(1);
  }
  if (!fs.existsSync(args.edmRoot)) {
    process.stderr.write(`EDM source root does not exist: ${args.edmRoot}\n`);
    process.exit(1);
  }
  const findings = extractReusableComponents(args.edmRoot, { framework: args.framework });
  const out = {
    version: 1,
    capturedAt: new Date().toISOString(),
    edmRoot: path.resolve(args.edmRoot),
    framework: args.framework || null,
    reusableComponents: findings,
  };
  if (args.output) {
    fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
    fs.writeFileSync(args.output, JSON.stringify(out, null, 2));
    process.stdout.write(JSON.stringify({ ok: true, output: args.output, count: findings.length }));
  } else {
    process.stdout.write(JSON.stringify(out, null, 2));
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  extractReusableComponents,
  readAdxName,
  referencePatterns,
  toComponentName,
};
