#!/usr/bin/env node
'use strict';

/**
 * Builds the Power Platform Skills showcase site into a static folder for GitHub Pages.
 *
 * Usage:
 *   node site/build.js [--out <dir>] [--base-path <path>] [--media <dir>] [--require-media]
 *
 *   --out            Output folder. Default: site/dist
 *   --base-path      Absolute path the site is served from, used only by 404.html.
 *                    Default: the path of the production site URL, /power-platform-skills/
 *   --media          Local copy of the site-media branch. Default: site/media, which
 *                    `node site/fetch-media.js` fills. See site/lib/media.js.
 *   --require-media  Fail if a pinned media file is missing. Without it, the build leaves the
 *                    video out with a warning, so the rest of the site can be previewed.
 *   --eval-results   Summary JSON file or directory of summaries; repeat for multiple inputs.
 *                    Without summaries, the evaluations page shows the untested inventory.
 *   --allow-empty-eval-results  Allow empty results directories for first-time publication.
 *
 * The build has no dependencies beyond Node.js, so CI and contributors need no npm install.
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadCatalog } = require('./lib/catalog.js');
const render = require('./lib/render.js');
const links = require('./lib/install-links.js');
const { copyMedia, loadMediaManifest } = require('./lib/media.js');
const { loadEvaluations } = require('./lib/evaluations.js');
const { renderEvaluations } = require('./lib/render-evaluations.js');

const SITE_DIR = __dirname;
const REPO_ROOT = path.resolve(SITE_DIR, '..');
// Written into every build. The build only clears an output folder that has this marker,
// so a mistyped --out can never delete an unrelated folder.
const MARKER = '.power-platform-skills-site';

// Everything under site/assets ships as-is, except Markdown notes for maintainers.
// The launcher page also runs the same link builders as the build, so the two cannot disagree.
const ASSETS_DIR = 'assets';
const EXTRA_ASSETS = [['lib/install-links.js', 'assets/install-links.js']];
const MEDIA_MANIFEST = path.join(SITE_DIR, 'media.json');
const USAGE = 'Usage: node site/build.js [--out <dir>] [--base-path <path>] [--media <dir>] [--require-media] [--eval-results <file-or-dir>] [--allow-empty-eval-results]';

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
    mediaDir: path.join(SITE_DIR, 'media'),
    requireMedia: false,
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
    } else if (arg === '--media' && value) {
      options.mediaDir = path.resolve(value);
      index += 1;
    } else if (arg === '--require-media') {
      options.requireMedia = true;
    } else if (arg === '--eval-results' && value) {
      options.evalResults = [...(options.evalResults || []), path.resolve(value)];
      index += 1;
    } else if (arg === '--allow-empty-eval-results') {
      options.allowEmptyEvalResults = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}\n${USAGE}`);
    }
  }
  if (options.allowEmptyEvalResults && !options.evalResults) throw new Error('--allow-empty-eval-results requires --eval-results');
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

// mediaDir defaults to none, so a build in a test never depends on what happens to be in
// site/media; the command line passes site/media.
function build({ repoRoot = REPO_ROOT, outDir, basePath, mediaDir = null, requireMedia = false, evalResults = null, allowEmptyEvalResults = false }) {
  const catalog = loadCatalog(repoRoot);
  const evaluations = loadEvaluations({ repoRoot, catalog, evalResults, allowEmptyEvalResults });
  prepareOutDir(outDir);

  const written = [];
  written.push(writeFile(outDir, 'index.html', render.renderHome(catalog)));
  written.push(writeFile(outDir, path.join('evaluations', 'index.html'), renderEvaluations(evaluations)));
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

  const media = copyMedia({ manifest: loadMediaManifest(MEDIA_MANIFEST), mediaDir, outDir });
  if (requireMedia && media.missing.length > 0) {
    throw new Error(`Missing ${media.missing.join(', ')} from ${mediaDir || 'the media folder'}. Run node site/fetch-media.js first.`);
  }
  written.push(...media.written);
  return { catalog, files: written, missingMedia: media.missing };
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { catalog, files, missingMedia } = build(options);
    console.log(`Built ${files.length} files for ${catalog.plugins.length} plugins into ${path.relative(process.cwd(), options.outDir) || '.'}`);
    if (missingMedia.length > 0) {
      console.warn(`Left out ${missingMedia.join(', ')}, so the explainer video will not play. Run node site/fetch-media.js to include it.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { build, parseArgs, MARKER };
