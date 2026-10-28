'use strict';
// What a test's unexpectedly failed build must say, so one failure is enough to diagnose it.
//
// A build in a test runs over a workspace folder on disk. When it fails for a reason the test did not provoke (a file the
// build expected is not there), the assertion that surfaces is only the build's message, for example
//   forms failed: ENOENT: no such file or directory, open '<workspace>/manifest.json'
// and the folder is removed straight afterwards, so a failure that never reproduces cannot be investigated. This appends to
// the failed build's message what the folder looked like at that moment: the whole error chain (name, code, message and stack
// of the error and of each `cause`), the path the failure names as missing and how much of it exists, and a bounded
// recursive listing of the workspace.
const fs = require('node:fs');
const path = require('node:path');

const MAX_LISTING_ENTRIES = 200;
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

function nearestExistingAncestor(missing) {
  let current = path.resolve(missing);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

// `name/` for a folder and `name (N bytes)` for a file, paths relative to `root`, folders before their contents and
// siblings in name order, so the same tree always lists the same way. Stops at `limit` entries and says how many more
// there were.
function listTree(root, limit = MAX_LISTING_ENTRIES) {
  const lines = [];
  let omitted = 0;
  const add = (line) => { if (lines.length < limit) lines.push(line); else omitted += 1; };
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch (error) {
      add(`${path.relative(root, dir) || '.'}/ <unreadable: ${error.code || error.message}>`);
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        add(`${relative}/`);
        walk(full);
      } else {
        let size = '?';
        try { size = String(fs.statSync(full).size); } catch (error) { size = `unreadable: ${error.code || error.message}`; }
        add(`${relative} (${size} bytes)`);
      }
    }
  };
  if (!fs.existsSync(root)) return { lines: [], omitted: 0, exists: false };
  walk(root);
  return { lines, omitted, exists: true };
}

function describeFolder({ label, dir }) {
  const tree = listTree(dir);
  if (!tree.exists) return [`${label}: ${dir} does not exist`];
  const header = `${label}: ${dir} (${tree.lines.length + tree.omitted} entries${tree.omitted ? `, first ${tree.lines.length} listed` : ''})`;
  return [header, ...(tree.lines.length ? tree.lines.map((line) => `  ${line}`) : ['  <empty>']),
    ...(tree.omitted ? [`  … ${tree.omitted} more not listed`] : [])];
}

// `folders` is `[{ label, dir }]`: the folders the build works in (workspace, app folder).
function describeBuildFailure(error, folders) {
  const chain = causeChain(error);
  const lines = ['--- build failure diagnostics ---', 'error chain (outermost first):'];
  chain.forEach((link, position) => lines.push(...describeLink(link, position)));
  const listed = [...folders];
  for (const missing of missingPaths(chain)) {
    const ancestor = nearestExistingAncestor(missing);
    lines.push(`missing path: ${missing} (exists now: ${fs.existsSync(missing)}; nearest existing folder: ${ancestor || 'none'})`);
    const inside = (dir) => ancestor && !path.relative(dir, ancestor).startsWith('..') && !path.isAbsolute(path.relative(dir, ancestor));
    if (ancestor && !listed.some(({ dir }) => inside(dir))) listed.push({ label: 'folder holding the missing path', dir: ancestor });
  }
  for (const folder of listed) lines.push(...describeFolder(folder));
  lines.push('--- end of build failure diagnostics ---');
  return lines.join('\n');
}

// Appends the diagnostics to the error's own message and returns the same error, so a test that checks its code, its phase
// or a pattern in its message (assert.rejects) still sees what it checked before. Anything that is not an Error is returned
// untouched.
function annotateBuildFailure(error, folders) {
  if (!(error instanceof Error)) return error;
  let text;
  try {
    text = describeBuildFailure(error, folders);
  } catch (diagnosticError) {
    // The diagnostics must never hide the failure they describe.
    text = `--- build failure diagnostics unavailable: ${diagnosticError && diagnosticError.message} ---`;
  }
  try { error.message = `${error.message}\n${text}`; } catch { /* a frozen error keeps its message */ }
  return error;
}

module.exports = { annotateBuildFailure, describeBuildFailure, listTree, MAX_LISTING_ENTRIES };
