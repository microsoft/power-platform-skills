#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REQUIRED_RUBY = Object.freeze([3, 3, 0]);
const REQUIRED_BUNDLER = '4.0.19';
const REQUIRED_FASTLANE = '2.238.0';

function parseVersion(value, label) {
  const match = String(value).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`Unable to parse ${label} version.`);
  return match.slice(1).map(Number);
}

function atLeast(actual, required) {
  for (let index = 0; index < required.length; index += 1) {
    if (actual[index] > required[index]) return true;
    if (actual[index] < required[index]) return false;
  }
  return true;
}

function inspectText(gemfile, lockfile) {
  const fastlane = gemfile.match(/gem\s+["']fastlane["'],\s*["']=\s*([^"']+)["']/)?.[1];
  const bundler = lockfile.match(/BUNDLED WITH\s+([0-9.]+)/m)?.[1];
  return { fastlane, bundler };
}

function commandVersion(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout || ''}\n${result.stderr || ''}`.trim(),
  };
}

function check({ projectRoot, platform = process.platform, rubyOutput, bundlerOutput }) {
  const root = path.resolve(projectRoot);
  const gemfile = fs.readFileSync(path.join(root, 'Gemfile'), 'utf8');
  const lockfile = fs.readFileSync(path.join(root, 'Gemfile.lock'), 'utf8');
  const pins = inspectText(gemfile, lockfile);
  const ruby = rubyOutput === undefined ? commandVersion('ruby', ['--version']) : {
    ok: true,
    output: rubyOutput,
  };
  const bundler = bundlerOutput === undefined
    ? commandVersion('bundle', ['--version'])
    : { ok: true, output: bundlerOutput };
  const issues = [];

  if (platform !== 'darwin') issues.push('macos-required');
  if (!ruby.ok) {
    issues.push('ruby-missing');
  } else if (!atLeast(parseVersion(ruby.output, 'Ruby'), REQUIRED_RUBY)) {
    issues.push('ruby-too-old');
  }
  if (!bundler.ok) {
    issues.push('bundler-missing');
  } else if (parseVersion(bundler.output, 'Bundler').join('.') !== REQUIRED_BUNDLER) {
    issues.push('bundler-version-mismatch');
  }
  if (pins.fastlane !== REQUIRED_FASTLANE) issues.push('fastlane-pin-mismatch');
  if (pins.bundler !== REQUIRED_BUNDLER) issues.push('lockfile-bundler-mismatch');

  return {
    status: issues.length === 0 ? 'ready' : 'blocked',
    requirements: {
      platform: 'darwin',
      rubyMinimum: REQUIRED_RUBY.join('.'),
      bundler: REQUIRED_BUNDLER,
      fastlane: REQUIRED_FASTLANE,
    },
    detected: {
      platform,
      ruby: ruby.ok ? parseVersion(ruby.output, 'Ruby').join('.') : null,
      bundler: bundler.ok ? parseVersion(bundler.output, 'Bundler').join('.') : null,
      fastlanePin: pins.fastlane || null,
      lockfileBundler: pins.bundler || null,
    },
    issues,
  };
}

function parseArgs(argv) {
  let projectRoot = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root' && argv[index + 1]) {
      projectRoot = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
    }
  }
  return { projectRoot };
}

function main(argv = process.argv.slice(2)) {
  try {
    const result = check(parseArgs(argv));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === 'ready' ? 0 : 2;
  } catch {
    process.stdout.write('{"status":"error","issues":["unable-to-check-prerequisites"]}\n');
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  REQUIRED_BUNDLER,
  REQUIRED_FASTLANE,
  REQUIRED_RUBY,
  atLeast,
  check,
  inspectText,
  main,
  parseVersion,
};
