#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validate: validateExperienceContract } = require('./validate-experience-contract');

function normalize(value) {
  return String(value || '').trim();
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') args.json = true;
    else if (arg === '--project-root') args.projectRoot = argv[++index];
    else if (arg === '--phase') args.phase = argv[++index];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (!args.plan) args.plan = arg;
  }
  return args;
}

function section(markdown, heading) {
  const lines = String(markdown || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === ('## ' + heading).toLowerCase());
  if (start < 0) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

function markdownTable(markdown, heading) {
  const lines = String(markdown || '').split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim().toLowerCase() === ('### ' + heading).toLowerCase());
  if (headingIndex < 0) return null;
  const tableLines = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (/^#{1,3}\s+/.test(line)) break;
    if (line.startsWith('|')) tableLines.push(line);
  }
  if (tableLines.length < 2) return null;
  const toCells = (line) => line.split('|').slice(1, -1).map((cell) => cell.trim());
  const headers = toCells(tableLines[0]).map((header) => header.toLowerCase());
  const rows = tableLines
    .slice(1)
    .filter((line) => !/^\|(?:\s*:?-{3,}:?\s*\|)+$/.test(line))
    .map(toCells)
    .filter((cells) => cells.some(Boolean));
  return { headers, rows };
}

function normalizeRoute(route) {
  return normalize(route).replace(/[?#].*$/, '').replace(/\/+$/, '') || '/';
}

function validateScreenContracts(markdown) {
  const issues = [];
  const screens = section(markdown, 'Screens');
  if (!screens) return [{ rule: 'missing-screens-section', message: 'Plan is missing its ## Screens section.' }];

  const screenMap = markdownTable(screens, 'Screen Map');
  if (!screenMap) {
    issues.push({ rule: 'missing-screen-map', message: 'Screens must include a ### Screen Map Markdown table.' });
  } else {
    const routeIndex = screenMap.headers.indexOf('route');
    const fileIndex = screenMap.headers.indexOf('file');
    const screenIndex = screenMap.headers.indexOf('screen');
    if (routeIndex < 0 || fileIndex < 0 || screenIndex < 0) {
      issues.push({ rule: 'screen-map-columns', message: 'Screen Map requires Screen, Route, and File columns.' });
    } else {
      const routes = new Map();
      let hasHome = false;
      for (const row of screenMap.rows) {
        const name = normalize(row[screenIndex]);
        const route = normalize(row[routeIndex]);
        const file = normalize(row[fileIndex]);
        if (!name || !route || !file) {
          issues.push({ rule: 'incomplete-screen-map-row', message: 'Every Screen Map row needs Screen, Route, and File values.' });
          continue;
        }
        const normalizedRoute = normalizeRoute(route);
        if (routes.has(normalizedRoute)) {
          issues.push({
            rule: 'duplicate-screen-route',
            message: 'Duplicate normalized Screen Map route: ' + normalizedRoute + '.',
          });
        } else {
          routes.set(normalizedRoute, name);
        }
        if (file.startsWith('/') || file.includes('..') || !/^app\/.+\.tsx$/i.test(file)) {
          issues.push({
            rule: 'unsafe-screen-file',
            message: 'Screen Map file must be a project-relative app/*.tsx path: ' + file + '.',
          });
        }
        if (normalizedRoute === '/(app)/home' && file === 'app/(app)/home.tsx') hasHome = true;
      }
      if (!hasHome) {
        issues.push({
          rule: 'missing-canonical-home',
          message: 'Screen Map must include Home at /(app)/home backed by app/(app)/home.tsx.',
        });
      }
    }
  }

  const navigation = markdownTable(screens, 'Navigation Contracts');
  if (!navigation) {
    issues.push({
      rule: 'missing-navigation-contracts',
      message: 'Screens must include a ### Navigation Contracts Markdown table.',
    });
  } else if (navigation.headers.indexOf('route') < 0) {
    issues.push({
      rule: 'navigation-contract-columns',
      message: 'Navigation Contracts requires a Route column.',
    });
  }
  return issues;
}

function validateScreenContractsWithExperience(markdown, projectRoot, phase = 'build') {
  const issues = validateScreenContracts(markdown);
  if (!projectRoot) return issues;
  const contractPath = path.join(projectRoot, '.tmp', 'experience-contract.json');
  if (!fs.existsSync(contractPath)) return issues;
  return issues.concat(validateExperienceContract(projectRoot, phase));
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.plan) {
    process.stdout.write('Usage: node validate-screen-contracts.js <native-app-plan.md> [--project-root <dir>] [--phase plan|build] [--json]\n');
    return args.help ? 0 : 2;
  }
  const planPath = path.resolve(args.plan);
  if (!fs.existsSync(planPath)) {
    process.stderr.write('BLOCKED: plan not found: ' + planPath + '\n');
    return 2;
  }
  const projectRoot = path.resolve(args.projectRoot || path.dirname(planPath));
  const phase = args.phase || 'build';
  const issues = validateScreenContractsWithExperience(fs.readFileSync(planPath, 'utf8'), projectRoot, phase);
  const result = { validator: 'validate-screen-contracts', plan: planPath, projectRoot, phase, issues };
  if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (issues.length) {
    if (!args.json) {
      process.stderr.write('BLOCKED: screen contracts have ' + issues.length + ' issue(s):\n');
      for (const issue of issues) process.stderr.write('- [' + issue.rule + '] ' + issue.message + '\n');
    }
    return 2;
  }
  if (!args.json) process.stdout.write('Screen contracts passed: ' + planPath + '\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { validateScreenContracts, validateScreenContractsWithExperience };
