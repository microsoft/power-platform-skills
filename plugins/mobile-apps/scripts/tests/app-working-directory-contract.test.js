'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { shellBlocks } = require('./helpers/markdown-shell-blocks');

const pluginRoot = path.resolve(__dirname, '../..');
const normalize = (text) => text.replace(/\r\n?/g, '\n');
const read = (file) => normalize(fs.readFileSync(file, 'utf8'));
const appRootReference = read(path.join(pluginRoot, 'shared/references/app-working-directory.md'));
const appRootLink = '[app-working-directory.md](${PLUGIN_ROOT}/shared/references/app-working-directory.md)';
const guard = "cd -- '<working_dir>' || { echo \"BLOCKED: cannot enter working_dir\" >&2; exit 1; }";
const powershellGuard = "Set-Location -LiteralPath '<working_dir>' -ErrorAction Stop";
const quotedFileArgument = /--(?:working-dir|project-root|approval-receipt|contract|file|output|publish-checkpoint|reconciliation|snapshot|validate)\s+"[^"\n]*<[^>\n]+>[^"\n]*"/;

function unsafePathLiteral(line) {
  if (quotedFileArgument.test(line)) return true;
  return [...line.matchAll(/"([^"\n]*)"/g)].some((match) =>
    match[1].includes('<working_dir>') && !/^\$\(cat '<working_dir>[^']*'\)$/.test(match[1]));
}

for (const prefix of ['', '   ', '> ', '>   ']) {
  for (const eol of ['\n', '\r\n']) {
    test(`shell recipe extraction retains source quoting with prefix ${JSON.stringify(prefix)} and ${eol === '\n' ? 'LF' : 'CRLF'}`, () => {
      const body = `${guard}\nnode tool.js --project-root '<working_dir>'`;
      const markdown = ['```bash', ...body.split('\n'), '```']
        .map((line) => prefix + line).join(eol);
      assert.deepEqual(shellBlocks(markdown), [body]);
      assert.deepEqual(shellBlocks(markdown, 'powershell'), []);
    });
  }
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
    assert.ok(!block.split('\n').some(unsafePathLiteral), 'Arguments and artifact aliases must preserve literal paths too');
  }
  for (const block of shellBlocks(text, 'powershell')) {
    assert.ok(block.startsWith(`${powershellGuard}\n`), 'PowerShell calls need a literal fail-closed root');
  }
}

function assertEveryGuardIsRequired(content, command, language = 'bash') {
  let count = 0;
  // Use source offsets: extracted list/blockquote snippets have already been dedented.
  for (let index = content.indexOf(command); index !== -1; index = content.indexOf(command, index + command.length)) {
    assert.throws(() => assertRootBinding(content.slice(0, index) + content.slice(index + command.length)));
    count++;
  }
  assert.equal(count, shellBlocks(content, language).length);
}

// Use Git Bash, not WSL bash, for Windows checkout paths, as in the creation tests.
const bashPaths = process.platform === 'win32'
  ? (spawnSync('where.exe', ['bash'], { encoding: 'utf8' }).stdout || '').split(/\r?\n/)
  : [];
const bash = bashPaths.find((entry) => /[\\/]Git[\\/]/i.test(entry)) || 'bash';
const shellLiteralContents = (value) => value.replaceAll('\\', '/').replaceAll("'", "'\\''");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'app-working-dir-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const owner = path.join(directory, "owner's app [test] $root $(printf expanded) `printf backtick`");
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
  const command = block.replaceAll('<working_dir>', shellLiteralContents(owner));
  // Use the current Node executable; mutation tests supply local CLI probes.
  const result = spawnSync(bash, ['-s'], {
    input: `node() { "$REAL_NODE" "$@"; }\nPA="npx --no-install pa"\nPA_KIND=pa\n${command}`,
    cwd: caller,
    env: {
      ...process.env,
      REAL_NODE: process.execPath.replaceAll('\\', '/'),
      PLUGIN_ROOT: pluginRoot.replaceAll('\\', '/'),
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
  assert.match(scope, /shell-quoted literal argument/);
  assert.match(scope, /keep the surrounding single quotes/);
  assert.match(scope, /Never interpolate a path inside double quotes/);
  assert.match(scope, /File tools do not inherit shell cwd/);
  assert.match(scope, /Read\/Edit\/Write\/Grep\/Glob absolute\s+project paths/);
  assert.match(scope, /grants no additional approval and does not relax\nplan-only mode/);
  assert.match(scope, /Git Bash\s+on Windows/);
  assert.match(scope, /existing PowerShell helper/);
  assert.match(scope, /double\s+embedded apostrophes/);
  assert.match(scope, /re-supply any required\nshell variables/);
  assert.match(scope, /Resolve `\$PA` and `PA_KIND` for this app via \[cli-binary\.md\]/);
  assert.match(scope, /not from another app's cached selection/);
  assert.match(scope, /Re-supply both in each fresh shell\s+call after binding the root/);
  assert.equal(shellBlocks(scope)[0], guard);
  assert.equal(shellBlocks(scope, 'powershell')[0], powershellGuard);
});

for (const [file, selector] of [
  ['agents/data-model-architect.md', '/render-dataverse-architect-evidence.js'],
  ['shared/references/dataverse-change-planning.md', '/validate-dataverse-planning-decisions.js'],
]) {
  test(`${file} keeps caller-supplied evidence path aliases literal`, (t) => {
    const { owner, caller } = fixture(t);
    const block = shellBlocks(read(path.join(pluginRoot, file)))
      .find((command) => command.includes(selector));
    assert.ok(block);
    const snapshot = `${owner.replaceAll('\\', '/')}/.tmp/snapshot.json`;
    const evidence = `${owner.replaceAll('\\', '/')}/.tmp/evidence.json`;
    const command = block
      .replaceAll('<foreground snapshot path>', shellLiteralContents(snapshot))
      .replaceAll('<compact architect evidence path>', shellLiteralContents(evidence))
      .replaceAll('<SNAPSHOT_PATH>', shellLiteralContents(snapshot));
    const probe = 'node() { "$REAL_NODE" -e \'console.log(JSON.stringify(process.argv.slice(1)))\' "$@"; }';
    const result = run(`${probe}\n${command}`, owner, caller);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const args = JSON.parse(result.stdout);
    assert.equal(args[args.indexOf('--snapshot') + 1], snapshot);
    if (args.includes('--output')) assert.equal(args[args.indexOf('--output') + 1], evidence);
  });
}

test('canonical root guard treats dollar and backtick syntax as literal path contents', (t) => {
  const { owner, caller } = fixture(t);
  const literalPath = owner.replaceAll('\\', '/').replaceAll("'", "'\\''");
  const command = guard.replace('<working_dir>', literalPath) +
    '\nnode -p "process.cwd()"';
  const result = run(command, owner, caller);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(fs.realpathSync.native(result.stdout.trim()), fs.realpathSync.native(owner));
});

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(file) : entry.name.endsWith('.md') ? [file] : [];
  });
}

test('shell commands and handoffs never interpolate root or artifact-path literals inside double quotes', () => {
  const offenders = [];
  for (const directory of ['agents', 'shared', 'skills']) {
    for (const file of markdownFiles(path.join(pluginRoot, directory))) {
      const text = read(file);
      const snippets = [
        ...shellBlocks(text),
        ...shellBlocks(text, 'text').flatMap((snippet) =>
          snippet.split('\n').filter((line) => quotedFileArgument.test(line))),
        ...[...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1])
          .filter((code) => !/^".*"$/.test(code.trim())),
      ];
      snippets.flatMap((snippet) => snippet.split('\n')).forEach((line) => {
        // Structured file-tool arguments are not shell commands.
        if (/\b(?:Grep|Glob|Read|Write|Edit)\b.*\b(?:path|file_path)=/.test(line)) return;
        if (unsafePathLiteral(line)) offenders.push(`${path.relative(pluginRoot, file)}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(offenders, []);
});

test('documented normalization arguments preserve literal root contents without repairing their quotes', (t) => {
  const { owner, caller } = fixture(t);
  const reference = read(path.join(pluginRoot, 'shared/references/dataverse-change-planning.md'));
  const block = shellBlocks(reference).find((command) => command.includes('--normalize-contract'));
  assert.ok(block);
  const probe = 'node() { "$REAL_NODE" -e \'console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(1) }))\' "$@"; }';
  const result = run(`${probe}\n${block}`, owner, caller);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const call = JSON.parse(result.stdout);
  assert.equal(fs.realpathSync.native(call.cwd), fs.realpathSync.native(owner));
  const contract = `${owner.replaceAll('\\', '/')}/.tmp/dataverse-schema-contract.json`;
  assert.deepEqual(call.args.slice(1), ['--normalize-contract', contract, '--output', contract]);

  const unsafe = block.replaceAll("'<working_dir>/.tmp/dataverse-schema-contract.json'", '"<working_dir>/.tmp/dataverse-schema-contract.json"');
  assert.notEqual(unsafe, block);
  const unsafeResult = run(`${probe}\n${unsafe}`, owner, caller);
  assert.equal(unsafeResult.status, 0, unsafeResult.stderr);
  assert.notDeepEqual(JSON.parse(unsafeResult.stdout).args.slice(1), call.args.slice(1),
    'The harness must expose unsafe source quoting, not rewrite it to a safe form');
});

for (const file of [
  'shared/references/offline-profile-reconciliation.md',
  'skills/deploy/SKILL.md',
  'skills/edit-app/SKILL.md',
]) {
  test(`${file} checks the actual owner project from a different app launch directory`, (t) => {
    const { owner, caller } = fixture(t);
    for (const [root, table] of [[owner, 'cr_owner'], [caller, 'cr_caller']]) {
      fs.writeFileSync(path.join(root, '.datamodel-manifest.json'),
        JSON.stringify({ tables: [{ logicalName: table, columns: [] }] }));
      fs.writeFileSync(path.join(root, 'offline-profile.json'),
        JSON.stringify({ profileId: 'test-profile', tables: [] }));
    }
    const block = shellBlocks(read(path.join(pluginRoot, file)))
      .find((command) => command.includes('/offline-profile-delta.js'));
    assert.ok(block);
    const result = run(block, owner, caller);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const delta = JSON.parse(result.stdout);
    assert.equal(delta.status, 'delta');
    assert.deepEqual(delta.missingTables.map((table) => table.logicalName), ['cr_owner']);
  });
}

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
    expectedCalls += block.split('\n').filter((line) => /^(?:\$PA|npx|npm) /.test(line)).length;
    const before = fs.readFileSync(trace, 'utf8');
    const missingRoot = run(command, path.join(directory, 'missing app'), caller);
    assert.equal(missingRoot.status, 1);
    assert.match(missingRoot.stderr, /BLOCKED: cannot enter working_dir/);
    assert.equal(fs.readFileSync(trace, 'utf8'), before, 'Failed cd must run no follow-up commands');
    assert.equal(fs.existsSync(path.join(caller, 'root-commands.jsonl')), false);
  }
  const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(expectedCalls, 8);
  assert.equal(calls.length, expectedCalls);
  for (const call of calls) {
    // Native realpath expands Windows 8.3 aliases retained by the JS resolver.
    assert.equal(fs.realpathSync.native(call.cwd), fs.realpathSync.native(owner));
  }
  for (const operation of ['refresh', 'remove', 'generate-schemas', 'tsc']) {
    assert.ok(calls.some((call) => call.args.includes(operation)), operation);
  }
  const cliCalls = calls.filter((call) => call.args[2] === 'pa');
  assert.equal(cliCalls.length, 4);
  for (const call of cliCalls) {
    assert.deepEqual(call.args.slice(0, 4), ['npx', '--no-install', 'pa', 'app']);
    assert.equal(call.args[5], 'data-source');
    assert.ok(call.args.includes('--name'));
    assert.ok(call.args.includes('--non-interactive'));
    if (call.args[4] === 'remove') assert.ok(call.args.includes('--force'));
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
    assertEveryGuardIsRequired(content, guard);
    assertEveryGuardIsRequired(content, powershellGuard, 'powershell');
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
      // Substitute values only; changing the authored quotes would conceal a regression.
      const command = block.replaceAll(/<(?!working_dir>)[^>]+>/g, 'fixture');
      const result = run(`${probes}\n${command}`, owner, caller);
      assert.equal(result.status, 0, `${name}:\n${block}\n${result.stderr}`);
      const before = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '';
      const failed = run(`${probes}\n${command}`, path.join(directory, 'missing app'), caller);
      assert.equal(failed.status, 1, failed.stderr);
      assert.match(failed.stderr, /BLOCKED: cannot enter working_dir/);
      assert.equal(fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '', before);
      assert.equal(fs.existsSync(path.join(caller, 'root-commands.jsonl')), false);
    }
    const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
    for (const call of calls) {
      assert.equal(fs.realpathSync.native(call.cwd), fs.realpathSync.native(owner));
    }
    for (const operation of ['data-source', 'generate-schemas', 'tsc']) {
      assert.ok(calls.some((call) => call.args.includes(operation)), operation);
    }
    assert.ok(calls.some((call) => call.args.includes('add') && call.args.includes('data-source')));
    if (name === 'add-dataverse') {
      assert.ok(calls.some((call) => call.args.some((arg) => arg.endsWith('/resolve-environment.js')) && call.args.includes('owner')));
      assert.match(content, /--operations "\$\(cat '<working_dir>\/\.tmp\/dataverse-operation-phase-<name>\.json'\)"/);
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
      assertEveryGuardIsRequired(content, guard);
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
      const command = block.replaceAll(/<(?!working_dir>)[^>]+>/g, 'fixture');
      const succeeded = run(`${probes}\n${command}`, owner, caller);
      assert.equal(succeeded.status, 0, `${block}\n${succeeded.stderr}`);
      const before = fs.readFileSync(trace, 'utf8');
      const failed = run(`${probes}\n${command}`, path.join(directory, 'missing app'), caller);
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
      const metadata = calls.filter((call) => /\/(?:verify-dataverse-access|dataverse-request|list-table-columns)\.js$/.test(call.args[0]));
      assert.equal(metadata.length, 4);
      for (const call of metadata) {
        assert.ok(call.args.includes('--tenant-id'));
        assert.equal(call.args[call.args.indexOf('--tenant-id') + 1], 'fixture');
      }
    } else {
      assert.ok(calls.every((call) => call.args[0] === '--no-install'));
    }
  });
}

test('connector execution and referenced examples consistently use the resolved PA command', () => {
  for (const file of ['skills/add-connector/SKILL.md', 'skills/list-connections/SKILL.md', 'shared/connector-reference.md']) {
    const blocks = shellBlocks(read(path.join(pluginRoot, file)));
    const commands = blocks.flatMap((block) => [...block.matchAll(/^\s*\$PA [^\n]*/gm)]
      .map((match) => match[0].trim()));
    assert.ok(commands.length >= 3, file);
    for (const command of commands) {
      assert.match(command, /^\$PA (?:app|connection) /, `${file}: ${command}`);
      assert.doesNotMatch(command, /--(?:api-id|resource-name|data-source-name|sql-stored-procedure)\b/);
    }
    assert.doesNotMatch(blocks.join('\n'), /^\s*npx[^\n]*\b(?:power-apps|pa)\b/m);
  }
});

const cliResolution = shellBlocks(read(path.join(pluginRoot, 'shared/cli-binary.md')))[0];
for (const [shims, kind] of [
  [['pa', 'power-apps'], 'pa'],
  [['pa.cmd', 'power-apps.cmd'], 'pa'],
  [['power-apps'], 'power-apps'],
  [['power-apps.cmd'], 'power-apps'],
  [[], 'none'],
]) {
  test(`CLI resolution in the owner app selects ${kind} with ${shims.join(', ') || 'no shims'}`, (t) => {
    const { owner, caller } = fixture(t);
    const bin = path.join(owner, 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    for (const shim of shims) fs.writeFileSync(path.join(bin, shim), '');
    const command = `${guard}\n${cliResolution}\nprintf '%s|%s' "$PA_KIND" "$PA"`;
    const result = run(command, owner, caller);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${kind}|${kind === 'none' ? '' : `npx --no-install ${kind}`}`);
  });
}

const previewOpeners = [
  ['skills/design-system/references/vibe/style-picker.md', '_design_vibe.html'],
  ['skills/preview-screens/SKILL.md', 'preview.html'],
];

function captureWindowsOpener(t, file, filename) {
  const { owner, caller } = fixture(t);
  const block = shellBlocks(read(path.join(pluginRoot, file)))
    .find((command) => command.includes('powershell.exe'));
  assert.ok(block);
  const probes = `
open() { return 1; }
xdg-open() { return 1; }
powershell.exe() {
  "$REAL_NODE" -e 'console.log(JSON.stringify({ path: process.env.MOBILE_APP_PREVIEW_PATH, args: process.argv.slice(1) }))' -- "$@"
}
`;
  const result = run(`${probes}\n${block}`, owner, caller);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const call = JSON.parse(result.stdout);
  assert.equal(call.path, `${owner.replaceAll('\\', '/')}/${filename}`);
  assert.deepEqual(call.args, ['-NoProfile', '-Command', 'Start-Process -FilePath $env:MOBILE_APP_PREVIEW_PATH']);
  return { block, owner, caller, call };
}

for (const [file, filename] of previewOpeners) {
  test(`${file} passes a literal Windows path as data and reports failed openers safely`, (t) => {
    const { block, owner, caller } = captureWindowsOpener(t, file, filename);
    const failed = run('open() { return 1; }\nxdg-open() { return 1; }\npowershell.exe() { return 1; }\n' + block,
      owner, caller);
    assert.equal(failed.status, 0, failed.stderr);
    assert.equal(failed.stderr, '');
    assert.match(failed.stdout, /Could not auto-open/);
    assert.ok(failed.stdout.includes(`file://${owner.replaceAll('\\', '/')}/${filename}`));
  });
}

const pwshProbe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
  encoding: 'utf8',
});
test('PowerShell root guards and preview openers preserve literal paths', {
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
  for (const [file, filename] of previewOpeners) {
    const { call } = captureWindowsOpener(t, file, filename);
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
      'function Start-Process { param([string]$FilePath) @{ path = $FilePath } | ConvertTo-Json -Compress }\n' +
      call.args[2],
    ], {
      env: { ...process.env, MOBILE_APP_PREVIEW_PATH: call.path },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).path, call.path);
  }
});
