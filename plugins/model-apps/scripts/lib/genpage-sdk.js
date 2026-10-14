'use strict';
// Generative pages through the bundled SDK: the plugin's one page backend (it replaced the `pac model genpage` wrapper).
//
//   const genpage = makeGenpageSdk(env, deps);
//   genpage.enumerateEnv()                  every page of the environment, drafts included  -> { ok, ids, pages: [{ pageId, name }], error }
//   genpage.enumeratePages(appId, options)  the pages an app's navigation names             -> { ok, pages: [{ pageId, name }], empty, error }
//   genpage.read(pageId)                    one page as the SDK projects it                  -> { id, name, source, dataSources, model, … }
//   genpage.create(args)                    mint an id (or take one), write, publish, prove  -> { pageId, name, publish, warnings }
//   genpage.update(pageId, args)            write only what differs, publish, prove          -> { pageId, unchanged?, publish, warnings }
//   genpage.placeInApp(appId, options)      pages into an app's navigation + their tables' default views into its components
//   genpage.dispose()                       close the backend and remove its throwaway workspace -> a promise (await it before the process ends)
//   genpage.discardWorkspaces()             the same for the workspaces made so far, leaving the backend open for the next operation
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
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { genPageSubArea, genPageSubAreaId } = require('./genpage-subarea.js');
const { guardWorkspaceStorage } = require('./workspace-storage-guard.js');

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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

// An error that must never be answered by trying again. The build re-runs a whole phase when a halt looks transient (isTransientHalt
// in build-model-app.js), and it decides that from the error's TEXT — which quotes the page's name (user text: "SQL Timeouts",
// "Concurrent Deletes") and the SDK's own message — so every error a page write raises says `transient: false`, which that check
// reads on the error and on its cause. A write that failed for a known reason would only fail again, and one whose outcome is not
// known must not be sent by a re-run that does not know it: a create would mint a second page beside the first one if it landed,
// and an update could record its turn twice.
function genpageError(message, props = {}) {
  const { cause, ...rest } = props;
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { transient: false }, rest);
}

const messageOf = (error) => String((error && error.message) || error);

// The typed SdkErrors a page push raises BEFORE it sends a write request — the only errors that PROVE a failed send wrote nothing. Read in the
// vendored SDK (src/MakerSdk.ts `prepareArtifactUnlocked`, src/api/GenPageApi.ts `create`/`update` ahead of their change set,
// src/adapters/GenPageAdapter.ts `toApiPayload`, src/adapters/genPageCompiler.ts):
//   VALIDATION_ERROR                  the page failed the adapter's checks or its compile: a syntax error, a data source that does not
//                                     resolve, a module that does not satisfy the page contract
//   GENPAGE_COMPILER_UNAVAILABLE / _VERSION / _INVALID, GENPAGE_RUNTIME_TYPES_INVALID
//                                     no usable TypeScript compiler, or the page's RuntimeTypes could not be built
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
  'GENPAGE_COMPILER_UNAVAILABLE', 'GENPAGE_COMPILER_VERSION', 'GENPAGE_COMPILER_INVALID', 'GENPAGE_RUNTIME_TYPES_INVALID',
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
  // Set by dispose(): no operation starts after it.
  let closed = false;
  // The operations in flight. An SDK that was lent to this backend (deps.sdk, or one a test makes) keeps its workspace somewhere this
  // backend cannot close, so for those release() waits for the operations instead.
  const running = new Set();
  const closedError = () => genpageError('the page backend was disposed, or its workspace was discarded: an operation that was under way is cut short, and none can start on a backend that was disposed', { code: 'GENPAGE_BACKEND_CLOSED' });

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
          const dir = (deps.mkdtempSync || fs.mkdtempSync)(path.join(os.tmpdir(), 'genpage-'));
          // The SDK reaches the disk only through its storage, so closing this one (dispose) is closing the workspace: a read or an
          // initialization that is still running when the folder is removed can neither write into it nor put it back.
          const guard = guardWorkspaceStorage((deps.createStorage || createNodeWorkspaceStorage)(dir), closedError);
          // Recorded before the SDK exists, so a failure to make it still leaves dispose() the folder to remove.
          made.push({ dir, guard });
          const sdk = createMakerSdk({
            workspaceStorage: guard.storage,
            instanceUrl: env,
            httpClient: deps.httpClient || (deps.createHttpClient || createAzHttpClient)(env),
            // A page's file downloads overlap (four at a time): a read of a page is its rows' bytes, one request each.
            readConcurrency: 4,
            ...(options.languageCode ? { languageCode: options.languageCode } : {}),
          });
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

  // One push, its answer sorted by what it says about the page. The SDK REPORTS some failures instead of throwing them
  // (`saved: false` with an `error`): an id that already exists, and a version conflict.
  //   { saved: true, result }
  //   { saved: false, outcome: 'nothing' | 'unknown' | 'exists' | 'conflict', error }
  // A create whose ids already exist — an earlier request that carried them landed — comes back one of two ways, and neither is ever "nothing was
  // written": the SDK reports the service's 412 as `ARTIFACT_ALREADY_EXISTS` ('exists'), and a change set the service rolled back for it is an answer the
  // SDK cannot account for (a CONNECTION_ERROR with status 200, "cannot be confirmed": 'unknown'). Both end in a read of the id.
  async function pushOnce(sdk, id) {
    let result;
    try {
      result = await sdk.pushArtifact('genPage', id);
    } catch (error) {
      return { saved: false, outcome: writeOutcome(error), error };
    }
    if (result && result.saved === true) return { saved: true, result };
    const error = result && result.error;
    if (error && error.code === 'ARTIFACT_ALREADY_EXISTS') return { saved: false, outcome: 'exists', error };
    if (error && error.code === 'VERSION_CONFLICT') return { saved: false, outcome: 'conflict', error };
    return { saved: false, outcome: error ? writeOutcome(error) : 'unknown', error: error || new Error('the SDK did not report the page as saved') };
  }

  // Publish the page and prove the published copy is the one just written. The SDK answers `publish.kind`:
  //   'verified'      the published projection serves exactly what was saved
  //   'unverifiable'  the publish was submitted but the published projection does not show the page yet (PublishXml is asynchronous)
  //   'failed'        the publish was refused
  async function publish(sdk, type, id, options) {
    try {
      const outcome = await sdk.publishArtifact(type, id, options);
      const state = (outcome && outcome.publish) || {};
      return { kind: state.kind || 'unknown', detail: state.reason || (state.error && messageOf(state.error)) || '' };
    } catch (error) {
      return { kind: 'failed', detail: messageOf(error) };
    }
  }

  const label = (name, id) => (name ? `"${name}" (${id})` : String(id));
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
        return { ok: false, ids: [], error: `could not list the environment's generative pages: ${messageOf(error)}` };
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
          const { fetchSitemap, sitemapGenPages } = require('./sitemap-pages.js');
          const rows = await sdk.queryRecords('appmodule', { select: ['uniquename'], filter: `appmoduleid eq ${String(appId).toLowerCase()}`, top: 1 });
          const unique = rows && rows[0] && rows[0].uniquename;
          if (!unique) return { ok: false, pages: [], error: `app ${appId} has no published form — it was never published, or does not exist` };
          const sitemap = await fetchSitemap(sdk, String(unique));
          if (!sitemap.ok) return { ok: false, pages: [], error: `could not read the published navigation of app ${appId} (${sitemap.reason}${sitemap.detail ? `: ${sitemap.detail}` : ''})` };
          pages = sitemapGenPages(sitemap.xml).map((p) => ({ pageId: p.pageId, name: p.title }));
        }
        return { ok: true, pages, empty: pages.length === 0 };
      } catch (error) {
        return { ok: false, pages: [], error: `could not read the navigation of app ${appId}: ${messageOf(error)}` };
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
      const found = await readServer(sdk, pageId);
      if (found.kind === 'absent') throw genpageError(`page ${pageId} does not exist in this environment`, { code: 'GENPAGE_NOT_FOUND' });
      if (found.kind === 'unreadable') throw genpageError(`could not read page ${pageId}: ${messageOf(found.error)}`, { code: 'GENPAGE_UNREADABLE', cause: found.error });
      if (typeof found.page.source !== 'string') {
        throw genpageError(`page ${pageId} (${JSON.stringify(found.page.name)}) has no source this tool can read: its rows are not laid out as the maker lays them out, so it is held as raw files, which are neither read nor compared as an empty page. Open it in Maker.`, { code: 'GENPAGE_NO_SOURCE' });
      }
      return found.page;
    },

    // CREATE: mint the page's id here, write it as one atomic change set, publish it, and prove the published copy.
    //   args: { name, source, dataSources, model, prompt, agentMessage, connectorBindings, actionBindings, pageId, beforeSend }
    //   `source` is the text the caller checked (sourceText turns the bytes of a file into it, once); bytes given here are decoded the
    //   same way, a string is used exactly as it is.
    //   `pageId` is an id to create the page under instead of a new one — a caller resuming a create that did not finish passes the id
    //   it minted then. `beforeSend(pageId)` is awaited after the id is known and before anything is sent: a caller that has to
    //   remember the id in case this call never answers records it there. If it throws, nothing was sent.
    // The id is minted BEFORE anything is sent, so what the write did can always be found out by reading it:
    //   saved                       -> publish
    //   a known failure             -> reported with the SDK's own code and message, and not sent again: the SDK refused it before
    //                                  writing, or the server answered the change set with a 4xx (atomic: nothing was written). It is
    //                                  a known failure of the page only while no earlier send is still open.
    //   an UNKNOWN outcome          -> read the id. Present: it landed (adopt it and publish). Absent: nothing was written YET, so the
    //                                  create is sent ONCE more under the SAME id: a first send that lands late collides on the id
    //                                  — no second page can exist — and that collision, like a second unknown, is settled by reading
    //                                  the id again.
    // A send that got no usable answer may still reach the service after anything this call has read or been told, so it is kept open:
    // every later failure — a second unknown, a refused resend, a read that finds nothing — ends as `outcome: 'unknown'` with the page's
    // id, never as "nothing was written", because that is only known when no send is open.
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
      try {
        await sdk.createArtifact('genPage', {
          id, name, source, dataSources,
          ...(args.model ? { model: String(args.model) } : {}),
          ...(connectorBindings !== undefined ? { connectorBindings } : {}),
          ...(actionBindings !== undefined ? { actionBindings } : {}),
          newTurn: turn,
        });
      } catch (error) {
        throw genpageError(`generative page ${who} was not created (nothing was written): ${messageOf(error)}`, { code: error && error.code, cause: error, outcome: 'nothing' });
      }
      if (typeof args.beforeSend === 'function') {
        try {
          await args.beforeSend(id);
        } catch (error) {
          throw genpageError(`generative page ${who} was not created (nothing was written): ${messageOf(error)}`, { code: error && error.code, cause: error, outcome: 'nothing' });
        }
      }

      const warnings = [];
      // The errors of the sends whose outcome is not known (see the comment above).
      const open = [];
      let pushed = await pushOnce(sdk, id);
      for (let send = 1; !pushed.saved; send += 1) {
        const refused = pushed.outcome === 'nothing';
        // Settled: there has been no other send, and this one is known to have written nothing.
        if (refused && !open.length) {
          throw genpageError(`generative page ${who} was not created (nothing was written): ${messageOf(pushed.error)}`, { code: pushed.error && pushed.error.code, cause: pushed.error, outcome: 'nothing' });
        }
        if (!refused) open.push(pushed.error);
        // What the sends said, for a message: a refused send is named as such, because it says nothing about the ones before it.
        const said = [...open.map(messageOf), ...(refused ? [`a later send was refused: ${messageOf(pushed.error)}`] : [])].join('; ');
        const code = (open[0] && open[0].code) || (pushed.error && pushed.error.code);
        const found = await readServer(sdk, id);
        if (found.kind === 'unreadable') {
          throw genpageError(`generative page ${who}: the outcome of creating it is unknown (${said}), and reading the page it would have (id ${id}) failed too (${messageOf(found.error)}). It was not sent again. Look for page ${id} before creating it again.`, { code, cause: open[0] || pushed.error, outcome: 'unknown', pageId: id });
        }
        if (found.kind === 'present') {
          // A send landed: only its answer was lost. What is on the server must be what was sent — an atomic create cannot be
          // partial, so any difference is somebody else's write to a page nobody else knew the id of.
          if (found.page.source !== source) {
            throw genpageError(`generative page ${who} (${id}) exists, but its source is not what this create sent — it was changed after it was created. It was not sent again and not published; read the page before going on.`, { code: 'GENPAGE_CREATE_DIVERGED', outcome: 'unknown', pageId: id });
          }
          warnings.push(`the answer to creating page ${who} was lost (${said}), but reading the id it was created under (${id}) showed that it had been written — so it was not sent again`);
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

      const published = await publish(sdk, 'genPage', id, { verify: true });
      return { pageId: id, name, publish: published, warnings: [...warnings, ...warningsOf(pushed, published, `page ${label(name, id)}`)] };
    },

    // UPDATE: read the page, write only what differs from it, record the turn, publish, and prove the published copy.
    //   args: { name, source, dataSources, model, prompt, agentMessage, connectorBindings, actionBindings, caller, appId, sourceFile }
    //   A field the caller leaves out (`undefined`) is left alone — an omitted data-source list, model, name or binding list is the
    //   page's own, not an instruction to clear it; `[]` clears a list. The page's FIRST prompt is kept and the new one is recorded
    //   as a turn of its conversation (pac overwrote the first prompt on every upload).
    //   A page that differs from the new content in nothing is not written and records no turn — a rebuild stops re-sending every page
    //   — but is still published, so a page saved by an earlier run whose publish did not finish converges.
    // The #722 guarantee: an update that MAY have landed is never sent again blindly. After an unknown outcome the page is read:
    //   what was sent is there, turn included   -> it landed (publish)
    //   the page is as it was before            -> nothing was written: sent ONCE more (the SDK's preflight compares the page's
    //                                              version tokens, so a page anyone changed meanwhile is refused, not overwritten)
    //   anything else                           -> refused, with where to look first. `caller: 'build'` words that for the build,
    //                                              which keeps no base marker and reads every page again when it runs; otherwise the
    //                                              standalone upload's `genpage-base.js check` (`appId` and `sourceFile` name its arguments).
    async update(pageId, args = {}) {
      if (!GUID_RE.test(String(pageId || ''))) throw genpageError(`'${pageId}' is not a page id`, { code: 'GENPAGE_ID_INVALID' });
      const id = String(pageId).toLowerCase();
      const fields = {
        source: sourceText(args.source),
        name: args.name === undefined || args.name === null || !String(args.name).trim() ? undefined : String(args.name),
        dataSources: dataSourcesOf(args.dataSources),
        model: args.model ? String(args.model) : undefined,
        connectorBindings: bindingOf(args.connectorBindings, 'connectorBindings'),
        actionBindings: bindingOf(args.actionBindings, 'actionBindings'),
      };
      const sdk = await getSdk();
      const found = await readServer(sdk, id);
      if (found.kind === 'absent') throw genpageError(`page ${id} does not exist in this environment — nothing was changed`, { code: 'GENPAGE_NOT_FOUND', outcome: 'nothing', pageId: id });
      if (found.kind === 'unreadable') throw genpageError(`could not read page ${id} before updating it (${messageOf(found.error)}) — nothing was changed`, { code: 'GENPAGE_UNREADABLE', cause: found.error, outcome: 'nothing', pageId: id });
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
      const planFor = (page) => {
        const edits = [];
        if (fields.source !== page.source) edits.push({ key: 'source', value: fields.source });
        if (fields.name !== undefined && fields.name !== page.name) edits.push({ key: 'name', value: fields.name });
        if (fields.dataSources !== undefined && !isDeepStrictEqual(fields.dataSources, page.dataSources === undefined ? [] : page.dataSources)) edits.push({ key: 'dataSources', value: fields.dataSources });
        if (fields.model !== undefined && fields.model !== page.model) edits.push({ key: 'model', value: fields.model });
        for (const key of ['connectorBindings', 'actionBindings']) {
          if (fields[key] !== undefined && !isDeepStrictEqual(fields[key], page[key])) edits.push({ key, value: fields[key] });
        }
        return edits;
      };
      let edits = planFor(baseline);
      if (!edits.length) {
        const published = await publish(sdk, 'genPage', id, { verify: true });
        return { pageId: id, unchanged: true, publish: published, warnings: warningsOf(null, published, `page ${who()}`) };
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
      let pushed = await pushOnce(sdk, id);
      for (let send = 1; !pushed.saved; send += 1) {
        // The one outcome that is known: the first send is the only one so far, and it wrote nothing. A version conflict is that when it is the first —
        // the SDK compared the page's version tokens before it wrote anything and found them moved — and so is a refusal or a 4xx. Every later failure
        // is read first: a send whose answer was lost is still open, it can reach the service after this send, a refusal of the resend or a page
        // that reads as it was says nothing about it, and the tokens a version conflict names may be its own.
        if (send === 1 && pushed.outcome === 'conflict') {
          throw genpageError(`the update of generative page ${who()} was refused because the page was changed by someone else after it was read, and nothing was written (${messageOf(pushed.error)}). Read the page again and apply the change to what it holds now.`, { code: 'VERSION_CONFLICT', cause: pushed.error, outcome: 'nothing', pageId: id });
        }
        if (send === 1 && pushed.outcome === 'nothing') {
          throw genpageError(`the update of generative page ${who()} failed and wrote nothing: ${messageOf(pushed.error)}`, { code: pushed.error && pushed.error.code, cause: pushed.error, outcome: 'nothing', pageId: id });
        }
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

      const published = await publish(sdk, 'genPage', id, { verify: true });
      return { pageId: id, publish: published, warnings: [...warnings, ...warningsOf(pushed, published, `page ${who()}`)] };
    },

    // Place pages into an app that exists, as the app designer does: each page becomes a sub-area of the app's navigation (the shape
    // genPageSubArea gives it), and the default public view of every table in `dataSources` joins the app's components so the
    // maker's "/" picker lists the table — pac's upload pinned those views, and the SDK's page write does not.
    //   options: { pages: [{ pageId, title }], dataSources: [table…], languageCode }
    // One app edit at most: the app is read, the navigation and the components are edited, then it is pushed and published. A page the
    // navigation already names, and a view the app already holds, are left alone; when nothing is missing nothing is written.
    // The sub-area goes in the first group that already holds a page, else the first group of the first area (an app has at least
    // one: the SDK refuses a navigation without an area that holds a group). Sitemap titles are written in the SDK's language
    // (`languageCode`, default the SDK's own).
    // Returns { added: [pageId…], alreadyPlaced: [pageId…], pinnedViews: [viewId…], warnings: [...], appEdited }. It throws, with the
    // page unplaced, when the app cannot be read, the edit is refused, or the app's publish fails.
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
      if (!edited) return { added: [], alreadyPlaced, pinnedViews: [], warnings, appEdited: false };

      const pushed = await sdk.pushArtifact('app', appId);
      if (!pushed || pushed.saved !== true) {
        throw genpageError(`app ${appId} was not changed: ${messageOf((pushed && pushed.error) || 'the push was not saved')}`, { code: pushed && pushed.error && pushed.error.code, cause: pushed && pushed.error });
      }
      warnings.push(...(pushed.warnings || []));
      const published = await publish(sdk, 'app', appId, undefined);
      if (published.kind === 'failed') {
        throw genpageError(`the navigation of app ${appId} was saved, but publishing the app failed (${published.detail}) — the pages are in the app's saved navigation and show once it is published`, { code: 'GENPAGE_APP_PUBLISH_FAILED', saved: true });
      }
      return { added: added.map((p) => String(p.pageId)), alreadyPlaced, pinnedViews: pin, warnings, appEdited: true };
    },

    // Closes the backend and removes the workspace folders it made. Idempotent; it never throws, and the promise it returns never rejects.
    //   - No operation starts after it (`GENPAGE_BACKEND_CLOSED`), and what is removed is what release() removes: the workspaces are
    //     closed first, so an initialization or a read that is still running can neither write into a folder that is about to go nor put
    //     one back after it went — the page source it was reading would be left in the temp directory, with nothing left to remove it.
    //   - The folders go once the storage calls that were already under way have settled. That is at once when there are none — the usual
    //     case, so a caller that does not wait still finds the folder gone — and otherwise when the returned promise settles, which a
    //     caller about to end the process must wait for (emitResult exits it).
    dispose() {
      closed = true;
      return release();
    },

    // Ends what the workspaces made so far were doing and removes them — exactly as dispose() does — but leaves the backend open: the next
    // operation makes a new workspace. For a caller that stops needing the reads it started (a verification pass that gave up on its page
    // reads) and may still be used for another pass; its answer is the same promise, which never rejects.
    discardWorkspaces() {
      return release();
    },
  };

  // Closes the workspaces made so far and removes their folders; the backend itself is not closed (dispose() does that), so an operation that
  // starts afterwards makes a workspace of its own. Closing is what stops the work: the SDK reaches the disk only through its storage, so a
  // closed one rejects every later call — an operation that was under way fails at its next storage call instead of writing, and nothing it
  // does afterwards can put a folder back. The folders are removed once the storage calls that were under way have settled (at once when none
  // were), so a handle is never pulled out from under a write.
  //   An SDK this backend was lent (deps.sdk) or got from a test seam (deps.createSdk) keeps its workspace somewhere that cannot be closed
  //   from here, so its owner — who removes the folder after this — is given the time the operations still running on it need to end, at
  //   most `deps.drainMs` (10 s, the time the page reads this replaced were given to let go of their folders).
  function release() {
    const workspaces = made.splice(0);
    for (const { guard } of workspaces) guard.close();
    byLanguage.clear();
    const finish = () => {
      for (const { dir } of workspaces) {
        // Windows answers EBUSY/EPERM for a moment while a handle that was just released lets go of a folder.
        try { (deps.rmSync || fs.rmSync)(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* a folder in the temp directory that cannot be removed is left */ }
      }
    };
    const outstanding = [
      ...workspaces.filter(({ guard }) => guard.busy).map(({ guard }) => guard.settled()),
      ...((deps.sdk || deps.createSdk) && running.size ? [boundedWait(Promise.allSettled([...running]), deps.drainMs)] : []),
    ];
    if (!outstanding.length) {
      finish();
      return Promise.resolve();
    }
    return Promise.allSettled(outstanding).then(finish);
  }

  // The operations are counted while they run: what release() waits for on an SDK it does not own. A closed backend refuses them in getSdk,
  // which the two listings reach inside their own try — a listing never rejects (a listing that cannot be read is `{ ok: false, error }`, and a
  // caller decides between creating a page and reusing one on that), so on a closed backend it answers exactly that.
  for (const name of ['enumerateEnv', 'enumeratePages', 'read', 'create', 'update', 'placeInApp']) {
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

// The default public view of each table in `tables` that the app's CURRENT layer does not hold yet, as ids — what pac's upload used to
// pin: `savedquery` rows with `querytype eq 0 and isdefault eq true` (a public view that is the table's default). The layer is the one
// an edit now would change (a pending write makes a layer of its own, so a membership read of the published one proves nothing); a layer
// that cannot be read leaves every view to pin — AddAppComponents is additive and re-adding a member is a no-op, so the worst case is
// one push that changes nothing. A table with no default public view is skipped, with a warning, never refused.
// See: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/savedquery
async function viewsToPin(sdk, appId, tables, warnings) {
  const wanted = dataSourcesOf(tables) || [];
  if (!wanted.length) return [];
  const { odataLit } = require('./odata.js');
  const ids = [];
  for (const table of [...new Set(wanted)]) {
    const rows = await sdk.queryRecords('savedquery', {
      select: ['savedqueryid'],
      filter: `returnedtypecode eq '${odataLit(table)}' and querytype eq 0 and isdefault eq true`,
      top: 1,
    });
    const id = rows && rows[0] && rows[0].savedqueryid;
    if (id) ids.push(String(id).toLowerCase());
    else warnings.push(`table ${table} has no default public view to pin into the app, so the maker's "/" picker may not list it`);
  }
  if (!ids.length) return [];
  const { currentAppLayer, appComponentRows } = require('./app-components.js');
  const layer = sdk.dataverse ? await currentAppLayer(sdk.dataverse, appId) : { ok: false };
  if (!layer.ok) return ids;
  // appmodulecomponent rows of type 26 (savedquery): [{ objectid: '<view id>', componenttype: 26 }]
  const held = new Set((await appComponentRows(sdk, layer.appModuleIdUnique, 26)).map((row) => String(row.objectid).replace(/[{}]/g, '').toLowerCase()));
  return ids.filter((id) => !held.has(id));
}

module.exports = {
  makeGenpageSdk, unescapePacName, suppliedButBlank, sourceText, dataSourcesOf, promptTranscript, configJson, pageFolderFiles,
  genPagesOfSiteMap, writeOutcome, PRE_WRITE_REFUSALS, genpageError,
};
