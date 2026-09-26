#!/usr/bin/env node

'use strict';

const { createDataverseRequestExecutor } = require('./dataverse-request');

const MAX_SINCE_HOURS = 168;
const DEFAULT_MAX_RECORDS = 10;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const RUNTIME_RUN_STATES = new Set(['unknown', 'observed', 'absent']);
const SOURCE_EVENTS = new Set(['created', 'updated', 'deleted']);

// Dataverse callbackregistration.message is a choice whose values encode one
// event or a supported combination: 1 Added, 2 Deleted, 3 Modified, and 4-7
// the corresponding combinations. Keep only normalized event names in output.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/callbackregistration
const CALLBACK_MESSAGE_EVENTS = new Map([
  [1, ['created']],
  [2, ['deleted']],
  [3, ['updated']],
  [4, ['created', 'updated']],
  [5, ['created', 'deleted']],
  [6, ['updated', 'deleted']],
  [7, ['created', 'updated', 'deleted']],
]);

class DiagnosticError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DiagnosticError';
    this.code = code;
  }
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function requireValue(args, index, flag) {
  if (!args[index + 1] || args[index + 1].startsWith('--')) {
    throw new DiagnosticError('invalid-arguments', `${flag} requires a value`);
  }
  return args[index + 1];
}

function parseArgs(argv = process.argv.slice(2), now = new Date()) {
  const parsed = {
    maxRecords: DEFAULT_MAX_RECORDS,
    producerRuntimeRunState: 'unknown',
    senderRuntimeRunState: 'unknown',
    queuedStatuses: [],
    terminalStatuses: [],
  };

  const valueFlags = new Map([
    ['--environment-url', 'environmentUrl'],
    ['--tenant-id', 'tenantId'],
    ['--source-entity-set', 'sourceEntitySet'],
    ['--source-record-id', 'sourceRecordId'],
    ['--source-event', 'sourceEvent'],
    ['--outbox-entity-set', 'outboxEntitySet'],
    ['--outbox-record-id', 'outboxRecordId'],
    ['--outbox-status-column', 'outboxStatusColumn'],
    ['--outbox-queued-statuses', 'queuedStatuses'],
    ['--outbox-terminal-statuses', 'terminalStatuses'],
    ['--producer-callback-workflow-id', 'producerCallbackWorkflowId'],
    ['--producer-runtime-resource-id', 'producerRuntimeResourceId'],
    ['--producer-runtime-run-state', 'producerRuntimeRunState'],
    ['--producer-runtime-run-id', 'producerRuntimeRunId'],
    ['--sender-callback-workflow-id', 'senderCallbackWorkflowId'],
    ['--sender-runtime-resource-id', 'senderRuntimeResourceId'],
    ['--sender-runtime-run-state', 'senderRuntimeRunState'],
    ['--sender-runtime-run-id', 'senderRuntimeRunId'],
    ['--since', 'since'],
    ['--max-records', 'maxRecords'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = valueFlags.get(flag);
    if (!key) {
      throw new DiagnosticError('invalid-arguments', 'An unsupported argument was provided');
    }
    const value = requireValue(argv, index, flag);
    index += 1;
    if (key === 'queuedStatuses' || key === 'terminalStatuses') {
      parsed[key] = parseList(value);
    } else if (key === 'maxRecords') {
      parsed[key] = Number(value);
    } else {
      parsed[key] = value;
    }
  }

  const required = [
    'environmentUrl',
    'tenantId',
    'sourceEntitySet',
    'sourceRecordId',
    'sourceEvent',
    'outboxEntitySet',
    'producerCallbackWorkflowId',
    'producerRuntimeResourceId',
    'senderCallbackWorkflowId',
    'senderRuntimeResourceId',
    'since',
  ];
  for (const key of required) {
    if (!parsed[key]) {
      throw new DiagnosticError('invalid-arguments', `${key} is required`);
    }
  }

  let environmentUrl;
  try {
    environmentUrl = new URL(parsed.environmentUrl);
  } catch {
    throw new DiagnosticError('invalid-arguments', 'environmentUrl must be an HTTPS URL');
  }
  if (environmentUrl.protocol !== 'https:') {
    throw new DiagnosticError('invalid-arguments', 'environmentUrl must be an HTTPS URL');
  }
  parsed.environmentUrl = environmentUrl.toString().replace(/\/+$/, '');

  for (const key of [
    'tenantId',
    'producerCallbackWorkflowId',
    'producerRuntimeResourceId',
    'senderCallbackWorkflowId',
    'senderRuntimeResourceId',
    'producerRuntimeRunId',
    'senderRuntimeRunId',
    'sourceRecordId',
    'outboxRecordId',
  ]) {
    if (parsed[key] && !GUID_PATTERN.test(parsed[key])) {
      throw new DiagnosticError('invalid-arguments', `${key} must be a GUID`);
    }
    if (parsed[key]) parsed[key] = parsed[key].toLowerCase();
  }

  for (const key of ['sourceEntitySet', 'outboxEntitySet', 'outboxStatusColumn']) {
    if (parsed[key] && !IDENTIFIER_PATTERN.test(parsed[key])) {
      throw new DiagnosticError('invalid-arguments', `${key} must be a Dataverse logical identifier`);
    }
  }

  for (const key of ['producerRuntimeRunState', 'senderRuntimeRunState']) {
    if (!RUNTIME_RUN_STATES.has(parsed[key])) {
      throw new DiagnosticError(
        'invalid-arguments',
        `${key} must be unknown, observed, or absent`,
      );
    }
    if (!SOURCE_EVENTS.has(parsed.sourceEvent)) {
      throw new DiagnosticError(
        'invalid-arguments',
        'sourceEvent must be created, updated, or deleted',
      );
    }
    for (const [key, statuses] of [
      ['queuedStatuses', parsed.queuedStatuses],
      ['terminalStatuses', parsed.terminalStatuses],
    ]) {
      if (statuses.some((status) => !/^-?\d+$/.test(status))) {
        throw new DiagnosticError('invalid-arguments', `${key} must contain choice integers`);
      }
    }
  }
  if (parsed.producerRuntimeRunState === 'observed' && !parsed.producerRuntimeRunId) {
    throw new DiagnosticError(
      'invalid-arguments',
      'producerRuntimeRunId is required when producerRuntimeRunState is observed',
    );
  }
  if (parsed.senderRuntimeRunState === 'observed' && !parsed.senderRuntimeRunId) {
    throw new DiagnosticError(
      'invalid-arguments',
      'senderRuntimeRunId is required when senderRuntimeRunState is observed',
    );
  }
  if (!Number.isInteger(parsed.maxRecords) || parsed.maxRecords < 1 || parsed.maxRecords > 20) {
    throw new DiagnosticError('invalid-arguments', 'maxRecords must be an integer from 1 to 20');
  }

  const since = new Date(parsed.since);
  if (Number.isNaN(since.getTime())) {
    throw new DiagnosticError('invalid-arguments', 'since must be an ISO-8601 timestamp');
  }
  const ageMs = now.getTime() - since.getTime();
  if (ageMs < 0) {
    throw new DiagnosticError('invalid-arguments', 'since cannot be in the future');
  }
  if (ageMs > MAX_SINCE_HOURS * 60 * 60 * 1000) {
    throw new DiagnosticError(
      'invalid-arguments',
      `since must be within the last ${MAX_SINCE_HOURS} hours`,
    );
  }
  parsed.since = since.toISOString();

  return parsed;
}

function escapeODataString(value) {
  return String(value).replace(/'/g, "''");
}

function values(response) {
  if (response && response.data && Array.isArray(response.data.value)) {
    return response.data.value;
  }
  return [];
}

function normalizeRequestFailure(response) {
  if (response && (response.status === 401 || response.status === 403)) {
    throw new DiagnosticError(
      'azure-auth-unavailable',
      'Azure CLI authentication is expired, unreadable, or not authorized for the target environment',
    );
  }
  throw new DiagnosticError('dataverse-read-failed', 'A bounded Dataverse read failed');
}

async function read(request, apiPath, allowNotFound = false) {
  let response;
  try {
    response = await request('GET', apiPath);
  } catch (error) {
    if (/Azure CLI token|az login|AADSTS|expired|authentication/i.test(String(error && error.message))) {
      throw new DiagnosticError(
        'azure-auth-unavailable',
        'Azure CLI authentication is expired or unreadable; run az login for the target tenant',
      );
    }
    throw new DiagnosticError('dataverse-read-failed', 'A bounded Dataverse read failed');
  }
  if (allowNotFound && response && response.status === 404) return null;
  if (!response || response.status < 200 || response.status >= 300) {
    normalizeRequestFailure(response);
  }
  return response.data || {};
}

async function resolveEntityMetadata(request, entitySetName) {
  const filter = escapeODataString(entitySetName);
  const data = await read(
    request,
    `EntityDefinitions?$select=EntitySetName,LogicalName,PrimaryIdAttribute&$filter=EntitySetName eq '${filter}'&$top=2`,
  );
  const matches = Array.isArray(data.value) ? data.value : [];
  if (matches.length !== 1 || !IDENTIFIER_PATTERN.test(matches[0].PrimaryIdAttribute || '')) {
    throw new DiagnosticError(
      'entity-set-unresolved',
      'A source or outbox entity set could not be resolved uniquely',
    );
  }
  return {
    primaryIdAttribute: matches[0].PrimaryIdAttribute,
    logicalName: matches[0].LogicalName,
  };
}

function dateValue(row, key) {
  const value = row && row[key];
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeGuid(value) {
  return GUID_PATTERN.test(String(value || '')) ? String(value).toLowerCase() : null;
}

function compatibleCallbackEvents(message) {
  const events = CALLBACK_MESSAGE_EVENTS.get(Number(message));
  return events ? [...events] : [];
}

function sanitizeRows(rows, primaryIdAttribute, statusColumn, queuedStatuses, terminalStatuses) {
  const queued = new Set(queuedStatuses.map(String));
  const terminal = new Set(terminalStatuses.map(String));
  return rows.map((row) => {
    let status = 'unknown';
    if (statusColumn && Object.hasOwn(row, statusColumn)) {
      const value = String(row[statusColumn]);
      status = queued.has(value) ? 'queued' : terminal.has(value) ? 'terminal' : 'other';
    }
    return {
      id: normalizeGuid(row[primaryIdAttribute]),
      createdAt: dateValue(row, 'createdon'),
      modifiedAt: dateValue(row, 'modifiedon'),
      status,
    };
  }).filter((row) => row.id);
}

function asyncStatus(job) {
  const state = Number(job.statecode);
  const status = Number(job.statuscode);
  if (state === 1) return 'suspended';
  if (status === 0 || status === 10) return 'ready-or-waiting';
  if (state === 2 || status === 20) return 'in-progress';
  if (state === 3 && status === 30) return 'succeeded';
  if (state === 3 && status === 31) return 'failed';
  if (state === 3 && status === 32) return 'canceled';
  if (state === 3) return 'completed';
  return 'unknown';
}

function latencyMs(start, end) {
  const startMs = timestampMs(start);
  const endMs = timestampMs(end);
  if (startMs === null || endMs === null || endMs < startMs) return null;
  return endMs - startMs;
}

function sanitizeJob(job) {
  const createdAt = dateValue(job, 'createdon');
  const startedAt = dateValue(job, 'startedon');
  const completedAt = dateValue(job, 'completedon');
  return {
    id: normalizeGuid(job.asyncoperationid),
    callbackWorkflowId: normalizeGuid(job._workflowactivationid_value),
    regardingRecordId: normalizeGuid(job._regardingobjectid_value),
    createdAt,
    startedAt,
    completedAt,
    queueLatencyMs: latencyMs(createdAt, startedAt),
    executionLatencyMs: latencyMs(startedAt, completedAt),
    status: asyncStatus(job),
  };
}

function sanitizeWorkflow(data, requestedId) {
  if (!data) {
    return {
      id: requestedId,
      status: 'missing',
      createdAt: null,
      modifiedAt: null,
    };
  }
  const state = Number(data.statecode);
  return {
    id: normalizeGuid(data.workflowid) || requestedId,
    status: state === 1 ? 'active' : state === 0 ? 'draft' : 'present',
    createdAt: dateValue(data, 'createdon'),
    modifiedAt: dateValue(data, 'modifiedon'),
  };
}

function sanitizeRegistrations(rows, runtimeResourceId, entityLogicalName) {
  return rows.filter((row) => (
    normalizeGuid(row.name) === runtimeResourceId
    && row.entityname === entityLogicalName
  )).map((row) => {
    const message = Number(row.message);
    const compatibleEvents = compatibleCallbackEvents(message);
    return {
      id: normalizeGuid(row.callbackregistrationid),
      createdAt: dateValue(row, 'createdon'),
      modifiedAt: dateValue(row, 'modifiedon'),
      message: compatibleEvents.length > 0 ? message : null,
      compatibleEvents,
      status: Number(row.softdeletestatus) === 0 ? 'present' : 'soft-deleted-or-unknown',
    };
  }).filter((row) => row.id);
}

function timestampMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function isWithinWindow(value, since, until) {
  const valueMs = timestampMs(value);
  const sinceMs = timestampMs(since);
  const untilMs = timestampMs(until);
  return valueMs !== null
    && sinceMs !== null
    && untilMs !== null
    && valueMs >= sinceMs
    && valueMs <= untilMs;
}

async function readCorrelatedJobs(
  request,
  { callbackWorkflowId, regardingRecordId, since, until, maxRecords },
) {
  if (!regardingRecordId) return [];
  const data = await read(
    request,
    'asyncoperations?'
      + '$select=asyncoperationid,_workflowactivationid_value,_regardingobjectid_value,'
      + 'statecode,statuscode,createdon,startedon,completedon'
      + `&$filter=operationtype eq 79 and _workflowactivationid_value eq ${callbackWorkflowId}`
      + ` and _regardingobjectid_value eq ${regardingRecordId}`
      + ` and createdon ge ${since} and createdon le ${until}`
      + `&$orderby=createdon desc&$top=${maxRecords}`,
  );

  // Operation type 79 identifies CallbackRegistration Expander jobs. The
  // workflowactivationid lookup binds the job to the Dataverse Workflow
  // record, while regardingobjectid binds it to the exact organic source row.
  // See:
  // https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/asyncoperation
  // https://learn.microsoft.com/power-apps/developer/data-platform/asynchronous-service
  return values({ data })
    .filter((job) => (
      normalizeGuid(job._workflowactivationid_value) === callbackWorkflowId
      && normalizeGuid(job._regardingobjectid_value) === regardingRecordId
    ))
    .map(sanitizeJob)
    .filter((job) => job.id && isWithinWindow(job.createdAt, since, until))
    .sort((left, right) => timestampMs(right.createdAt) - timestampMs(left.createdAt));
}

function addState(states, code, stage, evidence) {
  states.push({ code, stage, evidence });
}

function classifyOrganicCallbackChain({
  sourceRows,
  outboxRows,
  sourceEvent = 'created',
  sourceEvidenceState = sourceRows.length > 0 ? 'present' : 'queried-missing',
  outboxEvidenceState = outboxRows.length > 0 ? 'present' : 'unknown',
  producerWorkflowPresent = true,
  senderWorkflowPresent = true,
  producerRegistrationCount,
  senderRegistrationCount,
  producerCompatibleRegistrationCount = producerRegistrationCount,
  senderCompatibleRegistrationCount = senderRegistrationCount,
  producerJob,
  senderJob,
  producerRuntimeRunState,
  senderRuntimeRunState,
}) {
  const states = [];
  const hasOutbox = outboxRows.length > 0;
  const hasQueuedOutbox = outboxRows.some((row) => row.status === 'queued');
  const hasTerminalOutbox = outboxRows.some((row) => row.status === 'terminal');

  if (sourceEvidenceState === 'queried-missing' && sourceEvent !== 'deleted' && !producerJob) {
    addState(states, 'missing-source-record', 'producer', 'dataverse');
  } else if (!producerWorkflowPresent || producerRegistrationCount === 0) {
    addState(states, 'missing-registration', 'producer', 'dataverse');
  } else if (producerCompatibleRegistrationCount === 0) {
    addState(states, 'registration-event-mismatch', 'producer', 'dataverse');
  } else if (!producerJob) {
    addState(states, 'missing-job', 'producer', 'dataverse');
  } else if (producerJob && producerJob.status === 'ready-or-waiting' && !producerJob.startedAt) {
    addState(states, 'dataverse-async-backlog', 'producer', 'dataverse');
  } else if (producerJob && producerJob.status === 'failed') {
    addState(states, 'callback-job-failed', 'producer', 'dataverse');
  } else if (producerJob && producerJob.status === 'canceled') {
    addState(states, 'callback-job-canceled', 'producer', 'dataverse');
  } else if (producerJob && producerJob.status === 'suspended') {
    addState(states, 'callback-job-suspended', 'producer', 'dataverse');
  } else if (
    producerJob
    && ['succeeded', 'completed'].includes(producerJob.status)
    && producerRuntimeRunState === 'absent'
  ) {
    addState(states, 'identity-routing', 'producer', 'runtime-history');
  } else if (
    outboxEvidenceState === 'queried-missing'
    && producerRuntimeRunState === 'observed'
  ) {
    addState(states, 'producer-no-outbox', 'producer', 'dataverse');
  }

  if (hasOutbox) {
    if (!senderWorkflowPresent || senderRegistrationCount === 0) {
      addState(states, 'missing-registration', 'sender', 'dataverse');
    } else if (senderCompatibleRegistrationCount === 0) {
      addState(states, 'registration-event-mismatch', 'sender', 'dataverse');
    } else if (senderJob && senderJob.status === 'failed') {
      addState(states, 'callback-job-failed', 'sender', 'dataverse');
    } else if (senderJob && senderJob.status === 'canceled') {
      addState(states, 'callback-job-canceled', 'sender', 'dataverse');
    } else if (senderJob && senderJob.status === 'suspended') {
      addState(states, 'callback-job-suspended', 'sender', 'dataverse');
    } else if (hasQueuedOutbox && !senderJob) {
      addState(states, 'queued-outbox-no-sender', 'sender', 'dataverse');
    } else if (
      hasQueuedOutbox
      && senderJob.status === 'ready-or-waiting'
      && !senderJob.startedAt
    ) {
      addState(states, 'dataverse-async-backlog', 'sender', 'dataverse');
    } else if (
      hasQueuedOutbox
      && ['succeeded', 'completed'].includes(senderJob.status)
      && senderRuntimeRunState === 'absent'
    ) {
      addState(states, 'identity-routing', 'sender', 'runtime-history');
    }
  }

  if (hasTerminalOutbox) {
    addState(states, 'terminal-sender', 'sender', 'dataverse');
  }
  if (states.length === 0) {
    addState(states, 'insufficient-or-healthy-snapshot', 'chain', 'bounded-snapshot');
  }
  return states;
}

async function runDiagnostic(options, dependencies = {}) {
  const now = dependencies.now || new Date();
  const request = dependencies.request || createDataverseRequestExecutor({
    environmentUrl: options.environmentUrl,
    tenantId: options.tenantId,
  });

  const [sourceMetadata, outboxMetadata] = await Promise.all([
    resolveEntityMetadata(request, options.sourceEntitySet),
    resolveEntityMetadata(request, options.outboxEntitySet),
  ]);
  if (
    !IDENTIFIER_PATTERN.test(sourceMetadata.logicalName || '')
    || !IDENTIFIER_PATTERN.test(outboxMetadata.logicalName || '')
  ) {
    throw new DiagnosticError(
      'entity-set-unresolved',
      'A source or outbox logical name could not be resolved safely',
    );
  }
  const selectOutbox = [
    outboxMetadata.primaryIdAttribute,
    'createdon',
    'modifiedon',
    options.outboxStatusColumn,
  ].filter(Boolean).join(',');
  const sinceFilter = escapeODataString(options.since);
  const untilFilter = escapeODataString(now.toISOString());

  // Every query is an allowlist-only GET. In particular, callback URLs,
  // runtime integration properties, owners/OIDs, notification content,
  // payloads, provider responses, and authentication fields are never selected.
  const [
    producerWorkflow,
    senderWorkflow,
    producerRegistrations,
    senderRegistrations,
    sourceRecord,
    outboxRecord,
  ] = await Promise.all([
    read(
      request,
      `workflows(${options.producerCallbackWorkflowId})?$select=workflowid,statecode,statuscode,createdon,modifiedon`,
      true,
    ),
    read(
      request,
      `workflows(${options.senderCallbackWorkflowId})?$select=workflowid,statecode,statuscode,createdon,modifiedon`,
      true,
    ),
    read(
      request,
      'callbackregistrations?'
        + '$select=callbackregistrationid,name,entityname,message,createdon,modifiedon,softdeletestatus'
        + `&$filter=name eq '${options.producerRuntimeResourceId}'`
        + ` and entityname eq '${sourceMetadata.logicalName}' and softdeletestatus eq 0`
        + `&$orderby=createdon desc&$top=${options.maxRecords}`,
    ),
    read(
      request,
      'callbackregistrations?'
        + '$select=callbackregistrationid,name,entityname,message,createdon,modifiedon,softdeletestatus'
        + `&$filter=name eq '${options.senderRuntimeResourceId}'`
        + ` and entityname eq '${outboxMetadata.logicalName}' and softdeletestatus eq 0`
        + `&$orderby=createdon desc&$top=${options.maxRecords}`,
    ),
    read(
      request,
      `${options.sourceEntitySet}(${options.sourceRecordId})?$select=${sourceMetadata.primaryIdAttribute},createdon,modifiedon`,
      true,
    ),
    options.outboxRecordId
      ? read(
        request,
        `${options.outboxEntitySet}(${options.outboxRecordId})?$select=${selectOutbox}`,
        true,
      )
      : Promise.resolve(null),
  ]);

  const sourceRows = sanitizeRows(
    sourceRecord ? [sourceRecord] : [],
    sourceMetadata.primaryIdAttribute,
    null,
    [],
    [],
  ).filter((row) => row.id === options.sourceRecordId);
  const outboxRows = sanitizeRows(
    outboxRecord ? [outboxRecord] : [],
    outboxMetadata.primaryIdAttribute,
    options.outboxStatusColumn,
    options.queuedStatuses,
    options.terminalStatuses,
  ).filter((row) => row.id === options.outboxRecordId);

  // The callback-expander job's createdon is the event-time boundary. Row
  // createdon cannot be used here: an update can target an old row, and a
  // delete legitimately leaves no row to read after the organic event.
  const sourceEvidenceState = sourceRows.length > 0 ? 'present' : 'queried-missing';

  // No outbox ID means no outbox GET was attempted. Preserve that as unknown
  // instead of treating an empty local row array as proof that production
  // failed to create the expected row.
  const outboxEvidenceState = !options.outboxRecordId
    ? 'unknown'
    : outboxRows.length > 0 ? 'present' : 'queried-missing';
  const [producerJobs, senderJobs] = await Promise.all([
    readCorrelatedJobs(request, {
      callbackWorkflowId: options.producerCallbackWorkflowId,
      regardingRecordId: options.sourceRecordId,
      since: sinceFilter,
      until: untilFilter,
      maxRecords: options.maxRecords,
    }),
    readCorrelatedJobs(request, {
      callbackWorkflowId: options.senderCallbackWorkflowId,
      regardingRecordId: outboxRows[0] && outboxRows[0].id,
      since: sinceFilter,
      until: untilFilter,
      maxRecords: options.maxRecords,
    }),
  ]);
  const producerJob = producerJobs[0] || null;
  const senderJob = senderJobs[0] || null;

  // Microsoft documents that a GUID-valued callbackregistration.name is the
  // Power Automate flow ID. For row webhooks, require that exact runtime ID,
  // the exact trigger table logical name, and a non-deleted registration;
  // substring matching a Dataverse Workflow ID is neither necessary nor safe.
  // See:
  // https://learn.microsoft.com/power-apps/developer/data-platform/bypass-power-automate-flows
  const producerRegistrationRows = sanitizeRegistrations(
    values({ data: producerRegistrations }),
    options.producerRuntimeResourceId,
    sourceMetadata.logicalName,
  );
  const senderRegistrationRows = sanitizeRegistrations(
    values({ data: senderRegistrations }),
    options.senderRuntimeResourceId,
    outboxMetadata.logicalName,
  );
  const states = classifyOrganicCallbackChain({
    sourceRows,
    outboxRows,
    sourceEvent: options.sourceEvent,
    sourceEvidenceState,
    outboxEvidenceState,
    producerWorkflowPresent: Boolean(producerWorkflow),
    senderWorkflowPresent: Boolean(senderWorkflow),
    producerRegistrationCount: producerRegistrationRows
      .filter((row) => row.status === 'present').length,
    senderRegistrationCount: senderRegistrationRows
      .filter((row) => row.status === 'present').length,
    producerCompatibleRegistrationCount: producerRegistrationRows
      .filter((row) => (
        row.status === 'present'
        && row.compatibleEvents.includes(options.sourceEvent)
      )).length,
    senderCompatibleRegistrationCount: senderRegistrationRows
      .filter((row) => (
        row.status === 'present'
        && row.compatibleEvents.includes('created')
      )).length,
    producerJob,
    senderJob,
    producerRuntimeRunState: options.producerRuntimeRunState,
    senderRuntimeRunState: options.senderRuntimeRunState,
  });

  return {
    generatedAt: now.toISOString(),
    since: options.since,
    diagnosticWindow: {
      startAt: options.since,
      endAt: now.toISOString(),
      timestampBasis: 'callback-job-createdon',
    },
    identities: {
      producer: {
        callbackWorkflowId: options.producerCallbackWorkflowId,
        runtimeResourceId: options.producerRuntimeResourceId,
        runtimeRunId: options.producerRuntimeRunId || null,
        runtimeRunStatus: options.producerRuntimeRunState,
      },
      sender: {
        callbackWorkflowId: options.senderCallbackWorkflowId,
        runtimeResourceId: options.senderRuntimeResourceId,
        runtimeRunId: options.senderRuntimeRunId || null,
        runtimeRunStatus: options.senderRuntimeRunState,
      },
    },
    correlation: {
      sourceEvent: options.sourceEvent,
      sourceRecordId: options.sourceRecordId,
      outboxRecordId: options.outboxRecordId || null,
      sourceEvidence: sourceEvidenceState,
      outboxEvidence: outboxEvidenceState,
    },
    workflows: {
      producer: sanitizeWorkflow(producerWorkflow, options.producerCallbackWorkflowId),
      sender: sanitizeWorkflow(senderWorkflow, options.senderCallbackWorkflowId),
    },
    callbackRegistrations: {
      producer: producerRegistrationRows,
      sender: senderRegistrationRows,
    },
    callbackJobs: {
      producer: producerJob,
      sender: senderJob,
    },
    sourceRecords: sourceRows,
    outboxRecords: outboxRows,
    classifications: states,
  };
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  try {
    const now = dependencies.now || new Date();
    const options = parseArgs(argv, now);
    const result = await runDiagnostic(options, { ...dependencies, now });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const safeError = error instanceof DiagnosticError
      ? error
      : new DiagnosticError('diagnostic-failed', 'The callback diagnostic failed safely');
    stderr.write(`${JSON.stringify({ error: safeError.code, status: safeError.message })}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  DiagnosticError,
  MAX_SINCE_HOURS,
  asyncStatus,
  classifyOrganicCallbackChain,
  compatibleCallbackEvents,
  main,
  parseArgs,
  runDiagnostic,
};
