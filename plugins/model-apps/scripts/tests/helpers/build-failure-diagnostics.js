'use strict';
// What a test's unexpectedly failed build can say about itself, so one failure is enough to diagnose it.
//
// A build in a test runs over a workspace folder on disk. When it fails for a reason the test did not provoke (a file the
// build expected is not there), the assertion that surfaces is only the build's message, for example
//   forms failed: ENOENT: no such file or directory, open '<workspace>/manifest.json'
// and the folder is removed straight afterwards, so a failure that never reproduces cannot be investigated. This records what
// the folders looked like at that moment: the whole error chain (name, code, message and stack of the error and of each
// `cause`), the path the failure names as missing and how much of it exists, and a bounded recursive listing of the folders
// the scenario owns.
//
// The error itself is NEVER changed: its message, code, phase and cause stay what the build threw, so a test that rejects with a
// pattern (assert.rejects(..., /push|500|simulated/i)) still checks the build's own text and not a listing that happens to hold
// one of its words. The diagnostics are kept apart (a non-enumerable `buildFailureDiagnostics` property and a pending list) and
// printed with `t.diagnostic` only when the test that threw them fails (installBuildFailureDiagnostics).
//
// Scope. Only the folders the caller names are listed, never their parent or any other folder; a missing path outside them is
// reported as such and not looked at. The walk stops after MAX_LISTING_ENTRIES entries, reads at most MAX_DIRECTORY_READS names
// from one folder, goes no deeper than MAX_DEPTH and never follows a link, so what a failure costs does not depend on what a
// folder holds. The text is passed through the plugin's output redaction and a Bearer-token mask before it is kept.
const fs = require('node:fs');
const path = require('node:path');
const { redactOutput } = require('../../lib/output-redaction.js');

const MAX_LISTING_ENTRIES = 200;
const MAX_DIRECTORY_READS = 500;
const MAX_DEPTH = 8;
const MAX_CHAIN_LENGTH = 8;

// An error followed by its `cause`s, outermost first. A cause is an Error, a plain object or a string, and a chain can
// loop, so stop at a repeat or at MAX_CHAIN_LENGTH.
function causeChain(error) {
  const chain = [];
  for (let current = error; current !== undefined && current !== null && chain.length < MAX_CHAIN_LENGTH && !chain.includes(current); current = current && current.cause) {
    chain.push(current);
  }
  return chain;
}

function describeLink(link, position) {
  if (link === null || typeof link !== 'object') return [`  [${position}] ${String(link)}`];
  const name = link.name || (link.constructor && link.constructor.name) || 'Error';
  const facts = ['code', 'errno', 'syscall', 'path', 'phase']
    .filter((key) => link[key] !== undefined)
    .map((key) => `${key}=${JSON.stringify(link[key])}`);
  const lines = [`  [${position}] ${name}${facts.length ? ` (${facts.join(', ')})` : ''}: ${link.message}`];
  if (typeof link.stack === 'string') lines.push(...link.stack.split(/\r?\n/).map((line) => `      ${line}`));
  return lines;
}

// Paths a failure reports as missing. A system error carries `path`; a wrapped one (the build quotes the cause's message)
// only has it in the text, where Node writes:
//   ENOENT: no such file or directory, open 'C:\Users\maker\AppData\Local\Temp\rebuild-writes-aB3dEf\manifest.json'
function missingPaths(chain) {
  const found = new Set();
  for (const link of chain) {
    if (link === null || typeof link !== 'object') continue;
    if (link.code === 'ENOENT' && typeof link.path === 'string') found.add(link.path);
    for (const match of String(link.message || '').matchAll(/ENOENT[^'\r\n]*'([^'\r\n]+)'/g)) found.add(match[1]);
  }
  return [...found];
}

const isInside = (root, target) => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

// The deepest folder of the path that exists, looked for only from the path up to `root` (a folder the scenario owns, that
// exists): never above it.
function nearestExistingWithin(root, missing) {
  let current = path.resolve(missing);
  while (!fs.existsSync(current)) {
    if (path.resolve(root) === current) return null;
    current = path.dirname(current);
  }
  return current;
}

// `name/` for a folder and `name (N bytes)` for a file, paths relative to `root`, folders before their contents and
// siblings in name order. Bounded as the header says: `limit` entries listed, MAX_DIRECTORY_READS names read from a folder,
// MAX_DEPTH levels, no link followed (a link is listed as `name -> link`). `truncated` says that the walk stopped before it
// had seen everything; how much more there was is not counted, because counting it is the unbounded walk.
function listTree(root, limit = MAX_LISTING_ENTRIES) {
  const lines = [];
  let truncated = false;
  const add = (line) => {
    if (lines.length >= limit) { truncated = true; return false; }
    lines.push(line);
    return true;
  };
  const readNames = (dir) => {
    const opened = fs.opendirSync(dir);
    const entries = [];
    try {
      for (let entry = opened.readSync(); entry; entry = opened.readSync()) {
        if (entries.length >= MAX_DIRECTORY_READS) { truncated = true; break; }
        entries.push(entry);
      }
    } finally {
      opened.closeSync();
    }
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  };
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readNames(dir);
    } catch (error) {
      add(`${path.relative(root, dir).split(path.sep).join('/') || '.'}/ <unreadable: ${error.code || error.message}>`);
      return;
    }
    for (const entry of entries) {
      if (lines.length >= limit) { truncated = true; return; }
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      // Node 20 on Windows reports a junction as a plain directory in a directory entry, so a folder is checked by lstat too
      // (lstat does not follow the link).
      let link = entry.isSymbolicLink();
      if (!link && entry.isDirectory()) {
        try { link = fs.lstatSync(full).isSymbolicLink(); } catch { link = false; }
      }
      if (link) {
        add(`${relative} -> link`);
      } else if (entry.isDirectory()) {
        add(`${relative}/`);
        if (depth + 1 >= MAX_DEPTH) truncated = true;
        else walk(full, depth + 1);
      } else {
        let size;
        try { size = String(fs.lstatSync(full).size); } catch (error) { size = `unreadable: ${error.code || error.message}`; }
        add(`${relative} (${size} bytes)`);
      }
    }
  };
  if (!fs.existsSync(root)) return { lines: [], truncated: false, exists: false };
  walk(root, 0);
  return { lines, truncated, exists: true };
}

function describeFolder({ label, dir }) {
  const tree = listTree(dir);
  if (!tree.exists) return [`${label}: ${dir} does not exist`];
  const header = `${label}: ${dir} (${tree.lines.length} entries listed${tree.truncated ? `; more exist, the listing stops at ${MAX_LISTING_ENTRIES} entries, ${MAX_DIRECTORY_READS} names a folder and ${MAX_DEPTH} levels` : ''})`;
  return [header, ...(tree.lines.length ? tree.lines.map((line) => `  ${line}`) : ['  <empty>'])];
}

// A fake transport carries no real token, but a failure's cause can still quote a header; mask the credential forms a request
// carries before the text is kept, then let the plugin's own redaction take out every token this process obtained. Fail closed.
function redacted(text) {
  const masked = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ****');
  try {
    return redactOutput(masked);
  } catch {
    return '--- build failure diagnostics withheld: the text could not be checked for an access token ---';
  }
}

// `folders` is `[{ label, dir }]`: the folders the scenario owns (workspace, app folder). Nothing else is listed.
function describeBuildFailure(error, folders) {
  const chain = causeChain(error);
  const lines = ['--- build failure diagnostics ---', 'error chain (outermost first):'];
  chain.forEach((link, position) => lines.push(...describeLink(link, position)));
  for (const missing of missingPaths(chain)) {
    const owner = folders.find(({ dir }) => isInside(dir, missing));
    if (!owner) {
      lines.push(`missing path: ${missing} (outside the folders listed below; not looked at)`);
    } else if (!fs.existsSync(owner.dir)) {
      lines.push(`missing path: ${missing} (its ${owner.label} no longer exists)`);
    } else {
      lines.push(`missing path: ${missing} (exists now: ${fs.existsSync(missing)}; nearest existing folder: ${nearestExistingWithin(owner.dir, missing)})`);
    }
  }
  for (const folder of folders) lines.push(...describeFolder(folder));
  lines.push('--- end of build failure diagnostics ---');
  return redacted(lines.join('\n'));
}

const pending = [];

// Keeps the diagnostics apart from `error` and returns `error` exactly as it was thrown. Anything that is not an Error is
// returned untouched.
function recordBuildFailure(error, folders) {
  if (!(error instanceof Error)) return error;
  let text;
  try {
    text = describeBuildFailure(error, folders);
  } catch (diagnosticError) {
    // The diagnostics must never hide the failure they describe.
    text = `--- build failure diagnostics unavailable: ${diagnosticError && diagnosticError.message} ---`;
  }
  pending.push(text);
  try { Object.defineProperty(error, 'buildFailureDiagnostics', { value: text, enumerable: false, configurable: true }); } catch { /* a frozen error cannot carry it; the pending list still has it */ }
  return error;
}

// Prints what was recorded during a test, only when that test failed (a build a test provokes and rejects on purpose passes and
// prints nothing), and forgets it either way. One diagnostic per line: the TAP reporter writes a newline inside one as a
// literal `\n`.
function flushBuildFailureDiagnostics(t) {
  const recorded = pending.splice(0);
  if (t.passed !== false) return;
  for (const text of recorded) for (const line of text.split('\n')) t.diagnostic(line);
}

// Call once at the top of a test file, so the hook covers every test in it.
function installBuildFailureDiagnostics(test) {
  test.afterEach((t) => flushBuildFailureDiagnostics(t));
}

module.exports = {
  recordBuildFailure,
  flushBuildFailureDiagnostics,
  installBuildFailureDiagnostics,
  describeBuildFailure,
  listTree,
  MAX_LISTING_ENTRIES,
  MAX_DIRECTORY_READS,
  MAX_DEPTH,
};
