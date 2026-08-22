'use strict';

const TYPE_ROLES = [
  ['displayLarge', 57, 64, 400],
  ['displayMedium', 45, 52, 400],
  ['displaySmall', 36, 44, 400],
  ['headlineLarge', 32, 40, 400],
  ['headlineMedium', 28, 36, 400],
  ['headlineSmall', 24, 32, 400],
  ['titleLarge', 22, 28, 500],
  ['titleMedium', 16, 24, 500],
  ['titleSmall', 14, 20, 500],
  ['bodyLarge', 16, 24, 400],
  ['bodyMedium', 14, 20, 400],
  ['bodySmall', 12, 16, 400],
  ['labelLarge', 14, 20, 500],
  ['labelMedium', 12, 16, 500],
  ['labelSmall', 11, 16, 500],
];
const SHAPE_SCALE = new Set([4, 8, 12, 16, 24]);
const TEMPLATE_DESIGN_DEFAULTS = {
  accent: '#0588f0',
  surfaces: ['#f7f7f7', '#f7f7f7', '#ededed'],
  font: '-apple-system, system-ui, blinkmacsystemfont, segoe ui, roboto, helvetica, arial, sans-serif',
};

function number(value) {
  const parsed = Number.parseFloat(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function colorKey(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

function normalizeFont(value) {
  return String(value || '').toLowerCase().replace(/["']/g, '').replace(/\s+/g, ' ').trim();
}

function stringProperty(source, names) {
  for (const name of names) {
    const match = String(source || '').match(new RegExp(`(?:["']${name}["']|\\b${name})\\s*:\\s*["']([^"']+)["']`, 'i'));
    if (match) return match[1];
  }
  return '';
}

function visualFontFamilies(source) {
  const families = [];
  const typographyBlock = String(source || '').match(/typography\s*:\s*\{([\s\S]*?)\n\s*\}\s*(?:as const)?[,;]/)?.[1] || '';
  for (const match of typographyBlock.matchAll(/(?:display|heading|title|body|bodySm)\s*:\s*\{[^}]*family\s*:\s*["']([^"']+)["']/g)) {
    families.push(match[1]);
  }
  const fontStackBlock = String(source || '').match(/export const fontStack\s*=\s*\{([\s\S]*?)\}\s*as const/)?.[1] || '';
  for (const match of fontStackBlock.matchAll(/(?:display|heading|body)\s*:\s*["']([^"']+)["']/g)) families.push(match[1]);
  return [...new Set(families.map(normalizeFont).filter(Boolean))];
}

function brandDistinctness(source) {
  const accent = stringProperty(source, ['accentBase', 'primary']);
  const surfaces = [
    stringProperty(source, ['surface0', 'bg']),
    stringProperty(source, ['surface1', 'surface']),
    stringProperty(source, ['surface2', 'surfaceMuted']),
  ];
  const fonts = visualFontFamilies(source);
  return {
    accent,
    surfaces,
    fonts,
    accentDistinct: Boolean(accent) && colorKey(accent) !== colorKey(TEMPLATE_DESIGN_DEFAULTS.accent),
    surfacesDistinct: surfaces.every(Boolean)
      && surfaces.some((surface, index) => colorKey(surface) !== colorKey(TEMPLATE_DESIGN_DEFAULTS.surfaces[index])),
    fontDistinct: fonts.length > 0 && fonts.some((font) => font !== TEMPLATE_DESIGN_DEFAULTS.font),
  };
}

function hexToRgb(hex) {
  let value = String(hex || '').replace(/^#/, '');
  if (value.length === 3) value = value.split('').map((character) => character.repeat(2)).join('');
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  const channels = value.match(/.{2}/g).map((channel) => Number.parseInt(channel, 16));
  return colorKey(`rgb(${channels.join(', ')})`);
}

function tokenColors(source) {
  const colors = new Map();
  for (const match of String(source || '').matchAll(/\b([A-Za-z][A-Za-z0-9]*)\s*:\s*['"](#[0-9a-f]{3,6})['"]/gi)) {
    const value = hexToRgb(match[2]);
    if (value) colors.set(match[1], value);
  }
  return colors;
}

function gradientTokenNames(source) {
  const block = String(source || '').match(/export const gradients\s*=\s*\{([\s\S]*?)\}\s*as const/)?.[1] || '';
  return new Set([...block.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\s*:/gm)].map((match) => match[1]));
}

function adoptedTypeRoles(source) {
  const block = String(source || '').match(/export const typeScale\s*=\s*\{([\s\S]*?)\}\s*as const/)?.[1] || '';
  const roles = [];
  const pattern = /([A-Za-z][A-Za-z0-9]*)\s*:\s*\{\s*fontSize:\s*(\d+(?:\.\d+)?),\s*lineHeight:\s*(\d+(?:\.\d+)?),\s*fontWeight:\s*['"](\d+)['"]\s*\}/g;
  for (const match of block.matchAll(pattern)) {
    const published = TYPE_ROLES.find(([name, size, lineHeight, weight]) => (
      name === match[1]
      && size === Number(match[2])
      && lineHeight === Number(match[3])
      && weight === Number(match[4])
    ));
    if (published) roles.push(published);
  }
  return roles;
}

function descendants(element, elements, byParent) {
  const output = [];
  const queue = [...(byParent.get(element.id) || [])];
  while (queue.length > 0) {
    const child = queue.shift();
    output.push(child);
    queue.push(...(byParent.get(child.id) || []));
  }
  return output;
}

function typeRole(element, allowedRoles = TYPE_ROLES) {
  const size = number(element.style.fontSize);
  const lineHeight = number(element.style.lineHeight);
  const weight = Number.parseInt(element.style.fontWeight, 10) || 400;
  return allowedRoles.find(([, roleSize, roleLineHeight, roleWeight]) => (
    Math.abs(roleSize - size) < 0.5 && Math.abs(roleLineHeight - lineHeight) < 0.5 && roleWeight === weight
  ))?.[0] || null;
}

function runApp(rendered, context) {
  const hardFailures = [];
  const warnings = [];
  const roles = new Set();
  const iconSizes = new Set();
  const surfaces = new Set();
  const rowSignatures = new Set();
  const gradients = new Set();
  const tokenSource = context.brandTokenSource || '';
  const identity = brandDistinctness(tokenSource);
  if (!identity.accentDistinct) hardFailures.push('brand accent matches or omits the neutral template accent');
  if (!identity.surfacesDistinct) hardFailures.push('brand surfaces match or omit the neutral template surface set');
  if (!identity.fontDistinct) hardFailures.push('brand visual font stack matches or omits the neutral template font stack');
  const adoptedRoles = adoptedTypeRoles(tokenSource);
  if (adoptedRoles.length === 0) hardFailures.push('brand/tokens.ts exports no valid Material 3 typeScale roles');
  const colors = tokenColors(tokenSource);
  const excludedSurfaceColors = new Set(
    [...colors.entries()]
      .filter(([name]) => /accent|primary|status|warn|danger|success|info/i.test(name))
      .map(([, value]) => value),
  );
  const accentColors = new Set(
    [...colors.entries()]
      .filter(([name]) => /accentBase|primary/i.test(name))
      .map(([, value]) => value),
  );
  const gradientTokens = gradientTokenNames(tokenSource);
  const accentBudgets = [];
  const primaryActions = [];

  for (const { snapshot, context: screenContext } of rendered) {
    const elements = snapshot.elements.filter((element) => element.visible);
    const byParent = new Map();
    for (const element of elements) {
      const children = byParent.get(element.parentId) || [];
      children.push(element);
      byParent.set(element.parentId, children);
    }
    let paintedArea = 0;
    let accentArea = 0;
    for (const element of elements) {
      const area = Math.max(0, element.rect.width * element.rect.height);
      paintedArea += area;
      const ownBackground = colorKey(element.style.ownBackgroundColor);
      const foreground = colorKey(element.style.color);
      if (accentColors.has(ownBackground) || accentColors.has(foreground)) accentArea += area;
      if (ownBackground && ownBackground !== 'rgba(0,0,0,0)' && ownBackground !== 'transparent' && !excludedSurfaceColors.has(ownBackground)) {
        surfaces.add(ownBackground);
      }

      if (String(element.text || '').trim() && !element.harnessIcon) {
        const role = typeRole(element, adoptedRoles);
        if (!role) {
          hardFailures.push(`${screenContext.screenRelative}: ${JSON.stringify(element.text)} uses unpublished type tuple ${element.style.fontSize}/${element.style.lineHeight}/${element.style.fontWeight}`);
        } else roles.add(role);
      }

      const radius = number(element.style.borderRadius);
      if (radius && !SHAPE_SCALE.has(Math.round(radius))) {
        hardFailures.push(`${screenContext.screenRelative}: radius ${radius}px is outside 4/8/12/16/24`);
      }
      if (element.harnessIcon) iconSizes.add(Math.round(Math.max(element.rect.width, element.rect.height)));
      if (element.interactive && (element.rect.width < 48 || element.rect.height < 48)) {
        hardFailures.push(`${screenContext.screenRelative}: interactive ${element.testId || element.ariaLabel || element.tag} is ${element.rect.width}x${element.rect.height}, below 48x48`);
      }

      if (element.testId.startsWith('row:')) {
        const signature = descendants(element, elements, byParent)
          .map((child) => child.testId)
          .filter((testId) => testId && !testId.startsWith('row:'))
          .map((testId) => testId.replace(/:[^:]+$/, ':*'))
          .join('>');
        if (signature) rowSignatures.add(signature);
      }

      const hasGradient = /(?:linear|radial|conic)-gradient\(/i.test(element.style.backgroundImage || '');
      if (hasGradient || element.testId.startsWith('gradient:')) {
        const match = element.testId.match(/^gradient:([A-Za-z][A-Za-z0-9]*):(content|state|magnitude|legibility)$/);
        if (!match) {
          hardFailures.push(`${screenContext.screenRelative}: gradient lacks gradient:<token>:<source> testID`);
          continue;
        }
        const [, token, source] = match;
        gradients.add(token);
        if (!gradientTokens.has(token)) hardFailures.push(`${screenContext.screenRelative}: gradient ${token} is absent from brand gradients`);
        const children = descendants(element, elements, byParent);
        if (element.interactive || children.some((child) => child.interactive)) {
          hardFailures.push(`${screenContext.screenRelative}: gradient ${token} appears on interactive chrome`);
        }
        const structuralSource = ['content', 'legibility'].includes(source)
          ? children.some((child) => child.tag === 'img' || child.testId === 'hero')
          : Boolean(element.attributes?.['data-gradient-bound'])
            || children.some((child) => /^(chart|progress):/.test(child.testId));
        if (!structuralSource) hardFailures.push(`${screenContext.screenRelative}: gradient ${token} has no structural ${source} source`);
      }
    }
    const ratio = paintedArea > 0 ? accentArea / paintedArea : 0;
    accentBudgets.push({ screen: screenContext.screenRelative, ratio });
    if (ratio > 0.12) warnings.push(`${screenContext.screenRelative}: accent budget ${(ratio * 100).toFixed(1)}% exceeds 12%`);
    const filledPrimaryCount = elements.filter((element) => (
      element.testId === 'cta-primary'
      && element.rect.width >= snapshot.viewport.width * 0.8
      && colorKey(element.style.ownBackgroundColor) !== 'rgba(0,0,0,0)'
    )).length;
    primaryActions.push({ screen: screenContext.screenRelative, count: filledPrimaryCount });
    if (filledPrimaryCount > 1) warnings.push(`${screenContext.screenRelative}: ${filledPrimaryCount} filled full-width primary actions`);
  }

  if (roles.size > 7) hardFailures.push(`app uses ${roles.size} type roles; maximum is 7`);
  if (gradients.size > 2) hardFailures.push(`app renders ${gradients.size} gradient tokens; maximum is 2`);
  if (surfaces.size > 3) warnings.push(`app renders ${surfaces.size} non-accent/status surfaces; maximum is 3`);
  if (iconSizes.size > 3) warnings.push(`app renders ${iconSizes.size} icon sizes; warning threshold is 3`);
  if (rowSignatures.size > 1) warnings.push(`row anatomy differs across ${rowSignatures.size} rendered signatures`);

  return {
    pass: hardFailures.length === 0,
    failures: hardFailures,
    reportOnly: hardFailures.length === 0,
    report: {
      hardFailures,
      warnings,
      actual: {
        typeRoles: [...roles].sort(),
        surfaceCount: surfaces.size,
        accentBudgets,
        shapeScale: [...SHAPE_SCALE],
        iconSizes: [...iconSizes].sort((left, right) => left - right),
        primaryActions,
        rowSignatures: [...rowSignatures],
        gradients: [...gradients].sort(),
        brandDistinctness: identity,
      },
    },
  };
}

module.exports = { SHAPE_SCALE, TEMPLATE_DESIGN_DEFAULTS, TYPE_ROLES, adoptedTypeRoles, brandDistinctness, gradientTokenNames, runApp, scope: 'app', tokenColors, typeRole, visualFontFamilies };