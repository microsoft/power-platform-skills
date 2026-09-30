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

test('foreground Dataverse planning resolves and validates environment in one read-only command', () => {
  const planningStart = skill.indexOf('### Foreground Dataverse planning');
  const planningEnd = skill.indexOf(
    'Build `<working_dir>/.tmp/dataverse-concepts.json`',
    planningStart,
  );
  assert.notStrictEqual(planningStart, -1);
  assert.notStrictEqual(planningEnd, -1);
  const planning = skill.slice(planningStart, planningEnd);
  const commands = [...planning.matchAll(/```bash\r?\n([\s\S]*?)\r?\n```/g)];
  assert.strictEqual(commands.length, 1);
  assert.strictEqual(
    commands[0][1].trim(),
    'node "${PLUGIN_ROOT}/scripts/resolve-environment.js" "$ACTIVE_ENV_ID" --no-cache --require-tenant',
  );
  assert.doesNotMatch(planning, /PLANNING_ENV_JSON|node -e|JSON\.parse/);
  assert.match(planning, /`environmentUrl` as `\$ACTIVE_ENV_URL`/);
  assert.match(planning, /`tenantId` as\s+`\$ACTIVE_TENANT_ID`/);
  assert.match(planning, /nonzero exit[\s\S]*do not create a snapshot or reuse stale environment values/);
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
  assert.doesNotMatch(skill, /planning-timings\.js|PLANNING_TIMINGS_PATH/);
  assert.doesNotMatch(skill, /telemetry-output|PLANNING_TELEMETRY_PATH/);
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
  assert.doesNotMatch(fallback, /timing protocol|modelArchitect|screenPlanner|--retry/);
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
    fs.writeFileSync(snapshotFile, '{"stale":true}');
    fs.writeFileSync(evidenceFile, '{"stale":true}');
    const block = commands.replaceAll('<working_dir>', directory.replaceAll('\\', '/'));
    const env = {
      ...process.env, PLUGIN_ROOT: pluginRoot.replaceAll('\\', '/'), REAL_NODE: process.execPath.replaceAll('\\', '/'),
      FIXTURE_SNAPSHOT: JSON.stringify(snapshot), FAILURE_STAGE: failureStage,
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
    if (failureStage === 'snapshot') {
      assert.equal(fs.readFileSync(snapshotFile, 'utf8'), '{"stale":true}');
    }

    const recovered = spawnSync(bash, ['-s'], {
      input: `${stub}\n${block}`,
      env: { ...env, FAILURE_STAGE: '' }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stdout, /Dataverse inventory:/);
    loadAndValidateArchitectEvidence(snapshotFile, evidenceFile);
  }
});

test('planning recovery keeps the agent active without weakening approval or metadata checks', () => {
  assert.match(skill, /Foreground recovery, not agent termination/);
  assert.match(skill, /at most two repair-and-retry attempts per failing stage/);
  assert.match(skill, /rerun `run_dataverse_planning_attempt`/);
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
  // Design system was renumbered from 6.75 to Step 4 when the scaffold group moved ahead of
  // the planning gates; the handoff wording it asserts on is unchanged.
  const design = skill.slice(skill.indexOf('### Step 6.75 — Design system'), skill.indexOf('### Step 7'));
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
  // Preparation now runs ahead of the gates, so the plan is normally absent here; its presence
  // on a resumed run must not be mistaken for an already-created app.
  assert.match(step, /`native-app-plan\.md` is never a created-app marker/);
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
  assert.match(memory, /Step 5's `writtenFiles`, `memory-bank\.md`/);
  assert.match(memory, /read-only.*Step 6/);
  assert.match(shared, /not modified afterward by the skill or its subagents/);
  assert.match(shared, /Do not suppress a protected-path finding/);
});

function section(start, end) {
  const startIndex = skill.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section: ${start}`);
  const endIndex = skill.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section boundary: ${end}`);
  return skill.slice(startIndex, endIndex);
}

test('creating an app has no user prerequisites', () => {
  assert.match(skill, /\*\*This skill has no setup steps\.\*\*/);
  // The prerequisite this replaced: the user had to materialize a template and
  // install its dependencies before the skill would run at all.
  assert.doesNotMatch(skill, /rerun `\/create-mobile-app --working-dir <fresh-template-dir>`/);
  assert.doesNotMatch(skill, /must run `npm install` in the fresh template folder/);
  assert.doesNotMatch(skill, /ask the user to run `npm install`/i);
});

test('the app folder is created from the bundled snapshot, never fetched', () => {
  const bootstrap = section(
    '### Step 2a — Create the app folder, start dependency install',
    '### Step 2b — Requirements discovery',
  );

  assert.match(bootstrap, /scripts\/bootstrap-mobile-project\.js/);
  assert.match(bootstrap, /--parent-dir "\$PWD" --slug "<slug>"/);
  assert.match(bootstrap, /Exit 2 is an actionable refusal/);
  assert.match(bootstrap, /Set `<working_dir>` to `result\.targetDir`/);
  // Network template fetches would let main drift ahead of prepare-mobile-template.js.
  assert.doesNotMatch(bootstrap, /npx degit|git clone|curl |wget /);

  const source = fs.readFileSync(
    path.resolve(__dirname, '../bootstrap-mobile-project.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /\bhttps?:\/\/(?!\/)[^\s)]*\/(?:archive|tarball)/);
  assert.doesNotMatch(source, /child_process|fetch\(/);
});

test('dependency install starts in Step 2a and is collected in Step 5', () => {
  const bootstrap = section(
    '### Step 2a — Create the app folder, start dependency install',
    '### Step 2b — Requirements discovery',
  );
  assert.match(bootstrap, /scripts\/install-dependencies\.js" --working-dir "<working_dir>" start/);
  assert.match(bootstrap, /\*\*Do not poll, tail, or block on the install here\.\*\*/);

  const preparation = section(
    '### Step 5 — Prepare existing template',
    '### Step 6 — Initialize',
  );
  assert.match(preparation, /install-dependencies\.js" --working-dir "<working_dir>" wait --timeout-ms 900000/);
  for (const state of ['succeeded', 'failed', 'stalled', 'timeout', 'not-started']) {
    assert.ok(preparation.includes(`\`${state}\``), `Step 5 must handle ${state}`);
  }
  assert.match(preparation, /never substitute your own `npm install` for this gate/);

  // Step 5 runs after planning, so its gate is the only blocking wait in the flow.
  const betweenBootstrapAndPreparation = skill.slice(
    skill.indexOf('### Step 2b — Requirements discovery'),
    skill.indexOf('### Step 5 — Prepare existing template'),
  );
  assert.doesNotMatch(betweenBootstrapAndPreparation, /install-dependencies\.js/);
});

test('the device QR remains the real preview', () => {
  const shared = fs.readFileSync(path.resolve(__dirname, '../../shared/shared-instructions.md'), 'utf8');
  assert.match(shared, /the device QR remains the real preview/);
  assert.match(shared, /never treat a web render as evidence/);
  assert.match(shared, /must never gate a step and never fail a run/);
});

test('environment selection offers a pick list before asking for a GUID', () => {
  const step1 = section('### Step 1 — Prerequisites', '### Step 1.7 — Detect publisher prefix');

  assert.match(step1, /scripts\/list-environments\.js/);
  assert.match(step1, /Offer a choice; never demand a GUID/);
  assert.match(step1, /active.*marks the environment PAC is currently connected to/);
  // A real tenant returned 223 environments, so the skill must never render them flat.
  assert.match(step1, /--filter "<user's search text>"/);
  assert.match(step1, /BAP environment GUID/);
  // PAC must stay optional or this undoes the zero-prerequisite work.
  assert.match(step1, /\*\*PAC is not a prerequisite\.\*\*/);
  assert.match(step1, /exits 0 with `\[\]`/);
  assert.match(step1, /Do not install PAC, do not run `pac auth create`/);
});

test('skills are told the plugin root is pre-resolved so they stop searching for it', () => {
  // create-mobile-app references ${PLUGIN_ROOT} ~49 times. Without this rule an agent whose host
  // does not substitute the variable scans the filesystem to locate the plugin, which is slow and
  // can find a stale checkout instead of the running one.
  const shared = fs.readFileSync(path.resolve(__dirname, '../../shared/shared-instructions.md'), 'utf8');
  assert.match(shared, /already resolved/i);
  assert.match(shared, /Do NOT search the filesystem for the plugin directory/);
  assert.match(shared, /scan unrelated trees/);
});

test('the run writes a build plan into docs/ as decisions are made', () => {
  const protocol = section('## Build documentation protocol', '## TypeScript Gate Policy');
  assert.match(protocol, /scripts\/app-docs\.js/);
  assert.match(protocol, /docs\/create-app-plan\.html/);
  // Sections must be written when known, not batched at the end, or an aborted run documents nothing.
  assert.match(protocol, /Record each other section as soon as it is known/);
  // A gate is answered against the rendered diagram, so the section is written before the ask.
  assert.match(protocol, /\*before\* asking for approval/);
  assert.match(protocol, /--state proposed/);
  assert.match(protocol, /--state approved/);
  assert.match(protocol, /never gate, retry, or fail a build/);
  // The ER, the column tables and the colouring are all derived from the structured tables.
  assert.match(protocol, /built from `dataModel\.tables`/);
  assert.match(protocol, /--json-file/);

  const bootstrap = section(
    '### Step 2a — Create the app folder, start dependency install',
    '### Step 2b — Requirements discovery',
  );
  assert.match(bootstrap, /app-docs\.js" --working-dir "<working_dir>" init/);

  const record = section('### Step 3.9 — Confirm the approved plan', '### Step 6.75 — Design system');
  assert.match(record, /--section architecture/);
  assert.match(record, /--section dataModel/);
  assert.match(record, /--section screens/);
  // A connector-only app must retire both Dataverse phases or the plan never reaches 100%.
  assert.match(record, /--id data-model --status skipped/);
  assert.match(record, /--id dataverse --status skipped/);

  // Step 3.9 has to sit after the gates and before any mutation.
  assert.ok(skill.indexOf('### Step 3 — Plan') < skill.indexOf('### Step 3.9 — Confirm the approved plan'));
  assert.ok(skill.indexOf('### Step 3.9 — Confirm the approved plan') < skill.indexOf('### Step 8 — Apply data model'));

  assert.match(skill, /Build plan {4}: docs\/create-app-plan\.html/);
});

test('the design system is settled before any screen is generated', () => {
  // Screen-builders read brand/design-system.md and the generated tokens; building screens
  // first would mean restyling every one of them afterwards. The reordering work moved several
  // phases, so pin this rather than rely on it staying true by accident.
  const design = skill.indexOf('### Step 6.75 — Design system');
  const skeletons = skill.indexOf('### Step 10.8 — Generate app-specific shared code');
  const screens = skill.indexOf('### Step 11 — Build screens (parallel)');

  assert.ok(design > 0 && skeletons > 0 && screens > 0);
  assert.ok(design < skeletons, 'design must be chosen before skeletons are generated');
  assert.ok(design < screens, 'design must be chosen before screens are built');
});

test('step cross-references name the step that actually does the work', () => {
  const skill = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8',
  );

  // The design system moved from Step 4 to Step 6.75 when the scaffold group moved back after
  // the gates, but ~15 cross-references still said "Step 4" - which by then named Auth &
  // environment selection. An agent following "design is deferred to Step 4" would have gone to
  // the wrong step. Step numbers are prose here, so nothing else catches this.
  const headingOf = (step) => {
    const match = skill.match(new RegExp(`^### Step ${step.replace('.', '\\.')} — (.+)$`, 'm'));
    assert.ok(match, `Step ${step} must exist`);
    return match[1];
  };
  assert.match(headingOf('4'), /Auth & environment/);
  assert.match(headingOf('6.75'), /Design system/);

  // A line that talks about design, previews or the style picker must not cite Step 4.
  const misdirected = skill.split('\n')
    .map((line, index) => [index + 1, line])
    .filter(([, line]) => /\bStep 4\b/.test(line) && /design|preview|vibe|style/i.test(line));
  assert.deepEqual(
    misdirected.map(([number, line]) => `${number}: ${line.trim().slice(0, 90)}`),
    [],
    'these lines send a design concern to the auth/environment step',
  );
});

test('no command the skill runs asks the user to fetch or install anything first', () => {
  const skill = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8',
  );

  // Asserted on the fenced commands rather than the prose, because the prose legitimately
  // contains the words - "Do not ask the user to run `degit` or `npm install`" is the rule
  // itself, and a naive doesNotMatch over the whole file trips on its own prohibition.
  const offenders = [];
  for (const block of skill.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)) {
    const body = block[1];
    // `npm install` is banned as a bare command: the background installer owns install state,
    // and a second npm against the same node_modules corrupts it. `npm install` appearing as
    // part of a longer path (a message, a lock path) is not a command, hence the boundary.
    for (const [pattern, why] of [
      [/\bnpx degit\b/, 'fetches the template over the network instead of using the bundled snapshot'],
      [/\bgit clone\b/, 'fetches the template over the network instead of using the bundled snapshot'],
      [/(^|\s)npm install(\s|$)/m, 'bypasses install-dependencies.js, which owns install state'],
    ]) {
      if (pattern.test(body)) offenders.push(`${why}: ${body.trim().split('\n')[0].slice(0, 70)}`);
    }
  }
  assert.deepEqual(offenders, [], 'these runnable commands break the zero-prerequisite promise');
});

test('the bundled lock file reaches the generated app', () => {
  // The lock is what makes a first install ~2.5x faster and reproducible. It only helps if
  // bootstrap actually copies it, and an exclusion added to the copy list would silently
  // undo that - the app would still build, just slowly and from a resolved-fresh tree.
  const templateLock = path.resolve(__dirname, '..', '..', 'template', 'package-lock.json');
  assert.ok(fs.existsSync(templateLock), 'the template must ship a lock file');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-lock-'));
  const target = path.join(root, 'app');
  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'bootstrap-mobile-project.js'), '--working-dir', target,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(result.stdout);
  assert.ok(report.copiedFiles.includes('package-lock.json'), 'the lock must be copied');
  assert.deepEqual(
    fs.readFileSync(path.join(target, 'package-lock.json')),
    fs.readFileSync(templateLock),
    'the generated app must get the exact locked tree the template was tested with',
  );
});
