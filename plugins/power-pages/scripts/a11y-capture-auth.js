#!/usr/bin/env node
'use strict';

// Captures a signed-in session for auditing pages that require authentication.
//
// Opens a visible browser at --url. The user signs in themselves (Microsoft Entra ID,
// local login, MFA — whatever the site uses); the script never sees or types
// credentials. While the window is open it saves Playwright storage state (cookies +
// localStorage) every 2 seconds, so whatever state exists when the user closes the
// window is what gets audited.
//
// Usage:
//   node a11y-capture-auth.js --url <site-url> [--timeout-sec 600] [--done-file <path>] [--deps-dir <p>]
//   node a11y-capture-auth.js --remove <storage-state-path>
//
// Stops when the browser window is closed, when --done-file exists (lets an agent
// end capture without the user closing the window), or after --timeout-sec.
//
// Prints JSON: { authState: <path>, cookies: <count>, domains: <count>, originsWithStorage: <count> }.
// Never prints cookie names or values.
// Exit codes: 0 captured, 1 nothing captured or browser error, 2 usage, 4 missing deps.

const fs = require('node:fs');
const path = require('node:path');
const { EXIT } = require('./lib/a11y/args');
const { candidateRoots, launchBrowser, loadPlaywright, MissingDependencyError } = require('./lib/a11y/deps');
const { openAuthStateFile, removeAuthState, summarizeAuthState, writeAuthState } = require('./lib/a11y/auth-state');

const USAGE = 'Usage: node a11y-capture-auth.js --url <site-url> [--timeout-sec 600] [--done-file <path>] [--deps-dir <p>]\n'
  + '       node a11y-capture-auth.js --remove <storage-state-path>';

function parse(argv) {
  const opts = { url: null, timeoutSec: 600, doneFile: null, depsDir: null, remove: null };
  const takes = new Set(['--url', '--timeout-sec', '--done-file', '--deps-dir', '--remove']);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!takes.has(flag)) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    i++;
    if (flag === '--url') {
      let u;
      try { u = new URL(value); } catch { throw new Error(`--url is not a valid URL: ${value}`); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('--url must use http or https');
      opts.url = u.toString();
    } else if (flag === '--timeout-sec') {
      if (!/^\d+$/.test(value) || Number(value) < 10 || Number(value) > 3600) throw new Error('--timeout-sec must be 10-3600');
      opts.timeoutSec = Number(value);
    } else if (flag === '--done-file') opts.doneFile = value;
    else if (flag === '--deps-dir') opts.depsDir = value;
    else if (flag === '--remove') opts.remove = value;
  }
  if (!opts.remove && !opts.url) throw new Error('--url is required');
  return opts;
}

async function capture(opts, { stderr = process.stderr } = {}) {
  const { chromium } = loadPlaywright(candidateRoots(opts));
  const browser = await launchBrowser(chromium, { headless: false });
  const { file, fd } = openAuthStateFile();
  let saved = null;
  let closed = false;
  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    browser.on('disconnected', () => { closed = true; });
    context.on('close', () => { closed = true; });
    await page.goto(opts.url, { waitUntil: 'load' }).catch(() => {});
    stderr.write('[a11y] Sign in to the site in the browser window, then close the window to finish.\n');

    const deadline = Date.now() + opts.timeoutSec * 1000;
    while (!closed && Date.now() < deadline) {
      try {
        saved = await context.storageState();
        writeAuthState(fd, saved);
      } catch {
        // Context closed between the check and the call — the last save stands.
        break;
      }
      if (opts.doneFile && fs.existsSync(opts.doneFile)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    fs.closeSync(fd);
    await browser.close().catch(() => {});
  }
  return { file, saved };
}

async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let opts;
  try {
    opts = parse(argv);
  } catch (err) {
    stderr.write(`${err.message}\n${USAGE}\n`);
    return EXIT.USAGE;
  }

  if (opts.remove) {
    try {
      const { keptDir } = removeAuthState(opts.remove);
      stdout.write(`${JSON.stringify({ removed: opts.remove, ...(keptDir ? { keptDir: path.dirname(path.resolve(opts.remove)) } : {}) })}\n`);
      return EXIT.PASS;
    } catch (err) {
      stderr.write(`${err.message}\n`);
      return EXIT.USAGE;
    }
  }

  try {
    const { file, saved } = await capture(opts, { stderr });
    const summary = summarizeAuthState(saved);
    if (!saved || summary.cookies === 0) {
      // Nothing worth keeping; do not leave an empty session file behind.
      try { removeAuthState(file); } catch { /* already gone */ }
      stderr.write('No session cookies were captured. Sign in before closing the browser window.\n');
      return 1;
    }
    stdout.write(`${JSON.stringify({ authState: file, ...summary })}\n`);
    return EXIT.PASS;
  } catch (err) {
    if (err instanceof MissingDependencyError) {
      stderr.write(`${err.message}\n`);
      return EXIT.MISSING_DEPS;
    }
    stderr.write(`Session capture failed: ${err.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { main, parse };
