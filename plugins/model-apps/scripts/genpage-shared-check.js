#!/usr/bin/env node
'use strict';
// genpage-shared-check: before /genpage uploads an edit to a page, name the OTHER apps whose navigation shows that page, and stop until the user has confirmed them.
//
// WHY. A page is an environment-level record: any app's navigation can name it, and an upload (genpage-upload.js with --page-id) replaces that record itself, so the edit reaches every app that
// shows the page — apps the user never opened, possibly another team's. The edit flow is app-scoped, so nothing in it says so. The app build already refuses to update a page another app's
// navigation names (`pages-shared-across-apps`); this is the same scan, run from the edit flow, which asks instead of refusing: reusing a page across apps is often deliberate.
//
// Usage: node scripts/genpage-shared-check.js --env <envUrl> --app-id <guid> --page-id <guid> [--confirmed-apps <uniqueName>[,<uniqueName>...]]
//   --app-id   the app the edit is made from (the one Edit Phase 1 selected): it is the app the edit is expected to change, so it is never named as "another app"
//   --confirmed-apps  the unique names (the `uniqueName` of the answer below) of the apps the USER confirmed this change may reach
//
// Output (stdout, one JSON line of pure ASCII). Every refusal is a line of its own, never a missing field, so a caller branches on the exit status and reads the rest:
//   exit 0  { "ok": true, "shared": false, "pageId": "<guid>", "appId": "<guid>", "apps": [] }
//             no other app's navigation, published or saved, names the page: say nothing, and go on to the upload.
//   exit 0  { "ok": true, "shared": true, "confirmed": true, "pageId": …, "appId": …, "apps": [ { "uniqueName": "contoso_ops", "name": "Operations", "appId": "<guid>", "savedOnly": false }, … ] }
//             other apps name it, and --confirmed-apps names every one of them: go on to the upload.
//   exit 2  { "ok": false, "code": "GENPAGE_SHARED_PAGE_UNCONFIRMED", "error": "<message>", "pageId": …, "appId": …, "apps": [ …every other app… ], "unconfirmed": ["contoso_ops"], "outcome": "nothing" }
//             other apps name it and the user has not confirmed all of them: ask, or — unattended — stop and report them. The exit status is 2, apart from the failures' 1, so a caller cannot take a
//             refusal that is a question for a failure of the scan, or the reverse. `unconfirmed` are the apps --confirmed-apps does not name, which is every app when the flag is absent.
//   exit 1  { "ok": false, "code": "GENPAGE_APPS_UNREADABLE" | <the backend's>, "error": "<message>", … }  or a usage error (stderr only, stdout stays empty)
//             the scan could not tell: an app's navigation could not be read, or the scan could not run. The page is NOT taken to be unshared (fail closed, as the app build does).
//
// A confirmation covers the apps it names and no other: an app that began to show the page after the user was asked is not in --confirmed-apps, so this refuses again and names it. An app
// confirmed that no longer shows the page changes nothing. This reads the environment and writes nothing; it is not a lock, so an app that takes the page in between this check and the upload is not
// covered (the same gap the deployed-page check documents).
//
// Like every script here it emits no telemetry of its own (the plugin's hooks do), and it never prints a token.

const { parseArgs, validateFlags, emitResult, requireDataverseOrigin } = require('./lib/dataverse-auth.js');
const { makeGenpageSdk, GUID_RE } = require('./lib/genpage-sdk.js');
const { makeWritesBlocking } = require('./lib/output-redaction.js');
const { leftOnDiskWarning } = require('./lib/left-on-disk.js');

// How long the backend's cleanup is waited for before the process ends: a storage call that never settles must not keep the script alive.
const DISPOSE_WAIT_MS = 10000;
// Exit status of a refusal that is a question for the user (see above); 1 stays the status of every failure.
const UNCONFIRMED_EXIT = 2;

const FLAGS = {
  known: ['env', 'app-id', 'page-id', 'confirmed-apps'],
  needValue: ['env', 'app-id', 'page-id', 'confirmed-apps'],
  required: ['env', 'app-id', 'page-id'],
};
const USAGE = 'Usage: node scripts/genpage-shared-check.js --env <envUrl> --app-id <guid> --page-id <guid> [--confirmed-apps <uniqueName>[,<uniqueName>...]]';

class UsageError extends Error {}

function repeatedFlag(argv) {
  // `parseArgs` keeps only the last of a repeat and drops the others without a word, and a confirmation must never be the half of a list.
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
 * The check a command line asks for, or a UsageError saying what is wrong with it. Nothing is read from the environment.
 * @returns {{ env: string, pageId: string, appId: string, confirmed: string[] }}
 */
function parseCommand(argv) {
  const { positional, flags } = parseArgs(argv);
  const flagError = validateFlags(argv, { known: FLAGS.known, needValue: FLAGS.needValue });
  if (flagError) throw new UsageError(flagError);
  if (positional.length) throw new UsageError(`unexpected argument '${positional[0]}'`);
  const repeated = repeatedFlag(argv);
  if (repeated) throw new UsageError(`--${repeated} was given more than once${repeated === 'confirmed-apps' ? ': give one --confirmed-apps with the unique names separated by commas' : ''}`);
  for (const name of FLAGS.required) if (flags[name] === undefined) throw new UsageError(`--${name} is required`);
  let env;
  try {
    env = requireDataverseOrigin(flags.env);
  } catch (error) {
    throw new UsageError(error.message);
  }
  let confirmed = [];
  if (flags['confirmed-apps'] !== undefined) {
    confirmed = String(flags['confirmed-apps']).split(',').map((name) => name.trim());
    // An empty entry (`a,,b`, or a bare `--confirmed-apps ''`) is a list somebody mangled: it confirms nothing, and a guess at what was meant must not become a confirmation.
    if (!confirmed.length || confirmed.some((name) => !name)) throw new UsageError(`--confirmed-apps '${flags['confirmed-apps']}' has an empty app name: give the unique names of the apps the user confirmed, separated by commas`);
  }
  return { env, pageId: idOf('page-id', flags['page-id']), appId: idOf('app-id', flags['app-id']), confirmed };
}

// An app as the maker would call it, for the question put to the user: its display name with the unique name that confirms it, or the unique name alone when the name could not be read.
const describeApp = (app) => `${app.name ? `${JSON.stringify(app.name)} (${app.uniqueName})` : app.uniqueName}${app.savedOnly ? ' [saved, not published]' : ''}`;

/**
 * What the apps found and the apps the user confirmed come to. An app is confirmed by its unique name in lower case, which is how Dataverse compares it; nothing but a name in `confirmed` covers it.
 * @param {{ uniqueName: string }[]} apps the other apps whose navigation names the page
 * @param {string[]} confirmed the unique names the user confirmed
 */
function decide(apps, confirmed) {
  const covered = new Set(confirmed.map((name) => name.toLowerCase()));
  const unconfirmed = apps.filter((app) => !covered.has(String(app.uniqueName).toLowerCase())).map((app) => app.uniqueName);
  return { shared: apps.length > 0, confirmed: apps.length > 0 && unconfirmed.length === 0, unconfirmed };
}

// The refusal's words: who is affected, why it matters, what happens next.
function unconfirmedMessage({ pageId, apps, unconfirmed }) {
  const list = apps.map(describeApp);
  const who = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  const confirmedBefore = unconfirmed.length < apps.length;
  return `this change also affects ${who}: page ${pageId} is in ${apps.length === 1 ? 'its' : 'their'} navigation too, and an upload replaces the page itself, so ${apps.length === 1 ? 'that app shows' : 'those apps show'} the edited page as well. Nothing was changed. `
    + `${confirmedBefore ? `Not yet confirmed: ${unconfirmed.join(', ')}. ` : ''}Ask the user to confirm the change for ${apps.length === 1 ? 'that app' : 'these apps'}, then run this check again with --confirmed-apps '${apps.map((a) => a.uniqueName).join(',')}'. `
    + 'An unattended run stops here and reports the apps: suppressing the question never authorizes a change to other apps.';
}

/**
 * Runs one command line and reports its outcome. `deps` is a test seam: `makeGenpageSdk(env)` (the page backend), `emit(ok, payload, options)`, `usageError(message)` and `waits` (the
 * scan's waits between its tries when an app cannot be read).
 */
async function main(argv = process.argv.slice(2), deps = {}) {
  const emit = deps.emit || ((ok, payload, options) => emitResult(ok, payload, { ascii: true, ...options }));
  let command;
  try {
    command = parseCommand(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    return (deps.usageError || exitWithUsage)(error.message);
  }
  const genpage = (deps.makeGenpageSdk || makeGenpageSdk)(command.env);
  // The backend's workspace is removed BEFORE anything is reported: emitResult ends the process, so a cleanup placed after it never runs.
  let outcome;
  let leftOnDisk = null;
  try {
    const found = await genpage.sharedWith(command.pageId, command.appId, deps.waits ? { waits: deps.waits } : {});
    const verdict = decide(found.apps, command.confirmed);
    if (verdict.shared && !verdict.confirmed) {
      outcome = { ok: false, options: { failureExitCode: UNCONFIRMED_EXIT }, payload: { ok: false, error: unconfirmedMessage({ pageId: found.pageId, apps: found.apps, unconfirmed: verdict.unconfirmed }), code: 'GENPAGE_SHARED_PAGE_UNCONFIRMED', pageId: found.pageId, appId: found.appId, apps: found.apps, unconfirmed: verdict.unconfirmed, outcome: 'nothing' } };
    } else {
      outcome = { ok: true, payload: { ok: true, shared: verdict.shared, ...(verdict.shared ? { confirmed: true } : {}), pageId: found.pageId, appId: found.appId, apps: found.apps } };
    }
  } catch (error) {
    const known = {};
    for (const key of ['pageId', 'appId', 'outcome', 'apps', 'unreadableApps']) if (error && error[key] !== undefined) known[key] = error[key];
    outcome = { ok: false, payload: { ok: false, error: String((error && error.message) || error), ...(error && typeof error.code === 'string' && error.code ? { code: error.code } : {}), ...known } };
  } finally {
    try { leftOnDisk = leftOnDiskWarning(await genpage.dispose({ waitMs: DISPOSE_WAIT_MS })); } catch { /* the backend's own throwaway folder; nothing to say when it cannot even answer */ }
  }
  if (leftOnDisk) (deps.stderr || ((text) => process.stderr.write(text)))(`⚠ ${leftOnDisk}\n`);
  return emit(outcome.ok, outcome.payload, outcome.options);
}

function exitWithUsage(message) {
  makeWritesBlocking(process.stdout, process.stderr);
  process.stderr.write(`✗ ${message}\n${USAGE}\n`);
  process.exit(1);
}

module.exports = { main, parseCommand, decide, unconfirmedMessage, UsageError, UNCONFIRMED_EXIT };

if (require.main === module) {
  main().catch((error) => {
    makeWritesBlocking(process.stdout, process.stderr);
    process.stderr.write(`Error: ${error && error.message ? error.message : error}\n`);
    process.exit(1);
  });
}
