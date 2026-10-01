const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');

const { AXE_KEY, axeTags, criteriaFromTags, normalizeAxeResults, runAxe, tagToCriterion, wrapAxeSource } = require('../lib/a11y/axe-runner');
const { errorLine, redact, redactHtml, redactUrls, sanitizeHtml } = require('../lib/a11y/page-helpers');

test('tagToCriterion converts axe criterion tags and ignores level tags', () => {
  assert.equal(tagToCriterion('wcag143'), '1.4.3');
  assert.equal(tagToCriterion('wcag1410'), '1.4.10');
  assert.equal(tagToCriterion('wcag2411'), '2.4.11');
  assert.equal(tagToCriterion('wcag2a'), null);
  assert.equal(tagToCriterion('wcag21aa'), null);
  assert.equal(tagToCriterion('wcag22aa'), null);
  assert.equal(tagToCriterion('wcag2aaa'), null);
  assert.equal(tagToCriterion('best-practice'), null);
  assert.equal(tagToCriterion('cat.color'), null);
});

test('criteriaFromTags dedupes', () => {
  assert.deepEqual(criteriaFromTags(['wcag2aa', 'wcag143', 'wcag143', 'cat.color']), ['1.4.3']);
});

test('axeTags includes best-practice unless disabled', () => {
  assert.ok(axeTags().includes('best-practice'));
  assert.ok(!axeTags({ bestPractice: false }).includes('best-practice'));
  assert.ok(axeTags().includes('wcag22aa'));
});

test('normalizeAxeResults maps violations and incomplete with redaction', () => {
  const raw = {
    testEngine: { version: '4.13.0' },
    violations: [{
      id: 'color-contrast', impact: 'serious', tags: ['wcag2aa', 'wcag143'], help: 'Contrast', helpUrl: 'https://dequeuniversity.com/x',
      nodes: [{ target: ['main', 'p'], html: '<p>Signed in as maker@contoso.com</p>', failureSummary: 'Fix: contrast' }],
    }, {
      id: 'region', impact: 'moderate', tags: ['cat.keyboard', 'best-practice'], help: 'Landmarks',
      nodes: [{ target: ['div'], html: `<div>${'x'.repeat(400)}</div>` }],
    }],
    incomplete: [{ id: 'color-contrast', impact: null, tags: ['wcag143'], help: 'Contrast', nodes: [] }],
  };
  const { findings, axeVersion } = normalizeAxeResults(raw);
  assert.equal(axeVersion, '4.13.0');
  assert.equal(findings.length, 3);

  const [contrast, region, review] = findings;
  assert.equal(contrast.kind, 'violation');
  assert.deepEqual(contrast.wcag, ['1.4.3']);
  assert.equal(contrast.bestPractice, false);
  assert.equal(contrast.nodes[0].target, 'main p');
  assert.equal(contrast.nodes[0].html, '<p>Signed in as [redacted-email]</p>');

  assert.equal(region.bestPractice, true);
  assert.equal(region.nodes[0].html.length, 300);

  assert.equal(review.kind, 'needsReview');
  assert.equal(review.impact, 'moderate');
});

test('redact removes email addresses and truncates', () => {
  assert.equal(redact('a someone.else+tag@sub.contoso.co.uk b'), 'a [redacted-email] b');
  assert.equal(redact('abcdef', 3), 'abc');
  assert.equal(redact(undefined), '');
});

test('sanitizeHtml blanks secret-bearing attributes and URL query strings', () => {
  assert.equal(
    sanitizeHtml('<input type="hidden" name="__RequestVerificationToken" value="CfDJ8abc">'),
    '<input type="hidden" name="__RequestVerificationToken" value="[redacted]">',
  );
  assert.equal(sanitizeHtml('<script nonce="r4nd0m">'), '<script nonce="[redacted]">');
  assert.equal(sanitizeHtml(`<div data-csrf-token='abc' data-session-id="s1" class="x">`), `<div data-csrf-token='[redacted]' data-session-id="[redacted]" class="x">`);
  assert.equal(sanitizeHtml('<a href="/case?id=42&sig=abc#top">'), '<a href="/case?[redacted]#top">');
  assert.equal(sanitizeHtml('<img srcset="a.png?sv=1&sig=x 1x, b.png?sv=2 2x" alt="Logo">'), '<img srcset="a.png?[redacted] 1x, b.png?[redacted] 2x" alt="Logo">');
  assert.equal(sanitizeHtml('<form action="/_api/x?token=1">'), '<form action="/_api/x?[redacted]">');
  // outerHTML is sliced before sanitizing, so the last attribute can be cut mid-value.
  assert.equal(sanitizeHtml('<input name="q" value="half-a-secr'), '<input name="q" value="[redacted]"');
  assert.equal(sanitizeHtml('<a href="/a?b=c'), '<a href="/a?[redacted]"');
  assert.equal(sanitizeHtml('<button aria-label="Save" type="submit">'), '<button aria-label="Save" type="submit">');
  assert.equal(sanitizeHtml(undefined), '');
  // Fragments can carry OAuth tokens; an id-shaped in-page anchor is kept as evidence.
  assert.equal(sanitizeHtml('<a href="/callback#access_token=eyJ.abc&id_token=x">'), '<a href="/callback#[redacted]">');
  assert.equal(sanitizeHtml('<a href="#main-content">Skip</a>'), '<a href="#main-content">Skip</a>');
  assert.equal(sanitizeHtml('<a href="/page?x=1#state=abc">'), '<a href="/page?[redacted]#[redacted]">');
});

test('redactHtml sanitizes before truncating so a cut cannot expose a value', () => {
  const html = `<input aria-label="Email" value="maker@contoso.com" data-x="${'y'.repeat(400)}">`;
  const out = redactHtml(html, 300);
  assert.ok(out.length <= 300);
  assert.ok(!out.includes('maker@contoso.com'));
  assert.match(out, /value="\[redacted\]"/);
});

function fakePage({ axeAfterInject = true }) {
  const calls = [];
  let injected = false;
  return {
    calls,
    async evaluate(fn, arg) {
      // Readiness checks pass the isolated key as a string; the run passes { key, tags }.
      if (typeof arg === 'string') return injected && axeAfterInject;
      calls.push({ run: arg });
      return { violations: [], incomplete: [], testEngine: { version: '4.13.0' } };
    },
    async addScriptTag(opts) {
      calls.push({ inject: opts.content });
      injected = true;
    },
  };
}

test('runAxe injects the wrapped local source and runs under the isolated key with WCAG tags', async () => {
  const page = fakePage({});
  const result = await runAxe(page, '/* axe */', { bestPractice: false });
  assert.equal(result.axeVersion, '4.13.0');
  assert.ok(page.calls[0].inject.includes('/* axe */'));
  assert.ok(page.calls[0].inject.includes(JSON.stringify(AXE_KEY)));
  assert.deepEqual(page.calls[1].run, { key: AXE_KEY, tags: axeTags({ bestPractice: false }) });
});

test('runAxe fails loudly when axe does not initialize', async () => {
  await assert.rejects(runAxe(fakePage({ axeAfterInject: false }), 'x'), /did not initialize/);
});

// Minimal stand-in for the axe UMD bundle: it calls an AMD define() when one exists and
// writes window.axe, like the real axe.js does.
const FAKE_AXE = `(function (window) {
  if (typeof define === 'function' && define.amd) define(function () {});
  window.axe = { run: function () {}, version: 'pinned' };
})(window);`;

function sandbox(setup) {
  const defineCalls = [];
  const ctx = {};
  ctx.window = ctx;
  ctx.define = function () { defineCalls.push(arguments); };
  ctx.define.amd = {};
  if (setup) setup(ctx);
  vm.createContext(ctx);
  return { ctx, defineCalls };
}

test('wrapAxeSource isolates the pinned axe from a page AMD loader and restores window.axe', () => {
  const pageAxe = { run() {}, version: 'page' };
  const { ctx, defineCalls } = sandbox((c) => { c.axe = pageAxe; });
  vm.runInContext(wrapAxeSource(FAKE_AXE, 'k1'), ctx);
  assert.equal(defineCalls.length, 0);
  assert.equal(ctx.k1.version, 'pinned');
  assert.equal(ctx.axe, pageAxe);
  assert.equal(Object.keys(ctx).includes('k1'), false);
});

test('wrapAxeSource leaves no window.axe behind when the page had none', () => {
  const { ctx } = sandbox();
  vm.runInContext(wrapAxeSource(FAKE_AXE, 'k2'), ctx);
  assert.equal(ctx.k2.version, 'pinned');
  assert.equal(Object.prototype.hasOwnProperty.call(ctx, 'axe'), false);
});

test('wrapAxeSource refuses a page that locks window.axe', () => {
  const pageAxe = { run() {}, version: 'page' };
  const { ctx } = sandbox((c) => {
    Object.defineProperty(c, 'axe', { value: pageAxe, writable: false, configurable: false });
  });
  assert.throws(() => vm.runInContext(wrapAxeSource(FAKE_AXE, 'k3'), ctx), /locked/);
  assert.equal(ctx.k3, undefined);
  assert.equal(ctx.axe, pageAxe);
});

test('axeTags include WCAG 2.2 Level A as well as AA', () => {
  assert.ok(axeTags().includes('wcag22a'));
  assert.ok(axeTags().includes('wcag22aa'));
});

test('redactUrls and errorLine strip query strings, fragments, and emails from error text', () => {
  const msg = 'page.goto: net::ERR_ABORTED at https://contoso.powerappsportals.com/signin?returnUrl=%2F&code=secret#t for maker@contoso.com\n    at stack line';
  const line = errorLine(new Error(msg));
  assert.equal(line.includes('\n'), false, 'first line only');
  assert.equal(line.includes('secret'), false);
  assert.equal(line.includes('maker@contoso.com'), false);
  assert.ok(line.includes('https://contoso.powerappsportals.com/signin?[redacted]'));
  assert.equal(redactUrls('see http://x.test/a#frag'), 'see http://x.test/a?[redacted]');
  assert.equal(errorLine('plain text'), 'plain text');
});
