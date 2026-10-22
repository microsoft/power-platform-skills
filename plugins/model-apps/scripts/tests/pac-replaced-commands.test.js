'use strict';
// scripts/apps.js and scripts/list-tables.js do what `pac model list`, `pac model create` and `pac model list-tables` do, and read and write through
// the bundled SDK. No production script may run one of the three: it would put the Power Platform CLI back in a path the SDK serves, with its own
// sign-in, its own time limits and an output to parse, beside the Azure CLI token every other script reads with.
//
// The scan reads code, not comments (helpers/production-scripts.js scriptsMatching): the scripts say in their comments which command they replace.
const test = require('node:test');
const assert = require('node:assert');
const { scriptsMatching, withoutComments } = require('./helpers/production-scripts.js');

// A script starts pac with a command line in a string (`pac model list --environment …`) or with an argument list (`runPac(['model', 'create', …])`).
// The commands are told from their neighbours by what follows the last word: `list-languages` and `genpage list` are not them.
const COMMAND_LINE = /\bpac\s+model\s+(?:list-tables|list|create)(?![\w-])/;
const ARGUMENT_LIST = /['"]model['"]\s*,\s*['"](?:list-tables|list|create)['"]/;

test('no production script runs `pac model list`, `pac model create` or `pac model list-tables`', () => {
  assert.deepStrictEqual(scriptsMatching(COMMAND_LINE), [], 'a command line');
  assert.deepStrictEqual(scriptsMatching(ARGUMENT_LIST), [], 'an argument list');
});

test('the scan finds every way a script can spell the three commands, and not their neighbours', () => {
  const found = (code) => COMMAND_LINE.test(withoutComments(code)) || ARGUMENT_LIST.test(withoutComments(code));
  for (const code of [
    "run('pac model list --environment x');",
    '`pac model create --name ${name} --solution ${solution}`',
    "spawn('pac', ['model', 'list']);",
    'runPac(["model", "create", "--name", name]);',
    "const args = ['model','list-tables','--search', term];",
    'exec("pac  model   list-tables");',
    "pac model list\nnext();",
  ]) assert.ok(found(code), code);
  for (const code of [
    "run('pac model list-languages --environment x');",
    "run('pac model genpage list --app-id x');",
    "runPac(['model', 'genpage', 'list']);",
    "runPac(['model', 'list-languages']);",
    "runPac(['model', 'genpage', 'upload']);",
    "const s = 'pac model listing';",
    "const s = 'pac model created';",
    "// pac model list\nnext();",
    '/* pac model create --name x */ next();',
    "run('pac auth list');",
  ]) assert.ok(!found(code), code);
});

test('the two scripts name the commands they do the work of in their comments — which the scan does not read — and run no pac themselves', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const [file, commands] of [['apps.js', ['`pac model list`', '`pac model create`']], ['list-tables.js', ['`pac model list-tables']]]) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    for (const command of commands) assert.ok(source.includes(command), `${file} names ${command}, the command whose work it does`);
    assert.ok(!COMMAND_LINE.test(withoutComments(source)) && !ARGUMENT_LIST.test(withoutComments(source)), `${file} runs none of them`);
    assert.ok(!/\brunPac\b|\bspawn\b|execFile|runSync\(/.test(withoutComments(source)), `${file} starts no process at all`);
  }
});
