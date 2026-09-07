'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { compileRegistry, sourceTargets } = require('../lib/prototype-authoring');

const modules = process.env.MOBILE_PROTOTYPE_TEMPLATE_MODULES;
const ts = modules ? require(path.join(modules, 'typescript')) : null;
const options = { skip: !ts && 'Set MOBILE_PROTOTYPE_TEMPLATE_MODULES to the installed selected template' };

function write(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function project(context, screens = [{ screenId: 'home', route: '/home' }]) {
  const root = path.resolve(__dirname, '../../../..', `.prototype-authoring-work-${crypto.randomUUID()}`);
  fs.mkdirSync(root);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'app.json', { expo: { extra: { telemetry: { appInstanceId: crypto.randomUUID() } } } });
  write(root, '.tmp/compiled-screen-build-pack.json', { contractType: 'compiled-screen-build-pack', screens });
  write(root, 'app/(app)/home.tsx', 'export const authoringTargets = [] as const;\nexport default function Home() { return null; }\n');
  return root;
}

test('an existing matching route never grants a guessed source assignment', options, (context) => {
  const root = project(context);
  assert.throws(() => compileRegistry(root, ts, []), /explicit screen sources.*never inferred/);
  assert.equal(fs.existsSync(path.join(root, '.tmp/authoring-registry.json')), false);
  const registry = compileRegistry(root, ts, [], [{ screenId: 'home', sourceFile: 'app/(app)/home.tsx' }]);
  assert.equal(registry.screens[0].sourceFile, 'app/(app)/home.tsx');
  assert.deepEqual(registry.screens[0].targets, []);
});

test('explicit assignments compile only literal metadata and preserve stable sorted IDs', options, (context) => {
  const root = project(context, [
    { screenId: 'home', route: '/home' },
    { screenId: 'details', route: '/items/[id]' },
  ]);
  write(root, 'app/(app)/home.tsx', `export const authoringTargets = [
  { id: 'save', label: 'Save item', role: 'action', actionId: 'saveItem' },
  { id: 'items', label: 'Items', role: 'collection' },
] as const;
export default function Home() { return null; }
`);
  write(root, 'app/(app)/items/[id].tsx', 'export const authoringTargets = [] as const;\nexport default function Detail() { return null; }\n');
  const sources = [
    { screenId: 'home', sourceFile: 'app/(app)/home.tsx' },
    { screenId: 'details', sourceFile: 'app/(app)/items/[id].tsx' },
  ];
  const registry = compileRegistry(root, ts, ['home'], sources);
  assert.deepEqual(registry.screens.map((screen) => screen.screenId), ['details', 'home']);
  assert.deepEqual(registry.screens[1].targets.map((target) => target.id), ['items', 'save']);
  assert.deepEqual(compileRegistry(root, ts, ['home'], [...sources].reverse()), registry);
  write(root, '.tmp/authoring-registry.json', registry);
  assert.deepEqual(compileRegistry(root, ts, ['home']), registry);
  const compiled = JSON.parse(fs.readFileSync(path.join(root, '.tmp/compiled-screen-build-pack.json'), 'utf8'));
  compiled.screens.push({ screenId: 'newScreen', route: '/new' });
  write(root, '.tmp/compiled-screen-build-pack.json', compiled);
  write(root, 'app/(app)/new.tsx', 'export default function New() { return null; }\n');
  assert.throws(() => compileRegistry(root, ts, ['home']), /explicit screen sources/);
});

test('canonical source assignments reject unknown, duplicate, non-normalized and wrong-route paths', options, (context) => {
  const root = project(context);
  const cases = [
    null,
    [],
    [{ screenId: 'unknown', sourceFile: 'app/(app)/home.tsx' }],
    [{ screenId: 'home', sourceFile: 'app/(app)/home.tsx' }, { screenId: 'home', sourceFile: 'app/(app)/home.tsx' }],
    [{ screenId: 'home', sourceFile: 'app/(app)/home.tsx', inferred: true }],
    [{ screenId: 'home', sourceFile: path.join(root, 'app/(app)/home.tsx') }],
    [{ screenId: 'home', sourceFile: 'app/(app)/../home.tsx' }],
    [{ screenId: 'home', sourceFile: 'app/other.tsx' }],
    [{ screenId: 'home', sourceFile: 'app/_layout.tsx' }],
  ];
  for (const sources of cases) assert.throws(() => compileRegistry(root, ts, [], sources));
  assert.throws(() => compileRegistry(root, ts, ['unknown'], [{ screenId: 'home', sourceFile: 'app/(app)/home.tsx' }]), /unique members/);
});

test('assigned sources must be regular and cannot reuse another app identity', options, (context) => {
  for (const kind of ['symlink', 'hardlink', 'directory']) {
    const root = project(context);
    const source = path.join(root, 'app/(app)/home.tsx');
    const original = path.join(root, 'app/original.tsx');
    fs.renameSync(source, original);
    if (kind === 'symlink') fs.symlinkSync(original, source);
    else if (kind === 'hardlink') fs.linkSync(original, source);
    else fs.mkdirSync(source);
    assert.throws(() => compileRegistry(root, ts, [], [{ screenId: 'home', sourceFile: 'app/(app)/home.tsx' }]), undefined, kind);
  }
  const root = project(context);
  const registry = compileRegistry(root, ts, [], [{ screenId: 'home', sourceFile: 'app/(app)/home.tsx' }]);
  registry.appInstanceId = crypto.randomUUID();
  write(root, '.tmp/authoring-registry.json', registry);
  assert.throws(() => compileRegistry(root, ts, []), /app.json telemetry app identity/);
});

test('source metadata cannot execute expressions or silently change declared semantic targets', options, (context) => {
  for (const expression of [
    'loadTargets()',
    '[...otherTargets]',
    '[{ id: "save", label: labelFromRecord, role: "action" }]',
    '[{ ["id"]: "save", label: "Save", role: "action" }]',
  ]) {
    assert.throws(() => sourceTargets(ts, `export const authoringTargets = ${expression};`, 'screen.tsx', true), /literal metadata|literal target metadata/);
  }
  assert.throws(() => sourceTargets(ts, 'export let authoringTargets = [];', 'screen.tsx', true), /const authoringTargets/);
  assert.throws(() => sourceTargets(ts, 'export default function Home() { return null; }', 'screen.tsx', true), /const authoringTargets/);
  const root = project(context);
  const sources = [{ screenId: 'home', sourceFile: 'app/(app)/home.tsx' }];
  write(root, 'app/(app)/home.tsx', 'export const authoringTargets = [{ id: "save", label: "Save", role: "action" }, { id: "save", label: "Other", role: "action" }];\n');
  assert.throws(() => compileRegistry(root, ts, ['home'], sources), /target IDs must be unique/);
  write(root, 'app/(app)/home.tsx', 'export const authoringTargets = [{ id: "save", label: "Save", role: "invented-control" }];\n');
  assert.throws(() => compileRegistry(root, ts, ['home'], sources), /registry.target.role/);
});
