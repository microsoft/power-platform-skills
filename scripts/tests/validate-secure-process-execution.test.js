'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  AUDITED_EXCEPTIONS,
  analyzeSource,
  applyAuditedExceptions,
  auditRepository,
  listProductionJavaScript,
  shouldScan,
  validateExceptions,
} = require('../validate-secure-process-execution');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'secure-process-execution');
const VALIDATOR = path.join(REPOSITORY_ROOT, 'scripts', 'validate-secure-process-execution.js');

function fixture(group, name) {
  const filePath = path.join(FIXTURES, group, name);
  return {
    path: `fixtures/${group}/${name}`,
    source: fs.readFileSync(filePath, 'utf8'),
  };
}

for (const name of fs.readdirSync(path.join(FIXTURES, 'pass')).sort()) {
  test(`accepts safe fixture: ${name}`, () => {
    const input = fixture('pass', name);
    assert.deepEqual(analyzeSource(input.source, input.path), []);
  });
}

const FAILING_FIXTURES = new Map([
  ['ambiguous-options.js', 'ambiguous-shell-option'],
  ['computed-member.js', 'ambiguous-child-process-call'],
  ['computed-direct-require.js', 'nonconstant-shell-command'],
  ['concatenated-command.js', 'concatenated-shell-command'],
  ['default-esm-import.mjs', 'nonconstant-shell-command'],
  ['direct-require.js', 'concatenated-shell-command'],
  ['division-after-postfix.js', 'nonconstant-shell-command'],
  ['dynamic-executable.js', 'nonconstant-executable'],
  ['dynamic-template.js', 'dynamic-shell-command'],
  ['duplicate-shell-property.js', 'shell-true'],
  ['escaped-module-specifier.js', 'nonconstant-shell-command'],
  ['escaped-shell-property.js', 'shell-true'],
  ['even-escaped-template.js', 'dynamic-shell-command'],
  ['indirect-shell-true.js', 'shell-true'],
  ['nonconstant-command.js', 'nonconstant-shell-command'],
  ['octal-module-specifier.js', 'nonconstant-shell-command'],
  ['octal-shell-property.js', 'shell-true'],
  ['optional-call.js', 'nonconstant-shell-command'],
  ['optional-computed-call.js', 'nonconstant-shell-command'],
  ['optional-computed-namespace.js', 'nonconstant-shell-command'],
  ['optional-namespace-call.js', 'nonconstant-shell-command'],
  ['parameter-shadow.js', 'nonconstant-shell-command'],
  ['parenthesized-method.js', 'nonconstant-shell-command'],
  ['parenthesized-namespace-method.js', 'nonconstant-shell-command'],
  ['parenthesized-require.js', 'nonconstant-shell-command'],
  ['pre-fix-activation.js', 'dynamic-shell-command'],
  ['quoted-shell-true.js', 'shell-true'],
  ['shadowed-constant.js', 'nonconstant-shell-command'],
  ['shell-true.js', 'shell-true'],
  ['spread-shell-options.js', 'ambiguous-shell-option'],
  ['two-argument-options.js', 'ambiguous-shell-option'],
  ['unsupported-syntax.js', 'unsupported-source-syntax'],
]);

for (const [name, expectedRule] of FAILING_FIXTURES) {
  test(`rejects unsafe fixture: ${name}`, () => {
    const input = fixture('fail', name);
    const findings = analyzeSource(input.source, input.path);
    assert.ok(
      findings.some((item) => item.rule === expectedRule),
      `expected ${expectedRule}; received ${JSON.stringify(findings, null, 2)}`
    );
    assert.ok(findings.every((item) => item.line > 0 && item.column > 0));
  });
}

test('pre-fix activation shell command is red and argv replacement is green', () => {
  const before = fixture('fail', 'pre-fix-activation.js');
  const after = fixture('pass', 'fixed-activation.js');

  assert.equal(analyzeSource(before.source, before.path)[0].rule, 'dynamic-shell-command');
  assert.deepEqual(analyzeSource(after.source, after.path), []);
});

test('production path rules are explicit and exclude tests, fixtures, generated, vendor, and assets', () => {
  const accepted = [
    'plugins/power-pages/hooks/post-tool.js',
    'plugins/power-pages/scripts/tool.js',
    'plugins/power-pages/scripts/lib/tool.js',
    'plugins/power-pages/skills/example/scripts/validate-example.js',
    'plugins/power-pages/skills/example/scripts/validate-example.mjs',
    'plugins/power-pages/scripts/tool.cjs',
  ];
  const rejected = [
    'plugins/power-pages/scripts/tests/tool.test.js',
    'plugins/power-pages/scripts/fixtures/tool.js',
    'plugins/power-pages/scripts/generated/tool.js',
    'plugins/power-pages/scripts/vendor/tool.js',
    'plugins/power-pages/skills/example/assets/tool.js',
    'plugins/power-pages/skills/example/references/tool.js',
    'plugins/power-pages/scripts/tool.json',
  ];

  for (const filePath of accepted) assert.equal(shouldScan(filePath), true, filePath);
  for (const filePath of rejected) assert.equal(shouldScan(filePath), false, filePath);
});

test('repository walk applies the reviewed production path rules', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-process-paths-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = [
    'plugins/power-pages/hooks/hook.js',
    'plugins/power-pages/scripts/tool.js',
    'plugins/power-pages/scripts/tests/tool.js',
    'plugins/power-pages/skills/demo/scripts/run.js',
    'plugins/power-pages/skills/demo/assets/run.js',
  ];
  for (const filePath of files) {
    const absolutePath = path.join(root, filePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, "'use strict';\n");
  }

  assert.deepEqual(listProductionJavaScript(root), [
    'plugins/power-pages/hooks/hook.js',
    'plugins/power-pages/scripts/tool.js',
    'plugins/power-pages/skills/demo/scripts/run.js',
  ]);
});

test('audited exceptions require exact path, rule, callee, and call and fail on drift', () => {
  const filePath = 'plugins/power-pages/scripts/legacy.js';
  const source = [
    "const { spawn } = require('child_process');",
    "spawn('tool', [process.env.INPUT], { shell: true });",
    '',
  ].join('\n');
  const originalFinding = analyzeSource(source, filePath)[0];
  const exception = {
    path: filePath,
    rule: originalFinding.rule,
    callee: originalFinding.callee,
    call: originalFinding.call,
    reason: 'Tracked legacy launch awaiting removal.',
  };

  const exact = applyAuditedExceptions([originalFinding], [exception]);
  assert.deepEqual(exact.findings, []);
  assert.deepEqual(exact.audited, [exception]);

  const driftedFinding = analyzeSource(source.replace("'tool'", "'other-tool'"), filePath)[0];
  const drifted = applyAuditedExceptions([driftedFinding], [exception]);
  assert.deepEqual(
    drifted.findings.map((item) => item.rule).sort(),
    ['shell-true', 'stale-audited-exception']
  );
  assert.deepEqual(drifted.audited, []);
});

test('audited exception schema requires a review reason', () => {
  assert.throws(
    () => validateExceptions([{
      path: 'plugins/power-pages/scripts/legacy.js',
      rule: 'shell-true',
      callee: 'spawn',
      call: "spawn ( 'tool' , [ ] , { shell : true } )",
      reason: '',
    }]),
    /reason/
  );
});

test('repository-wide audit is clean apart from the exact reviewed exception', () => {
  const result = auditRepository(REPOSITORY_ROOT);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.audited, AUDITED_EXCEPTIONS);
  assert.ok(result.files.length > 100, 'expected a repository-wide production scan');
});

test('CLI audit emits actionable diagnostics and succeeds for the repository', () => {
  const result = spawnSync(process.execPath, [VALIDATOR, '--root', REPOSITORY_ROOT], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /AUDITED plugins\/power-pages\/scripts\/launch-playwright-mcp\.js/);
  assert.match(result.stdout, /validation passed \(\d+ production files, 1 audited exception\)/);
});
