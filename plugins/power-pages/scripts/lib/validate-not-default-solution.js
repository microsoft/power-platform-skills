#!/usr/bin/env node

// V-7 pure validator: flags if the bound Git solution is `Default` or
// `Active`. Per IL-008, the Default Solution cannot be Git-bound — any
// CommitToGit against it fails with a cryptic error and the binding itself
// is rejected by ConnectToGit on most tenants. This check is cheap and
// catches a common copy/paste mistake before any HTTP traffic.
//
// Manifest shape consumed:
//   {
//     bindingType:        'environment' | 'solution',
//     solutionUniqueName: '<name>',  // present iff bindingType==='solution'
//     ...
//   }
//
// Usage:
//   node validate-not-default-solution.js --manifest <path>
//   echo '{ ... manifest json ... }' | node validate-not-default-solution.js --stdin
//
// Output (JSON to stdout):
//   {
//     ok: bool,
//     totalChecked: 1,
//     blocking: [
//       {
//         severity: 'blocker',
//         key: 'default-solution-binding',
//         message: 'Solution ''Default'' cannot be Git-bound.',
//         ref: 'IL-008',
//         details: { solutionUniqueName: 'Default', bindingType: 'solution' },
//         remediation: 'Create a non-Default solution and bind that instead.',
//       },
//     ],
//     warnings: [],
//     info: [],
//   }

'use strict';

const fs = require('node:fs');

// Logical names that are reserved system solutions and cannot be Git-bound.
// `Default` (the catch-all user solution) and `Active` (the system layer)
// are the two cases we've seen in the wild; add more here if a tenant
// surfaces a different reserved name.
const RESERVED_SOLUTION_NAMES = new Set(['Default', 'Active']);

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { manifestFile: null, stdin: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--manifest' && args[i + 1]) out.manifestFile = args[++i];
    else if (args[i] === '--stdin') out.stdin = true;
  }
  return out;
}

/**
 * Pure validator: { ok, totalChecked, blocking[], warnings[], info[] }.
 *
 * @param {object} manifest - shape of .git-integration-manifest.json
 * @returns {{ ok: boolean, totalChecked: number, blocking: object[], warnings: object[], info: object[] }}
 */
function validateNotDefaultSolution(manifest = {}) {
  const blocking = [];
  const info = [];
  const bindingType = manifest.bindingType || null;
  const solutionUniqueName = manifest.solutionUniqueName || null;

  if (bindingType !== 'solution') {
    // Env-level binding is allowed (and indeed required) to include the
    // Default Solution implicitly. Skip this check.
    return {
      ok: true,
      totalChecked: 0,
      blocking: [],
      warnings: [],
      info: [{
        severity: 'info',
        key: 'default-solution-check-skipped',
        message: `bindingType='${bindingType || 'unknown'}' — skipping Default-solution check.`,
        ref: 'IL-008',
        details: { bindingType, solutionUniqueName },
        remediation: 'No action required; this check is only meaningful when bindingType==="solution".',
      }],
    };
  }

  if (!solutionUniqueName) {
    info.push({
      severity: 'info',
      key: 'default-solution-no-name',
      message: 'bindingType=solution but solutionUniqueName is missing from manifest — cannot validate.',
      ref: 'IL-008',
      details: { bindingType, solutionUniqueName: null },
      remediation: 'Repair .git-integration-manifest.json to include solutionUniqueName.',
    });
    return { ok: true, totalChecked: 0, blocking: [], warnings: [], info };
  }

  if (RESERVED_SOLUTION_NAMES.has(solutionUniqueName)) {
    blocking.push({
      severity: 'blocker',
      key: 'default-solution-binding',
      message: `Solution '${solutionUniqueName}' cannot be Git-bound.`,
      ref: 'IL-008',
      details: { solutionUniqueName, bindingType },
      remediation:
        'Create a non-Default solution (e.g. via Maker Portal → Solutions → New), move your components ' +
        'into it, and bind THAT solution to Git instead. Default and Active are reserved system layers.',
    });
  }

  return {
    ok: blocking.length === 0,
    totalChecked: 1,
    blocking,
    warnings: [],
    info,
  };
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  let manifest = {};
  if (args.manifestFile) {
    manifest = JSON.parse(fs.readFileSync(args.manifestFile, 'utf8'));
  } else if (args.stdin) {
    manifest = JSON.parse(await readStdin());
  } else {
    process.stderr.write('validate-not-default-solution: provide --manifest <path> or --stdin\n');
    process.exit(1);
  }
  const r = validateNotDefaultSolution(manifest);
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write('validate-not-default-solution: ' + e.message + '\n');
    process.exit(1);
  });
}

module.exports = { validateNotDefaultSolution, RESERVED_SOLUTION_NAMES };
