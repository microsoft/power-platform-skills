#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { readJson } = require('./lib/mobile-authoring-files');
const { playerDataverse } = require('./lib/player-dataverse');

async function main(argv = process.argv.slice(2), options = {}) {
  try {
    if (argv[0] !== 'init') throw new Error('Expected init --project-root <candidate-root>');
    let root = process.cwd();
    for (let index = 1; index < argv.length; index += 1) {
      if (argv[index] !== '--project-root' || !argv[index + 1]) throw new Error('Expected init --project-root <candidate-root>');
      root = path.resolve(argv[++index]);
    }
    const broker = playerDataverse({ ...options, projectRoot: root });
    if (!broker) throw new Error('This helper requires a validated Player descriptor. Standalone skills use their existing official init flow.');
    const manifest = readJson(root, '.tmp/dataverse-operation-manifest.json');
    const result = await broker.initialize(manifest);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const token = process.env.MOBILE_AUTHORING_RUNNER_TOKEN;
    process.stderr.write(`player-dataverse: ${token ? String(error.message).split(token).join('[redacted]') : error.message}\n`);
    return 1;
  }
}

if (require.main === module) main().then((status) => { process.exitCode = status; });
module.exports = { main };
