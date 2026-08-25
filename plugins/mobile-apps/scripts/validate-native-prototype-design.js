#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  MANIFEST_PATH,
  RECIPE_PATH,
  REGISTRY_PATH,
  TOKENS_PATH,
  compileArtifacts,
  readInputs,
  sha256,
  stableHash,
  stableStringify,
  validateRecipe,
} = require('./compile-native-prototype-design');

const REPORT_PATH = '.tmp/prototype-design-validation.json';

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function pointerValue(value, pointer) {
  if (pointer === '') return value;
  return pointer.slice(1).split('/').reduce((current, segment) => {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    return current === undefined || current === null ? undefined : current[key];
  }, value);
}

function issue(pathValue, rule, message) {
  return { path: pathValue, rule, message };
}

function compilationIssue(rule, error) {
  const message = String(error?.message || error);
  const match = message.match(/(?:^|:\s)(\/[A-Za-z0-9~_/-]+)(?=:)/);
  return issue(match?.[1] || '/', rule, message);
}

function validateBindings(recipe, inputs) {
  const issues = [];
  const groups = [
    ['designIntentPaths', inputs.semanticPlan],
    ['screenPaths', inputs.screenContract],
    ['navigationPaths', inputs.navigationContract],
    ['domainPaths', inputs.domainModel],
    ['foundationPaths', inputs.foundationContract],
  ];
  for (const [group, source] of groups) {
    for (const [sourcePath, targetPath] of Object.entries(recipe.sourceBindings?.[group] || {})) {
      const sourceValue = pointerValue(source, sourcePath);
      const targetValue = pointerValue(recipe, targetPath);
      if (sourceValue === undefined) issues.push(issue(sourcePath, 'missing-bound-source', `Bound source path from ${group} does not exist.`));
      else if (targetValue === undefined) issues.push(issue(targetPath, 'missing-bound-target', `Bound recipe path from ${group} does not exist.`));
      else if (stableStringify(sourceValue) !== stableStringify(targetValue)) issues.push(issue(targetPath, 'design-intent-drift', `Value no longer preserves ${sourcePath}.`));
    }
  }
  return issues;
}

function validateManifest(root, manifest, expectedFiles, sourceBindings) {
  const issues = [];
  if (manifest?.schemaVersion !== 1 || manifest?.kind !== 'native-prototype-design-manifest') {
    return [issue(`/${MANIFEST_PATH}`, 'invalid-design-manifest', 'Prototype design manifest has an invalid identity.')];
  }
  if (stableStringify(manifest.sourceBindings) !== stableStringify(sourceBindings)) issues.push(issue('/sourceBindings', 'manifest-source-drift', 'Design manifest source bindings are stale.'));
  const expectedPaths = Object.keys(expectedFiles).sort();
  const actualPaths = (manifest.outputs || []).map((entry) => entry.path).sort();
  if (stableStringify(actualPaths) !== stableStringify(expectedPaths)) issues.push(issue('/outputs', 'manifest-output-drift', 'Design manifest output set does not match the deterministic compiler.'));
  for (const entry of manifest.outputs || []) {
    const filePath = path.join(root, entry.path);
    if (!fs.existsSync(filePath)) {
      issues.push(issue(`/outputs/${entry.path}`, 'missing-design-output', `Generated design output is missing: ${entry.path}.`));
      continue;
    }
    if (sha256(fs.readFileSync(filePath)) !== entry.sha256) issues.push(issue(`/outputs/${entry.path}/sha256`, 'design-output-drift', `Generated design output was modified: ${entry.path}.`));
  }
  return issues;
}

function validateBuildPack(root, pack, recipe, registry, manifest) {
  const issues = [];
  if (!pack) return issues;
  if (stableStringify(pack.design?.recipe) !== stableStringify(recipe)) issues.push(issue('/design/recipe', 'build-pack-recipe-drift', 'Screen build pack does not embed the validated design recipe.'));
  if (pack.design?.tokensPath !== TOKENS_PATH) issues.push(issue('/design/tokensPath', 'build-pack-token-reference', `Screen build pack must reference ${TOKENS_PATH}.`));
  if (pack.design?.registryPath !== REGISTRY_PATH) issues.push(issue('/design/registryPath', 'build-pack-registry-reference', `Screen build pack must reference ${REGISTRY_PATH}.`));
  if (pack.design?.manifestPath !== MANIFEST_PATH) issues.push(issue('/design/manifestPath', 'build-pack-manifest-reference', `Screen build pack must reference ${MANIFEST_PATH}.`));
  if (stableStringify(pack.design?.signatureComponents) !== stableStringify(registry.components)) issues.push(issue('/design/signatureComponents', 'build-pack-signature-drift', 'Screen build pack does not embed the validated signature registry.'));
  if (stableStringify(pack.design?.primitives) !== stableStringify(recipe.foundationPrimitives)) issues.push(issue('/design/primitives', 'build-pack-foundation-drift', 'Screen build pack does not embed the validated foundation registry.'));
  if (pack.sources?.designManifest !== sha256(fs.readFileSync(path.join(root, MANIFEST_PATH)))) issues.push(issue('/sources/designManifest', 'build-pack-manifest-hash', 'Screen build pack design-manifest hash is stale.'));
  if (pack.sources?.signatureRegistry !== sha256(fs.readFileSync(path.join(root, REGISTRY_PATH)))) issues.push(issue('/sources/signatureRegistry', 'build-pack-registry-hash', 'Screen build pack signature-registry hash is stale.'));
  if (stableStringify(manifest.sourceBindings) !== stableStringify(recipe.sourceBindings)) issues.push(issue('/design/manifestPath', 'build-pack-source-binding-drift', 'Screen build pack points to a manifest with stale source bindings.'));
  return issues;
}

function validateNativePrototypeDesign(projectRoot, options = {}) {
  let loaded;
  try {
    loaded = readInputs(projectRoot);
  } catch (error) {
    return { valid: false, errors: [compilationIssue('invalid-design-inputs', error)] };
  }
  const { root, inputs } = loaded;
  let expected;
  try {
    expected = compileArtifacts(inputs);
  } catch (error) {
    return { valid: false, errors: [compilationIssue('design-compilation-failed', error)] };
  }
  const errors = [];
  const recipePath = path.join(root, RECIPE_PATH);
  const registryPath = path.join(root, REGISTRY_PATH);
  const manifestPath = path.join(root, MANIFEST_PATH);
  if (!fs.existsSync(recipePath)) errors.push(issue(`/${RECIPE_PATH}`, 'missing-design-recipe', 'Compiled design recipe is missing.'));
  if (!fs.existsSync(registryPath)) errors.push(issue(`/${REGISTRY_PATH}`, 'missing-signature-registry', 'Compiled signature registry is missing.'));
  if (!fs.existsSync(manifestPath)) errors.push(issue(`/${MANIFEST_PATH}`, 'missing-design-manifest', 'Compiled design manifest is missing.'));
  if (errors.length) return { valid: false, errors };

  let recipe;
  let registry;
  let manifest;
  try {
    recipe = readJson(recipePath, 'Design recipe');
    registry = readJson(registryPath, 'Signature registry');
    manifest = readJson(manifestPath, 'Prototype design manifest');
  } catch (error) {
    return { valid: false, errors: [issue('/', 'invalid-design-artifact', error.message)] };
  }
  errors.push(...validateRecipe(recipe, inputs).map((message) => {
    const separator = message.indexOf(':');
    return issue(separator >= 0 ? message.slice(0, separator) : '/', 'invalid-design-recipe', separator >= 0 ? message.slice(separator + 1).trim() : message);
  }));
  errors.push(...validateBindings(recipe, inputs));
  errors.push(...validateManifest(root, manifest, expected.files, recipe.sourceBindings));
  for (const [relativePath, expectedContent] of Object.entries(expected.files)) {
    const filePath = path.join(root, relativePath);
    if (!fs.existsSync(filePath)) continue;
    const actualContent = fs.readFileSync(filePath, 'utf8');
    if (actualContent !== expectedContent) errors.push(issue(`/${relativePath}`, 'non-deterministic-design-output', 'Artifact differs from the deterministic compilation of its validated inputs.'));
  }
  if (stableStringify(registry) !== stableStringify(expected.registry)) errors.push(issue(`/${REGISTRY_PATH}`, 'signature-registry-drift', 'Signature registry differs from the validated recipe.'));

  const packPath = path.join(root, '.tmp', 'screen-build-pack.json');
  if (options.requireBuildPack && !fs.existsSync(packPath)) errors.push(issue('/.tmp/screen-build-pack.json', 'missing-screen-build-pack', 'Post-pack validation requires the screen build pack.'));
  if (options.checkBuildPack !== false && fs.existsSync(packPath)) {
    try {
      errors.push(...validateBuildPack(root, readJson(packPath, 'Screen build pack'), recipe, registry, manifest));
    } catch (error) {
      errors.push(issue('/.tmp/screen-build-pack.json', 'invalid-screen-build-pack', error.message));
    }
  }
  const artifactHashes = Object.fromEntries((manifest.outputs || []).map((entry) => [entry.path, entry.sha256]));
  return {
    valid: errors.length === 0,
    errors,
    sourceBindings: recipe.sourceBindings,
    artifactHashes,
    recipeSha256: stableHash(recipe),
    registrySha256: stableHash(registry),
  };
}

function writeReport(projectRoot, report) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const target = path.join(root, REPORT_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const output = {
    schemaVersion: 1,
    kind: 'native-prototype-design-validation',
    ...report,
  };
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return output;
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--require-build-pack') args.requireBuildPack = true;
    else if (argv[index] === '--json') args.json = true;
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-native-prototype-design.js --project-root <dir> [--require-build-pack] [--json]\n');
    return 2;
  }
  const report = validateNativePrototypeDesign(args.projectRoot, { requireBuildPack: args.requireBuildPack });
  writeReport(args.projectRoot, report);
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.valid) {
    if (!args.json) report.errors.forEach((entry) => process.stderr.write(`- ${entry.path} [${entry.rule}] ${entry.message}\n`));
    return 2;
  }
  if (!args.json) process.stdout.write('Native prototype design passed.\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { REPORT_PATH, pointerValue, validateBindings, validateBuildPack, validateNativePrototypeDesign, writeReport };