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
const guard = 'cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }';
const files = [
  path.join(nativeRoot, 'SKILL.md'),
  ...fs.readdirSync(nativeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(nativeRoot, entry.name, 'SKILL.md'))
    .filter((file) => fs.existsSync(file)),
];

function shellBlocks(text) {
  return [...normalize(text).matchAll(/^```bash\n([\s\S]*?)\n```/gm)].map((match) => match[1]);
}

function assertRootBinding(text) {
  text = normalize(text);
  assert.match(text, /before any project read or command, execute/);
  assert.ok(text.includes(rootLink));
  assert.ok(text.indexOf(rootLink) < text.indexOf('```bash'), 'Bind root before the first gate');
  assert.match(text, /every shell call and\s+file tool/);
  const blocks = shellBlocks(text);
  assert.ok(blocks.length > 0);
  for (const block of blocks) {
    assert.ok(block.startsWith(`${guard}\n`), 'Every shell call must re-enter the app root');
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
  const owner = path.join(directory, "owner's app with spaces");
  const caller = path.join(directory, 'different app');
  for (const root of [owner, caller]) {
    fs.mkdirSync(path.join(root, 'src/native'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app.config.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(root, 'power.config.json'), '{}');
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

test('native root contract distinguishes direct defaults from required child context and file-tool scope', () => {
  const scope = reference.split('## 0. Bind every operation to the app root\n')[1]?.split('## 1.')[0];
  assert.ok(scope);
  assert.match(scope, /Child invocation[\s\S]*owner's absolute\s+`working_dir`/);
  assert.match(scope, /Never fall back to the process cwd/);
  assert.match(scope, /Missing or\s+relative owner context returns `NEEDS_CONTEXT` before project access/);
  assert.match(scope, /Direct invocation[\s\S]*`--working-dir`[\s\S]*capture the\s+initial cwd once/);
  assert.match(scope, /Canonicalize the existing directory/);
  assert.match(scope, /different roots, return `NEEDS_CONTEXT`/);
  assert.match(scope, /inaccessible directory is `BLOCKED`/);
  assert.match(scope, /does not persist across tool calls/);
  assert.match(scope, /shell-quoted literal argument/);
  assert.match(scope, /File tools do not inherit shell cwd/);
  assert.match(scope, /Read\/Edit\/Write\/Grep\/Glob absolute\s+project paths/);
  assert.match(scope, /grants no additional approval and does not relax plan-only mode/);
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
    assert.match(scope, /missing, relative, or conflicting\s+owner context returns `NEEDS_CONTEXT`/);
    assert.match(scope, /never a fallback to the process cwd/);
    assert.match(scope, /direct call[\s\S]*`--working-dir`[\s\S]*initial cwd once/);
    assert.match(scope, /Canonicalize the existing directory/);
    assert.match(scope, /Every shell call[\s\S]*CLI help[\s\S]*service verification, and\s+retries/);
    assert.match(scope, /shell-quoted literal\s+argument/);
    assert.match(scope, /absolute Read\/Edit\/Write\/Grep\/Glob paths/);
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
