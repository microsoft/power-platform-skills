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
  // Bug 9: `solutionUniqueName` corroboration. detect-git-binding may surface a
  // top-level `solutionUniqueName: null` (e.g. multiple bound solutions, or output
  // produced before the single-bound fallback) while `boundSolutions[]` DOES carry
  // the manifest's value. That is NOT a real divergence — treat it as aligned when
  // the server's boundSolutions corroborate the local manifest value. This removes
  // the false "stale manifest" gate (local "QuickFix" vs server null).
  const boundNames = Array.isArray(server.boundSolutions)
    ? server.boundSolutions.map((s) => s && s.uniqueName).filter(Boolean)
    : [];
  for (const field of COMPARED_FIELDS) {
    // Only compare coordinate fields when at least one side claims a binding;
    // when both are unbound, the coordinates are meaningless.
    if (field !== 'bound' && !localBound && !serverBound) continue;
    const lv = norm(local[field]);
    const sv = norm(server[field]);
    if (lv === sv) continue;
    if (field === 'solutionUniqueName' && sv == null && lv != null && boundNames.includes(lv)) {
      // server top-level is null but boundSolutions corroborates the manifest → aligned.
      continue;
    }
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

// ── Bug 8: CLI (the module used to be a library with NO CLI — invoking it with
// flags was a silent no-op). The pure `reconcileManifest` export above is unchanged;
// this block only wires it up for command-line use. Logic is factored into
// `runReconcileManifestCli` with injectable deps so it is unit-testable without live
// Dataverse/filesystem access.

function parseArgs(argv) {
  const a = argv.slice(2);
  const out = { manifest: null, projectRoot: null, envUrl: null, token: null, solutionUniqueName: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--manifest' && a[i + 1]) out.manifest = a[++i];
    else if (a[i] === '--project-root' && a[i + 1]) out.projectRoot = a[++i];
    else if (a[i] === '--projectRoot' && a[i + 1]) out.projectRoot = a[++i];
    else if (a[i] === '--envUrl' && a[i + 1]) out.envUrl = a[++i];
    else if (a[i] === '--token' && a[i + 1]) out.token = a[++i];
    else if (a[i] === '--solutionUniqueName' && a[i + 1]) out.solutionUniqueName = a[++i];
  }
  return out;
}

/**
 * Run the reconcile-manifest CLI: read the local manifest (via inner-loop-paths or
 * an explicit --manifest path), call detect-git-binding (NORMALIZED — see Bug 9),
 * reconcile, and return the JSON result. Pure dependency injection so tests need no
 * live calls or filesystem.
 *
 * @param {object} opts
 * @param {string[]} [opts.argv]
 * @param {object} [opts.deps]  { readFileSync, gitIntegrationManifestPath, detectGitBinding }
 * @returns {Promise<object>} reconcile result + { manifestPath, server }
 */
async function runReconcileManifestCli({ argv = process.argv, deps = {} } = {}) {
  const args = parseArgs(argv);
  const readFileSync = deps.readFileSync || require('fs').readFileSync;
  const gitIntegrationManifestPath = deps.gitIntegrationManifestPath ||
    require('./inner-loop-paths').gitIntegrationManifestPath;
  const detectGitBinding = deps.detectGitBinding ||
    require('./detect-git-binding').detectGitBinding;

  const manifestPath = args.manifest ||
    gitIntegrationManifestPath(args.projectRoot || process.cwd());

  let manifest = null;
  let manifestError = null;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch (e) { manifestError = e.message; }

  // detect-git-binding resolves the server truth (and, post-Bug-9, surfaces the
  // single-bound solutionUniqueName at the top level).
  const server = await detectGitBinding({
    envUrl: args.envUrl,
    token: args.token,
    solutionUniqueName: args.solutionUniqueName || (manifest && manifest.solutionUniqueName) || undefined,
  });

  const result = reconcileManifest({ manifest, serverBinding: server });
  return { ...result, manifestPath, server, ...(manifestError ? { manifestError } : {}) };
}

if (require.main === module) {
  runReconcileManifestCli({ argv: process.argv })
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => { process.stderr.write('reconcile-manifest: ' + e.message + '\n'); process.exit(1); });
}

module.exports = { reconcileManifest, runReconcileManifestCli, parseArgs, COMPARED_FIELDS };
