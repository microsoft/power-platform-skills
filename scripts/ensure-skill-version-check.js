#!/usr/bin/env node

/**
 * Ensures every Power Pages SKILL.md has the plugin version check line
 * immediately after the YAML frontmatter closing ---.
 *
 * Usage:
 *   node scripts/ensure-skill-version-check.js          # auto-add missing lines
 *   node scripts/ensure-skill-version-check.js --check   # CI: fail if any are missing
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'plugins', 'power-pages', 'skills');
const VERSION_CHECK_LINE =
  '> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.';

const checkOnly = process.argv.includes('--check');

function getSkillFiles() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(SKILLS_DIR, d.name, 'SKILL.md'))
    .filter((f) => fs.existsSync(f));
}

function hasVersionCheck(content) {
  return content.includes(VERSION_CHECK_LINE);
}

function addVersionCheck(content) {
  // Match YAML frontmatter: starts with --- on its own line, ends with --- on its own line.
  // Use line-based matching to avoid false positives from --- inside body or values,
  // and handle both LF and CRLF line endings.
  const match = content.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/);
  if (!match) return content;
  const insertPos = match[0].length;
  return (
    content.slice(0, insertPos) +
    '\n' +
    VERSION_CHECK_LINE +
    '\n' +
    content.slice(insertPos)
  );
}

const skillFiles = getSkillFiles();
const missing = [];

for (const filePath of skillFiles) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!hasVersionCheck(content)) {
    missing.push(filePath);
    if (!checkOnly) {
      const updated = addVersionCheck(content);
      fs.writeFileSync(filePath, updated, 'utf8');
      console.log(`Added version check: ${path.relative(ROOT, filePath)}`);
    }
  }
}

if (missing.length === 0) {
  console.log('All SKILL.md files have the plugin version check.');
} else if (checkOnly) {
  console.log('The following SKILL.md files are missing the plugin version check:');
  for (const f of missing) {
    console.log(`  - ${path.relative(ROOT, f)}`);
  }
  process.exit(1);
} else {
  console.log(`Added version check to ${missing.length} file(s).`);
}
