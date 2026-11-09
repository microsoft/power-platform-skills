'use strict';
// The navigation check (lib/app-navigation.js): which navigations the build refuses before it writes anything.
//
// A new app is created with its navigation MINUS the pages (they do not exist yet), and Dataverse refuses to CREATE a
// sitemap with no non-empty area holding a non-empty group (HTTP 400, measured). It accepts the same navigation when
// the sitemap of an app that already exists is UPDATED (measured: saved and published), so only a new app is refused.
// A spec whose navigation is only pages, or has no entry at all, still VALIDATES, so a build of a new app used to fail
// at the app step after the solution, tables, views and forms had been written. A run that creates a new app's pages
// FIRST (the whole build) creates the app once they exist, with them in its first navigation, so it builds a navigation
// of pages only for a new app too; both rules are pinned. This file pins the rule itself, its agreement with what appDef
// pushes, that validation is unchanged, and the lint warning. The build, the dry run and the writes are pinned in
// app-navigation-build.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { NAVIGATION_REFUSAL_CODE, navigationEntryKind, navigationHolds, navigationIsPagesOnly, navigationVerdict } = require('../lib/app-navigation.js');
const { appDef } = require('../lib/sdk-build.js');
const { validateAppSpec } = require('../lib/app-spec.js');
const { lintAppSpec } = require('../lib/spec-lint.js');
const { lintSpec } = require('../lint-app-spec.js');
const { SHAPES, specFor, oneGroup, page, table } = require('./helpers/navigation-shapes.js');

const CLI = path.join(__dirname, '..', 'lint-app-spec.js');
const exists = { false: 'a new app', true: 'an existing app', undefined: 'an app whose existence is unknown' };

test('an entry is classified as appDef does: a dashboard over a page, a page over a url, anything else is a table', () => {
  assert.strictEqual(navigationEntryKind({ dashboard: 'Ops', title: 'x' }), 'dashboard');
  assert.strictEqual(navigationEntryKind({ page: 'overview', title: 'x' }), 'page');
  assert.strictEqual(navigationEntryKind({ url: 'https://contoso.example', title: 'x' }), 'url');
  assert.strictEqual(navigationEntryKind({ entity: 'new_customer', title: 'x' }), 'entity');
  // Validation forbids two targets, but the precedence is what decides which entries a new app's first navigation drops.
  assert.strictEqual(navigationEntryKind({ dashboard: 'Ops', page: 'overview' }), 'dashboard');
  assert.strictEqual(navigationEntryKind({ page: 'overview', url: 'https://contoso.example' }), 'page');
  assert.strictEqual(navigationEntryKind({ title: 'no target at all' }), 'entity');
});

test('navigationHolds counts the areas, groups and entries the build walks, and the pages among the entries', () => {
  const spec = {
    appShell: {
      areas: [
        { label: 'A', groups: [{ label: 'G1', subAreas: [page('overview'), table] }, { label: 'G2', subAreas: [] }] },
        { label: 'B' },
        { label: 'C', groups: [{ label: 'G3', subAreas: [{ url: 'https://contoso.example', title: 'u' }, page('detail')] }] },
      ],
    },
  };
  assert.deepStrictEqual(navigationHolds(spec), { declared: true, areas: 3, groups: 3, entries: 4, pages: ['overview', 'detail'] });
  assert.deepStrictEqual(navigationHolds({}), { declared: false, areas: 0, groups: 0, entries: 0, pages: [] });
  assert.deepStrictEqual(navigationHolds({ appShell: { areas: [] } }), { declared: true, areas: 0, groups: 0, entries: 0, pages: [] });
});

// Lint runs on specs still being typed: a half-typed node is not counted, and nothing throws.
test('navigationHolds is total on a half-typed navigation', () => {
  for (const appShell of [null, 'areas', [], { areas: {} }, { areas: 'x' }, { areas: [null, 3, 'x', {}] }, { areas: [{ groups: 'g' }, { groups: [null, { subAreas: {} }] }] }]) {
    const holds = navigationHolds({ appShell });
    assert.strictEqual(holds.entries, 0, JSON.stringify(appShell));
    assert.deepStrictEqual(holds.pages, []);
  }
  assert.strictEqual(navigationHolds(undefined).declared, false);
  assert.strictEqual(navigationHolds({ appShell: { areas: [{ groups: [{ subAreas: [null, 4, page('overview')] }] }] } }).entries, 1, 'only the entry that is an object is one');
});

for (const shape of SHAPES) {
  test(`verdict — ${shape.name}: new ${shape.forNew}, existing ${shape.forExisting}, unknown ${shape.forUnknown}`, () => {
    const spec = specFor(shape);
    for (const [appExists, expected] of [[false, shape.forNew], [true, shape.forExisting], [undefined, shape.forUnknown]]) {
      const verdict = navigationVerdict(spec, { appExists });
      assert.strictEqual(verdict.outcome, expected, `${exists[appExists]}: ${JSON.stringify(verdict)}`);
      if (expected === 'ok') {
        assert.deepStrictEqual(verdict, { outcome: 'ok' });
        continue;
      }
      assert.strictEqual(verdict.kind, shape.kind);
      assert.ok(verdict.message && verdict.message.length > 0);
      if (expected === 'refuse') assert.strictEqual(verdict.code, NAVIGATION_REFUSAL_CODE);
      else assert.strictEqual(verdict.code, undefined, 'a navigation the build goes on with carries no refusal code');
    }
  });
  // A run that creates a new app's pages before the app (sdk-build.js pagesFirstRule): the whole build --apply runs.
  test(`verdict, a run that creates the pages first — ${shape.name}: new ${shape.forNewPagesFirst}, existing ${shape.forExisting}, unknown ${shape.forUnknownPagesFirst}`, () => {
    const spec = specFor(shape);
    for (const [appExists, expected] of [[false, shape.forNewPagesFirst], [true, shape.forExisting], [undefined, shape.forUnknownPagesFirst]]) {
      const verdict = navigationVerdict(spec, { appExists, newAppPagesFirst: true });
      assert.strictEqual(verdict.outcome, expected, `${exists[appExists]}: ${JSON.stringify(verdict)}`);
      if (expected === 'ok') assert.deepStrictEqual(verdict, { outcome: 'ok' });
      else assert.strictEqual(verdict.kind, shape.kind);
    }
  });
}

test('navigationIsPagesOnly: a navigation that holds entries, every one a page — the one a new app is built from only by creating its pages first', () => {
  for (const shape of SHAPES) assert.strictEqual(navigationIsPagesOnly(specFor(shape)), shape.kind === 'pages-only', shape.name);
  assert.strictEqual(navigationIsPagesOnly({}), false);
  assert.strictEqual(navigationIsPagesOnly({ appShell: oneGroup(page('overview'), { dashboard: 'Ops', title: 'Ops' }) }), false, 'a dashboard entry is not a page');
  assert.strictEqual(navigationIsPagesOnly({ appShell: oneGroup(page('overview'), { url: 'https://contoso.example', title: 'u' }) }), false, 'nor is a url');
});

test('the refusal code is the one the build halts with', () => {
  assert.strictEqual(NAVIGATION_REFUSAL_CODE, 'app-navigation-empty');
});

// An existing app is told it will have no entries only for a navigation its run would WRITE: a run that writes none asks
// nothing of the spec (sdk-build.js existingAppSitemapIsWritten) and has nothing to say. The one shape refused whatever the
// run writes is no `appShell.areas` at all, which appDef throws on before it asks whether the app exists.
test('an existing app is warned of an empty navigation only when the run writes one to it — and a spec with no appShell.areas is refused whatever the run writes', () => {
  for (const shape of SHAPES.filter((s) => s.kind === 'empty')) {
    const spec = specFor(shape);
    assert.strictEqual(navigationVerdict(spec, { appExists: true, existingAppIsWritten: true }).outcome, 'warn', `${shape.name}, existing, written`);
    assert.deepStrictEqual(navigationVerdict(spec, { appExists: true, existingAppIsWritten: false }), { outcome: 'ok' }, `${shape.name}, existing, nothing is written: nothing to say`);
    for (const existingAppIsWritten of [true, false]) {
      assert.strictEqual(navigationVerdict(spec, { appExists: undefined, existingAppIsWritten }).outcome, 'unknown', `${shape.name}, unknown, ${existingAppIsWritten ? 'written' : 'not written'}`);
      assert.strictEqual(navigationVerdict(spec, { appExists: false, existingAppIsWritten }).outcome, 'refuse', `${shape.name}, a new app is created whatever the run writes to an existing one`);
    }
  }
  for (const shape of SHAPES.filter((s) => s.kind === 'undeclared')) {
    for (const appExists of [true, false, undefined]) {
      for (const existingAppIsWritten of [true, false]) assert.strictEqual(navigationVerdict(specFor(shape), { appExists, existingAppIsWritten }).outcome, 'refuse', `${shape.name}, ${exists[appExists]}`);
    }
  }
  // Pages count for an existing app whether or not the run writes its navigation, and say nothing.
  const pagesOnly = specFor(SHAPES.find((s) => s.kind === 'pages-only'));
  for (const existingAppIsWritten of [true, false]) assert.deepStrictEqual(navigationVerdict(pagesOnly, { appExists: true, existingAppIsWritten }), { outcome: 'ok' });
});

test('a refusal says what the navigation holds, what Dataverse requires, and what to add', () => {
  // A navigation of pages only is refused only by a run that does not create a new app's pages first, and says why it does not.
  const pagesOnly = navigationVerdict(specFor(SHAPES.find((s) => s.name === 'a navigation of pages only')), { appExists: false, whyNotPagesFirst: 'this run does not have the pages phase, which would create them first' });
  assert.match(pagesOnly.message, /holds only page entries \('overview', 'detail'\)/);
  assert.match(pagesOnly.message, /A page entry joins the navigation only once its page exists, and this run does not have the pages phase, which would create them first, so a new app would be created without them/);
  assert.match(pagesOnly.message, /Dataverse refuses to create a sitemap with no non-empty area holding a non-empty group/);
  assert.match(pagesOnly.message, /HTTP 400: "SiteMap needs to have a non-empty Area with a non-empty Group"/);
  assert.match(pagesOnly.message, /A build that has the pages phase creates such an app after its pages, with them in its first navigation: run the whole build, with every page the navigation names implemented\./);
  assert.ok(pagesOnly.message.includes("{ entity: '<table>', title: '<label>' }"), 'an entry to add');
  assert.match(pagesOnly.message, /Or give a group one entry that is not a page/);
  assert.match(pagesOnly.message, /dashboard or url entry/);
  assert.match(pagesOnly.message, /keep the page entries beside it/);
  assert.match(navigationVerdict(specFor(SHAPES.find((s) => s.name === 'a navigation of pages only')), { appExists: false }).message, /and this run does not create the pages before the app, so/, 'without a reason it still says what the run does not do');

  for (const shape of SHAPES.filter((s) => s.kind === 'empty')) {
    const { message } = navigationVerdict(specFor(shape), { appExists: false });
    assert.ok(message.includes(`the navigation has no entry (${shape.said})`), `${shape.name}: ${message}`);
    assert.match(message, /Dataverse refuses to create a sitemap with no non-empty area holding a non-empty group \(HTTP 400: "SiteMap needs to have a non-empty Area with a non-empty Group"\)/);
    assert.ok(message.includes("{ entity: '<table>', title: '<label>' } in appShell.areas[].groups[].subAreas."), shape.name);
    assert.match(message, /A new app needs one entry that is not a page/, 'a run that does not create the pages first needs one');
    // In a run that does, an entry for one of the spec's pages is as good, and the advice says so instead.
    const pagesFirst = navigationVerdict(specFor(shape), { appExists: false, newAppPagesFirst: true }).message;
    assert.ok(pagesFirst.includes("{ entity: '<table>', title: '<label>' } in appShell.areas[].groups[].subAreas, or an entry for one of the spec's pages (a build that has the pages phase creates a new app's pages before the app)."), `${shape.name}: ${pagesFirst}`);
    assert.doesNotMatch(pagesFirst, /needs one entry that is not a page/);
  }
});

// No appShell.areas is not an empty navigation but no navigation: the build has nothing to build the app's sitemap from, so the message says that
// (not that Dataverse refuses a sitemap it was never given), and it is the same for an app that exists.
test('a spec with no appShell.areas says there is no navigation to build the app with — and what to add — whether the app is new or not', () => {
  for (const shape of SHAPES.filter((s) => s.kind === 'undeclared')) {
    for (const appExists of [false, true, undefined]) {
      const { message } = navigationVerdict(specFor(shape), { appExists });
      assert.ok(message.startsWith('the spec has no appShell.areas, so there is no navigation to build the app with.'), `${shape.name}, ${exists[appExists]}: ${message}`);
      assert.ok(message.includes("{ entity: '<table>', title: '<label>' } in appShell.areas[].groups[].subAreas"), shape.name);
      assert.ok(!/HTTP 400/.test(message), 'Dataverse is not involved: nothing would be sent');
      // In a run that creates a new app's pages first, an entry for one of the spec's pages is offered too.
      const pagesFirst = navigationVerdict(specFor(shape), { appExists, newAppPagesFirst: true });
      assert.strictEqual(pagesFirst.outcome, 'refuse', 'still refused: there is no navigation at all');
      assert.ok(pagesFirst.message.includes("in appShell.areas[].groups[].subAreas, or an entry for one of the spec's pages"), pagesFirst.message);
    }
  }
});

// An app that exists is built with an empty navigation: Dataverse accepts it on an update. It says what the app is left with, that the build goes on,
// and what to add to keep the app navigable — and it is not a refusal.
test('an app that exists is told it will have no navigation entries, that Dataverse accepts that on an update, and what to add', () => {
  for (const shape of SHAPES.filter((s) => s.kind === 'empty')) {
    const verdict = navigationVerdict(specFor(shape), { appExists: true });
    assert.strictEqual(verdict.outcome, 'warn', shape.name);
    assert.strictEqual(verdict.code, undefined, 'no refusal code: the build goes on');
    assert.ok(verdict.message.startsWith(`the navigation has no entry (${shape.said}), so the app is left with no navigation entries (any it has now are removed).`), `${shape.name}: ${verdict.message}`);
    assert.match(verdict.message, /Dataverse accepts an empty navigation when the navigation of an app that already exists is updated, so the build goes on\./);
    assert.ok(verdict.message.includes("give an area a group with an entry — for example { entity: '<table>', title: '<label>' } in appShell.areas[].groups[].subAreas"), shape.name);
    assert.ok(!/HTTP 400/.test(verdict.message), 'it quotes no refusal: there is none');
  }
});

test('a navigation of many pages names the first five and counts the rest', () => {
  const pages = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  const verdict = navigationVerdict({ appShell: oneGroup(...pages.map(page)) }, { appExists: false });
  assert.ok(verdict.message.includes("('p1', 'p2', 'p3', 'p4', 'p5' and 2 more)"), verdict.message);
  const five = navigationVerdict({ appShell: oneGroup(...pages.slice(0, 5).map(page)) }, { appExists: false });
  assert.ok(five.message.includes("('p1', 'p2', 'p3', 'p4', 'p5')"), 'exactly five are listed in full');
});

test('an unknown answer names what could not be checked, and says a new app would stop after its tables are written', () => {
  const spec = specFor(SHAPES.find((s) => s.name === 'a navigation of pages only'));
  const asked = navigationVerdict(spec, { whyUnknown: 'read refused (HTTP 503)' });
  assert.strictEqual(asked.outcome, 'unknown');
  assert.match(asked.message, /whether it exists could not be checked \(read refused \(HTTP 503\)\)/);
  assert.match(asked.message, /a new app would stop at the app step, after the tables are written/);
  assert.match(asked.message, /an app that already exists takes its page entries once the pages are built/);
  assert.match(navigationVerdict(spec, {}).message, /could not be checked \(the environment was not read\)/, 'without a reason it still says what it did not do');
});

// For an empty navigation what the unknown answer sets against the new app is not "page entries are taken" but that an app which exists is built with no
// entries (Dataverse accepts that on an update) — or, in a run that writes no navigation to it, that nothing is written there.
test('an unknown answer for an empty navigation says what an app that exists would be left with, or that the run writes it nothing', () => {
  for (const shape of SHAPES.filter((s) => s.kind === 'empty')) {
    const written = navigationVerdict(specFor(shape), { whyUnknown: 'read refused (HTTP 503)' });
    assert.strictEqual(written.outcome, 'unknown', shape.name);
    assert.ok(written.message.startsWith(`the navigation has no entry (${shape.said}), and Dataverse refuses to create a sitemap`), `${shape.name}: ${written.message}`);
    assert.match(written.message, /That matters only if the app is new \(an app that already exists is built with no navigation entries: Dataverse accepts an empty navigation when the navigation of an app that already exists is updated\)/);
    assert.match(written.message, /whether it exists could not be checked \(read refused \(HTTP 503\)\), so nothing stops the build here; a new app would stop at the app step, after the tables are written\./);
    const notWritten = navigationVerdict(specFor(shape), { existingAppIsWritten: false });
    assert.match(notWritten.message, /That matters only if the app is new \(this run writes no navigation to an app that already exists\)/, shape.name);
  }
});

// The agreement the whole check rests on: what the build pushes for a NEW app is appDef with `omitUnbuiltPages`, and
// the check must call a navigation fine exactly when that holds an entry in a group in an area.
function firstPushHoldsAnEntry(spec, created = { dashboards: {}, pages: {} }, options = { omitUnbuiltPages: true }) {
  let pushed;
  try {
    pushed = appDef(spec, created, options);
  } catch {
    return false; // no appShell.areas: appDef has nothing to build a sitemap from
  }
  return pushed.siteMap.areas.some((area) => area.groups.some((group) => group.subAreas.length > 0));
}

test('the check agrees with the navigation appDef pushes for a new app, for every shape', () => {
  for (const shape of SHAPES) {
    const spec = specFor(shape);
    assert.strictEqual(navigationVerdict(spec, { appExists: false }).outcome === 'ok', firstPushHoldsAnEntry(spec), shape.name);
  }
});

// The same agreement in a run that creates a new app's pages first. For a navigation of pages only the app's first push is made once the
// pages exist — appDef over every page's id, nothing left out (sdk-build.js createAppWithPages); for any other it is the app step's, the
// pages left out, as before.
test('the check agrees with the navigation appDef pushes for a new app in a run that creates the pages first, for every shape', () => {
  for (const shape of SHAPES) {
    const spec = specFor(shape);
    const built = { dashboards: {}, pages: Object.fromEntries((shape.pages || []).map((key, i) => [key, `gp-${i}`])) };
    const pushed = navigationIsPagesOnly(spec) ? firstPushHoldsAnEntry(spec, built, {}) : firstPushHoldsAnEntry(spec);
    assert.strictEqual(navigationVerdict(spec, { appExists: false, newAppPagesFirst: true }).outcome === 'ok', pushed, shape.name);
  }
});

test('the check agrees with appDef for a dashboard entry, which is built before the app and is not left out', () => {
  const spec = specFor({ appShell: oneGroup({ dashboard: 'Operations', title: 'Overview' }) });
  assert.strictEqual(firstPushHoldsAnEntry(spec, { dashboards: { Operations: 'dash-1' }, pages: {} }), true);
  assert.strictEqual(navigationVerdict(spec, { appExists: false }).outcome, 'ok');
});

test('the check agrees with appDef when a page is among several entries: it is the only one left out', () => {
  const spec = specFor({ pages: ['overview'], appShell: oneGroup(page('overview'), table) });
  const pushed = appDef(spec, { dashboards: {}, pages: {} }, { omitUnbuiltPages: true });
  assert.deepStrictEqual(pushed.siteMap.areas[0].groups[0].subAreas.map((s) => s.type), ['Entity']);
  const rebuilt = appDef(spec, { dashboards: {}, pages: { overview: 'gp-1' } }, {});
  assert.deepStrictEqual(rebuilt.siteMap.areas[0].groups[0].subAreas.map((s) => s.type), ['GenPage', 'Entity'], 'the pages phase writes it once the page exists');
});

// validateAppSpec is deliberately NOT where this is refused: a data-only spec has no navigation, and a downloaded spec carries the app's own, which can be empty.
for (const profile of ['plan', 'deploy']) {
  test(`validateAppSpec (${profile}) still accepts every shape — the navigation is refused by the build, not by validation`, () => {
    for (const shape of SHAPES) {
      const result = validateAppSpec(specFor(shape), { profile });
      assert.deepStrictEqual(result.errors, [], `${shape.name}: ${JSON.stringify(result.errors)}`);
      assert.strictEqual(result.ok, true, shape.name);
    }
  });
}

const appShellWarnings = (spec) => lintAppSpec(spec).warnings.filter((w) => w.startsWith('appShell: '));

// Lint speaks of the build --apply runs: the whole build, which creates a new app's pages before the app. So it warns for exactly the
// navigations that build refuses for a new app (`forNewPagesFirst`) — a navigation of pages only is not one of them.
test('lint warns, once, for exactly the navigations a new app cannot be built from — and never errors on them', () => {
  for (const shape of SHAPES) {
    const spec = specFor(shape);
    const warnings = appShellWarnings(spec);
    assert.strictEqual(warnings.length, shape.forNewPagesFirst === 'refuse' ? 1 : 0, `${shape.name}: ${JSON.stringify(warnings)}`);
    const lint = lintAppSpec(spec);
    assert.deepStrictEqual(lint.errors, [], `${shape.name}: a warning, not an error`);
    assert.strictEqual(lint.ok, true, shape.name);
  }
});

test('the lint warning carries what the build would say', () => {
  assert.deepStrictEqual(appShellWarnings(specFor(SHAPES.find((s) => s.name === 'a navigation of pages only'))), [], 'a navigation of pages only builds: the whole build creates the pages first');
  const [empty] = appShellWarnings(specFor(SHAPES.find((s) => s.name === 'areas: []')));
  assert.match(empty, /^appShell: the navigation has no entry \(appShell\.areas is empty\)/);
  assert.match(empty, /HTTP 400: "SiteMap needs to have a non-empty Area with a non-empty Group"/);
  assert.ok(empty.includes("{ entity: '<table>', title: '<label>' } in appShell.areas[].groups[].subAreas, or an entry for one of the spec's pages"), 'what to add, a page entry included');
  assert.ok(empty.endsWith(' An app that already exists is built with no navigation entries, and the build says so.'), 'an app that exists is not refused an empty navigation, and lint says what it gets instead');
  const [undeclared] = appShellWarnings(specFor(SHAPES.find((s) => s.name === 'a spec with no appShell')));
  assert.match(undeclared, /^appShell: the spec has no appShell\.areas, so there is no navigation to build the app with\./);
  assert.ok(!undeclared.includes('already exists'), 'no app of any kind is built from a spec with no appShell.areas, so none is spared');
});

// The authoring flow runs lint-app-spec at the default `plan` profile, where a page may still be an intent.
test('lint-app-spec (plan profile) reports the warning with its source tag, and the exit code stays 0 without --strict', () => {
  const report = lintSpec(specFor(SHAPES.find((s) => s.name === 'areas: []')));
  assert.strictEqual(report.profile, 'plan');
  assert.strictEqual(report.ok, true, JSON.stringify(report.errors));
  assert.strictEqual(report.warnings.filter((w) => w.startsWith('lint: appShell: ')).length, 1, JSON.stringify(report.warnings));
  assert.strictEqual(lintSpec(specFor(SHAPES.find((s) => s.name === 'a table entry'))).warnings.filter((w) => /appShell:/.test(w)).length, 0);
  // A navigation of pages only whose pages are still intents: the build that deploys them implements them first (validation's deploy
  // profile demands it), and then creates them before the app — so lint has nothing to say of the navigation.
  const intents = specFor(SHAPES.find((s) => s.name === 'a navigation of pages only'));
  for (const p of intents.pages) p.source = { kind: 'intent' };
  const pagesOnly = lintSpec(intents);
  assert.strictEqual(pagesOnly.ok, true, JSON.stringify(pagesOnly.errors));
  assert.deepStrictEqual(pagesOnly.warnings.filter((w) => /appShell:/.test(w)), []);
});

function runCli(spec, extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-navigation-lint-'));
  const file = path.join(dir, 'app-spec.json');
  fs.writeFileSync(file, JSON.stringify(spec));
  try {
    const stdout = execFileSync(process.execPath, [CLI, '--spec', `@${file}`, '--json', ...extraArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, report: JSON.parse(stdout) };
  } catch (err) {
    return { code: err.status, report: JSON.parse(String(err.stdout || '{}')) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('lint-app-spec --strict fails on a navigation a new app cannot be built from, and says nothing of one it can', () => {
  const refused = specFor(SHAPES.find((s) => s.name === 'areas: []'));
  const plain = runCli(refused);
  assert.strictEqual(plain.code, 0, 'a warning alone does not fail');
  assert.ok(plain.report.warnings.some((w) => /^lint: appShell: the navigation has no entry/.test(w)), JSON.stringify(plain.report.warnings));
  const strict = runCli(refused, ['--strict']);
  assert.strictEqual(strict.code, 1);
  assert.strictEqual(strict.report.ok, false);
  // The spec carries other advice (no personas, no pages), so only the navigation's own warning is looked for.
  const fine = runCli(specFor(SHAPES.find((s) => s.name === 'a table entry')));
  assert.strictEqual(fine.code, 0, JSON.stringify(fine.report));
  assert.deepStrictEqual(fine.report.warnings.filter((w) => /appShell:/.test(w)), []);
});
