'use strict';
// What a KILLED run leaves in the temp folder, and what the next run does about it. A run that is killed outright — SIGKILL, "End task", an
// agent's timeout — cannot remove the throwaway workspace it made: its page backend holds the source of every page it read and the environment's
// address there. The next run removes the workspaces of runs that are gone, says so, and never touches a workspace whose run may still be going.
// The runs are REAL processes, each with a temp folder of its own (TMPDIR / TEMP / TMP), so nothing here touches anyone else's.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { privateTempRoot, tempEnv, startTarget } = require('./helpers/kill-target-client.js');

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
