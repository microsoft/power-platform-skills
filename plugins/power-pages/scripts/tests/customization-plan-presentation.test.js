const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderCustomizationPlan } = require('../render-customize-declarative-site-plan');
const { contrastRatio, parseColor } = require('../lib/style-site-contrast');
const { renderDocument } = require('./customization-plan-test-helpers');

function planFixture() {
  return JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'customize-declarative-site-plan.json'), 'utf8'
  ));
}

function render(t, plan = planFixture(), images = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-presentation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'plan.html');
  const before = JSON.stringify(plan);
  renderCustomizationPlan(plan, output, { emitStatus: false });
  assert.equal(JSON.stringify(plan), before, 'Presentation must not alter the execution contract.');
  const html = fs.readFileSync(output, 'utf8');
  return { html, document: renderDocument(html, images) };
}

function externalImagePlan(url = 'https://cdn.example.com/speaker.jpg') {
  const plan = planFixture();
  const asset = plan.assets[0];
  asset.delivery = 'external-url';
  asset.externalUrl = url;
  asset.source = { type: 'user-provided', license: 'User-owned image.' };
  asset.preparation = { status: 'remote' };
  delete asset.webFileOperationId;
  plan.operations.shift();
  plan.operations[0].dependsOn = [];
  plan.operations[0].outputBindings = {};
  plan.operations[0].inputs.heroImageUrl = url;
  return plan;
}

test('maker-facing sections omit the execution trace without dropping operation data', (t) => {
  const plan = planFixture();
  const { html, document } = render(t, plan);
  assert.doesNotMatch(html, /Technical implementation trace|technicalDetails|technicalOperations|class="trace"/);
  assert.equal(document.has('technicalDetails'), false);
  assert.equal(document.has('technicalOperations'), false);
  assert.deepEqual(JSON.parse(document.get('operationsData').textContent), plan.operations);
  assert.match(document.get('pageChanges').innerHTML, /Create the Speakers page and navigation link/);
  assert.match(document.get('assetChanges').innerHTML, /Conference speaker portrait/);
  assert.match(document.get('checks').innerHTML, /class="card check"/);
  assert.match(document.get('deployments').innerHTML, /class="card deploy/);
});

test('important notes retain their contents with neutral surfaces, borders and text', (t) => {
  const plan = planFixture();
  plan.warnings.push({ label: 'Local review', description: 'Runtime verification is still pending.' });
  const { html, document } = render(t, plan);
  const notes = document.get('warnings').innerHTML;
  assert.equal((notes.match(/class="card plan-note"/g) || []).length, 2);
  assert.match(notes, /The local changes are not live until deployment succeeds/);
  assert.match(notes, /Runtime verification is still pending/);
  assert.doesNotMatch(notes, /class="[^"]*warning/);
  assert.match(html, /\.plan-note\{background:var\(--panel\);border-color:var\(--line\);color:var\(--ink\);overflow-wrap:anywhere\}/);
  const color = (name) => parseColor(html.match(new RegExp(`--${name}:(#[0-9a-f]+)`))[1]);
  assert.ok(contrastRatio(color('ink'), color('panel')) >= 4.5);
  plan.warnings = [];
  assert.match(render(t, plan).document.get('warnings').innerHTML, /No plan-level notes/);
});

test('navigation strings, objects, arrays and nested destinations remain readable and escaped', (t) => {
  const examples = [
    ['Primary Navigation', ['Primary Navigation']],
    [
      { label: 'Home', target: { page: 'Home', route: '/' } },
      ['Home', 'Target', 'Page', 'Route', '/'],
    ],
    [
      [
        { label: 'Services', route: '/services', children: [
          { label: 'Consulting', targetPage: 'Consulting', route: '/services/consulting' },
          { label: 'Training', url: '/training', order: 2 },
        ] },
        { label: 'Contact <team>', target: { name: 'Contact', route: '/contact' }, visible: false },
      ],
      ['Services', 'Children', 'Consulting', 'Target Page', '/services/consulting', 'Training', '/training', 'Order', '2', 'Contact &lt;team&gt;', '/contact', 'Visible', 'false'],
    ],
    [{ Primary: [{ name: 'Support', href: '/support', parent: 'Resources' }] }, ['Primary', 'Support', '/support', 'Resources']],
  ];
  for (const [navigation, expected] of examples) {
    const plan = planFixture();
    plan.operations[1].inputs.navigation = navigation;
    const output = render(t, plan).document.get('pageChanges').innerHTML;
    for (const text of expected) assert.ok(output.includes(text), text);
    assert.doesNotMatch(output, /\[object Object\]|<team>/);
    if (Array.isArray(navigation)) {
      assert.equal((output.match(/class="detail-list"/g) || []).length, 2, 'Both levels have distinct entry lists.');
      assert.ok(output.indexOf('Services') < output.indexOf('Consulting'));
      assert.ok(output.indexOf('Consulting') < output.indexOf('Training'));
    }
  }
});

test('Modify and Replace use distinct accessible colors across change cards and action badges', (t) => {
  const plan = planFixture();
  plan.assets = [];
  plan.operations = ['author-webpage', 'author-webpage-content', 'style-site'].flatMap((skill, index) =>
    ['modify', 'replace'].map((action) => ({
      ...structuredClone(plan.operations[1]), id: `${action}-${index}`, skill, action,
      dependsOn: [], outputBindings: {}, expectedOutputs: [],
    })));
  const { html, document } = render(t, plan);
  for (const category of ['pageChanges', 'componentChanges', 'styleChanges']) {
    const cards = document.get(category).innerHTML;
    for (const action of ['modify', 'replace']) {
      assert.match(cards, new RegExp(`class="card change [^"]*action-${action}"`));
      assert.match(cards, new RegExp(`class="tag action-badge action-${action}">${action[0].toUpperCase() + action.slice(1)}<`));
    }
  }
  const colors = Object.fromEntries(['modify', 'replace'].map((action) => {
    const foreground = html.match(new RegExp(`--${action}:(#[0-9a-f]+)`))[1];
    const background = html.match(new RegExp(`--${action}-soft:(#[0-9a-f]+)`))[1];
    assert.ok(contrastRatio(parseColor(foreground), parseColor(background)) >= 4.5, action);
    assert.ok(contrastRatio(parseColor(foreground), parseColor('#fff')) >= 3, `${action} border`);
    return [action, foreground];
  }));
  assert.notEqual(colors.modify, colors.replace);
  assert.match(html, /\.change\.action-modify,\.change\.action-replace\{border-left-color:var\(--action-color\)\}/);
  assert.match(html, /\.action-badge\{[^}]*background:var\(--action-surface[^}]*color:var\(--action-color/);
});

test('composition wireframes preserve all five layouts, column order, repeated elements and empty siblings', (t) => {
  const plan = planFixture();
  const layouts = [
    ['one-column', [12]], ['two-equal-columns', [6, 6]], ['three-equal-columns', [4, 4, 4]],
    ['one-third-left', [4, 8]], ['one-third-right', [8, 4]],
  ];
  plan.operations[1].inputs.sections = layouts.map(([layout, widths], index) => ({
    layout, name: `Section <${index}>`,
    columns: widths.map((_, column) => ({ elements: column === widths.length - 1 && column > 0 ? [] : [
      { type: 'text', content: `Intro ${index}-${column}` },
      { type: 'button', label: 'Explore services' },
      { type: 'button', label: 'Contact us' },
      { type: 'image', alt: 'People collaborating' },
      { type: 'video', title: 'Meet our team' },
      { type: 'spacer' },
    ] })),
  }));
  const output = render(t, plan).document.get('pageChanges').innerHTML;
  assert.equal((output.match(/class="composition-row"/g) || []).length, 5);
  assert.equal((output.match(/class="wire-column"/g) || []).length, 10);
  assert.equal((output.match(/class="wire-empty">Empty column/g) || []).length, 4);
  for (const [layout, widths] of layouts) {
    const tracks = widths.map((width) => `minmax(0,${width}fr)`).join(' ');
    assert.ok(output.includes(`grid-template-columns:${tracks}`), layout);
  }
  assert.ok(output.indexOf('Explore services') < output.indexOf('Contact us'));
  assert.ok(output.indexOf('Contact us') < output.indexOf('People collaborating'));
  for (const type of ['text', 'image', 'button', 'video', 'spacer']) {
    assert.match(output, new RegExp(`class="wire-element ${type}"`));
  }
  assert.match(output, /Section &lt;0&gt;/);
  assert.match(output, /Structure only, not a live site preview/);
  assert.equal((output.match(/class="wire-scroll multi" tabindex="0" role="region"/g) || []).length, 4);
  assert.match(output, /Scroll sideways to inspect columns/);
  assert.doesNotMatch(output, /Column widths unresolved|<Section/);
});

test('unknown and incomplete compositions disclose unresolved widths instead of inventing structure', (t) => {
  const plan = planFixture();
  plan.operations[1].inputs.sections = [
    { layout: 'custom', columns: [{ elements: [{ type: 'custom-widget', label: 'Requested widget' }] }] },
    { layout: 'three-equal-columns', columns: [{ elements: [] }] },
    { layout: 'two-equal-columns' },
  ];
  const output = render(t, plan).document.get('pageChanges').innerHTML;
  assert.equal((output.match(/Column widths unresolved/g) || []).length, 3);
  assert.equal((output.match(/class="wire-column"/g) || []).length, 2, 'Never add unspecified columns.');
  assert.match(output, /No columns specified/);
  assert.match(output, /class="wire-element other"/);
  assert.match(output, /Requested widget/);
  assert.doesNotMatch(output, /4\/12 width/);
});

test('approved hosted images have previews, aspect ratios, alt text and usable source metadata', (t) => {
  for (const plan of [planFixture(), externalImagePlan()]) {
    const asset = plan.assets[0];
    const { document } = render(t, plan);
    const card = document.get('assetChanges').innerHTML;
    const url = asset.externalUrl || asset.source.downloadUrl.replace(/&/g, '&amp;');
    assert.ok(card.includes(`src="${url}"`));
    assert.match(card, /alt="Conference speaker presenting to an audience"/);
    assert.match(card, /style="--asset-aspect:4\/3"/);
    assert.match(card, /loading="lazy" referrerpolicy="no-referrer"/);
    assert.match(card, /target="_blank" rel="noopener noreferrer"/);
    assert.match(card, /Open image source/);
    assert.ok(card.includes(asset.source.license));
    if (asset.source.type === 'unsplash') {
      assert.match(card, /Example Photographer/);
      assert.match(card, /href="https:\/\/unsplash.com\/photos\/example"/);
    }
  }
});

test('preview attributes escape quotes and never turn unsafe source metadata into links or CSS', (t) => {
  const plan = externalImagePlan('https://cdn.example.com/image?label="><script>alert(1)</script>');
  plan.assets[0].accessibility.altByLocale['en-US'] = 'Team " onerror="alert(1)';
  plan.assets[0].source.sourcePage = 'javascript:alert(1)';
  plan.assets[0].visual.aspectRatio = '1; background:url(https://example.com/tracker)';
  const card = render(t, plan).document.get('assetChanges').innerHTML;
  assert.match(card, /alt="Team &quot; onerror=&quot;alert\(1\)"/);
  assert.match(card, /src="https:\/\/cdn\.example\.com\/image\?label=&quot;&gt;&lt;script&gt;/);
  assert.match(card, /style="--asset-aspect:4\/3"/);
  assert.doesNotMatch(card, /<script>|href="javascript:|style="[^"]*background:url| onerror="alert/);
});

test('local assets without a hosted URL show an explicit unavailable preview without guessing a runtime host', (t) => {
  const plan = externalImagePlan();
  const asset = plan.assets[0];
  asset.delivery = 'web-file';
  delete asset.externalUrl;
  asset.source = { type: 'existing-site' };
  asset.existingPublicUrl = '/speaker.jpg';
  asset.preparation = { status: 'existing' };
  const card = render(t, plan).document.get('assetChanges').innerHTML;
  assert.match(card, /Image preview unavailable/);
  assert.match(card, /\/speaker\.jpg/);
  assert.doesNotMatch(card, /<img\b/);
});

function imageStub(complete = false, naturalWidth = 0) {
  const label = { textContent: 'Loading image preview...' };
  const fallback = { hidden: false, querySelector: () => label };
  const listeners = {};
  const image = {
    complete, naturalWidth, hidden: false,
    parentElement: { querySelector: () => fallback },
    addEventListener: (name, callback) => { listeners[name] = callback; },
  };
  return { image, fallback, label, listeners };
}

test('image load/error and already-complete images settle to a visible image or explicit fallback', (t) => {
  for (const cached of [false, true]) {
    for (const succeeds of [false, true]) {
      const stub = imageStub(cached, cached && succeeds ? 1200 : 0);
      render(t, externalImagePlan(), [stub.image]);
      if (!cached) {
        assert.equal(stub.fallback.hidden, false, 'Loading state stays visible until the image settles.');
        stub.image.naturalWidth = succeeds ? 1200 : 0;
        stub.listeners[succeeds ? 'load' : 'error']();
      }
      assert.equal(stub.image.hidden, !succeeds);
      assert.equal(stub.fallback.hidden, succeeds);
      if (!succeeds) assert.equal(stub.label.textContent, 'Image preview unavailable');
    }
  }
});
