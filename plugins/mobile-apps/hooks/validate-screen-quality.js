#!/usr/bin/env node

/**
 * Lexical validator: literal color/token bans in screen TSX.
 *
 * Scope is deliberately narrow. This validator owns only the rules that are
 * decidable from the text of a file:
 *   - #34 Color tokens are explicit ($color12, not the unresolvable $color)
 *   - #35 No raw hex literal outside brand/tokens.ts
 *
 * Every *behavioral* screen rule it used to carry — safe-area handling and
 * loading/error branch parity, empty-state placement relative to a list, icon-only
 * label and role and touch-target accessibility, Tamagui shadow props, and
 * unsupported button themes — now lives in the semantic analyzer
 * (`scripts/lib/ast/rules/`, run by `scripts/validate-mobile-ast.js`). Those rules
 * need the TypeScript program: a screen whose safe-area handling lives in an
 * imported `ScreenFrame`, or whose empty state comes from an aliased shared
 * component, is correct code that text matching cannot recognise.
 *
 * Fires after Write / Edit / MultiEdit on .tsx files inside `app/` or
 * `src/components/` of a generated project. Reads the tool_input from stdin,
 * scans content for forbidden patterns, exits 2 + corrective stderr to block.
 *
 * Scope:
 *   - Watches: app/(any-path)/*.tsx, src/components/(any-path)/*.tsx
 *   - Skips:   route layouts, brand/tokens.ts, tamagui.config.ts, tests,
 *              node_modules, src/generated (auto-generated), shared/samples
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

function isWatchedFile(filePath) {
  if (typeof filePath !== 'string') return false;
  if (!/\.tsx$/i.test(filePath)) return false;

  const norm = filePath.replace(/\\/g, '/');

  // Exclusions — these legitimately contain hex / inline shadows / etc.
  const exclude = [
    /\/_layout\.tsx$/,
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
// `color="$color"`, `bg="$bg"`, `color="$primary"` etc. — these don't resolve to
// any token in the default Tamagui 2 config. Builders must use $color12, $color2,
// or brand-aliased tokens.

const VAGUE_TOKEN_NAMES = new Set([
  '$color',     // missing scale digit — should be $color1..$color12
  '$bg',        // not a Tamagui token — use $background
  '$primary',   // not a Tamagui token — use $accentBase
  '$text',      // not a Tamagui token — use $color12
  '$accent',    // not a Tamagui token — use $accentBase
  '$secondary', // not a Tamagui token — use a verified project alias
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
        fix: `Use a numbered or brand-aliased token: ${prop}="$color12" / ${prop}="$brandText" / ${prop}="$accentBase". Bare ${token} does not resolve in the default Tamagui 2 config — text becomes invisible.`,
      });
    }
  }
  return violations;
}

// ─── Rule 2: No raw hex outside brand/ ───────────────────────────────────────
// Match #fff, #ffffff, #FFFFFF, #fff8 etc. anywhere in the file's TSX/style content.
// Whitelist: hex inside `// brand-exception:` comments, inside string literals
// that are NOT style values (e.g. status copy mentioning "#1"), and inside
// `console.*` / `aria-label` strings.

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

  const styleObjRe = /\b(color|backgroundColor|borderColor|borderTopColor|borderBottomColor|borderLeftColor|borderRightColor|tintColor)\s*:\s*['"](#[0-9a-fA-F]{3,8})['"][^\n]*/g;
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

// ─── Rule 5: No raw grays — soft warning, fold into raw-hex catch ────────────
// Already handled by findRawHex (any #color is caught). Specific gray warning
// would just duplicate. Skip as a separate rule.

// ─── Aggregate ───────────────────────────────────────────────────────────────

function findAllViolations(content) {
  return [
    ...findVagueTokens(content),
    ...findRawHex(content),
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
    'vague-token': 'Vague Tamagui tokens that do not resolve in Config v5 (causes invisible text)',
    'raw-hex': 'Raw hex colors in screen TSX (breaks dark-mode + brand tokens)',
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
  return ['vague-token', 'raw-hex'].includes(violation.rule);
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

  const content = extractContent(toolName, toolInput);
  if (!content) process.exit(0);

  const violations = findAllViolations(content);
  if (violations.length === 0) process.exit(0);

  process.stderr.write(buildBlockMessage(filePath, violations) + '\n');
  process.exit(2);
});
