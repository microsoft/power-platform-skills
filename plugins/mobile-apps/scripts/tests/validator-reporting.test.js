'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const PLUGIN_ROOT = path.resolve(__dirname, '../..');
const CLEAN = 'export const Content = () => <Text color="$color12">Ready</Text>;\n';
const FINDING = 'export const Content = () => (\n  <Text color="#abcdef">Review</Text>\n);\n';
const VALIDATORS = ['validate-screen-quality', 'validate-color-contrast'];

function fixture(t, files = {}) {
  // Keep generated CLI fixtures inside the project, outside the excluded tests/
  // ancestry, so production path filtering is exercised without test overrides.
  const root = path.resolve(`.validator-reporting-fixture-${randomUUID()}`);
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

function invoke(validator, cwd, args, input = '') {
  const result = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'hooks', `${validator}.js`), ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function report(validator, cwd, args = ['--report', '--strict']) {
  const result = invoke(validator, cwd, args);
  const json = JSON.parse(result.stdout);
  assert.equal(json.validator, validator);
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.evidence, 'source-pattern-heuristics');
  assert.equal(json.exitCode, result.status);
  assert.equal(json.passed, json.status === 'clean');
  assert.equal(json.coverage.pathBase, cwd);
  assert.ok(Array.isArray(json.issues));
  assert.ok(Array.isArray(json.errors));
  assert.match(json.limitations.join('\n'), /No rendered WCAG contrast ratios/);
  assert.match(json.limitations.join('\n'), /false positives and false negatives/);
  return { ...result, json };
}

test('self-closing icon buttons and compound text do not absorb later controls', t => {
  const source = `export const Header = () => <YStack>
    <Button onPress={() => goBack()} aria-label="Back" icon={<Ionicons name="chevron-back" />} />
    <Text>Heading</Text>
    <Button onPress={() => openDetails()}><Button.Text>Details</Button.Text></Button>
  </YStack>;
  export const Footer = () => <Button onPress={() => save()}>Save</Button>;`;
  const root = fixture(t, { 'src/components/Navigation.tsx': source });
  const { status, json } = report('validate-screen-quality', root, ['--report', '--strict', 'src/components/Navigation.tsx']);
  assert.equal(status, 0);
  assert.deepEqual(json.issues, []);
});

test('balanced icon props still allow real nested touch targets to be detected', t => {
  const source = `export const Row = () => <Button onPress={() => open()} icon={<Ionicons name="book" />}>
    <Button onPress={() => remove()}>Remove</Button>
  </Button>;`;
  const root = fixture(t, { 'src/components/Row.tsx': source });
  const { status, json } = report('validate-screen-quality', root, ['--report', '--strict', 'src/components/Row.tsx']);
  assert.equal(status, 1);
  assert.ok(json.issues.some(issue => issue.rule === 'nested-touch-targets'));
});

for (const validator of VALIDATORS) {
  test(`${validator}: explicit clean file reports exact source coverage, not rendered approval`, (t) => {
    const root = fixture(t, { 'app/home.tsx': CLEAN, 'app/not-requested.tsx': FINDING });
    const { status, stderr, json } = report(validator, root, ['--report', '--strict', 'app/home.tsx']);
    assert.equal(status, 0);
    assert.equal(stderr, '');
    assert.equal(json.status, 'clean');
    assert.equal(json.strict, true);
    assert.equal(json.coverage.defaultTargetUsed, false);
    assert.deepEqual(json.coverage.requestedTargets, ['app/home.tsx']);
    assert.deepEqual(json.coverage.scannedFiles, ['app/home.tsx']);
    assert.deepEqual(json.coverage.skipped, []);
    assert.deepEqual(json.issues, []);
    assert.deepEqual(json.errors, []);
  });

  test(`${validator}: strict findings fail while legacy report JSON stays compatible`, (t) => {
    const root = fixture(t, { 'app/home.tsx': FINDING });
    const strict = report(validator, root, ['--report', '--strict', 'app/home.tsx']);
    const informational = report(validator, root, ['--report', 'app/home.tsx']);
    assert.equal(strict.status, 1);
    assert.equal(informational.status, 0);
    assert.equal(strict.json.status, 'findings');
    assert.equal(informational.json.status, 'findings');
    assert.equal(informational.json.passed, false);
    assert.match(informational.stderr, /use --report --strict as the workflow gate/);
    assert.deepEqual(strict.json.issues, informational.json.issues);
    assert.deepEqual(strict.json.errors, []);
    const issue = strict.json.issues[0];
    assert.equal(issue.validator, validator);
    assert.equal(issue.file, 'app/home.tsx');
    assert.equal(issue.line, 2);
    assert.match(issue.rule, /raw-hex|hex-on-color-prop/);
    assert.ok(issue.match.includes('#abcdef'));
    assert.equal(typeof issue.fix, 'string');
    assert.equal(typeof issue.autoFixable, 'boolean');
  });

  test(`${validator}: missing targets cannot become clean, including alongside findings`, (t) => {
    const root = fixture(t, { 'app/home.tsx': FINDING });
    for (const args of [
      ['--report', 'app/missing.tsx'],
      ['--report', '--strict', 'missing-directory'],
      ['--report', '--strict', 'app/home.tsx', 'app/missing.tsx'],
    ]) {
      const { status, json } = report(validator, root, args);
      assert.equal(status, 2);
      assert.equal(json.status, 'incomplete');
      assert.ok(json.errors.some((error) => error.code === 'ENOENT'));
      if (args.includes('app/home.tsx')) {
        assert.ok(json.issues.length > 0);
        assert.deepEqual(json.coverage.scannedFiles, ['app/home.tsx']);
      } else {
        assert.deepEqual(json.coverage.scannedFiles, []);
        assert.ok(json.errors.some((error) => error.code === 'NO_SCANNED_FILES'));
      }
    }
  });

  test(`${validator}: directory reports enumerate exact inspected files and honest exclusions`, (t) => {
    const root = fixture(t, {
      'app/z.tsx': CLEAN,
      'app/nested/a.TSX': CLEAN,
      'src/components/card.tsx': CLEAN,
      'app/_layout.tsx': FINDING,
      'app/card.test.tsx': FINDING,
      'app/card.spec.tsx': FINDING,
      'app/page.jsx': FINDING,
      'src/util.ts': CLEAN,
      'src/generated/service.tsx': FINDING,
      'app/tests/ignored.tsx': FINDING,
      'app/__tests__/ignored.tsx': FINDING,
      'app/__mocks__/ignored.tsx': FINDING,
      'brand/tokens.ts': FINDING,
      'node_modules/package/index.tsx': FINDING,
      '.git/ignored.tsx': FINDING,
      '.expo/ignored.tsx': FINDING,
      'dist/ignored.tsx': FINDING,
      'build/ignored.tsx': FINDING,
      'shared/samples/app/ignored.tsx': FINDING,
    });
    const first = report(validator, root);
    const second = report(validator, root);
    assert.equal(first.stdout, second.stdout, 'directory order must be deterministic');
    assert.equal(first.status, 0);
    assert.equal(first.json.coverage.defaultTargetUsed, true);
    assert.deepEqual(first.json.coverage.scannedFiles, ['app/nested/a.TSX', 'app/z.tsx', 'src/components/card.tsx']);
    const skipped = new Map(first.json.coverage.skipped.map((entry) => [entry.path, entry]));
    for (const [target, reason] of [
      ['app/_layout.tsx', 'route-layout'],
      ['app/card.test.tsx', 'test-source'],
      ['app/card.spec.tsx', 'test-source'],
      ['app/page.jsx', 'unsupported-extension'],
      ['src/util.ts', 'unsupported-extension'],
      ['src/generated', 'generated-source'],
      ['app/tests', 'test-source'],
      ['app/__tests__', 'test-source'],
      ['app/__mocks__', 'test-source'],
      ['brand', 'brand-definition-directory'],
      ['node_modules', 'dependency-directory'],
      ['.git', 'version-control-directory'],
      ['.expo', 'generated-build-directory'],
      ['dist', 'generated-build-directory'],
      ['build', 'generated-build-directory'],
      ['shared/samples', 'plugin-sample-source'],
    ]) {
      assert.equal(skipped.get(target)?.reason, reason, target);
    }
    for (const entry of skipped.values()) {
      if (entry.kind === 'directory') assert.equal(entry.descendants, 'not-enumerated');
    }
    assert.ok(!skipped.has('src/generated/service.tsx'), 'pruned descendants must not be claimed as enumerated');
  });

  test(`${validator}: unsupported or explicitly excluded sources alone never pass`, (t) => {
    const root = fixture(t, {
      'app/home.ts': CLEAN,
      'app/home.jsx': CLEAN,
      'app/_layout.tsx': FINDING,
      'src/generated/service.tsx': FINDING,
      'app/tests/home.tsx': FINDING,
    });
    for (const target of ['app/home.ts', 'app/home.jsx', 'app/_layout.tsx', 'src/generated/service.tsx', 'app/tests/home.tsx']) {
      const { status, json } = report(validator, root, ['--report', '--strict', target]);
      assert.equal(status, 2, target);
      assert.equal(json.status, 'incomplete');
      assert.deepEqual(json.coverage.scannedFiles, []);
      assert.equal(json.coverage.skipped[0].path, target);
      assert.equal(json.coverage.skipped[0].kind, 'file');
      assert.ok(json.errors.some((error) => error.code === 'NO_SCANNED_FILES'));
    }
  });

  test(`${validator}: empty directories and empty TSX cannot produce a clean report`, (t) => {
    const root = fixture(t);
    const emptyDirectory = report(validator, root);
    assert.equal(emptyDirectory.status, 2);
    assert.equal(emptyDirectory.json.status, 'incomplete');
    assert.deepEqual(emptyDirectory.json.coverage.scannedFiles, []);
    fs.mkdirSync(path.join(root, 'app'));
    fs.writeFileSync(path.join(root, 'app/empty.tsx'), ' \n');
    fs.writeFileSync(path.join(root, 'app/home.tsx'), CLEAN);
    const emptySource = report(validator, root);
    assert.equal(emptySource.status, 2);
    assert.ok(emptySource.json.errors.some((error) => error.code === 'EMPTY_SOURCE'));
    assert.deepEqual(emptySource.json.coverage.scannedFiles, ['app/home.tsx']);
    assert.equal(emptySource.json.coverage.skipped[0].reason, 'empty-source');
  });

  test(`${validator}: invalid options are reported, not mistaken for successful empty scans`, (t) => {
    const root = fixture(t, { 'app/home.tsx': CLEAN });
    for (const args of [
      ['--report', '--strcit', 'app/home.tsx'],
      ['--strict', 'app/home.tsx'],
      ['--report', '--strict', '--', ''],
    ]) {
      const { status, json } = report(validator, root, args);
      assert.equal(status, 2);
      assert.equal(json.status, 'incomplete');
      assert.ok(json.errors.some((error) => error.code === 'USAGE'));
      assert.deepEqual(json.coverage.scannedFiles, []);
    }
    const help = invoke(validator, root, ['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--report \[--strict\]/);
    assert.match(help.stdout, /2 = incomplete scan/);
    assert.match(help.stdout, /Neither a clean report nor exit 0 proves/);
  });

  test(`${validator}: option terminator accepts dash-prefixed target paths`, (t) => {
    const root = fixture(t, { '-screens/app/home.tsx': CLEAN });
    const { status, json } = report(validator, root, ['--report', '--strict', '--', '-screens/app/home.tsx']);
    assert.equal(status, 0);
    assert.deepEqual(json.coverage.scannedFiles, ['-screens/app/home.tsx']);
  });

  test(`${validator}: overlapping targets and nested recursion inspect each file once`, (t) => {
    const nested = `app/${'nested/'.repeat(40)}home.tsx`;
    const root = fixture(t, { 'app/z.tsx': FINDING, [nested]: CLEAN });
    const { status, json } = report(validator, root, ['--report', '--strict', 'app', 'app/z.tsx', 'app']);
    assert.equal(status, 1);
    assert.deepEqual(json.coverage.scannedFiles, [nested, 'app/z.tsx']);
    assert.equal(json.issues.length, 1);
    assert.deepEqual(json.coverage.skipped.map((entry) => entry.reason), ['already-visited', 'already-visited']);
  });

  test(`${validator}: symlink cycles, linked files, and linked ancestors are not followed`, { skip: process.platform === 'win32' }, (t) => {
    const root = fixture(t, { 'app/home.tsx': CLEAN, 'outside.tsx': FINDING });
    fs.symlinkSync('.', path.join(root, 'app/loop'));
    fs.symlinkSync('../outside.tsx', path.join(root, 'app/linked.tsx'));
    fs.symlinkSync('../missing.tsx', path.join(root, 'app/broken.tsx'));
    const { status, json } = report(validator, root, ['--report', '--strict', 'app', 'app/loop/home.tsx']);
    assert.equal(status, 0);
    assert.deepEqual(json.coverage.scannedFiles, ['app/home.tsx']);
    assert.deepEqual(json.issues, []);
    assert.equal(json.coverage.skipped.filter((entry) => entry.reason === 'symbolic-link-not-followed').length, 3);
    assert.ok(json.coverage.skipped.some((entry) => entry.path === 'app/loop/home.tsx' && entry.reason === 'symbolic-link-ancestor'));
    const onlyLink = report(validator, root, ['--report', '--strict', 'app/linked.tsx']);
    assert.equal(onlyLink.status, 2);
    assert.equal(onlyLink.json.status, 'incomplete');
  });

  test(`${validator}: unreadable files and directories fail without discarding other findings`, (t) => {
    if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
      t.skip('POSIX read-permission failures require a non-root user.');
      return;
    }
    const root = fixture(t, { 'app/home.tsx': FINDING, 'app/private.tsx': CLEAN, 'app/private-directory/home.tsx': CLEAN });
    const locked = [path.join(root, 'app/private.tsx'), path.join(root, 'app/private-directory')];
    let result;
    try {
      for (const target of locked) fs.chmodSync(target, 0);
      result = report(validator, root);
    } finally {
      fs.chmodSync(locked[0], 0o600);
      fs.chmodSync(locked[1], 0o700);
    }
    assert.equal(result.status, 2);
    assert.equal(result.json.status, 'incomplete');
    assert.deepEqual(result.json.coverage.scannedFiles, ['app/home.tsx']);
    assert.ok(result.json.issues.length > 0);
    assert.ok(result.json.errors.some((error) => error.path === 'app/private.tsx' && error.operation === 'read' && error.code === 'EACCES'));
    assert.ok(result.json.errors.some((error) => error.path === 'app/private-directory' && error.operation === 'readdir' && error.code === 'EACCES'));
  });

  test(`${validator}: source text is never executed or imported`, (t) => {
    const root = fixture(t, {
      'app/home.tsx': `throw new Error('source must not execute');\nrequire('node:fs').writeFileSync('executed.txt', 'bad');\n${CLEAN}`,
    });
    const { status, json } = report(validator, root);
    assert.equal(status, 0);
    assert.deepEqual(json.coverage.scannedFiles, ['app/home.tsx']);
    assert.equal(fs.existsSync(path.join(root, 'executed.txt')), false);
  });

  test(`${validator}: the existing explicit dispatcher stdin contract remains usable`, (t) => {
    const root = fixture(t);
    const payload = (content) => JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: path.join(root, 'app/home.tsx'), content },
    });
    assert.equal(invoke(validator, root, [], payload(CLEAN)).status, 0);
    const finding = invoke(validator, root, [], payload(FINDING));
    assert.equal(finding.status, 2);
    assert.equal(finding.stdout, '');
    assert.match(finding.stderr, /heuristics/);
    assert.doesNotMatch(finding.stderr, /would fail WCAG|pre-tested for AA/);
    assert.equal(invoke(validator, root, [], 'not JSON').status, 0);
    const missing = invoke(validator, root, [], JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(root, 'app/missing.tsx') } }));
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Validation is incomplete/);
  });
}

test('the screen validator retains its narrower app/component scope', (t) => {
  const root = fixture(t, { 'other/home.tsx': CLEAN });
  const screen = report('validate-screen-quality', root, ['--report', '--strict', 'other/home.tsx']);
  assert.equal(screen.status, 2);
  assert.equal(screen.json.coverage.skipped[0].reason, 'outside-screen-scope');
  const contrast = report('validate-color-contrast', root, ['--report', '--strict', 'other/home.tsx']);
  assert.equal(contrast.status, 0);
  assert.deepEqual(contrast.json.coverage.scannedFiles, ['other/home.tsx']);
});

test('existing contrast signals remain findings without claiming measured ratios', (t) => {
  const root = fixture(t, {
    'app/home.tsx': [
      '<Text color="#abc">Hex</Text>',
      '<Text color={active ? "#aaa" : "#bbb"}>Conditional</Text>',
      '<Text color="rgba(255,255,255,0.7)">Alpha</Text>',
      '<View borderColor="rgba(255,255,255,0.4)" />',
      '<Text color="$color8">Faint</Text>',
      'const style = { color: "$gray7" };',
      '<Badge bg="$yellow9" color="white">Status</Badge>',
      '<Badge color="white" bg="$orange9">Status</Badge>',
    ].join('\n'),
  });
  const { status, json } = report('validate-color-contrast', root);
  assert.equal(status, 1);
  for (const rule of ['hex-on-color-prop', 'hex-on-color-prop (ternary)', 'low-alpha text', 'low-alpha border', 'low-contrast foreground token', 'white text on yellow/orange status fill']) {
    assert.ok(json.issues.some((issue) => issue.rule.startsWith(rule)), rule);
  }
  assert.equal(json.issues.filter((issue) => issue.rule === 'low-contrast foreground token').length, 2);
  assert.equal(json.issues.filter((issue) => issue.rule === 'white text on yellow/orange status fill').length, 2);
  assert.doesNotMatch(JSON.stringify(json), /needs ≥0\.85 for AA|needs ≥0\.65 for UI|pre-tested for AA/);
});

test('existing screen source-pattern findings remain actionable', (t) => {
  const root = fixture(t, {
    'app/home.tsx': [
      'export default function HomeScreen() {',
      'return <YStack color="$color" shadowOpacity={0.2}>',
      '<Text color="#abcdef">Ready</Text>',
      '<Button icon={Close} size="$1" />',
      '</YStack>;',
      '}',
    ].join('\n'),
  });
  const { status, json } = report('validate-screen-quality', root);
  assert.equal(status, 1);
  for (const rule of ['vague-token', 'raw-hex', 'inline-shadow', 'missing-safe-area-chrome', 'icon-only-control-missing-label', 'small-touch-target-without-hitslop']) {
    assert.ok(json.issues.some((issue) => issue.rule === rule && issue.fix.length > 0), rule);
  }
});

for (const [ownership, props] of [
  ['default bar-owned inset', ''],
  ['explicit parent delegation', ' includeBottomInset={false}'],
]) {
  test(`top-only safe area with ${ownership} does not demand double insets`, (t) => {
    const content = [
      'export default function FooterScreen() {',
      "return <SafeAreaView edges={['top']}>",
      `<BottomActionBar${props}><Text color="$color12">Actions</Text></BottomActionBar>`,
      '</SafeAreaView>;',
      '}',
    ].join('\n');
    const root = fixture(t, { 'app/footer.tsx': content });
    const { status, json } = report('validate-screen-quality', root, ['--report', '--strict', 'app/footer.tsx']);
    assert.equal(status, 0);
    assert.deepEqual(json.issues, []);
    assert.deepEqual(json.coverage.scannedFiles, ['app/footer.tsx']);
    assert.match(json.limitations.join('\n'), /Bottom inset ownership is not resolved/);
    assert.match(json.limitations.join('\n'), /Verify a single inset owner/);
    const legacy = invoke('validate-screen-quality', root, [], JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: path.join(root, 'app/footer.tsx'), content },
    }));
    assert.equal(legacy.status, 0);
    assert.equal(legacy.stderr, '');
  });
}

test('absolute-bottom source checks remain active without prescribing bar ownership', (t) => {
  for (const [bottom, expectedStatus] of [['0', 1], ['insets.bottom + 16', 0]]) {
    const root = fixture(t, {
      'app/footer.tsx': [
        'export default function FooterScreen() {',
        "return <SafeAreaView edges={['top']}>",
        `<YStack position="absolute" bottom={${bottom}}><Text color="$color12">Actions</Text></YStack>`,
        '<BottomActionBar includeBottomInset={false} />',
        '</SafeAreaView>;',
        '}',
      ].join('\n'),
    });
    const { status, json } = report('validate-screen-quality', root);
    assert.equal(status, expectedStatus);
    assert.deepEqual(json.issues.map((issue) => issue.rule), expectedStatus ? ['absolute-bottom-without-inset'] : []);
    assert.ok(!json.issues.some((issue) => issue.fix.includes("edges={['top', 'bottom']}")));
  }
});
