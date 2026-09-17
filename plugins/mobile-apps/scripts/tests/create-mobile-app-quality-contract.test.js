'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createSnapshot } = require('../create-dataverse-snapshot');
const { loadAndValidateArchitectEvidence } = require('../render-dataverse-architect-evidence');

const skillPath = path.resolve(
  __dirname,
  '../../skills/create-mobile-app/SKILL.md',
);
const skill = fs.readFileSync(skillPath, 'utf8');

function planningAttemptBlock(source) {
  const match = source.replace(/\r\n/g, '\n')
    .match(/```bash\n(SNAPSHOT_PATH=[\s\S]*?\nrun_dataverse_planning_attempt)\n```/);
  assert.ok(match, 'foreground snapshot commands must expose one recoverable attempt');
  return match[1];
}

test('foreground command extraction accepts LF and Windows CRLF checkouts', () => {
  const normalized = skill.replace(/\r\n/g, '\n');
  assert.equal(planningAttemptBlock(normalized.replace(/\n/g, '\r\n')),
    planningAttemptBlock(normalized));
});

test('foreground Dataverse planning bypasses cached environment resolution', () => {
  const planningStart = skill.indexOf('### Foreground Dataverse planning');
  const planningEnd = skill.indexOf(
    'Build `<working_dir>/.tmp/dataverse-concepts.json`',
    planningStart,
  );
  assert.notStrictEqual(planningStart, -1);
  assert.notStrictEqual(planningEnd, -1);
  assert.match(
    skill.slice(planningStart, planningEnd),
    /resolve-environment\.js" "\$ACTIVE_ENV_ID" --no-cache/,
  );
});

test('approved architecture precedes typed discovery without retrying the normal planner phases', () => {
  const architectureStart = skill.indexOf('### Architecture gate');
  const publisher = skill.indexOf('Now execute the deferred Step 1.7');
  const snapshotStart = skill.indexOf('### Foreground Dataverse planning');
  const conceptsStart = skill.indexOf('Build `<working_dir>/.tmp/dataverse-concepts.json`');
  const commandsStart = skill.indexOf('SNAPSHOT_PATH="');
  assert.ok(architectureStart >= 0 && architectureStart < publisher);
  assert.ok(publisher < snapshotStart && snapshotStart < conceptsStart);
  assert.ok(conceptsStart < commandsStart);
  const architecture = skill.slice(architectureStart, publisher);
  assert.match(architecture, /Architecture phase: gate-only/);
  assert.match(architecture, /Dataverse planning snapshot: NOT SUPPLIED/);
  assert.match(architecture, /approved-architecture\.md/);
  assert.doesNotMatch(architecture, /create-dataverse-snapshot\.js|detect-publisher-prefix\.js/);
  const concepts = skill.slice(conceptsStart, commandsStart);
  assert.match(concepts, /Gate 1-approved architecture/);
  assert.match(concepts, /exclude connector-owned\s+records from Dataverse candidate selection/);
  assert.match(skill, /initial `gate-only` and `complete` planner\s+passes are separate normal `nativePlanner` attempts/);
  assert.match(skill, /architecture-completion signal below is a successful `finish`/);
});

test('inline Dataverse planning keeps compact evidence and validates before Gate 2', () => {
  const fallbackStart = skill.indexOf('#### 3.0a — Inline-gate fallback');
  const fallbackEnd = skill.indexOf('#### 3.0 — Sub-agent return-status switch');
  assert.ok(fallbackStart >= 0 && fallbackStart < fallbackEnd);
  const fallback = skill.slice(fallbackStart, fallbackEnd);
  assert.match(fallback, /Approved native capabilities:[\s\S]*Approved connectors:/);
  assert.match(fallback, /`SNAPSHOT_PATH` and `ARCHITECT_EVIDENCE_PATH` verbatim/);
  assert.match(fallback, /full snapshot is\s+validator input only; read only the compact evidence/);
  assert.doesNotMatch(fallback, /\bEVIDENCE_PATH\b/);
  assert.match(fallback, /Before presenting Gate 2[\s\S]*validate-dataverse-planning-decisions\.js/);
  assert.match(fallback, /permit approval only on exit `0`/);
  assert.match(fallback, /every direct revision and the fully-inline fallback/);
  assert.match(fallback, /approve native capabilities, connectors, and data platform first/);
  assert.match(fallback, /then draft the data model from `ARCHITECT_EVIDENCE_PATH`/);
});

test('foreground planning returns failed attempts to recovery and resumes with fresh validated evidence', async (testContext) => {
  const commands = planningAttemptBlock(skill);
  const pluginRoot = path.resolve(__dirname, '../..');
  const bashPaths = process.platform === 'win32'
    ? (spawnSync('where.exe', ['bash'], { encoding: 'utf8' }).stdout || '').split(/\r?\n/)
    : [];
  const bash = bashPaths.find((entry) => /[\\/]Git[\\/]/i.test(entry)) || 'bash';
  const snapshot = await createSnapshot({
    environmentUrl: 'https://example.crm.dynamics.com', tenantId: 'tenant-1',
    request: async () => ({ status: 200, data: { value: [] } }),
  });
  const stub = `
node() {
  case "$1" in
    */create-dataverse-snapshot.js)
      if [ "$FAILURE_STAGE" = snapshot ]; then
        printf 'injected snapshot failure\\n' >&2
        return 1
      fi
      "$REAL_NODE" -e 'require("node:fs").writeFileSync(process.argv[1], process.env.FIXTURE_SNAPSHOT)' "$SNAPSHOT_PATH"
      ;;
    */render-dataverse-architect-evidence.js)
      if [ "$FAILURE_STAGE" = evidence ]; then
        printf 'injected evidence failure\\n' >&2
        return 1
      fi
      "$REAL_NODE" "$@"
      ;;
    *) "$REAL_NODE" "$@" ;;
  esac
}
`;
  for (const failureStage of ['snapshot', 'evidence']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'planning recovery '));
    testContext.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const temporary = path.join(directory, '.tmp');
    fs.mkdirSync(temporary);
    const snapshotFile = path.join(temporary, 'dataverse-foreground-planning-snapshot.json');
    const evidenceFile = path.join(temporary, 'dataverse-architect-evidence.json');
    const timingsFile = path.join(temporary, 'mobile-planning-timings.json');
    fs.writeFileSync(snapshotFile, '{"stale":true}');
    fs.writeFileSync(evidenceFile, '{"stale":true}');
    const block = commands.replaceAll('<working_dir>', directory.replaceAll('\\', '/'));
    const env = {
      ...process.env, PLUGIN_ROOT: pluginRoot.replaceAll('\\', '/'), REAL_NODE: process.execPath.replaceAll('\\', '/'),
      FIXTURE_SNAPSHOT: JSON.stringify(snapshot), FAILURE_STAGE: failureStage,
      PLANNING_TIMINGS_PATH: timingsFile.replaceAll('\\', '/'),
      POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1',
    };
    const failed = spawnSync(bash, ['-s'], {
      input: `${stub}\n${block}\nresult=$?\nprintf 'CONTROLLER_READY:%s\\n' "$result"\nexit "$result"`,
      env, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(failed.status, 2, failed.stderr);
    assert.match(failed.stderr, /NEEDS_RECOVERY: dataverse-(snapshot|evidence)/);
    assert.match(failed.stdout, /CONTROLLER_READY:2/);
    assert.doesNotMatch(failed.stdout, /Dataverse inventory:/);
    assert.equal(fs.readFileSync(evidenceFile, 'utf8'), '{"stale":true}');
    const failedTimings = JSON.parse(fs.readFileSync(timingsFile, 'utf8'));
    const stage = failureStage === 'snapshot' ? 'metadataSnapshot' : 'artifactValidation';
    assert.equal(failedTimings.stages[stage].status, 'failed');
    if (failureStage === 'snapshot') {
      assert.equal(fs.readFileSync(snapshotFile, 'utf8'), '{"stale":true}');
      assert.equal(failedTimings.stages.artifactValidation, undefined);
    }

    const recovered = spawnSync(bash, ['-s'], {
      input: `${stub}\n${block.replace(/run_dataverse_planning_attempt$/, 'run_dataverse_planning_attempt --retry')}`,
      env: { ...env, FAILURE_STAGE: '' }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stdout, /Dataverse inventory:/);
    loadAndValidateArchitectEvidence(snapshotFile, evidenceFile);
    const timings = JSON.parse(fs.readFileSync(timingsFile, 'utf8'));
    assert.deepEqual(timings.stages[stage].history.map((attempt) => attempt.status), ['failed', 'done']);
    assert.equal(timings.stages[stage].retryCount, 1);
    if (failureStage === 'snapshot') assert.equal(timings.stages.artifactValidation.retryCount, 0);
  }
});

test('planning recovery keeps the agent active without weakening approval or metadata checks', () => {
  assert.match(skill, /Foreground recovery, not agent termination/);
  assert.match(skill, /at most two repair-and-retry attempts per failing stage/);
  assert.match(skill, /rerun `run_dataverse_planning_attempt --retry`/);
  assert.match(skill, /Never substitute stale\s+evidence, invent metadata/);
  assert.match(skill, /Ask the user only when recovery needs interactive sign-in/);
  assert.match(skill, /Individual table-detail failures do not stop planning/);
});

test('offline setup follows materialized Dataverse data and never infers connector-only from absence', () => {
  const dataModel = skill.indexOf('### Step 8 — Apply data model');
  const sampleData = skill.indexOf('### Step 8.5 — Seed sample data');
  const offline = skill.indexOf('### Offline profile');
  const native = skill.indexOf('### Step 9 — Apply native capabilities');

  assert.ok(dataModel < sampleData);
  assert.ok(sampleData < offline);
  assert.ok(offline < native);
  assert.doesNotMatch(skill, /Step 6\.85/);
  const design = skill.slice(skill.indexOf('### Step 6.75'), skill.indexOf('### Step 7'));
  assert.match(design, /`DONE`[^\n]+continue to Step 7/);
  assert.match(design, /Continuing to Step 7/);
  const offlineSetup = skill.slice(offline, native);
  assert.match(offlineSetup, /Do not infer connector-only from a missing manifest/);
  assert.match(offlineSetup, /read-only manifest\s+recovery in Step 8\.5 before asking/);
  assert.match(offlineSetup, /If verification still fails, report\s+`BLOCKED: offline setup requires the materialized Dataverse manifest from Step 8`/);
  assert.match(skill, /seeding step fails[\s\S]*continue to the offline-profile phase/);
});

test('template preparation is delegated to the deterministic script', () => {
  const start = skill.indexOf('### Step 5 — Prepare existing template');
  const end = skill.indexOf('### Step 6 — Initialize');
  const step = skill.slice(start, end);

  assert.match(step, /scripts\/prepare-mobile-template\.js/);
  assert.match(step, /JSON_STRING_OF_WORKING_DIR/);
  assert.match(step, /JSON_STRING_OF_DISPLAY_NAME/);
  assert.match(step, /JSON_STRING_OF_SLUG/);
  assert.doesNotMatch(step, /--display-name "<displayName>"/);
  assert.match(step, /must not create, reset, delete, or\s+write anything under `src\/generated\/`/);
  assert.doesNotMatch(step, /rm\s+-rf[\s\S]*src\/generated/);
  assert.doesNotMatch(step, /src\/generated\/index\.ts[\s\S]*printf/);
  assert.doesNotMatch(step, /\ncp\s+.*shared\/samples/);
  assert.doesNotMatch(step, /baseUrl\s*=/);
  assert.doesNotMatch(step, /Write `app\/_layout\.tsx`/);
  assert.match(
    step,
    /`native-app-plan\.md` is expected here because Step 3 writes the approved plan before template preparation/,
  );
});

test('Power Apps initialization directly invokes the CLI with approved values', () => {
  const initializeStart = skill.indexOf('### Step 6 — Initialize');
  const initializeEnd = skill.indexOf('### Step 6.5 — Verify dependencies');
  const initialize = skill.slice(initializeStart, initializeEnd);
  assert.match(initialize, /npx power-apps init -t MobileApp/);
  assert.match(initialize, /--display-name "<displayName>"/);
  assert.match(initialize, /--environment-id "<environment-id>"/);
  assert.match(initialize, /approved Step 2 display name and Step 4 environment ID/);
  assert.match(initialize, /shell-safe quoting/);
  assert.match(initialize, /If a populated file remains, STOP/);
  assert.doesNotMatch(initialize, /spawnSync|node <<'NODE'/);
});

test('scaffold changed-file validation separates preparation and generator ownership', () => {
  const preparation = skill.slice(
    skill.indexOf('### Step 5 — Prepare existing template'),
    skill.indexOf('### Step 6 — Initialize'),
  );
  const memory = skill.slice(
    skill.indexOf('### Step 6.7 — Seed the memory bank'),
    skill.indexOf('### Step 6.75 — Design system'),
  );
  const shared = fs.readFileSync(path.resolve(__dirname, '../../shared/shared-instructions.md'), 'utf8');

  assert.match(preparation, /result\.writtenFiles/);
  assert.match(preparation, /removedPowerConfig.*removedLegacyFiles/);
  assert.match(preparation, /Do not rebuild this list from `git status`/);
  assert.match(memory, /Step 5's `writtenFiles`.*`memory-bank\.md`/);
  assert.match(memory, /read-only.*Step 6/);
  assert.match(shared, /not modified afterward by the skill or its subagents/);
  assert.match(shared, /Do not suppress a protected-path finding/);
});
