'use strict';
// The bundled SDK as every script makes it: the vendored bundle (vendor/cds-maker-sdk.cjs) with the vendored TypeScript compiler
// (lib/typescript-compiler.js) as its generative-page compiler.
//
// The SDK compiles a page's source itself whenever a push changes it, and without a compiler it refuses that push before
// writing anything (GENPAGE_COMPILER_UNAVAILABLE). Its bundle holds no TypeScript (the host passes one in through
// `MakerSdkOptions.typescript`), so every instance a script makes is given the vendored one here — lazily: it is unpacked and
// evaluated only when a page is compiled, so an instance that never compiles one pays nothing. Scripts require this module, never
// the bundle itself, so no instance can be made without it (tests/maker-sdk.test.js scans for a direct require). A caller can
// still pass its own `typescript` (a test's fake): an explicit option wins.
const bundle = require('../vendor/cds-maker-sdk.cjs');
const { loadVendoredTypeScript } = require('./typescript-compiler.js');

// `create` given the vendored compiler unless the options name one (a seam for the test: the bundle's own exports are read-only).
function withVendoredCompiler(create) {
  return (options) => create({ typescript: () => loadVendoredTypeScript(), ...options });
}

module.exports = { ...bundle, createMakerSdk: withVendoredCompiler(bundle.createMakerSdk), withVendoredCompiler };
