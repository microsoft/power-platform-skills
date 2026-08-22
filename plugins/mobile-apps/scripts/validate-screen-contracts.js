#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  process.stderr.write(`validate-screen-contracts: ${message}\n`);
  process.exitCode = 1;
}

function cleanCell(value) {
  return String(value || '').trim().replace(/^`|`$/g, '').replace(/\\\|/g, '|');
}

function sectionBody(markdown, heading) {
  const start = markdown.indexOf(`${heading}\n`);
  if (start < 0) return null;
  const bodyStart = start + heading.length + 1;
  const level = heading.match(/^#+/)?.[0].length || 1;
  const nextHeading = new RegExp(`^#{1,${level}}\\s+`, 'm');
  const remainder = markdown.slice(bodyStart);
  const next = remainder.search(nextHeading);
  return next < 0 ? remainder : remainder.slice(0, next);
}

function parseTable(markdown, heading, errors) {
  const body = sectionBody(markdown, heading);
  if (body === null) {
    errors.push(`missing ${heading}`);
    return { headers: [], rows: [] };
  }

  // Markdown tables arrive as `| Header | Header |` followed by one delimiter
  // row and data rows. Cell values may be wrapped in inline-code backticks.
  const tableLines = body.split('\n').filter((line) => /^\s*\|/.test(line));
  if (tableLines.length < 2) {
    errors.push(`${heading} does not contain a Markdown table`);
    return { headers: [], rows: [] };
  }
  const parseLine = (line) => line.trim().split(/(?<!\\)\|/).slice(1, -1).map(cleanCell);
  const headers = parseLine(tableLines[0]);
  const rows = tableLines
    .slice(1)
    .filter((line) => !/^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(line))
    .map(parseLine)
    .filter((cells) => cells.some(Boolean));
  return { headers, rows };
}

function rowsAsObjects(table, requiredHeaders, heading, errors) {
  for (const header of requiredHeaders) {
    if (!table.headers.includes(header)) errors.push(`${heading} is missing column ${header}`);
  }
  return table.rows.map((cells) => Object.fromEntries(
    table.headers.map((header, index) => [header, cells[index] || '']),
  ));
}

function routeFromFile(file) {
  const normalized = cleanCell(file).replace(/\\/g, '/');
  if (!normalized.startsWith('app/') || !normalized.endsWith('.tsx')) return null;
  let route = normalized.slice('app'.length, -'.tsx'.length);
  route = route.replace(/\/index$/, '') || '/';
  return route;
}

function parseSpecs(markdown, errors) {
  const screensBody = sectionBody(markdown, '## Screens');
  if (screensBody === null) {
    errors.push('missing ## Screens');
    return [];
  }
  const specsStart = screensBody.indexOf('### Per-Screen Specs\n');
  if (specsStart < 0) {
    errors.push('missing ### Per-Screen Specs');
    return [];
  }
  const specsText = screensBody.slice(specsStart + '### Per-Screen Specs\n'.length);
  const headingPattern = /^#### Screen (\d+) - (.+?) \(`([^`]+)`\)$/gm;
  const headings = [...specsText.matchAll(headingPattern)];
  return headings.map((match, index) => ({
    number: Number(match[1]),
    name: match[2].trim(),
    route: match[3].trim(),
    body: specsText.slice(
      match.index + match[0].length,
      index + 1 < headings.length ? headings[index + 1].index : specsText.length,
    ),
  }));
}

function serviceNames(value) {
  return [...new Set(
    [...String(value || '').matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*Service)\b/g)]
      .map((match) => match[1]),
  )];
}

function importedServiceNames(source) {
  const imported = new Set();
  const importPattern = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"][^'"]+['"];?/g;
  for (const match of source.matchAll(importPattern)) {
    for (const serviceName of serviceNames(match[0])) imported.add(serviceName);
  }
  return imported;
}

function localModuleSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /import\s+(?:type\s+)?[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g,
    /export\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s+from\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1].startsWith('.') || match[1].startsWith('@/')) specifiers.push(match[1]);
    }
  }
  return [...new Set(specifiers)];
}

function resolveLocalModule(importer, specifier, projectRoot) {
  const base = specifier.startsWith('@/')
    ? path.resolve(projectRoot, 'src', specifier.slice(2))
    : path.resolve(path.dirname(importer), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function reachableServiceNames(entryFile, projectRoot) {
  const services = new Set();
  const pending = [entryFile];
  const visited = new Set();
  while (pending.length > 0) {
    const currentFile = pending.pop();
    if (!currentFile || visited.has(currentFile)) continue;
    visited.add(currentFile);
    const source = fs.readFileSync(currentFile, 'utf8');
    for (const serviceName of importedServiceNames(source)) services.add(serviceName);
    for (const specifier of localModuleSpecifiers(source)) {
      const dependency = resolveLocalModule(currentFile, specifier, projectRoot);
      if (dependency && !visited.has(dependency)) pending.push(dependency);
    }
  }
  return services;
}

function declaredParamNames(navigationRow) {
  const declaration = [
    navigationRow?.['Path params'],
    navigationRow?.['Query params (union across all senders)'],
  ].join(' ');
  return [...new Set(
    [...declaration.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\??\s*:/g)]
      .map((match) => match[1]),
  )];
}

function readsLocalParam(source, paramName) {
  const escapedParam = paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const destructurePattern = /(?:const|let)\s*\{([\s\S]{0,500}?)\}\s*=\s*useLocalSearchParams(?:<[\s\S]{0,500}?>)?\s*\(\s*\)/g;
  for (const match of source.matchAll(destructurePattern)) {
    const bindings = match[1].split(',').map((binding) => binding.trim().split(':')[0].trim());
    if (bindings.includes(paramName)) return true;
  }

  const assignmentPattern = /(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*useLocalSearchParams(?:<[\s\S]{0,500}?>)?\s*\(\s*\)/g;
  for (const match of source.matchAll(assignmentPattern)) {
    const variable = match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const propertyRead = new RegExp(`\\b${variable}(?:\\?\\.|\\.)${escapedParam}\\b|\\b${variable}\\[['"]${escapedParam}['"]\\]`);
    if (propertyRead.test(source)) return true;
  }
  return false;
}

function validateBuiltScreens({ screenMap, specByRoute, navigationByRoute, projectRoot, errors }) {
  const resolvedRoot = path.resolve(projectRoot);
  for (const row of screenMap) {
    const screenFile = path.resolve(resolvedRoot, row.File);
    const relativeFile = path.relative(resolvedRoot, screenFile);
    if (relativeFile.startsWith('..') || path.isAbsolute(relativeFile)) {
      errors.push(`${row.Screen} file escapes the project root: ${row.File}`);
      continue;
    }
    if (!fs.existsSync(screenFile) || !fs.statSync(screenFile).isFile()) {
      errors.push(`${row.Screen} route ${row.Route} is missing built file ${row.File}`);
      continue;
    }

    const source = fs.readFileSync(screenFile, 'utf8');
    const spec = specByRoute.get(row.Route);
    const declaredServices = serviceNames(`${row.Data}\n${spec?.body || ''}`);
    const importedServices = reachableServiceNames(screenFile, resolvedRoot);
    for (const serviceName of declaredServices) {
      if (!importedServices.has(serviceName)) {
        errors.push(`${row.Screen} declares ${serviceName} but ${row.File} does not import it directly or through a local dependency`);
      }
    }

    const navigationRow = navigationByRoute.get(row.Route);
    for (const paramName of declaredParamNames(navigationRow)) {
      if (!readsLocalParam(source, paramName)) {
        errors.push(`${row.Screen} declares route param ${paramName} but ${row.File} does not read it with useLocalSearchParams`);
      }
    }
  }
}

function validate(markdown, { projectRoot } = {}) {
  const errors = [];
  const screenMap = rowsAsObjects(
    parseTable(markdown, '### Screen Map', errors),
    ['Screen', 'Route', 'File', 'Presentation', 'Archetype', 'Data'],
    '### Screen Map',
    errors,
  );
  const navigation = rowsAsObjects(
    parseTable(markdown, '### Navigation Contracts', errors),
    ['Route', 'Path params', 'Query params (union across all senders)', 'Intent'],
    '### Navigation Contracts',
    errors,
  );
  const specs = parseSpecs(markdown, errors);

  const routeOwners = new Map();
  const fileOwners = new Map();
  for (const row of screenMap) {
    if (!row.Route || !row.File) {
      errors.push(`screen ${row.Screen || '<unnamed>'} must declare Route and File`);
      continue;
    }
    if (routeOwners.has(row.Route)) errors.push(`duplicate Screen Map route ${row.Route}`);
    if (fileOwners.has(row.File)) errors.push(`duplicate Screen Map file ${row.File}`);
    routeOwners.set(row.Route, row.Screen);
    fileOwners.set(row.File, row.Screen);
    const derivedRoute = routeFromFile(row.File);
    if (derivedRoute && derivedRoute !== row.Route) {
      errors.push(`${row.File} normalizes to ${derivedRoute}, not ${row.Route}`);
    }
  }

  const files = [...fileOwners.keys()];
  for (const file of files) {
    const stem = file.endsWith('.tsx') ? file.slice(0, -4) : file;
    if (files.some((candidate) => candidate !== file && candidate.startsWith(`${stem}/`))) {
      errors.push(`file/folder route collision at ${file}`);
    }
  }

  const signedInRows = screenMap.filter((row) => row.Route.startsWith('/(app)/'));
  const specByRoute = new Map();
  const requiredFields = [
    'Domain layout decisions:',
    '**Archetype:**',
    '**Purpose:**',
    '**Route:**',
    '**File:**',
    '**Presentation:**',
    '**Data:**',
    '**Navigation:**',
    '**Navigation intent:**',
    '**State delta:**',
    '**Key user actions:**',
    '**Idempotency guards:**',
  ];
  const numbers = new Set();
  for (const spec of specs) {
    if (numbers.has(spec.number)) errors.push(`duplicate screen spec number ${spec.number}`);
    numbers.add(spec.number);
    if (specByRoute.has(spec.route)) errors.push(`duplicate per-screen spec route ${spec.route}`);
    specByRoute.set(spec.route, spec);
    for (const field of requiredFields) {
      if (!spec.body.includes(field)) errors.push(`${spec.name} (${spec.route}) is missing ${field}`);
    }
    const mapRow = screenMap.find((row) => row.Route === spec.route);
    if (!mapRow) {
      errors.push(`${spec.name} spec route ${spec.route} is absent from Screen Map`);
      continue;
    }
    if (!spec.body.includes(`**Route:** \`${mapRow.Route}\``)) {
      errors.push(`${spec.name} Route field does not match Screen Map`);
    }
    if (!spec.body.includes(`**File:** \`${mapRow.File}\``)) {
      errors.push(`${spec.name} File field does not match Screen Map`);
    }
    if (/\*\*Archetype:\*\*\s+Form\b/.test(spec.body)
      && !spec.body.includes('**Workflow mutation contract:**')) {
      errors.push(`${spec.name} Form spec is missing **Workflow mutation contract:**`);
    }
  }

  for (const row of signedInRows) {
    if (!specByRoute.has(row.Route)) errors.push(`${row.Screen} (${row.Route}) has no per-screen spec`);
  }

  const navigationByRoute = new Map(navigation.map((row) => [row.Route, row]));
  for (const spec of specs) {
    const contract = navigationByRoute.get(spec.route);
    if (!contract) {
      errors.push(`${spec.name} (${spec.route}) has no Navigation Contracts row`);
      continue;
    }
    const dynamicParams = [...spec.route.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
    for (const param of dynamicParams) {
      if (!contract['Path params'].includes(`${param}: string`)) {
        errors.push(`${spec.route} must declare path param ${param}: string`);
      }
    }
    if (!['navigate', 'push', 'replace'].includes(contract.Intent)) {
      errors.push(`${spec.route} has invalid navigation intent ${contract.Intent || '<empty>'}`);
    }
  }

  const profile = specByRoute.get('/(app)/profile');
  if (!profile) {
    errors.push('missing required Profile screen at /(app)/profile');
  } else {
    if (!profile.body.includes('**Profile content:**')) errors.push('Profile is missing **Profile content:**');
    if (!profile.body.includes('**Sign-out affordance:**')) errors.push('Profile is missing **Sign-out affordance:**');
    if (!profile.body.includes('useAuth().signOut')) errors.push('Profile sign-out contract must use useAuth().signOut');
  }

  if (projectRoot) {
    validateBuiltScreens({
      screenMap,
      specByRoute,
      navigationByRoute,
      projectRoot,
      errors,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    summary: {
      mapRows: screenMap.length,
      signedInScreens: signedInRows.length,
      specs: specs.length,
      navigationContracts: navigation.length,
    },
  };
}

function main() {
  const planArg = process.argv[2];
  if (!planArg) {
    fail('usage: node validate-screen-contracts.js <native-app-plan.md>');
    return;
  }
  const planPath = path.resolve(planArg);
  if (!fs.existsSync(planPath)) {
    fail(`plan not found: ${planPath}`);
    return;
  }
  const result = validate(fs.readFileSync(planPath, 'utf8'), {
    projectRoot: path.dirname(planPath),
  });
  if (!result.valid) {
    for (const error of result.errors) fail(error);
    return;
  }
  process.stdout.write(
    `validate-screen-contracts: PASS (${result.summary.signedInScreens} signed-in screens, `
      + `${result.summary.specs} specs, ${result.summary.navigationContracts} navigation contracts)\n`,
  );
}

if (require.main === module) main();

module.exports = {
  parseSpecs,
  parseTable,
  reachableServiceNames,
  readsLocalParam,
  routeFromFile,
  serviceNames,
  validate,
};