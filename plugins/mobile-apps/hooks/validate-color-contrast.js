#!/usr/bin/env node

/**
 * Explicit validator: catch contrast-failing color usage in TS/TSX files.
 *
 * Fires after Write / Edit / MultiEdit. Scans the resulting content for
 * patterns that historically fail WCAG AA in this plugin's generated apps:
 *
 *   1. Hardcoded hex on `color=` / `bg=` / `borderColor=` props (token bypass —
 *      doesn't adapt across light/dark and often fails contrast in one mode).
 *   2. Low-alpha rgba() on text or borders (e.g. `rgba(255,255,255,0.4)` border,
 *      `rgba(255,255,255,0.7)` text — both fail their respective WCAG ratios).
 *   3. Low-contrast foreground tokens for readable text/icon states
 *      (`color="$color8"`, `$gray7`, etc.). These are too faint for inactive
 *      tabs, metadata, form helper text, and icon-only controls on mobile.
 *   4. White text on yellow/orange status fills, which often fails WCAG AA.
 *   5. Actual WCAG ratios for resolvable brand-token foreground/background
 *      pairs in text, buttons, badges, and nested status surfaces.
 *
 * Exits with code 2 + corrective message on stderr to block the call and
 * force the agent to fix it.
 *
 * Exit codes:
 *   0 = pass (no contrast issues, or not a TS/TSX file, or not a write tool)
 *   2 = block + show stderr to the model (Claude Code convention)
 */

const fs = require('fs');
const path = require('path');

const ALLOWED_HINT =
  'Use resolved Tamagui/brand semantic tokens and verify the actual pair. Text requires 4.5:1, or 3:1 at 24sp+ / 18.66sp+ bold; non-text UI requires 3:1. Never hardcode hex on color/bg/borderColor props in TSX.';

function normalizeHex(value) {
  const raw = String(value || '').trim();
  if (!/^#[0-9a-fA-F]{3,8}$/.test(raw)) return null;
  if (raw.length === 4) return `#${raw.slice(1).split('').map((char) => char + char).join('')}`.toLowerCase();
  if (raw.length === 7) return raw.toLowerCase();
  return null;
}

function relativeLuminance(hex) {
  const normalized = normalizeHex(hex);
  if (!normalized) return null;
  const channels = [1, 3, 5].map((index) => parseInt(normalized.slice(index, index + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  if (foregroundLuminance === null || backgroundLuminance === null) return null;
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function loadResolvedColors(projectRoot) {
  const colors = new Map();
  const aliases = new Map();
  const tokenPath = path.join(projectRoot, 'brand', 'tokens.ts');
  const designPath = path.join(projectRoot, 'brand', 'design-system.md');
  const configPath = path.join(projectRoot, 'tamagui.config.ts');

  if (fs.existsSync(tokenPath)) {
    const source = fs.readFileSync(tokenPath, 'utf8');
    let match;
    const color = /['"]?([A-Za-z][A-Za-z0-9_-]*)['"]?\s*:\s*['"](#[0-9a-fA-F]{3,8})['"]/g;
    while ((match = color.exec(source))) {
      const hex = normalizeHex(match[2]);
      if (hex) colors.set(match[1], hex);
    }
  }

  if (fs.existsSync(designPath)) {
    const source = fs.readFileSync(designPath, 'utf8');
    let match;
    const row = /^\s*\|\s*([A-Za-z][A-Za-z0-9_-]*)\s*\|\s*(#[0-9a-fA-F]{3,8})\s*\|/gm;
    while ((match = row.exec(source))) {
      const hex = normalizeHex(match[2]);
      if (hex && !colors.has(match[1])) colors.set(match[1], hex);
    }
  }

  if (fs.existsSync(configPath)) {
    const source = fs.readFileSync(configPath, 'utf8');
    let match;
    const literal = /\b([A-Za-z][A-Za-z0-9_]*)\s*:\s*['"](#[0-9a-fA-F]{3,8})['"]/g;
    while ((match = literal.exec(source))) {
      const hex = normalizeHex(match[2]);
      if (hex) colors.set(match[1], hex);
    }
    const reference = /\b([A-Za-z][A-Za-z0-9_]*)\s*:\s*brandTokens\.color\.([A-Za-z][A-Za-z0-9_]*)/g;
    while ((match = reference.exec(source))) aliases.set(match[1], match[2]);
  }

  const semantic = {
    background: 'bg',
    surface0: 'bg',
    surface1: 'surface',
    accentBase: colors.has('accent') ? 'accent' : 'primary',
    accentDeep: 'primary',
    text0: 'text',
    textMuted: 'textMuted',
    statusSuccess: 'statusSuccess',
    statusWarning: 'statusWarning',
    statusDanger: 'statusDanger',
    statusInfo: 'statusInfo',
  };
  for (const [alias, target] of Object.entries(semantic)) if (!aliases.has(alias)) aliases.set(alias, target);

  return { aliases, colors };
}

function resolveColor(value, resolved) {
  const literal = normalizeHex(value);
  if (literal) return literal;
  const token = /^\$([A-Za-z][A-Za-z0-9_-]*)$/.exec(String(value || '').trim());
  if (!token) return null;
  let key = token[1];
  const seen = new Set();
  while (resolved.aliases.has(key) && !seen.has(key)) {
    seen.add(key);
    key = resolved.aliases.get(key);
  }
  return resolved.colors.get(key) || null;
}

function propValue(tag, names) {
  const pattern = new RegExp(`\\b(?:${names.join('|')})\\s*=\\s*["']([^"']+)["']`);
  return pattern.exec(tag)?.[1] || null;
}

function textThreshold(tag) {
  const numeric = /fontSize\s*=\s*\{(\d+(?:\.\d+)?)\}/.exec(tag);
  const token = /fontSize\s*=\s*["']\$(\d+)["']/.exec(tag);
  const tokenSizes = { 1: 12, 2: 13, 3: 14, 4: 15, 5: 16, 6: 18, 7: 20, 8: 24, 9: 30, 10: 36, 11: 48, 12: 64 };
  const size = numeric ? Number(numeric[1]) : token ? tokenSizes[token[1]] || 0 : 0;
  const weightMatch = /fontWeight\s*=\s*["']?(\d+|bold)/.exec(tag);
  const bold = weightMatch && (weightMatch[1] === 'bold' || Number(weightMatch[1]) >= 700);
  return size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
}

function findResolvedContrastIssues(content, projectRoot) {
  const issues = [];
  const resolved = loadResolvedColors(projectRoot);
  if (!resolved.colors.size) return issues;

  function checkPair(foregroundValue, backgroundValue, tag, context) {
    const foreground = resolveColor(foregroundValue, resolved);
    const background = resolveColor(backgroundValue, resolved);
    if (!foreground || !background) return;
    const ratio = contrastRatio(foreground, background);
    const required = textThreshold(tag);
    if (ratio !== null && ratio + 1e-6 < required) {
      issues.push({
        type: `resolved contrast ${ratio.toFixed(2)}:1 (requires ${required}:1)`,
        match: `${context}: ${foregroundValue} (${foreground}) on ${backgroundValue} (${background})`,
      });
    }
  }

  let match;
  const selfColoredText = /<(Text|Paragraph|SizableText|Label|Button\.Text)\b([^>]*)>/g;
  while ((match = selfColoredText.exec(content))) {
    const foreground = propValue(match[2], ['col', 'color']);
    const background = propValue(match[2], ['bg', 'background', 'backgroundColor']);
    if (foreground && background) checkPair(foreground, background, match[2], match[1]);
  }

  const container = /<(YStack|XStack|ZStack|Card|Button|Stack)\b([^>]*)>([\s\S]{0,1000}?)<\/\1>/g;
  while ((match = container.exec(content))) {
    const background = propValue(match[2], ['bg', 'background', 'backgroundColor']);
    if (!background) continue;
    let child;
    const childText = /<(Text|Paragraph|SizableText|Label|Button\.Text)\b([^>]*)>/g;
    while ((child = childText.exec(match[3]))) {
      const foreground = propValue(child[2], ['col', 'color']);
      if (foreground) checkPair(foreground, background, child[2], `${match[1]}>${child[1]}`);
    }
  }
  return issues;
}

// ─── Pattern 1: hardcoded hex on color/bg/borderColor props ──────────────────
// Matches:  color="#abc"  bg="#abcdef"  borderColor='#aabbcc'  color={someVar ? '#aaa' : '#bbb'}
// Excludes:  shadowColor="#000" (RN-specific, expected for shadow elevation)
//            backgroundColor on style={{}} blocks (style-object form, separate concern)
const HEX_ON_COLOR_PROP = /\b(?:color|bg|background|borderColor)\s*=\s*['"]#[0-9a-fA-F]{3,8}['"]/g;
const TERNARY_HEX_ON_COLOR_PROP = /\b(?:color|bg|background|borderColor)\s*=\s*\{[^}]*['"]#[0-9a-fA-F]{3,8}['"][^}]*\}/g;

// ─── Pattern 2: low-alpha rgba on text / border ──────────────────────────────
// Catches the failing-AA case: white-or-near-white text below ~0.85 alpha,
// any-color borders below ~0.65 alpha (UI 3:1 threshold).
//
// Specifically flags:
//   color="rgba(255,255,255,0.X)"     where X < 85
//   borderColor="rgba(...,0.X)"       where X < 65
const LOW_ALPHA_TEXT_RE = /\bcolor\s*=\s*\{?\s*['"]rgba\([^)]*,\s*0?\.([0-7]\d?|8[0-4])\s*\)['"]/g;
const LOW_ALPHA_BORDER_RE = /\bborderColor\s*=\s*\{?\s*['"]rgba\([^)]*,\s*0?\.([0-5]\d?|6[0-4])\s*\)['"]/g;

// Pattern 3: readable foregrounds must not use faint token steps. `$color9`
// is the faintest acceptable caption/placeholder step; important metadata,
// inactive tabs, icons, and helper text should prefer `$color10` or stronger.
const LOW_CONTRAST_FOREGROUND_TOKEN_RE = /\b(?:col|color|placeholderTextColor|tabBarInactiveTintColor|tintColor)\s*=\s*['"](\$(?:color|gray)[1-8]|\$text3)['"]/g;
const LOW_CONTRAST_FOREGROUND_STYLE_RE = /\b(?:color|placeholderTextColor|tabBarInactiveTintColor|tintColor)\s*:\s*['"](\$(?:color|gray)[1-8]|\$text3)['"]/g;

// Pattern 4: white-on-yellow/orange pills are a recurring generated UI miss.
// Use dark amber/orange text on a tint, or a dark status fill with white text.
const RISKY_STATUS_FILL = '\\$(?:yellow|orange)(?:[6-9]|1[0-2])';
const WHITE_FOREGROUND = '(?:white|\\$white|\\$color1|#fff(?:fff)?|#FFF(?:FFF)?)';
const WHITE_ON_YELLOW_ORANGE_RE = new RegExp(
  `<[^>]+\\b(?:bg|background|backgroundColor)=['"](${RISKY_STATUS_FILL})['"][^>]+\\b(?:col|color)=['"](${WHITE_FOREGROUND})['"][^>]*>`,
  'g'
);
const WHITE_ON_YELLOW_ORANGE_REVERSED = new RegExp(
  `<[^>]+\\b(?:col|color)=['"](${WHITE_FOREGROUND})['"][^>]+\\b(?:bg|background|backgroundColor)=['"](${RISKY_STATUS_FILL})['"][^>]*>`,
  'g'
);

function isWatchedFile(filePath) {
  if (typeof filePath !== 'string') return false;
  // Only watch screen / component / sample TSX. Skip pure utility .ts files
  // and skip the validator scripts themselves.
  if (!/\.(tsx)$/i.test(filePath)) return false;
  if (filePath.includes('/hooks/') && filePath.endsWith('.js')) return false;
  return true;
}

function isWriteTool(toolName) {
  return toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit';
}

function extractContent(toolName, toolInput) {
  if (toolName === 'Write' && typeof toolInput.content === 'string') {
    return toolInput.content;
  }
  if (toolName === 'Edit' && typeof toolInput.new_string === 'string') {
    return toolInput.new_string;
  }
  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    return toolInput.edits
      .map((e) => (e && typeof e.new_string === 'string' ? e.new_string : ''))
      .join('\n');
  }
  const fp = toolInput.file_path || toolInput.filePath;
  if (typeof fp === 'string' && fs.existsSync(fp)) {
    try {
      return fs.readFileSync(fp, 'utf8');
    } catch {
      return '';
    }
  }
  return '';
}

// Strip out shadowColor lines (legitimate RN pattern — '#000' is the standard
// shadow color and isn't a contrast concern since shadows aren't perceptible
// as colored content).
function stripShadowColor(content) {
  return content.replace(/shadowColor\s*[:=]\s*['"]\s*#[0-9a-fA-F]{3,8}\s*['"]/g, '');
}

function findIssues(content, projectRoot = process.cwd()) {
  const cleaned = stripShadowColor(content);
  const issues = [];

  // Hex on color props
  const directHex = cleaned.match(HEX_ON_COLOR_PROP) || [];
  for (const m of directHex) {
    issues.push({ type: 'hex-on-color-prop', match: m.trim() });
  }
  const ternaryHex = cleaned.match(TERNARY_HEX_ON_COLOR_PROP) || [];
  for (const m of ternaryHex) {
    issues.push({ type: 'hex-on-color-prop (ternary)', match: m.trim() });
  }

  // Low-alpha text
  let mt;
  while ((mt = LOW_ALPHA_TEXT_RE.exec(cleaned))) {
    const alpha = parseInt(mt[1], 10) / (mt[1].length === 1 ? 10 : 100);
    issues.push({
      type: `low-alpha text (alpha=${alpha.toFixed(2)} — needs ≥0.85 for AA at small sizes)`,
      match: mt[0].trim(),
    });
  }
  LOW_ALPHA_TEXT_RE.lastIndex = 0;

  // Low-alpha border
  let mb;
  while ((mb = LOW_ALPHA_BORDER_RE.exec(cleaned))) {
    const alpha = parseInt(mb[1], 10) / (mb[1].length === 1 ? 10 : 100);
    issues.push({
      type: `low-alpha border (alpha=${alpha.toFixed(2)} — needs ≥0.65 for UI 3:1)`,
      match: mb[0].trim(),
    });
  }
  LOW_ALPHA_BORDER_RE.lastIndex = 0;

  // Faint foreground tokens
  let mf;
  while ((mf = LOW_CONTRAST_FOREGROUND_TOKEN_RE.exec(cleaned))) {
    issues.push({
      type: 'low-contrast foreground token',
      match: mf[0].trim(),
    });
  }
  LOW_CONTRAST_FOREGROUND_TOKEN_RE.lastIndex = 0;

  while ((mf = LOW_CONTRAST_FOREGROUND_STYLE_RE.exec(cleaned))) {
    issues.push({
      type: 'low-contrast foreground token',
      match: mf[0].trim(),
    });
  }
  LOW_CONTRAST_FOREGROUND_STYLE_RE.lastIndex = 0;

  // White text on yellow/orange fills
  let ms;
  while ((ms = WHITE_ON_YELLOW_ORANGE_RE.exec(cleaned))) {
    issues.push({
      type: 'white text on yellow/orange status fill',
      match: ms[0].trim(),
    });
  }
  WHITE_ON_YELLOW_ORANGE_RE.lastIndex = 0;

  while ((ms = WHITE_ON_YELLOW_ORANGE_REVERSED.exec(cleaned))) {
    issues.push({
      type: 'white text on yellow/orange status fill',
      match: ms[0].trim(),
    });
  }
  WHITE_ON_YELLOW_ORANGE_REVERSED.lastIndex = 0;

  issues.push(...findResolvedContrastIssues(cleaned, projectRoot));

  return issues;
}

function buildBlockMessage(filePath, issues) {
  const userMsg =
    `\n[mobile-app] Found ${issues.length} contrast issue${issues.length === 1 ? '' : 's'} in ${filePath} that would fail WCAG AA. Claude will revise.\n`;
  const modelMsg =
    `\n--- For Claude ---\n` +
    `${issues.length} contrast issue${issues.length === 1 ? '' : 's'} blocking the write to ${filePath}:\n\n` +
    issues
      .slice(0, 8)
      .map((i, idx) => `  ${idx + 1}. [${i.type}]\n     ${i.match.slice(0, 160)}`)
      .join('\n\n') +
    (issues.length > 8 ? `\n  ... and ${issues.length - 8} more\n` : '\n') +
    `\n${ALLOWED_HINT}\n` +
    `\nQuick fix patterns:\n` +
    `  • color="#9BA1A6"           → color="$color10"\n` +
    `  • color="#E5484D"           → color="$statusOverdue" (or $red10)\n` +
    `  • color="$color8" on tabs/text/icons → color="$color10" (or $color11 for important metadata)\n` +
    `  • bg="$yellow9" color="white"       → bg="$yellow3" color="$yellow11"\n` +
    `  • color="rgba(255,255,255,0.8)" on gradient → color="white" (full alpha)\n` +
    `  • borderColor="rgba(255,255,255,0.4)"       → borderColor="rgba(255,255,255,0.7)" + borderWidth={1.5}\n` +
    `  • bg="rgba(30,64,175,0.10)" + fg="#1e40af"  → bg="$blue3" + color="$blue11" (auto-adapts)\n`;
  return userMsg + modelMsg;
}

function collectTargetFiles(targets) {
  const files = [];
  const roots = targets.length > 0 ? targets : [process.cwd()];

  function walk(target) {
    if (!fs.existsSync(target)) return;
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target)) {
        if (entry === 'node_modules' || entry === '.expo' || entry === 'dist' || entry === 'build') continue;
        walk(path.join(target, entry));
      }
      return;
    }
    if (stat.isFile() && isWatchedFile(target)) files.push(target);
  }

  for (const target of roots) walk(path.resolve(target));
  return files;
}

function lineForMatch(content, match) {
  const idx = content.indexOf(match);
  if (idx < 0) return 1;
  return content.slice(0, idx).split(/\r?\n/).length;
}

function fixForIssue(issue) {
  if (issue.type.includes('hex-on-color-prop')) {
    return 'Replace raw hex color/background/border values with Tamagui semantic tokens from the design system.';
  }
  if (issue.type.includes('low-alpha text')) {
    return 'Use a stronger foreground token or full-opacity text; readable text must meet AA contrast.';
  }
  if (issue.type.includes('low-alpha border')) {
    return 'Use a stronger border token or raise border opacity/width so non-text UI reaches 3:1 contrast.';
  }
  if (issue.type.includes('low-contrast foreground token')) {
    return 'Use $color10 or stronger for metadata, inactive controls, helper text, and icon affordances.';
  }
  if (issue.type.includes('white text on yellow/orange')) {
    return 'Use a tint background with dark amber/orange foreground, e.g. bg="$yellow3" color="$yellow11".';
  }
  if (issue.type.includes('resolved contrast')) {
    return 'Change the resolved foreground/background token pair until the measured ratio reaches WCAG AA; do not assume semantic token names guarantee contrast.';
  }
  return ALLOWED_HINT;
}

function isAutoFixable(issue) {
  return issue.type.includes('low-contrast foreground token') || issue.type.includes('white text on yellow/orange');
}

function runReportMode() {
  const targets = process.argv.filter((arg) => arg !== '--report').slice(2);
  const issues = [];
  for (const filePath of collectTargetFiles(targets)) {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    for (const issue of findIssues(content, process.cwd())) {
      issues.push({
        validator: 'validate-color-contrast',
        file: path.relative(process.cwd(), filePath) || filePath,
        line: lineForMatch(content, issue.match),
        rule: issue.type,
        match: issue.match,
        fix: fixForIssue(issue),
        autoFixable: isAutoFixable(issue),
      });
    }
  }

  process.stdout.write(JSON.stringify({ validator: 'validate-color-contrast', issues }, null, 2) + '\n');
  process.exit(0);
}

function main() {
  let inputData = '';
  process.stdin.on('data', (chunk) => (inputData += chunk));
  process.stdin.on('end', () => {
    let input;
    try {
      input = JSON.parse(inputData);
    } catch {
      process.exit(0);
    }

    const toolName = input.tool_name;
    const toolInput = input.tool_input || {};
    if (!isWriteTool(toolName)) process.exit(0);

    const filePath = toolInput.file_path || toolInput.filePath;
    if (!isWatchedFile(filePath)) process.exit(0);

    const content = extractContent(toolName, toolInput);
    if (!content) process.exit(0);

    const issues = findIssues(content, path.resolve(input.cwd || process.cwd()));
    if (issues.length === 0) process.exit(0);

    process.stderr.write(buildBlockMessage(filePath, issues));
    process.exit(2);
  });
}

if (require.main === module) {
  if (process.argv.includes('--report')) runReportMode();
  else main();
}

module.exports = {
  contrastRatio,
  findIssues,
  findResolvedContrastIssues,
  loadResolvedColors,
  normalizeHex,
  relativeLuminance,
  resolveColor,
};
