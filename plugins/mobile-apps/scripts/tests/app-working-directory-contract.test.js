'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../..');
const normalize = (text) => text.replace(/\r\n?/g, '\n');
const read = (file) => normalize(fs.readFileSync(file, 'utf8'));
const appRootReference = read(path.join(pluginRoot, 'shared/references/app-working-directory.md'));
const appRootLink = '[app-working-directory.md](${PLUGIN_ROOT}/shared/references/app-working-directory.md)';
const guard = 'cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }';
const powershellGuard = "Set-Location -LiteralPath '<working_dir>' -ErrorAction Stop";

function shellBlocks(text, language = 'bash') {
  const unquoted = normalize(text).replace(/^> ?/gm, '');
  return [...unquoted.matchAll(new RegExp('^```' + language + '\\n([\\s\\S]*?)\\n```', 'gm'))]
    .map((match) => match[1]);
}

function assertRootBinding(text) {
  text = normalize(text);
  assert.match(text, /before any project read or command, execute/);
  assert.ok(text.includes(appRootLink));
  assert.ok(text.indexOf(appRootLink) < text.indexOf('```bash'), 'Bind root before the first gate');
  assert.match(text, /every shell call and\s+file tool/);
  const blocks = shellBlocks(text);
  assert.ok(blocks.length > 0);
  for (const block of blocks) {
    assert.ok(block.startsWith(`${guard}\n`), 'Every shell call must re-enter the app root');
  }
  for (const block of shellBlocks(text, 'powershell')) {
    assert.ok(block.startsWith(`${powershellGuard}\n`), 'PowerShell calls need a literal fail-closed root');
  }
}

// Use Git Bash, not WSL bash, for Windows checkout paths, as in the creation tests.
const bashPaths = process.platform === 'win32'
  ? (spawnSync('where.exe', ['bash'], { encoding: 'utf8' }).stdout || '').split(/\r?\n/)
  : [];
const bash = bashPaths.find((entry) => /[\\/]Git[\\/]/i.test(entry)) || 'bash';
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'app-working-dir-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const owner = path.join(directory, "owner's app [test] $root `literal`");
  const caller = path.join(directory, 'different app');
  for (const root of [owner, caller]) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'app.config.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(root, 'power.config.json'), JSON.stringify({ environmentId: root === owner ? 'owner' : 'caller' }));
    fs.writeFileSync(path.join(root, 'native-app-plan.md'), '# Plan\n');
    fs.mkdirSync(path.join(root, '.tmp'));
    for (const name of ['dataverse-operation-all.json', 'dataverse-operation-phase-fixture.json']) {
      fs.writeFileSync(path.join(root, '.tmp', name), '[]');
    }
    fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{}}');
  }
  return { directory, owner, caller };
}

function run(block, owner, caller) {
  const command = block.replaceAll('"<working_dir>"', shellQuote(owner.replaceAll('\\', '/')));
  // Use the current Node executable; mutation tests supply local CLI probes.
  const result = spawnSync(bash, ['-s'], {
    input: `node() { "$REAL_NODE" "$@"; }\n${command}`,
    cwd: caller,
    env: {
      ...process.env,
      REAL_NODE: process.execPath.replaceAll('\\', '/'),
      POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1',
    },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.ifError(result.error);
  return result;
}

test('shared root contract distinguishes direct defaults from required child context and file-tool scope', () => {
  const scope = appRootReference;
  const shared = read(path.join(pluginRoot, 'shared/shared-instructions.md'));
  const heading = '## Data-source invocation scope';
  const start = shared.indexOf(heading);
  assert.ok(start >= 0, 'Data-source invocations must have a shared scope preflight');
  const end = shared.indexOf('\n---', start);
  assert.ok(end > start);
  const invocation = shared.slice(start, end);
  const binding = '[app-working-directory.md](references/app-working-directory.md)';
  assert.ok(invocation.includes(binding));
  assert.match(invocation, /before (?:reading|any project read)/);
  assert.ok(invocation.indexOf(binding) < invocation.indexOf('`power.config.json`'),
    'Bind the owner root before reading the selected app environment');
  assert.match(scope, /Child invocation[\s\S]*owner's absolute\s+`working_dir`/);
  assert.match(scope, /Never fall back to the process cwd/);
  assert.match(scope, /Missing or\s+relative owner context returns `NEEDS_CONTEXT` before project access/);
  assert.match(scope, /Direct invocation[\s\S]*`--working-dir`[\s\S]*capture the\s+initial cwd once/);
  assert.match(scope, /Canonicalize the existing filesystem directory/);
  assert.match(scope, /fs\.realpathSync\.native/);
  assert.match(scope, /different roots, return `NEEDS_CONTEXT`/);
  assert.match(scope, /inaccessible directory is `BLOCKED`/);
  assert.match(scope, /does not persist across tool calls/);
  assert.match(scope, /shell-quoted\nliteral argument/);
  assert.match(scope, /File tools do not inherit shell cwd/);
  assert.match(scope, /Read\/Edit\/Write\/Grep\/Glob absolute\s+project paths/);
  assert.match(scope, /grants no additional approval and does not relax\nplan-only mode/);
  assert.match(scope, /Git Bash on Windows/);
  assert.match(scope, /PowerShell 7 on macOS\/Linux/);
  assert.match(scope, /double embedded apostrophes/);
  assert.match(scope, /re-supply any required\nshell variables/);
  assert.equal(shellBlocks(scope)[0], guard);
  assert.equal(shellBlocks(scope, 'powershell')[0], powershellGuard);
});

const removal = read(path.join(pluginRoot, 'shared/references/data-source-removal.md'));

for (const [eolName, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(`data-source refresh, removal, and verification each re-enter the app root (${eolName})`, () => {
    const blocks = shellBlocks(removal.replace(/\n/g, eol));
    assert.equal(blocks.length, 3);
    for (const block of blocks) {
      assert.ok(block.startsWith(`${guard}\n`), 'Each call needs its own fail-closed root guard');
    }
    const scope = removal.split('## Bind refresh, removal, and verification to the app root\n')[1]
      ?.split('## Removal is not schema-map generation')[0];
    assert.ok(scope);
    assert.match(scope, /Before any app-local read or command/);
    assert.match(scope, /\[app-working-directory\.md\]\(app-working-directory\.md\)/);
    assert.match(scope, /every shell call and file tool[\s\S]*CLI help[\s\S]*service verification, and retries/);
    assert.match(scope, /does not grant removal approval or relax plan-only mode/);
  });
}

test('documented data-source commands stay in the owner app across fresh calls and stop on missing roots', (t) => {
  const { directory, owner, caller } = fixture(t);
  const blocks = shellBlocks(removal);
  const trace = path.join(owner, 'root-commands.jsonl');
  const callerConfig = fs.readFileSync(path.join(caller, 'power.config.json'), 'utf8');
  // Record the actual command arguments/cwd instead of invoking any real CLI or package manager.
  const probes = `
record_call() {
  node -e 'require("node:fs").appendFileSync("root-commands.jsonl", JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(1) }) + "\\n")' "$@"
}
npx() { record_call npx "$@"; }
npm() { record_call npm "$@"; }
`;
  let expectedCalls = 0;
  for (const block of blocks) {
    const command = `${probes}\n${block}`;
    const result = run(command, owner, caller);
    assert.equal(result.status, 0, result.stderr);
    expectedCalls += block.split('\n').filter((line) => /^(npx|npm) /.test(line)).length;
    const before = fs.readFileSync(trace, 'utf8');
    const missingRoot = run(command, path.join(directory, 'missing app'), caller);
    assert.equal(missingRoot.status, 1);
    assert.match(missingRoot.stderr, /BLOCKED: cannot enter working_dir/);
    assert.equal(fs.readFileSync(trace, 'utf8'), before, 'Failed cd must run no follow-up commands');
    assert.equal(fs.existsSync(path.join(caller, 'root-commands.jsonl')), false);
  }
  const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(expectedCalls, 9);
  assert.equal(calls.length, expectedCalls);
  for (const call of calls) {
    // Native realpath expands Windows 8.3 aliases retained by the JS resolver.
    assert.equal(fs.realpathSync.native(call.cwd), fs.realpathSync.native(owner));
  }
  for (const operation of ['refresh-data-source', 'delete-data-source', 'remove-flow', 'generate-schemas', 'tsc']) {
    assert.ok(calls.some((call) => call.args.includes(operation)), operation);
  }
  assert.equal(fs.readFileSync(path.join(caller, 'power.config.json'), 'utf8'), callerConfig);
});

const dataFiles = ['add-connector', 'add-dataverse', 'add-sharepoint']
  .map((name) => path.join(pluginRoot, 'skills', name, 'SKILL.md'));
const connectorReference = read(path.join(pluginRoot, 'shared/connector-reference.md'));

test('shared connector command examples retain the same per-call root guard', () => {
  assert.match(connectorReference, /\[app-working-directory\.md\]\(references\/app-working-directory\.md\)/);
  for (const block of shellBlocks(connectorReference)) {
    assert.ok(block.startsWith(`${guard}\n`));
  }
});

const sampleData = read(path.join(pluginRoot, 'skills/add-sample-data/SKILL.md'));
for (const [eolName, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(`sample-data discovery, insertion, and retry commands re-enter the app root (${eolName})`, () => {
    assert.match(sampleData, /before any project read or command\. Bind the absolute `working_dir` first/);
    assert.match(sampleData, /reuse it for every shell call, file tool, media path, and retry/);
    // Numbered instructions indent some command fences by three spaces.
    const content = sampleData.replace(/\n/g, eol);
    const blocks = shellBlocks(content.replace(/^ {3}/gm, ''));
    assert.ok(blocks.length > 0);
    assert.equal(blocks.length, [...sampleData.matchAll(/^ {0,3}```bash$/gm)].length);
    for (const block of blocks) {
      assert.ok(block.startsWith(`${guard}\n`), 'Each seed command needs a fail-closed root guard');
    }
  });
}

for (const file of dataFiles) {
  const name = path.basename(path.dirname(file));
  const content = read(file).replace(/^> ?/gm, '');
  const blocks = shellBlocks(content);
  for (const [eolName, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    test(`${name} binds addition, discovery, and verification to the app root (${eolName})`, () => {
      assertRootBinding(content.replace(/\n/g, eol));
    });
  }
  test(`${name} rejects missing or deferred root guards`, () => {
    assert.throws(() => assertRootBinding(content.replace(appRootLink, '') + `\n${appRootLink}`));
    for (const block of blocks) {
      assert.throws(() => assertRootBinding(content.replace(block, block.slice(guard.length + 1))));
    }
    for (const block of shellBlocks(content, 'powershell')) {
      assert.throws(() => assertRootBinding(content.replace(block, block.slice(powershellGuard.length + 1))));
    }
  });
  test(`${name} executes documented Bash operations only in the owner app`, (t) => {
    const { directory, owner, caller } = fixture(t);
    const trace = path.join(owner, 'root-commands.jsonl');
    const callerConfig = fs.readFileSync(path.join(caller, 'power.config.json'), 'utf8');
    // External tools are recorders, never real cloud/package operations. Preserve the
    // shell syntax (including substitutions and conditionals) of each documented block.
    const probes = `
record_call() {
  "$REAL_NODE" -e 'require("node:fs").appendFileSync("root-commands.jsonl", JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(1) }) + "\\n")' "$@"
}
node() {
  record_call node "$@"
  if [ "$1" = "-p" ]; then "$REAL_NODE" "$@"; else printf '{}\\n'; fi
}
npx() { record_call npx "$@"; }
npm() { record_call npm "$@"; }
az() { record_call az "$@"; }
`;
    for (const block of blocks) {
      // Whole quoted paths are replaced as literal arguments, including nested
      // $(cat "...") paths. Other placeholders are inert values for the CLI stubs.
      const command = block
        .replaceAll(/"<working_dir>([^"]*)"/g, (_match, suffix) =>
          shellQuote(owner.replaceAll('\\', '/') + suffix.replaceAll(/<[^>]+>/g, 'fixture')))
        .replaceAll(/<[^>]+>/g, 'fixture');
      const result = run(`${probes}\n${command}`, owner, caller);
      assert.equal(result.status, 0, `${name}:\n${block}\n${result.stderr}`);
      const missing = block.replaceAll(/"<working_dir>([^"]*)"/g, (_match, suffix) =>
        shellQuote(path.join(directory, 'missing app').replaceAll('\\', '/') + suffix.replaceAll(/<[^>]+>/g, 'fixture')))
        .replaceAll(/<[^>]+>/g, 'fixture');
      const before = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '';
      const failed = run(`${probes}\n${missing}`, owner, caller);
      assert.equal(failed.status, 1, failed.stderr);
      assert.match(failed.stderr, /BLOCKED: cannot enter working_dir/);
      assert.equal(fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '', before);
      assert.equal(fs.existsSync(path.join(caller, 'root-commands.jsonl')), false);
    }
    const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
    for (const call of calls) {
      assert.equal(fs.realpathSync.native(call.cwd), fs.realpathSync.native(owner));
    }
    for (const operation of ['add-data-source', 'generate-schemas', 'tsc']) {
      assert.ok(calls.some((call) => call.args.includes(operation)), operation);
    }
    if (name === 'add-dataverse') {
      assert.ok(calls.some((call) => call.args.some((arg) => arg.endsWith('/resolve-environment.js')) && call.args.includes('owner')));
      assert.match(content, /--operations "\$\(cat "<working_dir>\/\.tmp\/dataverse-operation-phase-<name>\.json"\)"/);
    }
    assert.equal(fs.readFileSync(path.join(caller, 'power.config.json'), 'utf8'), callerConfig);

    fs.unlinkSync(path.join(owner, 'app.config.js'));
    const invalidProject = run(`${probes}\n${blocks[0].replaceAll('<selected-environment-id>', 'owner')}`, owner, caller);
    assert.equal(invalidProject.status, 1);
    assert.match(invalidProject.stderr, /BLOCKED: working_dir is not an initialized app/);
  });
}

for (const file of ['agents/data-model-architect.md', 'skills/list-connections/SKILL.md']) {
  const content = read(path.join(pluginRoot, file));
  for (const [eolName, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    test(`${file} guards every project operation (${eolName})`, () => {
      assertRootBinding(content.replace(/\n/g, eol));
      for (const block of shellBlocks(content)) {
        assert.throws(() => assertRootBinding(content.replace(block, block.slice(guard.length + 1))));
      }
    });
  }
  test(`${file} executes from the owner root and blocks missing roots`, (t) => {
    const { directory, owner, caller } = fixture(t);
    const trace = path.join(owner, 'helper-calls.jsonl');
    const probes = `
node() { "$REAL_NODE" -e 'require("node:fs").appendFileSync("helper-calls.jsonl", JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(1) }) + "\\n")' -- "$@"; }
npx() { node "$@"; }
`;
    const blocks = shellBlocks(content);
    assert.ok(blocks.length >= 3);
    for (const block of blocks) {
      const materialize = (root) => block
        .replaceAll('"<working_dir>"', shellQuote(root.replaceAll('\\', '/')))
        .replaceAll(/<[^>]+>/g, 'fixture');
      const succeeded = run(`${probes}\n${materialize(owner)}`, owner, caller);
      assert.equal(succeeded.status, 0, `${block}\n${succeeded.stderr}`);
      const before = fs.readFileSync(trace, 'utf8');
      const failed = run(`${probes}\n${materialize(path.join(directory, 'missing app'))}`, owner, caller);
      assert.equal(failed.status, 1);
      assert.match(failed.stderr, /BLOCKED: cannot enter working_dir/);
      assert.equal(fs.readFileSync(trace, 'utf8'), before);
      assert.equal(fs.existsSync(path.join(caller, 'helper-calls.jsonl')), false);
    }
    const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
    for (const call of calls) {
      assert.equal(fs.realpathSync.native(call.cwd), fs.realpathSync.native(owner));
    }
    if (file.startsWith('agents/')) {
      const resolver = calls.find((call) => call.args.some((arg) => arg.endsWith('/resolve-environment.js')));
      assert.ok(resolver);
      assert.ok(resolver.args.includes('--no-cache'));
      assert.ok(resolver.args.includes('--require-tenant'));
    } else {
      assert.ok(calls.every((call) => call.args[0] === '--no-install'));
    }
  });
}

test('connector execution and referenced examples always use the installed local CLI', () => {
  for (const file of ['skills/add-connector/SKILL.md', 'skills/list-connections/SKILL.md', 'shared/connector-reference.md']) {
    const blocks = shellBlocks(read(path.join(pluginRoot, file)));
    const commands = blocks.flatMap((block) => [...block.matchAll(/^\s*npx[^\n]*\bpower-apps\b[^\n]*/gm)]
      .map((match) => match[0].trim()));
    assert.ok(commands.length >= 3, file);
    for (const command of commands) {
      assert.match(command, /^npx --no-install power-apps /, `${file}: ${command}`);
    }
  }
});

const pwshProbe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
  encoding: 'utf8',
});
test('SharePoint PowerShell root guards preserve literal paths and fail before any operation', {
  skip: pwshProbe.error?.code === 'ENOENT' && !process.env.CI ? 'PowerShell is unavailable locally; required in CI' : false,
}, (t) => {
  assert.ifError(pwshProbe.error);
  assert.equal(pwshProbe.status, 0, pwshProbe.stderr);
  const { directory, owner, caller } = fixture(t);
  const trace = path.join(owner, 'powershell-root.txt');
  const content = read(path.join(pluginRoot, 'skills/add-sharepoint/SKILL.md'));
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  for (const block of shellBlocks(content, 'powershell')) {
    const call = (root) => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
      `${block.split('\n')[0].replace("'<working_dir>'", quote(root))}\n` +
      "[System.IO.File]::WriteAllText((Join-Path (Get-Location).Path 'powershell-root.txt'), (Get-Location).Path)",
    ], { cwd: caller, encoding: 'utf8', timeout: 10000 });
    const result = call(owner);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.realpathSync.native(fs.readFileSync(trace, 'utf8')), fs.realpathSync.native(owner));
    fs.unlinkSync(trace);
    const failed = call(path.join(directory, 'missing app'));
    assert.ifError(failed.error);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /does not exist|Cannot find path/);
    assert.equal(fs.existsSync(trace), false);
    assert.equal(fs.existsSync(path.join(caller, 'powershell-root.txt')), false);
  }
});
