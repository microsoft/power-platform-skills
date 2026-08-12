#!/usr/bin/env node

/**
 * Remove/check generated prototype artifacts after real Dataverse/connector
 * services have replaced them.
 */

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const checkOnly = process.argv.includes('--check');
const generatedRoot = path.join(projectRoot, 'src', 'generated');

if (!fs.existsSync(generatedRoot)) {
  console.log('prototype-cleanup: PASS — no src/generated directory');
  process.exit(0);
}

const files = walk(generatedRoot);
const prototypeFiles = [];
const markerFiles = [];

for (const file of files) {
  const base = path.basename(file);
  if (base.endsWith('.seed.json')) prototypeFiles.push(file);
  if (/\.(ts|tsx|js|json)$/.test(base)) {
    const content = fs.readFileSync(file, 'utf8');
    if (/gen-mock-services\.js|PROTOTYPE MOCK SERVICE|PROTOTYPE CONNECTOR STUB|In-memory mock service|prototype mode/i.test(content)) {
      markerFiles.push(file);
      if (file.includes(`${path.sep}schemas${path.sep}`) && base.endsWith('.Schema.ts')) {
        prototypeFiles.push(file);
      }
    }
  }
}

if (checkOnly) {
  if (prototypeFiles.length || markerFiles.length) {
    report('BLOCKED: prototype-generated artifacts remain', prototypeFiles, markerFiles);
    process.exit(2);
  }
  console.log('prototype-cleanup: PASS — no generated seed files or mock service markers remain.');
  process.exit(0);
}

for (const file of prototypeFiles) fs.rmSync(file, { force: true });

const remainingMarkers = walk(generatedRoot).filter((file) => {
  if (!/\.(ts|tsx|js|json)$/.test(path.basename(file))) return false;
  const content = fs.readFileSync(file, 'utf8');
  return /gen-mock-services\.js|PROTOTYPE MOCK SERVICE|PROTOTYPE CONNECTOR STUB|In-memory mock service|prototype mode/i.test(content);
});

if (remainingMarkers.length) {
  report('BLOCKED: mock service markers remain after deleting seed/schema artifacts', [], remainingMarkers);
  process.exit(2);
}

console.log('prototype-cleanup: PASS — no generated seed files or mock service markers remain.');

function walk(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function report(header, prototype, markers) {
  console.error(header);
  for (const file of [...new Set([...prototype, ...markers])]) {
    console.error(`- ${path.relative(projectRoot, file)}`);
  }
}