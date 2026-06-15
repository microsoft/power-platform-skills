'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SKILL_DIR = path.join(__dirname, '..', '..', 'skills', 'git-sync');
const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md');
const REF_DIR = path.join(SKILL_DIR, 'references');
const LIB_DIR = path.join(__dirname, '..', 'lib');

function readSkill() { return fs.readFileSync(SKILL_MD, 'utf8'); }
function readRef(name) { return fs.readFileSync(path.join(REF_DIR, name), 'utf8'); }
function escapeRegExp(v) { return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function parseFrontmatter(prose) {
  const m = prose.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m, 'frontmatter block must exist');
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([a-zA-Z0-9_-]+):\s?(.*)$/);
    if (mm) data[mm[1]] = mm[2];
  }
  // description uses folded >- ; reconstruct char length from the block.
  const dm = prose.match(/^description:\s*>-\s*\r?\n([\s\S]*?)\r?\n[a-z-]+:/m);
  if (dm) data.description = dm[1].replace(/\s+/g, ' ').trim();
  return data;
}

// ===== frontmatter =====

test('frontmatter parses; name=git-sync; description <= 1000 chars (loader cap)', () => {
  const fm = parseFrontmatter(readSkill());
  assert.equal(fm.name, 'git-sync');
  assert.equal(fm['user-invocable'], 'true');
  assert.equal(fm.model, 'opus');
  assert.ok(fm.description && fm.description.length <= 1000, `description must be <= 1000 chars; got ${fm.description ? fm.description.length : 'none'}`);
});

// ===== the 3 reference docs exist AND are referenced =====

const REF_DOCS = ['changes-reference.md', 'update-reference.md', 'conflict-reference.md'];

test('the three skill-local reference docs exist', () => {
  for (const doc of REF_DOCS) {
    assert.ok(fs.existsSync(path.join(REF_DIR, doc)), `missing references/${doc}`);
  }
});

test('SKILL.md references each of the three reference docs', () => {
  const prose = readSkill();
  for (const doc of REF_DOCS) {
    assert.match(prose, new RegExp(`references/${escapeRegExp(doc)}`), `SKILL.md must reference references/${doc}`);
  }
});

// ===== dispatcher gates live in SKILL.md =====

const DISPATCHER_GATES = [
  '1.no-binding', '1.manifest-stale', '2.conflicts', '3.mixed-order',
  'final.open-pr', 'final.tag-offer', 'final',
];

test('all dispatcher gate IDs are present in SKILL.md with the git-sync prefix', () => {
  const prose = readSkill();
  for (const id of DISPATCHER_GATES) {
    assert.match(prose, new RegExp(`<!-- gate: git-sync:${escapeRegExp(id)} \\|`), `missing dispatcher gate git-sync:${id}`);
  }
});

// ===== flow gates live in the reference docs =====

test('changes-reference.md carries the commit-flow gates', () => {
  const doc = readRef('changes-reference.md');
  for (const id of ['changes.auto-fix-blocked-attachments', 'changes.pre-flight-blockers', 'changes.pre-flight-warnings', 'changes.plan', 'changes.consent']) {
    assert.match(doc, new RegExp(`git-sync:${escapeRegExp(id)}`), `changes-reference.md must define git-sync:${id}`);
  }
});

test('update-reference.md carries the pull-flow gates', () => {
  const doc = readRef('update-reference.md');
  for (const id of ['update.plan', 'update.hard-delete', 'update.consent']) {
    assert.match(doc, new RegExp(`git-sync:${escapeRegExp(id)}`), `update-reference.md must define git-sync:${id}`);
  }
});

test('conflict-reference.md carries the conflict-flow gates + a Future VS Code/LLM section', () => {
  const doc = readRef('conflict-reference.md');
  for (const id of ['2.conflict-decisions', '2.conflict-fallback']) {
    assert.match(doc, new RegExp(`git-sync:${escapeRegExp(id)}`), `conflict-reference.md must define git-sync:${id}`);
  }
  assert.match(doc, /Future/i, 'conflict-reference.md must document the future VS Code/LLM upgrade');
});

// ===== modes referenced =====

test('the dispatcher references all modes', () => {
  const prose = readSkill();
  for (const flag of ['--commit', '--pull', '--dry-run', '--background', '--hard-delete']) {
    assert.match(prose, new RegExp(escapeRegExp(flag)), `missing mode ${flag}`);
  }
});

test('the headline helpers are referenced', () => {
  const prose = readSkill();
  assert.match(prose, /detect-sync-direction|detectSyncDirection/);
  assert.match(prose, /classify-change-set/);
});

// ===== helper imports referenced from fenced blocks must exist =====

test('helper scripts referenced in fenced blocks exist on disk', () => {
  const allText = readSkill() + REF_DOCS.map(readRef).join('\n');
  const refs = new Set();
  for (const m of allText.matchAll(/scripts\/lib\/([A-Za-z0-9._-]+)\.js/g)) refs.add(m[1]);
  for (const name of refs) {
    assert.ok(fs.existsSync(path.join(LIB_DIR, `${name}.js`)), `referenced helper must exist: scripts/lib/${name}.js`);
  }
});

// ===== size sanity =====

test('SKILL.md stays within size caps (dispatcher should be lean)', () => {
  const prose = readSkill();
  const lines = prose.split(/\r?\n/).length;
  const bytes = Buffer.byteLength(prose, 'utf8');
  assert.ok(lines <= 600, `dispatcher SKILL.md should be <= 600 lines; got ${lines}`);
  assert.ok(bytes <= 40 * 1024, `dispatcher SKILL.md should be <= 40 KB; got ${bytes}`);
});
