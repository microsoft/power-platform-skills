'use strict';
// The pages lock exactly as model-apps 2.17.0 and 2.18.0 take it: ONE file, `pages-<app unique name, unsafe characters as _>.lock`, spelled as the
// app's name is spelled. A build of those releases is still out there while makers upgrade, and the pages lock of this release must keep it out of the
// pages phase — and be kept out by it — when both spell the app the same way. This is that release's function, kept verbatim (only the requires
// changed), so the tests meet the protocol an old build really follows rather than a reading of it.
const path = require('node:path');
const { acquireLease, releaseLease } = require('../../lib/apply-snapshot-store.js');
const { ownerStamp, ownerState, describeOwner } = require('../../lib/process-owner.js');
const { BuildHalt } = require('../../lib/entity-provision.js');
const { RETRY } = require('../../lib/retry-policy.js');

function acquireLegacyPagesLease(wsDir, appUnique, deps = {}) {
  const now = deps.now || (() => Date.now());
  const file = `pages-${String(appUnique).replace(/[^A-Za-z0-9_-]/g, '_')}.lock`;
  const lockPath = path.join(wsDir, file);
  const lease = acquireLease(wsDir, { file, now, stamp: ownerStamp({ ...deps.owner, now }), isStale: (held) => ownerState(held, deps.owner).state === 'gone' });
  if (!lease.ok) {
    if (lease.error) throw lease.error;
    const unreleased = lease.stale ? ` The build that held it is no longer running, but its lock could not be released: ${lease.reason}.` : '';
    throw new BuildHalt(`another build is deploying pages for '${appUnique}' — refusing a second concurrent pages deploy (would risk duplicate page creation). Retry after it finishes, or delete ${lockPath} if it is stale.${unreleased}`, { phase: 'pages', code: 'pages-locked', recoverable: true, retry: RETRY.NEVER });
  }
  if (lease.reclaimed && typeof deps.warn === 'function') {
    deps.warn(`released the pages lock for '${appUnique}': the build that held it (${describeOwner(lease.previous)}) is no longer running`);
  }
  return { release: () => releaseLease(lease) };
}

module.exports = { acquireLegacyPagesLease };
