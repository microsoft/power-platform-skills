'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const configPath = path.join(pluginRoot, 'template', 'tamagui.config.ts');
const integrationPath = path.join(pluginRoot, 'skills', 'design-system', 'references', 'tamagui-integration.md');
const designSkillPath = path.join(pluginRoot, 'skills', 'design-system', 'SKILL.md');

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

test('all shared sample semantic references resolve against template defaults', () => {
  const references = walk(path.join(pluginRoot, 'shared')).filter((filePath) => {
    if (filePath === configPath) return false;
    return fs.readFileSync(filePath, 'utf8').includes('$mono');
  });
  assert.ok(references.length > 0, 'Expected the mobile plugin to contain $mono usage guidance');

  const config = fs.readFileSync(configPath, 'utf8');
  assert.match(config, /createSystemFont/);
  assert.match(config, /const monoFont\s*=\s*createSystemFont/);
  assert.match(config, /fonts:\s*\{[\s\S]*\.\.\.defaultConfig\.fonts,[\s\S]*mono:\s*monoFont/);

  const sampleRoot = path.join(pluginRoot, 'shared', 'samples');
  const sampleSource = walk(sampleRoot).map((filePath) => fs.readFileSync(filePath, 'utf8')).join('\n');
  const semanticReferences = new Set(
    [...sampleSource.matchAll(/\$(status[A-Za-z]+|mono|surface[12])\b/g)].map((match) => match[1]),
  );
  assert.deepEqual([...semanticReferences].sort(), [
    'mono',
    'statusCancelled',
    'statusCancelledBg',
    'statusComplete',
    'statusCompleteBg',
    'statusDraft',
    'statusDraftBg',
    'statusInProgress',
    'statusInProgressBg',
    'statusOverdue',
    'statusOverdueBg',
    'statusPending',
    'statusPendingBg',
    'surface1',
    'surface2',
  ]);
  for (const token of semanticReferences) {
    if (token === 'mono') assert.match(config, /mono:\s*monoFont/);
    else assert.match(config, new RegExp(`\\b${token}:`), `template config is missing $${token}`);
  }

  for (const value of [
    '#FDECEA', '#E6F4EA', '#E8F0FE', '#FEF7E0', '#F1F3F4',
    '#C5221F', '#137333', '#1A73E8', '#B06000', '#5F6368',
    '#3B1210', '#12351F', '#102A43', '#3A2A0A', '#28282C',
    '#FF8A84', '#75D69C', '#8EC8FF', '#F5C46B', '#B4B4BC',
  ]) {
    assert.match(config, new RegExp(value), `template config is missing documented value ${value}`);
  }
});

test('design integration overrides template-owned aliases instead of creating them', () => {
  const integration = fs.readFileSync(integrationPath, 'utf8');
  const designSkill = fs.readFileSync(designSkillPath, 'utf8');

  assert.match(integration, /Compilation never depends on design-system execution/);
  assert.match(integration, /add-aliases[^\n]*Verify the template baseline exists; make no value changes/);
  assert.match(integration, /light: withSemanticAliases\(defaultConfig\.themes\.light, lightStatusColors, brandTokens\.color\)/);
  assert.match(integration, /dark: withSemanticAliases\(defaultConfig\.themes\.dark, darkStatusColors, darkBrandColors\)/);
  assert.match(integration, /statusDraft: statusColors\.statusDraft/);
  assert.match(integration, /statusCancelled: statusColors\.statusCancelled/);
  assert.match(designSkill, /template already owns the compile-time semantic token names and neutral values/);
  assert.match(designSkill, /template owns alias creation/);
  assert.doesNotMatch(integration, /default app still runs this reference in alias-only mode/);
});

test('template semantic helper maps brand identity fields but exempts fixed status aliases', () => {
  const config = fs.readFileSync(configPath, 'utf8');

  for (const mapping of [
    'surface0: brand.bg ?? theme.background',
    'surface1: brand.surface ?? theme.color2',
    'surface2: brand.surfaceMuted ?? theme.color3',
    'accentDeep: brand.primaryStrong ?? theme.blue8',
    'accentBase: brand.primary ?? theme.blue10',
    'accentSoft: brand.accent ?? theme.blue3',
    'accentOnAccent: brand.onPrimary ?? theme.color1',
  ]) {
    assert.ok(config.includes(mapping), `template config is missing brand override mapping: ${mapping}`);
  }
  assert.match(config, /statusDraft: statusColors\.statusDraft/);
  assert.match(config, /statusCancelled: statusColors\.statusCancelled/);
});

const templateRoot = path.join(pluginRoot, 'template');
const templateTsc = path.join(templateRoot, 'node_modules', 'typescript', 'bin', 'tsc');

test('bare template type-checks with every shared sample before design runs', {
  skip: !fs.existsSync(templateTsc),
}, (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-task36-template-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  for (const relativePath of ['tsconfig.json', 'tamagui.config.ts', 'expo-env.d.ts']) {
    const sourcePath = path.join(templateRoot, relativePath);
    if (fs.existsSync(sourcePath)) fs.copyFileSync(sourcePath, path.join(projectRoot, relativePath));
  }
  fs.cpSync(path.join(pluginRoot, 'shared', 'samples', 'src'), path.join(projectRoot, 'src'), { recursive: true });
  fs.symlinkSync(path.join(templateRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');

  const result = spawnSync(process.execPath, [templateTsc, '--noEmit', '--project', path.join(projectRoot, 'tsconfig.json')], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});