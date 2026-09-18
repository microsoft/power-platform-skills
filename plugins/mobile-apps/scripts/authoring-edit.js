#!/usr/bin/env node
'use strict';

const { createClient, publicError } = require('./lib/mobile-authoring-transport');
const { readJson } = require('./lib/mobile-authoring-files');
const edit = require('./lib/authoring-edit');

function parseArgs(argv) {
  const args = { command: argv[2], readyScreenIds: [] };
  const keys = {
    '--input': 'input', '--plan': 'planId', '--project-root': 'projectRoot',
    '--intent': 'intent', '--wait-ms': 'waitMs',
    '--gate-receipt': 'gateReceipt',
  };
  for (let index = 3; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--final') {
      if (args.final) throw new Error('Duplicate --final');
      args.final = true;
    }
    else if (key === '--ready-screen') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Missing ready screen ID');
      args.readyScreenIds.push(argv[++index]);
    } else if (keys[key]) {
      if (args[keys[key]] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) {
        throw new Error('Missing or duplicate edit option');
      }
      args[keys[key]] = argv[++index];
    } else throw new Error('Unsupported contextual edit option');
  }
  if (args.waitMs !== undefined) args.waitMs = Number(args.waitMs);
  return args;
}

async function run(args, options = {}) {
  const permitted = {
    inspect: ['projectRoot', 'intent'],
    prepare: ['projectRoot', 'input'],
    authorize: ['projectRoot', 'planId', 'waitMs'],
    check: ['projectRoot', 'planId'],
    teach: ['projectRoot', 'planId'],
    capture: ['projectRoot', 'planId'],
    integration: ['projectRoot', 'planId', 'gateReceipt'],
    candidate: ['projectRoot', 'planId', 'readyScreenIds', 'final'],
  }[args.command];
  if (!permitted || Object.entries(args).some(([key, value]) => key !== 'command'
    && value !== undefined && !(Array.isArray(value) && !value.length) && !permitted.includes(key))) {
    throw new Error('Unsupported options for the contextual edit command');
  }
  const client = createClient({ ...options, projectRoot: args.projectRoot });
  if (args.command === 'inspect') return edit.inspect(client, args.intent);
  if (args.command === 'prepare') {
    if (!args.input) throw new Error('prepare requires a project-relative --input proposal');
    return edit.prepare(client, readJson(client.descriptor.workspaceDir, args.input));
  }
  if (!args.planId) throw new Error('The edit command requires the sealed --plan ID');
  if (args.command === 'authorize') return edit.authorize(client, args.planId, { waitMs: args.waitMs });
  if (args.command === 'check') return edit.check(client, args.planId);
  if (args.command === 'teach') return edit.teach(client, args.planId);
  if (args.command === 'capture') return edit.capture(client, args.planId);
  if (args.command === 'integration') return edit.integration(client, args.planId, args.gateReceipt);
  if (args.command === 'candidate') return edit.submit(client, args.planId, { readyScreenIds: args.readyScreenIds, final: args.final });
  throw new Error('Expected inspect, prepare, authorize, integration, capture, check, teach, or candidate');
}

async function main(argv = process.argv) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    process.stdout.write(`${JSON.stringify(await run(parseArgs(argv), { signal: controller.signal }))}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`authoring-edit: ${publicError(error, process.env.MOBILE_AUTHORING_RUNNER_TOKEN)}\n`);
    return 2;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { parseArgs, run, main };
