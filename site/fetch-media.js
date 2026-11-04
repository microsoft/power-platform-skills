#!/usr/bin/env node
'use strict';

/**
 * Fetches the site's pinned media (the explainer video and its poster) from the site-media
 * branch into site/media, which Git ignores. See site/lib/media.js for why they live there.
 *
 * Usage:
 *   node site/fetch-media.js [--from <remote, URL, or path>]
 *
 *   --from  Where to fetch the branch from: a URL, a remote name, or a folder in a Git
 *           repository. Default: the public repository on GitHub, so a fork or a clone with other
 *           remote names still gets the real files. Use "." to try a site-media branch that is
 *           not pushed yet.
 *
 * Needs Git. The fetch runs in a temporary repository, so it never changes your clone.
 */

const path = require('node:path');
const links = require('./lib/install-links.js');
const { fetchMedia, loadMediaManifest } = require('./lib/media.js');

const SITE_DIR = __dirname;

function parseArgs(argv) {
  const options = { from: `https://github.com/${links.REPO}.git` };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--from' && argv[index + 1]) {
      options.from = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argv[index]}\nUsage: node site/fetch-media.js [--from <remote, URL, or path>]`);
    }
  }
  return options;
}

if (require.main === module) {
  try {
    const { from } = parseArgs(process.argv.slice(2));
    const manifest = loadMediaManifest(path.join(SITE_DIR, 'media.json'));
    const mediaDir = path.join(SITE_DIR, 'media');
    // Remote names resolve in the site's repository; relative folders from where this was run.
    const { fetched } = fetchMedia({ manifest, mediaDir, from, cwd: SITE_DIR, pathBase: process.cwd() });
    console.log(fetched.length ? `Fetched ${fetched.join(', ')} into site/media` : 'site/media already has every pinned file');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs };
