'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, ids } = require('./style-site-fixtures');
const { inspectSite, hash } = require('../lib/classic-site-style-context');
const { preparePlan, validatePlan, validateRequest, openingTag, planHash } = require('../lib/style-site-plan');
const { needsContrastReview } = require('../lib/style-site-contrast');
const { reviewPlan } = require('../lib/style-site-summary');
const { main: workflow } = require('../../skills/style-site/scripts/style-site-workflow');
const { applyPlan } = require('../../skills/style-site/scripts/apply-style-plan');
const { decodeHTMLAttribute } = require('../vendor/css-tools/css-tools.cjs');

function runWorkflow(f) {
  const baseline = inspectSite(f.root);
  const requestPath = path.join(f.work, 'request.json');
  fs.writeFileSync(requestPath, JSON.stringify(f.request));
  const summary = workflow(['--operation', 'prepare', '--siteRoot', f.root, '--request', requestPath, '--out', path.join(f.work, 'revision')]);
  const plan = JSON.parse(fs.readFileSync(summary.artifacts.plan, 'utf8'));
  const review = JSON.parse(fs.readFileSync(summary.artifacts.review, 'utf8'));
  assert.equal(validatePlan(plan), plan);
  assert.equal(review.planHash, plan.planHash);
  assert.deepEqual(inspectSite(f.root).files, baseline.files, 'Preparing general CSS does not write the site.');
  const receipt = path.join(f.work, 'receipt.json');
  const result = workflow(['--operation', 'apply', '--plan', summary.artifacts.plan, '--approvedHash', plan.planHash, '--receipt', receipt]);
  assert.equal(result.status, 'applied');
  assert.equal(result.verification.status, 'verified-local-files');
  assert.equal(applyPlan(plan).status, 'already-applied');
  for (const file of baseline.files.filter((entry) => !plan.writes.some((write) => write.path === entry.path))) {
    assert.equal(hash(fs.readFileSync(path.join(f.root, file.path), 'utf8')), file.hash, file.path);
  }
  for (const write of plan.writes) assert.equal(fs.readFileSync(path.join(f.root, write.path), 'utf8'), write.after);
  return { plan, review, result };
}

const rules = [
  '@font-face { font-family: "pp-brand"; src: url(/brand.woff2) format("woff2"); font-display: swap; }',
  '@property --pp-angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }',
  '@layer pp-components {',
  '  .pp-card { --pp-surface: oklch(96% .02 250); background: var(--pp-surface); display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: clamp(1rem, 2vw, 2rem); container-type: inline-size; }',
  '  .pp-card > h2 { font: 700 clamp(1.5rem, 3vw, 3rem)/1.2 "pp-brand", system-ui, sans-serif; text-wrap: balance; }',
  '  .pp-card > .btn:is(:hover, :focus-visible) { transform: translateY(-2px); transition: transform 180ms ease, box-shadow 200ms ease; }',
  '  .pp-card > .btn::before { content: "Next"; margin-inline-end: .5em; }',
  '  @media (max-width: 48rem) { .pp-card { grid-template-columns: 1fr; padding-inline: min(5vw, 1.5rem); } }',
  '  @supports (color: oklch(50% .2 250)) { .pp-card > h2 { color: oklch(35% .15 250); } }',
  '  @container (min-width: 30rem) { .pp-card > h2 { max-inline-size: 25ch; } }',
  '}',
  '@keyframes pp-enter { from { opacity: 0; transform: translateY(1rem); } to { opacity: 1; transform: none; } }',
  '.pp-card { animation: pp-enter 180ms ease both; }',
  '@media (prefers-reduced-motion: reduce) { .pp-card { animation: none; } .pp-card > .btn { transition: none; } }',
].join('\r\n');

for (const major of [3, 5]) {
  test(`general declarations work through approval/apply/verification on Bootstrap ${major}`, (t) => {
    const f = fixture(t, { major, prefix: major === 5 ? '' : 'adx_', nested: major === 5 });
    f.request.styles[0].studioComponent = 'Section';
    f.request.styles[0].declarations = {
      '--Brand': '#123456', '--brand': '#654321', display: 'grid',
      'grid-template-columns': 'repeat(auto-fit, minmax(min(100%, 18rem), 1fr))',
      'font-family': '"Contoso Sans", system-ui, sans-serif',
      'box-shadow': 'inset 0 1px 2px #0002, 0 9px 31px rgb(0 0 0 / 23%)',
      margin: '2rem', 'margin-inline-start': 'calc(-1 * 2vw)',
      'min-block-size': '50dvh', 'aspect-ratio': '3 / 2',
      background: 'repeating-conic-gradient(from 45deg, #123 0deg 20deg, #456 20deg 40deg)',
      transform: 'translateY(-.5rem) rotate(2deg)', transition: 'transform 240ms ease, opacity 200ms linear',
      'object-position': '40% 20%', 'scroll-margin-block-start': '5rem',
    };
    const { plan, review } = runWorkflow(f);
    const css = plan.writes.find((write) => write.kind === 'css').after;
    for (const [property, value] of Object.entries(f.request.styles[0].declarations)) assert.ok(css.includes(`${property}: ${value};`));
    assert.ok(css.indexOf('margin:') < css.indexOf('margin-inline-start:'), 'Authored shorthand order is semantic.');
    assert.match(plan.warnings.join('\n'), /Studio Design panel/);
    assert.equal(review.contrastReview, 'required-before-approval');
    assert.equal(review.route.name, 'small-change');
  });

  test(`scoped rules, fonts, tokens and responsive motion work on Bootstrap ${major}`, (t) => {
    const f = fixture(t, { major });
    delete f.request.styles[0].declarations;
    f.request.styles[0].css = rules;
    const before = fs.readFileSync(path.join(f.root, f.cssPath), 'utf8');
    const { plan, review } = runWorkflow(f);
    const css = plan.writes.find((write) => write.kind === 'css').after;
    assert.ok(css.startsWith(before));
    assert.ok(css.includes(rules.replace(/\r\n/g, '\n')));
    assert.doesNotMatch(css, /\r\r\n/);
    assert.equal(review.route.name, 'expanded');
    assert.equal(review.contrastReview, 'required-before-approval');
    assert.match(plan.warnings.join('\n'), /maintained in VS Code/);
    assert.deepEqual(plan.placements[0].affectedPageIds, [ids.locale]);
  });

  test(`global site themes require explicit scope, not fictional hooks (Bootstrap ${major})`, (t) => {
    const f = fixture(t, { major });
    delete f.request.components[0].className;
    delete f.request.components[0].sourcePath;
    delete f.request.styles[0].declarations;
    Object.assign(f.request.styles[0], {
      scope: 'site', global: true, targetId: f.assets['custom.css'].id,
      css: ':root { --pp-brand: #123456; color-scheme: light; }\nbody { font-family: "Contoso Sans", sans-serif; }\nh1, h2 { color: var(--pp-brand); }',
    });
    const { plan, review } = runWorkflow(f);
    assert.equal(plan.writes.length, 1);
    assert.equal(plan.writes[0].path, f.assets['custom.css'].path);
    assert.equal(review.route.name, 'expanded');
    assert.match(plan.placements[0].scopeNote, /all matching elements/);
    assert.ok(plan.placements[0].affectedPageIds.includes(ids.sectionLocale));
  });

  test(`inline declarations safely round-trip quotes, entities and custom-property case (Bootstrap ${major})`, (t) => {
    const f = fixture(t, { major });
    const target = '<article class="pp-card" data-component-theme="portalThemeColor1" title="Keep this" style=\'width: 10rem; background-image: url("/old.svg?size=1&amp;t=2"); font-family: &quot;Old Font&quot;;\'>';
    f.put(f.copyPath, `${target}<h2>Unchanged</h2></article>\r\n{% include 'Page Footer' %}`);
    Object.assign(f.request.styles[0], {
      location: 'inline', inlineTarget: target,
      declarations: { 'font-family': '"Maker\'s Sans", "A & B", serif', '--Brand': 'red', '--brand': 'blue', transform: 'translateY(-2px)', content: '"It\'s styled"' },
    });
    const { plan } = runWorkflow(f);
    assert.equal(plan.writes.length, 1);
    const output = plan.writes[0].after;
    const tag = openingTag(output);
    assert.deepEqual(tag.attributes.map((attribute) => attribute.name), ['class', 'data-component-theme', 'title', 'style']);
    const style = decodeHTMLAttribute(tag.attributes.find((attribute) => attribute.name === 'style').value);
    assert.match(style, /background-image: url\("\/old\.svg\?size=1&t=2"\)/);
    assert.ok(style.includes('font-family: "Maker\'s Sans", "A & B", serif;'));
    assert.ok(style.includes('--Brand: red; --brand: blue;'));
    assert.ok(output.endsWith("<h2>Unchanged</h2></article>\r\n{% include 'Page Footer' %}"));
  });
}

test('explicit inline removal enables state rules in the same approved revision', (t) => {
  const f = fixture(t);
  const target = '<section class="pp-card" style="opacity: .9 !important; padding: 1rem;" data-component-theme="portalThemeColor1">';
  f.put(f.copyPath, `${target}<p>Keep content</p></section>`);
  delete f.request.styles[0].declarations;
  f.request.styles[0].css = '.pp-card { opacity: 1; transition: opacity 150ms ease; } .pp-card:hover { opacity: .8; }';
  assert.throws(() => preparePlan(f.root, f.request), /Inline opacity overrides stylesheet/);
  f.request.styles.push({
    id: 'release-opacity', componentId: 'service-card', owner: 'custom', scope: 'page', location: 'inline',
    inlineTarget: target, declarations: { opacity: null }, rationale: 'Remove the owning inline opacity so the approved local base/hover rules can apply.',
  });
  const { plan } = runWorkflow(f);
  const markup = plan.writes.find((write) => write.kind === 'markup').after;
  assert.doesNotMatch(markup, /opacity:|!important/);
  assert.match(markup, /padding: 1rem/);
  assert.doesNotMatch(plan.writes.find((write) => write.kind === 'css').after, /!important/);
});

test('general CSS cannot bypass approval, source, selector or inline-ownership guards', (t) => {
  const f = fixture(t);
  const original = structuredClone(f.request);
  for (const patch of [
    { css: '.pp-card { color:red; } body { display:none; }' },
    { css: '.pp-card { content:"</style><script>"; }' },
    { css: '.pp-card { background:url(https://assets.example.com/hero.png); }' },
  ]) {
    f.request = structuredClone(original);
    delete f.request.styles[0].declarations;
    Object.assign(f.request.styles[0], patch);
    assert.throws(() => preparePlan(f.root, f.request));
  }
  f.request = structuredClone(original);
  f.request.styles[0].part = ' .btn, body';
  assert.throws(() => validateRequest(f.request));
  f.request = structuredClone(original);
  delete f.request.components[0].sourcePath;
  assert.throws(() => preparePlan(f.root, f.request), /sourcePath/);
  f.request = structuredClone(original);
  f.request.styles[0].declarations.color = null;
  assert.throws(() => validateRequest(f.request), /inline/i);
  f.request = structuredClone(original);
  f.request.styles[0].declarations.transform = 'translateY(-2px)';
  const plan = preparePlan(f.root, f.request);
  assert.throws(() => applyPlan(plan, { apply: true, approvedHash: '0'.repeat(64), receipt: path.join(f.work, 'wrong.json') }), /approval/);
  plan.writes[0].after += '\nbody { display:none; }';
  plan.writes[0].afterHash = hash(plan.writes[0].after);
  plan.planHash = planHash(plan);
  assert.throws(() => validatePlan(plan), /outside its declared/);
});

test('explicit priority is reviewed and cannot defeat important inline declarations', (t) => {
  const f = fixture(t);
  f.put(f.copyPath, '<section class="pp-card" style="color: red;"><h2>Keep</h2></section>');
  f.request.styles[0].declarations = { color: 'blue !important' };
  assert.throws(() => preparePlan(f.root, f.request), /important/i);
  f.request.styles[0].importantReason = 'A reviewed state rule needs this priority; do not change the native inline baseline.';
  const plan = preparePlan(f.root, f.request);
  assert.match(plan.warnings.join('\n'), /important/i);
  assert.equal(reviewPlan(plan).route.name, 'expanded');
  f.put(f.copyPath, '<section class="pp-card" style="color: red !important;"><h2>Keep</h2></section>');
  assert.throws(() => preparePlan(f.root, f.request), /Inline color overrides stylesheet/);
});

test('reviewed external imports must occupy a legal stylesheet position', (t) => {
  const f = fixture(t);
  delete f.request.styles[0].declarations;
  Object.assign(f.request.styles[0], {
    global: true, css: '@import url("https://styles.example.com/brand.css");\n:root { --pp-brand: #123456; }',
    externalResources: ['https://styles.example.com/brand.css'],
  });
  assert.throws(() => preparePlan(f.root, f.request), /import/i);
  Object.assign(f.request.styles[0], { scope: 'site', fileName: 'brand-theme.css' });
  const { plan, review } = runWorkflow(f);
  assert.ok(plan.writes.some((write) => write.kind === 'webfile'));
  assert.match(plan.warnings.join('\n'), /https:\/\/styles\.example\.com\/brand\.css/);
  assert.equal(review.route.name, 'expanded');
});

test('standard descendant selectors and rendered tags are not limited to a component catalog', (t) => {
  const f = fixture(t);
  f.request.styles[0].part = ' > .btn[aria-expanded="true"]:hover::before';
  f.request.styles[0].declarations = { content: '"Close"', 'margin-inline-end': '.5rem' };
  assert.match(preparePlan(f.root, f.request).writes[0].after, /aria-expanded="true"/);
  const target = '<input type="text" aria-label="Search" data-component-theme="portalThemeColor1">';
  f.put(f.copyPath, target);
  f.request.classEdits = [{ path: f.copyPath, match: target, className: 'pp-card' }];
  delete f.request.styles[0].part;
  f.request.styles[0].declarations = { 'accent-color': '#123456', 'caret-color': '#654321' };
  const { plan } = runWorkflow(f);
  assert.match(plan.writes.find((write) => write.kind === 'class').after, /aria-label="Search".*class="pp-card"/);
});

test('contrast review includes raw rules, shorthand paint, inherited tokens and motion', () => {
  for (const style of [
    { declarations: { background: 'linear-gradient(red, blue)' } },
    { declarations: { '--Brand': '#123456' } },
    { css: '.pp-card { color: oklch(50% .2 250); }' },
    { css: '@keyframes pp-fade { from { opacity: 0; } to { opacity: 1; } }' },
  ]) assert.equal(needsContrastReview({ styles: [style] }), true);
});

test('a managed block cannot hide an unfinished destination comment', (t) => {
  const f = fixture(t);
  for (const source of ['/*/', '.existing { color: red; } /* unfinished']) {
    f.put(f.cssPath, source);
    assert.throws(() => preparePlan(f.root, f.request), /CSS validation/);
  }
});

test('an outer iframe can be styled without touching its attributes or embedded content', (t) => {
  const f = fixture(t);
  const target = '<iframe src="/embedded-page" title="Video" class="pp-card">';
  const embedded = '<img class="not-a-local-hook" src="/inside.png">';
  f.request.components[0].kind = 'video';
  f.put(f.copyPath, `${target}${embedded}</iframe>`);
  Object.assign(f.request.styles[0], {
    location: 'inline', inlineTarget: target, declarations: { width: '100%', 'aspect-ratio': '16 / 9' },
  });
  const { plan } = runWorkflow(f);
  assert.ok(plan.writes[0].after.endsWith(`${embedded}</iframe>`));
  assert.match(plan.writes[0].after, /^<iframe src="\/embedded-page" title="Video" class="pp-card" style=/);
});

test('removing an absent inline property does not invent an empty style attribute', (t) => {
  const f = fixture(t);
  const target = '<section class="pp-card" data-component-theme="portalThemeColor1">';
  f.put(f.copyPath, `${target}<p>Keep</p></section>`);
  Object.assign(f.request.styles[0], { location: 'inline', inlineTarget: target, declarations: { color: null } });
  const write = preparePlan(f.root, f.request).writes[0];
  assert.equal(write.after, write.before);
  assert.doesNotMatch(write.after, /style=/);
});

test('exact multiline opening tags remain editable across general CSS revisions', (t) => {
  const f = fixture(t);
  const target = '<section\r\n class="pp-card"\r\n data-component-theme="portalThemeColor1">';
  f.put(f.copyPath, `${target}<p>Keep</p></section>`);
  Object.assign(f.request.styles[0], {
    location: 'inline', inlineTarget: target, declarations: { 'background-image': 'linear-gradient(\nred,\nblue)' },
  });
  const { plan } = runWorkflow(f);
  const markup = plan.writes[0].after;
  const tag = openingTag(markup);
  f.request.styles[0].inlineTarget = markup.slice(0, tag.end);
  f.request.styles[0].declarations['background-image'] = 'none';
  const next = preparePlan(f.root, f.request);
  assert.match(next.writes[0].after, /background-image: none/);
  assert.equal(validatePlan(next), next);
});

test('keyframes are not incorrectly treated as ordinary CSS losing to normal inline declarations', (t) => {
  const f = fixture(t);
  const before = '<section class="pp-card" style="opacity: .9;"><p>Keep</p></section>';
  f.put(f.copyPath, before);
  delete f.request.styles[0].declarations;
  f.request.styles[0].css = '@keyframes pp-fade { from { opacity: 0; } to { opacity: 1; } }\n.pp-card { animation: pp-fade 180ms ease; }\n@media (prefers-reduced-motion: reduce) { .pp-card { animation: none; } }';
  const { plan } = runWorkflow(f);
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].kind, 'css');
  assert.equal(fs.readFileSync(path.join(f.root, f.copyPath), 'utf8'), before);
  assert.match(plan.warnings.join('\n'), /keyframes|animation/i);
});

test('component kind is descriptive metadata, not a styling capability allowlist', (t) => {
  const f = fixture(t);
  for (const kind of ['accordion', 'carousel', 'site-theme', 'custom SVG']) {
    f.request.components[0].kind = kind;
    assert.doesNotThrow(() => validateRequest(f.request));
  }
  f.request.components[0].kind = '';
  assert.throws(() => validateRequest(f.request), /component kind/);
});

for (const location of ['stylesheet', 'inline', 'rules']) {
  test(`newer CSS value syntax retains the complete approved workflow (${location})`, (t) => {
    const f = fixture(t);
    const value = 'if(style(--scheme: dark): white; else: black)';
    const target = '<section class="pp-card">';
    f.put(f.copyPath, `${target}<p>Keep</p></section>`);
    f.request.styles[0].declarations = { '--scheme': 'dark', color: value };
    if (location === 'inline') {
      Object.assign(f.request.styles[0], { location: 'inline', inlineTarget: target });
    } else if (location === 'rules') {
      delete f.request.styles[0].declarations;
      f.request.styles[0].css = `.pp-card { --scheme: dark; color: ${value}; }`;
    }
    const { plan, review } = runWorkflow(f);
    assert.ok(plan.writes[0].after.includes(`color: ${value};`));
    assert.equal(review.contrastReview, 'required-before-approval');
    assert.match(plan.warnings.join('\n'), /grammar|token|compatib/i);
  });
}
