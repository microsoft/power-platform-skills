// plugins/model-apps/scripts/tests/helpers/cli-harness.js
// Loads a model-apps CLI in an isolated VM context with injectable module stubs, so a test can
// drive main() end to end and assert the WIRE CALLS it makes — rather than regex-matching source.
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

/**
 * @param {string} scriptPath  absolute path to the CLI under test
 * @param {object} [opts]
 * @param {object} [opts.requires]  map of require-id → stub module (e.g. './lib/dataverse-auth')
 * @param {string[]} [opts.argv]    args after `node script.js`
 * @param {object} [opts.env]       process.env for the run
 * @returns {{ main: Function, stdout: string[], stderr: string[], exitCode: number|null }}
 */
function loadCli(scriptPath, { requires = {}, argv = [], env = {} } = {}) {
  // The CLIs guard their entry with `if (require.main === module)`, which never fires here — so
  // export main() explicitly instead of relying on that guard to run it.
  const source = `${fs.readFileSync(scriptPath, 'utf8')}\nmodule.exports.__mainForTest = typeof main === 'function' ? main : undefined;\n`;
  const stdout = [];
  const stderr = [];
  const state = { exitCode: null };
  const mod = { exports: {} };

  const customRequire = (id) => {
    // Match on the id as written in the script, tolerating the optional .js suffix so a stub
    // registered as './lib/dataverse-auth' also satisfies `require('./lib/dataverse-auth.js')`.
    if (Object.prototype.hasOwnProperty.call(requires, id)) return requires[id];
    const noExt = id.replace(/\.js$/, '');
    if (Object.prototype.hasOwnProperty.call(requires, noExt)) return requires[noExt];
    if (id.startsWith('.')) return require(path.resolve(path.dirname(scriptPath), id));
    return require(id);
  };

  // process.exit must abort the CLI the way the real one does, so a test can prove that nothing
  // after a usage error ran. A plain return would let execution continue and silently pass.
  const sandboxProcess = {
    argv: ['node', scriptPath, ...argv],
    env,
    platform: process.platform,
    execPath: process.execPath,
    exitCode: undefined,
    exit: (code) => {
      state.exitCode = code;
      const err = new Error(`process.exit(${code})`);
      err.exitCode = code;
      throw err;
    },
    stdout: { write: (s) => { stdout.push(String(s)); return true; } },
    stderr: { write: (s) => { stderr.push(String(s)); return true; } },
  };

  // compileFunction — NOT runInNewContext. A new VM context is a separate realm with its own
  // Array/Object prototypes, so every array the script builds would fail assert.deepStrictEqual
  // against a host array with "same structure but not reference-equal". Compiling the module body
  // as a function in the CURRENT realm keeps the intrinsics shared, and shadowing `process` via a
  // parameter still isolates the CLI's exit/stdout/stderr.
  const fn = vm.compileFunction(source, ['require', 'module', 'exports', 'process'], { filename: scriptPath });
  fn(customRequire, mod, mod.exports, sandboxProcess);

  return {
    exports: mod.exports,
    main: mod.exports.__mainForTest,
    stdout,
    stderr,
    get exitCode() { return state.exitCode; },
    stdoutText: () => stdout.join(''),
    stderrText: () => stderr.join(''),
  };
}

module.exports = { loadCli };
