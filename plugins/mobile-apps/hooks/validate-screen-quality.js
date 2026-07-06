#!/usr/bin/env node

/**
 * PostToolUse hook: enforce 5 screen-quality rules deterministically.
 *
 * Replaces these per-screen self-check rules from agents/screen-builder.md:
 *   - #20 Palette warmth (no raw grays in screens)
 *   - #29 No inline shadowOffset / shadowColor
 *   - #34 Color tokens are explicit ($color12 not $color)
 *   - #35 No raw hex outside brand/tokens.ts
 *   - #24 (partial) ListEmptyComponent — flag the "if data.length===0 above FlatList" anti-pattern
 *   - Mobile chrome/a11y guardrails observed from preview QA: safe-area clipping,
 *     bottom-anchored controls under the tab/home area, icon-only controls without
 *     labels, tappable custom stacks without roles, and too-small icon buttons.
 *
 * Fires after Write / Edit / MultiEdit on .tsx files inside `app/` or
 * `src/components/` of a generated project. Reads the tool_input from stdin,
 * scans content for forbidden patterns, exits 2 + corrective stderr to block.
 *
 * Scope:
 *   - Watches: app/(any-path)/*.tsx, src/components/(any-path)/*.tsx
 *   - Skips:   brand/tokens.ts, tamagui.config.ts, tests, node_modules,
 *              src/generated (auto-generated), shared/samples (plugin source)
 *
 * Exit codes:
 *   0 = pass (clean, not watched, or unparseable input)
 *   2 = block + show stderr to model
 */

const fs = require('fs');
const path = require('path');

// ─── File-scope filtering ────────────────────────────────────────────────────

function isWriteTool(toolName) {
  return toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit';
}

function hasDeferredStyleHooksMarker(filePath) {
  if (typeof filePath !== 'string' || !filePath) return false;

  let dir = path.dirname(path.resolve(filePath));
  for (let depth = 0; depth < 12; depth += 1) {
    if (fs.existsSync(path.join(dir, '.tmp', 'defer-style-hooks'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function isWatchedFile(filePath) {
  if (typeof filePath !== 'string') return false;
  if (!/\.tsx$/i.test(filePath)) return false;

  const norm = filePath.replace(/\\/g, '/');

  // Exclusions — these legitimately contain hex / inline shadows / etc.
  const exclude = [
    /\/brand\//,
    /\/tamagui\.config\.ts/,
    /\/node_modules\//,
    /\/tests?\//,
    /\/src\/generated\//,
    /\/shared\/samples\//, // plugin source, not a generated app screen
    /\/\.expo\//,
    /\/dist\//,
    /\/build\//,
  ];
  for (const re of exclude) {
    if (re.test(norm)) return false;
  }

  // Inclusions — must be inside an `app/` or `src/components/` of a project
  return /\/app\//.test(norm) || /\/src\/components\//.test(norm);
}

// ─── Content extraction ──────────────────────────────────────────────────────

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
  // Fallback: PostToolUse may have already executed the write — read from disk
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

// ─── Rule 1: Forbidden vague Tamagui token shorthands ────────────────────────
// `col="$color"`, `bg="$bg"`, `color="$primary"` etc. — these don't resolve to
// any token in default Tamagui v3 config. Builders must use $color12, $color2,
// or brand-aliased tokens.

const VAGUE_TOKEN_NAMES = new Set([
  '$color',     // missing scale digit — should be $color1..$color12
  '$bg',        // not a Tamagui token — use $background
  '$primary',   // not a Tamagui token — use brand alias
  '$text',      // not a Tamagui token — use $color12
  '$accent',    // not a Tamagui token — use brand alias
  '$secondary', // not a Tamagui token — use brand alias
  '$muted',     // not a Tamagui token — use $color10
  '$border',    // not a Tamagui token — use $borderColor
]);

function findVagueTokens(content) {
  const violations = [];
  // Match: prop=`$word` where prop is a color/bg-related Tamagui shorthand.
  // Props that resolve to color tokens in Tamagui: col, color, bg, background,
  // borderColor, borderTopColor, borderBottomColor, borderLeftColor, borderRightColor.
  const re = /\b(col|color|bg|background|borderColor|borderTopColor|borderBottomColor|borderLeftColor|borderRightColor)\s*=\s*["'](\$[a-zA-Z][a-zA-Z0-9_]*)["']/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const prop = m[1];
    const token = m[2];
    if (VAGUE_TOKEN_NAMES.has(token)) {
      violations.push({
        rule: 'vague-token',
        match: `${prop}="${token}"`,
        fix: `Use a numbered or brand-aliased token: ${prop}="$color12" / ${prop}="$brandText" / ${prop}="$accentBase". Bare ${token} does not resolve in default Tamagui v3 config — text becomes invisible.`,
      });
    }
  }
  return violations;
}

// ─── Rule 1b: Unsupported semantic button themes ────────────────────────────
// Generic theme names like theme="active" are not guaranteed by generated
// Tamagui configs. When unresolved, primary buttons can render as pale neutral
// controls and look disabled. Builders must use verified tokens or shared
// components unless the theme was explicitly present in tamagui.config.ts.

function findUnsupportedButtonThemes(content) {
  const violations = [];
  const re = /<Button\b[^>]*\btheme\s*=\s*["'](active|primary)["'][^>]*>/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    violations.push({
      rule: 'unsupported-button-theme',
      match: m[0].slice(0, 180),
      fix: 'Do not use theme="active" or theme="primary" unless that exact theme is defined in tamagui.config.ts. Use explicit verified tokens instead, e.g. <Button bg="$blue10" color="$color1" ...>.',
    });
  }
  return violations;
}

// ─── Rule 2: No raw hex outside brand/ ───────────────────────────────────────
// Match #fff, #ffffff, #FFFFFF, #fff8 etc. anywhere in the file's TSX/style content.
// Whitelist: hex inside `// brand-exception:` comments, inside string literals
// that are NOT style values (e.g. status copy mentioning "#1"), and inside
// `console.*` / `accessibilityLabel` strings.

function findRawHex(content) {
  const violations = [];
  // Strict: only flag hex that appears as the value of a known color-like prop
  // or inside a StyleSheet.create({...}) value. This avoids false positives
  // on ID strings, accessibility labels, etc.
  //
  // Patterns we flag:
  //   color="#abc"  /  color="#abcdef"  /  color="#abcdef99"
  //   bg="#..." / background="#..." / borderColor="#..."
  //   color: '#abc'  (inside StyleSheet)
  //   backgroundColor: '#abc'  (inside StyleSheet or style={{...}})
  //
  // Allowed escape: append `// brand-exception` on the same line.

  const propEqRe = /\b(col|color|bg|background|borderColor|borderTopColor|borderBottomColor|borderLeftColor|borderRightColor|tintColor|placeholderTextColor|underlineColorAndroid)\s*=\s*["'](#[0-9a-fA-F]{3,8})["'][^\n]*/g;
  let m;
  while ((m = propEqRe.exec(content)) !== null) {
    const line = m[0];
    if (/brand-exception/.test(line)) continue;
    violations.push({
      rule: 'raw-hex',
      match: `${m[1]}="${m[2]}"`,
      fix: `Replace with a Tamagui token from tamagui.config.ts (e.g. ${m[1]}="$color12" / ${m[1]}="$accentBase"). Raw hex breaks dark-mode swap and brand consistency. If this hex is intentional and brand-locked, append \`// brand-exception\` on the same line.`,
    });
  }

  const styleObjRe = /\b(color|backgroundColor|borderColor|borderTopColor|borderBottomColor|borderLeftColor|borderRightColor|tintColor|shadowColor)\s*:\s*['"](#[0-9a-fA-F]{3,8})['"][^\n]*/g;
  while ((m = styleObjRe.exec(content)) !== null) {
    const line = m[0];
    if (/brand-exception/.test(line)) continue;
    violations.push({
      rule: 'raw-hex',
      match: `${m[1]}: '${m[2]}'`,
      fix: `Replace with a Tamagui token reference or move the literal to brand/tokens.ts. If intentional, append \`// brand-exception\`.`,
    });
  }

  return violations;
}

// ─── Rule 3: No inline shadowOffset / shadowColor / shadowRadius ─────────────
// Builders must use Tamagui `elevation="$1"` or the `shadows` token export.

function findInlineShadows(content) {
  const violations = [];
  const re = /\b(shadowOffset|shadowColor|shadowRadius|shadowOpacity)\s*:/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    // Whitelist: inside brand/tokens.ts shadow definitions (file is already excluded above)
    violations.push({
      rule: 'inline-shadow',
      match: `${m[1]}: ...`,
      fix: `Use Tamagui \`elevation="$1"\` (subtle) or \`elevation="$2"\` (raised), or spread \`{...shadows.sm}\` from \`@/tokens\`. Inline shadow props skip the dark-mode fallback (where elevation should come from a lighter surface, not a black blur).`,
    });
  }
  return violations;
}

// ─── Rule 4: ListEmptyComponent anti-pattern ─────────────────────────────────
// Flag the "if (data.length === 0) <EmptyState />" branch ABOVE a FlatList
// (which prevents pull-to-refresh on empty lists). EmptyState should live
// inside FlatList's `ListEmptyComponent` prop.
//
// Heuristic: if file contains a FlatList AND a guarded EmptyState branch that
// returns BEFORE the FlatList, flag it. Crude but catches the common bug.

function findEmptyStateAntiPattern(content) {
  const violations = [];
  // Cheap structural test: does file contain `<FlatList`?
  if (!/<FlatList\b/.test(content)) return violations;
  // Is there a guard like `if (...length === 0)` or `if (... .length < 1)` that
  // returns an EmptyState (or any JSX containing EmptyState/empty state)?
  const guardRe = /if\s*\([^)]*\.length\s*(===|==|<)\s*[01]\s*\)\s*[\s\S]{0,200}?return[\s\S]{0,400}?<(EmptyState|YStack|View)\b/g;
  if (guardRe.test(content)) {
    // Confirm the FlatList appears AFTER the guard (i.e. unreachable when empty).
    const flatIdx = content.search(/<FlatList\b/);
    const guardIdx = content.search(/if\s*\([^)]*\.length\s*(===|==|<)\s*[01]\s*\)/);
    if (guardIdx >= 0 && flatIdx >= 0 && guardIdx < flatIdx) {
      violations.push({
        rule: 'empty-state-branched-above-flatlist',
        match: `if (...length === 0) return <Empty/> ... <FlatList/>`,
        fix: `Move the empty state INTO FlatList's \`ListEmptyComponent\` prop. Branching above the FlatList kills pull-to-refresh on empty lists — users can't reload after a failed first fetch. Pattern: <FlatList ... ListEmptyComponent={<EmptyState .../>} />`,
      });
    }
  }
  return violations;
}

// ─── Rule 5: Safe-area + bottom chrome ──────────────────────────────────────

function findSafeAreaProblems(content) {
  const violations = [];
  const hasScreenChrome = /<SafeAreaView\b|useSafeAreaInsets\s*\(/.test(content);
  const looksLikeScreen = /export\s+default\s+function\s+\w*Screen\b|<FlatList\b|<ScrollView\b|<ScreenHeader\b|<StatusBar\b/.test(content);

  if (looksLikeScreen && !hasScreenChrome) {
    violations.push({
      rule: 'missing-safe-area-chrome',
      match: 'screen content without SafeAreaView/useSafeAreaInsets',
      fix: 'Wrap screen content in SafeAreaView from react-native-safe-area-context or apply paddingTop={insets.top} from useSafeAreaInsets(). Top headers must never render under the iOS/Android status area.',
    });
  }

  const bottomAnchoredRe = /<[^>]+\b(?:pos|position)=["']absolute["'][^>]+\bbottom=\{?([^}\s>]+)[^>]*>/g;
  let m;
  while ((m = bottomAnchoredRe.exec(content)) !== null) {
    const tag = m[0];
    if (/insets\.bottom|bottomInset|tabBarHeight/.test(tag)) continue;
    violations.push({
      rule: 'absolute-bottom-without-inset',
      match: tag.slice(0, 180),
      fix: 'Offset absolute FABs, snackbars, and sticky CTAs with bottom={insets.bottom + 16} (or tabBarHeight + inset) so controls clear the home indicator and tab bar.',
    });
  }

  const bottomActionBar = /<BottomActionBar\b/.test(content);
  const safeAreaTopOnly = /<SafeAreaView\b[^>]*edges=\{\s*\[\s*['"]top['"]\s*\]\s*\}/.test(content);
  if (bottomActionBar && safeAreaTopOnly) {
    violations.push({
      rule: 'bottom-ui-safe-area-top-only',
      match: '<SafeAreaView edges={[\'top\']}> ... <BottomActionBar>',
      fix: 'Use edges={[\'top\', \'bottom\']} whenever the screen has BottomActionBar, sticky form actions, or other bottom-anchored UI.',
    });
  }

  // Branch parity guard: if the populated branch has SafeAreaView but loading/error
  // branches early-return shared states above it, headers can clip under status/notch.
  const hasSafeAreaView = /<SafeAreaView\b/.test(content);
  if (hasSafeAreaView) {
    if (/if\s*\(\s*(?:is)?loading[^)]*\)\s*return\s*<LoadingState\b/i.test(content)) {
      violations.push({
        rule: 'loading-branch-missing-safe-area',
        match: 'if (loading) return <LoadingState .../> before SafeAreaView',
        fix: 'Keep loading UI inside the same SafeAreaView/inset wrapper as the populated branch, or pass explicit insets to the loading branch wrapper so top chrome never clips.',
      });
    }
    if (/if\s*\(\s*\w*error\w*[^)]*\)\s*return\s*<ErrorState\b/i.test(content)) {
      violations.push({
        rule: 'error-branch-missing-safe-area',
        match: 'if (error) return <ErrorState .../> before SafeAreaView',
        fix: 'Keep error UI inside the same SafeAreaView/inset wrapper as the populated branch so status/header chrome remains consistent across states.',
      });
    }
  }

  return violations;
}

// ─── Rule 6b: Scanner processing spinner must be overlayed ──────────────────

function findScannerOverlayProblems(content) {
  const violations = [];
  if (!/<BarcodeScannerView\b/.test(content)) return violations;

  const hasSpinner = /<Spinner\b/.test(content);
  if (!hasSpinner) return violations;

  const spinnerInOverlayProp = /overlay\s*=\s*\{[\s\S]{0,1600}<Spinner\b/.test(content);
  if (!spinnerInOverlayProp) {
    violations.push({
      rule: 'scanner-loader-outside-overlay',
      match: '<BarcodeScannerView ...> + <Spinner ...> rendered outside overlay prop',
      fix: 'Render scanner processing feedback inside BarcodeScannerView overlay (spinner-only overlay). Do not place a separate loading card/panel above the camera preview.',
    });
  }

  return violations;
}

// ─── Rule 6: Icon-only controls need labels + roles ─────────────────────────

function hasTextChildren(tag) {
  return />\s*(?:[^<\s]|\{)[\s\S]*<\//.test(tag);
}

function findA11yControlProblems(content) {
  const violations = [];

  const fontScalingDisabled = /\ballowFontScaling=\{false\}/g;
  for (const match of content.matchAll(fontScalingDisabled)) {
    violations.push({
      rule: 'dynamic-type-disabled',
      match: match[0],
      fix: 'Do not disable system text scaling for readable UI. Let text scale, then use numberOfLines, maxWidth, wrapping, or responsive layout to keep controls from overlapping.',
    });
  }

  const buttonRe = /<Button\b[\s\S]{0,500}?(?:\/>|>[\s\S]{0,120}<\/Button>)/g;
  let m;
  while ((m = buttonRe.exec(content)) !== null) {
    let tag = m[0];
    if (!tag.includes('</Button>')) {
      const closeIdx = content.indexOf('</Button>', m.index);
      if (closeIdx >= 0 && closeIdx - m.index < 1200) {
        tag = content.slice(m.index, closeIdx + '</Button>'.length);
      }
    }
    const iconOnly = /\bicon=/.test(tag) && !hasTextChildren(tag);
    if (iconOnly && !/\baccessibilityLabel=/.test(tag)) {
      violations.push({
        rule: 'icon-only-control-missing-label',
        match: tag.slice(0, 180),
        fix: 'Every icon-only Button/Pressable needs accessibilityLabel and accessibilityRole="button" when the role is not provided by the component.',
      });
    }
    if (/\bsize=["']\$[12]["']/.test(tag) && !/\bhitSlop=/.test(tag)) {
      violations.push({
        rule: 'small-touch-target-without-hitslop',
        match: tag.slice(0, 180),
        fix: 'Buttons with size="$1" or size="$2" are visually too small for mobile touch. Use size="$3"+ or add hitSlop={8} so the target is at least 44x44 pt.',
      });
    }
  }

  const tappableStackRe = /<(XStack|YStack|ZStack|Stack)\b(?=[\s\S]{0,400}\bonPress=)[\s\S]{0,500}?(?:\/>|>[\s\S]{0,120}<\/\1>)/g;
  while ((m = tappableStackRe.exec(content)) !== null) {
    const tag = m[0];
    if (!/\baccessibilityRole=/.test(tag)) {
      violations.push({
        rule: 'custom-pressable-missing-role',
        match: tag.slice(0, 180),
        fix: 'Custom tappable stacks must include accessibilityRole="button" (or the correct role) and a clear accessibilityLabel when the visual label is not enough.',
      });
    }
  }

  const tappableContainerRe = /<(Button|Pressable|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback|XStack|YStack|ZStack|Stack|View)\b(?=[^>]*\bonPress=)[^>]*>([\s\S]{0,1800}?)<\/\1>/g;
  while ((m = tappableContainerRe.exec(content)) !== null) {
    const block = m[0];
    const body = m[2] || '';
    const nestedInteractive = /<(Button|Pressable|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback|Link)\b|<(XStack|YStack|ZStack|Stack|View)\b(?=[^>]*\bonPress=)/.test(body);
    if (nestedInteractive) {
      violations.push({
        rule: 'nested-touch-targets',
        match: block.slice(0, 220),
        fix: 'Do not nest tappable controls inside another onPress parent. Give the row/card a single press owner, move child actions to siblings, or make decorative child overlays pointerEvents="none" so they do not intercept the parent tap.',
      });
    }
  }

  return violations;
}

// ─── Rule 7: Red/status visual discipline ───────────────────────────────────

function findStatusVisualProblems(content) {
  const violations = [];
  const statusStripeWithPill = /\bborderLeft(?:Width|Color)\b[\s\S]{0,800}<(StatusPill|Badge)\b|<(StatusPill|Badge)\b[\s\S]{0,800}\bborderLeft(?:Width|Color)\b/.test(content);
  if (statusStripeWithPill) {
    violations.push({
      rule: 'redundant-status-cues',
      match: 'left status stripe plus filled StatusPill/Badge in the same row/card',
      fix: 'Use one strong status cue plus text: either a left stripe with plain status text, or a status pill. Do not combine both in list rows unless the spec explicitly calls for emergency/outdoor mode.',
    });
  }

  const largeRedHeaderRe = /<(YStack|XStack|View|Stack)\b[^>]*(?:bg|background|backgroundColor)=["']\$(?:red|status(?:Fail|Error|Danger))[89]|<(YStack|XStack|View|Stack)\b[^>]*(?:bg|background|backgroundColor)=["']\$(?:red|status(?:Fail|Error|Danger))1[0-2]/g;
  let m;
  while ((m = largeRedHeaderRe.exec(content)) !== null) {
    const tag = m[0];
    if (/height=\{?(?:1[8-9]\d|[2-9]\d\d)|minHeight=\{?(?:1[8-9]\d|[2-9]\d\d)|flex=\{?1|f=\{?1/.test(tag)) {
      violations.push({
        rule: 'dominant-red-detail-header',
        match: tag.slice(0, 180),
        fix: 'Avoid full-screen-feeling red headers on detail screens. Use a compact status band, tinted red surface, or strong label plus structured details below so Fail states read as operational records, not app errors.',
      });
    }
  }

  return violations;
}

// ─── Rule 5: No raw grays — soft warning, fold into raw-hex catch ────────────
// Already handled by findRawHex (any #color is caught). Specific gray warning
// would just duplicate. Skip as a separate rule.

// ─── Aggregate ───────────────────────────────────────────────────────────────

function findAllViolations(content) {
  return [
    ...findVagueTokens(content),
    ...findUnsupportedButtonThemes(content),
    ...findRawHex(content),
    ...findInlineShadows(content),
    ...findEmptyStateAntiPattern(content),
    ...findSafeAreaProblems(content),
    ...findScannerOverlayProblems(content),
    ...findA11yControlProblems(content),
    ...findStatusVisualProblems(content),
  ];
}

function buildBlockMessage(filePath, violations) {
  const rel = path.relative(process.cwd(), filePath) || filePath;
  const lines = [];

  lines.push(
    `[mobile-app] A screen file was written with patterns known to cause silent UI bugs (invisible text, broken pull-to-refresh, dark-mode mismatch). The write was blocked; Claude will fix and retry — no action needed from you.`
  );
  lines.push('');
  lines.push(`For Claude: BLOCKED: screen-quality violations in ${rel}`);
  lines.push('');

  // Group by rule for readability
  const byRule = {};
  for (const v of violations) {
    if (!byRule[v.rule]) byRule[v.rule] = [];
    byRule[v.rule].push(v);
  }

  const ruleHeaders = {
    'vague-token': 'Vague Tamagui tokens that don\'t resolve in v3 config (causes invisible text)',
    'unsupported-button-theme': 'Unsupported semantic button theme (primary CTA can look disabled)',
    'raw-hex': 'Raw hex colors in screen TSX (breaks dark-mode + brand tokens)',
    'inline-shadow': 'Inline shadow props (skip dark-mode elevation fallback)',
    'empty-state-branched-above-flatlist': 'EmptyState branched above FlatList (breaks pull-to-refresh on empty list)',
    'missing-safe-area-chrome': 'Screen content can clip under the status/header area',
    'absolute-bottom-without-inset': 'Bottom-anchored controls can collide with tab bar/home indicator',
    'bottom-ui-safe-area-top-only': 'Bottom UI requires bottom safe-area handling',
    'loading-branch-missing-safe-area': 'Loading branch can bypass safe-area wrapper',
    'error-branch-missing-safe-area': 'Error branch can bypass safe-area wrapper',
    'scanner-loader-outside-overlay': 'Scanner loader must be overlayed in camera preview',
    'icon-only-control-missing-label': 'Icon-only controls missing accessibility labels',
    'small-touch-target-without-hitslop': 'Small mobile touch targets without hitSlop',
    'custom-pressable-missing-role': 'Custom tappable stacks missing accessibility roles',
    'nested-touch-targets': 'Nested touch targets can intercept parent taps',
    'dynamic-type-disabled': 'Dynamic type disabled on readable text',
    'redundant-status-cues': 'Noisy redundant status styling',
    'dominant-red-detail-header': 'Over-dominant failure/error header treatment',
  };

  for (const ruleName of Object.keys(byRule)) {
    lines.push(`  ${ruleHeaders[ruleName] || ruleName}:`);
    // Show up to 5 examples per rule
    const examples = byRule[ruleName].slice(0, 5);
    for (const ex of examples) {
      lines.push(`    - ${ex.match}`);
    }
    if (byRule[ruleName].length > 5) {
      lines.push(`    ... and ${byRule[ruleName].length - 5} more`);
    }
    // One fix hint per rule (first violation's fix message)
    lines.push(`    Fix: ${byRule[ruleName][0].fix}`);
    lines.push('');
  }

  lines.push('Re-issue the Write/Edit with all violations fixed. Do NOT add `// brand-exception` to bypass — only use that for genuinely brand-locked literal colors that must NOT swap in dark mode.');
  return lines.join('\n');
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

function isAutoFixable(violation) {
  return [
    'vague-token',
    'raw-hex',
    'icon-only-control-missing-label',
    'small-touch-target-without-hitslop',
    'custom-pressable-missing-role',
    'nested-touch-targets',
    'dynamic-type-disabled',
    'bottom-ui-safe-area-top-only',
  ].includes(violation.rule);
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
    for (const violation of findAllViolations(content)) {
      issues.push({
        validator: 'validate-screen-quality',
        file: path.relative(process.cwd(), filePath) || filePath,
        line: lineForMatch(content, violation.match),
        rule: violation.rule,
        match: violation.match,
        fix: violation.fix,
        autoFixable: isAutoFixable(violation),
      });
    }
  }

  process.stdout.write(JSON.stringify({ validator: 'validate-screen-quality', issues }, null, 2) + '\n');
  process.exit(0);
}

// ─── stdin → exit ────────────────────────────────────────────────────────────

if (process.argv.includes('--report')) {
  runReportMode();
}

let inputData = '';
process.stdin.on('data', (chunk) => {
  inputData += chunk;
});
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(inputData || '{}');
  } catch {
    process.exit(0);
  }

  const toolName = input.tool_name || input.toolName;
  const toolInput = input.tool_input || input.toolInput || {};

  if (!isWriteTool(toolName)) process.exit(0);

  const filePath = toolInput.file_path || toolInput.filePath;
  if (!isWatchedFile(filePath)) process.exit(0);

  if (process.env.CODE_APPS_NATIVE_SKIP_SCREEN_QUALITY_HOOK === '1' || hasDeferredStyleHooksMarker(filePath)) process.exit(0);

  const content = extractContent(toolName, toolInput);
  if (!content) process.exit(0);

  const violations = findAllViolations(content);
  if (violations.length === 0) process.exit(0);

  process.stderr.write(buildBlockMessage(filePath, violations) + '\n');
  process.exit(2);
});
