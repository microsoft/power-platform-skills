#!/usr/bin/env node

// Validates that export-solution completed: checks that a solution zip was written to disk
// and that Solution.xml is present inside it.
// Gracefully exits 0 when no solution zip is found (not an export-solution session).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { approve, block, runValidation, findProjectRoot, findPath, readDeferralMarker } = require('../../../scripts/lib/validation-helpers');

runValidation(async (cwd) => {
  if (readDeferralMarker(findProjectRoot(cwd) || cwd)) return approve();  // ALM deferred — silent-approve.
  const projectRoot = findProjectRoot(cwd) || cwd;

  // Search for solution zip files written this session
  // Look for *_managed.zip or *_unmanaged.zip patterns in the project root and subdirs
  const zipFiles = [];

  function scanForZips(dir, depth = 0) {
    if (depth > 2) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
          scanForZips(path.join(dir, entry.name), depth + 1);
        } else if (entry.isFile() && (entry.name.endsWith('_managed.zip') || entry.name.endsWith('_unmanaged.zip'))) {
          zipFiles.push(path.join(dir, entry.name));
        }
      }
    } catch {}
  }

  scanForZips(projectRoot);

  // No solution zip found — not an export-solution session
  if (zipFiles.length === 0) return approve();

  // Validate each zip found
  for (const zipPath of zipFiles) {
    const stat = fs.statSync(zipPath);

    if (stat.size < 1000) {
      return block(`Solution zip '${path.basename(zipPath)}' is too small (${stat.size} bytes). The export may have been truncated or failed.`);
    }

    // Verify Solution.xml is inside the zip
    try {
      const output = execFileSync('unzip', ['-l', zipPath], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      // `unzip -l` emits one entry per line, for example:
      //   1473  05-26-2026 11:31   solution.xml
      // Inspect stdout in JavaScript instead of piping through a shell.
      if (!/(?:^|[\\/])solution\.xml\s*$/im.test(output)) {
        return block(`Solution zip '${path.basename(zipPath)}' does not contain solution.xml. The export appears corrupt.`);
      }
    } catch {
      // unzip is unavailable or could not inspect the archive.
      // Fall back to just checking file size — already done above
      // Don't block if unzip is unavailable
    }
  }

  return approve();
});
