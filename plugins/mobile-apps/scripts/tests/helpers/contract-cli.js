'use strict';

// Shared harness for exercising the contract CLIs as real child processes, so the tests cover
// the documented exit-code contract (0 valid, 1 rejected, 2 usage/fatal) and not just the
// exported functions.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { CONTRACT_ARTIFACTS } = require('../../lib/product-experience-contracts');

const SCRIPTS_DIR = path.join(__dirname, '..', '..');

function runCli(scriptName, args, options = {}) {
  const script = path.join(SCRIPTS_DIR, scriptName);
  // `--help` prints plain usage text rather than a JSON document, so parsing is best-effort on
  // both the success and failure paths.
  const parse = (stdout) => {
    try {
      return JSON.parse(stdout.trim());
    } catch {
      return null;
    }
  };
  try {
    const stdout = execFileSync('node', [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...(options.env || {}) },
    });
    return { code: 0, json: parse(stdout), stdout };
  } catch (error) {
    const stdout = error.stdout ? error.stdout.toString() : '';
    return {
      code: error.status,
      json: parse(stdout),
      stdout,
      stderr: error.stderr ? error.stderr.toString() : '',
    };
  }
}

/**
 * Creates a scratch project directory. Kept under the tests folder rather than the OS temp
 * directory so a failed run leaves its fixtures next to the test that produced them.
 */
function makeProjectDir(label) {
  const base = path.join(__dirname, '..', '.scratch');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, `${label}-`));
}

function writeContracts(projectRoot, bundle) {
  // Written to the same default locations the CLIs read from, so a test that omits every path
  // flag is exercising the real planner integration surface.
  const files = {
    experience: path.join(projectRoot, CONTRACT_ARTIFACTS['product-experience']),
    scope: path.join(projectRoot, CONTRACT_ARTIFACTS['product-scope']),
    journey: path.join(projectRoot, CONTRACT_ARTIFACTS['workflow-journey']),
    buildPack: path.join(projectRoot, CONTRACT_ARTIFACTS['screen-build-pack']),
  };
  fs.mkdirSync(path.dirname(files.experience), { recursive: true });
  if (bundle.experience) fs.writeFileSync(files.experience, JSON.stringify(bundle.experience, null, 2));
  if (bundle.scope) fs.writeFileSync(files.scope, JSON.stringify(bundle.scope, null, 2));
  if (bundle.journey) fs.writeFileSync(files.journey, JSON.stringify(bundle.journey, null, 2));
  if (bundle.buildPack) fs.writeFileSync(files.buildPack, JSON.stringify(bundle.buildPack, null, 2));
  return files;
}

function cleanup(projectRoot) {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

function codes(result) {
  return (result.errors || []).map((entry) => entry.code);
}

module.exports = { SCRIPTS_DIR, cleanup, codes, makeProjectDir, runCli, writeContracts };
