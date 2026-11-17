'use strict';
// The pages lease for a page edit made OUTSIDE a build: `genpage.js add-to-app` / `remove-from-app` (and their --draft forms) and the placing
// `genpage-upload.js` write an app's navigation just as the build's pages phase does, so they take the same lease the build takes
// (lib/app-operation-lease.js acquireAppPagesLease) for the whole edit — read, write and publish — and the build lease a whole apply takes
// (withAppBuildLease). A build of the app, or another standalone edit of it, then refuses with `build-locked` or `pages-locked` instead of
// interleaving its writes with this one.
//
// What it is and is not, as acquireAppPagesLease says: a SINGLE-MACHINE advisory lock in one workspace folder, keyed by the app's unique name. It
// serialises only against a build or an edit that names the SAME workspace (the app folder's `.maker-workspace`, applyWorkspaceOf): a caller
// that runs from elsewhere must name the app folder (`appDir`) or the workspace (`workspaceDir`), and a host without a shared file system must
// serialise these edits itself. It is not a compare-and-swap on the service: correctness of each write still rests on the backend's own checks.
//
// The app's unique name is read from the service (genpage.appUniqueName: one GET of the saved layer), because a standalone edit is given only the
// app's id; the lock file names are derived from that name exactly as a build derives them from its spec, so both name the same file. An app whose
// name cannot be read is refused before anything is written (fail closed: an edit under no lease is the race this exists to stop).
const { acquireAppPagesLease, applyWorkspaceOf, withAppBuildLease } = require('./app-operation-lease.js');
const { genpageError } = require('./page-content.js');

const GENPAGE_APP_LEASE_UNRESOLVED = 'GENPAGE_APP_LEASE_UNRESOLVED';

// opts: { genpage, appId, appDir?, workspaceDir?, warn?, acquire? } — `acquire` is a test seam for acquireAppPagesLease. `fn({ appUniqueName })` runs
// while the leases are held, given the name they are keyed by, and the leases are let go however it ends.
async function withStandalonePagesLease(opts, fn) {
  const { genpage, appId, warn } = opts;
  const acquire = opts.acquire || acquireAppPagesLease;
  if (!genpage || typeof genpage.appUniqueName !== 'function') {
    throw genpageError(`the page backend cannot name app ${appId}, so the lease that keeps a build from editing it at the same time cannot be taken — nothing was changed`, { code: GENPAGE_APP_LEASE_UNRESOLVED, outcome: 'nothing', appId });
  }
  // A name that cannot be read — the service failed the read, or answered with no readable rows — is the same refusal as an app that is not there:
  // nothing has been read for the edit or written yet, and the edit must not run unleased. The read's own failure is kept in the message and as `cause`.
  let unique;
  try {
    unique = await genpage.appUniqueName(appId);
  } catch (error) {
    const why = String((error && error.message) || error);
    throw genpageError(`the unique name of app ${appId} could not be read (${why}), so the lease that keeps a build from editing it at the same time cannot be taken — nothing was changed; run the command again once the app can be read`, { code: GENPAGE_APP_LEASE_UNRESOLVED, outcome: 'nothing', appId, cause: error, transient: !!(error && error.transient) });
  }
  if (!unique) {
    throw genpageError(`app ${appId} was not found, so the lease that keeps a build from editing it at the same time cannot be taken — nothing was changed`, { code: GENPAGE_APP_LEASE_UNRESOLVED, outcome: 'nothing', appId });
  }
  // Both leases are taken before anything is read for the edit or written, so a refusal (`build-locked` or `pages-locked`: a build or another edit
  // holds one) changed nothing; say so, and name the app, as every other refusal of a page edit does.
  const refused = (error) => {
    if (error && typeof error === 'object') {
      if (error.outcome === undefined) error.outcome = 'nothing';
      if (error.appId === undefined) error.appId = appId;
    }
    return error;
  };
  const ws = applyWorkspaceOf({ workspaceDir: opts.workspaceDir, appDir: opts.appDir });
  // The build lease too, in the order a build takes them (build, then pages): a build holds the pages lease only in its pages phase, and its views
  // and charts phases — which leave managed debt in this workspace's binding store (lib/managed-standalone-fence.js) — run outside it. Holding the
  // build lease for the whole edit keeps every build of this app in this workspace out, so the store the edit reads under the leases (`fn`'s
  // managed fence) stays the store until the edit has written and published.
  let entered = false;
  try {
    return await withAppBuildLease({ workspaceDir: ws, appUniqueName: unique, warn }, async () => {
      let lease;
      try {
        lease = acquire(ws, unique, { warn });
      } catch (error) {
        throw refused(error);
      }
      entered = true;
      try {
        return await fn({ appUniqueName: unique });
      } finally {
        lease.release();
      }
    });
  } catch (error) {
    throw entered ? error : refused(error);
  }
}

module.exports = { withStandalonePagesLease, GENPAGE_APP_LEASE_UNRESOLVED };
