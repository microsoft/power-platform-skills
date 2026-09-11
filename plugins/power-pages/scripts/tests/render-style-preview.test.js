'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const {
  compileStyles, replaceBlock, planHash, KINDS, PARTS, VALUES, validateRequest,
} = require('../lib/style-site-plan');
const { hash } = require('../lib/classic-site-style-context');
const {
  main, renderStylePreview, validatePreview, rebuildPreview, browserRuntime,
} = require('../../skills/style-site/scripts/render-style-preview');

const scriptPath = path.resolve(__dirname, '../../skills/style-site/scripts/render-style-preview.js');
const templatePath = path.resolve(__dirname, '../../skills/style-site/assets/style-preview.html');
const samplePath = path.resolve(__dirname, '../../skills/style-site/assets/component-samples.json');

function setup(t, { major = 3, studio = false, hostile = false } = {}) {
  // Keep renderer fixtures in the working tree, not an OS temporary directory.
  const work = path.resolve(`.style-preview-test-${crypto.randomUUID()}`);
  const root = path.join(work, 'site', '.powerpages-site');
  fs.mkdirSync(path.join(root, 'web-pages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'website.yml'), 'id: 11111111-1111-4111-8111-111111111111\n');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const attack = '</script><script>window.compromised=true</script><img src="https://example.invalid/leak" onerror="alert(1)">';
  const component = {
    id: 'service-card', label: hostile ? attack : 'Service card', kind: 'card', className: 'pp-card',
    sourcePath: 'web-pages/home/Home.webpage.copy.html',
  };
  const request = {
    title: hostile ? attack : 'A considered card treatment',
    pageId: '22222222-2222-4222-8222-222222222222',
    components: [component],
    styles: [{
      id: 'card-decoration', componentId: component.id, owner: 'custom', scope: 'site',
      targetId: '33333333-3333-4333-8333-333333333333',
      declarations: { color: '#345b50', padding: '20px', 'border-radius': '12px', 'font-family': 'Georgia, serif' },
      rationale: 'An explicit reusable custom component treatment.',
    }],
  };
  const before = '/* Unrelated CSS before. */\r\n' +
    replaceBlock('', 'card-decoration', '.pp-card {\n  border-radius: 4px;\n}').replace(/\r?\n/g, '\r\n') +
    '.another-component { color: #111111; }\r\n';
  const after = replaceBlock(before, request.styles[0].id, compileStyles(request)[0].css);
  const writes = [{ path: 'web-files/custom.css', kind: 'css', before, after, beforeHash: hash(before), afterHash: hash(after) }];
  const placements = [{
    styleId: request.styles[0].id, owner: 'custom', scope: 'site', path: writes[0].path,
    affectedPageIds: [request.pageId],
  }];
  if (studio) {
    request.styles.push({
      id: 'native-surface', componentId: component.id, owner: 'studio', scope: 'site',
      declarations: { 'background-color': '#f4f3ee' }, rationale: 'Preserve native ownership.',
      studioAction: 'Set the component background using its Studio paintbrush.',
    });
    placements.push({ styleId: 'native-surface', owner: 'studio', scope: 'site', action: request.styles[1].studioAction });
  }
  const source = '<div class="container"><section class="pp-card" data-component-theme="native">' +
    '<h2>Local services</h2><p>Original local content.</p><button class="btn btn-primary">Explore</button>' +
    (hostile ? attack + '{% include "Dynamic component" %}<span>{{ user.name }}</span>' +
      '<iframe src="https://example.invalid/embed"></iframe><form action="https://example.invalid/submit">' +
      '<input type="hidden" name="token" value="example-only"><button onclick="alert(1)" type="submit">Send</button></form>' +
      '<a href="javascript:alert(1)">Link</a>' : '') + '</section></div>';
  const layers = [
    { path: 'web-files/bootstrap.min.css', before: `/*! Bootstrap v${major === 3 ? '3.3.6' : '5.2.2'} */\n.btn{padding:6px 12px}`, order: 1 },
    { path: 'web-files/theme.css', before: '.pp-card { color: #333333; }', order: 2 },
    { path: writes[0].path, before, after, order: 3 },
    { path: 'web-files/portalbasictheme.css', before: '.pp-card { margin: 16px; }', order: 10 },
  ].map((layer) => ({ ...layer, after: layer.after ?? layer.before }));
  if (hostile) {
    layers[0].before = '@import url("https://example.invalid/styles.css");\n' +
      '.pp-card { background-image: url("https://example.invalid/pixel"); }\n' +
      '/* </style><script>window.compromised=true</script> */\n' + layers[0].before;
    layers[0].after = layers[0].before;
  }
  const plan = {
    schemaVersion: 1, siteRoot: root, siteId: '11111111-1111-4111-8111-111111111111',
    title: request.title, request, allocatedIds: {},
    bootstrap: { major, version: major === 3 ? '3.3.6' : '5.2.2', evidence: [{ source: layers[0].path, kind: 'asset', major }] },
    inputs: [], placements, warnings: ['Stylesheet ordering is inferred from local metadata.'], writes,
    preview: {
      components: [{ ...component, before: source, after: source, simulation: hostile }],
      layers,
      studioCss: compileStyles(request, 'studio').map((rule) => rule.css).join('\n'),
    },
  };
  plan.planHash = planHash(plan);
  const planPath = path.join(work, 'proposal.json');
  fs.writeFileSync(planPath, JSON.stringify(plan));
  return { work, root, plan, planPath, attack, output: path.join(work, 'style-preview.html') };
}

function embeddedPlan(html) {
  return JSON.parse(html.match(/const plan = (.+);\r?\n/)[1]);
}

test('CLI renders an offline proposal without --siteRoot and reports the output filename', (t) => {
  const f = setup(t);
  const result = spawnSync(process.execPath, [scriptPath, '--plan', f.planPath, '--out', f.output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'ok', output: f.output });
  const html = fs.readFileSync(f.output, 'utf8');
  assert.deepEqual(embeddedPlan(html), f.plan);
  assert.ok(html.includes('Local visual preview, not the Power Pages runtime.'));
  assert.equal(fs.existsSync(path.join(f.root, 'style-preview.html')), false);
  assert.equal(fs.existsSync(path.join(f.work, 'power-pages-icon.png')), false, 'Self-contained previews create no icon sidecar.');
});

test('renderer uses a nonce, shared context encoders and no executable project content', (t) => {
  const f = setup(t, { hostile: true, studio: true });
  renderStylePreview(f.plan, f.output);
  const html = fs.readFileSync(f.output, 'utf8');
  assert.doesNotMatch(html, /<\/script><script>window\.compromised/);
  assert.match(html, /\\u003c\/script\\u003e\\u003cscript\\u003ewindow\.compromised/);
  assert.match(html, /<title>&lt;\/script&gt;&lt;script&gt;/);
  assert.equal(embeddedPlan(html).request.title, f.attack);
  const scripts = [...html.matchAll(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.match(scripts[0][1], /^[a-zA-Z0-9+/]{22}==$/);
  assert.ok(html.includes(`script-src 'nonce-${scripts[0][1]}'`));
  assert.doesNotThrow(() => new vm.Script(scripts[0][2]), 'The complete embedded browser program must parse.');
  assert.equal([...html.matchAll(/<iframe\b[^>]*sandbox=""/g)].length, 2);
  assert.doesNotMatch(html, /sandbox="[^"]*(?:allow-scripts|allow-same-origin)/);
  assert.match(html, /frame-src about:/);
  assert.match(html, /script-src 'none'; connect-src 'none'/);
  assert.match(html, /new DOMParser\(\)/);
  assert.match(html, /allowedTags\.has\(tag\)/);
  assert.match(html, /discardedTags\.has\(tag\)/);
  assert.match(html, /element\.setAttribute\('src', imagePlaceholder\)/);
});

test('all controls have request mappings; reset, viewport and draft export actions are wired', (t) => {
  const f = setup(t);
  main(['--plan', f.planPath, '--out', f.output]);
  const html = fs.readFileSync(f.output, 'utf8');
  for (const id of ['component-select', 'style-select', 'controls', 'desktop-button', 'mobile-button', 'state-select', 'compare-button', 'reset-button', 'export-button']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  for (const id of ['desktop-button', 'mobile-button', 'reset-button', 'export-button', 'compare-button']) {
    assert.ok(html.includes(`byId('${id}').addEventListener('click'`), `${id} has an action`);
  }
  assert.match(html, /Object\.entries\(style\.declarations\)/);
  assert.match(html, /input\.dataset\.styleId = style\.id/);
  assert.match(html, /input\.dataset\.property = property/);
  assert.match(html, /style\.declarations\[property\] = value/);
  assert.match(html, /request = clone\(originalRequest\)/);
  assert.match(html, /new Blob\(\[JSON\.stringify\(request, null, 2\)/);
  assert.match(html, /link\.download = 'style-site-draft-request\.json'/);
  assert.match(html, /URL\.revokeObjectURL\(url\)/);
  assert.match(html, /window\.styleSitePreview = Object\.freeze/);
  assert.doesNotMatch(html, /\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/);
});

test('browser and Node rebuilds agree exactly and preserve CSS layer order and unrelated bytes', (t) => {
  const f = setup(t, { studio: true });
  const draft = structuredClone(f.plan.request);
  draft.styles[0].declarations.padding = '32px 48px';
  draft.styles[0].declarations['border-radius'] = '24px';
  draft.styles[1].declarations['background-color'] = '#f0f0f0';
  const expected = rebuildPreview(f.plan, draft);
  const browser = vm.runInNewContext(`${browserRuntime()}\n({rebuildPreview, validateDraftValues, VALUES})`);
  const actual = browser.rebuildPreview(f.plan, draft);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  assert.deepEqual(actual.layers.map((layer) => layer.path), f.plan.preview.layers.map((layer) => layer.path));
  assert.equal(actual.layers[0].after, f.plan.preview.layers[0].after);
  assert.equal(actual.layers[3].after, '.pp-card { margin: 16px; }');
  assert.match(actual.layers[2].after, /padding: 32px 48px;\r\n/);
  assert.ok(actual.layers[2].after.endsWith('.another-component { color: #111111; }\r\n'));
  assert.equal(actual.layers[2].after.split('power-pages:style-site:card-decoration:start').length, 2);
  assert.match(actual.studioCss, /background-color: #f0f0f0/);
  assert.doesNotMatch(actual.layers.map((layer) => layer.after).join('\n'), /#f0f0f0|native-surface/);
  for (const [property, regex] of Object.entries(VALUES)) {
    assert.equal(browser.VALUES[property].source, regex.source);
    assert.equal(browser.VALUES[property].flags, regex.flags);
  }
  assert.equal(validateRequest(draft), draft);
  draft.styles[0].declarations.padding = '1px; background:url(https://example.invalid)';
  assert.throws(() => browser.validateDraftValues(draft), /Unsupported padding/);
});

test('browser compiler follows every exported component part and current focus/opacity values', (t) => {
  const f = setup(t);
  const browser = vm.runInNewContext(`${browserRuntime()}\n({compileStyles})`);
  for (const part of PARTS) {
    const draft = structuredClone(f.plan.request);
    draft.styles[0].part = part;
    draft.styles[0].declarations = {
      'outline-width': '2px', 'outline-offset': '3px', 'outline-style': 'solid',
      'outline-color': '#345b50', opacity: '0.75',
    };
    const expected = compileStyles(draft);
    assert.equal(JSON.stringify(browser.compileStyles(draft)), JSON.stringify(expected), part || 'component root');
    assert.ok(expected[0].css.startsWith(`.pp-card${part} {\n`));
    assert.match(expected[0].css, /opacity: 0\.75;/);
    assert.match(expected[0].css, /outline-offset: 3px;/);
  }
});

test('preview validates schema, component source, ownership and compiler correspondence', (t) => {
  const f = setup(t, { studio: true });
  assert.equal(validatePreview(f.plan), f.plan);
  for (const mutate of [
    (plan) => { plan.preview.layers[2].after += '\n.pp-card { color: red; }'; },
    (plan) => { plan.preview.layers.pop(); plan.preview.layers.push({ ...plan.preview.layers[0] }); },
    (plan) => { plan.preview.components[0].className = 'pp-not-the-request'; },
    (plan) => { plan.preview.components[0].after += '<div>Unapproved markup</div>'; },
    (plan) => { plan.preview.studioCss = ''; },
    (plan) => { plan.placements[0].owner = 'studio'; },
    (plan) => { plan.preview.layers = []; },
  ]) {
    const changed = structuredClone(f.plan);
    mutate(changed);
    changed.planHash = planHash(changed);
    assert.throws(() => validatePreview(changed), /preview|Preview|CSS|ownership|managed blocks/);
  }
  const tampered = structuredClone(f.plan);
  tampered.title += 'Edited without regeneration';
  assert.throws(() => validatePreview(tampered), /Invalid or modified proposal/);
});

test('existing output, including a different document, is never overwritten', (t) => {
  const f = setup(t);
  fs.writeFileSync(f.output, 'Keep the prior review.');
  assert.throws(() => renderStylePreview(f.plan, f.output), /already exists/);
  assert.equal(fs.readFileSync(f.output, 'utf8'), 'Keep the prior review.');
  const icon = path.join(f.work, 'power-pages-icon.png');
  fs.writeFileSync(icon, 'An unrelated existing asset.');
  renderStylePreview(f.plan, path.join(f.work, 'new-review.html'));
  assert.equal(fs.readFileSync(icon, 'utf8'), 'An unrelated existing asset.');
});

test('preview cannot be created inside the upload tree or through an alias into it', (t) => {
  const f = setup(t);
  const internal = path.join(f.root, 'reviews', 'style-preview.html');
  assert.throws(() => renderStylePreview(f.plan, internal), /outside the uploadable/);
  assert.equal(fs.existsSync(path.dirname(internal)), false);
  const alias = path.join(f.work, 'linked-site');
  try { fs.symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic('Directory links unavailable; direct boundary checked.'); return; }
    throw error;
  }
  assert.throws(() => renderStylePreview(f.plan, path.join(alias, 'style-preview.html')), /outside the uploadable/);
});

test('--siteRoot is an optional confirmation and cannot silently select a different site', (t) => {
  const f = setup(t);
  assert.equal(main(['--plan', f.planPath, '--out', f.output, '--siteRoot', path.dirname(f.root)]).output, f.output);
  const other = path.join(f.work, 'another-site');
  fs.mkdirSync(path.join(other, 'web-pages'), { recursive: true });
  fs.writeFileSync(path.join(other, 'website.yml'), 'id: 44444444-4444-4444-8444-444444444444\n');
  assert.throws(() => renderStylePreview(f.plan, path.join(f.work, 'different.html'), other), /does not match/);
});

test('portable plan can render after the original site folder becomes unavailable', (t) => {
  const f = setup(t);
  fs.rmSync(f.root, { recursive: true });
  assert.equal(main(['--plan', f.planPath, '--out', f.output]).output, f.output);
  assert.equal(fs.existsSync(f.root), false);
});

test('Studio-only plans allow sample-only components and never create local custom rules', (t) => {
  const f = setup(t, { major: 5 });
  const plan = f.plan;
  delete plan.request.components[0].sourcePath;
  plan.request.components[0].kind = 'form';
  Object.assign(plan.request.styles[0], { owner: 'studio', studioAction: 'Set the native form colors in Studio.' });
  plan.placements = [{ styleId: plan.request.styles[0].id, owner: 'studio', scope: 'site', action: plan.request.styles[0].studioAction }];
  plan.writes = [];
  plan.preview.components = [{ ...plan.request.components[0], before: null, after: null, simulation: true }];
  plan.preview.layers = plan.preview.layers.map((layer) => ({ ...layer, after: layer.before }));
  plan.preview.studioCss = compileStyles(plan.request, 'studio').map((rule) => rule.css).join('\n');
  plan.planHash = planHash(plan);
  renderStylePreview(plan, f.output);
  const rendered = embeddedPlan(fs.readFileSync(f.output, 'utf8'));
  assert.deepEqual(compileStyles(rendered.request), []);
  assert.deepEqual(rendered.writes, []);
  assert.equal(rendered.preview.components[0].before, null);
  assert.match(rendered.preview.studioCss, /\.pp-card/);
  assert.equal(rendered.bootstrap.major, 5);
});

test('class addition preview keeps distinct original and class-edited source', (t) => {
  const f = setup(t);
  const component = f.plan.preview.components[0];
  component.before = component.before.replace('class="pp-card"', 'class="original-card"');
  component.after = component.before.replace('class="original-card"', 'class="original-card pp-card"');
  f.plan.request.classEdits = [{
    path: component.sourcePath,
    match: '<section class="original-card" data-component-theme="native">',
    className: component.className,
  }];
  f.plan.writes.push({
    path: component.sourcePath, kind: 'class', before: component.before, after: component.after,
    beforeHash: hash(component.before), afterHash: hash(component.after),
  });
  f.plan.planHash = planHash(f.plan);
  renderStylePreview(f.plan, f.output);
  const source = embeddedPlan(fs.readFileSync(f.output, 'utf8')).preview.components[0];
  assert.doesNotMatch(source.before, /class="[^"]*\bpp-card\b/);
  assert.match(source.after, /class="original-card pp-card"/);
});

test('CLI rejects unknown/missing arguments and invalid plan JSON', (t) => {
  const f = setup(t);
  assert.throws(() => main([]), /Usage:/);
  assert.throws(() => main(['--plan', f.planPath, '--out']), /Missing value/);
  assert.throws(() => main(['--plan', f.planPath, '--out', f.output, '--apply']), /Unknown/);
  fs.writeFileSync(f.planPath, '{not json}');
  assert.throws(() => main(['--plan', f.planPath, '--out', f.output]), SyntaxError);
  assert.equal(fs.existsSync(f.output), false);
});

test('BS3 and BS5 samples cover each kind and use version-appropriate native classes', () => {
  const samples = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
  assert.equal(samples.schemaVersion, 1);
  for (const major of [3, 5]) {
    for (const kind of KINDS) {
      const sample = samples.versions[major][kind];
      assert.equal(typeof sample.html, 'string');
      for (const html of [sample.html, ...Object.values(sample.states || {})]) {
        assert.match(html, /__COMPONENT_CLASS__/);
        assert.doesNotMatch(html, /<script|<iframe|\bon\w+\s*=|\b(?:action|src)\s*=/i);
      }
    }
  }
  assert.match(samples.versions[3].card.html, /panel panel-default/);
  assert.match(samples.versions[3].image.html, /img-responsive/);
  assert.match(samples.versions[3].form.html, /form-group/);
  assert.doesNotMatch(JSON.stringify(samples.versions[3]), /form-select|img-fluid|card-body|data-bs-/);
  assert.match(samples.versions[5].card.html, /card-body/);
  assert.match(samples.versions[5].image.html, /img-fluid/);
  assert.match(samples.versions[5].form.html, /form-select/);
  assert.doesNotMatch(JSON.stringify(samples.versions[5]), /panel-body|img-responsive|form-group|glyphicon/);
  for (const major of [3, 5]) {
    assert.ok(samples.versions[major].form.states.error);
    assert.ok(samples.versions[major].list.states.empty);
    assert.ok(samples.versions[major].list.states.loading);
    assert.ok(samples.versions[major].button.states.disabled);
  }
});

test('preview provides accessibility, sanitization limits and class-addition correspondence', () => {
  const html = fs.readFileSync(templatePath, 'utf8');
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /depth > 64/);
  assert.match(html, /let remaining = 12000/);
  assert.match(html, /elementAt\(sourceBody, elementPath\(afterTarget, afterBody\)\)/);
  assert.match(html, /before the class addition/);
  assert.match(html, /id="class-edit-summary"/);
  assert.match(html, /Proposed structural change: add/);
  assert.match(html, /'form', 'list'/);
  assert.match(html, /style\.declarations/);
});
