'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseColor, compositeColor, contrastRatio, textContrast, needsContrastReview, checkColorPair,
} = require('../lib/style-site-contrast');

const white = [255, 255, 255, 1];
const black = [0, 0, 0, 1];
const navy = [17, 24, 39, 1];

test('color parsing accepts concrete hex/sRGB without inventing unresolved colors', () => {
  assert.deepEqual(parseColor('#fff'), white);
  assert.deepEqual(parseColor('#111827'), navy);
  assert.deepEqual(parseColor('#f008'), [255, 0, 0, 136 / 255]);
  assert.deepEqual(parseColor('#10203080'), [16, 32, 48, 128 / 255]);
  assert.equal(parseColor('#12345'), null);
  assert.equal(parseColor('#1234567'), null);
  assert.deepEqual(parseColor('rgb(17, 24, 39)'), navy);
  assert.deepEqual(parseColor('rgba(100% 0% 0% / 50%)'), [255, 0, 0, 0.5]);
  assert.deepEqual(parseColor('transparent'), [0, 0, 0, 0]);
  for (const value of ['white', 'inherit', 'currentColor', 'var(--text)', 'color(display-p3 1 0 0)',
    'rgb(256 0 0)', 'rgba(1 2 3 / 2)', 'rgb()', 'rgb(0,,0)', 'rgb(0,,0,,0)',
    'rgba(0,0,0,)', 'rgba(0,0,0 / 1)', 'rgb(0 0 0 1)', 'rgb(0,100%,0)', null]) {
    assert.equal(parseColor(value), null, String(value));
  }
});

test('WCAG calculations composite alpha and use exact large-text thresholds', () => {
  assert.equal(contrastRatio(white, black), 21);
  assert.equal(contrastRatio(navy, navy), 1);
  assert.deepEqual(compositeColor([0, 0, 0, 0.5], white), [127.5, 127.5, 127.5, 1]);
  assert.deepEqual(compositeColor([0, 0, 0, 0], navy), navy);
  assert.deepEqual(compositeColor([0, 0, 0, 0], [0, 0, 0, 0]), [0, 0, 0, 0]);
  const gray = [119, 119, 119, 1];
  assert.equal(textContrast(gray, white, 18, 700).status, 'fail');
  assert.equal(textContrast(gray, white, 18.666, 700).minimum, 4.5);
  assert.equal(textContrast(gray, white, 18.667, 700).status, 'pass');
  assert.equal(textContrast(gray, white, 24, 400).minimum, 3);
  assert.equal(textContrast(gray, white, 23.999, 400).minimum, 4.5);
  assert.equal(textContrast([255, 255, 255, 0.05], navy, 16, 400).status, 'fail');
  const luminance = 1.05 / 4.4999 - 0.05;
  const channel = 255 * (1.055 * luminance ** (1 / 2.4) - 0.055);
  assert.equal(textContrast([channel, channel, channel, 1], white, 16, 400).status, 'fail');
});

test('color-pair checks cannot masquerade as cascade or runtime verification', () => {
  const result = checkColorPair({ foreground: '#fff', background: '#111827', fontSize: '16px', fontWeight: 'normal' });
  assert.equal(result.status, 'pass');
  assert.equal(result.evidence, 'supplied-color-pair-only');
  assert.match(result.limitation, /child overrides/);
  assert.equal(checkColorPair({ foreground: '#222', background: '#111827', fontSize: 28, fontWeight: 'bold' }).status, 'fail');
  assert.throws(() => checkColorPair({ foreground: '#fff', background: 'transparent', fontSize: 16, fontWeight: 400 }), /opaque/);
  assert.throws(() => checkColorPair({ foreground: '#fff', background: '#1238', fontSize: 16, fontWeight: 400 }), /opaque/);
  assert.throws(() => checkColorPair({ foreground: 'inherit', background: '#fff', fontSize: 16, fontWeight: 400 }), /concrete/);
  for (const [fontSize, fontWeight] of [['1rem', 400], [NaN, 400], [0, 400], [16, 1001], [16, 0]]) {
    assert.throws(() => checkColorPair({ foreground: '#fff', background: '#111827', fontSize, fontWeight }), /resolved/);
  }
});

test('readability-sensitive requests remain identified without generating a browser audit', () => {
  const request = (declarations) => ({ styles: [{ declarations }] });
  for (const key of ['color', 'background-color', 'background-image', 'font-size', 'font-family', 'font-weight', 'line-height', 'opacity', 'text-shadow']) {
    assert.equal(needsContrastReview(request({ [key]: 'value' })), true);
  }
  assert.equal(needsContrastReview(request({ padding: '12px', 'border-radius': '8px' })), false);
});
