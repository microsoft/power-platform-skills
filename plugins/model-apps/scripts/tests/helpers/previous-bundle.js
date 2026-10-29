'use strict';
// The PREVIOUS release's vendored SDK bundle, for the tests that prove a workspace it wrote is read by this release's
// (workspace-upgrade-*-real-bundle.test.js, and the business-rule and flow upgrade cases).
//
// Where it comes from, in order: the file MODEL_APPS_PREVIOUS_BUNDLE names (CI fetches the release commit by hash and
// extracts the bundle there: .github/workflows/model-apps-script-tests.yml), else the release commit in this checkout's
// git history. Either way its SHA-256 must be the release's, so a wrong file or commit fails loudly instead of proving the
// upgrade from something else. Where neither is there, the tests skip — except in CI (GITHUB_ACTIONS), where a missing
// baseline is a failure: the proof must run there.
//
// On the next re-vendor, point PREVIOUS_RELEASE and PREVIOUS_BUNDLE_SHA256 at the release being replaced (and the workflow's
// fetch at the same commit: tests/run-tests.test.js holds them equal).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { makeTempDir } = require('./temp-dirs.js');

const PREVIOUS_RELEASE = 'c159268b994b218729ff69ccdd74be3c83c56f86'; // model-apps 2.20.4 (2.20.5 ships the same bundle)
const PREVIOUS_BUNDLE_SHA256 = 'eebd70a2a7f6e12e45d18744640fd803479a738bc936b8e0dce1a9f97a0a4f8c';
const BUNDLE_PATH = 'plugins/model-apps/scripts/vendor/cds-maker-sdk.cjs';
const IN_CI = Boolean(process.env.GITHUB_ACTIONS);

function bytesOfPrevious() {
  const named = process.env.MODEL_APPS_PREVIOUS_BUNDLE;
  if (named) return { bytes: fs.readFileSync(named), from: named };
  try {
    // `cat-file blob` gives the committed bytes as they are: no checkout filter (line ends) is applied.
    const bytes = execFileSync('git', ['cat-file', 'blob', `${PREVIOUS_RELEASE}:${BUNDLE_PATH}`], { cwd: __dirname, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return { bytes, from: `git ${PREVIOUS_RELEASE}` };
  } catch {
    return null;
  }
}

let loaded;
// The previous bundle as a module of its own, or null where it is not available.
function previousBundle() {
  if (loaded !== undefined) return loaded;
  const found = bytesOfPrevious();
  if (!found) return (loaded = null);
  const sha = crypto.createHash('sha256').update(found.bytes).digest('hex');
  if (sha !== PREVIOUS_BUNDLE_SHA256) throw new Error(`the previous release's SDK bundle from ${found.from} has SHA-256 ${sha}, not the release's ${PREVIOUS_BUNDLE_SHA256}`);
  const file = path.join(makeTempDir('previous-bundle-'), 'cds-maker-sdk.cjs');
  fs.writeFileSync(file, found.bytes);
  return (loaded = require(file));
}

// The `skip` option of a test that needs the previous bundle: false where it is available, and in CI (where its absence then
// fails the test, through requirePrevious); the reason elsewhere.
function skipWithoutPrevious() {
  if (previousBundle() || IN_CI) return false;
  return `the previous release's SDK bundle is not available (no git history for ${PREVIOUS_RELEASE}; set MODEL_APPS_PREVIOUS_BUNDLE)`;
}

// The previous bundle, or a failure that says what CI must provide.
function requirePrevious() {
  const bundle = previousBundle();
  if (!bundle) throw new Error(`the previous release's SDK bundle is required here: fetch ${PREVIOUS_RELEASE} and set MODEL_APPS_PREVIOUS_BUNDLE to its ${BUNDLE_PATH}`);
  return bundle;
}

module.exports = { PREVIOUS_RELEASE, PREVIOUS_BUNDLE_SHA256, BUNDLE_PATH, previousBundle, skipWithoutPrevious, requirePrevious };
