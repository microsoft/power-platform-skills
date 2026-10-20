'use strict';
// Every exit in the plugin's own code — `process.exit(…)`, the injectable `io.exit(…)` / `proc.exit(…)`, and an `exit(<status>)` bound to
// process.exit — is either PROTECTED (lib/output-redaction.js makeWritesBlocking is called before it, in a block that also holds it, so what was
// written on the way to it reaches a pipe on Linux and macOS whole) or listed below with the bound that makes it safe without: it writes nothing, or
// only a constant text, or a value from a closed set. A new exit fails here until it is protected or listed with its bound — the review that found
// result printers left out found them by reading, and this keeps the next one from being missed.
//
// Read: every .js/.cjs/.mjs file under scripts/ and hooks/ — the scripts the skills run and their libraries, the hooks the host runs, and the
// maintainers' tools in scripts/_vendor-build/ — but not tests/, the generated vendor/ bundle or node_modules/. Comments and the contents of strings,
// templates and regular expressions are blanked first by the plugin's own lexer (lib/source-literals.js), so an exit named in a comment is not one.
// "A block that also holds it": the innermost `{ … }` around the call holds the exit too — a call in another branch, or in another function, does
// not count. Control flow is not followed: this is an inventory, the tests in printers-whole-before-exit.test.js and result-whole-before-exit.test.js
// prove the behaviour.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { blankLiterals } = require('../lib/source-literals.js');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const ROOTS = ['scripts', 'hooks', 'scripts/_vendor-build'].map((dir) => path.join(PLUGIN_ROOT, ...dir.split('/')));
const SKIPPED = new Set(['tests', 'vendor', 'node_modules', '_vendor-build']);
const EXIT = /\b(?:process|io|proc)\.exit\s*\(|(?<![.\w$])exit\(\s*\d/g;
const GUARD = /\bmakeWritesBlocking\s*\(/g;

// The exits of one source text that no makeWritesBlocking call protects, as 1-based line numbers.
function unprotectedExits(source) {
  const blank = blankLiterals(source);
  const blocks = [];
  const open = [];
  for (let i = 0; i < blank.length; i += 1) {
    if (blank[i] === '{') open.push(i);
    else if (blank[i] === '}' && open.length) blocks.push([open.pop(), i]);
  }
  const innermost = (at) => blocks.filter(([a, b]) => a < at && at < b).reduce((best, block) => (!best || block[0] > best[0] ? block : best), null) || [-1, blank.length];
  // The declaration of the function itself (`function makeWritesBlocking(`) is not a call of it.
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

// Each exit left unprotected, per file: how many, and the bound that makes it safe. The USAGE constants are at most 417 bytes (the longest of either
// plugin) and are the first thing the process writes, so an empty pipe takes them at once — a pipe holds at least one 4 KiB page on Linux and starts at
// 16 KiB on macOS.
const NOTHING = 'writes nothing before it ends';
const USAGE = 'prints only its USAGE constant (at most 417 bytes) as its first output';
const ALLOWED = {
  'hooks/run-skill-posttool-validation.js': [3, 'the kill switch writes nothing; the two debug lines (DEBUG=1 only) are a constant and the name of one of the plugin\'s own skills'],
  'hooks/run-skill-pretool-telemetry.js': [9, `the telemetry hook ${NOTHING} on any path`],
  'hooks/run-user-prompt-telemetry.js': [7, `the telemetry hook ${NOTHING} on any path`],
  'hooks/validate-icon-imports.js': [10, `every fail-open path ${NOTHING}; the two that block are protected`],
  'hooks/validate-write-safety.js': [4, `the kill switch and the not-a-write-tool path write nothing; the two debug lines (DEBUG=1 only) are constants`],
  'scripts/_vendor-build/build-typescript.js': [1, 'a maintainer tool\'s two constant usage lines'],
  'scripts/_vendor-build/build.js': [4, 'a maintainer tool\'s constant lines; one names a count of changes and a commit hash (about 300 bytes)'],
  'scripts/add-page-to-solution.js': [1, USAGE],
  'scripts/ai-preflight.js': [1, USAGE],
  'scripts/build-model-app.js': [2, `${USAGE}, or one constant line`],
  'scripts/capture-fixture.js': [1, '--help prints a constant help text (722 bytes)'],
  'scripts/check-version.js': [3, NOTHING],
  'scripts/create-connection-reference.js': [1, USAGE],
  'scripts/dataverse-request.js': [1, USAGE],
  'scripts/download-model-app.js': [1, USAGE],
  'scripts/generate-page-manifest.js': [1, '--help prints a constant help text (338 bytes)'],
  'scripts/launch-playwright-mcp.js': [2, 'the server\'s own end: a signal\'s name, or nothing (the server wrote its output itself)'],
  'scripts/lib/exit-cleanup.js': [2, `ends the process on a signal and ${NOTHING}`],
  'scripts/lib/feature-flags.js': [3, 'the Custom API gate\'s constant message (440 bytes), the CLI\'s constant usage line, and "enabled" or "disabled"'],
  'scripts/lib/telemetry/lib/emit-dispatcher.js': [1, `the detached dispatcher ${NOTHING}`],
  'scripts/lib/telemetry/lib/telemetry-config.js': [4, 'the shared telemetry library (shared/telemetry, copied into five plugins), which the telemetry skill runs without --plugin: constant sentences and the plugin\'s own name (about 1.2 KB measured), and the config folder\'s path once or twice; under the 4 KiB any pipe takes at once unless that path is over 1,400 characters'],
  'scripts/list-connections.js': [1, USAGE],
  'scripts/list-custom-apis.js': [1, USAGE],
  'scripts/list-languages.js': [1, USAGE],
  'scripts/preview-app.js': [1, USAGE],
  'scripts/preview-form.js': [1, USAGE],
  'scripts/promote-intent-pages.js': [3, `${USAGE}, or a constant line, or a typeof name (a closed set)`],
  'scripts/provision-entities.js': [1, USAGE],
  'scripts/provision-solution.js': [1, USAGE],
  'scripts/resolve-interaction-mode.js': [1, 'main prints {"ok":true,"interactive",…,"reason"} with a reason from a closed set of three (under 120 bytes)'],
  'scripts/run-tests.js': [1, 'main makes both streams blocking before its reports; its usage line is a constant'],
  'scripts/smoke-eval.js': [2, 'a constant usage line; main makes both streams blocking when it starts, before everything it forwards'],
  'scripts/teardown-model-app.js': [1, USAGE],
  'scripts/verify-model-app.js': [1, USAGE],
  'scripts/write-app-spec-doc.js': [1, USAGE],
  'scripts/write-page-plan.js': [1, USAGE],
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

test('every exit of the plugin\'s own code is protected, or listed with the bound that makes it safe — and nothing listed is gone', () => {
  const found = {};
  let exits = 0;
  for (const file of productionFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    exits += [...blankLiterals(source).matchAll(EXIT)].length;
    const lines = unprotectedExits(source);
    if (lines.length) found[label(file)] = lines;
  }
  assert.ok(exits > 140, `the scan read the plugin (${exits} exits)`);
  const unlisted = Object.keys(found).filter((file) => !ALLOWED[file]).map((file) => `${file}: lines ${found[file].join(', ')}`);
  assert.deepEqual(unlisted, [], 'an exit that is neither protected by makeWritesBlocking nor listed in ALLOWED with its bound');
  const changed = Object.entries(ALLOWED).filter(([file, [count]]) => (found[file] || []).length !== count)
    .map(([file, [count]]) => `${file}: listed ${count}, found ${(found[file] || []).length} (lines ${(found[file] || []).join(', ') || 'none'})`);
  assert.deepEqual(changed, [], 'a listed file whose unprotected exits changed: protect the new one, or update its count and bound');
});
