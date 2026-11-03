'use strict';
// REAL BUNDLE and REAL PROCESSES: deployment settings, through the vendored SDK, the plugin's real az-token HttpClient (the long-action wrapper
// included) and a fake Dataverse that answers ExportSolution, StageSolution and ImportSolution in the shapes the SDK measured. What a stub cannot
// say: that the SDK still throws the codes this script falls back on, in the words it matches; that it still stages, deletes its staging copy and
// sends ComponentParameters as it did; that a transport failure on the import is not repeated. Below, the script runs in a child process with a fake
// `pac` alone on PATH (or none), and the run's every byte of output is searched for the secrets it was given.
// This file checks where lib/temp-workspace.js makes a workspace, so it works in a temp folder of its own (helpers/own-temp-folder.js): in the
// suite's shared one, other test processes make and remove the plugin's workspace folder. Required first, so every path below is inside it.
require('./helpers/own-temp-folder.js');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// The copy of the settings that pac is given is made the plain way here (helpers/plain-private-file.js: the real one asks Windows for an access list, half a second a copy); before the script is loaded.
const plainPrivateFile = require('./helpers/plain-private-file.js');
plainPrivateFile.install();
const ss = require('../solution-settings.js');
const { createCloud, LOCK_REFUSAL, CONCURRENCY_REFUSAL, ORG, DATAVERSE_TOKEN } = require('./helpers/fake-power-platform.js');
const { LOGS, jobRow, jobAnswer, REFUSAL_STATUS } = require('./helpers/import-job-logs.js');
const { runScript } = require('./helpers/run-with-fakes.js');
const { VALUES, spellingsOfValue } = require('./helpers/value-spellings.js');
const { WORK_FOLDER, RECORDED_WORK_FOLDER, PLAIN_WORK_FOLDER, entriesOf, pluginFolderOf, assertMadeByTheMaker, refusingWorkFolders } = require('./helpers/solution-settings-work-folder.js');

const SECRET = 'kv-secret-value-0123456789';
const CONNECTION_ID = 'shared-commondataser-00000000-0000-0000-0000-00000000abcd';
const CONNECTOR = '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps';
const JOB = '44444444-4444-4444-8444-444444444444';
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(' a solution package')]);
// What takes the place of a text that repeated a value of the settings file.
const WITHHELD = (what = 'text') => `<${what} withheld: it repeated a value from the settings file>`;

const tempDirs = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solution-settings-real-'));
  tempDirs.push(dir);
  return dir;
};
test.after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

// What StageSolution says the package holds.
const STAGE = {
  variables: [
    { schemaName: 'new_Url', defaultValue: 'https://default.example' },
    { schemaName: 'new_Secret', type: '100000005' },
  ],
  references: [{ logicalName: 'new_Dataverse', connectorId: CONNECTOR }],
};

function world(solution = {}, config = {}) {
  const cloud = createCloud({ solution: { packageBase64: ZIP.toString('base64'), stage: STAGE, ...solution }, ...config });
  const http = { getToken: () => cloud.tokens.dataverse, request: cloud.request, sleep: async () => {} };
  return { cloud, http };
}
const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const lines = (cloud) => cloud.requests.map((r) => `${r.method} ${r.path.replace(/^\/api\/data\/v9\.\d+\//, '')}`);

function files(extra = {}) {
  const dir = tempDir();
  const pkg = path.join(dir, 'solution.zip');
  fs.writeFileSync(pkg, ZIP);
  const settings = path.join(dir, 'filled.json');
  fs.writeFileSync(settings, JSON.stringify({
    EnvironmentVariables: [{ SchemaName: 'new_Secret', Value: SECRET }, { SchemaName: 'new_Url', Value: '' }],
    ConnectionReferences: [{ LogicalName: 'new_Dataverse', ConnectionId: CONNECTION_ID, ConnectorId: CONNECTOR }],
    ...extra,
  }, null, 2));
  return { dir, pkg, settings, out: path.join(dir, 'settings.json') };
}
const importRequest = (f) => ({ command: 'import', env: ORG, packagePath: f.pkg, settingsPath: f.settings });
const templateRequest = (f, extra) => ({ command: 'template', env: ORG, outPath: f.out, force: false, ...extra });
const never = { spawn: () => { throw new Error('pac must not be run'); } };

// --- template -----------------------------------------------------------------------------------------------------------------------

test('REAL BUNDLE: template --solution exports the solution unmanaged, stages the package for the template, deletes the staging copy, and writes pac\'s format sorted by name with empty values', async () => {
  const { cloud, http } = world();
  const f = files();
  const result = await ss.runTemplate(templateRequest(f, { solution: 'ContosoDemo' }), { http, pac: never });
  assert.deepStrictEqual(result, { source: 'sdk', out: f.out, environmentVariables: 2, connectionReferences: 1 });
  assert.deepStrictEqual(lines(cloud), [
    'POST ExportSolution',
    'POST StageSolution',
    'DELETE stagesolutionuploads(33333333-3333-4333-8333-333333333333)',
  ]);
  assert.deepStrictEqual(cloud.state.exports, [{ SolutionName: 'ContosoDemo', Managed: false }]);
  assert.deepStrictEqual(cloud.state.staged, [{ CustomizationFile: ZIP.toString('base64') }], 'what was exported is what was staged');
  assert.deepStrictEqual(cloud.state.deletedStaging, ['33333333-3333-4333-8333-333333333333']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f.out, 'utf8')), {
    EnvironmentVariables: [
      { SchemaName: 'new_Secret', Value: '', TypeId: 100000005, IsRequired: false },
      { SchemaName: 'new_Url', Value: '', DefaultValue: 'https://default.example', TypeId: 100000000, IsRequired: false },
    ],
    ConnectionReferences: [{ LogicalName: 'new_Dataverse', ConnectionId: '', ConnectorId: CONNECTOR }],
  });
  // Every request carried the Dataverse token and nothing else.
  assert.ok(cloud.requests.every((r) => r.authorization === `Bearer ${DATAVERSE_TOKEN}`));
});

test('REAL BUNDLE: template --package --env stages the zip as it is on disk and exports nothing', async () => {
  const { cloud, http } = world();
  const f = files();
  await ss.runTemplate(templateRequest(f, { packagePath: f.pkg }), { http, pac: never });
  assert.deepStrictEqual(lines(cloud), ['POST StageSolution', 'DELETE stagesolutionuploads(33333333-3333-4333-8333-333333333333)']);
  assert.deepStrictEqual(cloud.state.staged, [{ CustomizationFile: ZIP.toString('base64') }]);
});

test('REAL BUNDLE: a staging the platform fails is SOLUTION_STAGING_FAILED — pac reads the zip the SDK exported, and the SDK has still deleted its staging copy', async () => {
  const { cloud, http } = world({ stage: { status: 'Failed', missingDependencies: [{ Message: 'The component x depends on y' }] } });
  const f = files();
  let pacZip;
  const spawn = (name, args) => {
    pacZip = fs.readFileSync(args[args.indexOf('--solution-zip') + 1]);
    fs.writeFileSync(args[args.indexOf('--settings-file') + 1], JSON.stringify({ EnvironmentVariables: [], ConnectionReferences: [], CopilotAgents: [] }));
    return { status: 0, stdout: 'Deployment settings file created.', stderr: '' };
  };
  const result = await ss.runTemplate(templateRequest(f, { solution: 'ContosoDemo' }), { http, pac: { spawn } });
  assert.strictEqual(result.source, 'pac');
  assert.strictEqual(result.fallback.code, 'SOLUTION_STAGING_FAILED');
  assert.match(result.fallback.message, /did not pass StageSolution in this environment[\s\S]*The component x depends on y/);
  assert.deepStrictEqual(pacZip, ZIP, 'pac was given the exported bytes');
  assert.deepStrictEqual(cloud.state.deletedStaging, ['33333333-3333-4333-8333-333333333333']);
  assert.strictEqual(fs.existsSync(f.out), true);
});

test('REAL BUNDLE: a staging reply the SDK cannot read with certainty is SOLUTION_STAGING_UNREADABLE — a template that missed an entry would be silently wrong, so pac is asked', async () => {
  const unreadable = [
    ['no results', json(200, {})],
    ['an unknown status', json(200, { StageSolutionResults: { StageSolutionStatus: 'Odd', SolutionComponentsDetails: [] } })],
    ['components that are not a list', json(200, { StageSolutionResults: { StageSolutionStatus: 'Passed', SolutionComponentsDetails: 'x' } })],
    ['attributes of another shape', json(200, { StageSolutionResults: { StageSolutionStatus: 'Passed', SolutionComponentsDetails: [{ ComponentTypeName: 'EnvironmentVariableDefinition', Attributes: [] }] } })],
  ];
  for (const [what, answer] of unreadable) {
    const { http } = world({ stage: { answer } });
    const f = files();
    const spawn = (name, args) => { fs.writeFileSync(args[args.indexOf('--settings-file') + 1], JSON.stringify({ EnvironmentVariables: [] })); return { status: 0, stdout: '', stderr: '' }; };
    const result = await ss.runTemplate(templateRequest(f, { solution: 'Demo' }), { http, pac: { spawn } });
    assert.strictEqual(result.source, 'pac', what);
    assert.strictEqual(result.fallback.code, 'SOLUTION_STAGING_UNREADABLE', what);
  }
});

test('REAL BUNDLE: an export that fails is a failure — the platform\'s words, CONNECTION_ERROR — pac is not asked and --out is not written', async () => {
  const { http } = world({ exportAnswer: json(400, { error: { message: 'Solution with unique name ContosoDemo was not found.' } }) });
  const f = files();
  await assert.rejects(ss.runTemplate(templateRequest(f, { solution: 'ContosoDemo' }), { http, pac: never }), (err) => {
    assert.strictEqual(err.code, 'CONNECTION_ERROR');
    assert.match(err.message, /HTTP 400[\s\S]*was not found/);
    return true;
  });
  assert.strictEqual(fs.existsSync(f.out), false);
});

test('REAL BUNDLE: a staging copy that cannot be deleted is a warning on the output — the SDK says what is left behind', async () => {
  const { http } = world({ deleteStagingAnswer: json(500, { error: { message: 'delete failed' } }) });
  const f = files();
  const result = await ss.runTemplate(templateRequest(f, { solution: 'Demo' }), { http, pac: never });
  assert.strictEqual(result.warnings.length, 1);
  assert.match(result.warnings[0], /stagesolutionupload 33333333-3333-4333-8333-333333333333\) could not be deleted/);
});

// --- the folder a pac fallback works in ----------------------------------------------------------------------------------------------------
// A template that pac makes is written into a folder of the run's own, which holds the package the SDK exported and pac's template — whose defaults can be values. The folder is made by lib/temp-workspace.js, in the
// plugin's own folder of the temp directory (`solution-settings-<pid>-<random>`, with the owner record `.owner.json` a later run's sweep reads) or, where that cannot be used, in the temp directory itself
// (`solution-settings-<random>`): the tests find a work folder by either name (helpers/solution-settings-work-folder.js). It is removed however the run ends, with the bounded retry a Windows lock needs; a folder that
// stays is SAID, with its path, on the output of a run that succeeded and beside the failure of one that did not, and its files are EMPTIED first, so that what stays holds no value. The owner record is not one of
// those files: it is the plugin's own — the process that made the folder, the host, the time, and that the folder was lent to pac — and holds no value, so the lists below leave it out (`entriesOf`) and one test reads it.
// Holds the work folders as a scanner does: every removal of one answers `code` for its first `times` calls (all of them when Infinity), and what is left is removed when the test ends. `dirs` are the
// folders the script tried to remove. The test's own folders (`solution-settings-real-…`) have a longer name and are never held.
function holdingWorkFolders(t, { times = Infinity, code = 'EBUSY', platform } = {}) {
  const realRemove = fs.rmSync;
  const state = { dirs: new Set(), calls: 0 };
  fs.rmSync = (target, options) => {
    if (WORK_FOLDER.test(path.basename(String(target)))) {
      state.dirs.add(String(target));
      state.calls += 1;
      if (state.calls <= times) throw Object.assign(new Error(`${code}: resource busy or locked, rmdir '${target}'`), { code });
    }
    return realRemove(target, options);
  };
  const host = platform && Object.getOwnPropertyDescriptor(process, 'platform');
  if (platform) Object.defineProperty(process, 'platform', { ...host, value: platform });
  t.after(() => {
    fs.rmSync = realRemove;
    if (platform) Object.defineProperty(process, 'platform', host);
    for (const dir of state.dirs) realRemove(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  return state;
}
const pacWritesTemplate = (status = 0) => ({
  spawn: (name, args) => {
    fs.writeFileSync(args[args.indexOf('--settings-file') + 1], JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'new_Url', Value: '', DefaultValue: 'https://config.contoso.example' }], ConnectionReferences: [] }));
    return { status, stdout: status === 0 ? 'Template created' : '', stderr: status === 0 ? '' : 'Error: pac refused the package' };
  },
});
const MISSING_BASE = { stage: { status: 'Failed', missingDependencies: [{ Message: 'Missing base solution' }] } };

test('REAL BUNDLE: a pac template folder that cannot be removed is said — its path, and what is in it — as a warning on a run that succeeded; the template at --out is complete', async (t) => {
  const held = holdingWorkFolders(t);
  const { http } = world(MISSING_BASE);
  const f = files();
  const result = await ss.runTemplate(templateRequest(f, { solution: 'ContosoDemo' }), { http, pac: pacWritesTemplate() });
  assert.strictEqual(result.source, 'pac');
  assert.strictEqual(held.dirs.size, 1);
  const [left] = held.dirs;
  assert.deepStrictEqual(entriesOf(left), ['settings.json', 'solution.zip'], 'the exported package and pac\'s template are what stayed');
  assert.deepStrictEqual(entriesOf(left).map((name) => fs.readFileSync(path.join(left, name), 'utf8')), ['', ''], 'both are EMPTIED: what a template\'s defaults and a package\'s definitions hold is not left on disk');
  // What stays is where a later run's sweep looks for the folder of a run that is gone: the plugin's own folder, under this process's pid, recorded and lent. Its record holds none of the template's values.
  assert.ok(!JSON.stringify(assertMadeByTheMaker(left, { pid: process.pid })).includes('config.contoso.example'), 'the owner record is the maker\'s, with no value of the run');
  assert.deepStrictEqual(result.warnings, [`The folder ${left} could not be removed (EBUSY); it holds the solution package this run exported and the settings template pac wrote (emptied, so it keeps no value). Delete it.`]);
  assert.strictEqual(JSON.parse(fs.readFileSync(f.out, 'utf8')).EnvironmentVariables[0].SchemaName, 'new_Url');
});

test('REAL BUNDLE: and beside the failure of a run that did not — pac refuses — whose folder stayed: the failure keeps its code and its reason, and carries the folder as a warning', async (t) => {
  const held = holdingWorkFolders(t);
  const { http } = world(MISSING_BASE);
  const f = files();
  const { readCleanupWarnings } = require('../lib/maker-sdk.js');
  await assert.rejects(ss.runTemplate(templateRequest(f, { solution: 'ContosoDemo' }), { http, pac: pacWritesTemplate(1) }), (err) => {
    const [left] = held.dirs;
    assert.strictEqual(err.code, 'PAC_FAILED');
    assert.strictEqual(err.fallback.code, 'SOLUTION_STAGING_FAILED');
    const described = ss.describeFailure(err, readCleanupWarnings);
    assert.deepStrictEqual(entriesOf(left).map((name) => fs.readFileSync(path.join(left, name), 'utf8')), ['', ''], 'a template that pac wrote before it failed is emptied too');
    assert.deepStrictEqual(described.warnings, [`The folder ${left} could not be removed (EBUSY); it holds the solution package this run exported and the settings template pac wrote (emptied, so it keeps no value). Delete it.`]);
    assert.match(described.error, /pac refused the package/);
    return true;
  });
  assert.strictEqual(fs.existsSync(f.out), false, '--out is not written');
});

test('REAL BUNDLE: a folder held for a moment is removed by the bounded retry on Windows — no warning, nothing left — and the ordinary run, whose folder is not held, leaves nothing either', async (t) => {
  const held = holdingWorkFolders(t, { times: 2, platform: 'win32' });
  const { http } = world(MISSING_BASE);
  const f = files();
  const result = await ss.runTemplate(templateRequest(f, { solution: 'ContosoDemo' }), { http, pac: pacWritesTemplate() });
  assert.strictEqual(held.calls, 3, 'the removal was tried again, twice');
  assert.ok(!('warnings' in result), 'and said nothing, because nothing is left');
  assert.strictEqual(fs.existsSync([...held.dirs][0]), false);
  // The ordinary run, after the hold has let go: one removal, no warning.
  const g = files();
  const again = await ss.runTemplate(templateRequest(g, { solution: 'ContosoDemo' }), { http: world(MISSING_BASE).http, pac: pacWritesTemplate() });
  assert.ok(!('warnings' in again));
  assert.strictEqual(held.calls, 4);
  assert.deepStrictEqual([...held.dirs].map((dir) => fs.existsSync(dir)), [false, false]);
});

test('REAL BUNDLE: without --env the zip is read by pac alone, and its folder is said the same way — it holds pac\'s template and no package', async (t) => {
  const held = holdingWorkFolders(t);
  const f = files();
  const result = await ss.runTemplate(templateRequest(f, { env: undefined, packagePath: f.pkg }), { pac: pacWritesTemplate() });
  assert.strictEqual(result.source, 'pac');
  const [left] = held.dirs;
  assert.deepStrictEqual(entriesOf(left), ['settings.json']);
  assert.strictEqual(fs.readFileSync(path.join(left, 'settings.json'), 'utf8'), '', 'pac\'s template is emptied');
  assert.deepStrictEqual(result.warnings, [`The folder ${left} could not be removed (EBUSY); it holds the settings template pac wrote (emptied, so it keeps no value). Delete it.`]);
});

test('REAL BUNDLE: a template folder whose files cannot be emptied either says so — the package and the template may still hold values — and the run reports what it reported', async (t) => {
  const stays = holdingWorkFolders(t);
  const realWrite = fs.writeFileSync;
  let blocked = 0;
  fs.writeFileSync = (file, data, options) => {
    // What the run writes is allowed; emptying a file of the work folder afterwards (a write of nothing) is what a scanner holding the file blocks.
    if (WORK_FOLDER.test(path.basename(path.dirname(String(file)))) && data === '') {
      blocked += 1;
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    return realWrite(file, data, options);
  };
  t.after(() => { fs.writeFileSync = realWrite; });
  const { http } = world(MISSING_BASE);
  const f = files();
  const result = await ss.runTemplate(templateRequest(f, { solution: 'ContosoDemo' }), { http, pac: pacWritesTemplate() });
  const [left] = stays.dirs;
  assert.strictEqual(result.source, 'pac');
  assert.strictEqual(blocked, 2, 'both files were tried');
  assert.deepStrictEqual(result.warnings, [`The folder ${left} could not be removed (EBUSY); it holds the solution package this run exported and the settings template pac wrote (it could not be emptied either, so it may still hold values). Delete it.`]);
  assert.strictEqual(JSON.parse(fs.readFileSync(f.out, 'utf8')).EnvironmentVariables[0].SchemaName, 'new_Url', 'the template at --out is complete');
});

// --- what the SDK could not clean up survives the pac fallback ---------------------------------------------------------------------------------
// The SDK stages a package to read it and deletes the staging copy; a copy it cannot delete is a WARNING it carries on the error it raises, with the upload id, so the maker can delete it. When the SDK then refuses
// (a staging reply it cannot read) and pac does the work, that error is thrown away — and with it the warning. It is carried across the fallback (lib/sdk-first.js) and reaches the output of the run, whether pac
// succeeded or failed; a pac run that succeeded is still a success.
const STAGING_UPLOAD = '33333333-3333-4333-8333-333333333333';
// A variable the reply lists twice: the SDK will not guess which definition is meant, and refuses (SOLUTION_STAGING_UNREADABLE).
const UNREADABLE_STAGE = { variables: [{ schemaName: 'new_Mode' }, { schemaName: 'new_Mode' }] };
const stagingCopyStays = (message = 'Not permitted to delete staging copy') => json(403, { error: { message } });
const settledAs = (promise) => promise.then((result) => ({ result }), (error) => ({ error }));

for (const command of ['template', 'import']) {
  for (const pacFails of [false, true]) {
    test(`REAL BUNDLE: ${command} keeps the SDK's cleanup warning when the staging falls back to pac — pac ${pacFails ? 'fails' : 'succeeds'} — and a successful pac run is still a success`, async () => {
      const { cloud, http } = world({ stage: UNREADABLE_STAGE, deleteStagingAnswer: stagingCopyStays() });
      const f = files({ EnvironmentVariables: [{ SchemaName: 'new_Mode', Value: 'enabled' }], ConnectionReferences: [] });
      const spawn = (name, args) => {
        if (pacFails) return { status: 1, stdout: '', stderr: 'Error: pac refused the package' };
        if (command === 'template') fs.writeFileSync(args[args.indexOf('--settings-file') + 1], JSON.stringify({ EnvironmentVariables: [], ConnectionReferences: [] }));
        return { status: 0, stdout: 'Completed', stderr: '' };
      };
      const deps = { http, pac: { spawn } };
      const outcome = await settledAs(command === 'template' ? ss.runTemplate(templateRequest(f, { packagePath: f.pkg }), deps) : ss.runImport(importRequest(f), deps));
      assert.strictEqual(Boolean(outcome.error), pacFails, 'a pac run that succeeded is a success, and one that failed a failure');
      const shown = outcome.result || ss.describeFailure(outcome.error, require('../lib/maker-sdk.js').readCleanupWarnings);
      assert.strictEqual(shown.fallback.code, 'SOLUTION_STAGING_UNREADABLE', 'pac was asked because the SDK refused');
      assert.strictEqual(shown.warnings.length, 1, JSON.stringify(shown));
      assert.match(shown.warnings[0], new RegExp(`The staged copy of the package \\(stagesolutionupload ${STAGING_UPLOAD}\\) could not be deleted: HTTP 403 .*Not permitted to delete staging copy`));
      assert.strictEqual(cloud.state.imports.length, 0, 'the SDK imported nothing before pac was asked');
      assert.deepStrictEqual(cloud.state.deletedStaging, [STAGING_UPLOAD], 'it did try to delete its staging copy');
    });
  }
}

test('REAL BUNDLE: the warning that survives the fallback is sanitized once, like the one of a run that did not fall back — a value the platform quoted in it is withheld, whether pac succeeded or failed', async () => {
  for (const pacFails of [false, true]) {
    const { http } = world({
      stage: { variables: [{ schemaName: 'new_Secret', type: '100000005' }, { schemaName: 'new_Secret', type: '100000005' }] },
      deleteStagingAnswer: stagingCopyStays(`denied for ${SECRET} and ${CONNECTION_ID}`),
    });
    const f = files();
    const spawn = () => (pacFails ? { status: 1, stdout: '', stderr: 'Error: refused' } : { status: 0, stdout: 'ok', stderr: '' });
    const outcome = await settledAs(ss.runImport(importRequest(f), { http, pac: { spawn } }));
    const shown = outcome.result || ss.describeFailure(outcome.error, require('../lib/maker-sdk.js').readCleanupWarnings);
    assert.deepStrictEqual(shown.warnings, [WITHHELD('warning')], `pac ${pacFails ? 'failed' : 'succeeded'}`);
    assert.ok(!JSON.stringify(shown).includes(SECRET) && !JSON.stringify(shown).includes(CONNECTION_ID), JSON.stringify(shown));
  }
});

// --- import -------------------------------------------------------------------------------------------------------------------------

test('REAL BUNDLE: import stages the package to check every filled entry against it, deletes the staging copy, and sends ComponentParameters in the import itself — with pac\'s defaults', async () => {
  const { cloud, http } = world();
  const f = files();
  const result = await ss.runImport(importRequest(f), { http, pac: never, importJobId: JOB });
  assert.deepStrictEqual(result, { source: 'sdk', importJobId: JOB, applied: { environmentVariables: ['new_Secret'], connectionReferences: ['new_Dataverse'] } });
  assert.deepStrictEqual(lines(cloud), ['POST StageSolution', 'DELETE stagesolutionuploads(33333333-3333-4333-8333-333333333333)', 'POST ImportSolution']);
  assert.deepStrictEqual(cloud.state.imports, [{
    OverwriteUnmanagedCustomizations: false,
    PublishWorkflows: false,
    CustomizationFile: ZIP.toString('base64'),
    ImportJobId: JOB,
    ComponentParameters: [
      { '@odata.type': 'Microsoft.Dynamics.CRM.environmentvariablevalue', schemaname: 'new_Secret', value: SECRET },
      { '@odata.type': 'Microsoft.Dynamics.CRM.connectionreference', connectionreferencelogicalname: 'new_Dataverse', connectionid: CONNECTION_ID, connectorid: CONNECTOR },
    ],
  }]);
  assert.ok(!JSON.stringify(result).includes(SECRET) && !JSON.stringify(result).includes(CONNECTION_ID), 'the output names entries, never values');
});

test('REAL BUNDLE: an entry is applied under the PACKAGE\'s spelling of its name, whatever case the file used', async () => {
  const { http } = world();
  const f = files({ EnvironmentVariables: [{ SchemaName: 'NEW_SECRET', Value: SECRET }] });
  const result = await ss.runImport(importRequest(f), { http, pac: never, importJobId: JOB });
  assert.deepStrictEqual(result.applied.environmentVariables, ['new_Secret']);
});

test('REAL BUNDLE: a file that fills nothing in is a plain import — no staging, no ComponentParameters', async () => {
  const { cloud, http } = world();
  const f = files({ EnvironmentVariables: [{ SchemaName: 'new_Url', Value: '' }], ConnectionReferences: [{ LogicalName: 'new_Dataverse', ConnectionId: '' }] });
  const result = await ss.runImport(importRequest(f), { http, pac: never, importJobId: JOB });
  assert.deepStrictEqual(lines(cloud), ['POST ImportSolution']);
  assert.ok(!('ComponentParameters' in cloud.state.imports[0]));
  assert.deepStrictEqual(result.applied, { environmentVariables: [], connectionReferences: [] });
});

test('REAL BUNDLE: an entry that is not in the package, or names another connector, fails the whole import before anything is imported — naming entries, never values', async () => {
  const cases = [
    [{ EnvironmentVariables: [{ SchemaName: 'new_Missing', Value: SECRET }] }, /'new_Missing' is not a variable of the package/],
    [{ ConnectionReferences: [{ LogicalName: 'new_Nope', ConnectionId: CONNECTION_ID }] }, /'new_Nope' is not a connection reference of the package/],
    [{ ConnectionReferences: [{ LogicalName: 'new_Dataverse', ConnectionId: CONNECTION_ID, ConnectorId: '/providers/Microsoft.PowerApps/apis/shared_sql' }] }, /names connector '\/providers\/Microsoft\.PowerApps\/apis\/shared_sql'/],
  ];
  for (const [settings, message] of cases) {
    const { cloud, http } = world();
    const f = files({ EnvironmentVariables: undefined, ConnectionReferences: undefined, ...settings });
    await assert.rejects(ss.runImport(importRequest(f), { http, pac: never, importJobId: JOB }), (err) => {
      assert.strictEqual(err.code, 'INVALID_ARGUMENT');
      assert.match(err.message, message);
      assert.match(err.message, /Nothing was imported/);
      assert.ok(!err.message.includes(SECRET) && !err.message.includes(CONNECTION_ID), err.message);
      assert.strictEqual(err.importJobId, JOB);
      return true;
    });
    assert.ok(!lines(cloud).includes('POST ImportSolution'), 'nothing was imported');
    assert.deepStrictEqual(cloud.state.deletedStaging, ['33333333-3333-4333-8333-333333333333'], 'the staging copy is deleted although the check refused');
  }
});

test('REAL BUNDLE: the SDK\'s refusal of a pac-only settings feature still reads as the words this script falls back on — Workflows, CanvasApps, CopilotAgents, ConnectionInstance — and nothing was sent', async () => {
  const features = [
    { Workflows: [{ WorkflowId: '1' }] },
    { CanvasApps: [{ Name: 'x' }] },
    { CopilotAgents: [{ Name: 'x' }] },
    { ConnectionReferences: [{ LogicalName: 'new_Dataverse', ConnectionId: CONNECTION_ID, ConnectionInstance: { x: 1 } }] },
  ];
  for (const feature of features) {
    const { cloud, http } = world();
    const f = files(feature);
    const pacCalls = [];
    const spawn = (name, args) => { pacCalls.push(args); return { status: 0, stdout: 'Solution Imported successfully.', stderr: '' }; };
    const result = await ss.runImport(importRequest(f), { http, pac: { spawn }, importJobId: JOB });
    assert.strictEqual(result.source, 'pac', JSON.stringify(feature));
    assert.strictEqual(result.fallback.code, 'INVALID_ARGUMENT');
    assert.match(result.fallback.message, /this SDK does not apply/);
    // The sentence the SDK threw is exactly the one this script builds from the file's own content: that equality is what sends the file to pac, so a re-vendored
    // SDK that rewords it — or that stops refusing the feature — fails here instead of silently ending the fallback.
    assert.ok(ss.pacOnlyFeatureMessages(JSON.parse(fs.readFileSync(f.settings, 'utf8'))).includes(result.fallback.message), `${JSON.stringify(feature)}: ${result.fallback.message}`);
    assert.deepStrictEqual(cloud.requests, [], 'the file is checked before any request: nothing was staged, nothing imported');
    assert.deepStrictEqual(pacCalls.map((args) => args.slice(0, 7)), [['solution', 'import', '--path', f.pkg, '--environment', ORG, '--settings-file']]);
    assert.ok(pacCalls[0][7] !== f.settings && /^settings\.json$/.test(path.basename(pacCalls[0][7])), 'pac is given a copy of the settings the run read, not the maker\'s file');
  }
});

test('REAL BUNDLE: a settings key the SDK does not know is NOT a feature pac has: the import fails and pac is not asked — even when the key says "this SDK does not apply"', async () => {
  for (const key of ['Mystery', 'this SDK does not apply']) {
    const { cloud, http } = world();
    const f = files({ [key]: [] });
    await assert.rejects(ss.runImport(importRequest(f), { http, pac: never, importJobId: JOB }), (err) => err.code === 'INVALID_ARGUMENT' && /is not part of the format/.test(err.message) && !('fallback' in err), key);
    assert.deepStrictEqual(cloud.requests, []);
  }
});

test('REAL BUNDLE: a package that does not pass staging is NOT retried by pac — SOLUTION_STAGING_FAILED with the missing dependencies, nothing imported', async () => {
  const { cloud, http } = world({ stage: { status: 'Failed', missingDependencies: [{ Message: 'needs the Contoso base solution' }] } });
  const f = files();
  await assert.rejects(ss.runImport(importRequest(f), { http, pac: never, importJobId: JOB }), (err) => {
    assert.strictEqual(err.code, 'SOLUTION_STAGING_FAILED');
    assert.match(err.message, /needs the Contoso base solution/);
    return true;
  });
  assert.ok(!lines(cloud).includes('POST ImportSolution'));
});

test('REAL BUNDLE: a staging reply the SDK cannot read sends the import to pac, with the settings file as it is', async () => {
  const { http } = world({ stage: { answer: json(200, { StageSolutionResults: { StageSolutionStatus: 'Odd' } }) } });
  const f = files();
  const calls = [];
  const result = await ss.runImport(importRequest(f), { http, pac: { spawn: (name, args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; } }, importJobId: JOB });
  assert.strictEqual(result.source, 'pac');
  assert.strictEqual(result.fallback.code, 'SOLUTION_STAGING_UNREADABLE');
  assert.strictEqual(calls.length, 1);
});

test('REAL BUNDLE: a platform error that quotes a secret or a connection id reaches no message — a secret withholds the words, a connection id or a Text value alone is replaced — and the job is named for a lookup', async () => {
  const { http } = world({ importAnswer: json(400, { error: { message: `The connection ${CONNECTION_ID} is invalid for new_Dataverse; the value ${SECRET} is not accepted.` } }) });
  const f = files();
  // The file gives new_Secret no TypeId: it is the package's own definition — what StageSolution's reply says it is — that makes it a secret.
  await assert.rejects(ss.runImport(importRequest(f), { http, pac: never, importJobId: JOB }), (err) => {
    assert.strictEqual(err.code, 'CONNECTION_ERROR');
    assert.ok(!err.message.includes(SECRET) && !err.message.includes(CONNECTION_ID), err.message);
    assert.strictEqual(err.message, `HTTP 400 from ${ORG}/api/data/v9.0/ImportSolution: ${WITHHELD('message')}`);
    assert.strictEqual(err.importJobId, JOB);
    return true;
  });
  // The connection id alone: replaced, and the platform's other words kept.
  const idOnly = world({ importAnswer: json(400, { error: { message: `The connection ${CONNECTION_ID} is invalid for new_Dataverse.` } }) });
  await assert.rejects(ss.runImport(importRequest(files()), { http: idOnly.http, pac: never, importJobId: JOB }), (err) => {
    assert.strictEqual(err.message, `HTTP 400 from ${ORG}/api/data/v9.0/ImportSolution: The connection <redacted> is invalid for new_Dataverse.`);
    return true;
  });
  // A connection id the platform quotes in another case (a GUID is normalised): replaced all the same.
  const upper = world({ importAnswer: json(400, { error: { message: `The connection ${CONNECTION_ID.toUpperCase()} is invalid.` } }) });
  await assert.rejects(ss.runImport(importRequest(files()), { http: upper.http, pac: never, importJobId: JOB }), (err) => {
    assert.strictEqual(err.message, `HTTP 400 from ${ORG}/api/data/v9.0/ImportSolution: The connection <redacted> is invalid.`);
    return true;
  });
  // A variable the package says is Text: its value is replaced where the platform quotes it.
  const text = world({ importAnswer: json(400, { error: { message: 'The address https://plain.example/value is not reachable.' } }) });
  const withText = files({ EnvironmentVariables: [{ SchemaName: 'new_Url', Value: 'https://plain.example/value' }] });
  await assert.rejects(ss.runImport(importRequest(withText), { http: text.http, pac: never, importJobId: JOB }), (err) => {
    assert.strictEqual(err.message, `HTTP 400 from ${ORG}/api/data/v9.0/ImportSolution: The address <redacted> is not reachable.`);
    return true;
  });
});

test('REAL BUNDLE: an import that gets no answer is never sent again — one request, an error that names the job — and so is a staging', async () => {
  for (const [action, solution, run] of [
    ['ImportSolution', {}, (http, f) => ss.runImport(importRequest(f), { http, pac: never, importJobId: JOB })],
    ['StageSolution', {}, (http, f) => ss.runTemplate(templateRequest(f, { packagePath: f.pkg }), { http, pac: never })],
  ]) {
    const cloud = createCloud({ solution: { packageBase64: ZIP.toString('base64'), stage: STAGE, ...solution } });
    let hits = 0;
    const request = async (options) => {
      if (new URL(options.url).pathname.endsWith(`/${action}`)) {
        hits += 1;
        return { error: 'Request timed out' };
      }
      return cloud.request(options);
    };
    const f = files();
    // An import with entries stages first; the staging answers, the import does not.
    await assert.rejects(run({ getToken: () => cloud.tokens.dataverse, request, sleep: async () => {} }, f), (err) => {
      assert.match(err.message, new RegExp(`${action} got no answer \\(Request timed out\\)\\. It was not sent again`), err.message);
      if (action === 'ImportSolution') assert.match(err.message, new RegExp(`import job ${JOB}`));
      return true;
    }, action);
    assert.strictEqual(hits, 1, `${action}: one request, not the six the plain client makes for a POST nobody answered`);
  }
});

test('REAL BUNDLE: the sentence the plugin writes for a request that got no answer is its own — shown whole whatever short value the file fills in, which can be a word of it — while the transport\'s own words in it are cleaned where they are read', async () => {
  const noAnswer = (action, entries, transport) => {
    const cloud = createCloud({ solution: { packageBase64: ZIP.toString('base64'), stage: STAGE } });
    const request = async (options) => (new URL(options.url).pathname.endsWith(`/${action}`) ? { error: transport } : cloud.request(options));
    const f = files({ EnvironmentVariables: entries, ConnectionReferences: [] });
    const http = { getToken: () => cloud.tokens.dataverse, request, sleep: async () => {} };
    return ss.runImport(importRequest(f), { http, pac: never, importJobId: JOB }).then(() => assert.fail(`${action}: the import was expected to fail`), (err) => err);
  };
  const tail = 'It was not sent again: the environment may still be working on it, or may have finished.';
  const lead = (action) => `Transport failure reaching ${ORG}/api/data/v9.0/${action}: `;
  // A staging that gets no answer: no definition has been read yet, so a short value's type is not known and it is looked for as a whole word — and the plugin's own sentence is made of words.
  // The SDK writes the status line and the client's own message, and keeps the client's error as its cause, which is how the plugin knows the sentence is its own.
  for (const value of ['not', 'may', 'again', 'it', 'on']) {
    const err = await noAnswer('StageSolution', [{ SchemaName: 'new_Url', Value: value }], 'Request timed out');
    assert.strictEqual(err.message, `${lead('StageSolution')}StageSolution got no answer (Request timed out). ${tail}`, value);
    assert.strictEqual(err.code, 'CONNECTION_ERROR', value);
  }
  // An import: the sentence names the job, as before.
  const imported = await noAnswer('ImportSolution', [{ SchemaName: 'new_Url', Value: 'again' }], 'Request timed out');
  assert.strictEqual(imported.message, `${lead('ImportSolution')}ImportSolution got no answer (Request timed out). ${tail}${ss.lookUpJob(JOB)}`);
  // The transport's own words are another party's text: a value they quote is withheld there — a secret at any length, a short value of unknown type as a whole word — and the sentence around them stays.
  const secret = await noAnswer('ImportSolution', [{ SchemaName: 'new_Secret', Value: SECRET }], `connection reset while sending ${SECRET}`);
  assert.strictEqual(secret.message, `${lead('ImportSolution')}ImportSolution got no answer (${WITHHELD('transport text')}). ${tail}${ss.lookUpJob(JOB)}`);
  assert.ok(!secret.message.includes(SECRET));
  const short = await noAnswer('StageSolution', [{ SchemaName: 'new_Url', Value: 'timed' }], 'Request timed out');
  assert.strictEqual(short.message, `${lead('StageSolution')}StageSolution got no answer (${WITHHELD('transport text')}). ${tail}`);
});

test('REAL BUNDLE: an import that the platform ACCEPTED and a gateway answered 5xx (or 401) is not sent a second time — one ImportSolution, the SDK\'s ConnectionError with that status, then the job named', async () => {
  for (const status of [500, 502, 503, 504, 401]) {
    const cloud = createCloud({ solution: { packageBase64: ZIP.toString('base64'), stage: STAGE } });
    // The platform accepts the first ImportSolution (it is recorded), and a gateway answers it as it does for work still in progress; a second send would be answered 204.
    const request = async (options) => {
      const answer = await cloud.request(options);
      return new URL(options.url).pathname.endsWith('/ImportSolution') && cloud.state.imports.length === 1 ? json(status, { error: { code: '0x80048d19', message: `answered ${status}` } }) : answer;
    };
    const tokenReads = [];
    const f = files();
    await assert.rejects(ss.runImport(importRequest(f), { http: { getToken: (env, options) => { tokenReads.push(options); return cloud.tokens.dataverse; }, request, sleep: async () => {} }, pac: never, importJobId: JOB }), (err) => {
      assert.strictEqual(err.code, 'CONNECTION_ERROR');
      assert.strictEqual(err.statusCode, status);
      assert.match(err.message, new RegExp(`^HTTP ${status} from .*/ImportSolution: answered ${status} The request was sent once and was not sent again`));
      assert.strictEqual(err.importJobId, JOB);
      return true;
    }, String(status));
    assert.strictEqual(cloud.state.imports.length, 1, `${status}: one ImportSolution, accepted once`);
    assert.strictEqual(tokenReads.filter((options) => options && options.fresh).length, 0, `${status}: no token refresh for a second send`);
  }
});

test('REAL BUNDLE: a failed import reads its job\'s log once through the same client, and the platform\'s own reason is in the message', async () => {
  const log = '<importexportxml succeeded="failure" status="Import failed"><entity><result result="failure" errortext="Could not find connection \'x\' for API \'shared_sql\'"/></entity></importexportxml>';
  const { cloud, http } = world({ importAnswer: json(400, { error: { message: 'An unexpected error occurred.' } }), jobLog: log });
  const f = files();
  await assert.rejects(ss.runImport(importRequest(f), { http, pac: never, importJobId: JOB }), (err) => {
    assert.match(err.message, /An unexpected error occurred\. The import job's log \(importjobs\(44444444-4444-4444-8444-444444444444\)\) says: Could not find connection 'x' for API 'shared_sql'$/);
    return true;
  });
  assert.deepStrictEqual(cloud.state.jobReads, [JOB]);
  const reads = cloud.requests.filter((r) => r.path.includes('/importjobs('));
  assert.deepStrictEqual(reads.map((r) => [r.method, r.search]), [['GET', '?$select=data']]);
});

// --- an import the platform refused before it started ---------------------------------------------------------------------------------------------
// The platform refuses to START an import while another operation (a publish, another import) holds its customization lock: HTTP 429 and the lock's code (LOCK_REFUSAL). The refused
// send names a job that never existed, so — and only so — the script waits and sends the import again under a new job id. Here the REAL SDK stages the package, sends the import,
// and raises the ConnectionError for the refusal: what the stand-ins of solution-settings.test.js cannot say is that a second send is a second ImportSolution and nothing more.
const SENT_AGAIN = (sends, waits) => `ImportSolution was sent ${sends} times. Each send before the last was refused before it started (HTTP 429, code 0x8004F064: another operation held the environment's customization lock) and the job it named did not exist (importjobs(<id>) answered 404). The run waited ${waits} before sending again.`;
const wireOf = (cloud) => cloud.requests.map((r) => `${r.method} ${r.path.replace(/^\/api\/data\/v9\.\d+\//, '')}${r.search}`);
const withWaits = (http, waits) => ({ ...http, sleep: async (ms) => { waits.push(ms); } });

test('REAL BUNDLE: an import refused while another operation held the lock is sent again under a new job id — the package is staged once, the second send carries the same package and parameters — and one import is accepted', async () => {
  const { cloud, http } = world({ importRefusals: [LOCK_REFUSAL] });
  const waits = [];
  const f = files();
  const result = await ss.runImport(importRequest(f), { http: withWaits(http, waits), pac: never, importJobId: JOB });
  assert.strictEqual(cloud.state.imports.length, 1, 'the platform took one import');
  assert.strictEqual(cloud.state.refusedImports.length, 1, 'and refused one');
  const [accepted] = cloud.state.imports;
  const [refused] = cloud.state.refusedImports;
  assert.strictEqual(refused.ImportJobId, JOB);
  assert.match(accepted.ImportJobId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notStrictEqual(accepted.ImportJobId, JOB);
  assert.deepStrictEqual({ ...accepted, ImportJobId: JOB }, refused, 'the same package and the same ComponentParameters: only the job id differs');
  assert.deepStrictEqual(result, {
    source: 'sdk',
    importJobId: accepted.ImportJobId,
    applied: { environmentVariables: ['new_Secret'], connectionReferences: ['new_Dataverse'] },
    importAttempts: 2,
    importRefusals: [{ importJobId: JOB, status: 429, code: '0x8004F064', waitedMs: 10000 }],
  });
  assert.deepStrictEqual(waits, [10000]);
  // The SDK staged ONCE and deleted its copy: a second send is a second ImportSolution, never a second staging. The one read in between is the proof that the refused send's job does not exist.
  assert.deepStrictEqual(wireOf(cloud), [
    'POST StageSolution',
    'DELETE stagesolutionuploads(33333333-3333-4333-8333-333333333333)',
    'POST ImportSolution',
    `GET importjobs(${JOB})?$select=importjobid`,
    'POST ImportSolution',
  ]);
  assert.deepStrictEqual(cloud.state.jobReads, [JOB]);
  assert.strictEqual(cloud.state.staged.length, 1);
  assert.ok(!JSON.stringify(result).includes(SECRET) && !JSON.stringify(result).includes(CONNECTION_ID), 'the output names entries, never their values');
  assert.ok(cloud.requests.every((r) => r.authorization === `Bearer ${DATAVERSE_TOKEN}`), 'every request — the proof read too — carried the Dataverse token');
});

test('REAL BUNDLE: a file that fills nothing in is a plain import, and its refusal is sent again just the same — no staging, either time', async () => {
  const { cloud, http } = world({ importRefusals: [LOCK_REFUSAL, LOCK_REFUSAL] });
  const f = files({ EnvironmentVariables: [{ SchemaName: 'new_Url', Value: '' }], ConnectionReferences: [{ LogicalName: 'new_Dataverse', ConnectionId: '' }] });
  const result = await ss.runImport(importRequest(f), { http: withWaits(http, []), pac: never, importJobId: JOB });
  const refusedIds = cloud.state.refusedImports.map((body) => body.ImportJobId);
  assert.deepStrictEqual(refusedIds.length, 2);
  assert.deepStrictEqual(wireOf(cloud), [
    'POST ImportSolution',
    `GET importjobs(${refusedIds[0]})?$select=importjobid`,
    'POST ImportSolution',
    `GET importjobs(${refusedIds[1]})?$select=importjobid`,
    'POST ImportSolution',
  ]);
  assert.strictEqual(cloud.state.staged.length, 0);
  assert.strictEqual(result.importAttempts, 3);
  assert.deepStrictEqual(result.applied, { environmentVariables: [], connectionReferences: [] });
});

test('REAL BUNDLE: five refusals in a row end the run: the SDK\'s own failure for the fifth, with the count added — every send named a job of its own, no import was taken, and pac is not asked', async () => {
  const { cloud, http } = world({ importRefusals: Array.from({ length: 5 }, () => LOCK_REFUSAL) });
  const waits = [];
  const f = files();
  await assert.rejects(ss.runImport(importRequest(f), { http: withWaits(http, waits), pac: never, importJobId: JOB }), (err) => {
    const ids = cloud.state.refusedImports.map((body) => body.ImportJobId);
    assert.strictEqual(new Set(ids).size, 5);
    assert.strictEqual(err.message, `HTTP 429 from ${ORG}/api/data/v9.0/ImportSolution: ${LOCK_REFUSAL.message} ${SENT_AGAIN(5, '10 s, 20 s, 40 s, 60 s')} It sends at most 5 times: run the import again when the other operation has finished.`);
    assert.deepStrictEqual([err.code, err.statusCode, err.importJobId, err.importAttempts], ['CONNECTION_ERROR', 429, ids[4], 5]);
    assert.deepStrictEqual(err.importRefusals.map((r) => [r.importJobId, r.waitedMs]), ids.slice(0, 4).map((id, i) => [id, [10000, 20000, 40000, 60000][i]]));
    return true;
  });
  assert.strictEqual(cloud.state.imports.length, 0, 'the platform took no import');
  assert.deepStrictEqual(waits, [10000, 20000, 40000, 60000]);
  // Four proofs, one after each of the first four refusals; then the one read of the last job's log that every failed import makes (`$select=data`).
  assert.deepStrictEqual(cloud.requests.filter((r) => r.path.includes('/importjobs(')).map((r) => r.search), [...Array(4).fill('?$select=importjobid'), '?$select=data']);
  assert.strictEqual(cloud.requests.filter((r) => r.path.endsWith('/StageSolution')).length, 1, 'staged once, for five sends');
});

test('REAL BUNDLE: a refusal whose job exists, or whose job cannot be read, is NOT sent again — the SDK\'s failure as it always was, and the log of the job read once after it', async () => {
  for (const [what, jobLogAnswer] of [
    ['the job exists', json(200, { importjobid: JOB, data: '<importexportxml succeeded="success" status="Completed"/>' })],
    ['the read is refused', json(403, { error: { message: 'principal user is missing prvReadImportJob privilege' } })],
    ['the read fails', json(503, { error: { message: 'service unavailable' } })],
    ['the read gets no answer', { error: 'Request timed out' }],
  ]) {
    const { cloud, http } = world({ importRefusals: [LOCK_REFUSAL], jobLogAnswer });
    const f = files();
    await assert.rejects(ss.runImport(importRequest(f), { http: withWaits(http, []), pac: never, importJobId: JOB }), (err) => {
      assert.strictEqual(err.message, `HTTP 429 from ${ORG}/api/data/v9.0/ImportSolution: ${LOCK_REFUSAL.message}`, what);
      assert.deepStrictEqual([err.statusCode, err.importJobId, 'importAttempts' in err, 'importRefusals' in err], [429, JOB, false, false], what);
      return true;
    }, what);
    assert.strictEqual(cloud.requests.filter((r) => r.path.endsWith('/ImportSolution')).length, 1, `${what}: one ImportSolution`);
    assert.deepStrictEqual(cloud.requests.filter((r) => r.path.includes('/importjobs(')).map((r) => r.search), ['?$select=importjobid', '?$select=data'], `${what}: the proof, then the failure's usual read of the log`);
  }
});

test('REAL BUNDLE: a 429 of another kind, and the lock\'s words under another code, are sent once — no proof, no wait — as every 429 was before', async () => {
  const throttled = [
    { status: 429, code: '0x80072322', message: 'Number of requests exceeded the limit of 6000 over time window of 300 seconds.', headers: { 'retry-after': '20' } },
    { status: 429, code: '0x80071154', message: 'The current Import operation failed due to another concurrent operation running at the same time. Please try again later.' },
    { ...LOCK_REFUSAL, code: '0x80048d19' },
    { ...LOCK_REFUSAL, status: 503 },
    // SolutionConcurrencyFailure: its documented text says the installation or removal FAILED, so the code does not say that nothing started unless the platform's words do — "Cannot start …" — and its job
    // then proves it (below). Under another status, or with the documented text alone, it is sent once.
    { ...CONCURRENCY_REFUSAL, status: 503 },
    { ...CONCURRENCY_REFUSAL, message: 'The solution installation or removal failed due to the installation or removal of another solution at the same time. Please try again later.' },
  ];
  for (const refusal of throttled) {
    const { cloud, http } = world({ importRefusals: [refusal] });
    const waits = [];
    const f = files();
    await assert.rejects(ss.runImport(importRequest(f), { http: withWaits(http, waits), pac: never, importJobId: JOB }), (err) => {
      assert.strictEqual(err.statusCode, refusal.status);
      assert.deepStrictEqual(['importAttempts' in err, 'importRefusals' in err], [false, false]);
      return true;
    }, refusal.code);
    assert.deepStrictEqual([cloud.state.refusedImports.length, waits.length], [1, 0], `${refusal.code}: one send, no wait`);
    assert.deepStrictEqual(cloud.requests.filter((r) => r.path.includes('/importjobs(')).map((r) => r.search), ['?$select=data'], `${refusal.code}: only the failure's usual read of the log`);
  }
});

// --- an import refused with SolutionConcurrencyFailure (0x80071151) ----------------------------------------------------------------------------------------------
// What the platform was measured to answer an import that meets another import or a publish: HTTP 429, 0x80071151, and "Cannot start …" words (CONCURRENCY_REFUSAL). The code alone does not say that nothing
// started, so the refused send's own job — read once, at once — decides: it does not exist (404), or it is finished and its log says the import failed with that error before it processed the solution or any component.
const PROOF_READ = '?$select=importjobid,completedon,data';
const SENT_AGAIN_404 = (sends, waits) => `ImportSolution was sent ${sends} times. Each send before the last was refused before it started (HTTP 429, code 0x80071151: another operation held the environment's customization lock) and the job it named did not exist (importjobs(<id>) answered 404). The run waited ${waits} before sending again.`;
// How many requests the platform had seen when each wait began: a wait that follows the read of the job has the read before it.
const withWaitsAfterRequests = (http, cloud, waits) => ({ ...http, sleep: async (ms) => { waits.push([ms, cloud.requests.length]); } });
const NOT_PROVEN = (reason, id = JOB) => `ImportSolution was not sent again: the platform refused it (HTTP 429, code 0x80071151: another operation held the environment's customization lock), but ${reason}, so it is not proven that the refused send applied nothing of the package. Look up import job ${id} (importjobs(${id}) in the Web API, or the solution history in Maker) and run the import again only when that shows nothing was imported and the other operation has finished.`;
// What a refusal with 0x80071151 adds to the failure when the sends ran out on it: the job of the LAST send was not looked at, so nothing shows that the send applied nothing — the failure says what to look up first,
// by the rule that decided the sends before it, and never "run the import again" without it (the same words as in solution-settings.test.js).
const NOT_LOOKED_AT = (id) => `The last send was refused too (code 0x80071151), but this run sends the import 5 times at most and did not look at its import job, so it is not proven that it applied nothing of the package. Look up import job ${id} (importjobs(${id}) in the Web API, or the solution history in Maker) and run the import again only when that job does not exist (a 404), or is finished and its log says the import failed with that error before it processed the solution or any component, and the other operation has finished. Anything else means that the import may be running or may have applied the package: do not run it again.`;
const RUN_AGAIN = 'run the import again when the other operation has finished';

test('REAL BUNDLE: an import refused with 0x80071151 whose job does not exist is sent again — staged once, the job read AT ONCE (before the wait), the second send the same package — and one import is accepted', async () => {
  const { cloud, http } = world({ importRefusals: [CONCURRENCY_REFUSAL] });
  const waits = [];
  const f = files();
  const result = await ss.runImport(importRequest(f), { http: withWaitsAfterRequests(http, cloud, waits), pac: never, importJobId: JOB });
  assert.strictEqual(cloud.state.imports.length, 1, 'the platform took one import');
  assert.strictEqual(cloud.state.refusedImports.length, 1, 'and refused one');
  const [accepted] = cloud.state.imports;
  const [refused] = cloud.state.refusedImports;
  assert.strictEqual(refused.ImportJobId, JOB);
  assert.notStrictEqual(accepted.ImportJobId, JOB);
  assert.deepStrictEqual({ ...accepted, ImportJobId: JOB }, refused, 'the same package and the same ComponentParameters: only the job id differs');
  assert.deepStrictEqual(result, {
    source: 'sdk',
    importJobId: accepted.ImportJobId,
    applied: { environmentVariables: ['new_Secret'], connectionReferences: ['new_Dataverse'] },
    importAttempts: 2,
    importRefusals: [{ importJobId: JOB, status: 429, code: '0x80071151', waitedMs: 10000, proof: 'job-absent' }],
  });
  assert.deepStrictEqual(wireOf(cloud), [
    'POST StageSolution',
    'DELETE stagesolutionuploads(33333333-3333-4333-8333-333333333333)',
    'POST ImportSolution',
    `GET importjobs(${JOB})${PROOF_READ}`,
    'POST ImportSolution',
  ]);
  assert.deepStrictEqual(waits, [[10000, 4]], 'the wait came after the read of the job — the fourth request — and no read followed it');
  assert.deepStrictEqual(cloud.state.jobReads, [JOB]);
  assert.strictEqual(cloud.state.staged.length, 1);
  assert.ok(cloud.requests.every((r) => r.authorization === `Bearer ${cloud.tokens.dataverse}`), 'every request — the read of the job too — carried the Dataverse token');
  assert.ok(!JSON.stringify(result).includes(SECRET) && !JSON.stringify(result).includes(CONNECTION_ID), 'the output names entries, never their values');
});

test('REAL BUNDLE: an import refused with 0x80071151 whose job EXISTS — finished, its log saying the import failed with that error before it processed anything — is sent again, and the output says the log proved it', async () => {
  const { cloud, http } = world({ importRefusals: [CONCURRENCY_REFUSAL], jobLogAnswer: jobAnswer(jobRow(LOGS.refused({ tables: 6 }), { id: JOB })) });
  const waits = [];
  const f = files();
  const result = await ss.runImport(importRequest(f), { http: withWaitsAfterRequests(http, cloud, waits), pac: never, importJobId: JOB });
  assert.strictEqual(cloud.state.imports.length, 1);
  assert.deepStrictEqual(result.importRefusals, [{ importJobId: JOB, status: 429, code: '0x80071151', waitedMs: 10000, proof: 'job-refused-before-any-component' }]);
  assert.strictEqual(result.importAttempts, 2);
  assert.deepStrictEqual(wireOf(cloud).slice(2), ['POST ImportSolution', `GET importjobs(${JOB})${PROOF_READ}`, 'POST ImportSolution']);
  assert.deepStrictEqual(waits, [[10000, 4]]);
});

test('REAL BUNDLE: five refusals with 0x80071151 in a row end the run — each of the first four read at once and waited out, the fifth the SDK\'s own failure with the count — and no import was taken', async () => {
  const { cloud, http } = world({ importRefusals: Array.from({ length: 5 }, () => CONCURRENCY_REFUSAL) });
  const waits = [];
  const f = files();
  await assert.rejects(ss.runImport(importRequest(f), { http: withWaitsAfterRequests(http, cloud, waits), pac: never, importJobId: JOB }), (err) => {
    const ids = cloud.state.refusedImports.map((body) => body.ImportJobId);
    assert.strictEqual(new Set(ids).size, 5);
    assert.strictEqual(err.message, `HTTP 429 from ${ORG}/api/data/v9.0/ImportSolution: ${CONCURRENCY_REFUSAL.message} ${SENT_AGAIN_404(5, '10 s, 20 s, 40 s, 60 s')} ${NOT_LOOKED_AT(ids[4])}`);
    assert.deepStrictEqual([err.code, err.statusCode, err.importJobId, err.importAttempts], ['CONNECTION_ERROR', 429, ids[4], 5]);
    assert.deepStrictEqual(err.importRefusals.map((r) => [r.importJobId, r.waitedMs, r.proof]), ids.slice(0, 4).map((id, i) => [id, [10000, 20000, 40000, 60000][i], 'job-absent']));
    return true;
  });
  assert.strictEqual(cloud.state.imports.length, 0, 'the platform took no import');
  assert.deepStrictEqual(waits.map(([ms]) => ms), [10000, 20000, 40000, 60000]);
  // Four reads at once, one after each of the first four refusals — each wait follows its read — then the one read of the last job's log that every failed import makes (`$select=data`).
  assert.deepStrictEqual(cloud.requests.filter((r) => r.path.includes('/importjobs(')).map((r) => r.search), [...Array(4).fill(PROOF_READ), '?$select=data']);
  assert.deepStrictEqual(waits.map(([, seen]) => seen), [4, 6, 8, 10], 'a wait after each of the four reads of the job: the Stage, the delete of the staging copy, then a send and its read for each');
  assert.strictEqual(cloud.requests.filter((r) => r.path.endsWith('/StageSolution')).length, 1, 'staged once, for five sends');
});

// The read of an import job answers `answer` once `sends` ImportSolution requests have reached the platform — the read of the LAST send's job, the one the failure makes — and is the platform's own (a 404) before that.
const jobAnsweringAfterSends = (sends, answer) => {
  let seen = 0;
  return (entry) => {
    if (entry.method === 'POST' && entry.path.endsWith('/ImportSolution')) seen += 1;
    return entry.method === 'GET' && entry.path.includes('/importjobs(') && seen >= sends ? answer : undefined;
  };
};

test('REAL BUNDLE: the fifth refusal with 0x80071151 is followed by no advice to run the import again, whatever the job of that send is — it was not looked at, so the failure says what to look up first — and no sixth import is sent', async () => {
  for (const [what, last] of [
    ['a job that is still running', jobAnswer(jobRow(LOGS.running(), { completed: false }))],
    ['a job that applied the package', jobAnswer(jobRow(LOGS.succeeded()))],
    ['a read that is refused', json(403, { error: { message: 'principal user is missing prvReadImportJob privilege' } })],
    ['a read that fails', json(503, { error: { message: 'service unavailable' } })],
    ['a read that gets no answer', { error: 'Request timed out' }],
    ['a job that does not exist', undefined],
  ]) {
    const { cloud, http } = world({ importRefusals: Array.from({ length: 6 }, () => CONCURRENCY_REFUSAL) }, last ? { override: jobAnsweringAfterSends(5, last) } : {});
    const waits = [];
    const f = files();
    await assert.rejects(ss.runImport(importRequest(f), { http: withWaits(http, waits), pac: never, importJobId: JOB }), (err) => {
      const ids = cloud.state.refusedImports.map((body) => body.ImportJobId);
      assert.strictEqual(new Set(ids).size, 5, what);
      assert.strictEqual(err.message, `HTTP 429 from ${ORG}/api/data/v9.0/ImportSolution: ${CONCURRENCY_REFUSAL.message} ${SENT_AGAIN_404(5, '10 s, 20 s, 40 s, 60 s')} ${NOT_LOOKED_AT(ids[4])}`, what);
      assert.ok(!err.message.includes(RUN_AGAIN), `${what}: the advice that nothing has proven safe is not given`);
      assert.deepStrictEqual([err.code, err.statusCode, err.importJobId, err.importAttempts], ['CONNECTION_ERROR', 429, ids[4], 5], what);
      return true;
    }, what);
    assert.deepStrictEqual([cloud.state.refusedImports.length, cloud.state.imports.length, waits], [5, 0, [10000, 20000, 40000, 60000]], `${what}: five sends, no sixth, nothing taken`);
    assert.deepStrictEqual(cloud.requests.filter((r) => r.path.includes('/importjobs(')).map((r) => r.search), [...Array(4).fill(PROOF_READ), '?$select=data'], `${what}: four proofs, then the failure's usual read of the last job — never a fifth proof`);
  }
});

test('REAL BUNDLE: a timer that resumes after the five minutes ends the retry before the send, for a refusal with 0x80071151 proven by a 404 or by the log — the job read at once, the wait, and no second import', async () => {
  for (const [what, jobLogAnswer, logged] of [
    ['a 404', undefined, ''],
    ['the log of an import refused at the lock', jobAnswer(jobRow(LOGS.refused({ tables: 6 }), { id: JOB })), ` The import job's log (importjobs(${JOB})) says: its status is ${REFUSAL_STATUS}`],
  ]) {
    const { cloud, http } = world({ importRefusals: [CONCURRENCY_REFUSAL, CONCURRENCY_REFUSAL], ...(jobLogAnswer ? { jobLogAnswer } : {}) });
    const time = clocked(http, { lateMs: 350000 });
    const f = files();
    await assert.rejects(ss.runImport(importRequest(f), { http: time.http, pac: never, importJobId: JOB }), (err) => {
      assert.strictEqual(err.message, `HTTP 429 from ${ORG}/api/data/v9.0/ImportSolution: ${CONCURRENCY_REFUSAL.message}${logged} ${OUT_OF_TIME('360 s')}`, what);
      assert.deepStrictEqual([err.code, err.statusCode, err.importJobId, 'importAttempts' in err], ['CONNECTION_ERROR', 429, JOB, false], what);
      return true;
    }, what);
    assert.deepStrictEqual([cloud.state.refusedImports.length, cloud.state.imports.length, time.waits], [1, 0, [10000]], `${what}: one send, nothing taken, the one wait`);
    assert.deepStrictEqual(wireOf(cloud).slice(-2), [`GET importjobs(${JOB})${PROOF_READ}`, `GET importjobs(${JOB})?$select=data`], `${what}: the proof at once, then the failure's usual read — and no send after the wait`);
  }
});

test('REAL BUNDLE: a refusal with 0x80071151 whose job does not prove that nothing was applied is NOT sent again — one send, the job read once at once, no wait — and the failure says why and what to do', async () => {
  for (const [what, jobLogAnswer, reason] of [
    ['the import is still running', jobAnswer(jobRow(LOGS.running(), { completed: false })), 'its import job is not finished (completedon is empty)'],
    ['the import failed after it began', jobAnswer(jobRow(LOGS.failedAfterStart())), 'the log of its import job says the import failed with error 0x80048033, not with 0x80071151'],
    ['the solution manifest was processed', jobAnswer(jobRow(LOGS.refused({ manifest: 'true' }))), 'the log of its import job shows that the import began to apply the package (its solution manifest is processed)'],
    ['the read is refused', json(403, { error: { message: 'principal user is missing prvReadImportJob privilege' } }), 'the read of its import job answered HTTP 403, which is neither the job nor a 404'],
  ]) {
    const { cloud, http } = world({ importRefusals: [CONCURRENCY_REFUSAL], jobLogAnswer });
    const waits = [];
    const f = files();
    await assert.rejects(ss.runImport(importRequest(f), { http: withWaits(http, waits), pac: never, importJobId: JOB }), (err) => {
      assert.ok(err.message.startsWith(`HTTP 429 from ${ORG}/api/data/v9.0/ImportSolution: ${CONCURRENCY_REFUSAL.message}`), what);
      assert.ok(err.message.endsWith(NOT_PROVEN(reason)), `${what}: ${err.message}`);
      assert.deepStrictEqual([err.code, err.statusCode, err.importJobId, 'importAttempts' in err, 'importRefusals' in err, 'fallback' in err], ['CONNECTION_ERROR', 429, JOB, false, false, false], what);
      return true;
    }, what);
    assert.deepStrictEqual([cloud.state.refusedImports.length, cloud.state.imports.length, waits.length], [1, 0, 0], `${what}: one send, nothing taken, nothing waited for`);
    assert.deepStrictEqual(cloud.requests.filter((r) => r.path.includes('/importjobs(')).map((r) => r.search), [PROOF_READ, '?$select=data'], `${what}: the read that decides, then the failure's usual read of the log`);
  }
});

test('REAL BUNDLE: a refusal with 0x80071151 whose message does not begin "Cannot start" is sent once, with no read of the job but the failure\'s usual one — the code alone is not proof that nothing started', async () => {
  const documented = { ...CONCURRENCY_REFUSAL, message: 'The solution installation or removal failed due to the installation or removal of another solution at the same time. Please try again later.' };
  const { cloud, http } = world({ importRefusals: [documented] });
  const waits = [];
  const f = files();
  await assert.rejects(ss.runImport(importRequest(f), { http: withWaits(http, waits), pac: never, importJobId: JOB }), (err) => {
    assert.strictEqual(err.message, `HTTP 429 from ${ORG}/api/data/v9.0/ImportSolution: ${documented.message}`);
    assert.deepStrictEqual(['importAttempts' in err, 'importRefusals' in err], [false, false]);
    return true;
  });
  assert.deepStrictEqual([cloud.state.refusedImports.length, waits.length], [1, 0]);
  assert.deepStrictEqual(cloud.requests.filter((r) => r.path.includes('/importjobs(')).map((r) => r.search), ['?$select=data']);
});

test('REAL BUNDLE: a send that follows a refusal and is answered by a gateway is the failure — one more send is not made — and the job to look up is the one that send carried', async () => {
  // The platform refuses the first send, takes the second (it is recorded) and a gateway answers 504 for it: the second send's outcome is unknown.
  const { cloud, http } = world({ importRefusals: [LOCK_REFUSAL], importAnswer: json(504, { error: { code: '0x80048d19', message: 'gateway timeout' } }) });
  const f = files();
  await assert.rejects(ss.runImport(importRequest(f), { http: withWaits(http, []), pac: never, importJobId: JOB }), (err) => {
    const second = cloud.state.imports[0].ImportJobId;
    assert.notStrictEqual(second, JOB);
    assert.strictEqual(err.message, `HTTP 504 from ${ORG}/api/data/v9.0/ImportSolution: gateway timeout The last send was not sent again: the environment may have accepted it.${ss.lookUpJob(second)} ${SENT_AGAIN(2, '10 s')}`);
    assert.deepStrictEqual([err.statusCode, err.importJobId, err.importAttempts], [504, second, 2]);
    return true;
  });
  assert.strictEqual(cloud.requests.filter((r) => r.path.endsWith('/ImportSolution')).length, 2);
});

test('REAL BUNDLE: a refusal that quotes the settings file reaches no message — the SDK\'s words are withheld, the resend\'s own sentences hold no value and are shown whole', async () => {
  const quoting = { ...LOCK_REFUSAL, message: `${LOCK_REFUSAL.message} (value ${SECRET}, connection ${CONNECTION_ID})` };
  const { cloud, http } = world({ importRefusals: Array.from({ length: 5 }, () => quoting) });
  const f = files();
  await assert.rejects(ss.runImport(importRequest(f), { http: withWaits(http, []), pac: never, importJobId: JOB }), (err) => {
    assert.strictEqual(err.message, `HTTP 429 from ${ORG}/api/data/v9.0/ImportSolution: ${WITHHELD('message')} ${SENT_AGAIN(5, '10 s, 20 s, 40 s, 60 s')} It sends at most 5 times: run the import again when the other operation has finished.`);
    const printed = JSON.stringify(ss.describeFailure(err));
    assert.ok(!printed.includes(SECRET) && !printed.includes(CONNECTION_ID), printed);
    return true;
  });
  assert.strictEqual(cloud.state.refusedImports.length, 5);
});

// A clock that only the waits move, so that what the run spends is measured as it is when the waits are real: `now` is what the client reads, and a wait moves it by its length — and by `lateMs` more, for a timer
// that resumes later than it was asked to (a delayed timer, a laptop that was suspended).
const CLOCK_ORIGIN = Date.UTC(2026, 9, 14, 12, 0, 0);
function clocked(http, { lateMs = 0 } = {}) {
  const clock = { elapsed: 0 };
  const waits = [];
  return { clock, waits, http: { ...http, now: () => CLOCK_ORIGIN + clock.elapsed, sleep: async (ms) => { waits.push(ms); clock.elapsed += ms + lateMs; } } };
}
const NOT_SENT_AGAIN = (wait, spent) => `ImportSolution was not sent again: the next wait, ${wait}, does not fit in what is left of the 5 minutes this run spends in all on sending it again (${spent} are spent). Run the import again when the other operation has finished.`;
const OUT_OF_TIME = (spent) => `ImportSolution was not sent again: the 5 minutes this run spends in all on sending it again were used up (${spent}) before the next send. Run the import again when the other operation has finished.`;

test('REAL BUNDLE: a Retry-After longer than a minute — in seconds, and as a date — is waited out WHOLE before the second send; the platform is never sent the import again early', async () => {
  for (const [form, header] of [['delay-seconds', '180'], ['HTTP-date', new Date(CLOCK_ORIGIN + 180000).toUTCString()]]) {
    const { cloud, http } = world({ importRefusals: [{ ...LOCK_REFUSAL, headers: { 'retry-after': header } }] });
    const time = clocked(http);
    const f = files();
    const result = await ss.runImport(importRequest(f), { http: time.http, pac: never, importJobId: JOB });
    assert.deepStrictEqual(time.waits, [180000], `${form}: the whole of what the platform asked, not a minute of it`);
    assert.strictEqual(result.importAttempts, 2, form);
    assert.deepStrictEqual(result.importRefusals, [{ importJobId: JOB, status: 429, code: '0x8004F064', waitedMs: 180000 }], form);
    assert.strictEqual(cloud.state.imports.length, 1, form);
  }
});

test('REAL BUNDLE: a Retry-After that does not fit the five minutes ends the retry at once — one send, no wait, no proof, no second import — and the failure is the platform\'s refusal with the reason', async () => {
  for (const [form, header] of [['delay-seconds', '600'], ['HTTP-date', new Date(CLOCK_ORIGIN + 600000).toUTCString()]]) {
    const { cloud, http } = world({ importRefusals: [{ ...LOCK_REFUSAL, headers: { 'retry-after': header } }] });
    const time = clocked(http);
    const f = files();
    await assert.rejects(ss.runImport(importRequest(f), { http: time.http, pac: never, importJobId: JOB }), (err) => {
      assert.strictEqual(err.message, `HTTP 429 from ${ORG}/api/data/v9.0/ImportSolution: ${LOCK_REFUSAL.message} ${NOT_SENT_AGAIN('600 s', '0 s')}`, form);
      assert.deepStrictEqual([err.code, err.statusCode, err.importJobId, 'importAttempts' in err], ['CONNECTION_ERROR', 429, JOB, false], form);
      return true;
    }, form);
    assert.deepStrictEqual([cloud.state.refusedImports.length, cloud.state.imports.length, time.waits.length], [1, 0, 0], `${form}: one send, nothing taken, nothing waited for`);
    assert.deepStrictEqual(cloud.requests.filter((r) => r.path.includes('/importjobs(')).map((r) => r.search), ['?$select=data'], `${form}: only the failure's usual read of the log — no proof read, since nothing was to be sent again`);
  }
});

// --- what a final write that fails must not make the run forget -------------------------------------------------------------------------------------
// A template that is complete is installed as the LAST step, after the SDK has staged, refused and cleaned up (or not) and pac has made its folder: by then the run knows what it has left behind. The name `--out`
// can be taken while all that runs — the exclusive install refuses to replace what a maker saved — and the failure that is then reported must still say the staged copy and the folder that stayed.
const { readCleanupWarnings } = require('../lib/maker-sdk.js');
const UPLOAD = '33333333-3333-4333-8333-333333333333';

test('REAL BUNDLE: a template whose --out is taken while the SDK refuses and pac makes it fails OUT_EXISTS — and the staged copy the SDK could not delete is still said, with its upload id', async () => {
  const { cloud, http } = world({ stage: { variables: [{ schemaName: 'new_Mode' }, { schemaName: 'new_Mode' }] }, deleteStagingAnswer: json(403, { error: { message: 'staging cleanup denied' } }) });
  const f = files();
  const pac = { spawn: (name, args) => {
    fs.writeFileSync(args[args.indexOf('--settings-file') + 1], JSON.stringify({ EnvironmentVariables: [], ConnectionReferences: [] }));
    fs.writeFileSync(f.out, '{"maker":"saved while staging"}');
    return { status: 0, stdout: 'Template created', stderr: '' };
  } };
  let failure;
  await ss.runTemplate(templateRequest(f, { solution: 'Demo' }), { http, pac }).catch((error) => { failure = ss.describeFailure(error, readCleanupWarnings); });
  assert.ok(failure, 'the template failed');
  assert.strictEqual(failure.code, 'OUT_EXISTS');
  assert.deepStrictEqual(cloud.state.deletedStaging, [UPLOAD], 'the SDK tried to delete its staged copy');
  assert.strictEqual(failure.warnings.length, 1, 'one warning, said once');
  assert.match(failure.warnings[0], new RegExp(`stagesolutionupload ${UPLOAD}\\) could not be deleted`));
  assert.strictEqual(fs.readFileSync(f.out, 'utf8'), '{"maker":"saved while staging"}', 'what the maker saved is untouched');
});

test('REAL BUNDLE: a template made by pac whose work folder cannot be removed, and whose --out is taken meanwhile, fails OUT_EXISTS — and the folder that stayed is still said, with its path', async (t) => {
  const held = holdingWorkFolders(t);
  const f = files();
  const pac = { spawn: (name, args) => {
    fs.writeFileSync(args[args.indexOf('--settings-file') + 1], JSON.stringify({ EnvironmentVariables: [], ConnectionReferences: [] }));
    fs.writeFileSync(f.out, '{"maker":"saved while pac ran"}');
    return { status: 0, stdout: 'Template created', stderr: '' };
  } };
  let failure;
  await ss.runTemplate({ command: 'template', packagePath: f.pkg, outPath: f.out, force: false }, { pac }).catch((error) => { failure = ss.describeFailure(error, readCleanupWarnings); });
  assert.ok(failure, 'the template failed');
  assert.strictEqual(failure.code, 'OUT_EXISTS');
  const [left] = held.dirs;
  assert.ok(left && fs.existsSync(left), 'the folder stayed');
  assert.deepStrictEqual(failure.warnings, [`The folder ${left} could not be removed (EBUSY); it holds the settings template pac wrote (emptied, so it keeps no value). Delete it.`]);
  assert.strictEqual(fs.readFileSync(path.join(left, 'settings.json'), 'utf8'), '', 'pac\'s template is emptied');
});

// --- a folder for pac's copy that cannot be made --------------------------------------------------------------------------------------------------
test('REAL BUNDLE: a folder for the settings copy that cannot be made — in the plugin\'s own folder and in the temp folder it falls back to — after the SDK refused a feature pac applies, is PAC_SETTINGS_COPY_FAILED with the reason pac was asked, and names no SDK import job', async (t) => {
  // Each way fails with a code of its own: the plugin's folder is a courtesy to the next run and its refusal is never the run's failure — an error is reported only when the plain call fails too, and then it is that call's.
  const refused = refusingWorkFolders(t, { plugin: 'ENOSPC', plain: 'EACCES' });
  const { http } = world();
  const f = files({ Workflows: [{ WorkflowId: 'x' }] });
  let pacCalls = 0;
  const pac = { spawn: () => { pacCalls += 1; return { status: 0, stdout: '', stderr: '' }; } };
  let failure;
  await ss.runImport(importRequest(f), { http, pac, importJobId: JOB }).catch((error) => { failure = ss.describeFailure(error, readCleanupWarnings); });
  assert.deepStrictEqual(refused.map(({ way, code }) => [way, code]), [['plugin', 'ENOSPC'], ['plain', 'EACCES']], 'the folder was asked for in the plugin\'s own folder, and then in the temp folder');
  assert.ok(failure, 'the import failed');
  assert.strictEqual(pacCalls, 0, 'pac was not started');
  assert.strictEqual(failure.code, 'PAC_SETTINGS_COPY_FAILED');
  assert.strictEqual(failure.error, '`pac solution import` was not run: a private copy of the settings file could not be made (EACCES).');
  assert.strictEqual(failure.fallback.code, 'INVALID_ARGUMENT');
  assert.ok(!('importJobId' in failure), 'no SDK import was attempted for a feature only pac applies');
});

// Where only the plugin's own folder will not take the work folder the run goes on in the temp folder itself, as it always did, and what the run guarantees about a folder that cannot be removed holds there as well:
// the copy of the settings is emptied and the folder is said — with nothing that records it, so that no later run's sweep will find it, which is what the note's "Delete it" is for.
test('REAL BUNDLE: a settings copy in the temp folder itself — the plugin\'s own folder would not take the work folder — that cannot be removed is emptied and said all the same', async (t) => {
  const refused = refusingWorkFolders(t, { plugin: 'ENOSPC', plain: null });
  const held = holdingWorkFolders(t);
  const { http } = world();
  const f = files({ Workflows: [{ WorkflowId: 'x' }] });
  const result = await ss.runImport(importRequest(f), { http, pac: { spawn: () => ({ status: 0, stdout: 'Solution Imported successfully.', stderr: '' }) }, importJobId: JOB });
  assert.deepStrictEqual(refused.map(({ way }) => way), ['plugin'], 'only the plugin\'s folder refused');
  assert.strictEqual(result.source, 'pac');
  assert.strictEqual(held.dirs.size, 1);
  const [left] = held.dirs;
  assert.strictEqual(path.dirname(left), os.tmpdir(), 'the folder is in the temp folder itself');
  assert.match(path.basename(left), PLAIN_WORK_FOLDER, 'named as it always was');
  assert.deepStrictEqual(fs.readdirSync(left), ['settings.json'], 'and holds the copy alone: no owner record');
  assert.strictEqual(fs.readFileSync(path.join(left, 'settings.json'), 'utf8'), '', 'what could not be removed holds no value');
  assert.deepStrictEqual(result.warnings, [`The folder ${left} could not be removed (EBUSY); it holds the copy of the settings file that pac was given, which can hold secrets (emptied, so it keeps no value). Delete it.`]);
});

// --- real processes -----------------------------------------------------------------------------------------------------------------

const STAGE_CONFIG = { solution: { packageBase64: ZIP.toString('base64'), stage: STAGE } };
const FILLED = JSON.stringify({
  EnvironmentVariables: [{ SchemaName: 'new_Secret', Value: SECRET }],
  ConnectionReferences: [{ LogicalName: 'new_Dataverse', ConnectionId: CONNECTION_ID, ConnectorId: CONNECTOR }],
});
const inRunDir = (name) => (dir) => path.join(dir, name);
const noSecrets = (run) => {
  for (const text of [run.stdout, run.stderr]) {
    assert.ok(!text.includes(SECRET), 'the secret was printed');
    assert.ok(!text.includes(CONNECTION_ID), 'the connection id was printed');
    assert.ok(!text.includes(DATAVERSE_TOKEN), 'a token was printed');
  }
};

test('PROCESS: template --solution writes the settings file and prints one line naming it and the entry counts — no pac on the machine, no secret anywhere', () => {
  const run = runScript('solution-settings.js', ['template', '--env', ORG, '--solution', 'ContosoDemo', '--out', inRunDir('settings.json')], { platform: STAGE_CONFIG, read: ['settings.json'] });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.strictEqual(run.lines.length, 1);
  const out = JSON.parse(run.lines[0]);
  assert.deepStrictEqual([out.ok, out.source, out.environmentVariables, out.connectionReferences], [true, 'sdk', 2, 1]);
  assert.ok(path.isAbsolute(out.out) && path.basename(out.out) === 'settings.json');
  const written = JSON.parse(run.outputs['settings.json']);
  assert.deepStrictEqual(written.EnvironmentVariables.map((v) => v.SchemaName), ['new_Secret', 'new_Url']);
  assert.ok(run.outputs['settings.json'].endsWith('}\n'));
  assert.deepStrictEqual(run.pacCalls, []);
  noSecrets(run);
});

test('PROCESS: when the SDK refuses to stage, pac reads the exported zip and the file at --out is pac\'s own', () => {
  const pacFile = JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'x_a', Value: '', Name: { Default: 'A' } }], ConnectionReferences: [], CopilotAgents: [] }, null, 2);
  const run = runScript('solution-settings.js', ['template', '--env', ORG, '--solution', 'ContosoDemo', '--out', inRunDir('settings.json')], {
    platform: { solution: { ...STAGE_CONFIG.solution, stage: { status: 'Failed', missingDependencies: [{ Message: 'missing y' }] } } },
    pac: { responses: [{ match: ['solution', 'create-settings'], writeFlag: '--settings-file', writeContent: pacFile, stdout: 'Deployment settings file created.\n', snapshot: ['--solution-zip'] }] },
    read: ['settings.json'],
  });
  assert.strictEqual(run.status, 0, run.stderr);
  const out = JSON.parse(run.lines[0]);
  assert.deepStrictEqual([out.source, out.fallback.code, out.environmentVariables, out.connectionReferences], ['pac', 'SOLUTION_STAGING_FAILED', 1, 0]);
  assert.strictEqual(run.outputs['settings.json'], pacFile, 'pac\'s bytes, as pac wrote them');
  assert.strictEqual(run.pacCalls.length, 1);
  assert.strictEqual(run.pacCalls[0].snapshots['--solution-zip'].bytes, ZIP.length, 'pac was given the exported package');
  assert.deepStrictEqual(run.pacCalls[0].args.slice(0, 2), ['solution', 'create-settings']);
});

test('PROCESS: template --package without --env needs no environment at all — pac reads the zip, no request is made, no fallback is claimed', () => {
  const run = runScript('solution-settings.js', ['template', '--package', inRunDir('solution.zip'), '--out', inRunDir('settings.json')], {
    platform: {},
    files: { 'solution.zip': ZIP },
    pac: { responses: [{ match: ['solution', 'create-settings'], writeFlag: '--settings-file', writeContent: JSON.stringify({ EnvironmentVariables: [], ConnectionReferences: [] }) }] },
    read: ['settings.json'],
  });
  assert.strictEqual(run.status, 0, run.stderr);
  const out = JSON.parse(run.lines[0]);
  assert.deepStrictEqual([out.ok, out.source, 'fallback' in out], [true, 'pac', false]);
  assert.deepStrictEqual(run.requests, []);
});

test('PROCESS: an existing --out is not replaced without --force — exit 1, the file untouched, nothing asked of the environment — and --force replaces it', () => {
  const run = runScript('solution-settings.js', ['template', '--env', ORG, '--solution', 'ContosoDemo', '--out', inRunDir('settings.json')], { platform: STAGE_CONFIG, files: { 'settings.json': '{"mine":"filled in"}' }, read: ['settings.json'] });
  assert.strictEqual(run.status, 1);
  assert.strictEqual(JSON.parse(run.lines[0]).code, 'OUT_EXISTS');
  assert.strictEqual(run.outputs['settings.json'], '{"mine":"filled in"}');
  assert.deepStrictEqual(run.requests, []);
  const forced = runScript('solution-settings.js', ['template', '--env', ORG, '--solution', 'ContosoDemo', '--out', inRunDir('settings.json'), '--force'], { platform: STAGE_CONFIG, files: { 'settings.json': '{"mine":"filled in"}' }, read: ['settings.json'] });
  assert.strictEqual(forced.status, 0, forced.stderr);
  assert.ok(JSON.parse(forced.outputs['settings.json']).EnvironmentVariables);
});

test('PROCESS: import applies the settings in the import, prints the job and the entries it applied — and the secret and the connection id are nowhere in what the run printed', () => {
  const run = runScript('solution-settings.js', ['import', '--env', ORG, '--package', inRunDir('solution.zip'), '--settings', inRunDir('filled.json')], {
    platform: STAGE_CONFIG,
    files: { 'solution.zip': ZIP, 'filled.json': FILLED },
  });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.strictEqual(run.lines.length, 1);
  const out = JSON.parse(run.lines[0]);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.source, 'sdk');
  assert.match(out.importJobId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepStrictEqual(out.applied, { environmentVariables: ['new_Secret'], connectionReferences: ['new_Dataverse'] });
  assert.strictEqual(run.state.imports.length, 1);
  assert.strictEqual(run.state.imports[0].ImportJobId, out.importJobId, 'the job the output names is the job the platform was given');
  assert.strictEqual(run.state.imports[0].ComponentParameters[0].value, SECRET, 'the platform got the value');
  assert.deepStrictEqual(run.pacCalls, []);
  noSecrets(run);
});

test('PROCESS: a settings feature the SDK does not apply goes to pac — the same files, the environment pinned — and is reported as pac\'s, with the SDK\'s words', () => {
  const run = runScript('solution-settings.js', ['import', '--env', ORG, '--package', inRunDir('solution.zip'), '--settings', inRunDir('filled.json')], {
    platform: STAGE_CONFIG,
    files: { 'solution.zip': ZIP, 'filled.json': JSON.stringify({ ...JSON.parse(FILLED), Workflows: [{ WorkflowId: '1' }] }) },
    pac: { responses: [{ match: ['solution', 'import'], stdout: 'Solution Imported successfully.\n', snapshot: ['--settings-file', '--path'] }] },
  });
  assert.strictEqual(run.status, 0, run.stderr);
  const out = JSON.parse(run.lines[0]);
  assert.deepStrictEqual([out.ok, out.source, out.fallback.code], [true, 'pac', 'INVALID_ARGUMENT']);
  assert.match(out.fallback.message, /this SDK does not apply/);
  assert.deepStrictEqual(out.applied, { environmentVariables: ['new_Secret'], connectionReferences: ['new_Dataverse'] });
  assert.strictEqual(run.pacCalls.length, 1);
  const [call] = run.pacCalls;
  assert.deepStrictEqual([call.args[0], call.args[1], call.args[2] === '--path', call.args[4], call.args[5]], ['solution', 'import', true, '--environment', ORG]);
  assert.ok(call.args.includes('--settings-file'));
  assert.strictEqual(call.snapshots['--path'].bytes, ZIP.length);
  assert.strictEqual(JSON.parse(call.snapshots['--settings-file'].text).Workflows.length, 1, 'pac read the file itself');
  assert.deepStrictEqual(run.requests, [], 'the SDK refused before any request');
  noSecrets(run);
});

test('PROCESS: a pac import that fails reports the failure without the secret pac echoed — exit 1, one ok:false line', () => {
  const run = runScript('solution-settings.js', ['import', '--env', ORG, '--package', inRunDir('solution.zip'), '--settings', inRunDir('filled.json')], {
    platform: STAGE_CONFIG,
    files: { 'solution.zip': ZIP, 'filled.json': JSON.stringify({ ...JSON.parse(FILLED), CanvasApps: [{ Name: 'x' }] }) },
    pac: { responses: [{ match: ['solution', 'import'], status: 1, stderr: `Error: the value ${SECRET} and connection ${CONNECTION_ID} were refused\n` }] },
  });
  assert.strictEqual(run.status, 1);
  assert.strictEqual(run.lines.length, 1);
  const out = JSON.parse(run.lines[0]);
  assert.deepStrictEqual([out.ok, out.code, out.fallback.code], [false, 'PAC_FAILED', 'INVALID_ARGUMENT']);
  // The SDK refused before it staged anything, so the package's definitions were never read and the file gives new_Secret no type: it is not known to be anything but a secret.
  assert.strictEqual(out.error, `\`pac solution import\` failed (exit 1): ${WITHHELD('text')}`);
  noSecrets(run);
  // pac that echoes only the connection id: the id is replaced and pac's words are kept.
  const idOnly = runScript('solution-settings.js', ['import', '--env', ORG, '--package', inRunDir('solution.zip'), '--settings', inRunDir('filled.json')], {
    platform: STAGE_CONFIG,
    files: { 'solution.zip': ZIP, 'filled.json': JSON.stringify({ ...JSON.parse(FILLED), CanvasApps: [{ Name: 'x' }] }) },
    pac: { responses: [{ match: ['solution', 'import'], status: 1, stderr: `Error: connection ${CONNECTION_ID} was refused\n` }] },
  });
  assert.match(JSON.parse(idOnly.lines[0]).error, /failed \(exit 1\): Error: connection <redacted> was refused$/);
  noSecrets(idOnly);
});

test('PROCESS: a platform failure of the import prints one ok:false line with the job, and never the value the platform quoted', () => {
  const run = runScript('solution-settings.js', ['import', '--env', ORG, '--package', inRunDir('solution.zip'), '--settings', inRunDir('filled.json')], {
    platform: { ...STAGE_CONFIG, failures: [{ pathIncludes: '/ImportSolution', status: 400, body: { error: { message: `bad value ${SECRET}` } } }] },
    files: { 'solution.zip': ZIP, 'filled.json': FILLED },
  });
  assert.strictEqual(run.status, 1);
  const out = JSON.parse(run.lines[0]);
  assert.deepStrictEqual([out.ok, out.code], [false, 'CONNECTION_ERROR']);
  assert.match(out.importJobId, /^[0-9a-f-]{36}$/);
  // The package's definition says new_Secret is a secret (the file says nothing of it): the platform's words are withheld, and the line the SDK itself wrote stays.
  assert.strictEqual(out.error, `HTTP 400 from ${ORG}/api/data/v9.0/ImportSolution: ${WITHHELD('message')}`);
  assert.strictEqual(out.status, 400);
  noSecrets(run);
});

test('PROCESS: import refuses a missing settings file, a file of the wrong shape and a non-zip package before it asks anything — exit 1, and nothing in the message is a value', () => {
  const cases = [
    [{ 'solution.zip': ZIP }, 'SETTINGS_UNREADABLE'],
    [{ 'solution.zip': ZIP, 'filled.json': JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'a', Value: { v: SECRET } }] }) }, 'SETTINGS_INVALID'],
    [{ 'solution.zip': 'plain text', 'filled.json': FILLED }, 'PACKAGE_UNREADABLE'],
  ];
  for (const [files, code] of cases) {
    const run = runScript('solution-settings.js', ['import', '--env', ORG, '--package', inRunDir('solution.zip'), '--settings', inRunDir('filled.json')], { platform: STAGE_CONFIG, files });
    assert.strictEqual(run.status, 1, code);
    assert.strictEqual(JSON.parse(run.lines[0]).code, code);
    assert.deepStrictEqual(run.requests, [], code);
    noSecrets(run);
  }
});

test('PROCESS: the line is pure ASCII — a path with a non-ASCII character is written as a \\uXXXX escape and reads back as itself — on success and on failure', () => {
  const name = 'caf\u00e9.json';
  const ok = runScript('solution-settings.js', ['template', '--env', ORG, '--solution', 'ContosoDemo', '--out', inRunDir(name)], { platform: STAGE_CONFIG });
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^[\x00-\x7e\r\n]*$/, 'pure ASCII on success');
  assert.ok(ok.stdout.includes('caf\\u00e9.json'), 'the escape, not the character');
  assert.strictEqual(path.basename(JSON.parse(ok.lines[0]).out), name);
  const bad = runScript('solution-settings.js', ['import', '--env', ORG, '--package', inRunDir('p\u00e4ckage.zip'), '--settings', inRunDir('s.json')], { platform: STAGE_CONFIG, files: { 's.json': FILLED } });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stdout, /^[\x00-\x7e\r\n]*$/, 'pure ASCII on failure');
  assert.ok(bad.stdout.includes('p\\u00e4ckage.zip'));
  assert.strictEqual(JSON.parse(bad.lines[0]).code, 'PACKAGE_UNREADABLE');
});

test('PROCESS: an environment that is not a Dataverse origin, and every usage error, exit 1 on stderr with nothing on stdout', () => {
  for (const argv of [
    ['import', '--env', 'https://contoso.example.com', '--package', 'p.zip', '--settings', 's.json'],
    ['template', '--env', ORG, '--out', 'o.json'],
    ['template', '--env', ORG, '--solution', 'Demo', '--out', 'o.json', '--force', 'yes'],
    [],
  ]) {
    const run = runScript('solution-settings.js', argv, { platform: STAGE_CONFIG });
    assert.strictEqual(run.status, 1, argv.join(' '));
    assert.strictEqual(run.stdout, '', argv.join(' '));
    assert.match(run.stderr, /Usage:/);
    assert.deepStrictEqual(run.requests, []);
  }
});

test('PROCESS: a failure of the script itself prints only its kind — never its message, which is not known to be free of what the settings file holds', () => {
  // `emitResult` — where the script ends — is made to throw with a message that names the secret.
  const preload = path.resolve(__dirname, 'helpers', 'fake-emit-failure-preload.js');
  const run = runScript('solution-settings.js', ['template', '--env', ORG, '--solution', 'ContosoDemo', '--out', inRunDir('settings.json')], {
    platform: STAGE_CONFIG,
    env: { NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, FAKE_EMIT_SECRET: SECRET },
  });
  assert.strictEqual(run.status, 1);
  assert.strictEqual(run.stdout, '');
  assert.strictEqual(run.stderr, 'Error: solution-settings.js failed unexpectedly (TypeError).\n');
});

// --- an import that is sent once, and told once -----------------------------------------------------------------------------------------------

// A settings file with one secret variable (TypeId 100000005, as pac and the SDK write it), and the import of it in a child process over the fake platform.
const secretFile = (value, extra = {}) => JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'new_Secret', Value: value, TypeId: 100000005 }], ConnectionReferences: [], ...extra });
function importInProcess({ value = SECRET, settings, solution = {}, platform = {}, pac } = {}) {
  return runScript('solution-settings.js', ['import', '--env', ORG, '--package', inRunDir('solution.zip'), '--settings', inRunDir('filled.json')], {
    platform: { solution: { packageBase64: ZIP.toString('base64'), stage: STAGE, ...solution }, ...platform },
    files: { 'solution.zip': ZIP, 'filled.json': settings === undefined ? secretFile(value) : settings },
    pac,
  });
}
const importPosts = (run) => run.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/ImportSolution')).length;
// Every string in a parsed value, keys included.
const stringsIn = (value) => (typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...stringsIn(item)]) : []);
// What the run printed — stdout, stderr, and each string of the line on stdout (which is JSON, so a quote or a backslash in it is escaped) — holds none of `forbidden`.
function assertPrintsNone(run, forbidden, what = '') {
  const printed = [run.stdout, run.stderr, ...stringsIn(run.lines.length ? JSON.parse(run.lines[0]) : {})];
  for (const text of printed) {
    for (const value of forbidden) assert.ok(!text.includes(value), `${what} printed ${JSON.stringify(value)}:\n${text}`);
  }
}

test('PROCESS: ImportSolution is sent EXACTLY ONCE whatever answers it after the platform took it — 500, 502, 503, 504 and 401 — and the failure names the status, the code and the job to look up', () => {
  for (const status of [500, 502, 503, 504, 401]) {
    // The fake records the import when it arrives, then answers as a gateway would: the platform HAS accepted it, and a second send would be answered 204.
    const run = importInProcess({ solution: { importAnswer: json(status, { error: { code: '0x80048d19', message: `answered ${status}` } }) } });
    assert.strictEqual(run.status, 1, String(status));
    assert.strictEqual(importPosts(run), 1, `${status}: one POST, not the six the plain client makes`);
    assert.strictEqual(run.state.imports.length, 1);
    const out = JSON.parse(run.lines[0]);
    assert.deepStrictEqual([out.ok, out.code, out.status], [false, 'CONNECTION_ERROR', status], 'the status and the code survive');
    assert.strictEqual(out.importJobId, run.state.imports[0].ImportJobId, 'the job named is the job the platform was given');
    assert.strictEqual(out.error, `HTTP ${status} from ${ORG}/api/data/v9.0/ImportSolution: answered ${status} The request was sent once and was not sent again: the environment may have accepted it. Look up import job ${out.importJobId} (importjobs(${out.importJobId}) in the Web API, or the solution history in Maker) before importing again.`);
    assert.strictEqual(run.stderr.trim(), out.error, 'stderr says the same');
    assert.strictEqual(run.state.jobReads.length, 1, 'the job\'s log was read once, for what it says');
  }
});

test('PROCESS: an import whose request got no answer is not sent again either — one POST — and the failure names the job; a platform that refuses it (400) is not told to look anything up', () => {
  const lost = importInProcess({ platform: { failures: [{ pathIncludes: '/ImportSolution', error: 'Request timed out' }] } });
  assert.strictEqual(lost.status, 1);
  assert.strictEqual(importPosts(lost), 1);
  const out = JSON.parse(lost.lines[0]);
  assert.strictEqual(out.code, 'CONNECTION_ERROR');
  assert.ok(!('status' in out), 'no answer, no status');
  assert.match(out.error, /ImportSolution got no answer \(Request timed out\)\. It was not sent again/);
  assert.strictEqual(out.error.split('Look up import job').length, 2, 'the job is named once');
  assert.match(out.importJobId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  const refused = importInProcess({ solution: { importAnswer: json(400, { error: { message: 'the import was refused' } }) } });
  const refusedOut = JSON.parse(refused.lines[0]);
  assert.strictEqual(refusedOut.error, `HTTP 400 from ${ORG}/api/data/v9.0/ImportSolution: the import was refused`);
  assert.strictEqual(refusedOut.status, 400);
});

test('PROCESS: ExportSolution and StageSolution are sent once too — a gateway\'s answer after the platform took the request is the failure, not a reason to send it again', () => {
  const exported = runScript('solution-settings.js', ['template', '--env', ORG, '--solution', 'ContosoDemo', '--out', inRunDir('settings.json')], {
    platform: { solution: { ...STAGE_CONFIG.solution, exportAnswer: json(504, { error: { message: 'gateway timeout' } }) } },
  });
  assert.strictEqual(exported.status, 1);
  assert.strictEqual(exported.state.exports.length, 1, 'one ExportSolution');
  assert.deepStrictEqual([JSON.parse(exported.lines[0]).code, JSON.parse(exported.lines[0]).status], ['CONNECTION_ERROR', 504]);
  const staged = runScript('solution-settings.js', ['template', '--package', inRunDir('solution.zip'), '--env', ORG, '--out', inRunDir('settings.json')], {
    platform: { solution: { ...STAGE_CONFIG.solution, stage: { answer: json(503, { error: { message: 'service unavailable' } }) } } },
    files: { 'solution.zip': ZIP },
  });
  assert.strictEqual(staged.status, 1);
  assert.strictEqual(staged.state.staged.length, 1, 'one StageSolution');
  assert.deepStrictEqual([JSON.parse(staged.lines[0]).code, JSON.parse(staged.lines[0]).status], ['CONNECTION_ERROR', 503]);
});

test('PROCESS: an import refused while another operation held the lock is sent again — exit 0, one line naming the job that ran, the sends and each refusal — and no secret or connection id is anywhere', () => {
  const run = importInProcess({ platform: { instantWaits: true }, solution: { importRefusals: [LOCK_REFUSAL, LOCK_REFUSAL] } });
  assert.strictEqual(run.status, 0, run.stderr);
  const [accepted] = run.state.imports;
  const refusedIds = run.state.refusedImports.map((body) => body.ImportJobId);
  assert.strictEqual(refusedIds.length, 2, 'two sends were refused');
  assert.strictEqual(run.state.imports.length, 1, 'one import was taken');
  assert.strictEqual(importPosts(run), 3);
  assert.deepStrictEqual(JSON.parse(run.lines[0]), {
    ok: true,
    source: 'sdk',
    importJobId: accepted.ImportJobId,
    applied: { environmentVariables: ['new_Secret'], connectionReferences: [] },
    importAttempts: 3,
    importRefusals: [
      { importJobId: refusedIds[0], status: 429, code: '0x8004F064', waitedMs: 10000 },
      { importJobId: refusedIds[1], status: 429, code: '0x8004F064', waitedMs: 20000 },
    ],
  });
  assert.deepStrictEqual(run.state.waits, [10000, 20000], 'the script waited as it says — the waits it asked for, which the preload did not really wait');
  assert.strictEqual(run.stderr, '');
  noSecrets(run);
  assertPrintsNone(run, [SECRET, CONNECTION_ID]);
});

test('PROCESS: five refusals in a row end the run — exit 1, one ok:false line with the count, the last job and each refused one, the same words on stderr — and nothing is imported', () => {
  const run = importInProcess({ platform: { instantWaits: true }, solution: { importRefusals: Array.from({ length: 5 }, () => LOCK_REFUSAL) } });
  assert.strictEqual(run.status, 1);
  const out = JSON.parse(run.lines[0]);
  const ids = run.state.refusedImports.map((body) => body.ImportJobId);
  assert.strictEqual(ids.length, 5);
  assert.deepStrictEqual([out.ok, out.code, out.status, out.importJobId, out.importAttempts], [false, 'CONNECTION_ERROR', 429, ids[4], 5]);
  assert.deepStrictEqual(out.importRefusals.map((r) => [r.importJobId, r.waitedMs]), ids.slice(0, 4).map((id, i) => [id, [10000, 20000, 40000, 60000][i]]));
  assert.strictEqual(out.error, `HTTP 429 from ${ORG}/api/data/v9.0/ImportSolution: ${LOCK_REFUSAL.message} ${SENT_AGAIN(5, '10 s, 20 s, 40 s, 60 s')} It sends at most 5 times: run the import again when the other operation has finished.`);
  assert.strictEqual(run.stderr.trim(), out.error, 'stderr says the same');
  assert.deepStrictEqual(run.state.waits, [10000, 20000, 40000, 60000]);
  assert.strictEqual(importPosts(run), 5);
  assert.strictEqual(run.state.imports.length, 0);
  assert.ok(!('fallback' in out), 'pac was not asked');
  noSecrets(run);
});

test('PROCESS: a refusal whose job exists is not sent again — exit 1, the line a refused import always had, with no count', () => {
  const run = importInProcess({ platform: { instantWaits: true }, solution: { importRefusals: [LOCK_REFUSAL], jobLogAnswer: json(200, { importjobid: 'x' }) } });
  assert.strictEqual(run.status, 1);
  assert.strictEqual(importPosts(run), 1);
  const out = JSON.parse(run.lines[0]);
  assert.deepStrictEqual(out, { ok: false, error: `HTTP 429 from ${ORG}/api/data/v9.0/ImportSolution: ${LOCK_REFUSAL.message}`, code: 'CONNECTION_ERROR', status: 429, importJobId: run.state.refusedImports[0].ImportJobId });
  assert.deepStrictEqual(run.state.waits, [10000], 'the proof is read after the wait: this is the one wait that came to nothing');
});

test('PROCESS: an import refused with 0x80071151 is sent again when its job proves nothing was applied — exit 0, one line with each refusal and its proof — and is not when it does not — exit 1, the sentence that says why on stdout and on stderr', () => {
  const sent = importInProcess({ platform: { instantWaits: true }, solution: { importRefusals: [CONCURRENCY_REFUSAL], jobLogAnswer: jobAnswer(jobRow(LOGS.refused())) } });
  assert.strictEqual(sent.status, 0, sent.stderr);
  const [accepted] = sent.state.imports;
  const [refusedId] = sent.state.refusedImports.map((body) => body.ImportJobId);
  assert.strictEqual(importPosts(sent), 2);
  assert.deepStrictEqual(JSON.parse(sent.lines[0]), {
    ok: true,
    source: 'sdk',
    importJobId: accepted.ImportJobId,
    applied: { environmentVariables: ['new_Secret'], connectionReferences: [] },
    importAttempts: 2,
    importRefusals: [{ importJobId: refusedId, status: 429, code: '0x80071151', waitedMs: 10000, proof: 'job-refused-before-any-component' }],
  });
  assert.deepStrictEqual(sent.state.waits, [10000]);
  assert.strictEqual(sent.stderr, '');
  noSecrets(sent);
  assertPrintsNone(sent, [SECRET, CONNECTION_ID]);

  const stopped = importInProcess({ platform: { instantWaits: true }, solution: { importRefusals: [CONCURRENCY_REFUSAL], jobLogAnswer: jobAnswer(jobRow(LOGS.running(), { completed: false })) } });
  assert.strictEqual(stopped.status, 1);
  assert.strictEqual(importPosts(stopped), 1);
  const jobId = stopped.state.refusedImports[0].ImportJobId;
  const out = JSON.parse(stopped.lines[0]);
  assert.deepStrictEqual(out, {
    ok: false,
    error: `HTTP 429 from ${ORG}/api/data/v9.0/ImportSolution: ${CONCURRENCY_REFUSAL.message} ${NOT_PROVEN('its import job is not finished (completedon is empty)', jobId)}`,
    code: 'CONNECTION_ERROR',
    status: 429,
    importJobId: jobId,
  });
  assert.strictEqual(stopped.stderr.trim(), out.error, 'stderr says the same');
  assert.deepStrictEqual(stopped.state.waits, [], 'nothing was waited for');
  noSecrets(stopped);
});

test('PROCESS: five refusals with 0x80071151 in a row end the run — exit 1, one ok:false line whose last sentence says what to look up before the import is run again, the same words on stderr — and nothing is imported', () => {
  const run = importInProcess({ platform: { instantWaits: true }, solution: { importRefusals: Array.from({ length: 5 }, () => CONCURRENCY_REFUSAL) } });
  assert.strictEqual(run.status, 1);
  const out = JSON.parse(run.lines[0]);
  const ids = run.state.refusedImports.map((body) => body.ImportJobId);
  assert.strictEqual(ids.length, 5);
  assert.deepStrictEqual([out.ok, out.code, out.status, out.importJobId, out.importAttempts], [false, 'CONNECTION_ERROR', 429, ids[4], 5]);
  assert.deepStrictEqual(out.importRefusals.map((r) => [r.importJobId, r.waitedMs, r.proof]), ids.slice(0, 4).map((id, i) => [id, [10000, 20000, 40000, 60000][i], 'job-absent']));
  assert.strictEqual(out.error, `HTTP 429 from ${ORG}/api/data/v9.0/ImportSolution: ${CONCURRENCY_REFUSAL.message} ${SENT_AGAIN_404(5, '10 s, 20 s, 40 s, 60 s')} ${NOT_LOOKED_AT(ids[4])}`);
  assert.ok(!out.error.includes(RUN_AGAIN), 'the advice that nothing has proven safe is not given');
  assert.strictEqual(run.stderr.trim(), out.error, 'stderr says the same');
  assert.deepStrictEqual(run.state.waits, [10000, 20000, 40000, 60000]);
  assert.strictEqual(importPosts(run), 5);
  assert.strictEqual(run.state.imports.length, 0);
  assert.deepStrictEqual(run.requests.filter((r) => r.path.includes('/importjobs(')).map((r) => r.search), [...Array(4).fill(PROOF_READ), '?$select=data']);
  assert.ok(!('fallback' in out), 'pac was not asked');
  noSecrets(run);
});

// --- nothing a settings file holds comes back out ------------------------------------------------------------------------------------------------

const LONG_SECRET = 'synthetic-sensitive-value-CDR';
const WITHHELD_WARNING = WITHHELD('warning');

test('PROCESS: a cleanup warning on a FAILED import is cleaned like the message — a secret in the platform\'s answer to the staging delete reaches neither stdout nor stderr', () => {
  const run = importInProcess({
    value: LONG_SECRET,
    solution: {
      deleteStagingAnswer: json(400, { error: { message: `cleanup diagnosis contains ${LONG_SECRET}` } }),
      importAnswer: json(400, { error: { message: 'the import was refused' } }),
    },
  });
  assert.strictEqual(run.status, 1);
  assertPrintsNone(run, [LONG_SECRET], 'failure warnings');
  const out = JSON.parse(run.lines[0]);
  assert.deepStrictEqual(out.warnings, [WITHHELD_WARNING], 'the warning is there, and says it was withheld');
  assert.strictEqual(out.error, `HTTP 400 from ${ORG}/api/data/v9.0/ImportSolution: the import was refused`);
  assert.deepStrictEqual([out.code, out.status], ['CONNECTION_ERROR', 400]);
  assert.ok(out.importJobId);
});

test('PROCESS: the same warning on a SUCCESSFUL import is cleaned too', () => {
  const run = importInProcess({ value: LONG_SECRET, solution: { deleteStagingAnswer: json(400, { error: { message: `cleanup diagnosis contains ${LONG_SECRET}` } }) } });
  assert.strictEqual(run.status, 0, run.stderr);
  assertPrintsNone(run, [LONG_SECRET], 'success warnings');
  assert.deepStrictEqual(JSON.parse(run.lines[0]).warnings, [WITHHELD_WARNING]);
  assert.strictEqual(run.state.imports[0].ComponentParameters[0].value, LONG_SECRET, 'the platform still got the value');
});

// The import in a child process over the fake platform, for ONE variable, `new_Secret`, of `value`: the file gives it `fileType` as its TypeId (none when null), the package's own
// definition — the reply StageSolution gives — says it is of `type`, the platform answers ImportSolution with a 400 that says `message`, and the job's log says `log`.
function importOf(value, { fileType = null, type = '100000005', message = 'An unexpected error occurred.', log } = {}) {
  const settings = JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'new_Secret', Value: value, ...(fileType === null ? {} : { TypeId: fileType }) }], ConnectionReferences: [] });
  return importInProcess({
    settings,
    solution: { stage: { variables: [{ schemaName: 'new_Secret', type }], references: [] }, importAnswer: json(400, { error: { message } }), ...(log === undefined ? {} : { jobLog: log }) },
  });
}
// A failed import's job log whose first failing result says `text`, escaped as the platform writes an attribute.
const xmlEscaped = (text) => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const jobLogSaying = (text) => `<importexportxml succeeded="failure"><result result="failure" errortext="${xmlEscaped(text)}"/></importexportxml>`;
const IMPORT_URL = `${ORG}/api/data/v9.0/ImportSolution`;

test('PROCESS: a secret has no length floor, and the PACKAGE says what is secret — a five-character secret that the file gives no type, or calls Text, is not printed, on stdout or stderr', () => {
  for (const fileType of [null, 100000000, '100000000', 'secret', 100000005]) {
    const run = importOf('PIN42', { fileType, message: "Value 'PIN42' was refused" });
    assert.strictEqual(run.status, 1, String(fileType));
    assert.strictEqual(importPosts(run), 1, `the real bundle got through staging and sent the import (file type ${fileType})`);
    assertPrintsNone(run, ['PIN42'], `a short secret, file type ${fileType}`);
    const out = JSON.parse(run.lines[0]);
    assert.strictEqual(out.error, `HTTP 400 from ${IMPORT_URL}: ${WITHHELD('message')}`, String(fileType));
    assert.strictEqual(run.stderr.trim(), out.error);
    assert.strictEqual(out.status, 400);
  }
  // The package says Text, and the file says nothing or Text: a value of five characters is shown (it is a word as much as a value), one of six is replaced where it is quoted.
  for (const fileType of [null, 100000000]) {
    assert.strictEqual(JSON.parse(importOf('PIN42', { fileType, type: '100000000', message: "Value 'PIN42' was refused" }).lines[0]).error, `HTTP 400 from ${IMPORT_URL}: Value 'PIN42' was refused`, String(fileType));
    assert.strictEqual(JSON.parse(importOf('PIN420', { fileType, type: '100000000', message: "Value 'PIN420' was refused" }).lines[0]).error, `HTTP 400 from ${IMPORT_URL}: Value '<redacted>' was refused`, String(fileType));
  }
  // The package says Text and the file says Secret: a maker who marks a value secret is believed.
  const marked = importOf('PIN42', { fileType: 100000005, type: '100000000', message: "Value 'PIN42' was refused" });
  assertPrintsNone(marked, ['PIN42'], 'a value the file marks secret');
  assert.strictEqual(JSON.parse(marked.lines[0]).error, `HTTP 400 from ${IMPORT_URL}: ${WITHHELD('message')}`);
});

// Every spelling is a process of its own: a message that holds one spelling cannot hide that another is not recognised. The spellings are written out in helpers/value-spellings.js,
// independently of the script, which does not list spellings: it decodes the text.
for (const [valueName, value] of [['a value with a double quote', VALUES.quote], ['a value with every kind of character', VALUES.mixed]]) {
  for (const [name, spelled] of spellingsOfValue(value)) {
    test(`PROCESS: ${valueName}, quoted as ${name}, is not printed — in a run of its own`, () => {
      const run = importOf(value, { message: `Value ${spelled} was refused` });
      assert.strictEqual(run.status, 1);
      assert.strictEqual(importPosts(run), 1, 'the import was sent and the platform answered');
      assertPrintsNone(run, [value, spelled], `${valueName} as ${name}`);
      assert.strictEqual(JSON.parse(run.lines[0]).error, `HTTP 400 from ${IMPORT_URL}: ${WITHHELD('message')}`);
    });
  }
}

test('PROCESS: a JSON \\u0022 for a double quote — the escape a list of spellings is likeliest to miss — does not let the secret through, in the platform\'s answer and in the job\'s log', () => {
  const secret = 'cedar-"pine"-token';
  const escaped = 'cedar-\\u0022pine\\u0022-token';
  const run = importOf(secret, { message: `Value "${escaped}" was refused` });
  assert.strictEqual(run.status, 1);
  assert.strictEqual(importPosts(run), 1);
  assertPrintsNone(run, [secret, escaped], 'an escaped quote');
  assert.strictEqual(JSON.parse(run.lines[0]).error, `HTTP 400 from ${IMPORT_URL}: ${WITHHELD('message')}`);
  const inLog = importOf(secret, { log: jobLogSaying(`Value "${escaped}" was refused`) });
  assertPrintsNone(inLog, [secret, escaped], 'an escaped quote in the job log');
  assert.ok(JSON.parse(inLog.lines[0]).error.endsWith(`says: ${WITHHELD("the job log's text")}`));
});

test('PROCESS: the reason pac was asked and what pac says are cleaned — a secret the SDK quoted when it could not read the staging, and one pac echoed in two spellings', () => {
  const failing = [
    'Connected as maker@contoso.onmicrosoft.com',
    'Microsoft PowerPlatform CLI',
    'Version: 2.12.2+ga6b1ffa (.NET 10.0.12)',
    '',
    `Error: bad value ${JSON.stringify('synthetic-"secret"-CDR')} and synthetic-"secret"-CDR`,
  ].join('\r\n');
  const run = importInProcess({
    value: 'synthetic-"secret"-CDR',
    solution: { stage: { answer: json(200, { StageSolutionResults: { StageSolutionStatus: 'synthetic-"secret"-CDR', SolutionComponentsDetails: [] } }) } },
    pac: { responses: [{ match: ['solution', 'import'], status: 1, stdout: failing }] },
  });
  assert.strictEqual(run.status, 1);
  assertPrintsNone(run, ['synthetic-"secret"-CDR', 'synthetic-\\"secret\\"-CDR'], 'pac and the reason');
  const out = JSON.parse(run.lines[0]);
  assert.deepStrictEqual([out.code, out.fallback.code], ['PAC_FAILED', 'SOLUTION_STAGING_UNREADABLE']);
  assert.strictEqual(out.fallback.message, WITHHELD('message'));
  assert.strictEqual(out.error, `\`pac solution import\` failed (exit 1): ${WITHHELD('text')}`);
});

// What a short value that the file gives and the package does not define, or that nothing was read for, may withhold. The case seen on a real organization: an entry for a name the package does not define, with the value `x` — a
// message that names the entry, and holds no value, was withheld because the letter occurs in "new_Text". The SDK refuses such an entry before it sends anything.
const TEXT_STAGE = { variables: [{ schemaName: 'new_Text', type: '100000000' }], references: [] };
const NOT_IN_PACKAGE = /^importSolution: deploymentSettings does not match the package \u2014 EnvironmentVariables: 'new_NotInPackage' is not a variable of the package\. The package's variables: new_Text; its connection references: none\. Nothing was imported\.$/;

test('PROCESS: an entry for a name the package does not define, with a short value — "x" among them — prints the SDK\'s own account of which entry is wrong, exits 1, and imports nothing', () => {
  for (const value of ['x', 'Text', 'new', 'en', 'true', '1', 'qqq']) {
    const run = importInProcess({
      settings: JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'new_Text', Value: '' }, { SchemaName: 'new_NotInPackage', Value: value }], ConnectionReferences: [] }),
      solution: { stage: TEXT_STAGE },
    });
    assert.strictEqual(run.status, 1, JSON.stringify(value));
    assert.strictEqual(importPosts(run), 0, `${JSON.stringify(value)}: the SDK refused the entry before it sent anything`);
    const out = JSON.parse(run.lines[0]);
    assert.strictEqual(out.code, 'INVALID_ARGUMENT', JSON.stringify(value));
    assert.match(out.error, NOT_IN_PACKAGE, `a value of ${JSON.stringify(value)}`);
    assert.strictEqual(run.stderr.trim(), out.error, 'stderr says the same');
    assert.strictEqual(run.state.imports.length, 0);
  }
});

// A value of four or five characters that the package does not define is not known to be anything: it is looked for as a whole word. The whole-word rule is what lets a message that names the entry
// through — and what still holds a value back when a text has it standing alone.
test('PROCESS: a short value that is not known to be anything is still withheld where a text has it as a whole word — the platform\'s answer that quotes it, and nothing else of the message', () => {
  const run = importInProcess({
    settings: JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'new_NotInPackage', Value: 'none' }], ConnectionReferences: [] }),
    solution: { stage: TEXT_STAGE },
  });
  // The SDK's own words say "its connection references: none": the value is a whole word in them, and it is a word as much as a value, so the message is withheld — the cost the rule leaves.
  assert.strictEqual(JSON.parse(run.lines[0]).error, WITHHELD('message'));
  assert.strictEqual(run.status, 1);
  assertPrintsNone(run, ['none'], 'a value that is a whole word of the SDK\'s message');
  // The same value for a variable the package defines as Text is not hidden at all (it is known not to be a secret, and shorter than six characters).
  const known = importInProcess({
    settings: JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'new_Text', Value: 'none' }], ConnectionReferences: [] }),
    solution: { stage: TEXT_STAGE, importAnswer: json(400, { error: { message: 'the value none was refused' } }) },
  });
  assert.strictEqual(JSON.parse(known.lines[0]).error, `HTTP 400 from ${IMPORT_URL}: the value none was refused`);
});

// The pac fallback reads no package: every variable is of unknown type there. A value of `1` or `en` is a word as much as a value — and the plugin's own "(exit 1)" and the SDK's sentence for the feature
// ("deployment") are not another party's text, so neither is withheld for it.
const PAC_FAILING = [
  'Connected as maker@contoso.onmicrosoft.com',
  'Microsoft PowerPlatform CLI',
  'Version: 2.12.2+ga6b1ffa (.NET 10.0.12)',
  '',
  "Error: Failed to deserialize the deployment settings. Required property 'UserEmail' not found in JSON. Path 'Workflows[0]', line 22, position 5.",
].join('\r\n');
const FEATURE_SENTENCE = 'importSolution: deploymentSettings is not a deployment-settings file this SDK applies \u2014 deploymentSettings.Workflows is a pac feature this SDK does not apply: only an empty list is accepted. Nothing was imported.';

test('PROCESS: the pac fallback prints the reason pac was asked, and pac\'s exit status, for a short Text value — "1" or "en" — whether pac fails or succeeds', () => {
  for (const value of ['1', 'en']) {
    const settings = JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'new_Flag', Value: value }], ConnectionReferences: [], Workflows: [{ WorkflowId: '1' }] });
    const solution = { stage: { variables: [{ schemaName: 'new_Flag', type: '100000000' }], references: [] } };
    const failed = importInProcess({ settings, solution, pac: { responses: [{ match: ['solution', 'import'], status: 1, stdout: PAC_FAILING }] } });
    assert.strictEqual(failed.status, 1, `a value of ${value}`);
    assert.deepStrictEqual(failed.requests, [], 'the SDK refused the file before any request: pac read the package, not the plugin');
    const out = JSON.parse(failed.lines[0]);
    assert.strictEqual(out.code, 'PAC_FAILED');
    assert.strictEqual(out.error, "`pac solution import` failed (exit 1): Error: Failed to deserialize the deployment settings. Required property 'UserEmail' not found in JSON. Path 'Workflows[0]', line 22, position 5.", `a value of ${value}`);
    assert.deepStrictEqual(out.fallback, { code: 'INVALID_ARGUMENT', message: FEATURE_SENTENCE }, `a value of ${value}`);
    assert.strictEqual(failed.stderr.trim(), out.error);

    const ok = importInProcess({ settings, solution, pac: { responses: [{ match: ['solution', 'import'], stdout: 'Solution Imported successfully.\n' }] } });
    assert.strictEqual(ok.status, 0, `${value}: ${ok.stderr}`);
    const done = JSON.parse(ok.lines[0]);
    assert.deepStrictEqual([done.ok, done.source], [true, 'pac']);
    assert.deepStrictEqual(done.fallback, { code: 'INVALID_ARGUMENT', message: FEATURE_SENTENCE }, `a value of ${value}`);
    assert.deepStrictEqual(done.applied, { environmentVariables: ['new_Flag'], connectionReferences: [] });
  }
});

// A short secret — what a package that says Secret, or a file that does, may hold — is hidden by SUBSTRING at any length: the spellings the decoders do not read, and a value glued to words, are not a way
// round it. (The same texts print a short value that nothing says is a secret: see AGENTS.md for what that leaves.) Each is a process of its own.
for (const [name, spelled] of [['in an octal escape', '\\042PIN42\\042'], ['in a legacy %u escape', '%u0022PIN42%u0022'], ['in an XML reference with no semicolon', '&#x22PIN42&#x22'], ['glued to words', 'ValuePIN42wasRefused']]) {
  test(`PROCESS: a five-character secret — the package says Secret — is not printed when the platform quotes it ${name}, nor when only the file says Secret`, () => {
    const byPackage = importOf('PIN42', { message: `Value ${spelled} was refused` });
    assert.strictEqual(byPackage.status, 1);
    assert.strictEqual(importPosts(byPackage), 1, 'the import was sent and the platform answered');
    assertPrintsNone(byPackage, ['PIN42'], `the package says Secret, ${name}`);
    assert.strictEqual(JSON.parse(byPackage.lines[0]).error, `HTTP 400 from ${IMPORT_URL}: ${WITHHELD('message')}`);
    const byFile = importOf('PIN42', { fileType: 100000005, type: '100000000', message: `Value ${spelled} was refused` });
    assertPrintsNone(byFile, ['PIN42'], `the file says Secret, ${name}`);
    assert.strictEqual(JSON.parse(byFile.lines[0]).error, `HTTP 400 from ${IMPORT_URL}: ${WITHHELD('message')}`);
  });
}

test('PROCESS: pac\'s header is not in a failure — the Error line is, and the signed-in account, the version and the links are not', () => {
  const failing = [
    'Connected as maker@contoso.onmicrosoft.com',
    'Connected to... Contoso Maker',
    'Microsoft PowerPlatform CLI',
    'Version: 2.12.2+ga6b1ffa (.NET 10.0.12)',
    'Online documentation: https://aka.ms/PowerPlatformCLI',
    'Feedback, Suggestions, Issues: https://github.com/microsoft/powerplatform-build-tools/discussions',
    '',
    "Error: Failed to deserialize the deployment settings. Required property 'UserEmail' not found in JSON. Path 'Workflows[0]', line 22, position 5.",
  ].join('\r\n');
  const run = importInProcess({
    settings: JSON.stringify({ EnvironmentVariables: [], ConnectionReferences: [], Workflows: [{ WorkflowId: '1' }] }),
    pac: { responses: [{ match: ['solution', 'import'], status: 1, stdout: failing }] },
  });
  assert.strictEqual(run.status, 1);
  const out = JSON.parse(run.lines[0]);
  assert.strictEqual(out.error, "`pac solution import` failed (exit 1): Error: Failed to deserialize the deployment settings. Required property 'UserEmail' not found in JSON. Path 'Workflows[0]', line 22, position 5.");
  assertPrintsNone(run, ['maker@contoso.onmicrosoft.com', 'Contoso Maker', 'PowerPlatform CLI', '2.12.2', 'aka.ms', 'discussions'], 'the pac header');
});

// --- pac imports what the run read ----------------------------------------------------------------------------------------------------------------
// The run reads the settings file ONCE — the sanitizer is built from it, the SDK is given what it parsed, `applied` names its entries — and the staging that comes before an import takes as long as the platform takes. A file a
// maker (or a deployment) saves meanwhile is a file the run never looked at: read by its path, its values would reach pac, and pac's own words about them, with no sanitizer that knows them. So pac is given a private copy of the
// BYTES the run read, in a folder of the run's own that is removed afterwards. An edit made during the run is neither applied nor printed.
const SECRET_OLD = 'synthetic-before-stage-secret-736';
const SECRET_NEW = 'synthetic-after-stage-secret-736';
// A staging reply that lists a variable twice: the SDK will not guess which definition is meant and refuses it (SOLUTION_STAGING_UNREADABLE), so pac imports.
const DUPLICATE_SECRET_STAGE = { variables: [{ schemaName: 'new_Secret', type: '100000005' }, { schemaName: 'new_Secret', type: '100000005' }] };
const secretOnly = (value) => JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'new_Secret', Value: value, TypeId: 100000005 }], ConnectionReferences: [] });
// An import that falls back to pac while the file changes: the platform saves `edited` over settings.json when StageSolution arrives. The fake pac says, in its error, the value of the file it READS, and records what that file held.
function importEditedDuringStaging({ original, edited, pacStatus }) {
  return runScript('solution-settings.js', ['import', '--env', ORG, '--package', inRunDir('solution.zip'), '--settings', inRunDir('settings.json')], {
    platform: {
      solution: { packageBase64: ZIP.toString('base64'), stage: DUPLICATE_SECRET_STAGE },
      hooks: [{ method: 'POST', pathIncludes: '/StageSolution', writeFile: 'settings.json', content: secretOnly(edited) }],
    },
    pac: { responses: [{ match: ['solution', 'import'], status: pacStatus, stderr: pacStatus === 0 ? '' : "Error: rejected Value '{{value}}' from the settings file.", echoValueOf: '--settings-file', snapshot: ['--settings-file'] }] },
    files: { 'solution.zip': ZIP, 'settings.json': secretOnly(original) },
    read: ['settings.json'],
  });
}
const pacsFile = (run) => run.pacCalls[0].args[run.pacCalls[0].args.indexOf('--settings-file') + 1];

test('PROCESS: a settings file that changes while the SDK stages — and the SDK refuses, so pac imports — is not read again: pac is given the bytes the run read, in a folder of its own, and the secret the file was saved with is in no output', () => {
  const run = importEditedDuringStaging({ original: SECRET_OLD, edited: SECRET_NEW, pacStatus: 1 });
  assert.strictEqual(run.status, 1);
  assert.strictEqual(run.pacCalls.length, 1);
  assert.strictEqual(JSON.parse(run.outputs['settings.json']).EnvironmentVariables[0].Value, SECRET_NEW, 'the maker\'s edit is on disk, as saved');
  assert.strictEqual(JSON.parse(run.pacCalls[0].snapshots['--settings-file'].text).EnvironmentVariables[0].Value, SECRET_OLD, 'and is not what pac read: pac read the bytes the run read');
  // A child process of its own: the folder the copy was made in is the maker's (lib/temp-workspace.js) — in the plugin's own folder of the temp folder, named for the pid of that process.
  assert.strictEqual(path.dirname(path.dirname(pacsFile(run))), pluginFolderOf(), 'in the plugin\'s own folder');
  assert.match(path.basename(path.dirname(pacsFile(run))), RECORDED_WORK_FOLDER, 'in a folder of the run\'s own');
  assert.strictEqual(path.basename(pacsFile(run)), 'settings.json');
  assert.strictEqual(fs.existsSync(path.dirname(pacsFile(run))), false, 'removed after pac ran');
  assert.match(JSON.parse(run.lines[0]).error, /withheld/, 'pac quoted the value it read, which the sanitizer knows');
  assertPrintsNone(run, [SECRET_OLD, SECRET_NEW], 'a settings value');
});

test('PROCESS: and `applied` names the entries of the file pac was given — a file saved empty while the SDK staged does not change what the run says it applied', () => {
  const run = importEditedDuringStaging({ original: SECRET_OLD, edited: '', pacStatus: 0 });
  assert.strictEqual(run.status, 0);
  const consumed = JSON.parse(run.pacCalls[0].snapshots['--settings-file'].text);
  assert.strictEqual(consumed.EnvironmentVariables[0].Value, SECRET_OLD, 'pac was given the bytes the run read');
  assert.strictEqual(JSON.parse(run.outputs['settings.json']).EnvironmentVariables[0].Value, '', 'the file on disk is the maker\'s edit');
  const filledInWhatPacGot = consumed.EnvironmentVariables.filter((entry) => entry.Value !== '').map((entry) => entry.SchemaName);
  assert.deepStrictEqual(JSON.parse(run.lines[0]).applied.environmentVariables, filledInWhatPacGot, 'applied describes exactly what pac was given');
  assert.strictEqual(fs.existsSync(path.dirname(pacsFile(run))), false);
});

test('PROCESS control: a settings file that does not change is redacted on the same pac route — the secret pac quotes is withheld', () => {
  const run = importEditedDuringStaging({ original: SECRET_OLD, edited: SECRET_OLD, pacStatus: 1 });
  assert.strictEqual(run.status, 1);
  assert.strictEqual(run.pacCalls.length, 1);
  assertPrintsNone(run, [SECRET_OLD], 'the secret');
  assert.match(JSON.parse(run.lines[0]).error, /withheld/);
});

test('PROCESS: the private copy is its owner\'s alone where the system has permission bits — a folder of 0700 and a file of 0600', () => {
  const run = importEditedDuringStaging({ original: SECRET_OLD, edited: SECRET_OLD, pacStatus: 0 });
  assert.strictEqual(run.status, 0);
  const snapshot = run.pacCalls[0].snapshots['--settings-file'];
  // Windows has no permission bits to read (the folder is in the user's own temp folder): the bits are asserted where there are some.
  if (process.platform !== 'win32') assert.deepStrictEqual([snapshot.mode, snapshot.dirMode], ['600', '700']);
  assert.ok(snapshot.bytes > 0);
});

test('REAL BUNDLE: the copy is created exclusively with mode 0600 — as its owner\'s alone — in a folder made for the run (mkdtemp), once and nowhere else: the real private-folder code, which private-folder.test.js pins step by step and solution-settings-snapshot.test.js checks against the operating system', async (t) => {
  const realOpen = fs.openSync;
  const made = [];
  fs.openSync = (file, flags, mode, ...rest) => {
    if (path.basename(String(file)) === 'settings.json' && WORK_FOLDER.test(path.basename(path.dirname(String(file))))) made.push(['open', flags, mode && mode.toString(8)]);
    return realOpen(file, flags, mode, ...rest);
  };
  t.after(() => { fs.openSync = realOpen; });
  const { http } = world();
  const f = files({ Workflows: [{ WorkflowId: 'x' }] });
  const result = await ss.runImport(importRequest(f), { http, pac: { spawn: () => ({ status: 0, stdout: 'Solution Imported successfully.', stderr: '' }) }, importJobId: JOB, privateFile: plainPrivateFile.realCreatePrivateFile });
  assert.strictEqual(result.source, 'pac');
  // `wx` fails when the name exists — the folder is new, so it never does — instead of writing through a link or over a file somebody else put there.
  assert.deepStrictEqual(made, [['open', 'wx', '600']]);
});

// What a scanner does to a folder that was just written: every removal of it fails (`holdingWorkFolders`, above). The copy holds the settings file's values, so what cannot be removed is at least EMPTIED, and the folder is said.
test('REAL BUNDLE: a copy of the settings that cannot be removed is emptied and said — its path, and that it can hold secrets — as a warning on a pac run that succeeded, and the note is not withheld whatever value the file holds', async (t) => {
  const held = holdingWorkFolders(t);
  const { http } = world();
  // "copy" and "empty" are words of the note; the value of an entry the package does not define is looked for as a whole word, so a sanitizer that looked at the note would withhold it.
  const f = files({ EnvironmentVariables: [{ SchemaName: 'new_Text', Value: 'copy' }, { SchemaName: 'new_More', Value: 'emptied' }], ConnectionReferences: [], Workflows: [{ WorkflowId: 'x' }] });
  const result = await ss.runImport(importRequest(f), { http, pac: { spawn: () => ({ status: 0, stdout: 'Solution Imported successfully.', stderr: '' }) }, importJobId: JOB });
  assert.strictEqual(result.source, 'pac');
  const [left] = held.dirs;
  assert.deepStrictEqual(entriesOf(left), ['settings.json']);
  assert.strictEqual(fs.readFileSync(path.join(left, 'settings.json'), 'utf8'), '', 'what could not be removed holds no value');
  assertMadeByTheMaker(left, { pid: process.pid }); // and what stays is in the plugin's own folder, recorded and lent, for a later run's sweep
  assert.deepStrictEqual(result.warnings, [`The folder ${left} could not be removed (EBUSY); it holds the copy of the settings file that pac was given, which can hold secrets (emptied, so it keeps no value). Delete it.`]);
});

test('REAL BUNDLE: and beside the failure of a pac run that did not succeed — with the pac failure\'s own code and reason — and nothing of what the file held', async (t) => {
  const held = holdingWorkFolders(t);
  const { http } = world();
  const f = files({ Workflows: [{ WorkflowId: 'x' }] });
  await assert.rejects(ss.runImport(importRequest(f), { http, pac: { spawn: () => ({ status: 1, stdout: '', stderr: `Error: rejected ${SECRET}` }) }, importJobId: JOB }), (err) => {
    const [left] = held.dirs;
    assert.strictEqual(err.code, 'PAC_FAILED');
    assert.strictEqual(err.fallback.code, 'INVALID_ARGUMENT');
    const described = ss.describeFailure(err);
    assert.deepStrictEqual(described.warnings, [`The folder ${left} could not be removed (EBUSY); it holds the copy of the settings file that pac was given, which can hold secrets (emptied, so it keeps no value). Delete it.`]);
    assert.match(described.error, /^`pac solution import` failed \(exit 1\): /);
    assert.ok(!JSON.stringify(described).includes(SECRET));
    return true;
  });
});

test('REAL BUNDLE: a copy that is held for a moment is removed by the bounded retry on Windows — no warning — and one that cannot even be emptied says that it may still hold the values', async (t) => {
  const held = holdingWorkFolders(t, { times: 2, platform: 'win32' });
  const { http } = world();
  const f = files({ Workflows: [{ WorkflowId: 'x' }] });
  const result = await ss.runImport(importRequest(f), { http, pac: { spawn: () => ({ status: 0, stdout: 'Solution Imported successfully.', stderr: '' }) }, importJobId: JOB });
  assert.ok(!('warnings' in result));
  assert.strictEqual(held.calls, 3);
  assert.strictEqual(fs.existsSync([...held.dirs][0]), false);
});

test('REAL BUNDLE: the same sentences hold when the file cannot be emptied either — the note says the values may still be there', async (t) => {
  const stays = holdingWorkFolders(t);
  const realWrite = fs.writeFileSync;
  let blocked = false;
  fs.writeFileSync = (file, data, options) => {
    // The first write of the private copy is allowed; emptying it afterwards (a write of nothing) is what a scanner holding the file blocks.
    if (path.basename(String(file)) === 'settings.json' && WORK_FOLDER.test(path.basename(path.dirname(String(file)))) && data === '') {
      blocked = true;
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    return realWrite(file, data, options);
  };
  t.after(() => { fs.writeFileSync = realWrite; });
  const { http } = world();
  const f = files({ Workflows: [{ WorkflowId: 'x' }] });
  const result = await ss.runImport(importRequest(f), { http, pac: { spawn: () => ({ status: 0, stdout: 'Solution Imported successfully.', stderr: '' }) }, importJobId: JOB });
  const [left] = stays.dirs;
  assert.ok(blocked);
  assert.deepStrictEqual(result.warnings, [`The folder ${left} could not be removed (EBUSY); it holds the copy of the settings file that pac was given, which can hold secrets (it could not be emptied either, so it may still hold values). Delete it.`]);
});

// --- the access token is not in what a failure prints -----------------------------------------------------------------------------------------------
// The settings file's sanitizer takes the FILE's values out of what the platform says; the access token is not one of them. An authorization layer, or a gateway, that rejects a token
// may repeat it — whole, or one part of it — in the body of its answer, and the SDK quotes that body in the message the script prints. The Dataverse client takes the token out of an
// answer that is not a success (lib/sdk-http-client.js), as the Power Apps client does for its own.
const ECHOED_TOKEN = ['syntheticDataverseHeaderPartNotARealCredential', 'syntheticDataversePayloadPartNotARealCredential', 'syntheticDataverseSignaturePartNotARealCredential'].join('.');

test('PROCESS: a Dataverse token that the platform repeats in the answer to the import reaches neither stdout nor stderr — the answer\'s status, code and job survive, and the import is still sent once', () => {
  const run = importInProcess({
    platform: { tokens: { dataverse: ECHOED_TOKEN } },
    solution: { importAnswer: json(403, { error: { code: 'InvalidAuthenticationToken', message: `Rejected bearer ${ECHOED_TOKEN}` } }) },
  });
  assert.strictEqual(run.status, 1);
  assert.strictEqual(importPosts(run), 1);
  const out = JSON.parse(run.lines[0]);
  assert.deepStrictEqual([out.ok, out.code, out.status, out.importJobId], [false, 'CONNECTION_ERROR', 403, run.state.imports[0].ImportJobId]);
  assert.strictEqual(out.error, `HTTP 403 from ${ORG}/api/data/v9.0/ImportSolution: Rejected bearer <token>`);
  assert.strictEqual(run.stderr.trim(), out.error);
  assertPrintsNone(run, [ECHOED_TOKEN, ...ECHOED_TOKEN.split('.')], 'the Dataverse token');
});

test('PROCESS: nor does a part of it, or a transport failure that holds it — in the answer to the import and in the sentence for an import that got no answer', () => {
  const [, payload] = ECHOED_TOKEN.split('.');
  const part = importInProcess({ platform: { tokens: { dataverse: ECHOED_TOKEN } }, solution: { importAnswer: json(401, { error: { message: `the claim ${payload} is not valid` } }) } });
  assert.strictEqual(part.status, 1);
  assert.strictEqual(JSON.parse(part.lines[0]).error.startsWith(`HTTP 401 from ${ORG}/api/data/v9.0/ImportSolution: the claim <token> is not valid`), true, part.lines[0]);
  assertPrintsNone(part, [ECHOED_TOKEN, ...ECHOED_TOKEN.split('.')], 'a part of the Dataverse token');
  const lost = importInProcess({ platform: { tokens: { dataverse: ECHOED_TOKEN }, failures: [{ pathIncludes: '/ImportSolution', error: `socket hang up while sending Authorization: Bearer ${ECHOED_TOKEN}` }] } });
  assert.strictEqual(lost.status, 1);
  assert.match(JSON.parse(lost.lines[0]).error, /ImportSolution got no answer \(socket hang up while sending Authorization: Bearer <token>\)\. It was not sent again/);
  assertPrintsNone(lost, [ECHOED_TOKEN, ...ECHOED_TOKEN.split('.')], 'the Dataverse token in a transport failure');
});

// The log of an import job is read with a request that SUCCEEDED (a 200 answer), so the client hands it back as it came — a success is the caller's data — and the reason the failure quotes out of it is the one place
// such a text reaches an output. A log is the platform's account of components, not an authorization transcript, and no way is known for it to hold a bearer token; but what is printed is scrubbed where it is
// extracted, with every token the run sent, so the guarantee does not rest on that.
test('PROCESS: a token that the import job\'s log repeats is taken out of the reason the failure prints — whole, or in a part — and the rest of the log\'s words stay', () => {
  const [, payload] = ECHOED_TOKEN.split('.');
  const log = `<importexportxml succeeded="failure" status="Import failed"><entities><entity name="new_t"><result result="failure" errorcode="0x80048d19" errortext="rejected ${ECHOED_TOKEN} (the claim ${payload}) for new_t" /></entity></entities></importexportxml>`;
  const run = importInProcess({ platform: { tokens: { dataverse: ECHOED_TOKEN } }, solution: { importAnswer: json(400, { error: { code: '0x80048d19', message: 'the import failed' } }), jobLog: log } });
  assert.strictEqual(run.status, 1);
  const out = JSON.parse(run.lines[0]);
  assert.strictEqual(out.error, `HTTP 400 from ${ORG}/api/data/v9.0/ImportSolution: the import failed The import job's log (importjobs(${out.importJobId})) says: rejected <token> (the claim <token>) for new_t`);
  assert.strictEqual(run.stderr.trim(), out.error);
  assertPrintsNone(run, [ECHOED_TOKEN, ...ECHOED_TOKEN.split('.')], 'the Dataverse token');
  // A log that holds no token is quoted as it was.
  const plain = importInProcess({ platform: { tokens: { dataverse: ECHOED_TOKEN } }, solution: { importAnswer: json(400, { error: { code: '0x80048d19', message: 'the import failed' } }), jobLog: log.replace(ECHOED_TOKEN, 'a value').replace(payload, 'a claim') } });
  assert.strictEqual(JSON.parse(plain.lines[0]).error.endsWith('says: rejected a value (the claim a claim) for new_t'), true, plain.lines[0]);
});

test('PROCESS: a refusal whose Retry-After the five minutes cannot hold ends the run at once — exit 1, the platform\'s refusal and the reason it was not sent again, one send, nothing waited for', () => {
  const run = importInProcess({ platform: { instantWaits: true }, solution: { importRefusals: [{ ...LOCK_REFUSAL, headers: { 'retry-after': '3600' } }] } });
  assert.strictEqual(run.status, 1);
  const out = JSON.parse(run.lines[0]);
  assert.strictEqual(out.error, `HTTP 429 from ${ORG}/api/data/v9.0/ImportSolution: ${LOCK_REFUSAL.message} ${NOT_SENT_AGAIN('3600 s', '0 s')}`);
  assert.deepStrictEqual([out.ok, out.code, out.status, out.importJobId, 'importAttempts' in out], [false, 'CONNECTION_ERROR', 429, run.state.refusedImports[0].ImportJobId, false]);
  assert.strictEqual(run.stderr.trim(), out.error, 'stderr says the same');
  assert.deepStrictEqual(run.state.waits, [], 'it did not wait');
  assert.strictEqual(importPosts(run), 1);
  assert.strictEqual(run.state.imports.length, 0);
  noSecrets(run);
});

test('PROCESS control: the Power Apps client already takes an echoed token out of the same kind of answer — connector.js prints <token>', () => {
  const run = runScript('connector.js', ['operations', '--env', ORG, '--connector-id', 'shared_msnweather', '--connection-id', '00000000000000000000000000000001'], {
    platform: {
      tokens: { powerApps: ECHOED_TOKEN },
      failures: [{ host: 'api.bap.microsoft.com', method: 'GET', status: 400, body: { error: { message: `Rejected bearer ${ECHOED_TOKEN}` } } }],
    },
  });
  assert.strictEqual(run.status, 1);
  assert.ok(!run.stdout.includes(ECHOED_TOKEN) && !run.stderr.includes(ECHOED_TOKEN));
  assert.match(JSON.parse(run.stdout).error, /<token>/);
});

// --- the rest of the contract ----------------------------------------------------------------------------------------------------------------

test('PROCESS: an environment variable\'s value reaches the platform byte for byte — white space around it, a JSON document that ends in a newline, white space alone', () => {
  for (const value of [' {\n  "feature": true\n}\n', '  leading and trailing  ', '   ', 'line one\r\nline two\n']) {
    const run = importInProcess({ settings: JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'new_Url', Value: value }] }) });
    assert.strictEqual(run.status, 0, `${JSON.stringify(value)}: ${run.stderr}`);
    assert.strictEqual(run.state.imports[0].ComponentParameters[0].value, value, JSON.stringify(value));
    assert.deepStrictEqual(JSON.parse(run.lines[0]).applied.environmentVariables, ['new_Url']);
  }
});

test('PROCESS: template without --force does not replace a file that APPEARED while the platform was being waited for — the file is kept, the run fails OUT_EXISTS; with --force it is replaced', () => {
  const mine = '{"EnvironmentVariables":[{"SchemaName":"new_Secret","Value":"filled in meanwhile"}]}';
  const hooks = [{ pathIncludes: '/StageSolution', writeFile: 'settings.json', content: mine }];
  const run = runScript('solution-settings.js', ['template', '--env', ORG, '--solution', 'ContosoDemo', '--out', inRunDir('settings.json')], { platform: { ...STAGE_CONFIG, hooks }, read: ['settings.json'] });
  assert.strictEqual(run.status, 1);
  assert.strictEqual(JSON.parse(run.lines[0]).code, 'OUT_EXISTS');
  assert.match(JSON.parse(run.lines[0]).error, /already exists[\s\S]*--force/);
  assert.strictEqual(run.outputs['settings.json'], mine, 'the file that appeared is untouched');
  assert.ok(run.requests.some((r) => r.path.endsWith('/StageSolution')), 'the work was done: the file appeared during it');
  const forced = runScript('solution-settings.js', ['template', '--env', ORG, '--solution', 'ContosoDemo', '--out', inRunDir('settings.json'), '--force'], { platform: { ...STAGE_CONFIG, hooks }, read: ['settings.json'] });
  assert.strictEqual(forced.status, 0, forced.stderr);
  assert.ok(JSON.parse(forced.outputs['settings.json']).EnvironmentVariables.length > 0 && forced.outputs['settings.json'] !== mine);
});

// The settings file is published under its name by a hard link, and the temporary name it was written under is then removed (lib/safe-fs.js). Two things can go wrong with that on a real machine, and each is a
// process of its own here, with a preload that makes it happen: the temporary name cannot be removed (a scanner holds it), and the file system cannot link at all (FAT, exFAT, some shares).
const HELD_SIBLING = path.resolve(__dirname, 'helpers', 'fake-held-sibling-preload.js');
const NO_HARD_LINKS = path.resolve(__dirname, 'helpers', 'fake-no-hard-links-preload.js');
const requiring = (preload) => ({ NODE_OPTIONS: `--require=${JSON.stringify(preload)}` });
const templateInto = (out, extra = [], env = {}) => runScript('solution-settings.js', ['template', '--package', inRunDir('solution.zip'), '--env', ORG, '--out', out, ...extra], { platform: STAGE_CONFIG, files: { 'solution.zip': ZIP }, env });

test('PROCESS: template whose temporary name cannot be removed after the file was written is a SUCCESS — exit 0, the complete file, a warning naming the leftover — and the next run refuses the file, naming it', () => {
  const folder = tempDir();
  const out = path.join(folder, 'settings.json');
  const first = templateInto(out, [], requiring(HELD_SIBLING));
  assert.strictEqual(first.status, 0, first.stderr);
  const done = JSON.parse(first.lines[0]);
  assert.deepStrictEqual([done.ok, done.source, done.environmentVariables, done.connectionReferences], [true, 'sdk', 2, 1]);
  assert.strictEqual(done.warnings.length, 1);
  const [leftover] = fs.readdirSync(folder).filter((name) => name !== 'settings.json');
  assert.match(leftover, /^\.settings\.json\.\d+\.[0-9a-f]{8}\.tmp$/, 'the temporary name is what is left beside the file');
  assert.ok(done.warnings[0].includes(leftover) && /was written in full, but its temporary name .* could not be removed \(EBUSY\): delete it/.test(done.warnings[0]), done.warnings[0]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).EnvironmentVariables.map((v) => v.SchemaName), ['new_Secret', 'new_Url'], 'the file is complete');
  assert.strictEqual(fs.statSync(out).nlink, 2, 'under two names, until the leftover is removed');
  assert.match(first.stdout, /^[\x00-\x7e\r\n]*$/, 'pure ASCII');
  // The next run — with or without --force — finds a file with a second name, and says where the other name is.
  for (const extra of [[], ['--force']]) {
    const again = templateInto(out, extra);
    assert.strictEqual(again.status, 1, extra.join(' '));
    const refused = JSON.parse(again.lines[0]);
    assert.strictEqual(refused.code, 'UNSAFE_OUTPUT');
    assert.match(refused.error, /it is a hard link \(2 names share this file; one of them is .*the temporary name an earlier write could not remove — delete it\)/);
    assert.ok(refused.error.includes(leftover));
    assert.deepStrictEqual(again.requests, [], 'refused before anything is asked of the environment');
  }
  // Delete the leftover and the same run goes through.
  fs.rmSync(path.join(folder, leftover));
  const third = templateInto(out, ['--force']);
  assert.strictEqual(third.status, 0, third.stderr);
  assert.strictEqual(fs.statSync(out).nlink, 1);
  assert.deepStrictEqual(fs.readdirSync(folder), ['settings.json']);
});

test('PROCESS: template on a file system that cannot make a hard link fails closed without --force — and the message says that --force writes there — and --force writes the file', () => {
  const folder = tempDir();
  const out = path.join(folder, 'settings.json');
  const refused = templateInto(out, [], requiring(NO_HARD_LINKS));
  assert.strictEqual(refused.status, 1);
  const failure = JSON.parse(refused.lines[0]);
  assert.strictEqual(failure.code, 'IO_ERROR');
  assert.match(failure.error, /this file system cannot make a second name for a file \(link failed with EISDIR\)/);
  assert.match(failure.error, /file system that supports hard links \(NTFS, ext4, APFS\)\. Or pass --force: it replaces the file at --out by renaming a finished copy over it, which needs no hard link\.$/);
  assert.deepStrictEqual(fs.readdirSync(folder), [], 'nothing is left: not the file, not the temporary name');
  const forced = templateInto(out, ['--force'], requiring(NO_HARD_LINKS));
  assert.strictEqual(forced.status, 0, forced.stderr);
  assert.deepStrictEqual(fs.readdirSync(folder), ['settings.json']);
  assert.ok(JSON.parse(fs.readFileSync(out, 'utf8')).EnvironmentVariables.length > 0);
});

test('PROCESS: an invalid file whose key holds "this SDK does not apply" is a failure — pac is not asked — while a file that holds a real feature is answered by pac', () => {
  const phrase = 'this SDK does not apply';
  const pac = { responses: [{ match: ['solution', 'import'], stdout: 'Solution Imported successfully.\n' }] };
  for (const settings of [
    JSON.stringify({ ...JSON.parse(FILLED), [phrase]: true }),
    JSON.stringify({ ...JSON.parse(FILLED), [phrase]: true, Workflows: [{ WorkflowId: '1' }] }), // an unknown key is the SDK's first complaint, whatever else the file holds
    JSON.stringify({ EnvironmentVariables: [{ SchemaName: phrase, Value: '' }, { SchemaName: phrase, Value: '' }] }),
  ]) {
    const run = importInProcess({ settings, pac });
    assert.strictEqual(run.status, 1);
    assert.deepStrictEqual(run.pacCalls, [], 'pac is not started');
    const out = JSON.parse(run.lines[0]);
    assert.strictEqual(out.code, 'INVALID_ARGUMENT');
    assert.ok(!('fallback' in out));
    assert.ok(out.error.includes(phrase), 'the SDK\'s complaint quotes the name, as it does for any invalid file');
  }
  const feature = importInProcess({ settings: JSON.stringify({ ...JSON.parse(FILLED), Workflows: [{ WorkflowId: '1' }] }), pac });
  assert.strictEqual(feature.status, 0, feature.stderr);
  assert.strictEqual(JSON.parse(feature.lines[0]).source, 'pac');
  assert.strictEqual(feature.pacCalls.length, 1);
});

// What a failed import's own log looks like (abridged; every value is synthetic): the root says the job failed, and each component that failed has a `result`.
const JOB_LOG = [
  '<importexportxml start="639000000000000000" stop="639000000100000000" progress="100" processed="true" succeeded="failure" status="Import failed">',
  '<solutionManifests><solutionManifest><UniqueName>ContosoDemo</UniqueName><result result="success" errorcode="0x0" errortext="" /></solutionManifest></solutionManifests>',
  `<entities><entity name="new_ticket"><result result="failure" errorcode="0x80048d19" errortext="Could not find connection &apos;${CONNECTION_ID}&apos; for API &apos;shared_sharepointonline&apos;." /></entity></entities>`,
  '</importexportxml>',
].join('\n');

test('PROCESS: a failed import reads its job\'s log once and prints the reason the platform logged — the connection id in it replaced — beside the answer it gave', () => {
  const run = importInProcess({
    settings: FILLED,
    solution: { importAnswer: json(400, { error: { message: 'An unexpected error occurred.' } }), jobLog: JOB_LOG },
  });
  assert.strictEqual(run.status, 1);
  const out = JSON.parse(run.lines[0]);
  assert.strictEqual(out.error, `HTTP 400 from ${ORG}/api/data/v9.0/ImportSolution: An unexpected error occurred. The import job's log (importjobs(${out.importJobId})) says: Could not find connection '<redacted>' for API 'shared_sharepointonline'.`);
  assert.deepStrictEqual(run.state.jobReads, [out.importJobId], 'one read, of the job the import was given');
  assertPrintsNone(run, [CONNECTION_ID], 'the job log');
  // The log is read for the ImportSolution request only: a refusal before it (an entry the package does not hold) reads nothing.
  const refused = importInProcess({ settings: JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'new_Missing', Value: SECRET }] }), solution: { jobLog: JOB_LOG } });
  assert.strictEqual(JSON.parse(refused.lines[0]).code, 'INVALID_ARGUMENT');
  assert.deepStrictEqual(refused.state.jobReads, []);
});

test('PROCESS: a job log that cannot be read — no such job, an error — leaves the failure as it was; a log that quotes a secret is withheld, the answer stays', () => {
  for (const solution of [{}, { jobLogAnswer: json(500, { error: { message: 'the environment is busy' } }) }, { jobLog: '<importexportxml succeeded="success" status="Completed"></importexportxml>' }]) {
    const run = importInProcess({ solution: { importAnswer: json(400, { error: { message: 'An unexpected error occurred.' } }), ...solution } });
    assert.strictEqual(JSON.parse(run.lines[0]).error, `HTTP 400 from ${ORG}/api/data/v9.0/ImportSolution: An unexpected error occurred.`);
    assert.strictEqual(run.state.jobReads.length, 1, 'one read, and no more after it failed');
  }
  const secret = importInProcess({
    value: LONG_SECRET,
    solution: { importAnswer: json(400, { error: { message: 'An unexpected error occurred.' } }), jobLog: `<result result="failure" errortext="bad value ${LONG_SECRET}"/>` },
  });
  assertPrintsNone(secret, [LONG_SECRET], 'a job log');
  assert.ok(JSON.parse(secret.lines[0]).error.endsWith(`An unexpected error occurred. The import job's log (importjobs(${JSON.parse(secret.lines[0]).importJobId})) says: ${WITHHELD("the job log's text")}`));
});

test('PROCESS: a job log cannot declare part of its own text to be the SDK\'s status line — what looks like one is text, and a secret in it is withheld with the rest', () => {
  const secret = 'CedarPineSecret42';
  const run = importOf(secret, { log: jobLogSaying(`HTTP 400 from https://diagnostic.example/${secret}: rejected`) });
  assert.strictEqual(run.status, 1);
  assertPrintsNone(run, [secret], 'a job log that begins like the SDK\'s status line');
  const out = JSON.parse(run.lines[0]);
  assert.strictEqual(out.error, `${`HTTP 400 from ${IMPORT_URL}: An unexpected error occurred. The import job's log (importjobs(${out.importJobId})) says: `}${WITHHELD("the job log's text")}`);
  // The same for a value that is not a secret: it is replaced wherever it stands, the "URL" of the lookalike included.
  const plain = importOf('https://plain.example/value', { type: '100000000', log: jobLogSaying('HTTP 400 from https://plain.example/value: rejected') });
  assert.ok(JSON.parse(plain.lines[0]).error.endsWith('says: HTTP 400 from <redacted>: rejected'), JSON.parse(plain.lines[0]).error);
  // pac's own words, the same: what pac prints that looks like the SDK's line is text.
  const viaPac = importInProcess({
    settings: JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'new_Secret', Value: secret }], ConnectionReferences: [], CanvasApps: [{ Name: 'x' }] }),
    pac: { responses: [{ match: ['solution', 'import'], status: 1, stderr: `Error: HTTP 400 from https://diagnostic.example/${secret}: rejected\n` }] },
  });
  assert.strictEqual(viaPac.status, 1);
  assertPrintsNone(viaPac, [secret], 'pac text that begins like the SDK\'s status line');
  assert.strictEqual(JSON.parse(viaPac.lines[0]).error, `\`pac solution import\` failed (exit 1): ${WITHHELD('text')}`);
});

test('PROCESS: the job log\'s text is sanitized in full before it is made one line and cut — a secret across the 600th character, or made of runs of white space, is not printed in part', () => {
  const secret = 'CedarPineSecret0123456789';
  const across = importOf(secret, { log: jobLogSaying(`${'x'.repeat(592)}${secret} was refused`) });
  assert.strictEqual(across.status, 1);
  assertPrintsNone(across, [secret, secret.slice(0, 8), 'CedarPin'], 'a secret across the cut');
  assert.ok(JSON.parse(across.lines[0]).error.endsWith(`says: ${WITHHELD("the job log's text")}`));
  const status = importOf(secret, { log: `<importexportxml succeeded="failure" status="${'x'.repeat(592)}${secret}"/>` });
  assertPrintsNone(status, [secret, 'CedarPin'], 'a secret across the cut, in the root status');
  assert.ok(JSON.parse(status.lines[0]).error.endsWith(`says: ${WITHHELD("the job log's text")}`));
  const spaced = 'Cedar  Pine Secret42';
  const runs = importOf(spaced, { log: jobLogSaying(`Value '${spaced}' was refused`) });
  assertPrintsNone(runs, [spaced, 'Cedar Pine Secret42', 'Secret42'], 'a secret made of runs of white space');
  assert.ok(JSON.parse(runs.lines[0]).error.endsWith(`says: ${WITHHELD("the job log's text")}`));
  // A text of no value of the file is made one line and cut to 600 characters, as it was.
  const long = importOf(secret, { log: jobLogSaying(`a  b\n${'y'.repeat(700)}`) });
  assert.ok(JSON.parse(long.lines[0]).error.endsWith(`says: a b ${'y'.repeat(596)}…`));
});
