'use strict';
// What a KILLED run leaves in the temp folder, and what the next run does about it. A run that is killed outright — SIGKILL, "End task", an
// agent's timeout — cannot remove the throwaway workspace it made: its page backend holds the source of every page it read and the environment's
// address there. The next run removes the workspaces of runs that are gone, says so, and never touches a workspace whose run may still be going.
// The runs are REAL processes, each with a temp folder of its own (TMPDIR / TEMP / TMP), so nothing here touches anyone else's.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { privateTempRoot, tempEnv, startTarget, isRunning, waitUntil, readJsonWhenWritten, deadPid, holdExclusively } = require('./helpers/kill-target-client.js');
const { sweepDeadWorkspaces, workspaceParent, OWNER_FILE, REMOVING_SUFFIX, LENT_KEEP_MS } = require('../lib/temp-workspace.js');
const { ownerStamp } = require('../lib/process-owner.js');

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
// The run says so when it makes the folder, once; nothing about the folder is changed after the program has started, and a sweep takes a lent folder only when it is old (LENT_KEEP_MS).
const WORKER_TIME = 30000;
const DAY = 24 * 60 * 60 * 1000;

// The program is started the way pac is: an ordinary child of the run. On POSIX it outlives a run that is killed with no help at all; on Windows an ordinary child ends with its launcher
// (libuv puts it in a job that is closed with the process), so there the second test starts it detached — which is what a survivor needs there, and what is measured.
for (const [how, detached, skip] of [
  ['an ordinary child, as pac is started', undefined, process.platform === 'win32' && 'on Windows an ordinary child ends with its launcher'],
  ['a detached child', 'detached', false],
]) {
  test(`REAL KILL: a workspace lent to a program that outlives the run that made it (${how}) is kept while the program runs — the program finishes its work in it — and is taken only when it is old`, { skip }, async (t) => {
    const root = privateTempRoot(t);
    const deps = { os: { tmpdir: () => root } };
    const work = fs.mkdtempSync(path.join(root, 'work-'));
    const launcher = startTarget(t, detached ? ['pac-template', work, detached] : ['pac-template', work], { env: tempEnv(root) });
    const folder = (await launcher.waitFor(/^workspace /, WORKER_TIME)).slice('workspace '.length);
    const worker = await readJsonWhenWritten(path.join(work, 'worker.json'), WORKER_TIME);
    t.after(() => { try { process.kill(worker.pid, 'SIGKILL'); } catch { /* it ended */ } });
    const recordText = fs.readFileSync(path.join(folder, OWNER_FILE), 'utf8');
    const recordBefore = JSON.parse(recordText);
    await launcher.kill();
    assert.ok(isRunning(worker.pid), 'the program outlives the run that started it: that is the case');

    // The run is gone. The workspace is in use.
    const during = sweepDeadWorkspaces(deps);
    assert.deepStrictEqual(during.removed, [], 'a workspace in use by a program that runs is not removed because the run that made it is gone');
    assert.ok(fs.existsSync(folder), 'and is where it was');
    assert.strictEqual(recordBefore.pid, launcher.pid, 'it was recorded as the run\'s');
    assert.strictEqual(recordBefore.lent, true, `and as lent, in the one record the run wrote when it made the folder: ${recordText}`);
    assert.strictEqual(fs.readFileSync(path.join(folder, OWNER_FILE), 'utf8'), recordText, 'which was not written again while the program ran');

    // The program goes on with what it was doing, in the folder it was given.
    fs.writeFileSync(path.join(work, 'resume'), '');
    assert.deepStrictEqual(await readJsonWhenWritten(path.join(work, 'worker-result.json'), WORKER_TIME), { error: null, fileExists: true }, 'the program wrote its file in the folder it was given');
    await waitUntil(() => !isRunning(worker.pid), 'the program to end', WORKER_TIME);

    // Not even then is it taken because its run is gone: nothing says no other program has it. It is taken when it is old.
    assert.deepStrictEqual(sweepDeadWorkspaces(deps).removed, [], 'the run and the program are gone, and the folder is young: kept');
    assert.ok(fs.existsSync(folder));
    const later = sweepDeadWorkspaces({ ...deps, owner: { now: () => Date.now() + LENT_KEEP_MS + DAY } });
    assert.deepStrictEqual(later.removed.map((r) => r.name), [path.basename(folder)], 'a week and a day on, it is removed');
    assert.ok(!fs.existsSync(folder));
  });
}

// The reason the record is written once and never changed: a record that is changed after a program has started can be unreadable at that moment, and what the folder says is then not what the run
// decided. Here the record is held so that nobody else can read it (FileShare.None; a scanner, a backup or an editor does that for a moment), the run is killed with its program still running, and a
// sweep finds the record unreadable, and then readable. Neither may take the folder from under the program.
test('REAL KILL (Windows): a record that cannot be read for a moment — another program holds it exclusively — does not cost a lent workspace: kept while unreadable, kept once readable, and the program that had it finishes its work', { skip: process.platform !== 'win32' && 'an exclusive hold on a file is a Windows thing' }, async (t) => {
  const root = privateTempRoot(t);
  const deps = { os: { tmpdir: () => root } };
  const work = fs.mkdtempSync(path.join(root, 'work-'));
  const launcher = startTarget(t, ['lent-worker', work], { env: tempEnv(root) });
  const folder = (await launcher.waitFor(/^workspace /, WORKER_TIME)).slice('workspace '.length);
  const marker = path.join(folder, OWNER_FILE);
  const recordText = fs.readFileSync(marker, 'utf8');
  // The hold starts before the program does, and lasts past the kill, the way a scanner or a backup holds a file at the moment it is read.
  const hold = await holdExclusively(t, marker);
  assert.throws(() => fs.readFileSync(marker, 'utf8'), (e) => ['EBUSY', 'EPERM', 'EACCES'].includes(e.code), 'control: the record cannot be read now');
  fs.writeFileSync(path.join(work, 'go'), '');
  const worker = Number((await launcher.waitFor(/^worker \d+$/, WORKER_TIME)).slice('worker '.length));
  t.after(() => { try { process.kill(worker, 'SIGKILL'); } catch { /* it ended */ } });
  await launcher.kill();
  assert.ok(isRunning(worker), 'the program outlives the run that started it');

  assert.deepStrictEqual([sweepDeadWorkspaces(deps).removed, fs.existsSync(folder)], [[], true], 'the record cannot be read: nothing is shown to be dead, and the folder is kept');
  await hold.release();
  assert.strictEqual(fs.readFileSync(marker, 'utf8'), recordText, 'the record is what the run wrote when it made the folder: nothing changed it meanwhile');
  assert.deepStrictEqual([sweepDeadWorkspaces(deps).removed, fs.existsSync(folder)], [[], true], 'readable again, it says lent, and the folder is young: kept');
  fs.writeFileSync(path.join(work, 'resume'), '');
  assert.deepStrictEqual(await readJsonWhenWritten(path.join(work, 'worker-result.json'), WORKER_TIME), { error: null, fileExists: true }, 'the program wrote its file in the folder it was given');
});

// A sweep that is killed after it has moved the record out of a dead run's folder and before it has removed the empty folder leaves `<folder>.removing` and an empty folder; the next sweep
// finishes the removal, and the one after finds nothing.
test('REAL KILL: a sweep that is killed between moving the record aside and removing the folder leaves a removal that the next sweep finishes', async (t) => {
  const root = privateTempRoot(t);
  const deps = { os: { tmpdir: () => root } };
  const parent = workspaceParent(deps);
  fs.mkdirSync(parent, { mode: 0o700 });
  const gone = deadPid();
  const dir = fs.mkdtempSync(path.join(parent, `genpage-${gone}-`));
  fs.writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify(ownerStamp({ pid: gone })));
  fs.writeFileSync(path.join(dir, 'page.tsx'), 'the page source');

  const sweeper = startTarget(t, ['sweep-pause', root], { env: tempEnv(root) });
  await sweeper.waitFor(/^before-rmdir /, WORKER_TIME);
  await sweeper.kill();
  assert.deepStrictEqual([fs.existsSync(dir), fs.existsSync(dir) ? fs.readdirSync(dir) : null], [true, []], 'the killed sweep left the folder, empty — and, beside it, the record');
  assert.deepStrictEqual(fs.readdirSync(parent).sort(), [path.basename(dir), `${path.basename(dir)}${REMOVING_SUFFIX}`].sort());

  const next = sweepDeadWorkspaces(deps);
  assert.deepStrictEqual([next.removed.map((r) => r.name), next.failed], [[path.basename(dir)], []], 'the next sweep finishes the removal');
  assert.deepStrictEqual(fs.readdirSync(parent), [], 'the folder and the record beside it are gone');
  const again = sweepDeadWorkspaces(deps);
  assert.deepStrictEqual([again.removed, again.failed], [[], []], 'and the one after that finds nothing to do');
});

test('a run that lends its workspace to a program and finishes normally removes it as it always did — and the temp folder is left as it was found', async (t) => {
  const root = privateTempRoot(t);
  const work = fs.mkdtempSync(path.join(root, 'work-'));
  const run = startTarget(t, ['pac-template', work], { env: tempEnv(root) });
  const folder = (await run.waitFor(/^workspace /, WORKER_TIME)).slice('workspace '.length);
  await readJsonWhenWritten(path.join(work, 'worker.json'), WORKER_TIME);
  const record = JSON.parse(fs.readFileSync(path.join(folder, OWNER_FILE), 'utf8'));
  assert.strictEqual(record.lent, true, 'while the program runs, the record says the folder was lent');
  fs.writeFileSync(path.join(work, 'resume'), '');
  await run.waitFor(/^done$/, WORKER_TIME);
  await run.exited;
  assert.ok(!fs.existsSync(folder), 'the run removed its own workspace');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(work, 'settings-out.json'), 'utf8')), { EnvironmentVariables: [], ConnectionReferences: [] }, 'and wrote what pac wrote, at --out');
  assert.deepStrictEqual(fs.readdirSync(root).filter((name) => name !== path.basename(work)), [], 'nothing of the plugin\'s is left in the temp folder');
});
