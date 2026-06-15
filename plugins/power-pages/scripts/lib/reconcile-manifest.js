#!/usr/bin/env node

// Reconciles the local .git-integration-manifest.json against server truth from
// detect-git-binding.js. A stale manifest is a silent-drift footgun: the local
// file can claim bound=true (e.g. after the ADO branch was deleted, or the
// binding was torn down in the maker portal) while the server says bound=false,
// causing inner-loop skills to misbehave in Phase 1. This helper surfaces the
// divergence and the available remediations so the skill can ask the user
// instead of trusting stale local state.
//
// Pure function — no I/O, no Dataverse calls. Callers pass the parsed manifest
// and the detect-git-binding output; this returns the comparison.
//
// Output:
//   {
//     aligned: boolean,                 // true when local and server agree
//     divergences: [ { field, local, server } ],
//     options: [ "overwrite-from-server" | "rebind-old-coords" | "clear-local" ],
//     summary: "<one-line human description>"
//   }
//
// The `options` list is the set of remediations that make sense for the
// observed divergence (see references/manifest-contract.md):
//   - overwrite-from-server : trust the server, rewrite the local manifest.
//                             Always offered when there is any divergence.
//   - rebind-old-coords     : the local manifest names coordinates the server
//                             no longer has — offer to re-bind using them.
//                             Offered when local is bound but server is not.
//   - clear-local           : wipe the local manifest and start fresh.
//                             Offered when local claims a binding the server
//                             does not corroborate.
//
// Usage (library):
//   const { reconcileManifest } = require('./reconcile-manifest');
//   const r = reconcileManifest({ manifest, serverBinding });

'use strict';

// Fields that define a binding's identity. Compared in this order so the
// divergence list is stable.
const COMPARED_FIELDS = Object.freeze([
  'bound',
  'gitIntegrationId',
  'bindingType',
  'organization',
  'project',
  'repository',
  'branch',
  'gitFolder',
  'solutionUniqueName',
]);

// Normalise a value for comparison: undefined → null, trim + lowercase host-ish
// strings is NOT done here (we keep exact values) except trailing-slash on URLs
// is out of scope (these are coordinate names, not URLs).
function norm(v) {
  return v === undefined ? null : v;
}

/**
 * @param {object} input
 * @param {object|null} input.manifest        Parsed .git-integration-manifest.json (or null/{}).
 * @param {object|null} input.serverBinding   detect-git-binding.js output.
 * @returns {{ aligned: boolean, divergences: Array, options: string[], summary: string }}
 */
function reconcileManifest({ manifest, serverBinding } = {}) {
  const local = manifest && typeof manifest === 'object' ? manifest : {};
  const server = serverBinding && typeof serverBinding === 'object' ? serverBinding : {};

  const localBound = local.bound === true;
  const serverBound = server.bound === true;

  // Build the divergence list across the identity fields. When neither side is
  // bound, only `bound` matters (the other fields are meaningless).
  const divergences = [];
  for (const field of COMPARED_FIELDS) {
    // Only compare coordinate fields when at least one side claims a binding;
    // when both are unbound, the coordinates are meaningless.
    if (field !== 'bound' && !localBound && !serverBound) continue;
    const lv = norm(local[field]);
    const sv = norm(server[field]);
    if (lv === sv) continue;
    divergences.push({ field, local: lv, server: sv });
  }

  const aligned = divergences.length === 0;

  // Determine remediation options.
  const options = [];
  if (!aligned) {
    options.push('overwrite-from-server');
    if (localBound && !serverBound) {
      // Local names coordinates the server lost — re-bind is meaningful.
      options.push('rebind-old-coords');
      options.push('clear-local');
    } else if (!localBound && serverBound) {
      // Server is the source of truth; nothing local to re-bind from.
      // overwrite-from-server already covers it.
    } else {
      // Both bound but coordinates differ → let the user clear and start fresh
      // in addition to trusting the server.
      options.push('clear-local');
    }
  }

  let summary;
  if (aligned) {
    summary = serverBound
      ? 'Local manifest matches server binding.'
      : 'Local manifest and server agree: not bound.';
  } else if (localBound && !serverBound) {
    summary = 'Local manifest claims a binding the server no longer has (stale manifest).';
  } else if (!localBound && serverBound) {
    summary = 'Server is bound but the local manifest does not reflect it.';
  } else {
    summary = 'Local manifest and server binding disagree on coordinates.';
  }

  return { aligned, divergences, options, summary };
}

module.exports = { reconcileManifest, COMPARED_FIELDS };
