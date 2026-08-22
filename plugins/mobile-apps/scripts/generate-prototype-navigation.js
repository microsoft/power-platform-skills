#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseTable } = require('./validate-screen-contracts');

const FURNITURE_LABELS = new Set([
  'account', 'dashboard', 'home', 'menu', 'more', 'overview', 'preferences', 'profile', 'settings',
]);
const VERB_LABELS = new Set([
  'add', 'browse', 'create', 'edit', 'explore', 'manage', 'open', 'review', 'see', 'track', 'view',
]);

function fail(message) {
  console.error(`prototype-navigation: ${message}`);
  process.exit(1);
}

function rowsAsObjects(table, requiredHeaders, heading) {
  for (const header of requiredHeaders) {
    if (!table.headers.includes(header)) fail(`${heading} is missing column ${header}`);
  }
  return table.rows.map((cells) => Object.fromEntries(
    table.headers.map((header, index) => [header, cells[index] || '']),
  ));
}

function navigationPattern(markdown) {
  const match = markdown.match(/^### Navigation Pattern\s*$[\s\S]*?\*\*(Tabs(?: \+ Stack)?|Stack|Drawer)\*\*/m);
  if (!match) fail('### Navigation Pattern must declare Tabs, Tabs + Stack, Stack, or Drawer');
  return match[1];
}

function pathInfo(file) {
  const prefix = 'app/(app)/';
  if (!file.startsWith(prefix) || !file.endsWith('.tsx')) return null;
  const relative = file.slice(prefix.length, -'.tsx'.length);
  const parts = relative.split('/');
  return {
    entry: parts[0],
    child: parts.length === 1 ? null : parts.slice(1).join('/'),
    isRoot: parts.length === 1 || parts.slice(1).join('/') === 'index',
  };
}

function tabLabel(row) {
  const label = String(row.Screen || '').trim();
  if (!label || !/^[A-Za-z][A-Za-z0-9 &'/-]{0,23}$/.test(label)) {
    fail(`tab label "${label}" must be a concise content noun`);
  }
  const firstWord = label.toLowerCase().split(/\s+/)[0];
  if (VERB_LABELS.has(firstWord)) {
    fail(`tab label "${label}" starts with a command; use a content noun`);
  }
  return label;
}

function iconFor(label) {
  const value = label.toLowerCase();
  if (/shop|store|catalog|product/.test(value)) return 'storefront-outline';
  if (/cart|basket/.test(value)) return 'bag-handle-outline';
  if (/order|receipt|purchase/.test(value)) return 'receipt-outline';
  if (/inventory|stock|asset|equipment/.test(value)) return 'cube-outline';
  if (/inspect|audit|checklist|task|work/.test(value)) return 'clipboard-outline';
  if (/site|location|map|field/.test(value)) return 'map-outline';
  if (/message|chat|inbox|notification/.test(value)) return 'chatbubble-outline';
  if (/profile|account|user/.test(value)) return 'person-outline';
  if (/setting|preference/.test(value)) return 'settings-outline';
  if (/report|analytic|stat/.test(value)) return 'bar-chart-outline';
  return 'grid-outline';
}

function ensureNamedImport(source, moduleName, addNames, removeNames = []) {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*['"]${escaped}['"];?`);
  const match = source.match(pattern);
  if (!match) fail(`expected a named import from ${moduleName} in app/(app)/_layout.tsx`);
  const names = match[1]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .filter((name) => !removeNames.includes(name));
  for (const name of addNames) if (!names.includes(name)) names.push(name);
  return source.replace(pattern, `import { ${names.join(', ')} } from '${moduleName}';`);
}

function ensureImport(source, statement) {
  if (source.includes(statement)) return source;
  const importMatches = [...source.matchAll(/^import .*;$/gm)];
  if (importMatches.length === 0) fail('app/(app)/_layout.tsx has no import block');
  const last = importMatches[importMatches.length - 1];
  const insertion = last.index + last[0].length;
  return `${source.slice(0, insertion)}\n${statement}${source.slice(insertion)}`;
}

function renderTabs(tabs, hiddenEntries) {
  const visible = tabs.map((tab) => `    <Tabs.Screen
      name=${JSON.stringify(tab.entry)}
      options={{
        title: ${JSON.stringify(tab.label)},
        tabBarIcon: ({ color }) => (
          <Ionicons name=${JSON.stringify(tab.icon)} size={tokens.size.iconSize} color={color} />
        ),
      }}
    />`).join('\n');
  const hidden = hiddenEntries
    .map((entry) => `    <Tabs.Screen name=${JSON.stringify(entry)} options={{ href: null }} />`)
    .join('\n');
  return `  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: tokens.color.primary,
        tabBarInactiveTintColor: tokens.color.textMuted,
      }}
    >
${visible}${hidden ? `\n${hidden}` : ''}
    </Tabs>
  );`;
}

function replaceReturn(source, replacement) {
  const functionStart = source.indexOf('export default function AppLayout()');
  if (functionStart < 0) fail('app/(app)/_layout.tsx must export AppLayout');
  const tail = source.slice(functionStart);
  const match = tail.match(/  return \(\n[\s\S]*?\n  \);/);
  if (!match) fail('could not locate the AppLayout return block');
  const start = functionStart + match.index;
  return `${source.slice(0, start)}${replacement}${source.slice(start + match[0].length)}`;
}

function renderInnerLayout(folder, rows) {
  const functionName = `${folder
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join('')}Layout`;
  const screens = rows
    .map((row) => ({ ...row, info: pathInfo(row.File) }))
    .sort((left, right) => Number(right.info.child === 'index') - Number(left.info.child === 'index'))
    .map(({ Presentation, info }) => {
      const name = info.child;
      const options = ['modal', 'formSheet'].includes(Presentation)
        ? ` options={{ presentation: ${JSON.stringify(Presentation)} }}`
        : '';
      return `      <Stack.Screen name=${JSON.stringify(name)}${options} />`;
    });
  return `import { Stack } from 'expo-router';\n\nexport default function ${functionName}() {\n  return (\n    <Stack screenOptions={{ headerShown: false }}>\n${screens.join('\n')}\n    </Stack>\n  );\n}\n`;
}

function buildNavigation(markdown) {
  const parseErrors = [];
  const screenRows = rowsAsObjects(
    parseTable(markdown, '### Screen Map', parseErrors),
    ['Screen', 'Route', 'File', 'Presentation', 'Archetype'],
    '### Screen Map',
  );
  const contractRows = rowsAsObjects(
    parseTable(markdown, '### Navigation Contracts', parseErrors),
    ['Route', 'Intent'],
    '### Navigation Contracts',
  );
  if (parseErrors.length > 0) fail(parseErrors.join('; '));
  const signedInRows = screenRows.filter((row) => pathInfo(row.File));
  const contracts = new Map(contractRows.map((row) => [row.Route, row]));
  const tabs = signedInRows
    .filter((row) => row.Archetype.toLowerCase() === 'tab-root')
    .map((row) => {
      const info = pathInfo(row.File);
      if (!info.isRoot) fail(`Tab-root ${row.Screen} must own a flat file or folder index`);
      const contract = contracts.get(row.Route);
      if (!contract) fail(`Tab-root ${row.Screen} has no Navigation Contracts row`);
      if (contract.Intent.toLowerCase() !== 'navigate') {
        fail(`Tab-root ${row.Screen} must use navigate intent, not ${contract.Intent}`);
      }
      const label = tabLabel(row);
      return { entry: info.entry, icon: iconFor(label), label, route: row.Route };
    });
  if (tabs.length === 0) fail('Tabs navigation requires at least one Tab-root screen');
  const duplicateEntries = tabs.filter((tab, index) => tabs.findIndex((candidate) => candidate.entry === tab.entry) !== index);
  if (duplicateEntries.length > 0) fail(`duplicate tab entry ${duplicateEntries[0].entry}`);
  const furniture = tabs.filter((tab) => FURNITURE_LABELS.has(tab.label.toLowerCase()));
  if (furniture.length > 1) {
    fail(`at most one furniture tab is allowed; found ${furniture.map((tab) => tab.label).join(', ')}`);
  }
  const allEntries = [...new Set(signedInRows.map((row) => pathInfo(row.File).entry))];
  const visibleEntries = new Set(tabs.map((tab) => tab.entry));
  const hiddenEntries = allEntries.filter((entry) => !visibleEntries.has(entry));
  const folders = new Map();
  for (const row of signedInRows) {
    const info = pathInfo(row.File);
    if (!info.child) continue;
    const rows = folders.get(info.entry) || [];
    rows.push(row);
    folders.set(info.entry, rows);
  }
  for (const tab of tabs) {
    const folderRows = folders.get(tab.entry);
    if (folderRows && !folderRows.some((row) => pathInfo(row.File).child === 'index')) {
      fail(`visible tab folder ${tab.entry} has no index.tsx Screen Map row`);
    }
  }
  return { tabs, hiddenEntries, folders };
}

function main() {
  const projectArg = process.argv[2];
  if (!projectArg) fail('usage: node generate-prototype-navigation.js <project-dir>');
  const projectDir = path.resolve(projectArg);
  const planPath = path.join(projectDir, 'native-app-plan.md');
  const layoutPath = path.join(projectDir, 'app', '(app)', '_layout.tsx');
  const tokensPath = path.join(projectDir, 'brand', 'tokens.ts');
  for (const requiredPath of [planPath, layoutPath, tokensPath]) {
    if (!fs.existsSync(requiredPath)) fail(`required file is missing: ${requiredPath}`);
  }
  const markdown = fs.readFileSync(planPath, 'utf8');
  const pattern = navigationPattern(markdown);
  if (pattern === 'Stack') {
    console.log('prototype-navigation: Stack pattern requires no tab generation');
    return;
  }
  if (!pattern.startsWith('Tabs')) fail(`prototype navigation generator does not handle ${pattern}`);
  const navigation = buildNavigation(markdown);
  let layout = fs.readFileSync(layoutPath, 'utf8').replace(/\r\n?/g, '\n');
  layout = ensureNamedImport(layout, 'expo-router', ['Tabs'], ['Stack']);
  layout = ensureImport(layout, "import { Ionicons } from '@expo/vector-icons';");
  layout = ensureImport(layout, "import { tokens } from '../../brand/tokens';");
  layout = replaceReturn(layout, renderTabs(navigation.tabs, navigation.hiddenEntries));
  fs.writeFileSync(layoutPath, layout);
  for (const [folder, rows] of navigation.folders) {
    const folderDir = path.join(projectDir, 'app', '(app)', folder);
    fs.mkdirSync(folderDir, { recursive: true });
    fs.writeFileSync(path.join(folderDir, '_layout.tsx'), renderInnerLayout(folder, rows));
  }
  console.log(`prototype-navigation: generated ${navigation.tabs.length} tab(s), ${navigation.hiddenEntries.length} hidden entr${navigation.hiddenEntries.length === 1 ? 'y' : 'ies'}`);
}

if (require.main === module) main();

module.exports = {
  buildNavigation,
  iconFor,
  navigationPattern,
  pathInfo,
  renderTabs,
  tabLabel,
};