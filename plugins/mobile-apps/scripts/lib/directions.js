'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DIRECTIONS_DIR = path.resolve(__dirname, '../../skills/design-system/references/vibe');
const RESOLVABLE = ['polished-inspection', 'saas', 'product'];
const TEXT_TOKENS = ['ink', 'inkMuted', 'inkFaint'];
const GROUNDS = ['surface0', 'surface1', 'surface2'];
const cache = new Map();

const KEYWORDS = {
  'polished-inspection': [
    'asset', 'inventory', 'inspection', 'warehouse', 'fleet', 'maintenance',
    'construction', 'snagging', 'pharmacy', 'stock', 'housekeeping', 'audit',
  ],
  saas: [
    'company', 'corporate', 'internal', 'employee', 'expense', 'request',
    'approval', 'helpdesk', 'insurance', 'claim', 'school', 'attendance',
    'legal', 'case intake', 'tracker', 'dashboard', 'report', 'back office',
  ],
  product: [
    'consumer', 'customer', 'premium', 'wellness', 'learning', 'engagement',
    'retention', 'marketplace', 'commerce', 'retail', 'restaurant', 'order',
    'gym', 'class booking',
  ],
};

const BRAND_NAMES = {
  'polished-inspection': ['power platform', 'dynamics 365 field service', 'servicetitan', 'procore'],
  saas: ['microsoft 365', 'asana', 'salesforce', 'slack', 'jira', 'notion'],
  product: ['linear', 'spotify', 'airbnb', 'headspace', 'robinhood', 'substack'],
};

function normalize(value) {
  return String(value || '')
    .toLocaleLowerCase('en-US')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[^\p{L}\p{N}#-]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function rgb(hex) {
  const value = String(hex || '').replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(value)) throw new Error(`invalid color ${JSON.stringify(hex)}`);
  return value.match(/.{2}/g).map((channel) => Number.parseInt(channel, 16));
}

function hex(channels) {
  return `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function relativeLuminance(color) {
  return rgb(color)
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

function mix(first, second, amount) {
  const from = rgb(first);
  const to = rgb(second);
  return hex(from.map((channel, index) => channel + ((to[index] - channel) * amount)));
}

function mutedRamp(ink, grounds, target) {
  const limitingGround = [...grounds]
    .sort((left, right) => contrastRatio(ink, left) - contrastRatio(ink, right))[0];
  let best = ink;
  for (let percent = 1; percent <= 100; percent += 1) {
    const candidate = mix(ink, limitingGround, percent / 100);
    if (!grounds.every((ground) => contrastRatio(candidate, ground) >= target)) break;
    best = candidate;
  }
  return best;
}

function hueFromHex(color) {
  const [red, green, blue] = rgb(color).map((channel) => channel / 255);
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const difference = maximum - minimum;
  if (difference === 0) return 0;
  const segment = maximum === red
    ? ((green - blue) / difference) % 6
    : maximum === green
      ? (blue - red) / difference + 2
      : (red - green) / difference + 4;
  return (segment * 60 + 360) % 360;
}

function parseBundle(markdown) {
  const match = markdown.match(/## Bundle\s*\n\s*```yaml\s*\n([\s\S]*?)\n```/);
  if (!match) throw new Error('direction bundle is missing');
  const bundle = {};
  for (const line of match[1].split('\n')) {
    const field = line.match(/^([a-z][a-z0-9_]*):\s*(.*?)\s*$/);
    if (!field) continue;
    bundle[field[1]] = field[2].replace(/\s+#\s+.*$/, '').trim().replace(/^['"]|['"]$/g, '');
  }
  return bundle;
}

function parseReferenceApps(markdown) {
  const match = markdown.match(/## Reference apps\s*\n\s*([^\n]+)/i);
  return match ? match[1].split(',').map((value) => value.trim()).filter(Boolean) : [];
}

function get(name) {
  if (!RESOLVABLE.includes(name)) throw new Error(`direction ${name} is not auto-resolvable`);
  if (cache.has(name)) return cache.get(name);
  const source = path.join(DIRECTIONS_DIR, `direction-${name}.md`);
  const markdown = fs.readFileSync(source, 'utf8');
  const tokenMatch = markdown.match(/<!-- TOKENS[\s\S]*?```json\s*\n([\s\S]*?)\n```\s*-->/);
  if (!tokenMatch) throw new Error(`${path.basename(source)} has no TOKENS block`);
  const tokens = JSON.parse(tokenMatch[1]);
  for (const key of ['brand', ...GROUNDS, 'ink']) rgb(tokens[key]);
  if (!tokens.headingFont || !tokens.bodyFont) throw new Error(`${path.basename(source)} has incomplete font roles`);
  const direction = {
    name,
    source,
    markdown,
    tokens,
    bundle: parseBundle(markdown),
    referenceApps: parseReferenceApps(markdown),
  };
  cache.set(name, direction);
  return direction;
}

function assertPaletteContrast(palette) {
  const failures = [];
  let minimum = { ratio: Number.POSITIVE_INFINITY, pair: '' };
  for (const token of TEXT_TOKENS) {
    for (const ground of GROUNDS) {
      const ratio = contrastRatio(palette[token], palette[ground]);
      if (ratio < minimum.ratio) minimum = { ratio, pair: `${token}/${ground}` };
      if (ratio < 4.5) {
        failures.push(`${token} ${palette[token]} is ${ratio.toFixed(2)}:1 on ${ground} ${palette[ground]}`);
      }
    }
  }
  const accentRatio = contrastRatio(palette.accentOn, palette.accentBase);
  if (accentRatio < minimum.ratio) minimum = { ratio: accentRatio, pair: 'accentOn/accentBase' };
  if (accentRatio < 4.5) {
    failures.push(`accentOn ${palette.accentOn} is ${accentRatio.toFixed(2)}:1 on accentBase ${palette.accentBase}`);
  }
  if (failures.length > 0) throw new Error(`palette fails WCAG AA:\n  - ${failures.join('\n  - ')}`);
  return { ...palette, contrastMinimum: minimum };
}

function paletteFor(name) {
  const direction = get(name);
  const { tokens } = direction;
  const grounds = GROUNDS.map((key) => tokens[key]);
  const accentOn = [tokens.ink, '#FFFFFF']
    .sort((left, right) => contrastRatio(right, tokens.brand) - contrastRatio(left, tokens.brand))[0];
  return assertPaletteContrast({
    direction: name,
    accentBase: tokens.brand.toUpperCase(),
    accentSoft: mix(tokens.surface0, tokens.brand, 0.12),
    accentOn: accentOn.toUpperCase(),
    surface0: tokens.surface0.toUpperCase(),
    surface1: tokens.surface1.toUpperCase(),
    surface2: tokens.surface2.toUpperCase(),
    ink: tokens.ink.toUpperCase(),
    inkMuted: mutedRamp(tokens.ink, grounds, 5.5),
    inkFaint: mutedRamp(tokens.ink, grounds, 4.6),
    accentIsWarningHue: (() => {
      const hue = hueFromHex(tokens.brand);
      return hue <= 20 || hue >= 340;
    })(),
    warnFg: '#7A3700',
    warnBg: '#FBEAD9',
  });
}

function selection(direction, tier, reason) {
  return {
    needsChoice: false,
    direction,
    tier,
    reason,
    palette: paletteFor(direction),
    fontStack: {
      heading: get(direction).tokens.headingFont,
      body: get(direction).tokens.bodyFont,
    },
  };
}

function matchDirection(value, candidates) {
  const text = normalize(value);
  for (const name of RESOLVABLE) {
    for (const candidate of candidates[name]) {
      const normalizedCandidate = normalize(candidate);
      if (text.includes(normalizedCandidate)) return { name, match: candidate };
    }
  }
  return null;
}

function fromBrandDoc(brandDoc) {
  const text = normalize(brandDoc);
  for (const name of RESOLVABLE) {
    const direction = get(name);
    if (text.includes(normalize(name)) || text.includes(normalize(direction.tokens.brand))) {
      return selection(name, 1, `brand document named ${name}`);
    }
  }
  return null;
}

function fromBrandName(brandName) {
  const matched = matchDirection(brandName, BRAND_NAMES);
  return matched ? selection(matched.name, 2, `brand name matched ${JSON.stringify(matched.match)}`) : null;
}

function fromKeywords(value) {
  const matched = matchDirection(value, KEYWORDS);
  return matched ? selection(matched.name, 3, `keyword ${JSON.stringify(matched.match)}`) : null;
}

function resolvePalette({ brandDoc, brandName, appType, domain, explicit } = {}) {
  if (explicit) return selection(explicit, 4, 'user-selected direction');
  const brandDocument = fromBrandDoc(brandDoc);
  if (brandDocument) return brandDocument;
  const namedBrand = fromBrandName(brandName);
  if (namedBrand) return namedBrand;
  const keywordDirection = fromKeywords(`${appType || ''} ${domain || ''}`);
  if (keywordDirection) return keywordDirection;
  return {
    needsChoice: true,
    tier: 4,
    reason: 'no keyword matched',
    candidates: RESOLVABLE.map((name) => ({
      direction: name,
      accentBase: paletteFor(name).accentBase,
    })),
  };
}

module.exports = {
  DIRECTIONS_DIR,
  GROUNDS,
  RESOLVABLE,
  TEXT_TOKENS,
  assertPaletteContrast,
  contrastRatio,
  fromBrandDoc,
  fromBrandName,
  fromKeywords,
  get,
  mutedRamp,
  paletteFor,
  resolvePalette,
};