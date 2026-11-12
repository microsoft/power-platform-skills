#!/usr/bin/env node

/**
 * seed-memory-bank.js - create `<app>/memory-bank.md` from the plugin template and fill the facts
 * `/create-mobile-app` already knows at scaffold time.
 *
 * The memory bank is how a later run resumes and how other skills learn what this app is. Filling
 * its fact tables used to take the agent a read and a hand-written patch, one of the slower turns
 * before the preview; the values all come from files the run has already written, so a script
 * fills them in one step.
 *
 * Usage:
 *   node seed-memory-bank.js --working-dir <app root> --requirements <requirements.json>
 *     --environment <resolved-environment.json> [--cli-binary pa|power-apps]
 *
 * `requirements.json` is the build plan's requirements section (`appName`, `slug`).
 * `resolved-environment.json` is `resolve-environment.js` output (`environmentId`, `displayName`,
 * `environmentUrl`). Both are read as data, so user-authored names never pass through a shell.
 *
 * Rerunning fills the same rows again and leaves every other line as it is, so a bank that later
 * steps have appended to keeps their entries. Prints one line of JSON.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(PLUGIN_ROOT, 'shared', 'memory-bank.md');

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label} ${file}: ${error.message}`);
  }
}

function pluginVersion() {
  for (const manifest of ['.plugin/plugin.json', '.claude-plugin/plugin.json']) {
    try {
      const { version } = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, manifest), 'utf8'));
      if (version) return String(version);
    } catch {
      // Try the next manifest; a missing version is reported as unknown below.
    }
  }
  return 'unknown';
}

/** A table cell holds one line, and `|` would end the cell early. */
function cell(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * Replace the value cell of the `| <key> | ... |` row. Fact tables are two columns, e.g.
 *   | Display name | _<set by /create-mobile-app>_ |
 * Only the first matching row changes, and a key missing from the bank is reported, not added.
 */
function setRow(markdown, key, value) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const row = new RegExp(`^\\| ${escaped} \\|.*\\|[ \\t]*$`, 'm');
  if (!row.test(markdown)) return { markdown, found: false };
  return { markdown: markdown.replace(row, () => `| ${key} | ${cell(value)} |`), found: true };
}

/** Add a fact row right after the last row of the `## Project facts` table, once. */
function ensureProjectFact(markdown, key, value) {
  const updated = setRow(markdown, key, value);
  if (updated.found) return updated.markdown;
  return markdown.replace(/(## Project facts\n\n(?:\|.*\|\n)+)/, (table) => `${table}| ${key} | ${cell(value)} |\n`);
}

function seedMemoryBank({ workingDir, requirements, environment, cliBinary = 'pa', now = new Date() }) {
  const root = path.resolve(workingDir);
  const target = path.join(root, 'memory-bank.md');
  const existed = fs.existsSync(target);
  let markdown = fs.readFileSync(existed ? target : TEMPLATE, 'utf8').replace(/\r\n/g, '\n');

  if (!requirements.appName) throw new Error('requirements has no appName');
  if (!environment.environmentId) throw new Error('environment has no environmentId');

  const facts = [
    ['Display name', requirements.appName],
    ['Slug', requirements.slug || ''],
    ['Working directory', root],
    ['Plugin version that created the project', pluginVersion()],
    ['Created', now.toISOString().slice(0, 10)],
    ['Active environment ID', environment.environmentId],
    ['Active environment name', environment.displayName || environment.environmentUrl || ''],
    ['Environment URL', environment.environmentUrl || ''],
    ['CLI Binary', cliBinary],
  ];
  const missing = [];
  for (const [key, value] of facts) {
    const result = setRow(markdown, key, value);
    if (!result.found) missing.push(key);
    markdown = result.markdown;
  }
  // `/preview-screens` and `/edit-app` read this to decide whether to open HTML previews.
  markdown = ensureProjectFact(markdown, 'Visual companion', 'yes');

  fs.writeFileSync(target, markdown, 'utf8');
  return { status: 'ok', file: 'memory-bank.md', created: !existed, missingRows: missing };
}

function parseArgs(argv) {
  const options = {};
  const flags = { '--working-dir': 'workingDir', '--requirements': 'requirements', '--environment': 'environment', '--cli-binary': 'cliBinary' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = flags[argv[i]];
    if (!key) throw new Error(`unknown argument ${argv[i]}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argv[i]} needs a value`);
    options[key] = value;
    i += 1;
  }
  if (!options.workingDir || !options.requirements || !options.environment) {
    throw new Error('usage: seed-memory-bank.js --working-dir <dir> --requirements <json> --environment <json> [--cli-binary pa|power-apps]');
  }
  if (options.cliBinary && !['pa', 'power-apps'].includes(options.cliBinary)) throw new Error('--cli-binary must be pa or power-apps');
  return options;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = seedMemoryBank({
      workingDir: options.workingDir,
      requirements: readJson(options.requirements, 'requirements'),
      environment: readJson(options.environment, 'environment'),
      cliBinary: options.cliBinary,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { seedMemoryBank, setRow };
