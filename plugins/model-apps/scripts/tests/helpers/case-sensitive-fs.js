'use strict';
// One real folder that behaves as a case-sensitive one, on any file system, for as long as a test needs it.
//
// WHY. Whether two spellings of one app's name lock each other out depends on whether the file system folds case: on Windows and on a default macOS
// volume `pages-Contoso_App.lock` and `pages-contoso_app.lock` are one file, on Linux (and on a case-sensitive Windows folder or macOS volume) they
// are two. A test that should prove what happens on the second kind must not depend on the machine it runs on, so this stores every name directly
// inside `root` under an escaped name in which an upper-case letter is `^` and that letter in lower case: two spellings that differ only in case are
// then two files on every file system, and a name in lower case alone is stored as it is.
//
// It works by replacing, on the one `fs` object every module shares, the functions the lease code calls with a path (and readdirSync, which answers
// the names unescaped); a call about any other path, and a call with a descriptor, goes through untouched. `restore()` puts the functions back.
// Nothing here is used by the plugin itself.
const fs = require('node:fs');
const path = require('node:path');

const PATH_FUNCTIONS = ['readFileSync', 'writeFileSync', 'appendFileSync', 'statSync', 'lstatSync', 'openSync', 'rmSync', 'unlinkSync', 'readlinkSync', 'existsSync', 'mkdirSync'];

// An upper-case letter is stored as `^` and the letter in lower case. A name that is already stored that way has no upper-case letter left, so storing it
// again changes nothing — which matters, because Node's own fs functions call one another through the same object (writeFileSync calls openSync), and
// a name would otherwise be escaped twice. The tests name no file with a `^` in it.
const escapeName = (name) => name.replace(/[A-Z]/g, (c) => `^${c.toLowerCase()}`);
const unescapeName = (name) => name.replace(/\^([a-z])/g, (_, c) => c.toUpperCase());

function caseSensitiveFolder(root) {
  const rootPath = path.resolve(root);
  const sameFolder = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const inRoot = (p) => typeof p === 'string' && sameFolder(path.dirname(path.resolve(p)), rootPath);
  const map = (p) => (inRoot(p) ? path.join(rootPath, escapeName(path.basename(path.resolve(p)))) : p);
  const saved = new Map();
  for (const name of PATH_FUNCTIONS) {
    const original = fs[name];
    saved.set(name, original);
    fs[name] = function mapped(target, ...rest) { return original.call(fs, map(target), ...rest); };
  }
  const readdir = fs.readdirSync;
  saved.set('readdirSync', readdir);
  fs.readdirSync = function mappedReaddir(target, ...rest) {
    const names = readdir.call(fs, target, ...rest);
    return typeof target === 'string' && sameFolder(path.resolve(target), rootPath) && names.every((n) => typeof n === 'string') ? names.map(unescapeName) : names;
  };
  let restored = false;
  return {
    restore() {
      if (restored) return;
      restored = true;
      for (const [name, original] of saved) fs[name] = original;
    },
  };
}

// Whether the folder `dir` (which must exist and be empty of `case-probe-*`) already tells two spellings apart: on Linux, yes.
function foldsCase(dir) {
  const lower = path.join(dir, 'case-probe-a');
  fs.writeFileSync(lower, '');
  try {
    return fs.existsSync(path.join(dir, 'case-probe-A'));
  } finally {
    fs.rmSync(lower, { force: true });
  }
}

module.exports = { caseSensitiveFolder, foldsCase };
