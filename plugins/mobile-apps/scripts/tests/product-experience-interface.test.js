'use strict';

// Pins the planner integration interface: the four artifact paths, the four CLI names, and the
// promise that each CLI resolves those paths from `--project-root` alone while still accepting
// an explicit override for every input and output.
//
// This file exists so the interface cannot drift silently. A rename here is a deliberate,
// visible change rather than something a caller discovers at runtime.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { CONTRACT_ARTIFACTS, CONTRACT_TOOLS } = require('../lib/product-experience-contracts');
const { SCRIPTS_DIR, cleanup, makeProjectDir, runCli, writeContracts } = require('./helpers/contract-cli');
const { bundleFor } = require('./helpers/product-experience-scenarios');

test('the four planner-authored artifacts keep their standard names', () => {
  assert.deepStrictEqual(CONTRACT_ARTIFACTS, {
    'product-experience': '.tmp/product-experience-contract.json',
    'product-scope': '.tmp/product-scope-contract.json',
    'workflow-journey': '.tmp/workflow-journey-contract.json',
    'screen-build-pack': '.tmp/screen-build-pack.json',
    'compiled-screen-build-pack': '.tmp/compiled-screen-build-pack.json',
  });
});

test('the four CLIs keep their standard names and exist on disk', () => {
  assert.deepStrictEqual(CONTRACT_TOOLS, {
    'product-experience': 'validate-product-experience.js',
    'product-scope': 'validate-product-scope.js',
    'workflow-journey': 'validate-workflow-journey.js',
    'screen-build-pack': 'compile-screen-build-pack.js',
  });
  for (const fileName of Object.values(CONTRACT_TOOLS)) {
    assert.ok(fs.existsSync(path.join(SCRIPTS_DIR, fileName)), `${fileName} is missing`);
  }
});

test('every CLI resolves the standard artifacts from --project-root alone', () => {
  const projectRoot = makeProjectDir('interface-defaults');
  try {
    const bundle = bundleFor('commerce');
    writeContracts(projectRoot, bundle);
    const at = (key) => path.join(projectRoot, CONTRACT_ARTIFACTS[key]);

    const experience = runCli(CONTRACT_TOOLS['product-experience'], ['--project-root', projectRoot]);
    assert.strictEqual(experience.code, 0);
    assert.strictEqual(experience.json.contractPath, at('product-experience'));

    const scope = runCli(CONTRACT_TOOLS['product-scope'], ['--project-root', projectRoot]);
    assert.strictEqual(scope.code, 0);
    assert.strictEqual(scope.json.contractPath, at('product-scope'));
    assert.strictEqual(scope.json.experiencePath, at('product-experience'));

    const journey = runCli(CONTRACT_TOOLS['workflow-journey'], ['--project-root', projectRoot]);
    assert.strictEqual(journey.code, 0);
    assert.strictEqual(journey.json.contractPath, at('workflow-journey'));

    const compiled = runCli(CONTRACT_TOOLS['screen-build-pack'], ['--project-root', projectRoot]);
    assert.strictEqual(compiled.code, 0);
    assert.strictEqual(compiled.json.contractPath, at('screen-build-pack'));
    assert.strictEqual(compiled.json.outputPath, at('compiled-screen-build-pack'));
    assert.ok(fs.existsSync(at('compiled-screen-build-pack')));
  } finally {
    cleanup(projectRoot);
  }
});

test('every input and output path can be overridden explicitly', () => {
  const projectRoot = makeProjectDir('interface-overrides');
  try {
    const bundle = bundleFor('logistics');
    // Deliberately non-standard locations: a caller that keeps contracts elsewhere must not be
    // forced into the .tmp convention.
    const custom = path.join(projectRoot, 'planning');
    fs.mkdirSync(custom, { recursive: true });
    const at = (name) => path.join(custom, name);
    fs.writeFileSync(at('exp.json'), JSON.stringify(bundle.experience));
    fs.writeFileSync(at('scope.json'), JSON.stringify(bundle.scope));
    fs.writeFileSync(at('journey.json'), JSON.stringify(bundle.journey));
    fs.writeFileSync(at('packs.json'), JSON.stringify(bundle.buildPack));

    assert.strictEqual(runCli(CONTRACT_TOOLS['product-experience'], ['--contract', at('exp.json')]).code, 0);

    const scope = runCli(CONTRACT_TOOLS['product-scope'], [
      '--scope', at('scope.json'), '--experience', at('exp.json'),
    ]);
    assert.strictEqual(scope.code, 0);
    assert.strictEqual(scope.json.experiencePath, at('exp.json'));

    const journey = runCli(CONTRACT_TOOLS['workflow-journey'], [
      '--journey', at('journey.json'), '--scope', at('scope.json'), '--experience', at('exp.json'),
    ]);
    assert.strictEqual(journey.code, 0);

    const output = path.join(custom, 'compiled.json');
    const compiled = runCli(CONTRACT_TOOLS['screen-build-pack'], [
      '--build-pack', at('packs.json'),
      '--journey', at('journey.json'),
      '--scope', at('scope.json'),
      '--experience', at('exp.json'),
      '--output', output,
    ]);
    assert.strictEqual(compiled.code, 0);
    assert.strictEqual(compiled.json.outputPath, output);
    assert.ok(fs.existsSync(output));
  } finally {
    cleanup(projectRoot);
  }
});

test('no CLI hard-codes an artifact path outside the shared table', () => {
  // One authoritative table means a rename cannot leave a stale literal behind in one tool.
  for (const fileName of Object.values(CONTRACT_TOOLS)) {
    const source = fs.readFileSync(path.join(SCRIPTS_DIR, fileName), 'utf8');
    const literals = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .filter((line) => /'\.tmp\//.test(line));
    assert.deepStrictEqual(literals, [], `${fileName} hard-codes an artifact path`);
  }
});

test('every CLI reports its usage and exits 0 for --help', () => {
  for (const fileName of Object.values(CONTRACT_TOOLS)) {
    const result = runCli(fileName, ['--help']);
    assert.strictEqual(result.code, 0, `${fileName} --help did not exit 0`);
    assert.ok(result.stdout.startsWith(`Usage: node ${fileName}`), `${fileName} --help did not print its usage`);
  }
});
