'use strict';
// A process for the tests of what a KILLED run leaves behind. It takes what a run takes, says so on stdout, and then waits to be killed (the test
// ends it with SIGKILL — on Windows, TerminateProcess — which gives it no chance to clean up, exactly as an agent's timeout or "End task" does).
//
//   node kill-target.js lock <workspaceDir> <appUnique> [<gateFile>]
//        takes the pages lock of an app's workspace through the build's own function (lib/sdk-build.js acquireAppPagesLease). Says `ready`
//        once the module is loaded, waits for <gateFile> to exist when one is given (so several of these can start together), then says
//        `held` and waits to be killed — or says `refused <code>` and ends. A warning the function gives is said as `warn <text>`.
//   node kill-target.js pages <envUrl>
//        starts the page backend (lib/genpage-sdk.js) on requests that never answer, which makes its throwaway workspace and leaves the run
//        waiting in the first of them. Says `workspace <folder>` once the folder exists, and waits to be killed.
//   node kill-target.js pages-run <envUrl>
//        runs the page backend to the end over the in-memory page service: lists the pages, disposes the backend and says `done <answer>`.
//   node kill-target.js workspace <prefix>
//        makes a temporary workspace through the plugin's one maker of them (lib/temp-workspace.js), puts a file in it, says `workspace <folder>`
//        and waits to be killed.
//   node kill-target.js workspace-exit <prefix>        makes one, removes it as a run does when it is done, and ends: `done`.
//   node kill-target.js workspace-keep <prefix>        makes one and ends without removing it (a run that failed to): `workspace <folder>`.
//   node kill-target.js workspace-loop <prefix> <n> <ms> [<gateFile>]
//        n times: sweeps, makes a workspace, puts a file in it, waits <ms>, sweeps, checks that its own workspace and its record are still there, removes it.
//        Says `ready`, waits for <gateFile> when one is given, and says `loop-done <how many times a workspace of its own was gone or unrecorded>`.
//
// The test sets TMPDIR, TEMP and TMP to a folder of its own for these, so everything the process makes is in a place the test removes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [mode, ...args] = process.argv.slice(2);
const say = (line) => process.stdout.write(`${line}\n`);
// A timer that does nothing keeps the process, and so its pid, alive until something ends it.
const wait = () => setInterval(() => {}, 1000);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The `genpage-` folders under `root`, one level down as well: the folder the page backend made is directly in the temp folder or, when the plugin
// keeps its workspaces together, in the one folder it keeps them in.
function pageWorkspaces(root) {
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('genpage-')) found.push(path.join(root, entry.name));
    else for (const inner of fs.readdirSync(path.join(root, entry.name), { withFileTypes: true })) {
      if (inner.isDirectory() && inner.name.startsWith('genpage-')) found.push(path.join(root, entry.name, inner.name));
    }
  }
  return found;
}

async function main() {
  if (mode === 'lock') {
    const [workspaceDir, appUnique, gate] = args;
    const { acquireAppPagesLease } = require('../../lib/sdk-build.js');
    say('ready');
    if (gate) while (!fs.existsSync(gate)) pause(1);
    try {
      acquireAppPagesLease(workspaceDir, appUnique, { warn: (message) => say(`warn ${message}`) });
      say('held');
      wait();
    } catch (error) {
      say(`refused ${error && error.code}`);
    }
  } else if (mode === 'pages') {
    const { makeGenpageSdk } = require('../../lib/genpage-sdk.js');
    const never = () => new Promise(() => {});
    const genpage = makeGenpageSdk(args[0], { httpClient: { get: never, post: never, patch: never, delete: never } });
    genpage.enumerateEnv();
    // Polled on a timer, not in a loop: the SDK opens its workspace in this same event loop.
    const root = os.tmpdir();
    const poll = setInterval(() => {
      const [folder] = pageWorkspaces(root);
      // The folder exists from the moment it is made; the SDK has opened its workspace when it has written its manifest.
      if (folder && fs.existsSync(path.join(folder, 'manifest.json'))) { clearInterval(poll); say(`workspace ${folder}`); wait(); }
    }, 50);
    setTimeout(() => { say('no workspace was made'); process.exit(1); }, 60000).unref();
  } else if (mode === 'pages-run') {
    const { makeGenpageSdk } = require('../../lib/genpage-sdk.js');
    const { FakeGenPageServer } = require('./fake-genpage-server.js');
    const genpage = makeGenpageSdk(args[0], { httpClient: new FakeGenPageServer().http() });
    const listed = await genpage.enumerateEnv();
    const disposed = await genpage.dispose();
    say(`done ${JSON.stringify({ ok: listed.ok, left: disposed.left })}`);
  } else if (mode === 'workspace') {
    const { makeTempWorkspace } = require('../../lib/temp-workspace.js');
    const folder = makeTempWorkspace(args[0]);
    fs.writeFileSync(path.join(folder, 'page.tsx'), 'export default function Page() { return null; }\n');
    say(`workspace ${folder}`);
    wait();
  } else if (mode === 'workspace-exit') {
    const { makeTempWorkspace } = require('../../lib/temp-workspace.js');
    const folder = makeTempWorkspace(args[0]);
    fs.writeFileSync(path.join(folder, 'page.tsx'), 'x');
    fs.rmSync(folder, { recursive: true, force: true });
    say('done');
  } else if (mode === 'workspace-keep') {
    const { makeTempWorkspace } = require('../../lib/temp-workspace.js');
    const folder = makeTempWorkspace(args[0]);
    fs.writeFileSync(path.join(folder, 'page.tsx'), 'x');
    say(`workspace ${folder}`);
  } else if (mode === 'workspace-loop') {
    const { makeTempWorkspace, sweepDeadWorkspaces } = require('../../lib/temp-workspace.js');
    const [prefix, iterations, ms, gate] = args;
    say('ready');
    if (gate) while (!fs.existsSync(gate)) pause(1);
    let lost = 0;
    for (let i = 0; i < Number(iterations); i += 1) {
      sweepDeadWorkspaces();
      const folder = makeTempWorkspace(prefix);
      fs.writeFileSync(path.join(folder, 'page.tsx'), 'x');
      await new Promise((resolve) => setTimeout(resolve, Number(ms)));
      sweepDeadWorkspaces();
      if (!fs.existsSync(path.join(folder, 'page.tsx')) || !fs.existsSync(path.join(folder, '.owner.json'))) lost += 1;
      fs.rmSync(folder, { recursive: true, force: true });
    }
    say(`loop-done ${lost}`);
  } else {
    process.stderr.write(`unknown mode ${mode}\n`);
    process.exit(2);
  }
}

main().catch((error) => {
  process.stderr.write(`${(error && error.stack) || error}\n`);
  process.exit(1);
});
