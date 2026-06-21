#!/usr/bin/env node

// Robust launcher for the selective-merge VS Code experience (Wave 2 #9).
//
// Three escalating ways to open the merge, so the maker always has a path even
// when the companion extension isn't installed or VS Code wasn't already running:
//
//   1. DEEP LINK   — `code --open-url "<launchUri>"` opens the companion extension
//                    (native 3-way Merge Editor: Dataverse | Merged | Azure DevOps).
//   2. CLI MERGE   — `code --merge <dataverse> <ado> <base> <merged>` opens VS Code's
//                    BUILT-IN 3-way merge editor per unit with NO extension required.
//                    (VS Code CLI signature: path1=current, path2=incoming, base, result.)
//   3. OPEN FOLDER — `code "<runDir>"` opens the run folder; the maker runs the
//                    "Power Pages Merge: Open Merge Run" command.
//
// buildLaunchPlan() is pure (string-building) and unit-tested. launchEditor()
// executes #1 and falls back through #2/#3, reporting what was tried — it shells
// out to the `code` CLI only, never the network.
//
// Usage:
//   node launch-merge-editor.js --runDir <dir> [--launchUri <uri>] [--manifestFile <manifest.json>]

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function q(s) { return `"${String(s).replace(/"/g, '\\"')}"`; }

/**
 * Build the escalating launch commands from a run's manifest.
 * @param {object} args
 * @param {string} args.runDir       absolute run directory
 * @param {string} [args.launchUri]  vscode:// deep link (from writeMergeWorkspace)
 * @param {object} [args.manifest]   the bridge manifest (for per-unit CLI merge)
 * @param {string} [args.codeBin]    the code CLI binary name (default 'code')
 * @returns {{ deepLink, openFolder, cliMerge: object[], instructions: string[] }}
 */
function buildLaunchPlan({ runDir, launchUri, manifest, codeBin = 'code' } = {}) {
  if (!runDir) throw new Error('runDir is required');
  const deepLink = launchUri ? `${codeBin} --open-url ${q(launchUri)}` : null;
  const openFolder = `${codeBin} ${q(runDir)}`;

  const cliMerge = [];
  for (const u of (manifest && manifest.units) || []) {
    if (!u.files || !u.files.ours || !u.files.theirs || !u.files.base || !u.files.result) continue;
    const abs = (rel) => path.join(runDir, rel);
    // VS Code CLI: code --merge <path1=current> <path2=incoming> <base> <result>
    cliMerge.push({
      unitId: u.unitId,
      label: `${u.componentName || 'component'} (${u.field || ''})`,
      command: `${codeBin} --merge ${q(abs(u.files.ours))} ${q(abs(u.files.theirs))} ${q(abs(u.files.base))} ${q(abs(u.files.result))}`,
    });
  }

  const instructions = [
    'Open the merge in VS Code using the first option that works:',
    deepLink ? `  1. Companion extension (recommended): ${deepLink}` : '  1. (no launch URI available)',
    `  2. Built-in 3-way editor, no extension — run per conflicted unit:`,
    ...cliMerge.map((c) => `       • ${c.label}: ${c.command}`),
    `  3. Or open the folder and run "Power Pages Merge: Open Merge Run": ${openFolder}`,
    'Left = Dataverse (your environment), Right = Azure DevOps (incoming), Result = Merged. Save each, then return here.',
  ];

  return { deepLink, openFolder, cliMerge, instructions };
}

/** Default exec that works cross-platform. On Windows the `code` CLI is a batch
 *  file (`code.cmd`) which child_process can only launch through a shell; we build
 *  a single quoted command line so a deep-link URI's `&` isn't treated as a
 *  cmd.exe command separator (the live failure on 2026-06-19). On POSIX we spawn
 *  the binary directly (no shell) so args need no escaping. */
function quoteWinArg(a) {
  const s = String(a);
  return /[\s&^|<>()"%]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function defaultExec(cmd, args) {
  if (process.platform === 'win32') {
    const line = [cmd, ...args.map(quoteWinArg)].join(' ');
    return spawnSync(line, { encoding: 'utf8', shell: true });
  }
  return spawnSync(cmd, args, { encoding: 'utf8' });
}

/**
 * Try to open the editor: deep link first, then per-unit CLI merge, then folder.
 * Shells out to the `code` CLI only. Returns what was attempted/succeeded.
 * @param {object} args  buildLaunchPlan args + { exec } DI for tests.
 * @returns {{ ok, via, tried: string[], plan }}
 */
function launchEditor({ runDir, launchUri, manifest, codeBin = 'code', exec } = {}) {
  const plan = buildLaunchPlan({ runDir, launchUri, manifest, codeBin });
  const run = exec || defaultExec;
  const tried = [];

  if (launchUri) {
    tried.push('deep-link');
    const r = run(codeBin, ['--open-url', launchUri]);
    if (r && r.status === 0) return { ok: true, via: 'deep-link', tried, plan };
  }
  // Fall back to opening the folder (the maker then picks units, or uses CLI merge lines).
  tried.push('open-folder');
  const r2 = run(codeBin, [runDir]);
  if (r2 && r2.status === 0) return { ok: true, via: 'open-folder', tried, plan };

  return { ok: false, via: null, tried, plan };
}

function parseArgs(argv) {
  const a = argv.slice(2);
  const o = { runDir: null, launchUri: null, manifestFile: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--runDir' && a[i + 1]) o.runDir = a[++i];
    else if (a[i] === '--launchUri' && a[i + 1]) o.launchUri = a[++i];
    else if (a[i] === '--manifestFile' && a[i + 1]) o.manifestFile = a[++i];
  }
  return o;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  let manifest = null;
  if (args.manifestFile) { try { manifest = JSON.parse(fs.readFileSync(args.manifestFile, 'utf8')); } catch { /* ignore */ } }
  else if (args.runDir) { try { manifest = JSON.parse(fs.readFileSync(path.join(args.runDir, 'manifest.json'), 'utf8')); } catch { /* ignore */ } }
  const plan = buildLaunchPlan({ runDir: args.runDir, launchUri: args.launchUri, manifest });
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
}

module.exports = { buildLaunchPlan, launchEditor, quoteWinArg };
