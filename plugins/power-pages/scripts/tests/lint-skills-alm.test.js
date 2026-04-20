'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectFindings } = require('../lint-skills-alm');

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
