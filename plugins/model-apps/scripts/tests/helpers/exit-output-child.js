'use strict';
// A REAL PROCESS that prints a result the way every script does — `emitResult`, which exits right after its writes — for tests/result-whole-before-exit.test.js:
//   node [--require ./queued-stdio-preload.js] exit-output-child.js <scenario> [<json parameters>]
// `rows` sets the size: 30,000 rows make a text of about 3.5 MB, far more than a pipe holds at once (64 KiB on Linux); 2 rows make one a pipe takes at once. The texts are built by the functions exported here, so the test
// computes the bytes it expects from the same parameters. Only the plugin's own code prints: `emitResult` and, for `fatal`, the output guard's printer of an error that ends the process (lib/output-redaction.js). It
// requires no test runner: a test runner prints its own report on stdout when the process ends.
const { emitResult, getAuthToken } = require('../../lib/dataverse-auth.js');
const { TOKEN } = require('./synthetic-token.js');

const NOTE = 'The platform answered with a diagnostic that says nothing about credentials.';
// A table of `rows` rows, as a listing or a download summary prints one. `accent` puts characters above U+007E into every row, for the `ascii` option.
const table = (rows, accent = '') => Array.from({ length: rows }, (_, i) => ({ id: i, name: `row ${i}${accent}`, note: NOTE }));
// A text of about the same size, as an error that quotes a service's answer is.
const longText = (rows) => Array.from({ length: rows }, (_, i) => `line ${i}: ${NOTE}`).join(' ');
const ACCENT = ' \u2014 caf\u00e9';

const scenarios = {
  ok: ({ rows }) => emitResult(true, table(rows)),
  ascii: ({ rows }) => emitResult(true, table(rows, ACCENT), { ascii: true }),
  'structured-error': ({ rows }) => emitResult(false, { ok: false, error: longText(rows), rows: table(rows) }),
  'structured-errors': ({ rows }) => emitResult(false, { ok: false, errors: table(rows) }),
  'structured-unexplained': ({ rows }) => emitResult(false, { ok: false, rows: table(rows) }),
  error: ({ rows }) => emitResult(false, new Error(longText(rows))),
  text: ({ rows }) => emitResult(false, longText(rows)),
  // A token obtained the way a script obtains one (which puts the output guard on the process), then an error nothing catches whose message quotes an answer — and the token: the guard prints it, cleaned, and exits with 1.
  fatal: ({ rows }) => {
    if (getAuthToken('https://contoso.crm.dynamics.com', { exec: () => `${TOKEN}\n` }) !== TOKEN) throw new Error('the token was not obtained');
    setTimeout(() => { throw new Error(`${longText(rows)} Rejected bearer ${TOKEN}`); }, 0);
  },
};

if (require.main === module) {
  const [, , name, parameters] = process.argv;
  if (!scenarios[name]) {
    process.stderr.write(`unknown scenario ${name}\n`);
    process.exit(2);
  }
  scenarios[name](parameters ? JSON.parse(parameters) : {});
}

module.exports = { table, longText, ACCENT };
