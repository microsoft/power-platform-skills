/* Dev-only: vendors the TypeScript compiler the bundled SDK compiles generative pages with.
 * Run: node plugins/model-apps/scripts/_vendor-build/build-typescript.js --tarball <typescript-5.8.3.tgz>
 *      (the tarball: `npm pack typescript@5.8.3`)
 * Writes scripts/vendor/typescript/{typescript.min.js.br, LICENSE.txt, ThirdPartyNoticeText.txt, PROVENANCE.json}.
 * Not shipped. Re-run only when the SDK moves to another TypeScript, then run scripts/tests/vendor-typescript.test.js.
 *
 * Why a vendored compiler at all: the SDK compiles a page's source itself on every push, with TypeScript's own
 * `transpileModule` and checker, and it accepts ONLY the minor version the maker portal compiles with (5.8 — another is
 * refused, `GENPAGE_COMPILER_VERSION`), because a page must compile byte for byte as the portal compiles it. The SDK's
 * bundle holds no TypeScript (`_vendor-build/build.js` keeps it external); the host passes one in
 * (`MakerSdkOptions.typescript`). A plugin install has no node_modules, so it ships this one.
 *
 * Why this shape (measured): only `lib/typescript.js` is needed — the
 * compile reads no `.d.ts` file; minified it is ~3.6 MB, brotli-compressed ~0.8 MB on disk, unpacked in ~15 ms on the
 * first compile. It is minified as a SCRIPT (no `format`): as a module, esbuild renames the top-level `var ts`, and a host
 * that evaluates the file as a plain script then finds no `ts`. Another compiler (esbuild, swc, sucrase) is not an option:
 * it would break byte parity and the checker-based checks the SDK makes.
 *
 * Reproducible: the tarball is pinned by its npm integrity, the source file by its SHA-256, esbuild by its exact version
 * (package.json), and PROVENANCE.json carries no timestamp — a rebuild from the same tarball writes the same files.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { makeWritesBlocking } = require('../lib/output-redaction.js');

// typescript@5.8.3, as the npm registry publishes it (`npm view typescript@5.8.3 dist`): the tarball's sha1 and sha512,
// and the SHA-256 of the one file vendored from it. Bump all three together, deliberately.
const PINNED = {
  version: '5.8.3',
  tarballSha1: '92f8a3e5e3cf497356f4178c34cd65a7f5e8440e',
  tarballIntegrity: 'sha512-p1diW6TqL9L07nNxvRMM7hMMw4c5XOo/1ibL4aAIGmSAt9slTE1Xgw5KWuof2uTOvCg9BY7ZRi+GaF+7sfgPeQ==',
  sourceSha256: 'dd17428736a07e1db1a138d8a14295ddb2699ba780ee15038acdd2c6da5373a0',
};
const ESBUILD_OPTIONS = { loader: 'js', minify: true, target: 'es2019', legalComments: 'inline' };
const BROTLI_QUALITY = 11;
const OUT_DIR = path.resolve(__dirname, '../vendor/typescript');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const tarball = arg('--tarball');
if (!tarball) {
  console.error('Usage: node plugins/model-apps/scripts/_vendor-build/build-typescript.js --tarball <typescript-5.8.3.tgz>');
  console.error('   get the tarball with: npm pack typescript@5.8.3');
  process.exit(2);
}

const sha = (algo, bytes, enc = 'hex') => crypto.createHash(algo).update(bytes).digest(enc);

// A minimal ustar reader for the four files this needs — npm tarballs are gzip'd ustar, entries under `package/`.
// Header fields (POSIX ustar): name 0..100, size 124..136 (octal), typeflag 156, magic 257..263 ("ustar"), prefix 345..500.
// A pax header (typeflag 'x'/'g') is skipped with its data: the names read here are short, never carried by one.
function readTar(buffer) {
  const files = new Map();
  for (let at = 0; at + 512 <= buffer.length;) {
    const header = buffer.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 136).trim() || '0', 8);
    const type = field(156, 157) || '0';
    const prefix = field(257, 263).startsWith('ustar') ? field(345, 500) : '';
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const body = buffer.subarray(at + 512, at + 512 + size);
    if (type === '0' || type === '\0') files.set(name, Buffer.from(body));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const tgz = fs.readFileSync(tarball);
const integrity = `sha512-${sha('sha512', tgz, 'base64')}`;
if (integrity !== PINNED.tarballIntegrity || sha('sha1', tgz) !== PINNED.tarballSha1) {
  makeWritesBlocking(process.stdout, process.stderr);
  console.error(`Refusing ${tarball}: it is not the pinned typescript@${PINNED.version} tarball (integrity ${integrity}).`);
  process.exit(1);
}
const entries = readTar(zlib.gunzipSync(tgz));
const take = (name) => {
  const bytes = entries.get(`package/${name}`);
  if (!bytes) throw new Error(`the tarball has no package/${name}`);
  return bytes;
};
const pkg = JSON.parse(take('package.json').toString('utf8'));
const source = take('lib/typescript.js');
if (pkg.version !== PINNED.version || sha('sha256', source) !== PINNED.sourceSha256) {
  throw new Error(`package/lib/typescript.js is not the pinned ${PINNED.version} source (sha256 ${sha('sha256', source)})`);
}

const esbuild = require('esbuild');
const { code } = esbuild.transformSync(source.toString('utf8'), ESBUILD_OPTIONS);
const minified = Buffer.from(code, 'utf8');
if (!/Copyright \(c\) Microsoft Corporation/.test(code.slice(0, 4000))) throw new Error('the minified compiler lost its license header');

// Both ways a host can evaluate it must expose the compiler: as a function body in this realm (the plugin's loader,
// lib/typescript-compiler.js) and as a plain script in a bare context (a host that evaluates `typescript.js` as a script).
const asFunction = vm.runInThisContext(`(function () {\n${code}\n;return ts;\n})`, { filename: 'typescript.min.js' })();
const bare = vm.createContext({});
vm.runInContext(code, bare, { filename: 'typescript.min.js' });
for (const [how, ts] of [['as a function body', asFunction], ['as a bare script', bare.ts]]) {
  if (!ts || ts.version !== PINNED.version || typeof ts.transpileModule !== 'function') throw new Error(`the minified compiler does not load ${how}`);
}

const br = zlib.brotliCompressSync(minified, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: minified.length },
});
if (!zlib.brotliDecompressSync(br).equals(minified)) throw new Error('brotli round trip changed the compiler');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'typescript.min.js.br'), br);
fs.writeFileSync(path.join(OUT_DIR, 'LICENSE.txt'), take('LICENSE.txt'));
fs.writeFileSync(path.join(OUT_DIR, 'ThirdPartyNoticeText.txt'), take('ThirdPartyNoticeText.txt'));
const provenance = {
  package: 'typescript',
  version: PINNED.version,
  tarball: { sha1: PINNED.tarballSha1, integrity: PINNED.tarballIntegrity },
  source: { path: 'package/lib/typescript.js', sha256: PINNED.sourceSha256, bytes: source.length },
  esbuild: { version: esbuild.version, options: ESBUILD_OPTIONS },
  minified: { sha256: sha('sha256', minified), bytes: minified.length },
  brotli: { quality: BROTLI_QUALITY, sha256: sha('sha256', br), bytes: br.length },
};
fs.writeFileSync(path.join(OUT_DIR, 'PROVENANCE.json'), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`typescript ${PINNED.version}: ${source.length} B -> minified ${minified.length} B -> brotli ${br.length} B`);
console.log(`  -> ${path.relative(process.cwd(), OUT_DIR)} (minified sha256 ${provenance.minified.sha256})`);
