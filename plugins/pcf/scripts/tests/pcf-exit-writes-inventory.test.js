'use strict';
// Every exit in pcf's own code — `process.exit(…)`, an injectable `io.exit(…)` / `proc.exit(…)`, and an `exit(<status>)` bound to process.exit — is
// either PROTECTED (lib/output-redaction.js makeWritesBlocking is called before it, in a block that also holds it, so what was written on the way to
// it reaches a pipe on Linux and macOS whole) or listed below with the bound that makes it safe without: it writes nothing, or only a constant text,
// or a value from a closed set. A new exit fails here until it is protected or listed with its bound. The same reader as model-apps'
// tests/exit-writes-inventory.test.js (this plugin's suite runs on its own): every .js/.cjs/.mjs file under scripts/ and hooks/ but tests/, vendor/ and
// node_modules/, with comments and the contents of strings, templates and regular expressions blanked by lib/source-literals.js; "a block that also
// holds it" is the innermost `{ … }` around the call. Control flow is not followed: pcf-printers-whole-before-exit.test.js proves the behaviour.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { blankLiterals } = require('../lib/source-literals.js');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const ROOTS = ['scripts', 'hooks'].map((dir) => path.join(PLUGIN_ROOT, dir));
const SKIPPED = new Set(['tests', 'vendor', 'node_modules']);
const EXIT = /\b(?:process|io|proc)\.exit\s*\(|(?<![.\w$])exit\(\s*\d/g;
const GUARD = /\bmakeWritesBlocking\s*\(/g;

function unprotectedExits(source) {
  const blank = blankLiterals(source);
  const blocks = [];
  const open = [];
  for (let i = 0; i < blank.length; i += 1) {
    if (blank[i] === '{') open.push(i);
    else if (blank[i] === '}' && open.length) blocks.push([open.pop(), i]);
  }
  const innermost = (at) => blocks.filter(([a, b]) => a < at && at < b).reduce((best, block) => (!best || block[0] > best[0] ? block : best), null) || [-1, blank.length];
  const guards = [...blank.matchAll(GUARD)].map((m) => m.index).filter((at) => !/function\s+$/.test(blank.slice(Math.max(0, at - 16), at)));
  const lines = [];
  for (const m of blank.matchAll(EXIT)) {
    const protectedBy = guards.some((at) => {
      if (at >= m.index) return false;
      const [a, b] = innermost(at);
      return a < m.index && m.index < b;
    });
    if (!protectedBy) lines.push(source.slice(0, m.index).split('\n').length);
  }
  return lines;
}

function productionFiles() {
  const files = new Set();
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) walk(full);
      } else if (/\.(?:c|m)?js$/.test(entry.name)) {
        files.add(full);
      }
    }
  };
  for (const root of ROOTS) walk(root);
  return [...files].sort();
}

const label = (file) => path.relative(PLUGIN_ROOT, file).split(path.sep).join('/');

const NOTHING = 'writes nothing before it ends';
const SANDBOX = 'the branch for a test\'s injected process object (`process !== global.process`): a real run goes through emitResult, which is protected';
const ALLOWED = {
  'hooks/run-skill-pretool-telemetry.js': [7, `the telemetry hook ${NOTHING} on any path`],
  'hooks/run-user-prompt-telemetry.js': [5, `the telemetry hook ${NOTHING} on any path`],
  'hooks/validate-write-safety.js': [4, 'the kill switch and the not-a-write-tool path write nothing; the two debug lines (DEBUG=1 only) are constants'],
  'scripts/check-version.js': [3, NOTHING],
  'scripts/lib/telemetry/lib/emit-dispatcher.js': [1, `the detached dispatcher ${NOTHING}`],
  'scripts/lib/telemetry/lib/telemetry-config.js': [4, 'the shared telemetry library\'s copy (shared/telemetry, copied into five plugins), which no pcf skill runs (the telemetry skill runs scripts/telemetry-config.js, protected); run by hand without --plugin: constant sentences and the plugin\'s own name (about 1.2 KB measured), and the config folder\'s path once or twice; under the 4 KiB any pipe takes at once unless that path is over 1,400 characters'],
  'scripts/pcf-build.js': [1, SANDBOX],
  'scripts/pcf-gates.js': [1, SANDBOX],
  'scripts/resolve-interaction-mode.js': [1, 'main prints {"ok":true,"interactive",…,"reason"} with a reason from a closed set of three (under 120 bytes)'],
  'scripts/run-tests.js': [2, 'a constant line, or the status of the test run, whose children wrote their own output'],
  'scripts/write-pcf-plan.js': [2, `${SANDBOX}; or its USAGE constant (123 bytes) as its first output`],
};

test('the inventory reader: an exit after a makeWritesBlocking call in a block that holds it is protected; one in another branch, function or comment is not', () => {
  const source = [
    'function printer(text) {',
    '  makeWritesBlocking(process.stdout, process.stderr);',
    '  if (text) { process.stdout.write(text); process.exit(0); }',
    '  process.exit(1);',
    '}',
    'function other() {',
    '  if (a) { makeWritesBlocking(process.stderr); process.stderr.write("x"); process.exit(2); }',
    '  if (b) { process.stderr.write("y"); process.exit(3); }',
    '}',
    '// process.exit(4) in a comment, and "process.exit(5)" in a string',
    'main().then((code) => process.exit(code));',
    'const exit = opts.exit || process.exit; exit(6);',
    'io.exit(1); proc.exit(1);',
    'function makeWritesBlocking(...streams) { process.exit(7); }',
  ].join('\n');
  assert.deepEqual(unprotectedExits(source), [8, 11, 12, 13, 13, 14]);
});

test('every exit of pcf\'s own code is protected, or listed with the bound that makes it safe — and nothing listed is gone', () => {
  const found = {};
  let exits = 0;
  for (const file of productionFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    exits += [...blankLiterals(source).matchAll(EXIT)].length;
    const lines = unprotectedExits(source);
    if (lines.length) found[label(file)] = lines;
  }
  assert.ok(exits > 50, `the scan read the plugin (${exits} exits)`);
  const unlisted = Object.keys(found).filter((file) => !ALLOWED[file]).map((file) => `${file}: lines ${found[file].join(', ')}`);
  assert.deepEqual(unlisted, [], 'an exit that is neither protected by makeWritesBlocking nor listed in ALLOWED with its bound');
  const changed = Object.entries(ALLOWED).filter(([file, [count]]) => (found[file] || []).length !== count)
    .map(([file, [count]]) => `${file}: listed ${count}, found ${(found[file] || []).length} (lines ${(found[file] || []).join(', ') || 'none'})`);
  assert.deepEqual(changed, [], 'a listed file whose unprotected exits changed: protect the new one, or update its count and bound');
});
