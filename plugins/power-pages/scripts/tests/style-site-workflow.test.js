'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture, heroFixture, ids } = require('./style-site-fixtures');
const { main } = require('../../skills/style-site/scripts/style-site-workflow');
const { main: inspect } = require('../../skills/style-site/scripts/inspect-style-context');
const { inspectSite, captureSite, snapshotText, hash } = require('../lib/classic-site-style-context');
const { preparePlan, preparePlanFromSnapshot } = require('../lib/style-site-plan');
const { reviewPlan, compactSummary, SUMMARY_BYTES } = require('../lib/style-site-summary');
const workflow = path.resolve(__dirname, '../../skills/style-site/scripts/style-site-workflow.js');

function requestFile(f, name = 'request.json') {
  const file = path.join(f.work, name);
  fs.writeFileSync(file, JSON.stringify(f.request));
  return file;
}

function draft(f, name = 'r1') {
  return main(['--operation', 'prepare', '--siteRoot', f.root, '--request', requestFile(f), '--out', path.join(f.work, name)]);
}

test('one command produces only a bounded exact proposal/review without site edits or rendering', (t) => {
  const f = fixture(t);
  const baseline = inspectSite(f.root);
  const result = draft(f);
  assert.equal(result.route.name, 'small-change');
  assert.equal(result.status, 'ready-for-review');
  assert.equal(result.contrastReview, 'not-triggered');
  assert.equal(result.truncated, false, 'The normal one-component review must stay compact.');
  assert.deepEqual(Object.keys(result.artifacts).sort(), ['plan', 'review']);
  assert.deepEqual(fs.readdirSync(path.dirname(result.artifacts.plan)).sort(), ['style-site.plan.json', 'style-site.review.json']);
  assert.ok(Buffer.byteLength(JSON.stringify(result, null, 2)) <= SUMMARY_BYTES);
  const plan = JSON.parse(fs.readFileSync(result.artifacts.plan));
  const review = JSON.parse(fs.readFileSync(result.artifacts.review));
  assert.equal(review.planHash, plan.planHash);
  assert.equal(review.studioSupport[0].properties[0].status, 'unknown');
  assert.ok(result.warnings.some((warning) => warning.includes('Studio Design-panel editability is unverified')));
  assert.equal(plan.schemaVersion, 2);
  assert.equal(Object.hasOwn(plan, 'preview'), false);
  assert.equal(review.studioRuntime, 'pending-separate-live-verification');
  assert.match(result.verification, /rendering is not verified/);
  assert.deepEqual(inspectSite(f.root).files, baseline.files);
  for (const change of review.changes) {
    const write = plan.writes.find((entry) => entry.path === change.path);
    const before = write.before || '';
    assert.equal(before.slice(change.start, change.start + change.deleteCount), change.removed);
    assert.equal(before.slice(0, change.start) + change.inserted + before.slice(change.start + change.deleteCount), write.after);
  }
});

test('color proposals flag readability review without producing HTML or a browser checker', (t) => {
  const f = heroFixture(t, { readable: true });
  const baseline = inspectSite(f.root);
  const result = draft(f);
  assert.equal(result.contrastReview, 'required-before-approval');
  assert.deepEqual(Object.keys(result.artifacts).sort(), ['plan', 'review']);
  assert.equal(JSON.parse(fs.readFileSync(result.artifacts.review)).contrastReview, result.contrastReview);
  assert.ok(Buffer.byteLength(JSON.stringify(result, null, 2)) + 1 <= SUMMARY_BYTES);
  assert.deepEqual(inspectSite(f.root).files, baseline.files);
});

test('coordinator CLI prints one JSON result and rejects the retired preview operation', (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [workflow, '--operation', 'prepare', '--siteRoot', f.root,
    '--request', requestFile(f), '--out', path.join(f.work, 'cli')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'ready-for-review');
  assert.ok(Buffer.byteLength(result.stdout) <= SUMMARY_BYTES);
  const invalid = spawnSync(process.execPath, [workflow, '--operation', 'upload'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).status, 'blocked');
  const legacy = spawnSync(process.execPath, [workflow, '--operation', 'preview', '--siteRoot', f.root,
    '--request', requestFile(f), '--out', path.join(f.work, 'legacy')], { encoding: 'utf8' });
  assert.equal(legacy.status, 1);
  assert.match(JSON.parse(legacy.stderr).message, /prepare or apply.*removed/);
  assert.equal(fs.existsSync(path.join(f.work, 'legacy')), false);
});

test('apply requires the exact revision and runs fresh independent verification', (t) => {
  const f = fixture(t);
  const result = draft(f);
  const receipt = path.join(f.work, 'receipt.json');
  const args = ['--operation', 'apply', '--plan', result.artifacts.plan, '--receipt', receipt];
  assert.throws(() => main(args), /approvedHash/);
  assert.throws(() => main([...args, '--approvedHash', 'wrong']), /approval/);
  assert.equal(fs.existsSync(receipt), false);
  const applied = main([...args, '--approvedHash', result.planHash]);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.verification.status, 'verified-local-files');
  assert.equal(JSON.parse(fs.readFileSync(receipt)).status, 'applied');
});

for (const options of [{ major: 3, prefix: 'adx_' }, { major: 5, prefix: '', nested: true, wrapped: true }]) {
  for (const scope of ['site', 'section']) {
    for (const create of [false, true]) {
      test(`${create ? 'new' : 'existing'} ${scope} Web File applies with theme 9/basic 10 (Bootstrap ${options.major})`, (t) => {
        const f = fixture(t, options);
        f.setDisplayOrder('theme.css', 9);
        f.setDisplayOrder('portalbasictheme.css', 10);
        f.setDisplayOrder('bootstrap.min.css', undefined);
        const parentId = scope === 'site' ? ids.home : ids.section;
        if (scope === 'section') {
          f.request.pageId = ids.sectionLocale;
          f.request.components[0].sourcePath = 'web-pages/contact/content-pages/Contact.en-US.webpage.copy.html';
          f.put(f.request.components[0].sourcePath, '<section class="pp-card">Contact team</section>');
        }
        const sunriseId = '88888888-8888-4888-8888-888888888888';
        const sunrisePath = options.nested ? 'web-files/SunriseTheme.css/SunriseTheme.css' : 'web-files/SunriseTheme.css';
        if (!create) {
          f.put(sunrisePath, '/* Keep SunriseTheme content. */\n');
          f.put(`${sunrisePath}.webfile.yml`, f.yml('webfile', {
            id: sunriseId, name: 'SunriseTheme.css', partialurl: 'SunriseTheme.css',
            parentpageid: parentId, publishingstateid: ids.state, displayorder: 200,
          }) + 'filename: SunriseTheme.css\nmimetype: text/css\nisdocument: true\n');
        }
        Object.assign(f.request.styles[0], { scope,
          ...(scope === 'section' ? { parentPageId: parentId } : {}),
          ...(create ? { fileName: 'sunrise-theme.css' } : { targetId: sunriseId }) });
        f.request.styles.push({ ...f.request.styles[0], id: 'card-spacing', declarations: { padding: '16px' } });
        const baseline = inspectSite(f.root);
        const prepared = draft(f);
        const plan = JSON.parse(fs.readFileSync(prepared.artifacts.plan));
        const review = JSON.parse(fs.readFileSync(prepared.artifacts.review));
        assert.deepEqual(inspectSite(f.root).files, baseline.files, 'Preparation never writes the site.');
        assert.equal(plan.bootstrap.major, options.major);
        const notes = plan.warnings.filter((warning) => warning.includes('Advisory CSS Web File priority'));
        assert.equal(notes.length, 1, 'Multiple style groups in one Web File share one advisory note.');
        assert.match(notes[0], /higher priority than theme\.css and lower priority than portalbasictheme\.css/);
        assert.match(notes[0], /not a displayorder check or write prerequisite/);
        assert.ok(review.warnings.includes(notes[0]));
        assert.ok(prepared.warnings.includes(notes[0]));
        const css = plan.writes.find((write) => write.kind === 'css');
        assert.ok(notes[0].startsWith(`${css.path}:`));
        if (!create) assert.equal(css.path, sunrisePath);
        for (const metadata of plan.writes.filter((write) => write.kind === 'webfile')) {
          assert.equal(metadata.before, null);
          assert.doesNotMatch(metadata.after, /displayorder:/);
        }
        const applied = main(['--operation', 'apply', '--plan', prepared.artifacts.plan,
          '--approvedHash', prepared.planHash, '--receipt', path.join(f.work, 'receipt.json')]);
        assert.equal(applied.status, 'applied');
        assert.equal(applied.verification.status, 'verified-local-files');
        assert.ok(applied.warnings.includes(notes[0]));
        const after = inspectSite(f.root);
        assert.equal(fs.readFileSync(path.join(f.root, css.path), 'utf8'), css.after);
        for (const file of baseline.files.filter((entry) => entry.path !== css.path)) {
          assert.deepEqual(after.files.find((entry) => entry.path === file.path), file,
            `Unrelated source, existing metadata and defaults must remain unchanged: ${file.path}`);
        }
        const repeated = main(['--operation', 'apply', '--plan', prepared.artifacts.plan,
          '--approvedHash', prepared.planHash, '--receipt', path.join(f.work, 'repeat-receipt.json')]);
        assert.equal(repeated.status, 'already-applied');
        assert.equal(repeated.verification.status, 'verified-local-files');
        assert.ok(repeated.warnings.includes(notes[0]));
      });
    }
  }
}

test('page CSS and inline edits with no display-order metadata get no Web File advisory', (t) => {
  for (const location of ['stylesheet', 'inline']) {
    const f = fixture(t);
    for (const name of Object.keys(f.assets)) f.setDisplayOrder(name, undefined);
    Object.assign(f.request.styles[0], { location, ...(location === 'inline' ? { inlineTarget: '<section class="pp-card">' } : {}) });
    const prepared = draft(f);
    const applied = main(['--operation', 'apply', '--plan', prepared.artifacts.plan,
      '--approvedHash', prepared.planHash, '--receipt', path.join(f.work, 'receipt.json')]);
    assert.equal(applied.verification.status, 'verified-local-files');
    for (const result of [prepared, applied]) {
      assert.ok(!result.warnings.some((warning) => warning.includes('Advisory CSS Web File priority')));
    }
  }
});

test('drift after writing is reported independently with the recovery receipt', (t) => {
  const f = fixture(t);
  const result = draft(f);
  const receipt = path.join(f.work, 'receipt.json');
  const writeFile = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, content, ...args) => {
    const output = writeFile(file, content, ...args);
    if (file === receipt && String(content).includes('"status": "applied"')) {
      writeFile(path.join(f.root, f.assets['theme.css'].path), '/* concurrent Studio edit */');
    }
    return output;
  });
  assert.throws(() => main(['--operation', 'apply', '--plan', result.artifacts.plan, '--approvedHash', result.planHash, '--receipt', receipt]),
    /Independent verification failed.*receipt/);
  assert.equal(JSON.parse(fs.readFileSync(receipt)).status, 'applied');
});

test('revised requests require fresh review artifacts and never reuse old approval', (t) => {
  const f = fixture(t);
  const first = draft(f);
  const old = JSON.parse(fs.readFileSync(first.artifacts.plan));
  old.request.styles[0].declarations['border-radius'] = '24px';
  const file = path.join(f.work, 'revised-request.json');
  fs.writeFileSync(file, JSON.stringify(old.request));
  const second = main(['--operation', 'prepare', '--siteRoot', f.root, '--request', file, '--out', path.join(f.work, 'r2')]);
  assert.notEqual(first.planHash, second.planHash);
  assert.equal(JSON.parse(fs.readFileSync(first.artifacts.plan)).planHash, first.planHash);
  assert.throws(() => main(['--operation', 'apply', '--plan', second.artifacts.plan, '--approvedHash', first.planHash, '--receipt', path.join(f.work, 'r2-receipt.json')]), /approval/);
  assert.throws(() => draft(f), /already exists/);
  assert.throws(() => main(['--operation', 'prepare', '--siteRoot', f.root, '--request', file, '--out', path.join(f.root, 'r3')]), /outside/);
});

test('shared scope, templates, new CSS and Studio-only requests use expanded review', (t) => {
  const f = fixture(t);
  Object.assign(f.request.styles[0], { scope: 'site', targetId: f.assets['custom.css'].id });
  assert.equal(draft(f).route.name, 'expanded');
  f.request.styles[0] = { ...f.request.styles[0], owner: 'studio', handoffReason: 'user-requested', studioAction: 'Set background in Studio.' };
  delete f.request.components[0].sourcePath;
  const result = draft(f, 'studio');
  assert.equal(result.route.name, 'expanded');
  const applied = main(['--operation', 'apply', '--plan', result.artifacts.plan, '--approvedHash', result.planHash, '--receipt', path.join(f.work, 'studio-receipt.json')]);
  assert.equal(applied.status, 'no-local-changes');
  assert.equal(applied.verification.status, 'verified-local-files');
});

test('guarded page class additions stay eligible and expose exact replacement bytes', (t) => {
  const f = fixture(t);
  f.request.components[0].className = 'pp-hero';
  f.request.classEdits = [{ path: f.copyPath, match: '<section class="pp-card">', className: 'pp-hero' }];
  const review = reviewPlan(preparePlan(f.root, f.request));
  assert.equal(review.route.name, 'small-change');
  const change = review.changes.find((entry) => entry.kind === 'class');
  assert.equal(change.inserted, ' pp-hero');
  assert.equal(change.removed, '');
});

test('compact evidence resolves only explicit pages and static ID/class candidates', (t) => {
  const f = fixture(t);
  const output = path.join(f.work, 'inspection.json');
  const result = inspect(['--siteRoot', f.root, '--summary', '--out', output, '--pageId', ids.locale, '--target', '.pp-card']);
  assert.equal(result.selectedPageId, ids.locale);
  assert.equal(result.counts.targets, 1);
  assert.equal(result.targets[0].sourcePath, f.copyPath);
  assert.ok(!Object.hasOwn(result, 'files'));
  assert.deepEqual(JSON.parse(fs.readFileSync(output)).files, inspectSite(f.root).files);
  assert.throws(() => inspect(['--siteRoot', f.root, '--out', output]), /EEXIST/);
  assert.throws(() => inspect(['--siteRoot', f.root, '--out', path.join(f.root, 'context.json')]), /outside/);
  const filtered = inspect(['--siteRoot', f.root, '--summary', '--page', 'Start']);
  assert.equal(filtered.selectedPageId, null, 'Root and localized page must not be silently conflated.');
  assert.equal(filtered.counts.matchingPages, 2);
  assert.throws(() => inspect(['--siteRoot', f.root, '--summary', '--target', '.pp-card']), /page/);
  assert.throws(() => inspect(['--siteRoot', f.root, '--pageId', ids.locale, '--target', 'section .pp-card']), /literal/);
  assert.throws(() => inspect(['--siteRoot', f.root, '--pageId', 'unknown']), /No matching/);
});

test('inspection lists applicable CSS by path without treating displayorder or ancestry as priority', (t) => {
  const f = fixture(t);
  const sectionPath = 'web-files/a-section.css';
  f.put(sectionPath, '/* Section-only CSS. */');
  f.put(`${sectionPath}.webfile.yml`, f.yml('webfile', {
    id: '88888888-8888-4888-8888-888888888888', name: 'a-section.css',
    partialurl: 'a-section.css', parentpageid: ids.section, displayorder: 999,
  }) + 'filename: a-section.css\nmimetype: text/css\nisdocument: true\n');
  const args = ['--siteRoot', f.root, '--summary', '--pageId', ids.sectionLocale];
  const before = inspect(args);
  const paths = before.css.map((file) => file.path);
  assert.deepEqual(paths, [...paths].sort((a, b) => a.localeCompare(b)));
  assert.equal(paths[0], sectionPath, 'Ancestry and the value 999 must not move this file within the inventory.');
  assert.match(before.cssInventoryNote, /not runtime load order/);
  assert.match(before.cssInventoryNote, /displayorder metadata only, not CSS priority/);
  const context = inspectSite(f.root);
  assert.match(context.warnings.join('\n'), /displayorder does not establish CSS priority/);
  assert.match(context.warnings.join('\n'), /local styling does not require live checks/);
  assert.doesNotMatch(context.warnings.join('\n'), /order is inferred from exported metadata/);
  f.setDisplayOrder('theme.css', 9);
  f.setDisplayOrder('portalbasictheme.css', 10);
  f.setDisplayOrder('custom.css', -1);
  f.setDisplayOrder('bootstrap.min.css', undefined);
  const after = inspect(args);
  assert.deepEqual(after.css.map((file) => file.path), paths);
  assert.equal(after.css.find((file) => file.path === f.assets['custom.css'].path).order, -1);
  assert.equal(after.css.find((file) => file.path === f.assets['bootstrap.min.css'].path).order, null);
  const root = inspect(['--siteRoot', f.root, '--summary', '--pageId', ids.locale]);
  assert.ok(!root.css.some((file) => file.path === sectionPath), 'Ancestor pages do not inherit descendant Web Files.');
});

test('summary stays below 4 KB for a large inventory and discloses omitted evidence', (t) => {
  const f = fixture(t);
  for (let index = 0; index < 250; index += 1) {
    f.put(`web-pages/p${index}/Page.webpage.yml`, f.yml('webpage', {
      id: `88888888-8888-4888-8888-${String(index).padStart(12, '0')}`,
      name: `Page ${index}`, parentpageid: ids.home, partialurl: `p${index}`,
    }));
  }
  const result = inspect(['--siteRoot', f.root, '--summary', '--out', path.join(f.work, 'large.json')]);
  assert.equal(result.counts.matchingPages, 254);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result, null, 2)) <= SUMMARY_BYTES);
  assert.equal(JSON.parse(fs.readFileSync(result.artifact)).pages.length, 254);
  const bigReview = compactSummary({ planHash: 'a'.repeat(64), changes: [{ inserted: 'x'.repeat(20000) }], artifacts: { review: 'review.json' } });
  assert.equal(bigReview.truncated, true);
  assert.equal(bigReview.artifacts.review, 'review.json');
});

test('structural runtime evidence is bounded separately from the complete external capture', (t) => {
  const f = fixture(t);
  const snapshot = {
    schemaVersion: 1, source: 'runtime-dom', pageUrl: 'https://contoso.powerappsportals.com/',
    queryOmitted: false, capturedAt: '2026-01-01T00:00:00.000Z', rootSelector: 'main',
    scannedElements: 20, truncated: true, omittedBoundaries: 2, mode: 'structure', properties: [],
    candidates: Array.from({ length: 10 }, (_, index) => ({
      id: `runtime-${index + 1}`, tag: 'section', kind: 'card', domId: null,
      classes: ['pp-card'], attributesOmitted: false, locator: `section:nth-of-type(${index + 1})`, computedStyles: {},
    })),
  };
  const capture = path.join(f.work, 'runtime.json');
  fs.writeFileSync(capture, JSON.stringify(snapshot));
  const result = inspect(['--siteRoot', f.root, '--summary', '--out', path.join(f.work, 'context.json'),
    '--pageId', ids.locale, '--runtimeSnapshot', capture, '--target', '.pp-card']);
  assert.equal(result.runtime.pageUrl, snapshot.pageUrl);
  assert.equal(result.runtime.candidateCount, 10);
  assert.equal(result.runtime.mode, 'structure');
  assert.equal(result.runtime.truncated, true);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result, null, 2)) + 1 <= SUMMARY_BYTES);
  const full = JSON.parse(fs.readFileSync(result.artifact)).runtime;
  assert.equal(full.candidates.length, 10);
  assert.deepEqual(full.candidates[0].computedStyles, {});
  assert.equal(full.candidates[0].sourceStatus, 'candidate-match');
  assert.equal(full.candidates[0].sourceMatches[0].path, f.copyPath);
});

test('captured snapshots cannot be mutated, deserialized or reused to bypass a fresh preflight', (t) => {
  const f = fixture(t);
  const snapshot = captureSite(f.root);
  assert.throws(() => { snapshot.context.files[0].hash = 'fake'; }, /read only/);
  assert.throws(() => preparePlanFromSnapshot(structuredClone(snapshot), f.request), /in-process/);
  const original = snapshotText(snapshot, f.cssPath);
  f.put(f.cssPath, '/* later edit */');
  assert.equal(snapshotText(snapshot, f.cssPath), original);
  const stale = preparePlanFromSnapshot(snapshot, f.request);
  const planFile = path.join(f.work, 'stale.json');
  fs.writeFileSync(planFile, JSON.stringify(stale));
  assert.throws(() => main(['--operation', 'apply', '--plan', planFile, '--approvedHash', stale.planHash, '--receipt', path.join(f.work, 'receipt.json')]), /Source changed/);
  assert.equal(hash(original), stale.inputs.find((input) => input.path === f.cssPath).hash);
});

test('combined prepare/apply uses four full reads, keeping both preflights and independent verification', (t) => {
  const f = fixture(t);
  const inputCount = inspectSite(f.root).files.length;
  const read = fs.readFileSync;
  let siteReads = 0;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (typeof file === 'string' && file.startsWith(f.root + path.sep)) siteReads += 1;
    return read(file, ...args);
  });
  const result = draft(f);
  assert.equal(siteReads, inputCount, 'Preparation consumes one consistent CSS/source snapshot.');
  main(['--operation', 'apply', '--plan', result.artifacts.plan, '--approvedHash', result.planHash, '--receipt', path.join(f.work, 'receipt.json')]);
  assert.equal(siteReads, inputCount * 4 + 2, 'Two fresh preflights, one independent scan, and two last-moment target checks.');
});
