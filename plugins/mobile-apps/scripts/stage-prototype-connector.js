#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { readJson } = require('./lib/prototype-files');
const { stagePrototypeConnectorStartup, verifyPrototypeConnectorStartup, activatePrototypeConnectorData } = require('./lib/prototype-connector-startup');

function main(argv = process.argv.slice(2)) {
  try {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
      const flag = argv[index];
      if (Object.hasOwn(args, flag)) throw new Error(`Duplicate argument: ${flag}`);
      if (['--check', '--verify', '--activate', '--confirm-standalone-apply'].includes(flag)) args[flag] = true;
      else if (['--project-root', '--catalog', '--selection', '--preview', '--connector-name', '--local-ref-id', '--expected-source-revision'].includes(flag) && argv[index + 1]) args[flag] = argv[++index];
      else throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
    if (!args['--project-root']) throw new Error('--project-root is required');
    const root = path.resolve(args['--project-root']);
    let result;
    if (args['--verify']) {
      if (Object.keys(args).some((key) => !['--project-root', '--verify'].includes(key))) throw new Error('--verify takes only --project-root');
      result = verifyPrototypeConnectorStartup(root);
    } else if (args['--activate']) {
      if (Object.keys(args).some((key) => !['--project-root', '--activate', '--confirm-standalone-apply', '--expected-source-revision'].includes(key))) {
        throw new Error('--activate takes only the explicit standalone Apply confirmation and reviewed revision');
      }
      result = activatePrototypeConnectorData(root, {
        confirmStandaloneApply: args['--confirm-standalone-apply'] === true,
        expectedSourceRevision: args['--expected-source-revision'],
      });
    } else {
      if (args['--confirm-standalone-apply'] || args['--expected-source-revision']) throw new Error('Apply arguments require --activate');
      for (const flag of ['--catalog', '--selection', '--preview', '--connector-name']) if (!args[flag]) throw new Error(`${flag} is required`);
      result = stagePrototypeConnectorStartup(root, {
        catalog: readJson(root, args['--catalog']), selection: readJson(root, args['--selection']),
        preview: readJson(root, args['--preview']), connectorName: args['--connector-name'],
        ...(args['--local-ref-id'] ? { localRefId: args['--local-ref-id'] } : {}), check: args['--check'] === true,
      });
    }
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(`stage-prototype-connector: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { main };
