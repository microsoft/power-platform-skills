#!/usr/bin/env node

// Checks and optionally fixes the blockedattachments setting on a
// Dataverse environment. Power Pages code sites use .js files in their
// compiled output; environments with .js in blockedattachments reject
// uploads (pac pages upload-code-site) and solution imports (deploy-pipeline).
//
// Strategy: uses `pac env list-settings` / `pac env update-settings` so
// this works without requiring a separate Dataverse OData call, and correctly
// handles the PAC auth session already established by the caller.
//
// The blocked-attachment list is semicolon-separated (e.g.,
// "exe;dll;js;vbs;..."). This script removes only the extensions that are
// needed by Power Pages code sites (.js; optionally .css if blocked).
//
// Usage:
//   node fix-blocked-attachments.js
//     [--envUrl <url>]            target env (default: current PAC active env)
//     [--extensions js,css]       extensions to unblock (default: js)
//     [--dry-run]                 report what would change, don't apply
//     [--check-only]              READ-ONLY pre-flight mode. Returns the
//                                  validator-shaped envelope
//                                  ({ ok, blocking[], warnings[], info[] })
//                                  used by run-prevalidators.js. Does NOT
//                                  mutate the env. Implies --dry-run for the
//                                  underlying pac call. Exit code 0 on both
//                                  "ok" and "would block" — the orchestrator
//                                  interprets the envelope.
//     [--quiet]                   suppress informational output
//
// Output (JSON to stdout):
//   default / --dry-run mode:
//     {
//       "envUrl": "https://...",
//       "wasBlocked": ["js"],
//       "removed": ["js"],
//       "unchanged": [],
//       "newValue": "exe;dll;...",
//       "changed": true,
//       "dryRun": false
//     }
//   --check-only mode:
//     {
//       "ok": false,
//       "totalChecked": 1,
//       "blocking": [
//         {
//           "severity": "blocker",
//           "key": "blocked-attachment-extension",
//           "message": "Extension 'js' is blocked on this env (blockedattachments setting).",
//           "ref": "IL-012",
//           "details": { "extension": "js", "envUrl": "<envUrl>" },
//           "remediation": "Run scripts/lib/fix-blocked-attachments.js without --check-only to remove the extension."
//         }
//       ],
//       "warnings": [],
//       "info": [],
//       "scope": { "envUrl": "<envUrl>" }
//     }
//
// Exit 0 on success (including when nothing changed, and including
// --check-only with blockers). Exit 1 on error.

'use strict';

const { execSync } = require('child_process');

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    envUrl: null,
    extensions: ['js'],
    dryRun: false,
    checkOnly: false,
    quiet: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) opts.envUrl = args[++i];
    else if (args[i] === '--extensions' && args[i + 1]) {
      opts.extensions = args[++i].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    }
    else if (args[i] === '--dry-run') opts.dryRun = true;
    else if (args[i] === '--check-only') { opts.checkOnly = true; opts.dryRun = true; }
    else if (args[i] === '--quiet') opts.quiet = true;
  }
  return opts;
}

function log(msg, quiet) {
  if (!quiet) process.stderr.write(`[fix-blocked-attachments] ${msg}\n`);
}

function makePacRunner(execImpl) {
  const exec = execImpl || execSync;
  return function runPac(cmd) {
    try {
      const out = exec(`pac ${cmd}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, stdout: typeof out === 'string' ? out : (out || '') };
    } catch (e) {
      return { ok: false, stdout: e.stdout || '', stderr: e.stderr || '', error: e.message };
    }
  };
}

function parseBlockedAttachmentsFromPacOutput(pacOutput) {
  // pac env list-settings outputs:
  //   Setting            Value
  //   blockedattachments ade;adp;...;js;...
  const lines = pacOutput.split('\n');
  for (const line of lines) {
    if (/^blockedattachments\s+/i.test(line.trim())) {
      const parts = line.trim().split(/\s+/);
      // "blockedattachments" is first token, rest is the value
      return parts.slice(1).join(' ').trim();
    }
  }
  return null;
}

/**
 * Translate a fixBlockedAttachments result into the validator envelope
 * { ok, totalChecked, blocking[], warnings[], info[], scope } used by
 * run-prevalidators.js. Pure transform (no side effects).
 *
 * @param {object} result - return value of fixBlockedAttachments()
 * @returns {{ ok: boolean, totalChecked: number, blocking: object[], warnings: object[], info: object[], scope: object }}
 */
function toCheckOnlyEnvelope(result) {
  const blocking = (result.wasBlocked || []).map((ext) => ({
    severity: 'blocker',
    key: 'blocked-attachment-extension',
    message: `Extension '${ext}' is blocked on this env (blockedattachments setting).`,
    ref: 'IL-012',
    details: { extension: ext, envUrl: result.envUrl },
    remediation:
      `Run \`node scripts/lib/fix-blocked-attachments.js --envUrl "${result.envUrl}" --extensions ${ext}\` ` +
      'without --check-only to remove the extension.',
  }));
  return {
    ok: blocking.length === 0,
    totalChecked: (result.wasBlocked || []).length + (result.unchanged || []).length,
    blocking,
    warnings: [],
    info: [],
    scope: { envUrl: result.envUrl },
  };
}

async function fixBlockedAttachments({ envUrl, extensions, dryRun, quiet, execImpl } = {}) {
  const runPac = makePacRunner(execImpl);
  // Build pac command args for env targeting
  const envArg = envUrl ? `--environment "${envUrl}"` : '';

  log(`Reading blockedattachments from ${envUrl || '(current active env)'}`, quiet);
  const listResult = runPac(`env list-settings ${envArg} --filter blockedattachments`);
  if (!listResult.ok) {
    throw new Error(`pac env list-settings failed: ${listResult.stderr || listResult.error}`);
  }

  const currentValue = parseBlockedAttachmentsFromPacOutput(listResult.stdout);
  if (currentValue === null) {
    throw new Error(`Could not parse blockedattachments from pac output: ${listResult.stdout.slice(0, 300)}`);
  }

  log(`Current blockedattachments value (${currentValue.split(';').length} entries)`, quiet);

  const currentSet = new Set(currentValue.split(';').map(e => e.trim().toLowerCase()).filter(Boolean));
  const wasBlocked = extensions.filter(ext => currentSet.has(ext));
  const unchanged = extensions.filter(ext => !currentSet.has(ext));

  if (wasBlocked.length === 0) {
    log(`Extensions [${extensions.join(', ')}] are not blocked — nothing to change`, quiet);
    return {
      envUrl: envUrl || '(current active env)',
      wasBlocked: [],
      removed: [],
      unchanged: extensions,
      newValue: currentValue,
      changed: false,
      dryRun,
    };
  }

  // Build new value with extensions removed
  const newSet = new Set(currentSet);
  wasBlocked.forEach(ext => newSet.delete(ext));
  const newValue = [...newSet].join(';');

  log(`Will remove [${wasBlocked.join(', ')}] from blockedattachments`, quiet);

  if (!dryRun) {
    const updateResult = runPac(`env update-settings ${envArg} --name blockedattachments --value "${newValue}"`);
    if (!updateResult.ok) {
      throw new Error(`pac env update-settings failed: ${updateResult.stderr || updateResult.error}`);
    }
    log(`Applied: removed [${wasBlocked.join(', ')}]`, quiet);
  } else {
    log(`DRY RUN — would have removed [${wasBlocked.join(', ')}]`, quiet);
  }

  return {
    envUrl: envUrl || '(current active env)',
    wasBlocked,
    removed: dryRun ? [] : wasBlocked,
    unchanged,
    newValue,
    changed: !dryRun && wasBlocked.length > 0,
    dryRun,
  };
}

if (require.main === module) {
  const opts = parseArgs(process.argv);
  fixBlockedAttachments(opts)
    .then(result => {
      const out = opts.checkOnly ? toCheckOnlyEnvelope(result) : result;
      console.log(JSON.stringify(out));
      process.exit(0);
    })
    .catch(err => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { fixBlockedAttachments, toCheckOnlyEnvelope };
