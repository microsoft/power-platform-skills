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

function plainCell(value) {
  return normalize(value)
    .replace(/^[`"'“”']+|[`"'“”']+$/g, '')
    .replace(/\s+/g, ' ');
}

function requirementClauses(markdown) {
  const action = '(?:audit(?:ing)?|browse|buy|captur(?:e|ing)|continu(?:e|ing)|enter|(?:get|retriev)(?:ting|e|ing)?|inspect(?:ing)?|maint(?:ain|aining|ining)|manage|obtain|photograph|print|receiv(?:e|ing)|record|repair|scan|sell|showcas(?:e|ing)|track(?:ing)?|updat(?:e|ing)|view)';
  const actionStart = new RegExp(`\\b${action}\\b`, 'i');
  const actionJoin = new RegExp(`\\s*(?:,|\\band\\b)\\s+(?:to\\s+)?(?=${action}\\b)`, 'gi');
  return String(markdown || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('|') && !line.startsWith('```'))
    .flatMap((line) => line.split(/[.;]\s*/))
    .map((sentence) => sentence
      .replace(/^(?:create|design|build)\b.*?\b(?:app|solution)\b(?:\s+(?:for|to))?\s*/i, '')
      .replace(/\b(?:users?|people|workers?)\s+should\s+be\s+able\s+to\s+/gi, ', ')
      .replace(/,\s*(?:the\s+)?company\s+owns\b[^,]+,\s*/gi, ', ')
      .replace(/\b(?:the\s+)?app\s+should\s+support\s+/gi, ', ')
      .replace(/^(?:enable|help|allow|let|give)\b.*?\bto\s+(?=[a-z])/i, '')
      .replace(/^.*?\bused\b.*?\bfor\s+(?=[a-z])/i, ''))
    .map((sentence) => {
      const firstAction = sentence.match(actionStart);
      return firstAction ? sentence.slice(firstAction.index) : '';
    })
    .flatMap((sentence) => sentence.split(actionJoin))
    .map((clause) => clause.replace(/[.;,]+$/, '').trim())
    .filter((clause) => actionStart.test(clause));
}

function validateScreenContracts(markdown) {
  const issues = [];
  const screens = section(markdown, 'Screens');
  if (!screens) return [{ rule: 'missing-screens-section', message: 'Plan is missing its ## Screens section.' }];

  const screenMap = markdownTable(screens, 'Screen Map');
  const mappedScreens = [];
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
          mappedScreens.push({ name, route: normalizedRoute });
        }
        if (file.startsWith('/') || file.includes('..') || !/^app\/.+\.tsx$/i.test(file)) {
          issues.push({
            rule: 'unsafe-screen-file',
            message: 'Screen Map file must be a project-relative app/*.tsx path: ' + file + '.',
          });
        }
        if (normalizedRoute === '/(app)/home' && ['app/(app)/home.tsx', 'app/(app)/home/index.tsx'].includes(file)) hasHome = true;
      }
      if (!hasHome) {
        issues.push({
          rule: 'missing-canonical-home',
          message: 'Screen Map must include Home at /(app)/home backed by app/(app)/home.tsx or app/(app)/home/index.tsx.',
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

  const requirements = section(markdown, 'App Requirements');
  if (requirements.trim()) {
    const coverage = markdownTable(screens, 'Requirement Coverage');
    if (!coverage) {
      issues.push({
        rule: 'missing-requirement-coverage',
        message: 'Screens must include a ### Requirement Coverage table for the confirmed App Requirements.',
      });
    } else {
      const requiredColumns = ['requirement', 'brief evidence', 'surface', 'action', 'data', 'states'];
      const indexes = Object.fromEntries(requiredColumns.map((column) => [column, coverage.headers.indexOf(column)]));
      const missingColumns = requiredColumns.filter((column) => indexes[column] < 0);
      if (missingColumns.length) {
        issues.push({
          rule: 'requirement-coverage-columns',
          message: `Requirement Coverage requires columns: ${requiredColumns.join(', ')}.`,
        });
      } else if (!coverage.rows.length) {
        issues.push({ rule: 'empty-requirement-coverage', message: 'Requirement Coverage must contain at least one explicit product job.' });
      } else {
        const normalizedRequirements = requirements.replace(/\s+/g, ' ').toLowerCase();
        const clauses = requirementClauses(requirements);
        const clauseAssignments = new Map(clauses.map((clause) => [clause, []]));
        for (const [rowIndex, row] of coverage.rows.entries()) {
          const values = Object.fromEntries(requiredColumns.map((column) => [column, plainCell(row[indexes[column]])]));
          const label = `Requirement Coverage row ${rowIndex + 1}`;
          for (const column of requiredColumns) {
            if (!values[column]) issues.push({ rule: 'incomplete-requirement-coverage', message: `${label} is missing ${column}.` });
          }
          if (values['brief evidence'] && !normalizedRequirements.includes(values['brief evidence'].toLowerCase())) {
            issues.push({ rule: 'unverified-requirement-evidence', message: `${label} evidence is not an exact phrase from App Requirements: ${values['brief evidence']}.` });
          } else if (values['brief evidence']) {
            const evidence = values['brief evidence'].toLowerCase();
            const matchedClauses = clauses.filter((clause) => {
              const normalizedClause = clause.toLowerCase();
              return normalizedClause.includes(evidence) || evidence.includes(normalizedClause);
            });
            if (matchedClauses.length !== 1) {
              issues.push({
                rule: 'ambiguous-requirement-evidence',
                message: `${label} must cite one bounded App Requirements clause; it currently matches ${matchedClauses.length}.`,
              });
            } else {
              clauseAssignments.get(matchedClauses[0]).push(rowIndex + 1);
            }
          }
          if (values.surface && !mappedScreens.some((screen) => (
            values.surface.toLowerCase().includes(screen.name.toLowerCase())
            || values.surface.includes(screen.route)
          ))) {
            issues.push({ rule: 'unknown-requirement-surface', message: `${label} points to an unknown Screen Map surface: ${values.surface}.` });
          }
        }
        for (const clause of clauses) {
          if (!clauseAssignments.get(clause).length) {
            issues.push({ rule: 'uncovered-app-requirement', message: `No Requirement Coverage row cites this App Requirements clause: ${clause}.` });
          }
        }
      }
    }
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

module.exports = { requirementClauses, validateScreenContracts, validateScreenContractsWithExperience };
