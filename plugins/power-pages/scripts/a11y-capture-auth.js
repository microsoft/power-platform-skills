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
// Stops when the browser window is closed, or when --done-file exists (lets an agent
// end capture without the user closing the window). Reaching --timeout-sec first is an
// error, and the saved session is deleted: nobody confirmed the sign-in, and the agent
// that started the capture may have moved on, so no caller would clean the file up.
//
// Saves only cookies for the site's host and localStorage for its origin; identity
// provider cookies picked up during sign-in are dropped (filterAuthStateForSite).
// Prints JSON: { authState: <path>, cookies: <count>, domains: <count>, originsWithStorage: <count> }.
// Never prints cookie names or values. If a failed capture can't delete what it saved
// (for example, antivirus holds the file open), it prints { cleanupRequired: <path> }
// instead, so the caller can retry with --remove rather than leave live cookies behind.
// Exit codes: 0 captured, 1 nothing captured, timed out, or browser error, 2 usage,
// 4 missing deps.

const fs = require('node:fs');
const path = require('node:path');
const { EXIT } = require('./lib/a11y/args');
const { candidateRoots, launchBrowser, loadPlaywright, MissingDependencyError } = require('./lib/a11y/deps');
const { filterAuthStateForSite, openAuthStateFile, removeAuthState, summarizeAuthState, writeAuthState } = require('./lib/a11y/auth-state');

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
      // Not echoed: a malformed URL can still contain a password.
      try { u = new URL(value); } catch { throw new Error('--url is not a valid URL'); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('--url must use http or https');
      // Never echo the value: it would print the credentials this refuses.
      if (u.username || u.password) throw new Error('--url must not contain a user name or password; sign in in the browser window instead');
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

// Thrown when a capture failed and then couldn't delete the partial session. Carries
// the path so main() can hand cleanup to the caller instead of losing track of a file
// that holds live cookies.
class SessionCleanupError extends Error {
  constructor(file, cleanupError, cause) {
    super(`${cause ? `${cause.message}; ` : ''}the partial session could not be deleted (${cleanupError.message})`);
    this.file = file;
    this.cleanupError = cleanupError;
    this.cause = cause;
  }
}

async function capture(opts, {
  stderr = process.stderr, loadPw = loadPlaywright, launch = launchBrowser, removeState = removeAuthState,
} = {}) {
  const { chromium } = loadPw(candidateRoots(opts));
  // Create the private session file before launching the browser, and launch inside
  // the try: a failure at either step must not leave a browser process or an orphaned
  // session file behind.
  const { file, fd } = openAuthStateFile();
  let browser = null;
  let saved = null;
  let closed = false;
  let completed = false;
  let failure = null;
  try {
    browser = await launch(chromium, { headless: false });
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    browser.on('disconnected', () => { closed = true; });
    context.on('close', () => { closed = true; });
    await page.goto(opts.url, { waitUntil: 'load' }).catch(() => {});
    stderr.write('[a11y] Sign in to the site in the browser window, then close the window to finish.\n');

    const deadline = Date.now() + opts.timeoutSec * 1000;
    while (!closed && Date.now() < deadline) {
      let state;
      try {
        state = await context.storageState();
      } catch {
        // Context closed between the check and the call — the last save stands.
        break;
      }
      // Only the read above is expected to fail when the user closes the window. A
      // write failure (disk full, file locked by antivirus) must not be swallowed:
      // the file could hold a truncated or stale session, so it propagates and the
      // finally block deletes the file.
      saved = filterAuthStateForSite(state, opts.url);
      writeAuthState(fd, saved);
      if (opts.doneFile && fs.existsSync(opts.doneFile)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    // The loop also exits on the deadline. Only a closed window or the done file
    // confirms the user finished; otherwise fail so the finally block deletes the file.
    if (!closed && !(opts.doneFile && fs.existsSync(opts.doneFile)) && Date.now() >= deadline) {
      throw new Error(`timed out after ${opts.timeoutSec} seconds before sign-in was confirmed; the partial session was deleted`);
    }
    completed = true;
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    // Writes are synchronous, so a failed close loses nothing; it must never skip the
    // cleanup below.
    try { fs.closeSync(fd); } catch { /* see above */ }
    if (browser) await browser.close().catch(() => {});
    if (!completed) {
      // Replaces the original error on purpose: the caller must learn the file still
      // exists, and the original message is kept in the new one.
      try { removeState(file); } catch (err) { throw new SessionCleanupError(file, err, failure); }
    }
  }
  return { file, saved };
}

function reportCleanupRequired(file, err, { stdout, stderr }) {
  stdout.write(`${JSON.stringify({ cleanupRequired: file })}\n`);
  stderr.write(`The saved session at ${file} could not be deleted (${err.message}). It holds live sign-in cookies; delete it with: node a11y-capture-auth.js --remove "${file}"\n`);
}

async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, captureDeps = {} } = {}) {
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
    const { file, saved } = await capture(opts, { stderr, ...captureDeps });
    const summary = summarizeAuthState(saved);
    if (!saved || summary.cookies === 0) {
      // Nothing worth keeping; do not leave an empty session file behind. A missing
      // file already counts as removed, so any error here means the file is still there.
      try {
        (captureDeps.removeState || removeAuthState)(file);
      } catch (err) {
        reportCleanupRequired(file, err, { stdout, stderr });
        return 1;
      }
      stderr.write('No session cookies were captured. Sign in before closing the browser window.\n');
      return 1;
    }
    stdout.write(`${JSON.stringify({ authState: file, ...summary })}\n`);
    return EXIT.PASS;
  } catch (err) {
    if (err instanceof SessionCleanupError) {
      if (err.cause) stderr.write(`Session capture failed: ${err.cause.message}\n`);
      reportCleanupRequired(err.file, err.cleanupError, { stdout, stderr });
      return 1;
    }
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

module.exports = { SessionCleanupError, capture, main, parse };
