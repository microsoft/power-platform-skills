'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  collectFindings,
  getGatedWriteVerbs,
  parseAllowlist,
  allowlistPathMatches,
  KNOWN_RULES,
  CANCEL_LEAVES_VOCAB,
  extractGateMarkers,
  extractNotAGateMarkers,
  findPromptLines,
  splitIntoSections,
} = require('../lint-skills-alm');

function mkPluginRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alm-lint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'tests'), { recursive: true });
  // A minimal discovery module that exposes PPC_TYPE_LABELS — the lint script
  // reads this file to know which ppc types are "known".
  fs.writeFileSync(
    path.join(root, 'scripts', 'lib', 'discover-site-components.js'),
    `'use strict';
const PPC_TYPE_LABELS = Object.freeze({
  2: 'Web Page',
  3: 'Web File',
  35: 'Server Logic',
});
module.exports = { PPC_TYPE_LABELS };
`
  );
  return root;
}

function writeSkill(root, skillName, content) {
  const dir = path.join(root, 'skills', skillName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, content);
  return file;
}

function writeScript(root, scriptPath, content) {
  const file = path.join(root, 'scripts', scriptPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

test('clean plugin returns zero findings', async (t) => {
  const root = mkPluginRoot(t);
  writeSkill(root, 'clean-skill', '# Clean skill\n\nNo Dataverse writes here.\n');
  writeScript(root, 'util.js', '// just a utility, no Dataverse\nmodule.exports = {};\n');

  const findings = collectFindings({ pluginRoot: root });
  assert.equal(findings.length, 0);
});

test('flags a SKILL.md that POSTs to Dataverse but never reads the manifest', async (t) => {
  const root = mkPluginRoot(t);
  const file = writeSkill(
    root,
    'bad-skill',
    `# Bad skill

Create a row:

\`\`\`
POST {envUrl}/api/data/v9.2/environmentvariabledefinitions
{ "schemaname": "foo" }
\`\`\`
`
  );

  const findings = collectFindings({ pluginRoot: root });
  const match = findings.find((f) => f.rule === 'SKILL-must-read-manifest' && f.file === file);
  assert.ok(match, `expected finding for ${file}; got ${JSON.stringify(findings)}`);
  assert.match(match.message, /\.solution-manifest\.json/);
});

test('passes when SKILL.md both POSTs and reads the manifest', async (t) => {
  const root = mkPluginRoot(t);
  writeSkill(
    root,
    'good-skill',
    `# Good skill

Phase 1 reads \`.solution-manifest.json\`.

\`\`\`
POST {envUrl}/api/data/v9.2/environmentvariabledefinitions
\`\`\`
`
  );

  const findings = collectFindings({ pluginRoot: root });
  assert.equal(
    findings.filter((f) => f.rule === 'SKILL-must-read-manifest').length,
    0
  );
});

test('respects alm-lint-ignore comment on SKILL.md', async (t) => {
  const root = mkPluginRoot(t);
  writeSkill(
    root,
    'ignored-skill',
    `# Ignored skill

<!-- alm-lint-ignore: SKILL-must-read-manifest — purely a read-only diagnostic skill -->

\`\`\`
POST {envUrl}/api/data/v9.2/solutioncomponents
\`\`\`
`
  );
  const findings = collectFindings({ pluginRoot: root });
  assert.equal(
    findings.filter((f) => f.rule === 'SKILL-must-read-manifest').length,
    0
  );
});

test('flags a script that creates records without importing the resolver', async (t) => {
  const root = mkPluginRoot(t);
  const file = writeScript(
    root,
    'create-thing.js',
    `// Creates an env var definition directly.
const { makeRequest } = require('./lib/validation-helpers');
async function run() {
  await makeRequest({
    url: envUrl + '/api/data/v9.2/environmentvariabledefinitions',
    method: 'POST',
    body: JSON.stringify({ schemaname: 'x' }),
  });
}
`
  );
  const findings = collectFindings({ pluginRoot: root });
  const match = findings.find((f) => f.rule === 'SCRIPT-must-use-resolver' && f.file === file);
  assert.ok(match, `expected SCRIPT-must-use-resolver finding; got ${JSON.stringify(findings)}`);
});

test('passes when script imports the resolver', async (t) => {
  const root = mkPluginRoot(t);
  writeScript(
    root,
    'create-thing.js',
    `const { resolveTargetSolution } = require('./lib/resolve-target-solution');
const { makeRequest } = require('./lib/validation-helpers');
async function run() {
  await makeRequest({ url: 'x/api/data/v9.2/environmentvariabledefinitions', method: 'POST' });
}
`
  );
  const findings = collectFindings({ pluginRoot: root });
  assert.equal(
    findings.filter((f) => f.rule === 'SCRIPT-must-use-resolver').length,
    0
  );
});

test('does not scan scripts/lib or scripts/tests directories', async (t) => {
  const root = mkPluginRoot(t);
  writeScript(
    root,
    'lib/some-helper.js',
    `// Internal helper that happens to POST — should NOT be linted.
await makeRequest({ url: 'x/api/data/v9.2/solutioncomponents', method: 'POST' });
`
  );
  writeScript(
    root,
    'tests/some-helper.test.js',
    `await makeRequest({ url: 'x/api/data/v9.2/environmentvariabledefinitions', method: 'POST' });`
  );
  const findings = collectFindings({ pluginRoot: root });
  assert.equal(findings.length, 0);
});

test('flags unknown powerpagecomponenttype referenced in a SKILL.md', async (t) => {
  const root = mkPluginRoot(t);
  const file = writeSkill(
    root,
    'type-user',
    `# Uses a custom type

Read .solution-manifest.json somewhere.

Query:
\`\`\`
GET {envUrl}/api/data/v9.2/powerpagecomponents?$filter=powerpagecomponenttype eq 99
\`\`\`
`
  );
  const findings = collectFindings({ pluginRoot: root });
  const match = findings.find((f) => f.rule === 'DISCOVER-coverage' && f.file === file);
  assert.ok(match, 'expected DISCOVER-coverage finding for type 99');
  assert.match(match.message, /powerpagecomponenttype=99/);
});

test('does not flag known powerpagecomponenttype values', async (t) => {
  const root = mkPluginRoot(t);
  writeSkill(
    root,
    'type-user',
    `# Uses known types

Read .solution-manifest.json somewhere.

\`\`\`
GET {envUrl}/api/data/v9.2/powerpagecomponents?$filter=powerpagecomponenttype eq 2
GET {envUrl}/api/data/v9.2/powerpagecomponents?$filter=powerpagecomponenttype eq 35
\`\`\`
`
  );
  const findings = collectFindings({ pluginRoot: root });
  assert.equal(
    findings.filter((f) => f.rule === 'DISCOVER-coverage').length,
    0
  );
});

test('multiple findings in one file each get their own entry', async (t) => {
  const root = mkPluginRoot(t);
  writeSkill(
    root,
    'multi-offender',
    `# Multi

\`\`\`
POST {envUrl}/api/data/v9.2/environmentvariabledefinitions
GET {envUrl}/api/data/v9.2/powerpagecomponents?$filter=powerpagecomponenttype eq 42
GET {envUrl}/api/data/v9.2/powerpagecomponents?$filter=powerpagecomponenttype eq 99
\`\`\`
`
  );
  const findings = collectFindings({ pluginRoot: root });
  assert.equal(findings.filter((f) => f.rule === 'SKILL-must-read-manifest').length, 1);
  assert.equal(findings.filter((f) => f.rule === 'DISCOVER-coverage').length, 2);
});

test('getGatedWriteVerbs covers POST, PATCH, PUT (but not DELETE)', () => {
  const verbs = getGatedWriteVerbs();
  assert.deepEqual(verbs.sort(), ['PATCH', 'POST', 'PUT']);
  assert.ok(!verbs.includes('DELETE'), 'DELETE semantics differ — resolver does not apply');
});

test('flags a SKILL.md that PATCHes Dataverse but never reads the manifest', async (t) => {
  const root = mkPluginRoot(t);
  const file = writeSkill(
    root,
    'patch-skill',
    `# Patch skill

Bump version on the current solution:

\`\`\`
PATCH {envUrl}/api/data/v9.2/solutions(solutionId)
{ "version": "1.0.0.1" }
\`\`\`
`
  );
  const findings = collectFindings({ pluginRoot: root });
  const match = findings.find((f) => f.rule === 'SKILL-must-read-manifest' && f.file === file);
  assert.ok(match, `expected SKILL-must-read-manifest finding for PATCH; got ${JSON.stringify(findings)}`);
});

test('flags a SKILL.md that PUTs Dataverse but never reads the manifest', async (t) => {
  const root = mkPluginRoot(t);
  const file = writeSkill(
    root,
    'put-skill',
    `# Put skill

\`\`\`
PUT {envUrl}/api/data/v9.2/publishers(id)
\`\`\`
`
  );
  const findings = collectFindings({ pluginRoot: root });
  const match = findings.find((f) => f.rule === 'SKILL-must-read-manifest' && f.file === file);
  assert.ok(match, `expected SKILL-must-read-manifest finding for PUT; got ${JSON.stringify(findings)}`);
});

test('does NOT flag DELETE verbs — resolver does not apply to deletions', async (t) => {
  const root = mkPluginRoot(t);
  writeSkill(
    root,
    'delete-skill',
    `# Delete skill

Removes a solution from an env:

\`\`\`
DELETE {envUrl}/api/data/v9.2/solutions(solutionId)
\`\`\`
`
  );
  const findings = collectFindings({ pluginRoot: root });
  assert.equal(
    findings.filter((f) => f.rule === 'SKILL-must-read-manifest').length,
    0,
    'DELETE-only content should not trip the resolver rule'
  );
});

test('flags a script that uses apiPatch on a write entity without the resolver', async (t) => {
  const root = mkPluginRoot(t);
  const file = writeScript(
    root,
    'bump-solution-version.js',
    `const { apiPatch } = require('./lib/validation-helpers');
async function run() {
  await apiPatch('solutions', { version: '1.0.0.1' });
}
`
  );
  const findings = collectFindings({ pluginRoot: root });
  const match = findings.find((f) => f.rule === 'SCRIPT-must-use-resolver' && f.file === file);
  assert.ok(match, `expected finding for apiPatch; got ${JSON.stringify(findings)}`);
});

//
// Allowlist (`.almlintignore`) tests
//

test('parseAllowlist — parses a valid entry with a reason', () => {
  const text = `# comment
skills/legacy-skill/SKILL.md SKILL-must-read-manifest Purely a diagnostic read-only skill
`;
  const entries = parseAllowlist(text, 'fake.txt');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].pathPattern, 'skills/legacy-skill/SKILL.md');
  assert.equal(entries[0].rule, 'SKILL-must-read-manifest');
  assert.equal(entries[0].reason, 'Purely a diagnostic read-only skill');
});

test('parseAllowlist — skips comments and blank lines', () => {
  const text = `
# this is a comment
   # indented comment

skills/a/SKILL.md SKILL-must-read-manifest Reason one

# trailing comment
scripts/b.js SCRIPT-must-use-resolver Reason two here
`;
  const entries = parseAllowlist(text, 'fake.txt');
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => e.rule),
    ['SKILL-must-read-manifest', 'SCRIPT-must-use-resolver']
  );
});

test('parseAllowlist — rejects unknown rule names', () => {
  const text = 'skills/x/SKILL.md BOGUS-RULE has some reason text\n';
  assert.throws(() => parseAllowlist(text, 'fake.txt'), /unknown rule name "BOGUS-RULE"/);
});

test('parseAllowlist — rejects entries missing a reason', () => {
  const text = 'skills/x/SKILL.md SKILL-must-read-manifest\n';
  assert.throws(
    () => parseAllowlist(text, 'fake.txt'),
    /must have '<path> <rule> <reason>'/
  );
});

test('parseAllowlist — rejects short reasons (< 3 chars)', () => {
  const text = 'skills/x/SKILL.md SKILL-must-read-manifest hi\n';
  assert.throws(
    () => parseAllowlist(text, 'fake.txt'),
    /needs a reason of at least 3 characters/
  );
});

test('KNOWN_RULES covers every rule collectFindings can emit', () => {
  // Guard against adding a new rule but forgetting to register it in
  // KNOWN_RULES — an unregistered rule can't be waived via allowlist.
  const expected = ['SKILL-must-read-manifest', 'SCRIPT-must-use-resolver', 'DISCOVER-coverage'];
  for (const rule of expected) assert.ok(KNOWN_RULES.has(rule), `missing known rule: ${rule}`);
});

test('allowlistPathMatches — exact paths match case-insensitively', () => {
  assert.ok(allowlistPathMatches('skills/A/SKILL.md', 'skills/a/SKILL.md'));
  assert.ok(allowlistPathMatches('skills/a/SKILL.md', 'skills\\a\\SKILL.md'));
  assert.ok(!allowlistPathMatches('skills/a/SKILL.md', 'skills/b/SKILL.md'));
});

test('allowlistPathMatches — * wildcard matches any run of characters', () => {
  assert.ok(allowlistPathMatches('skills/*/SKILL.md', 'skills/my-skill/SKILL.md'));
  assert.ok(allowlistPathMatches('scripts/*.js', 'scripts/create-anything.js'));
  assert.ok(!allowlistPathMatches('scripts/*.js', 'scripts/lib/helper.js') === false); // negative-aware
});

test('collectFindings — allowlist entry suppresses a matching finding', async (t) => {
  const root = mkPluginRoot(t);
  writeSkill(
    root,
    'diagnostic-read-only',
    `# Diagnostic

\`\`\`
POST {envUrl}/api/data/v9.2/environmentvariabledefinitions
\`\`\`
`
  );
  // Without allowlist: one finding.
  const before = collectFindings({ pluginRoot: root });
  assert.equal(
    before.filter((f) => f.rule === 'SKILL-must-read-manifest').length,
    1
  );
  // Write allowlist at plugin root and re-run.
  fs.writeFileSync(
    path.join(root, '.almlintignore'),
    `# Diagnostic skill never writes for real — prose illustrates API surface only.
skills/diagnostic-read-only/SKILL.md SKILL-must-read-manifest Diagnostic-only skill; prose shows the endpoint but no actual POST executes at runtime.
`
  );
  const after = collectFindings({ pluginRoot: root });
  assert.equal(
    after.filter((f) => f.rule === 'SKILL-must-read-manifest').length,
    0
  );
});

test('collectFindings — allowlist glob suppresses matching findings across a directory', async (t) => {
  const root = mkPluginRoot(t);
  writeSkill(
    root,
    'readonly-a',
    `# A\n\`\`\`\nPOST {envUrl}/api/data/v9.2/environmentvariabledefinitions\n\`\`\`\n`
  );
  writeSkill(
    root,
    'readonly-b',
    `# B\n\`\`\`\nPOST {envUrl}/api/data/v9.2/environmentvariabledefinitions\n\`\`\`\n`
  );
  fs.writeFileSync(
    path.join(root, '.almlintignore'),
    `skills/readonly-*/SKILL.md SKILL-must-read-manifest Read-only diagnostic skills by convention
`
  );
  const findings = collectFindings({ pluginRoot: root });
  assert.equal(findings.length, 0);
});

test('collectFindings — allowlist rule mismatch does not suppress', async (t) => {
  const root = mkPluginRoot(t);
  writeSkill(
    root,
    'multi-offender',
    `# Multi\n\`\`\`\nPOST {envUrl}/api/data/v9.2/environmentvariabledefinitions\nGET {envUrl}/api/data/v9.2/powerpagecomponents?$filter=powerpagecomponenttype eq 99\n\`\`\`\n`
  );
  // Allowlist waives SKILL-must-read-manifest but NOT DISCOVER-coverage.
  fs.writeFileSync(
    path.join(root, '.almlintignore'),
    `skills/multi-offender/SKILL.md SKILL-must-read-manifest Diagnostic-only reads-no-writes
`
  );
  const findings = collectFindings({ pluginRoot: root });
  assert.equal(findings.filter((f) => f.rule === 'SKILL-must-read-manifest').length, 0);
  assert.equal(
    findings.filter((f) => f.rule === 'DISCOVER-coverage').length,
    1,
    'DISCOVER-coverage is a separate rule — should still fire'
  );
});

// ============================================================================
// Approval Gate rule tests
// ============================================================================

function writeCatalog(root, gateIds) {
  fs.mkdirSync(path.join(root, 'references'), { recursive: true });
  const content =
    '# Approval Gates Catalog (test fixture)\n\n' +
    gateIds.map((id) => `- \`${id}\``).join('\n') +
    '\n';
  fs.writeFileSync(path.join(root, 'references', 'approval-gates.md'), content);
}

test('extractGateMarkers: parses well-formed marker comments', () => {
  const content = [
    '## Phase 1',
    '<!-- gate: plan-alm:1.deferral | category=progress | cancel-leaves=deferral-marker -->',
    '> 🚦 **Gate (progress · plan-alm:1.deferral):** Description.',
    '',
    '`AskUserQuestion`:',
    '',
    '## Phase 2',
    '<!-- gate: plan-alm:2.q1 | category=plan | cancel-leaves=nothing -->',
  ].join('\n');
  const markers = extractGateMarkers(content);
  assert.equal(markers.length, 2);
  assert.equal(markers[0].gateId, 'plan-alm:1.deferral');
  assert.equal(markers[0].category, 'progress');
  assert.equal(markers[0].cancelLeaves, 'deferral-marker');
  assert.equal(markers[1].gateId, 'plan-alm:2.q1');
});

test('extractNotAGateMarkers: accepts hyphens in reason text', () => {
  const content = `<!-- not-a-gate: data-gathering — free-text fallback when auto-detection fails -->`;
  const markers = extractNotAGateMarkers(content);
  assert.equal(markers.length, 1);
  assert.match(markers[0].reason, /data-gathering/);
});

test('findPromptLines: matches backticked AskUserQuestion followed by colon', () => {
  const content = [
    'allowed-tools: AskUserQuestion',                    // not a prompt
    'Ask via `AskUserQuestion`:',                        // prompt
    'Use `AskUserQuestion` with `multiSelect: true`:',   // prompt (multiSelect on same line)
    'Use `AskUserQuestion` for the prompt — no colon',   // not a prompt
    'See `AskUserQuestion` docs for details.',           // not a prompt
  ].join('\n');
  const lines = findPromptLines(content);
  assert.deepEqual(lines, [2, 3]);
});

test('splitIntoSections: treats ## and ### as section boundaries; not ####', () => {
  const content = [
    'preamble',
    '## Phase 1',
    'a',
    '### Sub 1.1',
    'b',
    '#### Step 1.1.1',
    'c',
    '## Phase 2',
    'd',
  ].join('\n');
  const sections = splitIntoSections(content);
  // file-prologue + Phase 1 + Sub 1.1 + Phase 2 (#### does NOT open a new section)
  const headings = sections.map((s) => s.heading);
  assert.deepEqual(headings, ['<file-prologue>', 'Phase 1', 'Sub 1.1', 'Phase 2']);
});

test('GATE-must-have-marker: fires on unmarked AskUserQuestion in ALM skill (error severity)', async (t) => {
  const root = mkPluginRoot(t);
  writeSkill(
    root,
    'plan-alm',
    `# plan-alm
## Phase 1
Ask via \`AskUserQuestion\`:
`
  );
  const findings = collectFindings({ pluginRoot: root });
  const match = findings.find((f) => f.rule === 'GATE-must-have-marker');
  assert.ok(match, 'expected GATE-must-have-marker to fire');
  assert.equal(match.severity, 'error', 'ALM skill → error severity');
});

test('GATE-must-have-marker: fires as error for non-ALM skill (v3 plugin-wide enforcement)', async (t) => {
  // v3 removed the ALM-vs-non-ALM severity carve-out: every skill is hard-fail.
  // See references/approval-gates.md §10 landing history.
  const root = mkPluginRoot(t);
  writeSkill(
    root,
    'add-cloud-flow',
    `# add-cloud-flow
## Phase 1
Ask via \`AskUserQuestion\`:
`
  );
  const findings = collectFindings({ pluginRoot: root });
  const match = findings.find((f) => f.rule === 'GATE-must-have-marker');
  assert.ok(match);
  assert.equal(match.severity, 'error', 'v3: all skills → error severity');
});

test('GATE-must-have-marker: passes when section has a gate marker before the prompt', async (t) => {
  const root = mkPluginRoot(t);
  writeSkill(
    root,
    'plan-alm',
    `# plan-alm
## Phase 1
<!-- gate: plan-alm:1.foo | category=plan | cancel-leaves=nothing -->
Some prose.
Ask via \`AskUserQuestion\`:
`
  );
  writeCatalog(root, ['plan-alm:1.foo']);
  const findings = collectFindings({ pluginRoot: root });
  assert.equal(findings.filter((f) => f.rule === 'GATE-must-have-marker').length, 0);
});

test('GATE-must-have-marker: passes when section has a not-a-gate marker', async (t) => {
  const root = mkPluginRoot(t);
  writeSkill(
    root,
    'plan-alm',
    `# plan-alm
## Phase 1
<!-- not-a-gate: free-text fallback — data-gathering only -->
Ask via \`AskUserQuestion\`:
`
  );
  const findings = collectFindings({ pluginRoot: root });
  assert.equal(findings.filter((f) => f.rule === 'GATE-must-have-marker').length, 0);
});

test('GATE-must-have-marker: fails when marker is on the SAME line as the prompt (strict precede)', async (t) => {
  // v3 tightened m <= promptLine to m < promptLine. A single-line shape like
  // `<!-- gate: ... --> Use \`AskUserQuestion\` for X:` matches both regexes
  // at the same line number; under the old <= rule this passed trivially.
  // The new < rule requires the marker to be on a line STRICTLY BEFORE the
  // prompt.
  const root = mkPluginRoot(t);
  writeSkill(
    root,
    'plan-alm',
    `# plan-alm
## Phase 1
<!-- gate: plan-alm:1.foo | category=plan | cancel-leaves=nothing --> Use \`AskUserQuestion\` for X:
`
  );
  writeCatalog(root, ['plan-alm:1.foo']);
  const findings = collectFindings({ pluginRoot: root });
  const match = findings.find((f) => f.rule === 'GATE-must-have-marker');
  assert.ok(match, 'expected GATE-must-have-marker to fire — marker on prompt line should not satisfy pairing');
});

test('GATE-must-have-marker: pairing is per-section (marker in earlier section does NOT cover later section)', async (t) => {
  const root = mkPluginRoot(t);
  writeSkill(
    root,
    'plan-alm',
    `# plan-alm
## Phase 1
<!-- gate: plan-alm:1.foo | category=plan | cancel-leaves=nothing -->
## Phase 2
Ask via \`AskUserQuestion\`:
`
  );
  writeCatalog(root, ['plan-alm:1.foo']);
  const findings = collectFindings({ pluginRoot: root });
  assert.equal(findings.filter((f) => f.rule === 'GATE-must-have-marker').length, 1);
});

test('GATE-id-must-be-unique: fires when same gate-id appears in two SKILL.md files', async (t) => {
  const root = mkPluginRoot(t);
  writeSkill(
    root,
    'plan-alm',
    `# plan-alm
## Phase 1
<!-- gate: shared-id:1 | category=plan | cancel-leaves=nothing -->
Ask via \`AskUserQuestion\`:
`
  );
  writeSkill(
    root,
    'setup-solution',
    `# setup-solution
## Phase 1
<!-- gate: shared-id:1 | category=plan | cancel-leaves=nothing -->
Ask via \`AskUserQuestion\`:
`
  );
  writeCatalog(root, ['shared-id:1']);
  const findings = collectFindings({ pluginRoot: root });
  const match = findings.find((f) => f.rule === 'GATE-id-must-be-unique');
  assert.ok(match, 'expected GATE-id-must-be-unique to fire');
  assert.match(match.message, /shared-id:1/);
});

test('GATE-must-be-in-catalog: fires when gate-id is missing from catalog', async (t) => {
  const root = mkPluginRoot(t);
  writeSkill(
    root,
    'plan-alm',
    `# plan-alm
## Phase 1
<!-- gate: plan-alm:1.unknown | category=plan | cancel-leaves=nothing -->
Ask via \`AskUserQuestion\`:
`
  );
  writeCatalog(root, ['plan-alm:1.known']); // doesn't include `:1.unknown`
  const findings = collectFindings({ pluginRoot: root });
  const match = findings.find((f) => f.rule === 'GATE-must-be-in-catalog');
  assert.ok(match, 'expected GATE-must-be-in-catalog to fire');
});

test('GATE-must-be-in-catalog: skipped when catalog file is absent (graceful degradation)', async (t) => {
  const root = mkPluginRoot(t);
  writeSkill(
    root,
    'plan-alm',
    `# plan-alm
## Phase 1
<!-- gate: plan-alm:1.foo | category=plan | cancel-leaves=nothing -->
Ask via \`AskUserQuestion\`:
`
  );
  // No catalog written
  const findings = collectFindings({ pluginRoot: root });
  assert.equal(findings.filter((f) => f.rule === 'GATE-must-be-in-catalog').length, 0);
});

test('GATE-intent-must-call-helper: fires when intent marker has no helper invocation', async (t) => {
  const root = mkPluginRoot(t);
  writeSkill(
    root,
    'plan-alm',
    `# plan-alm
## Phase 0
<!-- gate: plan-alm:0.entry | category=intent | cancel-leaves=nothing -->
Ask via \`AskUserQuestion\`:
`
  );
  writeCatalog(root, ['plan-alm:0.entry']);
  const findings = collectFindings({ pluginRoot: root });
  const match = findings.find((f) => f.rule === 'GATE-intent-must-call-helper');
  assert.ok(match, 'expected GATE-intent-must-call-helper to fire');
});

test('GATE-intent-must-call-helper: passes when SKILL.md mentions one of the known helpers', async (t) => {
  const root = mkPluginRoot(t);
  writeSkill(
    root,
    'setup-solution',
    `# setup-solution
## Phase 0
Run \`check-alm-plan.js --projectRoot "."\` first.
<!-- gate: setup-solution:0.entry | category=intent | cancel-leaves=nothing -->
Ask via \`AskUserQuestion\`:
`
  );
  writeCatalog(root, ['setup-solution:0.entry']);
  const findings = collectFindings({ pluginRoot: root });
  assert.equal(findings.filter((f) => f.rule === 'GATE-intent-must-call-helper').length, 0);
});

test('GATE-cancel-leaves-known-vocab: passes for known vocabulary values', async (t) => {
  const root = mkPluginRoot(t);
  writeSkill(
    root,
    'plan-alm',
    `# plan-alm
## Phase 1
<!-- gate: plan-alm:1.a | category=plan | cancel-leaves=nothing -->
<!-- gate: plan-alm:1.b | category=consent | cancel-leaves=validated-stage-run -->
<!-- gate: plan-alm:1.c | category=consent | cancel-leaves=partial-manifest -->
Ask via \`AskUserQuestion\`:
`
  );
  writeCatalog(root, ['plan-alm:1.a', 'plan-alm:1.b', 'plan-alm:1.c']);
  const findings = collectFindings({ pluginRoot: root });
  assert.equal(findings.filter((f) => f.rule === 'GATE-cancel-leaves-known-vocab').length, 0);
});

test('GATE-cancel-leaves-known-vocab: passes for valid kebab-case custom slugs', async (t) => {
  const root = mkPluginRoot(t);
  writeSkill(
    root,
    'plan-alm',
    `# plan-alm
## Phase 1
<!-- gate: plan-alm:1.x | category=plan | cancel-leaves=my-custom-state -->
Ask via \`AskUserQuestion\`:
`
  );
  writeCatalog(root, ['plan-alm:1.x']);
  const findings = collectFindings({ pluginRoot: root });
  assert.equal(findings.filter((f) => f.rule === 'GATE-cancel-leaves-known-vocab').length, 0);
});

test('CANCEL_LEAVES_VOCAB export has the documented values', () => {
  const required = ['nothing', 'validated-stage-run', 'partial-manifest', 'attachment-block-modified'];
  for (const v of required) {
    assert.ok(CANCEL_LEAVES_VOCAB.has(v), `CANCEL_LEAVES_VOCAB missing: ${v}`);
  }
});

// Helper for the new CATALOG-row-must-have-marker tests — writes a §6-style
// markdown table that matches CATALOG_GATE_ROW_PATTERN. Each entry: { id, kind }
// where kind is 'gate' or 'not-a-gate'.
function writeCatalogTable(root, rows) {
  fs.mkdirSync(path.join(root, 'references'), { recursive: true });
  const header =
    '# Approval Gates Catalog (test fixture)\n\n' +
    '## 6. Catalog\n\n' +
    '### 6.1 fixture\n\n' +
    '| ID | Kind | Category | Phase | Trigger | Cancel leaves |\n' +
    '|---|---|---|---|---|---|\n';
  const body = rows
    .map((r) => `| \`${r.id}\` | ${r.kind} | plan | 1 | test | nothing |`)
    .join('\n');
  fs.writeFileSync(path.join(root, 'references', 'approval-gates.md'), header + body + '\n');
}

test('CATALOG-row-must-have-marker: fires when a catalog gate row has no SKILL.md marker', async (t) => {
  const root = mkPluginRoot(t);
  // Catalog has two gate rows, but only one SKILL.md marker exists.
  writeCatalogTable(root, [
    { id: 'plan-alm:1.foo', kind: 'gate' },
    { id: 'plan-alm:1.orphan', kind: 'gate' },
  ]);
  writeSkill(
    root,
    'plan-alm',
    `# plan-alm
## Phase 1
<!-- gate: plan-alm:1.foo | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · plan-alm:1.foo):** Description.
Ask via \`AskUserQuestion\`:
`
  );
  const findings = collectFindings({ pluginRoot: root });
  const orphans = findings.filter((f) => f.rule === 'CATALOG-row-must-have-marker');
  assert.equal(orphans.length, 1, `expected 1 orphan finding, got ${JSON.stringify(orphans)}`);
  assert.match(orphans[0].message, /plan-alm:1\.orphan/);
});

test('CATALOG-row-must-have-marker: passes when every gate row has a marker', async (t) => {
  const root = mkPluginRoot(t);
  writeCatalogTable(root, [
    { id: 'plan-alm:1.foo', kind: 'gate' },
    { id: 'plan-alm:1.bar', kind: 'gate' },
  ]);
  writeSkill(
    root,
    'plan-alm',
    `# plan-alm
## Phase 1
<!-- gate: plan-alm:1.foo | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · plan-alm:1.foo):** Description.
Ask via \`AskUserQuestion\`:

## Phase 2
<!-- gate: plan-alm:1.bar | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · plan-alm:1.bar):** Description.
Ask via \`AskUserQuestion\`:
`
  );
  const findings = collectFindings({ pluginRoot: root });
  assert.equal(findings.filter((f) => f.rule === 'CATALOG-row-must-have-marker').length, 0);
});

test('CATALOG-row-must-have-marker: skips not-a-gate rows (no marker required)', async (t) => {
  // Only `kind: gate` rows are checked. A `not-a-gate` row in the catalog has
  // no corresponding ID-bearing marker (not-a-gate comments are free-text), so
  // the reverse check must skip them.
  const root = mkPluginRoot(t);
  writeCatalogTable(root, [
    { id: 'plan-alm:1.foo', kind: 'not-a-gate' },
    { id: 'plan-alm:1.bar', kind: 'not-a-gate' },
  ]);
  writeSkill(root, 'plan-alm', '# plan-alm\n\nNo gates here.\n');
  const findings = collectFindings({ pluginRoot: root });
  assert.equal(findings.filter((f) => f.rule === 'CATALOG-row-must-have-marker').length, 0);
});

test('CATALOG-row-must-have-marker: tolerates leading whitespace on table rows (GFM)', async (t) => {
  // GFM allows up to 3 leading spaces before the leading `|`. The reverse-
  // check regex must match those rows; otherwise nested catalog rows go
  // invisible to orphan detection.
  const root = mkPluginRoot(t);
  fs.mkdirSync(path.join(root, 'references'), { recursive: true });
  const content =
    '# Approval Gates Catalog (test fixture)\n\n' +
    '   | `plan-alm:1.indented` | gate | plan | 1 | test | nothing |\n';
  fs.writeFileSync(path.join(root, 'references', 'approval-gates.md'), content);
  writeSkill(root, 'plan-alm', '# plan-alm\n\nNo marker for the indented row.\n');
  const findings = collectFindings({ pluginRoot: root });
  const orphans = findings.filter((f) => f.rule === 'CATALOG-row-must-have-marker');
  assert.equal(orphans.length, 1, 'indented row should still be checked');
  assert.match(orphans[0].message, /plan-alm:1\.indented/);
});

test('GATE-prose-block-required: fires when marker has no 🚦 within 10 lines', async (t) => {
  const root = mkPluginRoot(t);
  writeCatalog(root, ['plan-alm:1.bare']);
  writeSkill(
    root,
    'plan-alm',
    `# plan-alm
## Phase 1
<!-- gate: plan-alm:1.bare | category=plan | cancel-leaves=nothing -->

No prose block here, just text.
Ask via \`AskUserQuestion\`:
`
  );
  const findings = collectFindings({ pluginRoot: root });
  const match = findings.find((f) => f.rule === 'GATE-prose-block-required');
  assert.ok(match, `expected GATE-prose-block-required to fire; got ${JSON.stringify(findings)}`);
  assert.match(match.message, /plan-alm:1\.bare/);
});

test('GATE-prose-block-required: passes when 🚦 sentinel follows within window', async (t) => {
  const root = mkPluginRoot(t);
  writeCatalog(root, ['plan-alm:1.good']);
  writeSkill(
    root,
    'plan-alm',
    `# plan-alm
## Phase 1
<!-- gate: plan-alm:1.good | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · plan-alm:1.good):** Description.
>
> **Trigger:** something.
> **Why we ask:** to avoid X.
> **Cancel leaves:** nothing.

Ask via \`AskUserQuestion\`:
`
  );
  const findings = collectFindings({ pluginRoot: root });
  assert.equal(findings.filter((f) => f.rule === 'GATE-prose-block-required').length, 0);
});

test('GATE-prose-block-required: ignores 🚦 inside a fenced code block', async (t) => {
  // A literal 🚦 inside a ```bash``` example should NOT satisfy the rule —
  // otherwise a contributor who deletes the real Gate prose but leaves an
  // example 🚦 within the window passes silently. The rule's purpose is to
  // catch prose-block drift, not match the symbol anywhere.
  const root = mkPluginRoot(t);
  writeCatalog(root, ['plan-alm:1.fenced']);
  writeSkill(
    root,
    'plan-alm',
    `# plan-alm
## Phase 1
<!-- gate: plan-alm:1.fenced | category=plan | cancel-leaves=nothing -->

\`\`\`bash
echo "🚦 starting deploy"
\`\`\`

Ask via \`AskUserQuestion\`:
`
  );
  const findings = collectFindings({ pluginRoot: root });
  const match = findings.find((f) => f.rule === 'GATE-prose-block-required');
  assert.ok(match, '🚦 inside code fence should not satisfy the rule');
});

test('GATE-prose-block-required: treats both fence delimiter lines as OUTSIDE the code block (regression — Copilot review)', async (t) => {
  // Pre-fix, the toggle ran BEFORE recording inFence[i], which made the
  // opening ``` line INSIDE and the closing ``` line OUTSIDE — asymmetric.
  // Post-fix, both delimiter lines are classified OUTSIDE; only the
  // content lines strictly between them are INSIDE. A 🚦 placed on the
  // OPENING fence line itself (legal Markdown info string like ```🚦)
  // should therefore satisfy the rule, not be falsely rejected as
  // "inside the code block".
  const root = mkPluginRoot(t);
  writeCatalog(root, ['plan-alm:1.fence-line']);
  writeSkill(
    root,
    'plan-alm',
    `# plan-alm
## Phase 1
<!-- gate: plan-alm:1.fence-line | category=plan | cancel-leaves=nothing -->
\`\`\`🚦 fence-info contains the sentinel
not really inside per the rule
\`\`\`

Ask via \`AskUserQuestion\`:
`
  );
  const findings = collectFindings({ pluginRoot: root });
  assert.equal(
    findings.filter((f) => f.rule === 'GATE-prose-block-required').length,
    0,
    '🚦 on the opening fence delimiter line should satisfy the rule (delimiter lines are OUTSIDE the code block)'
  );
});

test('GATE-prose-block-required: tolerates 🚦 on the same line as the marker (single-line style)', async (t) => {
  // The window is inclusive of the marker's own line, so a compact one-line
  // marker + 🚦 should pass (legal Markdown).
  const root = mkPluginRoot(t);
  writeCatalog(root, ['plan-alm:1.oneliner']);
  writeSkill(
    root,
    'plan-alm',
    `# plan-alm
## Phase 1
<!-- gate: plan-alm:1.oneliner | category=plan | cancel-leaves=nothing --> > 🚦 **Gate (plan · plan-alm:1.oneliner):** Compact.

Ask via \`AskUserQuestion\`:
`
  );
  const findings = collectFindings({ pluginRoot: root });
  assert.equal(findings.filter((f) => f.rule === 'GATE-prose-block-required').length, 0);
});
