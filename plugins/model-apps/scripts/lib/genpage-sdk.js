'use strict';
// Generative pages through the bundled SDK: the plugin's one page backend (it replaced the `pac model genpage` wrapper).
//
//   const genpage = makeGenpageSdk(env, deps);
//   genpage.enumerateEnv()                  every page of the environment, drafts included  -> { ok, ids, pages: [{ pageId, name }], error }
//   genpage.enumeratePages(appId, options)  the pages an app's navigation names             -> { ok, pages: [{ pageId, name }], empty, error }
//   genpage.read(pageId)                    one page as the SDK projects it                  -> { id, name, source, dataSources, model, … }
//   genpage.create(args)                    mint an id (or take one), write, publish, prove  -> { pageId, name, publish, fingerprint, runtimeSha256?, warnings }
//   genpage.update(pageId, args)            write only what differs, publish, prove          -> { pageId, unchanged?, publish, fingerprint, runtimeSha256?, warnings }
//   genpage.placeInApp(appId, options)      pages into an app's navigation + their tables' default views into its components (and nothing else of the app's components)
//   genpage.removeFromApp(appId, pageId, options)  a page's sub-area out of an app's navigation (the page itself stays; no component of the app is added)
//   genpage.describe(pageId)                one page's identity and size, without needing a source -> { pageId, name, editable, dataSources, fileRows, conversationMessages }
//   genpage.delete(pageId)                  delete a page and its conversation history — refused while any app's navigation names it
//   genpage.runtimeTypes(dataSources, options)  the RuntimeTypes text a page is authored against   -> a string
//   genpage.defaultViews(tables)            the default public view of each table                  -> { views: [{ table, viewId }], warnings }
//   genpage.baseLanguage()                  the environment's base language (an LCID)
//   genpage.solutionTarget(uniqueName)      the solution a page is to join, read before the page is written -> { uniqueName, systemSolution, componentType? }
//   genpage.addToSolution(pageId, target)   the page (and its file rows) into that solution                 -> { added }
//   genpage.fileVersions(pageIds)           the versionnumber of every file row of each page, from one plain read -> { ok, versions: Map<pageId, Map<fileRowId, version> | null>, error }
//   genpage.projectVersions(pageIds)        the versionnumber of each page's own row, from one plain read          -> { ok, versions: Map<pageId, version | null>, error }
//   genpage.publishedDiffers(pageId, args, expected)  what a page's PUBLISHED copy differs from `args` (and its compiled output from `expected.runtimeSha256`) in, read back with plain reads -> { ok, differing: [field…], fingerprint, error }
//   genpage.dispose({ waitMs })             close the backend and remove its throwaway workspaces -> a promise of { left } (await it before the process ends)
//   genpage.discardWorkspaces({ waitMs })   the same for the workspaces made so far, leaving the backend open for the next operation
//
// The SDK is made through lib/maker-sdk.js — which carries the vendored page compiler — on a THROWAWAY workspace folder that dispose()
// removes: a page is read from the server at the start of every operation (`fetchArtifact(…, { overwrite: true })`), so nothing in
// a workspace could answer it, and a copy left holding an unpushed edit by an operation that failed could only get in the way of the
// next. `deps.sdk` is a seam: a caller that already holds an SDK on its own throwaway workspace (verify, download) lends it, and
// dispose() then removes nothing; tests lend a fake.
//
// WHY the write paths settle an unknown outcome by READING THE PAGE (create and update below): a page is written as ONE atomic
// change set (project, rows and conversation turn commit together or not at all), so an answer that never arrived — a reset, a
// timeout — leaves exactly two states, "landed" and "nothing written", and the page itself says which. That was measured on a live
// org: one create's `$batch` got ECONNRESET after the server had committed it. pac wrote a page in steps under a server-minted id,
// which is why it needed an environment-wide id diff, candidates and advice to look for the page; here the id is minted by the
// caller, so reading it is the whole answer — but only about the send that was read for. A send that got no usable answer is still in
// flight as far as anything here can tell, and can land after a read that found nothing, so an operation says "nothing was written"
// only when every send it made is accounted for (see `open` in create and the loop in update).
const crypto = require('node:crypto');
const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const { genPageSubArea, genPageSubAreaId } = require('./genpage-subarea.js');
const { guardWorkspaceStorage } = require('./workspace-storage-guard.js');
const { makeAppComponentScope } = require('./app-component-scope.js');
const { makeTempWorkspace } = require('./temp-workspace.js');
const { sha256 } = require('./hash.js');
const { withCause } = require('./retry-policy.js');
const { makeThrottleBudget, waitDoesNotFit, spentNote } = require('./throttle-budget.js');
const { mergeBindings } = require('./page-bindings.js');
const { isRestrictedSolution } = require('./system-solutions.js');
const { readTargetSolution, readPageComponentType, pageComponent } = require('./page-solution.js');
const { asPageNestingRefusal } = require('./page-nesting.js');

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// How many pages one read of their files' versions asks for: the pages are named in the query's filter, so this keeps the request line short however many pages an app has.
const PAGE_VERSION_CHUNK = 50;

// The provenance texts a page's first turn carries when the caller supplied none — the ones this plugin has always recorded.
const DEFAULT_AGENT_MESSAGE = 'Authored by app-builder';

// pac stores every ASCII `"` in a page name as `\"` — in the page's row and in a navigation title it writes (live-measured:
// `Say "hi" now` became `Say \"hi\" now` in both) — and changes nothing else. This is the inverse: the name pac was given.
// Pages pac created exist on every environment that used an earlier release, so a name read from one is read back through this;
// the SDK stores a name exactly, so nothing is ever written escaped, and sent back as it is a name read this way would not gain a
// backslash on every upload.
function unescapePacName(name) {
  return String(name).replace(/\\"/g, '"');
}

// A provenance value the caller SUPPLIED but left blank. `undefined`/`null` mean "not supplied", and a default then applies
// legitimately. A present-but-blank value is different: the caller asked for THAT text, so substituting generated provenance
// deploys words nobody wrote. Whitespace-, newline- and BOM-only files are the realistic ways an empty value arrives.
function suppliedButBlank(value) {
  return value !== undefined && value !== null && !String(value).trim();
}

// An error that must never be answered by trying again. The build re-runs a whole phase when a failure looks transient (isTransientHalt in build-model-app.js, by the rule of lib/retry-policy.js), and an error that says
// `transient: false` — on itself or anywhere along its causes — is never run again, whatever its text quotes (the page's name is the maker's: "SQL Timeouts", "Concurrent Deletes"). So every error a page write raises says
// so. A write that failed for a known reason would only fail again, and one whose outcome is not
// known must not be sent by a re-run that does not know it: a create would mint a second page beside the first one if it landed,
// and an update could record its turn twice. The one write that is NOT final is a throttle that outlasted every wait (throttledError): nothing was written, and the service's load is not the maker's to fix.
function genpageError(message, props = {}) {
  const { cause, ...rest } = props;
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { transient: false }, rest);
}

// The error of a write the service REFUSED with a throttle every time it was sent, or whose next wait did not fit what is left of the run's budget — the one page-write error that does not say `transient: false`. Nothing was
// written: a request the service declines to start commits nothing, and the page's id (a create) and the turn's identity (an update) were fixed before the first send, so a run again sends the same page, never a second one.
// What refused it is the service's load, which a run again a little later may find lifted, so the build is left to read the failure itself — the status 429 it carries, and the SDK's own error kept as the cause
// (lib/retry-policy.js) — and run the phase again, as it does for every failure that is the service's to say. What the last answer ASKED travels with it — `retryAfterMs`, and `retryNotBefore`, the moment on the backend's
// clock before which nothing may be sent — so the layer that runs the build again waits for that and not for its own, shorter, backoff (build-model-app.js, via throttleAskOf).
function throttledError(message, props = {}) {
  const { cause, ...rest } = props;
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), rest);
}

const messageOf = (error) => String((error && error.message) || error);

// The table an SDK failure says is not there, or null when it does not say so. The SDK reads each table's own metadata first and names the table in the request that fails:
//   HTTP 404 from https://contoso.crm.dynamics.com/api/data/v9.0/EntityDefinitions(LogicalName='nosuchtable')?$select=LogicalName%2CSchemaName%2C…&$expand=Attributes(…): Could not find entity nosuchtable
// The error carries `code` CONNECTION_ERROR, `statusCode` 404 and `url`, the request's, and that is what is read — never the message, which is the platform's own words and changes with its version. Only a 404 of the
// table's OWN read — the URL ends at `(LogicalName='<table>')`, before any query string — for a table that was ASKED for means the table is not there: a 404 from a request below it
// (`…(LogicalName='account')/Attributes/…`), from another path, or for a table nobody asked for (one a lookup column points at) is something else — a column read that raced a change, a proxy, a table the caller
// cannot see — and is left as the SDK's own error, as is any other status.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query-metadata-web-api (a table's definition is read at EntityDefinitions(LogicalName='…'))
// The lookup discovery (lib/lookup-metadata.js) tells a missing table with it too: GENPAGE_TABLE_NOT_FOUND here, LOOKUP_TABLE_NOT_FOUND there.
function missingTableOf(error, askedFor) {
  if (!error || error.statusCode !== 404 || typeof error.url !== 'string') return null;
  const named = /\/EntityDefinitions\(LogicalName='([A-Za-z0-9_]+)'\)(?:\?|$)/.exec(error.url);
  const table = named ? named[1].toLowerCase() : null;
  return table !== null && askedFor.includes(table) ? table : null;
}
// The SDK's own code of a failure, for a result that reports the failure by value: the listings never throw, and a caller that prints the failure says which kind it was.
const codeOf = (error) => (error && typeof error.code === 'string' && error.code ? { code: error.code } : {});

// The typed SdkErrors a page push raises BEFORE it sends a write request — the only errors that PROVE a failed send wrote nothing. Read in the
// vendored SDK (src/MakerSdk.ts `prepareArtifactUnlocked`, src/api/GenPageApi.ts `create`/`update` ahead of their change set,
// src/adapters/GenPageAdapter.ts `toApiPayload`, src/adapters/genPageCompiler.ts):
//   VALIDATION_ERROR                  the page failed the adapter's checks or its compile: a syntax error, a data source that does not
//                                     resolve, a module that does not satisfy the page contract
//   GENPAGE_COMPILER_UNAVAILABLE / _VERSION / _INVALID, GENPAGE_RUNTIME_TYPES_INVALID
//                                     no usable TypeScript compiler, or the page's RuntimeTypes could not be built
//   PAGE_NESTING_TOO_DEEP             the page's elements nest so deeply that the compiler ran out of stack space (lib/page-nesting.js raises it from the
//                                     compiler the SDK is given; the SDK compiles ahead of every write, so a push that raises it wrote nothing to the
//                                     service, though its metadata reads may already have been made)
//   GENPAGE_COMPILE_DEPTH_EXCEEDED    the SDK's own refusal of the same page, from a stage of its compile the guard above does not wrap; pushOnce reports it
//                                     as PAGE_NESTING_TOO_DEEP (lib/page-nesting.js, asPageNestingRefusal), and it is listed here so the proof never depends on that
//   GENPAGE_CONTENT_WRITE_UNSUPPORTED, GENPAGE_TURN_NOT_ATOMIC
//                                     the transport cannot write this page as one change set (assertContentWritable / assertTurnWritable)
//   GENPAGE_TURN_CONFLICT             the pending turn's id is already recorded as a different message (`unrecordedTurn`, a read)
//   GENPAGE_RETAIN_ON_CREATE, GENPAGE_RETAINED_ROW_MISSING, GENPAGE_CONTENT_NOT_TEXT, GENPAGE_WRITE_UNKNOWN
//                                     the write plan could not be made (`planWrites`, `changeSetOp`)
//   ARTIFACT_NOT_FOUND, ARTIFACT_LANGUAGE_MISMATCH, ARTIFACT_PROJECTION_STALE
//                                     the workspace copy cannot be pushed (prepare)
// A code that is not here is NOT proof. Filesystem errors have string codes too (`ENOSPC`, `EACCES`), and the SDK raises one when it
// persists its workspace AFTER the server committed the change set — so "has a string code" never means "wrote nothing"; the code has to
// be one of these, on an SdkError.
const PRE_WRITE_REFUSALS = new Set([
  'VALIDATION_ERROR',
  'GENPAGE_COMPILER_UNAVAILABLE', 'GENPAGE_COMPILER_VERSION', 'GENPAGE_COMPILER_INVALID', 'GENPAGE_RUNTIME_TYPES_INVALID', 'PAGE_NESTING_TOO_DEEP', 'GENPAGE_COMPILE_DEPTH_EXCEEDED',
  'GENPAGE_CONTENT_WRITE_UNSUPPORTED', 'GENPAGE_TURN_NOT_ATOMIC', 'GENPAGE_TURN_CONFLICT',
  'GENPAGE_RETAIN_ON_CREATE', 'GENPAGE_RETAINED_ROW_MISSING', 'GENPAGE_CONTENT_NOT_TEXT', 'GENPAGE_WRITE_UNKNOWN',
  'ARTIFACT_NOT_FOUND', 'ARTIFACT_LANGUAGE_MISMATCH', 'ARTIFACT_PROJECTION_STALE',
]);

// A typed error of the SDK itself. The class is the bundle's own (through lib/maker-sdk.js, which every script makes its SDK by), loaded
// when the first error is classified so a caller that never has one never parses the bundle for it.
function isSdkError(error) {
  const { SdkError } = require('./maker-sdk.js');
  return error instanceof SdkError;
}

// What a failed SDK send says it did to the page — about THIS send only. What the operation as a whole did also depends on the sends
// before it (see `earlier` in create and update): a refused resend proves nothing about an earlier send that is still in flight.
//   'nothing'  this send cannot have committed: the SDK refused before it sent a write request (PRE_WRITE_REFUSALS), or the server
//              answered it with a 4xx — a client error means the request was rejected, and a change set is atomic, so a rejected one
//              leaves nothing behind.
//   'unknown'  it may have committed: the connection failed (`CONNECTION_ERROR`, statusCode 0 — the plugin's HTTP client never re-sends
//              a `$batch`), the answer was a 5xx from something between us and the service (502/503/504 are written by the
//              intermediary, not by the service), the SDK could not read the answer (statusCode 200 from a `$batch` whose parts it
//              could not account for: "cannot be confirmed"), or the error is anything else at or after the send — a local failure
//              after the server answered (the workspace is persisted once the change set has committed), a token that could not be had.
function writeOutcome(error) {
  if (!isSdkError(error)) return 'unknown';
  if (error.code === 'CONNECTION_ERROR') {
    const status = error.statusCode;
    return Number.isInteger(status) && status >= 400 && status < 500 ? 'nothing' : 'unknown';
  }
  return PRE_WRITE_REFUSALS.has(error.code) ? 'nothing' : 'unknown';
}

// A push's failure as the maker is told it: the SDK's own refusal of a page too deep to compile is the plugin's PAGE_NESTING_TOO_DEEP, with the plugin's instruction
// ("split the page into components"), so the maker sees one refusal whichever layer caught the overflow (lib/page-nesting.js). Only the SDK's typed error is translated.
function nestingRefusalOf(error) {
  if (!isSdkError(error)) return error;
  const { SdkError } = require('./maker-sdk.js');
  return asPageNestingRefusal(error, (code, message) => new SdkError(code, message));
}

// A send the service refused with a throttle: the SDK's typed `ConnectionError` with status 429, read from its structure and never from its words. Dataverse's service protection limits answer a request they will not
// START this way (HTTP 429, with a `Retry-After`), so no part of the change set ran.
// See: https://learn.microsoft.com/power-apps/developer/data-platform/api-limits#retry-operations
function isThrottle(error) {
  return isSdkError(error) && error.code === 'CONNECTION_ERROR' && error.statusCode === 429;
}

// How many times a first send the service refused with a throttle is sent AGAIN: five, so six sends in all — the attempts the HTTP client gives every other throttled request (sdk-http-client.js `maxAttempts`), and on the
// same schedule (throttleBackoffMs: 1 s, 2 s, 4 s, 8 s, 8 s, plus jitter), or longer when the answer's `Retry-After` asks for it: that wait is taken WHOLE, as long as it fits the run's throttle budget
// (pushThroughThrottle, lib/throttle-budget.js). RETRY_AFTER_CAP_MS, a minute, caps the HTTP client's own retries and the wait before the read that settles an unknown outcome (pauseForRead), not this one.
const THROTTLE_RESENDS = 5;

// The statuses a change set the service refuses AS A WHOLE can prove, when every part of its answer carries one of them (watchThrottles): a 400, 403 or 404 — a request the service rejected, which no send can change — and a 429, which
// a later send can. NOT here, on purpose: a 409 or a 412 (the ids of an earlier send, which landed after its answer was lost, collide with the ones this send carries: that is the case the read after an unknown outcome exists
// for), a 500, and anything else. Those stay what they were, an outcome nobody knows.
const PROVEN_REFUSALS = Object.freeze(new Set([400, 403, 404, 429]));

// Wraps the HTTP client the SDK is given so the backend can learn what the SDK's errors do not carry. The SDK reports a refused request as a typed error that carries the status and the body of the answer but NOT its
// headers, so the wait the service asked for would be lost on the way up; and a change set the service refuses AS A WHOLE is answered HTTP 200 with the single part that failed, which the SDK can only report as an answer it
// cannot account for (a ConnectionError of status 200, "cannot be confirmed": one result for twelve operations), whatever the part says. The wrapper sees the answer first. Only the one request that writes a page is listened to —
// the `$batch`, `postRaw`:
//   - An answer that asks a caller to try again later — a 429, and the 5xx of a gateway (RFC 9110 defines `Retry-After` for a 503, and a 502 or 504 that carries one asks the same) — hands `record(ms)` whatever it asks, in its own
//     headers or in the headers of a refused operation inside it, as the HTTP client reads both (retryAfterMs, batchRetryAfterMs). It is the service's request WHOLE: the HTTP client's cap is for that client's own retries, and
//     what fits is the run's throttle budget's to judge (lib/throttle-budget.js).
//   - An answer of 2xx that is a COMPLETE, well-formed multipart envelope whose every part carries one of PROVEN_REFUSALS — read with the HTTP client's own strict parser (isBatchThrottled, completeBatchStatus), which takes anything missing or
//     malformed (a change set never closed, a part with no status line or one cut off) as proving nothing — is the change set the
//     service refused, and `refused({ status, outer, url })` says so. An answer that is cut off or incomplete inside, mixes statuses or carries any other status proves nothing about the change set and is not heard.
// The answer itself is returned as it came, and every other request is the client's own. A client that has no `postRaw` is returned as it is: the SDK refuses to write a page through it anyway.
// The wrapper is a delegating Proxy over an empty target, as the app-component scope that goes over it (lib/app-component-scope.js) and the table-list and app header guards the SDK factory puts
// over both (lib/collection-answers.js, lib/app-header-text.js) are: `postRaw` is the watch's, and every other member is read from the CLIENT at the moment it is read, a method bound to the
// client. So a client whose methods keep private state (a class with `#fields`) runs them on itself, a getter reads with the client as its receiver, a method the SDK holds detached from its
// receiver still reaches the client, and a frozen client is never written to. (An `Object.create(client)` with `postRaw` assigned on it ran every other method with the wrapper as `this` —
// "Cannot read private member #… from an object whose class did not declare it" — and could not be made over a frozen client's own `postRaw`: "Cannot assign to read only property".)
// See: https://www.rfc-editor.org/rfc/rfc9110#field.retry-after and https://www.rfc-editor.org/rfc/rfc6585#section-4 (429)
function watchThrottles(client, record, now = Date.now, refused) {
  if (!client || typeof client.postRaw !== 'function') return client;
  const { retryAfterMs, batchRetryAfterMs, isBatchThrottled, completeBatchStatus } = require('./sdk-http-client.js');
  const postRaw = async (...args) => {
    const answer = await client.postRaw(...args);
    if (answer && (answer.status === 429 || answer.status >= 500)) {
      const asked = Math.max(retryAfterMs(answer.headers, now(), Infinity), batchRetryAfterMs({ body: answer.body }, now(), Infinity));
      if (asked > 0) record(asked);
    } else if (answer && answer.status >= 200 && answer.status < 300) {
      const status = isBatchThrottled({ statusCode: answer.status, body: answer.body }) ? 429 : completeBatchStatus({ body: answer.body });
      if (PROVEN_REFUSALS.has(status)) {
        if (status === 429) {
          const asked = batchRetryAfterMs({ body: answer.body }, now(), Infinity);
          if (asked > 0) record(asked);
        }
        if (typeof refused === 'function') refused({ status, outer: answer.status, url: args[0] });
      }
    }
    return answer;
  };
  return new Proxy({}, {
    get: (_, key) => {
      if (key === 'postRaw') return postRaw;
      const value = client[key];
      return typeof value === 'function' ? value.bind(client) : value;
    },
    has: (_, key) => key in client,
  });
}

// The page's source as TEXT — the one place bytes become text, and it runs ONCE. The caller that reads a file calls this on the bytes it
// read, and then every check (the Griffel gate, the PAGEREF resolution), every hash and the write itself use that text unchanged:
// text is never normalized again, so what was checked and hashed is what the SDK stores, whatever the file started with.
//   - bytes (a Uint8Array): one leading UTF-8 byte order mark is dropped (the maker stores none; pac's download wrote one, so a file
//     saved from a download has it), and bytes that are not valid UTF-8 are refused — the SDK writes a page's rows in one atomic
//     change set, whose body is UTF-8 text, and a decode that replaced a bad byte would send a page nobody checked. Anything else is
//     kept as it is, line endings included (pac appended a CRLF; the SDK adds nothing).
//   - text (a string): already canonical — returned exactly as given. A second BOM at its start is page content, not an encoding
//     marker, and the BOM-strip that ran on its bytes must not run again on it: a file that starts with two of them would lose both.
// create() and update() take either, through this function, so a caller that hands them the bytes is normalized once there instead.
function sourceText(source) {
  if (typeof source === 'string') {
    // A string with a lone surrogate cannot be encoded as UTF-8 without replacing it.
    if (typeof source.isWellFormed === 'function' && !source.isWellFormed()) {
      throw genpageError('the page source is not valid text (it holds an unpaired surrogate), so it cannot be stored as UTF-8', { code: 'GENPAGE_SOURCE_NOT_UTF8' });
    }
    return source;
  }
  if (source instanceof Uint8Array) {
    try {
      // `fatal` refuses a bad sequence instead of replacing it with U+FFFD; the decoder drops one leading BOM itself (`ignoreBOM` is false).
      return new TextDecoder('utf-8', { fatal: true }).decode(source);
    } catch {
      throw genpageError('the page source is not valid UTF-8 — a page is stored as UTF-8 text, and sending it with bytes replaced would deploy something other than what was checked. Save the file as UTF-8 and run it again.', { code: 'GENPAGE_SOURCE_NOT_UTF8' });
    }
  }
  throw genpageError('the page source must be text or the bytes of a file', { code: 'GENPAGE_SOURCE_INVALID' });
}

// A table list as the SDK wants it: an array of logical names. A caller may hand the CSV it was typed as (`account,contact`); names
// are trimmed and lower-cased — a logical name is always lower case, and the SDK looks the table up by it.
function dataSourcesOf(value) {
  if (value === undefined || value === null) return undefined;
  // A blank CSV is "not given", the way a flag the caller did not pass is; an explicit empty ARRAY is the instruction to clear.
  if (typeof value === 'string' && !value.trim()) return undefined;
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
}

// `config.json` carries a binding as a bare JSON array (what the maker portal and pac both write); anything else would be merged into
// the existing value by an element update rather than replace it, so it is refused.
function bindingOf(value, label) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw genpageError(`${label} must be a JSON array`, { code: 'GENPAGE_BINDING_INVALID' });
  return value;
}

function turnOf(args, name) {
  const prompt = args.prompt && String(args.prompt).trim() ? String(args.prompt) : `Generative page ${name || ''}`.trim();
  // The default applies only when NO agent message was supplied; a supplied empty one records no reply.
  const reply = args.agentMessage === undefined || args.agentMessage === null ? DEFAULT_AGENT_MESSAGE : String(args.agentMessage);
  return { prompt, ...(reply ? { agentMessage: reply } : {}) };
}

// The fields of a page that an update compares and a settle checks. An absent key and an `undefined` one are the same here, which
// isDeepStrictEqual does not say.
function projectionOf(page) {
  const out = {};
  const put = (key, value) => { if (value !== undefined) out[key] = value; };
  put('source', page.source);
  put('name', page.name);
  put('dataSources', page.dataSources === undefined ? [] : page.dataSources);
  put('model', page.model);
  put('connectorBindings', page.connectorBindings);
  put('actionBindings', page.actionBindings);
  return out;
}

// What an update has to write for `page` to hold `fields` — [{ key, value }], in the order they are applied; empty when it already does. A field left `undefined` is the
// page's own and is never an edit. The one definition of "this page already holds that content": an update plans its writes with it, and a create that finds a page
// under its id asks it whether that page holds all of what the create asked for.
// `specBindings`: the binding lists given are an App Spec's. A spec states an entry by the properties it can carry and not by the ones it cannot (a connection id, a credential, a property a later runtime adds),
// so a list it states is read against the page's own entry by entry (mergeBindings): the page "holds" the list when every entry reads the same, and an edit's value is the list as the page will hold it, each entry
// still carrying what the spec could not state. For any other caller a list given is the page's list, as it always was.
function planEdits(fields, page, { specBindings = false } = {}) {
  const edits = [];
  if (fields.source !== page.source) edits.push({ key: 'source', value: fields.source });
  if (fields.name !== undefined && fields.name !== page.name) edits.push({ key: 'name', value: fields.name });
  if (fields.dataSources !== undefined && !isDeepStrictEqual(fields.dataSources, page.dataSources === undefined ? [] : page.dataSources)) edits.push({ key: 'dataSources', value: fields.dataSources });
  if (fields.model !== undefined && fields.model !== page.model) edits.push({ key: 'model', value: fields.model });
  for (const key of ['connectorBindings', 'actionBindings']) {
    if (fields[key] === undefined) continue;
    const wanted = specBindings ? mergeBindings(key, fields[key], page[key]) : fields[key];
    if (!isDeepStrictEqual(wanted, page[key])) edits.push({ key, value: wanted });
  }
  return edits;
}

// The content a caller asks a page to hold, as ONE hash: the fields planEdits compares — the source, and the name, data sources, model and bindings the caller gave — after the same
// normalization the write uses, so the same content hashes the same whether `create` or `update` was given it. A field left `undefined` is the page's own and is not part of it. The
// caller that keeps this hash with a publish it saw take effect (the build does, in its workspace: lib/page-publish-records.js) hands it back as `publishedFingerprint`, and an update
// that finds the page already holding this content publishes it only if that hash is not the content's. The prefix is the definition's version: a later definition makes every earlier
// hash unequal, and an unequal hash costs one publish, nothing worse.
function contentFingerprint(fields) {
  const content = {};
  for (const key of ['source', 'name', 'dataSources', 'model', 'connectorBindings', 'actionBindings']) if (fields[key] !== undefined) content[key] = fields[key];
  return sha256(`genpage-content/1\n${JSON.stringify(content)}`);
}

// The hashes a record of a publish holds for `fields` when it was made before one or more of the binding lists `fields` states were stated: the content with each such set of lists left out — three for a caller
// that states both lists (without the connector bindings, without the Custom API bindings, without either), one for a caller that states one, none for a caller that states none. `update` takes a record that is
// one of them for this content only once it has read the published copy and found the lists there too.
function fingerprintsBeforeListsWereStated(fields) {
  const stated = ['connectorBindings', 'actionBindings'].filter((key) => fields[key] !== undefined);
  const hashes = [];
  for (let leftOut = 1; leftOut < (1 << stated.length); leftOut += 1) {
    const earlier = { ...fields };
    stated.forEach((key, at) => { if (leftOut & (1 << at)) earlier[key] = undefined; });
    hashes.push(contentFingerprint(earlier));
  }
  return hashes;
}

// The content fields of a page as `update` takes them from its arguments, normalized as the write normalizes them, so what is compared, hashed and checked afterwards is what is written. A field the caller leaves
// out (`undefined`) is the page's own. `publishedDiffers` takes its arguments through this too, so the `fingerprint` it answers is the one `update` answers for the same arguments.
function contentFieldsOf(args) {
  return {
    source: sourceText(args.source),
    name: args.name === undefined || args.name === null || !String(args.name).trim() ? undefined : String(args.name),
    dataSources: dataSourcesOf(args.dataSources),
    model: args.model ? String(args.model) : undefined,
    connectorBindings: bindingOf(args.connectorBindings, 'connectorBindings'),
    actionBindings: bindingOf(args.actionBindings, 'actionBindings'),
  };
}

// The filetype of the rows that hold a page's TEXT: its source and its settings (`config.json`). The compiled output is the type after it. This is the layout the maker portal and the SDK write, and the one the SDK's
// page adapter reads (GenPageAdapter `fromApiResponse`): the source is the one text row whose name holds `page.tsx`, the settings the text row named `config.json`.
const TEXT_ROW_TYPE = 200000000;

// A file's content as bytes. The plugin's HTTP client answers a `$value` read with the Buffer it arrived as, never decoded (lib/sdk-http-client.js); a client that answers a string means its UTF-8.
function bytesOf(body) {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (Object.prototype.toString.call(body) === '[object ArrayBuffer]') return Buffer.from(body);
  return null;
}

// The page as its PUBLISHED layer holds it, in the shape `planEdits` compares — { name, source, dataSources, model, connectorBindings, actionBindings } — or null for a page that has no published copy. The published layer is
// what a plain read (no `MSCRM.IncludeUnpublished`) is served: the copy a publish writes and a draft does not touch. They are the plain reads the SDK's own check of a publish makes (it does not hand back what it
// read), made one after another — so a caller that needs them as ONE state brackets them with `fileVersions`, as the build does:
//   GET /uxagentprojects(<id>)?$select=uxagentprojectid,name                       { "uxagentprojectid": "…", "name": "Overview" }
//   GET /uxagentprojectfiles?$select=uxagentprojectfileid,filename,filetype&$filter=_uxagentprojectid_value eq <id>
//                                                                                  { "value": [ { "uxagentprojectfileid": "…", "filename": "src/pages/page.tsx", "filetype": 200000000 }, … ] }
//   GET /uxagentprojectfiles(<file id>)/filecontent/$value                         the file's bytes: the source row, and `config.json` when the page has one
// The settings are read as the SDK reads them: a JSON object (one leading byte order mark is ignored), `dataSources` a list of names, `model` a text, the two bindings as they are, every other key left alone.
// A page laid out otherwise — no source row or two, a file that is not UTF-8, settings that are not those — is one this reads no content from. It throws, and what a caller takes from that is "cannot be told".
async function readPublishedPage(sdk, id, { runtime = false } = {}) {
  const client = sdk.dataverse;
  if (!client || typeof client.get !== 'function') throw genpageError('the SDK has no Dataverse client to read the published layer with', { code: 'GENPAGE_PUBLISHED_UNREADABLE' });
  const get = async (path, what) => {
    const response = await client.get(path);
    if (!response || (response.status !== 404 && (response.status < 200 || response.status >= 300))) {
      throw genpageError(`${what}: HTTP ${response && response.status}`, { code: 'GENPAGE_PUBLISHED_UNREADABLE' });
    }
    return response;
  };
  const project = await get(`/uxagentprojects(${id})?$select=uxagentprojectid,name`, 'the page\'s row');
  if (project.status === 404) return null;
  const rows = await sdk.queryRecords('uxagentprojectfile', { select: ['uxagentprojectfileid', 'filename', 'filetype'], filter: `_uxagentprojectid_value eq ${id}`, paginate: true });
  const textRows = (rows || []).filter((row) => row && Number(row.filetype) === TEXT_ROW_TYPE && typeof row.filename === 'string');
  const sources = textRows.filter((row) => row.filename.includes('page.tsx'));
  const settings = textRows.filter((row) => row.filename === 'config.json');
  if (sources.length !== 1 || settings.length > 1) {
    throw genpageError(`its published files are not laid out as a page is (${sources.length} source rows, ${settings.length} settings rows)`, { code: 'GENPAGE_PUBLISHED_LAYOUT' });
  }
  const textOf = async (row, what) => {
    const fileId = String(row.uxagentprojectfileid || '').replace(/[{}]/g, '').toLowerCase();
    if (!GUID_RE.test(fileId)) throw genpageError(`${what} has no file id`, { code: 'GENPAGE_PUBLISHED_LAYOUT' });
    const content = await get(`/uxagentprojectfiles(${fileId})/filecontent/$value`, what);
    const bytes = content.status === 404 ? null : bytesOf(content.body);
    if (!bytes) throw genpageError(`${what} has no readable content`, { code: 'GENPAGE_PUBLISHED_UNREADABLE' });
    // `fatal`: a byte that is not UTF-8 is an error, not U+FFFD; `ignoreBOM`: a mark at the start is content, as the SDK's own read of the row keeps it.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  };
  const page = { name: String((project.body && project.body.name) ?? ''), source: await textOf(sources[0], 'the source row') };
  if (settings.length) {
    const config = JSON.parse((await textOf(settings[0], 'config.json')).replace(/^\uFEFF/, ''));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw genpageError('config.json is not a JSON object', { code: 'GENPAGE_PUBLISHED_LAYOUT' });
    if ('dataSources' in config) {
      if (!Array.isArray(config.dataSources) || !config.dataSources.every((name) => typeof name === 'string')) throw genpageError('config.json holds dataSources that are not a list of names', { code: 'GENPAGE_PUBLISHED_LAYOUT' });
      page.dataSources = config.dataSources;
    }
    if ('model' in config) {
      if (typeof config.model !== 'string') throw genpageError('config.json holds a model that is not a text', { code: 'GENPAGE_PUBLISHED_LAYOUT' });
      page.model = config.model;
    }
    for (const key of ['connectorBindings', 'actionBindings']) if (key in config) page[key] = config[key];
  }
  // `runtime`: the hash of the same copy's compiled output too (`runtimeSha256`, null for a copy that has none), from the listing of rows just read — a caller that compares the copy with evidence of what was published asks for it.
  if (runtime) page.runtimeSha256 = await compiledOutputSha256(sdk, id, { rows: rows || [] });
  return page;
}

// Whether the PUBLISHED copy of page `id` holds `fields` (planEdits, on the published layer): read only, and false for a page that has no published copy or whose copy cannot be read — "cannot be told" is never "holds it".
async function publishedCopyHolds(sdk, id, fields, options) {
  try {
    const page = await readPublishedPage(sdk, id);
    return page !== null && planEdits(fields, page, options).length === 0;
  } catch {
    return false;
  }
}

// The filetype of a page's COMPILED output row: the one after the text rows (TEXT_ROW_TYPE) — the bytes the runtime serves. The SDK writes it with the source, and a publish copies it to the published layer.
const COMPILED_ROW_TYPE = TEXT_ROW_TYPE + 1;

// The hash of the bytes of a page's compiled-output row as one layer serves them — the DRAFT (`unpublished`: the header `MSCRM.IncludeUnpublished`, which is what makes a read answer the draft) or the PUBLISHED layer
// (a plain read) — or null when the page has no such row, or it has no readable content. What the build certifies is a RUNTIME, and the source and the settings do not say what runs: another writer that published other
// compiled bytes under the SAME source, and put the original back as a draft, left a page whose draft, source and file versions all agreed with the file while the page that ran was theirs. Two plain reads:
//   GET /uxagentprojectfiles?$select=uxagentprojectfileid,filename,filetype&$filter=_uxagentprojectid_value eq <id>     { "value": [ { "uxagentprojectfileid": "…", "filename": "src/pages/page.compiled", "filetype": 200000001 }, … ] }
//   GET /uxagentprojectfiles(<file id>)/filecontent/$value                                                               the bytes (a 404 is a row with no content)
// A read that fails throws, which a caller takes as "cannot be told" — never as "there is none". `rows` are the rows of the page's files when the caller has just listed them (the published copy's read does): the listing is then not made again.
async function compiledOutputSha256(sdk, id, { unpublished = false, rows: listed } = {}) {
  const client = sdk.dataverse;
  if (!client || typeof client.get !== 'function') throw genpageError('the SDK has no Dataverse client to read the compiled output with', { code: 'GENPAGE_PUBLISHED_UNREADABLE' });
  const options = unpublished ? { headers: { 'MSCRM.IncludeUnpublished': 'true' } } : undefined;
  const get = async (path, what) => {
    const response = options ? await client.get(path, options) : await client.get(path);
    if (!response || (response.status !== 404 && (response.status < 200 || response.status >= 300))) {
      throw genpageError(`${what}: HTTP ${response && response.status}`, { code: 'GENPAGE_PUBLISHED_UNREADABLE' });
    }
    return response;
  };
  const rows = listed || (await get(`/uxagentprojectfiles?$select=uxagentprojectfileid,filename,filetype&$filter=_uxagentprojectid_value eq ${id}`, 'the page\'s files')).body?.value;
  const compiled = (Array.isArray(rows) ? rows : []).filter((row) => row && Number(row.filetype) === COMPILED_ROW_TYPE && typeof row.filename === 'string' && row.filename.includes('page.compiled'));
  if (compiled.length !== 1) return null;
  const fileId = String(compiled[0].uxagentprojectfileid || '').replace(/[{}]/g, '').toLowerCase();
  if (!GUID_RE.test(fileId)) return null;
  const content = await get(`/uxagentprojectfiles(${fileId})/filecontent/$value`, 'the compiled output');
  const bytes = content.status === 404 ? null : bytesOf(content.body);
  return bytes ? sha256(bytes) : null;
}

// Whether a page read from the environment holds what one of the creates sent under its id sent: its name, and its source. `sent` is [{ name, sourceSha256 }] —
// what a create records before it sends (the build's pending record). The two are what a page serves back EXACTLY as written (the SDK stores both verbatim), so
// the test is an exact comparison; a model, the data sources, the bindings and the conversation pass through projections that normalize them, and a proof that
// depended on them could refuse the very page it exists to recognise. A page that holds neither a name nor a source anyone sent under the id is not one of ours:
// it was named, or written, by someone else after the id was known, or edited since.
function holdsWhatWasSent(sent, page) {
  if (!page || typeof page.source !== 'string') return false;
  const digest = sha256(page.source);
  return (sent || []).some((s) => s && s.name === page.name && s.sourceSha256 === digest);
}

// Why a page found under a create's id is not one of ours, for a message: the names the creates sent and what the page is called, and whether its source is any
// that was sent. (`holdsWhatWasSent` having said no.)
function describeDivergence(sent, page) {
  const names = [...new Set((sent || []).map((s) => s.name))];
  const nameSent = names.includes(page.name);
  const sourceSent = typeof page.source === 'string' && (sent || []).some((s) => s.sourceSha256 === sha256(page.source));
  const parts = [];
  if (!nameSent) parts.push(`it is named ${JSON.stringify(page.name)}, and ${names.length === 1 ? 'the create sent' : 'the creates sent'} ${names.map((n) => JSON.stringify(n)).join(' or ')}`);
  if (!sourceSent) parts.push(`its source is not ${(sent || []).length === 1 ? 'the one' : 'any of those'} that ${(sent || []).length === 1 ? 'was' : 'were'} sent`);
  if (nameSent && sourceSent) parts.push('its name and its source were sent by different creates');
  return parts.join(', and ');
}

// The text of the first thing the user said in a page's conversation, or undefined: the prompt the page was created with.
const firstUserMessage = (page) => {
  const entry = ((page && page.conversation) || []).find((e) => e && e.sender === 'user');
  return entry && typeof entry.message === 'string' ? entry.message : undefined;
};

// Whether the conversation `now` is `before` plus the turn `turn` — the user's prompt and, when there is one, the agent's reply, in
// that order, at the end. An entry is `{ sender: 'user' | 'agent', message, createdOn }`; its id is not exposed, so the turn is
// recognised by what it says and where it sits.
function turnRecorded(now, before, turn) {
  const had = (before || []).length;
  const tail = (now || []).slice(had);
  const expected = [{ sender: 'user', message: turn.prompt }, ...(turn.agentMessage ? [{ sender: 'agent', message: turn.agentMessage }] : [])];
  return (now || []).length === had + expected.length
    && tail.every((entry, i) => entry.sender === expected[i].sender && entry.message === expected[i].message);
}

// The pages a sitemap's `siteMap` (the SDK's App artifact) names, as [{ pageId, name }] with `name` the navigation TITLE — which is
// not the page's own name — in navigation order, each page once.
function genPagesOfSiteMap(siteMap) {
  const seen = new Set();
  const pages = [];
  for (const area of (siteMap && siteMap.areas) || []) {
    for (const group of area.groups || []) {
      for (const sub of group.subAreas || []) {
        if (!sub || sub.type !== 'GenPage' || !sub.genPageId) continue;
        const key = String(sub.genPageId).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        pages.push({ pageId: String(sub.genPageId), name: sub.title });
      }
    }
  }
  return pages;
}

// The tables of the Entity entries of a navigation (`siteMap`, the SDK's App artifact) — the tables the SDK expands, whenever it writes the app, into their active Main forms, public views and
// charts (and only those: a page, a link or a dashboard entry adds none) — as lower-case logical names, each once, in navigation order. An entry is
//   { id: 'sub_0_0_0', type: 'Entity', entity: 'contoso_item', title: 'Items' }
// and the SDK reads it as `type === 'Entity'` with a truthy `entity`, so an entry of that type with no table names none.
function entityTablesOfSiteMap(siteMap) {
  const seen = new Set();
  const tables = [];
  const listOf = (value) => (Array.isArray(value) ? value : []);
  for (const area of listOf(siteMap && siteMap.areas)) {
    for (const group of listOf(area && area.groups)) {
      for (const sub of listOf(group && group.subAreas)) {
        if (!sub || sub.type !== 'Entity' || typeof sub.entity !== 'string' || !sub.entity) continue;
        const table = sub.entity.toLowerCase();
        if (seen.has(table)) continue;
        seen.add(table);
        tables.push(table);
      }
    }
  }
  return tables;
}

// The unique name of an app's PUBLISHED form (its appmodule row), or null when it has none — never published, or not there. It throws what the SDK's read throws.
async function publishedFormOf(sdk, appId) {
  const rows = await sdk.queryRecords('appmodule', { select: ['uniquename'], filter: `appmoduleid eq ${String(appId).toLowerCase()}`, top: 1 });
  return (rows && rows[0] && rows[0].uniquename) || null;
}

// The pages the PUBLISHED navigation of an app names — what runs: appmodule -> its sitemap component -> the sitemap XML, as the build and verify read it — as
// { ok: true, pages: [{ pageId, name }] }, `name` the navigation title. `{ ok: false, error, reason }` when it cannot be read — `reason` the part of `error` that says why, for a caller that words it
// itself — and `neverPublished: true` when the app has no published form at all: that is a fact (nothing runs from it, so no published navigation names anything) and not a read that failed, and it says so
// rather than answering as if the app were empty. It throws what the SDK's reads throw.
async function publishedNavigationOf(sdk, appId) {
  const { fetchSitemap, sitemapGenPages } = require('./sitemap-pages.js');
  const unique = await publishedFormOf(sdk, appId);
  if (!unique) return { ok: false, neverPublished: true, error: `app ${appId} has no published form — it was never published, or does not exist`, reason: 'no published form' };
  const sitemap = await fetchSitemap(sdk, String(unique));
  if (!sitemap.ok) {
    const reason = `${sitemap.reason}${sitemap.detail ? `: ${sitemap.detail}` : ''}`;
    return { ok: false, error: `could not read the published navigation of app ${appId} (${reason})`, reason };
  }
  return { ok: true, pages: sitemapGenPages(sitemap.xml).map((p) => ({ pageId: p.pageId, name: p.title })) };
}

// `publishedNavigationOf` that never throws: `{ ok: true, pages }`, or `{ ok: false, error, reason }` for an app that has no published navigation (`neverPublished`), for a navigation that cannot be read
// although the app has a published form, and — `lookupFailed: true` — for a read the SDK failed before it could even tell which of those it is. A caller that PROVES a publish by reading what runs reads through
// this, because an answer it could not get means "not proven" — a fact it reports — and not a failure of the work it had just done.
async function publishedPagesOf(sdk, appId) {
  try {
    return await publishedNavigationOf(sdk, appId);
  } catch (error) {
    return { ok: false, lookupFailed: true, error: `could not read the published navigation of app ${appId}: ${messageOf(error)}`, reason: messageOf(error) };
  }
}

// One app push, which the SDK may REPORT as not saved instead of throwing it. Its notes go to `warnings`.
// The push is limited to the components the edit owns — the views it pins, `owned.views` — and to the sitemap: the SDK (the bundle's `appApi.update`) follows its sitemap write with an AddAppComponents of
// everything it derives from the app's Entity sub-areas (every active Main form, public view and chart of each table), which puts back what the app's maker took out of it. See lib/app-component-scope.js.
async function pushApp(sdk, appId, warnings, scope, owned) {
  const pushed = await scope.limit(appId, owned, () => sdk.pushArtifact('app', appId));
  if (!pushed || pushed.saved !== true) {
    throw genpageError(`app ${appId} was not changed: ${messageOf((pushed && pushed.error) || 'the push was not saved')}`, { code: pushed && pushed.error && pushed.error.code, cause: pushed && pushed.error });
  }
  warnings.push(...(pushed.warnings || []));
}

// An id as the page verbs take it: a GUID however it is spelled, lower-cased — and a typed error, before any request, for anything else. (`read`, `update` and `placeInApp` check theirs where they use it.)
function guidOf(value, what) {
  if (!GUID_RE.test(String(value || ''))) throw genpageError(`'${value}' is not ${what === 'app' ? 'an app' : 'a page'} id`, { code: 'GENPAGE_ID_INVALID', outcome: 'nothing' });
  return String(value).toLowerCase();
}

// What a page's folder holds and how long its conversation is, from the page as the SDK projects it — for a caller that reports what it is about to remove (`delete`) or must
// pin views for (`add-to-app`): `fileRows` counts the four rows the maker lays out (the ids the adapter keeps in `bag.rows`) and every other row (`files`); `editable` says the page has a
// source this tool can read and write (a page held as raw files has none); `dataSources` is the page's own tables, or `null` when the SDK does not project the page's configuration —
// "reads no table" and "not known" are different facts, and a caller that pins one view per table must not take the second for the first.
function describeOf(page, id) {
  const editable = typeof page.source === 'string';
  const managedRows = Object.values((page.bag && page.bag.rows) || {}).filter(Boolean).length;
  return {
    pageId: id,
    name: page.name === undefined || page.name === null ? '' : String(page.name),
    editable,
    dataSources: editable ? (Array.isArray(page.dataSources) ? [...page.dataSources] : []) : null,
    fileRows: managedRows + (Array.isArray(page.files) ? page.files.length : 0),
    conversationMessages: Array.isArray(page.conversation) ? page.conversation.length : 0,
  };
}

// What a page's `prompt.txt` holds in the folders a download writes. pac wrote the conversation's user messages: the bare text of a
// conversation of one message, and otherwise
//   Conversation with 2 prompts:␍␊1. Show an overview␍␊2. Add a bar chart
// (the same words for one prompt are never used, and the grammar is pac's own, kept so a rebuild from a folder an earlier release
// downloaded and one from this release read the same text). A page with no conversation falls back to its first prompt; one with
// neither has no `prompt.txt` at all — absent, which a build reads as "no prompt supplied", not as an empty one.
function promptTranscript(page) {
  const prompts = ((page && page.conversation) || []).filter((entry) => entry && entry.sender === 'user').map((entry) => String(entry.message));
  if (prompts.length === 1) return prompts[0];
  if (prompts.length > 1) return `Conversation with ${prompts.length} prompts:${prompts.map((p, i) => `\r\n${i + 1}. ${p}`).join('')}`;
  return typeof (page && page.firstPrompt) === 'string' && page.firstPrompt ? page.firstPrompt : undefined;
}

// `config.json` as the maker lays it out: the typed fields and the keys the SDK does not model, in the order the page had them —
//   {"dataSources":["account"],"model":"","actionBindings":[…]}
// `bag.configKeys` is that order; a page without it (created by the SDK in this run) gets the order the SDK writes.
function configJson(page) {
  const bag = (page && page.bag) || {};
  const typed = { dataSources: page.dataSources === undefined ? [] : page.dataSources, model: page.model, connectorBindings: page.connectorBindings, actionBindings: page.actionBindings };
  const keys = Array.isArray(bag.configKeys) && bag.configKeys.length ? bag.configKeys : ['dataSources', 'model', 'connectorBindings', 'actionBindings'];
  const out = {};
  for (const key of keys) {
    const value = Object.prototype.hasOwnProperty.call(typed, key) ? typed[key] : (bag.config || {})[key];
    if (value !== undefined) out[key] = value;
  }
  // A key the typed layer holds that the key list does not name (a list from before it was modeled) is still the page's.
  for (const [key, value] of Object.entries(typed)) if (value !== undefined && !(key in out) && key === 'dataSources') out[key] = value;
  return JSON.stringify(out);
}

// The files of a page's folder in an app folder — what `download` writes under pages/<pageId>/ and a rebuild reads back:
//   page.tsx      the source, exactly as stored (pac wrote it with a BOM and a final CRLF; this adds neither)
//   config.json   the data sources, model and bindings
//   prompt.txt    the prompt text (promptTranscript); not written when the page has none
// Returns { 'page.tsx': text, 'config.json': text, 'prompt.txt'?: text }.
function pageFolderFiles(page) {
  const files = { 'page.tsx': page.source, 'config.json': configJson(page) };
  const prompt = promptTranscript(page);
  if (prompt !== undefined) files['prompt.txt'] = prompt;
  return files;
}

function makeGenpageSdk(env, deps = {}) {
  const newId = deps.newId || (() => crypto.randomUUID());
  // The identity of an update's turn (see update): minted once per update, and kept across the settling reads of that update.
  const newTurnId = deps.newTurnId || (() => crypto.randomUUID());
  // The workspace folders made here, each with the guard its SDK works through (workspace-storage-guard.js), removed by release().
  const made = [];
  const byLanguage = new Map();
  // What a page edit of an app may add to the app's components, held at the transport of every SDK this backend makes (lib/app-component-scope.js).
  const appScope = makeAppComponentScope();
  // The SDKs whose transport is `appScope`'s: those this backend made. A lent SDK (`deps.sdk`, or one `deps.createSdk` makes) has a transport of its own, so a push through it is not limited.
  const madeHere = new WeakSet();
  // Set by dispose(): no operation starts after it.
  let closed = false;
  // The operations in flight. An SDK that was lent to this backend (deps.sdk, or one a test makes) keeps its workspace somewhere this
  // backend cannot close, so for those release() waits for the operations instead.
  const running = new Set();
  const closedError = () => genpageError('the page backend was disposed, or its workspace was discarded: an operation that was under way is cut short, and none can start on a backend that was disposed', { code: 'GENPAGE_BACKEND_CLOSED' });

  // ── Waiting out a throttle ──
  // The wait the last refused answer of a page write asked for (its `Retry-After`, as watchThrottles heard it): pushOnce clears it before a push and hands it to the caller in the push's own answer.
  let asked = 0;
  // What the answer to this push proved when it was a change set the service refused AS A WHOLE ({ status, outer, url }, as watchThrottles heard it): cleared with `asked`, and read only through provenRefusal.
  let refusal = null;
  const random = deps.random || Math.random;
  // The clock `retryNotBefore` is stamped on: the moment before which nothing may be sent, for the layer that runs the build again. A test seam, with `sleep` and `random`.
  const clock = deps.now || Date.now;
  // The waits in progress. release() ends them, and an operation that wakes to a backend that was closed, or whose workspace was discarded, sends nothing more: `generation` is what release() moves.
  let generation = 0;
  const sleepers = new Set();
  // `deps.sleep` is a test seam (the waits are recorded, not taken). Either way a wait is one release() can end — a build that is told to stop must not go on to send a write after a pause it was woken from.
  function pause(ms) {
    return new Promise((resolve) => {
      let timer;
      const wake = () => { clearTimeout(timer); sleepers.delete(wake); resolve(); };
      sleepers.add(wake);
      if (deps.sleep) Promise.resolve().then(() => deps.sleep(ms)).then(wake, wake);
      else timer = setTimeout(wake, ms);
    });
  }
  async function pauseFor(ms) {
    if (!(ms > 0)) return;
    const epoch = generation;
    await pause(ms);
    if (closed || epoch !== generation) throw closedError();
  }

  // The SDK, made on first use. `languageCode` only matters to an app edit (a sitemap title is written in it) and is the SDK's
  // construction-time option, so one SDK per language.
  async function getSdk(languageCode) {
    if (closed) throw closedError();
    if (deps.sdk) return deps.sdk;
    const key = languageCode || 'default';
    if (!byLanguage.has(key)) {
      byLanguage.set(key, (async () => {
        const create = deps.createSdk || (async (options) => {
          const { createMakerSdk, createNodeWorkspaceStorage } = require('./maker-sdk.js');
          const { createAzHttpClient } = require('./sdk-http-client.js');
          // The folder is made through the plugin's one maker of them (lib/temp-workspace.js): it goes in the plugin's own temp folder with a record of whose it is,
          // so a run that is killed — and cannot remove it, here, in dispose() — has it removed by the next run (the folder holds the source of every page this run reads).
          const dir = makeTempWorkspace('genpage-', { mkdtempSync: deps.mkdtempSync });
          // The SDK reaches the disk only through its storage, so closing this one (dispose) is closing the workspace: a read or an
          // initialization that is still running when the folder is removed can neither write into it nor put it back.
          const guard = guardWorkspaceStorage((deps.createStorage || createNodeWorkspaceStorage)(dir), closedError);
          // Recorded before the SDK exists, so a failure to make it still leaves dispose() the folder to remove.
          made.push({ dir, guard });
          const sdk = createMakerSdk({
            workspaceStorage: guard.storage,
            instanceUrl: env,
            // The SDK's transport, limited for a page edit of an app (see appScope above and `pushApp`), and watched, so a refused page write's Retry-After reaches this backend, and so does what a change set
            // refused as a whole proved (watchThrottles): the SDK's error for either carries no headers and no part. The watch is the inner layer, next to the transport, so what it hears is what the service
            // answered: a post the limit answers itself (an AddAppComponents left with nothing to add) never reached the service.
            httpClient: appScope.wrap(watchThrottles(deps.httpClient || (deps.createHttpClient || createAzHttpClient)(env, { throttle: deps.throttle }), (ms) => { asked = Math.max(asked, ms); }, deps.now, (found) => { refusal = found; })),
            // A page's file downloads overlap (four at a time): a read of a page is its rows' bytes, one request each.
            readConcurrency: 4,
            ...(options.languageCode ? { languageCode: options.languageCode } : {}),
          });
          madeHere.add(sdk);
          await sdk.initWorkspace();
          return sdk;
        });
        return create({ languageCode });
      })());
    }
    try {
      return await byLanguage.get(key);
    } catch (error) {
      byLanguage.delete(key);
      throw error;
    }
  }

  // The page as the server holds it now — the draft layer, the one a push compares against — replacing any copy in the workspace.
  // `overwrite` is what makes this a read of the SERVER: without it the SDK hands back a copy that holds unpushed edits instead of
  // fetching (an operation that failed can leave one), which would be the wrong answer to "what did the write do?".
  //   { kind: 'present', page }   the page
  //   { kind: 'absent' }          no such page (HTTP 404 for its row; drafts are readable, so a 404 is not "unpublished")
  //   { kind: 'unreadable', error }
  async function readServer(sdk, id) {
    try {
      return { kind: 'present', page: await sdk.fetchArtifact('genPage', id, { overwrite: true }) };
    } catch (error) {
      if (error && error.code === 'CONNECTION_ERROR' && error.statusCode === 404) return { kind: 'absent' };
      return { kind: 'unreadable', error };
    }
  }

  // `readServer`'s answer as the page or the typed error a caller reads, for the operations that cannot go on without it: `GENPAGE_NOT_FOUND` / `GENPAGE_UNREADABLE`.
  async function presentPage(sdk, id) {
    const declinedBefore = declinedCount();
    const found = await readServer(sdk, id);
    if (found.kind === 'absent') throw genpageError(`page ${id} does not exist in this environment`, { code: 'GENPAGE_NOT_FOUND' });
    if (found.kind === 'unreadable') {
      const message = `could not read page ${id}: ${messageOf(found.error)}`;
      // A throttle the budget had no room to wait for is the service's to say, and a later run may find it ready: it is not the final "this page cannot be read".
      throw isThrottle(found.error) && declinedCount() > declinedBefore
        ? refusedReadError(message, found.error, {})
        : genpageError(message, { code: 'GENPAGE_UNREADABLE', cause: found.error });
    }
    return found.page;
  }

  // One push, its answer sorted by what it says about the page. The SDK REPORTS some failures instead of throwing them
  // (`saved: false` with an `error`): an id that already exists, and a version conflict.
  //   { saved: true, result }
  //   { saved: false, outcome: 'nothing' | 'unknown' | 'exists' | 'conflict', error, asked, throttled?, refusedWith? }
  // `asked` is the wait, in milliseconds, that the answer to this push asked for in its `Retry-After` (watchThrottles; 0 when it asked for none). `throttled` is there when a 'nothing' was the service's throttle (HTTP 429).
  // `refusedWith` is there when the answer was a change set the service refused AS A WHOLE and the parts of its answer prove which status (see provenRefusal).
  // A create whose ids already exist — an earlier request that carried them landed — comes back one of two ways, and neither is ever "nothing was
  // written": the SDK reports the service's 412 as `ARTIFACT_ALREADY_EXISTS` ('exists'), and a change set the service rolled back for it is an answer the
  // SDK cannot account for (a CONNECTION_ERROR with status 200, "cannot be confirmed": 'unknown'). Both end in a read of the id.
  async function pushOnce(sdk, id) {
    asked = 0;
    refusal = null;
    // What the answer to THIS push proved, when the SDK could not account for it. A change set the service refuses as a whole is answered HTTP 200 with the one part that failed, which the SDK reports as a ConnectionError of
    // status 200 on the `$batch` ("cannot be confirmed": one result for N operations) — so by its status that error is an unknown outcome, like any answer the SDK cannot read. The parts say more: when watchThrottles read every
    // part of this push's `$batch` answer, and every part was the same 400, 403, 404 or 429, the change set was refused — nothing in it committed (it is atomic) — and for a 429 it is a throttle, waited out like any other.
    // The error must be that answer's: the SDK's own ConnectionError, of the status that answer had, at the `$batch` url (a second request of the push, or any other error, is not the proof's). Anything the parts do not
    // prove stays what writeOutcome says.
    const provenRefusal = (error) => {
      if (!refusal || !isSdkError(error) || error.code !== 'CONNECTION_ERROR') return 0;
      return error.statusCode === refusal.outer && /\/\$batch$/.test(String(error.url)) && /\/\$batch$/.test(String(refusal.url)) ? refusal.status : 0;
    };
    // `asked` and the proof are read as the push ends, before anything else can answer.
    const unsaved = (outcome, error) => {
      const proven = provenRefusal(error);
      const settled = proven ? 'nothing' : outcome;
      return { saved: false, outcome: settled, error, asked, ...(proven ? { refusedWith: proven } : {}), ...(settled === 'nothing' && (proven === 429 || isThrottle(error)) ? { throttled: true } : {}) };
    };
    let result;
    try {
      result = await sdk.pushArtifact('genPage', id);
    } catch (thrown) {
      const error = nestingRefusalOf(thrown);
      return unsaved(writeOutcome(error), error);
    }
    if (result && result.saved === true) return { saved: true, result };
    const error = nestingRefusalOf(result && result.error);
    if (error && error.code === 'ARTIFACT_ALREADY_EXISTS') return unsaved('exists', error);
    if (error && error.code === 'VERSION_CONFLICT') return unsaved('conflict', error);
    return unsaved(error ? writeOutcome(error) : 'unknown', error || new Error('the SDK did not report the page as saved'));
  }

  // A first send the service REFUSED with a throttle (HTTP 429) — as a whole request, or as the one failing part of a change set it answered with HTTP 200 — waited out and sent again — at most THROTTLE_RESENDS times, six sends in
  // all — and the answer of the last one. The wait is the HTTP client's schedule for every other throttled request (throttleBackoffMs), or what the answer's Retry-After asks when that is longer, WHOLE (watchThrottles): what
  // fits is the budget's to say. Every wait comes out of the run's throttle budget (lib/throttle-budget.js), the same one the build's own waits and the HTTP client's come out of; the wait that does not fit is not taken, nothing more is sent, and the
  // answer comes back marked `stopped` for the caller to say so. Why a send that follows a 429 is safe, and why it is made here and not by the HTTP client re-sending the request (as it does for a conditional delete):
  //  - A 429 is the service declining to START the request: the change set is atomic, so nothing in it committed. The page is as unsent as it was.
  //  - And even a request that had been processed could not write a page twice. A create's ids — the page's, and those of its rows — are minted before the first send, so a second send meets the first and is rolled back whole (the
  //    property the resend after an unknown outcome rests on, too). An update's turn carries an identity from which the SDK derives the ids of its messages, so a second send addresses the same two rows and collides the same way.
  //  - The SDK compares the version tokens of the page's rows with the ones this operation read, on EVERY push: an update sent again after the wait is refused (`VERSION_CONFLICT`, reported by value and judged by the caller as any
  //    first send's) when anyone changed the page meanwhile, and is never sent over what they saved. The update's writes carry `If-Match: *`, so a request replayed by the HTTP client after the wait would skip that check —
  //    which is why that client leaves a page's change set to this backend (sdk-http-client.js, `isConditionalDeleteBatch`).
  //  - It is bounded (the sends, and each wait), and cut short by dispose() (pauseFor).
  // A refusal that is not a throttle, and a send that got no usable answer, are not waited out: they are settled as they always were by the caller.
  async function pushThroughThrottle(sdk, id, first, waited, budget, who) {
    let pushed = first;
    for (let resend = 0; !pushed.saved && pushed.throttled && resend < THROTTLE_RESENDS; resend += 1) {
      const { throttleBackoffMs } = require('./sdk-http-client.js');
      const wait = Math.max(throttleBackoffMs(resend, random), pushed.asked);
      if (!budget.fits(wait)) return { ...pushed, stopped: { askedMs: pushed.asked, waitMs: wait } };
      budget.spend(wait);
      budget.announce(`${who}: the service throttled the write (HTTP 429); waiting ${Math.ceil(wait / 1000)} s before sending it again (${spentNote(budget)})`, wait);
      await pauseFor(wait);
      waited.push(wait);
      pushed = await pushOnce(sdk, id);
    }
    return pushed;
  }
  // The wait before the read that settles an unknown outcome, when the answer that left it unknown (a gateway's 503) asked to wait: a request still on its way has had that time to land. It is a wait the service asked for, so it
  // is counted — at most the client's own cap of a minute (the longest it ever was), and at most what is left of the budget — and it never stops the write: the page is read for, and settled, either way.
  async function pauseForRead(askedMs, budget, who) {
    const { RETRY_AFTER_CAP_MS } = require('./sdk-http-client.js');
    const wait = Math.min(askedMs, RETRY_AFTER_CAP_MS, budget.remainingMs());
    if (!(wait > 0)) return;
    budget.spend(wait);
    budget.announce(`${who}: the service asked to wait ${Math.ceil(wait / 1000)} s before the page is read to see whether the write landed; waiting (${spentNote(budget)})`, wait);
    await pauseFor(wait);
  }
  // What the error of a throttle that outlasted the sends — or that did not fit the budget — carries on top of what every page-write error does: the status, so the build reads the throttle from the error itself (a refusal
  // proven by the parts of an HTTP 200 has no 429 anywhere else), and what the last answer asked, for the layer that runs the build again (throttleAskOf).
  const throttledProps = (pushed, failure) => ({ ...failure, statusCode: 429, ...(pushed.asked > 0 ? { retryAfterMs: pushed.asked, retryNotBefore: clock() + pushed.asked } : {}) });
  // The words an error of a page write uses for a failed send: the SDK's own, and — when the parts of the answer proved a refusal of the whole change set — what they proved, which the SDK's error ("cannot be confirmed") does not say.
  const refusalWords = (pushed) => (pushed.refusedWith
    ? `the service refused the change set with HTTP ${pushed.refusedWith} (inside its HTTP 200 answer: ${messageOf(pushed.error)})`
    : messageOf(pushed.error));
  // What an operation says of a write that was throttled and then taken: why it was slow, and that the page was written once. `waited` is what pushThroughThrottle recorded.
  const throttleNote = (what, waited) => `the service throttled the write of ${what} (HTTP 429) ${waited.length === 1 ? 'once' : `${waited.length} times`}: a refused request writes nothing, so it was sent again after waiting ${waited.map((ms) => `${Math.round(ms / 100) / 10} s`).join(', ')}, and written once`;
  // The budget an operation spends its waits from: the run's, which the build hands to every page write (`args.throttle`); else the one the backend was handed (`deps.throttle`: the upload script's, which hands it to its backend because it is a
  // run of one write, and which the backend's own HTTP client draws from as well); else — for a caller that has none — one of its own for this write.
  const budgetOf = (args) => (args && args.throttle && typeof args.throttle.fits === 'function' ? args.throttle : deps.throttle && typeof deps.throttle.fits === 'function' ? deps.throttle : makeThrottleBudget({ warn: deps.warn }));

  // The waits the HTTP client has refused for want of room in a budget (`declined`, lib/throttle-budget.js), counted over the budgets this backend draws on: the one a call was handed and the backend's own, which the client it makes draws from. A read the
  // client hands back as a throttle (HTTP 429) is the BUDGET's refusal when this count grew while it was read — the SDK's error says nothing of that, nor of what the service asked — so a caller takes the count before the read and compares after.
  const budgetsOf = (args) => [...new Set([args && args.throttle, deps.throttle].filter((b) => b && typeof b.declined === 'function'))];
  const declinedCount = (args) => budgetsOf(args).reduce((total, b) => total + b.declined().count, 0);
  // The error of a read before a write that the budget refused to wait for. It is the throttle's own (`throttledError`): not `transient: false`, because nothing was changed and the service's load is not the page's, and it carries what the service
  // asked — which the SDK's error does not — so that the build's retry loop stops with the budget's halt (build-model-app.js). The code and the fields are those the same read gives when it fails for another reason.
  const refusedReadError = (message, cause, props, args) => {
    const askedMs = Math.max(0, ...budgetsOf(args).map((b) => b.declined().askedMs));
    return throttledError(message, { code: 'GENPAGE_UNREADABLE', cause, ...props, statusCode: 429, ...(askedMs > 0 ? { retryAfterMs: askedMs, retryNotBefore: clock() + askedMs } : {}) });
  };

  // Publish the page and prove the published copy is the one just written. The SDK answers `publish.kind`:
  //   'verified'      the published projection serves exactly what was saved
  //   'unverifiable'  the publish was submitted but the published projection does not show the page yet (PublishXml is asynchronous)
  //   'failed'        the publish was refused
  // The answer carries the failure itself as a non-enumerable `cause` (withCause, retry-policy.js) when there was one — the SDK's reported `publish.error`, or what the call threw.
  async function publish(sdk, type, id, options) {
    try {
      const outcome = await sdk.publishArtifact(type, id, options);
      const state = (outcome && outcome.publish) || {};
      return withCause({ kind: state.kind || 'unknown', detail: state.reason || (state.error && messageOf(state.error)) || '' }, state.error);
    } catch (error) {
      return withCause({ kind: 'failed', detail: messageOf(error) }, error);
    }
  }

  const label = (name, id) => (name ? `"${name}" (${id})` : String(id));
  // The hash of the compiled output the page's DRAFT holds right now — read just BEFORE the publish, so it is what the publish copies — for a caller that asked (`runtimeEvidence: true`) because it keeps a record of what it
  // published and certifies the RUNTIME in it (lib/page-publish-records.js; `publishedDiffers` compares the published copy with it). It is evidence and nothing more: a read that fails, or a page with no compiled row, answers
  // `undefined`, and the caller then has nothing to certify with.
  async function runtimeEvidenceOf(sdk, id, args) {
    if (!args || args.runtimeEvidence !== true) return undefined;
    try {
      return (await compiledOutputSha256(sdk, id, { unpublished: true })) || undefined;
    } catch {
      return undefined;
    }
  }
  // The warnings a finished write carries: the SDK's own, and what a publish that could not be proven says.
  const warningsOf = (pushed, published, who) => [
    ...((pushed && pushed.result && pushed.result.warnings) || []),
    ...(published.kind === 'unverifiable' ? [`${who} was saved and published, but the published copy could not be read back to confirm it (${published.detail}) — treat it as live only once it is seen to be`] : []),
  ];

  const api = {
    // Every page of the environment — drafts included, and with the name the page's own row holds (which, for a page an earlier
    // release created, has pac's `\"` in it: unescapePacName). One SDK list (paged); a listing that cannot be read is `ok: false`,
    // never an empty environment — a caller that decides between creating a page and reusing one stops on it.
    // `ids` are lower-cased, for case-insensitive set membership.
    async enumerateEnv() {
      try {
        const list = await (await getSdk()).fetchArtifactList('genPage');
        const pages = list.map((p) => ({ pageId: String(p.id), name: String(p.name === undefined || p.name === null ? '' : p.name) }));
        return { ok: true, ids: pages.map((p) => p.pageId.toLowerCase()), pages };
      } catch (error) {
        return withCause({ ok: false, ids: [], error: `could not list the environment's generative pages: ${messageOf(error)}`, ...codeOf(error) }, error);
      }
    },

    // The pages the navigation of an app names. `name` is the navigation TITLE, not the page's own name (a rename of the page
    // leaves the title as it was), so a listed name is never evidence of what the page is called.
    // `includeUnpublished` reads the app's SAVED navigation (what the designer holds, the latest the maker made); without it the
    // PUBLISHED one (appmodule -> sitemap, as the build and verify read it). An app that was never published has no published
    // navigation, and says so rather than answering as if it were empty.
    async enumeratePages(appId, options = {}) {
      if (!GUID_RE.test(String(appId || ''))) return { ok: false, pages: [], error: `'${appId}' is not an app id` };
      try {
        const sdk = await getSdk();
        let pages;
        if (options && options.includeUnpublished === true) {
          pages = genPagesOfSiteMap((await sdk.fetchArtifact('app', appId, { overwrite: true })).siteMap);
        } else {
          const published = await publishedNavigationOf(sdk, appId);
          if (!published.ok) return { ok: false, pages: [], error: published.error };
          pages = published.pages;
        }
        return { ok: true, pages, empty: pages.length === 0 };
      } catch (error) {
        return { ok: false, pages: [], error: `could not read the navigation of app ${appId}: ${messageOf(error)}`, ...codeOf(error) };
      }
    },

    // One page as the SDK projects it: { id, name, source, dataSources, model, firstPrompt, firstAgentMessage, conversation,
    // connectorBindings, actionBindings, bag }. It throws — with a `code` — for a page that is not there (`GENPAGE_NOT_FOUND`),
    // one that cannot be read (`GENPAGE_UNREADABLE`), and one the SDK cannot project semantically (`GENPAGE_NO_SOURCE`): a page
    // whose rows are not laid out as the maker lays them out is held as raw files, with no `source`, and is reported — never
    // answered as a page with an empty source, which a caller would check, compare and overwrite as if it were one.
    async read(pageId) {
      if (!GUID_RE.test(String(pageId || ''))) throw genpageError(`'${pageId}' is not a page id`, { code: 'GENPAGE_ID_INVALID' });
      const sdk = await getSdk();
      const page = await presentPage(sdk, pageId);
      if (typeof page.source !== 'string') {
        throw genpageError(`page ${pageId} (${JSON.stringify(page.name)}) has no source this tool can read: its rows are not laid out as the maker lays them out, so it is held as raw files, which are neither read nor compared as an empty page. Open it in Maker.`, { code: 'GENPAGE_NO_SOURCE' });
      }
      return page;
    },

    // CREATE: mint the page's id here, write it as one atomic change set, publish it, and prove the published copy.
    //   args: { name, source, dataSources, model, prompt, agentMessage, connectorBindings, actionBindings, pageId, sentBefore, caller, beforeSend, runtimeEvidence, throttle }
    //   `throttle` is the budget the waits of a throttled write are spent from (lib/throttle-budget.js): the run's, which the build hands every page write, so what the service asked is waited for once for the whole run; a caller
    //   that gives none (the upload script) gets one of its own for this write. A wait that does not fit it stops the write: nothing more is sent, and the error says what the service asked.
    //   `runtimeEvidence: true` makes the result carry `runtimeSha256`, the hash of the compiled output the draft held when the page was published (read just before the publish), for a caller that records what it published
    //   and wants the record to certify the runtime that was published and not only its source (`publishedDiffers`'s `expected`). Without it nothing more is read.
    //   `source` is the text the caller checked (sourceText turns the bytes of a file into it, once); bytes given here are decoded the
    //   same way, a string is used exactly as it is.
    //   `pageId` is an id to create the page under instead of a new one — a caller RESUMING a create that did not finish passes the id it
    //   minted then, and the creates it sent under it as `sentBefore`: [{ name, sourceSha256 }], the name and the SHA-256 of the source of each.
    //   A create given an id is a resumed one, and a request an earlier call sent under that id, whose outcome it never learned, is OPEN from the start
    //   (below): it can reach the service after anything this call reads or is told, so nothing this call's own send answers settles it.
    //   `beforeSend(pageId, { name, sourceSha256 })` is awaited after the id is known and before anything is sent: a caller that has to
    //   remember the id in case this call never answers records it there, with what is being sent under it. If it throws, nothing was sent.
    // The id is minted BEFORE anything is sent, so what the write did can always be found out by reading it:
    //   saved                       -> publish
    //   a known failure             -> reported with the SDK's own code and message, and not sent again: the SDK refused it before
    //                                  writing, or the server answered the change set with a 4xx (atomic: nothing was written). It is
    //                                  a known failure of the page only while no earlier send is still open.
    //   a throttle (HTTP 429)       -> the service declined to start the request, so nothing was written; with no earlier send open it is waited out — the HTTP
    //                                  client's schedule, or what the answer's Retry-After asks — and sent again under the same id, six sends in all
    //                                  (pushThroughThrottle says why that is safe). One that outlasts them is reported as nothing written and, alone among
    //                                  the errors a page write raises, is not marked `transient: false`: the build may run again.
    //   an UNKNOWN outcome          -> read the id. Present: it landed (see "a page found" below). Absent: nothing was written YET, so the
    //                                  create is sent ONCE more under the SAME id: a first send that lands late collides on the id
    //                                  — no second page can exist — and that collision, like a second unknown, is settled by reading
    //                                  the id again.
    // A send that got no usable answer may still reach the service after anything this call has read or been told, so it is kept open:
    // every later failure — a second unknown, a refused resend, a read that finds nothing — ends as `outcome: 'unknown'` with the page's
    // id, never as "nothing was written", because that is only known when no send is open. A resumed create has an open send before it sends
    // anything, so even a refusal before its send (a page that does not compile) is `unknown`, with the id.
    // A page found under the id is THIS create's or an earlier one's only if it holds what one of the creates under that id sent — its name and its
    // source (holdsWhatWasSent). Any other page is not ours — it was named or written by someone else after the id was known, or edited since — and is
    // neither adopted nor published (`GENPAGE_CREATE_DIVERGED`). One that is ours may still hold less than THIS create asks for: an earlier create under
    // the same id sent another model, other data sources or bindings. It is then brought to what this create asks for through the ordinary update, which
    // publishes it — never published as it is, and never reported as if this create's content had been stored when it had not. (A prompt is
    // provenance, not content: an update records one only when it changes the page, so a page that differs from this create in nothing but its first
    // prompt is adopted with a warning that says so.)
    // A page that was written but not published is NOT an error here: `publish.kind === 'failed'` says so, and the page's id is in
    // the result, because the caller must still record that the page exists.
    async create(args = {}) {
      const name = args.name === undefined || args.name === null || !String(args.name).trim() ? 'Generative page' : String(args.name);
      const source = sourceText(args.source);
      const dataSources = dataSourcesOf(args.dataSources) || [];
      const connectorBindings = bindingOf(args.connectorBindings, 'connectorBindings');
      const actionBindings = bindingOf(args.actionBindings, 'actionBindings');
      const turn = turnOf(args, name);
      const given = args.pageId === undefined || args.pageId === null ? undefined : String(args.pageId);
      if (given !== undefined && !GUID_RE.test(given)) throw genpageError(`'${given}' is not a page id`, { code: 'GENPAGE_ID_INVALID', outcome: 'nothing' });
      const sdk = await getSdk();
      const id = (given === undefined ? String(newId()) : given).toLowerCase();
      const who = JSON.stringify(name);
      const model = args.model ? String(args.model) : undefined;
      // What is sent under the id, by which a page found there is recognised (holdsWhatWasSent): this create's, and those of the creates an earlier call sent under it.
      const sentNow = { name, sourceSha256: sha256(source) };
      const sent = [sentNow, ...(given !== undefined && Array.isArray(args.sentBefore) ? args.sentBefore : [])];
      // The content this create asks for, in the shape an update plans against — and as one hash, for the caller that keeps what it published (contentFingerprint).
      const fields = { source, name, dataSources, model, connectorBindings, actionBindings };
      const fingerprint = contentFingerprint(fields);
      // The errors of the sends whose outcome is not known (see the comment above). A resumed create starts with one: the earlier call's.
      const open = given === undefined ? [] : [genpageError(`a create an earlier build sent under id ${id}, whose outcome was never learned`)];
      // A refusal BEFORE this call sent anything. For a new create that is the whole story — nothing was written. For a resumed one an earlier call's request may still
      // land, so it is not known that nothing was written, and the error says where to look.
      const notSent = (error) => (given === undefined
        ? genpageError(`generative page ${who} was not created (nothing was written): ${messageOf(error)}`, { code: error && error.code, cause: error, outcome: 'nothing' })
        : genpageError(`generative page ${who} was not sent this time (${messageOf(error)}), but a create an earlier build sent under id ${id} was never accounted for and can still land, so whether page ${id} exists is not known. Look for page ${id} before creating it again.`, { code: error && error.code, cause: error, outcome: 'unknown', pageId: id }));
      try {
        await sdk.createArtifact('genPage', {
          id, name, source, dataSources,
          ...(model ? { model } : {}),
          ...(connectorBindings !== undefined ? { connectorBindings } : {}),
          ...(actionBindings !== undefined ? { actionBindings } : {}),
          newTurn: turn,
        });
      } catch (error) {
        throw notSent(error);
      }
      if (typeof args.beforeSend === 'function') {
        try {
          await args.beforeSend(id, { ...sentNow });
        } catch (error) {
          throw notSent(error);
        }
      }

      const warnings = [];
      const budget = budgetOf(args);
      let pushed = await pushOnce(sdk, id);
      // A first send the service refused with a throttle wrote nothing, and is waited out and sent again under the same id (pushThroughThrottle). Not when a send is already open — a resumed create: what the refusal says is then
      // about this send alone, and the request an earlier call gave up on can still land, so the refusal is judged below, by reading the page, as it always was.
      const waited = [];
      if (!open.length) pushed = await pushThroughThrottle(sdk, id, pushed, waited, budget, `generative page ${who}`);
      if (waited.length) warnings.push(throttleNote(`generative page ${who}`, waited));
      for (let send = 1; !pushed.saved; send += 1) {
        const refused = pushed.outcome === 'nothing';
        // Settled: there has been no other send, and this one is known to have written nothing.
        if (refused && !open.length) {
          const failure = { code: pushed.error && pushed.error.code, cause: pushed.error, outcome: 'nothing' };
          // A throttle that outlasted every wait — or whose next wait did not fit the budget — is the one refusal a run again can change.
          throw pushed.throttled
            ? throttledError(`generative page ${who} was not created (nothing was written): ${pushed.stopped ? waitDoesNotFit(budget, pushed.stopped) : `the service throttled all ${THROTTLE_RESENDS + 1} sends, waiting between them (${refusalWords(pushed)})`}`, throttledProps(pushed, failure))
            : genpageError(`generative page ${who} was not created (nothing was written): ${refusalWords(pushed)}`, failure);
        }
        if (!refused) open.push(pushed.error);
        // What the sends said, for a message: a refused send is named as such, because it says nothing about the ones before it.
        const said = [...open.map(messageOf), ...(refused ? [`a later send was refused: ${messageOf(pushed.error)}`] : [])].join('; ');
        const code = (open[0] && open[0].code) || (pushed.error && pushed.error.code);
        // An answer that asked to wait (a gateway's 503 with a Retry-After) is waited for before the page is read: a request still on its way has had that time to land.
        await pauseForRead(pushed.asked, budget, `generative page ${who}`);
        const found = await readServer(sdk, id);
        if (found.kind === 'unreadable') {
          throw genpageError(`generative page ${who}: the outcome of creating it is unknown (${said}), and reading the page it would have (id ${id}) failed too (${messageOf(found.error)}). It was not sent again. Look for page ${id} before creating it again.`, { code, cause: open[0] || pushed.error, outcome: 'unknown', pageId: id });
        }
        if (found.kind === 'present') {
          // A send landed — this create's, or one an earlier build made under the same id — and only its answer was lost. Whose page this is, and whether it holds all of
          // what this create asks for, are decided here, never assumed: an atomic create cannot be partial, so a page that holds neither a name nor a source anyone sent under
          // the id was changed after it was made, or is somebody else's page that came to hold an id nobody else knew.
          const page = found.page;
          if (!holdsWhatWasSent(sent, page)) {
            throw genpageError(`generative page ${who} (${id}) exists, but it is not a page any create under this id sent: ${describeDivergence(sent, page)}. It was not adopted, not sent again and not published; read the page before going on.`, { code: 'GENPAGE_CREATE_DIVERGED', outcome: 'unknown', pageId: id });
          }
          const edits = planEdits(fields, page);
          if (edits.length) {
            // Ours, but it holds what an earlier create under the id sent (another model, other data sources or bindings, or a name this one does not): brought to what this
            // create asks for by the ordinary update, which reads it again, writes only what differs, records this create's turn, publishes it and proves the publish. Publishing
            // it as it is would put the earlier content live under this create's name.
            // The update is one more write of this run, so it spends THIS create's budget — the run's, or the one this create made for itself when it was given none — and not a new one: a
            // budget the update made would give it five more minutes, and what the run (or this create's own pause before its read) already spent would not be there to refuse a wait that does not fit.
            const differing = edits.map((e) => e.key);
            let updated;
            try {
              updated = await api.update(id, { name, source, dataSources, model, connectorBindings, actionBindings, prompt: args.prompt, agentMessage: args.agentMessage, caller: args.caller, appId: args.appId, sourceFile: args.sourceFile, runtimeEvidence: args.runtimeEvidence, throttle: budget });
            } catch (error) {
              // The page exists and is not what this create asks for: whatever the update's own outcome was, this create is not "nothing" — the page is there.
              throw genpageError(`generative page ${who} (${id}) was written by a create under this id, but it holds the ${differing.join(', ')} of an earlier one, and bringing it to what this create asks for failed: ${messageOf(error)}. It was not published as it is.`, { code: error && error.code, cause: error, outcome: 'unknown', pageId: id });
            }
            return {
              pageId: id, name, publish: updated.publish, fingerprint, ...(updated.runtimeSha256 ? { runtimeSha256: updated.runtimeSha256 } : {}),
              warnings: [...warnings, `the answer to creating page ${who} was lost (${said}), but reading the id it was created under (${id}) showed a page that an earlier create under this id had written, differing from this create in ${differing.join(', ')} — so it was not sent again, and was updated to what this create asks for instead of being published as it was`, ...(updated.warnings || [])],
            };
          }
          warnings.push(`the answer to creating page ${who} was lost (${said}), but reading the id it was created under (${id}) showed that it had been written — so it was not sent again`);
          const firstPrompt = firstUserMessage(page);
          if (firstPrompt !== undefined && firstPrompt !== turn.prompt) {
            warnings.push(`page ${who} holds what this create asks for, but its first recorded prompt is that of an earlier create under this id: an update records a prompt only when it changes the page, so this create's prompt is not recorded`);
          }
          break;
        }
        // Absent: nothing has been written yet. A second send is safe under the same id; a third is not offered, and nothing is "known"
        // about a send that is still open.
        if (pushed.outcome === 'exists') {
          throw genpageError(`generative page ${who}: the service answered that page ${id} already exists, but no page ${id} can be read (${said}) — nothing is known to have been written, but a request that is still in flight can land. Look for a page with that name or id before creating it again.`, { code, cause: open[0] || pushed.error, outcome: 'unknown', pageId: id });
        }
        if (refused) {
          throw genpageError(`generative page ${who}: the outcome of creating it is unknown. A send got no usable answer (${open.map(messageOf).join('; ')}) and the send after it was refused (${messageOf(pushed.error)}), which says nothing about the first: it can still reach the service. No page ${id} can be read yet, and it was not sent again. Look for page ${id}, or a page with that name, before creating it again.`, { code, cause: open[0], outcome: 'unknown', pageId: id });
        }
        if (send >= 2) {
          throw genpageError(`generative page ${who}: creating it was sent twice and neither answer could be used (${said}), and no page ${id} can be read — nothing is known to have been written, but a request that is still in flight can land. Look for a page with that name or id before creating it again.`, { code, cause: open[0], outcome: 'unknown', pageId: id });
        }
        pushed = await pushOnce(sdk, id);
      }

      const runtimeSha256 = await runtimeEvidenceOf(sdk, id, args);
      const published = await publish(sdk, 'genPage', id, { verify: true });
      return { pageId: id, name, publish: published, fingerprint, ...(runtimeSha256 ? { runtimeSha256 } : {}), warnings: [...warnings, ...warningsOf(pushed, published, `page ${label(name, id)}`)] };
    },

    // UPDATE: read the page, write only what differs from it, record the turn, publish, and prove the published copy.
    //   args: { name, source, dataSources, model, prompt, agentMessage, connectorBindings, actionBindings, specBindings, caller, appId, sourceFile, publishedFingerprint, runtimeEvidence, throttle } (`runtimeEvidence`, `throttle`: see create)
    //   `specBindings: true` says that the binding lists given are an App Spec's: it states each entry by the properties it can carry, so they are read against the page's entries and an entry keeps what the spec could
    //   not state (planEdits, mergeBindings). Without it a list given is the page's list.
    //   A field the caller leaves out (`undefined`) is left alone — an omitted data-source list, model, name or binding list is the
    //   page's own, not an instruction to clear it; `[]` clears a list. The page's FIRST prompt is kept and the new one is recorded
    //   as a turn of its conversation (pac overwrote the first prompt on every upload).
    //   A page that differs from the new content in nothing is not written and records no turn — a rebuild stops re-sending every page —
    //   and is published all the same, because the server holds nothing that says whether an earlier run's publish of it finished: a page saved by a run whose publish
    //   failed converges here. That is one PublishXml, several seconds, for every unchanged page of every rebuild, so a caller that KNOWS better says so: `publishedFingerprint`
    //   is the `fingerprint` (contentFingerprint) a result gave it for a publish it saw take effect, and a page that already holds content with that very fingerprint is not
    //   published again (`publish.kind: 'skipped'`). It is only ever a reason not to publish a page this update has just read as already holding the content: a page that
    //   differs is written and published whatever the caller recorded, and a fingerprint that is missing or is another content's leaves the publish as it always was.
    //   With `specBindings`, the hash of the same content WITHOUT one or both of the binding lists it states is the record of a publish made before those lists were stated: it is taken for them too only when the
    //   published copy is read and holds them, and the result then says `receiptUpgraded: true` — its `fingerprint` is the hash to keep from now on.
    // The result carries the `fingerprint` of the content the page holds now, for the caller that keeps one.
    // The #722 guarantee: an update that MAY have landed is never sent again blindly. After an unknown outcome the page is read:
    //   what was sent is there, turn included   -> it landed (publish)
    //   the page is as it was before            -> nothing was written: sent ONCE more (the SDK's preflight compares the page's
    //                                              version tokens, so a page anyone changed meanwhile is refused, not overwritten)
    //   anything else                           -> refused, with where to look first. `caller: 'build'` words that for the build,
    //                                              which keeps no base marker and reads every page again when it runs; otherwise the
    //                                              standalone upload's `genpage-base.js check` (`appId` and `sourceFile` name its arguments).
    // A first send the service refuses with a throttle (HTTP 429) wrote nothing: it is waited out and sent again (pushThroughThrottle), and the SDK's version check runs again on that send, so a page someone saved meanwhile
    // is refused (`VERSION_CONFLICT`), never written over. A throttle that outlasts the waits is reported as nothing written and is not marked `transient: false`, so the build may run again. So is the read of the page that comes before any send,
    // when the run's budget had no room to wait for its throttle: `GENPAGE_UNREADABLE` with status 429 and what the service asked, nothing changed — a read that failed any other way is final, as it always was.
    async update(pageId, args = {}) {
      if (!GUID_RE.test(String(pageId || ''))) throw genpageError(`'${pageId}' is not a page id`, { code: 'GENPAGE_ID_INVALID' });
      const id = String(pageId).toLowerCase();
      const fields = contentFieldsOf(args);
      const sdk = await getSdk();
      const declinedBefore = declinedCount(args);
      const found = await readServer(sdk, id);
      if (found.kind === 'absent') throw genpageError(`page ${id} does not exist in this environment — nothing was changed`, { code: 'GENPAGE_NOT_FOUND', outcome: 'nothing', pageId: id });
      if (found.kind === 'unreadable') {
        const message = `could not read page ${id} before updating it (${messageOf(found.error)}) — nothing was changed`;
        // The read comes before any write, so a throttle the budget had no room to wait for changed nothing and is the service's to say: not final, and the build stops with the budget's halt (build-model-app.js).
        throw isThrottle(found.error) && declinedCount(args) > declinedBefore
          ? refusedReadError(message, found.error, { outcome: 'nothing', pageId: id }, args)
          : genpageError(message, { code: 'GENPAGE_UNREADABLE', cause: found.error, outcome: 'nothing', pageId: id });
      }
      let baseline = found.page;
      const who = () => label(baseline.name, id);
      if (typeof baseline.source !== 'string') {
        throw genpageError(`page ${who()} has no source this tool can edit: its rows are not laid out as the maker lays them out, so it is held as raw files. Nothing was changed — edit it in Maker.`, { code: 'GENPAGE_NO_SOURCE', outcome: 'nothing', pageId: id });
      }
      // The turn this update records carries its identity from here on. The SDK derives the ids of the turn's two messages from it, so a
      // send that is repeated — ours, or one still in flight from before — addresses the SAME message rows: the atomic change set that comes
      // second collides on them and is rolled back whole, and the conversation never holds the turn twice. The SDK mints an identity of its
      // own when it has none, but only in the copy it keeps of the page, and a read that settles an unknown outcome replaces that copy
      // with the server's (`fetchArtifact` with `overwrite`): the resend would then be a new turn, and both would land.
      // `newTurn.id` is documented as the SDK's to mint ("do not author it"); what the SDK checks, in the vendored GenPageAdapter's
      // `validate` and `normalize`, is only that it is a GUID — it keeps one it is given, and derives the message ids from its digits.
      const turn = { ...turnOf({ prompt: args.prompt, agentMessage: args.agentMessage }, fields.name || baseline.name), id: String(newTurnId()).toLowerCase() };
      const warnings = [];
      // The lists a caller gives as an App Spec's (see planEdits) are read against the page's entries; every other caller's replace them.
      const specBindings = args.specBindings === true;
      const planFor = (page) => planEdits(fields, page, { specBindings });
      const fingerprint = contentFingerprint(fields);
      let edits = planFor(baseline);
      if (!edits.length) {
        // Already published, by the caller's own record: nothing was written, so there is nothing to publish, and the page is not asked to publish again. A hash from another content,
        // or none, is the answer "not known", and the page is published (see above).
        if (typeof args.publishedFingerprint === 'string' && args.publishedFingerprint === fingerprint) {
          return { pageId: id, unchanged: true, publish: { kind: 'skipped', detail: 'the page already holds this content, and the caller recorded that this content was published' }, fingerprint, warnings: [] };
        }
        // A record made before the caller stated a binding list is the hash of this content WITHOUT it — the build's record of every page it published before a download wrote the lists into the spec (both lists),
        // or before a spec stated the second of them (one: a list a download could not state, or one the author took out of the spec to keep the page's own, stated again). The page holds them now (nothing is left
        // to write), and the caller's record says that nothing has touched the page since that publish, so the lists were published with it: but the record never named them, and it is only taken for them once the
        // PUBLISHED copy is read and found to hold them too (one read of the published layer, never a write). The answer says so (`receiptUpgraded`), so the caller keeps the hash it was given now, and a later
        // update finds it as it is. A copy that does not hold them — or cannot be read — leaves the page to be published, as it always was.
        if (specBindings && typeof args.publishedFingerprint === 'string' && fingerprintsBeforeListsWereStated(fields).includes(args.publishedFingerprint)
          && await publishedCopyHolds(sdk, id, fields, { specBindings })) {
          return { pageId: id, unchanged: true, publish: { kind: 'skipped', detail: 'the page already holds this content, the caller recorded that this content was published before its binding lists were stated, and the published copy holds them' }, fingerprint, receiptUpgraded: true, warnings: [] };
        }
        const runtimeSha256 = await runtimeEvidenceOf(sdk, id, args);
        const published = await publish(sdk, 'genPage', id, { verify: true });
        return { pageId: id, unchanged: true, publish: published, fingerprint, ...(runtimeSha256 ? { runtimeSha256 } : {}), warnings: warningsOf(null, published, `page ${who()}`) };
      }

      // Where to look before an update that may have landed is run again.
      const lookFirst = () => {
        if (args.caller === 'build') {
          return 'Run the build again: it reads the page first, so an update that did land is not sent again and records nothing twice; one that did not is sent once more.';
        }
        const { commandArgOrPlaceholder } = require('./cli-failure.js');
        const file = commandArgOrPlaceholder(args.sourceFile || '<file>', '<file>');
        return `First see what is deployed: node scripts/genpage-base.js check --env ${env} --app-id ${args.appId || '<app-id>'} --page-id ${id} --file ${file.arg} ("contentSame": true means the update landed; "deployed": "unchanged" means it did not). ${file.note ? `${file.note} ` : ''}Then re-run the upload: its own checks decide whether it may go ahead.`;
      };

      const apply = async () => {
        for (const { key, value } of edits) {
          // `updateElement` replaces a value the page has; `addElement` adds the key a page does not carry yet (a model, a binding).
          if (key === 'source' || key === 'name' || baseline[key] !== undefined) await sdk.updateElement('genPage', id, `/${key}`, value);
          else await sdk.addElement('genPage', id, '', { [key]: value });
        }
        await sdk.addElement('genPage', id, '', { newTurn: turn });
      };
      const wanted = () => {
        const want = projectionOf(baseline);
        for (const { key, value } of edits) want[key] = value;
        return want;
      };

      try {
        await apply();
      } catch (error) {
        throw genpageError(`the update of generative page ${who()} was refused before anything was written: ${messageOf(error)}`, { code: error && error.code, cause: error, outcome: 'nothing', pageId: id });
      }
      // A first send the service refused with a throttle wrote nothing, and is waited out and sent again — the SDK's version check runs again on each push (pushThroughThrottle).
      const waited = [];
      const budget = budgetOf(args);
      let pushed = await pushThroughThrottle(sdk, id, await pushOnce(sdk, id), waited, budget, `generative page ${who()}`);
      if (waited.length) warnings.push(throttleNote(`generative page ${who()}`, waited));
      for (let send = 1; !pushed.saved; send += 1) {
        // The one outcome that is known: the first send is the only one so far, and it wrote nothing. A version conflict is that when it is the first —
        // the SDK compared the page's version tokens before it wrote anything and found them moved — and so is a refusal or a 4xx. Every later failure
        // is read first: a send whose answer was lost is still open, it can reach the service after this send, a refusal of the resend or a page
        // that reads as it was says nothing about it, and the tokens a version conflict names may be its own.
        if (send === 1 && pushed.outcome === 'conflict') {
          throw genpageError(`the update of generative page ${who()} was refused because the page was changed by someone else after it was read, and nothing was written (${messageOf(pushed.error)}). Read the page again and apply the change to what it holds now.`, { code: 'VERSION_CONFLICT', cause: pushed.error, outcome: 'nothing', pageId: id });
        }
        if (send === 1 && pushed.outcome === 'nothing') {
          const failure = { code: pushed.error && pushed.error.code, cause: pushed.error, outcome: 'nothing', pageId: id };
          // A throttle that outlasted every wait — or whose next wait did not fit the budget — is the one refusal a run again can change.
          throw pushed.throttled
            ? throttledError(`the update of generative page ${who()} failed and wrote nothing: ${pushed.stopped ? waitDoesNotFit(budget, pushed.stopped) : `the service throttled all ${THROTTLE_RESENDS + 1} sends, waiting between them (${refusalWords(pushed)})`}`, throttledProps(pushed, failure))
            : genpageError(`the update of generative page ${who()} failed and wrote nothing: ${refusalWords(pushed)}`, failure);
        }
        // An answer that asked to wait (a gateway's 503 with a Retry-After) is waited for before the page is read: a request still on its way has had that time to land.
        await pauseForRead(pushed.asked, budget, `generative page ${who()}`);
        const now = await readServer(sdk, id);
        if (now.kind !== 'present') {
          throw genpageError(`the update of generative page ${who()} MAY HAVE LANDED (${messageOf(pushed.error)}), and ${now.kind === 'absent' ? 'the page can no longer be read — it was deleted' : `reading it failed (${messageOf(now.error)})`}. It was NOT sent again. ${lookFirst()}`, { code: pushed.error && pushed.error.code, cause: pushed.error, outcome: 'unknown', pageId: id });
        }
        if (isDeepStrictEqual(projectionOf(now.page), wanted()) && turnRecorded(now.page.conversation, baseline.conversation, turn)) {
          warnings.push(`the answer to updating page ${who()} was lost (${messageOf(pushed.error)}), but reading it showed the update, and its turn, had been written — so it was not sent again`);
          break;
        }
        const asBefore = isDeepStrictEqual(projectionOf(now.page), projectionOf(baseline)) && (now.page.conversation || []).length === (baseline.conversation || []).length;
        if (!asBefore) {
          throw genpageError(`the update of generative page ${who()} MAY HAVE LANDED or been overtaken (${messageOf(pushed.error)}): the page now holds neither what this update sent nor what it held before — it was saved by someone else, or only part of it is there. It was NOT sent again: a second send would overwrite whatever was saved since. ${lookFirst()}`, { code: pushed.error && pushed.error.code, cause: pushed.error, outcome: 'unknown', pageId: id });
        }
        // The page is as it was: nothing has landed YET. Once more, from what the page holds now (its version tokens are the ones just read), with the SAME turn.
        // After two sends it is not "nothing was written" either: the page reading as it was is a snapshot, and a send whose answer was lost can still land.
        if (send >= 2) {
          throw genpageError(`the update of generative page ${who()} was sent twice and neither answer could be used (${messageOf(pushed.error)}); reading the page shows nothing was written yet, but a send whose answer was lost can still land. It was NOT sent a third time. ${lookFirst()}`, { code: pushed.error && pushed.error.code, cause: pushed.error, outcome: 'unknown', pageId: id });
        }
        baseline = now.page;
        edits = planFor(baseline);
        if (!edits.length) break;
        try {
          await apply();
        } catch (error) {
          // The first send is still open, so "nothing was written" cannot be said about the update — only that this send was never made.
          throw genpageError(`the update of generative page ${who()} MAY HAVE LANDED (${messageOf(pushed.error)}), and sending it once more was refused before anything was sent (${messageOf(error)}). It was NOT sent again. ${lookFirst()}`, { code: error && error.code, cause: error, outcome: 'unknown', pageId: id });
        }
        pushed = await pushOnce(sdk, id);
      }

      const runtimeSha256 = await runtimeEvidenceOf(sdk, id, args);
      const published = await publish(sdk, 'genPage', id, { verify: true });
      return { pageId: id, publish: published, fingerprint, ...(runtimeSha256 ? { runtimeSha256 } : {}), warnings: [...warnings, ...warningsOf(pushed, published, `page ${who()}`)] };
    },

    // Place pages into an app that exists, as the app designer does: each page becomes a sub-area of the app's navigation (the shape
    // genPageSubArea gives it), and the default public view of every table in `dataSources` joins the app's components so the
    // maker's "/" picker lists the table — pac's upload pinned those views, and the SDK's page write does not.
    //   options: { pages: [{ pageId, title }], dataSources: [table…], languageCode, finish, finishIfUnpublished, beforeAppWrite }
    // One app edit at most: the app is read, the navigation and the components are edited, then it is pushed and published. A page the
    // navigation already names, and a view the app already holds, are left alone; when nothing is missing nothing is written.
    // The push changes the sitemap and adds the views pinned here — NOTHING else of the app's components. The SDK's own push would also add every
    // active Main form, public view and chart of each table the navigation opens (and each dashboard it names), which puts back what the app's
    // maker took out of the app and publishes it; the transport it is given limits its AddAppComponents to the views this edit owns (`appScope`,
    // lib/app-component-scope.js). It is the same for the build's pin of its pages' tables, which is this call with no page.
    // The sub-area goes in the first group that already holds a page, else the first group of the first area (an app has at least
    // one: the SDK refuses a navigation without an area that holds a group). Sitemap titles are written in the SDK's language
    // (`languageCode`, default the SDK's own).
    // `finish` is for a caller COMPLETING a placement an earlier run began (an upload that created the page and could not place it). That run may
    // have saved the navigation and then failed to publish the app, and a saved placement is not a published one: the page shows in the app only
    // once the app is published. So with `finish` the app is published even when its saved navigation already names the page and nothing is left
    // to write, and the placement is not reported done while the app's PUBLISHED navigation can be read and does not name every page asked for
    // (`GENPAGE_APP_PUBLISH_UNPROVEN`); `provedPublished` says it was seen to. Without `finish`, a placement that has nothing to do touches nothing —
    // not even a publish.
    // `finishIfUnpublished` is the same completion for a caller that has no record of an earlier run to say one is owed — `add-to-app` — and asks the APP: a page this call adds is
    // published and proven, as with `finish`; for pages the saved navigation already names, the published navigation is read once, and the app is published, and proven, only when
    // it does not show every page asked for (an app that was never published, or whose published navigation cannot be read, does not show them). Pages both layers name are left exactly as they are.
    // `beforeAppWrite` is an async function the caller wants run, and awaited, once, right before this call first writes the app — its push, or its publish when there is nothing to push — and not at all
    // for a placement that writes and publishes nothing. The build uses it to publish the tables whose forms the app's publish would otherwise leave their saved labels out of (lib/sdk-build.js
    // publishTablesBeforeApp): this call pushes and publishes the app by itself, so only it knows when that is about to happen, and what it is about to send. The edits are by then made in this
    // operation's workspace copy only, so a hook that throws leaves the app as it was, and the call throws what the hook threw.
    // The hook is told what the write is: `{ pushes, entityTables, mainFormsByTable }`. `pushes` says whether the app is pushed (false: it is only published, so nothing is added to it); `entityTables` are the
    // tables whose Main forms THIS push adds, and `mainFormsByTable` is the Main-form list the pushed app carries (a fetched app carries none), or undefined. The SDK expands the Entity entries of the
    // navigation it pushes — the one the server holds: this call fetches the app, adds the page entries and the views it was asked for, and pushes that — into their active Main forms, public views and
    // charts; but on the transport of an SDK this backend made, the push's AddAppComponents is cut down to the views this edit pins (`appScope`, `pushApp`), so it adds no Main form and
    // `entityTables` is empty. Only through a lent SDK, whose transport is its owner's, does the push add them all: then `entityTables` is the tables of those Entity entries (`entityTablesOfSiteMap`).
    // Returns { added: [pageId…], alreadyPlaced: [pageId…], pinnedViews: [viewId…], warnings: [...], appEdited, provedPublished? }. It throws, with
    // the page unplaced, when the app cannot be read, the edit is refused, `beforeAppWrite` throws, or the app's publish fails — and with `finish`, when the published
    // navigation does not show the page after the app was published.
    async placeInApp(appId, options = {}) {
      if (!GUID_RE.test(String(appId || ''))) throw genpageError(`'${appId}' is not an app id`, { code: 'GENPAGE_ID_INVALID' });
      const sdk = await getSdk(options.languageCode || deps.languageCode);
      const warnings = [];
      let app;
      try {
        app = await sdk.fetchArtifact('app', appId, { overwrite: true });
      } catch (error) {
        throw genpageError(`cannot read app ${appId} to place pages in it: ${messageOf(error)}`, { code: error && error.code, cause: error });
      }
      const placed = new Set(genPagesOfSiteMap(app.siteMap).map((p) => p.pageId.toLowerCase()));
      const wantedPages = (options.pages || []).filter((p) => p && p.pageId);
      const alreadyPlaced = wantedPages.filter((p) => placed.has(String(p.pageId).toLowerCase())).map((p) => String(p.pageId));
      const added = wantedPages.filter((p) => !placed.has(String(p.pageId).toLowerCase()));
      let edited = false;

      if (added.length) {
        const entries = added.map((p) => genPageSubArea({ id: genPageSubAreaId(p.pageId), title: String(p.title || p.name || 'Generative page') }, String(p.pageId)));
        const areas = (app.siteMap && app.siteMap.areas) || [];
        let target = null;
        areas.forEach((area, a) => (area.groups || []).forEach((group, g) => {
          if (!target && (group.subAreas || []).some((s) => s && s.type === 'GenPage')) target = { a, g, group };
        }));
        if (!target && areas.length && (areas[0].groups || []).length) target = { a: 0, g: 0, group: areas[0].groups[0] };
        if (target) {
          const where = `/siteMap/areas/${target.a}/groups/${target.g}`;
          if (Array.isArray(target.group.subAreas)) await sdk.updateElement('app', appId, `${where}/subAreas`, [...target.group.subAreas, ...entries]);
          else await sdk.addElement('app', appId, where, { subAreas: entries });
        } else {
          // No navigation to join: the SDK needs a non-empty area with a non-empty group, so the pages make one.
          const area = { id: 'area_genpages', title: 'Pages', groups: [{ id: 'group_genpages', title: 'Pages', subAreas: entries }] };
          if (Array.isArray(areas) && app.siteMap) await sdk.updateElement('app', appId, '/siteMap/areas', [...areas, area]);
          else await sdk.addElement('app', appId, '', { siteMap: { areas: [area] } });
        }
        edited = true;
      }

      const pin = await viewsToPin(sdk, appId, options.dataSources, warnings);
      if (pin.length) {
        const components = app.components;
        if (components === undefined) await sdk.addElement('app', appId, '', { components: { views: pin } });
        else if (components.views === undefined) await sdk.addElement('app', appId, '/components', { views: pin });
        else await sdk.updateElement('app', appId, '/components/views', [...components.views, ...pin]);
        edited = true;
      }
      // Nothing missing: an ordinary placement writes nothing. A completing one still has to see the app published (see `finish`, above): the earlier run may
      // have saved the navigation and failed to publish it, which leaves nothing to write and everything still to publish.
      let finishing = options.finish === true && wantedPages.length > 0;
      if (!finishing && options.finishIfUnpublished === true && wantedPages.length > 0) {
        if (added.length) {
          finishing = true;
        } else {
          const shown = await publishedPagesOf(sdk, appId);
          // An app that was never published, or whose published navigation cannot be read, shows none of them.
          const showing = new Set(shown.ok ? shown.pages.map((p) => String(p.pageId).toLowerCase()) : []);
          finishing = wantedPages.some((p) => !showing.has(String(p.pageId).toLowerCase()));
        }
      }
      if (!edited && !finishing) return { added: [], alreadyPlaced, pinnedViews: [], warnings, appEdited: false };

      // The first thing sent to the app is below: the caller's word comes before it (see `beforeAppWrite`, above), and it is told what the write is.
      if (typeof options.beforeAppWrite === 'function') {
        const limited = madeHere.has(sdk);
        await options.beforeAppWrite({ pushes: edited, entityTables: limited ? [] : entityTablesOfSiteMap(app.siteMap), mainFormsByTable: app.components && app.components.mainFormsByTable });
      }
      if (edited) await pushApp(sdk, appId, warnings, appScope, { views: pin });
      const published = await publish(sdk, 'app', appId, undefined);
      // The failures below name the app and the page(s) the caller asked for, as `removeFromApp`'s do, so a caller that prints one can go on from it.
      const asked = wantedPages.map((p) => String(p.pageId));
      const who = { appId, ...(asked.length === 1 ? { pageId: asked[0] } : asked.length > 1 ? { pageIds: asked } : {}) };
      if (published.kind === 'failed') {
        // What the failed publish left saved is what THIS call saved: the navigation when it added a page — or when it completes a placement an earlier run saved, which leaves nothing to edit — and the default views
        // of the tables when it pinned any. A call that only pinned views, for a page the navigation already names, has not touched the navigation.
        const navigation = added.length > 0 || pin.length === 0;
        const saved = navigation && pin.length > 0 ? `the navigation of app ${appId} and the default views of the tables the pages read were saved`
          : navigation ? `the navigation of app ${appId} was saved`
            : `the default views of the tables the pages read were saved in app ${appId}`;
        throw genpageError(`${saved}, but publishing the app failed (${published.detail}) — ${navigation ? "the pages are in the app's saved navigation and show once it is published" : 'they take effect once the app is published'}`, { code: 'GENPAGE_APP_PUBLISH_FAILED', saved: true, ...who });
      }
      const result = { added: added.map((p) => String(p.pageId)), alreadyPlaced, pinnedViews: pin, warnings, appEdited: edited };
      if (!finishing) return result;

      // The publish was accepted (a refused one threw above); what runs is the app's published navigation, so that is what confirms it. PublishXml is asynchronous
      // (the SDK reports an unconfirmed publish as unverifiable, never as failed), so a page that is not listed yet is not a failed publish — but it is not a finished
      // placement either, and the answer is to run the completion again. A published navigation that cannot be read at all contradicts nothing: the publish was
      // accepted, the placement is saved, and the page is shown once it is seen to be — it is said in a warning, not hidden.
      const shown = await publishedPagesOf(sdk, appId);
      if (!shown.ok) {
        warnings.push(`app ${appId} was published again, but its published navigation could not be read back to confirm that ${wantedPages.length === 1 ? 'the page shows' : 'the pages show'} (${shown.error}) — treat ${wantedPages.length === 1 ? 'it' : 'them'} as live only once seen to be`);
        return { ...result, provedPublished: false };
      }
      const showing = new Set(shown.pages.map((p) => String(p.pageId).toLowerCase()));
      const missing = wantedPages.map((p) => String(p.pageId)).filter((id) => !showing.has(id.toLowerCase()));
      if (missing.length) {
        throw genpageError(`app ${appId} was published, but its published navigation does not show ${missing.length === 1 ? 'page' : 'pages'} ${missing.join(', ')} yet (it is not listed) — the placement is saved in the app's navigation, and shows once the app's publish has taken effect. Run the same command again to check, or publish the app in Maker`, { code: 'GENPAGE_APP_PUBLISH_UNPROVEN', saved: true, ...who });
      }
      return { ...result, provedPublished: true };
    },

    // Take a page out of an app's navigation: every GenPage sub-area that names it goes, whichever area and group it sits in (the SDK refuses a second sub-area for one target in a sitemap it validates, so
    // one is what there normally is, but a sitemap edited elsewhere may hold two). Only the entry goes. The page stays, the views `placeInApp` pinned for its tables stay in the app's components (another
    // page or table of the app is as likely to need them, and nothing here can tell), and so does every other entry — an emptied group or area is left as it is, which the platform accepts.
    //   options: { allowEmpty, languageCode }
    // An EXISTING app accepts a navigation with no entry at all when it is updated (measured; the platform refuses one only when a sitemap is CREATED), so nothing but this check stops it, and it is a
    // judgement and not a rule of the platform: an app whose last entry is taken out opens on nothing, which is rarely what "remove this page" meant. So it is refused before anything is written
    // (`GENPAGE_NAVIGATION_WOULD_BE_EMPTY`) unless the caller says `allowEmpty`, a deliberate choice of the same kind as the build's `--allow-destructive` for a spec that empties a navigation.
    // One app edit at most, as for `placeInApp`: the app is read, the entries are taken out, it is pushed and published, and the PUBLISHED navigation is read back. Nothing is ADDED to the app's components: the SDK's push
    // would add every active Main form, public view and chart of each table the remaining navigation opens, which puts back what the app's maker took out of it, so the push is limited to the sitemap (`appScope`,
    // lib/app-component-scope.js). The publish is not optional. The app's users see the page
    // until the app is published, so a removal that was saved and not published is not one — and the platform keeps an app's reference to a page until a sitemap without it is published (sdk-teardown.js records the
    // measurement), so the page cannot be deleted before that, which is what a removal is usually for. That holds for an app that was NEVER published as well: nothing runs from it, but the removal publishes it all the same —
    // everything the app has saved goes live — and a warning says so.
    // A page the SAVED navigation does not name has nothing to write, and what follows depends on what is KNOWN of the published layer. It names the page (a maker saved the removal and never published it, or an earlier run saved
    // it and its publish failed): the app is published, so that "removed" is true of what runs. It does not, or the app was never published: neither layer names the page — reported as not in the navigation
    // (`wasInNavigation: false`), nothing written or published. The app has a published form whose navigation cannot be read: the saved removal may be the one that was never published, and "not in the navigation" would be a
    // success the app that runs may contradict, so the app is published (as `placeInApp` does for a placement it cannot see in what runs), `wasInNavigation` is null — not known — and `provedPublished` is false unless the
    // read-back works. A lookup the SDK failed before it could tell whether the app has a published form at all is `GENPAGE_APP_UNREADABLE`, with nothing changed: publishing on a guess could make a draft app live.
    // Returns { removed: [{ area, group, count }], wasInNavigation: true | false | null, appEdited, published, entriesLeft, provedPublished?, warnings } — `published` is whether this run published the app, `entriesLeft` how many entries of any
    // kind the saved navigation has once the page is out. It throws, with the page still in the app, when the app cannot be read, the edit is refused, or the check above fails — and with `saved: true` when the removal was saved
    // and the app's publish failed (`GENPAGE_APP_PUBLISH_FAILED`) or its published navigation still names the page (`GENPAGE_APP_PUBLISH_UNPROVEN`).
    async removeFromApp(appId, pageId, options = {}) {
      const app = guidOf(appId, 'app');
      const page = guidOf(pageId, 'page');
      const sdk = await getSdk(options.languageCode || deps.languageCode);
      const warnings = [];
      let current;
      try {
        current = await sdk.fetchArtifact('app', app, { overwrite: true });
      } catch (error) {
        throw genpageError(`cannot read app ${app} to take page ${page} out of it: ${messageOf(error)}`, { code: error && error.code, cause: error });
      }
      const edits = [];
      let left = 0;
      ((current.siteMap && current.siteMap.areas) || []).forEach((area, a) => (area.groups || []).forEach((group, g) => {
        const subAreas = Array.isArray(group.subAreas) ? group.subAreas : [];
        const kept = subAreas.filter((s) => !(s && s.type === 'GenPage' && String(s.genPageId || '').toLowerCase() === page));
        left += kept.length;
        if (kept.length !== subAreas.length) edits.push({ a, g, kept, area: area.title, group: group.title, count: subAreas.length - kept.length });
      }));
      const removed = edits.map(({ area, group, count }) => ({ area, group, count }));
      // `wasInNavigation` is true when a layer named the page, false when neither does — and that has to be KNOWN: a published navigation that could not be read does not "not name" the page — and null for a page
      // the saved navigation does not name while the published one could not be read. `published` is whether THIS run published the app.
      const answer = (wasInNavigation, published) => ({ removed, wasInNavigation, appEdited: edits.length > 0, published, entriesLeft: left, warnings });
      let wasInNavigation = true;
      let unreadableBefore = null;

      if (!edits.length) {
        const shown = await publishedPagesOf(sdk, app);
        // Neither layer names the page, and that is known: the published navigation was read and does not, or the app has none because it was never published (nothing runs from it).
        if (shown.ok ? !shown.pages.some((p) => String(p.pageId).toLowerCase() === page) : shown.neverPublished === true) return answer(false, false);
        if (!shown.ok) {
          // The SDK failed before it could tell whether the app has a published form at all: publishing on that would make a draft app live, and "not in the navigation" would be a guess, so nothing is done.
          if (shown.lookupFailed) {
            throw genpageError(`${shown.error}, so it is not known whether page ${page} still shows in the app that runs. Nothing was changed; run the same command again once the app can be read`, { code: 'GENPAGE_APP_UNREADABLE', outcome: 'nothing', appId: app, pageId: page });
          }
          // The app HAS a published form whose navigation cannot be read. A removal that was saved and whose publish failed (GENPAGE_APP_PUBLISH_FAILED says to run it again) looks exactly like this on the re-run: the saved
          // navigation is without the page and the one that runs may still name it. Reporting "not in the navigation" would be a success the app that runs may contradict, so the app is published — what
          // `placeInApp` does for a placement it cannot see in what runs — and the read-back says whether that could be proved.
          wasInNavigation = null;
          unreadableBefore = shown.reason;
        }
      }
      if (left === 0 && options.allowEmpty !== true) {
        throw genpageError(`taking page ${page} out of app ${app} would leave its navigation with no entry: the platform accepts that on an app that exists, but the app would open on nothing. Nothing was changed. Add the entry that should replace it first, or — if an app with an empty navigation is what is meant — ask for it explicitly (genpage.js remove-from-app --allow-empty-navigation)`, { code: 'GENPAGE_NAVIGATION_WOULD_BE_EMPTY', outcome: 'nothing', appId: app, pageId: page });
      }
      // Whether the app has ever been published, asked BEFORE the publish (afterwards every app has): it is only for the note below, so a read that fails does not stop the removal.
      let neverPublished = false;
      if (edits.length) {
        try {
          neverPublished = (await publishedFormOf(sdk, app)) === null;
        } catch { /* the removal goes on without the note */ }
      }
      for (const { a, g, kept } of edits) await sdk.updateElement('app', app, `/siteMap/areas/${a}/groups/${g}/subAreas`, kept);
      if (edits.length) await pushApp(sdk, app, warnings, appScope, { views: [] });
      const published = await publish(sdk, 'app', app, undefined);
      if (published.kind === 'failed') {
        const saved = edits.length ? `taken out of the saved navigation of app ${app}` : `already out of the saved navigation of app ${app}`;
        throw genpageError(`page ${page} was ${saved}, but publishing the app failed (${published.detail}) — it still shows in the app that runs until the app is published`, { code: 'GENPAGE_APP_PUBLISH_FAILED', saved: true, appId: app, pageId: page });
      }
      const result = answer(wasInNavigation, true);
      if (neverPublished) {
        warnings.push(`app ${app} had never been published; taking the page out published it — the platform keeps its reference to the page until a sitemap without it is published, and publishing publishes everything the app has saved`);
      }
      if (unreadableBefore !== null) {
        warnings.push(`the published navigation of app ${app} could not be read (${unreadableBefore}), so it is not known whether page ${page} still shows in the app that runs — the app was published so that what runs is its saved navigation, which does not name the page`);
      }
      // What runs is the published navigation, so that is what confirms the removal (see `placeInApp`: PublishXml is asynchronous, so a page still listed is not a failed publish, and not a finished removal either).
      const shown = await publishedPagesOf(sdk, app);
      if (!shown.ok) {
        warnings.push(`app ${app} was published, but its published navigation could not be read back to confirm that page ${page} no longer shows (${shown.error}) — treat it as gone only once seen to be`);
        return { ...result, provedPublished: false };
      }
      if (shown.pages.some((p) => String(p.pageId).toLowerCase() === page)) {
        throw genpageError(`app ${app} was published, but its published navigation still names page ${page} — the removal is saved in the app's navigation, and shows once the app's publish has taken effect. Run the same command again to check, or publish the app in Maker`, { code: 'GENPAGE_APP_PUBLISH_UNPROVEN', saved: true, appId: app, pageId: page });
      }
      return { ...result, provedPublished: true };
    },

    // One page's identity and size, for a caller that does not need its source (see `describeOf`). `read` refuses a page the SDK holds as raw files — it has no source to hand back — but such a page has a name,
    // can be placed in an app and can be deleted, so a caller that only places, lists or deletes reads it here, where it is `editable: false` and its `dataSources` are `null`. It throws `GENPAGE_NOT_FOUND`
    // for a page that is not there and `GENPAGE_UNREADABLE` for one that cannot be read.
    async describe(pageId) {
      const id = guidOf(pageId, 'page');
      return describeOf(await presentPage(await getSdk(), id), id);
    },

    // DELETE a page: the project row (its file rows go with it) and then the conversation messages that point at it — the SDK's own delete, which removes them in that order so that a page the platform refuses
    // loses nothing. What this adds is what the SDK cannot know:
    //   1. The page is read first (`GENPAGE_NOT_FOUND` when it is not there), and what it held is what is reported as deleted.
    //   2. No app's navigation may name it. Dataverse refuses to delete a page an app's sitemap still references (HTTP 400, "referenced by N other components"; see sdk-teardown.js), without saying WHICH app —
    //      and an app's saved navigation counts as much as its published one, as sdk-teardown.js measured — so the apps are looked up here with the scan the build uses for shared pages (every app's published AND saved navigation,
    //      apps that were never published included) and named, so the caller can take the page out of each with `removeFromApp` first (`GENPAGE_IN_APP`, nothing deleted). The scan fails closed:
    //      an app whose navigation cannot be read could be the one that holds the page (`GENPAGE_APPS_UNREADABLE`, nothing deleted).
    //   3. Nothing is deleted unless the caller says it means it: `options.allowDestructive` must be exactly `true` (the plugin's word for a destructive run, as in the build and teardown), or the answer is
    //      `GENPAGE_DELETE_NOT_CONFIRMED`, which says what a confirmed run would remove — the page, its file rows, its conversation messages. It comes AFTER 1 and 2, the reads that decide the delete, so it is only
    //      said of a delete that would otherwise have gone ahead, and the SDK (which deletes the moment it is asked) is not asked before.
    //   4. What the delete did is settled by reading the page again. A failure that is not the SDK's "history not fully removed" is judged by that read: the page still there means nothing was deleted
    //      (`outcome: 'nothing'`); the page gone means the delete landed and its answer was lost — the conversation messages are deleted AFTER the project, so those were not touched, and it is said;
    //      a page that cannot be read leaves it unknown (`outcome: 'unknown'`, with the id to look for).
    // Returns { pageId, name, deleted: true, fileRows, conversationMessages, historyRemoved, verified, warnings }: `historyRemoved` is false when some of the conversation messages remain (a warning names the SDK's
    // words), `verified` that the page was read back as gone.
    async delete(pageId, options = {}) {
      const id = guidOf(pageId, 'page');
      const sdk = await getSdk();
      const page = describeOf(await presentPage(sdk, id), id);
      const who = label(unescapePacName(page.name), id);
      const apps = await appsNaming(sdk, id);
      if (apps.length) {
        const text = apps.map((a) => `${a.name ? `${JSON.stringify(a.name)} (${a.uniqueName}${a.appId ? `, id ${a.appId}` : ''})` : a.uniqueName}${a.savedOnly ? ' [saved, not published]' : ''}`).join(', ');
        throw genpageError(`page ${who} was not deleted: ${apps.length === 1 ? 'the navigation of this app names it' : `the navigation of these ${apps.length} apps names it`} — ${text}. Dataverse refuses to delete a page an app still names, and an app left pointing at a deleted page shows an error where the page was. Take the page out of ${apps.length === 1 ? 'that app' : 'each of them'} first (genpage.js remove-from-app), then delete it.`, { code: 'GENPAGE_IN_APP', outcome: 'nothing', pageId: id, apps });
      }
      if (!(options && options.allowDestructive === true)) {
        const rows = `${page.fileRows} file ${page.fileRows === 1 ? 'row' : 'rows'}`;
        const messages = `${page.conversationMessages} conversation ${page.conversationMessages === 1 ? 'message' : 'messages'}`;
        throw genpageError(`page ${who} was not deleted: deleting it removes the page, its ${rows} and its ${messages}. Nothing was changed; run the same command with --allow-destructive to delete them`, { code: 'GENPAGE_DELETE_NOT_CONFIRMED', outcome: 'nothing', pageId: id, fileRows: page.fileRows, conversationMessages: page.conversationMessages });
      }
      const warnings = [];
      let historyRemoved = true;
      try {
        await sdk.deleteRemoteArtifact('genPage', id);
      } catch (error) {
        if (error && error.code === 'GENPAGE_HISTORY_NOT_DELETED') {
          historyRemoved = false;
          warnings.push(`page ${who} was deleted, but its conversation history was not fully removed: ${messageOf(error)}`);
        } else {
          const now = await readServer(sdk, id);
          if (now.kind === 'present') throw genpageError(`page ${who} was not deleted: ${messageOf(error)}`, { code: error && error.code, cause: error, outcome: 'nothing', pageId: id });
          if (now.kind === 'unreadable') throw genpageError(`deleting page ${who} failed (${messageOf(error)}), and reading the page to see whether it is gone failed too (${messageOf(now.error)}) — it is not known whether it was deleted. Look for page ${id} before running this again.`, { code: error && error.code, cause: error, outcome: 'unknown', pageId: id });
          historyRemoved = false;
          warnings.push(`the answer to deleting page ${who} was lost (${messageOf(error)}), but the page is gone — the conversation messages are deleted after the page, so this call did not remove its ${page.conversationMessages} message(s), and they may remain`);
        }
      }
      // The delete is only reported once the page is read back as gone: "deleted" is the claim a caller acts on.
      const after = await readServer(sdk, id);
      if (after.kind === 'present') {
        throw genpageError(`the delete of page ${who} was accepted, but the page can still be read — it is not proven deleted. Look at page ${id} before running this again.`, { code: 'GENPAGE_DELETE_UNPROVEN', outcome: 'unknown', pageId: id });
      }
      if (after.kind === 'unreadable') warnings.push(`page ${who} was deleted, but reading it back to confirm failed (${messageOf(after.error)})`);
      return { pageId: id, name: page.name, deleted: true, fileRows: page.fileRows, conversationMessages: page.conversationMessages, historyRemoved, verified: after.kind === 'absent', warnings };
    },

    // The RuntimeTypes TypeScript a page is authored against, for these tables, read from the environment now (the SDK's `generateGenPageRuntimeTypes`: nothing is written, and no compiler is loaded). `options.detail`
    // is the SDK's own — 'None' (the default: exactly the text a compiled page's enums come from), 'ColorsDefaultsConstraints' or 'ColorsDefaultsConstraintsDescriptions' — and only adds comments. The tables are
    // made the way a page's `dataSources` are (trimmed, lower-cased, each once: a table named twice in a list typed by hand is the same table, where the SDK refuses a page that holds one twice), and a list with
    // none is refused: the SDK would answer the base declarations alone, which is not what asking for a table's types means.
    async runtimeTypes(dataSources, options = {}) {
      const tables = [...new Set(dataSourcesOf(dataSources) || [])];
      if (!tables.length) throw genpageError('runtimeTypes needs at least one table', { code: 'GENPAGE_DATA_SOURCES_REQUIRED', outcome: 'nothing' });
      const sdk = await getSdk();
      try {
        return await sdk.generateGenPageRuntimeTypes(tables, options && options.detail ? { detail: options.detail } : undefined);
      } catch (error) {
        const missing = missingTableOf(error, tables);
        if (missing === null) throw error;
        throw genpageError(`table '${missing}' does not exist in this environment, so no types were generated — a table is named by its logical name (e.g. 'account', or 'contoso_project' for a custom table with its publisher prefix), not by its display name`, { code: 'GENPAGE_TABLE_NOT_FOUND', table: missing, cause: error });
      }
    },

    // The default public view of each table, which `placeInApp` pins into an app and a script that creates an app around a page pins at the create — one definition (`defaultViewsOf`) for both.
    // { views: [{ table, viewId }], warnings }: a table with no default public view is named in a warning and left out, never refused.
    async defaultViews(tables) {
      const warnings = [];
      const views = await defaultViewsOf(await getSdk(), tables, warnings);
      return { views, warnings };
    },

    // The environment's base language (an LCID) — what the titles of an app's navigation are written in so they show: a title in a language the environment has not provisioned does not (apps.js).
    // The SDK's own read, which throws rather than answering an English default.
    async baseLanguage() {
      return (await (await getSdk()).getEnvironmentLanguages()).baseLanguage;
    },

    // The solution a page is to join (`genpage-upload.js --solution`), read BEFORE the page is written, so a name that is no unmanaged solution — or a page table whose
    // component type the environment cannot say — refuses the upload with nothing made (lib/page-solution.js: why a page is added explicitly, and how).
    //   -> { uniqueName, systemSolution: true }                    a system solution (Default, Active, Basic): it holds every component already, so nothing is read and nothing will be added
    //   -> { uniqueName, systemSolution: false, componentType }    the unmanaged solution, as the platform spells its name, and the page table's component type
    // It throws, with a code: SOLUTION_NOT_FOUND, SOLUTION_MANAGED, GENPAGE_COMPONENT_TYPE_UNRESOLVED, or the SDK's own for a read that failed.
    async solutionTarget(uniqueName) {
      const name = String(uniqueName === undefined || uniqueName === null ? '' : uniqueName).trim();
      if (!name) throw genpageError('a solution is named by its unique name, and none was given', { code: 'SOLUTION_NOT_FOUND', outcome: 'nothing' });
      if (isRestrictedSolution(name)) return { uniqueName: name, systemSolution: true };
      const sdk = await getSdk();
      const solution = await readTargetSolution(sdk, name);
      return { uniqueName: solution.uniqueName, systemSolution: false, componentType: await readPageComponentType(sdk.dataverse) };
    },

    // Adds the page to the solution `target` names (solutionTarget's answer): the page's own row, and with it its file rows (AddRequiredComponents). A system solution
    // is not added to. A component the solution holds already is accepted by the platform, so adding a page twice changes nothing. -> { added: true | false }
    async addToSolution(pageId, target) {
      const id = guidOf(pageId, 'page');
      if (!target || target.systemSolution) return { added: false };
      if (!Number.isInteger(target.componentType) || target.componentType <= 0) {
        throw genpageError(`page ${id} cannot be added to solution ${target.uniqueName}: the page table's component type is not known`, { code: 'GENPAGE_COMPONENT_TYPE_UNRESOLVED', outcome: 'nothing', pageId: id });
      }
      await (await getSdk()).addSolutionComponent(pageComponent(id, target.componentType, target.uniqueName));
      return { added: true };
    },

    // The versionnumber of EVERY file row of each page — what the build's publish record compares (lib/page-publish-records.js has the measured facts and why this read is the plain one). A page is a
    // `uxagentprojects` row and its `uxagentprojectfiles` rows; one plain query per PAGE_VERSION_CHUNK pages, followed to its last page:
    //   GET /uxagentprojectfiles?$select=uxagentprojectfileid,versionnumber,_uxagentprojectid_value&$filter=_uxagentprojectid_value eq <id> or _uxagentprojectid_value eq <id>
    //   { "value": [ { "uxagentprojectfileid": "…", "versionnumber": 1234567, "_uxagentprojectid_value": "…" }, … ] }
    // The plain collection is the layer a publish moves AND a draft-only write moves, so a page changed by anyone since the versions were taken shows as a moved version; the SAME read must be used when the
    // versions are recorded and when they are checked, because the unpublished read answers other numbers for a draft and the two would never compare equal.
    //   -> { ok: true, versions: Map<page id (lower case), Map<file row id (lower case), version (digits)> | null> } | { ok: false, error }
    // A page whose rows cannot be taken as ONE consistent set is `null`, "not known": none came back (a page always has file rows), a row with no id, parent or version, a version that is no whole number or
    // too large to be one exactly, or a row listed twice. A read that fails is `ok: false`, never an empty answer.
    async fileVersions(pageIds) {
      const ids = [...new Set((pageIds || []).map((id) => String(id).toLowerCase()))];
      const bad = ids.find((id) => !GUID_RE.test(id));
      if (bad !== undefined) return { ok: false, error: `'${bad}' is not a page id` };
      const versions = new Map(ids.map((id) => [id, new Map()]));
      const unknown = new Set();
      try {
        const sdk = await getSdk();
        for (let at = 0; at < ids.length; at += PAGE_VERSION_CHUNK) {
          const chunk = ids.slice(at, at + PAGE_VERSION_CHUNK);
          const rows = await sdk.queryRecords('uxagentprojectfile', {
            select: ['uxagentprojectfileid', 'versionnumber', '_uxagentprojectid_value'],
            filter: chunk.map((id) => `_uxagentprojectid_value eq ${id}`).join(' or '),
            paginate: true,
          });
          for (const row of rows || []) {
            const parent = row && typeof row._uxagentprojectid_value === 'string' ? row._uxagentprojectid_value.replace(/[{}]/g, '').toLowerCase() : '';
            if (!versions.has(parent)) continue;
            const id = row && typeof row.uxagentprojectfileid === 'string' ? row.uxagentprojectfileid.replace(/[{}]/g, '').toLowerCase() : '';
            const version = row && (typeof row.versionnumber === 'number' ? (Number.isSafeInteger(row.versionnumber) && row.versionnumber >= 0 ? String(row.versionnumber) : '') : row.versionnumber);
            if (!GUID_RE.test(id) || typeof version !== 'string' || !/^[0-9]{1,19}$/.test(version) || versions.get(parent).has(id)) unknown.add(parent);
            else versions.get(parent).set(id, version);
          }
        }
      } catch (error) {
        return { ok: false, error: `could not read the versions of the pages' files: ${messageOf(error)}`, ...codeOf(error) };
      }
      return { ok: true, versions: new Map([...versions].map(([id, files]) => [id, unknown.has(id) || !files.size ? null : files])) };
    },

    // The versionnumber of each page's OWN row (`uxagentprojects`), read as `fileVersions` reads the files' — one plain query per PAGE_VERSION_CHUNK pages, followed to its last page:
    //   GET /uxagentprojects?$select=uxagentprojectid,versionnumber&$filter=uxagentprojectid eq <id> or uxagentprojectid eq <id>
    //   { "value": [ { "uxagentprojectid": "…", "versionnumber": 1234500 }, … ] }
    // A file row cannot show what the page's row holds — its NAME is there, not in a file — so a page renamed and published from elsewhere moves no file's version. The build's publish record keeps this version
    // beside the files' (lib/page-publish-records.js): a write to the row moves it as a write to a file moves that file's, and the SAME plain read must be used when it is recorded and when it is checked.
    //   -> { ok: true, versions: Map<page id (lower case), version (digits) | null> } | { ok: false, error }
    // A page whose row cannot be taken as one known version is `null`, "not known": no row came back (a page that has no published copy has none in the plain read), a row listed twice, a version that is no whole
    // number or too large to be one exactly. A read that fails is `ok: false`, never an empty answer.
    async projectVersions(pageIds) {
      const ids = [...new Set((pageIds || []).map((id) => String(id).toLowerCase()))];
      const bad = ids.find((id) => !GUID_RE.test(id));
      if (bad !== undefined) return { ok: false, error: `'${bad}' is not a page id` };
      const versions = new Map(ids.map((id) => [id, null]));
      const seen = new Set();
      const unknown = new Set();
      try {
        const sdk = await getSdk();
        for (let at = 0; at < ids.length; at += PAGE_VERSION_CHUNK) {
          const chunk = ids.slice(at, at + PAGE_VERSION_CHUNK);
          const rows = await sdk.queryRecords('uxagentproject', {
            select: ['uxagentprojectid', 'versionnumber'],
            filter: chunk.map((id) => `uxagentprojectid eq ${id}`).join(' or '),
            paginate: true,
          });
          for (const row of rows || []) {
            const id = row && typeof row.uxagentprojectid === 'string' ? row.uxagentprojectid.replace(/[{}]/g, '').toLowerCase() : '';
            if (!versions.has(id)) continue;
            const version = typeof row.versionnumber === 'number' ? (Number.isSafeInteger(row.versionnumber) && row.versionnumber >= 0 ? String(row.versionnumber) : '') : row.versionnumber;
            if (seen.has(id) || typeof version !== 'string' || !/^[0-9]{1,19}$/.test(version)) unknown.add(id);
            else versions.set(id, version);
            seen.add(id);
          }
        }
      } catch (error) {
        return { ok: false, error: `could not read the versions of the pages' rows: ${messageOf(error)}`, ...codeOf(error) };
      }
      return { ok: true, versions: new Map([...versions].map(([id, version]) => [id, unknown.has(id) ? null : version])) };
    },

    // What the PUBLISHED copy of a page differs from `args` in: the content a caller that keeps a record of what it published (the build: lib/page-publish-records.js) needs to see held before it records a publish.
    //   args: what `update` takes — only the content fields count (the source, and the name, data sources, model and bindings given); an omitted one is the page's own and cannot differ. `specBindings: true`
    //   reads the binding lists as an App Spec's, as `update` does, so the published copy of a page that holds more than a spec states is not reported as differing from it
    //   expected: `{ runtimeSha256 }` — the hash of the compiled output the DRAFT held when it was published (what `create` and `update` answer with `runtimeEvidence: true`); the published copy's compiled output must hash to it
    //   -> { ok: true, differing: [key…], fingerprint, runtimeSha256? } | { ok: false, error }
    // `differing` names the fields whose published value is not the one asked for, in `planEdits`' own words — the one definition of "holds that content", made on the published layer where `update` makes it on the
    // draft — and, given `expected.runtimeSha256`, `compiled output` when the published copy's compiled bytes are not those (or it has none): the runtime is what a record certifies, and the source does not say what
    // runs. It is empty when the published copy holds the content. `fingerprint` is `contentFingerprint` of the content that was asked about, so the caller can hold the answer to the hash it keeps; and given evidence the
    // answer carries `runtimeSha256`, the hash of the compiled output of the published copy it read (null when it has none), so the caller can hold it to the evidence too. `ok: false` is
    // "cannot be told", and never "holds it": a page with no published copy, a read that fails, a page laid out otherwise (see readPublishedPage). The reads are one after another, not one state: a caller that needs
    // them as one reads `fileVersions` and `projectVersions` before and after, and takes the answer only when those agree.
    async publishedDiffers(pageId, args = {}, expected = {}) {
      if (!GUID_RE.test(String(pageId || ''))) return { ok: false, error: `'${pageId}' is not a page id` };
      const id = String(pageId).toLowerCase();
      let fields;
      try {
        fields = contentFieldsOf(args);
      } catch (error) {
        return { ok: false, error: messageOf(error), ...codeOf(error) };
      }
      try {
        const sdk = await getSdk();
        const wantsRuntime = !!expected && typeof expected.runtimeSha256 === 'string';
        const page = await readPublishedPage(sdk, id, { runtime: wantsRuntime });
        if (page === null) return { ok: false, error: `page ${id} has no published copy` };
        const differing = planEdits(fields, page, { specBindings: args.specBindings === true }).map((edit) => edit.key);
        if (wantsRuntime && page.runtimeSha256 !== expected.runtimeSha256) differing.push('compiled output');
        // Given evidence, the answer says which compiled output it read (`runtimeSha256`, null for a copy with none), so a caller can see that the comparison was made: an answer that does not carry it was not about the runtime.
        return { ok: true, differing, fingerprint: contentFingerprint(fields), ...(wantsRuntime ? { runtimeSha256: page.runtimeSha256 } : {}) };
      } catch (error) {
        return { ok: false, error: `could not read the published copy of page ${id}: ${messageOf(error)}`, ...codeOf(error) };
      }
    },

    // Closes the backend and removes the workspace folders it made. Idempotent; it never throws, and the promise it returns never rejects.
    //   - No operation starts after it (`GENPAGE_BACKEND_CLOSED`), and what is removed is what release() removes: the workspaces are
    //     closed first, so an initialization or a read that is still running can neither write into a folder that is about to go nor put
    //     one back after it went — the page source it was reading would be left in the temp directory, with nothing left to remove it.
    //   - The folders go once the storage calls that were already under way have settled. That is at once when there are none — the usual
    //     case, so a caller that does not wait still finds the folder gone — and otherwise when the returned promise settles, which a
    //     caller about to end the process must wait for (emitResult exits it).
    //   - It answers for EVERY workspace this backend made, the ones an earlier discardWorkspaces() started clearing included: it joins that
    //     cleanup instead of forgetting it. The answer is `{ left }`, the folders still on disk — empty once they are all gone. A folder
    //     that could not be removed stays in `left` (a later call tries it again). `waitMs` is the caller's bound: when it runs out
    //     before a cleanup has finished, dispose() answers anyway, with that workspace in `left` — never "done" while one is on disk — and the
    //     cleanup goes on. A caller that ends the process should pass one: a storage call that never settles would otherwise keep it waiting.
    dispose(options) {
      closed = true;
      return release(options && options.waitMs);
    },

    // Ends what the workspaces made so far were doing and removes them — exactly as dispose() does, and with the same answer — but leaves the
    // backend open: the next operation makes a new workspace. For a caller that stops needing the reads it started (a verification pass that
    // gave up on its page reads) and may still be used for another pass.
    discardWorkspaces(options) {
      return release(options && options.waitMs);
    },
  };

  // The workspaces whose cleanup has not finished — each waits for the storage calls that were under way when it was closed — and every workspace
  // this backend made, with whether its folder is gone. release() forgets a workspace the moment it closes it, so without these a later call
  // (dispose() after a discardWorkspaces() whose caller stopped waiting) would see nothing to wait for and answer while the folder, and the page
  // source in it, was still on disk.
  const draining = new Set();
  const retired = [];

  // Closes a workspace's storage and removes its folder once the calls under way have settled (at once when none were).
  function retire({ dir, guard }) {
    const workspace = { dir, removed: false, done: undefined };
    workspace.remove = () => {
      // Windows answers EBUSY/EPERM for a moment while a handle that was just released lets go of a folder.
      try {
        (deps.rmSync || fs.rmSync)(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        workspace.removed = true;
      } catch { /* a folder in the temp directory that cannot be removed is left, and is named in `left` */ }
    };
    retired.push(workspace);
    if (!guard.busy) {
      workspace.remove();
      return;
    }
    workspace.done = guard.settled().then(workspace.remove);
    draining.add(workspace);
    workspace.done.then(() => draining.delete(workspace));
  }

  // Closes the workspaces made so far and removes their folders; the backend itself is not closed (dispose() does that), so an operation that
  // starts afterwards makes a workspace of its own. Closing is what stops the work: the SDK reaches the disk only through its storage, so a
  // closed one rejects every later call — an operation that was under way fails at its next storage call instead of writing, and nothing it
  // does afterwards can put a folder back. The folders are removed once the storage calls that were under way have settled (at once when none
  // were), so a handle is never pulled out from under a write. What it answers is the cleanup of every workspace, not only these (see dispose).
  //   An SDK this backend was lent (deps.sdk) or got from a test seam (deps.createSdk) keeps its workspace somewhere that cannot be closed
  //   from here, so its owner — who removes the folder after this — is given the time the operations still running on it need to end, at
  //   most `deps.drainMs` (10 s, the time the page reads this replaced were given to let go of their folders).
  function release(waitMs) {
    // A throttle that is being waited out is ended: the operation wakes to a closed backend and sends nothing more.
    generation += 1;
    for (const wake of [...sleepers]) wake();
    const workspaces = made.splice(0);
    for (const { guard } of workspaces) guard.close();
    byLanguage.clear();
    // A folder an earlier call could not remove is tried again: what held it may have let go.
    for (const workspace of retired) if (!workspace.removed && !draining.has(workspace)) workspace.remove();
    for (const workspace of workspaces) retire(workspace);
    const waits = [
      ...[...draining].map((workspace) => workspace.done),
      ...((deps.sdk || deps.createSdk) && running.size ? [boundedWait(Promise.allSettled([...running]), deps.drainMs)] : []),
    ];
    const answer = () => ({ left: retired.filter((workspace) => !workspace.removed).map((workspace) => workspace.dir) });
    if (!waits.length) return Promise.resolve(answer());
    const all = Promise.allSettled(waits);
    return (Number.isInteger(waitMs) && waitMs >= 0 ? boundedWait(all, waitMs) : all).then(answer);
  }

  // The operations are counted while they run: what release() waits for on an SDK it does not own. A closed backend refuses them in getSdk,
  // which the two listings reach inside their own try — a listing never rejects (a listing that cannot be read is `{ ok: false, error }`, and a
  // caller decides between creating a page and reusing one on that), so on a closed backend it answers exactly that.
  for (const name of ['enumerateEnv', 'enumeratePages', 'read', 'create', 'update', 'placeInApp', 'removeFromApp', 'describe', 'delete', 'runtimeTypes', 'defaultViews', 'baseLanguage', 'solutionTarget', 'addToSolution', 'fileVersions', 'projectVersions', 'publishedDiffers']) {
    const operation = api[name];
    api[name] = (...args) => {
      const run = operation(...args);
      running.add(run);
      const done = () => running.delete(run);
      run.then(done, done);
      return run;
    };
  }
  return api;
}

// `work`, or the end of `ms` (default 10 s), whichever comes first; never rejects, and leaves no timer behind.
function boundedWait(work, ms) {
  let timer;
  const limit = new Promise((resolve) => { timer = setTimeout(resolve, Number.isInteger(ms) ? ms : 10000); });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

// The default public view of each table in `tables`, as [{ table, viewId }] in the order of the tables, each once — what pac's upload used to pin into an app so that the maker's "/" picker lists the
// table: the `savedquery` row with `querytype eq 0 and isdefault eq true` (a public view that is the table's default). A table with no default public view is named in `warnings` and left out, never refused.
// The one definition of "the view to pin", shared by the placement of a page in an app that exists (`viewsToPin`) and by a script that creates an app around a page (apps.js), which has no app yet to ask.
// See: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/savedquery
async function defaultViewsOf(sdk, tables, warnings) {
  const wanted = dataSourcesOf(tables) || [];
  if (!wanted.length) return [];
  const { odataLit } = require('./odata.js');
  const views = [];
  for (const table of [...new Set(wanted)]) {
    const rows = await sdk.queryRecords('savedquery', {
      select: ['savedqueryid'],
      filter: `returnedtypecode eq '${odataLit(table)}' and querytype eq 0 and isdefault eq true`,
      top: 1,
    });
    const id = rows && rows[0] && rows[0].savedqueryid;
    if (id) views.push({ table, viewId: String(id).toLowerCase() });
    else warnings.push(`table ${table} has no default public view to pin into the app, so the maker's "/" picker may not list it`);
  }
  return views;
}

// The default public view of each table in `tables` that the app's CURRENT layer does not hold yet, as ids. The layer is the one
// an edit now would change (a pending write makes a layer of its own, so a membership read of the published one proves nothing); a layer
// that cannot be read leaves every view to pin — AddAppComponents is additive and re-adding a member is a no-op, so the worst case is
// one push that changes nothing.
async function viewsToPin(sdk, appId, tables, warnings) {
  const ids = (await defaultViewsOf(sdk, tables, warnings)).map((view) => view.viewId);
  if (!ids.length) return [];
  const { currentAppLayer, appComponentRows } = require('./app-components.js');
  const layer = sdk.dataverse ? await currentAppLayer(sdk.dataverse, appId) : { ok: false };
  if (!layer.ok) return ids;
  // appmodulecomponent rows of type 26 (savedquery): [{ objectid: '<view id>', componenttype: 26 }]
  const held = new Set((await appComponentRows(sdk, layer.appModuleIdUnique, 26)).map((row) => String(row.objectid).replace(/[{}]/g, '').toLowerCase()));
  return ids.filter((id) => !held.has(id));
}

// The apps whose navigation names a page, in either layer: [{ uniqueName, savedOnly, appId?, name? }]. It is the scan the build makes for a page shared across apps (sitemap-pages.js `fetchAppsForPages`: every app's
// published AND saved navigation, apps never published included), made over EVERY app. It fails closed, as a delete needs it to: a scan that could not run, or that could not read an app's navigation while none
// that it could read names the page, says nothing about the page being free — an app it could not read may hold it — so that is `GENPAGE_APPS_UNREADABLE`, not an empty answer. An app that IS found to name the
// page is reported even when others could not be read; the refusal then names those too.
// The apps are scanned by unique name, which is not what a caller acts on, so each is looked up (best effort: the answer stands without it) for its id and display name — the current layer, so a draft app is found:
//   GET /appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,name,uniquename&$filter=uniquename eq 'contoso_sales' or …
async function appsNaming(sdk, pageId) {
  const { fetchAppsForPages } = require('./sitemap-pages.js');
  const scan = await fetchAppsForPages(sdk, [pageId]);
  if (!scan.ok) {
    throw genpageError(`could not look for the apps whose navigation names page ${pageId} (${scan.error}) — nothing was deleted: an app that names it would be left pointing at a page that is gone. Run it again.`, { code: 'GENPAGE_APPS_UNREADABLE', outcome: 'nothing', pageId });
  }
  const named = scan.byId.get(pageId) || [];
  if (!named.length) {
    if (scan.unreadable.length) {
      throw genpageError(`page ${pageId} was not deleted: no app that could be read names it, but the navigation of ${scan.unreadable.length === 1 ? 'this app' : 'these apps'} could not be read — ${scan.unreadable.join(', ')} — and an app that names it would be left pointing at a page that is gone. Fix or remove ${scan.unreadable.length === 1 ? 'it' : 'them'}, or delete the page in Maker.`, { code: 'GENPAGE_APPS_UNREADABLE', outcome: 'nothing', pageId, unreadableApps: scan.unreadable });
    }
    return [];
  }
  const savedOnly = new Set((scan.savedOnly && scan.savedOnly.get(pageId)) || []);
  const known = new Map();
  try {
    const { odataLit } = require('./odata.js');
    const { collectionRows } = require('./app-components.js');
    const filter = named.map((unique) => `uniquename eq '${odataLit(unique)}'`).join(' or ');
    const rows = await collectionRows(sdk.dataverse, `/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,name,uniquename&$filter=${filter}`, 'the apps that name the page');
    for (const row of rows) if (row && row.uniquename && row.appmoduleid) known.set(String(row.uniquename).toLowerCase(), { appId: String(row.appmoduleid).toLowerCase(), name: row.name });
  } catch { /* the unique names are the answer; an id and a name are added when they can be read */ }
  return named.map((uniqueName) => {
    const found = known.get(String(uniqueName).toLowerCase());
    return { uniqueName, savedOnly: savedOnly.has(uniqueName), ...(found ? { appId: found.appId, ...(typeof found.name === 'string' && found.name ? { name: found.name } : {}) } : {}) };
  });
}

module.exports = {
  makeGenpageSdk, unescapePacName, suppliedButBlank, sourceText, dataSourcesOf, promptTranscript, configJson, pageFolderFiles,
  genPagesOfSiteMap, entityTablesOfSiteMap, writeOutcome, PRE_WRITE_REFUSALS, genpageError, holdsWhatWasSent, describeDivergence, contentFingerprint, watchThrottles, GUID_RE,
  missingTableOf,
};
