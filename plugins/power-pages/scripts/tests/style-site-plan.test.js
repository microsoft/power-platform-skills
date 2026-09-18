const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, ids } = require('./style-site-fixtures');
const { preparePlan, validatePlan, compileStyles, replaceBlock, addClass, planHash } = require('../lib/style-site-plan');
const { main } = require('../../skills/style-site/scripts/prepare-style-plan');

test('prepares exact localized page CSS without changing baseline or site files', (t) => {
  const f = fixture(t);
  const plan = preparePlan(f.root, f.request);
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].path, f.cssPath);
  assert.match(plan.writes[0].after, /\.pp-card \{/);
  assert.match(plan.writes[0].after, /Keep this existing rule/);
  assert.doesNotMatch(fs.readFileSync(path.join(f.root, f.cssPath), 'utf8'), /power-pages:style-site/);
  assert.equal(validatePlan(plan), plan);
  assert.equal(preparePlan(f.root, f.request).planHash, plan.planHash);
  assert.equal(plan.schemaVersion, 2);
  assert.equal(Object.hasOwn(plan, 'preview'), false);
  assert.deepEqual(plan.placements[0].affectedPageIds, [ids.locale]);
  assert.equal(JSON.stringify(plan).includes('<h2>'), false, 'Unchanged source HTML is not copied into proposals.');
});

test('reuses shared CSS and discloses inherited pages', (t) => {
  const f = fixture(t);
  Object.assign(f.request.styles[0], { scope: 'site', targetId: f.assets['custom.css'].id });
  const plan = preparePlan(f.root, f.request);
  assert.equal(plan.writes[0].path, f.assets['custom.css'].path);
  assert.ok(plan.placements[0].affectedPageIds.includes(ids.sectionLocale));
  assert.match(plan.writes[0].after, /\.pp-card/);
  assert.equal(plan.writes.length, 1, 'Default stylesheets and page markup are unchanged.');
});

for (const options of [{ prefix: 'adx_' }, { prefix: '', nested: true, major: 5 }]) {
  test(`creates correctly shaped CSS metadata (${JSON.stringify(options)})`, (t) => {
    const f = fixture(t, options);
    Object.assign(f.request.styles[0], { scope: 'site', fileName: 'service-cards.css' });
    const plan = preparePlan(f.root, f.request);
    const metadata = plan.writes.find((write) => write.kind === 'webfile');
    assert.doesNotMatch(metadata.after, /displayorder:/);
    assert.match(metadata.after, /mimetype: text\/css/);
    assert.match(metadata.path, options.nested ? /service-cards\.css\/service-cards\.css\.webfile\.yml$/ : /^web-files\/service-cards\.css\.webfile\.yml$/);
    assert.equal(plan.writes.find((write) => write.kind === 'css').path, metadata.path.replace(/\.webfile\.yml$/, ''));
    assert.match(metadata.after, new RegExp(`^${options.prefix}parentpageid: ${ids.home}$`, 'm'));
    assert.equal(preparePlan(f.root, f.request, plan.allocatedIds).planHash, plan.planHash);
  });
}

test('Studio-only proposal preserves native values and handoff instructions without local CSS writes', (t) => {
  const f = fixture(t);
  Object.assign(f.request.styles[0], { owner: 'studio', handoffReason: 'user-requested', studioAction: 'Use the component paintbrush to set the corner radius.' });
  delete f.request.components[0].sourcePath;
  const plan = preparePlan(f.root, f.request);
  assert.deepEqual(plan.writes, []);
  assert.equal(plan.request.styles[0].declarations['border-radius'], '12px');
  assert.equal(plan.placements[0].action, f.request.styles[0].studioAction);
  assert.deepEqual(compileStyles(f.request), []);
});

test('guarded class additions preserve Studio attributes and do not duplicate', (t) => {
  const f = fixture(t);
  f.put(f.copyPath, '<section class="sectionBlockLayout" data-component-theme="portalThemeColor1"><h2>Hello</h2></section>');
  f.request.classEdits = [{ path: f.copyPath, match: '<section class="sectionBlockLayout" data-component-theme="portalThemeColor1">', className: 'pp-card' }];
  const plan = preparePlan(f.root, f.request);
  const html = plan.writes.find((write) => write.kind === 'class');
  assert.match(html.after, /class="sectionBlockLayout pp-card" data-component-theme="portalThemeColor1"/);
  assert.equal(addClass(html.after, f.request.classEdits[0]), html.after);
  assert.throws(() => addClass(html.before + html.before, f.request.classEdits[0]), /exactly one/);
  assert.throws(() => addClass('', { match: '<div class="{{ name }}">', className: 'pp-card' }), /Liquid/);
});

test('managed blocks preserve line endings and unrelated bytes', () => {
  const initial = '/* existing */\r\n.a { color: red; }\r\n';
  const once = replaceBlock(initial, 'shape', '.pp-card {\n  border-radius: 8px;\n}');
  assert.ok(once.startsWith(initial));
  assert.equal(replaceBlock(once, 'shape', '.pp-card {\n  border-radius: 8px;\n}'), once);
  assert.throws(() => replaceBlock(once + once, 'shape', 'x'), /Ambiguous/);
});

test('refuses default CSS, root instead of localized page, unsafe values and unknown Bootstrap', (t) => {
  const f = fixture(t);
  f.request.styles[0].declarations.color = 'red; background: url(https://example.invalid)';
  assert.throws(() => preparePlan(f.root, f.request), /CSS validation/);
  delete f.request.styles[0].declarations.color;
  f.request.pageId = ids.home;
  assert.throws(() => preparePlan(f.root, f.request), /localized/);
  f.request.pageId = ids.locale;
  Object.assign(f.request.styles[0], { scope: 'site', targetId: f.assets['theme.css'].id });
  assert.throws(() => preparePlan(f.root, f.request), /custom CSS/);
  f.put(f.assets['bootstrap.min.css'].path, '/* unversioned */');
  assert.throws(() => preparePlan(f.root, f.request), /Bootstrap/);
});

test('tampered managed CSS cannot pass by recalculating only the plan hash', (t) => {
  const f = fixture(t);
  const plan = preparePlan(f.root, f.request);
  plan.writes[0].after += '\nbody { display: none; }';
  plan.writes[0].afterHash = require('../lib/classic-site-style-context').hash(plan.writes[0].after);
  plan.planHash = planHash(plan);
  assert.throws(() => validatePlan(plan), /outside its declared/);
});

test('plan warnings must remain a string array for review and apply output', (t) => {
  const f = fixture(t);
  const plan = preparePlan(f.root, f.request);
  for (const warnings of [undefined, null, 'not an array', [null], [{}]]) {
    const invalid = { ...plan, warnings };
    invalid.planHash = planHash(invalid);
    assert.throws(() => validatePlan(invalid), /Invalid plan context/);
  }
});

test('prepare CLI saves only external new proposal files', (t) => {
  const f = fixture(t);
  const requestPath = path.join(f.work, 'request.json');
  fs.writeFileSync(requestPath, JSON.stringify(f.request));
  const out = path.join(f.work, 'plan.json');
  assert.match(main(['--siteRoot', f.root, '--request', requestPath, '--out', out]).planHash, /^[0-9a-f]{64}$/);
  assert.throws(() => main(['--siteRoot', f.root, '--request', requestPath, '--out', out]), /EEXIST/);
  assert.throws(() => main(['--siteRoot', f.root, '--request', requestPath, '--out', path.join(f.root, 'plan.json')]), /outside/);
});

test('does not treat class text in scripts/comments as a component hook', (t) => {
  const f = fixture(t);
  f.put(f.copyPath, '<!-- <div class="pp-card"> -->\n<script>const name = "pp-card";</script>');
  assert.throws(() => preparePlan(f.root, f.request), /scoped class/);
});

test('Studio-only changes cannot smuggle class edits into local source', (t) => {
  const f = fixture(t);
  Object.assign(f.request.styles[0], { owner: 'studio', handoffReason: 'user-requested', studioAction: 'Use Studio.' });
  f.request.classEdits = [{ path: f.copyPath, match: '<section class="pp-card">', className: 'pp-card' }];
  assert.throws(() => preparePlan(f.root, f.request), /Studio-only/);
});

test('section CSS discloses its subtree and priority without allocating display order', (t) => {
  const f = fixture(t);
  f.request.pageId = ids.sectionLocale;
  const copyPath = 'web-pages/contact/content-pages/Contact.en-US.webpage.copy.html';
  f.put(copyPath, '<section class="pp-card">Contact team</section>');
  f.request.components[0].sourcePath = copyPath;
  Object.assign(f.request.styles[0], { scope: 'section', parentPageId: ids.section, fileName: 'contact-cards.css' });
  const plan = preparePlan(f.root, f.request);
  assert.deepEqual(plan.placements[0].affectedPageIds.sort(), [ids.section, ids.sectionLocale].sort());
  assert.equal(plan.placements[0].path, 'web-files/contact-cards.css');
  assert.doesNotMatch(plan.writes.find((write) => write.kind === 'webfile').after, /displayorder:/);
  assert.match(plan.warnings.join('\n'), /Advisory CSS Web File priority/);
  assert.ok(plan.writes.every((write) => !write.path.includes('portalbasictheme')));
});

test('multiple new custom files do not allocate display-order slots', (t) => {
  const f = fixture(t);
  Object.assign(f.request.styles[0], { scope: 'site', fileName: 'cards.css' });
  f.request.styles.push({ ...f.request.styles[0], id: 'card-color', fileName: 'colors.css', declarations: { color: '#123456' } });
  const plan = preparePlan(f.root, f.request);
  const metadata = plan.writes.filter((write) => write.kind === 'webfile');
  assert.equal(metadata.length, 2);
  for (const write of metadata) assert.doesNotMatch(write.after, /displayorder:/);
  assert.equal(plan.warnings.filter((warning) => warning.includes('Advisory CSS Web File priority')).length, 2);
});

test('refuses direct edits to generated CSS instead of introducing a new compiler', (t) => {
  const f = fixture(t);
  Object.assign(f.request.styles[0], { scope: 'site', targetId: f.assets['custom.css'].id });
  f.put('web-files/custom.scss', '.pp-card { border-radius: 4px; }');
  assert.throws(() => preparePlan(f.root, f.request), /source-owned/);
});

test('different scopes cannot overwrite the same pending CSS/metadata path', (t) => {
  const f = fixture(t);
  f.request.pageId = ids.sectionLocale;
  const copyPath = 'web-pages/contact/content-pages/Contact.en-US.webpage.copy.html';
  f.put(copyPath, '<section class="pp-card">Contact team</section>');
  f.request.components[0].sourcePath = copyPath;
  Object.assign(f.request.styles[0], { scope: 'site', fileName: 'cards.css' });
  f.request.styles.push({ ...f.request.styles[0], id: 'section-shape', scope: 'section', parentPageId: ids.section });
  assert.throws(() => preparePlan(f.root, f.request), /collide/);
});

test('Web File eligibility does not depend on missing, adjacent, equal or other display-order values', (t) => {
  for (const [theme, basic, custom] of [
    [9, 10, 200], [9, 10, 0], [9, 10, 9], [9, 10, 10], [9, 9, 9],
    [10, 9, 5], [undefined, undefined, undefined], [null, 'unknown', undefined], [9.5, 10.5, 1.5],
  ]) {
    for (const create of [false, true]) {
      const f = fixture(t);
      f.setDisplayOrder('theme.css', theme);
      f.setDisplayOrder('portalbasictheme.css', basic);
      f.setDisplayOrder('custom.css', custom);
      Object.assign(f.request.styles[0], { scope: 'site',
        ...(create ? { fileName: 'sunrise-theme.css' } : { targetId: f.assets['custom.css'].id }) });
      const plan = preparePlan(f.root, f.request);
      assert.equal(validatePlan(plan), plan);
      assert.match(plan.warnings.join('\n'), /Advisory CSS Web File priority/);
      assert.ok(plan.writes.every((write) => write.kind !== 'webfile' || write.before === null));
      for (const write of plan.writes.filter((entry) => entry.kind === 'webfile')) {
        assert.doesNotMatch(write.after, /displayorder:/);
      }
    }
  }
});

test('creating custom CSS does not require theme/default records to infer a priority band', (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, `${f.assets['theme.css'].path}.webfile.yml`));
  fs.unlinkSync(path.join(f.root, `${f.assets['portalbasictheme.css'].path}.webfile.yml`));
  Object.assign(f.request.styles[0], { scope: 'site', fileName: 'sunrise-theme.css' });
  const plan = preparePlan(f.root, f.request);
  assert.equal(validatePlan(plan), plan);
  assert.doesNotMatch(plan.writes.find((write) => write.kind === 'webfile').after, /displayorder:/);
});

test('class editing respects HTML attribute boundaries, including quoted > characters', () => {
  const source = '<section title=\' class="card" >\'><h2>Title</h2></section>';
  const match = '<section title=\' class="card" >\'>';
  const after = addClass(source, { match, className: 'pp-card' });
  assert.equal(after, '<section title=\' class="card" >\' class="pp-card"><h2>Title</h2></section>');
  const { classHooks } = require('../lib/style-site-plan');
  assert.deepEqual(classHooks(source), []);
  assert.deepEqual(classHooks(after), ['pp-card']);
  assert.throws(() => addClass('<section class="a" CLASS="b">', { match: '<section class="a" CLASS="b">', className: 'pp-card' }), /Duplicate/);
  const quotedTag = '<div title="<section>"><section>Content</section></div>';
  assert.equal(addClass(quotedTag, { match: '<section>', className: 'pp-card' }),
    '<div title="<section>"><section class="pp-card">Content</section></div>');
  assert.throws(() => addClass('<!-- <section> -->', { match: '<section>', className: 'pp-card' }), /exactly one/);
  assert.deepEqual(classHooks('<textarea><section class="pp-card"></section></textarea>'), []);
  assert.deepEqual(classHooks('{% comment %}<section class="pp-card"></section>{% endcomment %}'), []);
  const liquidComment = '{% comment %}<section>{% endcomment %}\n<section>Visible</section>';
  assert.equal(addClass(liquidComment, { match: '<section>', className: 'pp-card' }),
    '{% comment %}<section>{% endcomment %}\n<section class="pp-card">Visible</section>');
});

test('unused templates fail while reachable components retain verified source identity', (t) => {
  const f = fixture(t);
  const source = 'web-templates/card/Card.webtemplate.source.html';
  f.put('web-templates/card/Card.webtemplate.yml', f.yml('webtemplate', { id: '88888888-8888-4888-8888-888888888888', name: 'Card' }));
  f.put(source, '<section class="pp-card">A reusable card</section>');
  f.request.components[0].sourcePath = source;
  assert.throws(() => preparePlan(f.root, f.request), /not reachable/);
  f.put(f.copyPath, '{% include "Card" %}');
  const plan = preparePlan(f.root, f.request);
  assert.equal(plan.request.components[0].sourcePath, source);
  assert.match(plan.writes[0].after, /\.pp-card/);
  assert.equal(plan.writes.length, 1, 'Template markup is not replaced with samples.');
});

test('page-template relationships establish reachability through the localized root page', (t) => {
  const f = fixture(t);
  const templateId = '88888888-8888-4888-8888-888888888888';
  const pageTemplateId = '99999999-9999-4999-8999-999999999999';
  const source = 'web-templates/layout/Layout.webtemplate.source.html';
  f.put('web-templates/layout/Layout.webtemplate.yml', f.yml('webtemplate', { id: templateId, name: 'Layout' }));
  f.put(source, '<section class="pp-card">{% include "Page Copy" %}</section>');
  f.put('page-templates/layout/Layout.pagetemplate.yml', f.yml('pagetemplate', { id: pageTemplateId, webtemplateid: templateId }));
  fs.appendFileSync(path.join(f.root, 'web-pages/home/Home.webpage.yml'), `adx_pagetemplateid: ${pageTemplateId}\n`);
  f.request.components[0].sourcePath = source;
  assert.equal(preparePlan(f.root, f.request).request.components[0].sourcePath, source);
});

test('legacy preview plans and hash-rebuilt preview payloads require a new proposal', (t) => {
  const f = fixture(t);
  const plan = preparePlan(f.root, f.request);
  plan.schemaVersion = 1;
  plan.preview = { components: [], layers: [], studioCss: '' };
  plan.planHash = planHash(plan);
  assert.throws(() => validatePlan(plan), /Legacy preview proposals.*--operation prepare.*new hash/);
  plan.schemaVersion = 2;
  plan.planHash = planHash(plan);
  assert.throws(() => validatePlan(plan), /Invalid or modified proposal/);
});

test('diff-only preparation retains missing-asset protection without an unknown-order blocker', (t) => {
  const f = fixture(t);
  const asset = path.join(f.root, f.assets['theme.css'].path);
  const original = fs.readFileSync(asset);
  fs.unlinkSync(asset);
  assert.throws(() => preparePlan(f.root, f.request), /Missing baseline CSS/);
  fs.writeFileSync(asset, original);
  for (const name of Object.keys(f.assets)) f.setDisplayOrder(name, undefined);
  const plan = preparePlan(f.root, f.request);
  assert.equal(validatePlan(plan), plan);
  assert.ok(!plan.warnings.some((warning) => warning.includes('Advisory CSS Web File priority')),
    'Page-sidecar changes do not get unrelated Web File priority guidance.');
});

test('custom CSS still requires real hooks and scoped text parts after removing rendering', (t) => {
  const f = fixture(t);
  delete f.request.components[0].sourcePath;
  assert.throws(() => preparePlan(f.root, f.request), /real component sourcePath/);
  f.request.components[0].sourcePath = f.copyPath;
  for (const part of [' h1', ' h2', ' h3', ' h4', ' h5', ' h6', ' p', ' small', ' .text-muted', ' a', ' a:hover', ' a:focus-visible',
    ' *', ' [aria-current="page"]', ' > .btn::before']) {
    f.request.styles[0].part = part;
    f.request.styles[0].declarations = { color: '#ffffff' };
    assert.ok(compileStyles(f.request)[0].css.startsWith(`.pp-card${part} {`));
  }
  for (const part of [' h2, body', ' h2 !important', ' + body', ' ~ h2']) {
    f.request.styles[0].part = part;
    assert.throws(() => compileStyles(f.request), /CSS validation/);
  }
});
