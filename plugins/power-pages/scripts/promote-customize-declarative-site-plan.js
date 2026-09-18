#!/usr/bin/env node
/**
 * Promote an approved customization plan to the canonical current-plan paths.
 *
 * The browser review uses a fresh external directory. Promotion happens only after
 * approval so rejected drafts cannot replace the last approved plan.
 */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('./lib/render-template');

const args = parseArgs(process.argv);

if (!args.projectRoot || !args.data || !args.html) {
  console.error(
    'Usage: node promote-customize-declarative-site-plan.js ' +
      '--projectRoot <path> --data <approved-json> --html <approved-html>'
  );
  process.exit(1);
}

const projectRoot = path.resolve(args.projectRoot);
const sourceJson = path.resolve(args.data);
const sourceHtml = path.resolve(args.html);
const planRoot = path.join(projectRoot, 'docs', 'customize-declarative-site');
const currentJson = path.join(planRoot, 'current-plan.json');
const currentHtml = path.join(planRoot, 'current-plan.html');
const currentIcon = path.join(planRoot, 'power-pages-icon.png');

for (const [label, filePath] of [
  ['Approved JSON', sourceJson],
  ['Approved HTML', sourceHtml],
]) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    console.error(`${label} file not found: ${filePath}`);
    process.exit(1);
  }
  if (fs.statSync(filePath).size === 0) {
    console.error(`${label} file is empty: ${filePath}`);
    process.exit(1);
  }
}

try {
  JSON.parse(fs.readFileSync(sourceJson, 'utf8'));
} catch {
  console.error(`Approved JSON file is not valid JSON: ${sourceJson}`);
  process.exit(1);
}

if (
  [currentJson, currentHtml].includes(sourceJson) ||
  [currentJson, currentHtml].includes(sourceHtml)
) {
  console.error('Approved review files must be outside the canonical current-plan paths');
  process.exit(1);
}

const hasCurrentJson = fs.existsSync(currentJson);
const hasCurrentHtml = fs.existsSync(currentHtml);
if (hasCurrentJson !== hasCurrentHtml) {
  console.error(
    'Canonical plan is incomplete: current-plan.json and current-plan.html must either both exist or both be absent'
  );
  process.exit(1);
}

fs.mkdirSync(planRoot, { recursive: true });

let archivePath = null;
if (hasCurrentJson) {
  const historyRoot = path.join(planRoot, 'history');
  fs.mkdirSync(historyRoot, { recursive: true });
  archivePath = reserveArchiveDirectory(historyRoot);
  fs.copyFileSync(currentJson, path.join(archivePath, 'plan.json'));
  fs.copyFileSync(currentHtml, path.join(archivePath, 'plan.html'));
  if (fs.existsSync(currentIcon)) {
    fs.copyFileSync(currentIcon, path.join(archivePath, 'power-pages-icon.png'));
  }
}

fs.copyFileSync(sourceJson, currentJson);
fs.copyFileSync(sourceHtml, currentHtml);

const sourceIcon = path.join(path.dirname(sourceHtml), 'power-pages-icon.png');
const sharedIcon = path.join(
  __dirname,
  '..',
  'skills',
  'create-site',
  'assets',
  'shared',
  'power-pages-icon.png'
);
const iconToCopy = fs.existsSync(sourceIcon) ? sourceIcon : sharedIcon;
if (fs.existsSync(iconToCopy) && path.resolve(iconToCopy) !== path.resolve(currentIcon)) {
  fs.copyFileSync(iconToCopy, currentIcon);
}

console.log(
  JSON.stringify({
    status: 'ok',
    currentJson,
    currentHtml,
    archivedPreviousPlan: archivePath,
  })
);

function reserveArchiveDirectory(historyRoot) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let suffix = 1; ; suffix += 1) {
    const name = suffix === 1 ? timestamp : `${timestamp}-${suffix}`;
    const candidate = path.join(historyRoot, name);
    try {
      fs.mkdirSync(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}
