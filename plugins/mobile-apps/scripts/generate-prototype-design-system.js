#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

function renderTamaguiConfig() {
  return `import { createTamagui, createTokens } from '@tamagui/core';
import { createSystemFont, defaultConfig } from '@tamagui/config/v5';
import { animations } from '@tamagui/config/v5-rn';

import * as brand from './brand/tokens';

type HexColor = \`#\${string}\`;
type BrandColors = Partial<{
  bg: HexColor;
  surface: HexColor;
  surfaceMuted: HexColor;
  border: HexColor;
  primary: HexColor;
  primaryStrong: HexColor;
  accent: HexColor;
  onPrimary: HexColor;
  statusSuccess: HexColor;
  statusSuccessSoft: HexColor;
  statusWarning: HexColor;
  statusWarningSoft: HexColor;
  statusDanger: HexColor;
  statusDangerSoft: HexColor;
  statusInfo: HexColor;
  statusInfoSoft: HexColor;
}>;
type OptionalTokenGroups = typeof brand.tokens & {
  color: BrandColors;
  size?: Record<string, number>;
  space?: Record<string, number>;
  typography?: Partial<Record<'body' | 'heading' | 'display' | 'mono', { family?: string }>>;
};
type OptionalBrandModule = typeof brand & {
  fontStack?: Partial<Record<'body' | 'heading' | 'display' | 'mono', string>>;
};

const brandModule = brand as OptionalBrandModule;
const brandTokens = brand.tokens as OptionalTokenGroups;
const { shapeScale, typeScale } = brand;
const systemSans = '-apple-system, system-ui, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const systemMono = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

const fontSize = {
  1: typeScale.labelSmall.fontSize,
  2: typeScale.bodyMedium.fontSize,
  3: typeScale.bodyLarge.fontSize,
  4: typeScale.bodyLarge.fontSize,
  true: typeScale.bodyLarge.fontSize,
  5: typeScale.titleLarge.fontSize,
  6: typeScale.headlineSmall.fontSize,
  7: typeScale.headlineMedium.fontSize,
  8: typeScale.headlineLarge.fontSize,
  9: typeScale.headlineLarge.fontSize,
  10: typeScale.headlineLarge.fontSize,
  11: typeScale.headlineLarge.fontSize,
  12: typeScale.headlineLarge.fontSize,
  13: typeScale.headlineLarge.fontSize,
  14: typeScale.headlineLarge.fontSize,
  15: typeScale.headlineLarge.fontSize,
  16: typeScale.headlineLarge.fontSize,
} as const;
const lineHeight = {
  1: typeScale.labelSmall.lineHeight,
  2: typeScale.bodyMedium.lineHeight,
  3: typeScale.bodyLarge.lineHeight,
  4: typeScale.bodyLarge.lineHeight,
  true: typeScale.bodyLarge.lineHeight,
  5: typeScale.titleLarge.lineHeight,
  6: typeScale.headlineSmall.lineHeight,
  7: typeScale.headlineMedium.lineHeight,
  8: typeScale.headlineLarge.lineHeight,
  9: typeScale.headlineLarge.lineHeight,
  10: typeScale.headlineLarge.lineHeight,
  11: typeScale.headlineLarge.lineHeight,
  12: typeScale.headlineLarge.lineHeight,
  13: typeScale.headlineLarge.lineHeight,
  14: typeScale.headlineLarge.lineHeight,
  15: typeScale.headlineLarge.lineHeight,
  16: typeScale.headlineLarge.lineHeight,
} as const;
const fontWeight = {
  1: typeScale.labelSmall.fontWeight,
  2: typeScale.bodyMedium.fontWeight,
  3: typeScale.bodyLarge.fontWeight,
  4: typeScale.bodyLarge.fontWeight,
  true: typeScale.bodyLarge.fontWeight,
  5: typeScale.titleLarge.fontWeight,
  6: typeScale.headlineSmall.fontWeight,
  7: typeScale.headlineMedium.fontWeight,
  8: typeScale.headlineLarge.fontWeight,
  9: typeScale.headlineLarge.fontWeight,
  10: typeScale.headlineLarge.fontWeight,
  11: typeScale.headlineLarge.fontWeight,
  12: typeScale.headlineLarge.fontWeight,
  13: typeScale.headlineLarge.fontWeight,
  14: typeScale.headlineLarge.fontWeight,
  15: typeScale.headlineLarge.fontWeight,
  16: typeScale.headlineLarge.fontWeight,
} as const;
const visualFont = { size: fontSize, lineHeight, weight: fontWeight } as const;
const bodyFamily = brandModule.fontStack?.body ?? brandTokens.typography?.body?.family ?? systemSans;
const headingFamily = brandModule.fontStack?.heading
  ?? brandTokens.typography?.heading?.family
  ?? brandModule.fontStack?.display
  ?? brandTokens.typography?.display?.family
  ?? bodyFamily;
const monoFamily = brandModule.fontStack?.mono ?? brandTokens.typography?.mono?.family ?? systemMono;

const bodyFont = createSystemFont({ font: { family: bodyFamily, ...visualFont } });
const headingFont = createSystemFont({ font: { family: headingFamily, ...visualFont } });
const monoFont = createSystemFont({ font: { family: monoFamily, ...visualFont } });

const lightStatusColors = {
  statusOverdueBg: '#FDECEA', statusCompleteBg: '#E6F4EA', statusInProgressBg: '#E8F0FE',
  statusPendingBg: '#FEF7E0', statusDraftBg: '#F1F3F4', statusCancelledBg: '#F1F3F4',
  statusOverdue: '#C5221F', statusComplete: '#137333', statusInProgress: '#1A73E8',
  statusPending: '#B06000', statusDraft: '#5F6368', statusCancelled: '#5F6368',
} as const;
const darkStatusColors = {
  statusOverdueBg: '#3B1210', statusCompleteBg: '#12351F', statusInProgressBg: '#102A43',
  statusPendingBg: '#3A2A0A', statusDraftBg: '#28282C', statusCancelledBg: '#28282C',
  statusOverdue: '#FF8A84', statusComplete: '#75D69C', statusInProgress: '#8EC8FF',
  statusPending: '#F5C46B', statusDraft: '#B4B4BC', statusCancelled: '#B4B4BC',
} as const;

function withSemanticAliases(
  theme: typeof defaultConfig.themes.light,
  statusColors: typeof lightStatusColors | typeof darkStatusColors,
  colors: BrandColors = {},
) {
  return {
    ...theme,
    surface0: colors.bg ?? theme.background,
    surface1: colors.surface ?? theme.color2,
    surface2: colors.surfaceMuted ?? theme.color3,
    surface3: colors.border ?? theme.color4,
    accentDeep: colors.primaryStrong ?? colors.primary ?? theme.blue8,
    accentBase: colors.primary ?? theme.blue10,
    accentSoft: colors.accent ?? theme.blue3,
    accentOnAccent: colors.onPrimary ?? theme.color1,
    statusComplete: colors.statusSuccess ?? statusColors.statusComplete,
    statusCompleteBg: colors.statusSuccessSoft ?? statusColors.statusCompleteBg,
    statusPending: colors.statusWarning ?? statusColors.statusPending,
    statusPendingBg: colors.statusWarningSoft ?? statusColors.statusPendingBg,
    statusOverdue: colors.statusDanger ?? statusColors.statusOverdue,
    statusOverdueBg: colors.statusDangerSoft ?? statusColors.statusOverdueBg,
    statusInProgress: colors.statusInfo ?? statusColors.statusInProgress,
    statusInProgressBg: colors.statusInfoSoft ?? statusColors.statusInProgressBg,
    statusDraft: statusColors.statusDraft,
    statusDraftBg: statusColors.statusDraftBg,
    statusCancelled: statusColors.statusCancelled,
    statusCancelledBg: statusColors.statusCancelledBg,
  };
}

const radius = {
  ...defaultConfig.tokens.radius,
  1: shapeScale.xs, 2: shapeScale.xs,
  3: shapeScale.sm, 4: shapeScale.sm, true: shapeScale.sm,
  5: shapeScale.md, 6: shapeScale.md,
  7: shapeScale.lg, 8: shapeScale.lg,
  9: shapeScale.xl, 10: shapeScale.xl, 11: shapeScale.xl, 12: shapeScale.xl,
  xs: shapeScale.xs, sm: shapeScale.sm, md: shapeScale.md, lg: shapeScale.lg,
  xl: shapeScale.xl, full: shapeScale.xl,
};
const tokens = createTokens({
  ...defaultConfig.tokens,
  radius,
  size: { ...defaultConfig.tokens.size, ...(brandTokens.size ?? {}) },
  space: { ...defaultConfig.tokens.space, ...(brandTokens.space ?? {}) },
});
const darkBrandColors: BrandColors = {
  primary: brandTokens.color.primary,
  primaryStrong: brandTokens.color.primaryStrong,
  accent: brandTokens.color.accent,
  onPrimary: brandTokens.color.onPrimary,
  statusSuccess: brandTokens.color.statusSuccess,
  statusWarning: brandTokens.color.statusWarning,
  statusDanger: brandTokens.color.statusDanger,
  statusInfo: brandTokens.color.statusInfo,
};
const themes = {
  ...defaultConfig.themes,
  light: withSemanticAliases(defaultConfig.themes.light, lightStatusColors, brandTokens.color),
  dark: withSemanticAliases(defaultConfig.themes.dark, darkStatusColors, darkBrandColors),
};
const tamaguiConfig = createTamagui({
  ...defaultConfig,
  animations,
  fonts: { ...defaultConfig.fonts, body: bodyFont, heading: headingFont, mono: monoFont },
  themes,
  tokens,
});

export { tamaguiConfig };
export default tamaguiConfig;
export type Conf = typeof tamaguiConfig;

declare module 'tamagui' {
  interface TamaguiCustomConfig extends Conf {}
}
`;
}
const path = require('node:path');

const TOKEN_BLOCK_START = '// PROTOTYPE SEMANTICS START - managed by generate-prototype-design-system.js';
const TOKEN_BLOCK_END = '// PROTOTYPE SEMANTICS END';
const TOKEN_DISCIPLINE_START = '// PROTOTYPE DISCIPLINE START - managed by generate-prototype-design-system.js';
const TOKEN_DISCIPLINE_END = '// PROTOTYPE DISCIPLINE END';
const DESIGN_BLOCK_START = '<!-- PROTOTYPE SEMANTICS START - managed by generate-prototype-design-system.js -->';
const DESIGN_BLOCK_END = '<!-- PROTOTYPE SEMANTICS END -->';
const DISCIPLINE_BLOCK_START = '<!-- PROTOTYPE DISCIPLINE START - managed by generate-prototype-design-system.js -->';
const DISCIPLINE_BLOCK_END = '<!-- PROTOTYPE DISCIPLINE END -->';

function fail(message) {
  console.error(`prototype-design-system: ${message}`);
  process.exit(1);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`${filePath} is not valid JSON: ${error.message}`);
  }
}

function hashNumber(value) {
  return Number.parseInt(crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8), 16);
}

function hslToHex(hue, saturation, lightness) {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const segment = ((hue % 360) + 360) % 360 / 60;
  const x = chroma * (1 - Math.abs((segment % 2) - 1));
  const [red, green, blue] = segment < 1 ? [chroma, x, 0]
    : segment < 2 ? [x, chroma, 0]
      : segment < 3 ? [0, chroma, x]
        : segment < 4 ? [0, x, chroma]
          : segment < 5 ? [x, 0, chroma]
            : [chroma, 0, x];
  const match = l - chroma / 2;
  return `#${[red, green, blue]
    .map((channel) => Math.round((channel + match) * 255).toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase();
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map((value) => Number.parseInt(value, 16) / 255);
  return channels
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrastRatio(first, second) {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function darkenToContrast(hue, saturation, initialLightness, backgrounds, minimum = 4.5) {
  for (let lightness = initialLightness; lightness >= 0; lightness -= 1) {
    const candidate = hslToHex(hue, saturation, lightness);
    if (backgrounds.every((background) => contrastRatio(candidate, background) >= minimum)) {
      return candidate;
    }
  }
  return '#000000';
}

function hueFromHex(hex) {
  let value = String(hex || '').replace(/^#/, '');
  if (value.length === 3) value = value.split('').map((character) => `${character}${character}`).join('');
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  const [red, green, blue] = value.match(/.{2}/g).map((channel) => Number.parseInt(channel, 16) / 255);
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

function warningAccentFromTokens(source, fallback) {
  const match = String(source || '').match(/\b(?:accentBase|primary)\s*:\s*['"](#[0-9a-f]{3,6})['"]/i);
  if (!match) return fallback;
  const hue = hueFromHex(match[1]);
  return hue === null ? fallback : hue <= 20 || hue >= 340;
}

function derivePalette(domain) {
  const hue = hashNumber(domain) % 360;
  const accentBase = hslToHex(hue, 62, 36);
  const surface0 = hslToHex(hue, 24, 99);
  const surface1 = hslToHex(hue, 22, 96);
  const surface2 = hslToHex(hue, 20, 91);
  const surfaces = [surface0, surface1, surface2];
  const accentCandidates = ['#10202C', '#FFFFFF'];
  return {
    hue,
    accentIsWarningHue: hue <= 20 || hue >= 340,
    accentBase,
    accentSoft: hslToHex(hue, 45, 91),
    accentOn: accentCandidates.sort((left, right) => contrastRatio(right, accentBase) - contrastRatio(left, accentBase))[0],
    surface0,
    surface1,
    surface2,
    ink: darkenToContrast(hue, 28, 14, surfaces),
    inkMuted: darkenToContrast(hue, 16, 35, surfaces),
    inkFaint: darkenToContrast(hue, 12, 48, surfaces),
    warnFg: '#7A3700',
    warnBg: '#FBEAD9',
  };
}

function statusTone(label) {
  const normalized = String(label).toLowerCase();
  if (/available|complete|confirmed|approved|active|resolved|issued|released|passed|done|success/.test(normalized)) return 'success';
  if (/sold out|blocked|failed|cancelled|canceled|overdue|rejected|expired|denied|critical/.test(normalized)) return 'alarm';
  if (/low stock|pending|review|draft|progress|waiting|moderate|warning/.test(normalized)) return 'warning';
  return 'neutral';
}

function collectStatusFields(contract) {
  const fields = [];
  for (const table of contract.tables || []) {
    for (const column of table.columns || []) {
      const name = `${column.logicalName || ''} ${column.displayName || ''}`;
      const type = String(column.type || column.attributeType || '').toLowerCase();
      if (!/status|state|phase|outcome/.test(name.toLowerCase())) continue;
      if (!['choice', 'picklist', 'multiselectchoice', 'boolean'].includes(type)) continue;
      if (!Array.isArray(column.options) || column.options.length === 0) {
        fail(`${table.logicalName}.${column.logicalName} is status-like but has no option labels`);
      }
      const options = [];
      for (const option of column.options) {
        if (!Number.isInteger(option?.value) || !String(option?.label || '').trim()) {
          fail(`${table.logicalName}.${column.logicalName} has an invalid status option`);
        }
        options.push([option.value, String(option.label)]);
      }
      fields.push({ key: `${table.logicalName}.${column.logicalName}`, options });
    }
  }
  return fields.sort((left, right) => left.key.localeCompare(right.key));
}

function unambiguousStatusOptions(statusFields) {
  const labelsByValue = new Map();
  for (const field of statusFields) {
    for (const [value, label] of field.options) {
      const labels = labelsByValue.get(value) || new Set();
      labels.add(label);
      labelsByValue.set(value, labels);
    }
  }
  return [...labelsByValue.entries()]
    .filter(([, labels]) => labels.size === 1)
    .map(([value, labels]) => [value, [...labels][0]])
    .sort(([left], [right]) => left - right);
}

function collectStatusOptions(contract) {
  return unambiguousStatusOptions(collectStatusFields(contract));
}

function statusColors(tone, accentIsWarningHue) {
  if (tone === 'success') return { fg: '#0B4D2C', bg: '#E0F2E8', stripe: '#16834F' };
  if (tone === 'alarm') {
    return accentIsWarningHue
      ? { fg: '#7A3700', bg: '#FBEAD9', stripe: '#CA5010' }
      : { fg: '#7A1F2A', bg: '#FBE5E8', stripe: '#C4314B' };
  }
  if (tone === 'warning') return { fg: '#7A3700', bg: '#FBEAD9', stripe: '#CA5010' };
  return { fg: '#344657', bg: '#E8EDF2', stripe: '#6A7D8E' };
}

function deriveFontStack(domain) {
  const stacks = [
    { heading: 'Avenir Next, Avenir, Segoe UI, sans-serif', body: 'Avenir Next, Avenir, Segoe UI, sans-serif' },
    { heading: 'Trebuchet MS, Segoe UI, sans-serif', body: 'Segoe UI, Helvetica Neue, Arial, sans-serif' },
    { heading: 'Georgia, Times New Roman, serif', body: 'Avenir Next, Avenir, Segoe UI, sans-serif' },
  ];
  return stacks[hashNumber(domain) % stacks.length];
}

function renderDisciplineTokens(fontStack) {
  const fontStackSource = fontStack
    ? `\nexport const fontStack = ${JSON.stringify({ ...fontStack, mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }, null, 2)} as const;\n`
    : '';
  return `${TOKEN_DISCIPLINE_START}
export const typeScale = {
  headlineLarge: { fontSize: 32, lineHeight: 40, fontWeight: '400' },
  headlineMedium: { fontSize: 28, lineHeight: 36, fontWeight: '400' },
  headlineSmall: { fontSize: 24, lineHeight: 32, fontWeight: '400' },
  titleLarge: { fontSize: 22, lineHeight: 28, fontWeight: '500' },
  bodyLarge: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  bodyMedium: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
  labelSmall: { fontSize: 11, lineHeight: 16, fontWeight: '500' },
} as const;
${fontStackSource}

export const shapeScale = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

export const chartTokens = {
  seriesPrimary: '#147D92',
  seriesSecondary: '#6B5CA5',
  seriesTertiary: '#B8642F',
  grid: '#D5DEE6',
  axisLabelRole: 'labelSmall',
} as const;

export const gradients = {
  imageScrim: ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0.72)'],
  chartArea: ['rgba(20, 125, 146, 0.32)', 'rgba(20, 125, 146, 0.02)'],
} as const;

export type GradientName = keyof typeof gradients;
${TOKEN_DISCIPLINE_END}`;
}

function renderDisciplineDesign() {
  return `${DISCIPLINE_BLOCK_START}
## Discipline

- Font sizes come only from the adopted Material 3 \`typeScale\`; use at most 7 roles app-wide.
- Corner radii come only from \`shapeScale\`: 4 / 8 / 12 / 16 / 24.
- Exactly two surface levels (canvas and content surface); a third only for pinned layers.
- Accent-painted area stays near 10% and never exceeds 12% of a screen.
- Icons use one row size and one chrome size; one empty-state size is optional.
- Use at most one filled full-width primary action per screen; read-only screens may use none.
- Every list row shares one skeleton: icon, title, metadata, trailing state.
- Touch targets are at least 48x48; contrast is at least 4.5:1 for body text and 3:1 for large text/non-text.
- Chart series use only \`chartTokens\`; grid uses \`chartTokens.grid\`; axes use the adopted \`labelSmall\` role. Chart colors never reuse accent or status scales.

Sources: [Material 3](https://m3.material.io/), [Material 3 type scale](https://m3.material.io/styles/typography/type-scale-tokens), [Apple HIG](https://developer.apple.com/design/human-interface-guidelines/), [WCAG 2.2](https://www.w3.org/TR/WCAG22/).

### Discipline Negatives

- no gradient without a declared source: content, state, magnitude, or legibility
- never a gradient on interactive chrome: buttons, chips, or tab bars
- at most 2 distinct rendered gradients in the whole app
- never render a selected cautionary or negative option in the accent colour; selection inherits the option's semantic status tone
${DISCIPLINE_BLOCK_END}`;
}

function renderTokenSemantics(domain, palette, statusOptions, statusFields = []) {
  const statusEntries = statusOptions.map(([value, label]) => {
    const colors = statusColors(statusTone(label), palette.accentIsWarningHue);
    return `  ${JSON.stringify(String(value))}: ${JSON.stringify({ label, ...colors })},`;
  });
  const fieldEntries = statusFields.map((field) => {
    const options = field.options.map(([value, label]) => {
      const colors = statusColors(statusTone(label), palette.accentIsWarningHue);
      return `    ${JSON.stringify(String(value))}: ${JSON.stringify({ label, ...colors })},`;
    });
    return `  ${JSON.stringify(field.key)}: {\n${options.join('\n')}\n  },`;
  });
  return `${TOKEN_BLOCK_START}\nexport type StatusToken = {\n  label: string;\n  fg: \`#\${string}\`;\n  bg: \`#\${string}\`;\n  stripe: \`#\${string}\`;\n};\n\n// Values shared by multiple local choices appear here only when their labels agree.\nexport const statusByValue: Record<string, StatusToken> = {\n${statusEntries.join('\n')}\n};\n\n// Dataverse local choices can reuse the same integer for different labels.\nexport const statusByFieldValue: Record<string, Record<string, StatusToken>> = {\n${fieldEntries.join('\n')}\n};\n\nexport function statusToken(field: string, value: string | number): StatusToken | undefined {\n  const key = String(value);\n  return statusByFieldValue[field]?.[key] ?? statusByValue[key];\n}\n\nconst dayFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });\nconst dayTimeFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });\n\nfunction dateValue(value: Date | string | number): Date {\n  return value instanceof Date ? value : new Date(value);\n}\n\nexport function day(value: Date | string | number): string {\n  return dayFormatter.format(dateValue(value));\n}\n\nexport function dayTime(value: Date | string | number): string {\n  return dayTimeFormatter.format(dateValue(value));\n}\n\nexport const designProvenance = ${JSON.stringify({ domain, source: 'brief + schema contract' })} as const;\n${TOKEN_BLOCK_END}`;
}

function renderTokens(domain, palette, statusOptions, statusFields = []) {
  return `// Generated by generate-prototype-design-system.js from the approved brief and schema contract.\n\nexport const palette = ${JSON.stringify({
    accentBase: palette.accentBase,
    accentSoft: palette.accentSoft,
    accentOn: palette.accentOn,
    surface0: palette.surface0,
    surface1: palette.surface1,
    surface2: palette.surface2,
    ink: palette.ink,
    inkMuted: palette.inkMuted,
    inkFaint: palette.inkFaint,
    warnFg: palette.warnFg,
    warnBg: palette.warnBg,
  }, null, 2)} as const;\n\nexport const tokens = {\n  color: {\n    bg: palette.surface0,\n    surface: palette.surface1,\n    surfaceMuted: palette.surface2,\n    primary: palette.accentBase,\n    accent: palette.accentSoft,\n    onPrimary: palette.accentOn,\n    text: palette.ink,\n    textMuted: palette.inkMuted,\n    border: palette.surface2,\n    statusSuccess: '#16834F',\n    statusWarning: palette.warnFg,\n    statusDanger: ${JSON.stringify(palette.accentIsWarningHue ? '#CA5010' : '#C4314B')},\n    statusInfo: palette.accentBase,\n  },\n  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, '2xl': 32, '3xl': 48, '4xl': 64 },\n  size: { buttonHeight: 52, inputHeight: 52, listRowHeight: 64, iconSize: 24, avatarSm: 32, avatarMd: 40, avatarLg: 56 },\n  radius: { sm: 4, md: 6, lg: 8, full: 9999 },\n} as const;\n\n${renderTokenSemantics(domain, palette, statusOptions, statusFields)}\n`;
}

function renderDesignSemantics(statusOptions, palette, statusFields = []) {
  const statusRows = statusFields.flatMap((field) => field.options.map(([value, label]) => {
    const colors = statusColors(statusTone(label), palette.accentIsWarningHue);
    return `| \`${field.key}\` | \`${value}\` | ${label} | \`${colors.fg}\` | \`${colors.bg}\` | \`${colors.stripe}\` |`;
  }));
  return `${DESIGN_BLOCK_START}\n## Prototype Status Map\n\n| Field | Value | Label | Foreground | Background | Stripe |\n|---|---|---|---|---|---|\n${statusRows.join('\n') || '| - | - | No status options declared | - | - | - |'}\n\nUnambiguous values are also available through \`statusByValue\`; use \`statusToken(field, value)\` whenever a local choice value can be reused.\n\n## Prototype Component Rules\n\n- Status is shown with the mapped background, foreground, stripe, label, and an icon.\n- Date labels use \`day()\` or \`dayTime()\` from \`brand/tokens.ts\`.\n\n## Prototype Negatives\n\n- never use the accent as a status colour - status owns its own hue scale\n- never place status colour on chrome (headers, tab bar, nav)\n- no card borders on list rows - use fill difference plus a status stripe\n- when the brand accent is itself a warning hue (red-branded organisations), alarms move to a second channel - amber plus icon - and the accent stays brand-and-primary-action only\n- never place raw hex values in files under \`app/\`; import semantic tokens instead\n${DESIGN_BLOCK_END}`;
}

function renderDesignSystem(domain, palette, statusOptions, statusFields = []) {
  const paletteRows = [
    ['accentBase', palette.accentBase, 'Brand and primary actions only'],
    ['accentSoft', palette.accentSoft, 'Selected and supportive brand surfaces'],
    ['accentOn', palette.accentOn, 'Text and icons on accentBase'],
    ['surface0', palette.surface0, 'Page background'],
    ['surface1', palette.surface1, 'Grouped surface fill'],
    ['surface2', palette.surface2, 'Muted fill and separators'],
    ['ink', palette.ink, 'Primary text'],
    ['inkMuted', palette.inkMuted, 'Secondary text'],
    ['inkFaint', palette.inkFaint, 'Tertiary metadata'],
    ['warnFg', palette.warnFg, 'Warning text and icons'],
    ['warnBg', palette.warnBg, 'Warning surface'],
  ].map(([token, hex, usage]) => `| \`${token}\` | \`${hex}\` | ${usage} |`);
  return `# ${domain} - Prototype Design System\n\n## Brand\n\n- Identity: ${domain}\n- Accent source: deterministic hash of the approved domain phrase\n- Status source: approved schema choice labels\n\n## Palette\n\n| Token | Hex | Usage |\n|---|---|---|\n${paletteRows.join('\n')}\n\n${renderDesignSemantics(statusOptions, palette, statusFields)}\n`;
}

function replaceManagedBlock(source, start, end, block) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end);
  if (startIndex >= 0 || endIndex >= 0) {
    if (startIndex < 0 || endIndex < startIndex) fail(`managed block markers are malformed: ${start}`);
    return `${source.slice(0, startIndex)}${block}${source.slice(endIndex + end.length)}`;
  }
  return `${source.trimEnd()}\n\n${block}\n`;
}

function main() {
  const projectArg = process.argv[2];
  if (!projectArg) fail('usage: node generate-prototype-design-system.js <project-dir>');
  const projectDir = path.resolve(projectArg);
  const vocabularyPath = path.join(projectDir, '.tmp', 'seed-vocabulary.json');
  const contractPath = path.join(projectDir, '.tmp', 'dataverse-schema-contract.json');
  if (!fs.existsSync(vocabularyPath)) fail('.tmp/seed-vocabulary.json is required');
  if (!fs.existsSync(contractPath)) fail('.tmp/dataverse-schema-contract.json is required');
  const vocabulary = readJson(vocabularyPath);
  const contract = readJson(contractPath);
  if (!String(vocabulary.domain || '').trim()) fail('seed vocabulary domain is required');
  if (!Array.isArray(contract.tables)) fail('schema contract tables must be an array');
  const palette = derivePalette(vocabulary.domain.trim());
  const statusFields = collectStatusFields(contract);
  const statusOptions = unambiguousStatusOptions(statusFields);
  const brandDir = path.join(projectDir, 'brand');
  fs.mkdirSync(brandDir, { recursive: true });
  const tokenPath = path.join(brandDir, 'tokens.ts');
  const designPath = path.join(brandDir, 'design-system.md');
  const tamaguiConfigPath = path.join(projectDir, 'tamagui.config.ts');
  const existingTokenSource = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf8') : '';
  const generatedBaseline = !existingTokenSource
    || existingTokenSource.startsWith('// Generated by generate-prototype-design-system.js');
  const semanticPalette = generatedBaseline
    ? palette
    : { ...palette, accentIsWarningHue: warningAccentFromTokens(existingTokenSource, palette.accentIsWarningHue) };
  const tokenSource = generatedBaseline
    ? renderTokens(vocabulary.domain.trim(), semanticPalette, statusOptions, statusFields)
    : replaceManagedBlock(
      existingTokenSource,
      TOKEN_BLOCK_START,
      TOKEN_BLOCK_END,
      renderTokenSemantics(vocabulary.domain.trim(), semanticPalette, statusOptions, statusFields),
    );
  const generatedDesign = !fs.existsSync(designPath)
    || fs.readFileSync(designPath, 'utf8').startsWith(`# ${vocabulary.domain.trim()} - Prototype Design System`);
  const designSource = generatedDesign
    ? renderDesignSystem(vocabulary.domain.trim(), semanticPalette, statusOptions, statusFields)
    : replaceManagedBlock(
      fs.readFileSync(designPath, 'utf8'),
      DESIGN_BLOCK_START,
      DESIGN_BLOCK_END,
      renderDesignSemantics(statusOptions, semanticPalette, statusFields),
    );
  const disciplinedTokenSource = replaceManagedBlock(
    tokenSource,
    TOKEN_DISCIPLINE_START,
    TOKEN_DISCIPLINE_END,
    renderDisciplineTokens(generatedBaseline ? deriveFontStack(vocabulary.domain.trim()) : null),
  );
  const disciplinedDesignSource = replaceManagedBlock(
    designSource,
    DISCIPLINE_BLOCK_START,
    DISCIPLINE_BLOCK_END,
    renderDisciplineDesign(),
  );
  fs.writeFileSync(tokenPath, disciplinedTokenSource);
  fs.writeFileSync(designPath, disciplinedDesignSource);
  fs.writeFileSync(tamaguiConfigPath, renderTamaguiConfig());
  const statusCount = statusFields.reduce((total, field) => total + field.options.length, 0);
  console.log(`prototype-design-system: ${generatedBaseline ? 'generated baseline' : 'augmented approved artifacts'} (${statusCount} status option(s))`);
}

if (require.main === module) main();

module.exports = {
  collectStatusFields,
  collectStatusOptions,
  contrastRatio,
  deriveFontStack,
  derivePalette,
  hueFromHex,
  renderDesignSemantics,
  renderDesignSystem,
  renderDisciplineDesign,
  renderDisciplineTokens,
  renderTokenSemantics,
  renderTokens,
  renderTamaguiConfig,
  replaceManagedBlock,
  statusColors,
  statusTone,
  unambiguousStatusOptions,
  warningAccentFromTokens,
};