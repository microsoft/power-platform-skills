#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCREEN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MARKDOWN = /\.(?:md|markdown)$/i;
const USAGE = [
  'Usage: node scripts/read-screen-data-audit.js --project-root <root> --plan <explicit-plan.md> [--screen-id <id> ...]',
  'Read-only extraction of detailed specs; not approval or proof of coverage or quality.',
].join('\n');

function requirePath(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${label} must be an explicit non-empty file system path`);
  }
}

function realPath(value, label) {
  try {
    return fs.realpathSync(value);
  } catch (error) {
    throw new Error(`${label} does not exist or cannot be resolved: ${value} (${error.code})`);
  }
}

function readPlan(projectRoot, planPath) {
  requirePath(projectRoot, 'Project root');
  requirePath(planPath, 'Plan path (--plan)');
  const root = realPath(path.resolve(projectRoot), 'Project root');
  if (!fs.statSync(root).isDirectory()) throw new Error('Project root must be a directory');

  // Resolve symlinks before reading bytes: neither a file link nor an ancestor
  // directory link may redirect an explicitly selected plan outside the real root.
  const file = realPath(path.resolve(root, planPath), 'Plan path');
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Plan path must be inside the project root, not the root itself');
  }
  if (!fs.statSync(file).isFile() || !MARKDOWN.test(planPath) || !MARKDOWN.test(file)) {
    throw new Error('Plan path must be a regular Markdown file (.md or .markdown)');
  }
  return { planPath: relative.split(path.sep).join('/'), bytes: fs.readFileSync(file) };
}

function extractScreens(source) {
  const screens = [];
  const ids = new Set();
  let inScreens = false;
  let inSpecs = false;
  let screensSections = 0;
  let specsSections = 0;
  let fence = null;
  let current = null;

  function finish(end) {
    if (!current) return;
    if (!current.screenId) throw new Error(`Missing Screen ID field in "${current.heading}"`);
    if (ids.has(current.screenId)) throw new Error(`Duplicate Screen ID: ${current.screenId}`);
    ids.add(current.screenId);
    screens.push({
      screenId: current.screenId,
      heading: current.heading,
      // Slice the original text, including the heading, fences and line endings.
      // Auditing needs the full spec, not just selected or annotated Data fields.
      spec: source.slice(current.start, end),
    });
    current = null;
  }

  for (const match of source.matchAll(/([^\r\n]*)(?:\r\n|\n|\r|$)/g)) {
    const line = match.index === 0 ? match[1].replace(/^\uFEFF/, '') : match[1];
    if (fence) {
      const close = /^[ \t]*(`+|~+)[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) fence = null;
      continue;
    }
    // Markdown fences may use backticks or tildes, including longer outer fences
    // around examples containing ```; a shorter or different marker cannot close one.
    // Indented fences also occur in list-item examples within Data and UX fields.
    const open = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && (open[1][0] !== '`' || !open[2].includes('`'))) {
      fence = { marker: open[1][0], length: open[1].length };
      continue;
    }

    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const title = (heading[2] || '').replace(/[ \t]+#+[ \t]*$/, '').trim();
      if (level <= 4) finish(match.index);
      if (level <= 2) {
        inScreens = level === 2 && title.toLowerCase() === 'screens';
        inSpecs = false;
        if (inScreens && ++screensSections > 1) throw new Error('Duplicate ## Screens section');
      } else if (level === 3) {
        inSpecs = inScreens && title.toLowerCase() === 'per-screen specs';
        if (inSpecs && ++specsSections > 1) throw new Error('Duplicate ### Per-Screen Specs section');
      } else if (level === 4 && inSpecs) {
        if (!title) throw new Error('Per-screen spec heading must not be empty');
        current = { start: match.index, heading: title, screenId: null };
      }
      continue;
    }

    if (!current) continue;
    // Accept "- **Screen ID:** `work-list`", "- **Screen ID**: work-list"
    // and "- **Screen ID** — `work-list`", without absorbing adjacent prose.
    const field = /^[ \t]*(?:[-+*][ \t]+)?\*\*[ \t]*Screen[ \t]+ID[ \t]*(:?)[ \t]*\*\*(.*)$/i.exec(line);
    if (!field) continue;
    if (current.screenId) throw new Error(`Duplicate Screen ID field in "${current.heading}"`);
    let value = field[2].trim();
    if (!field[1]) {
      if (!/^[:—–-]/.test(value)) throw new Error(`Invalid Screen ID field in "${current.heading}": missing separator`);
      value = value.slice(1).trim();
    }
    if (value.startsWith('`') && value.endsWith('`')) value = value.slice(1, -1);
    if (!SCREEN_ID.test(value)) {
      throw new Error(`Invalid Screen ID in "${current.heading}": expected a lowercase kebab-case identifier`);
    }
    current.screenId = value;
  }
  if (fence) throw new Error('Unterminated fenced code block in plan');
  finish(source.length);
  if (screens.length === 0) {
    throw new Error('No detailed per-screen specs found under ## Screens / ### Per-Screen Specs');
  }
  return screens;
}

/**
 * Extract audit input from one explicit plan, never from an inferred fallback.
 * All detailed specs are structurally checked before selecting a subset. This
 * does not check Screen Map completeness, domain semantics or product approval.
 */
function readScreenDataAudit({ projectRoot, planPath, screenIds = [] } = {}) {
  if (!Array.isArray(screenIds)) throw new Error('screenIds must be an array of screen IDs');
  for (const id of screenIds) {
    if (typeof id !== 'string' || !SCREEN_ID.test(id)) throw new Error(`Invalid requested screen ID: ${String(id)}`);
  }
  const plan = readPlan(projectRoot, planPath);
  const screens = extractScreens(plan.bytes.toString('utf8'));
  const knownIds = new Set(screens.map(screen => screen.screenId));
  const requested = new Set(screenIds);
  for (const id of requested) {
    if (!knownIds.has(id)) throw new Error(`Unknown requested screen ID: ${id}`);
  }
  return {
    planPath: plan.planPath,
    planSha256: crypto.createHash('sha256').update(plan.bytes).digest('hex'),
    screens: requested.size ? screens.filter(screen => requested.has(screen.screenId)) : screens,
  };
}

function parseArgs(argv) {
  const options = { screenIds: [] };
  const flags = new Map([['--project-root', 'projectRoot'], ['--plan', 'planPath'], ['--screen-id', 'screenIds']]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = flags.get(flag);
    if (!key) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (key === 'screenIds') options.screenIds.push(value);
    else {
      if (Object.hasOwn(options, key)) throw new Error(`Duplicate argument: ${flag}`);
      options[key] = value;
    }
  }
  if (!options.projectRoot || !options.planPath) throw new Error('Both --project-root and an explicit --plan are required');
  return options;
}

if (require.main === module) {
  try {
    const argv = process.argv.slice(2);
    if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
      process.stdout.write(`${USAGE}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(readScreenDataAudit(parseArgs(argv)), null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    process.exitCode = 1;
  }
}

module.exports = { readScreenDataAudit };
