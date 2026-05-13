#!/usr/bin/env node
/**
 * Regenerate references/verified-icons.txt from the @fluentui/react-icons package.
 *
 * Run this after bumping the @fluentui/react-icons version pin or whenever the
 * icon set changes. The output is committed to the plugin so page-builder agents
 * can read it without an npm install at runtime.
 *
 * Usage:
 *   node scripts/regenerate-verified-icons.js
 *
 * Requirements:
 *   - node (any LTS)
 *   - npm (for the one-time install in a temp dir)
 *   - Network access to npm registry
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Pinned to an exact version so the committed verified-icons.txt is reproducible.
// To regenerate after a bump, change this constant and re-run this script.
const ICON_PKG = '@fluentui/react-icons@2.0.326';
const OUTPUT = path.join(__dirname, '..', 'references', 'verified-icons.txt');

// Install into a fresh temp dir to avoid polluting the plugin tree.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-icons-'));
console.log(`Installing ${ICON_PKG} into ${tmpDir}...`);

// On Windows, npm is a shim invoked through cmd. execFile needs shell:true there.
const npmShellOpts = { cwd: tmpDir, stdio: 'inherit', shell: process.platform === 'win32' };

try {
  execFileSync('npm', ['init', '-y'], { ...npmShellOpts, stdio: 'ignore' });
  execFileSync('npm', ['install', ICON_PKG, '--no-save', '--silent'], npmShellOpts);

  // Load the module from the temp dir and enumerate exports.
  const iconsPath = path.join(tmpDir, 'node_modules', '@fluentui', 'react-icons');
  const icons = require(iconsPath);

  // Keep unsized variants only: NameRegular or NameFilled (no trailing digits).
  const names = Object.keys(icons)
    .filter((n) => /^[A-Z][A-Za-z0-9]+(?:Regular|Filled)$/.test(n))
    .filter((n) => !/[0-9]+(?:Regular|Filled)$/.test(n))
    .sort();

  const header = [
    '# Fluent UI V9 verified icon names',
    `# Generated from ${ICON_PKG}`,
    `# Regenerate with: node scripts/regenerate-verified-icons.js`,
    `# Total: ${names.length} unsized icons (Regular + Filled variants only)`,
    '',
  ].join('\n');

  fs.writeFileSync(OUTPUT, header + names.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${names.length} icon names to ${OUTPUT}`);
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`Failed to clean up ${tmpDir}: ${e.message}`);
  }
}
