'use strict';
// The plugin-wide allowlist of what `pac` is still started for. Every other command the plugin used to run through pac is done
// through the bundled SDK now, so a NEW way to start pac — another verb, another script, another spelling of its name — fails
// here and has to be argued for in this file. Not seen: a name held in a constant inside one of the files that already name pac
// (`const X = 'pac.exe'; spawnSync(X, …)`); a pac literal in any other file fails the file list below. What stays, and why:
//   pac org who                     check-auth.js: the pre-flight compares pac's identity with az's (a mismatch is what makes a
//                                   later write fail with 403), and reads the environment when --env is omitted.
//   pac connection list             list-connections.js: when the SDK refuses the read (an org in a cloud or behind a route it does
//                                   not serve), pac answers instead (lib/sdk-first.js decides when).
//   pac model genpage list-connector-operations | get-connector-schema
//                                   connector.js, through lib/pac-fallback.js: the same, for a connector's operations and schemas, and
//                                   for a tabular connector's table columns.
//   pac solution create-settings | import
//                                   solution-settings.js, through lib/pac-fallback.js: a settings template made offline from a zip — the one
//                                   start no SDK refusal precedes, so it is named (NAMED_ROUTES) — and the import features the SDK does not apply.
//   pac --version, pac auth who     lib/telemetry/lib: the shared telemetry library (a byte copy of shared/telemetry/lib) reads
//                                   pac's version and signed-in identity for its event dimensions; changing that is the shared
//                                   library's business, not this plugin's.
// A "start" is a call whose first argument is a literal that names pac (any quote) — `pac`, `pac.exe`, `pac.cmd`, a path ending in one
// of them, in any letter case — or, for exec and execSync, a command line that begins with such a name. lib/pac-fallback.js's runPac is
// the one wrapper that takes its argv from a caller, so its calls are pinned as well. Comments are not code (helpers/production-scripts.js).
// The files read are the plugin's scripts AND its hooks, in `.js`, `.cjs` and `.mjs` (helpers/production-scripts.js): a pac started from a hook, or from a module with another extension,
// fails the same way.
//
// Of the starts that stay, one is not behind a refusal of the SDK, and is named so (NAMED_ROUTES below): the settings template made offline.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SCRIPTS_DIR, HOOKS_DIR, productionScripts, scriptLabel, withoutComments } = require('./helpers/production-scripts.js');

// The names a script starts pac by — not only `pac`. On Windows Node starts a program by its file name, so a direct
// `spawnSync('pac.exe', …)` starts the dotnet-tool install with no shell and no process runner; `pac.cmd` is the shim the other installs
// use; a path to either starts the same program; and a file name there is not case-sensitive (`PAC.EXE`). A word that only contains pac
// (`unpac`, `pac-fallback.js`) is not one: the name is the whole literal, or what follows the last path separator in it.
const QUOTE = /['"`]/.source;
const NOT_QUOTE = /[^'"`\r\n]/.source;
const PAC_NAME = String.raw`(?:${NOT_QUOTE}*[\\/])?pac(?:\.exe|\.cmd)?`;
// `exec("pac", ["auth", "who"], …)`, `spawnResultTree('pac', ['connection', 'list', …])`, `spawn('pac.exe', args, …)`:
// the function, then the argv — an array literal or the name of one.
const PAC_START = new RegExp(String.raw`\b([A-Za-z_$][\w$]*)\s*\(\s*(${QUOTE})${PAC_NAME}\2\s*,\s*(\[[^\]]*\]|[A-Za-z_$][\w$]*)`, 'gi');
// `execSync('pac solution export --name x')`: a command line handed to a shell. validate-secure-process-execution.js requires the
// command of exec and execSync to be one static string, and a static `pac …` is one, so it is read here: a literal first argument that
// begins with the name. Not seen: an alias of exec under another name, and a command line inside a longer argument
// (`spawn('cmd.exe', ['/c', 'pac …'])`).
const PAC_SHELL_START = new RegExp(String.raw`\b(?:exec|execSync)\s*\(\s*${QUOTE}\s*${PAC_NAME}\s+(${NOT_QUOTE}*)`, 'gi');
// `runPac(['solution', 'import', …], …)` or `runPac(args, …)`; its declaration (`function runPac(args, …)`) is not a call.
const RUN_PAC = /(?<!function\s+)\brunPac\s*\(\s*(\[[^\]]*\]|[A-Za-z_$][\w$]*)/g;
// The name as a string anywhere (`const exe = 'pac.exe'; spawn(exe, args)`): an indirection the call patterns cannot follow.
const PAC_LITERAL = new RegExp(String.raw`(${QUOTE})${PAC_NAME}\1`, 'i');

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
    const shellStarts = [...code.matchAll(PAC_SHELL_START)];
    for (const m of code.matchAll(PAC_START)) starts.push(`${name}: ${commandOf(m[3])}`);
    // `pac solution export --name x` is the command `solution export`.
    for (const m of shellStarts) starts.push(`${name}: ${m[1].trim().split(/\s+/).slice(0, 2).join(' ')}`);
    for (const m of code.matchAll(RUN_PAC)) runPacCalls.push(`${name}: ${commandOf(m[1])}`);
    if (PAC_LITERAL.test(code) || shellStarts.length > 0) literalFiles.push(name);
  }
  return { starts: starts.sort(), runPacCalls: runPacCalls.sort(), literalFiles: literalFiles.sort() };
}

// The files a scan reads, as [label, source]: `label` names a file the way the expectations below do (helpers/production-scripts.js scriptLabel).
const loadSources = (files, label = scriptLabel) => files.map((file) => [label(file), fs.readFileSync(file, 'utf8')]);
const SOURCES = loadSources(productionScripts());
const PRODUCTION = scan(SOURCES);

// What the scan may find in the production scripts. The tests below assert exactly this, and the last ones add a script of their own to
// the sources to show that it no longer holds.
const ALLOWED_STARTS = [
  'check-auth.js: org who',
  'lib/pac-fallback.js: <args>',
  'lib/telemetry/lib/agent-info.js: --version',
  'lib/telemetry/lib/pac-auth.js: auth who',
  'list-connections.js: connection list',
];
const ALLOWED_RUN_PAC_CALLS = [
  'connector.js: <args>',
  'solution-settings.js: solution create-settings',
  'solution-settings.js: solution import',
];
const ALLOWED_LITERAL_FILES = [
  'check-auth.js',
  'connector.js',
  'lib/pac-fallback.js',
  'lib/sdk-first.js',
  'lib/telemetry/lib/agent-info.js',
  'lib/telemetry/lib/pac-auth.js',
  'list-connections.js',
  'solution-settings.js',
];

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

test('the scan itself: it finds a start by any spelling of the name — an extension, a path, capitals — and by the command line given to exec', () => {
  const found = scan([
    ['f.js', "spawnSync('pac.exe', ['solution', 'export', '--name', n], { shell: false });"],
    ['g.js', 'execFileSync("PAC.CMD", args);'],
    ['h.js', "spawn('C:\\\\Users\\\\maker\\\\.dotnet\\\\tools\\\\pac.exe', ['org', 'who']);"],
    ['i.js', "execFile('/usr/local/bin/pac', ['connection', 'list'], callback);"],
    ['j.js', "execSync('pac solution export --name Contoso');"],
    ['k.js', 'child_process.execSync(`Pac.Exe auth who`);'],
  ]);
  assert.deepStrictEqual(found.starts, ['f.js: solution export', 'g.js: <args>', 'h.js: org who', 'i.js: connection list', 'j.js: solution export', 'k.js: auth who']);
  assert.deepStrictEqual(found.literalFiles, ['f.js', 'g.js', 'h.js', 'i.js', 'j.js', 'k.js']);
});

test('the scan itself: a word that only contains pac, a message that begins with it and a shell line that only mentions it are not starts', () => {
  const found = scan([
    ['l.js', "const names = ['unpac', 'spac.exe', 'pac-fallback.js', './pac.js', 'tools/pac.exe.bak'];"],
    ['m.js', "throw new Error('pac connection list failed');\nlog(`PAC CLI is not installed`);"],
    ['n.js', "execSync('echo pac');"],
  ]);
  assert.deepStrictEqual(found.starts, []);
  assert.deepStrictEqual(found.literalFiles, []);
});

test('pac is started in exactly these places, for exactly these commands', () => {
  assert.deepStrictEqual(PRODUCTION.starts, ALLOWED_STARTS);
});

test('runPac — the one wrapper that takes its argv from a caller — runs only the connector verbs and the two solution verbs', () => {
  assert.deepStrictEqual(PRODUCTION.runPacCalls, ALLOWED_RUN_PAC_CALLS);
  // connector.js passes an argv it builds: every one it can build is a connector verb of `pac model genpage`.
  const connector = withoutComments(fs.readFileSync(path.join(SCRIPTS_DIR, 'connector.js'), 'utf8'));
  const built = [...connector.matchAll(/\[\s*(['"`])model\1\s*,\s*(['"`])genpage\2\s*,\s*(['"`])([\w-]+)\3/g)].map((m) => m[4]);
  assert.deepStrictEqual([...new Set(built)].sort(), ['get-connector-schema', 'list-connector-operations']);
  assert.doesNotMatch(connector, /\[\s*(['"`])(?!model\1)[a-z-]+\1\s*,\s*(['"`])[a-z-]+\2\s*,\s*(['"`])--/, 'no other argv shape in connector.js');
});

test('only these scripts hold the string pac in their code, so an indirection cannot hide a new start', () => {
  // connector.js, solution-settings.js and lib/sdk-first.js also report `source: 'pac'` in their output.
  assert.deepStrictEqual(PRODUCTION.literalFiles, ALLOWED_LITERAL_FILES);
});

// Each of these starts pac for `solution export`, a verb the plugin does not use pac for. The first is the spelling the scan has always read;
// the others reach the same program under another name.
const NEW_SCRIPT_SPELLINGS = [
  ['its plain name', "spawnSync('pac', ['solution', 'export', '--name', name]);"],
  ['its Windows file name', "spawnSync('pac.exe', ['solution', 'export', '--name', name], { shell: false });"],
  ['its batch shim, in capitals', 'execFileSync("PAC.CMD", ["solution", "export", "--name", name]);'],
  ['an absolute Windows path', "spawn('C:\\\\Users\\\\maker\\\\.dotnet\\\\tools\\\\pac.exe', ['solution', 'export', '--name', name]);"],
  ['an absolute POSIX path', "execFile('/usr/local/bin/pac', ['solution', 'export', '--name', name], callback);"],
  ['a command line given to a shell', "execSync('pac solution export --name Contoso');"],
];

for (const [spelling, code] of NEW_SCRIPT_SPELLINGS) {
  test(`a new script that starts pac through ${spelling} fails the allowlist`, () => {
    const grown = scan([...SOURCES, ['lib/new-script.js', code]]);
    // The assertions of the tests above, on the production sources with the new script among them.
    assert.notDeepStrictEqual(grown.starts, ALLOWED_STARTS);
    assert.notDeepStrictEqual(grown.literalFiles, ALLOWED_LITERAL_FILES);
    assert.ok(grown.starts.includes('lib/new-script.js: solution export'), `the start is listed with its verb: ${JSON.stringify(grown.starts)}`);
  });
}

// --- hooks, and files of another extension -----------------------------------------------------------------------------------------------

// The same violation in each kind of file the scan must read besides scripts/*.js: a hook, and a module with each extension Node loads as code.
const NEW_FILE_KINDS = [
  ['a hook', 'hooks/new-hook.js'],
  ['a hook with the .cjs extension', 'hooks/new-hook.cjs'],
  ['a CommonJS module (.cjs)', 'lib/new-module.cjs'],
  ['an ES module (.mjs)', 'lib/new-module.mjs'],
];

for (const [kind, name] of NEW_FILE_KINDS) {
  test(`pac started from ${kind} fails the allowlist`, () => {
    const grown = scan([...SOURCES, [name, "spawnSync('pac', ['solution', 'export', '--name', name]);"]]);
    assert.notDeepStrictEqual(grown.starts, ALLOWED_STARTS);
    assert.notDeepStrictEqual(grown.literalFiles, ALLOWED_LITERAL_FILES);
    assert.ok(grown.starts.includes(`${name}: solution export`), JSON.stringify(grown.starts));
  });
}

test('the files the scan reads are the plugin\u2019s scripts and every one of its hooks — and no hook starts pac itself', () => {
  const labels = SOURCES.map(([name]) => name);
  assert.ok(labels.includes('lib/pac-fallback.js') && labels.includes('check-auth.js'), 'the scripts');
  const hooks = fs.readdirSync(HOOKS_DIR).filter((name) => /\.(?:js|cjs|mjs)$/.test(name)).map((name) => `hooks/${name}`);
  assert.ok(hooks.length >= 4, `the plugin has hooks: ${hooks.join(', ')}`);
  for (const hook of hooks) assert.ok(labels.includes(hook), `${hook} is read`);
  assert.deepStrictEqual(labels.filter((name) => name.startsWith('hooks/')).sort(), hooks.sort(), 'and nothing else of hooks/');
  // The hooks reach pac only through the shared telemetry library (lib/telemetry/lib, allowed above).
  assert.deepStrictEqual(PRODUCTION.starts.filter((start) => start.startsWith('hooks/')), []);
  assert.deepStrictEqual(PRODUCTION.literalFiles.filter((name) => name.startsWith('hooks/')), []);
});

test('a pac start planted in a script, a hook, a .cjs or a .mjs file on disk is found — and in vendor/, tests/ and node_modules/, which hold generated or test code, is not', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pac-allowlist-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const start = "spawnSync('pac.exe', ['solution', 'export', '--name', name]);\n";
  const planted = {
    'scripts/lib/ok.js': 'module.exports = 1;\n',
    'scripts/lib/bad-script.js': start,
    'scripts/lib/bad-common.cjs': start,
    'scripts/bad-module.mjs': start,
    'hooks/bad-hook.js': start,
    'hooks/bad-hook.cjs': start,
    'hooks/README.md': 'pac solution export\n',
    'scripts/vendor/skipped.cjs': start,
    'scripts/tests/skipped.js': start,
    'scripts/lib/node_modules/skipped.js': start,
  };
  for (const [name, text] of Object.entries(planted)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  const files = productionScripts([path.join(root, 'scripts'), path.join(root, 'hooks')]);
  const label = (file) => path.relative(root, file).split(path.sep).join('/');
  assert.deepStrictEqual(files.map(label).sort(), ['hooks/bad-hook.cjs', 'hooks/bad-hook.js', 'scripts/bad-module.mjs', 'scripts/lib/bad-common.cjs', 'scripts/lib/bad-script.js', 'scripts/lib/ok.js']);
  assert.deepStrictEqual(scan(loadSources(files, label)).starts, [
    'hooks/bad-hook.cjs: solution export',
    'hooks/bad-hook.js: solution export',
    'scripts/bad-module.mjs: solution export',
    'scripts/lib/bad-common.cjs: solution export',
    'scripts/lib/bad-script.js: solution export',
  ]);
  assert.deepStrictEqual(productionScripts(path.join(root, 'missing')), [], 'a root that does not exist holds nothing');
});

// --- the one pac start no refusal of the SDK precedes -----------------------------------------------------------------------------------

// Every other pac start of the plugin is a pre-flight, telemetry, or the fallback behind a typed refusal of the SDK (lib/sdk-first.js decides when; pac-fallback-commands.test.js pins that each pac
// code path is reached only from its fallback hook). A route that is none of those is named here, with the code that is it, when it is reached and why pac is the only way — so that a second one
// cannot arrive unargued, and this one cannot leave the code and stay on the list. `solution-settings.js` says the same in its own header, and AGENTS.md names it as one of the two pac-only paths.
const NAMED_ROUTES = {
  'the offline settings template': {
    start: 'solution-settings.js: solution create-settings',
    reached: '`solution-settings.js template --package <zip>` with no `--env`',
    call: 'templateThroughPac({ packagePath: request.packagePath }, null, deps)',
    guard: /if\s*\(\s*!request\.env\s*\)\s*\{\s*const made = await\s+$/,
    why: 'The SDK reads a solution package only by staging it in an environment (StageSolution), so with no environment there is nothing to ask; pac reads the zip offline. The result says `source: "pac"` and carries no `fallback`.',
  },
};

// The arguments of the call whose opening parenthesis is at `open`, split where the call splits them: brackets nest, and a string literal is skipped over.
function callArguments(code, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  let quote = null;
  for (let at = open + 1; at < code.length; at += 1) {
    const char = code[at];
    if (quote) {
      if (char === '\\') at += 1;
      else if (char === quote) quote = null;
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if ('([{'.includes(char)) {
      depth += 1;
    } else if (')]}'.includes(char)) {
      if (depth === 0) return [...args, code.slice(start, at).trim()];
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      args.push(code.slice(start, at).trim());
      start = at + 1;
    }
  }
  throw new Error('a call that does not close');
}

// What is wrong with the routes into the settings-template wrapper `templateThroughPac(args, refusal, deps)`: it is called exactly twice — once with the refusal the SDK gave (the fallback hook)
// and once with `null`, the named route, as the first statement of the `if (!request.env)` block it belongs to.
function routeProblems(source, route) {
  const code = withoutComments(source);
  const calls = [...code.matchAll(/(?<!function\s)\btemplateThroughPac\s*\(/g)].map((match) => {
    const args = callArguments(code, match.index + match[0].length - 1);
    return { refusal: args[1], text: `templateThroughPac(${args.join(', ')})`, before: code.slice(0, match.index) };
  });
  const problems = [];
  const unrefused = calls.filter((call) => call.refusal === 'null');
  if (unrefused.length !== 1) problems.push(`${unrefused.length} calls pass no refusal: the named route is exactly one`);
  else {
    if (unrefused[0].text !== route.call) problems.push(`the call that passes no refusal is ${unrefused[0].text}, not ${route.call}`);
    if (!route.guard.test(unrefused[0].before)) problems.push('the call that passes no refusal is not the first statement of the `if (!request.env)` block');
  }
  const refused = calls.filter((call) => call.refusal !== 'null');
  if (refused.length !== 1 || refused[0].refusal !== 'refusal') problems.push('the other call is exactly one, and passes the SDK\u2019s `refusal`');
  return problems;
}

test('the offline settings template is named on the list — the one pac start no SDK refusal precedes — and is exactly where it says it is', () => {
  const source = fs.readFileSync(path.join(SCRIPTS_DIR, 'solution-settings.js'), 'utf8');
  for (const [name, route] of Object.entries(NAMED_ROUTES)) {
    assert.ok(PRODUCTION.runPacCalls.includes(route.start), `${name}: ${route.start} is a start the scan finds`);
    assert.ok(ALLOWED_RUN_PAC_CALLS.includes(route.start), `${name}: and one the list allows`);
    assert.deepStrictEqual(routeProblems(source, route), [], name);
    assert.match(source, /the zip is read by pac, offline/, `${name}: the script\u2019s own header says so`);
  }
  assert.deepStrictEqual(Object.keys(NAMED_ROUTES), ['the offline settings template'], 'a second route is added here, with its reason, or not at all');
});

test('a second call that passes no refusal, a removed guard, a fallback that passes none, and a call moved out of its guard each fail the named route', () => {
  const route = NAMED_ROUTES['the offline settings template'];
  const source = fs.readFileSync(path.join(SCRIPTS_DIR, 'solution-settings.js'), 'utf8');
  const mutations = {
    'a second call that passes no refusal': `${source}\nasync function elsewhere(request) { return templateThroughPac({ packagePath: request.packagePath }, null, {}); }\n`,
    'the guard removed': source.replace('if (!request.env) {', 'if (request.env === 0) {'),
    'the fallback hook passing none': source.replace(/\n(\s*)refusal,(\r?\n\s*deps\r?\n)/, '\n$1null,$2'),
    'the offline call run for every package': source.replace(/if \(!request\.env\) \{(\r?\n)(\s*)const made/, 'if (request.packagePath) {$1$2const made'),
    'the offline call with other arguments': source.replace('templateThroughPac({ packagePath: request.packagePath }, null, deps)', 'templateThroughPac({ packagePath: request.packagePath, extra: true }, null, deps)'),
  };
  for (const [what, mutated] of Object.entries(mutations)) {
    assert.notStrictEqual(mutated, source, `${what}: the mutation changed the source`);
    assert.notDeepStrictEqual(routeProblems(mutated, route), [], what);
  }
});
