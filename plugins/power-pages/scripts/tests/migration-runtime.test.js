const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  discoverSite, captureSolutions, parseTracker, pollMigration, parseArgs,
  generateCustomizationReport, startReferences,
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

for (const step of [null, 'StatusUpdated', 'configurationdatacompleted']) {
  test(`metadata polling accepts top-level Completed with step ${step}`, async (t) => {
    const terminal = step === null
      ? { status: 0, stdout: 'Current migration status is : Completed\n' }
      : response('Completed', step);
    const f = polling(t, [terminal], 'configurationData');
    const result = await pollMigration(f.args, f.deps);
    assert.equal(result.outcome, 'ConfigurationDataCompleted');
    assert.equal(result.status, 'Completed');
    assert.equal(result.currentStep, step);
    assert.equal(f.calls.length, 1);
    assert.equal(f.sleeps.length, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.outputDir, 'migration-status.json'), 'utf8')).rawOutput, terminal.stdout);
  });
}

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

for (const mode of ['configurationData', 'all', 'configurationDataReferences']) {
  test(`${mode} polling stops immediately on Unknown and preserves the raw tracker`, async (t) => {
    const unknown = response('Unknown', 'ConfigurationDataCompleted');
    const f = polling(t, [unknown], mode);
    const result = await pollMigration(f.args, f.deps);
    assert.equal(result.outcome, 'CheckFailed');
    assert.equal(result.status, 'Unknown');
    assert.match(result.error, /Unknown/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.sleeps.length, 0);
    assert.equal(f.records.length, 1);
    assert.equal(result.rawOutput, unknown.stdout);
    assert.equal(fs.readFileSync(path.join(f.outputDir, 'migration-status.txt'), 'utf8'), unknown.stdout);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.outputDir, 'migration-status.json'), 'utf8')).outcome, 'CheckFailed');
  });
}

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

const csvHeader = 'Type of customization,Guidance,Snippet,Location\n';

function handoff(t, run) {
  const root = fixture(t);
  const outputDir = path.join(root, 'reports with spaces');
  const cwd = path.join(root, 'working directory');
  fs.mkdirSync(outputDir);
  fs.mkdirSync(cwd);
  const calls = [];
  return {
    root, outputDir, cwd, calls, args: { websiteId, outputDir },
    deps: {
      cwd,
      runPac(args, options) {
        calls.push({ args, options });
        return run(args, options);
      },
    },
  };
}

test('incident: report exits 0 without CSV, tracker regresses, and refs start is refused', async (t) => {
  let step = 'ConfigurationDataCompleted';
  const f = handoff(t, (args) => {
    if (args.includes('--checkMigrationStatus')) return response('Running', step);
    if (args.includes('--siteCustomizationReportPath')) {
      // Assert that the known milestone was persisted before the report command.
      const saved = JSON.parse(fs.readFileSync(path.join(f.outputDir, 'customization-report-attempt.json')));
      assert.equal(saved.before.currentStep, 'ConfigurationDataCompleted');
      step = 'PrecheckCompleted';
      return { status: 0, stdout: 'Prechecks completed successfully.\n' };
    }
    return { status: 1, stderr: 'The website is already under migration.' };
  });
  const metadata = await pollMigration({ ...f.args, mode: 'configurationData' }, { ...f.deps, emit() {} });
  assert.equal(metadata.outcome, 'ConfigurationDataCompleted');
  const milestone = fs.readFileSync(path.join(f.outputDir, 'migration-status.json'), 'utf8');
  const report = generateCustomizationReport(f.args, f.deps);
  assert.equal(report.outcome, 'TrackerChanged');
  assert.equal(report.command.status, 0);
  assert.equal(report.before.currentStep, 'ConfigurationDataCompleted');
  assert.equal(report.after.currentStep, 'PrecheckCompleted');
  assert.deepEqual(report.csvPaths, []);
  assert.equal(report.trackerChanged, true);
  assert.equal(fs.readFileSync(path.join(f.outputDir, 'migration-status.json'), 'utf8'), milestone);
  const refs = startReferences(f.args, f.deps);
  assert.equal(refs.outcome, 'StartRefused');
  assert.equal(refs.tracker.currentStep, 'PrecheckCompleted');
  assert.match(refs.error, /already under migration/);
  assert.ok(f.calls.every(({ args }) => !args.includes('--resetMigration')));
  assert.equal(f.calls.filter(({ args }) => args.includes('--mode')).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.outputDir, 'references-start.json'))).outcome, 'StartRefused');
});

for (const location of ['output', 'parent', 'cwd']) {
  test(`report fallback validates a fresh CSV in ${location} without requiring any shell`, (t) => {
    const f = handoff(t, (args, options) => {
      assert.equal(options.captureAll, true);
      if (args.includes('--checkMigrationStatus')) return response('Running', 'ConfigurationDataCompleted');
      assert.deepEqual(args, [
        'pages', 'migrate-datamodel', '--webSiteId', websiteId, '--siteCustomizationReportPath', f.outputDir,
      ]);
      assert.equal(options.cwd, f.cwd);
      const directory = { output: f.outputDir, parent: f.root, cwd: f.cwd }[location];
      // A header-only CSV is a valid zero-findings report, unlike an absent CSV.
      fs.writeFileSync(path.join(directory, 'SiteCustomization1.csv'), '\uFEFF' + csvHeader);
      return { status: 0, stdout: 'Report generated.' };
    });
    const result = generateCustomizationReport(f.args, f.deps);
    assert.equal(result.outcome, 'ReportGenerated');
    assert.equal(result.csvPaths.length, 1);
    assert.equal(result.trackerChanged, false);
    assert.equal(f.calls.length, 3);
  });
}

test('report fallback cannot reuse a stale CSV or claim success from precheck output', (t) => {
  const f = handoff(t, (args) => args.includes('--checkMigrationStatus')
    ? response('Running', 'ConfigurationDataCompleted')
    : { status: 0, stdout: 'Prechecks completed successfully.' });
  fs.writeFileSync(path.join(f.cwd, 'SiteCustomization999.csv'), csvHeader);
  const result = generateCustomizationReport(f.args, f.deps);
  assert.equal(result.outcome, 'ReportMissingOrInvalid');
  assert.match(result.error, /exit code 0 is not/);
  assert.deepEqual(result.csvPaths, []);
  assert.equal(f.calls.length, 3);
});

test('report fallback accepts a rewritten CSV but rejects empty or malformed artifacts', (t) => {
  for (const [content, outcome] of [
    [csvHeader + 'Liquid,Review,adx_name,web-templates/test.html\n', 'ReportGenerated'],
    ['', 'ReportMissingOrInvalid'],
    ['not,a,customization,report\n', 'ReportMissingOrInvalid'],
    [csvHeader + 'Liquid,missing columns\n', 'ReportMissingOrInvalid'],
    [csvHeader + 'Liquid,Review,adx_name,"unterminated', 'ReportMissingOrInvalid'],
  ]) {
    const f = handoff(t, (args) => {
      if (args.includes('--checkMigrationStatus')) return response('Completed', 'StatusUpdated');
      fs.writeFileSync(path.join(f.outputDir, 'SiteCustomization.csv'), content);
      return { status: 0, stdout: 'Done' };
    });
    fs.writeFileSync(path.join(f.outputDir, 'SiteCustomization.csv'), csvHeader + 'old,old,old,old\n');
    const result = generateCustomizationReport(f.args, f.deps);
    assert.equal(result.outcome, outcome);
    assert.equal(result.invalidCsvPaths.length, outcome === 'ReportGenerated' ? 0 : 1);
  }
});

test('multiple fresh report candidates require selection instead of choosing the highest number', (t) => {
  const f = handoff(t, (args) => {
    if (args.includes('--checkMigrationStatus')) return response('Completed', 'StatusUpdated');
    for (const name of ['SiteCustomization.csv', 'SiteCustomization99.csv']) {
      fs.writeFileSync(path.join(f.outputDir, name), csvHeader);
    }
    return { status: 0, stdout: 'Done' };
  });
  assert.equal(generateCustomizationReport(f.args, f.deps).outcome, 'ReportSelectionRequired');
});

test('report fallback stops before mutation for active, failed or unverifiable trackers', (t) => {
  for (const tracker of [
    response('Running', 'ConfigurationDataReferencesStarted'),
    response('Failed', 'ConfigurationDataCompleted'),
    { status: 0, stdout: 'Current migration status is : Running\n' },
    { status: 1, stderr: 'authentication failed' },
  ]) {
    const f = handoff(t, () => tracker);
    assert.equal(generateCustomizationReport(f.args, f.deps).outcome, 'CheckFailed');
    assert.equal(f.calls.length, 1);
    assert.ok(f.calls[0].args.includes('--checkMigrationStatus'));
  }
});

test('report command and post-report status failures remain explicit with both snapshots', (t) => {
  for (const failure of ['command', 'status']) {
    let checks = 0;
    const f = handoff(t, (args) => {
      if (args.includes('--checkMigrationStatus')) {
        if (++checks === 2 && failure === 'status') return { status: 1, stderr: 'network unavailable' };
        return response('Running', 'ConfigurationDataCompleted');
      }
      return failure === 'command' ? { status: 1, stderr: 'report generation failed' } : { status: 0, stdout: '' };
    });
    const result = generateCustomizationReport(f.args, f.deps);
    assert.equal(result.outcome, failure === 'command' ? 'CommandFailed' : 'CheckFailed');
    assert.ok(result.before.rawOutput);
    assert.ok(result.after.rawOutput);
    assert.ok(result.error);
    assert.equal(f.calls.length, 3);
  }
});

test('older PAC report fallback still works without verbose when status includes the current step', (t) => {
  const f = handoff(t, (args) => {
    if (args.includes('--verbose')) return { status: 1, stderr: 'An unknown argument --verbose was passed.' };
    if (args.includes('--checkMigrationStatus')) return response('Running', 'ConfigurationDataCompleted');
    fs.writeFileSync(path.join(f.outputDir, 'SiteCustomization.csv'), csvHeader);
    return { status: 0, stdout: 'Done' };
  });
  const result = generateCustomizationReport(f.args, f.deps);
  assert.equal(result.outcome, 'ReportGenerated');
  assert.equal(result.after.verboseSupported, false);
  assert.equal(f.calls.filter(({ args }) => args.includes('--verbose')).length, 1);
});

test('refused, failed and unverifiable reference starts do not retry or report migration success', (t) => {
  for (const [command, tracker, outcome] of [
    [{ status: 0, stdout: 'This website is already under migration.' }, response('Running', 'PrecheckCompleted'), 'StartRefused'],
    [{ status: 1, stderr: 'This website is already under migration.' }, response('Running', 'ConfigurationDataReferencesStarted'), 'StartRefused'],
    [{ status: 1, stderr: 'authentication failed' }, response('Running'), 'StartFailed'],
    [{ status: 0, stdout: 'Submitted' }, { status: 1, stderr: 'status check failed' }, 'CheckFailed'],
    [{ status: 0, stdout: 'Submitted' }, response('Unknown'), 'CheckFailed'],
  ]) {
    const f = handoff(t, (args) => args.includes('--checkMigrationStatus') ? tracker : command);
    const result = startReferences(f.args, f.deps);
    assert.equal(result.outcome, outcome);
    assert.ok(result.error);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls[0].args, [
      'pages', 'migrate-datamodel', '--webSiteId', websiteId, '--mode', 'configurationDataReferences',
    ]);
    assert.ok(f.calls[1].args.includes('--checkMigrationStatus'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.outputDir, 'references-start.json'), 'utf8')).tracker.rawOutput,
      tracker.stdout || tracker.stderr);
  }
});

test('accepted references start is not completion; polling still waits for top-level Completed', async (t) => {
  const f = handoff(t, (args) => args.includes('--checkMigrationStatus')
    ? response('Running', 'PrecheckCompleted') : { status: 0, stdout: 'Submitted' });
  assert.equal(startReferences(f.args, f.deps).outcome, 'StartAccepted');
  const poll = polling(t, [
    response('Running', 'PrecheckCompleted'),
    response('Running', 'ConfigurationDataReferencesCompleted'),
    response('Completed', 'StatusUpdated'),
  ]);
  assert.equal((await pollMigration(poll.args, poll.deps)).outcome, 'Completed');
  assert.equal(poll.calls.length, 3);
  assert.equal(poll.sleeps.length, 2);
});

test('30 unchanged precheck observations never trigger a reset or another references start', async (t) => {
  const f = polling(t, [response('Running', 'PrecheckCompleted')]);
  assert.equal((await pollMigration(f.args, f.deps)).outcome, 'TimedOut');
  assert.equal(f.calls.length, 30);
  assert.ok(f.calls.every(({ args }) => args.includes('--checkMigrationStatus') &&
    !args.includes('--resetMigration') && !args.includes('--mode')));
});

test('post-references report tracker change preserves Completed evidence and live state', async (t) => {
  let step = 'StatusUpdated';
  let status = 'Completed';
  const f = handoff(t, (args) => {
    if (args.includes('--checkMigrationStatus')) return response(status, step);
    fs.writeFileSync(path.join(f.outputDir, 'SiteCustomization.csv'), csvHeader);
    step = 'PrecheckCompleted';
    status = 'Running';
    return { status: 0, stdout: 'Prechecks completed.' };
  });
  const statePath = path.join(f.outputDir, 'migration-state.json');
  fs.writeFileSync(statePath, 'state is owned by update-state.js');
  assert.equal((await pollMigration({ ...f.args, mode: 'configurationDataReferences' }, { ...f.deps, emit() {} })).outcome, 'Completed');
  const milestone = fs.readFileSync(path.join(f.outputDir, 'migration-status.json'), 'utf8');
  const result = generateCustomizationReport(f.args, f.deps);
  assert.equal(result.outcome, 'TrackerChanged');
  assert.equal(result.csvPaths.length, 1);
  assert.equal(result.before.status, 'Completed');
  assert.equal(result.after.status, 'Running');
  assert.equal(fs.readFileSync(path.join(f.outputDir, 'migration-status.json'), 'utf8'), milestone);
  assert.equal(fs.readFileSync(statePath, 'utf8'), 'state is owned by update-state.js');
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
    ['Unknown', 1, 'CheckFailed', 1],
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

test('report and references-start CLI return nonzero for missing artifacts, tracker changes and refusals', (t) => {
  const root = fixture(t);
  const preload = path.join(root, 'fake-handoff-pac.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const path = require('node:path');
    const assert = require('node:assert/strict');
    let reported = false;
    require('node:child_process').execFileSync = (command, args, options) => {
      assert.equal(command, process.platform === 'win32' ? 'pac.exe' : 'pac');
      assert.equal(options.shell, false);
      let output;
      if (args.includes('--checkMigrationStatus')) {
        const step = reported && process.env.TEST_CASE === 'changed' ? 'PrecheckCompleted' : 'ConfigurationDataCompleted';
        const status = process.env.TEST_CASE === 'unknown' ? 'Unknown' : 'Running';
        output = 'Current migration status is : ' + status + '\\nCurrent Step: ' + step + '\\n';
      } else if (args.includes('--siteCustomizationReportPath')) {
        const directory = args[args.indexOf('--siteCustomizationReportPath') + 1];
        if (process.env.TEST_CASE === 'generated') {
          fs.writeFileSync(path.join(directory, 'SiteCustomization.csv'), 'Type of customization,Guidance,Snippet,Location\\n');
        }
        reported = true;
        output = 'Prechecks completed.';
      } else {
        output = process.env.TEST_CASE === 'refused' ? 'The website is already under migration.' : 'Submitted.';
      }
      fs.writeSync(options.stdio[1], output);
    };
  `);
  for (const [action, scenario, outcome, code] of [
    ['report', 'generated', 'ReportGenerated', 0],
    ['report', 'missing', 'ReportMissingOrInvalid', 1],
    ['report', 'changed', 'TrackerChanged', 1],
    ['start-references', 'refused', 'StartRefused', 1],
    ['start-references', 'accepted', 'StartAccepted', 0],
    ['start-references', 'unknown', 'CheckFailed', 1],
  ]) {
    const output = path.join(root, scenario);
    fs.mkdirSync(output);
    const result = spawnSync(process.execPath, [
      '--require', preload, script, action, '--website-id', websiteId, '--output-dir', output,
    ], { encoding: 'utf8', env: { ...process.env, TEST_CASE: scenario }, cwd: root });
    assert.equal(result.status, code, result.stderr);
    assert.equal(JSON.parse(result.stdout).outcome, outcome);
  }
});

test('migration instructions use portable commands for both tracks', () => {
  const skillRoot = path.join(__dirname, '../../skills/migrate-datamodel');
  for (const filename of ['SKILL.md']) {
    const content = fs.readFileSync(path.join(skillRoot, filename), 'utf8');
    assert.doesNotMatch(content, /```(?:powershell|bash)\b/i, filename);
    assert.doesNotMatch(content, /\b(?:Test-Path|Get-ChildItem|Out-File|Out-String|Start-Sleep|ConvertTo-Json|Write-Host|Where-Object)\b/, filename);
    assert.doesNotMatch(content, / [`\\]\r?$/m, `${filename} must not require shell line-continuation syntax`);
  }
  const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
  assert.match(skill, /state\.site\.migrationMode === 'all'/);
  assert.doesNotMatch(skill, /\bstate\.mode\b/);
  assert.equal((skill.match(/migration-runtime\.js" poll /g) || []).length, 3);
  assert.match(skill, /agent is the sole report-state writer/);
  assert.match(skill, /PowerShell is not a prerequisite/);
  assert.match(skill, /Always refresh the card once more from the final saved response/);
  assert.equal((skill.match(/migration-runtime\.js" start-references /g) || []).length, 2);
  assert.match(skill, /migration-runtime\.js" report /);
  const recovery = skill.split('#### References start refusal recovery')[1].split('### 3.3 Activate EDM')[0];
  assert.match(recovery, /both tracks/);
  assert.match(recovery, /Earlier approval to migrate references is \*\*not\*\* reset approval/);
  assert.match(recovery, /Only after reset approval/);
  assert.match(recovery, /verify the tracker is no longer `Running`/);
  assert.match(recovery, /Retry \*\*only\*\* `start-references` once/);
  assert.match(recovery, /Do not rerun metadata/);
  assert.match(recovery, /Require overall references `Completed` before activation/);
  assert.doesNotMatch(skill, /set \*\*`adx_migrationstatus`\*\*|manual `adx_migrationstatus`/);
});
