'use strict';
// A SYNTACTIC TRIPWIRE on the exits of the plugin's own code. A script that writes and then ends the process at once must make its writes blocking
// first (lib/output-redaction.js makeWritesBlocking), or a pipe on Linux and macOS takes only what fits at once. This scan of the source fails when
//   - an exit — `process.exit(…)`, the injectable `io.exit(…)` / `proc.exit(…)`, an `exit(<status>)`, or a call of a name bound to process.exit
//     (`const exit = … process.exit`, `const { exit } = process`) — has no makeWritesBlocking call before it in a block that also holds it, and is
//     not listed in ALLOWED with the bound that makes it safe without one: it writes nothing, or only a constant text, or a value from a closed set;
//   - the call that protects an exit comes after a write in its own block (with no `await` between them), or leaves out a stream that is written
//     directly (`process.stderr.write(…)`, `console.log(…)`, …) between it and the exit.
// It reads the source, not what runs: it shows that a new exit has a call before it, not that the call runs, or runs before every write that
// matters. What a process does is shown by printers-whole-before-exit.test.js and result-whole-before-exit.test.js: the order in which a printer
// makes its streams blocking and writes to them, recorded by the process itself, and the text a reader receives.
//
// Read: every .js/.cjs/.mjs file under scripts/ and hooks/ — the scripts the skills run and their libraries, the hooks the host runs, and the
// maintainers' tools in scripts/_vendor-build/ — but not tests/, the generated vendor/ bundle or node_modules/. Comments and the contents of strings,
// templates and regular expressions are blanked first by the plugin's own lexer (lib/source-literals.js), so an exit named in a comment is not one.
// A call protects only as a statement of its own (`makeWritesBlocking(…);` or `x.makeWritesBlocking(…);`) — not as the body of an unbraced `if`,
// `else` or loop, an arrow function or an operand — and the innermost `{ … }` around it must also hold the exit; when it is the first statement of a
// `try` block, the block that holds that `try` (the write it protects is in the try, so that a stream that cannot be read fails with the write).
//
// Known limits, which a reader of a finding (or of a pass) should keep in mind: a write in an enclosing block, or in an earlier turn of the event
// loop (before an `await`), is not compared with the call; a write through a helper (`emitResult`, a `warn(…)`, a stream kept in a variable) is not
// seen — the helper's own call protects it; protection inside a called function is not seen (run-tests.js, smoke-eval.js and
// resolve-interaction-mode.js are listed for it); an exit reached through an alias of another form (an argument, a property of an object other
// than `io` or `proc`) is not found; and control flow is not followed. `process.exitCode` with a natural end waits for the writes and is no exit.
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
// A name bound to process.exit — a reference that is not a call (`const exit = opts.exit || process.exit;`) or `const { exit } = process;`.
const ALIAS = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;]*?\bprocess\.exit\b(?!\s*\()/g;
const DESTRUCTURED = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*process\b/g;
// A direct write, and the stream it goes to: a stream's own `write`, or the console — `log`, `info`, `debug`, `dir` and `table` print on stdout,
// `error`, `warn` and `trace` on stderr (https://nodejs.org/api/console.html#class-console).
const WRITE = /\b(process|io|proc)\.(stdout|stderr)\.write\s*\(|(?<![.\w$])console\.(log|info|debug|dir|table|error|warn|trace)\s*\(/g;
const CONSOLE_STREAM = { log: 'stdout', info: 'stdout', debug: 'stdout', dir: 'stdout', table: 'stdout', error: 'stderr', warn: 'stderr', trace: 'stderr' };

// The exits of one source text that no makeWritesBlocking call protects (`unprotected`, 1-based line numbers), and the protected ones whose call
// comes after a write of its block or leaves out a stream written before the exit (`misguarded`, one sentence each).
function readExits(source) {
  const blank = blankLiterals(source);
  const lineOf = (at) => source.slice(0, at).split('\n').length;
  const blocks = [];
  const open = [];
  for (let i = 0; i < blank.length; i += 1) {
    if (blank[i] === '{') open.push(i);
    else if (blank[i] === '}' && open.length) blocks.push([open.pop(), i]);
  }
  const innermost = (at) => blocks.filter(([a, b]) => a < at && at < b).reduce((best, block) => (!best || block[0] > best[0] ? block : best), null) || [-1, blank.length];
  const closing = (at) => {
    for (let i = at, depth = 0; i < blank.length; i += 1) {
      if (blank[i] === '(') depth += 1;
      else if (blank[i] === ')' && (depth -= 1) === 0) return i;
    }
    return blank.length;
  };
  // A statement of its own: what comes before the call (its receiver skipped — `outputRedaction.`, `require('…').`) is the start of the text, `{`,
  // `}` or `;`. After `)` it is the body of an `if (…)` or a loop; after `=>`, `&&`, `?` or `else` it runs only sometimes, or not here.
  const isStatement = (at) => {
    let i = at - 1;
    const skipSpace = () => { while (i >= 0 && /\s/.test(blank[i])) i -= 1; };
    skipSpace();
    while (blank[i] === '.') {
      i -= 1;
      skipSpace();
      if (blank[i] === ')') {
        for (let depth = 0; i >= 0; i -= 1) {
          if (blank[i] === ')') depth += 1;
          else if (blank[i] === '(' && (depth -= 1) === 0) break;
        }
        i -= 1;
        skipSpace();
      }
      while (i >= 0 && /[\w$]/.test(blank[i])) i -= 1;
      skipSpace();
    }
    return i < 0 || '{};'.includes(blank[i]);
  };
  const exits = new Set([...blank.matchAll(EXIT)].map((m) => m.index));
  const aliases = new Set([...blank.matchAll(ALIAS)].map((m) => m[1]));
  for (const m of blank.matchAll(DESTRUCTURED)) {
    for (const part of m[1].split(',')) {
      const [key, name] = part.split(':').map((word) => word.trim());
      if (key === 'exit') aliases.add(name || key);
    }
  }
  for (const name of aliases) for (const m of blank.matchAll(new RegExp(`(?<![.\\w$])${name.replace(/\$/g, '\\$')}\\s*\\(`, 'g'))) exits.add(m.index);
  const guards = [];
  for (const m of blank.matchAll(GUARD)) {
    // The declaration of the function itself (`function makeWritesBlocking(`) is not a call of it.
    if (/function\s+$/.test(blank.slice(Math.max(0, m.index - 16), m.index)) || !isStatement(m.index)) continue;
    const paren = m.index + m[0].length - 1;
    const names = blank.slice(paren + 1, closing(paren)).split(',').map((name) => name.replace(/\s+/g, '')).filter(Boolean);
    let [a, b] = innermost(m.index);
    if (a >= 0 && /\btry\s*$/.test(blank.slice(0, a)) && blank.slice(a + 1, m.index).trim() === '') [a, b] = innermost(a);
    guards.push({ at: m.index, a, b, names });
  }
  const writes = [...blank.matchAll(WRITE)].map((m) => ({ at: m.index, stream: m[1] ? `${m[1]}.${m[2]}` : `process.${CONSOLE_STREAM[m[3]]}` }));
  const unprotected = [];
  const misguarded = [];
  for (const at of [...exits].sort((x, y) => x - y)) {
    const by = guards.filter((guard) => guard.at < at && guard.a < at && at < guard.b);
    if (!by.length) {
      unprotected.push(lineOf(at));
      continue;
    }
    const first = by[0];
    for (const write of writes) {
      if (write.at > first.at && write.at < at && !by.some((guard) => guard.at < write.at && guard.names.includes(write.stream))) {
        misguarded.push(`the exit on line ${lineOf(at)}: ${write.stream} is written on line ${lineOf(write.at)}, and no makeWritesBlocking call before it names it`);
      }
      if (write.at > first.a && write.at < first.at && innermost(write.at)[0] === first.a && !/\bawait\b/.test(blank.slice(write.at, first.at))) {
        misguarded.push(`the exit on line ${lineOf(at)}: ${write.stream} is written on line ${lineOf(write.at)}, before the makeWritesBlocking call of its block (line ${lineOf(first.at)})`);
      }
    }
  }
  return { unprotected, misguarded };
}

const unprotectedExits = (source) => readExits(source).unprotected;

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

// Each exit left unprotected, per file: how many, and the bound that makes it safe. The USAGE constants are at most 425 bytes (teardown-model-app.js's,
// the longest of either plugin, measured) and are the first thing the process writes, so an empty pipe takes them at once: a pipe takes at least 4 KiB
// at once on either system, one page when Linux has shrunk it for a user over their pipe quota, and normally 64 KiB (Linux) or 16 KiB (macOS).
const NOTHING = 'writes nothing before it ends';
const USAGE = 'prints only its USAGE constant (at most 425 bytes) as its first output';
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
  'scripts/capture-fixture.js': [1, '--help prints a constant help text (704 bytes)'],
  'scripts/check-version.js': [3, NOTHING],
  'scripts/create-connection-reference.js': [1, USAGE],
  'scripts/dataverse-request.js': [1, USAGE],
  'scripts/download-model-app.js': [1, USAGE],
  'scripts/generate-page-manifest.js': [1, '--help prints a constant help text (329 bytes)'],
  'scripts/launch-playwright-mcp.js': [2, 'the server\'s own end: a signal\'s name, or nothing (the server wrote its output itself)'],
  'scripts/lib/exit-cleanup.js': [2, `ends the process on a signal and ${NOTHING}`],
  'scripts/lib/feature-flags.js': [2, 'the CLI\'s constant usage line, and "enabled" or "disabled"'],
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

test('the inventory reader: what protects an exit, what does not, and a call that comes after a write or leaves out a stream', () => {
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
    'const exit = opts.exit || process.exit; exit(6); exit(text ? 0 : 1);',
    'io.exit(1); proc.exit(1);',
    'function makeWritesBlocking(...streams) { process.exit(7); }',
    'function skipped(text) { if (quiet) makeWritesBlocking(process.stdout); process.stdout.write(text); process.exit(0); }',
    'function operand(text) { const later = () => makeWritesBlocking(process.stdout); process.stdout.write(text); process.exit(0); }',
    'const { exit: quit } = process; quit(9);',
    'function fatal(text) { try { makeWritesBlocking(process.stderr); process.stderr.write(text); } catch {} process.exit(1); }',
    'function notFirst(text) { try { prepare(); makeWritesBlocking(process.stderr); process.stderr.write(text); } catch {} process.exit(1); }',
    'function member(text) { require("./lib/output-redaction.js").makeWritesBlocking(process.stdout, process.stderr); console.log(text); process.exit(0); }',
    'function wrongStream(text) { makeWritesBlocking(process.stderr); process.stdout.write(text); process.exit(0); }',
    'function lateGuard(text) { process.stdout.write(text); makeWritesBlocking(process.stdout); process.exit(0); }',
    'function viaConsole(text) { makeWritesBlocking(process.stdout); console.error(text); process.exit(1); }',
    'async function earlierTurn(text) { process.stderr.write("working"); await done(); makeWritesBlocking(process.stdout, process.stderr); console.error(text); process.exit(1); }',
    'function ended(text) { if (text) { makeWritesBlocking(process.stderr); process.stderr.write(text); process.exit(2); } makeWritesBlocking(process.stderr); process.stderr.write("none"); process.exit(2); }',
  ].join('\n');
  // Not protected: a branch without the call, a callback, an alias (called with a status, and without one), io/proc, an exit in the function itself,
  // a call in an unbraced if, a call in an arrow function, a destructured alias, and a call that is not the first statement of its try.
  assert.deepEqual(unprotectedExits(source), [8, 11, 12, 12, 13, 13, 14, 15, 16, 17, 19]);
  assert.deepEqual(readExits(source).misguarded, [
    'the exit on line 21: process.stdout is written on line 21, and no makeWritesBlocking call before it names it',
    'the exit on line 22: process.stdout is written on line 22, before the makeWritesBlocking call of its block (line 22)',
    'the exit on line 23: process.stderr is written on line 23, and no makeWritesBlocking call before it names it',
  ]);
});

test('every exit of the plugin\'s own code is protected, or listed with the bound that makes it safe — and nothing listed is gone; no protecting call comes after a write of its block or leaves out a stream', () => {
  const found = {};
  const misguarded = [];
  let exits = 0;
  for (const file of productionFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    exits += [...blankLiterals(source).matchAll(EXIT)].length;
    const read = readExits(source);
    if (read.unprotected.length) found[label(file)] = read.unprotected;
    misguarded.push(...read.misguarded.map((finding) => `${label(file)}: ${finding}`));
  }
  assert.ok(exits > 140, `the scan read the plugin (${exits} exits)`);
  assert.deepEqual(misguarded, [], 'a makeWritesBlocking call that comes after a write of its block, or leaves out a stream written before the exit it protects');
  const unlisted = Object.keys(found).filter((file) => !ALLOWED[file]).map((file) => `${file}: lines ${found[file].join(', ')}`);
  assert.deepEqual(unlisted, [], 'an exit that is neither protected by makeWritesBlocking nor listed in ALLOWED with its bound');
  const changed = Object.entries(ALLOWED).filter(([file, [count]]) => (found[file] || []).length !== count)
    .map(([file, [count]]) => `${file}: listed ${count}, found ${(found[file] || []).length} (lines ${(found[file] || []).join(', ') || 'none'})`);
  assert.deepEqual(changed, [], 'a listed file whose unprotected exits changed: protect the new one, or update its count and bound');
});
