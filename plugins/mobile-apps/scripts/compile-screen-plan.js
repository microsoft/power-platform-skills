#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseSpecs, parseTable } = require('./validate-screen-contracts');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(PLUGIN_ROOT, 'shared', 'contracts', 'plan.schema.json');
const REQUIRED = ['id', 'route', 'archetype', 'pattern', 'components', 'binding', 'states', 'derived'];
const ARCHETYPES = new Set(['list', 'detail', 'form', 'auth', 'tab-root', 'modal-sheet', 'empty-onboarding']);

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
}

function clean(value) {
  return String(value || '').trim().replace(/^`|`$/g, '');
}

function slug(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function field(body, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return clean(body.match(new RegExp(`^- \\*\\*${escaped}:\\*\\*\\s*(.+)$`, 'm'))?.[1] || '');
}

function list(value, separator = /[,;]/) {
  if (!value || /^(?:none|-|—)$/i.test(value)) return [];
  return [...new Set(value.split(separator).map(clean).filter(Boolean))];
}

function objects(table) {
  return table.rows.map((cells) => Object.fromEntries(table.headers.map((header, index) => [header, cells[index] || ''])));
}

function normalizeArchetype(value) {
  return clean(value).toLowerCase().replace(/\s+/g, '-');
}

function compile(markdown) {
  const parseErrors = [];
  const mapRows = objects(parseTable(markdown, '### Screen Map', parseErrors));
  const specs = parseSpecs(markdown, parseErrors);
  const specsByRoute = new Map(specs.map((spec) => [spec.route, spec]));
  const concerns = [...parseErrors];
  const screens = [];
  const scheduleScreens = [];

  for (const row of mapRows.filter((candidate) => clean(candidate.Route).startsWith('/(app)/'))) {
    const spec = specsByRoute.get(clean(row.Route));
    const body = spec?.body || '';
    const screen = {
      id: clean(row.ID),
      route: clean(row.Route),
      archetype: normalizeArchetype(row.Archetype),
      pattern: clean(row.Pattern),
      components: list(field(body, 'Components')),
      binding: field(body, 'Binding'),
      states: list(field(body, 'States')),
      derived: list(field(body, 'Derived')),
    };
    const hero = field(body, 'Hero');
    if (hero) screen.hero = hero;
    const label = clean(row.Screen) || spec?.name || screen.route;
    const missing = REQUIRED.filter((key) => {
      const value = screen[key];
      return value === undefined || value === '' || Array.isArray(value) && key !== 'derived' && value.length === 0;
    });
    if (!ARCHETYPES.has(screen.archetype)) missing.push('archetype(valid enum)');
    if ((screen.id === 'home' || /\/home$/.test(screen.route)) && !screen.hero) missing.push('hero(Home)');
    if (missing.length > 0) concerns.push(`${label}: missing ${[...new Set(missing)].join(', ')}`);
    screens.push(screen);
    scheduleScreens.push({ id: screen.id || slug(label), label, route: screen.route, file: clean(row.File) });
  }

  const duplicateIds = screens.map((screen) => screen.id).filter((id, index, all) => id && all.indexOf(id) !== index);
  const duplicateRoutes = screens.map((screen) => screen.route).filter((route, index, all) => route && all.indexOf(route) !== index);
  if (duplicateIds.length > 0) concerns.push(`duplicate ids: ${[...new Set(duplicateIds)].join(', ')}`);
  if (duplicateRoutes.length > 0) concerns.push(`duplicate routes: ${[...new Set(duplicateRoutes)].join(', ')}`);
  if (screens.length === 0) concerns.push('no signed-in screens');

  const complete = concerns.length === 0;
  const concurrency = complete ? 3 : 1;
  const waves = [];
  for (let index = 0; index < scheduleScreens.length; index += concurrency) waves.push(scheduleScreens.slice(index, index + concurrency));
  return {
    plan: complete ? { schemaVersion: 1, screens } : null,
    assessment: { schemaVersion: 1, mode: complete ? 'complete' : 'thin', concurrency, concerns, screens: scheduleScreens, waves },
  };
}

function outputPaths(projectDir) {
  const directory = path.join(projectDir, '.mobile-build');
  return {
    assessment: path.join(directory, 'screen-plan-assessment.json'),
    plan: path.join(directory, 'screen-plan.json'),
    schedule: path.join(directory, 'screen-build-schedule.json'),
  };
}

function compileProject(projectDir, planPath = path.join(projectDir, 'native-app-plan.md')) {
  const result = compile(fs.readFileSync(planPath, 'utf8'));
  const targets = outputPaths(projectDir);
  atomicWrite(targets.assessment, result.assessment);
  atomicWrite(targets.schedule, { concurrency: result.assessment.concurrency, waves: result.assessment.waves });
  if (result.plan) atomicWrite(targets.plan, result.plan);
  else fs.rmSync(targets.plan, { force: true });
  return { ...result, paths: targets };
}

function main() {
  try {
    const projectIndex = process.argv.indexOf('--project');
    const planIndex = process.argv.indexOf('--plan');
    if (projectIndex < 0 || !process.argv[projectIndex + 1]) throw new Error('usage: compile-screen-plan.js --project <dir> [--plan <native-app-plan.md>]');
    const projectDir = path.resolve(process.argv[projectIndex + 1]);
    const planPath = planIndex >= 0 ? path.resolve(process.argv[planIndex + 1]) : path.join(projectDir, 'native-app-plan.md');
    const result = compileProject(projectDir, planPath);
    if (result.plan) console.log('DONE');
    else console.log(`DONE_WITH_CONCERNS: thin screen plan; using serial builds; ${result.assessment.concerns.join('; ')}`);
    console.log(JSON.stringify({ mode: result.assessment.mode, concurrency: result.assessment.concurrency, waves: result.assessment.waves.length, assessment: result.paths.assessment, structuredPlan: result.plan ? result.paths.plan : null }));
  } catch (error) {
    console.error(`compile-screen-plan: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { ARCHETYPES, REQUIRED, SCHEMA_PATH, compile, compileProject, field, list, normalizeArchetype, outputPaths, slug };
