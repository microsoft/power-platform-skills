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
 *     [--visual-companion yes|no]
 *
 * `requirements.json` is the build plan's requirements section (`appName`, `slug`).
 * `resolved-environment.json` is `resolve-environment.js` output (`environmentId`, `displayName`,
 * `environmentUrl`). Both are read as data, so user-authored names never pass through a shell.
 *
 * `--visual-companion` is the run's preview preference (`--no-design` makes it `no`). It is written
 * as the `visual_companion: <yes|no>` line that `/preview-screens` and `/edit-app` grep for, the same
 * line the data-model-first order writes at its Step 6.7; a table row would not be found.
 *
 * Rerunning refreshes the current-state rows, keeps recorded history and preferences, and leaves
 * every other line as it is, so a bank that later steps have appended to keeps their entries.
 * Prints one line of JSON.
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

/** The value cell of the `| <key> | ... |` row, or undefined when the bank has no such row. */
function rowValue(markdown, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\| ${escaped} \\|(.*)\\|[ \\t]*$`, 'm').exec(markdown);
  return match ? match[1].trim() : undefined;
}

/**
 * True for a cell nobody has filled yet: empty, or the template's italic hint, e.g.
 *   | Created | _<ISO date>_ |
 *   | Environment URL | _e.g. https://contoso.crm.dynamics.com - captured at /add-dataverse Step 1_ |
 */
function isUnset(value) {
  return !value || /^_.*_$/.test(value);
}

// Facts about how the project began. Scaffold setup and Step 9.0 both run this helper, and a run
// continued on a later day or after a plugin update must not rewrite when, or with which plugin
// version, the project was created, so these fill only while their cell is unset. Every other
// fact describes the project as it is now, and a rerun refreshes it.
const CREATION_FACTS = new Set(['Plugin version that created the project', 'Created']);

const VISUAL_COMPANION = /^visual_companion:/m;

/**
 * Record the preview preference as the line `/preview-screens` greps for:
 *   visual_companion: no
 * It goes right after the `## Project facts` table, separated by a blank line so Markdown does not
 * read it as another table row. Once written, the line is the project's preference and the seeder
 * leaves it alone: scaffold setup records the run's value, Step 9.0 passes the same value again,
 * and a later run's default must not reset a choice the project already made.
 */
function ensureVisualCompanion(markdown, value) {
  if (VISUAL_COMPANION.test(markdown)) return { markdown, written: false };
  const line = `visual_companion: ${value}`;
  const withLine = markdown.replace(/(## Project facts\n\n(?:\|.*\|\n)+)/, (table) => `${table}\n${line}\n`);
  return { markdown: withLine, written: withLine !== markdown };
}

function seedMemoryBank({
  workingDir, requirements, environment, cliBinary = 'pa', visualCompanion, now = new Date(),
}) {
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
    const current = rowValue(markdown, key);
    if (current === undefined) {
      missing.push(key);
      continue;
    }
    if (CREATION_FACTS.has(key) && !isUnset(current)) continue;
    markdown = setRow(markdown, key, value).markdown;
  }
  if (visualCompanion !== undefined) {
    const result = ensureVisualCompanion(markdown, visualCompanion);
    if (!result.written && !VISUAL_COMPANION.test(markdown)) missing.push('visual_companion');
    markdown = result.markdown;
  }

  fs.writeFileSync(target, markdown, 'utf8');
  return { status: 'ok', file: 'memory-bank.md', created: !existed, missingRows: missing };
}

function parseArgs(argv) {
  const options = {};
  const flags = {
    '--working-dir': 'workingDir',
    '--requirements': 'requirements',
    '--environment': 'environment',
    '--cli-binary': 'cliBinary',
    '--visual-companion': 'visualCompanion',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = flags[argv[i]];
    if (!key) throw new Error(`unknown argument ${argv[i]}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argv[i]} needs a value`);
    options[key] = value;
    i += 1;
  }
  if (!options.workingDir || !options.requirements || !options.environment) {
    throw new Error('usage: seed-memory-bank.js --working-dir <dir> --requirements <json> --environment <json> [--cli-binary pa|power-apps] [--visual-companion yes|no]');
  }
  if (options.cliBinary && !['pa', 'power-apps'].includes(options.cliBinary)) throw new Error('--cli-binary must be pa or power-apps');
  if (options.visualCompanion && !['yes', 'no'].includes(options.visualCompanion)) throw new Error('--visual-companion must be yes or no');
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
      visualCompanion: options.visualCompanion,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { seedMemoryBank, setRow };
