'use strict';
// What a KILLED run leaves in the temp folder, and what the next run does about it. A run that is killed outright — SIGKILL, "End task", an
// agent's timeout — cannot remove the throwaway workspace it made: its page backend holds the source of every page it read and the environment's
// address there. The next run removes the workspaces of runs that are gone, says so, and never touches a workspace whose run may still be going.
// The runs are REAL processes, each with a temp folder of its own (TMPDIR / TEMP / TMP), so nothing here touches anyone else's.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { privateTempRoot, tempEnv, startTarget, isRunning, waitUntil, readJsonWhenWritten } = require('./helpers/kill-target-client.js');
const { sweepDeadWorkspaces, OWNER_FILE } = require('../lib/temp-workspace.js');

const ENV = 'https://contoso.crm.dynamics.com';

// Every file and folder under `root`, as paths relative to it.
function tree(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      found.push(path.relative(root, full));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return found.sort();
}

test('REAL KILL: the page workspace a killed run left in the temp folder is removed by the next run, which says so — and the temp folder is left empty', async (t) => {
  const root = privateTempRoot(t);
  const killed = startTarget(t, ['pages', ENV], { env: tempEnv(root) });
  const leftover = (await killed.waitFor(/^workspace /)).slice('workspace '.length);
  assert.ok(fs.existsSync(path.join(leftover, 'manifest.json')), 'the SDK made its workspace: it holds what the run reads (the environment\'s address, a page\'s source)');
  await killed.kill();
  assert.ok(fs.existsSync(leftover), 'a killed process cannot remove its folder: it is still there');

  // The next run: a page backend of its own, run to the end.
  const next = startTarget(t, ['pages-run', ENV], { env: tempEnv(root) });
  const done = await next.waitFor(/^done /);
  assert.deepStrictEqual(JSON.parse(done.slice('done '.length)), { ok: true, left: [] }, 'the run itself worked and removed what it made');
  await next.exited;
  assert.ok(!fs.existsSync(leftover), `the folder the killed run left is gone: ${leftover}`);
  assert.ok(/^⚠ /.test(next.stderr()) && next.stderr().includes(path.basename(leftover)) && next.stderr().includes(`pid ${killed.pid}`), `and the run said so, never silently: ${JSON.stringify(next.stderr())}`);
  assert.deepStrictEqual(tree(root), [], 'nothing is left in the temp folder');
});

test('a page workspace of a run that is still going is not touched by another run, and a normal run removes its own', async (t) => {
  const root = privateTempRoot(t);
  const running = startTarget(t, ['pages', ENV], { env: tempEnv(root) });
  const workspace = (await running.waitFor(/^workspace /)).slice('workspace '.length);
  const next = startTarget(t, ['pages-run', ENV], { env: tempEnv(root) });
  const done = await next.waitFor(/^done /);
  assert.deepStrictEqual(JSON.parse(done.slice('done '.length)), { ok: true, left: [] });
  await next.exited;
  assert.ok(fs.existsSync(path.join(workspace, 'manifest.json')), 'the workspace of the run that is going is as it was');
  assert.strictEqual(next.stderr(), '', 'and nothing was said: nothing was removed');
  await running.kill();
});

// A workspace whose path is LENT to a program of another make — templateThroughPac hands pac the scratch folder it makes — is in use by that program, which is not the run:
// a hard kill of the run (SIGKILL, an agent's timeout) leaves the program running on POSIX. (On Windows a child ends with its launcher unless it was started detached, which is
// how these tests make the program outlive the run there.) The programs are REAL, started by solution-settings.js through the process runner, over a fake pac.
const WORKER_TIME = 120000;

// The program is started the way pac is: an ordinary child of the run. On POSIX it outlives a run that is killed with no help at all; on Windows an ordinary child ends with its launcher
// (libuv puts it in a job that is closed with the process), so there the second test starts it detached — which is what a survivor needs there, and what is measured.
for (const [how, detached, skip] of [
  ['an ordinary child, as pac is started', undefined, process.platform === 'win32' && 'on Windows an ordinary child ends with its launcher'],
  ['a detached child', 'detached', false],
]) {
  test(`REAL KILL: a workspace lent to a program that outlives the run that made it (${how}) is kept while the program runs — the program finishes its work in it — and is removed once the program is gone`, { skip }, async (t) => {
    const root = privateTempRoot(t);
    const deps = { os: { tmpdir: () => root } };
    const work = fs.mkdtempSync(path.join(root, 'work-'));
    const launcher = startTarget(t, detached ? ['pac-template', work, detached] : ['pac-template', work], { env: tempEnv(root) });
    const folder = (await launcher.waitFor(/^workspace /, WORKER_TIME)).slice('workspace '.length);
    const worker = await readJsonWhenWritten(path.join(work, 'worker.json'), WORKER_TIME);
    t.after(() => { try { process.kill(worker.pid, 'SIGKILL'); } catch { /* it ended */ } });
    const recordBefore = JSON.parse(fs.readFileSync(path.join(folder, OWNER_FILE), 'utf8'));
    await launcher.kill();
    assert.ok(isRunning(worker.pid), 'the program outlives the run that started it: that is the case');

    // The run is gone. The workspace is in use.
    const during = sweepDeadWorkspaces(deps);
    assert.deepStrictEqual(during.removed, [], 'a workspace in use by a program that runs is not removed because the run that made it is gone');
    assert.ok(fs.existsSync(folder), 'and is where it was');
    assert.strictEqual(recordBefore.pid, launcher.pid, 'it was recorded as the run\'s');
    assert.ok(recordBefore.lent && recordBefore.lent.pids.some((child) => child.pid === worker.pid), `and as lent to the program: ${JSON.stringify(recordBefore)}`);

    // The program goes on with what it was doing, in the folder it was given.
    fs.writeFileSync(path.join(work, 'resume'), '');
    assert.deepStrictEqual(await readJsonWhenWritten(path.join(work, 'worker-result.json'), WORKER_TIME), { error: null, fileExists: true }, 'the program wrote its file in the folder it was given');
    await waitUntil(() => !isRunning(worker.pid), 'the program to end', WORKER_TIME);

    // Now no process of either make is left in it.
    assert.deepStrictEqual(sweepDeadWorkspaces(deps).removed.map((r) => r.name), [path.basename(folder)]);
    assert.ok(!fs.existsSync(folder));
  });
}

test('REAL KILL: a run that dies between "about to start the program" and "started" leaves a workspace that is kept for a day — nothing says whether a program has it — and then removed', async (t) => {
  const root = privateTempRoot(t);
  const deps = { os: { tmpdir: () => root } };
  const work = fs.mkdtempSync(path.join(root, 'work-'));
  const launcher = startTarget(t, ['pac-pending', work], { env: tempEnv(root) });
  const folder = (await launcher.waitFor(/^pending /, WORKER_TIME)).slice('pending '.length);
  await launcher.kill();

  const now = sweepDeadWorkspaces(deps);
  assert.deepStrictEqual(now.removed, [], 'a program may have been started with this folder and be running, and nothing says which: the folder is kept');
  assert.ok(fs.existsSync(folder));
  const record = JSON.parse(fs.readFileSync(path.join(folder, OWNER_FILE), 'utf8'));
  assert.ok(record.lent && record.lent.pending === 1 && record.lent.pids.length === 0, JSON.stringify(record));
  const justUnderADay = sweepDeadWorkspaces({ ...deps, owner: { now: () => record.lent.at + 24 * 3600 * 1000 - 1000 } });
  assert.deepStrictEqual(justUnderADay.removed, [], 'still kept a second short of a day');
  const later = sweepDeadWorkspaces({ ...deps, owner: { now: () => record.lent.at + 24 * 3600 * 1000 + 1000 } });
  assert.deepStrictEqual(later.removed.map((r) => r.name), [path.basename(folder)], 'a day later no program of ours is still running: the folder is removed');
  assert.ok(!fs.existsSync(folder));
});

test('a run that lends its workspace to a program and finishes normally removes it as it always did — and the temp folder is left as it was found', async (t) => {
  const root = privateTempRoot(t);
  const work = fs.mkdtempSync(path.join(root, 'work-'));
  const run = startTarget(t, ['pac-template', work], { env: tempEnv(root) });
  const folder = (await run.waitFor(/^workspace /, WORKER_TIME)).slice('workspace '.length);
  const worker = await readJsonWhenWritten(path.join(work, 'worker.json'), WORKER_TIME);
  const record = JSON.parse(fs.readFileSync(path.join(folder, OWNER_FILE), 'utf8'));
  assert.ok(record.lent && record.lent.pids.some((child) => child.pid === worker.pid), 'while the program runs, the record says who has the folder');
  fs.writeFileSync(path.join(work, 'resume'), '');
  await run.waitFor(/^done$/, WORKER_TIME);
  await run.exited;
  assert.ok(!fs.existsSync(folder), 'the run removed its own workspace');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(work, 'settings-out.json'), 'utf8')), { EnvironmentVariables: [], ConnectionReferences: [] }, 'and wrote what pac wrote, at --out');
  assert.deepStrictEqual(fs.readdirSync(root).filter((name) => name !== path.basename(work)), [], 'nothing of the plugin\'s is left in the temp folder');
});
