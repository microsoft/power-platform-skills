'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_MD = path.resolve(
  __dirname,
  '..', '..', 'skills', 'git-configure', 'SKILL.md',
);
const LIB_DIR = path.resolve(__dirname, '..', 'lib');

function readSkill() {
  return fs.readFileSync(SKILL_MD, 'utf8');
}

function parseFrontmatter(markdown) {
  assert.ok(/^\uFEFF?---\r?\n/.test(markdown), 'SKILL.md must start with YAML frontmatter');

  const closeIndex = markdown.indexOf('\n---', 4);
  assert.ok(closeIndex > -1, 'frontmatter must have a closing --- line');

  const raw = markdown.slice(4, closeIndex).trim();
  const data = {};
  let currentKey = null;

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) {
      currentKey = match[1];
      data[currentKey] = match[2].replace(/^['"]|['"]$/g, '');
      continue;
    }

    if (currentKey && /^\s+\S/.test(line)) {
      data[currentKey] = `${data[currentKey]} ${line.trim()}`.trim();
      continue;
    }

    assert.fail(`frontmatter line did not parse: ${line}`);
  }

  return data;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const expectedGateIds = [
  '1.env-confirm',
  '1.prereq-fail',
  '1.envurl-mismatch',
  '1.artifact-path',
  '1.bound-intent',
  '1.manifest-stale',
  '2.managed-env-warn',
  '2.byok-cmk-warn',
  '2.license-warn',
  '2.cross-tenant-block',
  '2.ado-perms-fail',
  '2.repo-init',
  '3.two-layer-explainer',
  '3.binding-type',
  '4.create-project',
  '4.create-repo',
  '4.create-branch',
  '4.folder-coexists',
  '4.folder-occupied',
  '4.shared-object-overlap',
  '5.workspace-dirty',
  '6.consent-setup',
  '6.consent-disconnect',
  '6.consent-rebind',
  '8.recovery',
  '9.enable-approach',
  '9.enable-solution',
  '9.commit-approach',
  '9.commit-solution',
  '10.final',
];

const allowedGateCategories = new Set(['intent', 'consent', 'plan', 'final']);

test('frontmatter parses cleanly', () => {
  const prose = readSkill();
  const frontmatter = parseFrontmatter(prose);

  assert.equal(frontmatter.name, 'git-configure');
  assert.equal(frontmatter['user-invocable'], 'true');
  assert.equal(frontmatter.model, 'opus');
  assert.ok(frontmatter.description, 'description is required');
  assert.ok(
    frontmatter.description.length <= 1000,
    `description must be <= 1000 characters; got ${frontmatter.description.length}`,
  );
});

test('all 30 gate IDs are present with git-configure prefix', () => {
  const prose = readSkill();

  for (const id of expectedGateIds) {
    assert.match(
      prose,
      new RegExp(`\\bgit-configure:${escapeRegExp(id)}\\b`),
      `missing gate id git-configure:${id}`,
    );
  }
});

test('each gate ID has a matching comment and blockquote with the same category', () => {
  const prose = readSkill();

  for (const id of expectedGateIds) {
    const gateId = `git-configure:${id}`;
    const commentPattern = new RegExp(
      `<!-- gate: ${escapeRegExp(gateId)} \\| category=(intent|consent|plan|final) \\| cancel-leaves=nothing -->`,
    );
    const commentMatch = prose.match(commentPattern);
    assert.ok(commentMatch, `${gateId} must have the canonical HTML gate comment`);

    const category = commentMatch[1];
    assert.ok(allowedGateCategories.has(category), `${gateId} has unsupported category ${category}`);

    const blockquotePattern = new RegExp(
      `^> 🚦 \\*\\*Gate \\(${escapeRegExp(category)} · ${escapeRegExp(gateId)}\\):\\*\\*`,
      'm',
    );
    assert.match(
      prose,
      blockquotePattern,
      `${gateId} must have a blockquote gate line with category ${category}`,
    );
  }
});

test('mode dispatcher referenced', () => {
  const prose = readSkill();
  assert.match(prose, /detectGitConfigureMode|detect-git-configure-mode/);
});

test('4 modes referenced', () => {
  const prose = readSkill();

  for (const modeReference of [
    '--mode=setup',
    '--mode=switch-branch',
    '--mode=rebind',
    '--mode=disconnect',
  ]) {
    assert.match(prose, new RegExp(escapeRegExp(modeReference)), `missing ${modeReference}`);
  }
});

test('consolidation map present', () => {
  const prose = readSkill();
  assert.match(prose, /Legacy preservation and consolidation map/);
});

test('no markdown-broken artifacts', () => {
  const prose = readSkill();

  assert.doesNotMatch(prose, /<!-- TODO:/);
  assert.doesNotMatch(prose, /\{\{placeholder\}\}/);
  assert.doesNotMatch(prose, /\[REPLACE_ME\]/);
});

test('line count and size cap', () => {
  const prose = readSkill();
  const lineCount = prose.split(/\r?\n/).length;
  const byteSize = Buffer.byteLength(prose, 'utf8');

  assert.ok(lineCount <= 1300, `SKILL.md must be <= 1300 lines; got ${lineCount}`);
  assert.ok(byteSize <= 60 * 1024, `SKILL.md must be <= 60 KB; got ${byteSize} bytes`);
});

test('helper imports match what exists', () => {
  const prose = readSkill();
  const fencedBlocks = [...prose.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]);
  const libReferences = new Set();

  for (const block of fencedBlocks) {
    for (const match of block.matchAll(/require\(['"](?:[^'"]*scripts\/lib\/)?([^'"]+)['"]\)/g)) {
      libReferences.add(match[1].replace(/\.js$/, ''));
    }

    for (const match of block.matchAll(/scripts\/lib\/([A-Za-z0-9._-]+)(?:\.js)?/g)) {
      libReferences.add(match[1].replace(/\.js$/, ''));
    }
  }

  for (const helperName of libReferences) {
    const helperPath = path.join(LIB_DIR, `${helperName}.js`);
    assert.ok(fs.existsSync(helperPath), `referenced helper must exist: scripts/lib/${helperName}.js`);
  }
});
