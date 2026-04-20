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
