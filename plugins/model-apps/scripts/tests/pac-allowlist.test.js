'use strict';
// The plugin-wide allowlist of what `pac` is still started for. Every other command the plugin used to run through pac is done
// through the bundled SDK now, so a NEW way to start pac — another verb, another script, an indirection — fails here and has to be
// argued for in this file. What stays, and why:
//   pac org who                     check-auth.js: the pre-flight compares pac's identity with az's (a mismatch is what makes a
//                                   later write fail with 403), and reads the environment when --env is omitted.
//   pac connection list             list-connections.js: when the SDK refuses the read (an org in a cloud or behind a route it does
//                                   not serve), pac answers instead (lib/sdk-first.js decides when).
//   pac model genpage list-connector-operations | get-connector-schema
//                                   connector.js, through lib/pac-fallback.js: the same, for a connector's operations and schemas, and
//                                   for a tabular connector's table columns.
//   pac solution create-settings | import
//                                   solution-settings.js, through lib/pac-fallback.js: a settings template made offline from a zip,
//                                   and the import features the SDK does not apply.
//   pac --version, pac auth who     lib/telemetry/lib: the shared telemetry library (a byte copy of shared/telemetry/lib) reads
//                                   pac's version and signed-in identity for its event dimensions; changing that is the shared
//                                   library's business, not this plugin's.
// A "start" is a call whose first argument is the literal 'pac' (any quote). lib/pac-fallback.js's runPac is the one wrapper that
// takes its argv from a caller, so its calls are pinned as well. Comments are not code (helpers/production-scripts.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SCRIPTS_DIR, productionScripts, withoutComments } = require('./helpers/production-scripts.js');

// `exec("pac", ["auth", "who"], …)`, `spawnResultTree('pac', ['connection', 'list', …])`, `spawn('pac', args, …)`:
// the function, then the argv — an array literal or the name of one.
const PAC_START = /\b([A-Za-z_$][\w$]*)\s*\(\s*(['"`])pac\2\s*,\s*(\[[^\]]*\]|[A-Za-z_$][\w$]*)/g;
// `runPac(['solution', 'import', …], …)` or `runPac(args, …)`; its declaration (`function runPac(args, …)`) is not a call.
const RUN_PAC = /(?<!function\s+)\brunPac\s*\(\s*(\[[^\]]*\]|[A-Za-z_$][\w$]*)/g;
const PAC_LITERAL = /(['"`])pac\1/;

// The first two string literals of an argv array — the command — or `<name>` when the argv is a variable.
function commandOf(argv) {
  if (!argv.startsWith('[')) return `<${argv}>`;
  return [...argv.matchAll(/(['"`])([^'"`]*)\1/g)].slice(0, 2).map((m) => m[2]).join(' ');
}

function scan(sources) {
  const starts = [];
  const runPacCalls = [];
  const literalFiles = [];
  for (const [name, source] of sources) {
    const code = withoutComments(source);
    for (const m of code.matchAll(PAC_START)) starts.push(`${name}: ${commandOf(m[3])}`);
    for (const m of code.matchAll(RUN_PAC)) runPacCalls.push(`${name}: ${commandOf(m[1])}`);
    if (PAC_LITERAL.test(code)) literalFiles.push(name);
  }
  return { starts: starts.sort(), runPacCalls: runPacCalls.sort(), literalFiles: literalFiles.sort() };
}

const PRODUCTION = scan(productionScripts().map((file) => [
  path.relative(SCRIPTS_DIR, file).split(path.sep).join('/'),
  fs.readFileSync(file, 'utf8'),
]));

test('the scan itself: it finds a start in any quote, with a literal or a variable argv, and not one in a comment', () => {
  const found = scan([
    ['a.js', 'spawnSync("pac", ["model", "genpage", "download"]);'],
    ['b.js', 'exec(`pac`, args);'],
    ['c.js', "// spawn('pac', ['solution', 'export'])\nconst x = 1;"],
    ['d.js', "async function runPac(args) {}\nrunPac(['solution', 'export', '--path', p]);"],
    ['e.js', "const where = { source: 'pac' };"],
  ]);
  assert.deepStrictEqual(found.starts, ['a.js: model genpage', 'b.js: <args>']);
  assert.deepStrictEqual(found.runPacCalls, ['d.js: solution export']);
  assert.deepStrictEqual(found.literalFiles, ['a.js', 'b.js', 'e.js']);
});

test('pac is started in exactly these places, for exactly these commands', () => {
  assert.deepStrictEqual(PRODUCTION.starts, [
    'check-auth.js: org who',
    'lib/pac-fallback.js: <args>',
    'lib/telemetry/lib/agent-info.js: --version',
    'lib/telemetry/lib/pac-auth.js: auth who',
    'list-connections.js: connection list',
  ]);
});

test('runPac — the one wrapper that takes its argv from a caller — runs only the connector verbs and the two solution verbs', () => {
  assert.deepStrictEqual(PRODUCTION.runPacCalls, [
    'connector.js: <args>',
    'solution-settings.js: solution create-settings',
    'solution-settings.js: solution import',
  ]);
  // connector.js passes an argv it builds: every one it can build is a connector verb of `pac model genpage`.
  const connector = withoutComments(fs.readFileSync(path.join(SCRIPTS_DIR, 'connector.js'), 'utf8'));
  const built = [...connector.matchAll(/\[\s*(['"`])model\1\s*,\s*(['"`])genpage\2\s*,\s*(['"`])([\w-]+)\3/g)].map((m) => m[4]);
  assert.deepStrictEqual([...new Set(built)].sort(), ['get-connector-schema', 'list-connector-operations']);
  assert.doesNotMatch(connector, /\[\s*(['"`])(?!model\1)[a-z-]+\1\s*,\s*(['"`])[a-z-]+\2\s*,\s*(['"`])--/, 'no other argv shape in connector.js');
});

test('only these scripts hold the string pac in their code, so an indirection cannot hide a new start', () => {
  // connector.js, solution-settings.js and lib/sdk-first.js also report `source: 'pac'` in their output.
  assert.deepStrictEqual(PRODUCTION.literalFiles, [
    'check-auth.js',
    'connector.js',
    'lib/pac-fallback.js',
    'lib/sdk-first.js',
    'lib/telemetry/lib/agent-info.js',
    'lib/telemetry/lib/pac-auth.js',
    'list-connections.js',
    'solution-settings.js',
  ]);
});
