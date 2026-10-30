'use strict';
// The pages lease for a page edit made OUTSIDE a build: `genpage.js add-to-app` / `remove-from-app` (and their --draft forms) and the placing
// `genpage-upload.js` write an app's navigation just as the build's pages phase does, so they take the same lease the build takes
// (lib/app-operation-lease.js acquireAppPagesLease) for the whole edit — read, write and publish. A build of the app, or another standalone edit of
// it, then refuses with `pages-locked` instead of interleaving its writes with this one.
//
// What it is and is not, as acquireAppPagesLease says: a SINGLE-MACHINE advisory lock in one workspace folder, keyed by the app's unique name. It
// serialises only against a build or an edit that names the SAME workspace (the app folder's `.maker-workspace`, applyWorkspaceOf): a caller
// that runs from elsewhere must name the app folder (`appDir`) or the workspace (`workspaceDir`), and a host without a shared file system must
// serialise these edits itself. It is not a compare-and-swap on the service: correctness of each write still rests on the backend's own checks.
//
// The app's unique name is read from the service (genpage.appUniqueName: one GET of the saved layer), because a standalone edit is given only the
// app's id; the lock file names are derived from that name exactly as a build derives them from its spec, so both name the same file. An app whose
// name cannot be read is refused before anything is written (fail closed: an edit under no lease is the race this exists to stop).
const { acquireAppPagesLease, applyWorkspaceOf } = require('./app-operation-lease.js');
const { genpageError } = require('./page-content.js');

const GENPAGE_APP_LEASE_UNRESOLVED = 'GENPAGE_APP_LEASE_UNRESOLVED';

// opts: { genpage, appId, appDir?, workspaceDir?, warn?, acquire? } — `acquire` is a test seam for acquireAppPagesLease. `fn` runs while the
// lease is held, and the lease is let go however it ends.
async function withStandalonePagesLease(opts, fn) {
  const { genpage, appId, warn } = opts;
  const acquire = opts.acquire || acquireAppPagesLease;
  if (!genpage || typeof genpage.appUniqueName !== 'function') {
    throw genpageError(`the page backend cannot name app ${appId}, so the lease that keeps a build from editing it at the same time cannot be taken — nothing was changed`, { code: GENPAGE_APP_LEASE_UNRESOLVED, outcome: 'nothing', appId });
  }
  const unique = await genpage.appUniqueName(appId);
  if (!unique) {
    throw genpageError(`app ${appId} was not found, so the lease that keeps a build from editing it at the same time cannot be taken — nothing was changed`, { code: GENPAGE_APP_LEASE_UNRESOLVED, outcome: 'nothing', appId });
  }
  const lease = acquire(applyWorkspaceOf({ workspaceDir: opts.workspaceDir, appDir: opts.appDir }), unique, { warn });
  try {
    return await fn();
  } finally {
    lease.release();
  }
}

module.exports = { withStandalonePagesLease, GENPAGE_APP_LEASE_UNRESOLVED };
