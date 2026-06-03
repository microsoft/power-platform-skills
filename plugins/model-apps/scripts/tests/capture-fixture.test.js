'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'capture-fixture.js');
const {
  parseArgs,
  shouldCopyFile,
  copyAllowedFiles,
  parseTapSummary,
  extractFailures,
} = require('../capture-fixture.js');

function mkTempDir(prefix = 'capture-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFiles(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function runScript(args) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ---------- parseArgs ----------

test('parseArgs: requires --working-dir', () => {
  assert.throws(() => parseArgs(['--eval', '1', '--slug', 's']), /--working-dir/);
});

test('parseArgs: requires --eval', () => {
  assert.throws(() => parseArgs(['--working-dir', '/x', '--slug', 's']), /--eval/);
});

test('parseArgs: requires --slug', () => {
  assert.throws(() => parseArgs(['--working-dir', '/x', '--eval', '1']), /--slug/);
});

test('parseArgs: --eval must be numeric', () => {
  assert.throws(
    () => parseArgs(['--working-dir', '/x', '--eval', 'abc', '--slug', 's']),
    /numeric/,
  );
});

test('parseArgs: --slug must be kebab-case', () => {
  assert.throws(
    () => parseArgs(['--working-dir', '/x', '--eval', '1', '--slug', 'CamelCase']),
    /kebab-case/,
  );
});

test('parseArgs: --force defaults to false', () => {
  const args = parseArgs(['--working-dir', '/x', '--eval', '1', '--slug', 's']);
  assert.equal(args.force, false);
});

test('parseArgs: --skip-verify is recognized', () => {
  const args = parseArgs(['--working-dir', '/x', '--eval', '1', '--slug', 's', '--skip-verify']);
  assert.equal(args.skipVerify, true);
});

test('parseArgs: unknown flag throws', () => {
  assert.throws(
    () => parseArgs(['--working-dir', '/x', '--eval', '1', '--slug', 's', '--bogus']),
    /Unknown/,
  );
});

// ---------- shouldCopyFile ----------

test('shouldCopyFile: allowlists .tsx', () => {
  assert.equal(shouldCopyFile('page.tsx'), true);
});

test('shouldCopyFile: allowlists .md', () => {
  assert.equal(shouldCopyFile('workflow-log.md'), true);
  assert.equal(shouldCopyFile('genpage-plan.md'), true);
  assert.equal(shouldCopyFile('entity-creation-log.md'), true);
});

test('shouldCopyFile: allowlists RuntimeTypes.ts', () => {
  assert.equal(shouldCopyFile('RuntimeTypes.ts'), true);
});

test('shouldCopyFile: rejects package.json', () => {
  assert.equal(shouldCopyFile('package.json'), false);
});

test('shouldCopyFile: rejects genpage.d.ts', () => {
  assert.equal(shouldCopyFile('genpage.d.ts'), false);
});

test('shouldCopyFile: rejects .log files', () => {
  assert.equal(shouldCopyFile('something.log'), false);
});

test('shouldCopyFile: rejects unknown extensions', () => {
  assert.equal(shouldCopyFile('weird.txt'), false);
  assert.equal(shouldCopyFile('binary.bin'), false);
});

test('shouldCopyFile: rejects .DS_Store / Thumbs.db', () => {
  assert.equal(shouldCopyFile('.DS_Store'), false);
  assert.equal(shouldCopyFile('Thumbs.db'), false);
});

// ---------- copyAllowedFiles ----------

test('copyAllowedFiles: copies allowlisted files, skips others', () => {
  const src = mkTempDir('src-');
  const dst = mkTempDir('dst-');
  fs.rmSync(dst, { recursive: true, force: true }); // function will recreate
  try {
    writeFiles(src, {
      'page.tsx': 'export default GeneratedComponent;',
      'RuntimeTypes.ts': 'export interface Account {}',
      'workflow-log.md': '# log',
      'genpage-plan.md': '# plan',
      'entity-creation-log.md': '# entity log',
      'package.json': '{"name":"x"}',
      'genpage.d.ts': 'declare global {}',
      'something.log': 'noise',
      'weird.txt': 'no',
    });
    const result = copyAllowedFiles(src, dst);
    assert.deepEqual(
      result.copied.sort(),
      ['entity-creation-log.md', 'genpage-plan.md', 'page.tsx', 'RuntimeTypes.ts', 'workflow-log.md'].sort(),
    );
    // Verify the right files actually landed
    assert.ok(fs.existsSync(path.join(dst, 'page.tsx')));
    assert.ok(fs.existsSync(path.join(dst, 'workflow-log.md')));
    assert.ok(!fs.existsSync(path.join(dst, 'package.json')));
    assert.ok(!fs.existsSync(path.join(dst, 'genpage.d.ts')));
    assert.ok(!fs.existsSync(path.join(dst, 'something.log')));
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  }
});

test('copyAllowedFiles: skips node_modules directory', () => {
  const src = mkTempDir('src-');
  const dst = mkTempDir('dst-');
  fs.rmSync(dst, { recursive: true, force: true });
  try {
    writeFiles(src, {
      'page.tsx': 'x',
      'node_modules/react/index.js': 'noise',
    });
    const result = copyAllowedFiles(src, dst);
    assert.ok(result.copied.includes('page.tsx'));
    assert.ok(!fs.existsSync(path.join(dst, 'node_modules')));
    assert.ok(result.skipped.some((s) => s.name.startsWith('node_modules')));
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  }
});

// ---------- parseTapSummary ----------

test('parseTapSummary: extracts counts from TAP output', () => {
  const stdout = `TAP version 13
1..1
ok 1 - fixture
# tests 24
# pass  14
# fail  0
# skip  10
# fixtures 1 (pass 1, fail 0)
`;
  const s = parseTapSummary(stdout);
  assert.deepEqual(s, { tests: 24, pass: 14, fail: 0, skip: 10 });
});

test('parseTapSummary: handles missing fields gracefully', () => {
  const s = parseTapSummary('garbage with no counts');
  assert.deepEqual(s, { tests: 0, pass: 0, fail: 0, skip: 0 });
});

// ---------- extractFailures ----------

test('extractFailures: pulls "not ok" assertion lines', () => {
  const stdout = `TAP version 13
1..1
# Subtest: 2-mock-dashboard
    ok 1 - first assertion
    not ok 2 - second assertion failed
      ---
      reason: "boom"
      ...
    ok 3 - third assertion
not ok 1 - 2-mock-dashboard
`;
  const fails = extractFailures(stdout);
  assert.equal(fails.length, 1);
  assert.match(fails[0], /second assertion failed/);
});

test('extractFailures: skips the subtest aggregate line', () => {
  const stdout = `    not ok 1 - real failure
not ok 1 - aggregate-fixture-name
`;
  const fails = extractFailures(stdout);
  assert.equal(fails.length, 1);
  assert.match(fails[0], /real failure/);
});

// ---------- CLI integration ----------

test('CLI: exits 1 when working dir does not exist', () => {
  const r = runScript([
    '--working-dir', '/nonexistent/zzz',
    '--eval', '2',
    '--slug', 'test',
    '--skip-verify',
  ]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /does not exist/);
});

test('CLI: exits 1 when eval id unknown', () => {
  const src = mkTempDir('src-');
  try {
    writeFiles(src, { 'page.tsx': 'x' });
    const r = runScript([
      '--working-dir', src,
      '--eval', '999',
      '--slug', 'test',
      '--skip-verify',
    ]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no eval with id 999/);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test('CLI: exits 2 when no allowlisted files in working dir', () => {
  const src = mkTempDir('src-');
  try {
    writeFiles(src, { 'noise.log': 'x', 'package.json': '{}' });
    const r = runScript([
      '--working-dir', src,
      '--eval', '2',
      '--slug', 'empty-test',
      '--skip-verify',
    ]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /no allowlisted files/);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test('CLI: writes fixture and reports JSON summary', () => {
  const src = mkTempDir('src-');
  const slug = `capture-cli-test-${Date.now()}`;
  const fixtureDir = path.join(
    __dirname, '..', '..', '..', '..',
    'evals', 'model-apps', 'genpage', 'fixtures',
    `2-${slug}`,
  );
  try {
    writeFiles(src, {
      'page.tsx': `import { makeStyles } from '@fluentui/react-components';
const useStyles = makeStyles({ r: {} });
const data = [{a:1},{a:2}];
const GeneratedComponent = (props) => { const { pageInput } = props; void pageInput; return <div/>; };
export default GeneratedComponent;`,
      'workflow-log.md': '# log\n',
      'package.json': '{"name":"x"}', // should be skipped
    });
    const r = runScript([
      '--working-dir', src,
      '--eval', '2',
      '--slug', slug,
      '--skip-verify',
    ]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const summary = JSON.parse(r.stdout);
    assert.equal(summary.eval, 2);
    assert.equal(summary.slug, slug);
    assert.ok(summary.copied.includes('page.tsx'));
    assert.ok(summary.copied.includes('workflow-log.md'));
    assert.ok(!summary.copied.includes('package.json'));
    assert.equal(summary.layer1, undefined, '--skip-verify omits layer1');
    assert.ok(fs.existsSync(fixtureDir));
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('CLI: refuses to overwrite without --force', () => {
  const src = mkTempDir('src-');
  const slug = `force-test-${Date.now()}`;
  const fixtureDir = path.join(
    __dirname, '..', '..', '..', '..',
    'evals', 'model-apps', 'genpage', 'fixtures',
    `2-${slug}`,
  );
  try {
    // First capture
    writeFiles(src, { 'page.tsx': 'first', 'workflow-log.md': '#' });
    const r1 = runScript([
      '--working-dir', src, '--eval', '2', '--slug', slug, '--skip-verify',
    ]);
    assert.equal(r1.code, 0);

    // Second capture without --force should fail
    const r2 = runScript([
      '--working-dir', src, '--eval', '2', '--slug', slug, '--skip-verify',
    ]);
    assert.equal(r2.code, 2);
    assert.match(r2.stderr, /already exists/);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('CLI: --force overwrites existing fixture', () => {
  const src = mkTempDir('src-');
  const slug = `overwrite-test-${Date.now()}`;
  const fixtureDir = path.join(
    __dirname, '..', '..', '..', '..',
    'evals', 'model-apps', 'genpage', 'fixtures',
    `2-${slug}`,
  );
  try {
    writeFiles(src, { 'page.tsx': 'v1', 'workflow-log.md': '# v1' });
    runScript([
      '--working-dir', src, '--eval', '2', '--slug', slug, '--skip-verify',
    ]);
    // overwrite source
    fs.writeFileSync(path.join(src, 'page.tsx'), 'v2');
    const r = runScript([
      '--working-dir', src, '--eval', '2', '--slug', slug, '--skip-verify', '--force',
    ]);
    assert.equal(r.code, 0);
    const content = fs.readFileSync(path.join(fixtureDir, 'page.tsx'), 'utf8');
    assert.equal(content, 'v2');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
