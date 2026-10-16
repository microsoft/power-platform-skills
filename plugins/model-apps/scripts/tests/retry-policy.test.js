'use strict';
// lib/retry-policy.js: the build's retry decision, from the STRUCTURE of what failed — an explicit "never", an HTTP status the service answered, a timeout or a
// reset of the transport, the SDK's own typed errors — and, only as a fallback, the service's own words. Never what the maker called anything.
// The halts themselves are held in halt-retry-policy.test.js; this file holds the rule.
const test = require('node:test');
const assert = require('node:assert');
const {
  RETRY, TRANSIENT_STATUSES, isTransientStatus, refusal, serviceFailure, retryFrom, retryPolicyFor, judgeFailure,
} = require('../lib/retry-policy.js');
const { BuildHalt } = require('../lib/entity-provision.js');
const { isTransientHalt } = require('../build-model-app.js');
const { SdkError } = require('../lib/maker-sdk.js');

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
  assert.strictEqual(isTransientHalt(wrap(`HTTP 409 from ${publishUrl}: CustomizationLockException: another solution install is running`)), true, 'a lock, in the service\'s words');
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
test('judgeFailure: the sentence around a failed publish is never read — a table whose logical name holds a word of the rule does not turn a 403 into retries — and the answer it embeds is read as the ConnectionError it came from', () => {
  const publishUrl = 'https://contoso.crm.dynamics.com/api/data/v9.2/PublishXml';
  const wrap = (answer, table = 'contoso_task') => new SdkError('ENRICH_DEFAULT_VIEWS_PUBLISH_FAILED', `enrichDefaultViews: 2 view(s) on '${table}' were saved but the publish FAILED, so none of them is live (${answer}). Re-publish the entity to make them visible; the saves themselves are unaffected.`);
  const NAMES = ['contoso_customizationlockexception', 'contoso_CustomizationLockException', 'cr1a2_customizationlockexception_log'];
  for (const table of NAMES) {
    // The status decides first, and the service's words are the answer's: "permission denied" has no word of the rule, so no status but the throttle and the gateway's is run again.
    for (const status of [400, 401, 403, 404, 409, 412, 500, 501]) {
      const failure = wrap(`HTTP ${status} from ${publishUrl}: permission denied`, table);
      assert.strictEqual(isTransientHalt(failure), false, `${status} on ${table}`);
      assert.strictEqual(retryPolicyFor(failure), RETRY.SERVICE, `${status}: it is the service's to say, and what it said is not transient`);
      assert.strictEqual(judgeFailure(failure).text, 'permission denied', `${status}: the words read are the answer's, and nothing else of the sentence`);
    }
    assert.strictEqual(isTransientHalt(wrap(`Transport failure reaching ${publishUrl}: Request failed: unable to verify the first certificate`, table)), false, `a certificate on ${table}`);
    assert.strictEqual(isTransientHalt(new BuildHalt(`enrich default views for ${table} failed`, { phase: 'views', code: 'ENRICH_DEFAULT_VIEWS_PUBLISH_FAILED', recoverable: true, cause: wrap(`HTTP 403 from ${publishUrl}: permission denied`, table), retry: RETRY.SERVICE })), false, `through the halt the runner raises, on ${table}`);
    // The controls: what the service really said is run again, for the same name.
    for (const status of [429, 502, 503, 504]) assert.strictEqual(isTransientHalt(wrap(`HTTP ${status} from ${publishUrl}: Service Unavailable`, table)), true, `${status} on ${table}`);
    assert.strictEqual(isTransientHalt(wrap(`HTTP 500 from ${publishUrl}: CustomizationLockException: another solution install is running`, table)), true, `a lock, in the answer, on ${table}`);
    assert.strictEqual(isTransientHalt(wrap(`HTTP 409 from ${publishUrl}: Cannot start the requested operation. Please try again later.`, table)), true, `"try again later", in the answer, on ${table}`);
    assert.strictEqual(isTransientHalt(wrap(`Transport failure reaching ${publishUrl}: Request failed: read ECONNRESET`, table)), true, `a reset on ${table}`);
  }
  // A phrase that is only in what the sentence says around the answer is not the service's: neither the table, nor the sentence's own words about the saves.
  assert.strictEqual(isTransientHalt(wrap(`HTTP 403 from ${publishUrl}: permission denied`, 'try_again_later_log')), false);
  // The url is read no more than the table is: only what follows it is the answer.
  assert.strictEqual(isTransientHalt(wrap('HTTP 403 from https://contoso.crm.dynamics.com/api/data/v9.2/CustomizationLockException: permission denied')), false, 'a word of the rule in the url');
  assert.strictEqual(judgeFailure(wrap(`HTTP 403 from ${publishUrl}: permission denied: please contact your admin`)).text, 'permission denied: please contact your admin', 'the answer is whatever follows the first ": " after the url — its own colons are its own');
  assert.strictEqual(judgeFailure(wrap(`HTTP 403 from ${publishUrl}: an answer that quotes (Re-publish the entity). Re-publish the entity to make them visible; the saves themselves are unaffected.`)).text, 'an answer that quotes (Re-publish the entity). Re-publish the entity to make them visible; the saves themselves are unaffected.', 'the sentence ends where the SDK ends it, so an answer that repeats its words is read whole');
  // The words are read for a status the service answered and for nothing else: a transport failure has no words (a reset is decided from its code), a status of 0 is the transport.
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

test('judgeFailure: the service\'s words are read from the answer, never from where the request went — the url holds what the maker named', () => {
  assert.strictEqual(isTransientHalt(connectionError(500, 'The server is busy', URL_WITH_LABEL)), false, 'SQL Timeout in the url');
  assert.strictEqual(isTransientHalt(connectionError(500, 'Sql error: Generic SQL error. Sql Number: 1205', URL_WITH_LABEL)), true, 'a deadlock victim, in the answer');
  assert.strictEqual(isTransientHalt(connectionError(400, 'the answer says: SQL timeout expired', URL_WITH_LABEL)), true, 'SQL timeout in the answer');
  assert.strictEqual(isTransientHalt(connectionError(409, 'Another solution install is running', URL_WITH_LABEL)), true, 'a lock, in the answer');
  const mismatched = Object.assign(new Error(`some other lead: ${LABEL}`), { code: 'CONNECTION_ERROR', statusCode: 500, url: URL_WITH_LABEL });
  assert.strictEqual(isTransientHalt(mismatched), true, 'a message that does not open the way the SDK opens it is read whole: nothing proves what is the url');
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

test('retryPolicyFor(): never for a failure that says so, for one that is typed, and for no failure at all; the service\'s to say otherwise', () => {
  assert.strictEqual(retryPolicyFor(undefined), RETRY.NEVER);
  assert.strictEqual(retryPolicyFor(refusal('x')), RETRY.NEVER);
  assert.strictEqual(retryPolicyFor(typed('VALIDATION_ERROR')), RETRY.NEVER);
  assert.strictEqual(retryPolicyFor(typed('EACCES')), RETRY.NEVER);
  assert.strictEqual(retryPolicyFor(connectionError(503, 'x')), RETRY.SERVICE);
  assert.strictEqual(retryPolicyFor(connectionError(403, 'x')), RETRY.SERVICE, 'a 403 is the service\'s answer: its words are read, and they decide');
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
