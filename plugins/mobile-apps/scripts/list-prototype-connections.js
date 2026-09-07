#!/usr/bin/env node
'use strict';

const { readConnectionCatalog } = require('./lib/prototype-connections');

async function main(argv = process.argv.slice(2)) {
  try {
    const options = {};
    const seen = new Set();
    for (let index = 0; index < argv.length; index += 1) {
      const flag = argv[index];
      if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
      seen.add(flag);
      if (flag === '--references') options.references = true;
      else if (['--environment-id', '--api-id', '--tenant-id'].includes(flag) && argv[index + 1]) {
        const key = { '--environment-id': 'environmentId', '--api-id': 'apiId', '--tenant-id': 'tenantId' }[flag];
        options[key] = argv[++index];
      } else throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
    console.log(JSON.stringify(await readConnectionCatalog(options), null, 2));
    return 0;
  } catch (error) {
    console.error(`list-prototype-connections: ${error.message}`);
    return 1;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });
module.exports = { main };
