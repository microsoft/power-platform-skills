#!/usr/bin/env node

// Lints SKILL.md files and component-creation scripts for violations of the
// ALM-aware-by-default principle documented in plugins/power-pages/AGENTS.md.
//
// Rules (see PLUGIN_DEVELOPMENT_GUIDE.md for authoritative descriptions):
//
//   SKILL-must-read-manifest
//     Trigger: SKILL.md contains Dataverse record-creation language
//              (POST to /api/data, AddSolutionComponent, create publisher/solution)
//     Require: the same file references `.solution-manifest.json`.
//     Waivable: yes, via `<!-- alm-lint-ignore: SKILL-must-read-manifest ... -->`.
//
//   SCRIPT-must-use-resolver
//     Trigger: `scripts/**/*.js` (excluding `lib/`, `tests/`, and this file)
//              makes an `AddSolutionComponent` call or creates an
//              `environmentvariabledefinition` / `publisher` / `solution` record.
//     Require: the file imports `./lib/resolve-target-solution`.
//     Waivable: yes, via `// alm-lint-ignore: SCRIPT-must-use-resolver ...`.
//
//   DISCOVER-coverage
//     Trigger: SKILL.md mentions `powerpagecomponenttype eq N` for any `N`.
//     Require: `N` is present in `scripts/lib/discover-site-components.js`
//              (via PPC_TYPE_LABELS).
//     Waivable: no — new component types must be added to the discovery module.
//
// Usage:
//   node scripts/lint-skills-alm.js [--plugin-root <path>]
//   Exit 0 when no findings; exit 1 when findings exist (stderr lists them).
//
// The script is pure-Node, has no dependencies, and returns findings
// programmatically so the tests can assert behavior without spawning processes.

'use strict';

const fs = require('fs');
const path = require('path');

// Lightweight glob that recursively walks a directory and returns files whose
// RELATIVE path (from root) matches every predicate.
function walkFiles(rootDir, predicate) {
  const out = [];
  (function visit(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && predicate(full)) out.push(full);
    }
  })(rootDir);
  return out;
}

// Heuristics that identify "this file creates or mutates Dataverse state" across
// two very different content shapes:
//
// * SKILL.md prose style:  `POST {envUrl}/api/data/v9.2/environmentvariabledefinitions`
//                          `PATCH {envUrl}/api/data/v9.2/solutions(...)`
// * JavaScript call style: `makeRequest({ url: '…environmentvariabledefinitions', method: 'POST' })`
//                          `apiPatch('solutions', ...)`
//
// The prose regex requires a write verb + `/api/data/` URL on the same line.
// The JS checks accept verb + endpoint in any order across the whole file.
// POST creates; PATCH/PUT mutate an existing record and should still honor the
// solution context (version bumps, component ownership checks); DELETE is
// intentionally excluded — it's a different semantic that the resolver does not
// help with.
const WRITE_VERBS_PATTERN = /\b(POST|PATCH|PUT)\b/i;
const PROSE_WRITE_PATTERN = /\b(POST|PATCH|PUT)\s+[^\n]*\/api\/data\//i;
const ADD_COMPONENT_PATTERN = /AddSolutionComponent/;
const WRITE_ENDPOINT_PATTERN =
  /\/api\/data\/v9\.\d\/(environmentvariabledefinitions|publishers|solutions|solutioncomponents|powerpagecomponents)\b/i;
// Catches helper-based calls like `apiPost(..., 'environmentvariabledefinitions', ...)` where
// the URL is built inside the helper. We match the entity name as a string literal.
const JS_WRITE_ENTITY_STRING_PATTERN =
  /['"](environmentvariabledefinitions|publishers|solutions|solutioncomponents|powerpagecomponents)['"]/i;
const JS_WRITE_METHOD_PATTERN = /method\s*:\s*['"](POST|PATCH|PUT)['"]/i;
// Helper function names that imply a Dataverse write.
const JS_HELPER_WRITE_PATTERN =
  /\b(apiPost|apiPatch|apiPut|postRecord|patchRecord|createRecord|updateRecord|addSolutionComponent)\b/;

function touchesDataverseWrites(content) {
  if (ADD_COMPONENT_PATTERN.test(content)) return true;
  if (PROSE_WRITE_PATTERN.test(content)) return true;
  if (WRITE_ENDPOINT_PATTERN.test(content) && JS_WRITE_METHOD_PATTERN.test(content)) return true;
  if (JS_WRITE_ENTITY_STRING_PATTERN.test(content) && JS_HELPER_WRITE_PATTERN.test(content)) return true;
  if (JS_WRITE_ENTITY_STRING_PATTERN.test(content) && JS_WRITE_METHOD_PATTERN.test(content)) return true;
  return false;
}

// Exported for tests so we can assert the verbs we actually intend to gate.
function getGatedWriteVerbs() {
  return ['POST', 'PATCH', 'PUT'];
}

function hasManifestRead(content) {
  return /\.solution-manifest\.json/.test(content);
}

function hasResolverImport(content) {
  return (
    /require\(['"][.\/]*lib\/resolve-target-solution['"]\)/.test(content) ||
    /from\s+['"][.\/]*lib\/resolve-target-solution['"]/.test(content)
  );
}

function extractIgnores(content) {
  const matches = [
    ...content.matchAll(/alm-lint-ignore:\s*([A-Za-z0-9_-]+)/gi),
  ];
  // Normalize captured rule names to the canonical case so downstream
  // `.has(ruleName)` checks line up with the canonical rule strings used
  // elsewhere in the file.
  return new Set(
    matches.map((m) => RULE_CANONICAL.get(m[1].toLowerCase()) || m[1])
  );
}

/**
 * Parses a `.almlintignore` allowlist. Each non-empty, non-comment line has the
 * shape: `<relative-path-or-glob> <rule-name> <reason text ...>`.
 *
 * - Paths are matched against the repo-relative path from pluginRoot, with
 *   forward slashes and lowercase. `*` is a greedy wildcard (no cross-segment
 *   magic); `?` matches a single character. Full globs aren't supported —
 *   keep entries readable.
 * - `rule-name` must be one of the KNOWN_RULES; an unknown name throws so that
 *   typos can't silently disable a rule.
 * - `reason` is required and must be at least 3 characters. Allowlist entries
 *   should always document why they exist.
 */
const KNOWN_RULES = new Set([
  'SKILL-must-read-manifest',
  'SCRIPT-must-use-resolver',
  'DISCOVER-coverage',
]);

// Map lowercased rule name → canonical form. Inline `alm-lint-ignore:` tags
// match case-insensitively (the regex uses `gi`), so the file-based allowlist
// must too — otherwise the same rule name that suppresses inline fails to
// suppress from the file.
const RULE_CANONICAL = new Map([...KNOWN_RULES].map((r) => [r.toLowerCase(), r]));

function parseAllowlist(text, filePath) {
  const entries = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/^\s+|\s+$/g, '');
    if (!line || line.startsWith('#')) continue;
    const first = line.indexOf(' ');
    const second = first >= 0 ? line.indexOf(' ', first + 1) : -1;
    if (first < 0 || second < 0) {
      throw new Error(
        `${filePath}:${i + 1}: allowlist entry must have '<path> <rule> <reason>' (got: "${raw}")`
      );
    }
    const pathPart = line.slice(0, first);
    const rulePart = line.slice(first + 1, second);
    const reasonPart = line.slice(second + 1).trim();
    const canonicalRule = RULE_CANONICAL.get(rulePart.toLowerCase());
    if (!canonicalRule) {
      throw new Error(
        `${filePath}:${i + 1}: unknown rule name "${rulePart}". Known: ${[...KNOWN_RULES].join(', ')}`
      );
    }
    if (reasonPart.length < 3) {
      throw new Error(
        `${filePath}:${i + 1}: allowlist entry needs a reason of at least 3 characters`
      );
    }
    entries.push({
      pathPattern: pathPart,
      rule: canonicalRule,
      reason: reasonPart,
      line: i + 1,
    });
  }
  return entries;
}

function allowlistPathMatches(pattern, relPath) {
  // Normalize both sides to POSIX, lowercase for case-insensitive matching.
  const normPattern = pattern.replace(/\\/g, '/').toLowerCase();
  const normPath = relPath.replace(/\\/g, '/').toLowerCase();
  // Convert simple glob (* and ?) to regex.
  const regexSrc =
    '^' +
    normPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.') +
    '$';
  return new RegExp(regexSrc).test(normPath);
}

function loadAllowlist(pluginRoot) {
  const candidates = [
    path.join(pluginRoot, '.almlintignore'),
    path.join(pluginRoot, 'scripts', '.almlintignore'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return { entries: parseAllowlist(fs.readFileSync(p, 'utf8'), p), source: p };
    }
  }
  return { entries: [], source: null };
}

function findingIsAllowlisted(finding, allowlistEntries, pluginRoot) {
  const rel = path.relative(pluginRoot, finding.file);
  return allowlistEntries.some(
    (e) => e.rule === finding.rule && allowlistPathMatches(e.pathPattern, rel)
  );
}

// Derives referenced powerpagecomponenttype values from the PPC_TYPE_LABELS
// constant exported by scripts/lib/discover-site-components.js. Require the
// sibling module directly rather than regex-parsing its source — formatting
// changes (comments, multi-line entries) would silently shrink the known-set
// with a text-based approach, defeating the non-waivable DISCOVER-coverage rule.
function loadKnownPpcTypes(pluginRoot) {
  const discoveryFile = path.join(pluginRoot, 'scripts', 'lib', 'discover-site-components.js');
  if (!fs.existsSync(discoveryFile)) return null;
  try {
    // Bypass require cache so repeated invocations with different pluginRoots
    // (tests + CLI in the same process) don't reuse a stale module object.
    const resolved = require.resolve(discoveryFile);
    delete require.cache[resolved];
    const mod = require(resolved);
    const labels = mod && mod.PPC_TYPE_LABELS;
    if (!labels || typeof labels !== 'object') return null;
    return new Set(Object.keys(labels).map((k) => Number(k)));
  } catch {
    return null;
  }
}

const PPCTYPE_FILTER_PATTERN = /powerpagecomponenttype\s+eq\s+(\d+)/gi;

function collectFindings({ pluginRoot }) {
  const findings = [];
  const { entries: allowlistEntries } = loadAllowlist(pluginRoot);
  const skillFiles = walkFiles(path.join(pluginRoot, 'skills'), (p) =>
    p.endsWith(`${path.sep}SKILL.md`)
  );

  const scriptFiles = walkFiles(path.join(pluginRoot, 'scripts'), (p) => {
    if (!p.endsWith('.js')) return false;
    const rel = path.relative(pluginRoot, p);
    // Exclude shared lib modules (they implement the rules; they don't consume them),
    // tests, and this lint script itself.
    if (rel.includes(`${path.sep}lib${path.sep}`)) return false;
    if (rel.includes(`${path.sep}tests${path.sep}`)) return false;
    if (path.basename(p) === 'lint-skills-alm.js') return false;
    return true;
  });

  const knownPpcTypes = loadKnownPpcTypes(pluginRoot);

  // Rule 1 — SKILL-must-read-manifest + Rule 3 — DISCOVER-coverage.
  for (const file of skillFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const ignores = extractIgnores(content);

    if (!ignores.has('SKILL-must-read-manifest')) {
      const touches = touchesDataverseWrites(content);
      if (touches && !hasManifestRead(content)) {
        findings.push({
          rule: 'SKILL-must-read-manifest',
          severity: 'error',
          file,
          message:
            'Skill creates Dataverse records but does not reference `.solution-manifest.json`. ' +
            'Either read the manifest during Phase 1 and pass solution identity to component-creation steps, ' +
            'or add an `alm-lint-ignore: SKILL-must-read-manifest` comment with a short justification.',
          hint: 'See AGENTS.md → ALM-aware-by-default → Solution selection resolution order.',
        });
      }
    }

    if (knownPpcTypes && !ignores.has('DISCOVER-coverage')) {
      for (const m of content.matchAll(PPCTYPE_FILTER_PATTERN)) {
        const typeValue = Number(m[1]);
        if (!knownPpcTypes.has(typeValue)) {
          findings.push({
            rule: 'DISCOVER-coverage',
            severity: 'error',
            file,
            message:
              `Skill references powerpagecomponenttype=${typeValue} but that value is not in ` +
              `PPC_TYPE_LABELS in scripts/lib/discover-site-components.js. ` +
              `Add it to the discovery module (picklist source of truth) before using it in a skill.`,
            hint: 'See AGENTS.md → ALM-aware-by-default → New component types.',
          });
        }
      }
    }
  }

  // Rule 2 — SCRIPT-must-use-resolver.
  for (const file of scriptFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const ignores = extractIgnores(content);
    if (ignores.has('SCRIPT-must-use-resolver')) continue;
    if (!touchesDataverseWrites(content)) continue;
    if (hasResolverImport(content)) continue;

    findings.push({
      rule: 'SCRIPT-must-use-resolver',
      severity: 'error',
      file,
      message:
        'Script creates Dataverse records (AddSolutionComponent / publisher / solution / env var definition) ' +
        'but does not import `./lib/resolve-target-solution`. Every such script must delegate solution ' +
        'selection to the shared resolver so the resolution order is honored consistently.',
      hint: 'Example: `const { resolveTargetSolution } = require(\'./lib/resolve-target-solution\');`',
    });
  }

  // Apply the allowlist as a final filter — entries in .almlintignore suppress
  // the matching finding. Inline `alm-lint-ignore:` comments handle single-file
  // exceptions; the allowlist handles broader patterns that shouldn't require
  // touching the source file.
  if (allowlistEntries.length === 0) return findings;
  return findings.filter((f) => !findingIsAllowlisted(f, allowlistEntries, pluginRoot));
}

function formatFinding(finding, pluginRoot) {
  const rel = path.relative(pluginRoot, finding.file);
  return (
    `[${finding.severity.toUpperCase()}] ${rel} — ${finding.rule}\n` +
    `    ${finding.message}\n` +
    (finding.hint ? `    ${finding.hint}\n` : '')
  );
}

function main(argv) {
  let pluginRoot = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--plugin-root' && argv[i + 1]) pluginRoot = argv[++i];
  }
  if (!pluginRoot) {
    // Default: treat the parent of this script's directory as the plugin root.
    pluginRoot = path.resolve(__dirname, '..');
  }

  const findings = collectFindings({ pluginRoot });
  if (findings.length === 0) {
    process.stdout.write('alm-lint: 0 findings\n');
    return 0;
  }
  for (const f of findings) process.stderr.write(formatFinding(f, pluginRoot));
  process.stderr.write(`\nalm-lint: ${findings.length} finding(s) in ${pluginRoot}\n`);
  return 1;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = {
  collectFindings,
  formatFinding,
  getGatedWriteVerbs,
  parseAllowlist,
  allowlistPathMatches,
  KNOWN_RULES,
};
