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
  assert.deepEqual(plan.preview.layers.map((layer) => path.posix.basename(layer.path)), ['bootstrap.min.css', 'theme.css', 'custom.css', 'portalbasictheme.css', path.posix.basename(f.cssPath)]);
});

test('reuses shared CSS and discloses inherited pages', (t) => {
  const f = fixture(t);
  Object.assign(f.request.styles[0], { scope: 'site', targetId: f.assets['custom.css'].id });
  const plan = preparePlan(f.root, f.request);
  assert.equal(plan.writes[0].path, f.assets['custom.css'].path);
  assert.ok(plan.placements[0].affectedPageIds.includes(ids.sectionLocale));
  const layer = plan.preview.layers.find((entry) => entry.path === f.assets['custom.css'].path);
  assert.match(layer.after, /\.pp-card/);
});

for (const options of [{ prefix: 'adx_' }, { prefix: '', nested: true, major: 5 }]) {
  test(`creates correctly shaped CSS metadata (${JSON.stringify(options)})`, (t) => {
    const f = fixture(t, options);
    Object.assign(f.request.styles[0], { scope: 'site', fileName: 'service-cards.css' });
    const plan = preparePlan(f.root, f.request);
    const metadata = plan.writes.find((write) => write.kind === 'webfile');
    assert.match(metadata.after, new RegExp(`^${options.prefix}displayorder: 3$`, 'm'));
    assert.match(metadata.after, /mimetype: text\/css/);
    assert.match(metadata.path, options.nested ? /service-cards\.css\/service-cards\.css\.webfile\.yml$/ : /^web-files\/service-cards\.css\.webfile\.yml$/);
    assert.equal(plan.preview.layers[2].path, metadata.path.replace(/\.webfile\.yml$/, ''));
    assert.equal(preparePlan(f.root, f.request, plan.allocatedIds).planHash, plan.planHash);
  });
}

test('Studio-only proposal previews native values without local CSS writes', (t) => {
  const f = fixture(t);
  Object.assign(f.request.styles[0], { owner: 'studio', studioAction: 'Use the component paintbrush to set the corner radius.' });
  delete f.request.components[0].sourcePath;
  const plan = preparePlan(f.root, f.request);
  assert.deepEqual(plan.writes, []);
  assert.match(plan.preview.studioCss, /border-radius: 12px/);
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
  assert.throws(() => preparePlan(f.root, f.request), /unsafe/);
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
  Object.assign(f.request.styles[0], { owner: 'studio', studioAction: 'Use Studio.' });
  f.request.classEdits = [{ path: f.copyPath, match: '<section class="pp-card">', className: 'pp-card' }];
  assert.throws(() => preparePlan(f.root, f.request), /Studio-only/);
});

test('section CSS stays in the custom priority band and discloses only its subtree', (t) => {
  const f = fixture(t);
  f.request.pageId = ids.sectionLocale;
  const copyPath = 'web-pages/contact/content-pages/Contact.en-US.webpage.copy.html';
  f.put(copyPath, '<section class="pp-card">Contact team</section>');
  f.request.components[0].sourcePath = copyPath;
  Object.assign(f.request.styles[0], { scope: 'section', parentPageId: ids.section, fileName: 'contact-cards.css' });
  const plan = preparePlan(f.root, f.request);
  assert.deepEqual(plan.placements[0].affectedPageIds.sort(), [ids.section, ids.sectionLocale].sort());
  assert.equal(plan.preview.layers[2].path, 'web-files/contact-cards.css');
  assert.equal(plan.preview.layers.at(-1).path, f.assets['portalbasictheme.css'].path);
});

test('new custom files receive distinct available display-order slots', (t) => {
  const f = fixture(t);
  Object.assign(f.request.styles[0], { scope: 'site', fileName: 'cards.css' });
  f.request.styles.push({ ...f.request.styles[0], id: 'card-color', fileName: 'colors.css', declarations: { color: '#123456' } });
  const plan = preparePlan(f.root, f.request);
  const metadata = plan.writes.filter((write) => write.kind === 'webfile');
  assert.match(metadata[0].after, /adx_displayorder: 3/);
  assert.match(metadata[1].after, /adx_displayorder: 4/);
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

test('reused custom CSS must remain in the supported priority band', (t) => {
  const f = fixture(t);
  Object.assign(f.request.styles[0], { scope: 'site', targetId: f.assets['custom.css'].id });
  const metadata = path.join(f.root, `${f.assets['custom.css'].path}.webfile.yml`);
  fs.writeFileSync(metadata, fs.readFileSync(metadata, 'utf8').replace('adx_displayorder: 5', 'adx_displayorder: 20'));
  assert.throws(() => preparePlan(f.root, f.request), /outside the supported display-order band/);
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

test('unused templates fail, while reachable Liquid components are explicitly simulated', (t) => {
  const f = fixture(t);
  const source = 'web-templates/card/Card.webtemplate.source.html';
  f.put('web-templates/card/Card.webtemplate.yml', f.yml('webtemplate', { id: '88888888-8888-4888-8888-888888888888', name: 'Card' }));
  f.put(source, '<section class="pp-card">A reusable card</section>');
  f.request.components[0].sourcePath = source;
  assert.throws(() => preparePlan(f.root, f.request), /not reachable/);
  f.put(f.copyPath, '{% include "Card" %}');
  const plan = preparePlan(f.root, f.request);
  assert.equal(plan.preview.components[0].simulation, true);
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
  assert.equal(preparePlan(f.root, f.request).preview.components[0].simulation, true);
});
