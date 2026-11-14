#!/usr/bin/env node

/**
 * scaffold-preview-screens.js - write the navigation shell and a placeholder for every planned screen,
 * straight from the approved screen graph.
 *
 * `/create-mobile-app` runs this right after the screen graph gate. Layouts and placeholders are
 * mechanical: they follow from each screen's file path and presentation, so writing them by hand
 * cost the agent several model turns before any screen could be built. With the shell in place,
 * Metro can bundle every route at once, screen-builders replace placeholders in parallel without
 * racing on shared `_layout.tsx` files, and the live preview shows the app's navigation while the
 * screens are still being built.
 *
 * Usage:
 *   node scaffold-preview-screens.js --working-dir <app root> --screens-file <screens.json>
 *
 * `screens.json` is the build plan's `screens` section with two extra fields per screen:
 *   {
 *     "navigation": "Tabs + Stack",            // Stack | Tabs | Tabs + Stack | Drawer
 *     "list": [
 *       { "name": "Today", "route": "/(app)/home", "file": "app/(app)/home.tsx",
 *         "presentation": "default", "source": "replace template" },
 *       { "name": "Inspection detail", "route": "/(app)/inspections/[id]",
 *         "file": "app/(app)/inspections/[id].tsx", "presentation": "default", "source": "new" }
 *     ]
 *   }
 * `presentation` is `default`, `modal`, or `formSheet`. A `source` that starts with `template` and
 * says `keep` (the Screen Map's `template (keep)`) marks a route the template owns, such as login.
 *
 * Prints one line of JSON and exits 0 (`status: "ok"`), 1 (`status: "blocked"`, with `reason`), or
 * 2 (bad arguments). `writtenFiles` lists every file this run created or changed, for the skill's
 * changed-file gate.
 *
 * Ownership: a file is rewritten only when it is missing, still identical to the plugin template,
 * or carries this script's marker, so a rerun after a screen graph change never overwrites a screen
 * a builder already wrote.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_ROOT = path.join(PLUGIN_ROOT, 'template');

const LAYOUT_MARKER = '// Navigation shell written by scaffold-preview-screens.js from the approved screen graph.';
const PLACEHOLDER_MARKER = '// PREVIEW PLACEHOLDER - written by scaffold-preview-screens.js; screen-builder replaces this whole file.';

const APP_GROUP = 'app/(app)';
const OUTER_LAYOUT = `${APP_GROUP}/_layout.tsx`;

// expo-router's root index (`app/index.tsx`) sends a signed-in user to this route, so it is the
// screen the preview opens on and the one built first.
const ENTRY_FILE = `${APP_GROUP}/home.tsx`;

// The template's protected layout ends with this plain stack. Tabs and Drawer replace exactly this
// statement, keeping the auth guard above it as the template wrote it.
const TEMPLATE_RETURN = /return \(\s*<Stack\s+screenOptions=\{\{\s*headerShown: false,?\s*\}\}\s*\/>\s*\);/;

const NAVIGATION = new Map([
  ['stack', 'Stack'],
  ['tabs', 'Tabs'],
  ['tabs + stack', 'Tabs'],
  ['tabs+stack', 'Tabs'],
  ['drawer', 'Drawer'],
]);
const PRESENTATIONS = new Set(['default', 'modal', 'formSheet']);

// First match wins; the name and file are both searched, so `Inspections` and `inspections/` agree.
const ICONS = [
  [/home|dashboard|overview|today/, 'home-outline'],
  [/inspect|audit|checklist|task|job|work/, 'clipboard-outline'],
  [/profile|account|\bme\b|user/, 'person-outline'],
  [/setting|config|preference/, 'settings-outline'],
  [/report|analytic|chart|stat/, 'bar-chart-outline'],
  [/map|location|site|field/, 'map-outline'],
  [/message|chat|inbox|notif/, 'chatbubble-outline'],
];

class Blocked extends Error {}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

/** `app/(app)/inspections/[id]/index.tsx` -> `/(app)/inspections/[id]`, as expo-router sees it. */
function expoRoute(file) {
  return `/${file.slice('app/'.length).replace(/\.tsx$/, '').replace(/(^|\/)index$/, '')}`.replace(/\/$/, '') || '/';
}

function pascalCase(name) {
  const words = String(name).normalize('NFKD').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const joined = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return /^[A-Za-z]/.test(joined) ? joined : `Screen${joined}`;
}

function iconFor(name, file) {
  const haystack = `${name} ${file}`.toLowerCase();
  const match = ICONS.find(([pattern]) => pattern.test(haystack));
  return match ? match[1] : 'apps-outline';
}

function isTemplateKept(screen) {
  return /template/i.test(String(screen.source || '')) && /keep/i.test(String(screen.source || ''));
}

function normalizeGraph(graph) {
  if (!graph || typeof graph !== 'object') throw new Blocked('screens file must hold a JSON object');
  const navigation = NAVIGATION.get(String(graph.navigation || '').trim().toLowerCase());
  if (!navigation) throw new Blocked(`unknown navigation pattern '${graph.navigation}'; use Stack, Tabs, Tabs + Stack, or Drawer`);
  if (!Array.isArray(graph.list) || graph.list.length === 0) throw new Blocked('screens file has no screens in `list`');

  const screens = graph.list.map((screen, index) => {
    const file = toPosix(String(screen && screen.file || '').trim());
    const name = String(screen && screen.name || '').trim();
    if (!name) throw new Blocked(`screen ${index + 1} has no name`);
    if (!/^app\/.+\.tsx$/.test(file) || file.split('/').some((part) => part === '..' || part === '.' || part === '')) {
      throw new Blocked(`screen '${name}' has file '${file}'; every screen needs a relative app/...tsx path`);
    }
    const presentation = String(screen.presentation || 'default').trim();
    if (!PRESENTATIONS.has(presentation)) throw new Blocked(`screen '${name}' has presentation '${presentation}'; use default, modal, or formSheet`);
    return { name, file, presentation, kept: isTemplateKept(screen) };
  });

  const routes = new Map();
  for (const screen of screens) {
    const route = expoRoute(screen.file);
    if (routes.has(route)) {
      throw new Blocked(`duplicate Expo route ${route} from ${routes.get(route)} and ${screen.file}. Use [id]/index.tsx when a dynamic detail route owns child screens.`);
    }
    routes.set(route, screen.file);
  }
  const files = new Set(screens.map((s) => s.file));
  for (const file of files) {
    const asFolder = file.replace(/\.tsx$/, '/');
    const clash = [...files].find((other) => other.startsWith(asFolder));
    if (clash) throw new Blocked(`${file} and ${clash} make ${asFolder.slice(0, -1)} both a screen and a folder. Move the screen to ${asFolder}index.tsx.`);
  }
  return { navigation, screens };
}

/** The app group's folders, each with its direct screens and subfolders, in Screen Map order. */
function folderTree(screens) {
  const folders = new Map();
  const ensure = (dir) => {
    if (!folders.has(dir)) folders.set(dir, { dir, screens: [], subfolders: [] });
    return folders.get(dir);
  };
  for (const screen of screens) {
    if (!screen.file.startsWith(`${APP_GROUP}/`)) continue;
    const parts = screen.file.slice(APP_GROUP.length + 1).split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      const dir = parts.slice(0, depth).join('/');
      const parent = parts.slice(0, depth - 1).join('/');
      const node = ensure(dir);
      if (depth > 1 && !ensure(parent).subfolders.includes(node.dir)) ensure(parent).subfolders.push(node.dir);
    }
    if (parts.length > 1) ensure(parts.slice(0, -1).join('/')).screens.push(screen);
  }
  for (const folder of folders.values()) {
    if (!folder.screens.some((s) => s.file.endsWith('/index.tsx'))) {
      const children = [...folder.screens.map((s) => s.file), ...folder.subfolders.map((d) => `${APP_GROUP}/${d}/`)];
      throw new Blocked(`folder ${APP_GROUP}/${folder.dir}/ has children (${children.join(', ')}) but no index.tsx. Every folder needs an index screen, or its tab cannot open it.`);
    }
  }
  return folders;
}

function innerLayout(folder) {
  const name = `${pascalCase(folder.dir.split('/').pop().replace(/[[\]]/g, ''))}Layout`;
  const entries = ['      <Stack.Screen name="index" />'];
  for (const screen of folder.screens) {
    if (screen.file.endsWith('/index.tsx')) continue;
    const route = path.posix.basename(screen.file, '.tsx');
    const options = screen.presentation === 'default' ? '' : ` options={{ presentation: '${screen.presentation}' }}`;
    entries.push(`      <Stack.Screen name=${JSON.stringify(route)}${options} />`);
  }
  for (const sub of folder.subfolders) entries.push(`      <Stack.Screen name=${JSON.stringify(path.posix.basename(sub))} />`);
  return `${LAYOUT_MARKER}
import { Stack } from 'expo-router';

export default function ${name}() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
${entries.join('\n')}
    </Stack>
  );
}
`;
}

/** One tab or drawer item per top-level file or folder under app/(app)/, in Screen Map order. */
function outerEntries(screens) {
  const entries = [];
  const seen = new Set();
  for (const screen of screens) {
    if (!screen.file.startsWith(`${APP_GROUP}/`)) continue;
    const parts = screen.file.slice(APP_GROUP.length + 1).split('/');
    const entry = parts.length === 1 ? parts[0].replace(/\.tsx$/, '') : parts[0];
    if (entry === '_layout' || seen.has(entry)) continue;
    seen.add(entry);
    // A folder tab takes its title from the folder's index screen, not whichever child came first.
    const titled = parts.length === 1
      ? screen
      : screens.find((s) => s.file === `${APP_GROUP}/${entry}/index.tsx`) || screen;
    entries.push({ entry, title: titled.name, icon: iconFor(titled.name, entry) });
  }
  return entries;
}

function outerLayout(base, navigation, entries) {
  if (!TEMPLATE_RETURN.test(base)) return null;
  const isTabs = navigation === 'Tabs';
  const item = isTabs ? 'Tabs.Screen' : 'Drawer.Screen';
  const iconProp = isTabs ? 'tabBarIcon' : 'drawerIcon';
  const screens = entries.map(({ entry, title, icon }) => `      <${item}
        name=${JSON.stringify(entry)}
        options={{
          title: ${JSON.stringify(title)},
          ${iconProp}: ({ color }) => <Ionicons name=${JSON.stringify(icon)} size={22} color={color} />,
        }}
      />`).join('\n');
  const options = isTabs
    ? `        headerShown: false,
        tabBarActiveTintColor: theme.accentBase,
        tabBarInactiveTintColor: theme.text2,
        // Web preview only: react-native-web clips the 10px tab label to a 10px line box, cutting
        // off descenders, and a browser has no bottom inset to give the taller label room. Native
        // keeps react-navigation's inset-aware defaults.
        ...(Platform.OS === 'web' ? { tabBarLabelStyle: { lineHeight: 13 }, tabBarStyle: { height: 56 } } : null),`
    : `        // A drawer is reachable only from the header's menu button, so the header stays on.
        headerShown: true,
        drawerType: 'front',
        drawerActiveTintColor: theme.accentBase,
        drawerInactiveTintColor: theme.text2,
        drawerStyle: { width: 280 },`;
  const navigator = isTabs ? 'Tabs' : 'Drawer';
  let out = base.replace(TEMPLATE_RETURN, `return (
    <${navigator}
      screenOptions={{
${options}
      }}
    >
${screens}
    </${navigator}>
  );`);
  out = out.replace(/import \{ Redirect, Stack \} from 'expo-router';/, isTabs
    ? "import { Redirect, Tabs } from 'expo-router';"
    : "import { Redirect } from 'expo-router';\nimport { Drawer } from 'expo-router/drawer';");
  out = out.replace(/import \{ useAuth \} from '@microsoft\/power-apps-native-host';/,
    "import { Ionicons } from '@expo/vector-icons';\nimport { useAuth, useThemeTokens } from '@microsoft/power-apps-native-host';\nimport { Platform } from 'react-native';");
  // Hooks run before the early return of the auth guard, as the rules of hooks require.
  out = out.replace(/(const \{[^}]*\} = useAuth\(\);\n)/, '$1  const theme = useThemeTokens();\n');
  if (!isTabs) out = out.replace("import { Platform } from 'react-native';\n", '');
  if (!/useThemeTokens\(\)/.test(out) || !out.includes(`<${navigator}`)) return null;
  return `${LAYOUT_MARKER}\n${out}`;
}

function placeholder(screen) {
  return `${PLACEHOLDER_MARKER}
import { SafeAreaView } from 'react-native-safe-area-context';
import { Spinner, Text, YStack } from 'tamagui';

export default function ${pascalCase(screen.name)}Placeholder() {
  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1 }}>
      <YStack flex={1} items="center" justify="center" gap="$3" px="$6" bg="$surface0">
        <Spinner size="large" />
        <Text fontSize="$7" fontWeight="700" color="$text0" text="center">
          {${JSON.stringify(screen.name)}}
        </Text>
        <Text fontSize="$4" color="$text2" text="center">
          Building this screen. It replaces this message as soon as it is ready.
        </Text>
      </YStack>
    </SafeAreaView>
  );
}
`;
}

/** True when `relative` may be (re)written: absent, untouched template, or ours. */
function owned(root, relative, marker) {
  const current = readText(path.join(root, relative));
  if (current === null) return true;
  if (current.startsWith(marker)) return true;
  const template = readText(path.join(TEMPLATE_ROOT, relative));
  return template !== null && template === current;
}

function writeIfChanged(root, relative, content, written) {
  const target = path.join(root, relative);
  if (readText(target) === content) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  written.push(relative);
}

function scaffoldPreviewScreens({ workingDir, graph }) {
  const root = path.resolve(workingDir);
  if (!fs.existsSync(path.join(root, 'app'))) throw new Blocked(`${root} has no app/ folder; run this from a prepared template`);
  const { navigation, screens } = normalizeGraph(graph);

  if (!screens.some((s) => s.file === ENTRY_FILE)) {
    throw new Blocked(`the root index redirects to /(app)/home, so the screen graph must assign ${ENTRY_FILE}`);
  }
  if (navigation === 'Drawer' && !fs.existsSync(path.join(root, 'node_modules', '@react-navigation', 'drawer'))) {
    throw new Blocked('Drawer navigation needs @react-navigation/drawer, which this template does not install. Plan Tabs or Stack navigation instead.');
  }

  const folders = folderTree(screens);
  const written = [];
  const layouts = [];
  const kept = [];
  const warnings = [];

  for (const folder of folders.values()) {
    const relative = `${APP_GROUP}/${folder.dir}/_layout.tsx`;
    if (!owned(root, relative, LAYOUT_MARKER)) {
      kept.push(relative);
      continue;
    }
    writeIfChanged(root, relative, innerLayout(folder), written);
    layouts.push(relative);
  }

  if (navigation !== 'Stack') {
    const current = readText(path.join(root, OUTER_LAYOUT));
    // A rerun starts again from the template, so a changed screen graph replaces the old tabs.
    const base = current && current.startsWith(LAYOUT_MARKER) ? readText(path.join(TEMPLATE_ROOT, OUTER_LAYOUT)) : current;
    const generated = base ? outerLayout(base, navigation, outerEntries(screens)) : null;
    if (generated) {
      writeIfChanged(root, OUTER_LAYOUT, generated, written);
      layouts.push(OUTER_LAYOUT);
    } else {
      warnings.push(`${OUTER_LAYOUT} is not the template's protected stack, so its ${navigation} navigator was not written. Add it by hand.`);
    }
  }

  const placeholders = [];
  for (const screen of screens) {
    if (screen.kept) continue;
    if (!owned(root, screen.file, PLACEHOLDER_MARKER)) {
      kept.push(screen.file);
      continue;
    }
    writeIfChanged(root, screen.file, placeholder(screen), written);
    placeholders.push(screen.file);
  }

  const entry = screens.find((s) => s.file === ENTRY_FILE);
  return {
    status: 'ok',
    navigation,
    entry: { name: entry.name, file: entry.file },
    layouts,
    placeholders,
    kept,
    warnings,
    writtenFiles: written,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--working-dir' || flag === '--screens-file') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      options[flag === '--working-dir' ? 'workingDir' : 'screensFile'] = value;
      i += 1;
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  if (!options.workingDir || !options.screensFile) throw new Error('usage: scaffold-preview-screens.js --working-dir <app root> --screens-file <screens.json>');
  return options;
}

if (require.main === module) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  try {
    const graph = JSON.parse(fs.readFileSync(options.screensFile, 'utf8'));
    process.stdout.write(`${JSON.stringify(scaffoldPreviewScreens({ workingDir: options.workingDir, graph }))}\n`);
  } catch (error) {
    if (!(error instanceof Blocked) && !(error instanceof SyntaxError)) throw error;
    process.stdout.write(`${JSON.stringify({ status: 'blocked', reason: error.message })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  Blocked,
  ENTRY_FILE,
  LAYOUT_MARKER,
  PLACEHOLDER_MARKER,
  expoRoute,
  isTemplateKept,
  normalizeGraph,
  scaffoldPreviewScreens,
};
