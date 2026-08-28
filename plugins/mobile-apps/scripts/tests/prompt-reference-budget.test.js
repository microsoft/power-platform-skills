'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  CREATE_PHASES,
  composeCreateMobileAppWorkflow,
} = require('./workflow-test-helpers');

const pluginRoot = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(
  path.join(pluginRoot, relativePath),
  'utf8',
);
const bytes = (relativePath) => Buffer.byteLength(read(relativePath));

test('orchestrator and agent prompts stay within progressive-loading budgets', () => {
  const core = read('skills/create-mobile-app/SKILL.md');
  assert.ok(Buffer.byteLength(core) <= 40 * 1024, 'create core exceeds 40 KiB');
  assert.ok(core.split('\n').length <= 300, 'create core exceeds 300 lines');

  assert.ok(bytes('agents/screen-builder.md') <= 15 * 1024, 'screen builder exceeds 15 KiB');
  for (const fileName of [
    'native-app-planner.md',
    'data-model-architect.md',
    'screen-planner.md',
    'offline-profile-architect.md',
  ]) {
    assert.ok(bytes(`agents/${fileName}`) <= 20 * 1024, `${fileName} exceeds 20 KiB`);
  }
  assert.ok(
    bytes('shared/shared-instructions-core.md') <= 3 * 1024,
    'mandatory shared instructions exceed 3 KiB',
  );
});

test('screen builder static required-reading set stays below 40 KiB', () => {
  const archetypes = [
    'list.md',
    'detail.md',
    'form.md',
    'schedule.md',
    'conversation.md',
    'map.md',
    'supporting.md',
  ].map((fileName) => bytes(`shared/references/screen-templates/${fileName}`));
  const samples = [
    'screen-list.tsx',
    'screen-detail.tsx',
    'screen-form.tsx',
  ].map((fileName) => bytes(`shared/samples/${fileName}`));

  const staticReadSet = bytes('agents/screen-builder.md')
    + bytes('shared/references/code-idioms.md')
    + bytes('shared/references/accessibility-checklist.md')
    + Math.max(...archetypes)
    + Math.max(...samples);

  assert.ok(
    staticReadSet <= 40 * 1024,
    `builder static read set is ${staticReadSet} bytes`,
  );
});

test('every create phase is referenced and contains executable step guidance', () => {
  const core = read('skills/create-mobile-app/SKILL.md');
  const composed = composeCreateMobileAppWorkflow(pluginRoot);
  for (const fileName of CREATE_PHASES) {
    assert.match(core, new RegExp(`references/${fileName.replace('.', '\\.')}`));
    assert.match(read(`skills/create-mobile-app/references/${fileName}`), /^# /m);
  }
  for (const step of ['Step 0', 'Step 3', 'Step 5', 'Step 8', 'Step 10b', 'Step 11']) {
    assert.ok(composed.includes(step), `composed workflow is missing ${step}`);
  }
});

test('approval artifacts are sealed only after Gate 4', () => {
  const planning = read('skills/create-mobile-app/references/phase-3-planning.md');
  const scaffold = read('skills/create-mobile-app/references/phase-4-scaffold.md');
  assert.doesNotMatch(planning, /--record --step "3\.9"/);
  assert.match(scaffold, /--record --step "6\.75"[\s\S]*plan=native-app-plan\.md/);
});

test('detail skeleton scalarizes and normalizes dynamic route parameters', () => {
  const navigation = read('skills/create-mobile-app/references/phase-10-navigation.md');
  assert.match(navigation, /id\?: string \| string\[\]/);
  assert.match(navigation, /Array\.isArray\(params\.id\) \? params\.id\[0\] : params\.id/);
  assert.match(navigation, /const id = normalizeDataverseGuid\(rawId\)/);
  assert.match(navigation, /if \(!result\.success\) \{[\s\S]*?return;[\s\S]*?result\.data/);
});

test('create and edit flows keep generated services outside the approved plan', () => {
  const navigation = read('skills/create-mobile-app/references/phase-10-navigation.md');
  const edit = read('skills/edit-app/SKILL.md');
  for (const source of [navigation, edit]) {
    assert.match(source, /\.tmp\/generated-services-snapshot\.md/);
    assert.match(source, /(?:approved[\s\S]{0,120}rewrite|rewrite[\s\S]{0,120}approved)/i);
  }
  assert.doesNotMatch(edit, /Replace or create the `## Generated Services/);
});

test('reference indexes point to existing titled shards', () => {
  for (const [indexPath, shardDir] of [
    ['shared/references/screen-templates.md', 'shared/references/screen-templates'],
    ['shared/references/universal-patterns.md', 'shared/references/universal-patterns'],
  ]) {
    const index = read(indexPath);
    for (const match of index.matchAll(/\]\(([^)#]+\.md)(?:#[^)]+)?\)/g)) {
      const resolved = path.resolve(path.dirname(path.join(pluginRoot, indexPath)), match[1]);
      assert.ok(fs.existsSync(resolved), `${indexPath} points to missing ${match[1]}`);
      assert.match(fs.readFileSync(resolved, 'utf8'), /^# /, `${match[1]} needs an H1`);
      assert.equal(path.dirname(resolved), path.join(pluginRoot, shardDir));
    }
  }
});

test('every build-pack composition has builder dispatch guidance', () => {
  const schema = JSON.parse(read('scripts/schema-screen-build-pack.json'));
  const kinds = schema.properties.packs.items.properties.composition.properties.kind.enum;
  const builder = read('agents/screen-builder.md');
  for (const kind of kinds) {
    assert.match(builder, new RegExp(`\\\`${kind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\\``));
  }
});

test('relative Markdown links in the mobile plugin resolve', () => {
  const markdownFiles = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.name.endsWith('.md')) markdownFiles.push(fullPath);
    }
  };
  walk(pluginRoot);

  const broken = [];
  for (const filePath of markdownFiles) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      let href = match[1].trim().replace(/^<|>$/g, '').split('#')[0];
      if (
        !href
        || /^(?:https?:|mailto:|file:|#)/.test(href)
        || href.includes('${')
        || href.includes('<')
        || href.includes('>')
        || href.includes('*')
      ) {
        continue;
      }
      href = decodeURIComponent(href);
      const target = path.resolve(path.dirname(filePath), href);
      if (!fs.existsSync(target)) {
        broken.push(`${path.relative(pluginRoot, filePath)} -> ${href}`);
      }
    }
  }

  assert.deepEqual(broken, []);
});
