'use strict';

const assert = require('assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  collectSourceTargets,
  main,
  parseArgs,
} = require('../validate-mobile-files');

test('protected paths remain blocked with POSIX and Windows path separators', () => {
  for (const filePath of [
    '/project/power.config.json',
    'C:\\project\\power.config.json',
    '/project/src/generated/services/ItemsService.ts',
    'C:\\project\\src\\generated\\services\\ItemsService.ts',
    '/project/vendor/package.tgz',
    'C:\\project\\vendor\\package.tgz',
  ]) {
    const result = spawnSync(process.execPath, [
      path.resolve(__dirname, '../../hooks/validate-protected-paths.js'),
    ], {
      encoding: 'utf8',
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: filePath } }),
    });
    assert.strictEqual(result.status, 2, `${filePath}: ${result.stderr}`);
    assert.match(result.stderr, /BLOCKED: protected path/);
  }
  for (const filePath of ['/project/src/items.ts', 'C:\\project\\src\\items.ts']) {
    const result = spawnSync(process.execPath, [
      path.resolve(__dirname, '../../hooks/validate-protected-paths.js'),
    ], {
      encoding: 'utf8',
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: filePath } }),
    });
    assert.strictEqual(result.status, 0, result.stderr);
  }
});

test('all-source flag is explicit and does not require individual files', () => {
  const parsed = parseArgs(['--project-root', '/tmp/project', '--all-source']);
  assert.strictEqual(parsed.allSource, true);
  assert.deepStrictEqual(parsed.targets, []);
});

test('all-source rejects explicit validation targets', () => {
  let stderr = '';
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    stderr += String(chunk);
    return true;
  };

  try {
    assert.strictEqual(main([
      '--project-root',
      '/tmp/project',
      '--all-source',
      '--file',
      'app/home.tsx',
    ]), 1);
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.match(stderr, /Usage: node validate-mobile-files\.js/);
});

test('all-source discovery includes app and source TypeScript but excludes generated files', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-all-source-'));
  const files = [
    'app/home.tsx',
    'app/(app)/detail.tsx',
    'app/generated/report.tsx',
    'src/components/index.tsx',
    'src/hooks/useItems.ts',
    'src/generated/services/Generated.ts',
    'tamagui.config.ts',
    'app.config.js',
  ];
  for (const relativePath of files) {
    const absolutePath = path.join(projectRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, 'export {};\n');
  }

  const targets = collectSourceTargets(projectRoot);
  assert.deepStrictEqual(targets, [
    path.join('app', '(app)', 'detail.tsx'),
    path.join('app', 'generated', 'report.tsx'),
    path.join('app', 'home.tsx'),
    path.join('src', 'components', 'index.tsx'),
    path.join('src', 'hooks', 'useItems.ts'),
    'tamagui.config.ts',
  ].sort());
  assert.ok(!targets.some((target) => target.startsWith(path.join('src', 'generated'))));
  assert.ok(!targets.includes('app.config.js'));
});
