#!/usr/bin/env node

// Lists the unmanaged, non-system solutions on an environment, for the
// git-configure Phase 3 solution-binding picker. Removes the "caller must know
// the solution unique-name" wall.
//
// Default filter (documented here, not encoded in the file name): visible AND
// unmanaged AND not a system solution. System solutions (Active / Basic /
// Default / CommonDataServiceDefault) are excluded client-side because they are
// never valid Git-binding targets.
//
// Each solution is annotated with `boundTo` when discover-bindings.js shows it
// already wired to a repo, so the picker can mark it (e.g. with a 🔗) and the
// user does not accidentally double-bind.
//
// Output (JSON to stdout):
//   {
//     ok: true,
//     solutions: [
//       { uniqueName, friendlyName, version, publisherPrefix,
//         boundTo: { organization, project, repository, branch, rootfolderpath } | null }
//     ],
//     count: <number>
//   }
//   On error: { ok: false, error: "<message>", statusCode?: <number> }
//
// Usage:
//   node list-solutions.js --envUrl <url> [--token <dvToken>] [--no-bindings]

'use strict';

const { getAuthToken, getEnvironmentUrl, makeRequest } = require('./validation-helpers');
const { discoverBindings } = require('./discover-bindings');

// System solutions that are never valid Git-binding targets.
const SYSTEM_SOLUTIONS = new Set(['Active', 'Basic', 'Default', 'CommonDataServiceDefault']);

async function odataGet(base, tok, pathAndQuery) {
  const res = await makeRequest({
    url: `${base}${pathAndQuery}`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tok}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Accept: 'application/json',
    },
  });
  if (res.error) return { error: res.error };
  if (res.statusCode !== 200) {
    let msg = `HTTP ${res.statusCode}`;
    try { msg = JSON.parse(res.body).error.message || msg; } catch {}
    return { error: msg, statusCode: res.statusCode };
  }
  try { return { value: JSON.parse(res.body).value || [] }; }
  catch (e) { return { error: 'Failed to parse response: ' + e.message }; }
}

/**
 * Build a uniqueName → binding map from discover-bindings output.
 * @returns {Map<string, object>}
 */
function buildBindingMap(discovery) {
  const map = new Map();
  if (!discovery || !discovery.ok) return map;
  for (const repo of discovery.knownRepos || []) {
    for (const bc of repo.branchConfigs || []) {
      if (bc.bindingType === 'solution' && bc.solutionUniqueName) {
        map.set(bc.solutionUniqueName, {
          organization:   repo.organizationname,
          project:        repo.projectname,
          repository:     repo.repositoryname,
          branch:         bc.branchname,
          rootfolderpath: bc.rootfolderpath,
        });
      }
    }
  }
  return map;
}

/**
 * @param {object} options
 * @param {boolean} [options.includeBindings=true]
 * @param {(opts: object) => Promise<object>} [options._discoverImpl]  DI for discoverBindings.
 * @returns {Promise<object>}
 */
async function listSolutions({ envUrl, token, includeBindings = true, _discoverImpl } = {}) {
  const url = envUrl || getEnvironmentUrl();
  if (!url) return { ok: false, error: 'Could not determine environment URL.' };
  const tok = token || getAuthToken(url);
  if (!tok) return { ok: false, error: 'Could not acquire auth token.' };
  const base = url.replace(/\/+$/, '');

  const r = await odataGet(
    base, tok,
    '/api/data/v9.2/solutions' +
    '?$filter=' + encodeURIComponent('isvisible eq true and ismanaged eq false') +
    '&$select=solutionid,uniquename,friendlyname,version' +
    '&$expand=' + encodeURIComponent('publisherid($select=customizationprefix)') +
    '&$orderby=friendlyname asc',
  );
  if (r.error) return { ok: false, error: r.error, statusCode: r.statusCode };

  // Cross-reference existing bindings (best-effort: never fail the listing if
  // discovery errors out).
  let bindingMap = new Map();
  if (includeBindings) {
    const discover = typeof _discoverImpl === 'function' ? _discoverImpl : discoverBindings;
    try {
      const discovery = await discover({ envUrl: base, token: tok });
      bindingMap = buildBindingMap(discovery);
    } catch (_) { /* best-effort */ }
  }

  const solutions = (r.value || [])
    .filter((s) => !SYSTEM_SOLUTIONS.has(s.uniquename))
    .map((s) => ({
      uniqueName:      s.uniquename,
      friendlyName:    s.friendlyname || s.uniquename,
      version:         s.version || null,
      publisherPrefix: (s.publisherid && s.publisherid.customizationprefix) || null,
      boundTo:         bindingMap.get(s.uniquename) || null,
    }));

  return { ok: true, solutions, count: solutions.length };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, token: null, includeBindings: true };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--no-bindings') out.includeBindings = false;
  }
  return out;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  listSolutions(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); if (!r.ok) process.exit(1); })
    .catch((e) => {
      process.stderr.write('list-solutions: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { listSolutions, SYSTEM_SOLUTIONS, buildBindingMap };
