'use strict';
// The default build's writer for NEW configuration rows (#807): environment variable definitions and values, connection
// references, Custom APIs with their request parameters and response properties, and duplicate-detection rules with their
// conditions. Every new row is ONE flat POST at the stable id lib/configuration-create-plan.js compiled for it, sent once:
//
//   prepare the unit (lib/configuration-create-state.js prepareCreateUnit: a durable receipt BEFORE anything is sent)
//   for each new row, in the compiled order (a root before its children):
//     seal the row as dispatched (saved and read back BEFORE the socket call: from here on it is "possibly sent")
//     POST /<entity set>   the compiled body, byte for byte, inside withConfigurationWrite (no HTTP retry of any kind)
//     accept only a direct acknowledgment of THAT id (classifyCreateAcknowledgment)
//     GET the exact row and compare its public projection with what was sent; then mark the row verified
//   observe the whole root graph again (new rows, preserved rows, parent links, no unexpected child)
//   prove solution membership through the caller's existing membership helpers (never for a value row)
//   a NEW rule whose intended state is published: one header-free PublishDuplicateRule action (publishNewRuleOnce)
//   observe the graph a last time, then remove the unit from the receipt
//
// Nothing here pushes an SDK artifact, calls updateElement, or retries: a lost answer, a 4xx after the seal, a mismatched
// read or a failed receipt transition stops the build with a configuration-create-* code and leaves the receipt, which the
// next build's preflight (lib/configuration-create-recovery.js preflightConfigurationCreates) refuses to continue past. A
// later 404 for a dispatched row never authorizes a second POST.
//
// Requests go through the build's own authenticated HttpClient (lib/sdk-http-client.js createAzHttpClient), not the SDK's
// solution-scoped client: that client adds MSCRM.SolutionUniqueName to every write, and a value row or the publication
// action must never carry it. build-model-app.js makeSdk attaches that client to the build's SDK here (a WeakMap, so the
// bridge is reachable only through this module and never appears on the SDK object).
//
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-entity-web-api
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/publishduplicaterule

const P = require('./configuration-create-plan.js');
const B = require('./configuration-create-bindings.js');
const S = require('./configuration-create-state.js');
const { withConfigurationWrite } = require('./configuration-transport.js');
const { isRestrictedSolution } = require('./system-solutions.js');
const { canonicalJson, normalizeGuid } = require('./reconcile-common.js');

const KIND_TABLE = P.CONFIGURATION_CREATE_KIND_TABLE;
const RECEIPT_KIND_TABLE = P.CONFIGURATION_CREATE_RECEIPT_KIND_TABLE;
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const lower = (v) => String(v).toLowerCase();

// ---------------------------------------------------------------------------------------------
// The bridge: the build's raw HttpClient and its API URL factory, held for one SDK object.

const BRIDGES = new WeakMap();

/**
 * Holds the build's authenticated HttpClient and API URL factory for `sdk` (the build's solution SDK), for this module only.
 *   attachConfigurationCreateBridge(sdk, { httpClient, apiUrl, workspaceDir?, reader?, environmentUrl?, authoringLanguageCode?, sleep? })
 * `httpClient` is a createAzHttpClient client (post/get answer { status, headers, body } and throw on a transport failure);
 * `apiUrl(path)` answers the absolute Web API URL of a path such as '/customapis'. The rest is what the build's own runtime
 * needs beside them, handed over separately from the temporary solution SDK: `workspaceDir` the durable app workspace the
 * receipt lives in, `reader` the header-less provision SDK the proof reads go through, `environmentUrl` and
 * `authoringLanguageCode` the receipt's context (lib/configuration-create-state.js createStateContext). `sleep(ms)` replaces the
 * wait between the reads that prove a new rule published (a test's clock; a build passes none and waits for real).
 */
function attachConfigurationCreateBridge(sdk, { httpClient, apiUrl, workspaceDir, reader, environmentUrl, authoringLanguageCode, sleep } = {}) {
  if (!sdk || typeof sdk !== 'object') throw new TypeError('attachConfigurationCreateBridge: sdk must be an object');
  if (!httpClient || typeof httpClient.post !== 'function') throw new TypeError('attachConfigurationCreateBridge: httpClient.post is required');
  if (typeof apiUrl !== 'function') throw new TypeError('attachConfigurationCreateBridge: apiUrl is required');
  BRIDGES.set(sdk, Object.freeze({
    httpClient,
    apiUrl,
    workspaceDir: nonEmpty(workspaceDir) ? workspaceDir : null,
    reader: reader || null,
    environmentUrl: nonEmpty(environmentUrl) ? environmentUrl : null,
    authoringLanguageCode: Number.isSafeInteger(authoringLanguageCode) ? authoringLanguageCode : null,
    sleep: typeof sleep === 'function' ? sleep : null,
  }));
}

/** The bridge attached to `sdk`, or null. */
function configurationCreateBridgeOf(sdk) {
  return sdk && typeof sdk === 'object' ? BRIDGES.get(sdk) || null : null;
}

// ---------------------------------------------------------------------------------------------
// Acknowledgments

// A header of an answer, by name, case-insensitively (the client hands headers over as the transport gave them).
function headerOf(headers, name) {
  if (!isPlain(headers)) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  const value = key === undefined ? undefined : headers[key];
  return Array.isArray(value) ? value[0] : value;
}
const hasErrorEnvelope = (body) => isPlain(body) && (isPlain(body.error) || isPlain(body.Error));
const isMultipart = (headers) => /^\s*multipart\//i.test(String(headerOf(headers, 'content-type') || ''));
// The id the OData-EntityId (or Location) header names, as the service writes it for a created row:
//   OData-EntityId: https://contoso.crm.dynamics.com/api/data/v9.2/duplicaterules(0b7c6f5e-0000-4000-8000-000000000001)
// Only the last parenthesized segment is read, and only a GUID counts; anything else is no id.
function entityIdOf(headers) {
  const raw = headerOf(headers, 'odata-entityid') || headerOf(headers, 'location');
  if (typeof raw !== 'string') return null;
  const m = /\(([^()]+)\)\s*$/.exec(raw);
  return m ? normalizeGuid(m[1]) || null : null;
}

/**
 * Whether the direct answer to one flat create acknowledges the create of `id`:
 *   classifyCreateAcknowledgment(answer, { id, idColumn }) -> { ok: true } | { ok: false, reason }
 * Accepted, as measured live for these tables: 204 No Content with no error envelope, whose OData-EntityId (when present)
 * names `id`; or 201 Created whose body or OData-EntityId names `id`. Refused: any other status (202 Accepted, 207
 * Multi-Status, every 3xx/4xx/5xx), a multipart body, an error envelope, a body that is not an object for a 201, or an id
 * that is not `id`. A refusal is never a proof that nothing was created.
 */
function classifyCreateAcknowledgment(answer, { id, idColumn } = {}) {
  const expected = normalizeGuid(id);
  if (!expected) throw new TypeError('classifyCreateAcknowledgment: id must be a GUID');
  const no = (reason) => ({ ok: false, reason });
  if (!isPlain(answer) || !Number.isInteger(answer.status)) return no('the create was not answered');
  const { status, headers, body } = answer;
  if (status !== 201 && status !== 204) return no(`the create was answered ${status}, not as a direct acknowledgment`);
  if (isMultipart(headers)) return no('the create was answered with a multipart body');
  if (hasErrorEnvelope(body)) return no('the create was answered with an error');
  const named = entityIdOf(headers);
  if (headerOf(headers, 'odata-entityid') !== undefined && !named) return no('the create answer names no readable id');
  if (named && named !== expected) return no('the create answer names another row');
  if (status === 204) {
    if (body !== undefined && body !== null && body !== '' && !(isPlain(body) && !Object.keys(body).length)) return no('a 204 answer carried a body');
    return { ok: true };
  }
  if (!isPlain(body)) return no('the 201 answer has no readable body');
  const bodyId = nonEmpty(idColumn) && typeof body[idColumn] === 'string' ? normalizeGuid(body[idColumn]) : null;
  if (bodyId && bodyId !== expected) return no('the create answer names another row');
  if (!bodyId && !named) return no('the 201 answer names no row');
  return { ok: true };
}

/**
 * Whether the direct answer to the one PublishDuplicateRule action acknowledges it:
 *   classifyNewRulePublicationAcknowledgment(answer) -> { ok: true } | { ok: false, reason }
 * Accepted: a complete 200 or 204 with no error envelope (live, the action answers 200 with the asyncoperation row it
 * queued; no JobId is read or kept). Refused: any other status (202, 207 included), a multipart body, an error envelope, or a
 * 200 whose body is not a JSON object.
 */
function classifyNewRulePublicationAcknowledgment(answer) {
  const no = (reason) => ({ ok: false, reason });
  if (!isPlain(answer) || !Number.isInteger(answer.status)) return no('the publication was not answered');
  const { status, headers, body } = answer;
  if (status !== 200 && status !== 204) return no(`the publication was answered ${status}`);
  if (isMultipart(headers)) return no('the publication was answered with a multipart body');
  if (hasErrorEnvelope(body)) return no('the publication was answered with an error');
  if (status === 200 && !isPlain(body)) return no('the publication answer is not readable');
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// The writer

// The membership kinds of the unit's rows: a value row is per-environment data and never a solution component.
const membershipItemsOf = (unit) => unit.rows
  .filter((r) => KIND_TABLE[r.kind] && KIND_TABLE[r.kind].solutionHeader)
  .map((r) => ({ kind: KIND_TABLE[r.kind].bindingKind, key: r.kind === unit.root.kind && r.id === unit.root.id ? unit.root.key : `${unit.root.key}|${r.key}`, id: r.id }));

const sameJson = (a, b) => canonicalJson(a) === canonicalJson(b);

/**
 * The default build's create capability, over the build's durable workspace and its raw client:
 *   createDefaultConfigurationWriter({ bridge, dataverse, workspaceDir, context, leaseDeps?, sleep?, publicationReads?, publicationDelayMs? })
 * `bridge` is configurationCreateBridgeOf(the build's SDK); `dataverse` the SDK's reader (`get`/`getAbsolute`, GET only);
 * `context` a createStateContext. Answers { executeCreateUnit, publishNewRuleOnce }.
 */
function createDefaultConfigurationWriter({ bridge, dataverse, workspaceDir, context, leaseDeps, sleep, publicationReads = 10, publicationDelayMs = 3000 } = {}) {
  if (!bridge || !bridge.httpClient || typeof bridge.httpClient.post !== 'function' || typeof bridge.apiUrl !== 'function') throw new TypeError('createDefaultConfigurationWriter: a bridge is required');
  if (!dataverse || typeof dataverse.get !== 'function') throw new TypeError('createDefaultConfigurationWriter: a dataverse reader is required');
  if (!nonEmpty(workspaceDir)) throw new TypeError('createDefaultConfigurationWriter: the durable workspace is required');
  if (!isPlain(context)) throw new TypeError('createDefaultConfigurationWriter: the state context is required');
  const wait = typeof sleep === 'function' ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A compiled handle is executed at most once in this process, whatever happens to it (a second call is refused before
  // anything is read or sent).
  const executed = new WeakSet();

  // One compiled request, as compiled: its path, its body bytes and a header set this function decides alone. The solution
  // header is the unit's solution, only for a kind that carries it and only for a solution that is not a system one; a value
  // row and the publication action carry none (and nothing else may add one: there are no caller headers).
  async function sendCompiledRow(request, solution) {
    const headers = {};
    if (request.solutionHeader === true && nonEmpty(solution) && !isRestrictedSolution(solution)) headers['MSCRM.SolutionUniqueName'] = solution;
    return withConfigurationWrite(() => bridge.httpClient.post(bridge.apiUrl(request.path), request.body, { headers }));
  }

  const ids = (unit, stateHandle) => ({ unitId: stateHandle ? stateHandle.unitId : undefined, rootId: unit.root.id, rootKind: unit.root.kind });
  const halt = (code, unit, stateHandle, details) => S.configurationCreateHalt(code, { ...ids(unit, stateHandle), ...details });

  // A receipt transition. B's own halts (persistence-uncertain, state-invalid, ...) are passed through as they are.
  function transition(fn) {
    fn();
  }

  // The exact row at its id, compared with what was sent for it.
  async function proveRow(handle, unit, row, stateHandle) {
    const k = KIND_TABLE[row.kind];
    const read = await B.readDefaultConfigurationRow(dataverse, k.bindingKind, row.id);
    if (!isPlain(read) || read.state === 'unknown') throw halt('configuration-create-graph-unreadable', unit, stateHandle, { reason: `the new ${row.kind} row could not be read`, dispatched: true });
    if (read.state === 'absent') throw halt('configuration-create-row-missing', unit, stateHandle, { reason: `the new ${row.kind} row is not there`, dispatched: true });
    if (normalizeGuid(read.id) !== row.id) throw halt('configuration-create-graph-unreadable', unit, stateHandle, { reason: 'the read answered another row', dispatched: true });
    const observed = P.publicProjectionFromObserved(row.kind, read);
    if (!observed.ok) throw halt('configuration-create-graph-unreadable', unit, stateHandle, { reason: `the new ${row.kind} row cannot be read completely`, dispatched: true });
    const sent = P.publicProjectionFromPost(handle, row.id);
    if (!sent.ok || !sameJson(observed.public, sent.public)) throw halt('configuration-create-content-conflict', unit, stateHandle, { reason: `the new ${row.kind} row does not hold what was sent`, dispatched: true });
    return observed;
  }

  // The whole root graph: the root and every child of its kinds, to the last page. Every row of the unit must be there with
  // its public projection, and no other child may be.
  async function observeGraph(unit, stateHandle) {
    const graph = await P.captureConfigurationBaseline(dataverse, { kind: unit.root.kind, rootId: unit.root.id });
    if (!graph.ok) throw halt(graph.code, unit, stateHandle, { reason: graph.reason, dispatched: true });
    const observed = new Map([[graph.root.id, { kind: graph.root.kind, public: graph.root.public }], ...graph.children.map((c) => [c.id, { kind: c.kind, public: c.public }])]);
    for (const row of unit.rows) {
      const seen = observed.get(row.id);
      if (!seen) throw halt('configuration-create-row-missing', unit, stateHandle, { reason: `a ${row.kind} row of the unit is not there`, dispatched: true });
      if (seen.kind !== row.kind || !sameJson(seen.public, row.public)) throw halt('configuration-create-content-conflict', unit, stateHandle, { reason: `a ${row.kind} row of the unit changed`, dispatched: true });
      observed.delete(row.id);
    }
    if (observed.size) throw halt('configuration-create-content-conflict', unit, stateHandle, { reason: 'the root holds a row the unit does not name', dispatched: true });
    return graph;
  }

  /**
   * Publish a NEW rule once, after its content and membership are proven:
   *   publishNewRuleOnce(compiledHandle, stateHandle) -> resolves when the rule reads published
   * Seals the publication slot (saved before the socket call), sends the one fixed action, records an acknowledged answer,
   * then reads the rule (GET only) up to `publicationReads` times, `publicationDelayMs` apart. Anything else is
   * configuration-create-publication-pending, and the action is never sent again.
   */
  async function publishNewRuleOnce(handle, stateHandle) {
    const unit = P.compiledUnitOf(handle);
    const request = P.compiledPublicationRequest(handle);
    if (!request || unit.root.kind !== 'duplicate-rule') throw halt('configuration-create-shape-refused', unit, stateHandle, { reason: 'the unit needs no publication', transition: 'publication-seal', dispatched: false });
    transition(() => S.sealNewRulePublication(stateHandle));
    let answer;
    try {
      answer = await sendCompiledRow(request, null);
    } catch {
      throw halt('configuration-create-publication-pending', unit, stateHandle, { reason: 'the publication was not answered', transition: 'publication-acknowledge', dispatched: true });
    }
    const ack = classifyNewRulePublicationAcknowledgment(answer);
    if (!ack.ok) throw halt('configuration-create-publication-pending', unit, stateHandle, { reason: ack.reason, transition: 'publication-acknowledge', dispatched: true });
    transition(() => S.markNewRulePublicationAcknowledged(stateHandle));
    for (let i = 0; i < publicationReads; i++) {
      if (i > 0) await wait(publicationDelayMs);
      const read = await B.readDefaultConfigurationRow(dataverse, 'duplicateRule', unit.root.id);
      if (isPlain(read) && read.state === 'present') {
        const observed = P.publicProjectionFromObserved('duplicate-rule', read);
        if (observed.ok && observed.ruleState === 'published') return;
      }
    }
    throw halt('configuration-create-publication-pending', unit, stateHandle, { reason: 'the rule does not read published yet', transition: 'publication-acknowledge', dispatched: true });
  }

  /**
   * Execute one compiled unit (compileConfigurationCreateUnit's { handle, unit }) in this invocation:
   *   executeCreateUnit({ handle, unit }, { membership? }) -> { rootId, childIds: { <slot>: id }, created: [rowId] }
   * `membership(items)` is the caller's existing ensure-and-prove over [{ kind, key, id }] (value rows are never passed);
   * it answers the items NOT proven members, and any is configuration-create-membership-incomplete. Every stop throws a
   * configuration-create-* halt (lib/configuration-create-state.js configurationCreateHalt).
   */
  async function executeCreateUnit(compiled, { membership } = {}) {
    const handle = compiled && compiled.handle;
    const unit = P.compiledUnitOf(handle);
    if (executed.has(handle)) throw halt('configuration-create-shape-refused', unit, null, { reason: 'this compiled unit was already executed', transition: 'prepare', dispatched: false });
    executed.add(handle);
    if (lower(unit.solution) !== lower(context.solutionUniqueName)) {
      throw halt('configuration-create-context-mismatch', unit, null, { reason: 'the unit was compiled for another solution', transition: 'prepare', dispatched: false });
    }
    const stateHandle = S.prepareCreateUnit(workspaceDir, {
      kindTable: RECEIPT_KIND_TABLE,
      context,
      unit: { root: { ...unit.root }, publicIntentSha256: unit.publicIntentSha256, publicPlanSha256: unit.publicPlanSha256, publicationRequired: unit.publicationRequired, rows: unit.rows.map((r) => ({ ...r })) },
      ...(leaseDeps ? { leaseDeps } : {}),
    });
    const created = unit.rows.filter((r) => r.role === 'create');
    for (const row of created) {
      const request = P.compiledRowRequest(handle, row.id);
      transition(() => S.sealCreateRow(stateHandle, row.id));
      let answer;
      try {
        answer = await sendCompiledRow(request, unit.solution);
      } catch {
        throw halt('configuration-create-pending', unit, stateHandle, { reason: `the ${row.kind} create was not answered`, transition: 'verify', dispatched: true });
      }
      const ack = classifyCreateAcknowledgment(answer, { id: row.id, idColumn: KIND_TABLE[row.kind].idColumn });
      if (!ack.ok) throw halt('configuration-create-pending', unit, stateHandle, { reason: ack.reason, transition: 'verify', dispatched: true });
      await proveRow(handle, unit, row, stateHandle);
      transition(() => S.markCreateRowVerified(stateHandle, row.id));
    }
    await observeGraph(unit, stateHandle);
    if (typeof membership === 'function') {
      let unproven;
      try {
        unproven = await membership(membershipItemsOf(unit));
      } catch {
        unproven = null;
      }
      if (!Array.isArray(unproven) || unproven.length) throw halt('configuration-create-membership-incomplete', unit, stateHandle, { reason: 'a row of the unit is not proven a member of the solution', dispatched: true });
    }
    if (unit.publicationRequired) await publishNewRuleOnce(handle, stateHandle);
    await observeGraph(unit, stateHandle);
    transition(() => S.completeCreateUnit(stateHandle));
    const childIds = {};
    for (const row of created) if (row.id !== unit.root.id) childIds[row.key] = row.id;
    return { rootId: unit.root.id, childIds, created: created.map((r) => r.id) };
  }

  return { executeCreateUnit, publishNewRuleOnce, sendCompiledRow };
}

module.exports = {
  attachConfigurationCreateBridge,
  configurationCreateBridgeOf,
  createDefaultConfigurationWriter,
  classifyCreateAcknowledgment,
  classifyNewRulePublicationAcknowledgment,
};
