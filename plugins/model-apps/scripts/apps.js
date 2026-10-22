#!/usr/bin/env node
'use strict';
// apps: the model-driven apps of an environment, and a new app that opens on generative pages — through the vendored SDK.
// It does what `pac model list` and `pac model create` do, without the Power Platform CLI.
//
//   list    every app, drafts included: { id, name, uniqueName, description, published, unpublishedChanges }.
//           The SDK's own `fetchArtifactList('app')` reads the same collection but keeps only each app's id and name, and the
//           skill also needs the unique name and whether the app is published, so this reads the collection itself:
//             GET /appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,name,uniquename,description,componentstate
//           (the current layer of every app, one that was never published included), and then the published layer, for the apps users can open:
//             GET /appmodules?$select=appmoduleid
//           A row of the first looks like
//             { "appmoduleid": "11111111-…", "name": "Contoso Sales", "uniquename": "contoso_sales", "description": null, "componentstate": 0 }
//           `componentstate` is 0 (Published) or 1 (Unpublished) —
//           https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/appmodule.
//
//           Two facts are reported apart, because neither is the other's reverse:
//             published           the app has a row in the published layer: users can open it
//             unpublishedChanges  it has a saved row that is not published (componentstate 1); null when its rows name no state
//           Measured on a real environment:
//             a draft app                                     one saved row (1), no published row               published false, unpublishedChanges true
//             a published app with a saved edit               one saved row (1), its published row still there   published true,  unpublishedChanges true
//             a published app                                 one row (0), and a published row                  published true,  unpublishedChanges false
//             a managed app a solution import brought in      one row (0), a published row with no `publishedon`  published true,  unpublishedChanges false
//           `pac model list` printed "(Saved - Not Published)" after the name of an app whose published row has no `publishedon`, a time that only a
//           publish (PublishXml) sets. That is neither fact: a managed app an import brought in, which is live, carried the mark, and a published app with
//           a saved edit did not. For the apps a skill makes the mark meant "never published", which is `published === false`; `unpublishedChanges` is
//           something `pac` never said. The mark is never part of `name`.
//           The two layers are read one after the other, the saved one first. An app published between the reads is then listed as published with
//           changes, a pair real apps have (a published app with a saved edit), and never as neither; the cost is that an app DELETED between them is
//           in the first answer, as published, and not in the second, which reads as neither — a pair no app has — so it is left out of the list.
//           Retire the first read for `fetchArtifactList('app')` once the SDK's list carries the columns it needs.
//
//   create  an app that opens on the given generative pages: one area, "Main", one group, "Pages" (what `pac model create` named
//           them), and one sub-area per page, titled with the page's stored name. It takes at least one page because Dataverse
//           refuses a navigation whose group is empty (HTTP 400, "SiteMap needs to have a non-empty Area with a non-empty Group"),
//           and `pac model create` got round that with an empty group, which the SDK does not write. So the order is: create the
//           first page (it needs no app), then create the app with it.
//
//           Nothing is written until every check has passed, and each check that fails says why: no --page-id, a page id that is not
//           a page in the environment, a solution that does not exist (or is managed, and takes no new components), a unique name
//           that is taken (by an app, or by a site map an app was deleted without), a name or unique name the platform would refuse.
//           A refusal prints { ok: false, code, error, written: false } and exits 1.
//
//           Writes, in order: the app row and its sitemap (the SDK's create and push — which also pin the sitemap as an app
//           component, give the app the System Administrator role so it can be opened, and write one app setting: see below), then the app
//           (component 80) and its sitemap (62) join the solution — adding the app module alone leaves its sitemap only in the default
//           solution — and, only with --publish, the publish. A system solution (Default, Active, Basic) holds every component already, so
//           nothing is added to it: the output says `systemSolution: true`, and `inSolution` is empty, which is not a failure.
//
//           The app setting. The SDK's create makes every new app with the new header and navigation ON (`headerAndNavigationRefresh` is
//           true unless the definition says false; a public preview) and writes that as the app setting HeaderAndNavigationRefresh = 2:
//           `POST appsettings`, bound to the app and to the environment's setting definition of that name, in the push, after the role
//           and before the SDK's own publish step and everything below. It is written at create only (an edit or a publish never writes it),
//           and only when the environment has that setting definition: without it the SDK adds a warning ("App setting
//           'HeaderAndNavigationRefresh' was not applied …", in `warnings`) and the app is made all the same. The row is saved, not
//           published: `RetrieveUnpublishedMultiple` (and the SDK's `getAppSettings`) read it, and a plain read of `appsettings` finds none until
//           the app is published — so a draft app made here has no setting row for a plain read (measured), and an app made with --publish gets
//           it with the app. `pac model create` wrote no such setting, and this script never adds the setting to the solution (only the app
//           and its sitemap).
//
//           The app is created UNPUBLISHED (`published: false`; the SDK publishes inside the create otherwise) so that --publish
//           means what it meant to `pac model create`: without it the app stays in draft. The build never does this, because its
//           own probes cannot see a draft. After a create that worked nothing here looks the app up by name or id — the ids are minted
//           before the first write (the app's by the SDK, the sitemap's below) — so a draft costs nothing; a create that failed reads
//           the platform back to say what it left, recognising its rows by those ids (see the output below).
//
//           Unique name. `pac model create` derived `<display name lower-cased, spaces as underscores>_<8 hex digits>` (an app named
//           "Account Metrics" got `account_metrics_1a2b3c4d`) — no publisher prefix; the hex digits make two apps of one name differ.
//           --unique-name replaces it. A unique name holds at most 100 characters (the name and the description at most 100 and 2000:
//           https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/appmodule) and "can only have English
//           characters and numbers" (an underscore is what the platform's own names use):
//           https://learn.microsoft.com/power-apps/developer/model-driven-apps/create-manage-model-driven-apps-using-code
//           That page also says that on creating an app "the name is automatically prefixed with your solution publisher prefix (for
//           example 'new_')". The names `pac model create` made were measured (three apps, in a live environment) and none carries a
//           prefix, so the derivation above follows what was measured, not that sentence. Do not "correct" it to add one: compare the
//           `uniqueName` this prints with the platform's row for a create made through this script before changing it.
//
//           Icon. The app's icon is a required column. The system's default icon web resource is used, as the Power Apps documentation
//           does (https://learn.microsoft.com/power-apps/developer/model-driven-apps/create-manage-model-driven-apps-using-code): a
//           component of the platform itself, so the app depends on nothing in the environment. Left to the SDK, an app is given
//           whatever image web resource it finds first, which makes the app depend on another solution's.
//
//           Language. Navigation titles carry a language code. Written in a language the environment has not provisioned, a title does
//           not show, so the titles use the environment's base language (read from the organization), never an assumed 1033.
//
//           Views. `pac model genpage upload --app-id` pinned the default public view of every table a page reads into the app, so that the
//           maker's "/" picker lists the table; a page made with no app and put in one afterwards by this create had nothing to pin them. So the create
//           does: it reads each page's tables (the page backend's `describe`: the `dataSources` of its config.json) and the default public view of each
//           (the page backend's `defaultViews` — the same definition the placement of a page in an app that exists pins), and the views join the app's
//           components in the create itself: the SDK's `components.views` of the app it creates, written by its AddAppComponents with the sitemap, so a
//           view the platform refuses undoes the create like any other write. A table with no default public view is left out and named in `warnings`; a page
//           the SDK holds as raw files has no configuration to read its tables from, which `warnings` says too. These reads come last of the checks, and a
//           page that cannot be read refuses the create before anything is written. The output says what was pinned (`pinnedViews`, and `dataSources`, the
//           tables the pages read).
//
// Like every script here it emits no telemetry of its own (the plugin's hooks do), and it never prints a token.
//
// Usage:
//   node scripts/apps.js list --env <envUrl> [--search <text>]
//   node scripts/apps.js create --env <envUrl> --name <display name> --solution <solution unique name>
//        --page-id <guid> [--page-id <guid> ...] [--unique-name <name>] [--description <text>] [--publish]
//   --env          the environment's https origin, e.g. https://contoso.crm.dynamics.com
//   --search       list: keeps the apps whose name or unique name holds the text (any letter case)
//   --name         create: the app's display name (at most 100 characters)
//   --solution     create: the UNIQUE name of an existing unmanaged solution; the app and its sitemap join it
//   --page-id      create: a generative page's id; repeat it, or comma-separate, for more pages (their order is the navigation's)
//   --unique-name  create: the app's unique name, instead of the derived one
//   --description  create: the app's description (at most 2000 characters)
//   --publish      create: publish the app (a bare flag); without it the app is left unpublished
//
// Output (stdout, one pure-ASCII JSON line; every character beyond ASCII is a \uXXXX escape any JSON parser reads back):
//   list    { "ok": true, "count": 1, "apps": [ { "id": "11111111-…", "name": "Contoso Sales", "uniqueName": "contoso_sales",
//             "description": "", "published": true, "unpublishedChanges": false } ] }   `unpublishedChanges` is null when the platform did not say
//   create  { "ok": true, "appId": "22222222-…", "uniqueName": "account_metrics_1a2b3c4d", "name": "Account Metrics", "published": false,
//             "unpublishedChanges": true, "solution": "ContosoCore", "addedToSolution": true, "inSolution": ["app", "sitemap"],
//             "sitemapId": "33333333-…", "languageCode": 1033,
//             "navigation": { "area": "Main", "group": "Pages", "pages": [ { "pageId": "44444444-…", "title": "Overview" } ] },
//             "dataSources": ["account"], "pinnedViews": ["55555555-…"] }
//             `published` and `unpublishedChanges` are the two facts of `list`: with --publish true and false, without it false and true.
//             In a system solution `inSolution` is empty and "systemSolution": true says why (it holds every component already).
//             `dataSources` are the tables the pages read, each once, and `pinnedViews` the ids of the default public views that joined the app's components with them
//             (empty when the pages read no table, or a table has no default public view — a warning then says so).
//             "warnings": [ … ] — the notes on the views, the SDK's notes on the push, and a page workspace the page backend could not remove (page source may still be in
//             the temp directory; on stderr alone when the create is refused) — are added when there are some
//   a refusal, or a failure to read:  { "ok": false, "code": "PAGE_NOT_FOUND", "error": "<message>", "written": false }
//   a failure after the push began, when something may exist: `code` and `error` are the SDK's own, and the rest is READ BACK from the
//             platform, not inferred from how far the run got — the SDK rolls a partial create back when it can, and a rollback can be refused
//             or lost. A row is this create's when it has this create's ID: the app's (the SDK mints it before the first write and sends it as
//             the row's key) or the site map's (this script chooses it). The unique name alone does not make a row this create's: a row that
//             holds it under another id belongs to another create.
//               { "ok": false, "code": …, "error": …, "written": true, "stage": "create" | "solution" | "publish", "uniqueName": …,
//                 "appId": "…", "sitemapId": "…", "left": { "app": true, "sitemap": true }, "published": false, "unpublishedChanges": true,
//                 "addedToSolution": false, "inSolution": ["app"] }
//             `written` is true when something of this create exists (its app or its site map), false when the read-back found neither, and null
//             when no row is known to exist and one could not be read. `left` says of each row whether it exists: true, false, or null when it
//             could not be read and nothing else says. `appId` is only this create's app, and only when it exists (with its two facts, `published` and
//             `unpublishedChanges`, when both layers were read); `sitemapId` is always the id the script chose before its first write.
//             A row that holds the unique name under another id is neither written nor left: it is named apart, as
//             "nameTakenBy": { "appId": …, "sitemapId": … } (each only when found), and a retry with that name is refused while it exists.
//             The reads are the app in the saved layer, the app in the published layer, then the site map by that name, in that order, and the first
//             that fails ends them: "readBackError" says why, and "lookFor": { uniqueName, appId (the id the create used), sitemapId } what to look
//             for. A read-back that cannot be made keeps what the run knows. A push the SDK reported as saved (stage "solution" or "publish")
//             wrote both rows, and a row that a read found before a later read failed is there, so "written" is true then, with "left" saying what
//             is known and null for the rest; "written" is null only when nothing is known to exist, and then "left" is absent (nothing was read)
//             or has a false and a null. `inSolution` is each of "app" and "sitemap" as it joined (a failure between the two has ["app"];
//             `addedToSolution` is true only when both did), `systemSolution` is as for a success, and the SDK's `warnings`, if it gave any, are
//             also written to stderr.
//   a failure before the push (in the workspace only this run sees): the same as a refusal, "written": false
//
// Exit codes: 0 done; 1 usage error (stderr names the flag and the usage, stdout stays empty), a refusal or a failure.

const { randomBytes, randomUUID } = require('node:crypto');
const { parseArgs, validateFlags, emitResult, requireDataverseOrigin } = require('./lib/dataverse-auth.js');
const { makeWritesBlocking } = require('./lib/output-redaction.js');
const { withThrowawaySdk } = require('./lib/throwaway-sdk.js');
const { pushFailed } = require('./lib/entity-provision.js');
const { collectionRows, currentLayerRow, savedPageRows } = require('./lib/app-components.js');
const { isRestrictedSolution } = require('./lib/system-solutions.js');
const { odataLit } = require('./lib/odata.js');
const { genPageSubArea } = require('./lib/genpage-subarea.js');
const { makeGenpageSdk, unescapePacName } = require('./lib/genpage-sdk.js');
const { leftOnDiskWarning } = require('./lib/left-on-disk.js');

const USAGE = [
  'Usage:',
  '  node scripts/apps.js list --env <envUrl> [--search <text>]',
  '  node scripts/apps.js create --env <envUrl> --name <display name> --solution <solution unique name>',
  '       --page-id <guid> [--page-id <guid> ...] [--unique-name <name>] [--description <text>] [--publish]',
].join('\n');

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The limits of the appmodule columns (https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/appmodule).
const NAME_MAX = 100;
const UNIQUE_NAME_MAX = 100;
const DESCRIPTION_MAX = 2000;
// The system's default icon web resource, the one the Power Apps documentation gives a new app (see the header).
const DEFAULT_APP_ICON_ID = '953b9fac-1e5e-e611-80d6-00155ded156f';
// Solution component types (https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/solutioncomponent).
const COMPONENT_TYPE_APP = 80;
const COMPONENT_TYPE_SITEMAP = 62;
const AREA_TITLE = 'Main';
const GROUP_TITLE = 'Pages';

// A decision of this script rather than a fault: it is reported as a result, with its code.
class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * What a run that did not finish prints: { ok: false, code?, error, ...extra }. The code is the error's own (the SDK's, say) when it
 * has one, so a caller sees the SDK's words and code and never a paraphrase.
 */
function failure(err, extra = {}) {
  const code = err && typeof err.code === 'string' ? err.code : undefined;
  return { ok: false, ...(code ? { code } : {}), error: String((err && err.message) || err), ...extra };
}

/**
 * The values of every `--page-id`, read from argv. `parseArgs` keeps only the LAST of a repeated flag, and this one repeats (one per
 * page), so its occurrences are collected here. A value may also list several ids, comma-separated, as the other scripts' page lists do.
 * @returns {{ ids: string[] } | { problem: string }}
 */
function pageIdArguments(argv) {
  const raw = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--page-id') {
      const next = argv[i + 1];
      // `--page-id --name x` is a flag with no value, which parseArgs would hide when another `--page-id` follows it.
      if (next === undefined || next.startsWith('--')) return { problem: '--page-id requires a value' };
      raw.push(next);
      i += 1;
    } else if (arg.startsWith('--page-id=')) {
      raw.push(arg.slice('--page-id='.length));
    }
  }
  if (raw.some((value) => !value.trim())) return { problem: '--page-id requires a value' };
  return { ids: raw.flatMap((value) => value.split(',')).map((id) => id.trim()).filter(Boolean) };
}

/**
 * The unique name `pac model create` derived: the display name lower-cased, every run of characters other than a-z and 0-9 an
 * underscore, then `_` and 8 hex digits — "Account Metrics" gave `account_metrics_1a2b3c4d`. A name with nothing in it that
 * survives (all punctuation, or another script) is `app_<hex>`.
 * @param {string} name - the display name
 * @param {() => string} [randomHex] - 8 hex digits; a test seam
 */
function deriveUniqueName(name, randomHex = () => randomBytes(4).toString('hex')) {
  const hex = randomHex();
  const room = UNIQUE_NAME_MAX - hex.length - 1;
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, room).replace(/_+$/, '');
  return `${slug || 'app'}_${hex}`;
}

// A plain read of the platform's own collections through the SDK's Dataverse client, for what the SDK has no method for (each caller says why).
// A failed read is reported with the code the SDK reports its own reads under, CONNECTION_ERROR, whichever way it fails.
const readRows = (sdk, firstPath, what) => collectionRows(sdk.dataverse, firstPath, what, { code: 'CONNECTION_ERROR' });

// --- list ------------------------------------------------------------------------------------------------------------------

// The current layer of every app, a draft included: what an author sees. `componentstate` says which layer a row is (0 Published, 1 Unpublished:
// https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/appmodule). A row looks like
//   { "appmoduleid": "11111111-…", "name": "Contoso Sales", "uniquename": "contoso_sales", "description": null, "componentstate": 0 }
const APPS_PATH = '/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,name,uniquename,description,componentstate';
// The published layer: the apps users can open. An app never published has no row here, and an app with a saved edit that is not published yet still has its row.
const PUBLISHED_APPS_PATH = '/appmodules?$select=appmoduleid';

// Ids are compared without regard to letter case, whichever layer or caller they come from (a GUID is one id however it is spelled).
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '');
const idOf = (row) => lower(row && row.appmoduleid);
// A real number or nothing: `Number(null)` is 0, which would read a row with no state as a published one.
const stateOf = (row) => (typeof row.componentstate === 'number' ? row.componentstate : null);
const text = (value) => (typeof value === 'string' ? value : '');
// Narrows a read of the apps to the one of that unique name (how a failed create looks for what it left); nothing without one.
const byUniqueName = (uniqueName) => (uniqueName === undefined ? '' : `&$filter=uniquename eq '${odataLit(uniqueName)}'`);

// The saved layer's rows, by app: id (lower-case) -> its rows. A row with no id fails the read: an app that cannot be told from another can neither be listed
// nor be said to be, or not to be, the one a create made.
async function readSavedApps(sdk, { uniqueName } = {}) {
  const rows = await readRows(sdk, `${APPS_PATH}${byUniqueName(uniqueName)}`, 'the model-driven apps');
  const byId = new Map();
  for (const row of rows) {
    const id = idOf(row);
    if (!GUID.test(id)) throw new Error('the platform answered an app with no id, so the list cannot be trusted');
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(row);
  }
  return byId;
}

// The ids (lower-case) of the apps that have a row in the published layer.
async function readPublishedIds(sdk, { uniqueName } = {}) {
  const rows = await readRows(sdk, `${PUBLISHED_APPS_PATH}${byUniqueName(uniqueName)}`, 'the published model-driven apps');
  if (rows.some((row) => !GUID.test(idOf(row)))) throw new Error('the platform answered a published app with no id, so the list cannot be trusted');
  return new Set(rows.map(idOf));
}

/**
 * One app as `list` shows it, from its rows in the saved layer and the ids of the published one. Two facts are reported for it, apart, because neither is
 * the other's reverse:
 *   published           the app has a row in the published layer: users can open it
 *   unpublishedChanges  it has a saved row that is not published: componentstate 1 in RetrieveUnpublishedMultiple; null when its rows name no state
 * Measured on a real environment (RetrieveUnpublishedMultiple's rows, and whether a published row exists):
 *   a draft app                                  one row, componentstate 1; no published row      -> published false, unpublishedChanges true
 *   a published app with a saved edit            one row, componentstate 1; the published row stays -> published true,  unpublishedChanges true
 *   a published app                              one row, componentstate 0; a published row       -> published true,  unpublishedChanges false
 *   a managed app that a solution import brought in   one row, 0; a published row with no `publishedon`  -> published true,  unpublishedChanges false
 * A pending edit may also answer two rows, one per layer; the authored one (1) is the app, whichever comes first.
 */
function describeApp(id, appRows, publishedIds) {
  const row = currentLayerRow(appRows);
  const states = appRows.map(stateOf);
  return {
    id,
    name: text(row.name),
    uniqueName: text(row.uniquename),
    description: text(row.description),
    published: publishedIds.has(id),
    unpublishedChanges: states.includes(1) ? true : states.every((state) => state === 0) ? false : null,
  };
}

// An app that is neither published nor holds a saved change does not exist: the saved layer says it is published (componentstate 0, which is a published row) and the
// published layer has no row for it. It was deleted between the two reads, which are made one after the other.
const deletedBetweenReads = (app) => !app.published && app.unpublishedChanges === false;

/**
 * The apps of the environment, drafts included, sorted by name (any letter case) and then id.
 */
async function readApps(sdk) {
  const saved = await readSavedApps(sdk);
  // The published layer is read second. An app published between the two reads then shows its saved row AND its published one — published, with changes,
  // a combination real apps have (a published app with a saved edit) — where the other order could show it with neither (published false,
  // unpublishedChanges false), which no app ever is.
  const published = await readPublishedIds(sdk);
  // The same order has one cost: an app DELETED between the reads is still in the first answer and no longer in the second, so it comes out as that pair. It
  // is left out. The app no longer exists, so leaving it out is what a read made a moment later would say; a re-read would add a request to every list for an
  // event that needs a delete inside the window between two requests, and a mark would give the boolean `published` a third state for an app that is gone.
  // (A draft deleted in that window cannot be told from one still there, so it is listed, as it was a moment ago.)
  return [...saved].map(([id, appRows]) => describeApp(id, appRows, published))
    .filter((app) => !deletedBetweenReads(app))
    .sort((a, b) => {
      const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()];
      return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/**
 * @param {string} env - a Dataverse https origin
 * @param {{ search?: string }} args
 * @param {object} [httpClient] - the SDK's HttpClient; the az-token one for `env` when omitted (a test seam)
 */
async function listApps(env, args = {}, httpClient) {
  const apps = await withThrowawaySdk({ env, httpClient, prefix: 'apps-' }, (make) => readApps(make()));
  const needle = typeof args.search === 'string' ? args.search.toLowerCase() : '';
  const kept = needle ? apps.filter((app) => app.name.toLowerCase().includes(needle) || app.uniqueName.toLowerCase().includes(needle)) : apps;
  return { ok: true, ...(needle ? { search: args.search } : {}), count: kept.length, apps: kept };
}

// --- create ----------------------------------------------------------------------------------------------------------------

/** The refusals that need no environment: a Refusal, or null when the input is acceptable. */
function inputRefusal(args) {
  if (!args.pageIds.length) {
    return new Refusal('PAGE_ID_REQUIRED',
      'An app needs a page in its navigation, so create needs at least one --page-id: Dataverse refuses an app whose navigation group is empty '
      + '("SiteMap needs to have a non-empty Area with a non-empty Group"). Create the first page without an app, then create the app with its id.');
  }
  const seen = new Set();
  for (const id of args.pageIds) {
    if (!GUID.test(id)) {
      return new Refusal('PAGE_ID_INVALID', `--page-id '${id}' is not a page id: expected a GUID such as 0f8fad5b-d9cb-469f-a165-70867728950e.`);
    }
    if (seen.has(id.toLowerCase())) return new Refusal('PAGE_ID_DUPLICATE', `--page-id ${id} was given more than once: a page is in an app's navigation once.`);
    seen.add(id.toLowerCase());
  }
  if (args.name.length > NAME_MAX) return new Refusal('NAME_TOO_LONG', `--name is ${args.name.length} characters; an app's name holds at most ${NAME_MAX}.`);
  if (args.description && args.description.length > DESCRIPTION_MAX) {
    return new Refusal('DESCRIPTION_TOO_LONG', `--description is ${args.description.length} characters; an app's description holds at most ${DESCRIPTION_MAX}.`);
  }
  if (args.uniqueName !== undefined && (!/^[A-Za-z0-9_]+$/.test(args.uniqueName) || args.uniqueName.length > UNIQUE_NAME_MAX)) {
    return new Refusal('UNIQUE_NAME_INVALID',
      `--unique-name '${args.uniqueName}' is not an app unique name: it takes 1 to ${UNIQUE_NAME_MAX} letters, digits and underscores, and nothing else.`);
  }
  return null;
}

/** The unmanaged solution named `uniqueName`, as the platform spells it; throws a Refusal when there is none. */
async function readSolution(sdk, uniqueName) {
  const rows = await sdk.queryRecords('solution', {
    select: ['solutionid', 'uniquename', 'friendlyname', 'ismanaged'],
    filter: `uniquename eq '${odataLit(uniqueName)}'`,
    top: 1,
  });
  const solution = rows && rows[0];
  if (!solution) {
    throw new Refusal('SOLUTION_NOT_FOUND',
      `There is no solution with the unique name '${uniqueName}' in this environment. --solution takes a solution's unique name, not its display name; `
      + 'create the solution first (provision-solution.js) if it should exist.');
  }
  if (solution.ismanaged === true) {
    throw new Refusal('SOLUTION_MANAGED', `The solution '${solution.uniquename}' is managed, and a managed solution takes no new components. Use an unmanaged solution.`);
  }
  return { uniqueName: solution.uniquename || uniqueName };
}

// The generative pages named by `ids`, as { id (lower-case), title } in the order of `ids`; a Refusal names every id that is no page.
// The SDK reads the same collection to check a sitemap's pages when the app is pushed, and refuses a missing one then, but without saying
// which — and the title of each sub-area is the page's stored name, so the rows are needed here anyway. Its `fetchArtifactList('genPage')`
// lists every page of the environment, where this asks for just the ids. The saved layer (`savedPageRows`, which says why) rather than a plain
// read, because a page saved in Maker and not yet published is a page all the same. With a pending edit the platform can answer with both layers,
// and only the authored one (componentstate 1) is current.
async function readPages(sdk, ids) {
  const wanted = ids.map((id) => id.toLowerCase());
  const rowsById = await savedPageRows(sdk.dataverse, wanted, { code: 'CONNECTION_ERROR' });
  const missing = wanted.filter((id) => !rowsById.has(id));
  if (missing.length) {
    throw new Refusal('PAGE_NOT_FOUND',
      `Not a generative page in this environment: ${missing.join(', ')}. --page-id takes the id of a page that exists (the page's id, not the app's).`);
  }
  // A page whose name cannot be read still shows in the navigation, under its id. A page an earlier release created through pac holds `\"` for every `"` of its name, and the entry's title is the name
  // the page was given (`unescapePacName` says why), as the build and the download read it.
  return wanted.map((id) => {
    const { name } = currentLayerRow(rowsById.get(id));
    return { id, title: (typeof name === 'string' && name) ? unescapePacName(name) : id };
  });
}

// The site maps named `uniqueName`, in either layer. An app's unique name is its site map's name (the SDK writes the two rows under one name),
// which is what makes the site map the place to look for a name an app was deleted without.
const sitemapsNamed = (sdk, uniqueName) => readRows(sdk,
  `/sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=sitemapid,sitemapnameunique&$filter=sitemapnameunique eq '${odataLit(uniqueName)}'`,
  'the site maps');

// A unique name is spent by an app (found in either layer, as a draft is) and by a SITEMAP: the two rows share it, and a sitemap that an app was
// deleted without stays behind and keeps the name — the create would then answer "The name … is already in use by an existing site map".
// `uniqueName` is letters, digits and underscores by now (inputRefusal), so the escape in the filter is belt and braces.
async function assertUniqueNameFree(sdk, uniqueName) {
  const apps = await sdk.resolveArtifact('app', { uniqueName });
  if (apps && apps.length) {
    throw new Refusal('UNIQUE_NAME_TAKEN', `An app already has the unique name '${uniqueName}' (${apps[0].name}, ${apps[0].id}). Pass another --unique-name.`);
  }
  if ((await sitemapsNamed(sdk, uniqueName)).length) {
    throw new Refusal('UNIQUE_NAME_TAKEN',
      `A site map already has the name '${uniqueName}' (one an app was deleted without), and an app's unique name is its site map's name. Pass another --unique-name.`);
  }
}

// The environment's base language: the one language it is certain to have provisioned. Its answer
//   { "value": [ { "organizationid": "…", "languagecode": 1033 } ] }
// is read as the build reads it (lib/entity-provision.js resolveLanguageCode); unlike the build, an answer that does not say stops the run
// before any write, because falling back to 1033 would label the navigation in a language that may not exist there.
async function readBaseLanguage(sdk) {
  const rows = await sdk.queryRecords('organization', { select: ['languagecode'], top: 1 });
  const lcid = Number(rows && rows[0] && rows[0].languagecode);
  if (!Number.isInteger(lcid) || lcid <= 0 || lcid > 65535) {
    throw new Refusal('LANGUAGE_UNREADABLE', "The environment's base language could not be read, and the navigation's titles need it. Retry; nothing was written.");
  }
  return lcid;
}

// The app the SDK creates. Its sitemap is the one lib/sdk-build.js appDef writes for generative-page entries. `viewIds` are the default public views of the tables the pages read,
// which the SDK pins as components of the app in the same create (the app artifact's `components.views`); the key is left out when there are none, so an app whose pages read no
// table is made exactly as it was.
function appDefinition({ name, description, uniqueName, pages, sitemapId, viewIds = [] }) {
  return {
    name,
    uniqueName,
    description: description || '',
    iconWebResourceId: DEFAULT_APP_ICON_ID,
    // Chosen here, before the write, so the sitemap's id is known without reading it back: it joins the solution next.
    sitemapId,
    published: false,
    siteMap: {
      areas: [{
        id: 'area_0',
        title: AREA_TITLE,
        groups: [{
          id: 'group_0_0',
          title: GROUP_TITLE,
          // The one shape a page has as a sub-area (lib/genpage-subarea.js), shared with the build and the placement of a page.
          subAreas: pages.map((page, i) => genPageSubArea({ id: `sub_0_0_${i}`, title: page.title }, page.id)),
        }],
      }],
    },
    ...(viewIds.length ? { components: { views: viewIds } } : {}),
  };
}

// The tables the pages read and the default public view of each — what `pac model genpage upload --app-id` pinned into the app on every upload, and what the placement of a page in an app
// that exists pins (lib/genpage-sdk.js `placeInApp`). An app made around a page that was created with no app has had no upload to pin them, so the create does. Both reads are the page backend's:
// `describe` for a page's `dataSources` (a page the SDK holds as raw files has none it can read: `null`, which is said, never taken for "no tables") and `defaultViews`, the one definition of
// "the default public view of a table" that the placement uses too. The backend is the page backend's own — its own throwaway workspace, removed whichever way this ends.
//   -> { dataSources: [table…] (each once, in the order the pages name them), viewIds: [view id…], warnings: [text…] }
async function readViewPins(env, httpClient, pages, makeBackend) {
  const backend = makeBackend(env, httpClient ? { httpClient } : {});
  let pins = null;
  try {
    const warnings = [];
    const dataSources = [];
    for (const page of pages) {
      const described = await backend.describe(page.id);
      if (described.dataSources === null) warnings.push(`page ${page.id} (${JSON.stringify(page.title)}) is held as raw files, so the tables it reads are not known and no view was pinned for it`);
      for (const table of described.dataSources || []) if (!dataSources.includes(table)) dataSources.push(table);
    }
    const found = dataSources.length ? await backend.defaultViews(dataSources) : { views: [], warnings: [] };
    pins = { dataSources, viewIds: found.views.map((view) => view.viewId), warnings: [...warnings, ...found.warnings] };
    return pins;
  } finally {
    // dispose() says, in `{ left }`, which folder it could not remove (a handle a scanner holds), and that folder holds page source. The create's outcome is not changed by it. A read that
    // succeeded carries the warning in its own `warnings`, which the output prints; one that failed has no result to carry it — the create is refused with that failure — so it goes to stderr.
    let leftOnDisk = null;
    try { leftOnDisk = leftOnDiskWarning(await backend.dispose({ waitMs: 10000 })); } catch { /* the backend's own throwaway folder; nothing to say when it cannot even answer */ }
    if (leftOnDisk) {
      if (pins) pins.warnings.push(leftOnDisk);
      else process.stderr.write(`⚠ ${leftOnDisk}\n`);
    }
  }
}

/**
 * Creates the app. Resolves with what the CLI prints — a refusal and a failed read or write included. It rejects only when the run cannot
 * begin at all (no throwaway folder, no SDK module), which main() prints in the same shape.
 * @param {object} args - { env, name, solution, pageIds, uniqueName?, description?, publish }
 * @param {object} [httpClient] - the SDK's HttpClient; the az-token one for `args.env` when omitted (a test seam)
 * @param {object} [seams] - { randomHex(), newId(), makeGenpageSdk(env, deps) }: the unique name's hex digits, the sitemap's id and the page backend, for a test
 */
async function createApp(args, httpClient, seams = {}) {
  const refusal = inputRefusal(args);
  if (refusal) return failure(refusal, { written: false });
  return withThrowawaySdk({ env: args.env, httpClient, prefix: 'apps-' }, async (make) => {
    let plan;
    let writer;
    try {
      const readSdk = make();
      const solution = await readSolution(readSdk, args.solution);
      const pages = await readPages(readSdk, args.pageIds);
      const uniqueName = args.uniqueName !== undefined ? args.uniqueName : deriveUniqueName(args.name, seams.randomHex);
      await assertUniqueNameFree(readSdk, uniqueName);
      plan = { solution, pages, uniqueName, languageCode: await readBaseLanguage(readSdk) };
      // Last of the reads: a page whose configuration cannot be read refuses the create like any other check, with nothing written.
      plan.pins = await readViewPins(args.env, httpClient, pages, seams.makeGenpageSdk || makeGenpageSdk);
      // The titles are written in the language the SDK instance is made with, which is why the writer is not the instance that read. It is made
      // here, inside the guarded block, so that an instance the SDK refuses to make is a failure with nothing written, like any other read.
      writer = make({ languageCode: plan.languageCode });
    } catch (err) {
      return failure(err, { written: false });
    }
    return writeApp(writer, args, plan, (seams.newId || randomUUID)());
  });
}

// What a create that failed after its push began left behind, READ from the platform rather than inferred from how far the run got. The SDK rolls a
// partial app back when it can, and a rollback can be refused, left undone on purpose or lost, so neither "something was written" nor "nothing was" can
// be said from here.
//
// The rows are recognised by their IDS, never by the unique name alone: the app's, which the SDK minted before its first write and sent as the new row's key
// (so the row is at that id, or it does not exist), and the site map's, which this script chose. The name is what a retry collides on, but a row that holds it
// under another id is somebody else's — a create under the same --unique-name that got there first — and reporting it as this create's leftover would point
// a skill that offers to remove what a failed create left at another maker's app. (The SDK addresses its own rows by those ids for the same reason.) Such a
// row is reported apart, as `nameTakenBy`, and `written` is decided from this run's rows alone.
//
// The reads — the app in the saved layer and in the published one, then the site map by that name — are made in turn, and the first that fails ends them.
// A read that fails does not fail the failure (the error the caller most needs is the one the create already has): the outcome says what is still known.
// A push the SDK reported as saved (the failure is at the solution or publish stage) committed the app and its site map, so both are known to be there
// without a read, and each read that answers replaces that with what it found. `left.app` and `left.sitemap` are true, false, or null when nothing says;
// `written` is true when either is true, false when both are false, and null otherwise: no row is known to exist, and one could not be read. `appId` is only
// ever an app that is known to exist; the id the create used is offered as something to look for when a read failed, and `sitemapId` is always the one the
// script chose.
async function readLeftovers(sdk, { uniqueName, sitemapId, appId, stage }) {
  const [mineApp, mineSitemap] = [lower(appId), lower(sitemapId)];
  let saved;
  let published;
  let sitemapIds;
  let readBackError;
  try {
    saved = await readSavedApps(sdk, { uniqueName });
    published = await readPublishedIds(sdk, { uniqueName });
    const sitemaps = await sitemapsNamed(sdk, uniqueName);
    if (sitemaps.some((row) => !GUID.test(lower(row && row.sitemapid)))) throw new Error('the platform answered a site map with no id, so what is left cannot be told');
    sitemapIds = sitemaps.map((row) => lower(row.sitemapid));
  } catch (err) {
    readBackError = String((err && err.message) || err);
  }

  const impliedByPush = stage !== 'create' ? true : null;
  const appRows = saved && saved.get(mineApp);
  const app = appRows && published ? describeApp(mineApp, appRows, published) : undefined;
  const left = {
    // An app that reads as neither published nor changed was deleted between the two reads, and is not there (deletedBetweenReads).
    app: saved ? Boolean(appRows) && !(app && deletedBetweenReads(app)) : impliedByPush,
    sitemap: sitemapIds ? sitemapIds.includes(mineSitemap) : impliedByPush,
  };
  const otherApp = saved && [...saved.keys()].find((id) => id !== mineApp);
  const otherSitemap = sitemapIds && sitemapIds.find((id) => id !== mineSitemap);
  const nameTakenBy = { ...(otherApp ? { appId: otherApp } : {}), ...(otherSitemap ? { sitemapId: otherSitemap } : {}) };
  return {
    written: left.app === true || left.sitemap === true ? true : left.app === false && left.sitemap === false ? false : null,
    stage,
    ...(left.app === true ? { appId } : {}),
    uniqueName,
    sitemapId,
    ...(left.app === null && left.sitemap === null ? {} : { left }),
    ...(left.app === true && app ? { published: app.published, unpublishedChanges: app.unpublishedChanges } : {}),
    ...(Object.keys(nameTakenBy).length ? { nameTakenBy } : {}),
    ...(readBackError === undefined ? {} : { lookFor: { uniqueName, appId, sitemapId }, readBackError }),
  };
}

async function writeApp(sdk, args, plan, sitemapId) {
  const { solution, pages, uniqueName, languageCode, pins } = plan;
  const systemSolution = isRestrictedSolution(solution.uniqueName);
  // What the run has done, for the output. `pushBegan`: the first request that can write has been sent, so something may exist, and a failure from
  // then on reads the platform back. `inSolution` is each component as its AddSolutionComponent lands, so a failure between the two says which of
  // them is in the solution; `warnings` are the SDK's notes on the push.
  const made = { pushBegan: false, appId: undefined, inSolution: [], published: false, warnings: [] };
  const bothInSolution = () => made.inSolution.includes('app') && made.inSolution.includes('sitemap');
  // What the output says about the solution, on a success as on a failure. A system solution (Default, Active, Basic) holds every component already,
  // so nothing is added to it and `inSolution` stays empty; `systemSolution` says that is why, which an empty list alone reads as the app being left out.
  const solutionFacts = () => ({
    addedToSolution: bothInSolution(),
    inSolution: [...made.inSolution],
    ...(systemSolution ? { systemSolution: true } : {}),
  });
  // The notes on the views come first (they were made before the push), then the SDK's own.
  const warningFacts = () => {
    const all = [...pins.warnings, ...made.warnings];
    return all.length ? { warnings: all } : {};
  };
  let stage = 'create';
  try {
    await sdk.initWorkspace();
    const art = await sdk.createArtifact('app', appDefinition({ name: args.name, description: args.description, uniqueName, pages, sitemapId, viewIds: pins.viewIds }));
    made.appId = art.id;
    made.pushBegan = true;
    const pushed = await sdk.pushArtifact('app', art.id);
    // The push's own id is the app's, as the build addresses it afterwards: the SDK moves the workspace key to the server's id when the two differ.
    made.appId = (pushed && pushed.id) || art.id;
    // Taken before the push is judged, so a failure at any stage still reports them: a failed run is the one that most needs to know that, say,
    // the System Administrator role could not be associated.
    made.warnings = [...((pushed && pushed.warnings) || [])];
    // The SDK reports some failed pushes by value; a push that was not saved is a failure here as it is to the build.
    if (pushFailed(pushed)) {
      throw Object.assign(new Error((pushed.error && pushed.error.message) || 'the push was not saved'), pushed.error && pushed.error.code ? { code: pushed.error.code } : {});
    }

    stage = 'solution';
    // The call is skipped for a system solution rather than risk a refusal after the app was written.
    if (!systemSolution) {
      await sdk.addSolutionComponent({ componentId: made.appId, componentType: COMPONENT_TYPE_APP, solutionUniqueName: solution.uniqueName });
      made.inSolution.push('app');
      await sdk.addSolutionComponent({ componentId: sitemapId, componentType: COMPONENT_TYPE_SITEMAP, solutionUniqueName: solution.uniqueName });
      made.inSolution.push('sitemap');
    }

    if (args.publish) {
      stage = 'publish';
      // A failed publish is reported by value (`publish.kind: 'failed'`), not thrown.
      const outcome = ((await sdk.publishArtifact('app', made.appId)) || {}).publish || {};
      if (outcome.kind !== 'submitted' && outcome.kind !== 'verified') {
        throw outcome.error || new Error(`the publish was not accepted (${outcome.kind || 'no answer'})`);
      }
      made.published = true;
    }
    return {
      ok: true,
      appId: made.appId,
      uniqueName,
      name: args.name,
      published: made.published,
      // A draft is a saved row with no published one; a publish takes the saved row into the published layer, so none is left.
      unpublishedChanges: !made.published,
      solution: solution.uniqueName,
      ...solutionFacts(),
      sitemapId,
      languageCode,
      navigation: { area: AREA_TITLE, group: GROUP_TITLE, pages: pages.map((page) => ({ pageId: page.id, title: page.title })) },
      dataSources: pins.dataSources,
      pinnedViews: pins.viewIds,
      ...warningFacts(),
    };
  } catch (err) {
    // Before the push began — in the workspace, which only this run sees — nothing was written.
    if (!made.pushBegan) return failure(err, { written: false });
    return failure(err, { ...(await readLeftovers(sdk, { uniqueName, sitemapId, appId: made.appId, stage })), ...solutionFacts(), ...warningFacts() });
  }
}

// --- the command line ------------------------------------------------------------------------------------------------------

function usageError(message) {
  makeWritesBlocking(process.stdout, process.stderr);
  process.stderr.write(`✗ ${message}\n${USAGE}\n`);
  process.exit(1);
}

// A boolean flag carries no value: `parseArgs` would take the next word for one (`--publish yes` publishes nothing and swallows `yes`).
function requireBare(flags, name) {
  if (flags[name] !== undefined && flags[name] !== true) usageError(`--${name} takes no value (got '${flags[name]}')`);
}

const COMMANDS = {
  list: { known: ['env', 'search'], needValue: ['env', 'search'] },
  create: {
    known: ['env', 'name', 'solution', 'page-id', 'unique-name', 'description', 'publish'],
    needValue: ['env', 'name', 'solution', 'page-id', 'unique-name', 'description'],
  },
};

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, command)) {
    usageError(command === undefined ? 'a command is required: list or create' : `unknown command '${command}': list or create`);
  }
  const flagError = validateFlags(argv, COMMANDS[command]);
  if (flagError) usageError(flagError);
  if (positional.length > 1) usageError(`unexpected argument '${positional[1]}'`);
  if (!flags.env) usageError('--env is required');
  let env;
  try {
    env = requireDataverseOrigin(flags.env);
  } catch (err) {
    usageError(err.message);
  }

  let args;
  if (command === 'create') {
    for (const name of ['name', 'solution']) if (!flags[name]) usageError(`--${name} is required`);
    requireBare(flags, 'publish');
    const pageIds = pageIdArguments(argv);
    if (pageIds.problem) usageError(pageIds.problem);
    args = {
      env,
      name: flags.name.trim(),
      solution: flags.solution.trim(),
      pageIds: pageIds.ids,
      ...(flags['unique-name'] !== undefined ? { uniqueName: flags['unique-name'].trim() } : {}),
      ...(flags.description !== undefined ? { description: flags.description } : {}),
      publish: flags.publish === true,
    };
  }

  // emitResult() ends the process, so the outcome is settled first and emitted outside the try: an exit inside it would be caught as a failure.
  let result;
  try {
    result = command === 'list' ? await listApps(env, { search: flags.search }) : await createApp(args);
  } catch (err) {
    result = failure(err, command === 'create' ? { written: false } : {});
  }
  // The SDK's notes on the push, for a run that finished and for one that failed after it: the failed run is the one that most needs them.
  // The run's last writes: these lines, then the result and the exit, with no turn of the event loop between them — made blocking (lib/output-redaction.js).
  makeWritesBlocking(process.stdout, process.stderr);
  for (const warning of result.warnings || []) process.stderr.write(`⚠ ${warning}\n`);
  emitResult(result.ok, result, { ascii: true });
}

// `COMMANDS` is the flag contract the eval graders read (evals/model-apps/genpage/lib/evidence-utils.js, scriptSwitches): which flags take no value, from the script itself rather than from a copy that
// could drift, as genpage.js exports its `VERBS`.
module.exports = { listApps, createApp, deriveUniqueName, pageIdArguments, COMMANDS };

if (require.main === module) {
  main().catch((err) => {
    makeWritesBlocking(process.stdout, process.stderr);
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
