'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadCli } = require('./helpers/cli-harness.js');

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

// Every other CLI success path passes --skip-verify, so a capture that never starts the runners —
// or that prints their TAP failures as a clean pass — stays green. The runners are the real files
// the CLI resolves from __dirname; loadCli does not inject __dirname, so the test points that free
// variable at an isolated tree before compiling. The documented review rule is "both `failures`
// arrays empty → good to commit", so a runner that produced no verdict (nonzero exit without a
// failing assertion, or no assertions at all) must land in `failures`, not leave them empty.
test('default capture executes both layers and reports runner failure', async () => {
  const root = mkTempDir('capture-tree-');
  const scriptsDir = path.join(root, 'plugins', 'model-apps', 'scripts');
  const evalDir = path.join(root, 'evals', 'model-apps', 'genpage');
  const marker = path.join(root, 'runners.log');
  const working = mkTempDir('capture-work-');
  const prevDirname = global.__dirname;
  const prevLog = console.log;
  const prevErr = console.error;
  const logs = [];
  const errs = [];
  const envKeys = ['CAPTURE_MARKER', 'CAPTURE_L1_TAP', 'CAPTURE_L1_CODE', 'CAPTURE_L2_TAP', 'CAPTURE_L2_CODE'];
  const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  function runnerSource(layer) {
    return `'use strict';
const fs = require('node:fs');
if (process.env.CAPTURE_MARKER) {
  fs.appendFileSync(process.env.CAPTURE_MARKER, ${JSON.stringify(String(layer))} + ' ' + process.argv.slice(2).join(' ') + '\\n');
}
const tap = process.env.CAPTURE_L${layer}_TAP;
if (tap) process.stdout.write(tap);
process.exit(Number(process.env.CAPTURE_L${layer}_CODE || 0));
`;
  }

  function looksVerified(layer) {
    return Boolean(layer && layer.fail === 0 && layer.pass > 0 && (layer.failures || []).length === 0);
  }

  try {
    writeFiles(root, {
      'evals/model-apps/genpage/evals.json': JSON.stringify({ evals: [{ id: 4 }] }),
      'evals/model-apps/genpage/run-layer-1.js': runnerSource(1),
      'evals/model-apps/genpage/run-layer-2.js': runnerSource(2),
    });
    writeFiles(working, {
      'page.tsx': 'export default function GeneratedComponent() { return null; }\n',
      'notes/ignore.md': 'not captured — subdirectories are skipped\n',
    });
    fs.mkdirSync(scriptsDir, { recursive: true });
    console.log = (...args) => { logs.push(args.map(String).join(' ')); };
    console.error = (...args) => { errs.push(args.map(String).join(' ')); };
    global.__dirname = scriptsDir;
    process.env.CAPTURE_MARKER = marker;

    function run(extraArgs, env) {
      logs.length = 0;
      errs.length = 0;
      fs.writeFileSync(marker, '');
      for (const [k, v] of Object.entries(env)) process.env[k] = v;
      const cli = loadCli(script, {
        argv: ['--working-dir', working, '--eval', '4', '--slug', 'runner-gap', '--force', ...extraArgs],
      });
      cli.main();
      const summary = logs.length ? JSON.parse(logs[logs.length - 1]) : null;
      return { cli, summary, marker: fs.readFileSync(marker, 'utf8'), errs: errs.slice() };
    }

    const skipped = run(['--skip-verify'], { CAPTURE_L1_CODE: '1', CAPTURE_L2_CODE: '1' });
    assert.equal(skipped.cli.exitCode, null);
    assert.equal(skipped.marker, '', '--skip-verify must not start either runner');
    assert.equal(skipped.summary.layer1, undefined);
    assert.equal(skipped.summary.layer2, undefined);
    assert.ok(skipped.summary.fixtureDir.startsWith(path.join(evalDir, 'fixtures')), skipped.summary.fixtureDir);

    const failingTap = [
      'TAP version 13',
      '# tests 3',
      '# pass  2',
      '# fail  1',
      '# skip  0',
      '    not ok 2 - runner refused the captured fixture',
      '',
    ].join('\n');
    const failed = run([], {
      CAPTURE_L1_TAP: failingTap,
      CAPTURE_L1_CODE: '1',
      CAPTURE_L2_TAP: '# tests 4\n# pass  4\n# fail  0\n# skip  0\n',
      CAPTURE_L2_CODE: '0',
    });
    assert.equal(failed.marker, '1 --eval 4\n2 --eval 4\n', 'both layers run, scoped to the captured eval id');
    assert.equal(failed.summary.layer1.fail, 1);
    assert.deepEqual(failed.summary.layer1.failures, ['not ok 2 - runner refused the captured fixture']);
    assert.equal(failed.summary.layer2.pass, 4);
    assert.deepEqual(failed.summary.layer2.failures, []);
    assert.equal(looksVerified(failed.summary.layer1), false);
    // The runner's status is reported; the process still exits 0 — the files were captured, and the
    // summary is how a capture is judged.
    assert.equal(failed.summary.layer1.exitCode, 1);
    assert.equal(failed.summary.layer2.exitCode, 0);
    assert.equal(failed.cli.exitCode, null);

    const empty = run([], { CAPTURE_L1_TAP: '', CAPTURE_L1_CODE: '1', CAPTURE_L2_TAP: '', CAPTURE_L2_CODE: '2' });
    assert.deepEqual(empty.summary.layer1, { tests: 0, pass: 0, fail: 0, skip: 0, exitCode: 1,
      failures: ['runner exited 1 without reporting a failing assertion — its result is not verified'] });
    assert.deepEqual(empty.summary.layer2, { tests: 0, pass: 0, fail: 0, skip: 0, exitCode: 2,
      failures: ['runner exited 2 without reporting a failing assertion — its result is not verified'] });
    assert.equal(looksVerified(empty.summary.layer1), false, 'empty runner output is not a verified pass');
    assert.equal(empty.cli.exitCode, null);

    // A runner that exits 0 having checked nothing has verified nothing.
    const none = run([], { CAPTURE_L1_TAP: '# tests 0\n# pass  0\n# fail  0\n# skip  0\n', CAPTURE_L1_CODE: '0',
      CAPTURE_L2_TAP: '# tests 2\n# pass  2\n# fail  0\n# skip  0\n', CAPTURE_L2_CODE: '0' });
    assert.deepEqual(none.summary.layer1.failures, ['runner reported no assertions for this eval — nothing was verified']);
    assert.deepEqual(none.summary.layer2.failures, [], 'a real pass stays clean');

    const malformed = run([], {
      CAPTURE_L1_TAP: 'this is not tap\n    not ok 1 - malformed runner output\n',
      CAPTURE_L1_CODE: '3',
      CAPTURE_L2_TAP: 'also not tap\n',
      CAPTURE_L2_CODE: '3',
    });
    assert.deepEqual(malformed.summary.layer1.failures, ['not ok 1 - malformed runner output']);
    assert.equal(malformed.summary.layer1.pass, 0);
    assert.equal(looksVerified(malformed.summary.layer1), false, 'malformed runner output must not look verified');
    assert.equal(looksVerified(malformed.summary.layer2), false);

    // A runner that exits nonzero while printing a clean-looking TAP summary has not passed: its exit
    // code was computed and then dropped, so this used to read as a verified capture.
    const hidden = run([], {
      CAPTURE_L1_TAP: '# tests 5\n# pass  5\n# fail  0\n# skip  0\n',
      CAPTURE_L1_CODE: '1',
      CAPTURE_L2_TAP: '# tests 1\n# pass  1\n# fail  0\n# skip  0\n',
      CAPTURE_L2_CODE: '1',
    });
    assert.equal(hidden.summary.layer1.pass, 5);
    assert.equal(hidden.summary.layer1.fail, 0);
    assert.equal(hidden.summary.layer1.exitCode, 1);
    assert.deepEqual(hidden.summary.layer1.failures, ['runner exited 1 without reporting a failing assertion — its result is not verified']);
    assert.equal(hidden.cli.exitCode, null);
    assert.equal(looksVerified(hidden.summary.layer1), false, 'a nonzero runner exit is never a verified pass');
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    if (prevDirname === undefined) delete global.__dirname;
    else global.__dirname = prevDirname;
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(working, { recursive: true, force: true });
  }
});
