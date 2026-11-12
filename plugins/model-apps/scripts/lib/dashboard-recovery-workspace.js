'use strict';
// The workspace a declared dashboard's settle and publish read and write through, and the isolated one they move to when the
// maker's workspace holds this build's own create draft (dashboard-reconcile.js preflightDashboard).
//
// WHY ISOLATED, AND NOT A REFRESH OF THE COPY. A run can stop after the service acknowledged a dashboard's create (the receipt
// is in the binding store) and before the SDK recorded the copy as synced, so the next run finds the copy "edited". When that
// copy is, whole, exactly the draft the receipt was recorded for, the next run may recover the create. It must not do that by
// reading the copy's hash and then fetching over it (`fetchArtifact(..., { overwrite: true })`): another local writer can edit
// the copy between the two, and the build's lease does not exclude it. So the copy is never written: the settle (its reads,
// proof and any later write) and the publish run in a fresh workspace of their own, made through lib/maker-sdk.js over the
// SAME already-gated HTTP client, instance and language (and the solution header only if the source has one). No second
// auth client, retry budget, send observer or barrier is made. The isolated folder is removed when the callback ends; the
// maker's copy stays as it was, and refreshing it is left to the maker.
//
//   await withDashboardWorkspaceScope({ sourceSdk: provision }, async (scope) => {
//     const settled = await settleDeclaredDashboard({ ..., sdk: provision, workspaceScope: scope });
//     await publishDeclaredDashboard({ ..., sdk: scope.currentSdk });
//   });
const fs = require('node:fs');
const crypto = require('node:crypto');
const { makeTempWorkspace } = require('./temp-workspace.js');
const { canonicalJson } = require('./reconcile-common.js');
// Loaded lazily, by the one accessor below: only a declared dashboard's retained create copy is read through it, and a
// default build must not load the stable-identity modules creates-local.js depends on (creates-port.test.js).
const createsLocal = () => require('./creates-local.js');

const KIND = 'dashboard';

/**
 * The maker's copy at `id`, read only locally: a pending create's draft, or a synced copy with edits (the SDK does not
 * refresh a dirty copy on a read). Anything else — a clean copy, which a read could refresh over, none, or one the SDK
 * cannot read consistently — answers null (creates-local.js readLocalCreateState). preflightDashboard reads it the same way.
 */
async function localCopy(sdk, id) {
  const local = await createsLocal().readLocalCreateState(sdk, KIND, id);
  if (local.state === 'pending') return local.draft;
  if (local.state === 'synced' && local.dirty) return await sdk.getArtifact(KIND, id);
  return null;
}

const changedSource = (id) => Object.assign(new Error(`the local copy of dashboard ${id} changed while the build recovered its create; the copy was kept as it is and nothing was bound. Run the build again`), {
  code: 'create-completion-required',
  category: 'workspace-copy-unsent-edits',
  id,
});

/**
 * Runs `fn(scope)` with a dashboard workspace scope over `sourceSdk`, and removes the isolated workspace (only it) when
 * `fn` ends, however it ends. The scope:
 *   sourceSdk               the maker's workspace SDK, never written through once the scope is isolated;
 *   currentSdk              the SDK to work through: `sourceSdk` until activateIsolated, the isolated one after;
 *   activateIsolated({ id, draftSha256 })  make the isolated SDK (once; later calls for the same id and hash answer it
 *                           again, another id or hash is refused) and record the source copy's draft hash;
 *   assertSourceUnchanged() no-op before activation; after it, the source copy at `id` must still hash to `draftSha256`
 *                           (a local read: a dirty copy is never refreshed by the SDK), or it throws
 *                           `create-completion-required` (category `workspace-copy-unsent-edits`).
 * @param {{ sourceSdk: object, deps?: { makerSdk?: object } }} options
 * @param {(scope: object) => Promise<*>} fn
 */
async function withDashboardWorkspaceScope({ sourceSdk, deps = {} } = {}, fn) {
  if (!sourceSdk || typeof fn !== 'function') throw new TypeError('withDashboardWorkspaceScope needs the source SDK and a callback');
  let isolatedDir = null;
  let isolated = null;
  let recorded = null;
  const scope = {
    get sourceSdk() { return sourceSdk; },
    get currentSdk() { return isolated || sourceSdk; },
    get isolated() { return !!isolated; },
    async activateIsolated({ id, draftSha256 } = {}) {
      if (typeof id !== 'string' || !id || typeof draftSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(draftSha256)) {
        throw new TypeError('activateIsolated needs the copy\'s id and its recorded draft hash');
      }
      if (recorded) {
        if (recorded.id !== id || recorded.draftSha256 !== draftSha256) throw new Error('the dashboard workspace scope is already isolated for another copy');
        return isolated;
      }
      const conn = sourceSdk.dataverse;
      if (!conn || typeof conn.instanceUrl !== 'string' || !conn.httpClient) throw new Error('the SDK exposes no connection to make an isolated workspace over');
      const dir = makeTempWorkspace('dashboard-recover-');
      try {
        const { createMakerSdk, createNodeWorkspaceStorage } = deps.makerSdk || require('./maker-sdk.js');
        const made = createMakerSdk({
          workspaceStorage: createNodeWorkspaceStorage(dir),
          instanceUrl: conn.instanceUrl,
          httpClient: conn.httpClient,
          ...(sourceSdk.languageCode !== undefined && sourceSdk.languageCode !== null ? { languageCode: sourceSdk.languageCode } : {}),
          // The solution header only when the source sends one: a header-less provision SDK must stay header-less.
          ...(typeof conn.solutionUniqueName === 'string' && conn.solutionUniqueName ? { solutionUniqueName: conn.solutionUniqueName } : {}),
        });
        await made.initWorkspace();
        isolated = made;
        isolatedDir = dir;
      } catch (err) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw err;
      }
      recorded = { id, draftSha256 };
      return isolated;
    },
    async assertSourceUnchanged() {
      if (!recorded) return;
      const art = await localCopy(sourceSdk, recorded.id).catch(() => null);
      const hash = art && typeof art === 'object' ? crypto.createHash('sha256').update(canonicalJson(art)).digest('hex') : null;
      if (hash !== recorded.draftSha256) throw changedSource(recorded.id);
    },
  };
  try {
    return await fn(scope);
  } finally {
    if (isolatedDir) {
      try {
        fs.rmSync(isolatedDir, { recursive: true, force: true });
      } catch {
        // A folder that held only this build's isolated read must not turn a finished settle into a failure, or hide a failed one.
      }
    }
  }
}

module.exports = { withDashboardWorkspaceScope, readRetainedCopy: localCopy };
