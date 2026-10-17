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
//   3. CODE. A condition the service names by the `error.code` of its answer — the OData error the SDK keeps, as the cause of its ConnectionError, or the one the engine's own failure records of an answer
//      it read with a request of its own (serviceFailure's `answered`) — is run again on any status: a customization or
//      solution lock, SQL giving up waiting, a concurrent request on the same record (TRANSIENT_SERVICE_CODES), the lag of a column the build has only just created (the spec says which are its), and a SQL
//      deadlock victim (isDeadlockVictimAnswer: the generic SQL error code AND, in the service's own answer, the platform's deadlock signature). Never the words beside a code on their own: see 5.
//   4. TRANSPORT. A timeout or a reset of the connection. The HTTP client puts Node's own `code` on the error it throws for a request that failed, and the SDK keeps that error as the cause of its ConnectionError of status 0: when the
//      failure carries a code, THE CODE DECIDES — one of TRANSPORT_CODES is a blip, and any other (a certificate that does not verify: ERR_TLS_CERT_ALTNAME_INVALID, UNABLE_TO_VERIFY_LEAF_SIGNATURE, …; an unknown host) is not,
//      whatever words come beside it: a certificate quotes the host and the names it carries, and a name can spell a reset. Only a failure with no code (a transport that reports none; the sentence an SDK error wraps around a
//      failed publish) is read by its words, and there a certificate's own phrases (CERTIFICATE_WORDS) are read first. A transport failure for another reason is not a blip.
//   5. A PERMANENT STATUS. Any other HTTP status in the chain — a 400, 401, 403, 404, 409, 412, a 500, and the 200 of an answer the SDK could not use — is a verdict, and nothing in the answer's WORDS
//      can undo it: a service echoes what the maker named (the table in "does not contain the attribute", the privilege derived from it in "missing prvRead…", the segment of a url), and a table's
//      logical name is one word that can be any word — `contoso_customizationlockexception` is a valid one — so a rule that finds a transient-sounding word anywhere in an answer runs a build four times
//      for a 403. A failure that carries such a status is never run again, whatever its message says.
//   6. TYPE. An error the SDK or the plugin types — a string `code` that is not CONNECTION_ERROR and not a transport code: VALIDATION_ERROR, VERSION_CONFLICT, ARTIFACT_NOT_FOUND,
//      APP_SOURCE_PATH, a file system error (ENOENT, EACCES) — is a refusal, whatever its message quotes, and no text is read from the chain. (A typed error that also carries a
//      throttle status is still the service's answer: 2 comes first. And an SDK error that only WRAPS a failed publish — WRAPPED_SERVICE_CODES — is not a refusal: what it embeds is read as the failure it came
//      from — its status — and nothing of the sentence around it: see there.)
//   7. WORDS. Only for a failure that carries NO HTTP status at all — a plain error, or the words a helper reported by value — the service's own words: what an error DECLARES as such
//      (`retryText`, outermost declaration), or else the message of each error in the chain that is not a BuildHalt — a halt's message is the plugin's own, and is never read. The words themselves
//      are build-model-app.js's (isTransientHalt). They are the fallback for what has no structure, never a second opinion on what has.
//
// WHAT RAISES A POLICY, where a failure is raised:
//   - a halt is raised with `retry: RETRY.NEVER` (a refusal of the spec, an identity or ownership conflict, an approval, a prerequisite, a local file) or with a policy decided from the failure
//     it wraps (`retry: retryPolicyFor(error)` / `...retryFrom(error)`), which is NEVER for a failure that says so or is typed, and SERVICE otherwise. `recoverable` is not a retry decision:
//     it says a re-run of the phase can continue, not that the service will have recovered.
//   - an error the build's engine raises itself is made by `refusal(message)` (deterministic: the spec, the environment's state, a local file) or `serviceFailure(message, …)` (the plugin's
//     words around a failure of the service — and, for an answer the engine read with a request of its own, that answer's OData error, `answered`, which rule 3 reads as it reads the SDK's).
//     tests/halt-retry-policy.test.js enumerates every halt in the sources and holds each to a table, so a halt added without a policy fails there.
// An error that carries none of this — an SDK or transport error that reaches the build as it is — is read by the rule above, as it always was.
// The platform's signature of a SQL deadlock victim, the one the HTTP client already sends requests again on (lib/sdk-http-client.js): `Sql Number: 1205`.
const { SQL_DEADLOCK_VICTIM } = require('./sdk-http-client.js');
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
//   Connection closed before the response completed       Response aborted before it completed       Response failed before it completed: aborted
//   Client network socket disconnected before secure TLS connection was established       (a reset in the middle of the TLS handshake)
// The same list lib/sdk-http-client.js (TRANSIENT_TRANSPORT_FAILURE) sends a request again for — that file is copied into the pcf plugin, which has no policy, so the two are kept equal by a test
// (tests/sdk-http-client.test.js): the build and the client call the same failures a blip, and a certificate that does not verify, a host that does not exist and a refused connection are neither's.
const TRANSPORT_WORDS = /\b(?:ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED|EPIPE|EAI_AGAIN)\b|socket hang up|timed out|Connection closed before the response completed|Response (?:aborted|failed) before it completed|Client network socket disconnected before secure TLS connection was established/i;
// What Node and OpenSSL say when a certificate does not verify (lib/sdk-http-client.js, CERTIFICATE_FAILURE, which this equals): a failure with no code is read for these before it is read for a reset, because the names a certificate carries
// — and Node quotes — can be any text. Each phrase has a space or a slash in it, which no host name has.
const CERTIFICATE_WORDS = new RegExp([
  'unable to verify the (?:first|leaf) certificate',
  'unable to get (?:local )?issuer certificate',
  'self[- ]signed certificate',
  'certificate (?:has expired|is not yet valid|revoked|not trusted|rejected|signature failure|chain too long|verify failed)',
  'invalid CA certificate',
  "does not match certificate's altnames",
].join('|'), 'i');

// The SDK errors that are typed and are still the service's to explain: the SDK words a sentence of its own around the error it caught and puts that error's message inside it, without
// attaching it as a cause. `enrichDefaultViews` does so when the publish of the views it has saved fails (a build without --publish):
//   enrichDefaultViews: 2 view(s) on 'contoso_task' were saved but the publish FAILED, so none of them is live (HTTP 503 from https://<org>/api/data/v9.2/PublishXml: Service Unavailable). Re-publish the entity to make them visible; the saves themselves are unaffected.
// That is not a refusal: the answer inside says whether a run again can help (a 503, a customization lock), as it did when the build read the whole message. So rule 4 leaves these codes alone — but ONLY the answer
// inside is read, never the sentence around it: it names the maker's table, and a logical name has no space in it for a phrase to be read out of, yet it can be a word of the rule (`contoso_customizationlockexception`
// is a valid name, and the rule matches that word anywhere, in any case). So the sentence is taken apart, anchored at both ends on the SDK's own fixed words, and what is inside the parentheses is read exactly as the
// ConnectionError it came from is: `HTTP <status> from <url>: <the service's words>`, or `Transport failure reaching <url>: <the transport's words>` for status 0 (lib/maker-sdk.js, ConnectionError). The status decides
// first, then a reset, then the words after the url — never the table, never the url. A sentence that does not read this way (another wording, an answer that does not open as a ConnectionError does, a table or an url
// with a space in it, where nothing says where the answer starts) FAILS CLOSED: it is a typed refusal like any other, and nothing in it is read. A change of the sentence in a later SDK is caught by
// tests/halt-retry-policy.test.js, which has the real bundle build it.
const WRAPPED_SERVICE_CODES = Object.freeze(new Set(['ENRICH_DEFAULT_VIEWS_PUBLISH_FAILED']));
const WRAPPER_SENTENCE = /^enrichDefaultViews: \d+ view\(s\) on '[^'\s]*' were saved but the publish FAILED, so none of them is live \(([\s\S]+)\)\. Re-publish the entity to make them visible; the saves themselves are unaffected\.$/;
const EMBEDDED_ANSWER = /^(?:HTTP (\d{3}) from|Transport failure reaching) (\S+): ([\s\S]*)$/;

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
// `answered` is the OData `error` of the answer itself, for a failure of a request the plugin sent and read on its own (lib/entity-provision.js statusError): the answer
//   { "error": { "code": "0x80044151", "message": "SQL timeout expired." } }
// is recorded as its `code` and its `message` — the only two members the rule ever reads (answeredErrorOf, isDeadlockVictimAnswer), each kept only when it is a string — so the code decides here exactly as it
// does for the same answer reaching the build as the SDK's ConnectionError, which keeps the body as its cause. An `answered` that is not an object (a string, a list) records nothing, and a code that is only
// MENTIONED — in the message, in the plugin's sentence — is not the code. The record is not one of the error's enumerable properties, so the error prints, serializes and compares as it did.
const RECORDED_ANSWER = Symbol('the OData error of an answer the plugin read itself');
function serviceFailure(message, { status, words, cause, answered } = {}) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  if (Number.isInteger(status) && status > 0) error.statusCode = status;
  if (words !== undefined) error.retryText = String(words);
  if (isObject(answered) && !Array.isArray(answered)) {
    const recorded = {};
    if (typeof answered.code === 'string') recorded.code = answered.code;
    if (typeof answered.message === 'string') recorded.message = answered.message;
    Object.defineProperty(error, RECORDED_ANSWER, { value: Object.freeze(recorded), enumerable: false });
  }
  return error;
}
// What serviceFailure recorded of an answer, or null for any other error.
const recordedAnswerOf = (error) => (Object.prototype.hasOwnProperty.call(error, RECORDED_ANSWER) ? error[RECORDED_ANSWER] : null);

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

// An SDK error that carries a failed request's answer in its message (WRAPPED_SERVICE_CODES) — the code alone says nothing of whether that answer can be read.
const wrapsServiceFailure = (error) => WRAPPED_SERVICE_CODES.has(typedCode(error));
// What such an error embeds, as { status, answer }: the status the service answered (0 for a failure of the transport) and the words after the url — or null when the sentence is not the one the SDK words (see
// WRAPPED_SERVICE_CODES), and then nothing of it is read.
function embeddedFailure(error) {
  const sentence = wrapsServiceFailure(error) ? WRAPPER_SENTENCE.exec(messageOf(error)) : null;
  const answer = sentence ? EMBEDDED_ANSWER.exec(sentence[1]) : null;
  return answer ? { status: answer[1] === undefined ? 0 : Number(answer[1]), answer: answer[3] } : null;
}
const embeddedStatus = (error) => (embeddedFailure(error) || { status: 0 }).status;

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
  const embedded = embeddedFailure(error);
  if (embedded) return embedded.answer;
  const message = messageOf(error);
  if (isConnectionError(error) && typeof error.url === 'string' && Number.isInteger(error.statusCode)) {
    const lead = error.statusCode > 0 ? `HTTP ${error.statusCode} from ${error.url}: ` : `Transport failure reaching ${error.url}: `;
    if (message.startsWith(lead)) return message.slice(lead.length);
  }
  return message;
}

// A failure of the transport, as an SDK ConnectionError of status 0 reports it, or as an SDK error that wraps one embeds it: there are no service words in it, only the transport's.
const isTransportFailure = (error) => (isConnectionError(error) && error.statusCode === 0) || (embeddedFailure(error) || {}).status === 0;

// A timeout or a reset of the transport. When the error the transport raised carries Node's code, the code decides — on the error itself, or, for an SDK ConnectionError of status 0, which keeps what the HTTP client threw as its `cause`,
// on that cause: one of TRANSPORT_CODES is a blip and any other code is final, whatever words come beside it. The words are read only when there is no code, and a certificate's own phrases before a reset's.
function isTransportBlip(error) {
  const code = typedCode(error);
  if (code && TRANSPORT_CODES.has(code)) return true;
  if (!isTransportFailure(error)) return false;
  const raised = isObject(error.cause) ? typedCode(error.cause) : null;
  if (raised && raised !== 'CONNECTION_ERROR') return TRANSPORT_CODES.has(raised);
  const words = answerOf(error);
  return !CERTIFICATE_WORDS.test(words) && TRANSPORT_WORDS.test(words);
}

// An error the SDK or the plugin has typed: its code says what it is, and what it is is not a service hiccup. The one exception is an SDK error that wraps a failed publish in a sentence this code can take apart
// (embeddedFailure): it is the service's answer, and is judged as such. One it cannot take apart is a refusal like any other.
const isTypedRefusal = (error) => !isHalt(error) && typedCode(error) !== null && !isConnectionError(error) && !TRANSPORT_CODES.has(typedCode(error)) && embeddedFailure(error) === null;

// The OData `error.code` of the answer an SDK ConnectionError carries — its `cause` is the response body, `{ "error": { "code": "0x80044151", "message": "SQL timeout expired." } }` — lower-cased (the platform writes
// them with either case: 0x8004F064, 0x80071151), or null when the error has no such body. Only the SDK's own ConnectionError for an answer (a status above 0) is read, and only the `code` field of the body's `error`:
// a code that is merely MENTIONED — in the message, in a name — is not the code, and a body that is not an OData error (a string, an HTML page from a gateway) holds none. The same answer read by a request of
// the plugin's own reaches the build as the engine's error around it, which records that `error` (serviceFailure's `answered`): it is read the same way, so a lock or a SQL timeout answered to the engine's own
// read or write is what it is when the SDK reads it.
function answeredErrorOf(error) {
  const recorded = recordedAnswerOf(error);
  if (recorded) return recorded;
  const body = isConnectionError(error) && error.statusCode > 0 && isObject(error.cause) ? error.cause : null;
  return body && isObject(body.error) ? body.error : null;
}
function serviceCodeOf(error) {
  const answered = answeredErrorOf(error);
  return answered && typeof answered.code === 'string' && answered.code ? answered.code.toLowerCase() : null;
}

// The conditions the service names by the code of its answer, and that a run again can ride out whatever status carries them: another customization or solution operation holds the lock, SQL gave up waiting, a
// concurrent request holds the record. These are the conditions the build's retry was always written for, which it used to find by their words anywhere in an answer (`CustomizationLockException`, "another solution
// install", "try again later", "SQL timeout", "concurrent Delete") — words the maker's own names can hold. Each is a code the platform documents, with its name there:
//   https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/web-service-error-codes
// The SDK recognises the first (a 429 with this code) to re-send a business process flow write, and the live capture of a refused solution delete in sdk-http-client.test.js carries it. To add a condition, add its
// documented code here and a row to the list in tests/retry-policy.test.js; a code the platform does not document for it is a guess. NOT in this table, on purpose: the SQL deadlock victim. It shares the generic SQL error
// code (`0x80044150`) with every other SQL failure — a constraint, a value too long, a timeout of another kind — so the code alone would run each of them again; only its SQL number tells it apart (isDeadlockVictimAnswer, below).
const TRANSIENT_SERVICE_CODES = Object.freeze(new Set([
  '0x80071151', // SolutionConcurrencyFailure: the installation or removal of another solution is running — "Please try again later."
  '0x80071154', // ConcurrentOperationFailure: another concurrent operation is running — "Please try again later."
  '0x80090412', // EntityCustomizationLockException: an entity customization is running
  '0x8004f061', // CustomizationLockEx_BothUnknown: "Cannot start the requested operation because there is a customization running at this moment."
  '0x8004f062', // CustomizationLockEx_BlockedUnknown
  '0x8004f063', // CustomizationLockEx_BothKnownSame
  '0x8004f064', // CustomizationLockEx_BothKnownDifferent: "Cannot start the requested operation [Publish] because there is another [EntityCustomization] running at this moment."
  '0x8004f067', // CustomizationLockEx_BlockingUnknown
  '0x8004f077', // RACCannotAcquireCustomizationLock: "Another metadata process is in progress. Please try again later."
  '0x80044151', // unManagedidssqltimeouterror: "SQL timeout expired."
  '0x80048105', // CascadeOperationConcurrentRequested: "More than one concurrent {0} requests detected for an Entity {1} and ObjectTypeCode {2}."
  '0x80048116', // POAOperationConcurrentRequested: the same, for a principal's access to the object
]));

// A SQL deadlock victim: SQL Server chose the request's transaction as the victim of a deadlock and rolled it back, so the idempotent build can run again — as it did when the build read the words of a failure, and as the HTTP
// client and the SDK already send a request again where that is safe (lib/sdk-http-client.js). Deadlocks do happen under concurrent metadata work. Live-captured, an HTTP 500 whose body is
//   {"error":{"code":"0x80044150","message":" Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205"}}
// which the SDK words as `HTTP 500 from <url>: Sql error: Generic SQL error. CRM ErrorCode: … Sql Number: 1205`. Two things make it one, and neither does alone:
//   - the CODE is the generic SQL error's, `0x80044150`, read from the `error.code` of the body (serviceCodeOf), never from text. Every SQL failure carries it, so it says only that SQL failed;
//   - the service's own ANSWER — what follows the url in the SDK's message (answerOf), so the maker's names in the url are not read; for an answer the engine read itself, the `message` it recorded of it
//     (serviceFailure's `answered`), never the plugin's sentence around it, which goes on after the answer and can quote a name there — ends in the platform's deadlock signature (SQL_DEADLOCK_VICTIM, the HTTP client's): the LAST SQL
//     number it gives is 1205. The platform writes its diagnostic after the SQL text, and the SQL text can quote what a maker named — a duplicate key quotes the value that collided — so a name that spells `Sql Number: 1205` in front of
//     the platform's own 2627 is a unique-key violation and not a deadlock, and a name that quotes another number in front of the platform's 1205 does not hide one:
//       …The duplicate key value is (Sql Number: 1205). CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 2627
// The signature without that code is text that can say anything — a display name that reads as one, or a url the SDK echoes — and the code beside another SQL number (547 is a constraint, 1222 a lock timeout, 2627 a unique key) is a failure
// a run again cannot change. Everything else about this code stays final.
// See https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/web-service-error-codes
const GENERIC_SQL_ERROR_CODE = '0x80044150';
const serviceWordsOf = (error) => {
  const recorded = recordedAnswerOf(error);
  if (recorded) return typeof recorded.message === 'string' ? recorded.message : '';
  return answerOf(error);
};
const isDeadlockVictimAnswer = (error) => serviceCodeOf(error) === GENERIC_SQL_ERROR_CODE && SQL_DEADLOCK_VICTIM.test(serviceWordsOf(error));

// The lag of a column the build has only just created. A view pushed moments after the relationship that adds its lookup is refused with a 400 whose answer says the table has no such attribute, and a run again succeeds
// (live-captured, from a view pushed right after the build created the relationship):
//   HTTP 400 from https://<org>/api/data/v9.0/savedqueries?$select=savedqueryid: The column, fetchxml, has invalid fetch.  Error : 'contoso_task' entity doesn't contain attribute with Name = 'contoso_projectid' and NameMapping = 'Logical' (look up …
// The metadata change had not reached the server that validates the fetch yet. It is the service's answer, so the code names it — QueryBuilderNoAttribute, "The specified attribute does not exist on this entity" (`0x80041103`),
// or InvalidFetchXml (`0x80040303`), the code of the validation that wraps it — and what the build adds is the one thing a code cannot say: that the column is one the SPEC creates (the message names the table and the
// column; `declares(table, column)` asks the spec). A column nobody declared is an authoring error and halts at once instead of spending three backoffs. The code of the wrapper has not been captured live: both documented
// codes for this failure are taken, and the pair of names the spec must declare is what keeps either from reading a real authoring error as lag.
const MISSING_ATTRIBUTE_CODES = Object.freeze(new Set(['0x80041103', '0x80040303']));
// Group 1 is the table, group 2 the column (both logical). `doesn.t` also accepts a typographic apostrophe, so a localized or reformatted rendering still matches.
const MISSING_DECLARED_ATTRIBUTE = /'([^']+)' entity doesn.t contain attribute with Name\s*=\s*'([^']+)'/i;

// The [table, column] an answer says is missing — for an answer whose code is one of MISSING_ATTRIBUTE_CODES and whose own message names them — or null. The answer's own message is read for the two names and for nothing else.
function missingAttributeOf(error) {
  const code = serviceCodeOf(error);
  const answered = code !== null && MISSING_ATTRIBUTE_CODES.has(code) ? answeredErrorOf(error) : null;
  const named = answered && typeof answered.message === 'string' ? MISSING_DECLARED_ATTRIBUTE.exec(answered.message) : null;
  return named ? [named[1], named[2]] : null;
}

// Whether the answer this error carries is a condition the service names by its code as one a run again can ride out — see TRANSIENT_SERVICE_CODES — a SQL deadlock victim (isDeadlockVictimAnswer), or the lag of a column the
// spec creates (`declares`).
function isTransientServiceAnswer(error, declares) {
  const code = serviceCodeOf(error);
  if (code === null) return false;
  if (TRANSIENT_SERVICE_CODES.has(code)) return true;
  if (isDeadlockVictimAnswer(error)) return true;
  const missing = typeof declares === 'function' ? missingAttributeOf(error) : null;
  return Boolean(missing && declares(missing[0], missing[1]));
}

// The HTTP statuses a failure carries along its chain: the `statusCode` of any error (the SDK's ConnectionError, a halt that declares one, a plugin error that records what the service answered) and the status an
// SDK error that wraps a failed publish embeds. Only a status above 0 is one: 0 is the SDK's way to say the request never got an answer.
const statusesOf = (error) => [error.statusCode, embeddedStatus(error)].filter((status) => Number.isInteger(status) && status > 0);

// What the rule above finds in a failure: { never, transient, transientStatus, transport, transientCode, text }. `transient` is the service saying a run again can help — a transient status, a timeout or a reset, or a
// condition it names by its code; `never` the explicit marker, a typed refusal and a permanent status, when nothing transient stands beside them; `text` is the service's own words, empty when none may be read.
// `declares(table, column)` is the caller's (it knows the spec): whether the build creates that column, for the lag of a column that is not visible yet.
function judgeFailure(error, { declares } = {}) {
  const chain = causeChain(error);
  const explicit = chain.some((e) => e.transient === false);
  const statuses = chain.flatMap(statusesOf);
  const transientStatus = statuses.some(isTransientStatus);
  const transport = chain.some(isTransportBlip);
  const transientCode = chain.some((e) => isTransientServiceAnswer(e, declares));
  const transient = transientStatus || transport || transientCode;
  const typed = chain.some(isTypedRefusal);
  // A status the service answered that is not transient is a verdict: no word in its answer can undo it (rule 5).
  const refused = statuses.length > 0 && !transientStatus;
  const found = { transient, transientStatus, transport, transientCode };
  if (explicit || (!transient && typed)) return { never: true, ...found, text: '' };
  if (!transient && refused) {
    // The one verdict that depends on what only the CALLER knows: the answer that says a column is missing, which is the lag of a column the spec creates or an authoring error according to the spec (MISSING_ATTRIBUTE_CODES).
    // A caller that gave no `declares` — a halt raised where no spec is in reach — leaves it open, for the retry check that has the spec; no word of the answer is read either way.
    const open = chain.some((e) => missingAttributeOf(e) !== null);
    return { never: !open, ...found, text: '' };
  }
  if (typed) return { never: false, ...found, text: '' };
  const declared = chain.find((e) => typeof e.retryText === 'string');
  // A failure of the transport has no words to read (rule 4 decided it), and a halt's own message is never read.
  const words = declared ? declared.retryText : chain.filter((e) => !isHalt(e) && !isTransportFailure(e)).map(answerOf).join(' ');
  return { never: false, ...found, text: words };
}

// The policy a halt (or any error) raised around `failure` is given: NEVER when the failure says so, is typed, or carries a status the service answered that no run again can change; SERVICE when it is the
// service's to say. No failure at all is NEVER: the halt is the plugin's own refusal.
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

// What a throttled failure asks of the NEXT send, read along its chain as the rest of the policy reads it: `throttled` (the service answered 429, or an error says what it asked), `askedMs` (the longest wait
// any error of the chain says the service asked: `retryAfterMs`) and `notBefore` (the latest moment, in milliseconds on the clock the error was made on, before which nothing may be sent: `retryNotBefore`).
// The page backend raises such an error when a throttled page write outlasts its sends (lib/genpage-sdk.js, `throttledError`) — the SDK's own error carries no headers, so the ask is what the backend heard where the
// answer passed — and the build's loop, which runs the pages phase again, waits for it instead of its own shorter backoff (build-model-app.js). Only a finite, positive number is an ask.
function throttleAskOf(error) {
  let throttled = false;
  let askedMs = 0;
  let notBefore = 0;
  const positive = (value) => Number.isFinite(value) && value > 0;
  for (const e of causeChain(error)) {
    if (e.statusCode === 429 || embeddedStatus(e) === 429) throttled = true;
    if (positive(e.retryNotBefore)) { throttled = true; notBefore = Math.max(notBefore, e.retryNotBefore); }
    if (positive(e.retryAfterMs)) askedMs = Math.max(askedMs, e.retryAfterMs);
  }
  return { throttled, askedMs, notBefore };
}

module.exports = {
  RETRY, TRANSIENT_STATUSES, TRANSIENT_SERVICE_CODES, TRANSPORT_CODES, isTransientStatus, refusal, neverRetry, serviceFailure, withCause, judgeFailure, retryPolicyFor, retryFrom, throttleAskOf,
};
