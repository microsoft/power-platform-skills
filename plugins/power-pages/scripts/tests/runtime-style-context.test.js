'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { fixture, ids } = require('./style-site-fixtures');
const { inspectSite } = require('../lib/classic-site-style-context');
const {
  STYLE_PROPERTIES, normalizeRuntimeUrl, buildRuntimeInspection, validateRuntimeSnapshot, attachRuntimeEvidence,
} = require('../lib/runtime-style-context');
const { main: inspect } = require('../../skills/style-site/scripts/inspect-style-context');
const { main: generate } = require('../../skills/style-site/scripts/inspect-runtime-dom');

const runtimeUrl = 'https://contoso.powerappsportals.com/services/';

function snapshot() {
  return {
    schemaVersion: 1, source: 'runtime-dom', pageUrl: runtimeUrl, queryOmitted: false,
    capturedAt: '2026-01-01T00:00:00.000Z', rootSelector: 'main',
    scannedElements: 1, truncated: false, omittedBoundaries: 0,
    candidates: [{
      id: 'runtime-1', kind: 'card', tag: 'section', domId: null, classes: ['pp-card'],
      attributesOmitted: false, locator: 'html:nth-of-type(1) > body:nth-of-type(1) > section:nth-of-type(1)',
      computedStyles: Object.fromEntries(STYLE_PROPERTIES.map((key) => [key, key === 'color' ? 'rgb(0, 0, 0)' : 'initial'])),
    }],
  };
}

function browserFixture(children, url = runtimeUrl) {
  const attributesByNode = new WeakMap();
  const calls = { computed: 0, properties: [] };
  function node(tag, attributes = {}, descendants = []) {
    const element = {
      localName: tag, nodeType: 1, children: descendants, parentElement: null, previousElementSibling: null,
      classList: (attributes.class || '').split(/\s+/).filter(Boolean),
      getAttribute(name) {
        assert.ok(['id', 'type'].includes(name), `Must not read attribute ${name}`);
        return attributes[name] ?? null;
      },
      getClientRects: () => attributes.hidden || attributes.display === 'none' ? [] : [1],
      checkVisibility: () => !attributes.hidden && attributes.visibility !== 'hidden',
      shadowRoot: attributes.shadowRoot ?? null,
    };
    attributesByNode.set(element, attributes);
    for (const field of ['value', 'innerHTML', 'outerHTML', 'textContent', 'innerText', 'href', 'src', 'dataset']) {
      Object.defineProperty(element, field, { get() { throw new Error(`Must not read ${field}`); } });
    }
    for (const method of ['click', 'submit', 'focus', 'dispatchEvent', 'setAttribute']) {
      element[method] = () => { throw new Error(`Must not call ${method}`); };
    }
    descendants.forEach((child, index) => { child.parentElement = element; child.previousElementSibling = descendants[index - 1] || null; });
    return element;
  }
  const root = node('body', {}, children(node));
  const filters = { SHOW_ELEMENT: 1, FILTER_REJECT: 2, FILTER_ACCEPT: 1 };
  const document = {
    readyState: 'complete',
    querySelectorAll(selector) {
      if (selector === 'body') return [root];
      if (selector === 'ambiguous') return [root, root];
      const all = (element) => [element, ...element.children.flatMap(all)];
      return all(root).filter((element) => selector.startsWith('#') ?
        element.getAttribute('id') === selector.slice(1) :
        selector.startsWith('.') ? element.classList.includes(selector.slice(1)) : element.localName === selector);
    },
    createTreeWalker(start, mask, filter) {
      const pending = [...start.children];
      return { nextNode() {
        while (pending.length) {
          const next = pending.shift();
          if (filter.acceptNode(next) === filters.FILTER_REJECT) continue;
          pending.unshift(...next.children);
          return next;
        }
        return null;
      } };
    },
  };
  const context = {
    URL, document, location: { href: url }, NodeFilter: filters,
    getComputedStyle(element) {
      calls.computed += 1;
      const attributes = attributesByNode.get(element);
      return {
        display: attributes.display || 'block', visibility: attributes.visibility || 'visible',
        getPropertyValue(property) {
          calls.properties.push(property);
          return attributes.styles?.[property] ?? 'initial';
        },
      };
    },
  };
  for (const owner of [context, document]) {
    for (const field of ['cookie', 'localStorage', 'sessionStorage']) {
      Object.defineProperty(owner, field, { get() { throw new Error(`Must not read ${field}`); } });
    }
  }
  for (const method of ['fetch', 'XMLHttpRequest']) {
    context[method] = () => { throw new Error(`Must not call ${method}`); };
  }
  return { context, document, root, calls };
}

function collect(browser, options = {}) {
  const code = buildRuntimeInspection({ url: runtimeUrl, ...options });
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${code})()`, browser.context)));
}

for (const options of [{}, { mode: 'structure' }, { mode: 'styles', properties: ['color'] }]) {
  test(`collector preserves privacy boundaries in ${options.mode || 'legacy'} capture`, () => {
    const browser = browserFixture((node) => [
      node('section', { class: 'sectionBlockLayout pp-card', id: 'service-card' }, [
        node('input', { type: 'password' }), node('input', { type: 'hidden' }), node('input', { type: 'file' }), node('p'),
      ]),
      node('iframe', {}, [node('section', { class: 'pp-private-frame' })]),
      node('custom-widget', {}, [node('button', { class: 'pp-private-widget' })]),
      node('div', { shadowRoot: {} }, [node('button', { class: 'pp-private-shadow' })]),
      ...['object', 'embed', 'script', 'style', 'template', 'noscript', 'svg']
        .map((tag) => node(tag, {}, [node('section', { class: 'pp-private-boundary' })])),
      node('section', { class: 'pp-hidden', hidden: true }),
      node('section', { class: 'pp-hidden-visibility', visibility: 'hidden' }),
      node('div', { class: 'contoso-card', id: 'custom-component' }),
    ]);
    const result = collect(browser, options);
    assert.equal(validateRuntimeSnapshot(result), result);
    assert.equal(result.candidates.length, 3);
    assert.equal(result.candidates[0].domId, 'service-card');
    assert.deepEqual(result.candidates[0].classes, ['sectionBlockLayout', 'pp-card']);
    assert.deepEqual(result.candidates[2].classes, ['contoso-card']);
    assert.equal(result.omittedBoundaries, 10);
    assert.doesNotMatch(JSON.stringify(result), /pp-private|pp-hidden|password/);
    assert.match(result.candidates[0].locator, /section:nth-of-type\(1\)$/);
  });
}

test('structural first pass performs zero computed style reads and remains bounded', () => {
  const browser = browserFixture((node) => Array.from({ length: 15 }, () => node('section')));
  browser.context.getComputedStyle = () => { throw new Error('Structure must not call getComputedStyle'); };
  const result = collect(browser, { mode: 'structure', maxCandidates: 10 });
  assert.equal(validateRuntimeSnapshot(result), result);
  assert.equal(result.mode, 'structure');
  assert.deepEqual(result.properties, []);
  assert.equal(result.candidates.length, 10);
  assert.equal(result.truncated, true);
  assert.ok(result.candidates.every((candidate) => Object.keys(candidate.computedStyles).length === 0));
  assert.equal(browser.calls.computed, 0);
  // Older hosts without checkVisibility can only infer visibility from layout
  // boxes in this pass; they still must not fall back to getComputedStyle.
  delete browser.root.children[0].checkVisibility;
  assert.equal(collect(browser, { mode: 'structure', maxCandidates: 1 }).candidates.length, 1);
});

test('styles pass reads only the requested properties on an explicitly selected target', () => {
  const browser = browserFixture((node) => [
    node('section', { id: 'chosen', class: 'pp-card', styles: { color: 'rgb(0, 0, 0)', 'font-size': '' } }, [node('p')]),
    node('section', { class: 'unrelated' }),
  ]);
  const result = collect(browser, { mode: 'styles', selector: '#chosen', maxCandidates: 1, properties: ' color, font-size ' });
  assert.equal(validateRuntimeSnapshot(result), result);
  assert.deepEqual(result.properties, ['color', 'font-size']);
  assert.deepEqual(result.candidates[0].computedStyles, { color: 'rgb(0, 0, 0)', 'font-size': '' });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].domId, 'chosen');
  assert.equal(browser.calls.computed, 1);
  assert.deepEqual(browser.calls.properties, ['color', 'font-size']);
  assert.equal(Object.hasOwn(result.candidates[0].computedStyles, 'padding'), false);
  const arrayInput = collect(browser, { selector: '#chosen', maxCandidates: 1, properties: ['color'] });
  assert.equal(arrayInput.mode, 'styles');
  assert.deepEqual(arrayInput.candidates[0].computedStyles, { color: 'rgb(0, 0, 0)' });
});

test('legacy defaults keep the full property set, 60 candidates and original snapshot shape', () => {
  const result = collect(browserFixture((node) => Array.from({ length: 65 }, () => node('section'))));
  assert.equal(result.candidates.length, 60);
  assert.equal(result.truncated, true);
  assert.equal(result.rootSelector, 'body');
  assert.equal(Object.hasOwn(result, 'mode'), false);
  assert.equal(Object.hasOwn(result, 'properties'), false);
  assert.deepEqual(Object.keys(result.candidates[0].computedStyles), STYLE_PROPERTIES);
  assert.equal(validateRuntimeSnapshot(result), result);
  assert.equal(validateRuntimeSnapshot(snapshot()).schemaVersion, 1);
  const explicit = collect(browserFixture((node) => [node('section')]), { mode: 'styles' });
  assert.deepEqual(explicit.properties, STYLE_PROPERTIES);
  assert.deepEqual(Object.keys(explicit.candidates[0].computedStyles), STYLE_PROPERTIES);
});

test('capture mode and property selections reject invalid or privacy-expanding inputs', () => {
  for (const options of [
    { mode: 'all' }, { mode: '' }, { mode: null }, { mode: 1 },
    { properties: '' }, { properties: [] }, { properties: null }, { properties: true },
    { properties: 'color,' }, { properties: 'color,,padding' }, { properties: 'color,color' },
    { properties: ['color', 'color'] }, { properties: ['color', 1] }, { properties: Array(1) },
    { properties: 'Color' }, { properties: '--private' }, { properties: 'content' },
    { properties: 'background-image' }, { properties: 'href' }, { properties: '__proto__' },
    { mode: 'structure', properties: 'color' }, { mode: 'structure', properties: '' },
  ]) {
    assert.throws(() => buildRuntimeInspection({ url: runtimeUrl, ...options }), /mode|properties/);
  }
  const code = generate(['--url', runtimeUrl, '--mode', 'structure', '--maxCandidates', '10']);
  assert.equal(JSON.parse(JSON.stringify(vm.runInNewContext(`(${code})()`,
    browserFixture((node) => [node('section')]).context))).mode, 'structure');
  assert.throws(() => generate(['--url', runtimeUrl, '--properties', 'content']), /properties/);
  assert.throws(() => generate(['--url', runtimeUrl, '--mode', 'structure', '--properties', 'color']), /properties/);
});

test('a narrow selector cannot bypass embedded, custom or shadow-host boundaries', () => {
  for (const mode of ['structure', 'styles']) {
    for (const [tag, attributes] of [['custom-widget', {}], ['div', { shadowRoot: {} }], ['iframe', {}]]) {
      const browser = browserFixture((node) => [node(tag, attributes, [node('section', { id: 'nested' })])]);
      assert.throws(() => collect(browser, { mode, selector: '#nested' }), /boundary/);
    }
  }
});

test('URL input is explicit, HTTPS by default, redirect-bound, and query data is not saved', () => {
  for (const url of ['file:///site.html', 'http://contoso.com/', 'https://user:secret@contoso.com/']) {
    assert.throws(() => normalizeRuntimeUrl(url), /HTTPS/);
  }
  assert.equal(normalizeRuntimeUrl('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000/');
  const withQuery = runtimeUrl + '?record=example-only#details';
  const browser = browserFixture((node) => [node('section')], withQuery);
  const result = collect(browser, { url: withQuery });
  assert.equal(result.pageUrl, runtimeUrl);
  assert.equal(result.queryOmitted, true);
  assert.doesNotMatch(JSON.stringify(result), /record=|example-only|#details/);
  assert.throws(() => collect(browser), /different URL/);
  browser.context.location.href = 'https://contoso.powerappsportals.com/SignIn';
  assert.throws(() => collect(browser), /login redirect/);
});

test('narrowing, readiness, candidate and scan limits are explicit', () => {
  const browser = browserFixture((node) => Array.from({ length: 5 }, () => node('section')));
  assert.equal(collect(browser, { maxCandidates: 2 }).truncated, true);
  assert.equal(collect(browser, { maxCandidates: 2 }).candidates.length, 2);
  assert.throws(() => collect(browser, { selector: 'missing' }), /exactly one/);
  assert.throws(() => collect(browser, { selector: 'ambiguous' }), /exactly one/);
  browser.document.readyState = 'loading';
  assert.throws(() => collect(browser), /Wait/);
  assert.throws(() => generate(['--url', runtimeUrl, '--maxCandidates', '0']), /1-100/);
  assert.throws(() => generate(['--url', runtimeUrl, '--upload', 'true']), /Unknown/);
  const many = browserFixture((node) => Array.from({ length: 5005 }, () => node('div')));
  const limited = collect(many);
  assert.equal(limited.scannedElements, 5000);
  assert.equal(limited.truncated, true);
});

test('snapshot import rejects unrecognized fields and malformed component data', () => {
  assert.equal(validateRuntimeSnapshot(snapshot()).source, 'runtime-dom');
  for (const mutate of [
    (data) => { data.cookies = 'unexpected'; },
    (data) => { data.pageUrl += '?token=unexpected'; },
    (data) => { data.pageUrl += '#unexpected'; },
    (data) => { data.candidates[0].html = '<input value="private">'; },
    (data) => { data.candidates[0].classes = ['pp-card', 'pp-card']; },
    (data) => { data.candidates[0].classes = ['invalid whitespace']; },
    (data) => { data.candidates[0].kind = 'arbitrary authoring label'; },
    (data) => { data.candidates[0].computedStyles.href = 'unexpected'; },
    (data) => { data.candidates[0].computedStyles = {}; },
    (data) => { data.candidates.push(data.candidates[0]); },
    (data) => { data.scannedElements = 9000; },
  ]) {
    const changed = snapshot();
    mutate(changed);
    assert.throws(() => validateRuntimeSnapshot(changed), /Invalid|Unknown/);
  }
});

test('partial snapshots require explicit capture metadata and exactly the declared property keys', () => {
  for (const [mode, properties] of [['structure', []], ['styles', ['color', 'padding']]]) {
    const data = snapshot();
    data.mode = mode;
    data.properties = properties;
    data.candidates[0].computedStyles = Object.fromEntries(properties.map((property) => [property, 'initial']));
    assert.equal(validateRuntimeSnapshot(data), data);
  }
  for (const mutate of [
    (data) => { data.mode = 'styles'; },
    (data) => { data.properties = STYLE_PROPERTIES; },
    (data) => { data.mode = 'styles'; data.properties = 'color'; },
    (data) => { data.mode = 'structure'; data.properties = []; },
    (data) => { data.mode = 'structure'; data.properties = ['color']; },
    (data) => { data.mode = 'styles'; data.properties = []; },
    (data) => { data.mode = 'styles'; data.properties = ['color', 'color']; },
    (data) => { data.mode = 'styles'; data.properties = ['content']; },
    (data) => { data.mode = 'styles'; data.properties = ['color']; },
    (data) => { data.mode = 'styles'; data.properties = STYLE_PROPERTIES; delete data.candidates[0].computedStyles.color; },
    (data) => { data.mode = 'structure'; data.properties = []; delete data.candidates[0].computedStyles; },
    (data) => { data.mode = 'structure'; data.properties = []; data.candidates[0].computedStyles = []; },
    (data) => { data.candidates[0].computedStyles.color = 'x'.repeat(251); },
    (data) => { data.candidates[0].computedStyles.color = 0; },
  ]) {
    const changed = snapshot();
    mutate(changed);
    assert.throws(() => validateRuntimeSnapshot(changed), /Invalid|Unknown|mode|properties|object/);
  }
});

test('small captures preserve URL, readiness, scan and metadata limits', () => {
  for (const mode of ['structure', 'styles']) {
    const browser = browserFixture((node) => [
      node('section', { id: 'i'.repeat(201), class: Array.from({ length: 35 }, (_, i) => `class-${i}`).join(' '),
        styles: { color: 'x'.repeat(251) } }),
    ]);
    const result = collect(browser, { mode, properties: mode === 'styles' ? ['color'] : undefined });
    assert.equal(validateRuntimeSnapshot(result), result);
    assert.equal(result.candidates[0].domId, null);
    assert.equal(result.candidates[0].classes.length, 30);
    assert.equal(result.candidates[0].attributesOmitted, true);
    if (mode === 'styles') assert.equal(result.candidates[0].computedStyles.color.length, 250);
    assert.throws(() => collect(browser, { mode, selector: 'ambiguous' }), /exactly one/);
    assert.throws(() => collect(browser, { mode, maxCandidates: 101 }), /1-100/);
    browser.document.readyState = 'loading';
    assert.throws(() => collect(browser, { mode }), /Wait/);
    browser.document.readyState = 'complete';
    browser.context.location.href = runtimeUrl + '?changed-context=yes';
    assert.throws(() => collect(browser, { mode }), /different URL/);
    const bounded = collect(browserFixture((node) => Array.from({ length: 5005 }, () => node('div'))), { mode });
    assert.equal(bounded.scannedElements, 5000);
    assert.equal(bounded.truncated, true);
  }
});

test('embedded-boundary scanning is capped in both optimized modes', () => {
  for (const mode of ['structure', 'styles']) {
    const browser = browserFixture((node) => Array.from({ length: 5001 }, () => node('iframe')));
    assert.throws(() => collect(browser, { mode }), /Too many embedded boundaries/);
  }
});

test('runtime classes map only to the selected local page and reachable templates, without approving edits', (t) => {
  const f = fixture(t);
  f.put('web-templates/unused/Unused.webtemplate.yml', f.yml('webtemplate', {
    id: '88888888-8888-4888-8888-888888888888', name: 'Unused',
  }));
  f.put('web-templates/unused/Unused.webtemplate.source.html', '<section class="pp-card">Unused</section>');
  fs.appendFileSync(path.join(f.root, f.copyPath), '\n{% comment %}<section class="pp-card">Inactive</section>{% include "Unused" %}{% endcomment %}');
  let result = attachRuntimeEvidence(inspectSite(f.root), ids.locale, snapshot());
  assert.equal(result.candidateCount, 1);
  assert.equal(result.pageUrl, runtimeUrl);
  assert.equal(Object.hasOwn(result, 'url'), false);
  assert.equal(result.candidates[0].sourceStatus, 'candidate-match');
  assert.equal(result.candidates[0].sourceMatches[0].path, f.copyPath);
  assert.equal(result.candidates[0].sourceMatches[0].line, 1);
  assert.equal(result.candidates[0].sourceMatches[0].matchedBy, 'classes');
  assert.match(result.warnings.join(' '), /do not authorize/);
  fs.appendFileSync(path.join(f.root, f.copyPath), '<section class="pp-card">Second instance</section>');
  result = attachRuntimeEvidence(inspectSite(f.root), ids.locale, snapshot());
  assert.equal(result.candidates[0].sourceStatus, 'ambiguous');
  const unmapped = snapshot();
  unmapped.candidates[0].classes = ['generated-runtime-only'];
  assert.equal(attachRuntimeEvidence(inspectSite(f.root), ids.locale, unmapped).candidates[0].sourceStatus, 'unresolved');
  assert.throws(() => attachRuntimeEvidence(inspectSite(f.root), 'unknown', snapshot()), /pageId/);
});

test('structural and subset evidence stays advisory without filling absent computed properties', (t) => {
  const f = fixture(t);
  for (const [mode, properties] of [['structure', []], ['styles', ['color']]]) {
    const input = snapshot();
    input.mode = mode;
    input.properties = properties;
    input.candidates[0].computedStyles = mode === 'styles' ? { color: 'rgb(0, 0, 0)' } : {};
    const result = attachRuntimeEvidence(inspectSite(f.root), ids.locale, input);
    assert.equal(result.candidateCount, input.candidates.length);
    assert.equal(result.mode, mode);
    assert.deepEqual(result.properties, properties);
    assert.equal(result.truncated, input.truncated);
    assert.deepEqual(result.candidates[0].computedStyles, input.candidates[0].computedStyles);
    assert.equal(result.candidates[0].sourceStatus, 'candidate-match');
    assert.match(result.warnings.join(' '), /do not authorize/);
    assert.match(result.warnings.join(' '), /absent evidence, not zero/);
    assert.equal(Object.hasOwn(result.candidates[0], 'selector'), false);
    assert.equal(Object.hasOwn(result.candidates[0], 'className'), false);
  }
});

test('local inspection optionally consumes an external snapshot but offline inspection remains unchanged', (t) => {
  const f = fixture(t);
  assert.equal(inspect(['--siteRoot', f.root]).runtime, undefined);
  const file = path.join(f.work, 'runtime.json');
  fs.writeFileSync(file, JSON.stringify(snapshot()));
  const context = inspect(['--siteRoot', f.root, '--runtimeSnapshot', file, '--pageId', ids.locale]);
  assert.equal(context.runtime.candidates[0].sourceStatus, 'candidate-match');
  assert.throws(() => inspect(['--siteRoot', f.root, '--runtimeSnapshot', file]), /pageId/);
  const internal = f.put('runtime.json', JSON.stringify(snapshot()));
  assert.throws(() => inspect(['--siteRoot', f.root, '--runtimeSnapshot', internal, '--pageId', ids.locale]), /outside/);
});

test('CLI generates a self-contained browser function without installing or launching a browser', () => {
  const script = path.resolve(__dirname, '../../skills/style-site/scripts/inspect-runtime-dom.js');
  const result = spawnSync(process.execPath, [script, '--url', runtimeUrl], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotThrow(() => new vm.Script(`(${result.stdout})`));
  assert.match(result.stdout, /^\(\) =>/);
  assert.doesNotMatch(result.stdout, /page\.evaluate/);
  assert.match(result.stdout, /createTreeWalker/);
  assert.doesNotMatch(result.stdout, /require\(|fetch\(|\.click\(|\.submit\(|localStorage/);
});

test('collector file output is exclusive, external, host-executable as async(page), and summarized', async (t) => {
  const f = fixture(t);
  const output = path.join(f.work, 'private', 'runtime-structure.js');
  const args = ['--url', runtimeUrl, '--mode', 'structure', '--maxCandidates', '10', '--siteRoot', f.root, '--out', output];
  const result = generate(args);
  const code = fs.readFileSync(output, 'utf8');
  assert.deepEqual(result, { path: output, bytes: Buffer.byteLength(code, 'utf8') });
  assert.doesNotThrow(() => new vm.Script(code));
  assert.match(code, /^async \(page\) =>/);
  const browser = browserFixture((node) => [node('section')]);
  browser.context.getComputedStyle = () => { throw new Error('Structure must not call getComputedStyle'); };
  let evaluations = 0;
  const run = vm.runInNewContext(`(${code})`, {});
  const returned = await run({
    async evaluate(collector) {
      evaluations += 1;
      return vm.runInNewContext(`(${collector.toString()})()`, browser.context);
    },
  });
  assert.equal(evaluations, 1);
  const captured = JSON.parse(JSON.stringify(returned));
  assert.equal(validateRuntimeSnapshot(captured).mode, 'structure');
  assert.equal(captured.candidates.length, 1);
  assert.throws(() => generate(args), /EEXIST/);
  assert.equal(fs.readFileSync(output, 'utf8'), code);
  if (process.platform !== 'win32') assert.equal(fs.statSync(output).mode & 0o777, 0o600);
});

test('runtime summary metadata counts captured candidates without inventing a complete total', (t) => {
  const f = fixture(t);
  const input = snapshot();
  input.truncated = true;
  const attached = attachRuntimeEvidence(inspectSite(f.root), ids.locale, input);
  assert.equal(attached.candidateCount, 1);
  assert.equal(attached.truncated, true);
  assert.equal(attached.scannedElements, 1);
  assert.equal(attached.omittedBoundaries, 0);
  assert.equal(Object.hasOwn(attached, 'totalCandidates'), false);
  assert.equal(Object.hasOwn(attached, 'mode'), false);
  assert.equal(Object.hasOwn(attached, 'properties'), false);
});

test('collector output requires a site root and rejects the upload tree, invalid roots and non-JS filenames', (t) => {
  const f = fixture(t, { wrapped: true });
  const outside = path.join(f.work, 'collector.js');
  assert.throws(() => generate(['--url', runtimeUrl, '--out', outside]), /--siteRoot is required/);
  assert.throws(() => generate(['--url', runtimeUrl, '--siteRoot', f.project]), /only used with --out/);
  assert.throws(() => generate(['--url', runtimeUrl, '--siteRoot', f.work, '--out', outside]), /website|classic|site/i);
  for (const inside of [path.join(f.root, 'collector.js'), path.join(f.root, 'new', 'collector.js')]) {
    assert.throws(() => generate(['--url', runtimeUrl, '--siteRoot', f.project, '--out', inside]), /outside/);
    assert.equal(fs.existsSync(inside), false);
  }
  const nonJs = path.join(f.work, 'collector.json');
  assert.throws(() => generate(['--url', runtimeUrl, '--siteRoot', f.root, '--out', nonJs]), /\.js/);
  assert.equal(fs.existsSync(nonJs), false);
  assert.equal(fs.existsSync(outside), false);
});

test('collector output cannot traverse a symlink or junction into the upload tree', (t) => {
  const f = fixture(t);
  const alias = path.join(f.work, 'site-alias');
  try { fs.symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('Symlinks are unavailable'); throw error; }
  const output = path.join(alias, 'new', 'collector.js');
  assert.throws(() => generate(['--url', runtimeUrl, '--siteRoot', f.root, '--out', output]), /outside/);
  assert.equal(fs.existsSync(path.join(f.root, 'new')), false);
});

test('CLI file mode emits only a path/byte summary, not collector code or the approved URL', (t) => {
  const f = fixture(t);
  const output = path.join(f.work, 'collector.js');
  const script = path.resolve(__dirname, '../../skills/style-site/scripts/inspect-runtime-dom.js');
  const result = spawnSync(process.execPath, [script, '--url', runtimeUrl + '?context=example-only',
    '--mode', 'styles', '--properties', 'color,background-color', '--selector', '.pp-card', '--maxCandidates', '1',
    '--siteRoot', f.root, '--out', output], { encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { path: output, bytes: fs.statSync(output).size });
  assert.doesNotMatch(result.stdout, /contoso|example-only|createTreeWalker|computedStyles/);
  assert.match(fs.readFileSync(output, 'utf8'), /context=example-only/);
});

test('collector embeds URL and selector strings as inert script-safe data', () => {
  const selector = 'section[data-label="</script><script>throw 1</script>"]';
  const code = generate(['--url', runtimeUrl, '--mode', 'styles', '--properties', 'color', '--selector', selector]);
  assert.doesNotMatch(code, /<\/script>/);
  const browser = browserFixture((node) => [node('section')]);
  browser.document.querySelectorAll = (value) => {
    assert.equal(value, selector);
    return [browser.root.children[0]];
  };
  const result = JSON.parse(JSON.stringify(vm.runInNewContext(`(${code})()`, browser.context)));
  assert.equal(result.rootSelector, selector);
  assert.deepEqual(result.candidates[0].computedStyles, { color: 'initial' });
});
