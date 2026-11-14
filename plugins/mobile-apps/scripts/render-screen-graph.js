#!/usr/bin/env node

/**
 * render-screen-graph.js - check the screen graph `/create-mobile-app` drafts at Step 4 and render
 * it into the plan's `## Screens` section.
 *
 * The orchestrator writes the graph once, as compact JSON (`.tmp/screens.json`). Everything that
 * follows mechanically from it - the Screen Map table, the union of params each route receives,
 * the Data Contract's markdown - is produced here, so the model never writes the same graph twice
 * and the rendered section cannot drift from the JSON that builders and the navigation shell read.
 *
 * Usage:
 *   node render-screen-graph.js --working-dir <app root> [--screens-file .tmp/screens.json]
 *                               [--plan native-app-plan.md]
 *
 * The JSON shape is defined in skills/create-mobile-app/references/screen-graph.md. In short:
 *   { navigation, pattern, list: [{ name, route, file, presentation, source, archetype, purpose,
 *     layout, data, capabilities, params, opens: [{ to, params, intent, from }] }],
 *     conventions: [string], contract: { entities: [{ name, purpose, fields, operations, queries,
 *     sampleRecords, sampleNotes }], deviceActions: [string] } }
 *
 * Writes the five graph subsections of `## Screens` (Navigation Pattern, Screen Map, Navigation
 * Contracts, Shared Conventions, Data Contract) and keeps any other subsection there, such as the
 * per-screen specs Phase B adds, so a rerun after a graph change never drops later work.
 *
 * Prints one line of JSON and exits 0 (`status: "ok"`, with `warnings`), 1 (`status: "blocked"`,
 * with every `problems` entry found, so one repair pass can fix them all), or 2 (bad arguments).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Blocked, ENTRY_FILE, expoRoute, isTemplateKept, normalizeGraph } = require('./scaffold-preview-screens');

const GRAPH_SECTIONS = ['Navigation Pattern', 'Screen Map', 'Navigation Contracts', 'Shared Conventions', 'Data Contract'];
const ARCHETYPES = new Set(['List', 'Detail', 'Form', 'Dashboard', 'Settings', 'Auth', 'Empty']);
const INTENTS = new Set(['push', 'navigate', 'replace']);
const OPERATIONS = /^(list|get|create|update|remove)\b/;
// Field types from shared/references/preview-data-layer.md `## Data Contract`; another entity's
// name and a quoted literal union are the other two allowed forms.
const BASE_TYPES = new Set(['string', 'text', 'number', 'integer', 'decimal', 'currency', 'boolean', 'date',
  'datetime', 'email', 'phone', 'url', 'image', 'file']);

const text = (value) => String(value == null ? '' : value).trim();
const list = (value) => (Array.isArray(value) ? value : []);
// A table cell must not end the row early.
const cell = (value) => text(value).replace(/\|/g, '\\|').replace(/\n+/g, ' ') || '—';
const paramName = (param) => text(param).split(':')[0].replace(/\?$/, '').trim();

function routeOf(screen) {
  return text(screen.route) || expoRoute(text(screen.file));
}

/** Every problem in the graph, not just the first: the orchestrator repairs them in one pass. */
function checkGraph(graph) {
  const problems = [];
  const warnings = [];
  try {
    const { screens } = normalizeGraph(graph);
    if (!screens.some((s) => s.file === ENTRY_FILE && !s.kept)) {
      problems.push(`the root index opens /(app)/home, so one screen to build must have file ${ENTRY_FILE}`);
    }
  } catch (error) {
    if (!(error instanceof Blocked)) throw error;
    problems.push(error.message);
    return { problems, warnings };
  }

  const entities = list(graph.contract && graph.contract.entities);
  const entityNames = new Set(entities.map((e) => text(e.name)));
  const routes = new Map(graph.list.map((s) => [routeOf(s), s]));
  // `/(app)/home` and `/home` name the same screen; senders use either.
  const findRoute = (to) => routes.get(text(to)) || routes.get(text(to).replace(/^\/\(app\)/, '')) || [...routes.entries()].find(([r]) => r.replace(/^\/\(app\)/, '') === text(to))?.[1];

  for (const screen of graph.list) {
    const name = text(screen.name);
    if (isTemplateKept(screen)) continue;
    if (!ARCHETYPES.has(text(screen.archetype))) problems.push(`screen '${name}': archetype '${text(screen.archetype)}' is not one of ${[...ARCHETYPES].join(', ')}`);
    for (const key of ['purpose', 'layout', 'data']) {
      if (!text(screen[key])) problems.push(`screen '${name}': ${key} is empty`);
    }
    for (const open of list(screen.opens)) {
      const target = findRoute(open.to);
      if (!target) {
        problems.push(`screen '${name}' opens ${text(open.to)}, which is not a route in the graph`);
        continue;
      }
      if (!INTENTS.has(text(open.intent))) problems.push(`screen '${name}' opens ${text(open.to)} with intent '${text(open.intent)}'; use push, navigate, or replace`);
      const accepted = new Set(list(target.params).map(paramName));
      for (const param of list(open.params)) {
        if (!accepted.has(paramName(param))) {
          problems.push(`screen '${name}' sends '${paramName(param)}' to ${text(open.to)}, which does not list it in params`);
        }
      }
    }
    // A data hook is named after its entity (useInspectionList -> Inspection). useAuth comes from
    // the template, not the data layer.
    for (const hook of text(screen.data).match(/\buse[A-Z]\w*/g) || []) {
      if (hook === 'useAuth') continue;
      if (![...entityNames].some((entity) => hook.startsWith(`use${entity}`))) {
        warnings.push(`screen '${name}' uses ${hook}, which names no contract entity`);
      }
    }
  }

  if (entities.length === 0) warnings.push('the Data Contract has no entities');
  const seen = new Set();
  for (const entity of entities) {
    const name = text(entity.name);
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) problems.push(`entity '${name}' must be PascalCase`);
    if (seen.has(name)) problems.push(`entity '${name}' is defined twice`);
    seen.add(name);
    if (!text(entity.purpose)) problems.push(`entity '${name}': purpose is empty`);
    if (list(entity.fields).length === 0) problems.push(`entity '${name}' has no fields`);
    for (const field of list(entity.fields)) {
      const match = /^([a-z][A-Za-z0-9]*)\??: (.+)$/.exec(text(field));
      if (!match) {
        problems.push(`entity '${name}': field '${text(field)}' must read 'name: type' in camelCase`);
        continue;
      }
      // `siteName: string (from Site)` is a display value derived from a reference.
      const type = match[2].replace(/\s*\(from [A-Z]\w*\)$/, '').trim();
      if (/^[A-Za-z]\w*$/.test(type) && !BASE_TYPES.has(type) && !entityNames.has(type)) {
        problems.push(`entity '${name}': field '${match[1]}' has type '${type}', which is neither a base type nor a contract entity`);
      }
    }
    if (list(entity.operations).length === 0) problems.push(`entity '${name}' has no operations`);
    for (const op of list(entity.operations)) {
      if (!OPERATIONS.test(text(op))) problems.push(`entity '${name}': operation '${text(op)}' must start with list, get, create, update, or remove`);
    }
    if (!Number.isInteger(entity.sampleRecords) || entity.sampleRecords < 1) {
      problems.push(`entity '${name}': sampleRecords must be a positive whole number`);
    }
  }
  return { problems, warnings };
}

function renderNavigationContracts(graph) {
  const rows = [];
  for (const screen of graph.list) {
    const route = routeOf(screen);
    const openedBy = [];
    for (const sender of graph.list) {
      for (const open of list(sender.opens)) {
        const to = text(open.to);
        if (to === route || to.replace(/^\/\(app\)/, '') === route.replace(/^\/\(app\)/, '')) {
          const sent = list(open.params).map(paramName).join(', ');
          openedBy.push(`${text(sender.name)}${open.from ? ` (${text(open.from)})` : ''} - ${text(open.intent)}${sent ? ` with ${sent}` : ''}`);
        }
      }
    }
    const params = list(screen.params).map((p) => `\`${text(p)}\``).join(', ');
    rows.push(`| \`${route}\` | ${params || '—'} | ${openedBy.map(cell).join('<br>') || '—'} |`);
  }
  return [
    '### Navigation Contracts',
    '',
    'Every param a route receives, as the union of what its senders pass. A receiver declares all of them, and a sender passes only these.',
    '',
    '| Route | Params | Opened by (intent) |',
    '|---|---|---|',
    ...rows,
  ].join('\n');
}

function renderDataContract(contract) {
  const out = ['### Data Contract'];
  for (const entity of list(contract && contract.entities)) {
    out.push('', `#### ${text(entity.name)}`);
    out.push(`- **Purpose:** ${text(entity.purpose)}`);
    out.push(`- **Fields:** ${list(entity.fields).map((f) => `\`${text(f)}\``).join(' · ')}`);
    out.push(`- **Operations:** ${list(entity.operations).map(text).join(' · ')}`);
    if (list(entity.queries).length) out.push(`- **Queries:** ${list(entity.queries).map(text).join(' · ')}`);
    out.push(`- **Sample records:** ${entity.sampleRecords}${text(entity.sampleNotes) ? `. ${text(entity.sampleNotes)}` : ''}`);
  }
  const actions = list(contract && contract.deviceActions);
  if (actions.length) out.push('', '#### Device actions', ...actions.map((a) => `- ${text(a)}`));
  return out.join('\n');
}

function renderSections(graph) {
  const map = [
    '### Screen Map',
    '',
    '| Screen | Route | File | Presentation | Archetype | Purpose | Data | Native | Source |',
    '|---|---|---|---|---|---|---|---|---|',
    ...graph.list.map((s) => `| ${cell(s.name)} | \`${routeOf(s)}\` | \`${text(s.file)}\` | ${cell(s.presentation || 'default')} | ${cell(s.archetype)} | ${cell(s.purpose)} | ${cell(s.data)} | ${cell(list(s.capabilities).join(', '))} | ${cell(s.source)} |`),
  ];
  const layouts = graph.list.filter((s) => !isTemplateKept(s) && text(s.layout));
  if (layouts.length) map.push('', ...layouts.map((s) => `- **${text(s.name)}:** ${text(s.layout)}`));
  return {
    'Navigation Pattern': `### Navigation Pattern\n\n**${text(graph.navigation)}** - ${text(graph.pattern)}`,
    'Screen Map': map.join('\n'),
    'Navigation Contracts': renderNavigationContracts(graph),
    'Shared Conventions': ['### Shared Conventions', '', ...list(graph.conventions).map((c) => `- ${text(c)}`)].join('\n'),
    'Data Contract': renderDataContract(graph.contract),
  };
}

/**
 * Replaces the graph's subsections inside `## Screens` and keeps every other subsection, in order,
 * after them. A plan with no `## Screens` heading gets one before `## Approvals` (or at the end).
 */
function mergeIntoPlan(plan, sections) {
  const lines = plan.replace(/\r\n/g, '\n').split('\n');
  let start = lines.findIndex((l) => /^## Screens\s*$/.test(l));
  if (start === -1) {
    const approvals = lines.findIndex((l) => /^## Approvals\s*$/.test(l));
    const at = approvals === -1 ? lines.length : approvals;
    lines.splice(at, 0, '## Screens', '');
    start = at;
  }
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;

  // Split the old body into `### ` subsections; text before the first one is dropped, because the
  // graph's subsections replace whatever placeholder the skeleton held.
  const kept = [];
  let current = null;
  for (const line of lines.slice(start + 1, end)) {
    const heading = /^### (.+?)\s*$/.exec(line);
    if (heading) {
      current = { title: heading[1], lines: [line] };
      kept.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  const others = kept.filter((s) => !GRAPH_SECTIONS.includes(s.title)).map((s) => s.lines.join('\n').trimEnd());
  const body = [...GRAPH_SECTIONS.map((title) => sections[title]), ...others].join('\n\n');
  return [...lines.slice(0, start + 1), '', body, '', ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n');
}

function renderScreenGraph({ workingDir, screensFile = '.tmp/screens.json', planFile = 'native-app-plan.md' }) {
  const root = path.resolve(workingDir);
  const graph = JSON.parse(fs.readFileSync(path.resolve(root, screensFile), 'utf8'));
  const { problems, warnings } = checkGraph(graph);
  if (problems.length) return { status: 'blocked', problems, warnings };
  const planPath = path.resolve(root, planFile);
  const plan = fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf8') : '';
  fs.writeFileSync(planPath, mergeIntoPlan(plan, renderSections(graph)));
  return {
    status: 'ok',
    plan: path.relative(root, planPath),
    screens: graph.list.filter((s) => !isTemplateKept(s)).length,
    entities: list(graph.contract && graph.contract.entities).length,
    warnings,
  };
}

function parseArgs(argv) {
  const options = {};
  const flags = { '--working-dir': 'workingDir', '--screens-file': 'screensFile', '--plan': 'planFile' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = flags[argv[i]];
    if (!key || argv[i + 1] === undefined) throw new Error(`unknown or incomplete argument: ${argv[i]}`);
    options[key] = argv[i + 1];
    i += 1;
  }
  if (!options.workingDir) throw new Error('--working-dir is required');
  return options;
}

if (require.main === module) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'error', reason: error.message })}\n`);
    process.exit(2);
  }
  try {
    const result = renderScreenGraph(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.status === 'ok' ? 0 : 1);
  } catch (error) {
    // An unreadable or malformed screens file is the orchestrator's to repair, like any problem.
    process.stdout.write(`${JSON.stringify({ status: 'blocked', problems: [error.message], warnings: [] })}\n`);
    process.exit(1);
  }
}

module.exports = { checkGraph, mergeIntoPlan, renderScreenGraph, renderSections };
