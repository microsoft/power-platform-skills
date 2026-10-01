#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VALIDATOR = path.join(REPO_ROOT, 'scripts', 'validate-plugin-copies.js');

const {
  COPY_SETS,
  checkCopySets,
} = require(VALIDATOR);

function writeText(root, relPath, content) {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function makeTempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-copies-'));
  // Follow the validator's own subset config so a newly required export does not need a second,
  // easily forgotten edit here. emitResult is the one export the copy intentionally rewrites.
  const { requiredExports, exceptExport } = COPY_SETS[0].subset;
  const exports = requiredExports.filter((name) => name !== exceptExport);
  const modelAuth = `
const DATAVERSE_HOST = /^https:\\/\\/contoso\\.crm\\.dynamics\\.com$/;
let authTokenMemo = null;
${exports.map((name) => `function ${name}() {\n  return DATAVERSE_HOST.test('https://contoso.crm.dynamics.com') && authTokenMemo === null;\n}`).join('')}
function shared() {
  return DATAVERSE_HOST.test('https://contoso.crm.dynamics.com');
}
function emitResult(result) {
  console.log(JSON.stringify(result));
}
module.exports = { ${exports.join(', ')}, shared, emitResult };
`.trimStart();
  const pcfAuth = modelAuth.replace(
    /function emitResult\(result\) \{[\s\S]*?\n\}/,
    "function emitResult(error) {\n  console.log(JSON.stringify({ ok: false, error }));\n}",
  );
  for (const pair of COPY_SETS[0].verbatim) {
    writeText(root, pair.source, `source for ${pair.source}\n`);
    writeText(root, pair.copy, `source for ${pair.source}\n`);
  }
  for (const wrapper of COPY_SETS[0].wrappers) {
    writeText(root, wrapper.copy, wrapper.requiredFragments.join('\n'));
  }
  writeText(root, COPY_SETS[0].subset.source, modelAuth);
  writeText(root, COPY_SETS[0].subset.copy, pcfAuth);
  return root;
}

function withTempRepo(fn) {
  const root = makeTempRepo();
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runCheck(root) {
  return checkCopySets({ repoRoot: root, sets: COPY_SETS });
}

test('in sync copies pass', () => withTempRepo((root) => {
  const result = runCheck(root);
  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 0);
  assert.equal(result.checked, COPY_SETS[0].verbatim.length + COPY_SETS[0].wrappers.length + 1);
}));

test('CRLF-only differences pass', () => withTempRepo((root) => {
  const pair = COPY_SETS[0].verbatim[0];
  writeText(root, pair.copy, `source for ${pair.source}\r\n`);
  const result = runCheck(root);
  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 0);
}));

test('CRLF-only differences in subset function bodies pass', () => withTempRepo((root) => {
  const copyPath = path.join(root, COPY_SETS[0].subset.copy);
  fs.writeFileSync(copyPath, fs.readFileSync(copyPath, 'utf8').replace(/\n/g, '\r\n'), 'utf8');
  const result = runCheck(root);
  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 0);
}));

test('verbatim drift is reported', () => withTempRepo((root) => {
  const pair = COPY_SETS[0].verbatim[0];
  writeText(root, pair.copy, 'changed\n');
  const result = runCheck(root);
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map((finding) => finding.kind), ['drift']);
  assert.equal(result.findings[0].source, pair.source);
  assert.equal(result.findings[0].copy, pair.copy);
  assert.match(result.findings[0].fix, /copy/i);
}));

test('missing copy is reported', () => withTempRepo((root) => {
  const pair = COPY_SETS[0].verbatim[0];
  fs.rmSync(path.join(root, pair.copy));
  const result = runCheck(root);
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map((finding) => finding.kind), ['missing-copy']);
}));

test('missing source is reported', () => withTempRepo((root) => {
  const pair = COPY_SETS[0].verbatim[0];
  fs.rmSync(path.join(root, pair.source));
  const result = runCheck(root);
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map((finding) => finding.kind), ['missing-source']);
}));

test('subset export body drift is reported', () => withTempRepo((root) => {
  const copyPath = path.join(root, COPY_SETS[0].subset.copy);
  fs.writeFileSync(
    copyPath,
    fs.readFileSync(copyPath, 'utf8').replace(
      "function shared() {\n  return DATAVERSE_HOST.test('https://contoso.crm.dynamics.com');\n}",
      "function shared() {\n  return !DATAVERSE_HOST.test('https://contoso.crm.dynamics.com');\n}",
    ),
    'utf8',
  );
  const result = runCheck(root);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.kind === 'export-drift' && finding.source === 'shared'));
}));

test('removing a required subset export is reported', () => withTempRepo((root) => {
  const copyPath = path.join(root, COPY_SETS[0].subset.copy);
  fs.writeFileSync(
    copyPath,
    fs.readFileSync(copyPath, 'utf8').replace(/parseArgs, /, ''),
    'utf8',
  );
  const result = runCheck(root);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.kind === 'missing-export' && finding.source === 'parseArgs'));
}));

test('subset module-level declaration drift is reported', () => withTempRepo((root) => {
  const copyPath = path.join(root, COPY_SETS[0].subset.copy);
  fs.writeFileSync(
    copyPath,
    fs.readFileSync(copyPath, 'utf8').replace('contoso', 'contos0'),
    'utf8',
  );
  const result = runCheck(root);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.kind === 'declaration-drift' && finding.source === 'DATAVERSE_HOST'));
}));

test('removing a closed-over subset declaration is reported', () => {
  const added = [
    ['nearestName', 'const nearestName = (value) => value;'],
    ['execFileAsync', 'const execFileAsync = async () => null;'],
    ['runSync', 'const runSync = () => null;'],
    ['helperFlag', 'const helperFlag = true;'],
  ];
  for (const [name, declaration] of added) {
    withTempRepo((root) => {
      for (const rel of [COPY_SETS[0].subset.source, COPY_SETS[0].subset.copy]) {
        const full = path.join(root, rel);
        const text = `${declaration}\n${fs.readFileSync(full, 'utf8')}`
          .replaceAll('return DATAVERSE_HOST.test', `return ${name} && DATAVERSE_HOST.test`);
        fs.writeFileSync(full, text);
      }
      const copyPath = path.join(root, COPY_SETS[0].subset.copy);
      fs.writeFileSync(copyPath, fs.readFileSync(copyPath, 'utf8').replace(`${declaration}\n`, ''));
      const result = runCheck(root);
      assert.equal(result.ok, false, name);
      assert.ok(
        result.findings.some((finding) => finding.kind === 'missing-declaration' && finding.source === name),
        `${name}: ${result.findings.map((finding) => finding.kind + ':' + finding.source).join(', ')}`,
      );
    });
  }

  for (const [name, pattern] of [
    ['DATAVERSE_HOST', /^const DATAVERSE_HOST = .*?;\r?\n/m],
    ['authTokenMemo', /^let authTokenMemo = null;\r?\n/m],
  ]) {
    withTempRepo((root) => {
      const copyPath = path.join(root, COPY_SETS[0].subset.copy);
      const before = fs.readFileSync(copyPath, 'utf8');
      const removed = before.replace(pattern, '');
      assert.notEqual(removed, before, name);
      fs.writeFileSync(copyPath, removed);
      const result = runCheck(root);
      assert.equal(result.ok, false, name);
      assert.ok(result.findings.some((finding) => finding.kind === 'missing-declaration' && finding.source === name), name);
    });
  }
});

test('removing a required subset module declaration is reported', () => withTempRepo((root) => {
  const copyPath = path.join(root, COPY_SETS[0].subset.copy);
  fs.writeFileSync(
    copyPath,
    fs.readFileSync(copyPath, 'utf8').replace(/let authTokenMemo = null;\n/, ''),
    'utf8',
  );
  const result = runCheck(root);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.kind === 'missing-declaration' && finding.source === 'authTokenMemo'));
}));

test('pcf emitResult must not match the source and must keep JSON error contract', () => withTempRepo((root) => {
  const copyPath = path.join(root, COPY_SETS[0].subset.copy);
  fs.writeFileSync(copyPath, fs.readFileSync(path.join(root, COPY_SETS[0].subset.source), 'utf8'), 'utf8');
  const result = runCheck(root);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.kind === 'emitResult-contract'));
}));

test('real repository copies are in sync', () => {
  const result = checkCopySets({ repoRoot: REPO_ROOT, sets: COPY_SETS });
  assert.deepEqual(result.findings, []);
  assert.equal(result.ok, true);
});

test('CLI reports success for the real repository', () => {
  const result = spawnSync(process.execPath, [VALIDATOR], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Plugin copies are in sync \(\d+ files in \d+ set\(s\)\)\./);
});
