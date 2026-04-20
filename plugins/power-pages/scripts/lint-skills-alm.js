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

// Heuristics that identify "this file creates Dataverse state" across two very
// different content shapes:
//
// * SKILL.md prose style:  `POST {envUrl}/api/data/v9.2/environmentvariabledefinitions`
// * JavaScript call style:  `makeRequest({ url: '…environmentvariabledefinitions', method: 'POST' })`
//
// The prose regex requires `POST` and a /api/data/ URL on the same line; the JS
// check accepts them in any order across the whole file, as long as both a
// POST/PATCH/PUT method and a known write endpoint appear.
const PROSE_POST_PATTERN = /POST\s+[^\n]*\/api\/data\//i;
const ADD_COMPONENT_PATTERN = /AddSolutionComponent/;
const WRITE_ENDPOINT_PATTERN =
  /\/api\/data\/v9\.\d\/(environmentvariabledefinitions|publishers|solutions|solutioncomponents|powerpagecomponents)\b/i;
// Catches helper-based calls like `apiPost(..., 'environmentvariabledefinitions', ...)` where
// the URL is built inside the helper. We match the entity name as a string literal.
const JS_WRITE_ENTITY_STRING_PATTERN =
  /['"](environmentvariabledefinitions|publishers|solutions|solutioncomponents|powerpagecomponents)['"]/i;
const JS_WRITE_METHOD_PATTERN = /method\s*:\s*['"](POST|PATCH|PUT)['"]/i;
// Helper function names that imply a Dataverse write.
const JS_HELPER_WRITE_PATTERN = /\b(apiPost|apiPatch|apiPut|postRecord|createRecord|addSolutionComponent)\b/;

function touchesDataverseWrites(content) {
  if (ADD_COMPONENT_PATTERN.test(content)) return true;
  if (PROSE_POST_PATTERN.test(content)) return true;
  if (WRITE_ENDPOINT_PATTERN.test(content) && JS_WRITE_METHOD_PATTERN.test(content)) return true;
  if (JS_WRITE_ENTITY_STRING_PATTERN.test(content) && JS_HELPER_WRITE_PATTERN.test(content)) return true;
  if (JS_WRITE_ENTITY_STRING_PATTERN.test(content) && JS_WRITE_METHOD_PATTERN.test(content)) return true;
  return false;
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
  return new Set(matches.map((m) => m[1]));
}

// Derives referenced powerpagecomponenttype values from the PPC_TYPE_LABELS
// constant in scripts/lib/discover-site-components.js.
function loadKnownPpcTypes(pluginRoot) {
  const discoveryFile = path.join(pluginRoot, 'scripts', 'lib', 'discover-site-components.js');
  if (!fs.existsSync(discoveryFile)) return null;
  const src = fs.readFileSync(discoveryFile, 'utf8');
  // Pull every `<int>:` label entry from the PPC_TYPE_LABELS object.
  const match = src.match(/const\s+PPC_TYPE_LABELS\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/);
  if (!match) return null;
  const body = match[1];
  const ids = [...body.matchAll(/^\s*(\d+)\s*:/gm)].map((m) => Number(m[1]));
  return new Set(ids);
}

const PPCTYPE_FILTER_PATTERN = /powerpagecomponenttype\s+eq\s+(\d+)/gi;

function collectFindings({ pluginRoot }) {
  const findings = [];
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

  return findings;
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

module.exports = { collectFindings, formatFinding };
