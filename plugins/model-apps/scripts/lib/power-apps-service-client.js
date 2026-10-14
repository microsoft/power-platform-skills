'use strict';
// The HttpClient the bundled SDK's connection and connector reads are given as `powerAppsServiceClient`
// (MakerSdkOptions). lib/maker-sdk.js builds it when a caller asks for `connectivity`; nothing else makes one.
//
// It carries an Azure CLI token for the Power Apps service (https://service.powerapps.com/), so it is written as the part of the
// system that HOLDS the credential and does not trust whoever asks for a request — the SDK checks every URL before it sends one,
// and this client checks again, on its own, so a mistake in either cannot take the token somewhere it was never meant to go.
//
// What the SDK sends it — absolute URLs, GETs only (its connectivity code, api/ConnectivityApi.ts of the vendored SDK):
//   GET https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments/<environmentId>?api-version=2021-04-01
//   GET https://test.api.bap.microsoft.com/...                       the same read the SDK's classic route makes for a Test org (see below)
//   GET https://<region>.api.powerapps.com/providers/Microsoft.PowerApps/connections?api-version=2016-11-01&$filter=environment eq '<id>'
//   GET https://<region>.api.powerapps.com/providers/Microsoft.PowerApps/apis/<connector>?api-version=2016-11-01&$filter=...
// The first two hosts are fixed: the classic route names one from the org's cloud. In practice only the first is reached: the SDK's router reads a Public org through
// this route and a Test org through the Power Platform API, which the plugin gives no client (lib/sdk-first.js, "No Power Platform API client"), so it refuses a Test
// org before any request (`CONNECTIVITY_NOT_CONFIGURED`) and the rest of the clouds likewise (`CONNECTIVITY_CLOUD_UNSUPPORTED`). The Test host stays in the list because the
// list is the hosts the SDK's classic route can name, not the clouds this plugin sends to it: a host the SDK may name is one the client must not refuse by surprise.
// The runtime host is the one the environment's own BAP row names
// (`properties.runtimeEndpoints['microsoft.PowerApps']`, e.g. https://unitedstates.api.powerapps.com or
// https://unitedstates.tip2.api.powerapps.com), which the SDK accepts only as an https origin of `api.powerapps.com` or a name under it,
// with no port; each page of connections then names the next one (`nextLink`) on that same origin. So the allowlist is exactly those
// hosts: the two BAP names, `api.powerapps.com` and `*.api.powerapps.com`.
//
// What this client refuses, before a token is read: anything that is not an absolute https URL on those hosts (a port or credentials
// in it included), and every method but GET. What it never does: follow a redirect — Node's https.request does not, and a 3xx is handed
// back as the answer, which the SDK reads as a failure — or let the token out in a message or an answer: a transport error's text and every
// string of what the service answers (an error body that repeats the token it rejected, say) have it taken out before the SDK sees them.
const { makeRequest, getPowerAppsToken, powerAppsTokenFailureMessage } = require('./dataverse-auth.js');

// The two Business Application Platform hosts the SDK chooses between (Public, Test).
const BAP_HOSTS = Object.freeze(['api.bap.microsoft.com', 'test.api.bap.microsoft.com']);
// `api.powerapps.com` or any name under it, written as the SDK writes its own check of the runtime host: the label characters, then the suffix.
const RUNTIME_HOST_CHARS = /^[a-z0-9][a-z0-9.-]*$/;
const RUNTIME_HOST_SUFFIX = '.api.powerapps.com';

// How long a request may stay silent before it is given up (socket idle time, as makeRequest's `timeout`). The answers are small JSON
// documents read in a second or so; a minute without a byte is a stalled connection. Nothing is re-sent after it: the SDK states that no
// fault of these reads is measured as transient.
const REQUEST_TIMEOUT_MS = 60000;

const URL_REFUSED = 'POWER_APPS_URL_REFUSED';
const METHOD_REFUSED = 'POWER_APPS_METHOD_REFUSED';
const TOKEN_UNAVAILABLE = 'POWER_APPS_TOKEN_UNAVAILABLE';
const REQUEST_FAILED = 'POWER_APPS_REQUEST_FAILED';

// The SDK maps a rejection that is not its own to a `ConnectionError` (status 0) and keeps ours as its `cause`, so `code` is what a caller
// reads there (`error.cause.code`).
class PowerAppsClientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PowerAppsClientError';
    this.code = code;
  }
}

/** Whether `hostname` (as the URL parser gives it: lower-case, no port) is a host the Power Apps token may be sent to. */
function isAllowedHost(hostname) {
  if (typeof hostname !== 'string') return false;
  if (BAP_HOSTS.includes(hostname)) return true;
  return RUNTIME_HOST_CHARS.test(hostname) && (hostname === 'api.powerapps.com' || hostname.endsWith(RUNTIME_HOST_SUFFIX));
}

// The parsed URL when it is one the token may be sent to, else a refusal that names what is wrong with it. Only the host is named in the
// message, never the whole URL: it carries the environment's id and filter.
function allowedTarget(url) {
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new PowerAppsClientError(URL_REFUSED, 'Refusing to send the Power Apps token with a request whose URL is not an absolute URL.');
  }
  if (target.protocol !== 'https:') {
    throw new PowerAppsClientError(URL_REFUSED, `Refusing to send the Power Apps token over ${target.protocol.replace(/:$/, '')}: only https is allowed.`);
  }
  if (target.username !== '' || target.password !== '' || target.port !== '') {
    throw new PowerAppsClientError(URL_REFUSED, `Refusing to send the Power Apps token to ${target.host}: a URL with credentials or a port is not one the service uses.`);
  }
  if (!isAllowedHost(target.hostname)) {
    throw new PowerAppsClientError(URL_REFUSED, `Refusing to send the Power Apps token to ${target.hostname}: it is not a Business Application Platform or Power Apps host.`);
  }
  return target;
}

// Parsed as JSON when it is JSON, else left as the text it is (an error page): the SDK reads `error.code` and `message` of an object body
// and a plain string otherwise (api/ConnectivityApi.ts messageOf).
function parseBody(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// A transport error's text with the token taken out of it, should a transport ever repeat the request it failed — an axios error holds
// its `Authorization` header. The message is the last place a credential may be read from.
//
// Not the token alone: what an error or a gateway repeats of a bearer token is often one part of it. A token is `header.payload.signature` (three
// base64url parts joined by dots; https://www.rfc-editor.org/rfc/rfc7519#section-3), so each part long enough to be distinctive is taken out too.
const MIN_TOKEN_PART_LENGTH = 24;
function scrub(text, token) {
  const message = String(text);
  if (!token) return message;
  const needles = new Set([token]);
  for (const part of token.split('.')) if (part.length >= MIN_TOKEN_PART_LENGTH) needles.add(part);
  return [...needles].sort((a, b) => b.length - a.length).reduce((out, needle) => out.split(needle).join('<token>'), message);
}

// The same for what the SERVICE answered: a body or a header that echoes the credential (an authorization layer saying which token it rejected, a gateway
// repeating the request) would carry it into the SDK's error message — `ConnectionError` quotes the body, and the scripts print that message. Every string of the
// answer is scrubbed, keys included, whatever the status: the rest of the answer is left as it is, so the status and the typed `error.code` the SDK reads survive.
// A structure nested deeper than a real answer is, is replaced rather than walked (recursion on a body nested thousands of levels deep must not be what fails the read).
const MAX_SCRUB_DEPTH = 100;
function scrubAnswer(value, token, depth = 0) {
  if (typeof value === 'string') return scrub(value, token);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_SCRUB_DEPTH) return '<too deeply nested to scrub>';
  if (Array.isArray(value)) return value.map((item) => scrubAnswer(item, token, depth + 1));
  const scrubbed = {};
  for (const [key, item] of Object.entries(value)) scrubbed[scrub(key, token)] = scrubAnswer(item, token, depth + 1);
  return scrubbed;
}

/**
 * The client for the SDK's `powerAppsServiceClient` option: `get` for the SDK's reads, and a refusal for every other method, so a
 * future SDK that tried to write through it would fail here instead of sending a request.
 * @param {object} [deps] - test seams
 * @param {() => (string|null|Promise<string|null>)} [deps.getToken] - the Azure CLI token for the Power Apps service; null when there is none
 * @param {() => string} [deps.tokenFailureMessage] - what to say when it is null
 * @param {(options: object) => Promise<object>} [deps.request] - the transport (`makeRequest`'s contract: `{ statusCode, body, headers }` or `{ error }`)
 * @param {number} [deps.timeoutMs]
 * @returns {{get, post, patch, delete, put, postRaw, patchRaw}}
 */
function createPowerAppsServiceClient(deps = {}) {
  const getToken = deps.getToken || (() => getPowerAppsToken());
  const tokenFailureMessage = deps.tokenFailureMessage || powerAppsTokenFailureMessage;
  const request = deps.request || makeRequest;
  const timeout = deps.timeoutMs || REQUEST_TIMEOUT_MS;

  async function get(url) {
    // The URL first: a request that will be refused must not cost an Azure CLI call, and the token is read only for one that will be sent.
    const target = allowedTarget(url);
    const token = await getToken();
    if (!token) throw new PowerAppsClientError(TOKEN_UNAVAILABLE, tokenFailureMessage());
    let res;
    try {
      // `target.href`, the URL as it was checked: the request is parsed once more by the transport, and what it sends to must be what was allowed.
      res = await request({
        url: target.href,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        includeHeaders: true,
        timeout,
      });
    } catch (error) {
      throw new PowerAppsClientError(REQUEST_FAILED, scrub((error && error.message) || error, token));
    }
    if (!res || res.error) throw new PowerAppsClientError(REQUEST_FAILED, scrub((res && res.error) || 'no answer', token));
    // A redirect is an answer like any other: not followed, and the SDK takes any status outside 2xx as a failure.
    // The raw text is scrubbed before it is parsed, and the parsed answer after (see scrubAnswer): the credential is taken out wherever the service spelled it.
    return { status: res.statusCode, headers: scrubAnswer(res.headers || {}, token), body: scrubAnswer(parseBody(typeof res.body === 'string' ? scrub(res.body, token) : res.body), token) };
  }

  const refuse = (method) => async () => {
    throw new PowerAppsClientError(METHOD_REFUSED, `The Power Apps service client sends GET requests only (${method} was refused).`);
  };
  return {
    get,
    post: refuse('POST'),
    patch: refuse('PATCH'),
    delete: refuse('DELETE'),
    put: refuse('PUT'),
    postRaw: refuse('POST'),
    patchRaw: refuse('PATCH'),
  };
}

module.exports = {
  createPowerAppsServiceClient,
  isAllowedHost,
  PowerAppsClientError,
  BAP_HOSTS,
  REQUEST_TIMEOUT_MS,
  URL_REFUSED,
  METHOD_REFUSED,
  TOKEN_UNAVAILABLE,
  REQUEST_FAILED,
};
