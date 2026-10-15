'use strict';
// The build's retry policy: when a failure is worth running the whole build again for.
//
// buildModelApp (build-model-app.js) runs every phase again — up to three more times, after a back-off — when a halt looks transient. The build is idempotent, so that is
// safe, but it is not free, and it blames the service in the log. So it must be decided from what the SERVICE said, never from what the maker named: a halt's message quotes
// views, roles, personas, flows, pages, source files and workspace folders, and "SQL Timeout Reader" is a legal name for any of them. Matching the text of a halt used to be the
// whole decision, and a deterministic refusal that happened to quote such a name was run four times.
//
// THE RULE, in the order it is applied (`judgeFailure`). The failure is the halt and the chain of `cause`s behind it, outermost first:
//   1. NEVER. Any error in the chain that says `transient: false`, however deep: a refusal a run again cannot change, an outcome that must not be sent again, a prerequisite.
//      It wins over everything below, a 503 included.
//   2. STATUS. The HTTP status the service answered — 429 (throttled) and 502, 503, 504 (the gateway or the service is down or behind) — on any error of the chain. The SDK's own
//      ConnectionError carries it as `statusCode`, and 0 for a failure of the transport. See https://learn.microsoft.com/en-us/power-apps/developer/data-platform/api-limits
//      and https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/compose-http-requests-handle-errors
//   3. TRANSPORT. A timeout or a reset of the connection: a system error whose `code` is one of TRANSPORT_CODES, or an SDK ConnectionError of status 0 whose own words say so.
//      A transport failure for another reason (a certificate, an unknown host) is not a blip.
//   4. TYPE. An error the SDK or the plugin types — a string `code` that is not CONNECTION_ERROR and not a transport code: VALIDATION_ERROR, VERSION_CONFLICT, ARTIFACT_NOT_FOUND,
//      APP_SOURCE_PATH, a file system error (ENOENT, EACCES) — is a refusal, whatever its message quotes, and no text is read from the chain. (A typed error that also carries a
//      throttle status is still the service's answer: 2 comes first. And an SDK error that only WRAPS a failed publish — WRAPPED_SERVICE_CODES — is not a refusal: see there.)
//   5. WORDS. Only then, the service's own words: what an error DECLARES as such (`retryText`, outermost declaration), or else the message of each error in the chain that is not a
//      BuildHalt — a halt's message is the plugin's own, and is never read. The SDK's ConnectionError opens with where the request went, which holds what the maker named in its
//      query (`HTTP 400 from https://<org>/api/data/v9.2/roles?$filter=name eq 'SQL Timeout Reader': <the answer>`), so the lead is cut off and only the answer is read; a transport
//      failure has no words to read (rule 3 decided it). The words themselves are build-model-app.js's (isTransientHalt).
//
// WHAT RAISES A POLICY, where a failure is raised:
//   - a halt is raised with `retry: RETRY.NEVER` (a refusal of the spec, an identity or ownership conflict, an approval, a prerequisite, a local file) or with a policy decided from the failure
//     it wraps (`retry: retryPolicyFor(error)` / `...retryFrom(error)`), which is NEVER for a failure that says so or is typed, and SERVICE otherwise. `recoverable` is not a retry decision:
//     it says a re-run of the phase can continue, not that the service will have recovered.
//   - an error the build's engine raises itself is made by `refusal(message)` (deterministic: the spec, the environment's state, a local file) or `serviceFailure(message, …)` (the plugin's
//     words around a failure of the service). tests/halt-retry-policy.test.js enumerates every halt in the sources and holds each to a table, so a halt added without a policy fails there.
// An error that carries none of this — an SDK or transport error that reaches the build as it is — is read by the rule above, as it always was.
const RETRY = Object.freeze({ NEVER: 'never', SERVICE: 'service' });

// The statuses a run again can ride out. 429 is the service's throttle; 502, 503 and 504 are the answers of a gateway or a service that is down or overloaded, never a verdict on the request.
const TRANSIENT_STATUSES = Object.freeze(new Set([429, 502, 503, 504]));
const isTransientStatus = (status) => TRANSIENT_STATUSES.has(status);

// The system errors of a connection that was reset or timed out, and undici's own, as Node reports them.
// See https://nodejs.org/api/errors.html#common-system-errors
const TRANSPORT_CODES = Object.freeze(new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]));
// What the plugin's own HTTP layer and Node say when a request is reset or times out (lib/dataverse-auth.js makeRequest, lib/sdk-http-client.js):
//   Request failed: read ECONNRESET          Request failed: connect ETIMEDOUT 10.0.0.1:443        Request timed out        socket hang up
//   Connection closed before the response completed        Response aborted before it completed
const TRANSPORT_WORDS = /\b(?:ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED|EPIPE|EAI_AGAIN)\b|socket hang up|timed out|Connection closed before the response completed|Response aborted before it completed/i;

// The SDK errors that are typed and are still the service's to explain: the SDK words a sentence of its own around the error it caught and puts that error's message inside it, without
// attaching it as a cause. `enrichDefaultViews` does so when the publish of the views it has saved fails (a build without --publish):
//   enrichDefaultViews: 2 view(s) on 'contoso_task' were saved but the publish FAILED, so none of them is live (HTTP 503 from https://<org>/api/data/v9.2/PublishXml: Service Unavailable). Re-publish the entity to make them visible; …
// That is not a refusal: the answer inside says whether a run again can help (a 503, a customization lock), as it did when the build read the whole message. So rule 4 leaves these codes alone, and the
// status, the transport failure and the words of the embedded answer decide — the answer opens the way the SDK's ConnectionError does (`HTTP <status> from <url>: …`, `Transport failure reaching <url>: …`).
// What the sentence quotes of its own is a table's logical name, which has no space in it for a phrase to be read out of.
const WRAPPED_SERVICE_CODES = Object.freeze(new Set(['ENRICH_DEFAULT_VIEWS_PUBLISH_FAILED']));
const EMBEDDED_STATUS = /\(HTTP (\d{3}) from /;
const EMBEDDED_TRANSPORT = /\(Transport failure reaching /;

// How far down the chain of causes the decision looks. Deeper than any failure the build raises (a halt, a step's wrapper, the SDK's error, the system error under it).
const MAX_CHAIN = 8;

// An error that says a run again cannot change it. `refusal` makes one; `neverRetry` marks one that exists. The message is the maker's to read and nobody's to judge.
function refusal(message, props = {}) {
  const { cause, ...rest } = props;
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { transient: false }, rest);
}
function neverRetry(error) {
  if (error && typeof error === 'object') error.transient = false;
  return error;
}

// An error the plugin words around a failure of the service: `status` is the HTTP status the service answered, `words` its own words about it (the only text the decision reads of this
// error), `cause` the failure itself. What the message quotes of the maker's is the plugin's, and does not decide.
function serviceFailure(message, { status, words, cause } = {}) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  if (Number.isInteger(status) && status > 0) error.statusCode = status;
  if (words !== undefined) error.retryText = String(words);
  return error;
}

// A result that reports a failure BY VALUE (`{ ok: false, error: '…' }`, `{ kind: 'failed', detail: '…' }` — a listing never throws) flattens the failure to a string, and a string holds the SDK's url and
// whatever the maker named in it. The failure itself rides along as `cause`, for the halt raised around the result to decide from (`retryFrom(result.cause, result.detail)`). NOT enumerable on a result
// that is printed or compared (the genpage backend's), so the result serializes and compares as it always did; a result that is only read in process may carry it plain. Not an object: nothing is added.
function withCause(result, failure) {
  if (isObject(failure) && isObject(result)) Object.defineProperty(result, 'cause', { value: failure, enumerable: false, configurable: true, writable: true });
  return result;
}

const isHalt = (error) => !!error && error.name === 'BuildHalt';
const isObject = (value) => !!value && typeof value === 'object';
const isConnectionError = (error) => error.code === 'CONNECTION_ERROR';
const typedCode = (error) => (typeof error.code === 'string' && error.code ? error.code : null);
const messageOf = (error) => (typeof error.message === 'string' ? error.message : '');

// An SDK error that carries a failed request's answer in its message (WRAPPED_SERVICE_CODES), and the status that answer opens with: 0 for any other error.
const wrapsServiceFailure = (error) => WRAPPED_SERVICE_CODES.has(typedCode(error));
function embeddedStatus(error) {
  const found = wrapsServiceFailure(error) ? EMBEDDED_STATUS.exec(messageOf(error)) : null;
  return found ? Number(found[1]) : 0;
}

// The errors of a failure, outermost first: the error and its causes. A cause that is not an object (a response body held as a string) ends it; so does an SDK ConnectionError that
// carries an HTTP status, whose `cause` is the response body and not an error — and a body is never read as one.
function causeChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (isObject(current) && !seen.has(current) && chain.length < MAX_CHAIN) {
    seen.add(current);
    chain.push(current);
    current = isConnectionError(current) && current.statusCode > 0 ? null : current.cause;
  }
  return chain;
}

// The words an SDK ConnectionError opens with, cut off: only the service's answer is left. The lead is rebuilt from the error's own `statusCode` and `url` and cut only when the message
// really begins with it, as lib/solution-settings.js does; a message that does not is read whole, since nothing proves which part is the url.
//   HTTP 500 from https://contoso.crm.dynamics.com/api/data/v9.2/roles?$filter=name eq 'SQL Timeout Reader': Sql error: Generic SQL error. Sql Number: 1205
//   Transport failure reaching https://contoso.crm.dynamics.com/api/data/v9.2/$batch: Request failed: read ECONNRESET
function answerOf(error) {
  const message = messageOf(error);
  if (isConnectionError(error) && typeof error.url === 'string' && Number.isInteger(error.statusCode)) {
    const lead = error.statusCode > 0 ? `HTTP ${error.statusCode} from ${error.url}: ` : `Transport failure reaching ${error.url}: `;
    if (message.startsWith(lead)) return message.slice(lead.length);
  }
  return message;
}

// A timeout or a reset of the transport.
function isTransportBlip(error) {
  const code = typedCode(error);
  if (code && TRANSPORT_CODES.has(code)) return true;
  if (isConnectionError(error) && error.statusCode === 0 && TRANSPORT_WORDS.test(answerOf(error))) return true;
  return wrapsServiceFailure(error) && EMBEDDED_TRANSPORT.test(messageOf(error)) && TRANSPORT_WORDS.test(messageOf(error));
}

// An error the SDK or the plugin has typed: its code says what it is, and what it is is not a service hiccup.
const isTypedRefusal = (error) => !isHalt(error) && typedCode(error) !== null && !isConnectionError(error) && !TRANSPORT_CODES.has(typedCode(error)) && !wrapsServiceFailure(error);

// What the rule above finds in a failure: { never, transientStatus, transport, text }. `never` covers the explicit marker and a typed refusal with nothing transient beside it; `text` is the
// service's own words, empty when none may be read.
function judgeFailure(error) {
  const chain = causeChain(error);
  const explicit = chain.some((e) => e.transient === false);
  const transientStatus = chain.some((e) => isTransientStatus(e.statusCode) || isTransientStatus(embeddedStatus(e)));
  const transport = chain.some(isTransportBlip);
  const typed = chain.some(isTypedRefusal);
  if (explicit || (typed && !transientStatus && !transport)) return { never: true, transientStatus, transport, text: '' };
  if (typed) return { never: false, transientStatus, transport, text: '' };
  const declared = chain.find((e) => typeof e.retryText === 'string');
  const words = declared
    ? declared.retryText
    : chain.filter((e) => !isHalt(e) && !(isConnectionError(e) && e.statusCode === 0)).map(answerOf).join(' ');
  return { never: false, transientStatus, transport, text: words };
}

// The policy a halt (or any error) raised around `failure` is given: NEVER when the failure says so or is typed, SERVICE when it is the service's to say. No failure at all is NEVER: the
// halt is the plugin's own refusal.
function retryPolicyFor(failure) {
  if (!isObject(failure)) return RETRY.NEVER;
  return judgeFailure(failure).never ? RETRY.NEVER : RETRY.SERVICE;
}

// The retry options of a halt that wraps a failure — `new BuildHalt(message, { phase, code, recoverable, ...retryFrom(failure, words) })`: the failure itself as the cause, with the policy its
// structure gives; or, when all there is is the text of a failure a helper reported by value (`{ ok: false, error: '…' }`), that text as the service's words. Neither is NEVER: nothing of the
// service's to ask.
function retryFrom(failure, words) {
  if (isObject(failure)) return { cause: failure, retry: retryPolicyFor(failure) };
  if (typeof words === 'string' && words) return { retry: RETRY.SERVICE, retryText: words };
  return { retry: RETRY.NEVER };
}

module.exports = {
  RETRY, TRANSIENT_STATUSES, TRANSPORT_CODES, isTransientStatus, refusal, neverRetry, serviceFailure, withCause, judgeFailure, retryPolicyFor, retryFrom,
};
