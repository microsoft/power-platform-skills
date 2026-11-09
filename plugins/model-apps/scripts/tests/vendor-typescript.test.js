'use strict';
// Guards the vendored TypeScript compiler (scripts/vendor/typescript/, built by _vendor-build/build-typescript.js) that the
// bundled SDK compiles generative pages with (lib/typescript-compiler.js). The SDK accepts only the maker portal's minor
// version (5.8) and compiles a page as the portal does, so what matters is that the vendored file IS the official
// typescript@5.8.3 compiler, only minified:
//   - every committed byte matches PROVENANCE.json, which pins the npm tarball and the source file it came from;
//   - it loads as 5.8.3, once, and a copy that does not match its provenance is refused before it is evaluated;
//   - evaluated as a plain script it leaves `ts` (a host may load it that way; the minify must be done as a SCRIPT);
//   - it emits exactly what the OFFICIAL compiler emits for representative pages, with the options the SDK compiles with
//     (fixtures/vendored-typescript/*.expected.js were produced by the unminified npm package), and its checker works.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { loadVendoredTypeScript, VENDOR_DIR } = require('../lib/typescript-compiler.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'vendored-typescript');
const provenance = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, 'PROVENANCE.json'), 'utf8'));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
// Fixtures are pure LF; a CRLF checkout (core.autocrlf) is normalised back, which is lossless for them.
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8').replace(/\r\n/g, '\n');

test('every vendored byte matches its provenance, which pins the official typescript@5.8.3 package', () => {
  assert.strictEqual(provenance.package, 'typescript');
  assert.strictEqual(provenance.version, '5.8.3', 'the SDK accepts only the maker portal\'s minor version');
  assert.match(provenance.tarball.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  assert.match(provenance.source.sha256, /^[0-9a-f]{64}$/);
  const br = fs.readFileSync(path.join(VENDOR_DIR, 'typescript.min.js.br'));
  assert.strictEqual(sha256(br), provenance.brotli.sha256, 'the committed brotli file');
  assert.strictEqual(br.length, provenance.brotli.bytes);
  const minified = zlib.brotliDecompressSync(br);
  assert.strictEqual(sha256(minified), provenance.minified.sha256, 'the compiler it unpacks to');
  assert.strictEqual(minified.length, provenance.minified.bytes);
  assert.match(minified.toString('utf8', 0, 4000), /Copyright \(c\) Microsoft Corporation/, 'the license header is kept in the file');
  // Apache-2.0: the license and the third-party notices ship beside the compiler, as the npm package carries them.
  assert.match(fs.readFileSync(path.join(VENDOR_DIR, 'LICENSE.txt'), 'utf8'), /Apache License\s+Version 2\.0/);
  assert.ok(fs.statSync(path.join(VENDOR_DIR, 'ThirdPartyNoticeText.txt')).size > 0);
  assert.deepStrictEqual(provenance.esbuild.options, { loader: 'js', minify: true, target: 'es2019', legalComments: 'inline' },
    'minified as a SCRIPT (no `format`): as a module esbuild renames the top-level `var ts`');
});

test('the vendored compiler loads as typescript 5.8.3, once', () => {
  const ts = loadVendoredTypeScript();
  assert.strictEqual(ts.version, '5.8.3');
  assert.strictEqual(typeof ts.transpileModule, 'function');
  assert.strictEqual(typeof ts.createProgram, 'function');
  assert.strictEqual(loadVendoredTypeScript(), ts, 'evaluated once per process');
});

test('a vendored compiler that does not match its provenance is refused before it is evaluated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendored-ts-'));
  try {
    for (const f of fs.readdirSync(VENDOR_DIR)) fs.copyFileSync(path.join(VENDOR_DIR, f), path.join(dir, f));
    // A compiler whose code was changed: it still evaluates, so only the hash check can stop it — and it must stop it before
    // the code runs (the flag would be set if it ran).
    const tampered = `globalThis.__vendoredTsRan = true;\n${zlib.brotliDecompressSync(fs.readFileSync(path.join(VENDOR_DIR, 'typescript.min.js.br'))).toString('utf8')}`;
    fs.writeFileSync(path.join(dir, 'typescript.min.js.br'), zlib.brotliCompressSync(Buffer.from(tampered, 'utf8'), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1 } }));
    assert.throws(() => loadVendoredTypeScript({ dir }), /does not match its provenance \(sha256 [0-9a-f]{64}, expected [0-9a-f]{64}\)/);
    assert.strictEqual(globalThis.__vendoredTsRan, undefined, 'the refused code never ran');
    // A missing file is a plain failure too — never a fallback to some other compiler.
    fs.rmSync(path.join(dir, 'typescript.min.js.br'));
    assert.throws(() => loadVendoredTypeScript({ dir }), /ENOENT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('evaluated as a plain script, the vendored compiler leaves `ts` (it was minified as a script, not a module)', () => {
  const code = zlib.brotliDecompressSync(fs.readFileSync(path.join(VENDOR_DIR, 'typescript.min.js.br'))).toString('utf8');
  const context = vm.createContext({});
  vm.runInContext(code, context, { filename: 'typescript.min.js' });
  assert.strictEqual(context.ts && context.ts.version, '5.8.3');
});

test('the vendored compiler emits exactly what the official compiler emits, with the options the SDK compiles pages with', () => {
  const ts = loadVendoredTypeScript();
  // The maker portal's transpile (and the SDK's): transpileModule with { module: ES2020, jsx: React }, the target left at the
  // default. The expected files were written by the unminified typescript@5.8.3 npm package with these same options.
  const options = { compilerOptions: { module: ts.ModuleKind.ES2020, jsx: ts.JsxEmit.React } };
  const pages = fs.readdirSync(FIXTURES).filter((n) => n.endsWith('.tsx')).sort();
  assert.deepStrictEqual(pages, ['async-data.tsx', 'enums.tsx', 'plain.tsx']);
  for (const page of pages) {
    const out = ts.transpileModule(readFixture(page), { ...options, fileName: page, reportDiagnostics: true });
    assert.deepStrictEqual(out.diagnostics, [], `${page}: no syntax diagnostics`);
    assert.strictEqual(out.outputText, readFixture(page.replace(/\.tsx$/, '.expected.js')), `${page}: byte for byte`);
  }
});

test('the vendored compiler\'s type checker resolves names, as the SDK\'s enum checks need', () => {
  const ts = loadVendoredTypeScript();
  // A one-file program with no lib, as the SDK builds one to resolve the enum members a page uses.
  const files = {
    'page.ts': 'declare const lvt_ticket_lvt_priority: { readonly Low: 1; readonly High: 3 };\nexport const high = lvt_ticket_lvt_priority.High;\nexport const wrong: string = lvt_ticket_lvt_priority.Low;\n',
  };
  const host = {
    getSourceFile: (name, target) => (files[name] === undefined ? undefined : ts.createSourceFile(name, files[name], target, true)),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '',
    getDirectories: () => [],
    fileExists: (name) => files[name] !== undefined,
    readFile: (name) => files[name],
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const program = ts.createProgram(['page.ts'], { noLib: true, noEmit: true, strict: true }, host);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile('page.ts');
  let highType = null;
  ts.forEachChild(source, function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'high') highType = checker.typeToString(checker.getTypeAtLocation(node.name));
    ts.forEachChild(node, visit);
  });
  assert.strictEqual(highType, '3', 'the member resolves to its literal value');
  const semantic = program.getSemanticDiagnostics(source).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  assert.deepStrictEqual(semantic, ["Type 'number' is not assignable to type 'string'."], 'and a wrong use is reported');
});
