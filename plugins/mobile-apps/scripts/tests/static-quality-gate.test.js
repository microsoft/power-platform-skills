'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const templateRoot = path.join(pluginRoot, 'template');
const harnessRoot = path.join(pluginRoot, 'skills', 'create-mobile-prototype', 'harness');
const registry = require(path.join(harnessRoot, 'registry.js'));
const staticRunner = require(path.join(harnessRoot, 'static', 'run.js'));
const hook = path.join(harnessRoot, 'static', 'run.js');

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-quality-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ['package.json', 'app.config.js', 'auth.config.json']) fs.copyFileSync(path.join(templateRoot, file), path.join(root, file));
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.mkdirSync(path.join(root, 'brand'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(root, 'brand', 'tokens.ts'), `export const tokens = { color: { primary: '#0A4F8F' } } as const;\n`);
  fs.copyFileSync(path.join(pluginRoot, 'shared', 'samples', 'src', 'components', 'index.tsx'), path.join(root, 'src', 'components', 'index.tsx'));
  fs.symlinkSync(path.join(templateRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  return root;
}

test('every tier-one fixture fires its registered AST rule under 150ms per file', (t) => {
  const root = project(t);
  const entries = registry.load().filter((entry) => entry.tier === 1);
  const startedAt = performance.now();
  for (const entry of entries) {
    const source = fs.readFileSync(path.join(pluginRoot, entry.fixture), 'utf8');
    const filePath = path.join(root, 'app', `${entry.module}.tsx`);
    const findings = staticRunner.lintSource(source, filePath, root);
    assert.equal(findings.some((finding) => finding.id === entry.id), true, `${entry.id} fixture did not fire: ${JSON.stringify(findings)}`);
  }
  const average = (performance.now() - startedAt) / entries.length;
  assert.ok(average < 150, `average AST cost ${average.toFixed(1)}ms exceeds 150ms`);
});

test('PostToolUse violation blocks with actionable registry id', (t) => {
  const root = project(t);
  const filePath = path.join(root, 'app', 'blocked.tsx');
  fs.writeFileSync(filePath, `import { Text } from 'tamagui';\nexport default function Screen() { return <Text color="#fff">Blocked</Text>; }\n`);
  const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: filePath } });
  const result = spawnSync(process.execPath, [hook], { encoding: 'utf8', input: payload });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /static\.raw-hex/);
  assert.match(result.stderr, /expected a semantic color token/);
});

test('three unrelated clean app screens produce zero static findings', (t) => {
  const root = project(t);
  const screens = [
    ['field', 'North Dock inspection'],
    ['retail', 'Cabin chronograph'],
    ['rehab', 'River intake'],
  ];
  for (const [name, recordName] of screens) {
    const filePath = path.join(root, 'app', `${name}.tsx`);
    const source = `import { Text, View } from 'react-native';\nconst record = { name: ${JSON.stringify(recordName)} };\nexport default function Screen() { return <View testID="screen:${name}" style={{ paddingStart: 8 }}><Text>{record.name}</Text></View>; }\n`;
    fs.writeFileSync(filePath, source);
    assert.deepEqual(staticRunner.lintFile(filePath, root), [], name);
  }
});

test('pluralisation distinguishes dynamic values from hard-coded plural nouns', (t) => {
  const root = project(t);
  const filePath = path.join(root, 'app', 'counts.tsx');
  const clean = "import { Text } from 'react-native';\nconst items = [{ id: 1 }];\nexport default function Screen() { return <Text>{`${items.length}`}</Text>; }\n";
  assert.equal(staticRunner.lintSource(clean, filePath, root).some((finding) => finding.id === 'content.pluralisation'), false);
  const unsafe = "import { Text } from 'react-native';\nconst count = 1;\nexport default function Screen() { return <Text>{`${count} items`}</Text>; }\n";
  assert.equal(staticRunner.lintSource(unsafe, filePath, root).some((finding) => finding.id === 'content.pluralisation'), true);
});

test('mobile dispatcher and plugin hook route TSX writes through the static registry', () => {
  const manifest = fs.readFileSync(path.join(pluginRoot, 'scripts', 'lib', 'mobile-validator-manifest.js'), 'utf8');
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
  assert.match(manifest, /validate-static-quality\.js/);
  assert.doesNotMatch(manifest, /validate-screen-quality\.js|validate-color-contrast\.js/);
  assert.equal(hooks.hooks.PostToolUse[0].matcher, 'Write|Edit|MultiEdit');
  assert.match(hooks.hooks.PostToolUse[0].hooks[0].command, /harness\/static\/run\.js/);
});