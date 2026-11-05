'use strict';
// The TypeScript compiler the bundled SDK compiles generative pages with (`MakerSdkOptions.typescript`).
//
// The SDK compiles a page's source itself on every push that changes it — `transpileModule` plus TypeScript's own checker
// to resolve enum names — and accepts only the minor version the maker portal compiles with (5.8), so that a page is stored
// exactly as the portal would store it. Its bundle holds no TypeScript: the host supplies one. A plugin install has no
// node_modules, so the plugin ships the official `typescript@5.8.3` `lib/typescript.js`, minified as a script and
// brotli-compressed (scripts/vendor/typescript/, built by _vendor-build/build-typescript.js; PROVENANCE.json pins the npm
// tarball, the source file and every derived hash).
//
// Loaded LAZILY, once per process, and only when a page is compiled — or read by the parser check (typescript-views.js), which asks it about a page on which the
// lexer guessed: unpacking takes ~15 ms and evaluating ~200 ms, with ~20 MB of heap, which a run that compiles nothing and meets no such page should not pay. The
// unpacked bytes are checked against the provenance before they are evaluated: a vendored file that was edited, truncated or swapped fails closed with its hash,
// rather than compiling pages with an unknown compiler.
//
// Evaluated in THIS realm as the body of a function — the file is a plain script whose top-level `var ts` then becomes the
// function's local, returned to the caller — rather than in a separate `vm` context: objects from another realm would make
// every `instanceof` check between the SDK and the compiler a question, and this is the realm the SDK's own Node loader
// (`loadNodeTypeScript`, an `import('typescript')`) would use.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const vm = require('node:vm');
const crypto = require('node:crypto');

const VENDOR_DIR = path.join(__dirname, '..', 'vendor', 'typescript');
let loaded = null;

/**
 * The vendored compiler, loaded once.
 * @param {{ dir?: string }} [options] - `dir`: a test seam for another copy of the vendor folder (never cached).
 * @returns {object} the TypeScript namespace (`ts`)
 * @throws when the vendored files are missing, do not match their provenance, or do not load as TypeScript of that version
 */
function loadVendoredTypeScript({ dir = VENDOR_DIR } = {}) {
  if (dir === VENDOR_DIR && loaded) return loaded;
  const provenance = JSON.parse(fs.readFileSync(path.join(dir, 'PROVENANCE.json'), 'utf8'));
  const code = zlib.brotliDecompressSync(fs.readFileSync(path.join(dir, 'typescript.min.js.br')));
  const actual = crypto.createHash('sha256').update(code).digest('hex');
  if (actual !== provenance.minified.sha256) {
    throw new Error(`The vendored TypeScript compiler does not match its provenance (sha256 ${actual}, expected ${provenance.minified.sha256}); `
      + 'rebuild it with scripts/_vendor-build/build-typescript.js.');
  }
  const ts = vm.runInThisContext(`(function () {\n${code.toString('utf8')}\n;return ts;\n})`, { filename: 'typescript.min.js' })();
  if (!ts || ts.version !== provenance.version || typeof ts.transpileModule !== 'function') {
    throw new Error(`The vendored TypeScript compiler did not load as typescript ${provenance.version}.`);
  }
  if (dir === VENDOR_DIR) loaded = ts;
  return ts;
}

module.exports = { loadVendoredTypeScript, VENDOR_DIR };
