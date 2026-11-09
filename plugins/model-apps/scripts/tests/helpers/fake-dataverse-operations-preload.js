'use strict';
// Loaded with `node --require` ahead of scripts/list-dataverse-operations.js: makes lib/dataverse-operations.js answer the way a broken or a
// widened catalogue would (FAKE_DV_OPERATIONS names how), so a test reads the listing's OWN check — exactly the reviewed pair, or nothing at all.
// Everything else is the real module. A test requires nothing from this file; with FAKE_DV_OPERATIONS unset it changes nothing.
const path = require('node:path');
const Module = require('node:module');

const mode = process.env.FAKE_DV_OPERATIONS;
const target = path.resolve(__dirname, '..', '..', 'lib', 'dataverse-operations.js');

if (mode === 'unloadable') {
  // The module itself cannot be loaded (a damaged install): its require throws.
  const load = Module._load;
  Module._load = function unloadable(request, parent, isMain) {
    let resolved = null;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      // The real load reports it.
    }
    if (resolved && path.resolve(resolved) === target) throw new SyntaxError('Unexpected end of input');
    return load.apply(this, arguments);
  };
} else if (mode) {
  const real = require(target);
  // structuredClone of the frozen catalogue is an ordinary copy the cases below may change.
  const copy = () => structuredClone(real.getDataverseOperationCatalogue());
  const catalogues = {
    throws: () => { throw new Error('the catalogue could not be read'); },
    missing: undefined,
    widened: () => {
      const catalogue = copy();
      catalogue.operations.push({ ...structuredClone(catalogue.operations[0]), name: 'CalculateRollupField', displayName: 'Calculate rollup field' });
      return catalogue;
    },
    reordered: () => {
      const catalogue = copy();
      catalogue.operations.reverse();
      return catalogue;
    },
    renamed: () => {
      const catalogue = copy();
      catalogue.operations[0].name = 'whoami';
      return catalogue;
    },
    action: () => {
      const catalogue = copy();
      catalogue.operations[0].isFunction = false;
      return catalogue;
    },
    bound: () => {
      const catalogue = copy();
      catalogue.operations[1].bindingType = 'Entity';
      return catalogue;
    },
    inputs: () => {
      const catalogue = copy();
      catalogue.operations[1].parameterKinds = { Target: 'String' };
      return catalogue;
    },
    declared: () => {
      const catalogue = copy();
      catalogue.operations[1].parameters = [{ name: 'Target', type: 'Edm.String' }];
      return catalogue;
    },
    'on-load': () => {
      const catalogue = copy();
      catalogue.operations[0].invocation = 'on-load';
      return catalogue;
    },
    unselected: () => {
      const catalogue = copy();
      catalogue.operations[0].requiresExplicitSelection = false;
      return catalogue;
    },
    unverified: () => {
      const catalogue = copy();
      delete catalogue.verification;
      return catalogue;
    },
    checked: () => {
      const catalogue = copy();
      catalogue.verification.environment = 'checked';
      return catalogue;
    },
    revised: () => {
      const catalogue = copy();
      catalogue.catalogueVersion = 2;
      return catalogue;
    },
    eligible: () => {
      const catalogue = copy();
      catalogue.operations[0].eligible = true;
      return catalogue;
    },
    'no-response': () => {
      const catalogue = copy();
      delete catalogue.operations[1].response;
      return catalogue;
    },
    empty: () => ({ ...copy(), operations: [] }),
    'not-an-object': () => 'WhoAmI,RetrieveVersion',
  };
  if (!Object.prototype.hasOwnProperty.call(catalogues, mode)) throw new Error(`unknown FAKE_DV_OPERATIONS mode: ${mode}`);
  // A script takes its helpers from the module cache when it requires the module, so it is handed this object.
  require.cache[target].exports = { ...real, getDataverseOperationCatalogue: catalogues[mode] };
}
