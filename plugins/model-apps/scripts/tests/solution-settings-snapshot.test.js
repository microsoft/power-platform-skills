'use strict';
// The settings copy the pac import fallback gives pac (importThroughPac), as the operating system sees it. What solution-settings.test.js and its real-bundle twin cannot say — because it is a statement about
// the file system and about processes, not about a call — is said here:
//   - the copy is its owner's alone, and not by the grace of the folder it happens to be in: on Windows an access list with the current user as its one entry, whatever the temporary folder grants others
//     (it is a native Windows check, run with a parent that gives the Users group read access); elsewhere the permission bits 0700 and 0600, whatever the umask;
//   - when that cannot be established the import is not run through pac at all;
//   - the copy is removed however the process ends that JavaScript can see — `process.exit`, an uncaught error, SIGINT, SIGTERM and SIGHUP — and the process then ends as it would have: BY the signal on POSIX, and on
//     Windows, where a user's Ctrl+C or Ctrl+Break is a console event and not a signal, with the status such an event gives a process that nothing handles (0xC000013A: the run was cancelled, it did not fail).
// A process that is KILLED (SIGKILL, TerminateProcess) cannot run anything: the copy of such a run stays, in the folder the run made for it — in the plugin's own folder of the temp directory, named for the run's pid, with
// the owner record a later run's sweep reads (lib/temp-workspace.js) and LENT to pac, which a sweep keeps until the folder is old, whether or not the run is still going. The last test says what the sweep does with it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const ss = require('../solution-settings.js');
const { createCloud, ORG } = require('./helpers/fake-power-platform.js');
const { runInConsoles, controlProblem } = require('./helpers/console-event.js');
const { sweepDeadWorkspaces, LENT_KEEP_MS } = require('../lib/temp-workspace.js');
const { createPrivateFile } = require('../lib/private-folder.js');
const { pluginFolderOf, workFoldersIn, filesUnder, ownerRecordOf, assertMadeByTheMaker } = require('./helpers/solution-settings-work-folder.js');

const SECRET = 'synthetic-snapshot-secret-not-a-real-value';
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(' a solution package')]);
const CHILD = path.join(__dirname, 'helpers', 'interrupted-import-child.js');
const EXIT_CLEANUP_CHILD = path.join(__dirname, 'helpers', 'exit-cleanup-child.js');
const WINDOWS = process.platform === 'win32';
const DAY = 24 * 60 * 60 * 1000;

const roots = [];
function folder(prefix = 'snapshot-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
test.after(() => { for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });

// A settings file that only pac can apply (a non-empty Workflows list), with one filled secret: the importer reaches its pac step with it.
const pacOnlySettings = (value = SECRET) => JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'new_Secret', Value: value, TypeId: 100000005 }], ConnectionReferences: [], Workflows: [{ WorkflowId: '1' }] });
const REFUSAL = { code: 'INVALID_ARGUMENT', message: 'importSolution: the settings file holds a feature only pac applies. Nothing was imported.' };
const viaPac = async (env, plan) => ({ source: 'pac', value: await plan.fromPac(REFUSAL), fallback: REFUSAL });
function importRequest(dir, settings = pacOnlySettings()) {
  const packagePath = path.join(dir, 'solution.zip');
  const settingsPath = path.join(dir, 'input.json');
  fs.writeFileSync(packagePath, ZIP);
  fs.writeFileSync(settingsPath, settings);
  return { command: 'import', env: ORG, packagePath, settingsPath };
}
function importDeps(pac) {
  const cloud = createCloud();
  return { http: { getToken: () => cloud.tokens.dataverse, request: cloud.request, sleep: async () => {} }, sdkFirst: viaPac, pac };
}
// Runs the importer with `TEMP` (and TMP, TMPDIR) pointing at `temp` for the length of the call, so that the folders the run makes are found there and nowhere else.
async function importingWithTemp(t, temp, request, pac, extra = {}) {
  const old = Object.fromEntries(['TEMP', 'TMP', 'TMPDIR'].map((name) => [name, process.env[name]]));
  for (const name of Object.keys(old)) process.env[name] = temp;
  try {
    return await ss.runImport(request, { ...importDeps(pac), ...extra });
  } finally {
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// The work folder is made in one of two places (lib/temp-workspace.js): in the plugin's own folder of the temp folder — which the maker gives an access list of its own, protected, before anything is put in it — or, where
// that folder cannot be used, in the temp folder itself. What the run guarantees about the copy and its folder is the same in both, so both are run (`workFoldersIn` looks in both for what a run left). The plugin's
// folder is left to the maker — on POSIX it is made here, before the test sets its hostile umask: made under that mask it would be 0500, which the maker rightly refuses, and the run would go on in the temp folder
// itself, which is what the other way is for. For the other way the plugin's folder is made unusable: a FILE where the folder would be, which the maker finds is not a folder.
const WAYS = [
  {
    how: 'in the plugin\'s own folder',
    where: (temp) => pluginFolderOf(temp),
    prepare: (temp) => { if (!WINDOWS) fs.mkdirSync(pluginFolderOf(temp), { mode: 0o700 }); },
  },
  {
    how: 'in the temp folder itself, where the plugin\'s own folder cannot be used',
    where: (temp) => temp,
    prepare: (temp) => fs.writeFileSync(pluginFolderOf(temp), ''),
  },
];

// --- Windows: the access list ------------------------------------------------------------------------------------------------------------------------

const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const POWERSHELL = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// The access lists of three paths, as .NET reads them — SDDL text, like `D:PAI(A;OICI;FA;;;S-1-5-21-…)` — and, for each, the SID of every entry's trustee IN FULL (`GetAccessRules(…, [SecurityIdentifier])`: .NET
// resolves each entry to its SID itself, whatever alias the SDDL text uses for it), and the SID of the user running this process. Written independently of the code under test: it asks the operating system through
// another route (PowerShell, not icacls), and compares accounts as the SIDs they are, not as the names SDDL writes them by.
function accessLists(paths) {
  const quoted = (value) => `'${value.replace(/'/g, "''")}'`;
  const reads = Object.entries(paths).flatMap(([name, target, kind = /\.[A-Za-z]+$/.test(target) ? 'File' : 'Directory']) => {
    const security = `[System.IO.${kind}]::GetAccessControl(${quoted(target)})`;
    return [
      `$r.${name} = ${security}.GetSecurityDescriptorSddlForm('Access')`,
      `$r.${name}Sids = @(${security}.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value })`,
    ];
  });
  const script = ['$ErrorActionPreference = "Stop"', '$r = @{}', '$r.me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value', ...reads, 'ConvertTo-Json -Compress -InputObject $r'].join('; ');
  const run = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(run.status, 0, run.stderr);
  const lists = JSON.parse(run.stdout);
  // A list of one entry may come back as the bare string.
  for (const name of Object.keys(paths)) lists[`${name}Sids`] = [].concat(lists[`${name}Sids`] === undefined ? [] : lists[`${name}Sids`]);
  return lists;
}
// The SID of the Users group, which the shared temporary folder is made to grant read access.
const USERS_GROUP = 'S-1-5-32-545';

// Two temporary folders, because Windows hands a new folder its access list in two ways and the code must make either the current user's alone: where the folder's parent has been given inheritable entries (a shared
// TEMP that grants the Users group read access — what an administrator or a policy sets), the new folder INHERITS them, and `/inheritance:r` removes them; in a plain folder under the user's own temporary folder
// Windows gives the new folder entries OF ITS OWN for SYSTEM, Administrators and the user (measured on a Windows 11 machine joined to Azure AD), which `/inheritance:r` leaves where they are and only `/reset`
// takes back to what is inherited first. A copy that is the current user's alone must come out of both — and of each of the two places the work folder is made in (`WAYS`): in the temp folder itself the folder
// inherits from the temp folder, and in the plugin's own folder from a folder that the maker has already made the current user's, the system's and the administrators'.
const TEMP_FOLDERS = [
  { what: 'a temporary folder that gives the Users group read access, inheritably', grant: true },
  { what: 'a plain folder in the user\'s own temporary folder, where Windows gives a new folder entries of its own for SYSTEM, Administrators and the user', grant: false },
];
for (const { what, grant } of TEMP_FOLDERS) {
  for (const { how, where, prepare } of WAYS) {
    test(`Windows: the settings copy and its folder are the current user's alone, in ${what}, with the work folder made ${how} — and the copy is gone afterwards`, { skip: !WINDOWS && 'an access list is native to Windows; elsewhere the permission bits are tested (below)' }, async (t) => {
      const base = folder();
      const shared = path.join(base, 'shared-temp');
      fs.mkdirSync(shared);
      if (grant) {
        // The situation of a shared TEMP, where a file a run makes can be read by other accounts.
        const granted = spawnSync(path.join(SYSTEM32, 'icacls.exe'), [shared, '/grant', '*S-1-5-32-545:(OI)(CI)RX'], { encoding: 'utf8' });
        assert.strictEqual(granted.status, 0, granted.stdout + granted.stderr);
      }
      prepare(shared);
      const request = importRequest(base);
      let seen;
      const pac = {
        spawn: (name, args) => {
          const copy = args[args.indexOf('--settings-file') + 1];
          assert.ok(fs.readFileSync(copy, 'utf8').includes(SECRET), 'the copy holds the filled value while pac runs');
          seen = { copy, ...accessLists({ parent: shared, folder: path.dirname(copy), file: copy }) };
          return { status: 0, stdout: 'Solution Imported successfully.', stderr: '' };
        },
      };
      const result = await importingWithTemp(t, shared, request, pac);
      assert.strictEqual(result.source, 'pac');
      const me = seen.me;
      assert.strictEqual(path.dirname(path.dirname(seen.copy)), where(shared), `the work folder was made ${how}`);
      if (grant) assert.ok(seen.parentSids.includes(USERS_GROUP), 'fixture control: the temporary folder does grant the Users group read access');
      assert.deepStrictEqual(seen.folderSids, [me], 'the folder: one entry, the current user\'s — the same SID, whatever alias the list spells it with');
      assert.deepStrictEqual(seen.fileSids, [me], 'the copy: one entry, the current user\'s — nothing the folder it is in grants the Users group reaches it');
      assert.match(seen.folder, /^D:P/, 'the folder does not inherit from its parent: its access list is protected');
      assert.deepStrictEqual(workFoldersIn(shared), [], 'the folder is gone — its owner can remove it');
    });
  }
}

// What a run says when it cannot make the copy private: PAC_SETTINGS_COPY_FAILED with the system's code or the step that failed, the reason pac was asked, no value anywhere, and pac not started.
function assertCopyRefused(failure, pacCalls) {
  assert.ok(failure, 'the import failed');
  assert.strictEqual(failure.code, 'PAC_SETTINGS_COPY_FAILED');
  assert.match(failure.message, /^`pac solution import` was not run: a private copy of the settings file could not be made \([^)]+\)\.$/);
  assert.strictEqual(failure.fallback.code, 'INVALID_ARGUMENT');
  assert.ok(!failure.message.includes(SECRET));
  assert.strictEqual(pacCalls, 0, 'pac was not started');
}

for (const { how, where, prepare } of WAYS) {
  test(`Windows: when the access list cannot be set — icacls cannot be started — the import is not run through pac, with the work folder made ${how}: no copy has a value in it, pac is not started, and the folder is gone`, { skip: !WINDOWS && 'an access list is native to Windows' }, async (t) => {
    const base = folder();
    const temp = path.join(base, 'tmp');
    fs.mkdirSync(temp);
    prepare(temp);
    const request = importRequest(base);
    let pacCalls = 0;
    const pac = { spawn: () => { pacCalls += 1; return { status: 0, stdout: '', stderr: '' }; } };
    // Where the work folder was made, said when the copy is asked for.
    let made;
    const privateFile = (dir, name, bytes) => {
      made = dir;
      return createPrivateFile(dir, name, bytes);
    };
    // icacls.exe is looked up in the Windows folder's System32 and nowhere else: with the Windows folder pointing at nothing it is not found. (Only the copy's tools are cut off: the maker finds the tools for the
    // plugin's own folder through the command interpreter's path, `ComSpec`, which is not changed.)
    const root = process.env.SystemRoot;
    const winDir = process.env.windir;
    process.env.SystemRoot = path.join(base, 'no-windows');
    delete process.env.windir;
    let failure;
    try {
      await importingWithTemp(t, temp, request, pac, { privateFile }).catch((error) => { failure = error; });
    } finally {
      process.env.SystemRoot = root;
      if (winDir !== undefined) process.env.windir = winDir;
    }
    assertCopyRefused(failure, pacCalls);
    assert.ok(made && path.dirname(made) === where(temp), `the work folder was made ${how}`);
    assert.deepStrictEqual(workFoldersIn(temp), [], 'and nothing was left behind');
  });
}

// --- elsewhere: the permission bits -------------------------------------------------------------------------------------------------------------------

for (const { how, where, prepare } of WAYS) {
  test(`POSIX: the settings copy is 0600 in a folder that is 0700 and the current user's, whatever the umask, with the work folder made ${how} — read while pac runs, and gone afterwards`, { skip: WINDOWS && 'Windows has no permission bits to read: its access list is tested above' }, async (t) => {
    const base = folder();
    const temp = path.join(base, 'tmp');
    fs.mkdirSync(temp);
    // Before the umask below: the plugin's folder is made as it is made in a normal run.
    prepare(temp);
    const request = importRequest(base);
    let seen;
    const pac = {
      spawn: (name, args) => {
        const copy = args[args.indexOf('--settings-file') + 1];
        const file = fs.lstatSync(copy);
        const dir = fs.lstatSync(path.dirname(copy));
        seen = { copy, file: file.mode & 0o777, dir: dir.mode & 0o777, owner: [file.uid, dir.uid], isFile: file.isFile(), isDir: dir.isDirectory(), text: fs.readFileSync(copy, 'utf8') };
        return { status: 0, stdout: 'ok', stderr: '' };
      },
    };
    // A mask that would leave the folder 0500 and the file 0400, were the modes left to it. It is set only now, so that what the importer makes is made under it and what this test made above is not (a
    // folder of 0500 cannot be written into).
    const old = process.umask(0o277);
    t.after(() => process.umask(old));
    await importingWithTemp(t, temp, request, pac);
    assert.strictEqual(path.dirname(path.dirname(seen.copy)), where(temp), `the work folder was made ${how}`);
    assert.deepStrictEqual([seen.file, seen.dir], [0o600, 0o700]);
    assert.deepStrictEqual(seen.owner, [process.getuid(), process.getuid()]);
    assert.ok(seen.isFile && seen.isDir);
    assert.ok(seen.text.includes(SECRET), 'the copy was readable by its owner');
    assert.deepStrictEqual(workFoldersIn(temp), []);
  });
}

// --- however the process ends -----------------------------------------------------------------------------------------------------------------------

// Starts the real importer in a child process (helpers/interrupted-import-child.js) with a pac that never answers, and waits until the settings copy exists. `temp` is the child's own temporary folder.
async function importerWithCopy(t, ending) {
  const base = folder('snapshot-child-');
  const temp = path.join(base, 'tmp');
  fs.mkdirSync(temp);
  const request = importRequest(base);
  const child = fork(CHILD, [request.packagePath, request.settingsPath, ending], {
    env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  const exited = once(child, 'exit');
  // The channel closes after the messages sent through it have been delivered, so a child that ends right after it speaks is still heard: 'disconnect' with no message is a child that never got there.
  const ready = new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('disconnect', () => reject(new Error(`the child ended before the copy was made: ${stderr}`)));
  });
  t.after(async () => {
    // Whatever the test found, the child it started does not outlive it.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  });
  const message = await ready;
  assert.strictEqual(message.kind, 'copy-ready', JSON.stringify(message));
  // The folder the copy is in is the one the maker made for the run — read, with its owner record, by the child while pac "ran": a child that ends itself right after it speaks has removed the folder by now.
  assertMadeByTheMaker(path.dirname(message.copy), { temp, pid: message.pid, record: message.record });
  assert.ok(message.text.includes(SECRET), 'while pac runs the copy holds the value');
  return { child, exited, temp, copy: message.copy, pid: message.pid, stderr: () => stderr };
}

test('the settings copy is removed when the process ends by process.exit while pac runs — and the exit status is the one asked for', async (t) => {
  const run = await importerWithCopy(t, 'exit');
  const [code, signal] = await run.exited;
  assert.deepStrictEqual([code, signal], [3, null]);
  assert.strictEqual(fs.existsSync(run.copy), false, 'the copy is gone');
  assert.deepStrictEqual(workFoldersIn(run.temp), [], 'and so is its folder');
});

test('the settings copy is removed when an error nothing catches ends the process while pac runs — and the process still ends with a failure', async (t) => {
  const run = await importerWithCopy(t, 'throw');
  const [code] = await run.exited;
  assert.notStrictEqual(code, 0);
  assert.match(run.stderr(), /an error nothing catches/, 'the error is reported as it would have been');
  assert.strictEqual(fs.existsSync(run.copy), false);
  assert.deepStrictEqual(workFoldersIn(run.temp), []);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`the settings copy is removed when the process is sent ${signal} while pac runs — and the process then ends as ${signal} ends it, not by exiting`, { skip: WINDOWS && 'Windows has no signals to deliver: a signal sent to a process ends it at once, without running anything (the handlers are tested with a stand-in process in exit-cleanup.test.js)' }, async (t) => {
    const run = await importerWithCopy(t, 'wait');
    run.child.kill(signal);
    const [code, ended] = await run.exited;
    assert.deepStrictEqual([code, ended], [null, signal], 'ended by the signal');
    assert.strictEqual(fs.existsSync(run.copy), false, 'the copy is gone');
    assert.deepStrictEqual(workFoldersIn(run.temp), [], 'and so is its folder');
  });
}

// --- a run that is KILLED ----------------------------------------------------------------------------------------------------------------------------

// A process that is KILLED (SIGKILL, TerminateProcess, an agent's timeout) runs nothing, so the copy of the settings it was giving pac stays, in the folder the run made for it. That folder is the maker's
// (lib/temp-workspace.js): in the plugin's own folder, named for the run's pid, with an owner record, and LENT to pac — another process, which a kill of the run does not end on POSIX, and which no record names. So a later
// run's sweep keeps the folder while it is young, although the run that made it is gone for certain, and removes it, copy and all, once it is old. Here the importer is the real one, with its real folder (inWorkFolder) and a
// real private copy; the run is killed for real, and the sweep is the maker's own (sweepDeadWorkspaces), over the temp folder the run had.
test('a run that is KILLED while pac runs leaves its folder, copy and all, recorded and lent — a later run\'s sweep keeps it while it is young and removes it once it is old, and no value stays on disk', async (t) => {
  const run = await importerWithCopy(t, 'wait');
  const left = path.dirname(run.copy);
  run.child.kill('SIGKILL');
  await run.exited;
  assert.strictEqual(fs.readFileSync(run.copy, 'utf8').includes(SECRET), true, 'a killed run removes nothing: its copy is where it was, with the value in it');
  const record = assertMadeByTheMaker(left, { temp: run.temp, pid: run.pid });
  const deps = { os: { tmpdir: () => run.temp } };

  // The run is gone for certain — no process has its pid — and the folder is young, so the sweep keeps it: pac may still be working in it. (`kept` says the sweep looked at it, and judged.)
  const young = sweepDeadWorkspaces(deps);
  assert.deepStrictEqual([young.removed, young.failed, young.kept], [[], [], 1], 'the sweep looked at the folder, and kept it');
  assert.strictEqual(fs.existsSync(run.copy), true, 'the copy is where it was');
  assert.deepStrictEqual(ownerRecordOf(left), record, 'and the record is as the run wrote it: nothing was changed after the folder was made');

  // A week and a day on, nothing has written in the folder for longer than a lent folder is kept: the sweep removes it, and the copy with it.
  const old = sweepDeadWorkspaces({ ...deps, owner: { now: () => Date.now() + LENT_KEEP_MS + DAY } });
  assert.deepStrictEqual([old.removed.map(({ name }) => name), old.failed], [[path.basename(left)], []], 'the sweep removed the folder');
  assert.strictEqual(fs.existsSync(left), false, 'the folder is gone');
  assert.deepStrictEqual(filesUnder(run.temp), [], 'and no file of it is left in the temp folder: not the copy, not the record');
});

// --- Windows: Ctrl+C and Ctrl+Break, as the console sends them ----------------------------------------------------------------------------------------

// Windows has no signals to deliver, but a user's Ctrl+C reaches the importer all the same: as a console event, which Node turns into SIGINT (Ctrl+Break: SIGBREAK). So the real importer runs in a child with a console of
// its own (helpers/console-event.js — nothing is ever sent to the console of whoever runs the tests), with a pac that never answers, and is sent the real thing. The copy must be gone afterwards, AND the process must end
// as Windows ends one that a console event cancels — STATUS_CONTROL_C_EXIT, 0xC000013A, which is how whoever started it can tell a cancelled run from one that failed (status 1). The control of each event is a child that
// registers nothing of ours: how Windows ends a process that nothing handles, which the importer's must end as. A machine whose control does not end that way, or that cannot send the event at all, skips these tests
// with the reason — the answer every console test gives (helpers/console-event.js, `controlProblem`, which has the status written out: it is what the test says Windows does, not taken from the code under test).
// See: https://learn.microsoft.com/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55
const CONSOLE_EVENTS = [['CTRL_C', 'Ctrl+C'], ['CTRL_BREAK', 'Ctrl+Break']];
let consoleRuns;
function importersInConsoles() {
  if (!consoleRuns) {
    const base = folder('snapshot-console-');
    const scenarios = [];
    const controls = CONSOLE_EVENTS.map(([event]) => {
      const config = path.join(base, `${event}-control.json`);
      const ready = path.join(base, `${event}-control.ready`);
      fs.writeFileSync(config, JSON.stringify({ marker: path.join(base, `${event}-control.cleaned`), ending: 'wait', ready, plain: true }));
      scenarios.push({ event, script: EXIT_CLEANUP_CHILD, args: [config], ready });
      return event;
    });
    const importers = CONSOLE_EVENTS.map(([event]) => {
      const dir = path.join(base, event);
      const temp = path.join(dir, 'tmp');
      fs.mkdirSync(temp, { recursive: true });
      const request = importRequest(dir);
      const ready = path.join(dir, 'ready.json');
      scenarios.push({
        event,
        script: CHILD,
        args: [request.packagePath, request.settingsPath, 'wait', ready],
        ready,
        env: { TEMP: temp, TMP: temp, TMPDIR: temp, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' },
      });
      return { event, temp, ready };
    });
    consoleRuns = runInConsoles(scenarios).then((results) => ({
      controls: Object.fromEntries(controls.map((event, index) => [event, results[index]])),
      importers: importers.map((importer, index) => ({ ...importer, result: results[controls.length + index] })),
    }));
  }
  return consoleRuns;
}

for (const [event, key] of CONSOLE_EVENTS) {
  test(`the settings copy is removed when ${key} reaches the importer while pac runs — and the process ends with STATUS_CONTROL_C_EXIT, as one that ${key} cancels does, not with the status 1 of a failure`, { skip: !WINDOWS && 'console events are a Windows thing: POSIX has signals, tested above' }, async (t) => {
    const { controls, importers } = await importersInConsoles();
    const control = controls[event];
    // The answer every console test gives (helpers/console-event.js): a machine that cannot send the event, or whose control does not end as a cancelled process, skips with the reason; a defect fails.
    const problem = controlProblem(control, key);
    if (problem) {
      t.skip(problem);
      return;
    }
    const run = importers.find((importer) => importer.event === event);
    assert.deepStrictEqual([run.result.delivered, run.result.exited, run.result.error], [true, true, null], JSON.stringify(run.result));
    const message = JSON.parse(fs.readFileSync(run.ready, 'utf8'));
    assert.strictEqual(message.kind, 'copy-ready');
    assertMadeByTheMaker(path.dirname(message.copy), { temp: run.temp, pid: message.pid, record: message.record });
    assert.ok(message.text.includes(SECRET), 'while pac ran the copy held the value');
    assert.strictEqual(run.result.status, control.status, 'the status of a process that nothing handles — the cancellation — and not 1');
    assert.strictEqual(fs.existsSync(message.copy), false, 'the copy is gone');
    assert.deepStrictEqual(workFoldersIn(run.temp), [], 'and so is its folder');
  });
}
