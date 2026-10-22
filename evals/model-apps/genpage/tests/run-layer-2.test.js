'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const runner = path.join(__dirname, '..', 'run-layer-2.js');

function mkTempFixturesDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'layer2-tests-'));
}

function writeFixture(rootDir, fixtureName, files) {
  const dir = path.join(rootDir, fixtureName);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
}

function runRunner(args, nodeArgs = []) {
  const result = spawnSync(process.execPath, [...nodeArgs, runner, ...args], { encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// ---------- end-to-end: green-path fixture ----------

test('runner: exits 0 when fixture passes all assertions', () => {
  const root = mkTempFixturesDir();
  try {
    // Minimal v2.1-compliant single-file mock page.
    writeFixture(root, '2-mock-clean', {
      'page.tsx': `import { makeStyles, tokens } from '@fluentui/react-components';
const useStyles = makeStyles({ root: { padding: tokens.spacingHorizontalM } });
const data = [{ a: 1, b: 'x' }, { a: 2, b: 'y' }];
const GeneratedComponent = (props) => {
  const { pageInput } = props;
  void pageInput;
  const styles = useStyles();
  return <div className={styles.root}>{data.length}</div>;
};
export default GeneratedComponent;`,
    });
    const { code } = runRunner(['--fixtures', root, '--eval', '2']);
    assert.equal(code, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- end-to-end: failing fixture ----------

test('runner: exits 1 when fixture has 100vh violation', () => {
  const root = mkTempFixturesDir();
  try {
    writeFixture(root, '2-bad', {
      'page.tsx': `import { makeStyles } from '@fluentui/react-components';
const useStyles = makeStyles({ root: { height: '100vh' } });
const data = [{ a: 1 }, { a: 2 }];
const GeneratedComponent = (props) => {
  const { pageInput } = props;
  void pageInput;
  return <div style={{ height: '100vh' }} />;
};
export default GeneratedComponent;`,
    });
    const { code, stdout } = runRunner(['--fixtures', root, '--eval', '2']);
    assert.equal(code, 1);
    assert.match(stdout, /not ok \d+ - Generated \.tsx does NOT use `100vh`/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- end-to-end: empty fixture ----------

test('runner: fails when fixture has no .tsx files', () => {
  const root = mkTempFixturesDir();
  try {
    fs.mkdirSync(path.join(root, '2-empty'));
    fs.writeFileSync(path.join(root, '2-empty', 'workflow-log.md'), '# log\n');
    const { code, stdout } = runRunner(['--fixtures', root, '--eval', '2']);
    assert.equal(code, 1);
    assert.match(stdout, /fixture has at least one \.tsx file/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- end-to-end: filter by tier ----------

test('runner: --tier smoke filters to smoke evals only', () => {
  const root = mkTempFixturesDir();
  try {
    // eval 2 is smoke; eval 4 is full
    writeFixture(root, '2-smoke', {
      'page.tsx': `import { makeStyles } from '@fluentui/react-components';
const useStyles = makeStyles({ r: {} });
const data = [{ a: 1 }, { a: 2 }];
const GeneratedComponent = (props) => { const { pageInput } = props; void pageInput; return <div/>; };
export default GeneratedComponent;`,
    });
    writeFixture(root, '4-full', {
      'page.tsx': `import { makeStyles } from '@fluentui/react-components';
const useStyles = makeStyles({ r: {} });
const data = [{ a: 1 }, { a: 2 }];
const GeneratedComponent = (props) => { const { pageInput } = props; void pageInput; return <div/>; };
export default GeneratedComponent;`,
    });
    const { code, stdout } = runRunner(['--fixtures', root, '--tier', 'smoke']);
    assert.equal(code, 0);
    assert.match(stdout, /# Subtest: 2-smoke/);
    assert.doesNotMatch(stdout, /# Subtest: 4-full/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- end-to-end: --eval flag ----------

test('runner: --eval <id> runs only that eval id', () => {
  const root = mkTempFixturesDir();
  try {
    writeFixture(root, '2-x', {
      'page.tsx': `import { makeStyles } from '@fluentui/react-components';
const useStyles = makeStyles({ r: {} });
const data = [{ a: 1 }, { a: 2 }];
const GeneratedComponent = (props) => { const { pageInput } = props; void pageInput; return <div/>; };
export default GeneratedComponent;`,
    });
    writeFixture(root, '4-y', {
      'page.tsx': `// won't be selected`,
    });
    const { code, stdout } = runRunner(['--fixtures', root, '--eval', '2']);
    assert.equal(code, 0);
    assert.match(stdout, /1\.\.1/);
    assert.match(stdout, /# Subtest: 2-x/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- end-to-end: missing fixtures dir ----------

test('runner: exits 2 when fixtures dir missing', () => {
  const { code, stderr } = runRunner(['--fixtures', '/nonexistent/path/that/does/not/exist']);
  assert.equal(code, 2);
  assert.match(stderr, /Fixtures directory does not exist/);
});

// ---------- end-to-end: malformed fixture folder name ----------

test('runner: skips folders without numeric prefix', () => {
  const root = mkTempFixturesDir();
  try {
    writeFixture(root, 'not-a-fixture', { 'page.tsx': `export default x;` });
    writeFixture(root, '2-valid', {
      'page.tsx': `import { makeStyles } from '@fluentui/react-components';
const useStyles = makeStyles({ r: {} });
const data = [{ a: 1 }, { a: 2 }];
const GeneratedComponent = (props) => { const { pageInput } = props; void pageInput; return <div/>; };
export default GeneratedComponent;`,
    });
    const { code, stdout } = runRunner(['--fixtures', root]);
    assert.equal(code, 0);
    assert.match(stdout, /1\.\.1/);
    assert.doesNotMatch(stdout, /not-a-fixture/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- end-to-end: TAP shape ----------

test('runner: emits TAP version 13 header and aggregate counts', () => {
  const root = mkTempFixturesDir();
  try {
    writeFixture(root, '2-x', {
      'page.tsx': `import { makeStyles } from '@fluentui/react-components';
const useStyles = makeStyles({ r: {} });
const data = [{ a: 1 }, { a: 2 }];
const GeneratedComponent = (props) => { const { pageInput } = props; void pageInput; return <div/>; };
export default GeneratedComponent;`,
    });
    const { stdout } = runRunner(['--fixtures', root]);
    assert.match(stdout, /^TAP version 13/m);
    assert.match(stdout, /# tests \d+/);
    assert.match(stdout, /# pass\s+\d+/);
    assert.match(stdout, /# fail\s+\d+/);
    assert.match(stdout, /# skip\s+\d+/);
    assert.match(stdout, /# fixtures \d+/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- fixture-loader: RuntimeTypes excluded ----------

test('fixture-loader: excludes RuntimeTypes.ts from check', () => {
  const root = mkTempFixturesDir();
  try {
    writeFixture(root, '2-rt-test', {
      'page.tsx': `import { makeStyles } from '@fluentui/react-components';
const useStyles = makeStyles({ r: {} });
const data = [{ a: 1 }, { a: 2 }];
const GeneratedComponent = (props) => { const { pageInput } = props; void pageInput; return <div/>; };
export default GeneratedComponent;`,
      'RuntimeTypes.tsx': `// This file should be excluded from checks - it has TODO`,
    });
    const { code, stdout } = runRunner(['--fixtures', root, '--eval', '2']);
    assert.equal(code, 0);
    // The TODO inside RuntimeTypes.tsx must not cause the TODO assertion to fail.
    assert.doesNotMatch(stdout, /not ok \d+ - .*TODO/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runner: the registered Phase-5b column checker executes and can fail the replay', (t) => {
  const root = mkTempFixturesDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeFixture(root, '1-phase-5b', {
    'page.tsx': `import { makeStyles } from '@fluentui/react-components';
const useStyles = makeStyles({ root: {} });
const data = [{ name: 'First' }, { name: 'Second' }];
const GeneratedComponent = (props) => {
  const { pageInput } = props;
  void pageInput;
  const styles = useStyles();
  return <div className={styles.root}>{data.length}</div>;
};
export default GeneratedComponent;`,
  });
  const args = ['--fixtures', root, '--eval', '1'];
  const green = runRunner(args);
  assert.equal(green.code, 0, green.stdout + green.stderr);
  assert.match(green.stdout, /Phase 5b: Generated \.tsx uses only column names verified from RuntimeTypes\.ts/);
  assert.match(green.stdout, /# SKIP column-name verification requires RuntimeTypes\.ts fixture/);

  // The column oracle is intentionally still a SKIP. Inject a failing result at its real
  // registry entry to prove routing invokes that callback and propagates failure, not just text.
  const preload = path.join(root, 'phase-5b-probe.cjs');
  const library = path.join(__dirname, '..', 'lib', 'assertions-layer-2.js');
  fs.writeFileSync(preload, `
const { PHASE5_EXPECTATIONS } = require(${JSON.stringify(library)});
const text = [...PHASE5_EXPECTATIONS.keys()].find((key) => key.startsWith('Phase 5b: Generated .tsx uses only column names'));
const original = PHASE5_EXPECTATIONS.get(text);
PHASE5_EXPECTATIONS.set(text, (args) => ({ status: 'fail', reason: 'Phase-5b callback executed: ' + original(args).reason }));
`);
  const red = runRunner(args, ['--require', preload]);
  assert.equal(red.code, 1, red.stdout + red.stderr);
  assert.match(red.stdout, /not ok \d+ - Phase 5b: Generated \.tsx uses only column names/);
  assert.match(red.stdout, /Phase-5b callback executed: column-name verification requires RuntimeTypes\.ts fixture/);
});

test('runner routing and lookup functions expose every registered phase check', () => {
  const workflow = require('../run-layer-1.js');
  const code = require('../run-layer-2.js');
  const { PHASE_EXPECTATIONS } = require('../lib/assertions-layer-1.js');
  const { PHASE5_EXPECTATIONS } = require('../lib/assertions-layer-2.js');
  assert.equal(typeof workflow.isPhaseExpectation, 'function');
  assert.equal(typeof workflow.getExpectationCheck, 'function');
  assert.equal(typeof code.isPhase5Expectation, 'function');
  assert.equal(typeof code.getExpectationCheck, 'function');
  for (const [text, check] of PHASE_EXPECTATIONS) {
    assert.equal(workflow.isPhaseExpectation(text), true, text);
    assert.equal(workflow.getExpectationCheck(text), check, text);
  }
  for (const [text, check] of PHASE5_EXPECTATIONS) {
    assert.equal(code.isPhase5Expectation(text), true, text);
    assert.equal(code.getExpectationCheck(text), check, text);
  }
  for (const text of ['Phase 5a: unknown', 'Phase 5b: unknown', 'Phase 5c: unknown', 'Phase 5: unknown']) {
    assert.equal(code.isPhase5Expectation(text), true, text);
    assert.equal(code.getExpectationCheck(text), undefined, text);
  }
  assert.equal(code.isPhase5Expectation('Phase 50: wrong phase'), false);
  assert.equal(code.isPhase5Expectation('Edit Phase 5: not routed by this layer'), false);
  assert.equal(workflow.getExpectationCheck('Phase 1: unregistered'), undefined);
  assert.equal(code.getExpectationCheck('Phase 1: unregistered'), undefined);
});
