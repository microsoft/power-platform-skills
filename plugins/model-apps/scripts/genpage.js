#!/usr/bin/env node
'use strict';
// genpage: the generative-page operations the skills ran through `pac model genpage` — list, download, generate-types, add, and removing or deleting a
// page — through the bundled SDK, with the Azure CLI token every other script reads with. Writing a page (create and update) is genpage-upload.js's; pulling
// a whole app into an editable spec is download-model-app.js's; this is for one page, or the pages of one app, at a time.
//
// WHY. The SDK reads, writes and deletes a page itself, and lib/genpage-sdk.js is the plugin's one page backend over it. What the skills still ran
// through pac were the listing, the download, the type generator and the placement of a page in an app. Doing them here means no page operation needs the
// Power Platform CLI — its sign-in, its time limits, an output to parse — and that the bytes of a page are the ones the environment stores.
//
// Usage: node scripts/genpage.js <command> --env <envUrl> [flags]
//   list             [--app-id <guid>] [--include-unpublished]
//   download         --page-id <guid>[,<guid>...] --output-directory <dir> [--app-id <guid>]
//   types            --data-sources <table>[,<table>...] --output-file <file> [--detail none|colors|descriptions]
//   add-to-app       --app-id <guid> --page-id <guid> [--title <text>]
//   remove-from-app  --app-id <guid> --page-id <guid> [--allow-empty-navigation]
//   delete           --page-id <guid> [--allow-destructive]
//   --env  the environment's https origin, e.g. https://contoso.crm.dynamics.com
// Every id is checked (a GUID) and so is the origin before the first request; a flag may be given once, because `parseArgs` keeps only the last of a repeat and the
// others would vanish unseen.
//
// What replaces what:
//   pac model genpage list [--app-id] [--include-unpublished]                  list
//   pac model genpage download --app-id --page-id … --output-directory         download
//   pac model genpage generate-types --data-sources … --output-file           types
//   pac model genpage add --app-id --page-id … --publish                       add-to-app
//   (taking a page out of an app, and deleting a page, were done in Maker)     remove-from-app, delete
//
// Output (stdout, one JSON line of pure ASCII — every character beyond ASCII is a \uXXXX escape any JSON parser reads back), exit 0:
//   list    { "ok": true, "scope": "environment", "count": 2, "pages": [ { "pageId": "<guid>", "name": "Overview" }, … ] }
//             Every generative page of the environment, drafts included, sorted by name (any letter case) and then id. `name` is the name the page was given: pac stored every `"` of a name as `\"`, the pages it created
//             exist on every environment that used an earlier release, and the build and the download read that back, so this does too.
//           { "ok": true, "scope": "app", "appId": "<guid>", "layer": "published", "count": 1,
//             "pages": [ { "pageId": "<guid>", "name": "Overview", "title": "Overview (nav)" } ] }
//             The pages an app's navigation names, in navigation order. `layer` is "published" (what runs: the default) or "saved" (--include-unpublished: what the app designer
//             holds, which has every published page unless a saved edit took one out). `name` is the page's own name — a navigation title is not it, a rename of the page
//             leaves the title as it was — and null, with "exists": false, for an entry whose page is not in the environment; `title` is the navigation's, when it says one.
//   download  { "ok": true, "outputDirectory": "<abs>", "pages": [ { "pageId": "<guid>", "name": "Overview", "directory": "<abs>/<guid>",
//               "files": ["page.tsx", "config.json", "prompt.txt"], "replaced": ["page.tsx"], "removed": ["prompt.txt"] } ] }
//             `replaced` names the files that already held other bytes and were overwritten, `removed` a `prompt.txt` that an earlier download left and this page does not have;
//             both are left out when empty.
//   types     { "ok": true, "outputFile": "<abs>", "dataSources": ["account", "contact"], "detail": "none", "bytes": 12345 }
//   add-to-app
//             { "ok": true, "appId": "<guid>", "pageId": "<guid>", "added": true, "alreadyPlaced": false, "title": "Overview", "appEdited": true, "published": true,
//               "pinnedViews": ["<view guid>"], "dataSources": ["account"], "languageCode": 1033, "warnings": [ … ] }
//             `added` is true when this run put the page in the navigation, `alreadyPlaced` when it was there; `title` is the new entry's. `published` says the app was published by this
//             run, and the page is then proven to show in the published navigation (a failed or unproven publish is a failure, below). `warnings` is left out when empty.
//   remove-from-app
//             { "ok": true, "appId": "<guid>", "pageId": "<guid>", "wasInNavigation": true, "removed": [ { "area": "Main", "group": "Pages", "count": 1 } ],
//               "appEdited": true, "published": true, "provedPublished": true, "entriesLeft": 2, "warnings": [ … ] }
//             `wasInNavigation` is true when a layer of the app's navigation named the page, false when neither did, and null when the saved navigation does not name it and the published one could not be
//             read (see remove-from-app below). `published` says this run published the app; `provedPublished` that the page was then seen gone from the published navigation (false: it could not be read back).
//   delete    { "ok": true, "deleted": { "pageId": "<guid>", "name": "Overview", "fileRows": 4, "conversationMessages": 2 }, "historyRemoved": true, "verified": true, "warnings": [ … ] }
//             Exactly what was deleted: the page, the rows of its folder and the messages of its conversation, counted before the delete. `verified` says the page was read back as gone;
//             `historyRemoved` is false when some conversation messages could not be deleted (a warning says which and why): the page is gone either way. Without `--allow-destructive` nothing is deleted:
//             the answer is the failure below, `GENPAGE_DELETE_NOT_CONFIRMED`, with the same counts.
//   a failure { "ok": false, "error": "<message>", "code": "<SDK or script error code>", … }, with `pageId`, `appId`, `outcome` ("nothing" or "unknown" — what a failed write can have done),
//             `apps` (the apps a delete was refused for), `saved` (a placement or removal that was saved and not published), `fileRows` and `conversationMessages` (what a delete that was not confirmed
//             would remove) and `table` (the table `types` found the environment does not have) when they are known; the message is also on stderr. Warnings are on stderr too, and so
//             is one that names a throwaway workspace that could not be removed (a page's source may still be in the temp directory): it is a warning of any result, success or failure.
// Exit codes: 0 done; 1 usage error (stderr names the flag and the usage, stdout stays empty), a refusal or a failure.
//
// list. pac's listing of the environment held only PUBLISHED pages unless `--include-unpublished` was passed. This one always reads every page the environment has, drafts included (the SDK's
// existence list, which is what the "look for the page before creating it again" step of an unknown create needs), so `--include-unpublished` changes nothing there and is accepted for the
// commands that still carry it. With --app-id it is the app's navigation, in the layer above.
//
// download. Writes <output-directory>/<page id>/{page.tsx, config.json, prompt.txt}, the layout pac used and edit-flow.md reads, from the page as the SDK reads it (lib/genpage-sdk.js
// `pageFolderFiles`; prompt.txt is left out for a page with no prompt, which a rebuild reads as "no prompt supplied"). The BYTES differ from pac's: pac wrote every file with a UTF-8 byte order
// mark and appended a final CRLF; the SDK keeps the stored text exactly (a BOM or a final CRLF in the page, if it has one, is the page's), and the base marker hashes a page with those
// stripped (lib/genpage-base.js), so a page downloaded here and one downloaded by pac hash alike. pac also wrote `page.js`, the compiled output, which nothing reads: the SDK compiles
// a page itself on every push. pac REQUIRED --app-id; here it is optional, and when it is given the pages are refused unless that app's SAVED navigation names every one (what the designer holds,
// and what genpage-upload.js proves membership against), before anything is read or written. Every page is read before any file is written, so a page that cannot be read leaves the folder as it was.
// Files are written by lib/safe-fs.js: a link, a junction or a hard link at the folder or at a file's name is refused — one whose target is missing included, so the refusal still comes before the first page is
// written — and a file is replaced by a temp file and a rename, never written through.
// An existing file is overwritten — as pac did — and `replaced` says which.
//
// types. The SDK's `generateGenPageRuntimeTypes`, read from the environment now: the maker portal's own generator, so the text is what the page is compiled against. Its bytes differ from pac's file:
//   - it is a self-contained module — the base declarations a page imports (TableRow, DataColumnValue, QueryTableOptions, ReadableTableRow, ExtractFields, PageInput, BaseUxAgentDataApi …) are in it,
//     and GeneratedComponentProps carries `pageInput`; pac's file held only the table section and left those names to the page runtime;
//   - it types the columns the maker portal types: the system columns and the derived read-only columns pac added (the `…name` and `…yominame` ones of a lookup — a Web API `$select` of one
//     is refused) are left out, and so are choice enums of columns that cannot be read (e.g. account_isprivate, which the SDK still compiles when a page uses it); its column order is the portal's
//     (the primary id, primary name, primary image, processid, statecode and statuscode first, then logical-name order), where pac's was logical-name order after the primary key;
//   - the TableRegistrations and EnumRegistrations entries, the row types and the `const enum`s are those of pac's file for the columns both type;
//   - it is LF with no byte order mark (pac wrote a BOM and CRLF) and starts with a blank line.
// `--detail colors|descriptions` adds the SDK's comments (option colours and maximum lengths, then table and column descriptions); the default `none` is the text a compiled page is made from.
// A table the environment does not have is `GENPAGE_TABLE_NOT_FOUND`, naming it in `table` — the SDK's 404 of that table's own metadata read, told from any other 404 by the request it names (lib/genpage-sdk.js
// `missingTableOf`) — and no file is made. The output name is checked before the environment is asked: a link at it, or a linked folder (a dangling one too), is refused.
//
// add-to-app. lib/genpage-sdk.js `placeInApp`: the page becomes a GenPage sub-area of the app's navigation (titled with the name the page was given, or --title as typed), and the default public view of each table the
// page reads joins the app's components, so the maker's "/" picker lists the table (pac's upload pinned those views; the SDK's page write does not). The app is then published and the page proven to show in
// the published navigation. A page the navigation already names is left alone — its entry is not touched — with two exceptions, which are the one app edit and the one publish this makes: a view of a table the page
// reads that the app lacks is pinned, and a placement that was saved and never published is published (the rule genpage-upload.js follows for a page it created and could not finish: the page is shown, in the
// app that runs, or the placement is not done). Nothing at all is written when both layers name the page and no view is missing. Publishing publishes everything the app has saved, a draft app included. The
// navigation's titles are written in the environment's base language, as apps.js writes them: a title in a language the environment has not provisioned does not show.
//
// remove-from-app. Takes the page's sub-area out of the app's navigation; the page itself stays, and so do the views add-to-app pinned (another page or table of the app may need them). The app is published
// and the page proven gone from the published navigation. The publish is not optional: the app's users see the page until it is published, and the platform keeps an app's reference to a page until a sitemap
// without it is published, so the page cannot be deleted before. That holds for an app that was NEVER published as well — nothing runs from it, but the removal publishes it, which puts everything the app has
// saved live, and a warning says so. A page the navigation does not name is reported as not in it, and nothing is written — when that is KNOWN: the published navigation was read and does not name it, or the app
// has no published form. When the saved navigation does not name the page and the published one cannot be read (a removal whose publish failed looks exactly like that on its re-run), the app is published
// again, as add-to-app does, `wasInNavigation` is null and `provedPublished` false unless the read-back works; and when the SDK failed before it could tell whether the app has a published form at all the
// answer is `GENPAGE_APP_UNREADABLE` with nothing changed. Dataverse accepts an app whose navigation has no entry when the
// app already exists (it refuses one only when a sitemap is created), so nothing in the platform stops an app being left to open on nothing; this refuses it (`GENPAGE_NAVIGATION_WOULD_BE_EMPTY`, nothing
// written) unless --allow-empty-navigation says it is meant, in the way the build asks for --allow-destructive before it empties a navigation.
//
// delete. Deletes the page and its conversation history (the SDK deletes the project row, whose file rows go with it, and then the messages that point at it). It is refused while any app's navigation names
// the page — published or saved, every app of the environment, apps never published included — and the refusal names those apps (`GENPAGE_IN_APP`, with `apps`), so the page is taken out of each first; Dataverse
// would refuse the delete anyway, without saying which app. An app whose navigation cannot be read could hold the page, so that is a refusal too (`GENPAGE_APPS_UNREADABLE`). Nothing is deleted unless
// `--allow-destructive` says it is meant — the plugin's word for a destructive run, as in the build and teardown. Without it the page and the apps are read all the same, and the answer is the refusal
// `GENPAGE_DELETE_NOT_CONFIRMED` (exit 1, one line, `fileRows` and `conversationMessages` in it) that says what a confirmed run would remove: the page's name, its file rows, its conversation messages. A
// refusal, not a usage error: the command line was a good one. The skill that runs this asks the user between the two runs, and suppressing that question never authorizes a delete.
//
// Like every script here it emits no telemetry of its own (the plugin's hooks do), and it never prints a token.

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, validateFlags, emitResult, requireDataverseOrigin } = require('./lib/dataverse-auth.js');
const { makeGenpageSdk, pageFolderFiles, dataSourcesOf, GUID_RE, unescapePacName } = require('./lib/genpage-sdk.js');
const { leftOnDiskWarning } = require('./lib/left-on-disk.js');
const { assertSafeOutputDir, assertPlainFileTarget, writeFileSafe, removeFileSafe } = require('./lib/safe-fs.js');
const { makeWritesBlocking } = require('./lib/output-redaction.js');

// How long the backend's cleanup is waited for before the process ends: a storage call that never settles must not keep the script alive.
const DISPOSE_WAIT_MS = 10000;

// --detail's values, as the SDK names its levels (`GenPageRuntimeTypesOptions.detail`).
const DETAILS = { none: 'None', colors: 'ColorsDefaultsConstraints', descriptions: 'ColorsDefaultsConstraintsDescriptions' };
const DETAIL_CHOICES = 'one of: none, colors, descriptions';

const VERBS = {
  list: {
    usage: 'list --env <envUrl> [--app-id <guid>] [--include-unpublished]',
    known: ['env', 'app-id', 'include-unpublished'],
    needValue: ['env', 'app-id'],
    switches: ['include-unpublished'],
    required: ['env'],
  },
  download: {
    usage: 'download --env <envUrl> --page-id <guid>[,<guid>...] --output-directory <dir> [--app-id <guid>]',
    known: ['env', 'page-id', 'output-directory', 'app-id'],
    needValue: ['env', 'page-id', 'output-directory', 'app-id'],
    required: ['env', 'page-id', 'output-directory'],
  },
  types: {
    usage: 'types --env <envUrl> --data-sources <table>[,<table>...] --output-file <file> [--detail none|colors|descriptions]',
    known: ['env', 'data-sources', 'output-file', 'detail'],
    needValue: ['env', 'data-sources', 'output-file', 'detail'],
    hints: { detail: DETAIL_CHOICES },
    required: ['env', 'data-sources', 'output-file'],
  },
  'add-to-app': {
    usage: 'add-to-app --env <envUrl> --app-id <guid> --page-id <guid> [--title <text>]',
    known: ['env', 'app-id', 'page-id', 'title'],
    needValue: ['env', 'app-id', 'page-id', 'title'],
    required: ['env', 'app-id', 'page-id'],
  },
  'remove-from-app': {
    usage: 'remove-from-app --env <envUrl> --app-id <guid> --page-id <guid> [--allow-empty-navigation]',
    known: ['env', 'app-id', 'page-id', 'allow-empty-navigation'],
    needValue: ['env', 'app-id', 'page-id'],
    switches: ['allow-empty-navigation'],
    required: ['env', 'app-id', 'page-id'],
  },
  delete: {
    usage: 'delete --env <envUrl> --page-id <guid> [--allow-destructive]',
    known: ['env', 'page-id', 'allow-destructive'],
    needValue: ['env', 'page-id'],
    switches: ['allow-destructive'],
    required: ['env', 'page-id'],
  },
};
const COMMANDS = Object.keys(VERBS);
const COMMAND_CHOICES = `${COMMANDS.slice(0, -1).join(', ')} or ${COMMANDS[COMMANDS.length - 1]}`;

const usageFor = (verb) => (Object.prototype.hasOwnProperty.call(VERBS, verb)
  ? `Usage: node scripts/genpage.js ${VERBS[verb].usage}`
  : `Usage: node scripts/genpage.js <command> --env <envUrl> [flags]\n${COMMANDS.map((name) => `  node scripts/genpage.js ${VERBS[name].usage}`).join('\n')}`);

// A mistake in the command line itself — an unknown command or flag, a missing or malformed value — found before any request is made. It is printed on stderr with the usage, stdout stays empty,
// and the exit status is 1; a refusal or a failure that needs the environment is printed as JSON instead.
class UsageError extends Error {
  constructor(message, verb) {
    super(message);
    this.verb = verb;
  }
}

// A failure of this script's own, in the shape of the backend's: a `code` the caller can branch on, and whatever else is known.
const scriptError = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);

function exitWithUsage(message, verb) {
  makeWritesBlocking(process.stdout, process.stderr);
  process.stderr.write(`✗ ${message}\n${usageFor(verb)}\n`);
  process.exit(1);
}

// `--flag` given more than once. `parseArgs` keeps the LAST of a repeat and drops the others without a word, so `--page-id a --page-id b` would act on b alone.
function repeatedFlag(argv) {
  const seen = new Set();
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg.startsWith('--')) continue;
    const name = arg.slice(2).split('=')[0];
    if (seen.has(name)) return name;
    seen.add(name);
  }
  return null;
}

const idOf = (flag, value) => {
  if (!GUID_RE.test(value)) throw new UsageError(`--${flag} '${value}' is not an id: expected a GUID such as 0f8fad5b-d9cb-469f-a165-70867728950e`);
  return value.toLowerCase();
};

/**
 * The command a command line asks for, or a UsageError saying what is wrong with it. Nothing is read from the environment, and no process is started.
 * @returns {{ verb: string, env: string, args: object }}
 */
function parseCommand(argv) {
  const { positional, flags } = parseArgs(argv);
  const verb = positional[0];
  if (verb === undefined) throw new UsageError(`a command is required: ${COMMAND_CHOICES}`);
  if (!Object.prototype.hasOwnProperty.call(VERBS, verb)) throw new UsageError(`unknown command '${verb}': ${COMMAND_CHOICES}`);
  const spec = VERBS[verb];
  const flagError = validateFlags(argv, { known: spec.known, needValue: spec.needValue, hints: spec.hints });
  const fail = (message) => { throw new UsageError(message, verb); };
  if (flagError) fail(flagError);
  if (positional.length > 1) fail(`unexpected argument '${positional[1]}'`);
  const repeated = repeatedFlag(argv);
  if (repeated) fail(`--${repeated} was given more than once${repeated === 'page-id' && verb === 'download' ? ': for several pages give one --page-id with the ids separated by commas' : ''}`);
  // A bare switch carries no value: `parseArgs` would take the next word for one (`--include-unpublished yes` is not "include", and swallows `yes`).
  for (const name of spec.switches || []) if (flags[name] !== undefined && flags[name] !== true) fail(`--${name} takes no value (got '${flags[name]}')`);
  for (const name of spec.required) if (flags[name] === undefined) fail(`--${name} is required`);
  let env;
  try {
    env = requireDataverseOrigin(flags.env);
  } catch (error) {
    return fail(error.message);
  }
  try {
    const args = {};
    if (flags['app-id'] !== undefined) args.appId = idOf('app-id', flags['app-id']);
    if (verb === 'download') {
      const ids = String(flags['page-id']).split(',').map((id) => id.trim()).filter(Boolean).map((id) => idOf('page-id', id));
      if (!ids.length) fail('--page-id names no page');
      if (new Set(ids).size !== ids.length) fail('--page-id names a page more than once');
      args.pageIds = ids;
      args.outputDirectory = flags['output-directory'];
    } else if (flags['page-id'] !== undefined) {
      args.pageId = idOf('page-id', flags['page-id']);
    }
    if (verb === 'list') args.includeUnpublished = flags['include-unpublished'] === true;
    if (verb === 'types') {
      args.dataSources = dataSourcesOf(flags['data-sources']) || [];
      if (!args.dataSources.length) fail(`--data-sources '${flags['data-sources']}' names no table: give a table logical name, or several separated by commas`);
      args.outputFile = flags['output-file'];
      const detail = flags.detail === undefined ? 'none' : String(flags.detail).trim().toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(DETAILS, detail)) fail(`--detail must be ${DETAIL_CHOICES} (got '${flags.detail}')`);
      args.detail = detail;
    }
    if (verb === 'add-to-app' && flags.title !== undefined) args.title = flags.title;
    if (verb === 'remove-from-app') args.allowEmpty = flags['allow-empty-navigation'] === true;
    if (verb === 'delete') args.allowDestructive = flags['allow-destructive'] === true;
    return { verb, env, args };
  } catch (error) {
    if (error instanceof UsageError && error.verb === undefined) error.verb = verb;
    throw error;
  }
}

// --- the verbs. Each answers what the CLI prints, or throws: an Error with a `code` (the SDK's, the backend's or this script's) is printed as a failure. ------------------------

const byName = (a, b) => {
  const [x, y] = [String(a.name).toLowerCase(), String(b.name).toLowerCase()];
  return x < y ? -1 : x > y ? 1 : a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0;
};

// A page name as the page was GIVEN it. pac stored every `"` of a name as `\"` (in the page's row and in a navigation title it wrote), the pages it created exist on every environment that used an earlier release,
// and every other reader of a stored name — the build, teardown, the download of an app — reads it back, so a name shown as stored would not be the name those use for the same page (the "look for the page
// before creating it again" step compares names), and an entry titled with it would show the backslashes to the app's users. A name that is not text (a page with none) is left as it is. Only what a page's
// ROW holds goes through this: a title the user typed is theirs, and a navigation entry's title is shown as the navigation holds it.
const shownName = (name) => (typeof name === 'string' ? unescapePacName(name) : name);

async function list(genpage, { appId, includeUnpublished }) {
  if (!appId) {
    const environment = await genpage.enumerateEnv();
    if (!environment.ok) throw scriptError(environment.code || 'GENPAGE_LIST_FAILED', environment.error);
    const pages = environment.pages.map(({ pageId, name }) => ({ pageId, name: shownName(name) })).sort(byName);
    return { ok: true, scope: 'environment', count: pages.length, pages };
  }
  const navigation = await genpage.enumeratePages(appId, { includeUnpublished });
  if (!navigation.ok) {
    throw scriptError(navigation.code || 'GENPAGE_APP_UNREADABLE', `${navigation.error}${includeUnpublished ? '' : " (--include-unpublished reads the app's saved navigation instead)"}`, { appId });
  }
  // A navigation entry says the TITLE the maker gave it, which is not what the page is called, so the pages' own names come from the environment's list.
  const environment = await genpage.enumerateEnv();
  if (!environment.ok) throw scriptError(environment.code || 'GENPAGE_LIST_FAILED', environment.error, { appId });
  const names = new Map(environment.pages.map(({ pageId, name }) => [pageId.toLowerCase(), shownName(name)]));
  const pages = navigation.pages.map(({ pageId, name: title }) => {
    const known = names.has(pageId.toLowerCase());
    return {
      pageId,
      name: known ? names.get(pageId.toLowerCase()) : null,
      ...(typeof title === 'string' && title ? { title } : {}),
      ...(known ? {} : { exists: false }),
    };
  });
  return { ok: true, scope: 'app', appId, layer: includeUnpublished ? 'saved' : 'published', count: pages.length, pages };
}

// The bytes a file holds now, or null when there is no such file. (Only called for a name `assertPlainFileTarget` has passed: a regular file with one name, or none.)
function bytesOf(file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

// Whether ANYTHING is at `target` — lstat, not `fs.existsSync`: existsSync follows a link and answers "no" for a DANGLING one (a link whose target is missing), which would let the pre-flight below skip
// the very entry it exists to refuse, and the write would then refuse it after the pages before it had been written. Any answer but "nothing there" — an unreadable entry, a file where a folder
// should be — counts as present, so it reaches `assertSafeOutputDir`, which refuses it in its own words.
function isThere(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    return !(error && error.code === 'ENOENT');
  }
}

async function download(genpage, { pageIds, outputDirectory, appId }) {
  if (appId) {
    const navigation = await genpage.enumeratePages(appId, { includeUnpublished: true });
    if (!navigation.ok) throw scriptError(navigation.code || 'GENPAGE_APP_UNREADABLE', navigation.error, { appId });
    const named = new Set(navigation.pages.map((p) => String(p.pageId).toLowerCase()));
    const outside = pageIds.filter((id) => !named.has(id));
    if (outside.length) {
      throw scriptError('GENPAGE_NOT_IN_APP', `${outside.length === 1 ? 'page' : 'pages'} ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not in the navigation of app ${appId}, so nothing was downloaded. Use the id of the app the page belongs to, or leave --app-id out to download a page by its id alone.`, { appId, pageIds: outside });
    }
  }
  // Every page is read before a file is written: a page that cannot be read — not there, held as raw files — leaves the folder as it was.
  const read = [];
  const failed = [];
  for (const id of pageIds) {
    try {
      read.push({ id, page: await genpage.read(id) });
    } catch (error) {
      failed.push({ pageId: id, code: error && typeof error.code === 'string' ? error.code : undefined, error: String((error && error.message) || error) });
    }
  }
  if (failed.length) {
    const codes = [...new Set(failed.map((f) => f.code).filter(Boolean))];
    throw scriptError(codes.length === 1 ? codes[0] : 'GENPAGE_READ_FAILED', `nothing was downloaded: ${failed.map((f) => `page ${f.pageId}: ${f.error}`).join('; ')}`, { failed });
  }

  const root = assertSafeOutputDir(outputDirectory, { create: true });
  const plans = read.map(({ id, page }) => ({ id, page, directory: path.join(root, id), files: pageFolderFiles(page) }));
  // A link planted in the output folder is refused for every page before the first file is written, so a refusal on the last page does not leave the others half done. (writeFileSafe
  // refuses one at write time too, which is what holds against a link that appears meanwhile.) `prompt.txt` is the one file a page may not have: it is checked all the same, since an earlier
  // download's copy of it is removed when this page has none.
  for (const { directory, files } of plans) {
    if (isThere(directory)) assertSafeOutputDir(directory);
    for (const name of new Set([...Object.keys(files), 'prompt.txt'])) assertPlainFileTarget(path.join(directory, name));
  }
  const pages = plans.map(({ id, page, directory, files }) => {
    const real = assertSafeOutputDir(directory, { create: true });
    const replaced = [];
    for (const [name, text] of Object.entries(files)) {
      const target = path.join(real, name);
      const before = bytesOf(target);
      if (before !== null && !before.equals(Buffer.from(text, 'utf8'))) replaced.push(name);
      writeFileSafe(target, text, { encoding: 'utf8' });
    }
    // A page with no prompt has no prompt.txt, which a rebuild reads as "no prompt supplied": one an earlier download left would be read as this page's.
    const removedPrompt = !('prompt.txt' in files) && removeFileSafe(path.join(real, 'prompt.txt'));
    return { pageId: id, name: shownName(page.name), directory: real, files: Object.keys(files), ...(replaced.length ? { replaced } : {}), ...(removedPrompt ? { removed: ['prompt.txt'] } : {}) };
  });
  return { ok: true, outputDirectory: root, pages };
}

async function types(genpage, { dataSources, outputFile, detail }) {
  const target = path.resolve(outputFile);
  const parent = path.dirname(target);
  // The name is checked before the environment is asked for anything: a link or a directory at it, or a linked folder, is refused whatever the types would have been.
  assertPlainFileTarget(target);
  if (isThere(parent)) assertSafeOutputDir(parent);
  const text = await genpage.runtimeTypes(dataSources, { detail: DETAILS[detail] });
  assertSafeOutputDir(parent, { create: true });
  const written = writeFileSafe(target, text, { encoding: 'utf8' });
  return { ok: true, outputFile: written, dataSources, detail, bytes: Buffer.byteLength(text, 'utf8') };
}

async function addToApp(genpage, { appId, pageId, title }) {
  // The page first: one that is not there is refused before anything about the app is read.
  const page = await genpage.describe(pageId);
  const languageCode = await genpage.baseLanguage();
  // The entry is titled with the name the page was given unless the caller typed a title, which is used exactly as typed.
  const entryTitle = title !== undefined ? title : shownName(page.name);
  const placed = await genpage.placeInApp(appId, {
    pages: [{ pageId, title: entryTitle }],
    dataSources: page.dataSources || [],
    languageCode,
    finishIfUnpublished: true,
  });
  const warnings = [...(placed.warnings || [])];
  // A page the SDK holds as raw files has no configuration to read its tables from: nothing is said to be pinned for it, and the gap is said.
  if (page.dataSources === null) warnings.push(`page ${pageId} is held as raw files, so the tables it reads are not known and no view was pinned for it`);
  if (title !== undefined && placed.alreadyPlaced.length) warnings.push("the page was already in the app's navigation, so --title was not applied: an entry that is there is left as it is");
  const added = placed.added.length > 0;
  return {
    ok: true,
    appId,
    pageId,
    added,
    alreadyPlaced: placed.alreadyPlaced.length > 0,
    ...(added ? { title: entryTitle } : {}),
    appEdited: placed.appEdited === true,
    published: placed.appEdited === true || placed.provedPublished !== undefined,
    pinnedViews: placed.pinnedViews,
    dataSources: page.dataSources || [],
    languageCode,
    ...(warnings.length ? { warnings } : {}),
  };
}

async function removeFromApp(genpage, { appId, pageId, allowEmpty }) {
  const removal = await genpage.removeFromApp(appId, pageId, { allowEmpty });
  const { warnings, ...rest } = removal;
  return { ok: true, appId, pageId, ...rest, ...(warnings && warnings.length ? { warnings } : {}) };
}

async function deletePage(genpage, { pageId, allowDestructive }) {
  // The backend deletes only when told `allowDestructive: true`, and otherwise refuses — after the reads that decide the delete — saying what it would remove.
  const { warnings, pageId: id, name, fileRows, conversationMessages, historyRemoved, verified } = await genpage.delete(pageId, { allowDestructive });
  return { ok: true, deleted: { pageId: id, name: shownName(name), fileRows, conversationMessages }, historyRemoved, verified, ...(warnings && warnings.length ? { warnings } : {}) };
}

const RUN = { list, download, types, 'add-to-app': addToApp, 'remove-from-app': removeFromApp, delete: deletePage };

// What a failure prints besides its message and code: whatever the backend or the verb knows about what it did, so a caller can go on from it (the page's id to look for, whether anything was
// written, the apps a delete was refused for, what a delete that was not confirmed would have removed).
const FAILURE_FIELDS = ['pageId', 'appId', 'outcome', 'apps', 'unreadableApps', 'saved', 'pageIds', 'failed', 'fileRows', 'conversationMessages', 'table'];

function failureOf(error) {
  const code = error && typeof error.code === 'string' && error.code ? error.code : undefined;
  const known = {};
  for (const key of FAILURE_FIELDS) if (error && error[key] !== undefined) known[key] = error[key];
  return { ok: false, error: String((error && error.message) || error), ...(code ? { code } : {}), ...known };
}

/**
 * Runs one command line and reports its outcome. `deps` is a test seam: `makeGenpageSdk(env)` (the page backend), `emit(ok, payload)`, `usageError(message, verb)` and `stderr(text)`.
 */
async function main(argv = process.argv.slice(2), deps = {}) {
  const emit = deps.emit || ((ok, payload) => emitResult(ok, payload, { ascii: true }));
  let command;
  try {
    command = parseCommand(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    return (deps.usageError || exitWithUsage)(error.message, error.verb);
  }
  const genpage = (deps.makeGenpageSdk || makeGenpageSdk)(command.env);
  // The backend's workspace is removed BEFORE anything is reported: emitResult ends the process, so a cleanup placed after it never runs, and that workspace holds the page's source. The
  // outcome is settled first and emitted outside the try, for the same reason: an exit inside it would be caught as a failure of the verb. dispose() says, in `{ left }`, which folder it
  // could not remove (a handle a scanner holds); that goes out with the result, as a warning, so a success that left a page's source in the temp directory says so.
  let outcome;
  let leftOnDisk = null;
  try {
    outcome = { ok: true, payload: await RUN[command.verb](genpage, command.args) };
  } catch (error) {
    outcome = { ok: false, payload: failureOf(error) };
  } finally {
    try { leftOnDisk = leftOnDiskWarning(await genpage.dispose({ waitMs: DISPOSE_WAIT_MS })); } catch { /* the backend's own throwaway folder; nothing to say when it cannot even answer */ }
  }
  if (leftOnDisk) outcome.payload = { ...outcome.payload, warnings: [...(outcome.payload.warnings || []), leftOnDisk] };
  const stderr = deps.stderr || ((text) => process.stderr.write(text));
  for (const warning of outcome.payload.warnings || []) stderr(`⚠ ${warning}\n`);
  return emit(outcome.ok, outcome.payload);
}

module.exports = { main, parseCommand, UsageError, VERBS };

if (require.main === module) {
  main().catch((error) => {
    makeWritesBlocking(process.stdout, process.stderr);
    process.stderr.write(`Error: ${error && error.message ? error.message : error}\n`);
    process.exit(1);
  });
}
