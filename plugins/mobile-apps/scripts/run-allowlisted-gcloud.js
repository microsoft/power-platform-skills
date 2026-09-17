#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ALLOWLIST_PATH = path.join(
  __dirname,
  '..',
  'shared',
  'mcp',
  'gcloud-allowlist.json',
);

function loadAllowlist() {
  const parsed = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  if (
    !parsed ||
    !Array.isArray(parsed.allow) ||
    parsed.allow.some((entry) => typeof entry !== 'string' || !entry.trim())
  ) {
    throw new Error('The gcloud command allowlist is invalid.');
  }
  return parsed.allow.map((entry) => entry.split(' '));
}

function isAllowedGcloudArgs(args, allowlist = loadAllowlist()) {
  if (
    !Array.isArray(args) ||
    args.length === 0 ||
    args.some(
      (argument) =>
        typeof argument !== 'string' ||
        argument.length === 0 ||
        /[\0\r\n]/.test(argument),
    )
  ) {
    return false;
  }

  return allowlist.some(
    (prefix) =>
      args.length >= prefix.length &&
      prefix.every((token, index) => args[index] === token),
  );
}

function main(argv = process.argv.slice(2)) {
  const separator = argv.indexOf('--');
  const args = separator >= 0 ? argv.slice(separator + 1) : [];
  if (!isAllowedGcloudArgs(args)) {
    process.stderr.write(
      'BLOCKED: gcloud command is not in shared/mcp/gcloud-allowlist.json.\n',
    );
    return 2;
  }

  const result = spawnSync('gcloud', args, {
    stdio: 'inherit',
    shell: false,
    env: {
      ...process.env,
      CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
    },
  });
  if (result.error) {
    process.stderr.write(`BLOCKED: unable to run gcloud: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  isAllowedGcloudArgs,
  loadAllowlist,
  main,
};
