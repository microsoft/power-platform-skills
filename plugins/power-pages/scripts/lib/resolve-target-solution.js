#!/usr/bin/env node

// Resolves "which solution should this new Dataverse record land in?"
// Implements the strict 3-step order documented in plugins/power-pages/AGENTS.md
// under the ALM-aware-by-default principle:
//
//   1. Explicit --solutionUniqueName (or equivalent caller arg).
//   2. .solution-manifest.json in the project root.
//   3. Neither present — throw NoSolutionConfiguredError.
//
// The module NEVER auto-picks from Dataverse. Interactive prompt UX is the
// caller's responsibility: callers catch NoSolutionConfiguredError, present
// an AskUserQuestion list, and re-invoke with `explicit` populated.
//
// Callers that need to confirm the solution still exists in Dataverse can pass
// `verifyExists: true`; the module will GET /solutions and enrich the result
// with { solutionId, version, ismanaged }.
//
// Usage (as a module):
//   const { resolveTargetSolution, NoSolutionConfiguredError } = require('./resolve-target-solution');
//   const r = await resolveTargetSolution({ explicit, projectRoot, envUrl, token, verifyExists: true });
//   // r === { solutionUniqueName, solutionId, version, ismanaged, source }
//
// Usage (as a CLI):
//   node resolve-target-solution.js [--explicit <name>] [--projectRoot <path>]
//                                    [--envUrl <url>] [--token <t>] [--verify]
//   Exit 0 + JSON to stdout on success; exit 1 + message to stderr on failure.

'use strict';

const fs = require('fs');
const path = require('path');
const helpers = require('./validation-helpers');

class NoSolutionConfiguredError extends Error {
  constructor(message, { hint } = {}) {
    super(message);
    this.name = 'NoSolutionConfiguredError';
    this.hint = hint;
  }
}

const NO_SOLUTION_HINT =
  'Run /power-pages:setup-solution to create a solution (writes .solution-manifest.json), ' +
  'or pass --solutionUniqueName to target an existing solution explicitly.';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    explicit: null,
    projectRoot: null,
    envUrl: null,
    token: null,
    verifyExists: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--explicit' && args[i + 1]) out.explicit = args[++i];
    else if (args[i] === '--solutionUniqueName' && args[i + 1]) out.explicit = args[++i];
    else if (args[i] === '--projectRoot' && args[i + 1]) out.projectRoot = args[++i];
    else if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--verify') out.verifyExists = true;
  }
  return out;
}

/**
 * Reads `.solution-manifest.json` from `projectRoot` (or any ancestor
 * directory up to the filesystem root). Returns the parsed object or null.
 */
function readManifest(projectRoot) {
  let dir = projectRoot || process.cwd();
  const { root } = path.parse(dir);
  while (true) {
    const candidate = path.join(dir, '.solution-manifest.json');
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, 'utf8');
        return { path: candidate, data: JSON.parse(raw) };
      } catch (err) {
        throw new Error(
          `Found .solution-manifest.json at ${candidate} but it could not be parsed: ${err.message}`
        );
      }
    }
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

/**
 * Calls the Dataverse /solutions endpoint to confirm a solution by uniquename.
 * Returns { solutionId, version, ismanaged } or null if not found.
 */
async function verifySolutionExists({ envUrl, token, uniqueName, makeRequest }) {
  if (!envUrl) throw new Error('verifyExists: true requires envUrl');
  if (!token) throw new Error('verifyExists: true requires token');
  const cleanUrl = envUrl.replace(/\/+$/, '');
  // Validate uniquename — only alphanumeric + underscore allowed. Reject anything
  // else up front so a typo surfaces as "invalid name" rather than a confusing
  // "not found" after silently dropping characters. Also protects the OData
  // filter below from injection.
  const trimmed = String(uniqueName).trim();
  if (!/^[A-Za-z0-9_]+$/.test(trimmed)) {
    throw new Error(
      `Invalid solution unique name "${uniqueName}" — only alphanumeric and underscore characters are allowed.`
    );
  }
  const safeName = trimmed;
  const url =
    `${cleanUrl}/api/data/v9.2/solutions` +
    `?$filter=uniquename eq '${safeName}'` +
    `&$select=solutionid,uniquename,version,ismanaged`;
  const res = await makeRequest({
    url,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    },
    timeout: 15000,
  });
  if (res.error) throw new Error(`Solution lookup failed: ${res.error}`);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Solution lookup returned ${res.statusCode}: ${(res.body || '').slice(0, 300)}`);
  }
  const parsed = JSON.parse(res.body);
  const row = (parsed.value || [])[0];
  if (!row) return null;
  return {
    solutionId: row.solutionid,
    version: row.version,
    ismanaged: row.ismanaged,
  };
}

/**
 * Resolves the target solution per the ALM-aware-by-default resolution order.
 *
 * @param {object} opts
 * @param {string} [opts.explicit] - From --solutionUniqueName CLI arg. Highest priority.
 * @param {string} [opts.projectRoot] - Directory to start manifest search. Defaults to cwd.
 * @param {boolean} [opts.verifyExists=false] - When true, GET /solutions to confirm.
 * @param {string} [opts.envUrl] - Required when verifyExists is true.
 * @param {string} [opts.token] - Required when verifyExists is true.
 * @param {Function} [opts.makeRequest] - Injected for tests.
 *
 * @returns {Promise<{
 *   solutionUniqueName: string,
 *   solutionId?: string,
 *   version?: string,
 *   ismanaged?: boolean,
 *   source: 'arg' | 'manifest',
 *   manifestPath?: string
 * }>}
 *
 * @throws {NoSolutionConfiguredError} when neither explicit nor manifest yields a name.
 * @throws {Error} on parse or verification failures.
 */
async function resolveTargetSolution({
  explicit = null,
  projectRoot = null,
  verifyExists = false,
  envUrl = null,
  token = null,
  makeRequest = helpers.makeRequest,
} = {}) {
  // Step 1: explicit arg wins unconditionally.
  if (explicit && String(explicit).trim()) {
    const result = {
      solutionUniqueName: String(explicit).trim(),
      source: 'arg',
    };
    if (verifyExists) {
      const verified = await verifySolutionExists({
        envUrl,
        token,
        uniqueName: result.solutionUniqueName,
        makeRequest,
      });
      if (!verified) {
        throw new Error(
          `Solution "${result.solutionUniqueName}" not found in ${envUrl}. ` +
            `Either create it first with /power-pages:setup-solution or check the name.`
        );
      }
      Object.assign(result, verified);
    }
    return result;
  }

  // Step 2: .solution-manifest.json.
  const manifest = readManifest(projectRoot);
  if (manifest && manifest.data && manifest.data.solution && manifest.data.solution.uniqueName) {
    const m = manifest.data.solution;
    const result = {
      solutionUniqueName: m.uniqueName,
      solutionId: m.solutionId,
      version: m.version,
      source: 'manifest',
      manifestPath: manifest.path,
    };
    if (verifyExists) {
      const verified = await verifySolutionExists({
        envUrl,
        token,
        uniqueName: result.solutionUniqueName,
        makeRequest,
      });
      if (!verified) {
        throw new Error(
          `.solution-manifest.json references "${result.solutionUniqueName}" but it was not found in ${envUrl}. ` +
            `The manifest may be stale or point to a different environment. ` +
            `Run /power-pages:setup-solution to recreate, or delete the manifest and start fresh.`
        );
      }
      // Manifest may be stale on solutionId/version; prefer live data.
      Object.assign(result, verified);
    }
    return result;
  }

  // Step 3: nothing resolves — throw with an actionable hint.
  throw new NoSolutionConfiguredError(
    'No target solution could be resolved — no --solutionUniqueName argument and no .solution-manifest.json found.',
    { hint: NO_SOLUTION_HINT }
  );
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  resolveTargetSolution(args)
    .then((r) => {
      process.stdout.write(JSON.stringify(r));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      if (err.hint) process.stderr.write(`Hint: ${err.hint}\n`);
      process.exit(1);
    });
}

module.exports = {
  resolveTargetSolution,
  readManifest,
  verifySolutionExists,
  NoSolutionConfiguredError,
  NO_SOLUTION_HINT,
};
