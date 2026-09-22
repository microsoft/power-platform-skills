#!/usr/bin/env node

const path = require('path');
const { parseArgs } = require('./lib/render-template');
const {
  DEFAULT_MAX_BYTES,
  prepareDeclarativeAsset,
} = require('./lib/declarative-asset-preparation');

async function main() {
  const args = parseArgs(process.argv);
  if (!args.projectRoot || (!args.sourcePath && !args.downloadUrl)) {
    console.error(
      'Usage: node prepare-declarative-asset.js --projectRoot <path> ' +
        '(--sourcePath <file> | --downloadUrl <url> --sourcePage <url> --fileName <name>)'
    );
    process.exit(1);
  }
  try {
    const result = await prepareDeclarativeAsset({
      projectRoot: path.resolve(args.projectRoot),
      sourcePath: args.sourcePath ? path.resolve(args.sourcePath) : undefined,
      downloadUrl: args.downloadUrl,
      sourcePage: args.sourcePage,
      fileName: args.fileName,
      expectedSha256: args.expectedSha256,
      maxBytes: args.maxBytes ? Number(args.maxBytes) : DEFAULT_MAX_BYTES,
    });
    console.log(JSON.stringify({ status: 'ok', ...result }));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { main };
