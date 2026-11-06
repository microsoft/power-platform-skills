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
  topLevelFunctions,
} = require(VALIDATOR);

const TELEMETRY_PAIR = {
  source: 'plugins/model-apps/scripts/lib/telemetry/ikey.json',
  copy: 'plugins/pcf/scripts/lib/telemetry/ikey.json',
  byteIdentical: true,
};
const CRLF = String.fromCharCode(13, 10);

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

test('the shared telemetry config belongs to the byte-identical model-apps copy set', () => {
  const set = COPY_SETS.find(item => item.name === 'pcf-from-model-apps');
  assert.ok(set);
  const pair = set.verbatim.find(item => item.source === TELEMETRY_PAIR.source);
  assert.deepEqual(pair, TELEMETRY_PAIR);
});

test('byte-identical telemetry config copies reject EOL-only drift', () => withTempRepo((root) => {
  const content = '{"disabled":false,"instrumentationKey":"fake-rotation-key"}';
  writeText(root, TELEMETRY_PAIR.source, content + CRLF);
  writeText(root, TELEMETRY_PAIR.copy, content + '\n');
  const result = checkCopySets({
    repoRoot: root, sets: [{ name: 'pcf-from-model-apps', verbatim: [TELEMETRY_PAIR] }],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map(item => item.kind), ['drift']);
}));

test('byte-identical telemetry config copies reject a one-sided key rotation', () => withTempRepo((root) => {
  writeText(root, TELEMETRY_PAIR.source, '{"instrumentationKey":"fake-rotated-key"}' + CRLF);
  writeText(root, TELEMETRY_PAIR.copy, '{"instrumentationKey":"fake-original-key"}' + CRLF);
  const result = checkCopySets({
    repoRoot: root, sets: [{ name: 'pcf-from-model-apps', verbatim: [TELEMETRY_PAIR] }],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map(item => item.kind), ['drift']);
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

// A retained function can call a helper FUNCTION that is not exported: model-apps' getAuthToken calls readAzToken. Its own text
// is identical in both copies, so only the helper's absence (or drift) says the copy is broken — at run time, as a ReferenceError.
// The helper's text goes in exactly as given, so that a test can find it again to change or remove it.
function withHelper(root, helperText) {
  for (const rel of [COPY_SETS[0].subset.source, COPY_SETS[0].subset.copy]) {
    const full = path.join(root, rel);
    const text = fs.readFileSync(full, 'utf8')
      .replaceAll('return DATAVERSE_HOST.test', 'return helper() && DATAVERSE_HOST.test')
      .replace('module.exports = {', `${helperText}\nmodule.exports = {`);
    fs.writeFileSync(full, text);
  }
  return path.join(root, COPY_SETS[0].subset.copy);
}

// Every form of top-level function declaration the finder reads (see `topLevelFunctions`). A form it did not read would never be required
// of pcf's copy, and the copy would throw ReferenceError the first time a retained function called that helper — so each form is a helper.
const DEEP = "const deep = 'https://contoso.crm.dynamics.com';\n";
const HELPER_FORMS = [
  ['function', 'function helper() {\n  return DATAVERSE_HOST.test(deep);\n}\n'],
  ['async function', 'async function helper() {\n  return DATAVERSE_HOST.test(deep);\n}\n'],
  ['generator function', 'function* helper() {\n  yield DATAVERSE_HOST.test(deep);\n}\n'],
  ['async generator function', 'async function* helper() {\n  yield DATAVERSE_HOST.test(deep);\n}\n'],
  ['unevenly spaced async generator', 'async   function  *  helper  (opts = {}) {\n  return DATAVERSE_HOST.test(deep);\n}\n'],
];

for (const [form, helper] of HELPER_FORMS) {
  test(`a helper written as ${form} is required of the copy, with what it uses and its text`, () => {
    withTempRepo((root) => {
      withHelper(root, DEEP + helper);
      assert.equal(runCheck(root).ok, true, 'with the helper in both copies');
    });
    withTempRepo((root) => {
      const copyPath = withHelper(root, DEEP + helper);
      const withoutHelper = fs.readFileSync(copyPath, 'utf8').replace(helper, '');
      assert.notEqual(withoutHelper, fs.readFileSync(copyPath, 'utf8'), 'the helper was in the copy');
      fs.writeFileSync(copyPath, withoutHelper);
      const result = runCheck(root);
      assert.equal(result.ok, false);
      assert.ok(result.findings.some((finding) => finding.kind === 'missing-declaration' && finding.source === 'helper'));
    });
    withTempRepo((root) => {
      const copyPath = withHelper(root, DEEP + helper);
      fs.writeFileSync(copyPath, fs.readFileSync(copyPath, 'utf8').replace(DEEP, ''));
      const result = runCheck(root);
      assert.equal(result.ok, false);
      assert.ok(result.findings.some((finding) => finding.kind === 'missing-declaration' && finding.source === 'deep'), 'what the helper reads');
    });
    withTempRepo((root) => {
      const copyPath = withHelper(root, DEEP + helper);
      fs.writeFileSync(copyPath, fs.readFileSync(copyPath, 'utf8').replace('DATAVERSE_HOST.test(deep)', 'DATAVERSE_HOST.test(deep) || true'));
      const result = runCheck(root);
      assert.equal(result.ok, false);
      assert.ok(result.findings.some((finding) => finding.kind === 'declaration-drift' && finding.source === 'helper'), 'a helper that differs');
    });
  });
}

test('the function finder reads a declaration in each form it supports, whole, and nothing that only looks like one', () => {
  const declarations = {
    plain: 'function plain(a, b = {}) {\n  return a + b;\n}',
    waits: 'async function waits(a) {\n  function inner() {\n    return a;\n  }\n  return await inner();\n}',
    walks: 'function* walks() {\n  yield 1;\n}',
    streams: 'async function* streams() {\n  yield 1;\n}',
    spaced: 'async   function  *  spaced  (opts = {}) {\n  return opts;\n}',
  };
  const source = [
    ...Object.values(declarations),
    // At the left margin, but inside a comment and a template: no declarations. A function expression is a `const` declaration, not one of these.
    '/*\nfunction commented() {}\n*/',
    'const quoted = `\nfunction templated() {}\n`;',
    'const expression = function named() {\n  return 1;\n};',
    '',
  ].join('\n');
  assert.deepEqual(Object.fromEntries(topLevelFunctions(source)), declarations);
});

test('a helper function must keep the source text, to its last line — a brace in a literal or a comment does not end it', () => {
  const tricky = [
    'function helper(opts = {}) {',
    "  const close = '}' + \"}\" + `${'}'}` + /}/.source; // }",
    '  /* } */',
    '  return DATAVERSE_HOST.test(close) || true;',
    '}',
    '',
  ].join('\n');
  withTempRepo((root) => {
    withHelper(root, tricky);
    assert.equal(runCheck(root).ok, true, 'identical copies');
  });
  withTempRepo((root) => {
    const copyPath = withHelper(root, tricky);
    fs.writeFileSync(copyPath, fs.readFileSync(copyPath, 'utf8').replace('test(close) || true', 'test(close) || false'));
    const result = runCheck(root);
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.kind === 'declaration-drift' && finding.source === 'helper'));
  });
});

test("what only the source's emitResult uses is not required of the copy, whose emitResult is its own", () => withTempRepo((root) => {
  const sourcePath = path.join(root, COPY_SETS[0].subset.source);
  fs.writeFileSync(sourcePath, fs.readFileSync(sourcePath, 'utf8')
    .replace('module.exports = {', 'function asciiOnly(value) {\n  return JSON.stringify(value);\n}\nmodule.exports = {')
    .replace('console.log(JSON.stringify(result));', 'console.log(asciiOnly(result));'));
  const result = runCheck(root);
  assert.equal(result.ok, true, result.findings.map((finding) => `${finding.kind}:${finding.source}`).join(', '));
}));

test('the function finder reads every exported function of the real dataverse-auth copies exactly as the runtime does', () => {
  for (const rel of [COPY_SETS[0].subset.source, COPY_SETS[0].subset.copy]) {
    const full = path.join(REPO_ROOT, rel);
    const found = topLevelFunctions(fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n'));
    // Every export the module writes as a function declaration. Keeping only what the finder found would drop exactly the ones it missed
    // — an `async function`, say — and a helper the finder misses is never required of pcf's copy.
    const declared = Object.entries(require(full)).filter(([, fn]) => typeof fn === 'function' && /^(?:async\s+)?function\b/.test(String(fn)));
    assert.ok(declared.length > 0, `${rel}: no exported function declaration to read`);
    assert.deepEqual(declared.map(([name]) => name).filter((name) => !found.has(name)), [], `${rel}: exported functions the finder did not find`);
    for (const [name, fn] of declared) assert.equal(found.get(name), String(fn).replace(/\r\n/g, '\n'), `${rel} ${name}`);
  }
});

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
