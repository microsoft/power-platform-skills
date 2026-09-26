'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  asyncStatus,
  classifyOrganicCallbackChain,
  compatibleCallbackEvents,
  main,
  parseArgs,
  runDiagnostic,
} = require('../diagnose-dataverse-callback-health');

const NOW = new Date('2026-09-08T12:00:00.000Z');
const IDS = {
  tenant: '10000000-0000-4000-8000-000000000001',
  producerWorkflow: '20000000-0000-4000-8000-000000000002',
  producerRuntime: '30000000-0000-4000-8000-000000000003',
  senderWorkflow: '40000000-0000-4000-8000-000000000004',
  senderRuntime: '50000000-0000-4000-8000-000000000005',
  source: '60000000-0000-4000-8000-000000000006',
  outbox: '70000000-0000-4000-8000-000000000007',
  producerRegistration: '80000000-0000-4000-8000-000000000008',
  senderRegistration: '90000000-0000-4000-8000-000000000009',
  producerJob: 'a0000000-0000-4000-8000-00000000000a',
  senderJob: 'b0000000-0000-4000-8000-00000000000b',
  unrelatedWorkflow: 'c0000000-0000-4000-8000-00000000000c',
  unrelatedRecord: 'd0000000-0000-4000-8000-00000000000d',
  unrelatedJob: 'e0000000-0000-4000-8000-00000000000e',
};

function args(extra = []) {
  return [
    '--environment-url', 'https://contoso.crm.dynamics.com',
    '--tenant-id', IDS.tenant,
    '--source-entity-set', 'new_sources',
    '--source-record-id', IDS.source,
    '--source-event', 'created',
    '--outbox-entity-set', 'new_pushnotifications',
    '--outbox-record-id', IDS.outbox,
    '--outbox-status-column', 'new_status',
    '--outbox-queued-statuses', '100000001',
    '--outbox-terminal-statuses', '100000003,100000004',
    '--producer-callback-workflow-id', IDS.producerWorkflow,
    '--producer-runtime-resource-id', IDS.producerRuntime,
    '--sender-callback-workflow-id', IDS.senderWorkflow,
    '--sender-runtime-resource-id', IDS.senderRuntime,
    '--since', '2026-09-08T11:00:00.000Z',
    ...extra,
  ];
}

test('argument parsing requires distinct identity roles without requiring equal IDs', () => {
  const parsed = parseArgs(args(), NOW);
  assert.equal(parsed.producerCallbackWorkflowId, IDS.producerWorkflow);
  assert.equal(parsed.producerRuntimeResourceId, IDS.producerRuntime);
  assert.notEqual(parsed.producerCallbackWorkflowId, parsed.producerRuntimeResourceId);
  assert.throws(
    () => parseArgs(args().toSpliced(-2, 2, '--since', '2026-08-01T00:00:00Z'), NOW),
    /within the last 168 hours/,
  );
  assert.throws(
    () => parseArgs(args(['--producer-runtime-run-state', 'observed']), NOW),
    /producerRuntimeRunId is required/,
  );
  assert.equal(parseArgs(args(['--source-event', 'updated']), NOW).sourceEvent, 'updated');
  assert.equal(parseArgs(args(['--source-event', 'deleted']), NOW).sourceEvent, 'deleted');
  assert.throws(
    () => parseArgs(args(['--source-event', 'upserted']), NOW),
    /sourceEvent must be created, updated, or deleted/,
  );
});

test('organic callback classifications cover each owning boundary', () => {
  const sourceRows = [{ id: IDS.source, createdAt: '2026-09-08T11:10:00.000Z', status: 'unknown' }];
  const queuedOutbox = [{ id: IDS.outbox, createdAt: '2026-09-08T11:20:00.000Z', status: 'queued' }];
  const terminalOutbox = [{ ...queuedOutbox[0], status: 'terminal' }];
  const backlog = {
    id: IDS.producerJob,
    createdAt: '2026-09-08T11:11:00.000Z',
    startedAt: null,
    completedAt: null,
    status: 'ready-or-waiting',
  };
  const completed = { ...backlog, startedAt: '2026-09-08T11:11:01.000Z', status: 'succeeded' };

  const classify = (overrides) => classifyOrganicCallbackChain({
    sourceRows,
    outboxRows: queuedOutbox,
    sourceEvent: 'created',
    sourceEvidenceState: 'present',
    outboxEvidenceState: 'present',
    producerRegistrationCount: 1,
    senderRegistrationCount: 1,
    producerJob: completed,
    senderJob: completed,
    producerRuntimeRunState: 'observed',
    senderRuntimeRunState: 'observed',
    ...overrides,
  }).map(({ code, stage }) => `${stage}:${code}`);

  assert.ok(classify({ producerRegistrationCount: 0 }).includes('producer:missing-registration'));
  assert.ok(classify({
    sourceRows: [],
    sourceEvidenceState: 'queried-missing',
    producerJob: null,
  }).includes('producer:missing-source-record'));
  assert.ok(classify({
    producerWorkflowPresent: false,
  }).includes('producer:missing-registration'));
  assert.ok(classify({
    producerJob: null,
    outboxRows: [],
    outboxEvidenceState: 'queried-missing',
  }).includes('producer:missing-job'));
  assert.ok(classify({ producerJob: backlog }).includes('producer:dataverse-async-backlog'));
  assert.ok(classify({
    producerRuntimeRunState: 'absent',
  }).includes('producer:identity-routing'));
  assert.ok(classify({
    outboxRows: [],
    outboxEvidenceState: 'queried-missing',
  }).includes('producer:producer-no-outbox'));
  assert.ok(!classify({
    outboxRows: [],
    outboxEvidenceState: 'unknown',
  }).includes('producer:producer-no-outbox'));
  assert.ok(!classify({
    outboxRows: [],
    outboxEvidenceState: 'queried-missing',
    producerRuntimeRunState: 'unknown',
  }).includes('producer:producer-no-outbox'));
  assert.ok(classify({
    senderJob: null,
  }).includes('sender:queued-outbox-no-sender'));
  assert.ok(classify({
    outboxRows: terminalOutbox,
  }).includes('sender:terminal-sender'));

  assert.ok(classify({
    producerCompatibleRegistrationCount: 0,
  }).includes('producer:registration-event-mismatch'));
  assert.ok(classify({
    senderCompatibleRegistrationCount: 0,
  }).includes('sender:registration-event-mismatch'));

  for (const status of ['failed', 'canceled', 'suspended']) {
    const producerStates = classify({
      producerJob: { ...completed, status },
    });
    assert.ok(producerStates.includes(`producer:callback-job-${status}`));
    assert.ok(!producerStates.includes('chain:insufficient-or-healthy-snapshot'));

    const senderStates = classify({
      senderJob: { ...completed, status },
    });
    assert.ok(senderStates.includes(`sender:callback-job-${status}`));
    assert.ok(!senderStates.includes('chain:insufficient-or-healthy-snapshot'));
  }

  const failedTerminalSender = classify({
    outboxRows: terminalOutbox,
    senderJob: { ...completed, status: 'failed' },
  });
  assert.ok(failedTerminalSender.includes('sender:callback-job-failed'));
  assert.ok(failedTerminalSender.includes('sender:terminal-sender'));
});

test('Dataverse async states preserve suspended, failed, and canceled jobs', () => {
  assert.equal(asyncStatus({ statecode: 1, statuscode: 10 }), 'suspended');
  assert.equal(asyncStatus({ statecode: 3, statuscode: 31 }), 'failed');
  assert.equal(asyncStatus({ statecode: 3, statuscode: 32 }), 'canceled');
});

test('callback registration message choices map to documented event combinations', () => {
  assert.deepStrictEqual(compatibleCallbackEvents(1), ['created']);
  assert.deepStrictEqual(compatibleCallbackEvents(2), ['deleted']);
  assert.deepStrictEqual(compatibleCallbackEvents(3), ['updated']);
  assert.deepStrictEqual(compatibleCallbackEvents(4), ['created', 'updated']);
  assert.deepStrictEqual(compatibleCallbackEvents(5), ['created', 'deleted']);
  assert.deepStrictEqual(compatibleCallbackEvents(6), ['updated', 'deleted']);
  assert.deepStrictEqual(
    compatibleCallbackEvents(7),
    ['created', 'updated', 'deleted'],
  );
  assert.deepStrictEqual(compatibleCallbackEvents(99), []);
});

function fakeRequest(paths, overrides = {}) {
  return async (method, apiPath) => {
    paths.push({ method, apiPath });
    if (apiPath.startsWith('EntityDefinitions')) {
      const source = apiPath.includes("new_sources");
      return {
        status: 200,
        data: {
          value: [{
            EntitySetName: source ? 'new_sources' : 'new_pushnotifications',
            LogicalName: source ? 'new_source' : 'new_pushnotification',
            PrimaryIdAttribute: source ? 'new_sourceid' : 'new_pushnotificationid',
          }],
        },
      };
    }
    if (apiPath.startsWith(`workflows(${IDS.producerWorkflow})`)) {
      return {
        status: 200,
        data: {
          workflowid: IDS.producerWorkflow,
          statecode: 1,
          createdon: '2026-09-01T10:00:00Z',
          modifiedon: '2026-09-08T10:00:00Z',
        },
      };
    }
    if (apiPath.startsWith(`workflows(${IDS.senderWorkflow})`)) {
      return {
        status: 200,
        data: {
          workflowid: IDS.senderWorkflow,
          statecode: 1,
          createdon: '2026-09-01T10:00:00Z',
          modifiedon: '2026-09-08T10:00:00Z',
        },
      };
    }
    if (apiPath.startsWith('callbackregistrations')) {
      const producer = apiPath.includes(IDS.producerRuntime);
      return {
        status: 200,
        data: {
          value: [{
            callbackregistrationid: producer
              ? IDS.producerRegistration
              : IDS.senderRegistration,
            name: producer ? IDS.producerRuntime : IDS.senderRuntime,
            entityname: producer ? 'new_source' : 'new_pushnotification',
            message: producer
              ? overrides.producerMessage ?? 4
              : overrides.senderMessage ?? 1,
            createdon: '2026-09-01T10:05:00Z',
            modifiedon: '2026-09-08T10:05:00Z',
            softdeletestatus: 0,
            url: 'https://prohibited.example/callback',
            runtimeintegrationproperties: 'Bearer prohibited',
          }],
        },
      };
    }
    if (apiPath.startsWith('asyncoperations')) {
      const producer = apiPath.includes(IDS.producerWorkflow);
      const exactJob = producer
        ? {
          asyncoperationid: IDS.producerJob,
          _workflowactivationid_value: IDS.producerWorkflow,
          _regardingobjectid_value: IDS.source,
          statecode: 3,
          statuscode: 30,
          createdon: '2026-09-08T11:11:00Z',
          startedon: '2026-09-08T11:11:01Z',
          completedon: '2026-09-08T11:11:02Z',
        }
        : {
          asyncoperationid: IDS.senderJob,
          _workflowactivationid_value: IDS.senderWorkflow,
          _regardingobjectid_value: IDS.outbox,
          statecode: 0,
          statuscode: 10,
          createdon: '2026-09-08T11:21:00Z',
          startedon: null,
          completedon: null,
        };
      return {
        status: 200,
        data: {
          value: [
            {
              asyncoperationid: IDS.unrelatedJob,
              _workflowactivationid_value: IDS.unrelatedWorkflow,
              _regardingobjectid_value: IDS.unrelatedRecord,
              statecode: 3,
              statuscode: 30,
              createdon: producer ? '2026-09-08T11:10:30Z' : '2026-09-08T11:20:30Z',
              startedon: producer ? '2026-09-08T11:10:31Z' : '2026-09-08T11:20:31Z',
              completedon: producer ? '2026-09-08T11:10:32Z' : '2026-09-08T11:20:32Z',
            },
            exactJob,
          ],
        },
      };
    }
    if (apiPath.startsWith(`new_sources(${IDS.source})?`)) {
      return {
        status: 200,
        data: {
          new_sourceid: IDS.source,
          createdon: '2026-08-01T11:10:00Z',
          modifiedon: '2026-09-08T11:10:00Z',
          owneroid: 'c0000000-0000-4000-8000-00000000000c',
          title: 'prohibited title',
        },
      };
    }
    if (apiPath.startsWith(`new_pushnotifications(${IDS.outbox})?`)) {
      return {
        status: 200,
        data: {
          new_pushnotificationid: IDS.outbox,
          createdon: '2026-09-08T11:20:00Z',
          modifiedon: '2026-09-08T11:20:00Z',
          new_status: 100000001,
          body: 'prohibited body',
          payload: '{"secret":"prohibited"}',
        },
      };
    }
    throw new Error(`Unexpected path: ${apiPath}`);
  };
}

test('diagnostic performs bounded read-only allowlisted queries and sanitizes output', async () => {
  const paths = [];
  const options = parseArgs(args([
    '--source-event', 'updated',
    '--producer-runtime-run-state', 'absent',
    '--sender-runtime-run-state', 'unknown',
  ]), NOW);
  const result = await runDiagnostic(options, {
    request: fakeRequest(paths),
    now: NOW,
  });
  const serialized = JSON.stringify(result);

  assert.ok(paths.length > 0);
  assert.ok(paths.every(({ method }) => method === 'GET'));
  assert.ok(paths.some(({ apiPath }) => apiPath.startsWith(`new_sources(${IDS.source})?`)));
  assert.ok(paths.some(({ apiPath }) => apiPath.startsWith(`new_pushnotifications(${IDS.outbox})?`)));
  assert.ok(paths.every(({ apiPath }) => !apiPath.startsWith('new_sources?')));
  assert.ok(paths.every(({ apiPath }) => !apiPath.startsWith('new_pushnotifications?')));
  assert.ok(paths.every(({ apiPath }) => !/url|runtimeintegrationproperties|owner|title|body|payload|provider|auth/i.test(
    apiPath.split('$select=')[1]?.split('&')[0] || '',
  )));
  assert.match(serialized, /identity-routing/);
  assert.match(serialized, /dataverse-async-backlog/);
  assert.doesNotMatch(serialized, new RegExp(IDS.unrelatedJob));
  assert.doesNotMatch(serialized, /prohibited|owneroid|title|body|payload|provider|Bearer/i);
  assert.equal(result.identities.producer.callbackWorkflowId, IDS.producerWorkflow);
  assert.equal(result.identities.producer.runtimeResourceId, IDS.producerRuntime);
  assert.equal(result.correlation.sourceEvent, 'updated');
  assert.equal(result.correlation.sourceRecordId, IDS.source);
  assert.equal(result.correlation.outboxRecordId, IDS.outbox);
  assert.equal(result.correlation.sourceEvidence, 'present');
  assert.equal(result.correlation.outboxEvidence, 'present');
  assert.equal(result.sourceRecords[0].createdAt, '2026-08-01T11:10:00.000Z');
  assert.equal(result.diagnosticWindow.timestampBasis, 'callback-job-createdon');
  assert.equal(result.callbackJobs.producer.id, IDS.producerJob);
  assert.equal(result.callbackJobs.producer.callbackWorkflowId, IDS.producerWorkflow);
  assert.equal(result.callbackJobs.producer.regardingRecordId, IDS.source);
  assert.equal(result.callbackJobs.producer.queueLatencyMs, 1000);
  assert.equal(result.callbackJobs.producer.executionLatencyMs, 1000);
  assert.equal(result.callbackJobs.sender.id, IDS.senderJob);
  assert.equal(result.callbackJobs.sender.queueLatencyMs, null);
  assert.equal(result.callbackJobs.sender.executionLatencyMs, null);
  const asyncPaths = paths.filter(({ apiPath }) => apiPath.startsWith('asyncoperations'));
  assert.equal(asyncPaths.length, 2);
  assert.ok(asyncPaths.some(({ apiPath }) => (
    apiPath.includes(`_workflowactivationid_value eq ${IDS.producerWorkflow}`)
    && apiPath.includes(`_regardingobjectid_value eq ${IDS.source}`)
    && apiPath.includes('createdon ge 2026-09-08T11:00:00.000Z')
    && apiPath.includes('createdon le 2026-09-08T12:00:00.000Z')
  )));
  assert.ok(asyncPaths.some(({ apiPath }) => (
    apiPath.includes(`_workflowactivationid_value eq ${IDS.senderWorkflow}`)
    && apiPath.includes(`_regardingobjectid_value eq ${IDS.outbox}`)
  )));
  const callbackPaths = paths.filter(({ apiPath }) => apiPath.startsWith('callbackregistrations'));
  assert.ok(callbackPaths.every(({ apiPath }) => !apiPath.includes('contains(')));
  assert.ok(callbackPaths.some(({ apiPath }) => (
    apiPath.includes('$select=callbackregistrationid,name,entityname,message,')
    &&
    apiPath.includes(`name eq '${IDS.producerRuntime}'`)
    && apiPath.includes("entityname eq 'new_source'")
  )));
  assert.equal(result.callbackRegistrations.producer[0].message, 4);
  assert.deepStrictEqual(
    result.callbackRegistrations.producer[0].compatibleEvents,
    ['created', 'updated'],
  );
  assert.equal(result.callbackRegistrations.sender[0].message, 1);
  assert.deepStrictEqual(result.callbackRegistrations.sender[0].compatibleEvents, ['created']);
});

test('outbox evidence distinguishes unknown, queried-missing, and present', async () => {
  const unknownOptions = parseArgs(args([
    '--producer-runtime-run-state', 'observed',
    '--producer-runtime-run-id', IDS.producerJob,
  ]).filter((value, index, all) => (
    value !== '--outbox-record-id' && all[index - 1] !== '--outbox-record-id'
  )), NOW);
  const unknown = await runDiagnostic(unknownOptions, {
    request: fakeRequest([]),
    now: NOW,
  });
  assert.equal(unknown.correlation.outboxEvidence, 'unknown');
  assert.ok(!unknown.classifications.some(({ code }) => code === 'producer-no-outbox'));

  const missing = await runDiagnostic(
    parseArgs(args([
      '--producer-runtime-run-state', 'observed',
      '--producer-runtime-run-id', IDS.producerJob,
    ]), NOW),
    {
      request: async (method, apiPath) => {
        if (apiPath.startsWith(`new_pushnotifications(${IDS.outbox})?`)) {
          return { status: 404, data: {} };
        }
        return fakeRequest([])(method, apiPath);
      },
      now: NOW,
    },
  );
  assert.equal(missing.correlation.outboxEvidence, 'queried-missing');
  assert.equal(missing.correlation.outboxRecordId, IDS.outbox);
  assert.ok(missing.classifications.some(({ code }) => code === 'producer-no-outbox'));
});

test('a deleted source can be correlated by exact callback job within the window', async () => {
  const baseRequest = fakeRequest([], { producerMessage: 7 });
  const deleted = await runDiagnostic(parseArgs(args([
    '--source-event', 'deleted',
  ]), NOW), {
    request: async (method, apiPath) => {
      if (apiPath.startsWith(`new_sources(${IDS.source})?`)) {
        return { status: 404, data: {} };
      }
      return baseRequest(method, apiPath);
    },
    now: NOW,
  });

  assert.equal(deleted.correlation.sourceEvidence, 'queried-missing');
  assert.equal(deleted.callbackJobs.producer.regardingRecordId, IDS.source);
  assert.ok(!deleted.classifications.some(({ code }) => code === 'missing-source-record'));
});

test('registration message mismatches are classified for producer and sender', async () => {
  const producerMismatch = await runDiagnostic(parseArgs(args([
    '--source-event', 'deleted',
  ]), NOW), {
    request: fakeRequest([], { producerMessage: 4 }),
    now: NOW,
  });
  assert.ok(producerMismatch.classifications.some(({ code, stage }) => (
    code === 'registration-event-mismatch' && stage === 'producer'
  )));

  const senderMismatch = await runDiagnostic(parseArgs(args(), NOW), {
    request: fakeRequest([], { senderMessage: 3 }),
    now: NOW,
  });
  assert.ok(senderMismatch.classifications.some(({ code, stage }) => (
    code === 'registration-event-mismatch' && stage === 'sender'
  )));
});

test('client-side correlation rejects callback jobs outside the bounded window', async () => {
  const baseRequest = fakeRequest([]);
  const result = await runDiagnostic(parseArgs(args(), NOW), {
    request: async (method, apiPath) => {
      const response = await baseRequest(method, apiPath);
      if (
        apiPath.startsWith('asyncoperations')
        && apiPath.includes(IDS.producerWorkflow)
      ) {
        for (const row of response.data.value) {
          if (row.asyncoperationid === IDS.producerJob) {
            row.createdon = '2026-09-08T12:01:00Z';
          }
        }
      }
      return response;
    },
    now: NOW,
  });

  assert.equal(result.callbackJobs.producer, null);
  assert.ok(result.classifications.some(({ code }) => code === 'missing-job'));
});

test('unreadable or expired Azure CLI authentication fails with a bounded message', async () => {
  let stdout = '';
  let stderr = '';
  const code = await main(args(), {
    now: NOW,
    request: async () => {
      throw new Error('AADSTS700082 token expired for maker@contoso.example with secret value');
    },
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });

  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /azure-auth-unavailable/);
  assert.match(stderr, /az login/i);
  assert.doesNotMatch(stderr, /maker@|secret value|AADSTS700082/);
});
