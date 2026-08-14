#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

function isWriteTool(toolName) {
  return toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit';
}

function isSourceFile(filePath) {
  return typeof filePath === 'string' &&
    /\.[jt]sx?$/i.test(filePath) &&
    !/[\\/]node_modules[\\/]/.test(filePath) &&
    !/[\\/]src[\\/]generated[\\/]/.test(filePath);
}

function extractContent(toolName, toolInput) {
  if (toolName === 'Write' && typeof toolInput.content === 'string') return toolInput.content;
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

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function findPackageJson(startPath) {
  let current = path.dirname(path.resolve(startPath));
  while (current !== path.dirname(current)) {
    const candidate = path.join(current, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    current = path.dirname(current);
  }
  return null;
}

function declaredPackages(packageJson) {
  return new Set(Object.keys({
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
    ...(packageJson.optionalDependencies || {}),
    ...(packageJson.peerDependencies || {}),
  }));
}

function findUndeclaredImports(content, packageJson) {
  const declared = declaredPackages(packageJson);
  const violations = [];
  const specifiers = new Set();
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[^"'`;]*?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) specifiers.add(match[1]);
  }
  for (const specifier of specifiers) {
    if (
      specifier.startsWith('.') ||
      specifier.startsWith('/') ||
      specifier.startsWith('@/') ||
      specifier.startsWith('#') ||
      BUILTINS.has(specifier)
    ) continue;
    const packageName = packageNameFromSpecifier(specifier);
    if (!declared.has(packageName)) {
      violations.push({ specifier, packageName });
    }
  }
  return violations;
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
  const filePath = toolInput.file_path || toolInput.filePath;
  if (!isWriteTool(toolName) || !isSourceFile(filePath)) process.exit(0);

  const packagePath = findPackageJson(filePath);
  if (!packagePath) {
    process.stderr.write(`BLOCKED: cannot validate imports because package.json was not found for ${filePath}\n`);
    process.exit(2);
  }

  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch (error) {
    process.stderr.write(`BLOCKED: cannot parse ${packagePath}: ${error.message}\n`);
    process.exit(2);
  }

  const content = extractContent(toolName, toolInput);
  if (!content) process.exit(0);
  const violations = findUndeclaredImports(content, packageJson);
  if (violations.length === 0) process.exit(0);

  process.stderr.write(
    [
      `BLOCKED: source file imports packages not declared by the live project package.json:`,
      ...violations.map(({ specifier, packageName }) =>
        `- ${specifier} (missing package declaration: ${packageName})`),
      'Use only installed dependencies, or add an exact package/version to the approved JavaScript Dependencies plan before installation.',
    ].join('\n') + '\n',
  );
  process.exit(2);
});

module.exports = {
  declaredPackages,
  findUndeclaredImports,
  packageNameFromSpecifier,
};
