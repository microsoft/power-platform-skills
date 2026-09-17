'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, ids } = require('./style-site-fixtures');
const { preparePlan, validatePlan, validateRequest, planHash, applyMarkup } = require('../lib/style-site-plan');
const { hash, inspectSite } = require('../lib/classic-site-style-context');
const { reviewPlan } = require('../lib/style-site-summary');
const { requestSupport } = require('../lib/studio-style-capabilities');
const { applyPlan } = require('../../skills/style-site/scripts/apply-style-plan');
const { verify } = require('../../skills/style-site/scripts/validate-style-site');
const { main: workflow } = require('../../skills/style-site/scripts/style-site-workflow');

const decoration = {
  'box-shadow': '0 12px 32px #00000033', 'border-width': '1px',
  'border-style': 'solid', 'border-color': '#ffffff', 'border-radius': '50%',
};

function imageRequest(f, inline = false) {
  const tags = [1, 2, 3].map((number) =>
    `<img src="/Circle-${number}.png" alt="Circle ${number}" data-component-theme="portalThemeColor1"${inline ? ' style="width: 100px; border-radius: 8px; border: 0px solid #000000;"' : ''}>`);
  const before = `<section class="sectionBlockLayout">\r\n${tags.join('\r\n')}\r\n</section>\r\n{% include 'Page Footer' %}`;
  f.put(f.copyPath, before);
  f.request.title = 'Three circular images';
  f.request.components = inline
    ? tags.map((tag, index) => ({ id: `circle-${index + 1}`, label: `Circle-${index + 1}.png`, kind: 'image', sourcePath: f.copyPath }))
    : [{ id: 'circles', label: 'Three images', kind: 'image', className: 'pp-circles', sourcePath: f.copyPath }];
  f.request.styles = (inline ? tags : [null]).map((tag, index) => ({
    id: `circle-decoration-${index + 1}`, componentId: inline ? `circle-${index + 1}` : 'circles',
    owner: 'custom', scope: 'page', studioComponent: 'Image', declarations: { ...decoration },
    rationale: inline ? 'Update the actual local component declarations without changing native markup.' : 'Reuse one namespaced image treatment in the selected local page stylesheet.',
    ...(inline ? { location: 'inline', inlineTarget: tag } : {}),
  }));
  f.request.classEdits = inline ? [] : tags.map((match) => ({ path: f.copyPath, match, className: 'pp-circles' }));
  return { before, tags };
}

for (const major of [3, 5]) {
  for (const inline of [false, true]) {
    test(`supported Image properties apply in VS Code (Bootstrap ${major}, inline ${inline})`, (t) => {
      const f = fixture(t, { major, prefix: major === 5 ? '' : 'adx_', nested: major === 5 });
      const { before } = imageRequest(f, inline);
      const baseline = inspectSite(f.root);
      const plan = preparePlan(f.root, f.request);
      assert.equal(validatePlan(plan), plan);
      assert.equal(reviewPlan(plan).route.name, 'small-change');
      assert.ok(requestSupport(f.request).every((group) => group.properties.every((entry) => entry.status === 'supported')));
      assert.deepEqual(plan.warnings, baseline.warnings, 'Keep baseline limitations without inventing unsupported-property warnings.');
      assert.equal(plan.writes.length, inline ? 1 : 2, 'Native support must never force a zero-write handoff.');
      assert.equal(plan.placements.every((placement) => placement.path === (inline ? f.copyPath : f.cssPath)), true);
      assert.deepEqual(inspectSite(f.root).files, baseline.files, 'Preparation never edits the site.');
      const markup = plan.writes.find((write) => write.kind === (inline ? 'markup' : 'class'));
      for (const number of [1, 2, 3]) assert.ok(markup.after.includes(`src="/Circle-${number}.png" alt="Circle ${number}"`));
      assert.ok(markup.after.includes('data-component-theme="portalThemeColor1"'));
      assert.ok(markup.after.endsWith("\r\n{% include 'Page Footer' %}"));
      assert.equal(markup.before, before);
      if (inline) {
        assert.equal((markup.after.match(/border-radius: 50%/g) || []).length, 3);
        assert.equal((markup.after.match(/width: 100px/g) || []).length, 3);
        assert.doesNotMatch(markup.after, /pp-circles|!important|border-radius: 8px/);
        assert.equal(applyMarkup(markup.after, f.request, f.copyPath), markup.after);
      } else {
        const css = plan.writes.find((write) => write.kind === 'css');
        assert.match(css.after, /\.pp-circles \{/);
        assert.match(css.after, /box-shadow: 0 12px 32px #00000033;/);
        assert.equal((markup.after.match(/class="pp-circles"/g) || []).length, 3);
      }
      const receipt = path.join(f.work, 'receipt.json');
      const applied = applyPlan(plan, { apply: true, approvedHash: plan.planHash, receipt });
      assert.equal(applied.status, 'applied');
      assert.equal(verify(plan, JSON.parse(fs.readFileSync(receipt))).status, 'verified-local-files');
      assert.equal(applyPlan(plan).status, 'already-applied');
      for (const file of baseline.files.filter((file) => !plan.writes.some((write) => write.path === file.path))) {
        assert.equal(hash(fs.readFileSync(path.join(f.root, file.path), 'utf8')), file.hash, file.path);
      }
    });
  }
}

test('the old native-property handoff policy cannot produce a valid zero-write plan', (t) => {
  const f = fixture(t);
  imageRequest(f);
  f.request.styles[0].owner = 'studio';
  f.request.styles[0].studioAction = 'Set shadow, border and corner radius in Studio.';
  f.request.classEdits = [];
  assert.throws(() => preparePlan(f.root, f.request), /Studio support does not require a handoff/);
  f.request.styles[0].handoffReason = 'studio-supported';
  assert.throws(() => validateRequest(f.request), /handoffReason: user-requested/);
  f.request.styles[0].handoffReason = 'user-requested';
  delete f.request.components[0].sourcePath;
  const handoff = preparePlan(f.root, f.request);
  assert.deepEqual(handoff.writes, []);
  imageRequest(f);
  const local = preparePlan(f.root, f.request);
  assert.throws(() => applyPlan(local, { apply: true, approvedHash: handoff.planHash, receipt: path.join(f.work, 'wrong.json') }), /approval/);
});

test('inline conflicts direct the agent to the real local declaration, not Studio or ineffective CSS', (t) => {
  const f = fixture(t);
  f.put(f.copyPath, '<img class="pp-card" style="border-radius: 8px;">');
  f.request.components[0].kind = 'image';
  f.request.styles[0].studioComponent = 'Image';
  assert.throws(() => preparePlan(f.root, f.request), /Inline border-radius overrides stylesheet.*guarded inline edit/);
  f.request.styles[0].location = 'inline';
  f.request.styles[0].inlineTarget = '<img class="pp-card" style="border-radius: 8px;">';
  const plan = preparePlan(f.root, f.request);
  assert.equal(plan.writes[0].kind, 'markup');
  assert.match(plan.writes[0].after, /border-radius: 12px;/);
});

test('class and inline changes compose against original anchors and preserve unrelated bytes', (t) => {
  const f = fixture(t);
  const target = '<img src="/Circle-1.png" style="border-radius: 8px;" data-component-theme="portalThemeColor1">';
  f.put(f.copyPath, `<!-- keep -->\r\n${target}\r\n<p>{{ user.fullname }}</p>`);
  f.request.classEdits = [{ path: f.copyPath, match: target, className: 'pp-card' }];
  f.request.styles[0].declarations = { 'box-shadow': decoration['box-shadow'] };
  f.request.styles.push({ ...f.request.styles[0], id: 'image-radius', location: 'inline', inlineTarget: target, declarations: { 'border-radius': '50%' } });
  const plan = preparePlan(f.root, f.request);
  const markup = plan.writes.find((write) => write.kind === 'markup');
  assert.equal(markup.after, '<!-- keep -->\r\n<img src="/Circle-1.png" style="border-radius: 50%;" data-component-theme="portalThemeColor1" class="pp-card">\r\n<p>{{ user.fullname }}</p>');
  assert.equal(plan.writes.filter((write) => write.path === f.copyPath).length, 1);
  assert.equal(validatePlan(plan), plan);
  assert.equal(applyMarkup(markup.after, f.request, f.copyPath), markup.after);
});

test('inline properties absent from Studio keep their warning and still apply locally', (t) => {
  const f = fixture(t);
  imageRequest(f, true);
  f.request.styles[0].declarations.opacity = '0.9';
  const plan = preparePlan(f.root, f.request);
  assert.match(plan.warnings.join('\n'), /Not editable through Image's Studio Design panel: opacity/);
  const applied = applyPlan(plan, { apply: true, approvedHash: plan.planHash, receipt: path.join(f.work, 'receipt.json') });
  assert.match(applied.warnings.join('\n'), /opacity/);
  assert.match(fs.readFileSync(path.join(f.root, f.copyPath), 'utf8'), /opacity: 0.9;/);
});

test('a static native tag can receive a style attribute without inventing a class or changing other attributes', (t) => {
  const f = fixture(t);
  const { tags } = imageRequest(f);
  f.request.components = [{ id: 'circle', label: 'Circle', kind: 'image', sourcePath: f.copyPath }];
  f.request.styles = [{
    id: 'circle-radius', componentId: 'circle', owner: 'custom', scope: 'page',
    studioComponent: 'Image', location: 'inline', inlineTarget: tags[0],
    declarations: { 'border-radius': '50%' }, rationale: 'This requested component-local value is authored on its actual static tag.',
  }];
  f.request.classEdits = [];
  const plan = preparePlan(f.root, f.request);
  const write = plan.writes[0];
  assert.equal(write.kind, 'markup');
  assert.ok(write.after.includes(tags[0].replace(/>$/, ' style="border-radius: 50%;">')));
  assert.ok(write.after.includes(tags[1]) && write.after.includes(tags[2]));
  assert.equal(applyMarkup(write.after, f.request, f.copyPath), write.after);
});

test('inline-only edits refuse unnecessary class additions and section scope', (t) => {
  const f = fixture(t);
  const { tags } = imageRequest(f, true);
  f.request.components[0].className = 'pp-circle';
  f.request.classEdits = [{ path: f.copyPath, match: tags[0], className: 'pp-circle' }];
  assert.throws(() => preparePlan(f.root, f.request), /inline-only proposals/);
  f.request.classEdits = [];
  delete f.request.components[0].className;
  f.request.styles[0].scope = 'section';
  assert.throws(() => preparePlan(f.root, f.request), /Inline page edits require page scope/);
});

test('inline groups merge disjoint properties but reject contradictory requests', (t) => {
  const f = fixture(t);
  imageRequest(f, true);
  const base = f.request.styles[0];
  base.declarations = { 'border-radius': '50%' };
  f.request.styles.push({ ...base, id: 'shadow', declarations: { 'box-shadow': decoration['box-shadow'] } });
  const plan = preparePlan(f.root, f.request);
  assert.equal(applyMarkup(plan.writes[0].after, f.request, f.copyPath), plan.writes[0].after);
  f.request.styles.at(-1).declarations['border-radius'] = '10px';
  assert.throws(() => preparePlan(f.root, f.request), /must not overlap properties/);
});

test('inline target validation rejects missing, ambiguous, dynamic and embedded-content targets', (t) => {
  const f = fixture(t);
  imageRequest(f, true);
  const base = structuredClone(f.request);
  for (const [target, source, expected] of [
    ['<img src="/missing.png">', '<img src="/elsewhere.png">', /exactly one/],
    ['<img src="/a.png">', '<img src="/a.png"><img src="/a.png">', /exactly one/],
    ['<img src="{{ value }}">', '<img src="{{ value }}">', /static opening tag/],
    ['<img src="/a.png">', '<!-- <img src="/a.png"> -->', /exactly one/],
    ['<img src="/a.png">', '{% comment %}<img src="/a.png">{% endcomment %}', /exactly one/],
    ['<img src="/a.png">', '<script>"<img src="/a.png">"</script>', /exactly one/],
    ['<img src="/a.png">', '<iframe src="/frame"><img src="/a.png"></iframe>', /exactly one/],
    ['<script>', '<script>', /static opening tag/],
    ['<img style="width:1px" style="width:2px">', '<img style="width:1px" style="width:2px">', /Duplicate/],
    ['<img style=width:1px>', '<img style=width:1px>', /quoted/],
  ]) {
    f.request = structuredClone(base);
    f.request.components = [f.request.components[0]];
    f.request.styles = [{ ...f.request.styles[0], inlineTarget: target }];
    f.put(f.copyPath, source);
    assert.throws(() => preparePlan(f.root, f.request), expected, target);
  }
});

test('inline schema rejects contradictory locations, unsafe values, parts and handoff flags', (t) => {
  const f = fixture(t);
  imageRequest(f, true);
  const base = structuredClone(f.request);
  for (const change of [{ part: ' img' }, { targetId: ids.locale }, { fileName: 'other.css' },
    { parentPageId: ids.home }, { location: 'external' }, { location: 'stylesheet' },
    { declarations: { color: '#fff;display:none' } }, { studioAction: 'Use Studio' }, { handoffReason: 'user-requested' }]) {
    const request = structuredClone(base);
    Object.assign(request.styles[0], change);
    assert.throws(() => validateRequest(request), /Inline styles|location|class hook|CSS validation|handoff|inlineTarget/);
  }
  f.request.components[0].className = 'pp-wrong';
  assert.throws(() => preparePlan(f.root, f.request), /component class hook/);
  f.request.components[0].className = ['pp-wrong'];
  assert.throws(() => validateRequest(f.request), /distinct pp-/);
});

test('inline edits cannot silently cross locales or shared-template scope', (t) => {
  const f = fixture(t);
  const { tags } = imageRequest(f, true);
  f.request.pageId = ids.sectionLocale;
  assert.throws(() => preparePlan(f.root, f.request), /selected localized page source/);
  f.request.pageId = ids.locale;
  const source = 'web-templates/images/Images.webtemplate.source.html';
  f.put(source, tags.join('\n'));
  f.put('web-templates/images/Images.webtemplate.yml', f.yml('webtemplate', { id: '88888888-8888-4888-8888-888888888888', name: 'Images' }));
  for (const component of f.request.components) component.sourcePath = source;
  assert.throws(() => preparePlan(f.root, f.request), /shared-template inline edits require explicit site scope/);
  for (const style of f.request.styles) style.scope = 'site';
  assert.throws(() => preparePlan(f.root, f.request), /not reachable/);
  f.put(f.copyPath, '{% include "Images" %}');
  const plan = preparePlan(f.root, f.request);
  assert.equal(reviewPlan(plan).route.name, 'expanded');
  assert.equal(plan.placements[0].affectedPageIds.length, inspectSite(f.root).pages.length);
  assert.match(plan.placements[0].scopeNote, /potentially affected/);
});

test('rehashed arbitrary markup and stale inline sources cannot bypass guarded application', (t) => {
  const f = fixture(t);
  imageRequest(f, true);
  const plan = preparePlan(f.root, f.request);
  const altered = structuredClone(plan);
  altered.writes[0].after = altered.writes[0].after.replace('alt="Circle 1"', 'alt="Changed content"');
  altered.writes[0].afterHash = hash(altered.writes[0].after);
  altered.planHash = planHash(altered);
  assert.throws(() => validatePlan(altered), /beyond the approved class\/inline edits/);
  f.put(f.copyPath, fs.readFileSync(path.join(f.root, f.copyPath), 'utf8') + '\n<!-- concurrent -->');
  assert.throws(() => applyPlan(plan, { apply: true, approvedHash: plan.planHash, receipt: path.join(f.work, 'receipt.json') }), /Source changed/);
  assert.equal(fs.existsSync(path.join(f.work, 'receipt.json')), false);
});

test('an explicit generated-markup banner is not treated as editable native component serialization', (t) => {
  const f = fixture(t);
  const { before } = imageRequest(f, true);
  f.put(f.copyPath, `<!-- Generated file. Do not edit. -->\n${before}`);
  assert.throws(() => preparePlan(f.root, f.request), /Markup is generated or source-owned/);
  assert.equal(fs.readFileSync(path.join(f.root, f.copyPath), 'utf8'), `<!-- Generated file. Do not edit. -->\n${before}`);
});

test('coordinator prepares and independently verifies inline-only requests without CSS or browser prerequisites', (t) => {
  const f = fixture(t);
  imageRequest(f, true);
  const requestFile = path.join(f.work, 'request.json');
  fs.writeFileSync(requestFile, JSON.stringify(f.request));
  const prepared = workflow(['--operation', 'prepare', '--siteRoot', f.root, '--request', requestFile, '--out', path.join(f.work, 'revision')]);
  assert.equal(prepared.route.name, 'small-change');
  const applied = workflow(['--operation', 'apply', '--plan', prepared.artifacts.plan, '--approvedHash', prepared.planHash, '--receipt', path.join(f.work, 'receipt.json')]);
  assert.equal(applied.status, 'applied');
  assert.deepEqual(applied.files, [f.copyPath]);
  assert.equal(applied.verification.status, 'verified-local-files');
});
