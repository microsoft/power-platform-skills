'use strict';
// Where the plugin runs the `pac` commands its bundled SDK now answers — a source scan of the scripts' CODE (comments taken out, so a sentence
// that names a command is not a call), the way sdk-opt-ins.test.js and sdk-async-surface.test.js look for SDK calls:
//
//   - `pac model list-languages` is run by NO script: the languages come from the SDK (scripts/list-languages.js) or not at all, because every
//     /genpage page operation needs the Azure CLI anyway and a fallback that avoided it bought nothing.
//   - `pac connection list`, the two connector verbs (`pac model genpage list-connector-operations`, `get-connector-schema`) and the two
//     solution verbs (`pac solution create-settings`, `pac solution import`) are run only by the script that asks the SDK first, and in it only
//     from the one function that is its pac code — which is reached from the script's `fromPac` hook (the SDK refused) or, for the one form the
//     SDK has no read of, from its pac-only path. THAT the hook is reached only when the SDK refuses is what each script's own tests run
//     (list-connections-sdk, connector, solution-settings and the real-bundle tests); what is pinned here is that no other code path can start
//     these commands behind the rule's back, and that the generic helpers (lib/pac-fallback.js, lib/sdk-first.js) name none of them.
//
// This is deliberately not a plugin-wide allowlist of `pac` commands: other scripts still run others, and that list is pinned where they are.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SCRIPTS_DIR, productionScripts, withoutComments } = require('./helpers/production-scripts.js');

// Every production script's code, once: path relative to scripts/ (forward slashes) -> source without comments.
const CODE = new Map(productionScripts().map((file) => [
  path.relative(SCRIPTS_DIR, file).split(path.sep).join('/'),
  withoutComments(fs.readFileSync(file, 'utf8')),
]));
const scriptsMatching = (pattern) => [...CODE].filter(([, text]) => text.search(pattern) !== -1).map(([name]) => name).sort();

// A command as the scripts write it: the words of an argv as string literals (`['connection', 'list']`), or in a label or an error message
// (`pac connection list`). The word after the last one must end it, so `pac connection list-x` is another command.
const literal = (w) => `['"\`]${w}['"\`]`;
const argvOf = (...words) => words.map(literal).join('\\s*,\\s*');
const spelled = (...words) => `\\bpac\\s+${words.join('\\s+')}(?![\\w-])`;

const LIST_LANGUAGES = new RegExp(`${literal('list-languages')}|${spelled('model', 'list-languages')}`);

// The commands that moved to the SDK-first scripts: `run` is how a script starts one (the words of its argv as string literals), `named` is any
// mention in code — that, or a label or an error message that quotes it (`pac connection list`) — and `holders` are the only functions that start it.
const MOVED = [
  { command: '`pac connection list`', run: new RegExp(argvOf('connection', 'list')), named: new RegExp(`${argvOf('connection', 'list')}|${spelled('connection', 'list')}`), script: 'list-connections.js', holders: ['listConnectionsWithPac'] },
  { command: '`pac model genpage list-connector-operations`', run: new RegExp(literal('list-connector-operations')), named: new RegExp(`${literal('list-connector-operations')}|${spelled('model', 'genpage', 'list-connector-operations')}`), script: 'connector.js', holders: ['pacArgs'] },
  { command: '`pac model genpage get-connector-schema`', run: new RegExp(literal('get-connector-schema')), named: new RegExp(`${literal('get-connector-schema')}|${spelled('model', 'genpage', 'get-connector-schema')}`), script: 'connector.js', holders: ['pacArgs'] },
  { command: '`pac solution create-settings`', run: new RegExp(argvOf('solution', 'create-settings')), named: new RegExp(`${argvOf('solution', 'create-settings')}|${spelled('solution', 'create-settings')}`), script: 'solution-settings.js', holders: ['templateThroughPac'] },
  { command: '`pac solution import`', run: new RegExp(argvOf('solution', 'import')), named: new RegExp(`${argvOf('solution', 'import')}|${spelled('solution', 'import')}`), script: 'solution-settings.js', holders: ['importThroughPac'] },
];

// For each owner of one of those commands, the lines that call it — nothing else may — and, for each script, the only functions that start a
// pac process at all.
const CALL_SITES = [
  { script: 'list-connections.js', fn: 'listConnectionsWithPac', lines: ['fromPac: async () => listConnectionsWithPac(env),'] },
  { script: 'connector.js', fn: 'pacArgs', lines: ['const args = pacArgs(request);'] },
  {
    script: 'connector.js',
    fn: 'readThroughPac',
    lines: [
      // The tabular form: the SDK has no read of a connector's tables, so pac is asked directly and says `source: "pac"` with no `fallback`.
      "if (request.form === 'table') return { source: 'pac', value: await readThroughPac(request, null, deps) };",
      'fromPac: async (refusal) => readThroughPac(request, refusal, deps),',
    ],
  },
  {
    script: 'solution-settings.js',
    fn: 'templateThroughPac',
    lines: [
      // `--package` with no `--env`: there is no environment to stage the package in, so pac reads the zip offline.
      'const made = await templateThroughPac({ packagePath: request.packagePath }, null, deps);',
      'fromPac: async (refusal) => templateThroughPac(',
    ],
  },
  { script: 'solution-settings.js', fn: 'importThroughPac', lines: ['fromPac: async (refusal) => importThroughPac(request, sanitize, refusal, deps),'] },
];
const PAC_STARTS = [
  { script: 'list-connections.js', pattern: /\bspawnResultTree\s*\(\s*['"`]pac['"`]/, holders: ['listConnectionsWithPac'] },
  { script: 'connector.js', pattern: /\brunPac\s*\(/, holders: ['readThroughPac'] },
  { script: 'solution-settings.js', pattern: /\brunPac\s*\(/, holders: ['importThroughPac', 'templateThroughPac'] },
];

// The top-level function each line of a script is in. These scripts declare their functions at the left margin and close them there, so the
// nearest declaration above a line, until the next closing brace in column 0, is the function that holds it — and a script that nests or moves
// them fails the pins below loudly, which is the point.
function ownersOf(lines) {
  const owners = [];
  let current = null;
  for (const line of lines) {
    const declared = /^(?:async\s+)?function\s+(\w+)\s*\(/.exec(line);
    if (declared) current = declared[1];
    owners.push(current);
    if (/^\}/.test(line)) current = null;
  }
  return owners;
}

// Every match of `pattern` in `text`: the function it is in and the (trimmed) line it starts on. Line breaks are normalized first, so a CRLF
// checkout and an LF one read alike, and a call written over two lines is still found.
function sites(text, pattern) {
  const source = text.replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const owners = ownersOf(lines);
  const starts = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const found = [];
  for (const match of source.matchAll(global)) {
    let row = starts.length - 1;
    while (starts[row] > match.index) row -= 1;
    found.push({ fn: owners[row] || '(module level)', line: lines[row].trim() });
  }
  return found;
}
const uniqueSorted = (values) => [...new Set(values)].sort();
const code = (script) => {
  assert.ok(CODE.has(script), `scripts/${script} exists`);
  return CODE.get(script);
};

test('no production script runs `pac model list-languages` — the languages come from the SDK or not at all', () => {
  assert.deepStrictEqual(scriptsMatching(LIST_LANGUAGES), []);
  // The scan is not vacuous: the script that reads the languages is there, and it asks the SDK.
  assert.match(code('list-languages.js'), /\bgetEnvironmentLanguages\b/);
  assert.doesNotMatch(code('list-languages.js'), /\bpac\b/i, 'its code does not so much as name pac');
});

for (const { command, named, script } of MOVED) {
  test(`${command} is written in scripts/${script} and in no other production script`, () => {
    assert.deepStrictEqual(scriptsMatching(named), [script]);
  });
}

// In `list-connections.js` the pac path's parser and failure messages also name the command (`pac connection list printed output this script could
// not read`), so only the argv — the run — is pinned to one function: that is the one that starts a process.
for (const { command, run, script, holders } of MOVED) {
  test(`${command} is run only by ${holders.map((h) => `${h}()`).join(' and ')} of scripts/${script}`, () => {
    assert.deepStrictEqual(uniqueSorted(sites(code(script), run).map((s) => s.fn)), [...holders].sort());
  });
}

for (const { script, fn, lines } of CALL_SITES) {
  test(`${fn}() of scripts/${script} is called from the fallback hook${lines.length > 1 ? ' and the pac-only path' : ''} and nowhere else`, () => {
    // Its own declaration is not a call, and an export names it without calling it.
    const calls = sites(code(script), new RegExp(`(?<!function )\\b${fn}\\s*\\(`)).map((s) => s.line);
    assert.deepStrictEqual(calls, lines);
  });
}

for (const { script, pattern, holders } of PAC_STARTS) {
  test(`scripts/${script} starts a pac process only in ${holders.map((h) => `${h}()`).join(' and ')}`, () => {
    assert.deepStrictEqual(uniqueSorted(sites(code(script), pattern).map((s) => s.fn)), [...holders].sort());
  });
}

test('the generic helpers name none of the commands: lib/pac-fallback.js runs what it is given, lib/sdk-first.js decides only when to ask', () => {
  for (const helper of ['lib/pac-fallback.js', 'lib/sdk-first.js']) {
    for (const { command, named } of MOVED) assert.doesNotMatch(code(helper), named, `${helper} names ${command}`);
    assert.doesNotMatch(code(helper), LIST_LANGUAGES, `${helper} names pac model list-languages`);
  }
});

// A scan that cannot see what it looks for passes on any input: each pattern reads the shapes the scripts write, and only those.
test('the patterns read the way the scripts write a command — an argv, a label — and not a longer command or an unrelated word', () => {
  const read = (pattern, text) => pattern.test(text);
  const [connectionList, , , createSettings, solutionImport] = MOVED;
  assert.ok(read(connectionList.run, "spawnResultSync('pac', ['connection', 'list'], {"));
  assert.ok(read(connectionList.named, 'const label = "pac connection list";'));
  assert.ok(read(connectionList.named, 'run(`pac   connection list`)'));
  assert.ok(!read(connectionList.run, 'const label = "pac connection list";'), 'a label is a mention, not a run');
  assert.ok(!read(connectionList.named, "server.on('connection', (socket) => {"), 'a socket event is not a pac command');
  assert.ok(!read(connectionList.named, 'pac connection list-all'), 'a longer command is another command');
  assert.ok(!read(connectionList.named, "['connection']"));
  assert.ok(read(createSettings.run, "['solution', 'create-settings', '--solution-zip', zip]"));
  assert.ok(read(solutionImport.run, "['solution',\n 'import']"), 'an argv wrapped over two lines is the same argv');
  assert.ok(read(solutionImport.named, "'pac solution import'"));
  assert.ok(!read(solutionImport.named, "['solution', 'importx']"));
  assert.ok(read(MOVED[1].run, "return ['model', 'genpage', 'list-connector-operations', ...common];"));
  assert.ok(read(MOVED[2].named, 'pac model genpage get-connector-schema failed'));
  assert.ok(read(LIST_LANGUAGES, "['model', 'list-languages']"));
  assert.ok(read(LIST_LANGUAGES, 'pac model list-languages --environment x'));
  assert.ok(!read(LIST_LANGUAGES, "fs.mkdtempSync(path.join(os.tmpdir(), 'list-languages-'))"), 'a folder prefix is not the command');
  assert.ok(!read(LIST_LANGUAGES, "require('./list-languages.js')"), 'the script\u2019s own file name is not the command');
  // The owner of a line is the function declared above it, until that function closes in column 0.
  const sample = ['const a = 1;', 'function one() {', '  return x;', '}', 'run();', 'async function two() {', '  go();', '}'].join('\r\n');
  assert.deepStrictEqual(sites(sample, /\bx\b|\brun\b|\bgo\b/).map((s) => `${s.fn}:${s.line}`), ['one:return x;', '(module level):run();', 'two:go();']);
});
