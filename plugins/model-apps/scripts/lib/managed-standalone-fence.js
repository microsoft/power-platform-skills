'use strict';
// The managed fence of a publishing or app-writing invocation that is not a build: `genpage.js add-to-app` and
// `remove-from-app`, the placing `genpage-upload.js`, and `teardown-model-app.js`. Each runs against an app whose build may
// have left managed debt in its workspace's binding store (lib/managed-bindings.js): an attempt not yet proved (a hold),
// or a publication that may have been sent and is not confirmed (a quarantine). A build discovers that debt through
// openManagedContext before its first publish; these entries must discover it the same way, or a page edit's app publish
// or a teardown's table publish would put live the saved state the build withheld.
//
// Read-only, as openManagedContext's discovery is: nothing is created, and a missing store installs nothing. The barrier it
// fills is the one the invocation's transport is gated by (publicationBarrier.gateRequest) and the one its app write asks
// (checkAppWrite), so the same rules a build follows apply.
//
// Which store: a store file is named by the environment, the app's unique name and the solution's unique name
// (managed-bindings.js storeFileName). A build passes its spec; a standalone page edit reads the app folder's
// `app-spec.json`, the spec the build of that workspace ran from. Fail-closed: a workspace that holds a store file while the
// names cannot be read refuses (`managed-binding-store-unreadable`), because debt this run cannot see must never read as none.
const fs = require('fs');
const path = require('path');
const { PREFIX, CODES, openManagedContext, isStoreEnvironment } = require('./managed-bindings.js');
const { createPublicationBarrier, describeWithheldApp } = require('./publication-barrier.js');
const { applyWorkspaceOf } = require('./app-operation-lease.js');
const { appUniqueName } = require('./app-unique-name.js');

const STORE_FILE = new RegExp(`^${PREFIX.replace(/\./g, '\\.')}[0-9a-f]{64}\\.json$`, 'i');
// The code of an app write a standalone entry refused because managed debt withholds a table or dashboard it may put live.
const APP_WRITE_WITHHELD = 'publication-withheld';

function fenceError(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra || {});
}

function storeFilesIn(workspaceDir) {
  let names;
  try {
    names = fs.readdirSync(workspaceDir);
  } catch (e) {
    // No folder at that path: ENOENT when it is missing, ENOTDIR when it names a file or lies under one. Windows answers ENOENT
    // for a path under a file where POSIX answers ENOTDIR, and a path that IS a file answers ENOTDIR on both. A store can be
    // in neither, so both read as "no store", the same on every platform; the caller's own folder check (lib/safe-fs.js
    // assertSafeOutputDir) refuses a write there. Any other error stays unreadable: debt this run cannot see is not none.
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return [];
    throw fenceError(CODES.unreadable, `the workspace ${workspaceDir} could not be listed for a managed binding store (${(e && e.code) || e})`);
  }
  return names.filter((n) => STORE_FILE.test(n));
}

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

// The names the build gave the store (lib/sdk-build.js openBuildBindingGroups): the app's by the build's own rule
// (lib/app-unique-name.js — `app.uniqueName` is optional, an authored spec derives it from the publisher prefix and the display
// name) and the solution's unique name. { app, solution }; `app` is null when the spec gives neither form, `solution` null when
// it names none. Never a guess: a part the spec cannot give is null, and the caller decides whether that fails closed.
function namesOf(spec) {
  if (!spec || typeof spec !== 'object') return { app: null, solution: null };
  const solution = spec.solution && nonEmpty(spec.solution.uniqueName) ? spec.solution.uniqueName : null;
  const app = spec.app && typeof spec.app === 'object' ? spec.app : null;
  let name = null;
  if (app && nonEmpty(app.uniqueName)) name = appUniqueName(spec);
  else if (app && nonEmpty(app.name) && spec.solution && nonEmpty(spec.solution.publisherPrefix)) name = appUniqueName(spec) || null;
  return { app: name, solution };
}

function readSpecNames(appDir) {
  try {
    return namesOf(JSON.parse(fs.readFileSync(path.join(appDir, 'app-spec.json'), 'utf8')));
  } catch {
    return { app: null, solution: null };
  }
}

/**
 * Discover the managed debt of one app's workspace into a publication barrier.
 * opts: { environment, appDir?, workspaceDir?, spec?, barrier?, appUniqueName? } — `spec` names the app and solution (else the
 * app folder's app-spec.json); `appUniqueName` is the app's name as the service gives it (the pages lease is keyed by it,
 * lib/standalone-page-lease.js), discovered beside the spec's own name when the two differ; `barrier` is filled (a new one
 * when omitted). Answers { barrier, absent, debt }. Throws `managed-binding-store-unreadable` for a store it cannot trust or
 * a workspace with a store whose app or solution cannot be named.
 */
function openStandaloneManagedFence({ environment, appDir, workspaceDir, spec, barrier, appUniqueName: leased } = {}) {
  const gate = barrier || createPublicationBarrier();
  const none = { barrier: gate, absent: true, debt: [] };
  if (!isStoreEnvironment(environment)) return none;
  const ws = applyWorkspaceOf({ workspaceDir, appDir });
  if (!storeFilesIn(ws).length) return none;
  const names = spec ? namesOf(spec) : readSpecNames(appDir ? path.resolve(appDir) : path.dirname(path.resolve(ws)));
  const apps = [...new Set([names.app, nonEmpty(leased) ? leased : null].filter(Boolean))];
  if (!names.solution || !apps.length) {
    throw fenceError(CODES.unreadable, `the workspace ${ws} holds a managed binding store, and the app and solution it belongs to could not be read from the app's app-spec.json — nothing was changed; run from the app folder (or name it with --app-dir) so the build's withheld publications are seen`);
  }
  let absent = true;
  const debt = [];
  for (const app of apps) {
    const ctx = openManagedContext({ workspaceDir: ws, environment, appUniqueName: app, solutionUniqueName: names.solution, barrier: gate });
    absent = absent && ctx.absent;
    debt.push(...ctx.debt);
  }
  return { barrier: gate, absent, debt };
}

/**
 * Refuse an app write of an existing app while the fence withholds anything: the app's holdings are not read by a standalone
 * entry, so, as checkAppWrite does for holdings it could not read, any withheld table or dashboard refuses. Throws a coded
 * error (`publication-withheld`, outcome 'nothing') before anything is written; returns quietly otherwise.
 */
function assertStandaloneAppWrite(fence, extra) {
  if (!fence || !fence.barrier) return;
  const verdict = fence.barrier.checkAppWrite({ existingApp: true });
  if (verdict.ok) return;
  throw fenceError(APP_WRITE_WITHHELD, describeWithheldApp(verdict), { outcome: 'nothing', ...(extra || {}) });
}

/**
 * The fence of a standalone app write made under the app's build and pages leases (genpage.js add-to-app / remove-from-app, the placing
 * genpage-upload.js). Two reads, and only the second one decides:
 *   - now, before the backend exists: an early refusal (thrown, as assertStandaloneAppWrite) that saves building a backend for
 *     an edit that cannot run. Its barrier is thrown away;
 *   - `underLease({ appUniqueName })`, inside the app's build and pages leases (lib/standalone-page-lease.js) and before the
 *     edit's first read or write: the store is discovered again into `barrier`, by the spec's app name and by the name the
 *     leases are keyed by, and the app write is refused if anything is withheld. A build holds the build lease for its whole
 *     apply, so debt it left after the first read — while this entry read the app's name, before it took the leases — is
 *     seen here; once the leases are held no build of this workspace can add more.
 * `barrier` is what the backend's transport is gated by. It exists whenever the environment can hold a store, even with no
 * store yet: one may appear before the lease is taken, and the transport must screen by what the leased read discovers. An
 * empty barrier passes every request through as it is (publication-barrier.js gateRequest), so no store changes nothing.
 */
function openStandaloneAppWriteFence({ environment, appDir, workspaceDir, appId } = {}) {
  assertStandaloneAppWrite(openStandaloneManagedFence({ environment, appDir, workspaceDir }), { appId });
  const barrier = isStoreEnvironment(environment) ? createPublicationBarrier() : null;
  return {
    barrier,
    underLease({ appUniqueName } = {}) {
      if (!barrier) return;
      assertStandaloneAppWrite(openStandaloneManagedFence({ environment, appDir, workspaceDir, barrier, appUniqueName }), { appId });
    },
  };
}

module.exports = { openStandaloneManagedFence, assertStandaloneAppWrite, openStandaloneAppWriteFence, APP_WRITE_WITHHELD };
