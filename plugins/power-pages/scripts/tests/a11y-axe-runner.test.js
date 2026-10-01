const assert = require('node:assert/strict');
const test = require('node:test');

const { axeTags, criteriaFromTags, normalizeAxeResults, runAxe, tagToCriterion } = require('../lib/a11y/axe-runner');
const { redact } = require('../lib/a11y/page-helpers');

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

function fakePage({ axeAfterInject = true }) {
  const calls = [];
  let injected = false;
  return {
    calls,
    async evaluate(fn, arg) {
      const src = fn.toString();
      if (src.includes('typeof window.axe')) return injected && axeAfterInject;
      calls.push({ run: arg });
      return { violations: [], incomplete: [], testEngine: { version: '4.13.0' } };
    },
    async addScriptTag(opts) {
      calls.push({ inject: opts.content });
      injected = true;
    },
  };
}

test('runAxe injects the local source as inline content and runs with WCAG tags', async () => {
  const page = fakePage({});
  const result = await runAxe(page, '/* axe */', { bestPractice: false });
  assert.equal(result.axeVersion, '4.13.0');
  assert.deepEqual(page.calls[0], { inject: '/* axe */' });
  assert.deepEqual(page.calls[1].run, axeTags({ bestPractice: false }));
});

test('runAxe fails loudly when axe does not initialize', async () => {
  await assert.rejects(runAxe(fakePage({ axeAfterInject: false }), 'x'), /did not initialize/);
});
