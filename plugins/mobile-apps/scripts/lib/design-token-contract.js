'use strict';

const fs = require('node:fs');

const { sha256Hex } = require('./product-experience-contracts');

const REQUIRED_COLOR_KEYS = [
  'bg',
  'surface',
  'primary',
  'accent',
  'text',
  'textMuted',
  'border',
  'statusSuccess',
  'statusWarning',
  'statusDanger',
  'statusInfo',
];

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function objectBlock(source, key) {
  // Generated tokens use object literals such as:
  //   tokens = { color: { primary: '#123456' }, typography: { heading: {...} } }
  // The regex locates only the controlled property name; balanced-brace scanning owns the
  // nested object because typography roles may contain additional object literals.
  const match = new RegExp(`(?:^|[,{]\\s*)["']?${escapePattern(key)}["']?\\s*:\\s*\\{`, 'm')
    .exec(source);
  if (!match) return null;
  const start = match.index + match[0].lastIndexOf('{');
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start + 1, index);
    }
  }
  return null;
}

function stringProperty(block, key) {
  if (!block) return null;
  return new RegExp(`["']?${escapePattern(key)}["']?\\s*:\\s*["']([^"']+)["']`)
    .exec(block)?.[1] || null;
}

function numberProperty(block, key) {
  if (!block) return null;
  const value = new RegExp(`["']?${escapePattern(key)}["']?\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`)
    .exec(block)?.[1];
  return value === undefined ? null : Number(value);
}

function readDesignTokenContract(tokensPath) {
  if (!fs.existsSync(tokensPath)) {
    return {
      ok: false,
      code: 'design-tokens-not-ready',
      message: 'final design preview requires generated brand/tokens.ts',
    };
  }
  const source = fs.readFileSync(tokensPath, 'utf8');
  const colorBlock = objectBlock(source, 'color');
  const colors = {};
  const missing = [];
  for (const key of REQUIRED_COLOR_KEYS) {
    const value = stringProperty(colorBlock, key);
    if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?$/i.test(value || '')) {
      colors[key] = value;
    } else {
      missing.push(key);
    }
  }
  const typographyBlock = objectBlock(source, 'typography');
  const headingBlock = objectBlock(`{${typographyBlock || ''}}`, 'heading');
  const weight = stringProperty(headingBlock, 'weight')
    || numberProperty(headingBlock, 'weight');
  const typography = {
    family: stringProperty(headingBlock, 'family'),
    size: numberProperty(headingBlock, 'size'),
    weight,
    lineHeight: numberProperty(headingBlock, 'lineHeight'),
    tracking: numberProperty(headingBlock, 'tracking'),
  };
  const typographyReady = typography.family
    && Number.isFinite(typography.size)
    && typography.weight !== null
    && Number.isFinite(typography.lineHeight)
    && Number.isFinite(typography.tracking);
  if (missing.length || !typographyReady) {
    return {
      ok: false,
      code: 'design-tokens-incomplete',
      message: `final design preview requires complete generated colors and heading typography; missing ${[
        ...missing,
        ...(!typographyReady ? ['typography.heading'] : []),
      ].join(', ')}`,
    };
  }
  return {
    ok: true,
    ready: true,
    source: 'generated-brand-tokens',
    revision: sha256Hex(source),
    colors,
    typography,
  };
}

module.exports = {
  REQUIRED_COLOR_KEYS,
  objectBlock,
  readDesignTokenContract,
};