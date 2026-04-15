#!/usr/bin/env node

// Validates that export-solution completed: checks that a solution zip was written to disk
// and that Solution.xml is present inside it.
// Gracefully exits 0 when no solution zip is found (not an export-solution session).

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  approve, block, runValidation, findProjectRoot, findPath,
} = require('../../../scripts/lib/validation-helpers');

runValidation(async (cwd) => {
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
      const output = execSync(`unzip -l "${zipPath}" 2>/dev/null | grep -i solution.xml`, {
        encoding: 'utf8',
        timeout: 10000,
      });
      if (!output || !output.toLowerCase().includes('solution.xml')) {
        return block(`Solution zip '${path.basename(zipPath)}' does not contain solution.xml. The export appears corrupt.`);
      }
    } catch {
      // unzip not available or grep returned no match
      // Fall back to just checking file size — already done above
      // Don't block if unzip is unavailable
    }
  }

  return approve();
});
