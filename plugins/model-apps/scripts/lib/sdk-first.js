'use strict';
// SDK first, pac as the fallback — the rule list-connections.js, connector.js and solution-settings.js share.
//
// Each of them reads through the bundled SDK. The SDK refuses, with a typed code, what its route does not serve — an environment in a
// cloud it has no route for, a token the route refused, a package it cannot read — and for those, and only those, the script
// asks pac the same question instead. Any other failure is a failure of a route that DOES serve (an HTTP 5xx or 404, a refused Dataverse call, an answer
// the SDK cannot read, a bad argument) and is thrown to the caller with the SDK's own code: it is never answered by pac, because an answer
// that comes from somewhere else when the first source is broken hides that it is broken. The SDK never falls back by itself, and this
// is the one place a script does.
//
// The SDK is made on a throwaway workspace (`createMakerSdk` requires a storage, though none of these reads touch it): created before
// the SDK, removed whichever way the read ends. tests/sdk-async-surface.test.js holds every file that makes a workspace to that shape.
const fs = require('node:fs');
const auth = require('./dataverse-auth.js');
const { createAzHttpClient } = require('./sdk-http-client.js');
const { makeTempWorkspace } = require('./temp-workspace.js');
const { TOKEN_UNAVAILABLE, PowerAppsClientError } = require('./power-apps-service-client.js');

// The codes with which the SDK's connection and connector reads (api/ConnectivityApi.ts, api/connectivityRouter.ts, api/connectivityShared.ts and
// api/connectorProjection.ts of the vendored SDK) say "this route does not serve this cloud, token or connector". Each is an answer about the ROUTE, and
// leaves nothing half done (the reads write nothing):
//   CONNECTIVITY_NOT_CONFIGURED          the org's cloud is read only through a client the host did not give — a Test org, through the Power Platform API
//                                        (see "No Power Platform API client", below): nothing was requested
//   CONNECTIVITY_CLOUD_UNSUPPORTED       the org is not in the Public or Test cloud (GCC, GCC High, DoD, China, a custom domain or a port):
//                                        nothing was requested
//   CONNECTIVITY_ENVIRONMENT_UNVERIFIED  the environment's id could not be read, or the Business Application Platform's row for it does
//                                        not tie it to this org with a Power Apps runtime host: the service was not asked about it
//   CONNECTIVITY_ROUTE_DECOMMISSIONED    HTTP 410 `ServiceDecommissioned` from the Power Apps host: that service has been switched off
//   CONNECTIVITY_UNAUTHORIZED            HTTP 401 or 403 from the Business Application Platform or the Power Apps host: the token the route was given was refused
//   CONNECTOR_SWAGGER_UNSUPPORTED        this connector's definition has a form the SDK does not project (an OpenAPI 3 document, a path item with a `$ref`)
// and one of this plugin's own: POWER_APPS_TOKEN_UNAVAILABLE — no Azure CLI token for the Power Apps service could be had, so the SDK
// route cannot be used on this machine (pac signs in by itself).
//
// CONNECTIVITY_UNAUTHORIZED is a refusal, not a failure, for three reasons. The SDK itself says what to do with it — its message ends "Supply a valid token for
// this route, or fall back to pac" — and the plugin has no other token to supply (the Azure CLI's is the one it hands the SDK), so falling back is the half of that
// advice open to it. A tenant can refuse the Azure CLI's client (by conditional access, say) and still allow pac's own, so a 401 or 403 here is an answer about THIS
// client's access to the route and says nothing about whether the signed-in identity may read the connections. And the fallback is never silent: the output carries the
// code and the SDK's words, and a pac that cannot read them either fails the read with its own failure. Only the two connectivity routes raise it — a 401 or 403 from
// Dataverse itself (the org read) stays a CONNECTION_ERROR, a failure.
//
// Left out on purpose, each a failure to report: CONNECTIVITY_RESPONSE_UNREADABLE (the service answered a shape the SDK does not read:
// a changed service must not be papered over), CONNECTOR_OPERATION_NOT_FOUND, CONNECTOR_SCHEMA_TOO_LARGE, INVALID_ARGUMENT, and every
// CONNECTION_ERROR — a 404 or 5xx from a route that serves, or any status from Dataverse.
const NOT_CONFIGURED = 'CONNECTIVITY_NOT_CONFIGURED';
const CLOUD_UNSUPPORTED = 'CONNECTIVITY_CLOUD_UNSUPPORTED';
const ROUTE_REFUSALS = Object.freeze([
  NOT_CONFIGURED,
  CLOUD_UNSUPPORTED,
  'CONNECTIVITY_ENVIRONMENT_UNVERIFIED',
  'CONNECTIVITY_ROUTE_DECOMMISSIONED',
  'CONNECTIVITY_UNAUTHORIZED',
  'CONNECTOR_SWAGGER_UNSUPPORTED',
]);
const CONNECTIVITY_REFUSALS = Object.freeze([...ROUTE_REFUSALS, TOKEN_UNAVAILABLE]);

// `{ code, message }` when `error` is one of the SDK's connectivity refusals, else null — the failure is then thrown, not answered by pac.
//
// Only what the SDK itself raised counts, and the check is on WHAT the error is, not on any `code` it carries: an error that is an `SdkError` of the bundle with one of the
// SDK's refusal codes, or the one wrapped refusal below. The SDK's `ConnectionError` also keeps the HTTP response BODY of a failed request as its `cause`
// (api/ConnectivityApi.ts `send`, errors/index.ts), so a service answering 404 or 500 with a body that says `{ "code": "CONNECTIVITY_CLOUD_UNSUPPORTED" }` has a body with a refusal's
// code on it — which is data from the network, and must stay a failure, not send the read to pac. (A 401 or 403 from the Power Apps host is different: the SDK answers it
// with its own CONNECTIVITY_UNAUTHORIZED, an error it raised, whose code is the SDK's and never the body's.)
//
// The wrapped refusal: the Power Apps client's own rejections (a missing token, say) are not SDK errors, so the SDK wraps a rejection of the client as a ConnectionError with
// status 0 and keeps the original as its `cause`. It counts as "no token" only when it is exactly that — a transport failure (status 0) whose cause is this plugin's own
// client error, with the token-unavailable code — and then the code and the words that explain it are the original's.
function connectivityRefusal(error) {
  // Required here, for a failure only: the bundle is large, and a read that succeeds never needs its classes.
  const { SdkError } = require('./maker-sdk.js');
  if (!(error instanceof SdkError)) return null;
  if (error.code === 'CONNECTION_ERROR') {
    const cause = error.cause;
    if (error.statusCode === 0 && cause instanceof PowerAppsClientError && cause.code === TOKEN_UNAVAILABLE) return { code: TOKEN_UNAVAILABLE, message: String(cause.message) };
    return null;
  }
  return ROUTE_REFUSALS.includes(error.code) ? { code: error.code, message: String(error.message) } : null;
}

// The cloud an org is in, from its host, as the SDK decides it before it sends anything — `connectivityCloudOf` in api/connectivityShared.ts of the vendored SDK, which the
// bundle does not export. So the rule is written out here again, and pinned to the bundle by tests/connectivity-real-bundle.test.js (a table of hosts, each given to the real SDK,
// which refuses before any request or sends one): a re-vendored SDK that changes the rule fails there, not in front of a user.
//   <name>.crmtest.dynamics.com            Test
//   <name>.crm<N>.dynamics.com             Public — N is a number or nothing (crm, crm4, crm11) — except N = 9, which is GCC
//   anything else                          Unsupported: GCC High, DoD, China, a custom domain, a port, text that is not a URL
// What is read is the HOST, lower-cased, as `new URL(...).host` gives it: a port is part of it, so it never matches, and user information is not. `crm9` is a comparison of
// the digits as TEXT, so `crm09` is Public to the SDK and to this. The families are Dataverse's own, which dataverseOrigin (lib/dataverse-auth.js) lists with their source.
const PUBLIC_ORG_HOST = /^[a-z0-9-]+\.crm(\d*)\.dynamics\.com$/;
const TEST_ORG_HOST = /^[a-z0-9-]+\.crmtest\.dynamics\.com$/;
function connectivityCloudOf(instanceUrl) {
  let host = '';
  try {
    host = new URL(instanceUrl).host.toLowerCase();
  } catch {
    // Not a URL: it is in no cloud.
  }
  if (TEST_ORG_HOST.test(host)) return 'Test';
  const publicOrg = PUBLIC_ORG_HOST.exec(host);
  return publicOrg && publicOrg[1] !== '9' ? 'Public' : 'Unsupported';
}

// No Power Platform API client. The SDK picks its route from the org's cloud (api/connectivityRouter.ts): a Public org is read through the classic Power Apps API, the one
// route an Azure CLI token answers and the only one this plugin gives the SDK a client for. A Test org is read only through the Power Platform API, which the SDK reaches
// when the host gives it a `powerPlatformApiClient`, and the connector tables (`listConnectorTables`, `getConnectorTableSchema`) need that client AND a `connectorRuntimeClient`.
// The plugin cannot build either on the Azure CLI. The Power Platform API asks for a token that carries the Connectivity.Connections.Read and Connectivity.Connectors.Read
// permissions; the token the Azure CLI gives for that API carries environment-management and app-read scopes and neither of those, and the route answers such a token 403
// (CONNECTIVITY_UNAUTHORIZED). pac signs in with a client of its own whose token that API accepts, so pac answers what the SDK has no route for here.
//
// And it answers at once. The SDK would refuse a Test org, or any org outside the Public cloud, before sending anything — it reads no token and makes no request to say so — so
// asking it first only costs two Azure CLI processes (powerAppsPreflight, seconds each on a cold Windows machine) and a throwaway workspace. The refusal is decided here
// from the host instead, with the code the SDK would give (NOT_CONFIGURED for Test, CLOUD_UNSUPPORTED for the rest) so the output reads the same either way, and the
// SDK is never made.
const OUTSIDE_PUBLIC = Object.freeze({
  Test: Object.freeze({
    code: NOT_CONFIGURED,
    message: 'This environment is in the Test cloud, whose connections and connectors the SDK reads through the Power Platform API. That route needs a token with the connectivity '
      + "permissions, and the Azure CLI's token for the API has none, so the plugin gives the SDK no client for it and pac reads them. Nothing was requested.",
  }),
  Unsupported: Object.freeze({
    code: CLOUD_UNSUPPORTED,
    message: "This environment's host is not a Public-cloud one (<name>.crm<N>.dynamics.com, N other than 9) or a Test-cloud one, the two clouds the SDK reads connections in: GCC, "
      + 'GCC High, DoD, China, a custom domain and a port have no route, so pac reads them. Nothing was requested.',
  }),
});

/** `{ code, message }` for an org outside the Public cloud — what the SDK would refuse it with, given the clients this plugin gives it — else null. */
function connectivityRouteRefusal(env) {
  const cloud = connectivityCloudOf(env);
  return cloud === 'Public' ? null : { ...OUTSIDE_PUBLIC[cloud] };
}

// Whether a Power Apps token can be had at all, before an SDK is made — read beside the Dataverse token the SDK's first request needs
// (both start an Azure CLI process, seconds each on a cold Windows machine, and are kept for the rest of the run). Without one the
// route cannot be used on this machine, and a machine with no Azure CLI is told so here, not after a throwaway workspace and an org read.
async function powerAppsPreflight(env, deps = {}) {
  const dataverseToken = deps.getAuthTokenAsync || auth.getAuthTokenAsync;
  const powerAppsToken = deps.getPowerAppsTokenAsync || auth.getPowerAppsTokenAsync;
  const message = deps.powerAppsTokenFailureMessage || auth.powerAppsTokenFailureMessage;
  const [, token] = await Promise.all([dataverseToken(env), powerAppsToken()]);
  return token ? null : { code: TOKEN_UNAVAILABLE, message: message() };
}

// What must hold before an SDK is made for a connection or connector read, the cheapest check first: the org's cloud (no process, no request), then the Power Apps token (two
// Azure CLI processes). The first refusal skips the SDK, its throwaway workspace and every token read after it.
async function connectivityPreflight(env, deps = {}) {
  return connectivityRouteRefusal(env) || powerAppsPreflight(env, deps);
}

/** What a read of connections or connector metadata passes to sdkFirst: the opt-in factory option, the refusals and the route and token checks. */
const connectivity = Object.freeze({
  sdkOptions: Object.freeze({ connectivity: true }),
  refusal: connectivityRefusal,
  preflight: connectivityPreflight,
});

/**
 * Reads through the SDK and, when it refuses in the way `plan.refusal` names, through pac.
 * @param {string} env - a Dataverse https origin (already validated by the caller)
 * @param {object} plan
 * @param {(sdk: object) => Promise<any>} plan.fromSdk - the read, on an SDK made for `env`
 * @param {(refusal: {code: string, message: string}|null) => Promise<any>} plan.fromPac - the same read through pac; `refusal` says why it is asked
 * @param {(error: Error) => ({code: string, message: string}|null)} plan.refusal - a failure of the SDK that means "ask pac" → its code and
 *   message, any other → null
 * @param {(env: string, deps: object) => Promise<({code: string, message: string}|null)>} [plan.preflight] - settles before an SDK is made
 *   whether the route is usable at all (a refusal skips the SDK)
 * @param {object} [plan.sdkOptions] - more options for `createMakerSdk`
 * @param {(env: string) => object} [plan.httpClient] - the org's HttpClient, when the read needs other than the plain az-token one
 * @param {object} [deps] - test seams: `sdkModule` ({ createMakerSdk, createNodeWorkspaceStorage }), `httpClient`, and the preflight's token reads
 * @returns {Promise<{ source: 'sdk', value: any } | { source: 'pac', value: any, fallback: {code: string, message: string} }>}
 */
async function sdkFirst(env, plan, deps = {}) {
  let refused = plan.preflight ? await plan.preflight(env, deps) : null;
  if (!refused) {
    const workspaceDir = makeTempWorkspace('sdk-first-');
    try {
      const { createMakerSdk, createNodeWorkspaceStorage } = deps.sdkModule || require('./maker-sdk.js');
      const sdk = createMakerSdk({
        workspaceStorage: createNodeWorkspaceStorage(workspaceDir),
        instanceUrl: env,
        httpClient: deps.httpClient || (plan.httpClient ? plan.httpClient(env) : createAzHttpClient(env)),
        ...(plan.sdkOptions || {}),
      });
      return { source: 'sdk', value: await plan.fromSdk(sdk) };
    } catch (error) {
      refused = plan.refusal(error);
      if (!refused) throw error;
    } finally {
      try {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      } catch {
        // A directory nothing was written to must not turn a read into a failure.
      }
    }
  }
  // After the throwaway workspace is gone, so a slow pac does not keep it.
  return { source: 'pac', value: await plan.fromPac(refused), fallback: refused };
}

module.exports = { sdkFirst, connectivity, connectivityRefusal, connectivityCloudOf, connectivityRouteRefusal, connectivityPreflight, powerAppsPreflight, CONNECTIVITY_REFUSALS };
