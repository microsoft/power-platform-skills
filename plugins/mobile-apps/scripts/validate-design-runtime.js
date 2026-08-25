#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function sourceFiles(root, relativeDirectory) {
  const directory = path.join(root, relativeDirectory);
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(candidate);
    }
  };
  visit(directory);
  return files;
}

function literalPresent(source, property, value) {
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`['\"]?${property}['\"]?\\s*:\\s*['\"]${escaped}['\"]`).test(source);
}

function validateTypographyRecipe(typography) {
  const issues = [];
  if (!typography || typeof typography !== 'object') {
    return [{ rule: 'missing-typography-recipe', message: 'Design recipe is missing its typography runtime contract.' }];
  }
  const requiredStrings = ['displayRole', 'bodyRole', 'runtimeStrategy', 'headingFamily', 'bodyFamily', 'monoFamily', 'rationale'];
  for (const property of requiredStrings) {
    if (typeof typography[property] !== 'string' || !typography[property].trim()) {
      issues.push({ rule: 'incomplete-typography-recipe', message: `Design recipe typography.${property} is required.` });
    }
  }
  if (typography.supportsDynamicType !== true) {
    issues.push({ rule: 'dynamic-type-disabled', message: 'Design recipe must preserve native Dynamic Type/font scaling.' });
  }
  for (const role of ['display', 'heading', 'title', 'body', 'label', 'caption']) {
    if (typeof typography.roles?.[role] !== 'string' || !typography.roles[role].startsWith('$')) issues.push({ rule: 'typography-role-unresolved', message: `Design recipe typography.roles.${role} must resolve to a semantic token.` });
  }
  if (typography.dynamicType?.enabled !== true || typography.dynamicType?.preserveLayout !== true || typeof typography.dynamicType?.maximumScale !== 'number' || typography.dynamicType.maximumScale < 1.5) {
    issues.push({ rule: 'dynamic-type-contract-incomplete', message: 'Design recipe must declare enabled Dynamic Type, layout preservation, and a usable maximum scale.' });
  }
  if (typography.runtimeStrategy === 'platform-safe-editorial') {
    if (typography.displayRole !== 'editorial-display' || typography.headingFamily !== 'platform-serif' || typography.bodyFamily !== 'system-sans') {
      issues.push({ rule: 'editorial-family-drift', message: 'Platform-safe editorial typography requires an editorial display role, platform-serif headings, and system-sans body copy.' });
    }
  } else if (typography.runtimeStrategy === 'system-native') {
    if (typography.headingFamily !== 'system-sans' || typography.bodyFamily !== 'system-sans' || String(typography.rationale || '').trim().length < 20) {
      issues.push({ rule: 'unjustified-system-typography', message: 'System-native typography requires system-sans heading/body families and an explicit rationale.' });
    }
  } else if (typography.runtimeStrategy !== 'bundled-custom') {
    issues.push({ rule: 'unknown-typography-strategy', message: `Unsupported typography runtime strategy: ${typography.runtimeStrategy || 'missing'}.` });
  }
  return issues;
}

function validateDesignRuntimeSources(recipe, { tokensSource = '', configSource = '', runtimeSource = '' } = {}) {
  const typography = recipe?.typography;
  const issues = validateTypographyRecipe(typography);
  if (!typography || issues.some((issue) => issue.rule === 'missing-typography-recipe')) return issues;

  for (const property of ['runtimeStrategy', 'headingFamily', 'bodyFamily', 'monoFamily']) {
    if (typeof typography[property] === 'string' && !literalPresent(tokensSource, property, typography[property])) {
      issues.push({ rule: 'typography-token-drift', message: `brand/tokens.ts does not preserve recipe typography.${property}.` });
    }
  }
  if (!/createFont\s*\(/.test(configSource) || !/fonts\s*:\s*\{[\s\S]*?heading\s*:/.test(configSource) || !/fonts\s*:\s*\{[\s\S]*?body\s*:/.test(configSource)) {
    issues.push({ rule: 'typography-fonts-not-wired', message: 'tamagui.config.ts must create and register $heading and $body fonts.' });
  }
  if (!/brandTokens\.typography\b/.test(configSource)) {
    issues.push({ rule: 'typography-tokens-not-consumed', message: 'tamagui.config.ts does not consume brandTokens.typography.' });
  }
  if (typography.runtimeStrategy === 'platform-safe-editorial'
    && (!/Platform\.select\s*\(/.test(configSource) || !/Georgia/.test(configSource) || !/['"]serif['"]/.test(configSource))) {
    issues.push({ rule: 'editorial-runtime-not-wired', message: 'Editorial runtime must map platform-serif to platform-safe iOS/Android families without downloading a font.' });
  }
  if (typography.runtimeStrategy === 'system-native'
    && (!/Platform\.select\s*\(/.test(configSource) || !/sans-serif/.test(configSource))) {
    issues.push({ rule: 'system-runtime-not-wired', message: 'System-native runtime must explicitly map the system-sans semantic family.' });
  }
  if (!/fontFamily\s*=\s*['"]\$heading['"]/.test(runtimeSource)) {
    issues.push({ rule: 'heading-role-unused', message: 'Generated runtime components do not consume the $heading role.' });
  }
  if (!/fontFamily\s*=\s*['"]\$body['"]/.test(runtimeSource)) {
    issues.push({ rule: 'body-role-unused', message: 'Generated runtime components do not consume the $body role.' });
  }
  if (/allowFontScaling\s*=\s*\{\s*false\s*\}/.test(runtimeSource)) {
    issues.push({ rule: 'dynamic-type-disabled', message: 'Generated runtime disables font scaling with allowFontScaling={false}.' });
  }
  return issues;
}

function validateDesignRuntime(projectRoot, packPath = '.tmp/screen-build-pack.json') {
  const root = path.resolve(projectRoot);
  const resolvedPack = path.resolve(root, packPath);
  const tokensPath = path.join(root, 'brand', 'tokens.ts');
  const configPath = path.join(root, 'tamagui.config.ts');
  if (!fs.existsSync(resolvedPack)) return [{ rule: 'missing-screen-build-pack', message: 'Design runtime validation requires .tmp/screen-build-pack.json.' }];
  if (!fs.existsSync(tokensPath)) return [{ rule: 'missing-design-tokens', message: 'Design runtime validation requires brand/tokens.ts.' }];
  if (!fs.existsSync(configPath)) return [{ rule: 'missing-tamagui-config', message: 'Design runtime validation requires tamagui.config.ts.' }];
  let pack;
  try { pack = readJson(resolvedPack, 'Screen build pack'); } catch (error) {
    return [{ rule: 'invalid-screen-build-pack', message: error.message }];
  }
  const runtimeFiles = [...sourceFiles(root, 'src/components'), ...sourceFiles(root, 'app')];
  const runtimeSource = runtimeFiles.map((filePath) => fs.readFileSync(filePath, 'utf8')).join('\n');
  return validateDesignRuntimeSources(pack?.design?.recipe, {
    tokensSource: fs.readFileSync(tokensPath, 'utf8'),
    configSource: fs.readFileSync(configPath, 'utf8'),
    runtimeSource,
  });
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--pack') args.pack = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-design-runtime.js --project-root <dir> [--pack .tmp/screen-build-pack.json] [--json]\n');
    return 2;
  }
  const issues = validateDesignRuntime(args.projectRoot, args.pack);
  if (args.json) process.stdout.write(`${JSON.stringify({ validator: 'validate-design-runtime', issues }, null, 2)}\n`);
  if (issues.length) {
    if (!args.json) issues.forEach((issue) => process.stderr.write(`- [${issue.rule}] ${issue.message}\n`));
    return 2;
  }
  if (!args.json) process.stdout.write('Design runtime passed.\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { validateDesignRuntime, validateDesignRuntimeSources, validateTypographyRecipe };
