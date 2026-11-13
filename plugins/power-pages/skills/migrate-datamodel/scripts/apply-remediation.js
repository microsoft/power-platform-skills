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
 *   - Rejects linked descendants; restores originals on caught copy failures.
 *     Do not edit either tree concurrently. This is not crash-safe recovery.
 *   - On success, deletes `<output-dir>/remediation-staged/` (unless --keep-staged).
 *   - --discard: skip the copy, just delete the staged dir (used on cancel).
 *   - --dry-run: print what would happen, touch nothing.
 *
 * Exit codes: 0 = ok, 2 = bad usage, 3 = nothing-to-apply,
 *             4 = invalid manifest, missing staged file, or copy error.
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

function validatePath(root, relativePath) {
  const relative = path.relative(root, path.resolve(root, relativePath));
  if (path.isAbsolute(relativePath) || !relative || path.isAbsolute(relative) ||
      relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Remediation path must stay inside the staged and site roots: ${relativePath}`);
  }
  // Lexical containment alone permits "link/page.html" to traverse a junction.
  // Reject linked roots/descendants, including dangling links, without following them.
  let current = root;
  for (const part of ['', ...relative.split(path.sep)]) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Remediation path contains a symbolic link or junction: ${current}`);
    }
    if (stat.isFile() && stat.nlink > 1) {
      throw new Error(`Remediation path contains a hard-linked file: ${current}`);
    }
    if (current !== path.join(root, relative) && !stat.isDirectory()) {
      throw new Error(`Remediation parent is not a directory: ${current}`);
    }
  }
  return path.join(root, relative);
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
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.files)) {
    throw new Error('remediation-diff.json must contain an object with a files array');
  }
  const files = payload.files;
  if (typeof payload.siteRoot !== 'string' || !path.isAbsolute(payload.siteRoot)) {
    throw new Error('remediation-diff.json must contain an absolute siteRoot');
  }
  const liveRoot = fs.realpathSync(siteRoot);
  if (liveRoot !== fs.realpathSync(payload.siteRoot)) {
    throw new Error('Selected site root does not match the remediation manifest siteRoot');
  }
  const targets = new Set();
  const plan = files.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.relativePath !== 'string' ||
        entry.relativePath.trim() === '') {
      throw new Error('Every remediation file entry must contain a non-empty relativePath string');
    }
    const stagedPath = validatePath(path.resolve(stagedDir), entry.relativePath);
    const livePath = validatePath(liveRoot, entry.relativePath);
    const identity = process.platform === 'win32' ? livePath.toLowerCase() : livePath;
    if (targets.has(identity)) {
      throw new Error(`Duplicate remediation destination: ${entry.relativePath}`);
    }
    targets.add(identity);
    if (!fs.existsSync(stagedPath) || !fs.statSync(stagedPath).isFile()) {
      throw new Error(`Staged file missing or not a file: ${stagedPath}`);
    }
    if (fs.existsSync(livePath) && !fs.statSync(livePath).isFile()) {
      throw new Error(`Live destination is not a file: ${livePath}`);
    }
    return { relativePath: entry.relativePath, from: stagedPath, to: livePath };
  });

  if (files.length === 0) {
    console.log('Remediation diff manifest contains zero files — nothing to apply.');
    if (!keepStaged) rmRecursive(stagedDir);
    process.exit(3);
  }

  if (dryRun) {
    for (const { from, to } of plan) {
      console.log(`[dry-run] ${from} → ${to}`);
    }
    console.log(`\n[dry-run] Would apply ${plan.length}/${files.length} file(s) and delete ${stagedDir}.`);
    return;
  }

  // Read every original before the first write. Include a failed copy in rollback:
  // copyFileSync can truncate its destination before reporting a disk/I/O failure.
  for (const entry of plan) {
    entry.original = fs.existsSync(entry.to) ? fs.readFileSync(entry.to) : null;
    entry.mode = entry.original !== null ? fs.statSync(entry.to).mode : null;
  }
  // Keep a disk copy too: if restoration itself fails, exiting must not destroy
  // the only remaining original bytes. The index records files that were absent.
  const backupDir = fs.mkdtempSync(path.join(path.resolve(outputDir), 'remediation-backup-'));
  try {
    for (const [index, entry] of plan.entries()) {
      entry.backupFile = entry.original === null ? null : `${index}.bin`;
      if (entry.backupFile) fs.writeFileSync(path.join(backupDir, entry.backupFile), entry.original);
    }
    fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({
      siteRoot: liveRoot,
      files: plan.map(({ relativePath, mode, backupFile }) => ({ relativePath, mode, backupFile })),
    }, null, 2));
  } catch (error) {
    throw new Error(`Could not prepare backup at ${backupDir}: ${error.message}. No live files changed.`);
  }
  const touched = [];
  const createdDirectories = new Set();
  try {
    for (const entry of plan) {
      validatePath(path.resolve(stagedDir), entry.relativePath);
      validatePath(liveRoot, entry.relativePath);
      for (let dir = path.dirname(entry.to); !fs.existsSync(dir); dir = path.dirname(dir)) {
        createdDirectories.add(dir);
      }
      fs.mkdirSync(path.dirname(entry.to), { recursive: true });
      validatePath(liveRoot, entry.relativePath);
      touched.push(entry);
      fs.copyFileSync(entry.from, entry.to);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const entry of touched.reverse()) {
      try {
        validatePath(liveRoot, entry.relativePath);
        if (entry.original === null) {
          if (fs.existsSync(entry.to)) fs.unlinkSync(entry.to);
        } else {
          fs.writeFileSync(entry.to, entry.original);
          fs.chmodSync(entry.to, entry.mode);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${entry.relativePath}: ${rollbackError.message}`);
      }
    }
    for (const dir of [...createdDirectories].sort((a, b) => b.length - a.length)) {
      try {
        validatePath(liveRoot, path.relative(liveRoot, dir));
        fs.rmdirSync(dir);
      } catch (rollbackError) {
        if (rollbackError.code !== 'ENOENT') rollbackErrors.push(`${dir}: ${rollbackError.message}`);
      }
    }
    throw new Error(`Apply failed: ${error.message}. ` +
      (rollbackErrors.length
        ? `Rollback incomplete; manual recovery required:\n${rollbackErrors.join('\n')}`
        : 'Original files restored.') +
      `\nRecovery backup retained at ${backupDir}.\nStaged remediation and manifest retained.`);
  }

  rmRecursive(backupDir);
  if (!keepStaged) {
    rmRecursive(stagedDir);
  }
  console.log(`\n✓ Applied ${plan.length}/${files.length} remediation file(s) to ${siteRoot}.`);
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(4);
}
