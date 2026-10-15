'use strict';
// The navigation check in the build, the dry run and the writes (lib/app-navigation.js, sdk-build.js).
//
// A new app is created with its navigation MINUS the pages, and Dataverse refuses to CREATE a sitemap with no non-empty
// area holding a non-empty group (HTTP 400). It accepts the same navigation when the sitemap of an app that already
// exists is UPDATED (measured), so only a new app is refused. A spec whose navigation is only pages, or has no entry at
// all, validates, so the build of a new app used to fail at the app step AFTER the solution, tables, views and forms
// were written. These tests drive the real engine (and the real CLI wrapper) with fakes that record EVERY call, and pin:
//   * each refused shape, in the dry run and on --apply, and that --apply wrote nothing before it halted;
//   * an existing app is spared the pages-only half, because its navigation is written once the pages exist, and the
//     empty half: it is built, with a warning that it is left with no navigation entries, in a run that writes one;
//   * a spec with no appShell.areas is refused for every app, since there is nothing to build the sitemap from;
//   * a run without the app step is not checked, and an app whose existence cannot be read warns and goes on;
//   * a valid navigation's plan and every request it makes are exactly what they were;
//   * existingAppSitemapIsWritten says what the engine does: the check never refuses a build that would have worked;
//   * a dry run that would stop says so in its summary line, with a live plan and without one;
//   * the order of the destructive gate and the navigation check for an app that exists.
// The shapes are in helpers/navigation-shapes.js, the fakes in helpers/navigation-fakes.js, the rule itself in
// app-navigation.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');

const { runSdkBuild, existingAppSitemapIsWritten, planFor, PHASES, BuildHalt } = require('../lib/sdk-build.js');
const { STAGES } = require('../lib/stages.js');
const { buildModelApp, isTransientHalt, discoverOpDiffState } = require('../build-model-app.js');
const { SHAPES, specFor } = require('./helpers/navigation-shapes.js');
const { writesIn, environment, pagesEnvironment, pageBackend, appFolder } = require('./helpers/navigation-fakes.js');

const shapeNamed = (name) => SHAPES.find((s) => s.name === name);
const refusedForNew = SHAPES.filter((s) => s.forNew === 'refuse');
// No appShell.areas: appDef throws on it before the app step asks whether the app exists, so no app of any kind is built from it.
const undeclared = SHAPES.filter((s) => s.kind === 'undeclared');
const onlyPages = SHAPES.filter((s) => s.kind === 'pages-only');
// A navigation with no entry: refused for a new app, built for one that exists. Whether the run writes the navigation to that app decides whether
// there is anything to say, so these are the shapes the run's phases matter to.
const emptyNavigations = SHAPES.filter((s) => s.kind === 'empty');
// Every shape the verdict depends on the app's existence for.
const dependsOnExistence = SHAPES.filter((s) => s.forUnknown === 'unknown');
const withPages = ['solution', 'data-model', 'app-shell', 'pages'];
const APP_LABEL = 'app module "Support Desk" + sitemap';
const appStep = (items) => items.find((p) => p.label === APP_LABEL);
const navigationWarnings = (warnings) => warnings.filter((w) => /could not be checked/.test(w));
const leftEmptyWarnings = (warnings) => warnings.filter((w) => /left with no navigation entries/.test(w));
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const navigationWrites = (calls) => calls.filter((c) => c[0] === 'updateElement' && c[1] === 'app' && c[3] === '/siteMap');
const entriesWritten = (write) => write[4].areas.flatMap((a) => a.groups.flatMap((g) => g.subAreas));

// What the message of a refusal says the navigation holds, for the shape.
function assertSaysWhatIsWrong(message, shape) {
  if (shape.kind === 'pages-only') assert.match(message, /the navigation holds only page entries/);
  else if (shape.kind === 'undeclared') assert.match(message, /the spec has no appShell\.areas, so there is no navigation to build the app with\./);
  else assert.ok(message.includes(`the navigation has no entry (${shape.said})`), `${shape.name}: ${message}`);
  // A spec with no appShell.areas never reaches Dataverse, so it quotes no refusal of the platform's.
  if (shape.kind !== 'undeclared') assert.match(message, /HTTP 400: "SiteMap needs to have a non-empty Area with a non-empty Group"/);
  assert.ok(message.includes("{ entity: '<table>', title: '<label>' }"), 'what to add');
}

// The warning that says what the build leaves an existing app with, for the shape.
function assertSaysWhatTheAppIsLeftWith(message, shape) {
  assert.ok(message.startsWith(`app "Support Desk": the navigation has no entry (${shape.said}), so the app is left with no navigation entries (any it has now are removed).`), message);
  assert.match(message, /Dataverse accepts an empty navigation when the navigation of an app that already exists is updated, so the build goes on\./);
}

// ── The dry run ──────────────────────────────────────────────────────────────────────────────────────────────────
for (const shape of refusedForNew) {
  test(`dry run, new app — ${shape.name}: the app step is the one that would stop the build, and says why`, async () => {
    const spec = specFor(shape);
    const env = environment({ app: 'absent' });
    const events = [];
    const warnings = [];
    const result = await runSdkBuild(spec, { sdk: env.sdk, apply: false, emit: (e) => events.push(e), warn: (m) => warnings.push(m) });
    const step = appStep(result.planItems);
    assert.strictEqual(step.state, 'unknown', 'marked as an item the live plan could not call create or reuse');
    assert.strictEqual(step.wouldHalt, true, 'and counted among the steps that would stop the build');
    assert.match(step.stateWhy, shape.kind === 'undeclared' ? /^the build would stop before writing anything: the spec has no appShell\.areas/ : /^the build would stop before writing anything: the navigation /);
    assertSaysWhatIsWrong(step.stateWhy, shape);
    assert.ok(result.plan.includes(`${APP_LABEL} [unknown]`));
    const line = events.find((e) => e.label === APP_LABEL);
    assert.strictEqual(line.state, 'unknown');
    assert.strictEqual(line.stateWhy, step.stateWhy, 'the printed plan line carries the reason');
    // Only that line changed: every other step is the one planFor lists, and none is marked.
    const planned = planFor(spec, { phases: PHASES, sampleData: false, publish: false }).map((p) => p.label);
    assert.deepStrictEqual(result.planItems.map((p) => p.label), planned);
    assert.deepStrictEqual(result.planItems.filter((p) => p.wouldHalt).map((p) => p.label), [APP_LABEL]);
    assert.deepStrictEqual(warnings, [], 'the app is known to be new, so there is nothing left to warn of');
    assert.deepStrictEqual(writesIn(env.calls), [], 'a dry run writes nothing');
  });
}

for (const shape of onlyPages) {
  test(`dry run, existing app — ${shape.name}: nothing stops the build, the pages are written once they exist`, async () => {
    const env = environment({ app: 'present' });
    const warnings = [];
    const result = await runSdkBuild(specFor(shape), { sdk: env.sdk, apply: false, warn: (m) => warnings.push(m) });
    const step = appStep(result.planItems);
    assert.strictEqual(step.state, 'reuse');
    assert.strictEqual(step.wouldHalt, undefined);
    assert.deepStrictEqual(warnings, []);
  });
}

for (const shape of undeclared) {
  test(`dry run, existing app — ${shape.name}: would stop the build, as it would for a new app, since there is no navigation to build the app with`, async () => {
    const env = environment({ app: 'present' });
    const result = await runSdkBuild(specFor(shape), { sdk: env.sdk, apply: false });
    const step = appStep(result.planItems);
    assert.strictEqual(step.wouldHalt, true);
    assertSaysWhatIsWrong(step.stateWhy, shape);
  });
}

test('dry run, existing app — no navigation is written to it when the pages phase is out of range and the spec has a page entry', async () => {
  // existingAppSitemapIsWritten: the app step writes nothing for a spec with a page entry, so there is nothing to refuse.
  const env = environment({ app: 'present' });
  const spec = specFor(shapeNamed('a navigation of pages only'));
  const result = await runSdkBuild(spec, { sdk: env.sdk, apply: false, phases: ['app-shell'] });
  assert.strictEqual(appStep(result.planItems).wouldHalt, undefined);
});

// Dataverse accepts an empty navigation when the sitemap of an app that exists is updated (measured), so the dry run does not stop the build there: the
// app step is the plain `reuse` line, and the maker is told, as a warning, that the app is left with no navigation entries. That holds for the run that
// writes the navigation through the pages finalizer (the whole build) and for the app step alone, which writes it itself from a spec with no page entry.
for (const shape of emptyNavigations) {
  for (const [which, phases] of [['the whole build', PHASES], ['the app step alone', ['app-shell']]]) {
    test(`dry run, existing app, ${which} — ${shape.name}: nothing stops the build, and the app is said to be left with no navigation entries`, async () => {
      const env = environment({ app: 'present' });
      const warnings = [];
      const result = await runSdkBuild(specFor(shape), { sdk: env.sdk, apply: false, phases, warn: (m) => warnings.push(m) });
      const step = appStep(result.planItems);
      assert.strictEqual(step.state, 'reuse');
      assert.strictEqual(step.wouldHalt, undefined, 'it is not one that would stop the build');
      assert.strictEqual(step.stateWhy, undefined);
      assert.deepStrictEqual(result.planItems.filter((p) => p.wouldHalt), []);
      assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
      assertSaysWhatTheAppIsLeftWith(warnings[0], shape);
      assert.deepStrictEqual(writesIn(env.calls), [], 'a dry run writes nothing');
    });
  }
}

// The one run with the pages phase that writes no navigation to an existing app: a changed-only re-upload, which skips the
// pages finalizer. The platform cannot refuse a write that is not made, and there is nothing to warn of either — for an
// existing app only; a new app is created with its first push whatever the re-upload writes.
const reupload = { selectedKeys: ['overview'], skipSitemapFinalize: true };
const emptyWithAPage = () => ({ ...shapeNamed('areas: []'), pages: ['overview'] });
test('dry run, a changed-only re-upload — an empty navigation is neither refused nor warned of for an existing app (nothing writes it there), and refused for a new one', async () => {
  const warnings = [];
  const existing = await runSdkBuild(specFor(emptyWithAPage()), { sdk: environment({ app: 'present' }).sdk, apply: false, phases: withPages, changedOnly: reupload, warn: (m) => warnings.push(m) });
  assert.strictEqual(appStep(existing.planItems).state, 'reuse');
  assert.strictEqual(appStep(existing.planItems).wouldHalt, undefined);
  assert.deepStrictEqual(warnings, [], 'nothing is written to the app, so there is nothing to say');
  const fresh = await runSdkBuild(specFor(emptyWithAPage()), { sdk: environment({ app: 'absent' }).sdk, apply: false, phases: withPages, changedOnly: reupload });
  assert.strictEqual(appStep(fresh.planItems).wouldHalt, true);
});

// Existence is the one thing the dry run reads for this, and it may not be able to: --no-live-plan, or a read that fails. A spec with no
// appShell.areas is refused all the same: no app of any kind is built from it, so the answer cannot change the verdict.
for (const shape of undeclared) {
  test(`dry run, existence unknown — ${shape.name}: refused all the same, since no app can be built from it`, async () => {
    const warnings = [];
    const spec = specFor(shape);
    const noLivePlan = await runSdkBuild(spec, { sdk: environment().sdk, apply: false, livePlan: false, warn: (m) => warnings.push(m) });
    assert.strictEqual(noLivePlan.livePlan, false);
    assert.strictEqual(appStep(noLivePlan.planItems).wouldHalt, true);
    const unreadable = await runSdkBuild(spec, { sdk: environment({ app: 'unreadable' }).sdk, apply: false, warn: (m) => warnings.push(m) });
    assert.strictEqual(appStep(unreadable.planItems).wouldHalt, true);
    assertSaysWhatIsWrong(appStep(unreadable.planItems).stateWhy, shape);
    assert.deepStrictEqual(navigationWarnings(warnings), []);
  });
}

// What the unknown answer says first is what the navigation holds, which differs by kind; the rest is the same.
const unknownAnswerStarts = (shape) => (shape.kind === 'pages-only' ? /^app "Support Desk": the navigation holds only page entries/ : /^app "Support Desk": the navigation has no entry/);

for (const shape of dependsOnExistence) {
  test(`dry run, existence unknown — ${shape.name}: not refused on the stricter rule; says what could not be checked`, async () => {
    const spec = specFor(shape);
    const warnings = [];
    const noLivePlan = await runSdkBuild(spec, { sdk: environment().sdk, apply: false, livePlan: false, warn: (m) => warnings.push(m) });
    assert.strictEqual(appStep(noLivePlan.planItems).wouldHalt, undefined);
    assert.strictEqual(appStep(noLivePlan.planItems).state, undefined, 'nothing was read, so nothing is claimed');
    assert.strictEqual(navigationWarnings(warnings).length, 1, JSON.stringify(warnings));
    assert.match(warnings[0], unknownAnswerStarts(shape));
    assert.match(warnings[0], /whether it exists could not be checked \(this dry run did not read the environment\)/);

    warnings.length = 0;
    const unreadable = await runSdkBuild(spec, { sdk: environment({ app: 'unreadable' }).sdk, apply: false, warn: (m) => warnings.push(m) });
    const step = appStep(unreadable.planItems);
    assert.strictEqual(step.state, 'unknown', 'the live plan could not read the app');
    assert.strictEqual(step.wouldHalt, undefined, 'and an unread app is not one that would stop the build');
    assert.match(step.stateWhy, /read refused \(HTTP 503\)/, 'its own reason is kept');
    assert.strictEqual(navigationWarnings(warnings).length, 1);
    assert.match(warnings[0], /could not be checked \(read refused \(HTTP 503\)\)/);
  });
}

test('dry run — a run without the app step is not checked: no line is marked, nothing is warned of, the app is not read', async () => {
  for (const phases of [STAGES.data, STAGES.ui, STAGES.publish, ['views', 'forms'], ['pages']]) {
    for (const shape of refusedForNew) {
      const env = environment({ app: 'absent' });
      const warnings = [];
      const result = await runSdkBuild(specFor(shape), { sdk: env.sdk, apply: false, phases, publish: true, warn: (m) => warnings.push(m) });
      assert.ok(!result.planItems.some((p) => p.wouldHalt), `${phases.join(',')} / ${shape.name}`);
      assert.ok(!result.planItems.some((p) => p.phase === 'app-shell'), 'the app step is not in the plan');
      assert.deepStrictEqual(warnings, []);
      assert.ok(!env.calls.some(([name, set]) => name === 'queryRecords' && set === 'appmodule'), 'the app is not read');
    }
  }
});

// What the CLI prints for the dry run: the summary counts the step among those that would stop the build, and does not then tell the maker to run it.
test('buildModelApp prints the plan line with its reason, and the summary counts it as one that would stop the build', async () => {
  const shape = shapeNamed('a navigation of pages only');
  const appDir = appFolder(shape.pages);
  try {
    const logs = [];
    const result = await buildModelApp(specFor(shape), { apply: false, env: 'https://contoso.example', appDir, livePlan: true }, { sdk: environment({ app: 'absent' }).sdk, log: (m) => logs.push(m) });
    assert.strictEqual(result.dryRun, true);
    assert.ok(logs.some((l) => /\? unknown app module "Support Desk" \+ sitemap — the build would stop before writing anything: the navigation holds only page entries/.test(l)), logs.join('\n'));
    assert.ok(logs.some((l) => /▢ dry run — .*\b1 would stop the build\b.*\(\d+ steps\)\. Fix the steps marked \? above, then re-run with --apply to execute\./.test(l)), logs.join('\n'));
    assert.ok(!logs.some((l) => /Re-run with --apply to execute/.test(l)), 'a dry run that would stop the build does not say to run it');

    const fine = [];
    await buildModelApp(specFor(shapeNamed('a table entry')), { apply: false, env: 'https://contoso.example', appDir, livePlan: true }, { sdk: environment({ app: 'absent' }).sdk, log: (m) => fine.push(m) });
    assert.ok(!fine.some((l) => /would stop the build/.test(l)), 'a valid navigation is not counted');
    assert.ok(fine.some((l) => /▢ dry run — .*\(\d+ steps\)\. Re-run with --apply to execute\./.test(l)), 'and its summary is the one it always was');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// With --no-live-plan nothing is read, but the check can still refuse a spec on its own (no appShell.areas): it marks the app step as one that would stop
// the build, and the spec-only summary has to count it. It used to print "N steps, spec-only … Re-run with --apply to execute." under that very line.
test('buildModelApp --no-live-plan: a step marked as one that would stop the build is counted in the spec-only summary, which does not say to run it', async () => {
  const appDir = appFolder([]);
  try {
    for (const shape of undeclared) {
      const logs = [];
      const result = await buildModelApp(specFor(shape), { apply: false, env: 'https://contoso.example', appDir, livePlan: false }, { sdk: environment().sdk, log: (m) => logs.push(m) });
      assert.strictEqual(result.dryRun, true);
      assert.strictEqual(result.livePlan, false, 'no live probe');
      assert.ok(logs.some((l) => /\? unknown app module "Support Desk" \+ sitemap — the build would stop before writing anything: the spec has no appShell\.areas/.test(l)), `${shape.name}: ${logs.join('\n')}`);
      assert.deepStrictEqual(logs.filter((l) => /▢ dry run —/.test(l)), [`\n▢ dry run — ${result.planItems.length} steps, spec-only (no live probe; --no-live-plan), 1 would stop the build. Fix the steps marked ? above, then re-run with --apply to execute.`], shape.name);
    }
    // A navigation that builds keeps the summary it always had.
    const fine = [];
    const result = await buildModelApp(specFor(shapeNamed('a table entry')), { apply: false, env: 'https://contoso.example', appDir, livePlan: false }, { sdk: environment().sdk, log: (m) => fine.push(m) });
    assert.deepStrictEqual(fine.filter((l) => /▢ dry run —/.test(l)), [`\n▢ dry run — ${result.planItems.length} steps, spec-only (no live probe; --no-live-plan). Re-run with --apply to execute.`]);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// ── --apply: refused before anything is written ─────────────────────────────────────────────────────────────────
for (const shape of refusedForNew) {
  test(`apply, new app — ${shape.name}: halts before the first write`, async () => {
    const env = environment({ app: 'absent' });
    const warnings = [];
    let halt;
    await assert.rejects(runSdkBuild(specFor(shape), { sdk: env.sdk, apply: true, warn: (m) => warnings.push(m) }), (e) => { halt = e; return true; });
    assert.ok(halt instanceof BuildHalt);
    assert.strictEqual(halt.code, 'app-navigation-empty');
    assert.strictEqual(halt.phase, 'preflight', 'before the first phase, as the view-filter pre-flight halts');
    assert.strictEqual(halt.recoverable, false);
    assert.strictEqual(halt.transient, false, 'never retried: a re-run reads the same spec');
    assert.strictEqual(isTransientHalt(halt), false);
    assert.match(halt.message, shape.kind === 'undeclared' ? /^app "Support Desk" cannot be built: the spec has no appShell\.areas/ : /^app "Support Desk" cannot be built: the navigation /);
    assert.match(halt.message, /The build stopped before writing anything\.$/);
    assertSaysWhatIsWrong(halt.message, shape);
    if (shape.kind === 'pages-only') {
      assert.match(halt.message, /A page entry joins the navigation only once its page exists, so a new app is created without them/);
      assert.match(halt.message, /A new app needs one entry that is not a page: add one to a group/);
    } else {
      assert.match(halt.message, /A new app needs one entry that is not a page/);
    }
    // Nothing was written, and the only thing read is the one fact the verdict needed: whether the app exists. A spec with no appShell.areas is refused
    // from the spec alone, since no answer could change that.
    assert.deepStrictEqual(writesIn(env.calls), []);
    assert.deepStrictEqual(env.calls, shape.kind === 'undeclared' ? [] : [['findArtifact', 'app', { uniqueName: 'new_supportdesk' }]]);
    assert.deepStrictEqual(warnings, []);
  });
}

for (const shape of undeclared) {
  test(`apply, existing app — ${shape.name}: halts before the first write, since there is no navigation to build the app with`, async () => {
    const appDir = appFolder([]);
    try {
      const env = pagesEnvironment({ existing: true });
      await assert.rejects(
        runSdkBuild(specFor(shape), { sdk: env.sdk, apply: true, env: 'https://contoso.example', appDir, genpage: pageBackend(), phases: withPages }),
        (e) => e instanceof BuildHalt && e.code === 'app-navigation-empty' && e.phase === 'preflight' && e.recoverable === false,
      );
      assert.deepStrictEqual(env.calls, [], 'refused from the spec alone, before anything was read or written');
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  });
}

// Dataverse accepts an empty navigation when the sitemap of an app that exists is updated (measured), so the build goes on and writes it — through the pages
// finalizer, or, without the pages phase, from the app step itself — and says the app is left with no entries. The verdict depends on whether the app exists, so
// the one read of that is the first call; the app step makes its own after it.
for (const shape of emptyNavigations) {
  for (const [which, phases] of [['the whole build', withPages], ['the app step alone', ['app-shell']]]) {
    test(`apply, existing app, ${which} — ${shape.name}: builds, writes the navigation with no entry in it, and says the app is left with none`, async () => {
      const appDir = appFolder([]);
      try {
        const env = pagesEnvironment({ existing: true });
        const warnings = [];
        const result = await runSdkBuild(specFor(shape), { sdk: env.sdk, apply: true, env: 'https://contoso.example', appDir, genpage: pageBackend(), phases, warn: (m) => warnings.push(m) });
        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(env.calls[0], ['findArtifact', 'app', { uniqueName: 'new_supportdesk' }]);
        const writes = navigationWrites(env.calls);
        assert.strictEqual(writes.length, 1, 'the navigation is written once');
        assert.deepStrictEqual(entriesWritten(writes[0]), [], 'with no entry in it');
        assert.strictEqual(leftEmptyWarnings(warnings).length, 1, JSON.stringify(warnings));
        assertSaysWhatTheAppIsLeftWith(warnings[0], shape);
      } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
    });
  }
}

test('apply, a changed-only re-upload — an empty navigation is neither refused nor warned of for an existing app (nothing writes it there), and refused for a new one', async () => {
  const shape = emptyWithAPage();
  const appDir = appFolder(shape.pages);
  try {
    const existing = pagesEnvironment({ existing: true });
    const warnings = [];
    const result = await runSdkBuild(specFor(shape), { sdk: existing.sdk, apply: true, env: 'https://contoso.example', appDir, genpage: pageBackend(), phases: withPages, changedOnly: reupload, warn: (m) => warnings.push(m) });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(existing.calls[0], ['findArtifact', 'app', { uniqueName: 'new_supportdesk' }], 'the verdict depends on whether the app exists, so that is read first');
    assert.deepStrictEqual(navigationWrites(existing.calls), [], 'and no navigation is written');
    assert.deepStrictEqual(leftEmptyWarnings(warnings), [], 'so there is nothing to say of what the app is left with');
    assert.deepStrictEqual(navigationWarnings(warnings), [], 'and the existence was read, so nothing is unchecked');

    const fresh = pagesEnvironment({ existing: false });
    await assert.rejects(
      runSdkBuild(specFor(shape), { sdk: fresh.sdk, apply: true, env: 'https://contoso.example', appDir, genpage: pageBackend(), phases: withPages, changedOnly: reupload }),
      (e) => e instanceof BuildHalt && e.code === 'app-navigation-empty',
    );
    assert.deepStrictEqual(writesIn(fresh.calls), []);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

for (const shape of onlyPages) {
  test(`apply, existing app — ${shape.name}: still builds, and its pages are written into the navigation once they exist`, async () => {
    const appDir = appFolder(shape.pages);
    try {
      const env = pagesEnvironment({ existing: true });
      const uploads = pageBackend();
      const result = await runSdkBuild(specFor(shape), { sdk: env.sdk, apply: true, env: 'https://contoso.example', appDir, genpage: uploads, phases: withPages });
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(uploads.uploads.slice().sort(), shape.pages.map((k) => k[0].toUpperCase() + k.slice(1)).sort(), 'every page was built');
      // One read of whether the app exists comes first (the check's); the app step makes its own after it.
      assert.deepStrictEqual(env.calls[0], ['findArtifact', 'app', { uniqueName: 'new_supportdesk' }]);
      const writes = env.calls.filter((c) => c[0] === 'updateElement' && c[1] === 'app' && c[3] === '/siteMap');
      assert.strictEqual(writes.length, 1, 'the pages finalizer writes the navigation once');
      const written = writes[0][4].areas.flatMap((a) => a.groups.flatMap((g) => g.subAreas));
      assert.deepStrictEqual(written.map((s) => s.type), shape.pages.map(() => 'GenPage'));
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  });
}

for (const shape of onlyPages) {
  test(`apply, new app — ${shape.name}: with a table entry beside the pages the same navigation builds, and the first push leaves the pages out`, async () => {
    const appDir = appFolder(shape.pages);
    try {
      const withTable = { ...shape, appShell: JSON.parse(JSON.stringify(shape.appShell)) };
      withTable.appShell.areas[0].groups[0].subAreas.push({ entity: 'new_customer', title: 'Customers' });
      const env = pagesEnvironment({ existing: false });
      const result = await runSdkBuild(specFor(withTable), { sdk: env.sdk, apply: true, env: 'https://contoso.example', appDir, genpage: pageBackend(), phases: withPages });
      assert.strictEqual(result.ok, true);
      const created = env.calls.find((c) => c[0] === 'createArtifact' && c[1] === 'app');
      assert.deepStrictEqual(created[2].siteMap.areas.flatMap((a) => a.groups.flatMap((g) => g.subAreas)).map((s) => s.type), ['Entity'], 'only the entry that is not a page is in the app as it is created');
      const finalized = env.calls.filter((c) => c[0] === 'updateElement' && c[1] === 'app' && c[3] === '/siteMap');
      assert.strictEqual(finalized.length, 1);
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  });
}

// The CLI wrapper reads the environment first (its own pre-flight), then hands the build to the engine.
test('buildModelApp --apply: the halt is raised once, not retried, journaled, and nothing is written', async () => {
  for (const shape of refusedForNew) {
    const appDir = appFolder(shape.pages || []);
    try {
      const env = environment({ app: 'absent' });
      const closed = [];
      let attempts = 0;
      const runBuild = (...args) => { attempts += 1; return runSdkBuild(...args); };
      await assert.rejects(
        buildModelApp(specFor(shape), { apply: true, env: 'https://contoso.example', appDir, profile: 'deploy', retryDelayMs: 0 }, { sdk: env.sdk, provisionSdk: env.sdk, runBuild, journal: { record() {}, close: (summary) => closed.push(summary) }, log: () => {}, sleep: async () => {} }),
        (e) => e instanceof BuildHalt && e.code === 'app-navigation-empty',
        shape.name,
      );
      assert.strictEqual(attempts, 1, `${shape.name}: a halt that is not transient is not run again`);
      assert.deepStrictEqual(writesIn(env.calls), [], `${shape.name}: the pre-flight and the check only read`);
      assert.strictEqual(closed.length, 1);
      assert.strictEqual(closed[0].status, 'halt');
      assert.strictEqual(closed[0].phase, 'preflight');
      assert.strictEqual(closed[0].code, 'app-navigation-empty');
      assert.strictEqual(closed[0].recoverable, false);
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  }
});

// ── A run without the app step is not checked ───────────────────────────────────────────────────────────────────
test('apply — a run without the app step is not checked: the data stage of every refused shape still builds', async () => {
  for (const phases of [STAGES.data, ['solution', 'data-model', 'views']]) {
    for (const shape of refusedForNew) {
      const env = environment({ app: 'absent' });
      const warnings = [];
      const result = await runSdkBuild(specFor(shape), { sdk: env.sdk, apply: true, phases, warn: (m) => warnings.push(m) });
      assert.strictEqual(result.ok, true, `${phases.join(',')} / ${shape.name}`);
      assert.ok(env.calls.some(([name]) => name === 'createSolution'), 'it went on and wrote');
      assert.ok(!env.calls.some(([name]) => name === 'findArtifact'), 'the app was not looked for');
      assert.deepStrictEqual(navigationWarnings(warnings), []);
    }
  }
});

test('apply — the app step alone is a run with the app step, so it is checked', async () => {
  const env = environment({ app: 'absent' });
  await assert.rejects(
    runSdkBuild(specFor(shapeNamed('areas: []')), { sdk: env.sdk, apply: true, phases: ['app-shell'] }),
    (e) => e instanceof BuildHalt && e.code === 'app-navigation-empty',
  );
  assert.deepStrictEqual(env.calls, [['findArtifact', 'app', { uniqueName: 'new_supportdesk' }]], 'the only thing it read is whether the app exists, and nothing was written');
});

// ── The app's existence cannot be read ──────────────────────────────────────────────────────────────────────────
for (const shape of dependsOnExistence) {
  test(`apply, existence unknown — ${shape.name}: not refused on the stricter rule; warns and goes on as it did before`, async () => {
    const env = environment({ app: 'unreadable-once' });
    const warnings = [];
    const result = await runSdkBuild(specFor(shape), { sdk: env.sdk, apply: true, phases: ['solution', 'data-model', 'app-shell'], warn: (m) => warnings.push(m) });
    assert.strictEqual(result.ok, true, 'the build went on');
    assert.ok(env.calls.some(([name]) => name === 'createSolution'), 'and wrote');
    assert.ok(env.calls.some(([name, kind]) => name === 'createArtifact' && kind === 'app'), 'as far as the app step, which is where a new app stops at the platform');
    const said = navigationWarnings(warnings);
    assert.strictEqual(said.length, 1, JSON.stringify(warnings));
    assert.match(said[0], unknownAnswerStarts(shape));
    assert.match(said[0], /whether it exists could not be checked \(read refused \(HTTP 503\)\)/);
    assert.match(said[0], /a new app would stop at the app step, after the tables are written/);
    assert.deepStrictEqual(env.calls[0], ['findArtifact', 'app', { uniqueName: 'new_supportdesk' }], 'the check read first, before any write');
  });
}

test('apply, existence unknown — a spec with no appShell.areas is refused without asking: no app of any kind is built from it', async () => {
  for (const shape of undeclared) {
    const env = environment({ app: 'unreadable' });
    await assert.rejects(runSdkBuild(specFor(shape), { sdk: env.sdk, apply: true }), (e) => e instanceof BuildHalt && e.code === 'app-navigation-empty', shape.name);
    assert.deepStrictEqual(env.calls, [], 'the answer would not change the verdict, so it is not read');
  }
});

// ── A valid navigation is untouched ─────────────────────────────────────────────────────────────────────────────
// Captured from the build as it was before the check existed (the same fakes and specs run against the previous
// engine), so these say the plan and every request a valid navigation makes are byte for byte what they were.
const GOLDEN = {
  applyNewTable: { calls: 14, sha: '8d09d30f974d3189825ec14438bdf6d1c00eb75b42088816b4b2bd6edd180d3b' },
  applyNewUrl: { calls: 14, sha: 'c90699cef67fb3ec65692205fe42d3c8fe69e0018b96841cbc72c7b8e350a9e9' },
  dryLive: { calls: 2, sha: '4234a3bee2b8281a5346821c9eae1218743fae1213c841574d43e43b08e23698' },
  applyNewBesidePages: { calls: 28, sha: '8ed8cfad18ed2b5eb59b29bc1ab9a9d023ad9c30ec8c7a69efe714ef14e7ab78' },
  // An EXISTING app now takes a changed name and description, so its fetched copy is read once more to compare them: one `getArtifact`
  // (a read of the workspace copy — no request to the environment) after the sitemap write. Captured again with the fake's deployed
  // app carrying the spec's own header; no other call of the sequence differs, and a new app's is exactly what it was.
  applyExistingBesidePages: { calls: 29, sha: '789bf9a2cdcc1c653fe49a6ff3f363ce73e7d9c255e916a5d810b74f57dd25e3' },
  // The same one added read (see above), here before the app step's own push of its sitemap and header.
  applyExistingAppStep: { calls: 24, sha: 'c57951fa58f2709965565258ed26693f6567e067b3b0099f36f4e8a59a237749' },
};

const calledSameAs = (calls, golden, what) => {
  assert.deepStrictEqual({ calls: calls.length, sha: digest(calls) }, golden, `${what}: the requests changed — ${JSON.stringify(calls.map((c) => c[0]))}`);
};

test('a valid navigation — a new app is built with exactly the requests it always was', async () => {
  const table = specFor(shapeNamed('a table entry'));
  const env = environment({ app: 'absent' });
  await runSdkBuild(table, { sdk: env.sdk, apply: true, phases: PHASES });
  // The first request is the solution lookup: the check asked nothing before it, and the app is looked up once, by the app step.
  assert.deepStrictEqual(env.calls.map(([name, kind]) => (name === 'queryRecords' || name === 'findArtifact' ? `${name}(${kind})` : name)), [
    'queryRecords(solution)', 'queryRecords(publisher)', 'createSolution', 'queryRecords(organization)', 'findTables', 'createTable', 'queryRecords(webresource)',
    'createWebResource', 'addSolutionComponent', 'findArtifact(app)', 'createArtifact', 'pushArtifact', 'addSolutionComponent', 'queryRecords(sitemap)',
  ]);
  calledSameAs(env.calls, GOLDEN.applyNewTable, 'table entry');

  const url = environment({ app: 'absent' });
  await runSdkBuild(specFor(shapeNamed('a url entry')), { sdk: url.sdk, apply: true, phases: ['solution', 'data-model', 'app-shell'] });
  calledSameAs(url.calls, GOLDEN.applyNewUrl, 'url entry');
});

test('a valid navigation — with pages beside the entry, a new app and an existing one are built with the requests they always were', async () => {
  const shape = shapeNamed('a table entry beside pages');
  for (const [existing, golden] of [[false, GOLDEN.applyNewBesidePages], [true, GOLDEN.applyExistingBesidePages]]) {
    const appDir = appFolder(shape.pages);
    try {
      const env = pagesEnvironment({ existing });
      await runSdkBuild(specFor(shape), { sdk: env.sdk, apply: true, env: 'https://contoso.example', appDir, genpage: pageBackend(), phases: withPages });
      calledSameAs(env.calls, golden, existing ? 'existing app' : 'new app');
      assert.strictEqual(env.calls.filter((c) => c[0] === 'findArtifact').length, 1, 'the app is looked up once, by the app step');
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  }
  const appStepOnly = pagesEnvironment({ existing: true });
  const appStepDir = appFolder([]);
  try {
    await runSdkBuild(specFor(shapeNamed('a table entry')), { sdk: appStepOnly.sdk, apply: true, appDir: appStepDir, phases: ['solution', 'data-model', 'app-shell'] });
  } finally { fs.rmSync(appStepDir, { recursive: true, force: true }); }
  calledSameAs(appStepOnly.calls, GOLDEN.applyExistingAppStep, 'existing app, app step only');
});

test('a valid navigation — the dry run plans, reads and prints exactly what it always did', async () => {
  const table = specFor(shapeNamed('a table entry'));
  const warnings = [];
  const live = environment({ app: 'absent' });
  const result = await runSdkBuild(table, { sdk: live.sdk, apply: false, phases: PHASES, warn: (m) => warnings.push(m) });
  assert.deepStrictEqual(result.plan, [
    'solution ContosoSD (publisher new)',
    'table new_customer ("Customer") [create]',
    'app module "Support Desk" + sitemap [create]',
    'app icon (generated) new_supportdesk_icon',
    'finalize sitemap (genpage subareas)',
  ]);
  assert.deepStrictEqual(result.planItems.filter((p) => p.wouldHalt || p.stateWhy), []);
  assert.deepStrictEqual(warnings, []);
  calledSameAs(live.calls, GOLDEN.dryLive, 'dry run, live plan');

  const existing = await runSdkBuild(table, { sdk: environment({ app: 'present' }).sdk, apply: false, phases: PHASES });
  assert.strictEqual(appStep(existing.planItems).state, 'reuse');
  const specOnly = await runSdkBuild(table, { sdk: environment().sdk, apply: false, livePlan: false, phases: PHASES });
  assert.deepStrictEqual(specOnly.plan, [
    'solution ContosoSD (publisher new)',
    'table new_customer ("Customer")',
    'app module "Support Desk" + sitemap',
    'app icon (generated) new_supportdesk_icon',
    'finalize sitemap (genpage subareas)',
  ]);
});

// ── existingAppSitemapIsWritten says what the engine does ───────────────────────────────────────────────────────
// The check speaks of an EXISTING app's empty navigation only when the run would write one to it, so it must know exactly
// when that is. Each case runs the real engine against an app that already exists and looks for the write.
const SCENARIOS = [
  { name: 'no pages phase, a spec with no page entry: the app step writes it', shape: 'a table entry', phases: ['solution', 'data-model', 'app-shell'], written: true },
  { name: 'no pages phase, a spec with a page entry: nothing writes it', shape: 'a table entry beside pages', phases: ['solution', 'data-model', 'app-shell'], written: false },
  { name: 'the pages phase, a spec with no page: the finalizer writes it', shape: 'a table entry', phases: withPages, written: true },
  { name: 'the pages phase, a spec with a page entry: the finalizer writes it', shape: 'a table entry beside pages', phases: withPages, written: true },
  { name: 'the pages phase in a changed-only re-upload: the finalizer is skipped', shape: 'a table entry beside pages', phases: withPages, changedOnly: { selectedKeys: ['overview'], skipSitemapFinalize: true }, written: false },
];
for (const scenario of SCENARIOS) {
  test(`existingAppSitemapIsWritten — ${scenario.name}`, async () => {
    const shape = shapeNamed(scenario.shape);
    const spec = specFor(shape);
    const appDir = appFolder(shape.pages || []);
    try {
      const env = pagesEnvironment({ existing: true });
      await runSdkBuild(spec, { sdk: env.sdk, apply: true, env: 'https://contoso.example', appDir, genpage: pageBackend(), phases: scenario.phases, changedOnly: scenario.changedOnly });
      const seen = env.calls.some((c) => c[0] === 'updateElement' && c[1] === 'app' && c[3] === '/siteMap');
      assert.strictEqual(seen, scenario.written, 'what the engine does');
      assert.strictEqual(existingAppSitemapIsWritten(spec, scenario.phases, scenario.changedOnly), seen, 'what the check believes it does');
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  });
}

// ── The destructive gate and the navigation check, for an app that exists ───────────────────────────────────────
// The CLI's destructive-operation gate (build-model-app.js) runs before the engine's navigation check. For an app that exists the check no longer refuses an
// emptied navigation (Dataverse accepts one on an update), so the gate's question — may the build remove the entries the app has — is the right one to ask
// first, and the only one: the maker is not asked to authorize a removal that the build then refuses. The navigation the check does refuse for every app is a
// spec with no appShell.areas, whose navigation the build never writes, so the gate must not ask about removing entries from it either: discoverOpDiffState
// reads the deployed navigation only for a spec that declares one.
const deployedNavigation = { areas: [{ id: 'area_0', title: 'Main', groups: [{ id: 'group_0_0', title: 'Records', subAreas: [{ id: 'sub_0_0_0', title: 'Customers', type: 'Entity', entity: 'new_customer' }] }] }] };

test('discoverOpDiffState lists the deployed entries as removed for an emptied navigation, and reads no navigation for a spec whose appShell has no areas', async () => {
  const emptied = await discoverOpDiffState(specFor(shapeNamed('areas: []')), pagesEnvironment({ existing: true, existingSitemap: deployedNavigation }).sdk);
  assert.deepStrictEqual(emptied.sitemap, { deployedTargets: ['entity:new_customer'], wantTargets: [] }, 'the removal is real: the build writes the empty navigation');
  const env = pagesEnvironment({ existing: true, existingSitemap: deployedNavigation });
  const noAreas = await discoverOpDiffState(specFor(shapeNamed('an appShell with no areas array')), env.sdk);
  assert.strictEqual(noAreas.sitemap, null, 'the build never writes a navigation for it, so there is nothing to authorize');
  assert.ok(!env.calls.some((c) => c[0] === 'fetchArtifact'), 'and the deployed one is not even read');
  assert.strictEqual(noAreas.collision.appExists, true, 'the rest of the discovery is as it was');
});

test('an existing app whose navigation the spec empties: the destructive gate asks first, since the removal is real — and then the build goes on and says what the app is left with', async () => {
  const shape = shapeNamed('areas: []');
  const appDir = appFolder([]);
  try {
    const env = pagesEnvironment({ existing: true, existingSitemap: deployedNavigation });
    const warnings = [];
    // Apply allows only the full build or the data stage; the fakes here cover the phases up to the pages.
    const runBuild = (spec, options) => runSdkBuild(spec, { ...options, phases: withPages });
    const deps = { sdk: env.sdk, provisionSdk: env.sdk, genpage: pageBackend(), runBuild, log: () => {}, warn: (m) => warnings.push(m) };
    const options = { apply: true, env: 'https://contoso.example', appDir, profile: 'deploy', retryDelayMs: 0 };

    const asked = await buildModelApp(specFor(shape), options, deps);
    assert.strictEqual(asked.ok, false);
    assert.ok(asked.errors.some((e) => /^refusing 1 destructive operation\(s\) without --allow-destructive:/.test(e) && /drops navigation target\(s\): entity:new_customer/.test(e)), JSON.stringify(asked.errors));
    assert.deepStrictEqual(writesIn(env.calls).filter(([name]) => name !== 'fetchArtifact'), [], 'nothing was written (fetchArtifact only copies the deployed app into the local workspace, for the gate to compare)');
    assert.deepStrictEqual(warnings, [], 'and the build never started');

    const approved = await buildModelApp(specFor(shape), { ...options, allowDestructive: true }, deps);
    assert.notStrictEqual(approved.ok, false, JSON.stringify(approved.errors));
    const writes = navigationWrites(env.calls);
    assert.strictEqual(writes.length, 1, 'the navigation was written');
    assert.deepStrictEqual(entriesWritten(writes[0]), [], 'with no entry in it, as the maker approved');
    assert.strictEqual(leftEmptyWarnings(warnings).length, 1, JSON.stringify(warnings));
    assertSaysWhatTheAppIsLeftWith(warnings[0], shape);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

test('an existing app with an appShell that has no areas is refused by the navigation check, and the destructive gate does not first ask to remove entries the build would never write', async () => {
  const shape = shapeNamed('an appShell with no areas array');
  const appDir = appFolder([]);
  try {
    const env = pagesEnvironment({ existing: true, existingSitemap: deployedNavigation });
    let attempts = 0;
    const runBuild = (spec, options) => { attempts += 1; return runSdkBuild(spec, { ...options, phases: withPages }); };
    await assert.rejects(
      buildModelApp(specFor(shape), { apply: true, env: 'https://contoso.example', appDir, profile: 'deploy', retryDelayMs: 0 }, { sdk: env.sdk, provisionSdk: env.sdk, genpage: pageBackend(), runBuild, log: () => {} }),
      (e) => e instanceof BuildHalt && e.code === 'app-navigation-empty' && /the spec has no appShell\.areas, so there is no navigation to build the app with\./.test(e.message),
    );
    assert.strictEqual(attempts, 1, 'the gate let the build through to the check, with no question about removals');
    assert.deepStrictEqual(writesIn(env.calls), [], 'and nothing was written');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});
