'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  runExecutionPipeline,
  runPlanningPipeline,
  runScaffoldPipeline,
  verifyIntegrity,
  withIntegrity,
} = require('../run-mobile-app-pipeline');

const ENVIRONMENT_ID = '3ecebcfc-2e80-e9ad-8a07-ad2001b0b5d9';
const TENANT_ID = '499ece4c-9b2a-4b89-81ed-578e64f3230c';
const ENVIRONMENT_URL = 'https://example.crm.dynamics.com';

function fixture(context) {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-app-pipeline-'));
  context.after(() => fs.rmSync(workingDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workingDir, '.tmp'), { recursive: true });
  return workingDir;
}

function flagValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function environmentResult(overrides = {}) {
  return {
    environmentId: ENVIRONMENT_ID,
    environmentUrl: ENVIRONMENT_URL,
    tenantId: TENANT_ID,
    displayName: 'Test Environment',
    source: 'environment-id',
    ...overrides,
  };
}

function noTimingWrites() {
  return {
    recordPlanningDuration: () => {},
    materializeFromFiles: ({ outputPath }) => {
      fs.writeFileSync(outputPath, JSON.stringify({ schemaVersion: 1, tables: [] }));
      return { schemaVersion: 1, tables: [] };
    },
  };
}

test('planning mode owns resolution, snapshot, promotion, and output binding', async (context) => {
  const workingDir = fixture(context);
  const conceptsPath = path.join(workingDir, 'concepts.json');
  fs.writeFileSync(conceptsPath, '[]');
  const calls = [];
  const promoted = [];
  const runCommand = (_command, args) => {
    const script = path.basename(args[0] || '');
    calls.push(script);
    if (script === 'resolve-environment.js') {
      return { status: 0, stdout: JSON.stringify(environmentResult()), stderr: '' };
    }
    if (script === 'detect-publisher-prefix.js') {
      return { status: 0, stdout: JSON.stringify({ prefix: 'new' }), stderr: '' };
    }
    if (script === 'create-dataverse-snapshot.js') {
      fs.writeFileSync(flagValue(args, '--output'), '{}');
      return { status: 0, stdout: JSON.stringify({ status: 'DONE' }), stderr: '' };
    }
    throw new Error(`unexpected command: ${script}`);
  };
  const output = await runPlanningPipeline({
    mode: 'planning',
    'working-dir': workingDir,
    'environment-id': ENVIRONMENT_ID,
    'concepts-file': conceptsPath,
    'progressive-detail': true,
    'combined-base-read': true,
  }, {
    ...noTimingWrites(),
    runCommand,
    promotePlanningGeneration: (options) => {
      promoted.push(options);
      return {
        snapshotPath: path.join(options.generationsDir, 'hash', 'snapshot.json'),
        evidencePath: path.join(options.generationsDir, 'hash', 'architect-evidence.json'),
        manifestPath: path.join(options.generationsDir, 'hash', 'generation-manifest.json'),
        sourceSnapshotSha256: 'a'.repeat(64),
        evidenceSha256: 'b'.repeat(64),
      };
    },
  });
  assert.equal(output.status, 'PLANNING_EVIDENCE_READY');
  assert.deepEqual(calls, [
    'resolve-environment.js',
    'detect-publisher-prefix.js',
    'create-dataverse-snapshot.js',
  ]);
  assert.equal(promoted.length, 1);
  assert.equal(output.context.publisherPrefix, 'new');
  verifyIntegrity(output, 'planning output');
  assert.equal(fs.existsSync(path.join(
    workingDir,
    '.tmp',
    'planning-pipeline-output.json',
  )), true);
});

test('connector-only planning skips Dataverse metadata work', async (context) => {
  const workingDir = fixture(context);
  const calls = [];
  const output = await runPlanningPipeline({
    mode: 'planning',
    'working-dir': workingDir,
    'environment-id': ENVIRONMENT_ID,
    'connector-only': true,
  }, {
    ...noTimingWrites(),
    runCommand: (_command, args) => {
      calls.push(path.basename(args[0]));
      return { status: 0, stdout: JSON.stringify(environmentResult()), stderr: '' };
    },
  });
  assert.equal(output.status, 'PLANNING_CONTEXT_READY');
  assert.deepEqual(calls, ['resolve-environment.js']);
  assert.equal(output.artifacts.snapshotPath, undefined);
});

test('planning expansion promotes a base snapshot in the same invocation', async (context) => {
  const workingDir = fixture(context);
  const baseSnapshot = path.join(workingDir, '.tmp', 'base-snapshot.json');
  fs.writeFileSync(baseSnapshot, '{}');
  let snapshotArgs = null;
  await runPlanningPipeline({
    mode: 'planning',
    'working-dir': workingDir,
    'environment-id': ENVIRONMENT_ID,
    'base-snapshot': baseSnapshot,
    tables: 'new_alpha,new_beta',
  }, {
    ...noTimingWrites(),
    runCommand: (_command, args) => {
      const script = path.basename(args[0]);
      if (script === 'resolve-environment.js') {
        return { status: 0, stdout: JSON.stringify(environmentResult()), stderr: '' };
      }
      if (script === 'detect-publisher-prefix.js') {
        return { status: 0, stdout: JSON.stringify({ prefix: 'new' }), stderr: '' };
      }
      if (script === 'create-dataverse-snapshot.js') {
        snapshotArgs = args;
        fs.writeFileSync(flagValue(args, '--output'), '{}');
        return { status: 0, stdout: '{}', stderr: '' };
      }
      throw new Error(`unexpected command: ${script}`);
    },
    promotePlanningGeneration: (options) => ({
      snapshotPath: path.join(options.generationsDir, 'hash', 'snapshot.json'),
      evidencePath: path.join(options.generationsDir, 'hash', 'architect-evidence.json'),
      manifestPath: path.join(options.generationsDir, 'hash', 'generation-manifest.json'),
      sourceSnapshotSha256: 'a'.repeat(64),
      evidenceSha256: 'b'.repeat(64),
    }),
  });
  assert.equal(flagValue(snapshotArgs, '--base-snapshot'), baseSnapshot);
  assert.equal(flagValue(snapshotArgs, '--tables'), 'new_alpha,new_beta');
});

test('planning rejects snapshot inputs outside the project root', async (context) => {
  const workingDir = fixture(context);
  await assert.rejects(
    runPlanningPipeline({
      mode: 'planning',
      'working-dir': workingDir,
      'environment-id': ENVIRONMENT_ID,
      'base-snapshot': path.join(workingDir, '..', 'outside.json'),
    }, {
      ...noTimingWrites(),
      runCommand: (_command, args) => {
        const script = path.basename(args[0]);
        if (script === 'resolve-environment.js') {
          return { status: 0, stdout: JSON.stringify(environmentResult()), stderr: '' };
        }
        if (script === 'detect-publisher-prefix.js') {
          return { status: 0, stdout: JSON.stringify({ prefix: 'new' }), stderr: '' };
        }
        throw new Error(`unexpected command: ${script}`);
      },
    }),
    /base snapshot must stay inside the working directory/,
  );
});

test('scaffold mode prepares, initializes, and typechecks in one invocation', async (context) => {
  const workingDir = fixture(context);
  fs.mkdirSync(path.join(workingDir, 'node_modules', 'expo'), { recursive: true });
  const calls = [];
  const output = await runScaffoldPipeline({
    mode: 'scaffold',
    'working-dir': workingDir,
    'environment-id': ENVIRONMENT_ID,
    'display-name': 'Pipeline Test',
    slug: 'pipeline-test',
    'prepare-template': true,
  }, {
    runCommand: (command, args) => {
      calls.push([command, ...args]);
      if (command === 'npx' && args[0] === 'power-apps') {
        fs.writeFileSync(
          path.join(workingDir, 'power.config.json'),
          JSON.stringify({ environmentId: ENVIRONMENT_ID }),
        );
      }
      return { status: 0, stdout: '{}', stderr: '' };
    },
  });
  assert.equal(output.status, 'SCAFFOLD_READY');
  assert.equal(path.basename(calls[0][1]), 'prepare-mobile-template.js');
  assert.deepEqual(calls[1].slice(0, 3), ['npx', 'power-apps', 'init']);
  assert.deepEqual(calls[2], ['npx', 'tsc', '--noEmit']);
});

test('scaffold validates its planning-output environment binding', async (context) => {
  const workingDir = fixture(context);
  const planningOutputPath = path.join(workingDir, '.tmp', 'planning.json');
  fs.writeFileSync(planningOutputPath, JSON.stringify(withIntegrity({
    schemaVersion: 1,
    mode: 'planning',
    status: 'PLANNING_CONTEXT_READY',
    context: environmentResult(),
  })));
  await assert.rejects(runScaffoldPipeline({
    mode: 'scaffold',
    'working-dir': workingDir,
    'planning-output': planningOutputPath,
    'environment-id': '00000000-0000-0000-0000-000000000000',
    'display-name': 'Mismatch',
  }), /scaffold environment does not match planning output/);
});

function executionFixture(context, { planningOutput = false } = {}) {
  const workingDir = fixture(context);
  const contractPath = path.join(workingDir, '.tmp', 'contract.json');
  const receiptPath = path.join(workingDir, '.tmp', 'receipt.json');
  const planPath = path.join(workingDir, 'native-app-plan.md');
  fs.writeFileSync(contractPath, '{}');
  fs.writeFileSync(receiptPath, '{}');
  fs.writeFileSync(planPath, '# Plan\n');
  fs.writeFileSync(
    path.join(workingDir, 'power.config.json'),
    JSON.stringify({ environmentId: ENVIRONMENT_ID }),
  );
  let planningOutputPath = null;
  if (planningOutput) {
    planningOutputPath = path.join(workingDir, '.tmp', 'planning.json');
    fs.writeFileSync(planningOutputPath, JSON.stringify(withIntegrity({
      schemaVersion: 1,
      mode: 'planning',
      status: 'PLANNING_EVIDENCE_READY',
      context: {
        ...environmentResult(),
        publisherPrefix: 'new',
        solutionUniqueName: 'Default',
      },
    })));
  }
  return { workingDir, contractPath, receiptPath, planPath, planningOutputPath };
}

function executionRunner(files, calls, {
  recoveryStatus = null,
  executionStatuses = null,
  verificationStatus = 'DONE',
} = {}) {
  let executionAttempt = 0;
  return (command, args) => {
    const script = command === process.execPath ? path.basename(args[0]) : command;
    calls.push({ command, script, args: [...args] });
    if (script === 'resolve-environment.js') {
      return { status: 0, stdout: JSON.stringify(environmentResult()), stderr: '' };
    }
    if (script === 'detect-publisher-prefix.js') {
      return { status: 0, stdout: JSON.stringify({ prefix: 'new' }), stderr: '' };
    }
    if (script === 'build-dataverse-operation-manifest.js') {
      if (args.includes('--validate')) {
        return { status: 0, stdout: '{}', stderr: '' };
      }
      const output = flagValue(args, '--output');
      if (args.includes('--bind-plan')) fs.writeFileSync(output, '{}');
      else if (args.includes('--reconciliation-scope')) {
        fs.writeFileSync(output, JSON.stringify({
          exactTables: ['new_alpha', 'new_beta'],
          proposedTables: ['new_alpha'],
        }));
      } else if (args.includes('--contract')) {
        fs.writeFileSync(output, JSON.stringify({
          integritySha256: 'a'.repeat(64),
          executable: true,
          summary: { metadataOperationCount: 1, metadataWriteCount: 1 },
          service: {
            requiredTables: [
              { logicalName: 'new_alpha' },
              { logicalName: 'new_beta' },
            ],
          },
        }));
      }
      return { status: 0, stdout: '{}', stderr: '' };
    }
    if (script === 'create-dataverse-snapshot.js') {
      fs.writeFileSync(flagValue(args, '--output'), '{}');
      return { status: 0, stdout: '{}', stderr: '' };
    }
    if (script === 'execute-dataverse-plan.js') {
      const outcomePath = flagValue(args, '--outcome');
      const selectedStatus = executionStatuses
        ? executionStatuses[Math.min(executionAttempt, executionStatuses.length - 1)]
        : recoveryStatus || 'DONE';
      executionAttempt += 1;
      const outcome = selectedStatus === 'DONE'
        ? { status: 'DONE', reasonCode: 'PUBLISH_CONFIRMED' }
        : { status: selectedStatus, reasonCode: 'TEST_RECOVERY' };
      fs.writeFileSync(outcomePath, JSON.stringify(outcome));
      const exitCode = selectedStatus === 'DONE'
        ? 0
        : selectedStatus === 'COLLISION_ADAPTATION_REQUIRED' ? 3 : 4;
      return { status: exitCode, stdout: JSON.stringify(outcome), stderr: '' };
    }
    if (script === 'verify-dataverse-post-publish.js') {
      fs.writeFileSync(flagValue(args, '--output'), JSON.stringify({
        status: verificationStatus,
        mismatches: verificationStatus === 'BLOCKED'
          ? [{ fact: 'column', expected: 'present', actual: 'missing' }]
          : [],
      }));
      return { status: verificationStatus === 'BLOCKED' ? 2 : 0, stdout: '{}', stderr: '' };
    }
    if (command === 'npx' || command === 'npm') {
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected command: ${script}`);
  };
}

function executionArgs(files, overrides = {}) {
  return {
    mode: 'execute',
    'working-dir': files.workingDir,
    'environment-id': ENVIRONMENT_ID,
    contract: files.contractPath,
    'approval-receipt': files.receiptPath,
    plan: files.planPath,
    ...overrides,
  };
}

test('execution check owns fresh reconciliation and validation without mutation', async (context) => {
  const files = executionFixture(context);
  const calls = [];
  const output = await runExecutionPipeline(executionArgs(files, { check: true }), {
    ...noTimingWrites(),
    runCommand: executionRunner(files, calls),
  });
  assert.equal(output.status, 'EXECUTION_READY');
  assert.equal(output.wouldMutateMetadata, true);
  assert.equal(output.plannedMetadataOperationCount, 1);
  assert.equal(output.plannedMetadataWriteCount, 1);
  assert.deepEqual(output.plannedServiceTables, ['new_alpha', 'new_beta']);
  assert.deepEqual(calls.map((call) => call.script), [
    'resolve-environment.js',
    'detect-publisher-prefix.js',
    'build-dataverse-operation-manifest.js',
    'build-dataverse-operation-manifest.js',
    'create-dataverse-snapshot.js',
    'build-dataverse-operation-manifest.js',
    'build-dataverse-operation-manifest.js',
  ]);
  assert.equal(calls.some((call) => call.script === 'execute-dataverse-plan.js'), false);
});

test('execution rejects an active app-local lock and reclaims a stale lock', async (context) => {
  const files = executionFixture(context);
  const lockPath = path.join(files.workingDir, '.tmp', 'dataverse-execution.lock');
  const processApi = {
    pid: 1234,
    kill(pid) {
      if (pid === 5678) return;
      const error = new Error('process not found');
      error.code = 'ESRCH';
      throw error;
    },
  };
  fs.writeFileSync(lockPath, JSON.stringify({
    schemaVersion: 1,
    pid: 5678,
    startedAt: '2026-08-29T00:00:00.000Z',
    token: 'active',
  }));
  await assert.rejects(
    runExecutionPipeline(executionArgs(files, { check: true }), {
      ...noTimingWrites(),
      processApi,
      runCommand: executionRunner(files, []),
    }),
    /Dataverse execution already in progress for this app \(pid 5678\)/,
  );
  assert.equal(fs.existsSync(lockPath), true);

  fs.writeFileSync(lockPath, JSON.stringify({
    schemaVersion: 1,
    pid: 9012,
    startedAt: '2026-08-29T00:00:00.000Z',
    token: 'stale',
  }));
  const output = await runExecutionPipeline(executionArgs(files, { check: true }), {
    ...noTimingWrites(),
    processApi,
    runCommand: executionRunner(files, []),
  });
  assert.equal(output.status, 'EXECUTION_READY');
  assert.equal(fs.existsSync(lockPath), false);
});

test('execution mode verifies before generating services sequentially', async (context) => {
  const files = executionFixture(context, { planningOutput: true });
  const calls = [];
  const output = await runExecutionPipeline(executionArgs(files, {
    'planning-output': files.planningOutputPath,
  }), {
    ...noTimingWrites(),
    runCommand: executionRunner(files, calls),
  });
  assert.equal(output.status, 'DONE');
  assert.deepEqual(output.generatedServices, ['new_alpha', 'new_beta']);
  const names = calls.map((call) => call.script);
  const verificationIndex = names.indexOf('verify-dataverse-post-publish.js');
  const serviceCalls = calls.filter(
    (call) => call.command === 'npx' && call.args[0] === 'power-apps',
  );
  assert.equal(serviceCalls.length, 2);
  assert.ok(calls.indexOf(serviceCalls[0]) > verificationIndex);
  assert.deepEqual(serviceCalls.map((call) => flagValue(call.args, '--resource-name')), [
    'new_alpha',
    'new_beta',
  ]);
  assert.deepEqual(calls.at(-2).args, ['run', 'generate-schemas']);
  assert.deepEqual(calls.at(-1).args, ['tsc', '--noEmit']);
  assert.equal(output.materializedTableCount, 0);
  assert.equal(fs.existsSync(output.artifacts.materializedManifestPath), true);
});

test('execution allows an isolated materialized-manifest output', async (context) => {
  const files = executionFixture(context);
  const isolated = path.join(files.workingDir, '.tmp', 'isolated-model.json');
  const output = await runExecutionPipeline(executionArgs(files, {
    'skip-service-generation': true,
    'materialized-manifest-output': isolated,
  }), {
    ...noTimingWrites(),
    runCommand: executionRunner(files, []),
  });
  assert.equal(output.status, 'DONE');
  assert.equal(output.artifacts.materializedManifestPath, isolated);
  assert.equal(fs.existsSync(isolated), true);
  assert.equal(fs.existsSync(path.join(files.workingDir, '.datamodel-manifest.json')), false);
});

test('execution rejects planning environment drift before reconciliation', async (context) => {
  const files = executionFixture(context, { planningOutput: true });
  const planning = JSON.parse(fs.readFileSync(files.planningOutputPath, 'utf8'));
  const content = { ...planning, context: {
    ...planning.context,
    tenantId: '00000000-0000-0000-0000-000000000000',
  } };
  delete content.integritySha256;
  fs.writeFileSync(files.planningOutputPath, JSON.stringify(withIntegrity(content)));
  const calls = [];
  await assert.rejects(
    runExecutionPipeline(executionArgs(files, {
      'planning-output': files.planningOutputPath,
    }), {
      ...noTimingWrites(),
      runCommand: executionRunner(files, calls),
    }),
    /execution tenant does not match planning output/,
  );
  assert.deepEqual(calls.map((call) => call.script), ['resolve-environment.js']);
});

test('pipeline rejects an unsupported planning-output schema version', async (context) => {
  const files = executionFixture(context, { planningOutput: true });
  const planning = JSON.parse(fs.readFileSync(files.planningOutputPath, 'utf8'));
  const content = { ...planning, schemaVersion: 2 };
  delete content.integritySha256;
  fs.writeFileSync(files.planningOutputPath, JSON.stringify(withIntegrity(content)));
  await assert.rejects(
    runExecutionPipeline(executionArgs(files, {
      'planning-output': files.planningOutputPath,
    }), {
      ...noTimingWrites(),
      runCommand: executionRunner(files, []),
    }),
    /schemaVersion 2 is unsupported/,
  );
});

test('pipeline requires integrity on planning output', async (context) => {
  const files = executionFixture(context, { planningOutput: true });
  const planning = JSON.parse(fs.readFileSync(files.planningOutputPath, 'utf8'));
  delete planning.integritySha256;
  fs.writeFileSync(files.planningOutputPath, JSON.stringify(planning));
  await assert.rejects(
    runExecutionPipeline(executionArgs(files, {
      'planning-output': files.planningOutputPath,
    }), {
      ...noTimingWrites(),
      runCommand: executionRunner(files, []),
    }),
    /integritySha256 is required/,
  );
});

test('malformed child JSON reports bounded stdout and stderr context', async (context) => {
  const workingDir = fixture(context);
  await assert.rejects(
    runPlanningPipeline({
      mode: 'planning',
      'working-dir': workingDir,
      'environment-id': ENVIRONMENT_ID,
    }, {
      ...noTimingWrites(),
      runCommand: () => ({
        status: 0,
        stdout: 'not-json-output',
        stderr: 'diagnostic-context',
      }),
    }),
    /stdout=not-json-output; stderr=diagnostic-context/,
  );
});

test('execution returns structured recovery without services or verification', async (context) => {
  const files = executionFixture(context);
  const calls = [];
  const output = await runExecutionPipeline(executionArgs(files), {
    ...noTimingWrites(),
    runCommand: executionRunner(files, calls, {
      recoveryStatus: 'UNCERTAIN_RECONCILIATION_REQUIRED',
    }),
  });
  assert.equal(output.status, 'UNCERTAIN_RECONCILIATION_REQUIRED');
  assert.equal(calls.some(
    (call) => call.script === 'verify-dataverse-post-publish.js',
  ), false);
  assert.equal(calls.some(
    (call) => call.command === 'npx' && call.args[0] === 'power-apps',
  ), false);
  assert.equal(calls.filter(
    (call) => call.script === 'execute-dataverse-plan.js',
  ).length, 2);
});

test('execution resolves one uncertain mutation without a model round trip', async (context) => {
  const files = executionFixture(context);
  const calls = [];
  const output = await runExecutionPipeline(executionArgs(files, {
    'skip-service-generation': true,
  }), {
    ...noTimingWrites(),
    runCommand: executionRunner(files, calls, {
      executionStatuses: ['UNCERTAIN_RECONCILIATION_REQUIRED', 'DONE'],
    }),
  });
  assert.equal(output.status, 'DONE');
  assert.equal(calls.filter(
    (call) => call.script === 'execute-dataverse-plan.js',
  ).length, 2);
  assert.equal(calls.filter(
    (call) => call.script === 'create-dataverse-snapshot.js',
  ).length, 2);
  assert.ok(output.stages.some(
    (stage) => stage.name === 'uncertainRecovery' && stage.status === 'DONE',
  ));
  const firstExecution = calls.findIndex(
    (call) => call.script === 'execute-dataverse-plan.js',
  );
  const recoveryReconciliation = calls.findIndex(
    (call, index) => index > firstExecution
      && call.script === 'create-dataverse-snapshot.js',
  );
  const secondExecution = calls.findIndex(
    (call, index) => index > recoveryReconciliation
      && call.script === 'execute-dataverse-plan.js',
  );
  assert.ok(firstExecution < recoveryReconciliation);
  assert.ok(recoveryReconciliation < secondExecution);
});

test('execution preserves structured post-publish mismatches', async (context) => {
  const files = executionFixture(context);
  const calls = [];
  const output = await runExecutionPipeline(executionArgs(files, {
    'skip-service-generation': true,
  }), {
    ...noTimingWrites(),
    runCommand: executionRunner(files, calls, { verificationStatus: 'BLOCKED' }),
  });
  assert.equal(output.status, 'BLOCKED');
  assert.equal(output.reasonCode, 'POST_PUBLISH_VERIFICATION_FAILED');
  assert.equal(output.verification.mismatches[0].fact, 'column');
  assert.equal(calls.some((call) => call.command === 'npm'), false);
});

test('create-mobile-app routes deterministic phases through the parent pipeline', () => {
  const skill = fs.readFileSync(path.resolve(
    __dirname,
    '../../skills/create-mobile-app/SKILL.md',
  ), 'utf8');
  const planning = skill.slice(
    skill.indexOf('### Step 3.0'),
    skill.indexOf('### Step 4'),
  );
  const scaffold = skill.slice(
    skill.indexOf('### Step 5'),
    skill.indexOf('### Step 6.7'),
  );
  const execution = skill.slice(
    skill.indexOf('> "→ [Step 8/13]'),
    skill.indexOf('### Step 8.5'),
  );
  assert.match(planning, /run-mobile-app-pipeline\.js" planning/);
  assert.equal((planning.match(/run-mobile-app-pipeline\.js" planning/g) || []).length, 4);
  assert.match(scaffold, /run-mobile-app-pipeline\.js" scaffold/);
  assert.doesNotMatch(scaffold, /^\s*npx power-apps init/m);
  assert.doesNotMatch(scaffold, /^\s*npx tsc --noEmit/m);
  assert.match(execution, /run-mobile-app-pipeline\.js" execute/);
  assert.match(execution, /Do not invoke `\/add-dataverse`/);
  assert.match(execution, /skip the remainder of Step 8/);
});

test('add-dataverse approved path delegates to the execution pipeline', () => {
  const skill = fs.readFileSync(path.resolve(
    __dirname,
    '../../skills/add-dataverse/SKILL.md',
  ), 'utf8');
  assert.match(skill, /Approved-contract deterministic pipeline/);
  assert.match(skill, /run-mobile-app-pipeline\.js" execute/);
  assert.match(skill, /skip Steps 1 through 8/);
});