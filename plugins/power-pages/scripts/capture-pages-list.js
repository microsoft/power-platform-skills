#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const { formatJsonResult } = require('./lib/template-cli-args');

// Accepted argv shape:
//   --output /tmp/pac-pages-before.txt
// Missing output is reported as JSON rather than throwing so the skill can stop
// before import if the snapshot cannot be captured.
function parseArgs(argv) {
  const args = {};
  const idx = argv.indexOf('--output');
  if (idx !== -1) args.output = argv[idx + 1];
  return args;
}

function capturePagesListVerbose({ output }, deps = {}) {
  if (!output) return { ok: false, error: 'Usage: capture-pages-list.js --output <file>' };
  const execFile = deps.execFileSync || execFileSync;
  const fsImpl = deps.fs || fs;
  try {
    const stdout = execFile('pac', ['pages', 'list', '-v'], { encoding: 'utf8', timeout: 30000 });
    fsImpl.writeFileSync(output, stdout, 'utf8');
    return { ok: true, output };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

if (require.main === module) {
  process.stdout.write(formatJsonResult(capturePagesListVerbose(parseArgs(process.argv.slice(2)))));
}

module.exports = { parseArgs, capturePagesListVerbose };
