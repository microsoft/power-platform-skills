#!/usr/bin/env node

/**
 * PostToolUse hook: enforce navigation intent + submit idempotency guardrails.
 *
 * Blocking errors:
 * - `router.push(...)` to known singleton routes (must use `router.navigate(...)`)
 * - Async save handlers without a submit busy lock (`isSubmitting` / `isPending`)
 *
 * Non-blocking warning:
 * - Navigation handlers with no obvious duplicate-tap guard (`isNavigating`)
 */

const fs = require('fs');

function isWriteTool(toolName) {
  return toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit';
}

function isWatchedFile(filePath) {
  if (typeof filePath !== 'string') return false;
  if (!/\.tsx$/i.test(filePath)) return false;

  const norm = filePath.replace(/\\/g, '/');
  if (!/\/app\//.test(norm)) return false;
  if (/\/node_modules\//.test(norm)) return false;
  if (/\/src\/generated\//.test(norm)) return false;
  if (/\/shared\/samples\//.test(norm)) return false;
  if (/\/\.expo\//.test(norm) || /\/dist\//.test(norm) || /\/build\//.test(norm)) return false;
  return true;
}

function getContent(toolName, toolInput) {
  if (toolName === 'Write' && typeof toolInput.content === 'string') return toolInput.content;
  if (toolName === 'Edit' && typeof toolInput.new_string === 'string') return toolInput.new_string;
  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    return toolInput.edits
      .map((e) => (e && typeof e.new_string === 'string' ? e.new_string : ''))
      .join('\n');
  }

  const filePath = toolInput.file_path || toolInput.filePath;
  if (typeof filePath === 'string' && fs.existsSync(filePath)) {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  }
  return '';
}

function normalizeRouteLiteral(routeLiteral) {
  const route = String(routeLiteral || '').split('?')[0].trim();
  return route;
}

function isSingletonRoute(route) {
  return /\/(?:\(app\)\/)?(?:workout|recovery)\/form$/.test(route) || /\/login$/.test(route);
}

function findSingletonPushViolations(content) {
  const violations = [];

  const literalPushRe = /router\.push\s*\(\s*([`'\"])([^`'\"]+)\1\s*\)/g;
  let m;
  while ((m = literalPushRe.exec(content)) !== null) {
    const route = normalizeRouteLiteral(m[2]);
    if (isSingletonRoute(route)) {
      violations.push(
        `Use router.navigate(...) for singleton route "${route}". router.push(...) can create duplicate instances on double-tap.`
      );
    }
  }

  const objectPushRe = /router\.push\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
  while ((m = objectPushRe.exec(content)) !== null) {
    const body = m[1] || '';
    const pm = body.match(/pathname\s*:\s*([`'\"])([^`'\"]+)\1/);
    if (!pm) continue;
    const route = normalizeRouteLiteral(pm[2]);
    if (isSingletonRoute(route)) {
      violations.push(
        `Use router.navigate(...) for singleton route "${route}" in object-form navigation.`
      );
    }
  }

  return violations;
}

function hasAsyncSave(content) {
  if (/\b\w+Service\.(create|update)\s*\(/.test(content)) return true;
  if (/\buseMutation\s*\(/.test(content)) return true;
  return false;
}

function hasSubmitLock(content) {
  const lockFlag = /\b(isSubmitting|formState\.isSubmitting|isPending)\b/.test(content);
  if (!lockFlag) return false;

  const stateLockPattern = /setIsSubmitting\s*\(\s*true\s*\)[\s\S]{0,1800}?finally\s*\{[\s\S]{0,400}?setIsSubmitting\s*\(\s*false\s*\)/.test(content);
  const mutationLockPattern = /\bisPending\b/.test(content) && /disabled\s*=\s*\{[^}]*isPending[^}]*\}/.test(content);
  const formStateLockPattern = /formState\.isSubmitting/.test(content) && /disabled\s*=\s*\{[^}]*formState\.isSubmitting[^}]*\}/.test(content);

  return stateLockPattern || mutationLockPattern || formStateLockPattern;
}

function hasNavigation(content) {
  return /router\.(push|navigate|replace)\s*\(/.test(content);
}

function hasNavigationTapGuard(content) {
  const lockMention = /\bisNavigating\b/.test(content);
  if (!lockMention) return false;

  const earlyReturn = /if\s*\(\s*isNavigating\s*\)\s*return/.test(content);
  const setTrue = /setIsNavigating\s*\(\s*true\s*\)/.test(content);
  const setFalse = /setIsNavigating\s*\(\s*false\s*\)/.test(content);
  return earlyReturn && setTrue && setFalse;
}

function buildBlockMessage(filePath, errors, warnings) {
  const lines = [
    '[mobile-app] Navigation/submit idempotency guardrail violation. Write blocked.',
    '',
    `For Claude: BLOCKED: navigation/submit guardrails failed in ${filePath}`,
    '',
  ];

  for (const err of errors) lines.push(`  - ${err}`);

  if (warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of warnings) lines.push(`  - ${warning}`);
  }

  lines.push('');
  lines.push('Required fixes:');
  lines.push('  - Singleton routes must use `router.navigate(...)`, not `router.push(...)`.');
  lines.push('  - Async save flows must use a submit lock (`isSubmitting` or `isPending`) and disabled busy CTA.');
  lines.push('  - Primary navigation actions should use an `isNavigating` lock to prevent iOS duplicate transitions.');

  return lines.join('\n');
}

function buildWarningMessage(filePath, warnings) {
  const lines = [
    `[mobile-app] Navigation guardrail warning in ${filePath}:`,
  ];
  for (const warning of warnings) lines.push(`  - ${warning}`);
  return lines.join('\n');
}

if (require.main === module) {
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

    const content = getContent(toolName, toolInput);
    if (!content) process.exit(0);

    const errors = [];
    const warnings = [];

    const singletonPush = findSingletonPushViolations(content);
    errors.push(...singletonPush);

    if (hasAsyncSave(content) && !hasSubmitLock(content)) {
      errors.push('Async save flow detected without a submit busy lock (`isSubmitting`/`isPending`).');
    }

    if (hasNavigation(content) && !hasNavigationTapGuard(content)) {
      warnings.push('Navigation calls found with no clear `isNavigating` duplicate-tap guard.');
    }

    if (errors.length > 0) {
      process.stderr.write(buildBlockMessage(filePath, errors, warnings) + '\n');
      process.exit(2);
    }

    if (warnings.length > 0) {
      process.stderr.write(buildWarningMessage(filePath, warnings) + '\n');
    }

    process.exit(0);
  });
}

module.exports = {
  findSingletonPushViolations,
  hasSubmitLock,
  hasAsyncSave,
  hasNavigationTapGuard,
};
