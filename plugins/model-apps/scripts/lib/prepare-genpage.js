'use strict';
// Prepare a generative page WITHOUT deploying it: read what a page write would take — its source, its settings (the table list and the model), its bindings,
// the navigation it declares, and the RuntimeTypes the caller supplies — check it as the write would, and answer exact hashes of each with what the checks found.
// Nothing is read from or written to a service or the disk, nothing is approved and nothing is deployed: the answer is the input to a later, separate write.
//
// WHY. The page backend (lib/genpage-sdk.js) checks and hashes a page inside its create and update, with the vendored compiler, after it has made a workspace on
// disk. A host that only wants to know "is this page ready, and which exact content is it" — the standalone page flow and the app builder alike, before they
// ask anyone to approve a write — had to run a write to find out. This is that preparation, alone, and it is the same preparation: the content hash is the one
// create and update answer for the same fields (lib/page-content.js, contentFingerprint), so an approval recorded against it names the content a later write
// sends, and a write of different content does not match it.
//
// THE COMPILER. `deps.typescript` is a compiler in the shape the SDK takes one (lib/typescript-provider.js: the namespace, or a function that answers it). Given
// one, every parse here is that compiler's — the structure gate's (lib/page-structure.js, through typescript-views.js, which keeps its views apart per compiler)
// and the parse check below — and the vendored compiler is never loaded. Given none, the vendored compiler is loaded lazily, exactly as before, where it is first
// needed. No provider is set globally: a call's compiler is that call's. This module and the modules it requires need no file system at load (the vendored
// compiler, which reads its own files to check their provenance, is required only on the default path), so it can run where there is none.
//
// WHAT IT DOES NOT CLAIM. The RuntimeTypes of a page's tables come only from the caller: prepare reads no live metadata, and invents none for a table that does
// not exist yet. A page that names tables without supplied types is prepared with a warning that its use of them was not checked here (the write reads them).
// The compiled output is not produced: the SDK compiles with its own options at write time, so a compiled hash from here would be a second definition of it.
const { sha256 } = require('./hash.js');
const { genpageError, contentFieldsOf, contentFingerprint } = require('./page-content.js');
const { pageStructure } = require('./page-structure.js');
const { PAGE_NESTING_TOO_DEEP, PAGE_NESTING_MESSAGE, isStackOverflow } = require('./page-nesting.js');
const { resolveTypescriptProvider } = require('./typescript-provider.js');
const { stableStringify } = require('./phase-diff.js');

// The version of the preparation's answer: a later definition of any hash below changes it, so a stored answer is never compared with one made differently.
const PREPARE_VERSION = 'genpage-prepare/1';
const CONFIG_KEYS = ['dataSources', 'model'];
const BINDING_KEYS = ['connectorBindings', 'actionBindings'];
const INPUT_KEYS = new Set(['source', 'name', 'config', 'bindings', 'navigation', 'runtimeTypes']);
// A value an answer's hash can name exactly: JSON's own values, nested no deeper than any declaration a page has. A function, a symbol, a bigint, a non-finite number
// or a cycle has no JSON text, so it would hash as something it is not (stableStringify writes `null` for each).
const MAX_JSON_DEPTH = 64;

function isPlainJson(value, depth = 0) {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isPlainJson(item, depth + 1));
  if (typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).every((item) => isPlainJson(item, depth + 1));
}

const hashOf = (label, value) => sha256(`${label}\n${stableStringify(value)}`);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

// The diagnostics of TypeScript's parse of `text`, as { line, column, message } (1-based), or a thrown error. `kind` is the parse's (TSX for the page, TS for the
// declarations the RuntimeTypes are).
function parseDiagnostics(ts, fileName, text, kind) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  return (sf.parseDiagnostics || []).map((d) => {
    const at = sf.getLineAndCharacterOfPosition(d.start || 0);
    const message = typeof ts.flattenDiagnosticMessageText === 'function' ? ts.flattenDiagnosticMessageText(d.messageText, '\n') : String(d.messageText);
    return { line: at.line + 1, column: at.character + 1, message };
  });
}

/**
 * Prepare a page: check it as a write would and hash what a write would send, without writing.
 * @param {{ source: string|Uint8Array, name?: string, config?: { dataSources?: string|string[], model?: string },
 *   bindings?: { connectorBindings?: object[], actionBindings?: object[] }, navigation?: object|object[], runtimeTypes?: string }} input
 * @param {{ typescript?: object|Function }} [deps] `typescript`: the compiler to check with, in the SDK's shape (lib/typescript-provider.js); the vendored one otherwise
 * @returns {Readonly<{ ok: boolean, version: string, compiler: { source: 'injected'|'vendored', version: string|null },
 *   hashes: { source: string|null, content: string|null, config: string|null, bindings: string|null, navigation: string|null, runtimeTypes: string|null },
 *   runtimeTypes: { state: 'supplied'|'not-supplied' }, diagnostics: Array<{ severity: 'error'|'warning', code: string, message: string }>, writes: 0 }>}
 */
function prepareGenpage(input, deps = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw genpageError('prepareGenpage takes an object: { source, name?, config?, bindings?, navigation?, runtimeTypes? }', { code: 'PREPARE_INPUT_INVALID', outcome: 'nothing' });
  }
  // A key the preparation does not read would be content nobody checked or hashed, and an approval of the answer would seem to cover it.
  const unknown = Object.keys(input).filter((key) => !INPUT_KEYS.has(key));
  if (unknown.length) {
    throw genpageError(`prepareGenpage does not take ${unknown.map((key) => `'${key}'`).join(', ')}: it takes source, name, config, bindings, navigation and runtimeTypes`, { code: 'PREPARE_INPUT_INVALID', outcome: 'nothing' });
  }
  const injected = resolveTypescriptProvider(deps && deps.typescript);
  const diagnostics = [];
  const add = (severity, code, message, extra = {}) => diagnostics.push({ severity, code, message, ...extra });
  const hashes = { source: null, content: null, config: null, bindings: null, navigation: null, runtimeTypes: null };

  const group = (value, keys, label) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
      add('error', 'PREPARE_INPUT_INVALID', `${label} must be an object with ${keys.join(' and ')}`);
      return undefined;
    }
    const extra = Object.keys(value).filter((key) => !keys.includes(key));
    if (extra.length) add('error', 'PREPARE_INPUT_INVALID', `${label} does not take ${extra.map((key) => `'${key}'`).join(', ')}: it takes ${keys.join(' and ')}`);
    return value;
  };
  const config = group(input.config, CONFIG_KEYS, 'config');
  const bindings = group(input.bindings, BINDING_KEYS, 'bindings');

  // The content as create and update normalize it (contentFieldsOf): a source that is no UTF-8 text, or a binding that is no list, is refused with the code the write refuses it with.
  let fields = null;
  if (config !== undefined && bindings !== undefined) {
    try {
      fields = contentFieldsOf({
        source: input.source,
        name: input.name,
        dataSources: config ? config.dataSources : undefined,
        model: config ? config.model : undefined,
        connectorBindings: bindings ? bindings.connectorBindings : undefined,
        actionBindings: bindings ? bindings.actionBindings : undefined,
      });
    } catch (error) {
      if (!error || typeof error.code !== 'string') throw error;
      add('error', error.code, error.message);
    }
  }
  if (fields) {
    hashes.source = sha256(fields.source);
    hashes.content = contentFingerprint(fields);
    if (config) hashes.config = hashOf('genpage-prepare-config/1', { dataSources: fields.dataSources ?? null, model: fields.model ?? null });
    if (bindings) {
      const lists = { connectorBindings: fields.connectorBindings ?? null, actionBindings: fields.actionBindings ?? null };
      if (isPlainJson(lists)) hashes.bindings = hashOf('genpage-prepare-bindings/1', lists);
      else add('error', 'PREPARE_INPUT_INVALID', 'bindings must hold only JSON values (objects, arrays, text, finite numbers, true, false, null)');
    }
  }

  if (input.navigation !== undefined && input.navigation !== null) {
    if (isPlainJson(input.navigation) && typeof input.navigation === 'object') hashes.navigation = hashOf('genpage-prepare-navigation/1', input.navigation);
    else add('error', 'PREPARE_INPUT_INVALID', 'navigation must be a JSON object or list');
  }

  // The compiler: the caller's, or the vendored one, required here and not at the top (THE COMPILER, above). A vendored compiler that cannot be loaded (its provenance
  // check failed) checks nothing, and the page is not ready: the write would fail on it too.
  let ts = injected;
  if (!ts) {
    try {
      ts = require('./typescript-compiler.js').loadVendoredTypeScript();
    } catch (error) {
      add('error', 'PAGE_COMPILER_UNAVAILABLE', `the TypeScript compiler could not be loaded, so the page could not be checked: ${error && error.message ? error.message : error}`);
      ts = null;
    }
  }

  if (fields) {
    // The structure gate both page gates run (lib/page-structure.js), with this call's compiler settling where the lexer guessed.
    const structure = pageStructure(fields.source, { ts: injected });
    if (structure.code === PAGE_NESTING_TOO_DEEP) add('error', PAGE_NESTING_TOO_DEEP, PAGE_NESTING_MESSAGE);
    else for (const problem of structure.problems) add('error', 'PAGE_STRUCTURE_INVALID', problem);
    if (ts && structure.code !== PAGE_NESTING_TOO_DEEP) {
      try {
        for (const d of parseDiagnostics(ts, 'page.tsx', fields.source, ts.ScriptKind.TSX)) add('error', 'PAGE_PARSE_FAILED', d.message, { line: d.line, column: d.column });
      } catch (error) {
        if (isStackOverflow(error)) add('error', PAGE_NESTING_TOO_DEEP, PAGE_NESTING_MESSAGE);
        else add('error', 'PAGE_PARSE_UNREADABLE', `the compiler could not parse the page: ${error && error.message ? error.message : error}`);
      }
    }
  }

  const runtimeTypes = { state: 'not-supplied' };
  if (input.runtimeTypes !== undefined && input.runtimeTypes !== null) {
    runtimeTypes.state = 'supplied';
    if (typeof input.runtimeTypes !== 'string') {
      add('error', 'PREPARE_RUNTIME_TYPES_INVALID', 'runtimeTypes must be the text of the RuntimeTypes declarations');
    } else {
      hashes.runtimeTypes = sha256(input.runtimeTypes);
      if (ts) {
        try {
          for (const d of parseDiagnostics(ts, 'RuntimeTypes.d.ts', input.runtimeTypes, ts.ScriptKind.TS)) {
            add('error', 'PREPARE_RUNTIME_TYPES_INVALID', `RuntimeTypes: ${d.message}`, { line: d.line, column: d.column });
          }
        } catch (error) {
          add('error', 'PREPARE_RUNTIME_TYPES_INVALID', `the compiler could not parse the RuntimeTypes: ${error && error.message ? error.message : error}`);
        }
      }
    }
  } else if (fields && fields.dataSources && fields.dataSources.length) {
    // Never invented, and never fetched: the tables may not exist yet, and prepare reads nothing live.
    add('warning', 'PREPARE_RUNTIME_TYPES_NOT_SUPPLIED', `no RuntimeTypes were supplied for ${fields.dataSources.join(', ')}, so the page's use of those tables is not checked here — the write reads their metadata when it runs`);
  }

  return deepFreeze({
    ok: !diagnostics.some((d) => d.severity === 'error'),
    version: PREPARE_VERSION,
    compiler: { source: injected ? 'injected' : 'vendored', version: ts && typeof ts.version === 'string' ? ts.version : null },
    hashes,
    runtimeTypes,
    diagnostics,
    writes: 0,
  });
}

module.exports = { prepareGenpage, PREPARE_VERSION };
