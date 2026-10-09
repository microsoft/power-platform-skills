'use strict';
// lib/deployed-baseline.js: the last-applied/downloaded spec is a sitemap baseline ONLY for the app and
// environment it describes (AB#6726727).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { baselinePath, confinedReader, deployedIdsFor, writeBaseline, readBaseline } = require('../lib/deployed-baseline.js');

const ENV = 'https://contoso.crm.dynamics.com';
const spec = () => ({ solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A', uniqueName: 'new_a' }, pages: [{ key: 'home', name: 'Home', source: { kind: 'tsx', codeFile: 'pages/home.tsx' } }] });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-'));

test('a baseline is returned only for the app and environment it was written for', () => {
  const dir = tmp();
  try {
    const ws = path.join(dir, '.maker-workspace');
    fs.mkdirSync(path.join(dir, 'pages'));
    fs.writeFileSync(path.join(dir, 'pages', 'home.tsx'), 'export default () => null;');
    writeBaseline(ws, spec(), { appDir: dir, environment: ENV, appUniqueName: 'new_a' });
    const got = readBaseline(ws, { environment: ENV, appUniqueName: 'NEW_A' });
    assert.ok(got, 'same app (unique names are case-insensitive) and environment');
    assert.strictEqual(got.app.uniqueName, 'new_a');
    assert.match(got.pages[0].__contentSha, /^[0-9a-f]{64}$/, 'annotated like a build-written snapshot, so the dry-run diff does not over-report');
    assert.strictEqual(readBaseline(ws, { environment: 'https://fabrikam.crm.dynamics.com', appUniqueName: 'new_a' }), null, 'another environment');
    assert.strictEqual(readBaseline(ws, { environment: ENV, appUniqueName: 'new_b' }), null, 'another app');
    assert.strictEqual(readBaseline(ws, { environment: null, appUniqueName: 'new_a' }), null, 'an environment that could not be identified');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A plain write cut short by a crash or a full disk left a truncated file, which reads as no baseline — and
// without one the spec wins over every nav change made in the designer. The baseline is written atomically
// (writeFileAtomic, apply-snapshot-store.js), so a write that fails leaves the previous one, still readable.
test('a baseline write that fails leaves the previous baseline readable, and no temp file', (t) => {
  const dir = tmp();
  try {
    const ws = path.join(dir, '.maker-workspace');
    const identity = { appDir: dir, environment: ENV, appUniqueName: 'new_a' };
    writeBaseline(ws, spec(), identity);
    const before = fs.readFileSync(baselinePath(ws), 'utf8');
    const next = { ...spec(), app: { name: 'Renamed', uniqueName: 'new_a' } };
    for (const step of ['fsyncSync', 'renameSync']) {
      const mock = t.mock.method(fs, step, () => { throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); });
      assert.throws(() => writeBaseline(ws, next, identity), { code: 'ENOSPC' }, step);
      mock.mock.restore();
      assert.strictEqual(fs.readFileSync(baselinePath(ws), 'utf8'), before, `${step}: the previous baseline is untouched`);
      assert.strictEqual(readBaseline(ws, { environment: ENV, appUniqueName: 'new_a' }).app.name, 'A', step);
      assert.deepStrictEqual(fs.readdirSync(ws), ['last-applied.json'], `${step}: no temp is left`);
    }
    writeBaseline(ws, next, identity);
    assert.strictEqual(readBaseline(ws, { environment: ENV, appUniqueName: 'new_a' }).app.name, 'Renamed');
    assert.deepStrictEqual(fs.readdirSync(ws), ['last-applied.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a snapshot with no stamps, or one that cannot be read, is not a baseline', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(baselinePath(dir), JSON.stringify(spec()));
    assert.strictEqual(readBaseline(dir, { environment: ENV, appUniqueName: 'new_a' }), null, 'written before the stamps existed');
    fs.writeFileSync(baselinePath(dir), '{ not json');
    assert.strictEqual(readBaseline(dir, { environment: ENV, appUniqueName: 'new_a' }), null);
    fs.writeFileSync(baselinePath(dir), '[]');
    assert.strictEqual(readBaseline(dir, { environment: ENV, appUniqueName: 'new_a' }), null);
    assert.strictEqual(readBaseline(path.join(dir, 'missing'), { environment: ENV, appUniqueName: 'new_a' }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the content reader stays inside the app folder', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'in.txt'), 'x');
    const read = confinedReader(dir);
    assert.strictEqual(String(read('in.txt')), 'x');
    assert.strictEqual(read('../outside.txt'), null);
    assert.strictEqual(read(path.resolve(dir, '..', 'x.txt')), null);
    assert.strictEqual(read('missing.txt'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// AB#6726727: the sitemap baseline lines nav entries up by the ids a dashboard and page have in THIS
// environment. A spec downloaded from another one keeps that one's ids, so an apply records what IT
// resolved, and a download what it read.
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const F = 'ffffffff-0000-0000-0000-00000000000f';
const withIds = () => ({ ...spec(), dashboards: [{ name: 'Ops', dashboardId: F }, { name: 'Sales' }], pages: [{ key: 'home', name: 'Home', pageId: F, source: { kind: 'tsx', codeFile: 'pages/home.tsx' } }, { key: 'about', name: 'About' }] });

test('an apply records the ids it resolved, then the prior baseline\u2019s, and never the spec\u2019s own', () => {
  const ids = deployedIdsFor(withIds(), {
    created: { dashboards: { Ops: A }, pages: { home: B } },
    previous: { __deployedIds: { dashboards: { Sales: B, Ops: F }, pages: { about: A } } },
  });
  assert.deepStrictEqual(ids, { dashboards: { Ops: A, Sales: B }, pages: { home: B, about: A } });
  // Nothing resolved it and no prior baseline had it: left out, for the next build to resolve.
  assert.deepStrictEqual(deployedIdsFor(withIds(), {}), { dashboards: {}, pages: {} });
});

test('a download records the ids it read from the environment', () => {
  assert.deepStrictEqual(deployedIdsFor(withIds(), { fromSpec: true }), { dashboards: { Ops: F }, pages: { home: F } });
});

test('a name that is also an Object.prototype member is recorded as data, not as the prototype', () => {
  const s = { dashboards: [{ name: '__proto__' }, { name: 'constructor' }] };
  const ids = deployedIdsFor(s, { created: { dashboards: JSON.parse(`{"__proto__":"${A}"}`) } });
  assert.deepStrictEqual(Object.keys(ids.dashboards), ['__proto__']);
  assert.strictEqual(Object.getPrototypeOf(ids.dashboards), Object.prototype);
  assert.strictEqual(JSON.parse(JSON.stringify(ids)).dashboards.__proto__, A);
});

test('the baseline is written with its deployed ids and read back as schemaVersion 2', () => {
  const dir = tmp();
  try {
    const ws = path.join(dir, '.maker-workspace');
    // A legacy (v1) download: the page is referenced from the nav by NAME, and has no key yet.
    const legacy = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A', uniqueName: 'new_a' },
      pages: [{ name: 'Home Page', pageId: A, codeFile: 'pages/home.tsx' }],
      appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ page: 'Home Page', title: 'Home' }] }] }] } };
    writeBaseline(ws, legacy, { appDir: dir, environment: ENV, appUniqueName: 'new_a', fromSpec: true });
    const got = readBaseline(ws, { environment: ENV, appUniqueName: 'new_a' });
    const key = got.pages[0].key;
    assert.ok(key, 'migrated: the page has a key');
    assert.strictEqual(got.appShell.areas[0].groups[0].subAreas[0].page, key, 'and the nav references it by that key');
    assert.deepStrictEqual(got.__deployedIds, { dashboards: {}, pages: { [key]: A } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// readBaseline runs on EVERY build in a folder that has a baseline, so one the migrator cannot read must
// degrade to "no baseline" (the build then reports each nav change it makes) — never throw out of the
// build. The migrator is defensive enough that parsed JSON cannot make it throw, so the module is loaded
// here against one that does.
test('a baseline the migrator cannot read is no baseline, not a crash', () => {
  const dir = tmp();
  const modPath = require.resolve('../lib/deployed-baseline.js');
  const specPath = require.resolve('../lib/app-spec.js');
  const saved = { mod: require.cache[modPath], spec: require.cache[specPath] };
  try {
    const ws = path.join(dir, '.maker-workspace');
    writeBaseline(ws, { ...spec(), pages: [] }, { appDir: dir, environment: ENV, appUniqueName: 'new_a' });
    assert.ok(readBaseline(ws, { environment: ENV, appUniqueName: 'new_a' }), 'readable with the real migrator');
    delete require.cache[modPath];
    require.cache[specPath] = { ...saved.spec, exports: { ...saved.spec.exports, migrateAppSpec: () => { throw new Error('unreadable'); } } };
    const fresh = require('../lib/deployed-baseline.js');
    assert.strictEqual(fresh.readBaseline(ws, { environment: ENV, appUniqueName: 'new_a' }), null);
  } finally {
    require.cache[specPath] = saved.spec;
    if (saved.mod) require.cache[modPath] = saved.mod; else delete require.cache[modPath];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
