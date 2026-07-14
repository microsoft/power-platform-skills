#!/usr/bin/env node
/**
 * check-conversion-scaffolding.js
 *
 * Detects visible conversion/debug scaffolding that should not remain in a
 * finished adapted mobile app. This is intentionally heuristic: it reports
 * generic panels, source-data labels, and copy that explains the conversion
 * rather than the user's workflow.
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const STRICT = process.env.STRICT === '1' || process.argv.includes('--strict');
const TARGET_DIRS = [
  path.join(ROOT, 'src/appScreens'),
  path.join(ROOT, 'app/(app)'),
  path.join(ROOT, 'src/components'),
  path.join(ROOT, 'src/hooks'),
  path.join(ROOT, 'src/data'),
  path.join(ROOT, 'src/features'),
];

const PATTERNS = [
  { rule: 'generic-capability-panel', re: /\bCapabilityPanel\b|Capabilities/g, message: 'Visible capability/debug panel should be replaced with workflow-specific UI.' },
  { rule: 'related-sources-panel', re: /\bRelatedSources\b|Related sources/g, message: 'Data-source inventory is implementation detail; hide or replace with business filters/summary.' },
  { rule: 'next-actions-panel', re: /\bNextActions\b/g, message: 'Generic next-screen buttons should become explicit workflow actions.' },
  { rule: 'generic-data-list-panel', re: /\bDataListPanel\b/g, message: 'Generic record list should become a domain row/list component before DONE.' },
  { rule: 'generic-service-registry', re: /\bserviceRegistry\b|\bDATA_SOURCES\b|\bDataSourceConfig\b|\buseDataSourceRows\b/g, message: 'Generic service/data-source registries are transition scaffolding. Generate domain hooks instead (for example src/hooks/use<Entity>.ts).' },
  { rule: 'source-technical-copy', re: /clone of|source formula|Dataverse services ready|Form values bind|No external connector required|Routes into|Surfaces related|Screen Map|control tree/gi, message: 'Technical conversion copy leaks implementation details to users.' },
  { rule: 'screen-config-driven-ui', re: /SCREEN_BY_KEY|APP_SCREENS|config\.dataSources|config\.nextScreens/g, message: 'Screen config is okay for routing, but final UI must not be driven by generic screen metadata.' },
  { rule: 'app-screens-import', re: /from ['"]@\/appScreens\//g, message: 'Do not import from src/appScreens; move shared support code to src/components, src/hooks, src/navigation, or src/features.' },
];

function walk(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (/\.(tsx|ts)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function lineNumber(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

const issues = [];
for (const dir of TARGET_DIRS) {
  for (const file of walk(dir)) {
    const rel = path.relative(ROOT, file);
    const text = fs.readFileSync(file, 'utf8');
    if (/^src\/data\//.test(rel)) {
      issues.push({ file: rel, line: 1, rule: 'data-folder-leftover', sample: 'src/data', message: 'src/data is not part of the final generated architecture. Domain server-state hooks belong in src/hooks/use<Domain>.ts.' });
    }
    if (/^src\/appScreens\//.test(rel)) {
      issues.push({ file: rel, line: 1, rule: 'app-screens-folder-leftover', sample: 'src/appScreens', message: 'src/appScreens is conversion staging debt. Route screens belong in app/(app); shared code belongs in src/components, src/hooks, src/navigation, or src/features.' });
    }
    if (/^src\/appScreens\/.*Screen\.tsx$/.test(rel)) {
      issues.push({ file: rel, line: 1, rule: 'screen-implementation-outside-router', sample: 'src/appScreens', message: 'Screen implementations must live directly in Expo Router files under app/(app), not in src/appScreens with route wrappers.' });
    }
    if (/^app\/.+\.tsx$/.test(rel) && /from ['"]@\/appScreens\//.test(text)) {
      const wrapperMessage = /return\s+<Screen\s*\/?>/.test(text)
        ? 'Route file is only a wrapper. Put the real screen implementation directly in this app route file.'
        : 'Route files must not import shared code from @/appScreens. Move helpers to src/components, src/hooks, src/navigation, or src/features.';
      issues.push({ file: rel, line: 1, rule: 'app-screens-import', sample: '@/appScreens', message: wrapperMessage });
    }
    for (const pattern of PATTERNS) {
      pattern.re.lastIndex = 0;
      let match;
      while ((match = pattern.re.exec(text))) {
        issues.push({ file: rel, line: lineNumber(text, match.index), rule: pattern.rule, sample: match[0], message: pattern.message });
      }
    }
  }
}

console.log('\n=== conversion scaffolding audit ===');
console.log(`issues: ${issues.length}`);
if (issues.length) {
  for (const issue of issues.slice(0, 120)) {
    console.log(`- ${issue.file}:${issue.line} [${issue.rule}] ${issue.sample} - ${issue.message}`);
  }
  if (issues.length > 120) console.log(`... ${issues.length - 120} more`);
}

if (STRICT && issues.length) {
  console.error(`\n[scaffold] ${issues.length} conversion-scaffolding issue(s) - STRICT mode failure`);
  process.exit(1);
}
process.exit(0);
