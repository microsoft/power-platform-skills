#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getSection, getSubsection } = require('./validate-experience-contract');

const REQUIRED_SPEC_FIELDS = [
  'archetype',
  'purpose',
  'route',
  'file',
  'presentation',
  'data',
  'native capabilities',
  'navigation',
  'state delta',
  'key user actions',
  'idempotency guards',
];

function stripMarkup(value) {
  return String(value || '').replace(/[`*]/g, '').trim();
}

function parseArgs(argv) {
  const args = { json: false };
  for (const arg of argv) {
    if (arg === '--json') args.json = true;
    else if (!args.planPath) args.planPath = arg;
  }
  return args;
}

function tableCells(line) {
  return line.split('|').slice(1, -1).map((cell) => stripMarkup(cell));
}

function parseScreenMap(markdown) {
  const screens = getSection(markdown, 'Screens');
  const section = getSubsection(screens, 'Screen Map');
  const lines = section.split(/\r?\n/).filter((line) => /^\s*\|/.test(line));
  if (lines.length < 2) return [];
  const headers = tableCells(lines[0]).map((header) => header.toLowerCase());
  const indexes = Object.fromEntries(headers.map((header, index) => [header, index]));
  return lines.slice(2).map((line) => {
    const row = tableCells(line);
    return {
      screen: row[indexes.screen] || '',
      route: row[indexes.route] || '',
      file: row[indexes.file] || '',
    };
  }).filter((row) => row.screen || row.route || row.file);
}

function parseSpecFields(body) {
  const fields = new Map();
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*-\s+\*\*([^*]+):\*\*\s*(.*?)\s*$/.exec(line);
    if (match) fields.set(match[1].trim().toLowerCase(), stripMarkup(match[2]));
  }
  return fields;
}

function parseScreenSpecs(markdown) {
  const screens = getSection(markdown, 'Screens');
  const heading = /^####\s+(.+?)\s+\(`([^`]+)`\)\s*$/gm;
  const matches = [...screens.matchAll(heading)];
  return matches.map((match, index) => {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = index + 1 < matches.length ? matches[index + 1].index : screens.length;
    return {
      screen: match[1].trim(),
      route: match[2].trim(),
      fields: parseSpecFields(screens.slice(bodyStart, bodyEnd)),
    };
  });
}

function routeFromFile(relativeFile) {
  const normalized = String(relativeFile || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = normalized.split('/');
  if (segments.shift() !== 'app') return null;
  const routeSegments = segments
    .filter((segment) => !(/^\(.+\)$/.test(segment) && segment !== '(app)'))
    .map((segment) => segment.replace(/\.tsx?$/i, ''))
    .filter((segment) => segment !== 'index');
  if (!routeSegments.length || routeSegments.some((segment) => segment === '_layout')) return null;
  return `/${routeSegments.join('/')}`;
}

function declaredServices(projectRoot) {
  const barrel = path.join(projectRoot, 'src', 'generated', 'services', 'dataSourcesInfo.ts');
  if (!fs.existsSync(barrel)) return new Set();
  const content = fs.readFileSync(barrel, 'utf8');
  return new Set([...content.matchAll(/export\s+\{\s*([A-Za-z_$][\w$]*Service)\s*\}/g)]
    .map((match) => match[1]));
}

function addIssue(issues, rule, message, detail = {}) {
  issues.push({ rule, message, ...detail });
}

function validateScreenContracts(planPath) {
  const resolvedPlan = path.resolve(planPath);
  const projectRoot = path.dirname(resolvedPlan);
  const markdown = fs.readFileSync(resolvedPlan, 'utf8');
  const rows = parseScreenMap(markdown);
  const specs = parseScreenSpecs(markdown);
  const issues = [];

  if (!rows.length) addIssue(issues, 'missing-screen-map', 'Screens section must contain a populated Screen Map table.');
  if (!specs.length) addIssue(issues, 'missing-screen-specs', 'Screens section must contain per-screen specifications.');

  const routes = new Set();
  const files = new Set();
  const specsByRoute = new Map(specs.map((spec) => [spec.route, spec]));
  const availableServices = declaredServices(projectRoot);

  for (const row of rows) {
    if (!row.screen || !row.route || !row.file) {
      addIssue(issues, 'incomplete-screen-map-row', 'Every Screen Map row needs Screen, Route, and File values.', { screen: row.screen });
      continue;
    }
    if (routes.has(row.route)) addIssue(issues, 'duplicate-route', `Route ${row.route} appears more than once.`, { screen: row.screen });
    if (files.has(row.file)) addIssue(issues, 'duplicate-file', `File ${row.file} appears more than once.`, { screen: row.screen });
    routes.add(row.route);
    files.add(row.file);

    const screenPath = path.resolve(projectRoot, row.file);
    const relative = path.relative(projectRoot, screenPath);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !row.file.replace(/\\/g, '/').startsWith('app/')) {
      addIssue(issues, 'unsafe-screen-file', `Screen file must stay under app/: ${row.file}.`, { screen: row.screen });
      continue;
    }
    if (!fs.existsSync(screenPath)) addIssue(issues, 'missing-screen-file', `Planned screen file does not exist: ${row.file}.`, { screen: row.screen });
    const derivedRoute = routeFromFile(row.file);
    if (derivedRoute !== row.route) {
      addIssue(issues, 'route-file-drift', `Route ${row.route} does not match ${row.file}; expected ${derivedRoute || '<invalid file>'}.`, { screen: row.screen });
    }

    const spec = specsByRoute.get(row.route);
    if (!spec) {
      addIssue(issues, 'missing-screen-spec', `No per-screen spec declares route ${row.route}.`, { screen: row.screen });
      continue;
    }
    for (const field of REQUIRED_SPEC_FIELDS) {
      if (!spec.fields.get(field)) addIssue(issues, 'missing-spec-field', `${row.screen} spec is missing ${field}.`, { screen: row.screen, field });
    }
    if (spec.fields.get('route') && spec.fields.get('route') !== row.route) {
      addIssue(issues, 'spec-route-drift', `${row.screen} spec route ${spec.fields.get('route')} does not match Screen Map route ${row.route}.`, { screen: row.screen });
    }
    if (spec.fields.get('file') && spec.fields.get('file') !== row.file) {
      addIssue(issues, 'spec-file-drift', `${row.screen} spec file ${spec.fields.get('file')} does not match Screen Map file ${row.file}.`, { screen: row.screen });
    }
    const serviceNames = [...String(spec.fields.get('data') || '').matchAll(/\b([A-Z][A-Za-z0-9_$]*Service)\./g)]
      .map((match) => match[1]);
    for (const serviceName of new Set(serviceNames)) {
      if (!availableServices.has(serviceName)) {
        addIssue(issues, 'unknown-generated-service', `${row.screen} references ${serviceName}, but it is not exported by generated services.`, { screen: row.screen, service: serviceName });
      }
    }
  }

  for (const spec of specs) {
    if (!routes.has(spec.route)) addIssue(issues, 'unmapped-screen-spec', `Per-screen spec ${spec.screen} uses route ${spec.route}, which is absent from Screen Map.`, { screen: spec.screen });
  }

  const appRoots = rows.map((row) => path.resolve(projectRoot, row.file));
  for (const screenPath of appRoots) {
    if (!fs.existsSync(screenPath)) continue;
    const content = fs.readFileSync(screenPath, 'utf8');
    if (/from\s+['"][^'"]*\.seed\.json['"]/.test(content)) {
      addIssue(issues, 'direct-seed-import', `${path.relative(projectRoot, screenPath)} imports seed JSON directly; use generated services.`, { file: path.relative(projectRoot, screenPath) });
    }
  }

  return { projectRoot, planPath: resolvedPlan, screens: rows.length, specs: specs.length, issues };
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.planPath) {
    process.stderr.write('Usage: node validate-screen-contracts.js <native-app-plan.md> [--json]\n');
    return 2;
  }
  const planPath = path.resolve(args.planPath);
  if (!fs.existsSync(planPath) || !fs.statSync(planPath).isFile()) {
    process.stderr.write(`BLOCKED: plan not found: ${planPath}\n`);
    return 2;
  }
  const result = validateScreenContracts(planPath);
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.issues.length) {
    if (!args.json) {
      process.stderr.write(`BLOCKED: screen contracts have ${result.issues.length} issue(s):\n`);
      for (const issue of result.issues) process.stderr.write(`- [${issue.rule}] ${issue.message}\n`);
    }
    return 1;
  }
  if (!args.json) process.stdout.write(`Screen contracts passed: ${result.screens} screen(s), ${result.specs} spec(s).\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  parseScreenMap,
  parseScreenSpecs,
  routeFromFile,
  validateScreenContracts,
};