#!/usr/bin/env node
'use strict';

const path = require('node:path');

const {
  deriveBuildPlanModel,
  updateProgress,
  writeBuildPlan,
} = require('./lib/mobile-build-plan');
const { startBuildPlanServer } = require('./lib/mobile-build-plan-server');

const COMMANDS = new Set(['render', 'progress', 'model', 'serve']);

function usage() {
  return [
    'Usage:',
    '  node mobile-build-plan.js render --project-root <dir> [--output <html>]',
    '  node mobile-build-plan.js progress --project-root <dir> --phase <id> --status <status> [--detail <text>] [--overall-status <status>]',
    '  node mobile-build-plan.js model --project-root <dir>',
    '  node mobile-build-plan.js serve --project-root <dir> [--port <number>]',
  ].join('\n');
}

function parseArgs(argv) {
  const command = argv[0];
  if (!COMMANDS.has(command)) throw new Error(`Unknown Build Plan command: ${command || '(missing)'}`);
  const args = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') args.help = true;
    else if (token === '--project-root') args.projectRoot = argv[++index];
    else if (token === '--output') args.output = argv[++index];
    else if (token === '--phase') args.phase = argv[++index];
    else if (token === '--status') args.status = argv[++index];
    else if (token === '--detail') args.detail = argv[++index];
    else if (token === '--overall-status') args.overallStatus = argv[++index];
    else if (token === '--port') args.port = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!args.projectRoot) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const projectRoot = path.resolve(args.projectRoot);
  try {
    if (args.command === 'render') {
      const result = writeBuildPlan(projectRoot, { output: args.output });
      process.stdout.write(`${JSON.stringify({
        ok: true,
        output: result.output,
        revision: result.model.revision,
      }, null, 2)}\n`);
    } else if (args.command === 'progress') {
      if (!args.phase || !args.status) throw new Error('--phase and --status are required');
      const progress = updateProgress(projectRoot, {
        phase: args.phase,
        status: args.status,
        detail: args.detail,
        overallStatus: args.overallStatus,
      });
      const result = writeBuildPlan(projectRoot);
      process.stdout.write(`${JSON.stringify({
        ok: true,
        progressRevision: progress.revision,
        modelRevision: result.model.revision,
      }, null, 2)}\n`);
    } else if (args.command === 'model') {
      process.stdout.write(`${JSON.stringify(deriveBuildPlanModel(projectRoot), null, 2)}\n`);
    } else {
      const instance = await startBuildPlanServer({
        projectRoot,
        port: args.port === undefined ? 0 : Number(args.port),
      });
      process.stdout.write(`${JSON.stringify({
        ok: true,
        pid: process.pid,
        launchUrl: instance.launchUrl,
        snapshot: path.join(projectRoot, '_build_plan.html'),
      }, null, 2)}\n`);
      const stop = async () => {
        try {
          await instance.close();
          process.exitCode = 0;
        } catch (error) {
          process.stderr.write(`mobile-build-plan: ${error.message}\n`);
          process.exitCode = 1;
        }
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`mobile-build-plan: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}

module.exports = { COMMANDS, main, parseArgs, usage };