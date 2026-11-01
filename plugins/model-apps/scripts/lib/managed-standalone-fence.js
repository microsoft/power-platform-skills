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
    if (e && e.code === 'ENOENT') return [];
    throw fenceError(CODES.unreadable, `the workspace ${workspaceDir} could not be listed for a managed binding store (${(e && e.code) || e})`);
  }
  return names.filter((n) => STORE_FILE.test(n));
}

function namesOf(spec) {
  const app = spec && spec.app && spec.app.uniqueName;
  const solution = spec && spec.solution && spec.solution.uniqueName;
  return typeof app === 'string' && app.trim() && typeof solution === 'string' && solution.trim() ? { app, solution } : null;
}

function readSpecNames(appDir) {
  try {
    return namesOf(JSON.parse(fs.readFileSync(path.join(appDir, 'app-spec.json'), 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Discover the managed debt of one app's workspace into a publication barrier.
 * opts: { environment, appDir?, workspaceDir?, spec?, barrier? } — `spec` names the app and solution (else the app folder's
 * app-spec.json); `barrier` is filled (a new one when omitted). Answers { barrier, absent, debt }. Throws
 * `managed-binding-store-unreadable` for a store it cannot trust or a workspace with a store whose names cannot be read.
 */
function openStandaloneManagedFence({ environment, appDir, workspaceDir, spec, barrier } = {}) {
  const gate = barrier || createPublicationBarrier();
  const none = { barrier: gate, absent: true, debt: [] };
  if (!isStoreEnvironment(environment)) return none;
  const ws = applyWorkspaceOf({ workspaceDir, appDir });
  if (!storeFilesIn(ws).length) return none;
  const names = spec ? namesOf(spec) : readSpecNames(appDir ? path.resolve(appDir) : path.dirname(path.resolve(ws)));
  if (!names) {
    throw fenceError(CODES.unreadable, `the workspace ${ws} holds a managed binding store, and the app and solution it belongs to could not be read from the app's app-spec.json — nothing was changed; run from the app folder (or name it with --app-dir) so the build's withheld publications are seen`);
  }
  const ctx = openManagedContext({ workspaceDir: ws, environment, appUniqueName: names.app, solutionUniqueName: names.solution, barrier: gate });
  return { barrier: gate, absent: ctx.absent, debt: ctx.debt };
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

module.exports = { openStandaloneManagedFence, assertStandaloneAppWrite, APP_WRITE_WITHHELD };
