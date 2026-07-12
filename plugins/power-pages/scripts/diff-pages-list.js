#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { diffPagesListVerbose } = require('./lib/pages-list-diff');

// Accepted argv shape:
//   --before /tmp/pac-pages-before.txt --after /tmp/pac-pages-after.txt
// Both files contain raw `pac pages list -v` output captured before/after a
// template solution import.
// Missing or malformed argv is fail-open JSON (`{ error: "Usage..." }`) rather
// than a thrown exception so the skill can surface the problem and stop before
// activation.
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--before') args.before = argv[++i];
    else if (arg === '--after') args.after = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.before || !args.after) {
    process.stdout.write(`${JSON.stringify({ error: 'Usage: diff-pages-list.js --before <file> --after <file>' }, null, 2)}\n`);
    process.exit(0);
  }
  const before = fs.readFileSync(args.before, 'utf8');
  const after = fs.readFileSync(args.after, 'utf8');
  process.stdout.write(`${JSON.stringify(diffPagesListVerbose(before, after), null, 2)}\n`);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs };
