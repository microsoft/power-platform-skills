'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../..');
const nativeRoot = path.join(pluginRoot, 'skills/add-native');
const normalize = (text) => text.replace(/\r\n?/g, '\n');
const read = (file) => normalize(fs.readFileSync(file, 'utf8'));
const reference = read(path.join(pluginRoot, 'shared/references/native-artifact-compatibility.md'));
const rootLink = '[native-artifact-compatibility.md Step 0](${PLUGIN_ROOT}/shared/references/native-artifact-compatibility.md#0-bind-every-operation-to-the-app-root)';
const appRootReference = read(path.join(pluginRoot, 'shared/references/app-working-directory.md'));
const appRootLink = '[app-working-directory.md](${PLUGIN_ROOT}/shared/references/app-working-directory.md)';
const guard = 'cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }';
const powershellGuard = "Set-Location -LiteralPath '<working_dir>' -ErrorAction Stop";
const files = [
  path.join(nativeRoot, 'SKILL.md'),
  ...fs.readdirSync(nativeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(nativeRoot, entry.name, 'SKILL.md'))
    .filter((file) => fs.existsSync(file)),
];

function shellBlocks(text, language = 'bash') {
  const unquoted = normalize(text).replace(/^> ?/gm, '');
  return [...unquoted.matchAll(new RegExp('^```' + language + '\\n([\\s\\S]*?)\\n```', 'gm'))]
    .map((match) => match[1]);
}

function assertRootBinding(text, link = rootLink) {
  text = normalize(text);
  assert.match(text, /before any project read or command, execute/);
  assert.ok(text.includes(link));
  assert.ok(text.indexOf(link) < text.indexOf('```bash'), 'Bind root before the first gate');
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
const dependencies = {
  'expo-camera': '1.0.0',
  'expo-secure-store': '1.0.0',
  'expo-print': '1.0.0',
  '@microsoft/power-apps-native-pdf-viewer': '0.2.9',
  '@microsoft/power-apps-native-pen-input': '1.0.0',
  '@microsoft/power-apps-native-bglocation': '1.0.0',
};

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'app-working-dir-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const owner = path.join(directory, "owner's app [test] $root `literal`");
  const caller = path.join(directory, 'different app');
  for (const root of [owner, caller]) {
    fs.mkdirSync(path.join(root, 'src/native'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app.config.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(root, 'power.config.json'), JSON.stringify({ environmentId: root === owner ? 'owner' : 'caller' }));
    fs.writeFileSync(path.join(root, 'native-app-plan.md'), '# Plan\n');
    fs.mkdirSync(path.join(root, '.tmp'));
    for (const name of ['dataverse-operation-all.json', 'dataverse-operation-phase-fixture.json']) {
      fs.writeFileSync(path.join(root, '.tmp', name), '[]');
    }
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      dependencies: root === owner ? dependencies : {},
    }));
    const installed = path.join(root, 'node_modules/@microsoft/power-apps-native-pdf-viewer');
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ version: '0.2.9' }));
  }
  return { directory, owner, caller };
}

function run(block, owner, caller) {
  const command = block
    .replaceAll('"<working_dir>"', shellQuote(owner.replaceAll('\\', '/')))
    .replaceAll('<approved-artifact-keys-json>', '["scanner"]')
    .replaceAll('<expo-module-name>', 'expo-secure-store');
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
  const binding = '[app-working-directory.md](references/app-working-directory.md)';
  assert.ok(shared.includes(binding));
  assert.ok(shared.indexOf(binding) < shared.indexOf('Classify the current request'));
  assert.match(reference, /## 0\. Bind every operation to the app root[\s\S]*\[app-working-directory\.md\]\(app-working-directory\.md\)/);
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

for (const name of ['add-dataverse', 'add-sample-data']) {
  const content = read(path.join(pluginRoot, 'skills', name, 'SKILL.md')).replace(/^> ?/gm, '');
  for (const [eolName, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    test(`${name} roots all Bash commands, including indented recipes (${eolName})`, () => {
      // Numbered instructions indent command fences by two or three spaces.
      const source = content.replace(/\n/g, eol).replace(/^ {1,3}/gm, '');
      const blocks = shellBlocks(source);
      assert.equal(blocks.length, [...content.matchAll(/^ {0,3}```bash$/gm)].length);
      assertRootBinding(source, appRootLink);
      for (const block of blocks) {
        const unguarded = normalize(source).replace(block, block.slice(guard.length + 1));
        assert.throws(() => assertRootBinding(unguarded, appRootLink));
      }
    });
  }
}

test('Dataverse nested metadata and generated-file paths stay literal and app-rooted', () => {
  const content = read(path.join(pluginRoot, 'skills/add-dataverse/SKILL.md'));
  assert.match(content, /--operations "\$\(cat "<working_dir>\/\.tmp\/derived-metadata-operations\.json"\)"/);
  assert.match(content, /Glob: <working_dir>\/src\/generated\/services\/\*Service\.ts/);
  assert.match(content, /Glob: <working_dir>\/src\/generated\/models\/\*Model\.ts/);
});

test('documented seed commands block missing roots before any script or CLI call', (t) => {
  const { directory, owner, caller } = fixture(t);
  const content = read(path.join(pluginRoot, 'skills/add-sample-data/SKILL.md')).replace(/^> ?/gm, '');
  const blocks = shellBlocks(content.replace(/^ {1,3}/gm, ''));
  assert.equal(blocks.length, 11);
  const trace = path.join(owner, 'seed-root-commands.jsonl');
  const callerTrace = path.join(caller, 'seed-root-commands.jsonl');
  const ownerConfig = fs.readFileSync(path.join(owner, 'power.config.json'));
  const callerConfig = fs.readFileSync(path.join(caller, 'power.config.json'));
  fs.writeFileSync(path.join(owner, '.datamodel-manifest.json'), '{"tables":[]}');
  // Script/cloud commands are recorders; only the fixed local logger uses real Node.
  const probes = `
record_call() {
  "$REAL_NODE" -e 'require("node:fs").appendFileSync("seed-root-commands.jsonl", JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(1) }) + "\\n")' "$@"
}
node() {
  record_call node "$@"
  if [ "$1" = "-p" ]; then printf 'owner\\n'; else printf '{}\\n'; fi
}
az() { record_call az "$@"; printf 'fixture-account\\n'; }
npx() { record_call npx "$@"; }
npm() { record_call npm "$@"; }
`;
  const prepare = (block, root) => {
    const command = block
      .replaceAll(/"<working_dir>([^"]*)"/g, (_match, suffix) =>
        shellQuote(root.replaceAll('\\', '/') + suffix.replaceAll(/<[^>]+>/g, 'fixture')))
      .replaceAll(/<[^>]+>/g, 'fixture');
    assert.doesNotMatch(command, /<[^>]+>/);
    return `${probes}\nPLUGIN_ROOT=${shellQuote(pluginRoot.replaceAll('\\', '/'))}\n${command}`;
  };
  for (const block of blocks) {
    const valid = run(prepare(block, owner), owner, caller);
    assert.equal(valid.status, 0, `${block}\n${valid.stderr}`);
    assert.equal(valid.stderr, '');
    const before = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '';
    const missing = run(prepare(block, path.join(directory, 'missing seed app')), owner, caller);
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /BLOCKED: cannot enter working_dir/);
    assert.doesNotMatch(missing.stderr, /syntax error|unexpected token|unexpected EOF/);
    assert.equal(fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '', before, 'Failed cd must invoke no script or CLI');
    assert.equal(fs.existsSync(callerTrace), false);
  }
  const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 11);
  for (const call of calls) {
    assert.equal(fs.realpathSync.native(call.cwd), fs.realpathSync.native(owner));
  }
  assert.ok(calls.some((call) => call.args[0] === 'az'));
  assert.ok(calls.some((call) => call.args.includes('BATCH-RECORDS')));
  assert.ok(calls.some((call) => call.args.some((arg) => arg.endsWith('/resolve-environment.js')) && call.args.includes('owner')));
  assert.deepEqual(fs.readFileSync(path.join(owner, 'power.config.json')), ownerConfig);
  assert.deepEqual(fs.readFileSync(path.join(caller, 'power.config.json')), callerConfig);
});

for (const file of dataFiles) {
  const name = path.basename(path.dirname(file));
  const content = read(file).replace(/^> ?/gm, '');
  const blocks = shellBlocks(content);
  for (const [eolName, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    test(`${name} binds addition, discovery, and verification to the app root (${eolName})`, () => {
      assertRootBinding(content.replace(/\n/g, eol), appRootLink);
    });
  }
  test(`${name} rejects missing or deferred root guards`, () => {
    assert.throws(() => assertRootBinding(content.replace(appRootLink, '') + `\n${appRootLink}`, appRootLink));
    for (const block of blocks) {
      assert.throws(() => assertRootBinding(content.replace(block, block.slice(guard.length + 1)), appRootLink));
    }
    for (const block of shellBlocks(content, 'powershell')) {
      assert.throws(() => assertRootBinding(content.replace(block, block.slice(powershellGuard.length + 1)), appRootLink));
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

for (const file of files) {
  const name = path.relative(nativeRoot, file);
  const content = read(file);
  const blocks = shellBlocks(content);

  for (const [eolName, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    test(`${name} binds every shell call and file tool before project access (${eolName})`, () => {
      assertRootBinding(content.replace(/\n/g, eol));
    });
  }

  test(`${name} rejects a deferred root preflight or a missing later cd`, () => {
    assert.throws(() => assertRootBinding(content.replace(rootLink, '') + `\n${rootLink}`));
    for (const block of blocks) {
      assert.throws(() => assertRootBinding(content.replace(block, block.slice(guard.length + 1))));
    }
  });

  test(`${name} executes project and package gates against the owner, not the launch directory`, (t) => {
    const { owner, caller } = fixture(t);
    const projectGate = blocks[0];
    const packageGate = blocks.find((block) => block.includes("require('./package.json')"));
    assert.ok(packageGate);
    for (const gate of new Set([projectGate, packageGate])) {
      const result = run(gate, owner, caller);
      assert.equal(result.status, 0, result.stderr);
    }

    fs.unlinkSync(path.join(owner, 'app.config.js'));
    const invalidProject = run(projectGate, owner, caller);
    assert.equal(invalidProject.status, 1);
    assert.match(invalidProject.stderr, /BLOCKED: working_dir is not an initialized app/);
    fs.writeFileSync(path.join(owner, 'app.config.js'), 'module.exports = {};');

    fs.writeFileSync(path.join(owner, 'package.json'), '{"dependencies":{}}');
    fs.writeFileSync(path.join(caller, 'package.json'), JSON.stringify({ dependencies }));
    const missingPackage = run(packageGate, owner, caller);
    assert.equal(missingPackage.status, 1);
    assert.match(missingPackage.stderr, /MISSING/);
  });

  test(`${name} roots relative write probes and stops before writes when cd fails`, (t) => {
    const { directory, owner, caller } = fixture(t);
    const probe = "node -e \"require('node:fs').writeFileSync('src/native/root-probe.txt', 'scoped')\"";
    // Probe the actual per-call guard without executing network or type-check commands.
    const command = `${blocks[0].split('\n')[0]}\n${probe}`;
    assert.equal(run(command, owner, caller).status, 0);
    assert.equal(fs.readFileSync(path.join(owner, 'src/native/root-probe.txt'), 'utf8'), 'scoped');
    assert.equal(fs.existsSync(path.join(caller, 'src/native/root-probe.txt')), false);
    const missingRoot = run(command, path.join(directory, 'missing app'), caller);
    assert.equal(missingRoot.status, 1);
    assert.match(missingRoot.stderr, /BLOCKED: cannot enter working_dir/);
    assert.equal(fs.existsSync(path.join(caller, 'src/native/root-probe.txt')), false);
  });
}
