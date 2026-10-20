'use strict';
// Loaded with `node --require` ahead of pcf-inventory.js or verify-pcf.js, for tests/pcf-result-whole-before-exit.test.js: lib/pcf-dataverse.js — the one module through which those scripts reach an org — answers
// FAKE_BIG_ORG_CONTROLS custom controls (helpers/big-results.js controls), or, with FAKE_BIG_ORG_FAILURE, refuses to make the SDK with an error whose message is that many lines (longText). Every other export is the
// real module's. So a script prints a result of megabytes as a process, with no Dataverse and no Azure CLI.
const path = require('node:path');
const { controls, longText } = require('./big-results.js');

const target = require.resolve(path.join(__dirname, '..', '..', 'lib', 'pcf-dataverse.js'));
const real = require(target);
const count = Number(process.env.FAKE_BIG_ORG_CONTROLS || 0);
const failure = Number(process.env.FAKE_BIG_ORG_FAILURE || 0);

// The script's own `require('./lib/pcf-dataverse.js')` resolves to the same file, so it is handed this object from the module cache.
require.cache[target].exports = {
  ...real,
  makePcfSdk: async () => {
    if (failure) throw new Error(longText(failure));
    return {};
  },
  listCustomControls: async () => controls(count),
};
