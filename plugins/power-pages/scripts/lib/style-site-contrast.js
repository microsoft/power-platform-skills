'use strict';

function needsContrastReview(request) {
  const { styleProperties } = require('./style-site-css');
  return request.styles.some((style) => styleProperties(style).some((property) =>
    /^(?:--.+|color|background(?:-.+)?|opacity|font(?:-.+)?|line-height|text-shadow|(?:-webkit-)?text-fill-color|fill|stroke|filter|backdrop-filter|mix-blend-mode|mask(?:-.+)?|animation(?:-.+)?)$/.test(property)));
}

function parseColor(value) {
  if (typeof value !== 'string') return null;
  value = value.trim();
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) {
    const hex = value.length <= 5 ? value.slice(1).split('').map((digit) => digit + digit).join('') : value.slice(1);
    return [...[0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)),
      hex.length === 8 ? Number.parseInt(hex.slice(6), 16) / 255 : 1];
  }
  // Accept resolved "rgb(17, 24, 39)" / "rgba(0, 0, 0, 0)" and the
  // space/slash sRGB spelling; reject malformed "rgb(0,,0)" and mixed
  // delimiters rather than coercing empty channels to zero. Never substitute
  // black for unresolved tokens, inherited values or non-sRGB color spaces.
  if (value.toLowerCase() === 'transparent') return [0, 0, 0, 0];
  if (!/^rgba?\([0-9.%+\s,/-]+\)$/i.test(value)) return null;
  const body = value.slice(value.indexOf('(') + 1, -1).trim();
  const legacy = body.includes(',');
  let parts;
  if (legacy) {
    if (body.includes('/')) return null;
    parts = body.split(',').map((part) => part.trim());
  } else {
    const sides = body.split(/\s*\/\s*/);
    if (sides.length > 2) return null;
    parts = sides[0].trim().split(/\s+/);
    if (parts.length !== 3) return null;
    if (sides.length === 2) parts.push(sides[1]);
  }
  if (parts.length !== 3 && parts.length !== 4) return null;
  if (parts.some((part) => !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)%?$/.test(part))) return null;
  if (legacy && parts.slice(0, 3).some((part) => part.endsWith('%') !== parts[0].endsWith('%'))) return null;
  const channels = parts.map((part, index) => {
    const number = Number(part.replace(/%$/, ''));
    return part.endsWith('%') ? number * (index === 3 ? 1 : 255) / 100 : number;
  });
  if (channels.length === 3) channels.push(1);
  return channels.every((number, index) => Number.isFinite(number) && number >= 0 && number <= (index === 3 ? 1 : 255))
    ? channels : null;
}

function compositeColor(foreground, background) {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  if (!alpha) return [0, 0, 0, 0];
  return [...foreground.slice(0, 3).map((channel, index) =>
    (channel * foreground[3] + background[index] * background[3] * (1 - foreground[3])) / alpha), alpha];
}

function contrastRatio(foreground, background) {
  // WCAG 2.2 relative luminance and contrast ratio:
  // https://www.w3.org/TR/WCAG22/#dfn-relative-luminance
  const luminance = (color) => color.slice(0, 3).map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function textContrast(foreground, background, fontSize, fontWeight) {
  if (background[3] !== 1) throw new Error('Provide the effective opaque background after resolving ancestor colors; no canvas color is assumed.');
  if (!Number.isFinite(fontSize) || fontSize <= 0 || !Number.isFinite(fontWeight) || fontWeight < 1 || fontWeight > 1000) {
    throw new Error('Contrast requires a resolved positive font size and font weight from 1 to 1000.');
  }
  // 18pt regular / 14pt bold at 96 CSS px/inch. Eighteen-pixel bold text
  // is not large text; thresholds use unrounded ratios.
  // https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
  const minimum = fontSize >= 24 || (fontSize >= 14 * 96 / 72 && fontWeight >= 700) ? 3 : 4.5;
  const ratio = contrastRatio(compositeColor(foreground, background), background);
  return { ratio, minimum, status: ratio >= minimum ? 'pass' : 'fail' };
}

function checkColorPair({ foreground, background, fontSize, fontWeight }) {
  const text = parseColor(foreground);
  const surface = parseColor(background);
  if (!text || !surface) throw new Error('Resolve concrete hex or sRGB colors first; tokens, inheritance and complex backgrounds are not evaluated.');
  const size = typeof fontSize === 'string' ? Number(fontSize.replace(/px$/, '')) : fontSize;
  const weight = fontWeight === 'normal' ? 400 : fontWeight === 'bold' ? 700 : Number(fontWeight);
  return {
    ...textContrast(text, surface, size, weight),
    foreground: text, background: surface, fontSize: size, fontWeight: weight,
    evidence: 'supplied-color-pair-only',
    limitation: 'Does not evaluate the cascade, child overrides, layout, images, group opacity, runtime rendering or Studio editability.',
  };
}

module.exports = { needsContrastReview, parseColor, compositeColor, contrastRatio, textContrast, checkColorPair };
