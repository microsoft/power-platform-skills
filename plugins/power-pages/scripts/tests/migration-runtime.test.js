const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  discoverSite, captureSolutions, parseTracker, pollMigration, parseArgs,
} = require('../../skills/migrate-datamodel/scripts/migration-runtime');
const { buildInitialState } = require('../../skills/migrate-datamodel/scripts/lib/migration-state-schema');

const script = path.join(__dirname, '../../skills/migrate-datamodel/scripts/migration-runtime.js');
const websiteId = '00000000-0000-0000-0000-000000000001';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeSite(root, child = '') {
  const directory = path.join(root, child);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'website.yml'), `adx_websiteid: ${websiteId}\n`);
  return directory;
}

function response(status, step = 'ConfigurationDataReferencesStarted') {
  return { status: 0, stdout: `Current migration status is : ${status}\nCurrent Step: ${step}\n` };
}

function polling(t, responses, mode = 'configurationDataReferences') {
  const outputDir = fixture(t);
  const calls = [];
  const records = [];
  const sleeps = [];
  let index = 0;
  const deps = {
    runPac(args, options) {
      calls.push({ args, options });
      return responses[Math.min(index++, responses.length - 1)];
    },
    emit(record) { records.push(record); },
    sleep: async (ms) => { sleeps.push(ms); },
  };
  return { outputDir, calls, records, sleeps, deps, args: { websiteId, mode, outputDir } };
}

test('site discovery supports direct and nested configuration trees', (t) => {
  const root = fixture(t);
  const project = path.join(root, 'site $name & (literal)');
  const site = makeSite(project, '.powerpages-site');
  const result = discoverSite(project, true);
  assert.equal(result.siteRoot, site);
  assert.equal(result.parentOutputDir, path.join(root, 'migration-reports'));
  assert.equal(discoverSite(root, true).siteRoot, site);
});

test('site discovery does not pick the first of multiple sites', (t) => {
  const root = fixture(t);
  assert.equal(discoverSite(root).siteRoot, null);
  makeSite(root, 'first');
  assert.equal(discoverSite(root, true).siteRoot, path.join(root, 'first'));
  makeSite(root, 'second');
  assert.equal(discoverSite(root).siteRoot, null);
  assert.throws(() => discoverSite(root, true), /found 2/);
});

test('discovery CLI accepts paths with spaces and reports missing paths explicitly', (t) => {
  const root = fixture(t);
  const site = makeSite(root, 'site with spaces');
  const result = spawnSync(process.execPath, [script, 'discover', '--path', site, '--require-site'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).siteRoot, site);
  const missing = spawnSync(process.execPath, [script, 'discover', '--path', path.join(root, 'missing')], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ENOENT/);
});

test('solution capture writes the complete UTF-8 output without a BOM', (t) => {
  const root = fixture(t);
  const output = path.join(root, 'reports with spaces', 'solutions.txt');
  const text = 'PowerPages_FAQ Fran\u00e7ais\n' + 'x'.repeat(40000);
  captureSolutions(output, {
    runPac(args, options) {
      assert.deepEqual(args, ['solution', 'list', '--includeSystemSolutions']);
      assert.equal(options.captureAll, true);
      return { status: 0, stdout: text };
    },
  });
  assert.deepEqual(fs.readFileSync(output), Buffer.from(text, 'utf8'));
});

test('failed or empty solution capture cannot masquerade as an empty template list', (t) => {
  const root = fixture(t);
  const output = path.join(root, 'solutions.txt');
  for (const result of [
    { status: 1, stderr: 'not authenticated' },
    { status: 0, stdout: '' },
    { status: 1, error: Object.assign(new Error('pac not found'), { code: 'ENOENT' }) },
  ]) {
    assert.throws(() => captureSolutions(output, { runPac: () => result }), /failed|empty solution list/);
    assert.equal(fs.existsSync(output), false);
  }
});

test('tracker parsing uses labels rather than incidental Completed history', () => {
  const output = '\u001b[32mCurrent migration status is : Running\u001b[0m\r\n' +
    '  Current Step: ConfigurationDataCompleted\r\nStep History: Completed\r\n';
  assert.deepEqual(parseTracker(output), { status: 'Running', currentStep: 'ConfigurationDataCompleted' });
  assert.throws(() => parseTracker('Step History: Completed'), /no recognized/);
});

test('metadata-only polling stops at the expected Running handoff', async (t) => {
  const f = polling(t, [response('Running', 'ConfigurationDataCompleted')], 'configurationData');
  const result = await pollMigration(f.args, f.deps);
  assert.equal(result.outcome, 'ConfigurationDataCompleted');
  assert.equal(f.calls.length, 1);
  assert.equal(f.sleeps.length, 0);
  assert.deepEqual(result.operation.poll, { attempt: 1, max: 30 });
});

test('milestone matching retains the original case-insensitive behavior', async (t) => {
  const f = polling(t, [response('running', 'configurationdatacompleted')], 'configurationData');
  assert.equal((await pollMigration(f.args, f.deps)).outcome, 'ConfigurationDataCompleted');
});

test('all mode waits past the metadata handoff for top-level Completed', async (t) => {
  const f = polling(t, [response('Running', 'ConfigurationDataCompleted'), response('Completed')], 'all');
  const result = await pollMigration(f.args, f.deps);
  assert.equal(result.outcome, 'Completed');
  assert.deepEqual(f.sleeps, [60000]);
  assert.equal(f.calls.length, 2);
});

test('refs polling preserves complete responses and final snapshots for report interpretation', async (t) => {
  const terminal = response('Completed');
  terminal.stdout += 'Chunk Details\n' + 'x'.repeat(40000) + '\nlast chunk\n';
  const f = polling(t, [response('Running'), terminal]);
  const result = await pollMigration(f.args, f.deps);
  assert.equal(result.outcome, 'Completed');
  assert.deepEqual(f.sleeps, [60000]);
  assert.equal(f.records.length, 2);
  assert.equal(f.records.at(-1).rawOutput, terminal.stdout);
  assert.equal(fs.readFileSync(path.join(f.outputDir, 'migration-status.txt'), 'utf8'), terminal.stdout);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.outputDir, 'migration-status.json'), 'utf8')).outcome, 'Completed');
  for (const call of f.calls) {
    assert.deepEqual(call.args, ['pages', 'migrate-datamodel', '--webSiteId', websiteId, '--checkMigrationStatus', '--verbose']);
    assert.equal(call.options.captureAll, true);
    assert.equal(call.options.timeoutMs, 60000);
  }
});

test('polling stops after exactly 30 attempts with no final unnecessary sleep', async (t) => {
  const f = polling(t, [response('Running')]);
  const result = await pollMigration(f.args, f.deps);
  assert.equal(result.outcome, 'TimedOut');
  assert.equal(f.calls.length, 30);
  assert.equal(f.sleeps.length, 29);
  assert.ok(f.sleeps.every((ms) => ms === 60000));
});

for (const status of ['Failed', 'Reverted']) {
  test(`${status} takes precedence over a metadata-completed step`, async (t) => {
    const f = polling(t, [response(status, 'ConfigurationDataCompleted')], 'configurationData');
    assert.equal((await pollMigration(f.args, f.deps)).outcome, status);
    assert.equal(f.sleeps.length, 0);
  });
}

test('missing executable, timeout, nonzero exit and malformed responses stop rather than spin', async (t) => {
  for (const response of [
    { status: 1, error: Object.assign(new Error('pac not found'), { code: 'ENOENT' }) },
    { status: 1, error: Object.assign(new Error('PAC timed out'), { code: 'ETIMEDOUT' }) },
    { status: 1, stderr: 'authentication failed' },
    { status: 0, stdout: 'Completed in step history only' },
    { status: 1, stdout: 'Current migration status is : Completed\n' },
  ]) {
    const f = polling(t, [response]);
    const result = await pollMigration(f.args, f.deps);
    assert.equal(result.outcome, 'CheckFailed');
    assert.ok(result.error);
    assert.equal(f.calls.length, 1);
    assert.equal(f.sleeps.length, 0);
  }
});

test('only an explicit unsupported verbose flag permits non-verbose fallback', async (t) => {
  const f = polling(t, [
    { status: 1, stderr: 'An unknown argument --verbose was passed.' },
    response('Running'),
    response('Completed'),
  ]);
  const result = await pollMigration(f.args, f.deps);
  assert.equal(result.outcome, 'Completed');
  assert.equal(result.verboseSupported, false);
  assert.ok(f.calls[0].args.includes('--verbose'));
  assert.ok(f.calls.slice(1).every((call) => !call.args.includes('--verbose')));
});

test('incidental unknown-verbose text in successful output cannot trigger fallback', async (t) => {
  const terminal = response('Completed');
  terminal.stdout += 'History: An unknown argument --verbose was passed.\n';
  const f = polling(t, [terminal]);
  assert.equal((await pollMigration(f.args, f.deps)).verboseSupported, true);
  assert.equal(f.calls.length, 1);
});

test('metadata-only fallback cannot infer a milestone from Running alone', async (t) => {
  const f = polling(t, [
    { status: 1, stderr: 'An unknown argument --verbose was passed.' },
    { status: 0, stdout: 'Current migration status is : Running\n' },
  ], 'configurationData');
  const result = await pollMigration(f.args, f.deps);
  assert.equal(result.outcome, 'CheckFailed');
  assert.match(result.error, /requires Current Step/);
});

test('progress can update the existing report through Node without concurrent state writers', async (t) => {
  const f = polling(t, [response('Completed')]);
  const statePath = path.join(f.outputDir, 'migration-state.json');
  fs.writeFileSync(statePath, JSON.stringify(buildInitialState({ webSiteId: websiteId, outputDir: f.outputDir })));
  const updateScript = path.join(__dirname, '../../skills/migrate-datamodel/scripts/update-state.js');
  f.deps.emit = (record) => {
    const result = spawnSync(process.execPath, [
      updateScript, '--output-dir', f.outputDir, '--set-operation', JSON.stringify(record.operation),
    ], { encoding: 'utf8', shell: false });
    assert.equal(result.status, 0, result.stderr);
  };
  assert.equal((await pollMigration(f.args, f.deps)).outcome, 'Completed');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.deepEqual(state.currentOperation.poll, { attempt: 1, max: 30 });
  assert.ok(fs.existsSync(path.join(f.outputDir, 'datamodel-migration-report.html')));
});

test('the background poller never replaces migration state', async (t) => {
  const f = polling(t, [response('Completed')]);
  const statePath = path.join(f.outputDir, 'migration-state.json');
  fs.writeFileSync(statePath, 'existing state belongs to the report updater');
  assert.equal((await pollMigration(f.args, f.deps)).outcome, 'Completed');
  assert.equal(fs.readFileSync(statePath, 'utf8'), 'existing state belongs to the report updater');
});

test('invalid helper arguments fail before PAC is invoked', async (t) => {
  assert.throws(() => parseArgs(['poll', '--mode']), /requires a value/);
  assert.throws(() => parseArgs(['solutions', '--unexpected']), /Unknown argument/);
  assert.throws(() => parseArgs(['unknown']), /Usage/);
  assert.deepEqual(parseArgs(['delay', '--seconds', '60']), { action: 'delay', seconds: '60' });
  const f = polling(t, [response('Completed')]);
  await assert.rejects(pollMigration({ ...f.args, mode: 'invalid' }, f.deps), /--mode/);
  await assert.rejects(pollMigration({ ...f.args, websiteId: null }, f.deps), /--website-id/);
  assert.equal(f.calls.length, 0);
});

test('polling CLI returns distinct success, migration-failure and elapsed-window exit codes', (t) => {
  const root = fixture(t);
  const preload = path.join(root, 'fake-pac.cjs');
  // Only this child process is mocked. No real PAC executable or environment
  // is used, and immediate timers exercise the real 30-attempt CLI boundary.
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    require('node:child_process').execFileSync = (command, args, options) => {
      assert.equal(command, process.platform === 'win32' ? 'pac.exe' : 'pac');
      assert.equal(options.shell, false);
      fs.writeSync(options.stdio[1], 'Current migration status is : ' + process.env.TEST_TRACKER_STATUS + '\\n');
    };
    global.setTimeout = (callback) => { callback(); };
  `);
  for (const [status, exitCode, outcome, attempts] of [
    ['Completed', 0, 'Completed', 1], ['Failed', 1, 'Failed', 1], ['Running', 2, 'TimedOut', 30],
  ]) {
    const output = path.join(root, status);
    const result = spawnSync(process.execPath, [
      '--require', preload, script, 'poll', '--website-id', websiteId,
      '--mode', 'configurationDataReferences', '--output-dir', output,
    ], { encoding: 'utf8', env: { ...process.env, TEST_TRACKER_STATUS: status } });
    assert.equal(result.status, exitCode, result.stderr);
    const records = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(records.length, attempts);
    assert.equal(records.at(-1).outcome, outcome);
  }
});

test('migration instructions use portable commands for both tracks', () => {
  const skillRoot = path.join(__dirname, '../../skills/migrate-datamodel');
  for (const filename of ['SKILL.md', 'DESIGN.md', 'REPORTS_INTEGRATION.md']) {
    const content = fs.readFileSync(path.join(skillRoot, filename), 'utf8');
    assert.doesNotMatch(content, /```(?:powershell|bash)\b/i, filename);
    assert.doesNotMatch(content, /\b(?:Test-Path|Get-ChildItem|Out-File|Out-String|Start-Sleep|ConvertTo-Json|Write-Host|Where-Object)\b/, filename);
    assert.doesNotMatch(content, / [`\\]\r?$/m, `${filename} must not require shell line-continuation syntax`);
  }
  const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
  assert.equal((skill.match(/migration-runtime\.js" poll /g) || []).length, 3);
  assert.match(skill, /agent is the sole report-state writer/);
  assert.match(skill, /PowerShell is not a prerequisite/);
  assert.match(skill, /Always refresh the card once more from the final saved response/);
});
