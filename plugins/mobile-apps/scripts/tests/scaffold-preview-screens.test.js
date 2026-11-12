'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  LAYOUT_MARKER,
  PLACEHOLDER_MARKER,
  expoRoute,
  scaffoldPreviewScreens,
} = require('../scaffold-preview-screens');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'scaffold-preview-screens.js');
const TEMPLATE_APP = path.join(PLUGIN_ROOT, 'template', 'app');

function freshApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-preview-'));
  fs.cpSync(TEMPLATE_APP, path.join(root, 'app'), { recursive: true });
  return root;
}

const read = (root, relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const INSPECTIONS = {
  navigation: 'Tabs + Stack',
  list: [
    { name: 'Login', file: 'app/login.tsx', presentation: 'default', source: 'template (keep)' },
    { name: 'Today', file: 'app/(app)/home.tsx', presentation: 'default', source: 'replace template' },
    { name: 'Inspections', file: 'app/(app)/inspections/index.tsx', presentation: 'default', source: 'new' },
    { name: 'Inspection detail', file: 'app/(app)/inspections/[id]/index.tsx', presentation: 'default', source: 'new' },
    { name: 'Capture photo', file: 'app/(app)/inspections/[id]/photo.tsx', presentation: 'modal', source: 'new' },
    { name: 'New inspection', file: 'app/(app)/inspections/new.tsx', presentation: 'formSheet', source: 'new' },
    { name: 'Profile', file: 'app/(app)/profile.tsx', presentation: 'default', source: 'new' },
  ],
};

test('the screen graph becomes a navigation shell with a placeholder per planned screen', () => {
  const root = freshApp();
  const templateLogin = read(root, 'app/login.tsx');
  const result = scaffoldPreviewScreens({ workingDir: root, graph: INSPECTIONS });

  assert.equal(result.status, 'ok');
  assert.equal(result.navigation, 'Tabs');
  assert.deepEqual(result.entry, { name: 'Today', file: 'app/(app)/home.tsx' });

  // One tab per top-level file or folder, in Screen Map order; children stay inside their stack.
  const outer = read(root, 'app/(app)/_layout.tsx');
  assert.ok(outer.startsWith(LAYOUT_MARKER));
  assert.deepEqual([...outer.matchAll(/<Tabs\.Screen\s+name="([^"]+)"/g)].map((m) => m[1]), ['home', 'inspections', 'profile']);
  assert.match(outer, /title: "Inspections"/, 'a folder tab takes its index screen\'s name');
  // The template's auth guard survives, and the theme hook runs before its early return.
  assert.match(outer, /const theme = useThemeTokens\(\);\n\n  if \(!isLoading && !isSignedIn\)/);
  assert.match(outer, /<Redirect href="\/login" \/>/);

  // Inner stacks register every child with its presentation, and nested folders as screens.
  const inspections = read(root, 'app/(app)/inspections/_layout.tsx');
  assert.match(inspections, /<Stack\.Screen name="index" \/>/);
  assert.match(inspections, /<Stack\.Screen name="new" options=\{\{ presentation: 'formSheet' \}\} \/>/);
  assert.match(inspections, /<Stack\.Screen name="\[id\]" \/>/);
  assert.match(read(root, 'app/(app)/inspections/[id]/_layout.tsx'), /<Stack\.Screen name="photo" options=\{\{ presentation: 'modal' \}\} \/>/);

  // Every planned screen but the kept template route is a placeholder a builder will replace.
  for (const file of result.placeholders) assert.ok(read(root, file).startsWith(PLACEHOLDER_MARKER), file);
  assert.equal(result.placeholders.length, 6);
  assert.equal(read(root, 'app/login.tsx'), templateLogin, 'template (keep) routes are left alone');
  assert.match(read(root, 'app/(app)/home.tsx'), /export default function TodayPlaceholder\(\)/);
  assert.deepEqual(new Set(result.writtenFiles), new Set([...result.layouts, ...result.placeholders]));
});

test('a rerun after the graph changes rewrites its own files and never a built screen', () => {
  const root = freshApp();
  scaffoldPreviewScreens({ workingDir: root, graph: INSPECTIONS });
  // A builder has finished Today.
  const built = "export default function Today() { return null; }\n";
  fs.writeFileSync(path.join(root, 'app/(app)/home.tsx'), built);

  const renamed = structuredClone(INSPECTIONS);
  renamed.list.find((s) => s.name === 'Profile').name = 'Account';
  const again = scaffoldPreviewScreens({ workingDir: root, graph: renamed });

  assert.equal(read(root, 'app/(app)/home.tsx'), built);
  assert.ok(again.kept.includes('app/(app)/home.tsx'));
  assert.match(read(root, 'app/(app)/_layout.tsx'), /title: "Account"/, 'tabs regenerate from the template');
  assert.equal((read(root, 'app/(app)/_layout.tsx').match(/useThemeTokens\(\);/g) || []).length, 1);
  assert.match(read(root, 'app/(app)/profile.tsx'), /AccountPlaceholder/);

  // Nothing changed this time, so nothing is reported as written.
  assert.deepEqual(scaffoldPreviewScreens({ workingDir: root, graph: renamed }).writtenFiles, []);
});

test('a Stack app keeps the template layout and still gets placeholders', () => {
  const root = freshApp();
  const outer = read(root, 'app/(app)/_layout.tsx');
  const result = scaffoldPreviewScreens({
    workingDir: root,
    graph: { navigation: 'Stack', list: [{ name: 'Home', file: 'app/(app)/home.tsx' }, { name: 'Notes', file: 'app/(app)/notes.tsx' }] },
  });
  assert.equal(read(root, 'app/(app)/_layout.tsx'), outer);
  assert.deepEqual(result.placeholders, ['app/(app)/home.tsx', 'app/(app)/notes.tsx']);
});

test('graphs Expo Router cannot serve are refused before anything is written', () => {
  const cases = [
    [{ navigation: 'Tabs', list: [{ name: 'Notes', file: 'app/(app)/notes.tsx' }] }, /must assign app\/\(app\)\/home\.tsx/],
    [{ navigation: 'Tabs', list: [{ name: 'Home', file: 'app/(app)/home.tsx' }, { name: 'Detail', file: 'app/(app)/jobs/[id].tsx' }] },
      /folder app\/\(app\)\/jobs\/ has children .* but no index\.tsx/],
    [{ navigation: 'Tabs', list: [{ name: 'Home', file: 'app/(app)/home.tsx' }, { name: 'Jobs', file: 'app/(app)/jobs/index.tsx' },
      { name: 'Detail', file: 'app/(app)/jobs/[id].tsx' }, { name: 'Photo', file: 'app/(app)/jobs/[id]/photo.tsx' }] },
      /both a screen and a folder/],
    [{ navigation: 'Tabs', list: [{ name: 'Home', file: 'app/(app)/home.tsx' }, { name: 'Home again', file: 'app/(app)/home/index.tsx' }] },
      /duplicate Expo route \/\(app\)\/home/],
    [{ navigation: 'Tabs', list: [{ name: 'Home', file: 'app/(app)/../../evil.tsx' }] }, /relative app\/\.\.\.tsx path/],
    [{ navigation: 'Carousel', list: [{ name: 'Home', file: 'app/(app)/home.tsx' }] }, /unknown navigation pattern/],
  ];
  for (const [graph, reason] of cases) {
    const root = freshApp();
    const before = read(root, 'app/(app)/_layout.tsx');
    assert.throws(() => scaffoldPreviewScreens({ workingDir: root, graph }), reason);
    assert.equal(read(root, 'app/(app)/_layout.tsx'), before);
    assert.equal(fs.existsSync(path.join(root, 'app/(app)/notes.tsx')), false);
  }
});

test('the CLI reports a blocked graph as JSON and exit 1', () => {
  const root = freshApp();
  const screensFile = path.join(root, 'screens.json');
  fs.writeFileSync(screensFile, JSON.stringify({ navigation: 'Tabs', list: [{ name: 'Notes', file: 'app/(app)/notes.tsx' }] }));
  const run = spawnSync(process.execPath, [SCRIPT, '--working-dir', root, '--screens-file', screensFile], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(JSON.parse(run.stdout).status, 'blocked');

  fs.writeFileSync(screensFile, JSON.stringify(INSPECTIONS));
  const ok = spawnSync(process.execPath, [SCRIPT, '--working-dir', root, '--screens-file', screensFile], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).entry.file, 'app/(app)/home.tsx');
});

test('routes normalize the way Expo Router reads file names', () => {
  assert.equal(expoRoute('app/(app)/home.tsx'), '/(app)/home');
  assert.equal(expoRoute('app/(app)/inspections/index.tsx'), '/(app)/inspections');
  assert.equal(expoRoute('app/(app)/inspections/[id]/index.tsx'), '/(app)/inspections/[id]');
  assert.equal(expoRoute('app/index.tsx'), '/');
});
