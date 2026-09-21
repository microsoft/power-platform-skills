#!/usr/bin/env node

'use strict';

const { spawnSync } = require('node:child_process');
const {
  assertVerificationTools,
  resolveTool,
} = require('./verify-android-apk');

const MIN_NODE_MAJOR = 20;
const STAGE_REQUIREMENTS = Object.freeze({
  'firebase-client': Object.freeze(['node', 'npm', 'npx']),
  wif: Object.freeze(['node', 'npm', 'npx', 'gcloud', 'az']),
  'flow-authoring': Object.freeze(['node', 'npm', 'npx', 'power-apps', 'pac', 'az']),
  'android-build': Object.freeze(['node', 'npm', 'npx', 'apksigner', 'aapt', 'unzip']),
  'ios-build': Object.freeze(['node', 'npm', 'npx', 'xcodebuild']),
  'android-verify': Object.freeze([
    'node', 'npm', 'npx', 'power-apps', 'pac', 'az', 'apksigner', 'aapt', 'unzip',
  ]),
  'ios-verify': Object.freeze([
    'node', 'npm', 'npx', 'power-apps', 'pac', 'az',
  ]),
});

function parseArgs(argv) {
  const result = { stage: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    if (arg !== '--stage') throw new Error(`Unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--stage requires a value.');
    result.stage = value;
    index += 1;
  }
  return result;
}

function sanitizeVersion(value) {
  const firstLine = String(value || '').split(/\r?\n/, 1)[0].trim();
  return firstLine.replace(/[^\w.+() /-]/g, '').slice(0, 120) || null;
}

function commandSpec(name) {
  switch (name) {
    case 'npm':
    case 'npx':
    case 'pac':
      return { command: name, args: ['--version'] };
    case 'gcloud':
      return { command: name, args: ['--version'] };
    case 'az':
      return { command: name, args: ['version', '--output', 'json'] };
    case 'power-apps':
      return { command: 'npx', args: ['--no-install', 'power-apps', '--version'] };
    case 'xcodebuild':
      return { command: name, args: ['-version'] };
    default:
      return null;
  }
}

function probeCommand(name, options = {}) {
  const spawn = options.spawnSync || spawnSync;
  const spec = commandSpec(name);
  const result = spawn(spec.command, spec.args, {
    encoding: 'utf8',
    env: options.env || process.env,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    return {
      name,
      status: 'missing',
      code: 'local-runtime-missing',
      version: null,
    };
  }
  return {
    name,
    status: 'ready',
    code: null,
    version: sanitizeVersion(result.stdout || result.stderr),
  };
}

function probeNode(options = {}) {
  const version = options.nodeVersion || process.version;
  const match = /^v?(\d+)(?:\.|$)/.exec(version);
  if (!match || Number(match[1]) < MIN_NODE_MAJOR) {
    return {
      name: 'node',
      status: 'unsupported',
      code: 'local-runtime-unsupported',
      version: sanitizeVersion(version),
      minimum: `${MIN_NODE_MAJOR}.0.0`,
    };
  }
  return {
    name: 'node',
    status: 'ready',
    code: null,
    version: sanitizeVersion(version),
    minimum: `${MIN_NODE_MAJOR}.0.0`,
  };
}

function probeAndroidTools(root, options = {}) {
  const env = options.env || process.env;
  const tools = new Map();
  for (const name of ['apksigner', 'aapt', 'unzip']) {
    try {
      tools.set(name, {
        name,
        path: resolveTool(name, null, { env }),
        status: 'ready',
        code: null,
        version: null,
      });
    } catch {
      tools.set(name, {
        name,
        path: null,
        status: 'missing',
        code: 'local-runtime-missing',
        version: null,
      });
    }
  }
  if ([...tools.values()].some(({ status }) => status !== 'ready')) {
    return new Map([...tools].map(([name, value]) => [
      name,
      {
        name,
        status: value.status,
        code: value.code,
        version: null,
      },
    ]));
  }
  try {
    const apksigner = tools.get('apksigner').path;
    const aapt = tools.get('aapt').path;
    const unzip = tools.get('unzip').path;
    assertVerificationTools(root, apksigner, aapt, unzip);
    return new Map([
      ['apksigner', { name: 'apksigner', status: 'ready', code: null, version: null }],
      ['aapt', { name: 'aapt', status: 'ready', code: null, version: null }],
      ['unzip', { name: 'unzip', status: 'ready', code: null, version: null }],
    ]);
  } catch {
    return new Map(['apksigner', 'aapt', 'unzip'].map((name) => [
      name,
      {
        name,
        status: 'unsupported',
        code: 'local-runtime-unsupported',
        version: null,
      },
    ]));
  }
}

function checkStage(stage, options = {}) {
  const required = STAGE_REQUIREMENTS[stage];
  if (!required) {
    throw new Error(`Unsupported stage '${stage}'.`);
  }

  const android = required.some((name) => ['apksigner', 'aapt', 'unzip'].includes(name))
    ? probeAndroidTools(options.projectRoot || process.cwd(), options)
    : new Map();
  const checks = required.map((name) => {
    if (name === 'node') return probeNode(options);
    if (android.has(name)) return android.get(name);
    if (name === 'xcodebuild' && (options.platform || process.platform) !== 'darwin') {
      return {
        name,
        status: 'unsupported',
        code: 'local-runtime-unsupported',
        version: null,
      };
    }
    return probeCommand(name, options);
  });
  const ready = checks.every(({ status }) => status === 'ready');
  return {
    schemaVersion: 1,
    stage,
    status: ready ? 'ready' : 'blocked',
    checks,
    issues: checks
      .filter(({ status }) => status !== 'ready')
      .map(({ name, code, status }) => ({ name, code, status })),
  };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(
        `Usage: node scripts/check-push-prerequisites.js --stage <${Object.keys(STAGE_REQUIREMENTS).join('|')}>\n`,
      );
      return 0;
    }
    if (!args.stage) throw new Error('--stage is required.');
    const result = checkStage(args.stage);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === 'ready' ? 0 : 2;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  MIN_NODE_MAJOR,
  STAGE_REQUIREMENTS,
  checkStage,
  commandSpec,
  parseArgs,
  probeCommand,
  probeNode,
  sanitizeVersion,
};
