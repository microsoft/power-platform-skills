'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pluginRoot = path.resolve(__dirname, '..', '..');

function runHook(name, projectRoot, filePath, content) {
  return spawnSync(process.execPath, [path.join(pluginRoot, 'hooks', name)], {
    cwd: projectRoot,
    encoding: 'utf8',
    input: JSON.stringify({
      cwd: projectRoot,
      tool_name: 'Write',
      tool_input: { file_path: filePath, content },
    }),
  });
}

test('screen validator blocks invalid mobile and Tamagui generation patterns', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-screen-contract-'));
  const file = path.join(root, 'app', 'home.tsx');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = [
    "import { Input, Text, YStack } from 'tamagui';",
    'export default function Home() {',
    '  return <YStack alignSelf="center" contentContainerStyle={{ padding: 4 }}>',
    '    <Input onChange={(e) => console.log(e.target.value)} />',
    "    <Text fontFamily={true ? '$mono' : undefined}>42</Text>",
    '  </YStack>;',
    '}',
  ].join('\n');
  const result = runHook('validate-screen-quality.js', root, file, content);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /Undefined Tamagui monospace font token/);
  assert.match(result.stderr, /Web-style text input handler/);
  assert.match(result.stderr, /Unsupported longhand prop/);
  assert.match(result.stderr, /React Native container prop used on a Tamagui primitive/);
});

test('screen validator allows React Native contentContainerStyle and typed onChangeText', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-screen-valid-'));
  const file = path.join(root, 'app', 'home.tsx');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = [
    "import { ScrollView } from 'react-native';",
    "import { Input, Text } from 'tamagui';",
    "import { SafeAreaView } from 'react-native-safe-area-context';",
    'export default function Home() {',
    '  return <SafeAreaView><ScrollView contentContainerStyle={{ padding: 4 }}>',
    '    <Input onChangeText={(value: string) => console.log(value)} />',
    "    <Text style={{ fontFamily: 'monospace' }}>42</Text>",
    '  </ScrollView></SafeAreaView>;',
    '}',
  ].join('\n');
  const result = runHook('validate-screen-quality.js', root, file, content);
  assert.strictEqual(result.status, 0, result.stderr);
});

test('source import validator blocks packages absent from the live project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-import-contract-'));
  const file = path.join(root, 'app', 'form.tsx');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    dependencies: { react: '19.0.0' },
  }));
  const result = runHook(
    'validate-source-imports.js',
    root,
    file,
    "import { zodResolver } from '@hookform/resolvers/zod';\nexport default function Form() { return null; }\n",
  );
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /@hookform\/resolvers/);
});

test('source import validator blocks dynamic imports and require calls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-dynamic-import-contract-'));
  const file = path.join(root, 'src', 'load.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    dependencies: { react: '19.0.0' },
  }));
  for (const content of [
    "export async function load() { return import('undeclared-dynamic'); }\n",
    "const missing = require('undeclared-required');\nexport { missing };\n",
  ]) {
    const result = runHook('validate-source-imports.js', root, file, content);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /undeclared-/);
  }
});

test('template path aliases include root and wildcard entries', () => {
  const tsconfig = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'template', 'tsconfig.json'), 'utf8'));
  for (const alias of ['components', 'hooks', 'utils', 'tokens', 'generated', 'native']) {
    assert.ok(tsconfig.compilerOptions.paths[`@/${alias}`]);
    assert.ok(tsconfig.compilerOptions.paths[`@/${alias}/*`]);
  }
});
