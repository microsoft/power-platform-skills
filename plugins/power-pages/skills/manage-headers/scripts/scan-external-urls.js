#!/usr/bin/env node

// scan-external-urls.js — scan a Power Pages code site for external URLs
// referenced in HTML, CSS, and JavaScript, and propose a CSP allowlist.
//
// The Power Pages runtime does NOT merge a baseline CSP with user-supplied
// values — the maker is responsible for the full allowlist, including both
// the site's own external sources and the Power-Pages-runtime hosts the
// site needs to function. This script extracts the first half from source
// code and supplies the second half from a built-in catalogue.
//
// Extraction is pattern-based and intentionally conservative. It catches
// URLs in:
//   HTML  — src / href / action / srcset attributes, categorized by tag
//   CSS   — url(...) values and @import statements
//   JS/TS — string literals that look like URLs (https?://...)
//
// Dynamic URLs built at runtime from template literals or computed
// hostnames will NOT be caught. Review the `bySourceFile` output to spot
// gaps before promoting a CSP to enforcement.
//
// CLI usage:
//   node scan-external-urls.js --projectRoot <path> [--exclude <comma-globs>]
//   node scan-external-urls.js --help

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

const EXIT = Object.freeze({
  OK: 0,
  UNKNOWN: 1,
  INVALID_ARGS: 2,
});

// Directory names (at any depth) that should be skipped by default —
// build artifacts, VCS metadata, and dependency folders. Users can extend
// this list via --exclude.
const DEFAULT_EXCLUDE_DIRS = Object.freeze([
  'node_modules',
  '.git',
  '.svelte-kit',
  '.next',
  '.nuxt',
  '.vite',
  '.astro',
  '.turbo',
  '.cache',
  '.output',
  'dist',
  'build',
  'out',
  'coverage',
  '.powerpages-site', // deployment artifacts; we scan source, not the upload bundle
]);

const HTML_EXTS = new Set(['.html', '.htm']);
const CSS_EXTS = new Set(['.css', '.scss', '.sass', '.less']);
const JS_EXTS = new Set([
  '.js', '.mjs', '.cjs',
  '.jsx', '.ts', '.tsx',
  '.vue', '.astro', '.svelte',
]);

// Cloud-independent Power-Pages-runtime sources a CSP should allow. The
// `content.powerapps.*` host for `script-src` is cloud-specific (different
// host per Public / US Gov / DoD / China) and is therefore omitted here —
// the skill composes it separately after detecting the site's cloud via
// `pac auth who`. Listing all four would over-allow the CSP.
const RUNTIME_DEPENDENCIES = Object.freeze({
  'script-src': Object.freeze([
    "'self'",
    "'nonce'", // expanded per-request by the runtime to 'nonce-<random>'
    // Note: one cloud-specific content.powerapps.* host must also be added.
    // See headers.md → Power-Pages-runtime sources a CSP must allow.
  ]),
  'style-src': Object.freeze([
    "'self'",
    "'unsafe-inline'", // platform limitation — out-of-the-box styles require it
    'https:',
  ]),
  'img-src': Object.freeze(["'self'", 'data:', 'https:']),
  'font-src': Object.freeze(["'self'", 'https:', 'data:']),
  'connect-src': Object.freeze(["'self'", 'https:']),
  'frame-ancestors': Object.freeze(["'self'"]),
});

// Mapping of HTML tags to the CSP directive that governs their src/href.
const HTML_TAG_TO_DIRECTIVE = Object.freeze({
  script: 'script-src',
  img: 'img-src',
  iframe: 'frame-src',
  video: 'media-src',
  audio: 'media-src',
  source: 'media-src',
  embed: 'object-src', // CSP Level 3 pairs <embed> with object-src alongside <object>/<applet>
  form: 'form-action',
  // <link> is special — categorized by rel attribute below
});

const HELP = `Usage:
  scan-external-urls.js --projectRoot <path>
                        [--exclude <comma-separated directory names>]
                        [--output <file>]
  scan-external-urls.js --help

Scans a Power Pages code site's source files for external URLs and proposes
a CSP allowlist. Pattern-based — dynamic URLs built at runtime will not
be caught.

Options:
  --projectRoot <path>   The code-site directory (REQUIRED).
  --exclude <names>      Extra directory names to skip. Added on top of
                         the default exclusions (node_modules, .git, dist,
                         build, .powerpages-site, etc.).
  --output <file>        Write the JSON result to <file> instead of stdout.
                         Use this on large sites where bySourceFile would
                         exceed the agent harness 10-30K char buffer; stdout
                         then prints only a one-line {written, summary}
                         pointer with directive counts.
  -h, --help             Show this help.

Output (stdout, default):
  {
    "byDirective": {
      "script-src":  ["<host>", ...],
      "style-src":   ["<host>", ...],
      "img-src":     ["<host>", ...],
      "font-src":    ["<host>", ...],
      "connect-src": ["<host>", ...],
      "frame-src":   ["<host>", ...],
      "media-src":   ["<host>", ...],
      "object-src":  ["<host>", ...],
      "form-action": ["<host>", ...]
    },
    "runtimeDependencies": { "<directive>": [<sources>], ... },
    "bySourceFile": [ { "file": "<relpath>", "urls": ["<full url>", ...] } ]
  }

Output (stdout, with --output):
  { "written": "<absolute path>",
    "summary": { "byDirectiveCounts": { "<directive>": N, ... },
                 "totalSourceFiles": N } }

Exit codes:
  0  Success.
  1  Unknown or I/O failure.
  2  Invalid or missing CLI arguments.

Examples:
  node scan-external-urls.js --projectRoot ./my-site
  node scan-external-urls.js --projectRoot ./my-site --exclude legacy,tmp
  node scan-external-urls.js --projectRoot ./my-site --output ./csp-scan.json
`;

function exitWithMessage(exitCode, message) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(exitCode);
}

function invalidArgs(message) {
  const err = new Error(message);
  err.code = 'INVALID_ARGS';
  return err;
}

function hostFromUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

// ===== File walking =====

/**
 * Recursively walk `dir`, yielding file paths. Skips directory names in
 * `excludedDirs` at any depth and symlinks (to avoid loops).
 */
function* walkFiles(dir, excludedDirs) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (excludedDirs.has(entry.name)) continue;
      yield* walkFiles(full, excludedDirs);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

// ===== Extractors =====

// Matches src / href / action attributes (and friends) on well-known tags.
// Uses named capture groups so we can distinguish tag + attribute + value.
const HTML_ATTR_REGEX = /<\s*(?<tag>script|link|img|iframe|video|audio|source|embed|form)\b[^>]*?\s(?<attr>src|href|action|srcset)\s*=\s*["'](?<url>[^"']+)["']/gi;

// Matches <link rel="...">. Used to decide whether a <link href=...> is a
// stylesheet (style-src), a preconnect/dns-prefetch (connect-src), or
// something else (img-src as a catch-all).
const LINK_REL_REGEX = /<\s*link\b[^>]*?\srel\s*=\s*["'](?<rel>[^"']+)["'][^>]*?\shref\s*=\s*["'](?<url>[^"']+)["']/gi;
// And the reverse order — rel can appear after href on the same tag.
const LINK_HREF_FIRST_REGEX = /<\s*link\b[^>]*?\shref\s*=\s*["'](?<url>[^"']+)["'][^>]*?\srel\s*=\s*["'](?<rel>[^"']+)["']/gi;

function extractHtmlUrls(content, filePath) {
  const found = []; // { url, directive }
  const links = new Map(); // url → rel (so we don't double-count <link>)

  for (const match of content.matchAll(LINK_REL_REGEX)) {
    links.set(match.groups.url, match.groups.rel.toLowerCase());
  }
  for (const match of content.matchAll(LINK_HREF_FIRST_REGEX)) {
    if (!links.has(match.groups.url)) links.set(match.groups.url, match.groups.rel.toLowerCase());
  }

  for (const match of content.matchAll(HTML_ATTR_REGEX)) {
    const tag = match.groups.tag.toLowerCase();
    const attr = match.groups.attr.toLowerCase();
    const url = match.groups.url;
    if (tag === 'link') continue; // handled below
    const directive = HTML_TAG_TO_DIRECTIVE[tag];
    if (!directive) continue;
    // `img srcset="url 2x, url2 1x"` — split into individual URLs
    if (attr === 'srcset') {
      for (const item of url.split(',')) {
        const first = item.trim().split(/\s+/)[0];
        if (first) found.push({ url: first, directive });
      }
    } else {
      found.push({ url, directive });
    }
  }

  for (const [url, rel] of links) {
    let directive;
    if (rel.includes('stylesheet')) directive = 'style-src';
    else if (rel.includes('preconnect') || rel.includes('dns-prefetch')) directive = 'connect-src';
    else if (rel.includes('icon') || rel.includes('image')) directive = 'img-src';
    else directive = 'connect-src'; // conservative catch-all for link tags
    found.push({ url, directive });
  }

  return found;
}

const CSS_URL_REGEX = /url\s*\(\s*(?:"([^"]+)"|'([^']+)'|([^)\s]+))\s*\)/g;
const CSS_IMPORT_REGEX = /@import\s+(?:"([^"]+)"|'([^']+)')/g;

function extractCssUrls(content) {
  const found = [];
  for (const match of content.matchAll(CSS_IMPORT_REGEX)) {
    const url = match[1] || match[2];
    if (url) found.push({ url, directive: 'style-src' });
  }
  for (const match of content.matchAll(CSS_URL_REGEX)) {
    const url = match[1] || match[2] || match[3];
    if (!url) continue;
    // Without deeper parsing we can't reliably tell fonts from images.
    // Bucket everything under img-src; callers can review bySourceFile.
    found.push({ url, directive: 'img-src' });
  }
  return found;
}

// Match URL literals inside JavaScript/TypeScript source. Conservative —
// only matches protocol-prefixed URLs in single/double/backtick quotes.
const JS_URL_REGEX = /["'`](https?:\/\/[^"'`\s<>()]+)["'`]/g;

function extractJsUrls(content) {
  const found = [];
  for (const match of content.matchAll(JS_URL_REGEX)) {
    const url = match[1];
    // connect-src is the closest CSP bucket for JS-initiated requests;
    // users can re-categorize if they know the target is media / img.
    found.push({ url, directive: 'connect-src' });
  }
  return found;
}

// ===== Scan =====

function scanProject({ projectRoot, extraExcludes = [] } = {}) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw invalidArgs('--projectRoot is required');
  }
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw invalidArgs(`--projectRoot does not exist or is not a directory: ${projectRoot}`);
  }

  const excluded = new Set([...DEFAULT_EXCLUDE_DIRS, ...extraExcludes]);
  const byDirective = new Map(); // directive → Set of hosts
  const bySourceFile = []; // { file, urls }

  for (const file of walkFiles(projectRoot, excluded)) {
    const ext = path.extname(file).toLowerCase();
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // binary / unreadable
    }

    let hits = [];
    if (HTML_EXTS.has(ext)) {
      hits = extractHtmlUrls(content, file);
    } else if (CSS_EXTS.has(ext)) {
      hits = extractCssUrls(content);
    } else if (JS_EXTS.has(ext)) {
      hits = extractJsUrls(content);
    }
    if (hits.length === 0) continue;

    const fileUrls = new Set();
    for (const { url, directive } of hits) {
      const host = hostFromUrl(url);
      if (!host) continue; // relative / data URI / etc. — not a CSP allowlist candidate
      fileUrls.add(url);
      if (!byDirective.has(directive)) byDirective.set(directive, new Set());
      byDirective.get(directive).add(host);
    }
    if (fileUrls.size > 0) {
      bySourceFile.push({
        file: path.relative(projectRoot, file).split(path.sep).join('/'),
        urls: [...fileUrls].sort(),
      });
    }
  }

  const byDirectiveOut = {};
  for (const [directive, hosts] of byDirective) {
    byDirectiveOut[directive] = [...hosts].sort();
  }

  return {
    byDirective: byDirectiveOut,
    runtimeDependencies: RUNTIME_DEPENDENCIES,
    bySourceFile: bySourceFile.sort((a, b) => a.file.localeCompare(b.file)),
  };
}

// ===== CLI =====

function parseCli(argv) {
  const options = {
    projectRoot: { type: 'string' },
    exclude: { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  };
  return parseArgs({ args: argv.slice(2), options, strict: true }).values;
}

function main() {
  let args;
  try {
    args = parseCli(process.argv);
  } catch (err) {
    exitWithMessage(EXIT.INVALID_ARGS, `Argument error: ${err.message}\n\n${HELP}`);
    return;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  try {
    const extraExcludes = args.exclude
      ? args.exclude.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const result = scanProject({ projectRoot: args.projectRoot, extraExcludes });
    if (args.output) {
      const outPath = path.resolve(args.output);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
      const byDirectiveCounts = Object.fromEntries(
        Object.entries(result.byDirective).map(([d, hosts]) => [d, hosts.length]),
      );
      const pointer = {
        written: outPath,
        summary: {
          byDirectiveCounts,
          totalSourceFiles: result.bySourceFile.length,
        },
      };
      process.stdout.write(JSON.stringify(pointer, null, 2) + '\n');
    } else {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
  } catch (err) {
    const exitCode = err.code === 'INVALID_ARGS' ? EXIT.INVALID_ARGS : EXIT.UNKNOWN;
    exitWithMessage(exitCode, err.stack || err.message);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  scanProject,
  extractHtmlUrls,
  extractCssUrls,
  extractJsUrls,
  hostFromUrl,
  RUNTIME_DEPENDENCIES,
  DEFAULT_EXCLUDE_DIRS,
  EXIT,
};
