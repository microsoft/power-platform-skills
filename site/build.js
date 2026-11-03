#!/usr/bin/env node
'use strict';

/**
 * Builds the Power Platform Skills showcase site into a static folder for GitHub Pages.
 *
 * Usage:
 *   node site/build.js [--out <dir>] [--base-path <path>]
 *
 *   --out        Output folder. Default: site/dist
 *   --base-path  Absolute path the site is served from, used only by 404.html.
 *                Default: the path of the production site URL, /power-platform-skills/
 *
 * The build has no dependencies beyond Node.js, so CI and contributors need no npm install.
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadCatalog } = require('./lib/catalog.js');
const render = require('./lib/render.js');
const links = require('./lib/install-links.js');

const SITE_DIR = __dirname;
const REPO_ROOT = path.resolve(SITE_DIR, '..');
// Written into every build. The build only clears an output folder that has this marker,
// so a mistyped --out can never delete an unrelated folder.
const MARKER = '.power-platform-skills-site';

// Everything under site/assets ships as-is, except Markdown notes for maintainers.
// The launcher page also runs the same link builders as the build, so the two cannot disagree.
const ASSETS_DIR = 'assets';
const EXTRA_ASSETS = [['lib/install-links.js', 'assets/install-links.js']];

function listAssets(dir, relative = '') {
  return fs.readdirSync(path.join(dir, relative), { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) return listAssets(dir, child);
    return entry.name.endsWith('.md') ? [] : [child];
  });
}

function parseArgs(argv) {
  const options = {
    outDir: path.join(SITE_DIR, 'dist'),
    basePath: new URL(links.SITE_URL).pathname,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--out' && value) {
      options.outDir = path.resolve(value);
      index += 1;
    } else if (arg === '--base-path' && value) {
      options.basePath = value;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}\nUsage: node site/build.js [--out <dir>] [--base-path <path>]`);
    }
  }
  if (!options.basePath.startsWith('/')) options.basePath = `/${options.basePath}`;
  if (!options.basePath.endsWith('/')) options.basePath = `${options.basePath}/`;
  return options;
}

function prepareOutDir(outDir) {
  if (fs.existsSync(outDir)) {
    const entries = fs.readdirSync(outDir);
    if (entries.length > 0 && !entries.includes(MARKER)) {
      throw new Error(`Refusing to clear ${outDir}: it is not empty and was not created by this build.`);
    }
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, MARKER), '');
}

function writeFile(outDir, relative, contents) {
  const file = path.join(outDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return relative.split(path.sep).join('/');
}

// The transcript under the explainer video: each paragraph of narration, then what is on screen
// while it is spoken. The film shows examples the narration never says aloud (skill names,
// steps, the permission prompt), and the descriptions carry them for anyone who cannot see the
// video. timeline.json is the script the film and its captions are generated from
// (site/explainer), so the spoken part cannot drift. Descriptions.txt has one paragraph, split
// by a blank line, per narration paragraph.
function loadExplainer() {
  const dir = path.join(SITE_DIR, 'explainer');
  const timeline = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
  const spoken = [];
  for (const sentence of timeline.sentences) {
    (spoken[sentence.paragraph - 1] ||= []).push(sentence.text);
  }
  const shown = fs.readFileSync(path.join(dir, 'Descriptions.txt'), 'utf8')
    .split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim().split(/\s+/).join(' ')).filter(Boolean);
  if (shown.length !== spoken.length) {
    throw new Error(`site/explainer/Descriptions.txt has ${shown.length} paragraphs; the narration has ${spoken.length}.`);
  }
  return {
    seconds: Math.round(timeline.duration),
    transcript: spoken.map((sentences, index) => ({ spoken: sentences.join(' '), shown: shown[index] })),
  };
}

function build({ repoRoot = REPO_ROOT, outDir, basePath }) {
  const catalog = loadCatalog(repoRoot);
  prepareOutDir(outDir);

  const written = [];
  written.push(writeFile(outDir, 'index.html', render.renderHome(catalog, loadExplainer())));
  for (const plugin of catalog.plugins) {
    written.push(writeFile(outDir, path.join('plugins', plugin.name, 'index.html'), render.renderPlugin(plugin, catalog)));
  }
  written.push(writeFile(outDir, path.join('install', 'index.html'), render.renderLauncher(catalog)));
  written.push(writeFile(outDir, '404.html', render.renderNotFound(basePath)));
  // GitHub Pages runs Jekyll on branch deploys, which drops files and folders that start
  // with "_" or ".". Actions deploys skip Jekyll already; this keeps a branch deploy safe too.
  written.push(writeFile(outDir, '.nojekyll', ''));

  const assetsDir = path.join(SITE_DIR, ASSETS_DIR);
  const assets = listAssets(assetsDir).map((file) => [path.join(ASSETS_DIR, file), path.join(ASSETS_DIR, file)]);
  for (const [from, to] of [...assets, ...EXTRA_ASSETS]) {
    written.push(writeFile(outDir, to, fs.readFileSync(path.join(SITE_DIR, from))));
  }
  return { catalog, files: written };
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { catalog, files } = build(options);
    console.log(`Built ${files.length} files for ${catalog.plugins.length} plugins into ${path.relative(process.cwd(), options.outDir) || '.'}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { build, loadExplainer, parseArgs, MARKER };
