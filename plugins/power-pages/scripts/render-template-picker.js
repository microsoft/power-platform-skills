#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { renderTemplate } = require('./lib/render-template');

// Accepted argv shape:
//   --templatesJsonPath /tmp/templates.json --outputPath /tmp/picker.html [--open]
// `--open` is a boolean switch; the JSON file must contain
// `{ "TEMPLATES_JSON": [ ...manifest entries with absolute preview image URLs... ] }`.
function parseArgs(argv) {
  const args = { open: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--templatesJsonPath') args.templatesJsonPath = argv[++i];
    else if (arg === '--outputPath') args.outputPath = argv[++i];
    else if (arg === '--open') args.open = true;
  }
  return args;
}

function openFileInDefaultBrowser(filePath, deps = {}) {
  const platform = (deps.os || os).platform();
  const execFile = deps.execFileSync || execFileSync;
  if (platform === 'darwin') {
    execFile('open', [filePath], { stdio: 'ignore' });
  } else if (platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', filePath], { stdio: 'ignore', windowsHide: true });
  } else {
    execFile('xdg-open', [filePath], { stdio: 'ignore' });
  }
}

function renderTemplatePicker({ templatesJsonPath, outputPath, open = false }, deps = {}) {
  if (!templatesJsonPath || !outputPath) {
    throw new Error('Usage: render-template-picker.js --templatesJsonPath <path> --outputPath <path> [--open]');
  }
  const fsImpl = deps.fs || fs;
  const templatePath = path.join(__dirname, '..', 'skills', 'create-site', 'assets', 'template-picker.html');
  const data = JSON.parse(fsImpl.readFileSync(templatesJsonPath, 'utf8'));
  renderTemplate({
    templatePath,
    outputPath,
    dataObject: data,
    requiredKeys: ['TEMPLATES_JSON'],
  });
  if (open) {
    openFileInDefaultBrowser(outputPath, deps);
  }
  return { status: 'ok', output: outputPath, opened: Boolean(open) };
}

function main() {
  try {
    const result = renderTemplatePicker(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, openFileInDefaultBrowser, renderTemplatePicker };
