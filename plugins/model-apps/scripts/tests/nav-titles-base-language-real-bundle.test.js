'use strict';
// REAL-BUNDLE tests for an environment whose base language is not 1033: its navigation titles in a download, and in the rebuild of what the download wrote.
//
// Reported on a Spanish-only environment (base language 3082, no other language provisioned): a download wrote an empty `label` / `title` for every area, group and
// entry, and a rebuild of that spec wrote the navigation titles back as nothing. The SDK projects a sitemap's titles in ONE language, the one it is constructed with: a node's
// title is the `<Title LCID="…">` whose LCID is that language, and "" when it has none. The download built its SDK with no language, which is 1033 — a language the
// environment does not hold — so every title read as "", and the build, which does pass the environment's language, then took that "" for the author's wish to have no title.
//
// These drive the real bundle over a fake Dataverse (helpers/app-sitemap-org.js), the real `makeDownloadSdk`, `hydrateSpec`, `appDef` and `adoptLiveSitemap`, and read the
// sitemap XML the SDK actually writes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { makeDownloadSdk, main } = require('../download-model-app.js');
const { hydrateSpec } = require('../lib/hydrate-spec.js');
const { appDef } = require('../lib/sdk-build.js');
const { adoptLiveSitemap, describeSitemapNotes, chromeByTargetKey } = require('../lib/sitemap-merge.js');
const { createSitemapOrg, createSdk, sitemapXml, json, ENV, APP_ID, APP_UNIQUE, DASH } = require('./helpers/app-sitemap-org.js');

const DASHBOARD_NAME = 'Case overview';
const CREATED = { dashboards: { [DASHBOARD_NAME]: DASH } };

const tempDirs = [];
test.after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

// The titles each node of the fixture sitemap holds, by language: { area, group, table, dashboard } -> { <lcid>: title }. A node with no `<Titles>` holds none.
function heldTitles(xml) {
  const by = (fragment) => Object.fromEntries([...String(fragment || '').matchAll(/<Title LCID="(\d+)" Title="([^"]*)" \/>/g)].map((m) => [m[1], m[2]]));
  const first = (re) => (re.exec(xml) || [])[1];
  const entry = (needle) => (new RegExp(`<SubArea\\b[^>]*${needle}[^>]*?(?:/>|>(.*?)</SubArea>)`).exec(xml) || [])[1];
  return {
    area: by(first(/<Area\b[^>]*>(<Titles>.*?<\/Titles>)/)),
    group: by(first(/<Group\b[^>]*>(<Titles>.*?<\/Titles>)/)),
    table: by(entry('Entity="contoso_case"')),
    dashboard: by(entry('DefaultDashboard=')),
  };
}

// What a download reads of the app: the SDK as `makeDownloadSdk` makes it, then the App Spec's navigation `hydrateSpec` writes from it.
async function download(org, deps = {}) {
  const made = await makeDownloadSdk(ENV, { httpClient: org.httpClient, ...deps });
  try {
    const app = await made.sdk.fetchArtifact('app', APP_ID);
    const spec = await hydrateSpec({
      app: async () => ({ ...app, uniquename: APP_UNIQUE }),
      pages: async () => [],
      entities: async () => [],
      webResources: async () => [],
      solution: async () => ({ uniqueName: 'ContosoCases', publisherPrefix: 'contoso' }),
      dashboards: async () => [{ id: DASH, name: DASHBOARD_NAME, tiles: [] }],
    });
    return { app, spec, shell: spec.appShell, languageNote: made.languageNote };
  } finally {
    made.cleanup();
  }
}
const labels = (shell) => {
  const group = shell.areas[0].groups[0];
  return { area: shell.areas[0].label, group: group.label, entries: group.subAreas.map((s) => s.title) };
};
const asksForLanguage = (org) => org.requests.filter((r) => /\/organizations\?/.test(r.path));

const SPANISH = { area: { 3082: 'Trabajo' }, group: { 3082: 'Casos' }, dashboard: { 3082: 'Panel de casos' } };
const ENGLISH = { area: { 1033: 'Work' }, group: { 1033: 'Cases' }, dashboard: { 1033: 'Case dashboard' } };
const BOTH = { area: { 1033: 'Work', 3082: 'Trabajo' }, group: { 1033: 'Cases', 3082: 'Casos' }, dashboard: { 1033: 'Case dashboard', 3082: 'Panel de casos' } };

// --- the download ----------------------------------------------------------------------------------------------------------------------------------------------------

test('REAL BUNDLE: a download of a Spanish-only environment writes the navigation titles it holds', async () => {
  const org = createSitemapOrg({ xml: sitemapXml(SPANISH), baseLanguage: 3082 });
  const { shell, languageNote } = await download(org);
  assert.deepStrictEqual(labels(shell), { area: 'Trabajo', group: 'Casos', entries: ['', 'Panel de casos'] });
  // The shape is the App Spec's own and carries no language: the table entry has no title of its own (the app shows the table's name), the dashboard entry names its dashboard.
  assert.deepStrictEqual(shell, { areas: [{ label: 'Trabajo', groups: [{ label: 'Casos', subAreas: [{ title: '', entity: 'contoso_case' }, { title: 'Panel de casos', dashboard: DASHBOARD_NAME }] }] }] });
  assert.strictEqual(languageNote, undefined, 'nothing to say: the language was read');
});

test('REAL BUNDLE: an English environment downloads exactly the titles it always did', async () => {
  const org = createSitemapOrg({ xml: sitemapXml(ENGLISH), baseLanguage: 1033 });
  const { shell, languageNote } = await download(org);
  assert.deepStrictEqual(shell, { areas: [{ label: 'Work', groups: [{ label: 'Cases', subAreas: [{ title: '', entity: 'contoso_case' }, { title: 'Case dashboard', dashboard: DASHBOARD_NAME }] }] }] });
  assert.strictEqual(languageNote, undefined);
});

test('REAL BUNDLE: a download asks the environment for its base language once', async () => {
  const org = createSitemapOrg({ xml: sitemapXml(ENGLISH), baseLanguage: 1033 });
  await download(org);
  assert.strictEqual(asksForLanguage(org).length, 1);
});

test('REAL BUNDLE: a bilingual environment downloads the titles in its base language, whichever that is', async () => {
  const english = await download(createSitemapOrg({ xml: sitemapXml(BOTH), baseLanguage: 1033 }));
  assert.deepStrictEqual(labels(english.shell), { area: 'Work', group: 'Cases', entries: ['', 'Case dashboard'] });
  // The App Spec labels are written at the language a rebuild resolves, which is the base language: Spanish text must not come back as the Spanish title\u2019s English twin.
  const spanish = await download(createSitemapOrg({ xml: sitemapXml(BOTH), baseLanguage: 3082 }));
  assert.deepStrictEqual(labels(spanish.shell), { area: 'Trabajo', group: 'Casos', entries: ['', 'Panel de casos'] });
});

test('REAL BUNDLE: a language an author pinned in the spec on disk is the one the titles are read in, and the environment is not asked', async () => {
  const org = createSitemapOrg({ xml: sitemapXml({ area: { 1033: 'Work', 1036: 'Travail' }, group: { 1033: 'Cases', 1036: 'Dossiers' }, dashboard: { 1033: 'Dashboard', 1036: 'Tableau' } }), baseLanguage: 1033 });
  const { shell } = await download(org, { authoredLanguageCode: 1036 });
  assert.deepStrictEqual(labels(shell), { area: 'Travail', group: 'Dossiers', entries: ['', 'Tableau'] });
  assert.deepStrictEqual(asksForLanguage(org), [], 'a rebuild resolves the pinned language before the environment\u2019s, so the download does too');
});

test('REAL BUNDLE: a base language that cannot be read leaves the download in 1033, and says so', async () => {
  for (const [what, answer] of [
    ['a server error', () => json(500, { error: { message: 'busy' } })],
    ['an answer with no organization', () => json(200, { value: [] })],
    ['a language that is no LCID', () => json(200, { value: [{ languagecode: 'es-ES' }] })],
    ['a request that failed', () => ({ error: 'socket hang up' })],
  ]) {
    const org = createSitemapOrg({ xml: sitemapXml(ENGLISH), baseLanguage: 1033, organizationAnswer: answer });
    const { shell, languageNote } = await download(org);
    assert.deepStrictEqual(labels(shell), { area: 'Work', group: 'Cases', entries: ['', 'Case dashboard'] }, `${what}: 1033 is what it was`);
    assert.match(languageNote, /base language.*1033/, `${what}: ${languageNote}`);
  }
});

// --- what `main` hands it ---------------------------------------------------------------------------------------------------------------------------------------

function mainDeps(outDir, seen) {
  const stderr = [];
  const results = [];
  return {
    stderr,
    results,
    deps: {
      argv: ['--env', ENV, '--app', APP_UNIQUE, '--out', outDir],
      stderr: { write: (text) => { stderr.push(String(text)); } },
      emitResult: (ok, payload) => results.push({ ok, payload }),
      preflightAuth: async () => ({ ok: true }),
      makeGenpageSdk: () => ({}),
      makeDownloadSdk: async (env, passed) => {
        seen.push(passed);
        return { sdk: { queryRecords: async (_set, opts = {}) => (/uniquename eq/.test(opts.filter || '') ? [{ appmoduleid: APP_ID }] : [{ uniquename: APP_UNIQUE }]) }, cleanup() {}, languageNote: passed.noteToReturn };
      },
      runDownload: async () => ({
        ok: true,
        spec: { schemaVersion: 2, solution: { uniqueName: 'ContosoCases', publisherPrefix: 'contoso' }, app: { name: 'Case Management', uniqueName: APP_UNIQUE }, entities: [], pages: [], appShell: { areas: [] } },
        pages: [], entities: [], webResources: [], droppedSubareas: 0, droppedSubareaDetails: [], dashboardWarnings: [],
      }),
      validateAppSpec: () => ({ ok: true, warnings: [] }),
    },
  };
}

test('main hands the download SDK the language pinned in the spec already on disk, and prints what the SDK says about the language it could not read', async () => {
  const outDir = tmp('nav-main-');
  fs.writeFileSync(path.join(outDir, 'app-spec.json'), JSON.stringify({ languageCode: 3082 }));
  const seen = [];
  const { deps, stderr } = mainDeps(outDir, seen);
  const original = deps.makeDownloadSdk;
  deps.makeDownloadSdk = async (env, passed) => original(env, { ...passed, noteToReturn: 'the environment\u2019s base language could not be read, so navigation titles were read in 1033' });
  await main(deps);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].authoredLanguageCode, 3082);
  assert.ok(stderr.some((line) => /^WARNING: the environment\u2019s base language could not be read/.test(line)), stderr.join(''));
});

test('main pins no language for a spec that has none, an unreadable one, or one whose language is not an LCID', async () => {
  for (const [what, write] of [
    ['no spec on disk', () => {}],
    ['a spec that is not JSON', (dir) => fs.writeFileSync(path.join(dir, 'app-spec.json'), '{ nope')],
    ['a spec with no language', (dir) => fs.writeFileSync(path.join(dir, 'app-spec.json'), JSON.stringify({ app: {} }))],
    ['a language that is no LCID', (dir) => fs.writeFileSync(path.join(dir, 'app-spec.json'), JSON.stringify({ languageCode: 'es-ES' }))],
  ]) {
    const outDir = tmp('nav-main-');
    write(outDir);
    const seen = [];
    const { deps, stderr } = mainDeps(outDir, seen);
    await main(deps);
    assert.strictEqual(seen.length, 1, what);
    assert.strictEqual(seen[0].authoredLanguageCode, undefined, what);
    assert.ok(!stderr.some((line) => /base language/.test(line)), `${what}: nothing is said when the SDK has nothing to say`);
  }
});

// --- the rebuild -----------------------------------------------------------------------------------------------------------------------------------------------

const specFor = (shell) => ({ solution: { uniqueName: 'ContosoCases', publisherPrefix: 'contoso' }, app: { name: 'Case Management', uniqueName: APP_UNIQUE }, appShell: shell });

/** What the build does for an existing app: fetch it in the language the build resolved, re-attach the spec's navigation to the live nodes, write, push. */
async function rebuild(org, shell, { languageCode, baseChrome } = {}) {
  const { sdk, dispose } = await createSdk(org, { languageCode });
  try {
    await sdk.fetchArtifact('app', APP_ID);
    const live = await sdk.getArtifact('app', APP_ID);
    const { siteMap, notes } = adoptLiveSitemap(appDef(specFor(shell), CREATED).siteMap, live.siteMap, { lcid: languageCode, baseChrome });
    await sdk.updateElement('app', APP_ID, '/siteMap', siteMap);
    await sdk.pushArtifact('app', APP_ID);
    return { xml: org.written(), notes };
  } finally {
    dispose();
  }
}

test('REAL BUNDLE: the spec an earlier download wrote on a Spanish-only environment, with every label empty, rebuilds with every title as it was', async () => {
  const xml = sitemapXml(SPANISH);
  const emptied = { areas: [{ label: '', groups: [{ label: '', subAreas: [{ title: '', entity: 'contoso_case' }, { title: '', dashboard: DASHBOARD_NAME }] }] }] };
  const { xml: written, notes } = await rebuild(createSitemapOrg({ xml, baseLanguage: 3082 }), emptied, { languageCode: 3082 });
  assert.deepStrictEqual(heldTitles(written), heldTitles(xml), `the titles are as they were:\n${written}`);
  assert.deepStrictEqual(heldTitles(written), { area: { 3082: 'Trabajo' }, group: { 3082: 'Casos' }, table: {}, dashboard: { 3082: 'Panel de casos' } });
  const lines = describeSitemapNotes(notes);
  assert.strictEqual(lines.length, 3, JSON.stringify(lines));
  for (const [line, node, title] of [[lines[0], 'area', 'Trabajo'], [lines[1], 'group', 'Casos'], [lines[2], 'nav entry', 'Panel de casos']]) {
    assert.match(line, new RegExp(`^${node} "${title}": kept the environment's title '${title}' \u2014 the spec has none for it`), line);
  }
});

test('REAL BUNDLE: the same spec rebuilds with every title as it was when the download that wrote it also left its baseline', async () => {
  const xml = sitemapXml(SPANISH);
  const emptied = { areas: [{ label: '', groups: [{ label: '', subAreas: [{ title: '', entity: 'contoso_case' }, { title: '', dashboard: DASHBOARD_NAME }] }] }] };
  const { xml: written, notes } = await rebuild(createSitemapOrg({ xml, baseLanguage: 3082 }), emptied, { languageCode: 3082, baseChrome: chromeByTargetKey(specFor(emptied), CREATED) });
  assert.deepStrictEqual(heldTitles(written), heldTitles(xml), `the titles are as they were:\n${written}`);
  assert.strictEqual(describeSitemapNotes(notes).length, 3, 'an area, a group and an entry the spec says nothing about: each kept, each said');
});

test('REAL BUNDLE: a title the spec states is written, as it always was, and the language the spec does not mention is not touched', async () => {
  const xml = sitemapXml(BOTH);
  const stated = { areas: [{ label: 'Operaciones', groups: [{ label: 'Expedientes', subAreas: [{ title: '', entity: 'contoso_case' }, { title: 'Resumen', dashboard: DASHBOARD_NAME }] }] }] };
  const { xml: written, notes } = await rebuild(createSitemapOrg({ xml, baseLanguage: 3082 }), stated, { languageCode: 3082 });
  assert.deepStrictEqual(heldTitles(written), {
    area: { 1033: 'Work', 3082: 'Operaciones' },
    group: { 1033: 'Cases', 3082: 'Expedientes' },
    table: {},
    dashboard: { 1033: 'Case dashboard', 3082: 'Resumen' },
  });
  assert.deepStrictEqual(describeSitemapNotes(notes).map((line) => line.replace(/ to the spec's .*$/, '')), [
    'area "Trabajo": title changes from \'Trabajo\'',
    'group "Casos": title changes from \'Casos\'',
    'nav entry "Panel de casos": title changes from \'Panel de casos\'',
  ]);
});

for (const [what, titlesByNode, baseLanguage] of [
  ['a Spanish-only environment', SPANISH, 3082],
  ['an English environment', ENGLISH, 1033],
  ['a bilingual environment whose base language is English', BOTH, 1033],
  ['a bilingual environment whose base language is Spanish', BOTH, 3082],
]) {
  test(`REAL BUNDLE: ${what} downloads and rebuilds with every title, in every language, as it was`, async () => {
    const xml = sitemapXml(titlesByNode);
    const { shell } = await download(createSitemapOrg({ xml, baseLanguage }));
    const { xml: written, notes } = await rebuild(createSitemapOrg({ xml, baseLanguage }), shell, { languageCode: baseLanguage });
    assert.deepStrictEqual(heldTitles(written), heldTitles(xml), `${what}:\n${written}`);
    assert.deepStrictEqual(describeSitemapNotes(notes), [], 'the spec says what the environment holds: there is nothing to report');
  });
}

test('REAL BUNDLE: the baseline a download writes for the spec it wrote keeps a title the environment gained since, whatever language it is in', async () => {
  const downloadedFrom = sitemapXml(SPANISH);
  const { shell } = await download(createSitemapOrg({ xml: downloadedFrom, baseLanguage: 3082 }));
  const baseline = specFor(shell);
  const renamed = sitemapXml({ ...SPANISH, dashboard: { 3082: 'Panel de expedientes' } });
  const { xml: written, notes } = await rebuild(createSitemapOrg({ xml: renamed, baseLanguage: 3082 }), shell, { languageCode: 3082, baseChrome: chromeByTargetKey(baseline, CREATED) });
  assert.deepStrictEqual(heldTitles(written).dashboard, { 3082: 'Panel de expedientes' }, 'the designer\u2019s rename survives a rebuild of the stale spec');
  assert.ok(describeSitemapNotes(notes).some((line) => /kept the environment's title 'Panel de expedientes'/.test(line)), JSON.stringify(describeSitemapNotes(notes)));
});
