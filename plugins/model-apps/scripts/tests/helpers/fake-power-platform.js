'use strict';
// A fake Power Platform for tests that run the REAL vendored SDK, the real az-token HttpClient and the real Power Apps service client:
// one `request` function with the contract of dataverse-auth.js `makeRequest` ({ statusCode, body, headers } or { error }) that answers
// the hosts the SDK talks to, in the shapes the SDK measured on live environments, and records every request.
//
//   Dataverse     https://<org>.crm.dynamics.com/api/data/v9.x/…
//     GET  RetrieveCurrentOrganization(AccessType=@p1)?@p1=…      -> { Detail: { EnvironmentId } }
//     POST ExportSolution                                         -> { ExportSolutionFile: <base64 package> }
//     POST StageSolution                                          -> { StageSolutionResults: { StageSolutionStatus, StageSolutionUploadId, SolutionComponentsDetails } }
//     DELETE stagesolutionuploads(<id>)                           -> 204
//     POST ImportSolution                                         -> 204 (the body is recorded in `state.imports`) — or, for a send that config.solution.importRefusals
//                                                                    refuses, the platform's answer when another operation holds its lock (HTTP 429 and a lock code,
//                                                                    LOCK_REFUSAL), which starts nothing: the body goes to `state.refusedImports`, not to `state.imports`
//     GET  importjobs(<id>)?$select=…                             -> { importjobid, data: <the job's XML log> } (config.solution.jobLog), else 404
//   Business Application Platform  https://api.bap.microsoft.com (Public) | https://test.api.bap.microsoft.com (Test)
//     GET providers/Microsoft.BusinessAppPlatform/environments/<id>
//   Power Apps runtime             the origin the BAP row names, e.g. https://unitedstates.api.powerapps.com
//     GET providers/Microsoft.PowerApps/connections?api-version=2016-11-01&$filter=environment eq '<id>'
//     GET providers/Microsoft.PowerApps/apis/<connector>?api-version=2016-11-01&$filter=environment eq '<id>'
//
// Like the live service, it answers a request that is not what the SDK should send — a wrong api-version, a read without the environment
// filter — with the live service's error, so a mistake in what the SDK sends fails a test instead of passing it. Every request carries the
// token of its audience, and the fake checks it: a Dataverse request must carry the Dataverse token and a Power Apps one the Power Apps
// token, so a token that goes to the wrong host fails the run.
const ORG = 'https://contoso.crm.dynamics.com';
const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const DATAVERSE_TOKEN = 'dataverse-test-token';
const POWER_APPS_TOKEN = 'power-apps-test-token';

// What the platform answers when it cannot START an operation because another one holds the environment's customization lock: a customization-lock code of the error reference and
// the text the reference documents for it (CustomizationLockEx_BothKnownDifferent, with the two operations filled in):
//   HTTP 429  { "error": { "code": "0x8004F064", "message": "Cannot start the requested operation [Import] because there is another [Publish] running at this moment. Use Solution History for more details." } }
// See: https://learn.microsoft.com/power-apps/developer/data-platform/reference/web-service-error-codes
const LOCK_REFUSAL = Object.freeze({
  status: 429,
  code: '0x8004F064',
  message: 'Cannot start the requested operation [Import] because there is another [Publish] running at this moment. Use Solution History for more details.',
});
// The answer that is NOT a refusal to start, though it reads like one: the generic solution-concurrency code (`SolutionConcurrencyFailure`), whose documented text says the installation or
// removal FAILED because another one ran at the same time. It does not say the operation never started, so an import answered with it is not sent again.
const CONCURRENCY_REFUSAL = Object.freeze({
  status: 429,
  code: '0x80071151',
  message: 'Cannot start the requested operation [Import] because there is another [Publish] running at this moment. Use Solution History for more details. '
    + '-- The solution installation or removal failed due to the installation or removal of another solution at the same time. Please try again later.',
});

const json = (statusCode, body, headers = {}) => ({ statusCode, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const empty = (statusCode) => ({ statusCode, headers: {}, body: '' });

/** The connection row the classic Power Apps API answers: only the fields the SDK reads, in the measured shape. */
function connectionRow({ id, apiId, displayName, statuses = ['Connected'], environmentId = ENVIRONMENT_ID }) {
  return {
    name: id,
    id: `${apiId}/connections/${id}`,
    type: 'Microsoft.PowerApps/apis/connections',
    properties: {
      apiId,
      displayName,
      statuses: statuses.map((status) => ({ status })),
      environment: { id: `/providers/Microsoft.PowerApps/environments/${environmentId}`, name: environmentId },
    },
  };
}

/**
 * A Swagger 2.0 document of the measured contract, from `operations`: `{ id, summary, method, path, parameters, response }`. `response` is the
 * schema of the 200 response; leave it out for an operation that answers none (the SDK projects `{}`).
 */
function swagger(operations) {
  const paths = {};
  for (const op of operations) {
    const route = op.path || `/${op.id}`;
    paths[route] = paths[route] || {};
    paths[route][op.method || 'get'] = {
      operationId: op.id,
      ...(op.summary !== undefined ? { summary: op.summary } : {}),
      parameters: op.parameters || [],
      responses: op.response ? { 200: { description: 'OK', schema: op.response } } : { default: { description: 'Operation Failed.' } },
    };
  }
  return { swagger: '2.0', info: { title: 'Contoso connector', version: '1.0' }, host: 'connector.contoso.example', basePath: '/', schemes: ['https'], paths };
}

/** One component of StageSolution's reply: `Attributes` is `{ Count, Keys, Values }` (measured). */
function stagedComponent(typeName, attributes) {
  const keys = Object.keys(attributes);
  return { ComponentTypeName: typeName, Attributes: { Count: keys.length, Keys: keys, Values: keys.map((key) => attributes[key]) } };
}

/** An environment variable definition of a staged package. */
function stagedVariable({ schemaName, defaultValue, type = '100000000', isRequired = 'false' }) {
  return stagedComponent('EnvironmentVariableDefinition', {
    schemaname: schemaName,
    ...(defaultValue !== undefined ? { defaultvalue: defaultValue } : {}),
    type,
    isrequired: isRequired,
  });
}

/** A connection reference of a staged package. */
function stagedReference({ logicalName, connectorId }) {
  return stagedComponent('ConnectionReference', {
    connectionreferencelogicalname: logicalName,
    ...(connectorId !== undefined ? { connectorid: connectorId } : {}),
  });
}

/**
 * @param {object} [config]
 * @param {string} [config.org] - the org's URL (a `crmtest` host makes it a Test-cloud org)
 * @param {string} [config.environmentId]
 * @param {string} [config.runtimeOrigin] - what the BAP row names as the Power Apps runtime
 * @param {boolean} [config.decommissioned] - the Power Apps runtime answers 410 `ServiceDecommissioned`, as a service that has been switched off does
 * @param {object[]} [config.connections] - rows (see connectionRow)
 * @param {number} [config.pageSize] - connections per page; the rest follow by `nextLink`
 * @param {object} [config.swaggers] - connector short name -> Swagger document
 * @param {object[]} [config.references] - Dataverse `connectionreferences` rows
 * @param {{ status: number, data?: any }} [config.referencesAnswer] - what the `connectionreferences` read answers instead of those rows
 * @param {object} [config.bapRow] - properties merged over the BAP row's own
 * @param {object} [config.solution] - { packageBase64, stage: { status, variables, references, uploadId }, exportAnswer, importAnswer, importRefusals, deleteStagingAnswer, jobLog, jobLogAnswer }.
 *   `importRefusals` is a list with one entry per ImportSolution SEND, in order: `{ status, code, message, headers? }` is the platform refusing that send before it starts
 *   (see LOCK_REFUSAL), and `null` — or the end of the list — is the platform taking it (recorded, answered by `importAnswer`, else 204)
 * @param {(request: object) => (object|undefined)} [config.override] - answers a request itself (return a response) or defers (undefined)
 * @param {object} [config.tokens] - the token each audience must carry: { dataverse, powerApps }
 */
function createCloud(config = {}) {
  const org = config.org || ORG;
  const environmentId = config.environmentId || ENVIRONMENT_ID;
  const isTest = /\.crmtest\.dynamics\.com$/i.test(new URL(org).hostname);
  const bapHost = isTest ? 'test.api.bap.microsoft.com' : 'api.bap.microsoft.com';
  const runtimeOrigin = config.runtimeOrigin || (isTest ? 'https://unitedstates.tip2.api.powerapps.com' : 'https://unitedstates.api.powerapps.com');
  const tokens = { dataverse: DATAVERSE_TOKEN, powerApps: POWER_APPS_TOKEN, ...(config.tokens || {}) };
  const solution = config.solution || {};
  const requests = [];
  const state = { staged: [], deletedStaging: [], imports: [], refusedImports: [], exports: [], jobReads: [], importSends: 0 };

  const filter = `environment eq '${environmentId}'`;
  const filterOk = (u) => u.searchParams.get('$filter') === filter;
  const apiVersionOk = (u) => u.searchParams.get('api-version') === '2016-11-01';

  function dataverse(method, u, body) {
    const route = u.pathname.replace(/^\/api\/data\/v9\.\d+\//, '');
    if (method === 'GET' && route.startsWith('RetrieveCurrentOrganization(')) {
      return json(200, { Detail: { EnvironmentId: environmentId, OrganizationId: '22222222-2222-4222-8222-222222222222' } });
    }
    if (method === 'POST' && route === 'ExportSolution') {
      state.exports.push(body);
      if (solution.exportAnswer) return solution.exportAnswer;
      return json(200, { ExportSolutionFile: solution.packageBase64 || Buffer.from('PK\u0003\u0004 a solution package').toString('base64') });
    }
    if (method === 'POST' && route === 'StageSolution') {
      const stage = solution.stage || {};
      const uploadId = stage.uploadId || '33333333-3333-4333-8333-333333333333';
      state.staged.push(body);
      if (stage.answer) return stage.answer;
      return json(200, {
        StageSolutionResults: {
          StageSolutionStatus: stage.status || 'Passed',
          StageSolutionUploadId: uploadId,
          MissingDependencies: stage.missingDependencies || [],
          SolutionValidationResults: stage.validation || [],
          SolutionComponentsDetails: [
            ...(stage.variables || []).map(stagedVariable),
            ...(stage.references || []).map(stagedReference),
          ],
        },
      });
    }
    const staging = /^stagesolutionuploads\(([^)]+)\)$/.exec(route);
    if (method === 'DELETE' && staging) {
      state.deletedStaging.push(staging[1]);
      return solution.deleteStagingAnswer || empty(204);
    }
    if (method === 'POST' && route === 'ImportSolution') {
      const refusal = (solution.importRefusals || [])[state.importSends];
      state.importSends += 1;
      if (refusal) {
        state.refusedImports.push(body);
        return json(refusal.status, { error: { code: refusal.code, message: refusal.message } }, refusal.headers || {});
      }
      state.imports.push(body);
      return solution.importAnswer || empty(204);
    }
    const job = /^importjobs\(([^)]+)\)$/.exec(route);
    if (method === 'GET' && job) {
      state.jobReads.push(job[1]);
      if (solution.jobLogAnswer) return solution.jobLogAnswer;
      if (solution.jobLog !== undefined) return json(200, { importjobid: job[1], data: solution.jobLog });
      return json(404, { error: { code: '0x80040217', message: `importjob With Id = ${job[1]} Does Not Exist` } });
    }
    return json(404, { error: { code: '0x80060888', message: `Resource not found for the segment '${route}'.` } });
  }

  function bap(method, u) {
    if (method !== 'GET') return json(405, { error: { code: 'MethodNotAllowed', message: 'GET only' } });
    if (u.pathname !== `/providers/Microsoft.BusinessAppPlatform/environments/${environmentId}` || u.searchParams.get('api-version') !== '2021-04-01') {
      return json(404, { error: { code: 'EnvironmentNotFound', message: 'The environment was not found.' } });
    }
    return json(200, {
      name: environmentId,
      id: `/providers/Microsoft.BusinessAppPlatform/environments/${environmentId}`,
      properties: {
        linkedEnvironmentMetadata: { instanceUrl: `${org}/` },
        runtimeEndpoints: { 'microsoft.PowerApps': runtimeOrigin },
        ...(config.bapRow || {}),
      },
    });
  }

  function powerApps(method, u) {
    if (method !== 'GET') return json(405, { error: { code: 'MethodNotAllowed', message: 'GET only' } });
    if (config.decommissioned) {
      return json(410, { error: { code: 'ServiceDecommissioned', message: "This endpoint, '*.api.powerapps.com', is decommissioned and is no longer supported." } });
    }
    if (!apiVersionOk(u)) return json(400, { error: { code: 'InvalidApiVersion', message: 'The api-version is not supported.' } });
    if (u.pathname === '/providers/Microsoft.PowerApps/connections') {
      if (!u.searchParams.has('$filter')) return json(400, { error: { code: 'MissingEnvironmentFilter', message: 'An environment filter is required.' } });
      if (!filterOk(u)) return json(404, { error: { code: 'ServiceToServiceEnvironmentNotFound', message: 'The environment was not found.' } });
      const rows = config.connections || [];
      const size = config.pageSize || rows.length || 1;
      const start = Number(u.searchParams.get('$skiptoken') || 0);
      const page = rows.slice(start, start + size);
      const body = { value: page };
      if (start + size < rows.length) {
        const next = new URL(u.href);
        next.searchParams.set('$skiptoken', String(start + size));
        body.nextLink = next.href;
      }
      return json(200, body);
    }
    const connector = /^\/providers\/Microsoft\.PowerApps\/apis\/([^/]+)$/.exec(u.pathname);
    if (connector) {
      if (!u.searchParams.has('$filter')) return json(400, { error: { code: 'MissingEnvironmentFilter', message: 'An environment filter is required.' } });
      if (!filterOk(u)) return json(404, { error: { code: 'ServiceToServiceEnvironmentNotFound', message: 'The environment was not found.' } });
      const name = decodeURIComponent(connector[1]).toLowerCase();
      const found = Object.keys(config.swaggers || {}).find((key) => key.toLowerCase() === name);
      if (!found) return json(404, { error: { code: 'ApiResourceNotFound', message: `The connector '${connector[1]}' was not found.` } });
      return json(200, { name: found, properties: { swagger: config.swaggers[found] } });
    }
    return json(404, { error: { code: 'NotFound', message: 'No such resource.' } });
  }

  async function request({ url, method = 'GET', headers = {}, body = null }) {
    const u = new URL(url);
    const entry = { method, host: u.hostname, path: u.pathname, search: u.search, body: body === null ? undefined : body, authorization: headers.Authorization };
    requests.push(entry);
    const dataverseHost = u.origin === new URL(org).origin;
    const runtimeHost = u.origin === new URL(runtimeOrigin).origin;
    const bapHostMatch = u.hostname === bapHost;
    if (!dataverseHost && !runtimeHost && !bapHostMatch) {
      throw new Error(`the fake platform has no host ${u.hostname}: ${method} ${u.href}`);
    }
    const expected = `Bearer ${dataverseHost ? tokens.dataverse : tokens.powerApps}`;
    if (headers.Authorization !== expected) {
      return json(401, { error: { code: 'Unauthorized', message: `${u.hostname} was sent the wrong credential` } });
    }
    if (config.override) {
      const answered = config.override(entry);
      if (answered) return answered;
    }
    const parsed = typeof body === 'string' && body ? JSON.parse(body) : undefined;
    if (dataverseHost) return dataverse(method, u, parsed);
    if (bapHostMatch) return bap(method, u);
    return powerApps(method, u);
  }

  // What a script's `dataverseRequest(env, 'GET', 'connectionreferences?…')` reads: the Web API collection, through the same fake — or, with `referencesAnswer`, the answer
  // a test gives instead (a 500, say), as `dataverseRequest` returns one: { status, data }.
  function dataverseCollection(apiPath) {
    if (/^connectionreferences\?/.test(apiPath)) return config.referencesAnswer || { status: 200, data: { value: config.references || [] } };
    return { status: 404, data: { error: { message: `the fake org answers no ${apiPath}` } } };
  }

  return {
    request,
    requests,
    state,
    dataverseCollection,
    org,
    environmentId,
    runtimeOrigin,
    bapHost,
    tokens,
    // The requests a host received.
    to: (hostname) => requests.filter((r) => r.host === hostname),
    toDataverse: () => requests.filter((r) => r.host === new URL(org).hostname),
    toPowerApps: () => requests.filter((r) => r.host !== new URL(org).hostname),
  };
}

module.exports = {
  createCloud,
  connectionRow,
  swagger,
  stagedVariable,
  stagedReference,
  LOCK_REFUSAL,
  CONCURRENCY_REFUSAL,
  ORG,
  ENVIRONMENT_ID,
  DATAVERSE_TOKEN,
  POWER_APPS_TOKEN,
};
