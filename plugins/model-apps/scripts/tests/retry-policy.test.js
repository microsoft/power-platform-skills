'use strict';
// lib/retry-policy.js: the build's retry decision, from the STRUCTURE of what failed — an explicit "never", an HTTP status the service answered, a timeout or a
// reset of the transport, the SDK's own typed errors — and, only as a fallback, the service's own words. Never what the maker called anything.
// The halts themselves are held in halt-retry-policy.test.js; this file holds the rule.
const test = require('node:test');
const assert = require('node:assert');
const {
  RETRY, TRANSIENT_STATUSES, TRANSIENT_SERVICE_CODES, isTransientStatus, refusal, serviceFailure, retryFrom, retryPolicyFor, judgeFailure, throttleAskOf,
} = require('../lib/retry-policy.js');
const { BuildHalt } = require('../lib/entity-provision.js');
const { isTransientHalt } = require('../build-model-app.js');
const { SdkError, ConnectionError } = require('../lib/maker-sdk.js');

const LABEL = 'SQL Timeout 503 try again later';
const URL_WITH_LABEL = `https://contoso.crm.dynamics.com/api/data/v9.2/roles?$filter=name eq '${LABEL}'`;
// The SDK's ConnectionError: `HTTP <status> from <url>: <the service's words>`, or `Transport failure reaching <url>: <the transport's words>` for status 0.
function connectionError(statusCode, words, url = URL_WITH_LABEL) {
  const lead = statusCode > 0 ? `HTTP ${statusCode} from ${url}: ` : `Transport failure reaching ${url}: `;
  return Object.assign(new Error(`${lead}${words}`), { code: 'CONNECTION_ERROR', statusCode, url });
}
const typed = (code, message = 'refused') => Object.assign(new Error(message), { code });

test('the statuses a run again can ride out are the throttle and the gateway answers: 429, 502, 503, 504 — and no other', () => {
  assert.deepStrictEqual([...TRANSIENT_STATUSES].sort(), [429, 502, 503, 504]);
  for (const status of [429, 502, 503, 504]) assert.strictEqual(isTransientStatus(status), true, String(status));
  for (const status of [0, 200, 400, 401, 403, 404, 409, 412, 500, 501, undefined, null, '503']) assert.strictEqual(isTransientStatus(status), false, String(status));
});

test('refusal(): an Error that says a run again cannot change it — its message is the maker\'s to read, and nobody\'s to judge', () => {
  const error = refusal(`view "${LABEL}" does not exist`, { code: 'X_MISSING' });
  assert.ok(error instanceof Error);
  assert.strictEqual(error.message, `view "${LABEL}" does not exist`);
  assert.strictEqual(error.transient, false);
  assert.strictEqual(error.code, 'X_MISSING');
  assert.strictEqual(isTransientHalt(error), false);
  assert.strictEqual(isTransientHalt(new Error(error.message)), true, 'the control: the same words in an unmarked error read as transient');
  const cause = new Error('inner');
  assert.strictEqual(refusal('outer', { cause }).cause, cause, 'a cause is kept');
});

test('serviceFailure(): an Error the plugin words around a failure of the service — what it quotes is the plugin\'s, what decides is the status and the service\'s words', () => {
  const error = serviceFailure(`could not read RequiredLevel for ${LABEL}: HTTP 503`, { status: 503, words: 'The service is unavailable.' });
  assert.strictEqual(error.statusCode, 503);
  assert.strictEqual(error.retryText, 'The service is unavailable.');
  assert.strictEqual(isTransientHalt(error), true, 'a 503 is run again');
  const quoted = serviceFailure(`could not read ${LABEL}`, { status: 400, words: 'Bad request' });
  assert.strictEqual(isTransientHalt(quoted), false, 'the label in the message is not read');
  assert.strictEqual(isTransientHalt(serviceFailure('x', { words: 'The service says: try again later.' })), true, 'the service\'s own words are');
  const cause = new Error('inner');
  assert.strictEqual(serviceFailure('x', { cause }).cause, cause);
});

test('judgeFailure: an explicit never wins over everything the failure carries, however deep in the chain it sits', () => {
  const deep = { message: 'outer', cause: { message: 'middle', cause: refusal('inner', { statusCode: 503, retryText: 'try again later' }) } };
  assert.strictEqual(judgeFailure(deep).never, true);
  assert.strictEqual(isTransientHalt(deep), false);
  assert.strictEqual(judgeFailure({ message: 'x', cause: { transient: false, statusCode: 429 } }).never, true, 'the old reading of the error and its cause still holds');
});

test('judgeFailure: the HTTP status decides first — 429, 502, 503 and 504 are transient wherever in the chain the service\'s answer sits', () => {
  for (const status of [429, 502, 503, 504]) {
    assert.strictEqual(isTransientHalt(connectionError(status, 'nothing to read here')), true, `${status} on the error`);
    assert.strictEqual(isTransientHalt({ message: 'wrapper', cause: connectionError(status, 'x') }), true, `${status} on its cause`);
    assert.strictEqual(isTransientHalt({ message: 'wrapper', cause: { message: 'again', cause: { statusCode: status } } }), true, `${status} two levels down`);
  }
  for (const status of [400, 401, 403, 404, 409, 412, 500]) assert.strictEqual(isTransientHalt(connectionError(status, 'nothing to read here')), false, String(status));
  assert.strictEqual(isTransientHalt(Object.assign(typed('APP_COMPONENT_UNREADABLE'), { statusCode: 503 })), true, 'a typed error of the plugin\'s that carries a throttle status is still the service\'s answer');
});

test('judgeFailure: a timeout or a reset of the transport is transient; a transport failure for another reason, and a file error, are not', () => {
  for (const words of ['Request failed: read ECONNRESET', 'Request failed: connect ETIMEDOUT 10.0.0.1:443', 'Request timed out', 'socket hang up', 'Connection closed before the response completed', 'Response aborted before it completed']) {
    assert.strictEqual(isTransientHalt(connectionError(0, words)), true, words);
  }
  assert.strictEqual(isTransientHalt(connectionError(0, 'Request failed: unable to verify the first certificate')), false, 'a certificate is not a blip');
  assert.strictEqual(isTransientHalt(connectionError(0, `Request failed: getaddrinfo ENOTFOUND ${LABEL}`)), false, 'an unknown host is not a blip');
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']) {
    assert.strictEqual(isTransientHalt(typed(code, 'read failed')), true, code);
  }
  for (const code of ['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'ENOSPC', 'EISDIR']) assert.strictEqual(isTransientHalt(typed(code, `${code}: '${LABEL}'`)), false, code);
  // The transport's words are read for a transport failure only: "timeout" in a 500's body is the service's own, and is judged by its own words.
  assert.strictEqual(isTransientHalt(connectionError(500, 'the request timed out')), false);
});

// The HTTP client puts Node's own `code` on the error it throws for a request that failed (lib/sdk-http-client.js), and the SDK keeps that error as the cause of its ConnectionError of status 0 (DataverseClient.send). A certificate that
// does not verify quotes the host and the certificate's names — a name can spell anything, a transport code included — so the words beside a code are not read: the code decides, and the words only when the error carries none.
test('judgeFailure: a failure of the transport is decided by Node\'s own code when the error the transport raised carries one — and by its words, a certificate\'s own phrases first, when it carries none', () => {
  const SAN = "Hostname/IP does not match certificate's altnames: Host: contoso.crm.dynamics.com. is not in the cert's altnames: DNS:ECONNRESET.example.com";
  const raised = (words, code) => {
    const thrown = Object.assign(new Error(`Request failed: ${words}`), code ? { code } : {});
    return new ConnectionError(URL_WITH_LABEL, 0, thrown.message, thrown);
  };
  const verdict = (words, code) => { const j = judgeFailure(raised(words, code)); return { transient: j.transient, never: j.never, transport: j.transport }; };
  const X509 = ['UNABLE_TO_GET_ISSUER_CERT', 'CERT_SIGNATURE_FAILURE', 'CERT_NOT_YET_VALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_REVOKED', 'INVALID_CA', 'CERT_UNTRUSTED', 'HOSTNAME_MISMATCH', 'ERR_TLS_CERT_ALTNAME_INVALID'];
  // The code first: a certificate that does not verify is never run again, whatever its names say.
  for (const code of X509) {
    assert.deepStrictEqual(verdict(SAN, code), { transient: false, never: true, transport: false }, `${code}: final`);
    assert.deepStrictEqual(verdict('read ECONNRESET, socket hang up, timed out', code), { transient: false, never: true, transport: false }, `${code}: whatever the words quote`);
    assert.strictEqual(isTransientHalt(raised(SAN, code)), false, code);
    assert.strictEqual(retryPolicyFor(raised(SAN, code)), RETRY.NEVER, code);
  }
  // A transient code is run again, whatever the words say; another code is final even when the words sound transient.
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN']) {
    assert.deepStrictEqual(verdict('nothing a word list would recognise', code), { transient: true, never: false, transport: true }, code);
    assert.strictEqual(isTransientHalt(raised('nothing a word list would recognise', code)), true, code);
  }
  for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']) {
    assert.strictEqual(verdict('read ECONNRESET, socket hang up, timed out', code).transient, false, `${code}: the code is final, and the words are not read`);
    assert.strictEqual(isTransientHalt(raised('read ECONNRESET', code)), false, code);
  }
  // No code: the words, and a certificate's own phrases before a transient word beside them.
  assert.strictEqual(verdict(SAN).transient, false, 'the names of a certificate that does not verify are not a reset');
  assert.strictEqual(verdict('Hostname/IP does not match certificate\'s altnames: Host: x. is not cert\'s CN: socket hang up').transient, false);
  assert.strictEqual(verdict('unable to verify the first certificate for etimedout.example.com').transient, false);
  assert.strictEqual(verdict('read ECONNRESET').transient, true, 'a reset with no code is a blip by its words, as it always was');
  assert.strictEqual(verdict('connect ETIMEDOUT 10.0.0.1:443').transient, true);
  assert.strictEqual(verdict('Client network socket disconnected before secure TLS connection was established').transient, true, 'the reset in the middle of the TLS handshake is not a certificate');
  assert.strictEqual(isTransientHalt(raised(SAN)), false);
  // The same through the sentence an SDK error wraps around a failed publish, which holds the words and no error to take the code from.
  const publishUrl = 'https://contoso.crm.dynamics.com/api/data/v9.2/PublishXml';
  const wrap = (answer) => new SdkError('ENRICH_DEFAULT_VIEWS_PUBLISH_FAILED', `enrichDefaultViews: 2 view(s) on 'contoso_task' were saved but the publish FAILED, so none of them is live (${answer}). Re-publish the entity to make them visible; the saves themselves are unaffected.`);
  assert.strictEqual(isTransientHalt(wrap(`Transport failure reaching ${publishUrl}: Request failed: ${SAN}`)), false);
  assert.strictEqual(isTransientHalt(wrap(`Transport failure reaching ${publishUrl}: Request failed: read ECONNRESET`)), true);
  // A code on the error that is not the transport's — the one that wraps it — does not make it a failure of the transport.
  assert.strictEqual(judgeFailure(Object.assign(new Error('wrapper'), { cause: raised(SAN, 'ERR_TLS_CERT_ALTNAME_INVALID') })).transient, false);
  assert.strictEqual(judgeFailure(Object.assign(new Error('wrapper'), { cause: raised('read ECONNRESET', 'ECONNRESET') })).transient, true);
});

test('judgeFailure: an error the SDK or the plugin types is a refusal whatever it says — its words are read only when it carries no code', () => {
  for (const code of ['VALIDATION_ERROR', 'VERSION_CONFLICT', 'ARTIFACT_NOT_FOUND', 'ARTIFACT_ALREADY_EXISTS', 'INVALID_ARGUMENT', 'APP_SOURCE_PATH', 'TABLE_METADATA_NOT_VISIBLE']) {
    assert.strictEqual(isTransientHalt(typed(code, `${LABEL}: CustomizationLockException, try again later`)), false, code);
    assert.strictEqual(retryPolicyFor(typed(code)), RETRY.NEVER, code);
  }
  assert.strictEqual(isTransientHalt(new Error(`${LABEL}`)), true, 'an error with no code is read: it may be the service\'s own, as it always was');
  // A halt that wraps a typed error does not make it readable, and a file error under a typed one stays a file error.
  const source = Object.assign(new Error('does not exist or is not a file', { cause: typed('ENOENT', `ENOENT: no such file or directory, lstat '/work/${LABEL}.tsx'`) }), { code: 'APP_SOURCE_PATH' });
  assert.strictEqual(isTransientHalt(source), false);
  assert.strictEqual(isTransientHalt(new BuildHalt('pages failed', { phase: 'pages', code: 'APP_SOURCE_PATH', cause: source })), false);
});

test('judgeFailure: an SDK error that wraps a failed publish is read by the answer it embeds — its code says what failed, not that a run again cannot help', () => {
  // `enrichDefaultViews` (a build without --publish) words a sentence of its own around the publish error it caught and puts that error's message inside, without attaching it as a cause.
  const publishUrl = 'https://contoso.crm.dynamics.com/api/data/v9.2/PublishXml';
  const wrap = (answer, table = 'contoso_task') => new SdkError('ENRICH_DEFAULT_VIEWS_PUBLISH_FAILED', `enrichDefaultViews: 2 view(s) on '${table}' were saved but the publish FAILED, so none of them is live (${answer}). Re-publish the entity to make them visible; the saves themselves are unaffected.`);
  assert.strictEqual(wrap('x').code, 'ENRICH_DEFAULT_VIEWS_PUBLISH_FAILED', 'the bundle\'s own SdkError, typed as the SDK types it');
  for (const status of [429, 502, 503, 504]) assert.strictEqual(isTransientHalt(wrap(`HTTP ${status} from ${publishUrl}: Service Unavailable`)), true, `${status} in the answer it embeds`);
  for (const status of [400, 403, 404, 500]) assert.strictEqual(isTransientHalt(wrap(`HTTP ${status} from ${publishUrl}: Principal user is missing prvPublishCustomization`)), false, `${status}`);
  assert.strictEqual(isTransientHalt(wrap(`HTTP 409 from ${publishUrl}: CustomizationLockException: another solution install is running`)), false, 'a status that says no is final, and the words of an answer that says no are not read');
  assert.strictEqual(isTransientHalt(wrap(`HTTP 429 from ${publishUrl}: CustomizationLockException: another solution install is running`)), true, 'a lock the service answered with a throttle');
  assert.strictEqual(isTransientHalt(wrap(`Transport failure reaching ${publishUrl}: Request failed: read ECONNRESET`)), true, 'a reset');
  assert.strictEqual(isTransientHalt(wrap(`Transport failure reaching ${publishUrl}: Request failed: unable to verify the first certificate`)), false, 'a certificate is not a blip');
  assert.strictEqual(isTransientHalt(wrap(`HTTP 403 from ${publishUrl}: permission denied`, 'contoso_sql_timeout')), false, 'what the sentence quotes is the maker\'s table, and decides nothing');
  assert.strictEqual(retryPolicyFor(wrap(`HTTP 503 from ${publishUrl}: x`)), RETRY.SERVICE);
  const err = wrap(`HTTP 503 from ${publishUrl}: x`);
  assert.strictEqual(isTransientHalt(new BuildHalt(`enrich default views for contoso_task failed: ${err.message}`, { phase: 'views', code: err.code, recoverable: true, cause: err, retry: retryPolicyFor(err) })), true, 'through the halt the runner raises');
  assert.strictEqual(isTransientHalt(new SdkError('VALIDATION_ERROR', `(HTTP 503 from ${publishUrl}: x) ${LABEL}`)), false, 'the exception is for the codes that wrap a failed publish, and no other typed error');
});

// The SDK's sentence around the answer it embeds names the maker's table, and a table's logical name has no space in it — but it can be a single word the rule looks for: `CustomizationLockException` is one
// word, matched without word boundaries and ignoring case, and `contoso_customizationlockexception` is a valid logical name. So the sentence is cut away and only the answer inside it is read, as it is
// where the SDK's own ConnectionError carries it (a status, a url, the service's words).
test('judgeFailure: the sentence around a failed publish is never read — a table whose logical name holds a word of the rule does not turn a 403 into retries — and the status of the answer it embeds is read as the ConnectionError\'s own is', () => {
  const publishUrl = 'https://contoso.crm.dynamics.com/api/data/v9.2/PublishXml';
  const wrap = (answer, table = 'contoso_task') => new SdkError('ENRICH_DEFAULT_VIEWS_PUBLISH_FAILED', `enrichDefaultViews: 2 view(s) on '${table}' were saved but the publish FAILED, so none of them is live (${answer}). Re-publish the entity to make them visible; the saves themselves are unaffected.`);
  const NAMES = ['contoso_customizationlockexception', 'contoso_CustomizationLockException', 'cr1a2_customizationlockexception_log'];
  for (const table of NAMES) {
    // The status decides, and the words of the answer decide nothing: a status that is not transient is final, whatever the answer quotes.
    for (const status of [400, 401, 403, 404, 409, 412, 500, 501]) {
      const failure = wrap(`HTTP ${status} from ${publishUrl}: permission denied`, table);
      assert.strictEqual(isTransientHalt(failure), false, `${status} on ${table}`);
      assert.strictEqual(retryPolicyFor(failure), RETRY.NEVER, `${status}: what the service answered says no, so no run again can change it`);
      assert.strictEqual(judgeFailure(failure).text, '', `${status}: and no word of the sentence, the table or the answer is read`);
    }
    assert.strictEqual(isTransientHalt(wrap(`Transport failure reaching ${publishUrl}: Request failed: unable to verify the first certificate`, table)), false, `a certificate on ${table}`);
    assert.strictEqual(isTransientHalt(new BuildHalt(`enrich default views for ${table} failed`, { phase: 'views', code: 'ENRICH_DEFAULT_VIEWS_PUBLISH_FAILED', recoverable: true, cause: wrap(`HTTP 403 from ${publishUrl}: permission denied`, table), retry: RETRY.SERVICE })), false, `through the halt the runner raises, on ${table}`);
    // The controls: what the service really said is run again, for the same name.
    for (const status of [429, 502, 503, 504]) assert.strictEqual(isTransientHalt(wrap(`HTTP ${status} from ${publishUrl}: Service Unavailable`, table)), true, `${status} on ${table}`);
    assert.strictEqual(isTransientHalt(wrap(`HTTP 429 from ${publishUrl}: CustomizationLockException: another solution install is running`, table)), true, `a lock the service answered with a throttle, on ${table}`);
    assert.strictEqual(isTransientHalt(wrap(`HTTP 500 from ${publishUrl}: CustomizationLockException: another solution install is running`, table)), false, `a lock named only by its words, on a 500, on ${table}`);
    assert.strictEqual(isTransientHalt(wrap(`HTTP 409 from ${publishUrl}: Cannot start the requested operation. Please try again later.`, table)), false, `"try again later", on a 409, on ${table}`);
    assert.strictEqual(isTransientHalt(wrap(`Transport failure reaching ${publishUrl}: Request failed: read ECONNRESET`, table)), true, `a reset on ${table}`);
  }
  // A phrase that is only in what the sentence says around the answer is not the service's: neither the table, nor the sentence's own words about the saves.
  assert.strictEqual(isTransientHalt(wrap(`HTTP 403 from ${publishUrl}: permission denied`, 'try_again_later_log')), false);
  // The url is read no more than the table is.
  assert.strictEqual(isTransientHalt(wrap('HTTP 403 from https://contoso.crm.dynamics.com/api/data/v9.2/CustomizationLockException: permission denied')), false, 'a word of the rule in the url');
  // The words are read for a failure that carries no status, and for nothing else: a transport failure has no words (a reset is decided from its code), a status of 0 is the transport.
  assert.strictEqual(judgeFailure(wrap(`Transport failure reaching ${publishUrl}: Request failed: unable to verify the first certificate`)).text, '', 'no words for a transport failure');
  // FAIL CLOSED: a sentence this code does not recognise — another wording, another shape of the embedded answer — decides nothing it could be wrong about. It is the refusal every typed error is.
  for (const [what, message] of [
    ['another wording of the sentence', `publishing the default views of 'contoso_task' failed (HTTP 503 from ${publishUrl}: Service Unavailable)`],
    ['the sentence without its end', `enrichDefaultViews: 2 view(s) on 'contoso_task' were saved but the publish FAILED, so none of them is live (HTTP 503 from ${publishUrl}: Service Unavailable)`],
    ['an answer that does not open as the SDK opens one', 'enrichDefaultViews: 2 view(s) on \'contoso_task\' were saved but the publish FAILED, so none of them is live (the service said: try again later). Re-publish the entity to make them visible; the saves themselves are unaffected.'],
    ['a table name with a space in it, which is no logical name', `enrichDefaultViews: 2 view(s) on 'SQL timeout' were saved but the publish FAILED, so none of them is live (HTTP 503 from ${publishUrl}: Service Unavailable). Re-publish the entity to make them visible; the saves themselves are unaffected.`],
    ['an url with a space in it, where nothing says where the answer starts', `enrichDefaultViews: 2 view(s) on 'contoso_task' were saved but the publish FAILED, so none of them is live (HTTP 503 from ${publishUrl}?$filter=name eq 'x': Service Unavailable). Re-publish the entity to make them visible; the saves themselves are unaffected.`],
  ]) {
    const failure = new SdkError('ENRICH_DEFAULT_VIEWS_PUBLISH_FAILED', message);
    assert.strictEqual(isTransientHalt(failure), false, what);
    assert.strictEqual(retryPolicyFor(failure), RETRY.NEVER, what);
  }
});

test('judgeFailure: the service\'s words are read only where there is no status — never from where the request went, and never beside a status that says no', () => {
  assert.strictEqual(isTransientHalt(connectionError(500, 'The server is busy', URL_WITH_LABEL)), false, 'SQL Timeout in the url');
  assert.strictEqual(isTransientHalt(connectionError(500, 'Sql error: Generic SQL error. Sql Number: 1205', URL_WITH_LABEL)), false, 'the deadlock signature in a 500 that carries no code is words, and a status that says no is final: a deadlock victim is the generic SQL error code AND the signature (below)');
  assert.strictEqual(isTransientHalt(connectionError(400, 'the answer says: SQL timeout expired', URL_WITH_LABEL)), false, 'SQL timeout in the answer of a 400');
  assert.strictEqual(isTransientHalt(connectionError(409, 'Another solution install is running', URL_WITH_LABEL)), false, 'a lock named by its words, on a 409');
  const mismatched = Object.assign(new Error(`some other lead: ${LABEL}`), { code: 'CONNECTION_ERROR', statusCode: 500, url: URL_WITH_LABEL });
  assert.strictEqual(isTransientHalt(mismatched), false, 'a status says no, whatever the message holds');
  // A failure that carries no status at all has no structure to read, and its words are the fallback, as they always were.
  assert.strictEqual(isTransientHalt(new Error('Sql error: Generic SQL error. Sql Number: 1205')), true);
  assert.strictEqual(isTransientHalt(new Error(`some other lead: ${LABEL}`)), true, 'an error with no status and no code is read whole');
});

test('judgeFailure: a halt\'s own message is never read — only the failure it wraps, and what it declares', () => {
  assert.strictEqual(isTransientHalt(new BuildHalt(`page "${LABEL}" cannot be deployed`, { phase: 'pages', code: 'x' })), false, 'a halt with nothing behind it');
  assert.strictEqual(isTransientHalt(new BuildHalt(`quotes ${LABEL}`, { phase: 'pages', code: 'x', cause: new Error('permanent refusal') })), false);
  assert.strictEqual(isTransientHalt(new BuildHalt(`quotes ${LABEL}`, { phase: 'pages', code: 'x', cause: new Error('The service is unavailable. Please try again later.') })), true, 'the failure it wraps is read');
  assert.strictEqual(isTransientHalt(new BuildHalt('quotes', { phase: 'pages', code: 'x', retry: RETRY.SERVICE, retryText: 'try again later' })), true, 'what a halt declares as the service\'s words is');
  assert.strictEqual(isTransientHalt(new BuildHalt(`quotes ${LABEL}`, { phase: 'pages', code: 'x', retry: RETRY.SERVICE, retryText: 'the service is busy' })), false, 'and the label is not');
  assert.strictEqual(isTransientHalt(new BuildHalt('x', { phase: 'pages', code: 'x', retry: RETRY.NEVER, cause: connectionError(503, 'x') })), false, 'a halt that says never is never run again, a 503 behind it or not');
  const wrapped = new BuildHalt('outer', { phase: 'pages', code: 'x', cause: new BuildHalt(`inner ${LABEL}`, { phase: 'pages', code: 'y', retry: RETRY.NEVER }) });
  assert.strictEqual(isTransientHalt(wrapped), false, 'the runner wraps a halt once: what the first says still holds');
});

test('judgeFailure: what an error declares as the service\'s words is all that is read, and the outermost declaration wins', () => {
  const declared = Object.assign(new Error(`page "${LABEL}" was saved, but publishing it failed`), { retryText: 'PublishXml answered 500: the service is busy' });
  assert.strictEqual(isTransientHalt(declared), false);
  assert.strictEqual(isTransientHalt({ message: `pages failed: ${declared.message}`, cause: declared }), false, 'a wrapper\'s message — the label again — is not read either');
  assert.strictEqual(isTransientHalt(Object.assign(new Error('x'), { retryText: 'Please try again later.' })), true);
  assert.strictEqual(isTransientHalt(Object.assign(new Error('x'), { retryText: '' })), false, 'a refusal with no words says nothing');
  const outer = Object.assign(new Error('x'), { retryText: 'busy', cause: Object.assign(new Error('y'), { retryText: 'try again later' }) });
  assert.strictEqual(isTransientHalt(outer), false, 'the outermost declaration decides');
  assert.strictEqual(isTransientHalt(Object.assign(new Error('x'), { retryText: 'busy', statusCode: 503 })), true, 'a status still counts');
});

test('judgeFailure: the chain is bounded and cycle-safe, and a cause that is not an object (a response body, a string) is not an error to read', () => {
  const a = new Error('a');
  const b = new Error('b', { cause: a });
  a.cause = b;
  assert.doesNotThrow(() => judgeFailure(a));
  assert.strictEqual(isTransientHalt(a), false);
  let long = new Error('end: try again later');
  for (let i = 0; i < 20; i += 1) long = new Error(`link ${i}`, { cause: long });
  assert.doesNotThrow(() => judgeFailure(long));
  assert.strictEqual(isTransientHalt(connectionError(400, 'x')), false);
  const body = Object.assign(connectionError(400, 'bad'), { cause: { code: 'VALIDATION_ERROR', error: { message: 'try again later' } } });
  assert.strictEqual(isTransientHalt(body), false, 'the response body an HTTP error carries as its cause is not read as a second error');
  assert.strictEqual(isTransientHalt(Object.assign(new Error('x'), { cause: 'try again later' })), false, 'a string cause is not an error');
  for (const nothing of [null, undefined, 0, '', false]) assert.strictEqual(isTransientHalt(nothing), false);
  assert.strictEqual(isTransientHalt('try again later'), false, 'a thrown string has no message');
});

test('retryPolicyFor(): never for a failure that says so, for one that is typed, for a status that says no, and for no failure at all; the service\'s to say otherwise', () => {
  assert.strictEqual(retryPolicyFor(undefined), RETRY.NEVER);
  assert.strictEqual(retryPolicyFor(refusal('x')), RETRY.NEVER);
  assert.strictEqual(retryPolicyFor(typed('VALIDATION_ERROR')), RETRY.NEVER);
  assert.strictEqual(retryPolicyFor(typed('EACCES')), RETRY.NEVER);
  assert.strictEqual(retryPolicyFor(connectionError(503, 'x')), RETRY.SERVICE);
  assert.strictEqual(retryPolicyFor(connectionError(403, 'x')), RETRY.NEVER, 'a 403 is the service\'s answer, and it says no: no run again can change it, whatever its words');
  assert.strictEqual(retryPolicyFor(connectionError(0, 'Request failed: read ECONNRESET')), RETRY.SERVICE);
  assert.strictEqual(retryPolicyFor(new Error('try again later')), RETRY.SERVICE);
  assert.strictEqual(retryPolicyFor(Object.assign(typed('APP_X'), { statusCode: 429 })), RETRY.SERVICE, 'a throttle status outranks the type');
});

test('retryFrom(): the options of a halt that wraps a failure — the failure as its cause and the policy its structure gives — or the service\'s words when all there is is a text', () => {
  const failure = connectionError(503, 'x');
  assert.deepStrictEqual(retryFrom(failure), { cause: failure, retry: RETRY.SERVICE });
  const refused = typed('VALIDATION_ERROR');
  assert.deepStrictEqual(retryFrom(refused), { cause: refused, retry: RETRY.NEVER });
  assert.deepStrictEqual(retryFrom(undefined, 'could not read the sitemap: HTTP 503'), { retry: RETRY.SERVICE, retryText: 'could not read the sitemap: HTTP 503' });
  assert.deepStrictEqual(retryFrom('a string is not a failure', 'its words'), { retry: RETRY.SERVICE, retryText: 'its words' });
  assert.deepStrictEqual(retryFrom(undefined), { retry: RETRY.NEVER }, 'no failure and no words: nothing of the service\'s to ask');
  assert.deepStrictEqual(retryFrom(undefined, ''), { retry: RETRY.NEVER });
});

test('BuildHalt: the policy it is raised with is on the halt, never says never twice, and a policy that is not one is refused when the halt is built', () => {
  const never = new BuildHalt('x', { phase: 'p', code: 'c', retry: RETRY.NEVER });
  assert.strictEqual(never.retry, RETRY.NEVER);
  assert.strictEqual(never.transient, false, 'the marker the build\'s retry check has always read');
  const service = new BuildHalt('x', { phase: 'p', code: 'c', retry: RETRY.SERVICE, retryText: 'busy', statusCode: 503 });
  assert.strictEqual(service.retry, RETRY.SERVICE);
  assert.strictEqual(service.transient, undefined);
  assert.strictEqual(service.retryText, 'busy');
  assert.strictEqual(service.statusCode, 503);
  assert.strictEqual(new BuildHalt('x', { phase: 'p', code: 'c' }).retry, undefined, 'a halt raised without one still works: it is judged by the failure it wraps, and its own message is never read');
  assert.throws(() => new BuildHalt('x', { retry: 'maybe' }), /retry policy/);
});

// ── A permanent HTTP status is final, whatever the answer says ──────────────────────────────────────────────────────────────────────────────────────
// The service's answers echo what the maker named: the table in a "does not contain the attribute" answer, the privilege derived from it in a "missing prvRead…" one, the segment of a url in a 404. A table's logical name
// is one word and can be any word — `contoso_customizationlockexception` is a valid one — so a rule that finds a transient-sounding word ANYWHERE in the answer runs a build four times for a 403. The status the service
// answered is the structure; the words are the maker's as much as the service's. These are the SDK's own errors (`ConnectionError`: the status, the url and, as its cause, the answer's body), not stand-ins.
const API = 'https://contoso.crm.dynamics.com/api/data/v9.2';
const answerOf = (status, words, code) => new ConnectionError(`${API}/savedqueries?$select=savedqueryid&$filter=returnedtypecode eq 'contoso_customizationlockexception'`, status, words, { error: { ...(code ? { code } : {}), message: words } });
const ECHOES = [
  ['a privilege named after a table called like a lock', 'Principal user is missing prvReadcontoso_customizationlockexception privilege.'],
  ['a table called like a lock, in an attribute answer', "The entity 'contoso_customizationlockexception' does not contain the specified attribute 'contoso_missing'."],
  ['a segment called like a lock', "Resource not found for the segment 'contoso_customizationlockexceptions'."],
  ['a table called like a throttle', 'Principal user is missing prvReadcontoso_throttled privilege.'],
  ['a column called like a timeout', "Could not find a property named 'contoso_sql_timeout' on type 'contoso_item'."],
  ['a table called like a retry', "The entity 'contoso_try_again_later' does not contain the specified attribute 'contoso_missing'."],
  ['a segment called like a solution install', "Resource not found for the segment 'contoso_another_solution_install'."],
  ['a table called like a concurrent delete', "The entity 'contoso_concurrent_delete' does not contain the specified attribute 'contoso_missing'."],
  ['a display name that reads as a deadlock', "The value 'Sql Number: 1205' is not valid for 'contoso_name'."],
  ['the service\'s own transient words, on a status that says no', 'Cannot start the requested operation because there is another EntityCustomization running at this moment. Please try again later. CustomizationLockException'],
];

test('judgeFailure: a permanent HTTP status is final — whatever the answer holds, a table, a privilege or a column called like a lock, a throttle or a timeout does not run the build again', () => {
  for (const status of [400, 401, 403, 404, 405, 409, 412, 500, 501]) {
    for (const [what, words] of ECHOES) {
      const failure = answerOf(status, words);
      assert.strictEqual(isTransientHalt(failure), false, `${status}, ${what}`);
      assert.strictEqual(isTransientHalt({ message: 'views failed', cause: failure }), false, `${status}, ${what}, behind a halt`);
      assert.strictEqual(retryPolicyFor(failure), RETRY.NEVER, `${status}, ${what}: the policy says so, not only the retry check`);
      assert.deepStrictEqual([judgeFailure(failure).never, judgeFailure(failure).text], [true, ''], `${status}, ${what}: nothing of the answer is read`);
    }
  }
});

test('judgeFailure: a status the SDK reports for an answer it could not use is a permanent status too — and what its message quotes decides nothing', () => {
  const unusable = new ConnectionError(`${API}/$batch`, 200, "atomic write of generative page 'c6082ee7-3c26-4bed-8bea-b10c4241ae67' (12 operation(s)) cannot be confirmed: the change set reported 1 result(s) for 12 operation(s)");
  assert.strictEqual(isTransientHalt(unusable), false);
  const quoting = new ConnectionError(`${API}/contoso_customizationlockexceptions`, 200, "fetchArtifactList contoso_customizationlockexception: paginated read returned a malformed page — expected an OData 'value' array but got a string");
  assert.strictEqual(isTransientHalt(quoting), false, 'the label a caller put in front of the SDK\'s sentence');
  assert.strictEqual(retryPolicyFor(quoting), RETRY.NEVER);
});

test('judgeFailure: the throttle and the gateway answers are still run again — whatever the answer echoes', () => {
  for (const status of [429, 502, 503, 504]) {
    for (const [what, words] of ECHOES) {
      assert.strictEqual(isTransientHalt(answerOf(status, words)), true, `${status}, ${what}`);
      assert.strictEqual(retryPolicyFor(answerOf(status, words)), RETRY.SERVICE, `${status}, ${what}`);
    }
  }
});

// A condition that is the service's to name is named by the CODE it returns — the OData `error.code` of the body the SDK keeps as the cause of its ConnectionError — and by nothing in a message. The codes are the ones the
// platform documents for the conditions the build's retry has always been written for: another customization or solution operation holds the lock (`CustomizationLockEx_*`, `EntityCustomizationLockException`,
// `SolutionConcurrencyFailure`, `RACCannotAcquireCustomizationLock`), SQL gave up waiting (`unManagedidssqltimeouterror`) and a concurrent request on the same record (`*OperationConcurrentRequested`).
// See https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/web-service-error-codes
const TRANSIENT_CODES = [
  ['0x80071151', 'SolutionConcurrencyFailure'], ['0x80071154', 'ConcurrentOperationFailure'], ['0x80090412', 'EntityCustomizationLockException'],
  ['0x8004F061', 'CustomizationLockEx_BothUnknown'], ['0x8004F062', 'CustomizationLockEx_BlockedUnknown'], ['0x8004F063', 'CustomizationLockEx_BothKnownSame'],
  ['0x8004F064', 'CustomizationLockEx_BothKnownDifferent'], ['0x8004F067', 'CustomizationLockEx_BlockingUnknown'], ['0x8004F077', 'RACCannotAcquireCustomizationLock'],
  ['0x80044151', 'unManagedidssqltimeouterror'], ['0x80048105', 'CascadeOperationConcurrentRequested'], ['0x80048116', 'POAOperationConcurrentRequested'],
];

test('judgeFailure: a condition the service names by its error code is run again on any status — the code decides, in any case, and the answer\'s words do not', () => {
  assert.deepStrictEqual([...TRANSIENT_SERVICE_CODES].sort(), TRANSIENT_CODES.map(([code]) => code.toLowerCase()).sort(), 'the table is the list above, and a code is added to both, with the name the platform documents for it');
  for (const [code, name] of TRANSIENT_CODES) {
    for (const status of [400, 409, 412, 500]) {
      for (const spelled of [code, code.toLowerCase(), code.toUpperCase().replace(/^0X/, '0x')]) {
        const failure = answerOf(status, 'nothing a rule could read here', spelled);
        assert.strictEqual(isTransientHalt(failure), true, `${status} ${spelled} (${name})`);
        assert.strictEqual(retryPolicyFor(failure), RETRY.SERVICE, `${status} ${spelled} (${name})`);
      }
    }
  }
  // The same answer's WORDS decide nothing: the code is in `error.code` or it is not there.
  for (const [what, words] of [['the SQL timeout', 'SQL timeout expired.'], ['a lock', 'Cannot start the requested operation [Publish] because there is another [EntityCustomization] running at this moment. Please try again later.'], ['a concurrent delete', 'More than one concurrent Delete requests detected for an Entity contoso_item and ObjectTypeCode 10001.'], ['another solution', 'The solution installation or removal failed due to the installation or removal of another solution at the same time. Please try again later.']]) {
    assert.strictEqual(isTransientHalt(answerOf(500, words)), false, `${what}, no code`);
    assert.strictEqual(isTransientHalt(answerOf(500, words, '0x80044150')), false, `${what}, under the generic SQL error code every SQL failure shares`);
    assert.strictEqual(isTransientHalt(answerOf(403, words, '0x80040220')), false, `${what}, under the code of a missing privilege`);
  }
  // A code that is only MENTIONED — in the message, in a name — is not the code.
  assert.strictEqual(isTransientHalt(answerOf(403, 'Principal user is missing prvRead0x80071151 privilege.', '0x80040220')), false, 'a code in a name');
  assert.strictEqual(isTransientHalt(new ConnectionError(`${API}/x`, 500, '0x80044151', { error: { message: 'SQL timeout expired. 0x80044151' } })), false, 'the answer names a code but holds none');
  // And it is read from the body the SDK kept: a body that is not an OData error, or whose code is not a string, holds none.
  for (const body of ['0x80044151', '<html>0x80044151</html>', null, undefined, { error: 'x' }, { error: { code: 0x80044151 } }, { error: { code: ['0x80044151'] } }, { code: '0x80044151' }]) {
    assert.strictEqual(isTransientHalt(new ConnectionError(`${API}/x`, 500, 'x', body)), false, JSON.stringify(body));
  }
});

// A SQL deadlock victim: SQL chose the request's transaction as the victim of a deadlock and rolled it back, so the idempotent build can run again. Its code is the generic SQL error's, which every SQL failure carries, so what tells it apart
// is its SQL number — and it takes BOTH: the code in the `error.code` of the body, and the number in the service's own answer (the url the SDK opens its message with, which can carry anything a maker named, is not read). The number
// that counts is the LAST one the answer gives: the platform writes its own diagnostic at the end of the message, after the SQL text, and the SQL text can quote what a maker named (a duplicate key quotes the value that collided).
//   {"error":{"code":"0x80044150","message":" Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205"}}
const DEADLOCK_WORDS = ' Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205';
const sqlNumber = (number) => DEADLOCK_WORDS.replace('1205', number);
// The answer to a unique-key violation (2627) or a constraint (547) that quotes the name a maker gave: the name is in front of the platform's own diagnostic.
const quoting = (number, name = 'Sql Number: 1205') => ` Sql error: Violation of UNIQUE KEY constraint 'ndx_name'. Cannot insert duplicate key. The duplicate key value is (${name}). CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: ${number}`;

test('judgeFailure: a SQL deadlock victim — the generic SQL error code and the platform\'s deadlock signature in the service\'s own answer — is run again, and each of them alone, another SQL number, and a url or a name that quotes the signature are final', () => {
  assert.ok(!TRANSIENT_SERVICE_CODES.has('0x80044150'), 'the generic SQL error code is not a transient condition of its own: it is every SQL failure');
  const victim = answerOf(500, DEADLOCK_WORDS, '0x80044150');
  assert.strictEqual(isTransientHalt(victim), true);
  assert.strictEqual(retryPolicyFor(victim), RETRY.SERVICE);
  const judged = judgeFailure(victim);
  assert.deepStrictEqual([judged.transient, judged.transientCode, judged.never], [true, true, false], 'decided by the code and the signature');
  assert.strictEqual(isTransientHalt({ message: 'views failed', cause: victim }), true, 'behind a halt');
  assert.strictEqual(isTransientHalt(new BuildHalt('views failed', { phase: 'views', code: 'x', cause: victim, retry: retryPolicyFor(victim) })), true, 'through the halt the runner raises');
  assert.strictEqual(isTransientHalt(answerOf(500, DEADLOCK_WORDS, '0X80044150')), true, 'the code in either case, as every code is read');
  // The last number is the service's own, so a deadlock is a deadlock whatever the name in front of it quotes, and text after the number does not hide it.
  assert.strictEqual(isTransientHalt(answerOf(500, quoting(1205, 'Sql Number: 547'), '0x80044150')), true, 'a name in front of it that quotes another SQL number');
  assert.strictEqual(isTransientHalt(answerOf(500, quoting(1205), '0x80044150')), true, 'a name in front of it that quotes the deadlock\'s own');
  assert.strictEqual(isTransientHalt(answerOf(500, `${DEADLOCK_WORDS}. Rerun the transaction.`, '0x80044150')), true, 'text after the number');
  // The same answer, one thing short of it.
  for (const [what, failure] of [
    ['the signature and no code', answerOf(500, DEADLOCK_WORDS)],
    ['the signature under the code of a missing privilege', answerOf(500, DEADLOCK_WORDS, '0x80040220')],
    ['the signature under the code of another deadlock answer the platform words differently', answerOf(500, DEADLOCK_WORDS, '0x80040265')],
    ['the code and another SQL number: a constraint', answerOf(500, sqlNumber(547), '0x80044150')],
    ['the code and another SQL number: a lock timeout', answerOf(500, sqlNumber(1222), '0x80044150')],
    ['the code and a number that only starts with the deadlock\'s', answerOf(500, sqlNumber(12050), '0x80044150')],
    ['the code and no SQL number at all', answerOf(500, 'Sql error: Generic SQL error.', '0x80044150')],
    ['the code mentioned in the message, and not in the body', new ConnectionError(`${API}/x`, 500, `0x80044150${DEADLOCK_WORDS}`, { error: { message: `0x80044150${DEADLOCK_WORDS}` } })],
    ['the code mentioned in the message, under another code in the body', answerOf(500, `0x80044150${DEADLOCK_WORDS}`, '0x80040220')],
    ['the signature in a body that is not an OData error', new ConnectionError(`${API}/x`, 500, DEADLOCK_WORDS, DEADLOCK_WORDS)],
    ['the signature in a body whose error is a string', new ConnectionError(`${API}/x`, 500, DEADLOCK_WORDS, { error: DEADLOCK_WORDS })],
    // What a maker named is in the url the SDK echoes: the answer is what follows it.
    ['the code and another SQL number, with the signature in the url', new ConnectionError(`${API}/roles?$filter=name eq 'Sql Number: 1205'`, 500, sqlNumber(547), { error: { code: '0x80044150', message: sqlNumber(547) } })],
    ['the code and no signature, with the signature in the url', new ConnectionError(`${API}/roles?$filter=name eq 'Sql Number: 1205'`, 500, 'Sql error: Generic SQL error.', { error: { code: '0x80044150', message: 'Sql error: Generic SQL error.' } })],
    // What a maker named is ALSO in the service's own message, when the SQL text quotes it: the diagnostic the platform writes after that text is the number that counts.
    ['a unique key (2627) after a name that quotes the deadlock\'s number', answerOf(500, quoting(2627), '0x80044150')],
    ['a constraint (547) after a name that quotes the deadlock\'s number', answerOf(500, quoting(547), '0x80044150')],
    ['a lock timeout (1222) after a name that quotes the deadlock\'s number', answerOf(500, quoting(1222), '0x80044150')],
    ['the deadlock\'s number in front of another one', answerOf(500, `${DEADLOCK_WORDS} (inner: Sql Number: 547)`, '0x80044150')],
  ]) {
    assert.strictEqual(isTransientHalt(failure), false, what);
    assert.strictEqual(retryPolicyFor(failure), RETRY.NEVER, `${what}: a status that says no, and nothing that says otherwise`);
    assert.strictEqual(judgeFailure(failure).transientCode, false, what);
  }
  // A name in what the plugin words around the failure — a halt's message, a declared text — is not read either.
  const refused = answerOf(500, sqlNumber(547), '0x80044150');
  assert.strictEqual(isTransientHalt(new BuildHalt("view 'Sql Number: 1205' could not be saved", { phase: 'views', code: 'x', cause: refused })), false, 'the halt\'s own message');
  assert.strictEqual(isTransientHalt(Object.assign(new Error("view 'Sql Number: 1205' could not be saved"), { cause: refused })), false, 'a wrapper\'s message');
  // Only a failure with no status at all is read by its words, as it always was: that is the fallback this rule does not touch — and it reads the same signature, the last SQL number, so a name in front of another number is not a deadlock there either.
  assert.strictEqual(isTransientHalt(new Error(DEADLOCK_WORDS)), true);
  assert.strictEqual(isTransientHalt(new Error(quoting(1205, 'Sql Number: 547'))), true, 'the words of an error with no status: a deadlock whatever name is in front of it');
  assert.strictEqual(isTransientHalt(new Error(quoting(2627))), false, 'the words of an error with no status: a unique key that quotes the deadlock\'s number is not one');
});

// The build's engine reads some answers with requests of its own (lib/entity-provision.js: a column's length, which table answers to a name, the update of a column by its ids) and words the
// failure itself (statusError, made by serviceFailure). The OData `error` of such an answer rides on that failure (`answered`), and the rule reads it as it reads the body the SDK's
// ConnectionError keeps: its `code`, and — for a deadlock's signature — its own `message`; never the plugin's sentence around it, which quotes what the maker named, and never a code that is
// merely MENTIONED. Raw, and as statusError words it:
//   {"error":{"code":"0x80044151","message":"SQL timeout expired."}}   ->   could not read the column's length (HTTP 500: SQL timeout expired.)
const recordedAnswerOf = (status, words, code, around = 'could not read the column\'s length') => serviceFailure(`${around} (HTTP ${status}: ${words})`, { status, words: `HTTP ${status}: ${words}`, answered: { ...(code ? { code } : {}), message: words } });

test('judgeFailure: an answer the engine read with a request of its own carries its OData code to the rule — a condition the service names by its code is run again on any status, as through the SDK', () => {
  for (const [code, name] of TRANSIENT_CODES) {
    for (const status of [400, 409, 412, 500]) {
      const failure = recordedAnswerOf(status, 'nothing a rule could read here', code);
      assert.strictEqual(isTransientHalt(failure), true, `${status} ${code} (${name})`);
      assert.strictEqual(retryPolicyFor(failure), RETRY.SERVICE, `${status} ${code} (${name})`);
      assert.strictEqual(isTransientHalt(new BuildHalt('data-model failed', { phase: 'data-model', code: 'x', cause: failure, retry: retryPolicyFor(failure) })), true, `${status} ${code} (${name}): through the halt the runner raises`);
    }
  }
  // Behind the wrapper a step puts around it (alignPrimaryNameLength: "asked 120, the platform made 850: …"), as a step's failure reaches the build.
  const step = serviceFailure('asked 120, the platform made 850: the update of the column was refused (HTTP 500: SQL timeout expired.)', { cause: recordedAnswerOf(500, 'SQL timeout expired.', '0x80044151', 'the update of the column was refused') });
  assert.strictEqual(isTransientHalt(step), true, 'behind the step\'s own wrapper');
  // Everything else of the rule is as it was: a status that says no, with no such code, is final whatever the answer's words or the plugin's sentence say.
  for (const [what, failure] of [
    ['the SQL timeout in words, under another code', recordedAnswerOf(500, 'SQL timeout expired.', '0x80040216')],
    ['the SQL timeout in words, and no code', recordedAnswerOf(500, 'SQL timeout expired.')],
    ['a code merely named in the answer\'s message, under another code', recordedAnswerOf(500, 'An unexpected error occurred (0x80044151). Please try again later.', '0x80040216')],
    ['a 400 under a code that names no condition', recordedAnswerOf(400, 'The attribute cannot be changed right now. Please try again later.', '0x80040203')],
    ['a transient code named in the plugin\'s own sentence, not in the answer', serviceFailure('could not read 0x80044151 (HTTP 500: An unexpected error occurred.)', { status: 500, words: 'HTTP 500: An unexpected error occurred.', answered: { code: '0x80040216', message: 'An unexpected error occurred.' } })],
  ]) {
    assert.strictEqual(isTransientHalt(failure), false, what);
    assert.strictEqual(retryPolicyFor(failure), RETRY.NEVER, what);
  }
  // Only an object is an answer's error, and only a string `code` in it is a code: anything else records nothing.
  for (const answered of ['0x80044151', ['0x80044151'], [{ code: '0x80044151' }], null, undefined, 42, { code: 0x80044151 }, { code: ['0x80044151'] }, { message: '0x80044151' }]) {
    const failure = serviceFailure('could not read the column\'s length (HTTP 500: x)', { status: 500, words: 'HTTP 500: x', answered });
    assert.strictEqual(isTransientHalt(failure), false, JSON.stringify(answered));
  }
  // An explicit never still wins over the code it carries, here as everywhere.
  assert.strictEqual(isTransientHalt(Object.assign(recordedAnswerOf(500, 'SQL timeout expired.', '0x80044151'), { transient: false })), false, 'an explicit never on it');
  assert.strictEqual(isTransientHalt(refusal('the spec says no', { cause: recordedAnswerOf(500, 'SQL timeout expired.', '0x80044151') })), false, 'a refusal around it');
  // What is recorded is not one of the error's own enumerable properties: the error prints, serializes and compares as it did.
  const recorded = recordedAnswerOf(409, 'locked', '0x8004F064');
  assert.deepStrictEqual(Object.keys(recorded).sort(), ['retryText', 'statusCode']);
  assert.ok(!JSON.stringify(recorded).includes('0x8004F064'));
});

test('judgeFailure: a SQL deadlock victim in an answer the engine read itself is read from that answer — its code and its own message — and never from the plugin\'s sentence around it', () => {
  const victim = recordedAnswerOf(500, DEADLOCK_WORDS, '0x80044150');
  assert.strictEqual(isTransientHalt(victim), true);
  assert.strictEqual(retryPolicyFor(victim), RETRY.SERVICE);
  assert.strictEqual(isTransientHalt(recordedAnswerOf(500, quoting(1205, 'Sql Number: 547'), '0x80044150')), true, 'a name in front of it that quotes another SQL number');
  for (const [what, failure] of [
    ['a unique key (2627) after a name that quotes the deadlock\'s number', recordedAnswerOf(500, quoting(2627), '0x80044150')],
    ['the code and another SQL number', recordedAnswerOf(500, sqlNumber(547), '0x80044150')],
    ['the signature under another code', recordedAnswerOf(500, DEADLOCK_WORDS, '0x80040220')],
    ['the signature and no code', recordedAnswerOf(500, DEADLOCK_WORDS)],
    // The plugin's sentence goes on after the answer, and what it quotes there — a maker's column — can spell the signature: the answer is what is read.
    ['a unique key, in a sentence that quotes a column spelled like the signature after the answer', serviceFailure(`the update of the column was refused (HTTP 500: ${quoting(2627)}) for column 'Sql Number: 1205'`, { status: 500, words: `HTTP 500: ${quoting(2627)}`, answered: { code: '0x80044150', message: quoting(2627) } })],
  ]) {
    assert.strictEqual(isTransientHalt(failure), false, what);
    assert.strictEqual(retryPolicyFor(failure), RETRY.NEVER, what);
  }
  // And the other way round: an answer that is a deadlock victim is one, whatever the sentence around it quotes after it.
  const quotedAfter = serviceFailure(`the update of the column was refused (HTTP 500: ${DEADLOCK_WORDS}) for column 'Sql Number: 547'`, { status: 500, words: `HTTP 500: ${DEADLOCK_WORDS}`, answered: { code: '0x80044150', message: DEADLOCK_WORDS } });
  assert.strictEqual(isTransientHalt(quotedAfter), true, 'the plugin\'s words after the answer do not hide it');
});

test('judgeFailure: a failure that carries no HTTP status at all is still judged by the service\'s own words — the fallback is for what has no structure', () => {
  assert.strictEqual(isTransientHalt(new Error('The service says: try again later.')), true);
  assert.strictEqual(isTransientHalt(Object.assign(new Error('x'), { retryText: 'SQL timeout expired.' })), true);
  assert.strictEqual(isTransientHalt(Object.assign(new Error('x'), { retryText: 'SQL timeout expired.', statusCode: 400 })), false, 'a status the service answered decides, whatever words the plugin declares beside it');
  assert.strictEqual(isTransientHalt(serviceFailure('could not read RequiredLevel', { status: 500, words: 'CustomizationLockException: try again later' })), false);
  assert.strictEqual(isTransientHalt(serviceFailure('could not read RequiredLevel', { status: 503, words: 'x' })), true);
});

// ── What a throttled failure asks of the next send ──────────────────────────────────────────────────────────────────────────────────────────────────
// The page backend sends a throttled page write again up to six times; when that is not enough it raises an error that carries what the last answer asked (`retryAfterMs`) and the moment before which nothing may be sent
// (`retryNotBefore`, on the clock the backend works to), so the layer that runs the build again waits for it instead of its own, shorter, backoff. This reads them along the chain, as the rest of the policy does.
test('throttleAskOf: what a throttled failure asks of the next send — the longest ask and the latest not-before along its causes — and whether it is a throttle at all', () => {
  const NOW = 1800000000000;
  const asked = Object.assign(new Error('the service throttled all 6 sends'), { retryAfterMs: 7000, retryNotBefore: NOW + 7000, cause: connectionError(429, 'Too many requests.') });
  assert.deepStrictEqual(throttleAskOf(asked), { throttled: true, askedMs: 7000, notBefore: NOW + 7000 });
  assert.deepStrictEqual(throttleAskOf({ message: 'pages failed', cause: asked }), { throttled: true, askedMs: 7000, notBefore: NOW + 7000 }, 'behind the halt the runner raises');
  const two = Object.assign(new Error('outer'), { retryAfterMs: 3000, retryNotBefore: NOW + 9000, cause: Object.assign(new Error('inner'), { retryAfterMs: 5000, retryNotBefore: NOW + 5000 }) });
  assert.deepStrictEqual(throttleAskOf(two), { throttled: true, askedMs: 5000, notBefore: NOW + 9000 }, 'the longest ask, and the latest moment');
  assert.deepStrictEqual(throttleAskOf(connectionError(429, 'x')), { throttled: true, askedMs: 0, notBefore: 0 }, 'a throttle that asked for nothing is still a throttle');
  assert.deepStrictEqual(throttleAskOf(Object.assign(typed('APP_COMPONENT_UNREADABLE'), { statusCode: 429 })), { throttled: true, askedMs: 0, notBefore: 0 });
  for (const status of [0, 400, 403, 500, 502, 503, 504]) assert.deepStrictEqual(throttleAskOf(connectionError(status, 'x')), { throttled: false, askedMs: 0, notBefore: 0 }, `${status} is not a throttle`);
  for (const junk of [undefined, null, 'x', 7, {}, { retryNotBefore: 'soon' }, { retryNotBefore: Infinity }, { retryNotBefore: Number.NaN }, { retryAfterMs: -5 }, { retryAfterMs: '7000' }]) {
    assert.deepStrictEqual(throttleAskOf(junk), { throttled: false, askedMs: 0, notBefore: 0 }, String(junk));
  }
});
