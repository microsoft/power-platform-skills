'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(pluginRoot, file), 'utf8').replace(/\r\n?/g, '\n');
const helpers = ['add-table-to-offline-profile', 'edit-offline-profile', 'enable-tables-offline'];
const documents = Object.fromEntries(helpers.map((name) => [name, read(`skills/${name}/SKILL.md`)]));
const reference = read('shared/references/app-working-directory.md');
const rootLink = '[app-working-directory.md](${PLUGIN_ROOT}/shared/references/app-working-directory.md)';
const shellBlocks = (text) => [...text.replace(/\r\n?/g, '\n').matchAll(/^```bash\n([\s\S]*?)\n```/gm)]
  .map((match) => match[1]);
const guard = shellBlocks(reference)[0];
const slashPath = (value) => value.replaceAll('\\', '/');

// The documented Windows shell is Git Bash, not a WSL filesystem.
const bashPaths = process.platform === 'win32'
  ? (spawnSync('where.exe', ['bash'], { encoding: 'utf8' }).stdout || '').split(/\r?\n/)
  : [];
const bash = bashPaths.find((entry) => /[\\/]Git[\\/]/i.test(entry)) || 'bash';
const context = {
  environmentId: 'owner-environment',
  environmentUrl: 'https://contoso.crm.dynamics.com',
  tenantId: '00000000-0000-0000-0000-000000000000',
  profileId: '11111111-1111-1111-1111-111111111111',
  itemId: '22222222-2222-2222-2222-222222222222',
  table: 'cr123_visit',
};

function section(text, from, to) {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `Missing section: ${from}`);
  return text.slice(start, end);
}

function fixture(t) {
  // Keep generated fixtures in the checkout, never the system temporary directory.
  const relative = `.offline-helper-root-fixture-${randomUUID()}`;
  fs.mkdirSync(relative);
  t.after(() => fs.rmSync(relative, { recursive: true, force: true }));
  for (const [name, environmentId] of [
    ["owner's app [test] $literal $(printf value) `printf tick`", context.environmentId],
    ['different app', 'caller-environment'],
  ]) {
    const root = path.join(relative, name);
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'app.config.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(root, 'power.config.json'), JSON.stringify({ environmentId }));
    fs.writeFileSync(path.join(root, '.datamodel-manifest.json'),
      JSON.stringify({ tables: [{ logicalName: root.includes('different') ? 'cr123_other' : context.table }] }));
    fs.writeFileSync(path.join(root, 'offline-profile.json'),
      JSON.stringify({ profileId: root.includes('different') ? 'other-profile' : context.profileId }));
    fs.writeFileSync(path.join(root, 'memory-bank.md'), '# Existing memory\n');
  }
  fs.mkdirSync(path.join(relative, 'mock plugin'));
  // Record every Node invocation, including config reads. Plugin scripts are
  // intercepted, so no production auth, Dataverse, telemetry, or CLI can run.
  fs.writeFileSync(path.join(relative, 'probe.cjs'), `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TRACE_FILE, JSON.stringify({
  cwd: process.cwd(), args,
}) + '\\n');
if (args[0] === '-p') {
  assert.equal(args[1], "require('./power.config.json').environmentId || ''");
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  assert.ifError(result.error);
  process.exit(result.status);
}
const script = path.basename(args[0]);
assert.ok(['resolve-environment.js', 'dataverse-request.js', 'update-entity-offline-flags.js'].includes(script));
assert.equal(path.resolve(args[0]), path.resolve(process.env.PLUGIN_ROOT, 'scripts', script));
if (script === 'resolve-environment.js') {
  assert.deepEqual(args.slice(2), ['--no-cache', '--require-tenant']);
  console.log(JSON.stringify({ environmentId: args[1] }));
} else if (script === 'dataverse-request.js') {
  assert.ok(['GET', 'POST', 'PATCH'].includes(args[2]));
  assert.ok(args[3] && !args[3].startsWith('--'), 'API path must precede options');
  const bodyIndex = args.indexOf('--body');
  if (bodyIndex >= 0) JSON.parse(args[bodyIndex + 1]);
  console.log('{"status":204}');
} else {
  assert.deepEqual(args.slice(2, 4), ['--table', 'cr123_visit']);
  assert.equal(args[args.indexOf('--tenant-id') + 1], ${JSON.stringify(context.tenantId)});
  console.log('{"status":204}');
}
`);
  const directory = path.resolve(relative);
  const owner = path.join(directory, "owner's app [test] $literal $(printf value) `printf tick`");
  const caller = path.join(directory, 'different app');
  const callerFiles = Object.fromEntries(fs.readdirSync(caller)
    .map((name) => [name, fs.readFileSync(path.join(caller, name), 'utf8')]));
  return {
    directory, owner, caller, callerFiles,
    trace: path.join(directory, 'trace.jsonl'),
    mockPlugin: path.join(directory, 'mock plugin'),
    probe: path.join(directory, 'probe.cjs'),
  };
}

function render(block, root) {
  let command = block.replaceAll('<working_dir>', slashPath(root).replaceAll("'", "'\\''"));
  for (const [token, value] of Object.entries({
    'selected-environment-id': context.environmentId,
    envUrl: context.environmentUrl,
    tenantId: context.tenantId,
    profileId: context.profileId,
    itemId: context.itemId,
    newItemId: context.itemId,
    table: context.table,
    DisplayName: 'Visit',
    relationshipSchemaName: 'cr123_visit_contact',
    'MetadataId-from-EntityDefinitions': '33333333-3333-3333-3333-333333333333',
    '0|1|2': '1',
    bool: 'true',
    new: '10',
    'new-bool': 'true',
  })) command = command.replaceAll(`<${token}>`, value);
  // The recipes abbreviate the JSON-string selectedcolumns array with [...].
  return command.replaceAll('[...]', '[\\"cr123_title\\"]');
}

function run(block, f, root = f.owner) {
  const result = spawnSync(bash, ['-s'], {
    input: `node() { "$REAL_NODE" "$PROBE" "$@"; }\n${render(block, root)}\n`,
    cwd: f.caller,
    env: {
      ...process.env,
      REAL_NODE: slashPath(process.execPath),
      PROBE: slashPath(f.probe),
      PLUGIN_ROOT: slashPath(f.mockPlugin),
      TRACE_FILE: f.trace,
      POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1',
    },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.ifError(result.error);
  return result;
}

function calls(f) {
  return fs.existsSync(f.trace)
    ? fs.readFileSync(f.trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
}

for (const name of helpers) {
  const text = documents[name];

  test(`${name}: child context uses the canonical fail-closed contract before project access`, () => {
    const binding = section(text, '## Invocation context and root binding', '## Workflow');
    assert.ok(binding.includes(rootLink));
    assert.ok(text.indexOf(rootLink) < text.indexOf('```bash'));
    assert.match(binding, /always a \*\*child invocation\*\*/);
    assert.match(binding, /owner's absolute `working_dir`/);
    assert.match(binding, /`--working-dir`[\s\S]*same native-canonical root/);
    assert.match(binding, /Missing, relative, or conflicting root[\s\S]*`NEEDS_CONTEXT` before project access/);
    assert.match(binding, /inaccessible directory[\s\S]*`BLOCKED`/);
    assert.match(binding, /Never use the launch cwd/);
    assert.doesNotMatch(text, /fs\.realpathSync|readlink|realpath --/);
    assert.match(reference, /fs\.realpathSync\.native/);
    assert.match(reference, /Set-Location -LiteralPath '<working_dir>' -ErrorAction Stop/);
    for (const field of ['MOBILE_APP_ORCHESTRATING=1', 'orchestrator', 'working_dir', 'phase', 'approved_scope']) {
      assert.ok(binding.includes(field), field);
    }
    assert.match(binding, /marker is\s+not\s+approval/);
    assert.match(binding, /`--plan-only` or a planning-phase handoff/);
    assert.match(binding, /gate response cannot lift proposal-only mode/);
  });

  test(`${name}: every shell/file operation and linked retry is rooted without persistent shell state`, () => {
    for (const eol of ['\n', '\r\n']) {
      const blocks = shellBlocks(text.replace(/\n/g, eol));
      assert.ok(blocks.length >= 6);
      for (const block of blocks) {
        assert.ok(block.startsWith(`${guard}\n`), block);
        if (block.includes('/dataverse-request.js')) {
          assert.ok(block.includes('--tenant-id "<tenantId>"'), block);
          assert.ok(block.includes('"<envUrl>"'), block);
        }
        if (block.includes('/resolve-environment.js')) {
          assert.match(block, / --no-cache --require-tenant$/);
          assert.match(block, /require\('\.\/power\.config\.json'\)\.environmentId/);
          assert.ok(block.includes('"$environment_id" != "<selected-environment-id>"'));
        }
      }
    }
    const files = ['power.config.json', '.datamodel-manifest.json',
      'docs/plan-artifacts/.datamodel-manifest.json', 'memory-bank.md'];
    if (name !== 'enable-tables-offline') files.push('offline-profile.json', 'app/', 'src/');
    for (const file of files) assert.ok(text.includes(`<working_dir>/${file}`), file);
    assert.match(text, /every shell call and file tool/);
    assert.match(text, /Re-supply the absolute `PLUGIN_ROOT`/);
    assert.match(text, /[Mm]issing values\s+return\s+`NEEDS_CONTEXT`/);
    assert.match(text, /no\s+prior `cd`, export, or shell variable persists/);
    assert.match(text, /All linked recovery commands, re-GET verification, and retries/);
    assert.doesNotMatch(text, /\$PROFILE_ID|\bin cwd\b/);
    if (name !== 'enable-tables-offline') {
      assert.match(text, /--project-root '<working_dir>'` in its own guarded call/);
      const handoff = section(text, '```text\nArguments: --working-dir', '\n```');
      for (const field of [
        "--working-dir '<working_dir>'", '--profile-id "<profileId>"', '--table "<table>"',
        'MOBILE_APP_ORCHESTRATING=1', 'orchestrator', 'working_dir', 'phase', 'approved_scope',
        'environment ID/URL/tenant', 'profile ID', 'table allowlist', 'item ID',
        'supplied answers', '--plan-only',
      ]) assert.ok(handoff.includes(field), field);
      assert.match(text, /recipient must enforce the same canonical root contract/);
      assert.match(text, /do not fall back to direct invocation or rediscovery/);
    }
  });

  test(`${name}: documented commands and fresh retries cannot be redirected by another app cwd`, (t) => {
    const f = fixture(t);
    const blocks = shellBlocks(text);
    const missing = path.join(f.directory, 'missing owner');
    const notDirectory = path.join(f.owner, 'power.config.json');
    for (const block of blocks) {
      // Each execution is a new Bash process launched in the other valid app.
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = run(block, f);
        assert.equal(result.status, 0, `${block}\n${result.stderr}`);
      }
      for (const invalidRoot of [missing, notDirectory]) {
        const before = calls(f);
        const result = run(block, f, invalidRoot);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /BLOCKED: cannot enter working_dir/);
        assert.deepEqual(calls(f), before, 'A failed root must prevent even config reads');
      }
    }
    const recorded = calls(f);
    assert.ok(recorded.length > 0);
    const requests = [];
    for (const call of recorded) {
      assert.equal(fs.realpathSync.native(call.cwd), fs.realpathSync.native(f.owner));
      const [script, ...args] = call.args;
      if (script.endsWith('/resolve-environment.js')) {
        assert.deepEqual(args, [context.environmentId, '--no-cache', '--require-tenant']);
      } else if (script.endsWith('/dataverse-request.js')) {
        requests.push(args);
        assert.equal(args[0], context.environmentUrl);
        assert.equal(args[args.indexOf('--tenant-id') + 1], context.tenantId);
        if (args[2].startsWith('mobileofflineprofileitems(')) assert.ok(args[2].includes(context.itemId));
        if (args[2].startsWith('mobileofflineprofiles(')) assert.ok(args[2].includes(context.profileId));
        if (args[2].startsWith('EntityDefinitions(')) assert.ok(args[2].includes(context.table));
        if (args[2] === 'PublishXml') {
          const body = JSON.parse(args[args.indexOf('--body') + 1]);
          const target = name === 'enable-tables-offline'
            ? `<entity>${context.table}</entity>`
            : `<mobileofflineprofile>${context.profileId}</mobileofflineprofile>`;
          assert.ok(body.ParameterXml.includes(target));
        }
        if (args[2] === 'mobileofflineprofileitems') {
          const body = JSON.parse(args[args.indexOf('--body') + 1]);
          assert.equal(body['regardingobjectid@odata.bind'], `/mobileofflineprofiles(${context.profileId})`);
          assert.equal(body.selectedentitytypecode, context.table);
        }
      } else if (script.endsWith('/update-entity-offline-flags.js')) {
        assert.equal(args[0], context.environmentUrl);
        assert.equal(args[args.indexOf('--tenant-id') + 1], context.tenantId);
      } else {
        assert.equal(script, '-p');
      }
    }
    const methods = name === 'enable-tables-offline' ? ['GET', 'POST'] : ['GET', 'POST', 'PATCH'];
    for (const method of methods) {
      assert.ok(requests.some((args) => args[1] === method), method);
    }
    assert.deepEqual(fs.readdirSync(f.caller).sort(), Object.keys(f.callerFiles).sort());
    for (const [file, original] of Object.entries(f.callerFiles)) {
      assert.equal(fs.readFileSync(path.join(f.caller, file), 'utf8'), original);
    }
  });

  test(`${name}: invalid owner markers or environment cannot borrow the launch app configuration`, (t) => {
    const f = fixture(t);
    const blocks = shellBlocks(text);
    fs.unlinkSync(path.join(f.owner, 'app.config.js'));
    const invalidProject = run(blocks[0], f);
    assert.equal(invalidProject.status, 1);
    assert.match(invalidProject.stderr, /BLOCKED: working_dir is not an initialized app/);
    assert.deepEqual(calls(f), []);

    const resolver = blocks.find((block) => block.includes('/resolve-environment.js'));
    for (const environmentId of ['', 'other-environment']) {
      fs.writeFileSync(path.join(f.owner, 'power.config.json'), JSON.stringify({ environmentId }));
      const result = run(resolver, f);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /NEEDS_CONTEXT: selected environment does not match working_dir/);
    }
    fs.writeFileSync(path.join(f.owner, 'power.config.json'), '{bad JSON');
    const malformed = run(resolver, f);
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /BLOCKED: unreadable power.config.json/);
    assert.ok(calls(f).every((call) => call.args[0] === '-p'),
      'No resolver, auth, or Dataverse call is allowed after an invalid config');
  });
}

test('add-table manifest discovery stays within the owner for both supported locations and missing files', (t) => {
  const f = fixture(t);
  const block = shellBlocks(documents['add-table-to-offline-profile'])
    .find((command) => command.includes('no manifest in working_dir'));
  let result = run(block, f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `${slashPath(f.owner)}/.datamodel-manifest.json`);
  fs.mkdirSync(path.join(f.owner, 'docs/plan-artifacts'), { recursive: true });
  fs.renameSync(path.join(f.owner, '.datamodel-manifest.json'),
    path.join(f.owner, 'docs/plan-artifacts/.datamodel-manifest.json'));
  result = run(block, f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `${slashPath(f.owner)}/docs/plan-artifacts/.datamodel-manifest.json`);
  fs.unlinkSync(path.join(f.owner, 'docs/plan-artifacts/.datamodel-manifest.json'));
  result = run(block, f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NEEDS_CONTEXT: no manifest in working_dir/);
  assert.equal(result.stdout, '');
  assert.ok(fs.existsSync(path.join(f.caller, '.datamodel-manifest.json')));
});

test('offline setup forwards its resolved root and exact approved prerequisites to the internal helper', () => {
  const setup = read('skills/setup-offline-profile/SKILL.md');
  const binding = section(setup, '## App-root binding', '## Workflow');
  assert.ok(binding.includes(rootLink));
  assert.ok(setup.indexOf(rootLink) < setup.indexOf('```bash'));
  assert.match(binding, /inherit a child invocation's owner root/);
  assert.match(binding, /file tools use absolute `<working_dir>\/\.\.\.` paths/);
  assert.match(binding, /prior shell variables do not persist/);
  assert.match(binding, /planning-phase caller returns[\s\S]*before entering this mutating wizard/);
  for (const block of shellBlocks(setup)) assert.ok(block.startsWith(`${guard}\n`), block);
  const handoff = section(setup, '### Step 4', '### Step 5');
  for (const field of [
    "--working-dir '<working_dir>'", 'MOBILE_APP_ORCHESTRATING=1',
    'orchestrator: setup-offline-profile', 'working_dir: <working_dir>',
    'phase: implementation', 'approved_scope:', 'environmentId:', 'environmentUrl:',
    'tenantId:', 'tables:', 'operations:', 'publication:', 'supplied_answers:',
  ]) assert.ok(handoff.includes(field), field);
  assert.match(handoff, /exact Gate 1-approved prerequisite table allowlist/);
  assert.match(handoff, /Configuration review must already\s+be accepted/);
  assert.match(handoff, /literal first-line status/);
  const creation = read('skills/create-mobile-app/SKILL.md');
  const caller = section(creation, 'If the user selects Yes, invoke `/setup-offline-profile`', 'Tables and generated services now exist');
  assert.match(caller, /--working-dir '<working_dir>'/);
  assert.match(caller, /orchestrator: create-mobile-app/);
  assert.match(caller, /not its prerequisite or\s+profile mutations/);
});

test('offline setup resolves identity only inside its selected app before handing off', (t) => {
  const f = fixture(t);
  const setup = read('skills/setup-offline-profile/SKILL.md');
  const block = shellBlocks(setup)[0];
  const result = run(block, f);
  assert.equal(result.status, 0, result.stderr);
  const recorded = calls(f);
  assert.equal(recorded.length, 2);
  assert.ok(recorded.every((call) => fs.realpathSync.native(call.cwd) === fs.realpathSync.native(f.owner)));
  assert.deepEqual(recorded[1].args.slice(1), [context.environmentId, '--no-cache', '--require-tenant']);
  const before = calls(f);
  const failed = run(block, f, path.join(f.directory, 'missing owner'));
  assert.equal(failed.status, 1);
  assert.deepEqual(calls(f), before);
  assert.match(failed.stderr, /BLOCKED: cannot enter working_dir/);
});

test('offline enablement cannot widen the owner table list or repeat approval in planning mode', () => {
  const enable = documents['enable-tables-offline'];
  const tables = section(enable, '### Step 2', '### Step 3');
  assert.match(tables, /only the exact table allowlist in the owner's `approved_scope`/);
  assert.match(tables, /not permission to enable every\s+row/);
  assert.match(tables, /Missing or conflicting table selection returns\s+`NEEDS_CONTEXT`/);
  const gate = section(enable, '### Gate', '### Step 4');
  assert.match(gate, /Gate 1 approval is reused without a duplicate\s+prompt/);
  assert.match(gate, /owner[\s\S]*owns the approval gate/);
  assert.match(gate, /Do not widen\s+scope or override proposal-only mode/);
  assert.match(enable, /owner separately approves the broader publication/);
  assert.match(enable, /Table-only approval does not authorize publishing unrelated changes/);
  assert.match(enable, /literal first line/);
});

test('root reception preserves offline gates, exact deltas, permissions, and schema baselines', () => {
  const add = documents['add-table-to-offline-profile'];
  const edit = documents['edit-offline-profile'];
  const prereqs = section(add, '### Step 3', '### Step 4');
  assert.match(prereqs, /current offline approval covers these exact prerequisite changes/);
  assert.match(prereqs, /obtain owner\/user approval first/);
  assert.match(prereqs, /IsCustomizable.Value = false[\s\S]*BLOCKED/);
  assert.match(add, /Cancel stops without[\s\S]*creating a profile item/);
  assert.match(add, /--all-new[\s\S]*only within the owner's exact table allowlist/);
  assert.match(add, /Steps 3–7 for[\s\S]*each approved missing table/);
  assert.doesNotMatch(add, /no prompt — the user already opted|skills\/enable-tables-offline/);
  const editGate = section(edit, '### Step 3', '### Step 4');
  assert.match(editGate, /Apply this change\? \[Apply \/ Cancel\]/);
  assert.match(editGate, /If `Cancel` → STOP/);
  assert.match(edit, /Preserve every field and table outside the approved delta/);
  assert.match(edit, /leave `schemaColumns`[\s\S]*untouched for scope\/sync\/rename-only edits/);
  assert.match(add, /entry MUST include a `schemaColumns` array/);
  for (const text of [add, edit]) {
    assert.match(text, /403\/`PrivilegeCheckFailed`[\s\S]*`BLOCKED`/);
    assert.match(text, /do not change identity or profile to[\s\S]*bypass permissions/);
    assert.match(text, /broader publication/);
    assert.match(text, /profile-scoped approval/);
    assert.match(text, /schema approval alone does not authorize/);
    assert.match(text, /selected environment/);
    assert.match(text, /snapshot\/argument/);
  }
});
