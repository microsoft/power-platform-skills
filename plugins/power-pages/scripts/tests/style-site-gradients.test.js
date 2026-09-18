'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRequest, compileStyles, applyMarkup } = require('../lib/style-site-plan');
const { checkColorPair, needsContrastReview } = require('../lib/style-site-contrast');

const accepted = [
  'none',
  'linear-gradient(#fff, #000)',
  'linear-gradient(to right, #fff 0%, #000 100%)',
  'linear-gradient(to bottom left, #f008 0% 20%, #00000000 55%, #123456ff 100%)',
  'linear-gradient(to left top, transparent, currentColor)',
  'linear-gradient(-360deg, var(--brand), rgb(10, 20, 30))',
  'linear-gradient(+.5deg, rgba(10, 20, 30, .5) 5%, rgba(0% 10% 20% / 50%) 95%)',
  'linear-gradient(135deg, navy, rebeccapurple, orange)',
  'LINEAR-GRADIENT(TO RIGHT, #FFF, #000)',
  'radial-gradient(#fff, #000)',
  'radial-gradient(circle, #fff, #000)',
  'radial-gradient(at top left, #fff, #000)',
  'radial-gradient(circle at 50% 40%, rgba(255, 255, 255, .2), #000)',
  'radial-gradient(ellipse farthest-corner at left bottom, #fff 0%, #000 100%)',
  'radial-gradient(closest-side at center, #fff, #000)',
  `linear-gradient(${Array(8).fill('#123456').join(', ')})`,
  'conic-gradient(from 45deg, red, blue, red)',
  'repeating-linear-gradient(45deg, red 0 10px, blue 10px 20px)',
  'radial-gradient(circle 100px at 50% 40%, red, blue)',
  'linear-gradient(var(--brand, red), blue)',
  'linear-gradient(red 10px, blue), radial-gradient(white, black)',
  'linear-gradient(red, transparent), url(/hero.svg)',
  'var(--surface-image)',
  'inherit',
];

test('general CSS image syntax works in stylesheet and inline output without a false contrast pass', () => {
  for (const value of accepted) {
    const request = {
      title: 'Gradient surface', pageId: 'page',
      components: [{ id: 'surface', label: 'Surface', kind: 'section', className: 'pp-surface', sourcePath: 'page.webpage.copy.html' }],
      styles: [{ id: 'surface-fill', componentId: 'surface', owner: 'custom', scope: 'page',
        declarations: { 'background-image': value }, rationale: 'Edit this verified local surface.' }],
    };
    assert.equal(validateRequest(request), request);
    assert.ok(compileStyles(request)[0].css.includes(`background-image: ${value};`));
    const target = '<section class="pp-surface" style="padding: 12px; background: #123;">';
    Object.assign(request.styles[0], { location: 'inline', inlineTarget: target });
    assert.equal(validateRequest(request), request);
    const result = applyMarkup(target, request, 'page.webpage.copy.html');
    assert.ok(result.includes(`background: #123; background-image: ${value};`));
    assert.equal(applyMarkup(result, request, 'page.webpage.copy.html'), result);
    assert.equal(needsContrastReview(request), true);
    if (value !== 'none') assert.throws(() =>
      checkColorPair({ foreground: '#fff', background: value, fontSize: 16, fontWeight: 400 }), /concrete/);
  }
});
