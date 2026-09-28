// plugins/model-apps/scripts/tests/helpers/fake-auth.js
// Shared piece of the CLI test harnesses that stub lib/dataverse-auth.js.
'use strict';
const realAuth = require('../../lib/dataverse-auth.js');

/**
 * Builds a `validateFlags` stand-in for a harness that cans `parseArgs` to a fixed result.
 *
 * Those harnesses never populate process.argv, so the shipped flag contract would go unexercised —
 * and a hand-written copy of the check inside each harness would be free to drift from the real
 * one. Instead this rebuilds an argv that parses back to the same flags and runs the REAL
 * validateFlags over it, so a CLI whose declared `known` list omits a flag its own tests pass still
 * fails loudly.
 *
 * parseArgs only ever yields boolean `true` (bare flag) or a string, so the two forms below round
 * trip exactly: `true` → `--flag`, anything else → `--flag=value` (which also preserves the empty
 * string that `--flag=` and `--flag ""` both produce).
 *
 * @param {() => object} getFlags  reads the harness's current canned flags object
 * @returns {(argv: string[], contract: object) => string|null}
 */
function validateFlagsFromParsed(getFlags) {
  return (_argv, contract) => {
    const flags = getFlags() || {};
    const argv = [];
    for (const [k, v] of Object.entries(flags)) argv.push(v === true ? `--${k}` : `--${k}=${v}`);
    return realAuth.validateFlags(argv, contract);
  };
}

module.exports = { validateFlagsFromParsed, realAuth };
