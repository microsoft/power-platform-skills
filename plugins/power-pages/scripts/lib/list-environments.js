#!/usr/bin/env node

// Lists the Power Platform environments the signed-in user can see, for the
// git-configure Phase 1 environment picker. Removes the "caller must already
// know --envUrl" wall for first-time users.
//
// Wraps `pac env list --json`. Only fields the CLI actually returns are
// surfaced — we deliberately do NOT invent managedEnvTier / region fields that
// `pac env list` does not provide (a separate BAP call is needed for those, and
// the picker does not require them).
//
// Output (JSON to stdout):
//   {
//     ok: true,
//     environments: [
//       { friendlyName, url, environmentId, organizationId, uniqueName, geo, isDefault }
//     ],
//     count: <number>,
//     defaultUrl: <url|null>
//   }
//   Graceful failure (pac missing / signed-out / non-JSON):
//   { ok: false, error: "<message>",
//     hint: "Could not list environments via pac. Pass --envUrl <url> explicitly." }
//
// Usage:
//   node list-environments.js
//
// API (library):
//   const { listEnvironments } = require('./list-environments');
//   const r = await listEnvironments();   // or listEnvironments({ _execImpl })

'use strict';

const { execSync } = require('child_process');

const FALLBACK_HINT = 'Could not list environments via pac. Pass --envUrl <url> explicitly.';

function defaultExec() {
  return execSync('pac env list --json', { encoding: 'utf8', timeout: 30000 });
}

/**
 * @param {object} [options]
 * @param {() => string} [options._execImpl]  DI: returns the raw `pac env list --json` text.
 * @returns {{ ok: boolean, environments?: Array, count?: number, defaultUrl?: string|null, error?: string, hint?: string }}
 */
function listEnvironments({ _execImpl } = {}) {
  const exec = typeof _execImpl === 'function' ? _execImpl : defaultExec;

  let raw;
  try {
    raw = exec();
  } catch (e) {
    return { ok: false, error: `pac env list failed: ${e.message}`, hint: FALLBACK_HINT };
  }

  let rows;
  try {
    rows = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `pac env list returned non-JSON: ${e.message}`, hint: FALLBACK_HINT };
  }
  if (!Array.isArray(rows)) {
    return { ok: false, error: 'pac env list did not return an array.', hint: FALLBACK_HINT };
  }

  const environments = rows.map((r) => {
    const ident = r.EnvironmentIdentifier || {};
    return {
      friendlyName:   r.FriendlyName || null,
      url:            r.EnvironmentUrl ? r.EnvironmentUrl.replace(/\/+$/, '') : null,
      environmentId:  ident.Id || null,
      organizationId: r.OrganizationId || null,
      uniqueName:     r.UniqueName || null,
      geo:            r.Geo || null,
      isDefault:      ident.IsDefault === true,
    };
  })
  // Stable, friendly ordering: default env first, then alphabetical.
  .sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return (a.friendlyName || '').localeCompare(b.friendlyName || '');
  });

  const def = environments.find((e) => e.isDefault) || null;

  return {
    ok: true,
    environments,
    count: environments.length,
    defaultUrl: def ? def.url : null,
  };
}

if (require.main === module) {
  const r = listEnvironments();
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  if (!r.ok) process.exit(1);
}

module.exports = { listEnvironments };
