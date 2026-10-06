const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const folder = require('../project-folder');

// A project folder whose name holds characters a shell would act on.
function makeProject({ dev = true, nodeModules = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-test-'));
  const project = path.join(root, 'Contoso & Co $(id)');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: dev ? { dev: 'vite' } : {} }));
  if (nodeModules) fs.mkdirSync(path.join(project, 'node_modules'));
  return { root, project };
}

test('readRequest validates the action and the folder, and fails closed', () => {
  const { root, project } = makeProject();
  try {
    assert.deepEqual(folder.readRequest(JSON.stringify({ action: 'status', projectRoot: project })), { action: 'status', projectRoot: project });
    assert.match(folder.readRequest(JSON.stringify({ action: 'rm', projectRoot: project })).error, /action.*wrong type/);
    assert.match(folder.readRequest(JSON.stringify({ action: 'status', projectRoot: project, cmd: 'x' })).error, /Unknown field.*cmd/);
    assert.match(folder.readRequest(JSON.stringify({ action: 'status' })).error, /needs "action"/);
    assert.match(folder.readRequest(JSON.stringify({ action: 'status', projectRoot: path.join(root, 'missing') })).error, /not found/);
    assert.match(folder.readRequest(JSON.stringify({ action: 'status', projectRoot: path.join(project, 'package.json') })).error, /Not a folder/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('folderStatus runs git with argv in the folder and returns its lines', () => {
  const calls = [];
  const status = folder.folderStatus('/p/Contoso & Co', {
    spawnSyncFn: (cmd, args, options) => { calls.push({ cmd, args, options }); return { status: 0, stdout: '?? new.css\r\n!! node_modules/\n' }; },
  });
  assert.deepEqual(status, { git: true, entries: ['?? new.css', '!! node_modules/'] });
  assert.deepEqual(calls, [{ cmd: 'git', args: ['status', '--porcelain', '--ignored'], options: { cwd: '/p/Contoso & Co', encoding: 'utf8', shell: false } }]);
  assert.deepEqual(folder.folderStatus('/p', { spawnSyncFn: () => ({ status: 128, stdout: '' }) }), { git: false });
});

test('devScriptProblem requires a dev script and installed dependencies', () => {
  for (const [options, expected] of [[{}, null], [{ dev: false }, /no "dev" script/], [{ nodeModules: false }, /npm install first/]]) {
    const { root, project } = makeProject(options);
    try {
      const problem = folder.devScriptProblem(project);
      if (expected) assert.match(problem, expected);
      else assert.equal(problem, null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('startDevServer runs npm through Node with argv, forwards stop signals, and exits with it', async () => {
  const processRef = new EventEmitter();
  processRef.stderr = { write() {} };
  const child = new EventEmitter();
  const killed = [];
  child.kill = (signal) => { killed.push(signal); process.nextTick(() => child.emit('exit', null, signal)); };
  let spawned;
  const done = folder.startDevServer('/p/Contoso & Co', {
    processRef,
    resolveNpmCliFn: () => '/node/lib/node_modules/npm/bin/npm-cli.js',
    spawnFn: (cmd, args, options) => { spawned = { cmd, args, options }; return child; },
  });
  assert.deepEqual(spawned, {
    cmd: process.execPath,
    args: ['/node/lib/node_modules/npm/bin/npm-cli.js', 'run', 'dev'],
    options: { cwd: '/p/Contoso & Co', stdio: 'inherit', shell: false },
  });
  processRef.emit('SIGTERM', 'SIGTERM');
  assert.equal(await done, 0);
  assert.deepEqual(killed, ['SIGTERM']);
  assert.equal(processRef.listenerCount('SIGTERM'), 0, 'signal handlers are removed when the server exits');
});

test('main prints the folder status from a stdin request, and refuses a dev start without dependencies', async () => {
  const { root, project } = makeProject({ nodeModules: false });
  try {
    let out = '';
    let err = '';
    const io = { write: (s) => { out += s; }, writeError: (s) => { err += s; } };
    const status = await folder.main(['--input', '-'], {
      ...io, readStdin: () => JSON.stringify({ action: 'status', projectRoot: project }), spawnSyncFn: () => ({ status: 0, stdout: '' }),
    });
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(out), { git: true, entries: [] });

    let started = false;
    const dev = await folder.main(['--input', '-'], {
      ...io, readStdin: () => JSON.stringify({ action: 'dev', projectRoot: project }), startDevServerFn: async () => { started = true; return 0; },
    });
    assert.equal(dev, 1);
    assert.equal(started, false);
    assert.match(err, /npm install first/);

    assert.equal(await folder.main(['--project-root', project], io), 1, 'the folder is accepted only through stdin');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
