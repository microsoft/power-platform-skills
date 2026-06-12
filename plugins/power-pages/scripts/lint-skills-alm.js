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
//   GATE-must-have-marker
//     Trigger: a SKILL.md phase section contains an `AskUserQuestion` prompt
//              (matched by `` `AskUserQuestion` `` near a `:`).
//     Require: the same section contains at least one preceding
//              `<!-- gate: ... -->` or `<!-- not-a-gate: ... -->` marker.
//     Scope:   Every SKILL.md under plugins/power-pages/skills/ → severity 'error'.
//              (v2 had a warn-only branch for non-ALM skills; v3 removed it once
//              the catalog in references/approval-gates.md was extended to cover
//              the full skill set — see §10 landing history.)
//     Waivable: yes, inline `<!-- alm-lint-ignore: GATE-must-have-marker -->`
//               or `.almlintignore` entry.
//
//   GATE-id-must-be-unique
//     Trigger: parse all `<!-- gate: ID | ... -->` markers across all
//              SKILL.md files.
//     Require: no `ID` appears twice.
//     Waivable: no — duplicates are always a bug.
//
//   GATE-must-be-in-catalog
//     Trigger: any gate-id used in a SKILL.md marker.
//     Require: the same gate-id appears (backticked) somewhere in
//              references/approval-gates.md (the catalog).
//     Scope:   Every SKILL.md → 'error'. (Same v3 enforcement note as
//              GATE-must-have-marker above.)
//     Waivable: yes (inline + allowlist).
//
//   GATE-intent-must-call-helper
//     Trigger: a marker tagged `category=intent`.
//     Require: the SKILL.md section invokes one of the known helper scripts
//              (INTENT_HELPERS): check-alm-plan.js, verify-alm-prerequisites.js,
//              check-activation-status.js.
//     Waivable: no — `intent` means "helper-script-backed, deterministic
//               state read"; an inline LLM-evaluated entry condition does
//               not qualify.
//
//   GATE-cancel-leaves-known-vocab
//     Trigger: any `<!-- gate: ... | cancel-leaves=VALUE -->` marker.
//     Require: VALUE is in CANCEL_LEAVES_VOCAB or matches the
//              kebab-case slug grammar.
//     Waivable: yes — custom slugs allowed; rule flags only typos /
//               non-kebab values.
//
//   CATALOG-row-must-have-marker
//     Trigger: every `| `<gate-id>` | gate | ...` row in §6 of the catalog
//              (references/approval-gates.md). Only rows tagged `gate` —
//              `not-a-gate` rows are skipped because not-a-gate markers in
//              SKILL.md don't carry an ID to match against.
//     Require: at least one `<!-- gate: <gate-id> ... -->` marker in some
//              SKILL.md under plugins/power-pages/skills/.
//     Waivable: `.almlintignore` allowlist only — this rule operates on the
//               catalog as a whole (not per SKILL.md), so inline
//               `<!-- alm-lint-ignore: ... -->` comments are not honored.
//               To suppress an orphan-row finding, add an allowlist entry like:
//                   references/approval-gates.md CATALOG-row-must-have-marker <reason>
//
//   GATE-prose-block-required
//     Trigger: any `<!-- gate: ID ... -->` marker.
//     Require: within the next 10 lines, a line carrying the 🚦 sentinel
//              appears. Catches the "future PR deletes the prose block"
//              drift case without forcing the v3 3-label structure on 80+
//              legacy v2 single-line markers. The richer structured fields
//              (Trigger / Why we ask / Cancel leaves) are recommended in
//              §4.1 of references/approval-gates.md but not enforced.
//     Waivable: yes — inline ignore comment.
//
// Usage:
//   node scripts/lint-skills-alm.js [--plugin-root <path>]
//   Exit 0 only when there are zero findings. Exit 1 on any finding —
//   v3 is hard-fail uniform, so every finding has severity 'error' and
//   every output goes to stderr.
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
  'GATE-must-have-marker',
  'GATE-id-must-be-unique',
  'GATE-must-be-in-catalog',
  'GATE-intent-must-call-helper',
  'GATE-cancel-leaves-known-vocab',
  'CATALOG-row-must-have-marker',
  'GATE-prose-block-required',
]);

// `category=intent` markers must be backed by a real helper invocation.
// Anything else is LLM-improvised entry logic, which defeats the rule's
// purpose (deterministic state read, not LLM reasoning).
const INTENT_HELPERS = [
  'check-alm-plan.js',
  'verify-alm-prerequisites.js',
  'check-activation-status.js',
];

// Normalized vocabulary for the `cancel-leaves=` marker field. Any value
// outside this set is accepted iff it's a kebab-case slug; non-kebab
// values are flagged so typos surface.
const CANCEL_LEAVES_VOCAB = new Set([
  'nothing',
  'validated-stage-run',
  'partial-manifest',
  'partial-solution',
  'deferral-marker',
  'host-binding',
  'attachment-block-modified',
  'cross-host-stamp-moved',
  'external-state-pending',
]);

const KEBAB_CASE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

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

// ---- Approval Gate parsing helpers ---------------------------------------
//
// SKILL.md format expected by these rules:
//
//   <!-- gate: skill-name:phase-id | category=X | cancel-leaves=Y -->
//   > 🚦 **Gate (X · skill-name:phase-id):** Description.
//
//   <!-- not-a-gate: <reason text> -->
//
// Pairing rule: each `AskUserQuestion` prompt in a phase section must be
// preceded (anywhere earlier in the same section) by at least one
// `<!-- gate: ... -->` or `<!-- not-a-gate: ... -->` marker.

// Phase boundary: any markdown heading at level 2 or 3 (## or ###).
const SECTION_HEADING_PATTERN = /^(#{2,3})\s+(.+?)\s*$/;

// Gate marker — capture id, category, cancel-leaves.
// Gate IDs allow alphanumeric, dash, underscore, colon, and dot (e.g. `setup-solution:5.4c`).
const GATE_MARKER_PATTERN =
  /<!--\s*gate:\s*([A-Za-z0-9][A-Za-z0-9._:-]*)\s*\|\s*category=([a-z]+)\s*\|\s*cancel-leaves=([a-z0-9-]+)\s*-->/gi;

// Not-a-gate marker — capture reason text. Use non-greedy `[\s\S]+?` so the
// reason can contain hyphens / arbitrary characters; the closing `-->`
// anchors the match.
const NOT_A_GATE_PATTERN = /<!--\s*not-a-gate:\s*([\s\S]+?)\s*-->/g;

// Strong-signal AskUserQuestion prompt detection. Requires backticked
// `AskUserQuestion` followed (on the same line, within ~150 chars) by a colon
// — filters out prose mentions like "the AskUserQuestion tool" and table cells.
// Allows backticks inside the matched range so multi-select prompts of the
// form "Use `AskUserQuestion` with `multiSelect: true`:" are still detected.
const PROMPT_LINE_PATTERN = /`AskUserQuestion`[^\n]{0,150}:/;

function splitIntoSections(content) {
  const lines = content.split(/\r?\n/);
  const sections = [];
  let current = { heading: '<file-prologue>', startLine: 1, lines: [] };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(SECTION_HEADING_PATTERN);
    if (m) {
      sections.push(current);
      current = { heading: m[2], startLine: i + 1, lines: [] };
    }
    current.lines.push({ text: line, lineNum: i + 1 });
  }
  sections.push(current);
  return sections;
}

// Extract structured gate markers from a content string.
// Returns: [{ gateId, category, cancelLeaves, lineNum }, ...]
function extractGateMarkers(content) {
  const out = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    GATE_MARKER_PATTERN.lastIndex = 0;
    let m;
    while ((m = GATE_MARKER_PATTERN.exec(lines[i])) !== null) {
      out.push({
        gateId: m[1],
        category: m[2].toLowerCase(),
        cancelLeaves: m[3].toLowerCase(),
        lineNum: i + 1,
      });
    }
  }
  return out;
}

function extractNotAGateMarkers(content) {
  const out = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    NOT_A_GATE_PATTERN.lastIndex = 0;
    let m;
    while ((m = NOT_A_GATE_PATTERN.exec(lines[i])) !== null) {
      out.push({ reason: m[1].trim(), lineNum: i + 1 });
    }
  }
  return out;
}

// Find AskUserQuestion prompts. Returns array of line numbers where a prompt
// is introduced.
function findPromptLines(content) {
  const lines = content.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (PROMPT_LINE_PATTERN.test(lines[i])) out.push(i + 1);
  }
  return out;
}

// v3: hard-fail uniformly across every SKILL.md under plugins/power-pages/skills/.
// Kept as a named constant so every finding-push site references the same
// source of truth; flipping severity for a future rule class would touch a
// single line here rather than rewriting every literal.
const SKILL_SEVERITY = 'error';

// Parse the catalog file (references/approval-gates.md) and extract all
// backticked gate-id strings. Returns a Set, or null if the catalog isn't
// present (downgrades GATE-must-be-in-catalog to no-op so the lint isn't
// hard-broken when the catalog is removed/renamed).
//
// Case-insensitive on the skill-name segment to align with GATE_MARKER_PATTERN
// — SKILL.md gate markers allow any case in the skill-name segment, so the
// catalog scan must too, otherwise a CamelCase skill would fail
// GATE-must-be-in-catalog even with a correct catalog row. Underscores are
// intentionally NOT allowed — current naming convention is kebab-case for
// skill names; allow only [A-Za-z][A-Za-z0-9-]* on that segment.
const CATALOG_GATE_ID_PATTERN = /`([A-Za-z][A-Za-z0-9-]*:[A-Za-z0-9._-]+)`/g;

function loadCatalogGateIds(pluginRoot) {
  const catalogFile = path.join(pluginRoot, 'references', 'approval-gates.md');
  if (!fs.existsSync(catalogFile)) return null;
  const content = fs.readFileSync(catalogFile, 'utf8');
  const ids = new Set();
  CATALOG_GATE_ID_PATTERN.lastIndex = 0;
  let m;
  while ((m = CATALOG_GATE_ID_PATTERN.exec(content)) !== null) {
    ids.add(m[1]);
  }
  return ids;
}

// Catalog row pattern: matches `| `<id>` | gate | ...` rows in §6 tables.
// Only rows tagged `gate` (not `not-a-gate`) need a matching marker — not-a-gate
// markers in SKILL.md don't carry an ID (they're free-text reasons), so the
// reverse check is meaningless for them.
//
// Leading whitespace tolerance: GFM accepts up to 3 spaces of indentation
// before the leading `|`, so we allow `^\s{0,3}\|`. Without this, a future
// markdown reformat that nests §6 tables under a parent list silently
// disables orphan detection for the indented rows.
const CATALOG_GATE_ROW_PATTERN =
  /^\s{0,3}\|\s*`([A-Za-z][A-Za-z0-9-]*:[A-Za-z0-9._-]+)`\s*\|\s*gate\s*\|/gm;

function loadCatalogGateRows(pluginRoot) {
  const catalogFile = path.join(pluginRoot, 'references', 'approval-gates.md');
  if (!fs.existsSync(catalogFile)) return null;
  const content = fs.readFileSync(catalogFile, 'utf8');
  const ids = new Set();
  CATALOG_GATE_ROW_PATTERN.lastIndex = 0;
  let m;
  while ((m = CATALOG_GATE_ROW_PATTERN.exec(content)) !== null) {
    ids.add(m[1]);
  }
  return ids;
}

// Section-level pair: for each prompt, is there a preceding gate or
// not-a-gate marker in the same section?
function checkSectionPairing(content) {
  const sections = splitIntoSections(content);
  const unmatched = [];
  for (const section of sections) {
    const sectionText = section.lines.map((l) => l.text).join('\n');
    const gates = extractGateMarkers(sectionText);
    const notGates = extractNotAGateMarkers(sectionText);
    const markerLines = [...gates.map((g) => g.lineNum), ...notGates.map((n) => n.lineNum)];
    // Lines in section-local numbering — convert to file-relative.
    const sectionStart = section.startLine;
    const fileMarkerLines = markerLines.map((l) => sectionStart - 1 + l);
    const prompts = findPromptLines(sectionText).map(
      (l) => sectionStart - 1 + l
    );
    for (const promptLine of prompts) {
      // Marker must be on a line STRICTLY BEFORE the prompt line.
      // `<=` would let a marker sit on the same line as the prompt (or be
      // smuggled inside the prompt's line via inline HTML), which trivially
      // satisfies the rule without matching its intent.
      const hasPreceding = fileMarkerLines.some((m) => m < promptLine);
      if (!hasPreceding) unmatched.push({ heading: section.heading, lineNum: promptLine });
    }
  }
  return unmatched;
}
// --------------------------------------------------------------------------

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
  const catalogGateIds = loadCatalogGateIds(pluginRoot); // may be null if catalog absent
  const allGateMarkers = []; // [{ file, gateId, category, cancelLeaves, lineNum }]

  // Rule 1 — SKILL-must-read-manifest + Rule 3 — DISCOVER-coverage +
  // Approval Gate rules (per-file portions).
  for (const file of skillFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const ignores = extractIgnores(content);

    if (!ignores.has('SKILL-must-read-manifest')) {
      const touches = touchesDataverseWrites(content);
      if (touches && !hasManifestRead(content)) {
        findings.push({
          rule: 'SKILL-must-read-manifest',
          severity: SKILL_SEVERITY,
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
            severity: SKILL_SEVERITY,
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

    // -- Approval Gate rules ------------------------------------------------
    const gateMarkers = extractGateMarkers(content);
    for (const gm of gateMarkers) allGateMarkers.push({ file, ...gm });

    // GATE-must-have-marker — every prompt in a section needs a preceding marker.
    if (!ignores.has('GATE-must-have-marker')) {
      const unmatched = checkSectionPairing(content);
      for (const u of unmatched) {
        findings.push({
          rule: 'GATE-must-have-marker',
          severity: SKILL_SEVERITY,
          file,
          message:
            `Phase section "${u.heading}" contains an \`AskUserQuestion\` prompt (line ${u.lineNum}) ` +
            `with no preceding \`<!-- gate: ... -->\` or \`<!-- not-a-gate: ... -->\` marker in the same section.`,
          hint: 'See references/approval-gates.md §4 (marker syntax) and §6 (catalog).',
        });
      }
    }

    // GATE-intent-must-call-helper — `category=intent` markers require a known helper invocation.
    if (!ignores.has('GATE-intent-must-call-helper')) {
      const intentMarkers = gateMarkers.filter((g) => g.category === 'intent');
      if (intentMarkers.length > 0) {
        const callsHelper = INTENT_HELPERS.some((h) => content.includes(h));
        if (!callsHelper) {
          findings.push({
            rule: 'GATE-intent-must-call-helper',
            severity: SKILL_SEVERITY,
            file,
            message:
              `Skill declares ${intentMarkers.length} \`category=intent\` gate(s) ` +
              `(${intentMarkers.map((g) => g.gateId).join(', ')}) but does not invoke any ` +
              `known helper script (${INTENT_HELPERS.join(', ')}). ` +
              `\`intent\` gates must be backed by deterministic state from a helper — not by LLM reasoning.`,
            hint: 'See references/approval-gates.md §3.1.',
          });
        }
      }
    }

    // GATE-prose-block-required — every `<!-- gate: -->` must be followed
    // within 10 lines (inclusive of the marker's own line, to support a
    // single-line marker-plus-🚦 style if a future contributor chooses it)
    // by a line carrying the 🚦 sentinel OUTSIDE any fenced code block.
    // This is the minimum viable check against "future PR deletes the
    // human-readable block" drift: it catches deletion + ID-line tampering
    // without forcing a structural rewrite of legacy v2 single-line prose.
    // The richer structured fields (`> **Trigger:**`, `> **Why we ask:**`,
    // `> **Cancel leaves:**`) are recommended in §4.1 of references/approval-
    // gates.md for new markers but not lint-enforced — keeping the rule
    // tight enough that 80+ existing v2 markers don't need to be rewritten
    // in the same PR.
    //
    // Code-fence awareness: a literal 🚦 inside a ```bash``` example or
    // similar should NOT satisfy the rule, otherwise a contributor who
    // deletes the real Gate prose block but leaves an example 🚦 within
    // the window silently passes. We track fence state across the FULL
    // file (not just the window) so the in/out determination is correct
    // when the window opens mid-fence.
    if (!ignores.has('GATE-prose-block-required')) {
      const lines = content.split(/\r?\n/);
      // Pre-compute: for each line, is it inside a fenced code block?
      // A fence-toggle line is one that starts with ``` (optionally followed
      // by an info string). Bare ``` or ```lang both toggle, but only when
      // appearing at column 0 (after trimming up to 3 spaces of indent per
      // CommonMark fenced-code rules — approximated with /^\s{0,3}```/).
      //
      // The fence-delimiter LINE ITSELF (both opening and closing) is marked
      // OUTSIDE — it's Markdown syntax, not code content. Only the content
      // lines strictly between two delimiters are INSIDE. This makes both
      // delimiters classified consistently with each other (a previous
      // version flipped `inside` BEFORE recording, which left the opening
      // fence INSIDE and the closing fence OUTSIDE — asymmetric).
      const inFence = new Array(lines.length).fill(false);
      let inside = false;
      const FENCE_PATTERN = /^\s{0,3}```/;
      for (let i = 0; i < lines.length; i++) {
        if (FENCE_PATTERN.test(lines[i])) {
          inFence[i] = false; // delimiter line itself: not inside
          inside = !inside;
        } else {
          inFence[i] = inside;
        }
      }
      for (const gm of gateMarkers) {
        const startIdx = gm.lineNum - 1; // 0-based
        const endExclusive = Math.min(startIdx + 10, lines.length);
        let hasSentinel = false;
        for (let i = startIdx; i < endExclusive; i++) {
          if (lines[i].includes('🚦') && !inFence[i]) {
            hasSentinel = true;
            break;
          }
        }
        if (!hasSentinel) {
          findings.push({
            rule: 'GATE-prose-block-required',
            severity: SKILL_SEVERITY,
            file,
            message:
              `Gate \`${gm.gateId}\` (line ${gm.lineNum}) is missing the 🚦 ` +
              `prose block within 10 lines (a line carrying the 🚦 sentinel ` +
              `outside any fenced code block). Every gate marker must be ` +
              `followed by a \`> 🚦 **Gate (...)**\` line so humans see ` +
              `the same context the lint sees.`,
            hint: 'See references/approval-gates.md §4.1 for the marker + prose template.',
          });
        }
      }
    }

    // GATE-cancel-leaves-known-vocab — value must be in vocab OR kebab-case.
    if (!ignores.has('GATE-cancel-leaves-known-vocab')) {
      for (const gm of gateMarkers) {
        const v = gm.cancelLeaves;
        if (CANCEL_LEAVES_VOCAB.has(v)) continue;
        if (KEBAB_CASE_PATTERN.test(v)) continue;
        findings.push({
          rule: 'GATE-cancel-leaves-known-vocab',
          severity: SKILL_SEVERITY,
          file,
          message:
            `Gate \`${gm.gateId}\` has \`cancel-leaves=${v}\` which is neither a known vocabulary value ` +
            `(${[...CANCEL_LEAVES_VOCAB].join(', ')}) nor a valid kebab-case slug. ` +
            `Use the canonical vocab or coin a kebab-case slug.`,
          hint: 'See references/approval-gates.md §4.3.',
        });
      }
    }

    // GATE-must-be-in-catalog — every gate-id used here must be in the catalog.
    if (catalogGateIds && !ignores.has('GATE-must-be-in-catalog')) {
      for (const gm of gateMarkers) {
        if (!catalogGateIds.has(gm.gateId)) {
          findings.push({
            rule: 'GATE-must-be-in-catalog',
            severity: SKILL_SEVERITY,
            file,
            message:
              `Gate \`${gm.gateId}\` is declared in SKILL.md but is not in the catalog ` +
              `(references/approval-gates.md). Add a catalog row before introducing the marker, ` +
              `or remove the marker if the prompt is data-gathering (use \`<!-- not-a-gate: ... -->\` instead).`,
            hint: 'See references/approval-gates.md §6 and §7 (How to add a new gate).',
          });
        }
      }
    }
  }

  // GATE-id-must-be-unique — fire after all SKILL.md files are processed.
  const idIndex = new Map(); // gateId → [{ file, lineNum }, ...]
  for (const m of allGateMarkers) {
    if (!idIndex.has(m.gateId)) idIndex.set(m.gateId, []);
    idIndex.get(m.gateId).push({ file: m.file, lineNum: m.lineNum });
  }
  for (const [gateId, occurrences] of idIndex.entries()) {
    if (occurrences.length <= 1) continue;
    const locs = occurrences
      .map((o) => `${path.relative(pluginRoot, o.file)}:${o.lineNum}`)
      .join(', ');
    findings.push({
      rule: 'GATE-id-must-be-unique',
      severity: SKILL_SEVERITY,
      file: occurrences[0].file,
      message:
        `Gate id \`${gateId}\` is declared in ${occurrences.length} places: ${locs}. ` +
        `Gate IDs must be globally unique across the plugin.`,
      hint: 'Re-anchor one of the markers to a different phase id, or merge them into a single gate.',
    });
  }

  // CATALOG-row-must-have-marker — every `kind: gate` catalog row must have at
  // least one matching <!-- gate: ID --> marker in a SKILL.md. This is the
  // reverse of GATE-must-be-in-catalog and prevents the orphan-row class of
  // bug that v3 closed by hand: catalog rows that describe gates with no
  // corresponding SKILL.md anchor accumulate silently otherwise.
  const catalogGateRows = loadCatalogGateRows(pluginRoot);
  if (catalogGateRows) {
    const markerIdSet = new Set(allGateMarkers.map((m) => m.gateId));
    const catalogFile = path.join(pluginRoot, 'references', 'approval-gates.md');
    for (const gateId of catalogGateRows) {
      if (markerIdSet.has(gateId)) continue;
      findings.push({
        rule: 'CATALOG-row-must-have-marker',
        severity: SKILL_SEVERITY,
        file: catalogFile,
        message:
          `Catalog row \`${gateId}\` (kind: gate) has no matching ` +
          `\`<!-- gate: ${gateId} ... -->\` marker in any SKILL.md. Either add ` +
          `the marker to the owning skill, or remove/retag the catalog row.`,
        hint: 'See references/approval-gates.md §7 (How to add a new gate) and §10 (catalog completeness).',
      });
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
      severity: SKILL_SEVERITY,
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

  // v3: every finding is `severity: 'error'`. The warn-only branch existed
  // pre-v3 for non-ALM skills; once the catalog covered every skill the
  // branch became unreachable. Any future re-introduction of a 'warning'
  // severity should restore the stdout-vs-stderr split here.
  //
  // Single concatenation + one write call avoids the Node-on-Windows
  // truncation case where many small synchronous writes to a piped stderr
  // (CI redirecting to a log file) can drop trailing data when process.exit
  // fires before the OS has drained the pipe.
  const out =
    findings.map((f) => formatFinding(f, pluginRoot)).join('') +
    `\nalm-lint: ${findings.length} error(s) in ${pluginRoot}\n`;
  process.stderr.write(out);
  return 1;
}

if (require.main === module) {
  // Use exitCode instead of process.exit so the event loop drains stderr
  // before the process terminates — important for CI runs that pipe stderr
  // to a log file.
  process.exitCode = main(process.argv);
}

module.exports = {
  collectFindings,
  formatFinding,
  getGatedWriteVerbs,
  parseAllowlist,
  allowlistPathMatches,
  KNOWN_RULES,
  INTENT_HELPERS,
  CANCEL_LEAVES_VOCAB,
  // Approval Gate parsing helpers (exported for tests):
  extractGateMarkers,
  extractNotAGateMarkers,
  findPromptLines,
  splitIntoSections,
  loadCatalogGateIds,
};
