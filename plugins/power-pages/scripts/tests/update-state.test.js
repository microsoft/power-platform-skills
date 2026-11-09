const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildInitialState } = require('../../skills/migrate-datamodel/scripts/lib/migration-state-schema');

const script = path.join(__dirname, '../../skills/migrate-datamodel/scripts/update-state.js');
const websiteId = '00000000-0000-0000-0000-000000000001';
const envUrl = 'https://contoso.crm.dynamics.com';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'demo-env--portal');
  const args = ['--init', '--output-dir', root, '--website-id', websiteId,
    '--env-name', 'Demo Env', '--slug', 'portal', '--env-url', envUrl];
  const run = (extra = [], base = args) => spawnSync(process.execPath, [script, ...base, ...extra], {
    encoding: 'utf8',
  });
  const statePath = path.join(output, 'migration-state.json');
  return { root, output, args, run, statePath };
}

test('initial state retains the four-phase authoring workflow', () => {
  const state = buildInitialState({ webSiteId: websiteId, outputDir: 'migration-reports' });
  assert.equal(state.track, 'A');
  assert.deepEqual(state.phases.map((phase) => phase.id), [1, 2, 3, 4]);
  assert.equal(state.site.environmentUrl, null);
});

test('init records identity and matching resume preserves progress and prints its output directory', (t) => {
  const fixture = setup(t);
  const init = fixture.run();
  assert.equal(init.status, 0, init.stderr);
  const state = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
  assert.equal(state.site.environmentUrl, envUrl);
  assert.equal(state.site.slug, 'portal');
  state.phases[0].subSteps[0].status = 'completed';
  fs.writeFileSync(fixture.statePath, JSON.stringify(state));
  const before = fs.readFileSync(fixture.statePath, 'utf8');
  const resumed = fixture.run();
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /resume mode/);
  assert.ok(resumed.stdout.includes(`--output-dir "${fixture.output}"`));
  assert.equal(fs.readFileSync(fixture.statePath, 'utf8'), before);
});

test('identity collisions refuse both resume and force reset without changing state', async (t) => {
  for (const [label, flag, value] of [
    ['website ID', '--website-id', '00000000-0000-0000-0000-000000000002'],
    ['environment URL', '--env-url', 'https://fabrikam.crm.dynamics.com'],
    ['sanitized environment name', '--env-name', 'Demo-Env'],
    ['sanitized slug', '--slug', 'Portal'],
  ]) {
    await t.test(label, (t) => {
      const fixture = setup(t);
      assert.equal(fixture.run().status, 0);
      const before = fs.readFileSync(fixture.statePath, 'utf8');
      for (const force of [[], ['--force']]) {
        const result = fixture.run([flag, value, ...force]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /identity mismatch/);
        assert.equal(fs.readFileSync(fixture.statePath, 'utf8'), before);
      }
    });
  }
});

test('unverified legacy environment is not silently resumed', (t) => {
  const fixture = setup(t);
  assert.equal(fixture.run().status, 0);
  const state = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
  delete state.site.environmentUrl;
  fs.writeFileSync(fixture.statePath, JSON.stringify(state));
  const result = fixture.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /older state without environmentUrl/);
  const verified = fixture.run([], ['--output-dir', fixture.output, '--set-site',
    JSON.stringify({ environmentUrl: `${envUrl}/` })]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(fixture.run().status, 0);
});

test('switching tracks preserves shared progress and approval gates', (t) => {
  const fixture = setup(t);
  assert.equal(fixture.run().status, 0);
  const before = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
  before.phases[0].subSteps[0].status = 'completed';
  fs.writeFileSync(fixture.statePath, JSON.stringify(before));
  const result = fixture.run([], ['--output-dir', fixture.output, '--set-track', 'B']);
  assert.equal(result.status, 0, result.stderr);
  const after = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
  assert.equal(after.track, 'B');
  assert.deepEqual(after.phases.map((phase) => phase.id), [1, 2, 3, 4]);
  assert.deepEqual(after.phases[0], before.phases[0]);
  assert.deepEqual(after.phases[3], before.phases[3]);
  assert.deepEqual(after.approvalGate, before.approvalGate);
  assert.deepEqual(after.site, before.site);
});

test('input notices preserve migration gates/progress and clear when the pause resolves', (t) => {
  const fixture = setup(t);
  assert.equal(fixture.run().status, 0);
  const run = (args) => {
    const result = fixture.run([], ['--output-dir', fixture.output, ...args]);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
  };
  run(['--approve-and-start', '1']);
  const before = run(['--set-operation', '{"label":"Checking metadata"}']);
  const waiting = run(['--set-input', JSON.stringify({ requiredAction: '  Provide the Portal ID.  ' })]);
  assert.equal(waiting.pendingInput.requiredAction, 'Provide the Portal ID.');
  assert.match(waiting.pendingInput.responseLocation, /migration conversation/);
  assert.equal(waiting.currentOperation, null);
  assert.deepEqual(waiting.phases, before.phases);
  assert.deepEqual(waiting.approvalGate, before.approvalGate);
  assert.deepEqual(waiting.site, before.site);
  assert.equal(run(['--set-track', 'B']).pendingInput.requiredAction, waiting.pendingInput.requiredAction);
  assert.equal(run(['--clear-input']).pendingInput, null);
  assert.equal(run(['--clear-input']).pendingInput, null);

  const pause = () => run(['--set-input', '{"requiredAction":"Confirm restart.","responseLocation":"Migration chat"}']);
  assert.equal(pause().pendingInput.responseLocation, 'Migration chat');
  assert.equal(run(['--set-operation', '{"label":"Verifying restart"}']).pendingInput, null);
  pause();
  const approval = run(['--set-approval', '2', 'phase-start']);
  assert.equal(approval.pendingInput, null);
  assert.equal(approval.currentOperation, null);
  pause();
  assert.deepEqual(run(['--clear-input']).approvalGate, approval.approvalGate);
  pause();
  assert.equal(run(['--clear-approval']).pendingInput, null);
  pause();
  assert.equal(run(['--approve-and-start', '2']).pendingInput, null);
});

test('invalid input notices cannot replace usable state or report files', (t) => {
  const fixture = setup(t);
  assert.equal(fixture.run().status, 0);
  const stateBefore = fs.readFileSync(fixture.statePath, 'utf8');
  const reportPath = path.join(fixture.output, 'datamodel-migration-report.html');
  const reportBefore = fs.readFileSync(reportPath, 'utf8');
  for (const raw of ['{', 'null', '[]', '1', 'true', '""', '{}',
    '{"requiredAction":null}', '{"requiredAction":" "}', '{"requiredAction":1}',
    '{"requiredAction":"Confirm.","responseLocation":null}',
    '{"requiredAction":"Confirm.","responseLocation":" "}']) {
    const result = fixture.run([], ['--output-dir', fixture.output, '--set-input', raw]);
    assert.equal(result.status, 1, raw);
    assert.match(result.stderr, /--set-input|Pending input/);
    assert.equal(fs.readFileSync(fixture.statePath, 'utf8'), stateBefore);
    assert.equal(fs.readFileSync(reportPath, 'utf8'), reportBefore);
  }
});

test('legacy saved states without pendingInput render and accept new input notices', (t) => {
  const fixture = setup(t);
  assert.equal(fixture.run().status, 0);
  const state = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
  delete state.pendingInput;
  fs.writeFileSync(fixture.statePath, JSON.stringify(state));
  const result = fixture.run([], ['--output-dir', fixture.output, '--render-only']);
  assert.equal(result.status, 0, result.stderr);
  const paused = fixture.run([], ['--output-dir', fixture.output, '--set-input', '{"requiredAction":"Confirm restart."}']);
  assert.equal(paused.status, 0, paused.stderr);
});

test('package progress preserves elapsed time and completed metadata while references remain pending', (t) => {
  const fixture = setup(t);
  assert.equal(fixture.run().status, 0);
  const run = (args) => {
    const result = fixture.run([], ['--output-dir', fixture.output, ...args]);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
  };
  run(['--approve-and-start', '1']);
  run(['--set-phase', '1', '--status', 'completed']);
  run(['--set-phase', '2', '--status', 'in-progress']);
  const before = run(['--set-step', '2.2', '--status', 'completed']);
  run(['--set-input', '{"requiredAction":"Approve the additional V2 package installation."}']);
  const label = 'Installing PowerPages_ProgramRegistration_V2';
  const installing = run(['--set-operation', JSON.stringify({ label, detail: 'Installation in progress.' })]);
  assert.equal(installing.pendingInput, null);
  assert.equal(installing.currentOperation.expectedDurationSec, null);
  assert.equal(installing.currentOperation.poll, null);
  assert.deepEqual(installing.phases, before.phases);
  assert.ok(installing.phases[2].subSteps.every((step) => step.status === 'pending'));

  const startedAt = '2026-01-01T12:00:00Z';
  installing.currentOperation.startedAt = startedAt;
  fs.writeFileSync(fixture.statePath, JSON.stringify(installing));
  const verifying = run(['--set-operation', JSON.stringify({ label, detail: 'Installation accepted; verifying installed version.' })]);
  assert.equal(verifying.currentOperation.startedAt, startedAt);
  assert.deepEqual(verifying.phases, before.phases);
  const reportPath = path.join(fixture.output, 'datamodel-migration-report.html');
  assert.match(fs.readFileSync(reportPath, 'utf8'), /class="now-running-bar-fill now-running-bar-indeterminate"/);
  assert.equal(run(['--clear-operation']).currentOperation, null);
  assert.doesNotMatch(fs.readFileSync(reportPath, 'utf8'), /data-now-running data-op-started-at=/);
});

test('force reset clears generated artifacts but keeps downloaded source and inputs', (t) => {
  const fixture = setup(t);
  assert.equal(fixture.run().status, 0);
  const artifacts = [
    'sdm-snapshot.json', 'edm-snapshot.json', 'migration-data-diff.json',
    'remediation-diff.json', 'customization-report.html',
    'plugin-remediation-prompt.txt', 'dme-remediation-prompt.txt',
    'migration-status.json', 'migration-status.txt',
  ];
  for (const name of artifacts) fs.writeFileSync(path.join(fixture.output, name), '{}');
  fs.mkdirSync(path.join(fixture.output, 'remediation-staged'));
  fs.writeFileSync(path.join(fixture.output, 'remediation-staged', 'old.html'), 'old proposal');
  fs.mkdirSync(path.join(fixture.output, 'site'));
  fs.writeFileSync(path.join(fixture.output, 'site', 'website.yml'), 'source');
  fs.writeFileSync(path.join(fixture.output, 'SiteCustomization.csv'), 'input');
  const result = fixture.run(['--force']);
  assert.equal(result.status, 0, result.stderr);
  for (const name of [...artifacts, 'remediation-staged']) {
    assert.equal(fs.existsSync(path.join(fixture.output, name)), false, name);
  }
  assert.equal(fs.readFileSync(path.join(fixture.output, 'site', 'website.yml'), 'utf8'), 'source');
  assert.equal(fs.readFileSync(path.join(fixture.output, 'SiteCustomization.csv'), 'utf8'), 'input');
  assert.ok(fs.existsSync(path.join(fixture.output, 'datamodel-migration-report.html')));
});

test('init rejects missing or invalid environment origins before creating artifacts', (t) => {
  const fixture = setup(t);
  const missing = fixture.run([], fixture.args.slice(0, -2));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /requires --env-url/);
  for (const value of ['http://contoso.crm.dynamics.com', `${envUrl}/api/data`]) {
    const invalid = fixture.run(['--env-url', value]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /HTTPS environment origin/);
  }
  assert.equal(fs.existsSync(fixture.output), false);
});

test('missing state reports the correct initialization command', (t) => {
  const fixture = setup(t);
  const result = fixture.run([], ['--output-dir', fixture.output, '--render-only']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /migration-state.json not found/);
  assert.match(result.stderr, /--env-url <ENV_URL>/);
  assert.doesNotMatch(result.stderr, /TypeError|Cannot read properties/);
});

test('malformed state is rejected without replacing the state or report', (t) => {
  const fixture = setup(t);
  assert.equal(fixture.run().status, 0);
  const valid = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
  const reportPath = path.join(fixture.output, 'datamodel-migration-report.html');
  const report = fs.readFileSync(reportPath, 'utf8');
  for (const invalid of [
    null, {}, { ...valid, site: null }, { ...valid, phases: null },
    { ...valid, phases: [null] },
    { ...valid, phases: [{ id: 1, subSteps: [null] }] },
    { ...valid, augmentedPrompts: null },
  ]) {
    const raw = JSON.stringify(invalid);
    fs.writeFileSync(fixture.statePath, raw);
    const result = fixture.run([], ['--output-dir', fixture.output, '--render-only']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid migration state/);
    assert.doesNotMatch(result.stderr, /TypeError|Cannot read properties/);
    assert.equal(fs.readFileSync(fixture.statePath, 'utf8'), raw);
    assert.equal(fs.readFileSync(reportPath, 'utf8'), report);
  }
});

test('null site patches and null reference tracker entries are rejected before persisting', (t) => {
  const fixture = setup(t);
  assert.equal(fixture.run().status, 0);
  const before = fs.readFileSync(fixture.statePath, 'utf8');
  for (const [flag, payload, expected] of [
    ['--set-site', null, /expects a JSON object/],
    ['--set-site', { name: {} }, /name must be a string or null/],
    ['--set-refs-migration', { runs: [null] }, /runs and chunks entries must be objects/],
    ['--set-refs-migration', { runs: [{ chunks: [null] }] }, /runs and chunks entries must be objects/],
    ['--set-refs-migration', { stepHistory: [null] }, /stepHistory entries must be objects/],
  ]) {
    const result = fixture.run([], ['--output-dir', fixture.output, flag, JSON.stringify(payload)]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /TypeError|Cannot read properties/);
    assert.equal(fs.readFileSync(fixture.statePath, 'utf8'), before);
  }
});

test('valid nullable site fields and pending reference runs still render successfully', (t) => {
  const fixture = setup(t);
  assert.equal(fixture.run().status, 0);
  const site = fixture.run([], ['--output-dir', fixture.output, '--set-site', '{"name":null,"template":null}']);
  assert.equal(site.status, 0, site.stderr);
  const refs = fixture.run([], ['--output-dir', fixture.output, '--set-refs-migration',
    JSON.stringify({ status: 'Running', runs: [{ name: 'Pending run', chunks: null }], stepHistory: [] })]);
  assert.equal(refs.status, 0, refs.stderr);
  const state = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
  assert.equal(state.site.name, null);
  assert.equal(state.refsMigration.status, 'Running');
});

test('environment URL can be cleared without bypassing resume identity checks', (t) => {
  const fixture = setup(t);
  assert.equal(fixture.run().status, 0);
  const cleared = fixture.run([], ['--output-dir', fixture.output, '--set-site', '{"environmentUrl":null}']);
  assert.equal(cleared.status, 0, cleared.stderr);
  const state = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
  assert.equal(state.site.environmentUrl, null);
  const resumed = fixture.run();
  assert.equal(resumed.status, 1);
  assert.match(resumed.stderr, /identity mismatch/);
  const restored = fixture.run([], ['--output-dir', fixture.output, '--set-site',
    JSON.stringify({ environmentUrl: `${envUrl}/` })]);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(fixture.run().status, 0);
});
