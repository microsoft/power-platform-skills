'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const vm = require('node:vm');

const pluginRoot = path.resolve(__dirname, '../..');
const templateRoot = path.join(pluginRoot, 'template');
// Windows Git checkouts may use CRLF; Bash needs LF even when its commands are
// supplied through argv rather than a .sh file.
const skill = fs.readFileSync(path.join(pluginRoot, 'skills/create-mobile-app/SKILL.md'), 'utf8')
  .replace(/\r\n/g, '\n');
const templateSource = 'microsoft/power-platform-skills/plugins/mobile-apps/template#main';

// Execute the published recipes, not a second implementation of their branches.
// Approval decisions, planner output, and retaining/joining a terminal are supplied
// by this harness; this does not simulate an agent or contact a tenant/registry.
function recipe(heading, marker) {
  const start = skill.indexOf(heading);
  assert.notEqual(start, -1, `Missing heading: ${heading}`);
  const end = skill.indexOf('\n### ', start + heading.length);
  const section = skill.slice(start, end === -1 ? undefined : end);
  const matches = [...section.matchAll(/^```bash\r?\n([\s\S]*?)^```/gm)]
    .map((match) => match[1])
    .filter((block) => block.includes(marker));
  assert.equal(matches.length, 1, `Expected one ${heading} recipe containing ${marker}`);
  return matches[0];
}

const step0 = '### Step 0 — Capture launch directory';
const step2d = '### Step 2d — Materialize/adopt template';
const step5 = '### Step 5 — Join dependency install';
const recipes = {
  capture: recipe(step0, 'LAUNCH_DIR='),
  probe: recipe(step0, 'RESUME_WORKING_DIR='),
  resume: recipe(step0, 'RESUME_APPROVED'),
  resolve: recipe('### Step 2 — Gather requirements', 'TARGET_JSON='),
  materialize: recipe(step2d, 'SCAFFOLD_APPROVAL'),
  markers: recipe(step2d, 'test -f package.json'),
  identity: recipe(step2d, 'updateIdentity'),
  initialize: recipe(step2d, 'scripts/lib/app-identity.js'),
  install: recipe(step2d, '&& npm install'),
  dependencies: recipe(step5, 'test -d node_modules/expo'),
  prepare: recipe(step5, 'prepareMobileTemplate'),
};

const stateKeys = [
  'LAUNCH_DIR', 'WORKING_DIR', 'TARGET_JSON', 'SCAFFOLD_ACTION',
  'DEPENDENCIES_INSTALLED', 'RESUME_JSON', 'RESUME_WORKING_DIR',
  'NPM_INSTALL_TERMINAL_ID',
];
const stateMarker = '__MOBILE_WORKFLOW_STATE__';
const captureState = `process.stdout.write('\\n${stateMarker}' + JSON.stringify(Object.fromEntries(${JSON.stringify(stateKeys)}.map((key, index) => [key, process.argv[index + 1]]))) + '\\n')`;
const slashPath = (value) => value.replace(/\\/g, '/');
const bashPath = (value) => slashPath(value).replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`);
const shellQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`;

function write(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function snapshot(root, excluded = []) {
  const result = [];
  function visit(absolutePath, relativePath) {
    if (excluded.includes(relativePath)) return;
    const stat = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      result.push([relativePath, 'link', fs.readlinkSync(absolutePath)]);
    } else if (stat.isDirectory()) {
      // Allowed install/planning writes change ancestor directory timestamps.
      result.push([relativePath, 'directory', stat.mode,
        ...(excluded.length ? [] : [stat.mtimeMs, stat.ctimeMs])]);
      for (const name of fs.readdirSync(absolutePath).sort()) {
        visit(path.join(absolutePath, name), relativePath ? `${relativePath}/${name}` : name);
      }
    } else {
      result.push([relativePath, 'file', stat.mode, stat.mtimeMs, stat.ctimeMs,
        fs.readFileSync(absolutePath).toString('base64')]);
    }
  }
  visit(root, '');
  return result;
}

// Serialized into a separate child script. Only npm/npx/degit are replaced.
// The npm child creates a deliberately partial tree, signals readiness, and
// cannot finish until this test releases that specific install ID.
async function externalToolFixture() {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const { setTimeout: delay } = require('node:timers/promises');
  const [tool, ...args] = process.argv.slice(2);
  const control = process.env.WORKFLOW_CONTROL;
  const id = process.env.WORKFLOW_INSTALL_ID;
  const event = (value) => fs.appendFileSync(path.join(control, 'calls.jsonl'),
    `${JSON.stringify({ tool, args, cwd: process.cwd(), pid: process.pid, id, ...value })}\n`);
  event({ phase: 'start' });
  const assertFixtureTarget = (target) => {
    const relative = path.relative(process.env.WORKFLOW_LAUNCH, path.resolve(target));
    assert.ok(!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`),
      'An external-tool regression must never write outside the fixture launch directory');
  };

  if (tool === 'npx') {
    assert.deepEqual(args.slice(0, -1), [
      '--yes', 'degit@2.8.4',
      'microsoft/power-platform-skills/plugins/mobile-apps/template#main',
    ]);
    assert.equal(args.length, 4);
    assertFixtureTarget(args[3]);
    fs.cpSync(process.env.WORKFLOW_TEMPLATE, args[3], { recursive: true });
    event({ phase: 'exit', code: 0 });
    return;
  }

  assert.equal(tool, 'npm', 'Unexpected external command; never fall through to real tools');
  assert.deepEqual(args, ['install']);
  assert.ok(id, 'Install must have a retained test terminal ID');
  assertFixtureTarget(process.cwd());
  const packageName = JSON.parse(fs.readFileSync('package.json', 'utf8')).name;
  fs.mkdirSync(path.join('node_modules', 'expo'), { recursive: true });
  const started = path.join(control, `${id}.started.json`);
  fs.writeFileSync(`${started}.pending`,
    JSON.stringify({ pid: process.pid, packageName, cwd: process.cwd() }));
  fs.renameSync(`${started}.pending`, started);
  process.stdout.write(`install ${id} started\n`);
  const deadline = Date.now() + 20000;
  const release = path.join(control, `${id}.release.json`);
  while (!fs.existsSync(release)) {
    assert.ok(Date.now() < deadline, `Install ${id} was never released`);
    await delay(20);
  }
  const { code } = JSON.parse(fs.readFileSync(release, 'utf8'));
  if (code === 0) {
    const lock = `${JSON.stringify({ name: packageName, lockfileVersion: 3 })}\n`;
    fs.writeFileSync('package-lock.json', lock);
    fs.writeFileSync(path.join('node_modules', '.package-lock.json'), lock);
  }
  event({ phase: 'exit', code });
  process.stderr.write(`install ${id} exit ${code}\n`);
  process.exitCode = code;
}

function makeHarness(t, { requested = "apps/O'Brien workspace" } = {}) {
  const root = fs.mkdtempSync(path.join(__dirname, '.workflow-scratch-'));
  const launch = path.join(root, "launcher's projects");
  const control = path.join(root, 'control');
  const bin = path.join(control, 'bin');
  const home = path.join(root, 'home');
  for (const directory of [launch, bin, home]) fs.mkdirSync(directory, { recursive: true });
  const driver = path.join(control, 'external-tool.js');
  fs.writeFileSync(driver, `(${externalToolFixture.toString()})().catch(error => {
    console.error(error.stack);
    process.exitCode = 97;
  });\n`);
  for (const tool of ['npm', 'npx', 'degit']) {
    fs.writeFileSync(path.join(bin, tool),
      `#!/usr/bin/env bash\nexec "$WORKFLOW_NODE" "$WORKFLOW_DRIVER" ${tool} "$@"\n`,
      { mode: 0o755 });
  }

  const env = { ...process.env };
  // Do not let an interactive user's shell startup scripts or Node preload
  // change these child commands. All fixture paths stay inside this checkout.
  for (const name of ['BASH_ENV', 'ENV', 'NODE_OPTIONS']) delete env[name];
  Object.assign(env, {
    POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1',
    HOME: home,
    USERPROFILE: home,
    PLUGIN_ROOT: slashPath(pluginRoot),
    CLAUDE_SKILL_DIR: slashPath(path.join(pluginRoot, 'skills/create-mobile-app')),
    WORKFLOW_NODE: slashPath(process.execPath),
    WORKFLOW_DRIVER: slashPath(driver),
    WORKFLOW_CONTROL: control,
    WORKFLOW_TEMPLATE: templateRoot,
    WORKFLOW_LAUNCH: launch,
    WORKFLOW_BIN: bashPath(bin),
    WORKFLOW_NODE_DIR: bashPath(path.dirname(process.execPath)),
    REQUESTED_WORKING_DIR: requested,
    APP_SLUG: 'inspectors-workspace',
    DISPLAY_NAME: "R&D $& O'Brien \"Inspector\" \\ area\nLine\u2028\u2029$(false); `false`",
    ENV_JSON: JSON.stringify({ environmentId: '00000000-0000-0000-0000-000000000000' }),
    SCAFFOLD_APPROVAL: '',
    RESUME_APPROVED: '',
  });
  for (const key of stateKeys) env[key] = '';
  const children = [];
  let installNumber = 0;

  function start(source, values = {}) {
    Object.assign(env, values);
    // PATH uses Bash paths; resolver JSON and Node argv retain native paths.
    // No user-provided name/path is interpolated into shell/JavaScript source.
    const command = [
      'export PATH="$WORKFLOW_BIN:$WORKFLOW_NODE_DIR:$PATH"',
      'for tool in npm npx degit; do',
      '  test "$(command -v "$tool")" = "$WORKFLOW_BIN/$tool" || exit 96',
      'done',
      source,
      'WORKFLOW_STATUS=$?',
      'test "$WORKFLOW_STATUS" -eq 0 || exit "$WORKFLOW_STATUS"',
      `node -e ${shellQuote(captureState)} ${stateKeys.map((key) => `"$${key}"`).join(' ')}`,
    ].join('\n');
    const child = spawn('bash', ['--noprofile', '--norc', '-c', command], {
      cwd: launch, env: { ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const record = { child, id: values.WORKFLOW_INSTALL_ID, closed: false, stdout: '', stderr: '' };
    children.push(record);
    child.stdout.on('data', (data) => { record.stdout += data; });
    child.stderr.on('data', (data) => { record.stderr += data; });
    record.done = new Promise((resolve) => {
      child.once('error', (error) => {
        record.closed = true;
        resolve({ code: null, error, ...record });
      });
      child.once('close', (code, signal) => {
        record.closed = true;
        const result = { code, signal, stdout: record.stdout, stderr: record.stderr };
        if (code === 0) {
          const index = result.stdout.lastIndexOf(stateMarker);
          if (index !== -1) result.state = JSON.parse(result.stdout.slice(index + stateMarker.length));
        }
        resolve(result);
      });
    });
    return record;
  }

  function accept(result, expectedCode = 0) {
    assert.equal(result.code, expectedCode,
      `${result.error || ''}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    if (expectedCode === 0) {
      assert.ok(result.state, 'Documented shell command must reach its successful end');
      Object.assign(env, result.state);
    }
    return result;
  }

  async function run(source, values, expectedCode = 0) {
    return accept(await start(source, values).done, expectedCode);
  }

  async function startInstall(source = recipes.install, values = {}) {
    const id = `install-${++installNumber}`;
    if (source === recipes.install) env.NPM_INSTALL_TERMINAL_ID = id;
    const record = start(source, { ...values, WORKFLOW_INSTALL_ID: id });
    const signal = path.join(control, `${id}.started.json`);
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(signal)) {
      assert.equal(record.closed, false, `Install exited before readiness:\n${record.stdout}\n${record.stderr}`);
      assert.ok(Date.now() < deadline, 'Install child did not signal readiness');
      await delay(20);
    }
    record.started = JSON.parse(fs.readFileSync(signal, 'utf8'));
    assert.equal(record.started.cwd, fs.realpathSync(env.WORKING_DIR || env.RESUME_WORKING_DIR));
    return record;
  }

  function release(record, code) {
    const destination = path.join(control, `${record.id}.release.json`);
    fs.writeFileSync(`${destination}.pending`, JSON.stringify({ code }));
    fs.renameSync(`${destination}.pending`, destination);
  }

  async function joinAndPrepare(record) {
    // This is the host's terminal join, not inferred success from node_modules.
    assert.equal(env.NPM_INSTALL_TERMINAL_ID, record.id);
    const result = await record.done;
    if (result.code !== 0) return result;
    accept(result);
    await run(recipes.dependencies);
    return run(recipes.prepare);
  }

  async function resolve() {
    await run(recipes.capture);
    await run(recipes.probe);
    await run(recipes.resolve);
    return JSON.parse(env.TARGET_JSON);
  }

  async function approve() {
    await run(recipes.materialize, { SCAFFOLD_APPROVAL: 'proceed' });
    await run(recipes.markers);
    await run(recipes.identity);
    await run(recipes.initialize);
  }

  function calls() {
    const file = path.join(control, 'calls.jsonl');
    return fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      : [];
  }

  t.after(async () => {
    // Release first, including children still starting; kill only this test's
    // own Node fixture and shell if a broken recipe ignores the release.
    for (const record of children.filter((item) => !item.closed)) {
      if (record.id) release(record, 125);
      await Promise.race([record.done, delay(1000)]);
      if (!record.closed) {
        const signal = record.id && path.join(control, `${record.id}.started.json`);
        if (signal && fs.existsSync(signal)) {
          const { pid } = JSON.parse(fs.readFileSync(signal, 'utf8'));
          try { process.kill(pid, 'SIGTERM'); } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
        record.child.kill('SIGTERM');
        await record.done;
      }
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  return {
    root, launch, home, env, run, resolve, approve, startInstall, release, joinAndPrepare, accept, calls,
    target: path.resolve(launch, requested || '.'),
  };
}

function seedTemplate(target, installed = false) {
  fs.cpSync(templateRoot, target, { recursive: true });
  if (installed) {
    write(target, 'node_modules/expo/package.json', '{}\n');
    write(target, 'node_modules/.package-lock.json', '{}\n');
  }
}

function assertIdentity(target, displayName, slug) {
  const source = fs.readFileSync(path.join(target, 'app.config.js'), 'utf8');
  new vm.Script(source); // Check the complete generated JavaScript without loading host dependencies.
  const declarations = ['APP_NAME', 'APP_SLUG'].map((name) => {
    const match = source.match(new RegExp(`^const ${name} = .+;$`, 'm'));
    assert.ok(match, `${name} declaration missing`);
    return match[0];
  });
  const identity = vm.runInNewContext(
    `${declarations.join('\n')}\n({ name: APP_NAME, slug: APP_SLUG });`,
    { process: { env: {} } },
  );
  assert.equal(identity.name, displayName);
  assert.equal(identity.slug, slug);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).name, slug);
}

function assertNotPrepared(target) {
  assert.equal(fs.existsSync(path.join(target, 'src/utils/text.ts')), false);
  assert.equal(fs.existsSync(path.join(target, 'memory-bank.md')), false);
}

function writePlan(target) {
  write(target, 'native-app-plan.md', '# Approved plan\n');
  write(target, '_screens_section.md', '## Approved screens\n');
  write(target, '.tmp/planning.json', '{"status":"planned"}\n');
}

test('preview abort and unapproved Step 2d leave missing, empty, and adoptable targets unchanged', { timeout: 45000 }, async (t) => {
  for (const kind of ['missing', 'empty', 'adopt']) {
    await t.test(kind, async (t) => {
      const h = makeHarness(t);
      if (kind === 'empty') fs.mkdirSync(h.target, { recursive: true });
      if (kind === 'adopt') seedTemplate(h.target);
      const before = snapshot(h.launch);
      const resolved = await h.resolve();
      assert.equal(resolved.action, kind === 'adopt' ? 'adopt' : 'materialize');
      assert.equal(h.env.RESUME_WORKING_DIR, '');
      // Aborting here requires no executable mutation step.
      assert.deepEqual(snapshot(h.launch), before);
      assert.deepEqual(h.calls(), []);
      for (const approval of ['', 'abort', 'edit']) {
        const blocked = await h.run(recipes.materialize, { SCAFFOLD_APPROVAL: approval }, 2);
        assert.match(blocked.stderr, /Preview approval is required/);
        assert.deepEqual(snapshot(h.launch), before);
        assert.deepEqual(h.calls(), []);
      }
    });
  }
});

test('approved materialization executes the #main download and real identity/preparation around a retained install', { timeout: 45000 }, async (t) => {
  const h = makeHarness(t);
  assert.equal((await h.resolve()).action, 'materialize');
  await h.approve();
  assert.deepEqual(h.calls().filter((event) => event.phase === 'start').map(({ tool, args }) => ({ tool, args })), [
    { tool: 'npx', args: ['--yes', 'degit@2.8.4', templateSource, h.env.WORKING_DIR] },
  ]);
  assertIdentity(h.target, h.env.DISPLAY_NAME, h.env.APP_SLUG);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.target, '.resolved-environment.json'), 'utf8')),
    JSON.parse(h.env.ENV_JSON));
  const appJson = fs.readFileSync(path.join(h.target, 'app.json'), 'utf8');
  assert.match(JSON.parse(appJson).expo.extra.telemetry.appInstanceId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  await h.run(recipes.initialize);
  assert.equal(fs.readFileSync(path.join(h.target, 'app.json'), 'utf8'), appJson);

  const ownedBefore = snapshot(h.target, ['.tmp', 'native-app-plan.md', '_screens_section.md', 'node_modules', 'package-lock.json']);
  const install = await h.startInstall();
  assert.equal(install.started.packageName, h.env.APP_SLUG);
  writePlan(h.target);
  assert.equal(install.closed, false, 'Planning must run while the real install child is held');
  assert.equal(fs.existsSync(path.join(h.target, 'node_modules/expo')), true);
  assert.equal(fs.existsSync(path.join(h.target, 'node_modules/.package-lock.json')), false);
  assertNotPrepared(h.target);
  assert.deepEqual(snapshot(h.target, ['.tmp', 'native-app-plan.md', '_screens_section.md', 'node_modules', 'package-lock.json']), ownedBefore);
  h.release(install, 0);
  const prepared = await h.joinAndPrepare(install);
  assert.equal(prepared.code, 0);
  assert.equal(install.closed, true);
  assert.equal(fs.existsSync(path.join(h.target, 'src/utils/text.ts')), true);
  assert.equal(fs.readFileSync(path.join(h.target, 'native-app-plan.md'), 'utf8'), '# Approved plan\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.target, 'package-lock.json'), 'utf8')).name, h.env.APP_SLUG);
  assert.deepEqual(h.calls().filter((event) => event.tool === 'npm').map(({ phase, code, id }) => ({ phase, code, id })), [
    { phase: 'start', code: undefined, id: install.id },
    { phase: 'exit', code: 0, id: install.id },
  ]);
});

test('approved adoption never downloads and still installs when dependency markers already exist', { timeout: 45000 }, async (t) => {
  const h = makeHarness(t, { requested: '' });
  seedTemplate(h.launch, true);
  const target = await h.resolve();
  assert.equal(target.action, 'adopt');
  assert.equal(target.dependenciesInstalled, true);
  await h.approve();
  assert.deepEqual(h.calls(), []);
  assertIdentity(h.target, h.env.DISPLAY_NAME, h.env.APP_SLUG);
  const install = await h.startInstall();
  writePlan(h.target);
  assert.equal(install.closed, false);
  assertNotPrepared(h.target);
  h.release(install, 0);
  await h.joinAndPrepare(install);
  assert.deepEqual(h.calls().filter((event) => event.phase === 'start').map((event) => event.tool), ['npm']);
});

test('a nonzero retained install cannot prepare; explicit re-resolution, adoption, and approval allow retry', { timeout: 45000 }, async (t) => {
  const h = makeHarness(t);
  await h.resolve();
  await h.approve();
  const appJson = fs.readFileSync(path.join(h.target, 'app.json'), 'utf8');
  const ownedBefore = snapshot(h.target, ['.tmp', 'native-app-plan.md', '_screens_section.md', 'node_modules', 'package-lock.json']);
  const install = await h.startInstall();
  writePlan(h.target);
  h.release(install, 23);
  const failed = await h.joinAndPrepare(install);
  assert.equal(failed.code, 23);
  assert.match(failed.stderr, /exit 23/);
  assertNotPrepared(h.target);
  assert.deepEqual(snapshot(h.target, ['.tmp', 'native-app-plan.md', '_screens_section.md', 'node_modules', 'package-lock.json']), ownedBefore);
  assert.equal(h.calls().filter((event) => event.tool === 'npm' && event.phase === 'start').length, 1);

  const retry = await h.resolve();
  assert.equal(retry.action, 'adopt');
  assert.equal(retry.partialPlan, true);
  assert.equal(retry.dependenciesInstalled, false);
  const beforeApproval = snapshot(h.target);
  await h.run(recipes.materialize, { SCAFFOLD_APPROVAL: '' }, 2);
  assert.deepEqual(snapshot(h.target), beforeApproval);
  await h.approve();
  const retryInstall = await h.startInstall();
  assert.notEqual(retryInstall.id, install.id);
  h.release(retryInstall, 0);
  await h.joinAndPrepare(retryInstall);
  assert.equal(fs.existsSync(path.join(h.target, 'src/utils/text.ts')), true);
  assert.equal(fs.readFileSync(path.join(h.target, 'app.json'), 'utf8'), appJson);
  assert.equal(fs.readFileSync(path.join(h.target, 'native-app-plan.md'), 'utf8'), '# Approved plan\n');
  assert.deepEqual(h.calls().filter((event) => event.phase === 'start').map((event) => event.tool), ['npx', 'npm', 'npm']);
});

test('approved Step 2d revalidates a destination that changed after preview before external calls', { timeout: 45000 }, async (t) => {
  const h = makeHarness(t);
  await h.resolve();
  seedTemplate(h.target);
  const before = snapshot(h.launch);
  const blocked = await h.run(recipes.materialize, { SCAFFOLD_APPROVAL: 'proceed' }, 1);
  assert.match(blocked.stderr, /Target changed since preview/);
  assert.deepEqual(snapshot(h.launch), before);
  assert.deepEqual(h.calls(), []);
});

test('resume probing is read-only; approved foreground restores only missing dependencies without fresh preparation', { timeout: 60000 }, async (t) => {
  for (const kind of ['installed', 'missing', 'partial-failure']) {
    await t.test(kind, async (t) => {
      const h = makeHarness(t);
      seedTemplate(h.target, kind === 'installed');
      await h.run(recipes.identity, { WORKING_DIR: h.target, DISPLAY_NAME: 'Existing app', APP_SLUG: 'existing-app' });
      await h.run(recipes.initialize);
      write(h.target, 'memory-bank.md', '# Project\nCreate workflow checkpoint: Step 6 complete\n');
      write(h.target, 'power.config.json', '{"environmentId":"00000000-0000-0000-0000-000000000000","appId":"existing"}\n');
      write(h.target, 'src/generated/services/ExistingService.ts', 'export const preserved = true;\n');
      write(h.target, 'src/hooks/useContacts.ts', '// Existing app-owned hook; never fresh-clean this.\n');
      if (kind === 'partial-failure') fs.mkdirSync(path.join(h.target, 'node_modules/expo'), { recursive: true });
      const before = snapshot(h.launch);
      const beforeRestore = snapshot(h.target, ['node_modules', 'package-lock.json']);
      await h.run(recipes.capture);
      await h.run(recipes.probe);
      assert.equal(JSON.parse(h.env.RESUME_JSON).action, 'resume');
      assert.deepEqual(snapshot(h.launch), before);
      assert.deepEqual(h.calls(), []);
      await h.run(recipes.resume, { RESUME_APPROVED: '' }, 2);
      assert.deepEqual(snapshot(h.launch), before);
      assert.deepEqual(h.calls(), []);

      const approval = { RESUME_APPROVED: 'yes', DISPLAY_NAME: 'Do not rename', APP_SLUG: 'do-not-rename' };
      if (kind === 'installed') {
        await h.run(recipes.resume, approval);
        assert.deepEqual(snapshot(h.launch), before);
        assert.deepEqual(h.calls(), []);
      } else {
        const restore = await h.startInstall(recipes.resume, approval);
        assert.equal(restore.closed, false, 'Foreground resume recipe must wait for npm');
        assert.equal(restore.started.packageName, 'existing-app');
        assert.deepEqual(snapshot(h.target, ['node_modules', 'package-lock.json']), beforeRestore);
        const exitCode = kind === 'partial-failure' ? 29 : 0;
        h.release(restore, exitCode);
        h.accept(await restore.done, exitCode);
        assert.deepEqual(snapshot(h.target, ['node_modules', 'package-lock.json']), beforeRestore);
        assert.deepEqual(h.calls().filter((event) => event.phase === 'start').map((event) => event.tool), ['npm']);
      }
      if (kind !== 'partial-failure') {
        assert.equal(h.env.SCAFFOLD_ACTION, 'resume');
        assert.equal(h.env.NPM_INSTALL_TERMINAL_ID, '');
      }
      assertIdentity(h.target, 'Existing app', 'existing-app');
    });
  }
});

test('unsafe resume probes and forged approved-resume targets fail before any external command', { timeout: 60000 }, async (t) => {
  for (const kind of ['unrelated', 'file', 'symlink', 'bank-directory', 'incomplete', 'initialized-without-bank', 'home', 'root']) {
    await t.test(kind, async (t) => {
      const h = makeHarness(t);
      let target = h.target;
      if (kind === 'unrelated') write(target, 'notes.txt', 'Not an app\n');
      if (kind === 'file') write(h.launch, path.relative(h.launch, target), 'Not a directory\n');
      if (kind === 'symlink') {
        const realTarget = path.join(h.launch, 'real-app');
        seedTemplate(realTarget);
        write(realTarget, 'memory-bank.md', '# Existing app\n');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.symlinkSync(realTarget, target, process.platform === 'win32' ? 'junction' : 'dir');
      }
      if (kind === 'bank-directory') {
        seedTemplate(target);
        fs.mkdirSync(path.join(target, 'memory-bank.md'));
      }
      if (kind === 'incomplete') write(target, 'memory-bank.md', '# Not a complete template\n');
      if (kind === 'initialized-without-bank') {
        seedTemplate(target);
        write(target, 'power.config.json', '{"environmentId":"00000000-0000-0000-0000-000000000000"}\n');
      }
      if (kind === 'home') target = h.home;
      if (kind === 'root') target = path.parse(h.root).root;
      const before = snapshot(h.launch);
      const homeBefore = snapshot(h.home);
      await h.run(recipes.capture);
      const probe = await h.run(recipes.probe, { REQUESTED_WORKING_DIR: target }, 2);
      assert.match(probe.stderr, /BLOCKED:/);
      const resume = await h.run(recipes.resume, { RESUME_WORKING_DIR: target, RESUME_APPROVED: 'yes' }, 2);
      assert.match(resume.stderr, /BLOCKED:/);
      assert.deepEqual(snapshot(h.launch), before);
      assert.deepEqual(snapshot(h.home), homeBefore);
      assert.deepEqual(h.calls(), []);
    });
  }
});
