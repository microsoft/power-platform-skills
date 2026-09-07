'use strict';

const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const protocol = require('./authoring-protocol');
const {
  MAX_JSON_BYTES, digest, canonicalJson, readJson, exists, atomicWrite, journalPath,
} = require('./mobile-authoring-files');
const { readDescriptor, validateContext, assertNoCredential } = require('./mobile-authoring-context');
const {
  questionBinding, currentBinding, prepareQuestion, questionDigest, verifyDecision,
} = require('./mobile-authoring-decisions');
const { AuthoringError, publicError } = require('./mobile-authoring-errors');

const DEFAULT_WAIT_MS = 30 * 60 * 1000;
const MAX_WAIT_MS = 2 * 60 * 60 * 1000;
const LONG_POLL_MS = 25_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TRANSPORT_ATTEMPTS = 3;
const MAX_CONNECTOR_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_DATAVERSE_BYTES = 32 * 1024 * 1024;
const DATAVERSE_EXECUTION_TIMEOUT_MS = 120_000;

function boundedWait(value = DEFAULT_WAIT_MS) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_WAIT_MS) {
    throw new AuthoringError('invalid-wait', 'Authoring wait must be between 1 ms and two hours');
  }
  return value;
}

async function readResponse(response, maximumBytes = MAX_JSON_BYTES) {
  if (Number(response.headers.get('content-length')) > maximumBytes) {
    await response.body?.cancel();
    throw new AuthoringError('invalid-response', 'Authoring bridge response exceeded its bound');
  }
  const chunks = [];
  let length = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > maximumBytes) {
          await reader.cancel();
          throw new AuthoringError('invalid-response', 'Authoring bridge response exceeded its bound');
        }
        chunks.push(Buffer.from(chunk.value));
      }
    } finally { reader.releaseLock(); }
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AuthoringError('invalid-response', 'Authoring bridge returned invalid JSON'); }
}

function statusError(status) {
  if (status === 401 || status === 403) return new AuthoringError('revoked', 'Authoring runner authorization is missing or revoked');
  if ([404, 409, 410].includes(status)) return new AuthoringError('stale-or-cancelled', 'Authoring attempt is stale, cancelled, or no longer available');
  if (status >= 300 && status < 400) return new AuthoringError('redirect', 'Authoring redirects are forbidden');
  return new AuthoringError('bridge-request-failed', `Authoring bridge rejected the request (HTTP ${status})`);
}

function createClient(options = {}) {
  const loaded = readDescriptor(options);
  if (!loaded) throw new AuthoringError('standalone', 'No Player job is active; use the ordinary foreground question tool');
  const { descriptor, token } = loaded;
  const fetchRequest = options.fetch || globalThis.fetch;
  const signal = options.signal;
  const wait = options.delay || delay;
  const root = descriptor.workspaceDir;
  let handshake;
  const prefix = `/runner/jobs/${encodeURIComponent(descriptor.jobId)}`;

  async function request(method, suffix, payload, {
    timeoutMs = REQUEST_TIMEOUT_MS, deadline, maximumResponseBytes = MAX_JSON_BYTES, retry = true,
  } = {}) {
    assertNoCredential(payload ?? {}, token);
    const body = payload === undefined ? undefined : canonicalJson(payload);
    if (body && Buffer.byteLength(body) > MAX_JSON_BYTES) throw new AuthoringError('payload-too-large', 'Authoring payload exceeded its bound');
    const maximumAttempts = retry ? MAX_TRANSPORT_ATTEMPTS : 1;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      if (signal?.aborted) throw new AuthoringError('cancelled', 'Authoring wait was cancelled');
      const remaining = deadline === undefined ? timeoutMs : Math.min(timeoutMs, deadline - Date.now());
      if (remaining <= 0) throw new AuthoringError('timeout', 'Authoring decision wait timed out; resume the same question');
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, remaining);
      let retryable = false;
      try {
        const response = await fetchRequest(`${descriptor.bridgeUrl}${prefix}${suffix}`, {
          method,
          headers: { 'x-runner-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body }),
          redirect: 'manual',
          signal: controller.signal,
        });
        if (!response.ok) {
          retryable = [408, 425, 429, 502, 503, 504].includes(response.status);
          await response.body?.cancel();
          throw statusError(response.status);
        }
        return await readResponse(response, maximumResponseBytes);
      } catch (error) {
        if (signal?.aborted) throw new AuthoringError('cancelled', 'Authoring wait was cancelled');
        if (error instanceof AuthoringError && !retryable) throw error;
        if (attempt === maximumAttempts - 1) {
          if (!retry) {
            throw new AuthoringError('execution-outcome-unknown', 'The desktop execution outcome is unknown; reconcile preserved remote evidence before retrying');
          }
          throw new AuthoringError('transport-unavailable', 'Authoring bridge is unavailable; resume the same request when it returns');
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
      // Retries retain the exact body/event ID. They never create another maker
      // question and never ask the language model to poll a URL.
      await wait(Math.min(250 * (2 ** attempt), Math.max(0, (deadline || Infinity) - Date.now())), undefined, { signal });
    }
    throw new AuthoringError('transport-unavailable', 'Authoring bridge is unavailable');
  }

  async function verify({ refresh = false } = {}) {
    if (handshake && !refresh) return handshake;
    const result = await request('GET', '/verify');
    protocol.object(result, 'runner handshake');
    if (result.protocolVersion !== descriptor.protocolVersion || result.protocolId !== protocol.PROTOCOL_ID
      || result.protocolHash !== descriptor.protocolHash || result.appInstanceId !== descriptor.appInstanceId
      || result.jobId !== descriptor.jobId || result.attemptId !== descriptor.attemptId
      || result.operation !== descriptor.operation || result.baseRevision !== descriptor.baseRevision
      || result.workspaceKind !== 'candidate' || result.active !== true
      || result.decisionPublicKey !== descriptor.decisionPublicKey) {
      throw new AuthoringError('handshake-mismatch', 'The active bridge attempt does not match this candidate workspace descriptor');
    }
    if (result.workspaceDir !== descriptor.workspaceDir) {
      throw new AuthoringError('workspace-mismatch', 'The bridge attempt belongs to another candidate workspace');
    }
    const context = result.context === undefined || result.context === null
      ? null : validateContext(result.context, descriptor);
    if (canonicalJson(context) !== canonicalJson(descriptor.context || null)) {
      throw new AuthoringError('context-mismatch', 'The captured context does not match the bridge-validated base publication');
    }
    const integration = result.integration === undefined || result.integration === null
      ? null : protocol.assertIntegrationSelection(result.integration);
    if (canonicalJson(integration) !== canonicalJson(descriptor.integration || null)) {
      throw new AuthoringError('integration-mismatch', 'The catalogue selection no longer matches this edit operation');
    }
    handshake = result;
    return result;
  }

  async function connectorMetadata(input) {
    protocol.object(input, 'connector metadata request');
    if (Object.keys(input).some((key) => !['url', 'authResource'].includes(key))) {
      throw new AuthoringError('invalid-metadata-request', 'Only the SDK metadata URL and authentication resource are permitted');
    }
    if (descriptor.operation !== 'edit' || descriptor.integration?.kind !== 'connector') {
      throw new AuthoringError('wrong-operation', 'SDK metadata transport requires the selected connector edit');
    }
    const url = protocol.text(input.url, 'connector metadata URL', 4000);
    const authResource = protocol.text(input.authResource, 'connector metadata resource', 1000);
    let parsed;
    try { parsed = new URL(url); } catch { throw new AuthoringError('invalid-metadata-request', 'SDK metadata requires an HTTPS URL'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
      throw new AuthoringError('invalid-metadata-request', 'SDK metadata URLs cannot contain credentials or fragments');
    }
    assertNoCredential(input, token);
    await verify({ refresh: true });
    // Only the bridge performs the GET after checking its exact selected
    // metadata allowlist and current artifact-bound grants. Never fetch url here.
    const result = await request('POST', '/connector-metadata', {
      attemptId: descriptor.attemptId, url, authResource,
    }, { maximumResponseBytes: MAX_CONNECTOR_METADATA_BYTES });
    protocol.object(result, 'connector metadata response');
    if (Object.keys(result).length !== 2 || result.status !== 200
      || !Object.prototype.hasOwnProperty.call(result, 'data')) {
      throw new AuthoringError('invalid-metadata-response', 'The scoped SDK metadata broker returned an invalid response');
    }
    assertNoCredential(result, token);
    return result;
  }

  async function dataverse(input) {
    protocol.object(input, 'Dataverse request');
    if (descriptor.operation !== 'connect') {
      throw new AuthoringError('wrong-operation', 'Dataverse desktop transport requires an explicit conversion job');
    }
    const fields = {
      'resolve-environment': ['target'],
      metadata: ['environmentUrl', 'method', 'apiPath'],
      'execute-manifest': ['environmentUrl', 'manifestHash'],
      'generate-services': ['environmentUrl', 'manifestHash'],
      init: ['environmentUrl'],
    };
    const operation = protocol.enumeration(input.operation, Object.keys(fields), 'Dataverse operation');
    if (Object.keys(input).some((key) => key !== 'operation' && !fields[operation].includes(key))) {
      throw new AuthoringError('invalid-dataverse-request', 'Dataverse requests accept only the bounded fields for their selected operation');
    }
    const payload = { attemptId: descriptor.attemptId, appInstanceId: descriptor.appInstanceId, operation };
    function text(value, label, maximum) {
      const result = protocol.text(value, label, maximum);
      if (result !== value || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new AuthoringError('invalid-dataverse-request', 'Dataverse request fields cannot contain surrounding whitespace or control characters');
      }
      return result;
    }
    function origin(value) {
      let parsed;
      try { parsed = new URL(value); } catch { /* Rejected below. */ }
      if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password
        || parsed.pathname !== '/' || parsed.search || parsed.hash) {
        throw new AuthoringError('invalid-dataverse-request', 'Dataverse environment URLs must be HTTPS origins without credentials or URL data');
      }
      return parsed;
    }
    function safe(value) {
      assertNoCredential(value, token);
      const serialized = JSON.stringify(value);
      if (/\bBearer\s+[A-Za-z0-9._~+/=-]+|\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(serialized)
        || /\\?["'](?:accessToken|access_token|refreshToken|refresh_token|clientSecret|client_secret|authorization)\\?["']\s*:/i.test(serialized)) {
        throw new AuthoringError('credentials-forbidden', 'Dataverse desktop transport cannot carry credentials');
      }
    }
    if (operation === 'resolve-environment') {
      payload.target = text(input.target, 'Dataverse target', 2000);
      if (/^[a-z][a-z\d+.-]*:/i.test(payload.target)) origin(payload.target);
    } else {
      payload.environmentUrl = text(input.environmentUrl, 'Dataverse environment URL', 2000);
      const environment = origin(payload.environmentUrl);
      if (operation === 'metadata') {
        payload.method = protocol.enumeration(input.method, ['GET'], 'Dataverse metadata method');
        payload.apiPath = text(input.apiPath, 'Dataverse metadata path', 16_000);
        let metadata;
        try { metadata = new URL(payload.apiPath, environment); } catch { /* Rejected below. */ }
        if (!metadata || metadata.origin !== environment.origin || metadata.username || metadata.password || metadata.hash
          || payload.apiPath.includes('\\')) {
          throw new AuthoringError('invalid-dataverse-request', 'Dataverse metadata paths must stay in the selected environment without credentials or fragments');
        }
      } else if (operation !== 'init') {
        payload.manifestHash = protocol.revision(input.manifestHash, 'Dataverse manifest hash');
      }
    }
    safe(payload);
    await verify({ refresh: true });
    const readOnly = operation === 'resolve-environment' || operation === 'metadata';
    // The bridge owns credentials, exact endpoint/manifest policy, and receipt
    // checks. This seam never executes a command or fetches the supplied URL.
    const result = await request('POST', '/dataverse', payload, {
      maximumResponseBytes: MAX_DATAVERSE_BYTES,
      timeoutMs: readOnly ? REQUEST_TIMEOUT_MS : DATAVERSE_EXECUTION_TIMEOUT_MS,
      retry: readOnly,
    });
    protocol.object(result, 'Dataverse response');
    safe(result);
    return result;
  }

  function assertCurrent(binding) {
    if (currentBinding(root, binding).sourceRevision !== binding.sourceRevision) {
      throw new AuthoringError('stale-artifacts', 'Question artifacts changed; reopen the owning gate instead of reusing its decision');
    }
  }

  async function requestQuestion(input, questionOptions = {}) {
    await verify({ refresh: true });
    const binding = questionBinding(root, questionOptions);
    const question = prepareQuestion(input, binding, descriptor);
    assertNoCredential(question, token);
    const requestPath = journalPath(descriptor, `questions/${digest(question.id)}.json`);
    let stored = exists(root, requestPath) ? readJson(root, requestPath) : null;
    const payload = { attemptId: descriptor.attemptId, ...question };
    if (stored && (canonicalJson(stored.question) !== canonicalJson(question)
      || canonicalJson(stored.binding) !== canonicalJson(binding))) {
      throw new AuthoringError('question-conflict', 'A question ID cannot be reused for different content or artifact bindings');
    }
    if (!stored) {
      stored = { schemaVersion: 1, question, binding, state: 'requesting' };
      atomicWrite(root, requestPath, stored, { exclusive: true });
    }
    // Re-send the immutable POST even on resume: the bridge is authoritative
    // about the active approval revision and invalidates stale local receipts.
    const response = await request('POST', '/questions', payload);
    const approvalId = protocol.id(response.approvalId, 'question acknowledgement.approvalId');
    const approvalRevision = protocol.integer(response.approvalRevision, 'question acknowledgement.approvalRevision', 1);
    if (response.questionDigest !== questionDigest(question)) {
      throw new AuthoringError('question-mismatch', 'Bridge question acknowledgement did not bind the submitted question');
    }
    if (stored.approvalId && (stored.approvalId !== approvalId || stored.approvalRevision !== approvalRevision)) {
      throw new AuthoringError('stale-approval', 'The stored question no longer has the same approval revision');
    }
    stored = { ...stored, approvalId, approvalRevision, state: 'waiting' };
    atomicWrite(root, requestPath, stored);
    const deadline = Date.now() + boundedWait(questionOptions.waitMs);
    let receipt;
    while (Date.now() < deadline) {
      assertCurrent(binding);
      const pollMs = Math.min(LONG_POLL_MS, deadline - Date.now());
      const result = await request('GET', `/questions/${encodeURIComponent(question.id)}/decision?wait=${pollMs}`, undefined, {
        timeoutMs: pollMs + 5000, deadline,
      });
      if (result.pending === true) {
        if (Object.keys(result).some((key) => key !== 'pending')) throw new AuthoringError('invalid-response', 'Unexpected pending decision payload');
        // A bridge may return promptly during recovery; avoid a busy HTTP loop.
        await wait(Math.min(100, Math.max(0, deadline - Date.now())), undefined, { signal });
        continue;
      }
      receipt = verifyDecision(result, { descriptor, question, approvalId, approvalRevision, token });
      await verify({ refresh: true });
      assertCurrent(binding);
      break;
    }
    if (!receipt) throw new AuthoringError('timeout', 'Authoring decision wait timed out; resume the same question');
    const receiptPath = journalPath(descriptor, `decisions/${digest(question.id)}.json`);
    const saved = {
      schemaVersion: 1, question, binding, receipt,
    };
    atomicWrite(root, receiptPath, saved);
    atomicWrite(root, requestPath, { ...stored, state: 'answered', receiptPath });
    return { question, binding, receipt, receiptPath };
  }

  async function verifySavedDecision(relative, { gateId, action = 'approve', refresh = true } = {}) {
    await verify({ refresh });
    const saved = readJson(root, relative);
    const question = protocol.assertQuestion(saved.question);
    if (gateId && question.gateId !== gateId) throw new AuthoringError('wrong-gate', 'The maker receipt belongs to another gate');
    const requestPath = journalPath(descriptor, `questions/${digest(question.id)}.json`);
    const stored = readJson(root, requestPath);
    if (canonicalJson(stored.question) !== canonicalJson(question)
      || canonicalJson(stored.binding) !== canonicalJson(saved.binding)) {
      throw new AuthoringError('receipt-conflict', 'Stored receipt does not match the submitted question');
    }
    const receipt = verifyDecision(saved.receipt, {
      descriptor, question, approvalId: stored.approvalId, approvalRevision: stored.approvalRevision, token,
    });
    const current = await request('GET', `/questions/${encodeURIComponent(question.id)}/decision?wait=0`);
    if (current.pending === true || canonicalJson(current) !== canonicalJson(receipt)) {
      throw new AuthoringError('stale-approval', 'The bridge no longer recognizes this exact maker decision');
    }
    assertCurrent(saved.binding);
    if (receipt.action !== action) throw new AuthoringError('not-approved', 'The maker did not approve this effect');
    return { ...saved, receipt };
  }

  async function event(input) {
    await verify({ refresh: true });
    protocol.object(input, 'authoring event');
    if (Object.keys(input).some((key) => !['eventId', 'kind', 'screens', 'screenId', 'state', 'message'].includes(key))) {
      throw new AuthoringError('invalid-event', 'Unsupported authoring event field');
    }
    const kind = protocol.enumeration(input.kind, ['plan', 'screen', 'step'], 'event.kind');
    const allowed = {
      plan: ['eventId', 'kind', 'screens', 'message'],
      screen: ['eventId', 'kind', 'screenId', 'state', 'message'],
      step: ['eventId', 'kind', 'message'],
    }[kind];
    if (Object.keys(input).some((key) => !allowed.includes(key))) throw new AuthoringError('invalid-event', 'Event fields do not match the event kind');
    const eventId = input.eventId ? protocol.id(input.eventId, 'event.eventId') : `event-${digest(canonicalJson({
      appInstanceId: descriptor.appInstanceId, jobId: descriptor.jobId, attemptId: descriptor.attemptId, input,
    })).slice(0, 40)}`;
    const payload = { attemptId: descriptor.attemptId, eventId, kind };
    if (kind === 'plan') {
      payload.screens = protocol.assertScreenPlan(input.screens);
      if (payload.screens.some((screen) => screen.state !== 'planned')) {
        throw new AuthoringError('invalid-plan', 'A new screen plan must contain planned screens, not readiness claims');
      }
    }
    if (kind === 'screen') {
      payload.screenId = protocol.id(input.screenId, 'event.screenId');
      payload.state = protocol.enumeration(input.state, protocol.SCREEN_STATES, 'event.state');
      if (payload.state === 'ready') throw new AuthoringError('publisher-only', 'Only a bridge-published candidate can mark a screen ready');
    }
    if (input.message !== undefined) payload.message = protocol.text(input.message, 'event.message', 1000);
    return request('POST', '/events', payload);
  }

  async function submitCandidate(candidate) {
    await verify({ refresh: true });
    const payload = protocol.assertCandidate(candidate);
    if (payload.baseRevision !== descriptor.baseRevision
      || require('./authoring-source').captureSource(root).revision !== payload.sourceRevision) {
      throw new AuthoringError('stale-candidate', 'Candidate does not match the exact managed source and base revision');
    }
    return request('POST', '/candidate', { attemptId: descriptor.attemptId, ...payload });
  }

  async function finish(kind, message) {
    await verify({ refresh: true });
    const leaf = `${kind}.json`;
    const file = journalPath(descriptor, leaf);
    const payload = exists(root, file) ? readJson(root, file) : {
      attemptId: descriptor.attemptId, eventId: `${kind}-${crypto.randomUUID()}`,
      ...(kind === 'failed' ? { message: protocol.text(message, 'failure.message', 1000) } : {}),
    };
    assertNoCredential(payload, token);
    if (!exists(root, file)) atomicWrite(root, file, payload, { exclusive: true });
    return request('POST', `/${kind}`, payload);
  }

  return {
    descriptor, verify, requestQuestion, verifySavedDecision, connectorMetadata, dataverse, event, submitCandidate,
    assertSafe: (value) => assertNoCredential(value, token),
    complete: () => finish('complete'), failed: (message) => finish('failed', message),
  };
}

module.exports = {
  AuthoringError, DEFAULT_WAIT_MS, MAX_WAIT_MS, LONG_POLL_MS, MAX_CONNECTOR_METADATA_BYTES,
  MAX_DATAVERSE_BYTES, DATAVERSE_EXECUTION_TIMEOUT_MS,
  boundedWait, createClient, publicError,
};
