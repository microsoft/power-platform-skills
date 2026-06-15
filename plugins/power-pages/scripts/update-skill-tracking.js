#!/usr/bin/env node

// DEPRECATED LOCATION — this helper moved to scripts/lib/update-skill-tracking.js
// for consistency (all helpers live under scripts/lib/). This shim delegates to
// the new location so existing `node scripts/update-skill-tracking.js ...`
// invocations keep working; it will be removed after 2026-07-13. Update callers
// to the lib/ path.

process.stderr.write(
  '[DEPRECATION WARN] scripts/update-skill-tracking.js moved to ' +
  'scripts/lib/update-skill-tracking.js. Update your invocation path; ' +
  'this shim is removed after 2026-07-13.\n'
);

// The target runs its logic on require, reading the shared process.argv.
require('./lib/update-skill-tracking');
