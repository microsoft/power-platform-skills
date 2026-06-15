#!/usr/bin/env node

// V-11 validator: thin wrapper around fix-blocked-attachments.js that runs
// it in --check-only mode and re-emits its output unchanged so the
// run-prevalidators.js orchestrator picks up the standard envelope
// { ok, totalChecked, blocking[], warnings[], info[], scope } directly.
//
// This validator exists so the skill has a single discoverable name
// (`validate-blocked-attachments.js`) for the V-11 finding type alongside
// the other validators, instead of teaching the orchestrator about a
// special "non-validator helper" code path.
//
// Why a separate file (vs. the orchestrator just calling
// fix-blocked-attachments.js --check-only directly): symmetry. Every
// orchestrator entry points at a file named `validate-*.js`. That single
// convention keeps the validator catalog easy to enumerate, easy to
// document in SKILL.md, and easy for downstream tooling (JUnit/SARIF
// emission, IL hyperlinking, per-validator timing) to thread through.
//
// Usage:
//   node validate-blocked-attachments.js
//     [--envUrl <url>]            target env (default: current PAC active env)
//     [--extensions js,css]       extensions to check (default: js)
//     [--quiet]
//
// Output (JSON to stdout): the --check-only envelope produced by
//   fix-blocked-attachments.js. Always exit 0; the orchestrator interprets
//   ok=false as a blocker.

'use strict';

const { fixBlockedAttachments, toCheckOnlyEnvelope } = require('./fix-blocked-attachments');

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { envUrl: null, extensions: ['js'], quiet: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) opts.envUrl = args[++i];
    else if (args[i] === '--extensions' && args[i + 1]) {
      opts.extensions = args[++i].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    }
    else if (args[i] === '--quiet') opts.quiet = true;
  }
  return opts;
}

/**
 * Read-only pre-flight check for blocked attachment extensions. Returns
 * the same envelope shape as the other validators so the orchestrator can
 * aggregate without special-casing.
 *
 * @param {object} options
 * @param {string} [options.envUrl]
 * @param {string[]} [options.extensions]
 * @param {boolean} [options.quiet]
 * @param {Function} [options.execImpl]   // hook for tests
 * @returns {Promise<{ ok: boolean, totalChecked: number, blocking: object[], warnings: object[], info: object[], scope: object } | { error: string }>}
 */
async function validateBlockedAttachments({ envUrl, extensions = ['js'], quiet = true, execImpl } = {}) {
  try {
    const result = await fixBlockedAttachments({
      envUrl, extensions, quiet,
      dryRun: true,
      execImpl,
    });
    const envelope = toCheckOnlyEnvelope(result);
    for (const finding of envelope.blocking || []) {
      finding.ref = 'IL-ATTACH-001';
    }
    return envelope;
  } catch (e) {
    return { error: e.message };
  }
}

if (require.main === module) {
  const opts = parseArgs(process.argv);
  validateBlockedAttachments(opts)
    .then((r) => {
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      process.exit(r && r.error ? 1 : 0);
    })
    .catch((e) => {
      process.stderr.write('validate-blocked-attachments: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { validateBlockedAttachments };
