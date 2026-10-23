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
//   node kill-target.js workspace-abort <prefix> <how> [lent|removed]
//        makes a workspace, puts a file in it and says `workspace <folder>`, then ends the way a run that is cut short does: <how> `exit` is process.exit(7), `throw` an error nothing catches (thrown from a timer, which ends
//        the process with status 1). With `lent` the workspace is made LENT to another program (makeTempWorkspace(prefix, { lent: true })); with `removed` it is removed first, as the run's own `finally` would have.
//   node kill-target.js workspace-listeners <prefix>
//        makes one and says what the process listens for once it has — `listeners {"SIGINT":0,"SIGTERM":0,"SIGHUP":0,"SIGBREAK":0}` — then removes it and ends: `done`.
//   node kill-target.js workspace-refused <prefix>
//        makes one with a maker that refuses to make a folder inside the plugin's own folder (a full disk: ENOSPC), so that the workspace is made in the temp folder itself — which it says, `workspace <folder>` —
//        and removes it, and ends: `done`. The plugin's folder was made, for the workspace that was refused.
//   node kill-target.js workspace-loop <prefix> <n> <ms> [<gateFile>]
//        n times: sweeps, makes a workspace, puts a file in it, waits <ms>, sweeps, checks that its own workspace is still whole (and recorded, if it is in the plugin's folder), removes it.
//        Says `ready`, waits for <gateFile> when one is given, and says `loop-done <how many times a workspace of its own was gone or unrecorded> <how many were made in the plain temp folder>`.
//   node kill-target.js hold <file>
//        opens <file> and keeps it open — a program that reads a file, or a scanner — says `ready`, and waits to be killed.
//   node kill-target.js pac-template <workDir> [detached]
//        runs the deployment-settings template through pac (solution-settings.js runTemplate: the scratch folder it makes for pac is a workspace made LENT) over a fake pac that
//        starts a real program, this file's `pac-worker`, with the folder it was given. Says `workspace <folder>` when the fake pac is handed its folder and `done` when the
//        template is written. `detached` starts the program detached, so that it outlives a hard kill of this process on Windows too (on POSIX every child does).
//   node kill-target.js pac-worker <settingsFile> <workDir>
//        the fake pac's program: writes the first half of <settingsFile>, writes its pid to <workDir>/worker.json, waits for <workDir>/resume, writes the rest and
//        <workDir>/worker-result.json (what its write said), and ends.
//   node kill-target.js pac-template-abort <workDir> <how>
//        runs the deployment-settings template through pac as `pac-template` does, over a fake pac that starts no program: it writes the first half of the settings file in the folder it was given,
//        says `workspace <folder>`, and then the run is cut short while pac "runs" — <how> `exit` is process.exit(7), `throw` an error nothing catches (thrown from a timer, which ends the process with
//        status 1), `wait` nothing: the process waits to be signalled or killed.
//   node kill-target.js lent-worker <workDir>
//        makes a workspace LENT (`makeTempWorkspace(prefix, { lent: true })`, as solution-settings.js does for pac), says `workspace <folder>`, waits for <workDir>/go — a test that wants
//        to do something to the record meanwhile (hold it exclusively) does it then — and starts the `pac-worker` program, detached, in the folder: `worker <pid>`. Then waits to be killed.
//   node kill-target.js sweep-pause <tempRoot>
//        sweeps the plugin's folder of the temp folder <tempRoot> and pauses for two minutes at the one moment a sweep that is killed can leave a removal half done: after the record
//        has been moved out of the dead run's folder and before the empty folder is removed. Says `before-rmdir <folder>` there.
//   node kill-target.js sweep <tempRoot>
//        one sweep of the plugin's folder of the temp folder <tempRoot>, by a process of its own — the next run, which knows nothing of the last one's memory, only of what it left on disk. Says
//        `swept {"removed":[<folder names>],"failed":<how many>,"kept":<how many>}` and ends. The Windows access-list reader is stood in for: the folder is the test's own, and what is under test is the sweep.
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
    // Gives up when no workspace is made — in less time than the test waits for the line (helpers/kill-target-client.js WAIT_MS), so
    // that what this process says reaches the test's failure. Cleared once it is ready: a holder that has said its workspace stays,
    // however long the test takes, until the test kills it.
    const giveUp = setTimeout(() => { say('no workspace was made'); process.exit(1); }, 25000);
    giveUp.unref();
    const poll = setInterval(() => {
      const [folder] = pageWorkspaces(root);
      // The folder exists from the moment it is made; the SDK has opened its workspace when it has written its manifest.
      if (folder && fs.existsSync(path.join(folder, 'manifest.json'))) { clearInterval(poll); clearTimeout(giveUp); say(`workspace ${folder}`); wait(); }
    }, 50);
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
  } else if (mode === 'workspace-abort') {
    const { makeTempWorkspace } = require('../../lib/temp-workspace.js');
    const [prefix, how, option] = args;
    const folder = makeTempWorkspace(prefix, option === 'lent' ? { lent: true } : {});
    fs.writeFileSync(path.join(folder, 'page.tsx'), 'x');
    if (option === 'removed') fs.rmSync(folder, { recursive: true, force: true });
    say(`workspace ${folder}`);
    if (how === 'exit') process.exit(7);
    // From a timer, so that nothing in this file catches it: the process ends as it does for any error that nothing catches.
    if (how === 'throw') setImmediate(() => { throw new Error('an error nothing catches'); });
  } else if (mode === 'workspace-listeners') {
    const { makeTempWorkspace } = require('../../lib/temp-workspace.js');
    const folder = makeTempWorkspace(args[0]);
    const listeners = Object.fromEntries(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].map((signal) => [signal, process.listenerCount(signal)]));
    say(`listeners ${JSON.stringify(listeners)}`);
    fs.rmSync(folder, { recursive: true, force: true });
    say('done');
  } else if (mode === 'workspace-refused') {
    const { makeTempWorkspace, workspaceParent } = require('../../lib/temp-workspace.js');
    const parent = workspaceParent();
    const folder = makeTempWorkspace(args[0], {
      mkdtempSync: (start) => {
        if (path.dirname(start) === parent) throw Object.assign(new Error(`ENOSPC: no space left on device, mkdir '${start}'`), { code: 'ENOSPC' });
        return fs.mkdtempSync(start);
      },
    });
    say(`workspace ${folder}`);
    fs.rmSync(folder, { recursive: true, force: true });
    say('done');
  } else if (mode === 'workspace-loop') {
    const { makeTempWorkspace, sweepDeadWorkspaces, workspaceParent } = require('../../lib/temp-workspace.js');
    const [prefix, iterations, ms, gate] = args;
    say('ready');
    if (gate) while (!fs.existsSync(gate)) pause(1);
    let lost = 0;
    let plain = 0;
    for (let i = 0; i < Number(iterations); i += 1) {
      sweepDeadWorkspaces();
      const folder = makeTempWorkspace(prefix);
      // The plugin's folder is a courtesy: where it could not be used — another run was removing it just then (Windows) — the workspace is made in the temp folder, unrecorded and never swept.
      // That is a workspace like any other for this run, but it is counted, so that a run that always did so is seen.
      const inPluginFolder = path.dirname(folder) === workspaceParent();
      if (!inPluginFolder) plain += 1;
      fs.writeFileSync(path.join(folder, 'page.tsx'), 'x');
      await new Promise((resolve) => setTimeout(resolve, Number(ms)));
      sweepDeadWorkspaces();
      if (!fs.existsSync(path.join(folder, 'page.tsx')) || (inPluginFolder && !fs.existsSync(path.join(folder, '.owner.json')))) lost += 1;
      fs.rmSync(folder, { recursive: true, force: true });
    }
    say(`loop-done ${lost} ${plain}`);
  } else if (mode === 'hold') {
    fs.openSync(args[0], 'r');
    say('ready');
    wait();
  } else if (mode === 'pac-worker') {
    const [settingsFile, workDir] = args;
    fs.writeFileSync(settingsFile, '{"EnvironmentVariables":');
    fs.writeFileSync(path.join(workDir, 'worker.json'), JSON.stringify({ pid: process.pid }));
    while (!fs.existsSync(path.join(workDir, 'resume'))) pause(20);
    // What pac would do next: finish writing its file in the folder it was given. If that folder has been removed from under it, the write says so.
    let error = null;
    try { fs.writeFileSync(settingsFile, '{"EnvironmentVariables":[],"ConnectionReferences":[]}'); } catch (e) { error = (e && e.code) || String(e); }
    fs.writeFileSync(path.join(workDir, 'worker-result.json'), JSON.stringify({ error, fileExists: fs.existsSync(settingsFile) }));
  } else if (mode === 'pac-template') {
    const [workDir, detached] = args;
    const { runTemplate } = require('../../solution-settings.js');
    const { spawnResultTree, withPathFirst } = require('../../lib/process-runner.js');
    // The runner looks programs up on PATH and never in the current folder: the fake pac is `node`, found where this one is.
    const env = withPathFirst(process.env, path.dirname(process.execPath));
    const nodeName = path.basename(process.execPath, path.extname(process.execPath));
    const packagePath = path.join(workDir, 'package.zip');
    fs.writeFileSync(packagePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01]));
    const spawn = (_name, pacArgs, options) => {
      const folder = path.dirname(pacArgs[pacArgs.indexOf('--settings-file') + 1]);
      say(`workspace ${folder}`);
      return spawnResultTree(nodeName, [__filename, 'pac-worker', pacArgs[pacArgs.indexOf('--settings-file') + 1], workDir], { ...options, env, ...(detached === 'detached' ? { detached: true } : {}) }, { env });
    };
    wait();
    await runTemplate({ command: 'template', packagePath, outPath: path.join(workDir, 'settings-out.json'), force: false }, { pac: { spawn } });
    say('done');
    process.exit(0);
  } else if (mode === 'pac-template-abort') {
    const [workDir, how] = args;
    const { runTemplate } = require('../../solution-settings.js');
    const packagePath = path.join(workDir, 'package.zip');
    fs.writeFileSync(packagePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01]));
    const spawn = (_name, pacArgs) => {
      const settingsFile = pacArgs[pacArgs.indexOf('--settings-file') + 1];
      fs.writeFileSync(settingsFile, '{"EnvironmentVariables":');
      say(`workspace ${path.dirname(settingsFile)}`);
      if (how === 'exit') process.exit(7);
      // From a timer, so that nothing in this file catches it: the process ends as it does for any error that nothing catches.
      if (how === 'throw') setImmediate(() => { throw new Error('an error nothing catches'); });
      return new Promise(() => {});
    };
    wait();
    await runTemplate({ command: 'template', packagePath, outPath: path.join(workDir, 'settings-out.json'), force: false }, { pac: { spawn } });
  } else if (mode === 'lent-worker') {
    const [workDir] = args;
    const { makeTempWorkspace } = require('../../lib/temp-workspace.js');
    const { spawn: start } = require('node:child_process');
    // What solution-settings.js does for pac, and nothing more: the workspace is made lent, once; then a program is given a path in it.
    const folder = makeTempWorkspace('solution-settings-', { lent: true });
    say(`workspace ${folder}`);
    while (!fs.existsSync(path.join(workDir, 'go'))) pause(10);
    const worker = start(process.execPath, [__filename, 'pac-worker', path.join(folder, 'settings.json'), workDir], { detached: true, stdio: 'ignore', windowsHide: true });
    worker.unref();
    say(`worker ${worker.pid}`);
    wait();
  } else if (mode === 'sweep-pause') {
    const { sweepDeadWorkspaces } = require('../../lib/temp-workspace.js');
    const [root] = args;
    sweepDeadWorkspaces({
      os: { tmpdir: () => root },
      fs: { ...fs, rmdirSync: (dir, ...rest) => { say(`before-rmdir ${dir}`); pause(120000); return fs.rmdirSync(dir, ...rest); } },
    });
    say('swept');
  } else if (mode === 'sweep') {
    const { sweepDeadWorkspaces } = require('../../lib/temp-workspace.js');
    const [root] = args;
    const swept = sweepDeadWorkspaces({ os: { tmpdir: () => root }, folderPrivacy: () => ({ ok: true, reason: 'stood in for' }) });
    say(`swept ${JSON.stringify({ removed: swept.removed.map((r) => r.name), failed: swept.failed.length, kept: swept.kept })}`);
  } else {
    process.stderr.write(`unknown mode ${mode}\n`);
    process.exit(2);
  }
}

main().catch((error) => {
  process.stderr.write(`${(error && error.stack) || error}\n`);
  process.exit(1);
});
