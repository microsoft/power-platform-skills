'use strict';
// A download writes a rebuildable spec only in a language it KNOWS. The navigation titles it writes are read in the language a rebuild will resolve (the spec on disk's pinned
// `languageCode`, else the environment's base language), and a spec written with the titles of a GUESSED language is worse than none: on a bilingual environment whose base
// language is Spanish, a download whose read of the base language failed fell back to 1033 and wrote the ENGLISH titles as the area and group labels, and a later rebuild, which
// does resolve 3082, wrote them over the Spanish ones — with the spec valid and the baseline matching, so nothing said so.
//
// The build, asked for the same language when the read fails, warns and uses 1033 (resolveLanguageCode), and `--verify`, which describes a deployment as a download does, refuses to
// assume one (its `undetermined` hook). A download describes a deployment, and its output is consumed by a build that may resolve another language, so it is held to the stricter rule: when
// neither `--language-code` nor a spec on disk gives the language and the environment will not say, it stops, writes nothing and says how to go on.
//
// These run `main` — the real `makeDownloadSdk`, the real SDK and the plugin's own HTTP client over a fake Dataverse (helpers/app-sitemap-org.js) — up to and through the point it
// hands the spec to the writer, with `runDownload` replaced by the one read this is about: the app's navigation, hydrated into the App Spec.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { main, makeDownloadSdk } = require('../download-model-app.js');
const { hydrateSpec } = require('../lib/hydrate-spec.js');
const { createSitemapOrg, sitemapXml, json, ENV, APP_ID, APP_UNIQUE, DASH } = require('./helpers/app-sitemap-org.js');

const tempDirs = [];
test.after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

// Every node holds its title in both languages: a bilingual environment. Its base language is the one the spec's labels must be written in.
const BOTH = { area: { 1033: 'Work', 3082: 'Trabajo' }, group: { 1033: 'Cases', 3082: 'Casos' }, dashboard: { 1033: 'Case dashboard', 3082: 'Panel de casos' } };
const ENGLISH = { area: { 1033: 'Work' }, group: { 1033: 'Cases' }, dashboard: { 1033: 'Case dashboard' } };
const REFUSED = () => json(403, { error: { message: 'the caller has no read privilege on the organization table' } });
const labelsOf = (spec) => ({ area: spec.appShell.areas[0].label, group: spec.appShell.areas[0].groups[0].label });
const asksForLanguage = (org) => org.requests.filter((r) => /\/organizations\?/.test(r.path));

/**
 * `main`, as the CLI runs it, over `org`. `disk` is what the output folder holds before the run: `{ spec, baseline }`, each written as given (an object as JSON). Returns what was printed,
 * how many times the download was asked to read the app (`runs`), and the folder's files.
 */
async function runMain(org, { argv = [], disk = {} } = {}) {
  const outDir = tmp('download-language-');
  if (disk.spec !== undefined) fs.writeFileSync(path.join(outDir, 'app-spec.json'), typeof disk.spec === 'string' ? disk.spec : JSON.stringify(disk.spec));
  if (disk.baseline !== undefined) {
    fs.mkdirSync(path.join(outDir, '.maker-workspace'));
    fs.writeFileSync(path.join(outDir, '.maker-workspace', 'last-applied.json'), disk.baseline);
  }
  const results = [];
  const stderr = [];
  const exits = [];
  let runs = 0;
  const deps = {
    argv: ['--env', ENV, '--app', APP_UNIQUE, '--out', outDir, ...argv],
    stderr: { write: (text) => { stderr.push(String(text)); } },
    exit: (code) => { exits.push(code); },
    emitResult: (ok, payload) => results.push({ ok, payload }),
    preflightAuth: async () => ({ ok: true }),
    makeGenpageSdk: () => ({}),
    httpClient: org.httpClient,
    runDownload: async ({ sdk }) => {
      runs += 1;
      const app = await sdk.fetchArtifact('app', APP_ID);
      const hydrated = await hydrateSpec({
        app: async () => ({ ...app, uniquename: APP_UNIQUE }),
        pages: async () => [],
        entities: async () => [],
        webResources: async () => [],
        solution: async () => ({ uniqueName: 'ContosoCases', publisherPrefix: 'contoso' }),
        dashboards: async () => [{ id: DASH, name: 'Case overview', tiles: [] }],
      });
      return {
        ok: true,
        spec: { schemaVersion: 2, solution: { uniqueName: 'ContosoCases', publisherPrefix: 'contoso' }, app: { name: 'Case Management', uniqueName: APP_UNIQUE }, entities: [], pages: [], appShell: hydrated.appShell },
        pages: [], entities: [], webResources: [], droppedSubareas: 0, droppedSubareaDetails: [], dashboardWarnings: [],
      };
    },
    validateAppSpec: () => ({ ok: true, warnings: [] }),
  };
  await main(deps);
  const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name])).sort() : []);
  return {
    results,
    stderr: stderr.join(''),
    exits,
    runs,
    files: files(outDir),
    spec: () => JSON.parse(fs.readFileSync(path.join(outDir, 'app-spec.json'), 'utf8')),
    read: (name) => fs.readFileSync(path.join(outDir, name), 'utf8'),
  };
}

const SPANISH_BASE = () => createSitemapOrg({ xml: sitemapXml(BOTH), baseLanguage: 3082, organizationAnswer: REFUSED });

// --- the language cannot be established ---------------------------------------------------------------------------------------------------------------------------

test('a bilingual environment whose base language is Spanish and whose base language is refused gets no spec: the English titles are not written as the labels', async () => {
  const run = await runMain(SPANISH_BASE());
  assert.strictEqual(run.runs, 0, 'nothing was read with a language that is a guess');
  assert.deepStrictEqual(run.files, [], 'and nothing was written');
  assert.strictEqual(run.results.length, 1);
  const [{ ok, payload }] = run.results;
  assert.strictEqual(ok, false);
  assert.strictEqual(payload.ok, false);
  assert.strictEqual(payload.code, 'navigation-language-unknown');
  // Actionable: why, that nothing was written, and the three ways on — again, the flag the build and verify take, or a pin in the spec.
  assert.match(payload.error, /base language could not be read \(HTTP 403\)/);
  assert.match(payload.error, /Nothing was written/);
  assert.match(payload.error, /again/);
  assert.match(payload.error, /--language-code <lcid>/);
  assert.match(payload.error, /"languageCode"/);
  assert.match(payload.error, /app-spec\.json/);
});

test('a spec and a baseline already on disk are not overwritten by a download that could not establish the language', async () => {
  const spec = JSON.stringify({ app: { name: 'Case Management' }, appShell: { areas: [{ label: 'Trabajo', groups: [{ label: 'Casos', subAreas: [] }] }] } }, null, 2);
  const baseline = JSON.stringify({ marker: 'baseline written by the last apply' });
  const run = await runMain(SPANISH_BASE(), { disk: { spec, baseline } });
  assert.strictEqual(run.results[0].payload.code, 'navigation-language-unknown');
  assert.strictEqual(run.read('app-spec.json'), spec, 'the spec on disk is byte for byte what it was');
  assert.strictEqual(run.read('.maker-workspace/last-applied.json'), baseline, 'and so is the baseline');
  assert.deepStrictEqual(run.files, ['.maker-workspace/last-applied.json', 'app-spec.json']);
});

test('every way the base language fails to be read is a refusal that says what happened', async () => {
  for (const [what, answer, why] of [
    ['a refusal', () => json(403, { error: { message: 'no read privilege' } }), /\(HTTP 403\)/],
    ['a service that stays unavailable through the client\u2019s own retries', () => json(503, { error: { message: 'busy' } }), /\(HTTP 503\)/],
    ['an answer with no organization', () => json(200, { value: [] }), /\(the answer named no language\)/],
    ['a language that is no LCID', () => json(200, { value: [{ languagecode: 'es-ES' }] }), /\(the answer named no language\)/],
    ['a request that failed', () => ({ error: 'socket hang up' }), /\(.*socket hang up.*\)/],
  ]) {
    const run = await runMain(createSitemapOrg({ xml: sitemapXml(BOTH), baseLanguage: 3082, organizationAnswer: answer }));
    assert.strictEqual(run.runs, 0, what);
    assert.deepStrictEqual(run.files, [], what);
    assert.strictEqual(run.results[0].payload.code, 'navigation-language-unknown', what);
    assert.match(run.results[0].payload.error, why, `${what}: ${run.results[0].payload.error}`);
  }
});

test('a service that is unavailable for a moment is not a refusal: the client\u2019s own retry reads the language, and the download goes on in it', async () => {
  let answered = 0;
  const org = createSitemapOrg({
    xml: sitemapXml(BOTH),
    baseLanguage: 3082,
    organizationAnswer: () => ((answered += 1) <= 2 ? json(503, { error: { message: 'busy' } }) : json(200, { value: [{ languagecode: 3082 }] })),
  });
  const run = await runMain(org);
  assert.strictEqual(run.results[0].ok, true, JSON.stringify(run.results[0]));
  assert.deepStrictEqual(labelsOf(run.spec()), { area: 'Trabajo', group: 'Casos' });
  assert.ok(answered >= 3, 'the read was sent again');
});

// --- a language the download is given -----------------------------------------------------------------------------------------------------------------------------

test('--language-code names the language the titles are read in, and the environment is not asked', async () => {
  for (const flag of ['--language-code', '--languageCode']) {
    const org = SPANISH_BASE();
    const run = await runMain(org, { argv: [flag, '3082'] });
    assert.strictEqual(run.results[0].ok, true, `${flag}: ${JSON.stringify(run.results[0])}`);
    assert.deepStrictEqual(labelsOf(run.spec()), { area: 'Trabajo', group: 'Casos' }, flag);
    assert.deepStrictEqual(asksForLanguage(org), [], `${flag}: it is given, so it is not read`);
    // A reading instruction, like the flag of the build: the spec is not pinned to it, so it stays what every other environment can rebuild.
    assert.strictEqual('languageCode' in run.spec(), false, flag);
  }
});

test('--language-code is read exactly as the build and verify read it: an LCID, one spelling, no conflict', async () => {
  for (const [argv, said] of [
    [['--language-code', 'es-ES'], /--language-code \/ --languageCode must be digits only, a positive integer LCID up to 65535 \(got 'es-ES'\)/],
    [['--language-code', '0'], /must be digits only/],
    [['--language-code', '70000'], /must be digits only/],
    [['--language-code', '1031', '--languageCode', '1036'], /--language-code '1031' and --languageCode '1036' disagree — pass only one/],
  ]) {
    const org = SPANISH_BASE();
    const run = await runMain(org, { argv });
    assert.deepStrictEqual(run.exits, [1], argv.join(' '));
    assert.match(run.stderr, said, argv.join(' '));
    assert.match(run.stderr, /Usage: node download-model-app\.js .*\[--language-code <lcid>\]/, 'the usage line names the flag');
    assert.deepStrictEqual(run.results, [], 'nothing is printed as a result');
    assert.deepStrictEqual(org.requests, [], 'no request was made');
  }
});

test('the usage line names --language-code, and a misspelling of it is a usage error that suggests it', async () => {
  const run = await runMain(SPANISH_BASE(), { argv: ['--language-cod', '3082'] });
  assert.deepStrictEqual(run.exits, [1]);
  assert.match(run.stderr, /--language-cod \(did you mean --language-code\?\)/);
  assert.match(run.stderr, /\[--language-code <lcid>\]/);
});

test('a language pinned in the spec on disk keeps bypassing the read, and the spec that is written keeps the pin', async () => {
  const org = SPANISH_BASE();
  const run = await runMain(org, { disk: { spec: { languageCode: 3082 } } });
  assert.strictEqual(run.results[0].ok, true, JSON.stringify(run.results[0]));
  assert.deepStrictEqual(labelsOf(run.spec()), { area: 'Trabajo', group: 'Casos' });
  assert.strictEqual(run.spec().languageCode, 3082);
  assert.deepStrictEqual(asksForLanguage(org), []);
});

test('a flag that names another language than the spec on disk pins is refused: the titles would be read in one language and rebuilt in the other', async () => {
  const spec = JSON.stringify({ languageCode: 1036 });
  const run = await runMain(SPANISH_BASE(), { argv: ['--language-code', '3082'], disk: { spec } });
  assert.strictEqual(run.runs, 0);
  assert.strictEqual(run.results[0].ok, false);
  assert.strictEqual(run.results[0].payload.code, 'navigation-language-conflict');
  assert.match(run.results[0].payload.error, /--language-code 3082 .*"languageCode": 1036/);
  assert.strictEqual(run.read('app-spec.json'), spec, 'nothing is overwritten');
  // The same language in both is not a conflict.
  const agreeing = await runMain(SPANISH_BASE(), { argv: ['--language-code', '3082'], disk: { spec: JSON.stringify({ languageCode: 3082 }) } });
  assert.strictEqual(agreeing.results[0].ok, true, JSON.stringify(agreeing.results[0]));
});

// --- the language is read ----------------------------------------------------------------------------------------------------------------------------------------

test('an environment whose base language is read downloads as it did: the labels in that language, no pin, and one read of the language', async () => {
  const spanish = createSitemapOrg({ xml: sitemapXml(BOTH), baseLanguage: 3082 });
  const run = await runMain(spanish);
  assert.strictEqual(run.results[0].ok, true);
  assert.deepStrictEqual(labelsOf(run.spec()), { area: 'Trabajo', group: 'Casos' });
  assert.strictEqual('languageCode' in run.spec(), false);
  assert.strictEqual(asksForLanguage(spanish).length, 1);
  assert.deepStrictEqual(run.files, ['.maker-workspace/last-applied.json', 'app-spec.json']);

  const english = createSitemapOrg({ xml: sitemapXml(ENGLISH), baseLanguage: 1033 });
  const run1033 = await runMain(english);
  assert.strictEqual(run1033.results[0].ok, true);
  assert.deepStrictEqual(labelsOf(run1033.spec()), { area: 'Work', group: 'Cases' });
  assert.strictEqual('languageCode' in run1033.spec(), false);
  assert.strictEqual(asksForLanguage(english).length, 1);
});

// --- what makeDownloadSdk says -----------------------------------------------------------------------------------------------------------------------------------

test('makeDownloadSdk says where the language came from, or that it has none, and never falls back to one', async () => {
  const made = async (org, deps = {}) => {
    const session = await makeDownloadSdk(ENV, { httpClient: org.httpClient, ...deps });
    session.cleanup();
    return session;
  };
  const read = await made(createSitemapOrg({ xml: sitemapXml(BOTH), baseLanguage: 3082 }));
  assert.deepStrictEqual([read.languageCode, read.languageSource, read.languageUnresolved], [3082, 'environment', undefined]);
  const pinned = await made(SPANISH_BASE(), { authoredLanguageCode: 1036 });
  assert.deepStrictEqual([pinned.languageCode, pinned.languageSource], [1036, 'spec']);
  const flagged = await made(SPANISH_BASE(), { languageCode: 3082, authoredLanguageCode: 1036 });
  assert.deepStrictEqual([flagged.languageCode, flagged.languageSource], [3082, 'flag'], 'the flag outranks the pin, as it does for the build');
  const unknown = await made(SPANISH_BASE());
  assert.deepStrictEqual([unknown.languageCode, unknown.languageSource], [undefined, undefined]);
  assert.match(unknown.languageUnresolved, /^HTTP 403$/);
  assert.ok(unknown.sdk, 'the SDK is still made: whoever refuses owns the refusal');
});
