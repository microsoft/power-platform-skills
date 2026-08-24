#!/usr/bin/env node

/**
 * apply-remediation.js
 *
 * Applies the staged remediation produced by `generate-migration-reports.js`
 * (with `--automate-fetchxml` and/or `--automate-liquid`) to the live site
 * source. The skill calls this AFTER the user has reviewed the Remediation
 * Diff card in the live execution report and explicitly approved the upload.
 *
 * Usage:
 *   node apply-remediation.js --output-dir "./migration-reports" --site-root "./mysite/contoso/"
 *   node apply-remediation.js --output-dir "./migration-reports" --site-root "./mysite/contoso/" --discard
 *   node apply-remediation.js --output-dir "./migration-reports" --dry-run
 *
 * Behavior:
 *   - Reads `<output-dir>/remediation-diff.json` (errors if absent).
 *   - For each entry, copies `<output-dir>/remediation-staged/<relativePath>`
 *     over `<site-root>/<relativePath>`. mkdir -p any missing parents.
 *   - On success, deletes `<output-dir>/remediation-staged/` (unless --keep-staged).
 *   - --discard: skip the copy, just delete the staged dir (used on cancel).
 *   - --dry-run: print what would happen, touch nothing.
 *
 * Exit codes: 0 = ok, 2 = bad usage, 3 = nothing-to-apply, 4 = copy error.
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function rmRecursive(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = args['output-dir'];
  const siteRoot = args['site-root'];
  const discard = !!args['discard'];
  const dryRun = !!args['dry-run'];
  const keepStaged = !!args['keep-staged'];

  if (!outputDir) {
    console.error('Error: --output-dir is required');
    process.exit(2);
  }
  if (!discard && !siteRoot) {
    console.error('Error: --site-root is required (omit only when --discard is set)');
    process.exit(2);
  }

  const diffPath = path.join(outputDir, 'remediation-diff.json');
  const stagedDir = path.join(outputDir, 'remediation-staged');

  if (!fs.existsSync(diffPath)) {
    console.log(`No remediation-diff.json at ${diffPath} — nothing to apply.`);
    process.exit(3);
  }

  if (discard) {
    if (dryRun) {
      console.log(`[dry-run] Would delete staged tree: ${stagedDir}`);
      console.log(`[dry-run] Would delete diff manifest: ${diffPath}`);
      return;
    }
    rmRecursive(stagedDir);
    fs.unlinkSync(diffPath);
    console.log('✓ Discarded staged remediation. Live source was never touched.');
    return;
  }

  const payload = JSON.parse(fs.readFileSync(diffPath, 'utf-8'));
  const files = payload.files || [];

  if (files.length === 0) {
    console.log('Remediation diff manifest contains zero files — nothing to apply.');
    if (!keepStaged) rmRecursive(stagedDir);
    process.exit(3);
  }

  let applied = 0;
  const errors = [];
  for (const entry of files) {
    const rel = entry.relativePath;
    const from = path.join(stagedDir, rel);
    const to = path.join(siteRoot, rel);

    if (!fs.existsSync(from)) {
      errors.push(`Staged file missing: ${from}`);
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] ${from} → ${to}`);
      applied++;
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      applied++;
      console.log(`✓ ${rel}`);
    } catch (e) {
      errors.push(`Failed to copy ${rel}: ${e.message}`);
    }
  }

  if (errors.length > 0) {
    console.error('\nErrors encountered:');
    for (const e of errors) console.error('  ' + e);
    process.exit(4);
  }

  if (dryRun) {
    console.log(`\n[dry-run] Would apply ${applied}/${files.length} file(s) and delete ${stagedDir}.`);
    return;
  }

  if (!keepStaged) {
    rmRecursive(stagedDir);
  }
  console.log(`\n✓ Applied ${applied}/${files.length} remediation file(s) to ${siteRoot}.`);
}

main();
