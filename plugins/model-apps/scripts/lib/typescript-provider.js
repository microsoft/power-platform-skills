'use strict';
// A TypeScript compiler a caller hands in, in the shape the SDK takes one. The SDK is given its compiler as a FUNCTION that answers the namespace
// (`createMakerSdk({ typescript: () => ts })`: lib/maker-sdk.js, withVendoredCompiler), so a caller may hand that function — the one it gives the SDK — or the
// namespace itself, and both are read here the same way. One reader, so the page preparation (lib/prepare-genpage.js), the structure gate it runs
// (lib/page-structure.js) and the SDK the page backend makes (lib/genpage-sdk.js) take the same caller's compiler, and none of them falls back to the vendored one
// behind the caller's back.
//
// What is checked is only what the plugin calls: the parse (`createSourceFile`, with the `ScriptTarget` and `ScriptKind` enums it is called with) and the transpile
// the SDK compiles a page with. A compiler without them would fail later, in the middle of a page write; refused here, it fails before anything was read or written.
const { genpageError } = require('./page-content.js');

const TYPESCRIPT_PROVIDER_INVALID = 'TYPESCRIPT_PROVIDER_INVALID';

// The namespace `provider` names, or null for no provider (the vendored compiler then stands, loaded lazily where it is first needed).
function resolveTypescriptProvider(provider) {
  if (provider === undefined || provider === null) return null;
  let ts = provider;
  if (typeof provider === 'function') {
    try {
      ts = provider();
    } catch (error) {
      throw genpageError(`the TypeScript provider failed when asked for the compiler: ${error && error.message ? error.message : error}`, { code: TYPESCRIPT_PROVIDER_INVALID, outcome: 'nothing', cause: error });
    }
  }
  const usable = ts !== null && (typeof ts === 'object' || typeof ts === 'function')
    && typeof ts.createSourceFile === 'function' && typeof ts.transpileModule === 'function'
    && ts.ScriptTarget && ts.ScriptKind && ts.ScriptKind.TSX !== undefined;
  if (!usable) {
    throw genpageError('the TypeScript provider is not a TypeScript compiler: it must be the compiler\'s namespace, or a function that answers it, with createSourceFile, transpileModule, ScriptTarget and ScriptKind', { code: TYPESCRIPT_PROVIDER_INVALID, outcome: 'nothing' });
  }
  return ts;
}

// The options one caller's compiler is handed on with, in the two shapes its consumers take — so an orchestration resolves it ONCE and cannot mix
// them up:
//   parse    the page parsers (lib/page-structure.js pageStructure / pageStructureProblems, lib/typescript-views.js) read the NAMESPACE, as `ts`;
//            a function handed there is not a compiler, and the parse would fall back to the lexer's guess and report a valid page as cut off.
//   backend  makeGenpageSdk(env, deps) reads the provider as `typescript` (either shape: it resolves it lazily, when the SDK first compiles);
//            a `ts` key there is ignored, and the page would be compiled by the vendored compiler instead.
// No provider: both are empty objects, so a call that spreads them sends exactly what it sent before, and nothing is resolved or loaded.
function typescriptProviderOptions(provider) {
  const ts = resolveTypescriptProvider(provider);
  if (!ts) return { parse: {}, backend: {} };
  return { parse: { ts }, backend: { typescript: provider } };
}

module.exports = { resolveTypescriptProvider, typescriptProviderOptions, TYPESCRIPT_PROVIDER_INVALID };
