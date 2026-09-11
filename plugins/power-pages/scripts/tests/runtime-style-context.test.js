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
  function node(tag, attributes = {}, descendants = []) {
    const element = {
      localName: tag, nodeType: 1, children: descendants, parentElement: null, previousElementSibling: null,
      classList: (attributes.class || '').split(/\s+/).filter(Boolean),
      getAttribute: (name) => attributes[name] ?? null,
      getClientRects: () => attributes.hidden ? [] : [1],
    };
    for (const field of ['value', 'innerHTML', 'outerHTML', 'textContent']) {
      Object.defineProperty(element, field, { get() { throw new Error(`Must not read ${field}`); } });
    }
    descendants.forEach((child, index) => { child.parentElement = element; child.previousElementSibling = descendants[index - 1] || null; });
    return element;
  }
  const root = node('body', {}, children(node));
  const filters = { SHOW_ELEMENT: 1, FILTER_REJECT: 2, FILTER_ACCEPT: 1 };
  const document = {
    readyState: 'complete',
    querySelectorAll: (selector) => selector === 'body' ? [root] : selector === 'ambiguous' ? [root, root] : [],
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
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', getPropertyValue: () => 'initial' }),
  };
  return { context, document };
}

function collect(browser, options = {}) {
  const code = buildRuntimeInspection({ url: runtimeUrl, ...options });
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${code})()`, browser.context)));
}

test('collector reads structural IDs/classes/styles, not content, values or hidden/embedded internals', () => {
  const browser = browserFixture((node) => [
    node('section', { class: 'sectionBlockLayout pp-card', id: 'service-card' }, [
      node('input', { type: 'password' }), node('input', { type: 'hidden' }), node('p'),
    ]),
    node('iframe', {}, [node('section', { class: 'pp-private-frame' })]),
    node('custom-widget', {}, [node('button', { class: 'pp-private-widget' })]),
    node('section', { class: 'pp-hidden', hidden: true }),
    node('div', { class: 'contoso-card', id: 'custom-component' }),
  ]);
  const result = collect(browser);
  assert.equal(validateRuntimeSnapshot(result), result);
  assert.equal(result.candidates.length, 3);
  assert.equal(result.candidates[0].domId, 'service-card');
  assert.deepEqual(result.candidates[0].classes, ['sectionBlockLayout', 'pp-card']);
  assert.deepEqual(result.candidates[2].classes, ['contoso-card']);
  assert.equal(result.omittedBoundaries, 2);
  assert.doesNotMatch(JSON.stringify(result), /pp-private|pp-hidden|password/);
  assert.match(result.candidates[0].locator, /section:nth-of-type\(1\)$/);
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

test('runtime classes map only to the selected local page and reachable templates, without approving edits', (t) => {
  const f = fixture(t);
  f.put('web-templates/unused/Unused.webtemplate.yml', f.yml('webtemplate', {
    id: '88888888-8888-4888-8888-888888888888', name: 'Unused',
  }));
  f.put('web-templates/unused/Unused.webtemplate.source.html', '<section class="pp-card">Unused</section>');
  fs.appendFileSync(path.join(f.root, f.copyPath), '\n{% comment %}<section class="pp-card">Inactive</section>{% include "Unused" %}{% endcomment %}');
  let result = attachRuntimeEvidence(inspectSite(f.root), ids.locale, snapshot());
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
  assert.match(result.stdout, /createTreeWalker/);
  assert.doesNotMatch(result.stdout, /require\(|fetch\(|\.click\(|\.submit\(|localStorage/);
});
