#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const SCREEN_ARTIFACT_SCHEMA = require('./schema-screen-artifact.json');
const { validateScreenBuildPack } = require('./validate-screen-build-pack');
const { validateScreenSourceContract } = require('./lib/screen-source-contract');

const ARTIFACT_KEYS = SCREEN_ARTIFACT_SCHEMA.required;
const SHA256 = /^[a-f0-9]{64}$/i;
const MAX_SOURCE_BYTES = 512 * 1024;
const TEMPLATE_PACKAGE_PATH = path.resolve(__dirname, '..', 'template', 'package.json');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function ownKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
}

function exactKeys(value, expected, label, errors) {
  const actual = ownKeys(value);
  const missing = expected.filter((key) => !actual.includes(key));
  const unknown = actual.filter((key) => !expected.includes(key));
  if (missing.length) errors.push(`${label} is missing keys: ${missing.join(', ')}`);
  if (unknown.length) errors.push(`${label} has unknown keys: ${unknown.join(', ')}`);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolvePackTarget(root, relativePath, errors) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    errors.push('artifact file must be a non-empty project-relative path');
    return null;
  }
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    errors.push('artifact file must not be absolute or contain traversal');
    return null;
  }
  if (!/^app\/.+\.tsx$/.test(relativePath.replace(/\\/g, '/'))) {
    errors.push('artifact file must be a TSX screen under app/');
    return null;
  }
  if (path.basename(relativePath) === '_layout.tsx') {
    errors.push('layout files are foreground-owned and cannot be screen artifact targets');
    return null;
  }
  const target = path.resolve(root, relativePath);
  if (!isInside(root, target)) {
    errors.push('artifact file escapes the project root');
    return null;
  }
  const parentRelative = path.relative(root, path.dirname(target));
  let cursor = root;
  for (const part of parentRelative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      errors.push(`artifact target parent must not be a symlink: ${path.relative(root, cursor)}`);
      return null;
    }
  }
  if (!fs.existsSync(target)) {
    errors.push(`typed screen skeleton is missing: ${relativePath}`);
    return null;
  }
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    errors.push(`typed screen skeleton must be a regular non-symlink file: ${relativePath}`);
    return null;
  }
  return target;
}

function packageName(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function importedPackages(source) {
  const packages = new Set();
  const pattern = /(?:import[\s\S]*?from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[1];
    if (specifier.startsWith('.') || specifier.startsWith('@/')) continue;
    packages.add(packageName(specifier));
  }
  return packages;
}

function dependencyMap(packageJson) {
  return { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
}

function validateImports(source, pack, projectRoot, errors) {
  if (!fs.existsSync(TEMPLATE_PACKAGE_PATH)) {
    errors.push('bundled template package manifest is missing');
    return;
  }
  const baseline = dependencyMap(readJson(TEMPLATE_PACKAGE_PATH, 'Bundled template package manifest'));
  const projectPackagePath = path.join(projectRoot, 'package.json');
  const project = fs.existsSync(projectPackagePath) ? dependencyMap(readJson(projectPackagePath, 'Project package manifest')) : {};
  const approved = new Map((pack.execution?.javascriptDependencies || []).map((item) => [item.package, item.version]));
  for (const imported of importedPackages(source)) {
    if (Object.prototype.hasOwnProperty.call(baseline, imported)) continue;
    const version = approved.get(imported);
    if (!version) {
      errors.push(`artifact source imports unapproved package ${imported}`);
      continue;
    }
    if (project[imported] !== version) errors.push(`artifact source requires exact approved dependency ${imported}@${version}`);
  }
}

function validateServiceCalls(source, screen, errors) {
  const pattern = /\b([A-Za-z_$][\w$]*Service)\.([A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const call = `${match[1]}.${match[2]}`;
    errors.push(`artifact source calls generated service ${call}; screens must use approved @/data hooks`);
  }
}

function validateDomainHooks(source, screen, errors) {
  if (/from\s+['"]@\/data\/fixtures['"]|from\s+['"]@\/data\/repositories\//.test(source)) {
    errors.push('artifact source imports domain fixtures or repositories directly; screens must use @/data hooks');
  }
  if (/from\s+['"]@\/generated\//.test(source)) errors.push('artifact source imports generated Power Apps files; screens must use @/data hooks');
  for (const operation of screen.data?.operations || []) {
    if (!source.includes(operation.id)) errors.push(`artifact source is missing operation ID anchor ${operation.id}`);
    if (!new RegExp(`\\b${operation.hook}\\s*\\(`).test(source)) errors.push(`artifact source does not call approved domain hook ${operation.hook} for operation ${operation.id}`);
  }
}

function validateSource(source, screen, pack, projectRoot, errors) {
  if (typeof source !== 'string' || !source.trim()) {
    errors.push('artifact source must be non-empty TSX');
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) errors.push('artifact source exceeds 512 KiB');
  if (source.includes('\0')) errors.push('artifact source must not contain NUL bytes');
  if (/```/.test(source)) errors.push('artifact source must contain raw TSX only, without Markdown fences');
  if (/TODO:\s*screen-builder fills JSX here/i.test(source)) errors.push('artifact source still contains the screen-builder skeleton marker');
  if (!/(?:export\s+default\s+(?:function|class)|export\s*\{[^}]+\s+as\s+default\s*\})/s.test(source)) {
    errors.push('artifact source must retain one default screen export');
  }
  if (!/\bScreenShell\b/.test(source)) errors.push('artifact source must use the shared ScreenShell');
  const escapedMode = String(screen?.headerMode || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (escapedMode && !new RegExp(`headerMode\\s*=\\s*["']${escapedMode}["']`).test(source)) {
    errors.push(`artifact source must use literal ScreenShell headerMode ${screen.headerMode}`);
  }
  for (const issue of validateScreenSourceContract(source, screen, {
    minimumControlSize: pack.design?.recipe?.spacing?.minimumControlSize || 44,
    navigationContract: pack.navigation,
  })) {
    errors.push(`artifact source ${issue.rule}: ${issue.message}`);
  }
  validateImports(source, pack, projectRoot, errors);
  validateServiceCalls(source, screen, errors);
  validateDomainHooks(source, screen, errors);
}

function validateScreenArtifact(projectRoot, pack, artifact, expectedScreenId = null) {
  const errors = [];
  const root = fs.realpathSync(path.resolve(projectRoot));
  const packValidation = validateScreenBuildPack(root, pack);
  if (packValidation.issues.length) {
    errors.push(...packValidation.issues.map((issue) => `screen build pack: ${issue.message}`));
    return { valid: false, errors, target: null, screen: null };
  }
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return { valid: false, errors: ['artifact must be an object'], target: null, screen: null };
  }
  exactKeys(artifact, ARTIFACT_KEYS, 'artifact', errors);
  if (artifact.schemaVersion !== 1) errors.push('artifact schemaVersion must be 1');
  if (artifact.kind !== 'mobile-screen-artifact') errors.push('artifact kind must be mobile-screen-artifact');
  if (!SHA256.test(String(artifact.packRevision || '')) || artifact.packRevision !== pack.revision) {
    errors.push('artifact packRevision does not match the validated screen build pack');
  }
  if (!SHA256.test(String(artifact.inputFileSha256 || ''))) errors.push('artifact inputFileSha256 must be a SHA-256 digest');
  if (!Array.isArray(artifact.warnings) || artifact.warnings.some((warning) => typeof warning !== 'string' || !warning.trim())) {
    errors.push('artifact warnings must be an array of non-empty strings');
  } else if (new Set(artifact.warnings).size !== artifact.warnings.length) {
    errors.push('artifact warnings must be unique');
  }

  const authorizedScreenId = expectedScreenId || artifact.screenId;
  if (expectedScreenId && artifact.screenId !== expectedScreenId) {
    errors.push(`artifact screenId does not match the foreground-authorized screen: ${expectedScreenId}`);
  }
  const matches = (pack.screens || []).filter((candidate) => candidate.id === authorizedScreenId);
  if (matches.length !== 1) errors.push(`authorized screenId must match exactly one pack screen: ${authorizedScreenId || '<missing>'}`);
  const screen = matches.length === 1 ? matches[0] : null;
  if (screen && artifact.route !== screen.route) errors.push(`artifact route does not match pack screen ${screen.id}`);
  if (screen && artifact.file !== screen.file) errors.push(`artifact file does not match pack screen ${screen.id}`);

  const target = screen ? resolvePackTarget(root, screen.file, errors) : null;
  if (target && SHA256.test(String(artifact.inputFileSha256 || ''))) {
    const currentHash = sha256(fs.readFileSync(target));
    if (currentHash !== artifact.inputFileSha256) {
      errors.push(`typed screen skeleton changed after builder dispatch: ${screen.file}`);
    }
  }
  if (screen) validateSource(artifact.source, screen, pack, root, errors);
  return { valid: errors.length === 0, errors, target, screen };
}

function screenInputFingerprint(projectRoot, pack, screenId) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const packValidation = validateScreenBuildPack(root, pack);
  if (packValidation.issues.length) {
    throw new Error(`invalid screen build pack: ${packValidation.issues.map((issue) => issue.message).join('; ')}`);
  }
  const matches = (pack.screens || []).filter((candidate) => candidate.id === screenId);
  if (matches.length !== 1) throw new Error(`screenId must match exactly one pack screen: ${screenId || '<missing>'}`);
  const errors = [];
  const target = resolvePackTarget(root, matches[0].file, errors);
  if (!target || errors.length) throw new Error(errors.join('; '));
  return {
    screenId: matches[0].id,
    file: matches[0].file,
    inputFileSha256: sha256(fs.readFileSync(target)),
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--pack') args.pack = argv[++index];
    else if (argv[index] === '--artifact') args.artifact = argv[++index];
    else if (argv[index] === '--screen-id') args.screenId = argv[++index];
    else if (argv[index] === '--print-input-sha256') args.printInputSha256 = true;
    else if (argv[index] === '--json') args.json = true;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot || !args.screenId || (!args.artifact && !args.printInputSha256)) {
    process.stderr.write('Usage: node validate-screen-artifact.js --project-root <dir> [--pack <path>] --screen-id <id> (--artifact <artifact.json> [--json] | --print-input-sha256)\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const packPath = path.resolve(root, args.pack || '.tmp/screen-build-pack.json');
    const pack = readJson(packPath, 'Screen build pack');
    if (args.printInputSha256) {
      const fingerprint = screenInputFingerprint(root, pack, args.screenId);
      process.stdout.write(args.json ? `${JSON.stringify(fingerprint, null, 2)}\n` : `${fingerprint.inputFileSha256}\n`);
      return 0;
    }
    const artifactPath = path.resolve(args.artifact);
    const result = validateScreenArtifact(root, pack, readJson(artifactPath, 'Screen artifact'), args.screenId);
    if (args.json) {
      process.stdout.write(`${JSON.stringify({
        valid: result.valid,
        errors: result.errors,
        screenId: result.screen?.id || null,
        target: result.target ? path.relative(root, result.target).replace(/\\/g, '/') : null,
      }, null, 2)}\n`);
    }
    if (!result.valid) {
      if (!args.json) result.errors.forEach((error) => process.stderr.write(`- ${error}\n`));
      return 2;
    }
    if (!args.json) process.stdout.write(`Screen artifact valid for ${result.screen.id}: ${result.screen.file}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`validate-screen-artifact: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { screenInputFingerprint, sha256, validateScreenArtifact };
