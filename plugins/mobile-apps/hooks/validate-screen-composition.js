#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  getSection,
  getSubsection,
  parseBulletFields,
  parseTableFields,
} = require('../scripts/validate-experience-contract');

const TAMAGUI_FONT_SIZE_MIN = {
  '$1': 12,
  '$2': 13,
  '$3': 14,
  '$4': 15,
  '$5': 16,
  '$6': 18,
  '$7': 20,
  '$8': 24,
  '$9': 30,
  '$10': 36,
  '$11': 48,
  '$12': 64,
  '$13': 72,
};

function normalize(value) {
  return String(value || '').replace(/^\s*`|`\s*$/g, '').trim().toLowerCase();
}

function numberFrom(value) {
  const match = /\d+(?:\.\d+)?/.exec(String(value || ''));
  return match ? Number(match[0]) : Number.NaN;
}

function isWatchedFile(filePath) {
  if (typeof filePath !== 'string' || !/\.tsx$/i.test(filePath)) return false;
  const normalized = filePath.replace(/\\/g, '/');
  return (/\/app\//.test(normalized) || /\/src\/components\//.test(normalized))
    && !/\/_layout\.tsx$/.test(normalized)
    && !/\/node_modules\//.test(normalized)
    && !/\/src\/generated\//.test(normalized);
}

function parseArgs(argv) {
  const args = { report: false, targets: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project-root') args.projectRoot = argv[++index];
    else if (arg === '--report') args.report = true;
    else args.targets.push(arg);
  }
  return args;
}

function collectFiles(targets, projectRoot) {
  const files = [];
  const roots = targets.length ? targets : [path.join(projectRoot, 'app')];
  function walk(target) {
    const resolved = path.resolve(projectRoot, target);
    if (!fs.existsSync(resolved)) return;
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(resolved)) {
        if (['node_modules', '.expo', 'dist', 'build'].includes(entry)) continue;
        walk(path.join(resolved, entry));
      }
    } else if (stat.isFile() && isWatchedFile(resolved)) files.push(resolved);
  }
  for (const target of roots) walk(target);
  return [...new Set(files)];
}

function parseScreenMap(markdown) {
  const screens = getSection(markdown, 'Screens');
  const subsection = getSubsection(screens, 'Screen Map');
  const lines = subsection.split(/\r?\n/).filter((line) => /^\s*\|/.test(line));
  if (lines.length < 2) return [];
  const cells = (line) => line.split('|').slice(1, -1).map((cell) => cell.trim().replace(/`/g, ''));
  const headers = cells(lines[0]).map((header) => header.toLowerCase());
  const indexes = Object.fromEntries(headers.map((header, index) => [header, index]));
  return lines.slice(2).map((line) => {
    const row = cells(line);
    return {
      screen: row[indexes.screen] || '',
      route: row[indexes.route] || '',
      file: row[indexes.file] || '',
      source: row[indexes.source] || '',
    };
  }).filter((row) => row.file && !/^[-—]$/.test(row.file));
}

function parseContract(markdown) {
  const section = getSection(markdown, 'Product Experience');
  const fields = parseBulletFields(section.split(/^### First Viewport Contract\s*$/m)[0]);
  const viewport = parseTableFields(getSubsection(section, 'First Viewport Contract'));
  return { fields, viewport };
}

function addIssue(issues, file, rule, message, match = '') {
  issues.push({
    validator: 'validate-screen-composition',
    file,
    line: 1,
    rule,
    match,
    fix: message,
    autoFixable: false,
  });
}

function componentFile(projectRoot, name) {
  if (!name) return null;
  const candidates = [
    path.join(projectRoot, 'src', 'components', `${name}.tsx`),
    path.join(projectRoot, 'src', 'components', `${name}.ts`),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function combinedHomeSource(projectRoot, homeContent, signatureName) {
  const signaturePath = componentFile(projectRoot, signatureName);
  const signatureContent = signaturePath ? fs.readFileSync(signaturePath, 'utf8') : '';
  return { combined: `${homeContent}\n${signatureContent}`, signaturePath, signatureContent };
}

function hasMinimumHeight(content, minimum) {
  if (!Number.isFinite(minimum)) return false;
  const direct = new RegExp(`(?:minH|minHeight|height)\\s*=\\s*\\{?${minimum}\\}?`);
  return direct.test(content)
    || /signatureHeight|FIRST_VIEWPORT_MIN_HEIGHT|firstViewportMinHeight/.test(content)
    || new RegExp(`Math\\.max\\([\\s\\S]{0,160}${minimum}`).test(content);
}

function hasViewportShare(content, share) {
  if (!Number.isFinite(share)) return false;
  const rounded = String(share).replace('.', '\\.');
  return /useWindowDimensions\s*\(/.test(content)
    && (new RegExp(`(?:height|viewportHeight)[\\s\\S]{0,120}\\*\\s*${rounded}`).test(content)
      || /FIRST_VIEWPORT_SHARE|firstViewportShare/.test(content));
}

function fontSizes(content) {
  const values = [];
  let match;
  const numeric = /fontSize\s*=\s*\{(\d+)\}/g;
  while ((match = numeric.exec(content))) values.push(Number(match[1]));
  const token = /fontSize\s*=\s*["'](\$\d+)["']/g;
  while ((match = token.exec(content))) values.push(TAMAGUI_FONT_SIZE_MIN[match[1]] || 0);
  return values;
}

function countMetricComponents(content) {
  const tags = content.match(/<(?:[A-Za-z0-9_]*(?:Stat|Metric|Kpi|KPI)[A-Za-z0-9_]*)\b/g) || [];
  return tags.length;
}

function extractTabNames(projectRoot) {
  const layoutCandidates = [
    path.join(projectRoot, 'app', '(app)', '_layout.tsx'),
    path.join(projectRoot, 'app', '(app)', '(tabs)', '_layout.tsx'),
  ];
  const names = new Set();
  for (const file of layoutCandidates) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    let match;
    const screenName = /(?:Tabs|NativeTabs)\.Screen[\s\S]{0,240}?name=["']([^"']+)["']/g;
    while ((match = screenName.exec(content))) names.add(match[1].split('/').pop().toLowerCase());
    const triggerName = /(?:Tabs|NativeTabs)\.Trigger[\s\S]{0,160}?name=["']([^"']+)["']/g;
    while ((match = triggerName.exec(content))) names.add(match[1].split('/').pop().toLowerCase());
  }
  return names;
}

function extractButtonLabels(content) {
  const labels = [];
  let match;
  const button = /<Button\b[\s\S]{0,500}?>([\s\S]{0,220}?)<\/Button>/g;
  while ((match = button.exec(content))) {
    const plain = match[1].replace(/<[^>]+>/g, ' ').replace(/\{[^}]+\}/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (plain) labels.push(plain);
  }
  return labels;
}

function sourceSignature(content) {
  const count = (pattern) => (content.match(pattern) || []).length;
  const primitives = new Set([
    'YStack', 'XStack', 'ZStack', 'Stack', 'View', 'SafeAreaView', 'ScrollView',
    'FlatList', 'SectionList', 'Text', 'Paragraph', 'SizableText', 'Button',
    'Card', 'Image', 'Ionicons', 'StatusBar', 'Fragment',
  ]);
  const customComponents = [];
  let component;
  const tag = /<([A-Z][A-Za-z0-9_]*)\b/g;
  while ((component = tag.exec(content))) {
    if (!primitives.has(component[1]) && !customComponents.includes(component[1])) customComponents.push(component[1]);
  }
  return JSON.stringify({
    flatList: /<FlatList\b/.test(content),
    sectionList: /<SectionList\b/.test(content),
    scrollView: /<ScrollView\b/.test(content),
    image: /<Image\b/.test(content),
    scanner: /BarcodeScanner|CameraView/.test(content),
    calendar: /Calendar|Agenda/.test(content),
    timeline: /Timeline|timeline/i.test(content),
    cards: Math.min(5, count(/<Card\b/g)),
    filters: Math.min(5, count(/FilterChip|Segmented|Chip/g)),
    bottomAction: /BottomActionBar|position=["']absolute["'][^>]*(?:bottom|b)=/.test(content),
    customComponents: customComponents.slice(0, 4),
  });
}

function validateHome(projectRoot, markdown, homePath, homeContent, issues) {
  const { fields, viewport } = parseContract(markdown);
  const signatureName = String(viewport.get('signature component') || '').replace(/[`*]/g, '').trim();
  const minimum = numberFrom(viewport.get('minimum height'));
  const share = numberFrom(viewport.get('viewport share'));
  const headlineMinimum = numberFrom(viewport.get('headline minimum'));
  const metricsMaximum = numberFrom(viewport.get('supporting metrics maximum'));
  const media = normalize(viewport.get('media'));
  const composition = normalize(fields.get('home composition'));
  const duplicatePolicy = normalize(viewport.get('duplicate action with tab'));
  const relativeHome = path.relative(projectRoot, homePath);
  const { combined, signaturePath } = combinedHomeSource(projectRoot, homeContent, signatureName);

  const requiredTestIds = ['experience-signature', 'experience-headline', 'experience-primary-action'];
  if (media === 'required' || media === 'optional') requiredTestIds.push('experience-media');
  if (normalize(viewport.get('next section visible')) === 'yes') requiredTestIds.push('experience-next-section');
  for (const testId of requiredTestIds) {
    const count = (combined.match(new RegExp(`testID=["']${testId}["']`, 'g')) || []).length;
    if (count !== 1) addIssue(issues, relativeHome, 'runtime-measurement-id', `Render testID="${testId}" exactly once for native visual QA.`, String(count));
  }

  if (!signatureName || !new RegExp(`<${signatureName}\\b|from\\s+["'][^"']*${signatureName}["']`).test(homeContent)) {
    addIssue(issues, relativeHome, 'missing-signature-component', `Render the approved signature component ${signatureName || '<missing>'} on Home.`, signatureName);
  }
  if (signatureName && !signaturePath) {
    addIssue(issues, relativeHome, 'missing-shared-signature-file', `Generate src/components/${signatureName}.tsx before screen builders run.`, signatureName);
  }
  if (!hasMinimumHeight(combined, minimum)) {
    addIssue(issues, relativeHome, 'signature-min-height-not-materialized', `Materialize the First Viewport minimum height (${minimum}dp) in Home or ${signatureName}.`, String(minimum));
  }
  if (!hasViewportShare(combined, share)) {
    addIssue(issues, relativeHome, 'viewport-share-not-materialized', `Use useWindowDimensions and the approved viewport share (${share}) with the minimum height.`, String(share));
  }
  const sizes = fontSizes(combined);
  if (Number.isFinite(headlineMinimum) && !sizes.some((size) => size >= headlineMinimum)) {
    addIssue(issues, relativeHome, 'headline-minimum-not-materialized', `Use an explicit/resolvable headline size of at least ${headlineMinimum}sp in the signature region.`, String(headlineMinimum));
  }
  const metricCount = countMetricComponents(combined);
  const metricIdCount = (combined.match(/testID=["']experience-metric-[1-4]["']/g) || []).length;
  if (metricIdCount > metricsMaximum) {
    addIssue(issues, relativeHome, 'too-many-metric-measurement-ids', `Use at most ${metricsMaximum} experience-metric-* testIDs.`, String(metricIdCount));
  }
  if (Number.isFinite(metricsMaximum) && metricCount > metricsMaximum) {
    addIssue(issues, relativeHome, 'too-many-supporting-metrics', `Reduce first-viewport Stat/Metric/KPI components to the approved maximum (${metricsMaximum}).`, String(metricCount));
  }
  if (composition !== 'operational-dashboard' && metricCount >= 3) {
    addIssue(issues, relativeHome, 'dashboard-drift', `${composition} must not collapse into an equal-weight KPI dashboard.`, String(metricCount));
  }
  if (media === 'required') {
    if (!/from\s+["']expo-image["']|require\([^)]*assets\//.test(combined) || !/<Image\b/.test(combined)) {
      addIssue(issues, relativeHome, 'required-media-not-rendered', 'Render required media with expo-image or an approved local asset.', fields.get('media source'));
    }
    if (!/onError|mediaError|imageError|fallback|placeholder/i.test(combined)) {
      addIssue(issues, relativeHome, 'missing-media-fallback', 'Implement loading/error/empty media fallback while preserving signature geometry.', fields.get('media fallback'));
    }
  }
  if (normalize(viewport.get('next section visible')) === 'yes') {
    const signatureUse = homeContent.search(new RegExp(`<${signatureName}\\b`));
    if (signatureUse >= 0 && !/<(?:SectionHeader|YStack|XStack|Text)\b/.test(homeContent.slice(signatureUse + signatureName.length + 1))) {
      addIssue(issues, relativeHome, 'next-section-not-materialized', 'Render the next section after the signature component so it can remain visible at the fold.');
    }
  }
  if (duplicatePolicy === 'forbidden') {
    const tabNames = extractTabNames(projectRoot);
    for (const label of extractButtonLabels(homeContent)) {
      const duplicate = [...tabNames].find((tab) => label === tab || label.startsWith(`${tab} `));
      if (duplicate) addIssue(issues, relativeHome, 'duplicate-tab-action', `Remove Home button "${label}" because the ${duplicate} tab owns that action.`, label);
    }
  }
}

function validateTabSilhouettes(projectRoot, markdown, overrides, issues) {
  const rows = parseScreenMap(markdown).filter((row) => /^\/\(app\)\/[^/]+$/.test(row.route) && !/template \(keep\)/i.test(row.source));
  const signatures = new Map();
  for (const row of rows) {
    const filePath = path.resolve(projectRoot, row.file);
    const content = overrides.get(filePath) || (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '');
    if (!content) continue;
    const signature = sourceSignature(content);
    const existing = signatures.get(signature) || [];
    existing.push({ row, filePath });
    signatures.set(signature, existing);
  }
  for (const group of signatures.values()) {
    if (group.length < 2) continue;
    const names = group.map(({ row }) => row.screen).join(', ');
    for (const { filePath } of group) {
      addIssue(issues, path.relative(projectRoot, filePath), 'repeated-tab-silhouette', `Differentiate neighboring tab roots (${names}) by dominant component, scroll axis, grouping, primary control, or media usage.`, names);
    }
  }
}

function validateProject(projectRoot, targets, overrides = new Map()) {
  const issues = [];
  const planPath = path.join(projectRoot, 'native-app-plan.md');
  if (!fs.existsSync(planPath)) return issues;
  const markdown = fs.readFileSync(planPath, 'utf8');
  const experience = getSection(markdown, 'Product Experience');
  if (!experience) return issues;
  const screenRows = parseScreenMap(markdown);
  const homeRow = screenRows.find((row) => row.route === '/(app)/home' || /(?:^|\/)home\.tsx$/.test(row.file));
  const homePath = homeRow ? path.resolve(projectRoot, homeRow.file) : path.join(projectRoot, 'app', '(app)', 'home.tsx');
  const targetSet = new Set(targets.map((target) => path.resolve(projectRoot, target)));
  const shouldCheckHome = targets.length === 0 || targetSet.has(homePath) || [...targetSet].some((target) => /\/src\/components\//.test(target));
  const homeContent = overrides.get(homePath) || (fs.existsSync(homePath) ? fs.readFileSync(homePath, 'utf8') : '');
  if (shouldCheckHome && homeContent) validateHome(projectRoot, markdown, homePath, homeContent, issues);
  validateTabSilhouettes(projectRoot, markdown, overrides, issues);
  return issues;
}

function buildBlockMessage(issues) {
  const lines = [`[mobile-app] BLOCKED: ${issues.length} Product Experience composition issue(s).`];
  for (const issue of issues.slice(0, 12)) lines.push(`- ${issue.file} [${issue.rule}] ${issue.fix}`);
  if (issues.length > 12) lines.push(`- ... and ${issues.length - 12} more`);
  return `${lines.join('\n')}\n`;
}

function reportMode(args) {
  const projectRoot = path.resolve(args.projectRoot || process.cwd());
  const files = collectFiles(args.targets, projectRoot);
  const issues = validateProject(projectRoot, files);
  process.stdout.write(`${JSON.stringify({ validator: 'validate-screen-composition', issues }, null, 2)}\n`);
  return 0;
}

function hookMode() {
  let inputData = '';
  process.stdin.on('data', (chunk) => { inputData += chunk; });
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(inputData || '{}'); } catch { process.exit(0); }
    const toolName = input.tool_name || input.toolName;
    if (!['Write', 'Edit', 'MultiEdit'].includes(toolName)) process.exit(0);
    const toolInput = input.tool_input || input.toolInput || {};
    const filePath = toolInput.file_path || toolInput.filePath;
    if (!isWatchedFile(filePath)) process.exit(0);
    let content = toolInput.content || toolInput.new_string || '';
    if (!content && fs.existsSync(filePath)) content = fs.readFileSync(filePath, 'utf8');
    const projectRoot = path.resolve(input.cwd || process.cwd());
    const overrides = new Map([[path.resolve(filePath), content]]);
    const issues = validateProject(projectRoot, [filePath], overrides);
    if (!issues.length) process.exit(0);
    process.stderr.write(buildBlockMessage(issues));
    process.exit(2);
  });
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.report) process.exitCode = reportMode(args);
  else hookMode();
}

module.exports = {
  parseContract,
  parseScreenMap,
  sourceSignature,
  validateProject,
};
