'use strict';
// scripts/solution-settings.js — deployment settings for a solution: the CLI contract, the checks made before any request, the SDK calls and
// pac's defaults, which refusals fall back to pac and which do not, the long-running-action client, and what the sanitizer keeps out of what is printed (and what it leaves).
// The SDK and pac are stood in for here; tests/solution-settings-real-bundle.test.js drives the real bundle and the real script.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadCli } = require('./helpers/cli-harness.js');
const realAuth = require('../lib/dataverse-auth.js');

const SCRIPT = path.resolve(__dirname, '..', 'solution-settings.js');
const ss = require(SCRIPT);

const ENV = 'https://contoso.crm.dynamics.com';
const SECRET = 'kv-secret-value-0123456789';
// A value of a variable that is not secret (a text variable), beside it.
const PLAIN = 'plain-value-0123456789';
const CONNECTION_ID = 'shared-commondataser-00000000-0000-0000-0000-00000000abcd';
const JOB = '44444444-4444-4444-8444-444444444444';

const tempDirs = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solution-settings-test-'));
  tempDirs.push(dir);
  return dir;
};
test.after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }); });

const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(' a solution package')]);
function files(dir) {
  const pkg = path.join(dir, 'solution.zip');
  fs.writeFileSync(pkg, ZIP);
  return { pkg, out: path.join(dir, 'settings.json'), settings: path.join(dir, 'filled.json') };
}

const template = (extra = {}) => ({
  EnvironmentVariables: [{ SchemaName: 'new_Url', Value: '', DefaultValue: 'https://default.example', TypeId: 100000000, IsRequired: false }],
  ConnectionReferences: [{ LogicalName: 'new_Dataverse', ConnectionId: '', ConnectorId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps' }],
  ...extra,
});
const filled = () => template({
  EnvironmentVariables: [{ SchemaName: 'new_Url', Value: SECRET, DefaultValue: 'https://default.example', TypeId: 100000005, IsRequired: false }],
  ConnectionReferences: [{ LogicalName: 'new_Dataverse', ConnectionId: CONNECTION_ID, ConnectorId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps' }],
});
// The same file with a variable that is not secret: a message that quotes its value, or the connection id, is shown with them replaced.
const filledPlain = () => template({
  EnvironmentVariables: [{ SchemaName: 'new_Url', Value: PLAIN, DefaultValue: 'https://default.example', TypeId: 100000000, IsRequired: false }],
  ConnectionReferences: [{ LogicalName: 'new_Dataverse', ConnectionId: CONNECTION_ID, ConnectorId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps' }],
});

// A stand-in for lib/sdk-first.js's sdkFirst that applies the rule with the plan's OWN refusal: the SDK's answer, or a refusal → pac, or the failure.
const stubSdkFirst = (sdk, record = []) => async (env, plan) => {
  record.push({ env, plan });
  try {
    return { source: 'sdk', value: await plan.fromSdk(sdk) };
  } catch (error) {
    const refusal = plan.refusal(error);
    if (!refusal) throw error;
    return { source: 'pac', value: await plan.fromPac(refusal), fallback: refusal };
  }
};
const refusal = (code, message = `${code} words`) => Object.assign(new Error(message), { code });

// A pac that records its calls. `onCall(args)` may write the file pac would write and answers the result.
function fakePac(onCall) {
  const calls = [];
  return { calls, pac: { spawn: (name, args, options) => { calls.push({ name, args, options }); return onCall(args, options); } } };
}
const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

// --- arguments ----------------------------------------------------------------------------------------------------------------------

test('template: three forms — a solution to export, a package to stage, a package to read with pac — and import needs all three of its flags', () => {
  const a = ss.readRequest(['template', '--env', ENV, '--solution', 'ContosoDemo', '--out', 'out.json']).request;
  assert.deepStrictEqual({ ...a, outPath: path.basename(a.outPath) }, { command: 'template', env: ENV, solution: 'ContosoDemo', packagePath: undefined, outPath: 'out.json', force: false });
  const b = ss.readRequest(['template', '--env', `${ENV}/`, '--package', 'p.zip', '--out', 'out.json', '--force']).request;
  assert.strictEqual(b.env, ENV, 'the origin');
  assert.strictEqual(b.force, true);
  assert.strictEqual(path.basename(b.packagePath), 'p.zip');
  assert.ok(path.isAbsolute(b.packagePath) && path.isAbsolute(b.outPath), 'paths are resolved once, here');
  const c = ss.readRequest(['template', '--package', 'p.zip', '--out', 'out.json']).request;
  assert.strictEqual(c.env, undefined);
  const d = ss.readRequest(['import', '--env', ENV, '--package', 'p.zip', '--settings', 's.json']).request;
  assert.deepStrictEqual([d.command, d.env, path.basename(d.packagePath), path.basename(d.settingsPath)], ['import', ENV, 'p.zip', 's.json']);
});

test('a command is required, and is template or import', () => {
  assert.match(ss.readRequest([]).error, /a command is required: template or import/);
  assert.match(ss.readRequest(['export']).error, /unknown command 'export': use template or import/);
});

test('template: name a solution or a package — one of the two — and a solution needs the environment it is exported from', () => {
  assert.match(ss.readRequest(['template', '--env', ENV, '--out', 'o.json']).error, /name the solution to export with --solution, or a package with --package — one of the two/);
  assert.match(ss.readRequest(['template', '--env', ENV, '--solution', 'Demo', '--package', 'p.zip', '--out', 'o.json']).error, /one of the two/);
  assert.match(ss.readRequest(['template', '--solution', 'Demo', '--out', 'o.json']).error, /--solution needs --env/);
  assert.match(ss.readRequest(['template', '--env', ENV, '--solution', 'Demo']).error, /--out is required/);
  for (const bad of ['1Demo', 'Demo-App', 'Demo App', 'Demo;x', '', 'x'.repeat(66), '../x']) {
    assert.ok(ss.readRequest(['template', '--env', ENV, '--solution', bad || ' ', '--out', 'o.json']).error, JSON.stringify(bad));
  }
  assert.match(ss.readRequest(['template', '--env', ENV, '--solution', 'Demo-App', '--out', 'o.json']).error, /--solution must be a solution's unique name/);
});

test('import: every flag is required', () => {
  assert.match(ss.readRequest(['import', '--package', 'p.zip', '--settings', 's.json']).error, /--env is required/);
  assert.match(ss.readRequest(['import', '--env', ENV, '--settings', 's.json']).error, /--package is required/);
  assert.match(ss.readRequest(['import', '--env', ENV, '--package', 'p.zip']).error, /--settings is required/);
});

test('an environment that is not a Dataverse origin is refused before any file is read or request sent — in both commands', () => {
  for (const bad of ['https://contoso.example.com', 'http://contoso.crm.dynamics.com', `${ENV}/api/data/v9.2`, 'contoso']) {
    assert.match(ss.readRequest(['import', '--env', bad, '--package', 'p.zip', '--settings', 's.json']).error, /is not a Dataverse environment URL/, bad);
    assert.match(ss.readRequest(['template', '--env', bad, '--package', 'p.zip', '--out', 'o.json']).error, /is not a Dataverse environment URL/, bad);
  }
});

test('flags are validated up front: an unknown one (with the nearest name), a missing value, the other command\'s flag, extra arguments', () => {
  assert.match(ss.readRequest(['template', '--env', ENV, '--solutionn', 'x', '--out', 'o.json']).error, /unknown flag\(s\): --solutionn \(did you mean --solution\?\)/);
  assert.match(ss.readRequest(['template', '--env', ENV, '--solution', 'Demo', '--out']).error, /--out requires a value/);
  assert.match(ss.readRequest(['template', '--env', ENV, '--solution', 'Demo', '--out', 'o.json', '--settings', 's.json']).error, /unknown flag\(s\): --settings/);
  assert.match(ss.readRequest(['import', '--env', ENV, '--package', 'p.zip', '--settings', 's.json', '--force']).error, /unknown flag\(s\): --force/);
  assert.match(ss.readRequest(['import', '--env', ENV, '--package', 'p.zip', '--settings', 's.json', '--solution', 'x']).error, /unknown flag\(s\): --solution/);
  assert.match(ss.readRequest(['template', 'extra', '--env', ENV, '--solution', 'Demo', '--out', 'o.json']).error, /unexpected argument 'extra'/);
});

test('--force is a switch: it takes no value, and a value after it is an error rather than swallowed', () => {
  assert.match(ss.readRequest(['template', '--env', ENV, '--solution', 'Demo', '--force', 'o.json']).error, /--force takes no value \(got 'o\.json'\)/);
  assert.match(ss.readRequest(['template', '--env', ENV, '--solution', 'Demo', '--out', 'o.json', '--force=yes']).error, /--force takes no value/);
  assert.strictEqual(ss.readRequest(['template', '--env', ENV, '--solution', 'Demo', '--out', 'o.json', '--force']).request.force, true);
  assert.strictEqual(ss.readRequest(['template', '--force', '--env', ENV, '--solution', 'Demo', '--out', 'o.json']).request.force, true);
});

// --- the settings file --------------------------------------------------------------------------------------------------------------

test('a settings file is what pac writes: lists of entries with a name and a value; pac\'s own file and this script\'s both pass', () => {
  assert.strictEqual(ss.settingsProblem(template()), null);
  assert.strictEqual(ss.settingsProblem(filled()), null);
  // What `pac solution create-settings` 2.12 writes — display names, an empty CopilotAgents list — is accepted.
  assert.strictEqual(ss.settingsProblem({
    EnvironmentVariables: [{ SchemaName: 'x_a', Value: '', DefaultValue: 'd', Name: { Default: 'A', ByLcid: { 1033: 'A' } }, TypeId: 100000000, IsRequired: false }],
    ConnectionReferences: [{ LogicalName: 'x_cr', ConnectionId: '', ConnectorId: '/providers/Microsoft.PowerApps/apis/shared_sql' }],
    CopilotAgents: [],
  }), null);
  assert.strictEqual(ss.settingsProblem({ EnvironmentVariables: [] }), null, 'one list is enough');
  assert.strictEqual(ss.settingsProblem({ ConnectionReferences: [] }), null);
});

test('a file that is not that shape is named, entry and field, in words that never quote a value', () => {
  const cases = [
    [null, /one JSON object/],
    [[], /one JSON object/],
    ['text', /one JSON object/],
    [{}, /neither an "EnvironmentVariables" nor a "ConnectionReferences" list/],
    [{ Other: [] }, /neither/],
    [{ EnvironmentVariables: {} }, /"EnvironmentVariables" must be a list/],
    [{ ConnectionReferences: 'x' }, /"ConnectionReferences" must be a list/],
    [{ EnvironmentVariables: ['x'] }, /EnvironmentVariables\[0\] must be an object/],
    [{ EnvironmentVariables: [{ Value: 'x' }] }, /EnvironmentVariables\[0\]\.SchemaName must be a non-empty string/],
    [{ EnvironmentVariables: [{ SchemaName: '', Value: '' }] }, /SchemaName must be a non-empty string/],
    [{ EnvironmentVariables: [{ SchemaName: ' a ', Value: '' }] }, /SchemaName must not begin or end with white space/],
    [{ EnvironmentVariables: [{ SchemaName: 'a' }] }, /EnvironmentVariables\[0\]\.Value must be a string — empty to leave the entry unset/],
    [{ EnvironmentVariables: [{ SchemaName: 'a', Value: 5 }] }, /Value must be a string/],
    [{ EnvironmentVariables: [{ SchemaName: 'a', Value: { x: 1 } }] }, /Value must be a string/],
    [{ ConnectionReferences: [{ LogicalName: 'a' }] }, /ConnectionReferences\[0\]\.ConnectionId must be a string/],
    [{ ConnectionReferences: [{ LogicalName: 'a', ConnectionId: ' x' }] }, /ConnectionId must not begin or end with white space/],
    [{ ConnectionReferences: [{ ConnectionId: '' }] }, /ConnectionReferences\[0\]\.LogicalName must be a non-empty string/],
    [{ EnvironmentVariables: [{ SchemaName: 'ok', Value: '' }, { SchemaName: 'b', Value: 12 }] }, /EnvironmentVariables\[1\]\.Value/],
  ];
  for (const [settings, message] of cases) {
    const problem = ss.settingsProblem(settings);
    assert.match(problem, message, JSON.stringify(settings));
  }
  // The problem text never holds what was in the field: a settings file can hold a secret.
  const secret = { EnvironmentVariables: [{ SchemaName: 'new_Secret', Value: { vault: SECRET } }, { SchemaName: 'x', Value: '' }] };
  assert.ok(!ss.settingsProblem(secret).includes(SECRET), ss.settingsProblem(secret));
  const padded = { ConnectionReferences: [{ LogicalName: 'a', ConnectionId: ` ${CONNECTION_ID}` }] };
  assert.ok(!ss.settingsProblem(padded).includes(CONNECTION_ID));
});

test('an environment variable\'s value is TEXT and passes through byte for byte — leading and trailing white space, a JSON document that ends in a newline, a value made of white space alone — while identifiers keep their checks', () => {
  const values = [' leading', 'trailing ', '  both  ', ' {\n  "feature": true\n}\n', '{"a":1}\n', '   ', '\t', '\n', ' \u00a0 ', 'line one\nline two\r\n'];
  for (const Value of values) {
    assert.strictEqual(ss.settingsProblem({ EnvironmentVariables: [{ SchemaName: 'new_Text', Value }] }), null, JSON.stringify(Value));
    // Through the whole parse as well, and nothing in the entry changes on the way: what the file holds is what the environment gets.
    const parsed = ss.parseSettings(JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'new_Text', Value }] }), 'f');
    assert.strictEqual(parsed.EnvironmentVariables[0].Value, Value, JSON.stringify(Value));
  }
  // A value of white space alone is FILLED (the SDK sends it: it only skips an empty string), so it is named among the entries the file fills.
  assert.deepStrictEqual(ss.filledNames({ EnvironmentVariables: [{ SchemaName: 'new_Text', Value: '   ' }, { SchemaName: 'new_Empty', Value: '' }] }), { environmentVariables: ['new_Text'], connectionReferences: [] });
  // The identifiers keep their checks: a name or a connection id with white space around it is a mistake the SDK refuses too.
  assert.match(ss.settingsProblem({ EnvironmentVariables: [{ SchemaName: ' new_Text', Value: 'x' }] }), /SchemaName must not begin or end with white space/);
  assert.match(ss.settingsProblem({ ConnectionReferences: [{ LogicalName: 'new_ref ', ConnectionId: '' }] }), /LogicalName must not begin or end with white space/);
  assert.match(ss.settingsProblem({ ConnectionReferences: [{ LogicalName: 'new_ref', ConnectionId: `${CONNECTION_ID}\n` }] }), /ConnectionId must not begin or end with white space/);
  assert.match(ss.settingsProblem({ ConnectionReferences: [{ LogicalName: 'new_ref', ConnectionId: '   ' }] }), /ConnectionId must not begin or end with white space/);
  // A value that is not a string is still refused, in words that never quote it.
  assert.match(ss.settingsProblem({ EnvironmentVariables: [{ SchemaName: 'new_Text', Value: null }] }), /Value must be a string — empty to leave the entry unset/);
});

test('a settings file is read as UTF-8 with or without the byte order mark a Windows tool adds, and invalid JSON is said without quoting it', () => {
  const text = JSON.stringify(template());
  assert.deepStrictEqual(ss.parseSettings(`\uFEFF${text}`, 'f'), template());
  assert.deepStrictEqual(ss.parseSettings(text, 'f'), template());
  assert.throws(() => ss.parseSettings(`{"EnvironmentVariables": [{"SchemaName": "a", "Value": "${SECRET}`, 'the file'), (err) => err.code === 'SETTINGS_INVALID' && /the file is not valid JSON\./.test(err.message) && !err.message.includes(SECRET));
  assert.throws(() => ss.parseSettings('[]', 'the file'), (err) => err.code === 'SETTINGS_INVALID' && /the file is not a deployment-settings file: the file must hold one JSON object/.test(err.message));
});

test('what a file fills in is named, never shown: the entries with a value or a connection id', () => {
  assert.deepStrictEqual(ss.filledNames(template()), { environmentVariables: [], connectionReferences: [] });
  assert.deepStrictEqual(ss.filledNames(filled()), { environmentVariables: ['new_Url'], connectionReferences: ['new_Dataverse'] });
  assert.deepStrictEqual(ss.filledNames({ EnvironmentVariables: [{ SchemaName: 'a', Value: 'x' }] }), { environmentVariables: ['a'], connectionReferences: [] });
});

// The secret of the file above (TypeId 100000005) beside a text variable and a connection id: what a message may quote, and how it is shown.
const mixedSettings = () => ({
  EnvironmentVariables: [
    { SchemaName: 'new_Secret', Value: SECRET, TypeId: 100000005 },
    { SchemaName: 'new_Text', Value: PLAIN, TypeId: 100000000 },
  ],
  ConnectionReferences: [{ LogicalName: 'new_Dataverse', ConnectionId: CONNECTION_ID }],
});
// What the package's own definitions say each variable is (a `type` option value), by lower-cased schema name — what the StageSolution reply gives, as the import records it.
const TEXT_TYPE = 100000000;
const SECRET_TYPE = 100000005;
const packageTypes = (types) => new Map(Object.entries(types).map(([name, type]) => [name.toLowerCase(), type]));
// What takes the place of a text that repeated a value of the file.
const WITHHELD = (what = 'text') => `<${what} withheld: it repeated a value from the settings file>`;

test('the sanitizer takes every filled connection id and every value that is not a secret out of a text, longest first, in one pass — and leaves short non-secret words alone', () => {
  const sanitize = ss.sanitizer({
    EnvironmentVariables: [{ SchemaName: 'a', Value: PLAIN }, { SchemaName: 'b', Value: `${PLAIN}-suffix` }, { SchemaName: 'c', Value: 'true' }, { SchemaName: 'd', Value: '' }],
    ConnectionReferences: [{ LogicalName: 'e', ConnectionId: CONNECTION_ID }],
  }, packageTypes({ a: TEXT_TYPE, b: TEXT_TYPE, c: TEXT_TYPE, d: TEXT_TYPE }));
  assert.strictEqual(sanitize(`bad value ${PLAIN}-suffix and ${PLAIN} and ${CONNECTION_ID}`), 'bad value <redacted> and <redacted> and <redacted>');
  assert.strictEqual(sanitize('the value true is fine'), 'the value true is fine', 'a short value would be taken out of ordinary words');
  assert.strictEqual(sanitize(`${PLAIN}${PLAIN}`), '<redacted><redacted>');
  assert.strictEqual(ss.sanitizer({})('nothing to hide'), 'nothing to hide');
  assert.strictEqual(ss.sanitizer(null)('x'), 'x');
  assert.strictEqual(sanitize(null), '');
  // One pass: what replaces a value is never searched for another (a value that is a piece of "<redacted>"), and a metacharacter in a value is only itself.
  const onePass = ss.sanitizer({ EnvironmentVariables: [{ SchemaName: 'a', Value: 'abcdef' }, { SchemaName: 'b', Value: 'redact' }] }, packageTypes({ a: TEXT_TYPE, b: TEXT_TYPE }));
  assert.strictEqual(onePass('abcdef redact'), '<redacted> <redacted>');
  // ...also when the text has an escape in it, which makes the decoded views of what is left be looked at: the marker is not what they are searched in.
  assert.strictEqual(onePass('abcdef \\u0041 redact'), '<redacted> \\u0041 <redacted>');
  const meta = ss.sanitizer({ EnvironmentVariables: [{ SchemaName: 'a', Value: 'a.b*c(d)[e]|f+g' }] }, packageTypes({ a: TEXT_TYPE }));
  assert.strictEqual(meta('x a.b*c(d)[e]|f+g y aXbbc(d)e'), 'x <redacted> y aXbbc(d)e');
});

test('what is KNOWN of a variable\'s secrecy is the PACKAGE\'s to say — its definition\'s type — and never the file\'s optional TypeId: the file can only add secrecy, and a variable the package was not read for is not known to be anything', () => {
  assert.strictEqual(ss.MIN_HIDDEN_LENGTH, 6);
  assert.strictEqual(ss.SECRET_TYPE_ID, 100000005);
  // [the package's type, the file's TypeId, what is known: 'secret', 'plain' (the package says another type) or 'unknown' (no definition was read)]
  const NUMBER_TYPE = 100000001;
  const table = [
    [SECRET_TYPE, undefined, 'secret'], // the package says Secret and the file says nothing: the case an optional field must not decide
    [SECRET_TYPE, null, 'secret'],
    [SECRET_TYPE, TEXT_TYPE, 'secret'], // the file says Text, the package says Secret: the package's word is the one that counts
    [SECRET_TYPE, '100000000', 'secret'],
    [SECRET_TYPE, 'secret', 'secret'],
    [SECRET_TYPE, SECRET_TYPE, 'secret'],
    [TEXT_TYPE, undefined, 'plain'],
    [TEXT_TYPE, TEXT_TYPE, 'plain'],
    [NUMBER_TYPE, undefined, 'plain'],
    [NUMBER_TYPE, 'nonsense', 'plain'],
    [TEXT_TYPE, SECRET_TYPE, 'secret'], // the file adds secrecy: a maker who marks a value secret is believed
    [TEXT_TYPE, '100000005', 'secret'],
    [undefined, undefined, 'unknown'], // nothing read, nothing said: not known to be anything
    [undefined, null, 'unknown'],
    [undefined, TEXT_TYPE, 'unknown'], // the file's word is not evidence: nothing checks it
    [undefined, '100000000', 'unknown'],
    [undefined, 'secret', 'unknown'],
    [undefined, SECRET_TYPE, 'secret'], // ...except that a file's word that a value is a secret is believed: evidence only ever raises secrecy
    [undefined, '100000005', 'secret'],
  ];
  for (const [packageType, TypeId, expected] of table) {
    const entry = TypeId === undefined ? {} : { TypeId };
    assert.strictEqual(ss.secrecyOf(entry, packageType), expected, `package ${packageType}, file ${JSON.stringify(TypeId)}`);
  }
});

test('a secret is hidden at any length whatever the file says of its type; a value that is not one is hidden from six characters on, by its trimmed length', () => {
  const as = (packageType, Value, TypeId) => ss.sanitizer(
    { EnvironmentVariables: [{ SchemaName: 'new_A', Value, ...(TypeId === undefined ? {} : { TypeId }) }] },
    packageType === undefined ? new Map() : packageTypes({ new_A: packageType })
  );
  assert.strictEqual(as(TEXT_TYPE, 'abcdef')('x abcdef y'), 'x <redacted> y', 'six characters, not a secret: replaced');
  assert.strictEqual(as(TEXT_TYPE, 'abcde')('x abcde y'), 'x abcde y', 'five characters, not a secret: shown — it is a word as much as a value, and a message with every digit blanked says nothing');
  assert.strictEqual(as(TEXT_TYPE, '  abcde  ')('x abcde y'), 'x abcde y', 'the length is that of the value without its padding');
  assert.strictEqual(as(TEXT_TYPE, ' abcdef ')('x abcdef y'), 'x<redacted>y', 'the padded form is the longest, so it is the one taken out');
  assert.strictEqual(as(TEXT_TYPE, ' abcdef ')('x abcdef, y'), 'x <redacted>, y', 'the trimmed form is taken out where the padding is not there (a service may trim what it quotes)');
  // The package says Secret: every length, and whatever the file says (the file's TypeId is optional, and nothing checks it).
  for (const TypeId of [undefined, null, TEXT_TYPE, '100000000', 'secret', SECRET_TYPE, '100000005']) {
    assert.strictEqual(as(SECRET_TYPE, 'PIN42', TypeId)('Value PIN42 was refused'), WITHHELD(), `package Secret, file ${JSON.stringify(TypeId)}`);
  }
  assert.strictEqual(as(SECRET_TYPE, 'x')('an x in it'), WITHHELD(), 'a one-character secret is hidden too');
  // The package says Text and the file says Secret: the file adds secrecy.
  assert.strictEqual(as(TEXT_TYPE, 'PIN42', SECRET_TYPE)('Value PIN42 was refused'), WITHHELD());
  // The package was not read: a variable is not known to be anything else, whatever the file says. (Five characters is below MIN_HIDDEN_LENGTH, so the value is looked for as a whole word: here it is one.)
  for (const TypeId of [undefined, null, TEXT_TYPE, '100000000', 'secret', SECRET_TYPE]) {
    assert.strictEqual(as(undefined, 'PIN42', TypeId)('Value PIN42 was refused'), WITHHELD(), `no definition, file ${JSON.stringify(TypeId)}`);
  }
  // A text that holds none of it is shown as it is, whichever way the variable is read.
  assert.strictEqual(as(undefined, 'PIN42')('nothing of it here'), 'nothing of it here');
  // The definitions are looked at when a text is sanitized, not when the sanitizer is made: what the import learns of the package later is used.
  const definitions = new Map();
  const later = ss.sanitizer({ EnvironmentVariables: [{ SchemaName: 'New_A', Value: 'abcdefgh' }] }, definitions);
  assert.strictEqual(later('x abcdefgh y'), WITHHELD(), 'before the package was read: not known to be anything, and six characters or more are looked for as a substring');
  definitions.set('new_a', TEXT_TYPE);
  assert.strictEqual(later('x abcdefgh y'), 'x <redacted> y', 'after: the package says Text, and the schema name is matched without regard to case');
});

// The escapes of a double quote that the decoders do not read, and the value glued to words: only a SUBSTRING test finds a value in them. (`\042` is an octal escape, `%u0022` the legacy
// percent form, and `&#x22` has no `;`.) The other texts quote the value in a form the decoders DO read, or plainly.
const UNDECODED_TEXTS = [
  ['an octal escape', 'Value \\042PIN42\\042 was refused'],
  ['a legacy %u escape', 'Value %u0022PIN42%u0022 was refused'],
  ['an XML reference with no semicolon', 'Value &#x22PIN42&#x22 was refused'],
  ['glued to words', 'ValuePIN42wasRefused'],
  ['after an underscore', 'key_PIN42 was refused'],
];
const DECODED_TEXTS = [
  ['plainly', "Value 'PIN42' was refused"],
  ['a JSON \\u0022', 'Value \\u0022PIN42\\u0022 was refused'],
  ['a percent-encoded quote', 'value=%22PIN42%22'],
  ['an XML entity', 'Value &quot;PIN42&quot; was refused'],
];

test('a KNOWN secret — the package says Secret, or the file does — is found as a substring at ANY length, whatever the text spells around it: glued to words, inside an escape the decoders do not read', () => {
  const sanitizeAs = (value, packageType, TypeId) => ss.sanitizer(
    { EnvironmentVariables: [{ SchemaName: 'new_A', Value: value, ...(TypeId === undefined ? {} : { TypeId }) }] },
    packageType === undefined ? new Map() : packageTypes({ new_A: packageType })
  );
  const known = [
    ['the package says Secret', SECRET_TYPE, undefined],
    ['the package says Secret, the file says Text', SECRET_TYPE, TEXT_TYPE],
    ['the file says Secret, the package says Text', TEXT_TYPE, SECRET_TYPE],
    ['the file says Secret, the package was not read', undefined, SECRET_TYPE],
    ['both say Secret', SECRET_TYPE, SECRET_TYPE],
  ];
  for (const [how, packageType, TypeId] of known) {
    const sanitize = sanitizeAs('PIN42', packageType, TypeId);
    for (const [name, text] of [...UNDECODED_TEXTS, ...DECODED_TEXTS]) assert.strictEqual(sanitize(text, 'message'), WITHHELD('message'), `${how}: ${name}: ${text}`);
    // Even one character: a substring of a word is found, which is what hiding a secret of any length costs.
    assert.strictEqual(sanitizeAs('x', packageType, TypeId)('new_Text', 'message'), WITHHELD('message'), `${how}: one character, inside a word`);
  }
});

test('a value whose type is NOT known is looked for as a substring from six characters, as before — a Secret-type value is a Key Vault reference, always long — in every text it can be spelled in', () => {
  const sanitize = ss.sanitizer({ EnvironmentVariables: [{ SchemaName: 'new_A', Value: 'PIN420' }] }, new Map());
  for (const [name, text] of [...UNDECODED_TEXTS, ...DECODED_TEXTS]) assert.strictEqual(sanitize(text.replace(/PIN42/g, 'PIN420'), 'message'), WITHHELD('message'), `${name}: ${text}`);
  // A Key Vault reference, as a settings file holds one for a Secret-type variable, is found in any of them.
  const reference = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/contoso/secrets/token';
  const vault = ss.sanitizer({ EnvironmentVariables: [{ SchemaName: 'new_A', Value: reference }] }, new Map());
  for (const text of [`the secret ${reference} was refused`, `{"path":"${reference.replace(/\//g, '\\/')}"}`, `value%3D${encodeURIComponent(reference)}`, `the vault is ${reference.toUpperCase()}`]) assert.strictEqual(vault(text, 'message'), WITHHELD('message'), text);
  // The length is that of the trimmed value: six characters are looked for as a substring, five as a whole word.
  const at = (value) => ss.sanitizer({ EnvironmentVariables: [{ SchemaName: 'new_A', Value: value }] }, new Map());
  assert.strictEqual(at('abcdef')('xabcdefy'), WITHHELD(), 'six: a substring');
  assert.strictEqual(at(' abcdef ')('xabcdefy'), WITHHELD(), 'six once trimmed: a substring');
  assert.strictEqual(at('abcde')('xabcdey'), 'xabcdey', 'five: not a whole word in it');
  assert.strictEqual(at('  abcde  ')('xabcdey'), 'xabcdey', 'five once trimmed: not a whole word in it');
  assert.strictEqual(at('abcde')('x abcde y'), WITHHELD(), 'five: a whole word in it');
});

// The SDK's own account of an entry the package does not define (api/SolutionApi.ts of the vendored SDK, measured): it names the entry and the package's variables, and never a value.
const MISMATCH = "importSolution: deploymentSettings does not match the package — EnvironmentVariables: 'new_NotInPackage' is not a variable of the package. The package's variables: new_Text; its connection references: none. Nothing was imported.";

test('a value whose type is NOT known and is shorter than six characters is looked for as a WHOLE WORD — so "x" does not withhold "new_Text" — in every decoded view, every occurrence, either case', () => {
  const FEATURE = listSentence('Workflows');
  const unknown = (value) => ss.sanitizer({ EnvironmentVariables: [{ SchemaName: 'new_A', Value: value }] }, new Map());
  // [value, text]: a text that does not have the value as a word is shown as it is.
  const shown = [
    ['x', 'new_Text'], // the case seen on a real organization: the x of "Text"
    ['x', MISMATCH],
    ['Text', MISMATCH], // the second half of a name: the underscore before it is part of the word
    ['new', 'new_NotInPackage'], // an underscore is part of a word
    ['en', 'deployment'],
    ['en', FEATURE],
    ['x', 'new_Text, boxes, x1, x_y, and 2x'], // a letter, a digit or an underscore on either side
    ['  x ', 'new_Text'], // the white space around a value is not part of what is looked for
    ['1', 'a1b, 11, 1a, _1'],
    ['_', 'a_b'],
    ['x', 'x\u203Fy'], // U+203F, another connector punctuation (Pc)
    ['e', 'x e\u0301 y'], // a combining mark glued to it
    ['e\u0301', 'cafe\u0301'], // a value that ends in a mark has a word's edge there, and a letter before it
    ['\u00e9', 'caf\u00e9'], // a letter that is not ASCII
    ['\u00c9', 'caf\u00e9'], // ...in the other case
    ['\u4e16', '\u4e16\u754c'], // ideographs are letters
    ['\ud835\udc9c', 'x\ud835\udc9cy'], // a letter outside the Basic Multilingual Plane is one character
    ['-x', 'a-xb'], // an edge that is a word character is glued to the next letter, whatever the other edge is
    ['x-', 'ax-b'],
    ['PIN42', 'ValuePIN42wasRefused'], // what the rule leaves (stated in AGENTS.md): a short value glued to words…
    ['PIN42', 'key_PIN42 was refused'],
    ['PIN42', 'Value \\042PIN42\\042 was refused'], // …or inside an escape the decoders do not read
    ['PIN42', 'Value %u0022PIN42%u0022 was refused'],
    ['PIN42', 'Value &#x22PIN42&#x22 was refused'],
  ];
  for (const [value, text] of shown) assert.strictEqual(unknown(value)(text, 'message'), text, `${JSON.stringify(value)} in ${JSON.stringify(text)}`);
  // A text that has it as a word is withheld whole.
  const withheld = [
    ['x', "'x'"],
    ['x', 'a x b'],
    ['X', "'x'"], // either case
    ['x', 'X'],
    ['x', 'x'],
    ['  x ', "'x'"], // a value is looked for without the white space around it: a service may trim it
    ['\tPIN4 ', 'Value "PIN4" was refused'],
    ['x', 'x y'],
    ['x', 'y x'],
    ['x', 'x.'], // punctuation and symbols are not word characters
    ['x', 'x-y'],
    ['x', 'value=x;'],
    ['x', "new_Text and 'x'"], // every occurrence is looked at, not the first
    ['x', "'x' and new_Text"],
    ['x', 'new_Text box x1 and, last of all, x'],
    ['en', 'the en value'],
    ['1', '`pac solution import` failed (exit 1)'],
    ['none', MISMATCH], // a whole word of the SDK's own words: what the rule costs
    ['is', MISMATCH], // …and so is any other word of that sentence, whatever the value is: a word as much as a value
    ['the', MISMATCH],
    ['_', 'a _ b'],
    ['-x-', 'the token a-x-b was refused'], // edges that are not word characters need nothing around them
    ['-x', 'a-x b'], // …and a side whose edge IS a word character needs its neighbour not to be one: here the x is followed by a space
    ['x-', 'a x-b'], // …here the x is preceded by one
    ['e\u0301', 'a (e\u0301) b'],
    ['\u00e9', 'a (\u00e9) b'],
    ['\u00c9', 'a (\u00e9) b'],
    ['\u4e16', 'a \u4e16 b'],
    ['\ud835\udc9c', 'x \ud835\udc9c y'],
    ['PIN42', "Value 'PIN42' was refused"],
    ['PIN42', '[PIN42]'],
    ['PIN42', 'Value \\u0022PIN42\\u0022 was refused'], // a form the decoders read puts the quote beside it
    ['PIN42', 'value=%22PIN42%22'],
    ['PIN42', 'Value &quot;PIN42&quot; was refused'],
    ['PIN42', 'Value &#x22;PIN42&#x22; was refused'],
    ['PIN42', 'a %2522PIN42%2522 b'], // two levels
    ['a  b', 'the pair a b was refused'], // white space collapsed, as for a secret
    ['a  b', 'the pair a\n\nb was refused'],
  ];
  for (const [value, text] of withheld) assert.strictEqual(unknown(value)(text, 'message'), WITHHELD('message'), `${JSON.stringify(value)} in ${JSON.stringify(text)}`);
  // The caller's status line (`lead`) is still kept in front of what is withheld, and a text that does not have the value is not touched.
  const lead = `HTTP 400 from ${ENV}/api/data/v9.0/ImportSolution: `;
  assert.strictEqual(unknown('x')(`${lead}the value 'x' is not a number`, 'message', lead), `${lead}${WITHHELD('message')}`);
  assert.strictEqual(unknown('x')(`${lead}the value is not a number`, 'message', lead), `${lead}the value is not a number`);
});

test('a short value of an entry the package does not define does not withhold the SDK\'s account of which entry is wrong — the case seen on a real organization — which names the entry, never a value', () => {
  const definitions = packageTypes({ new_Text: TEXT_TYPE });
  for (const value of ['x', 'true', '1', 'en', 'Text', 'qqq', 'new']) {
    const sanitize = ss.sanitizer({ EnvironmentVariables: [{ SchemaName: 'new_Text', Value: '' }, { SchemaName: 'new_NotInPackage', Value: value }] }, definitions);
    assert.strictEqual(sanitize(MISMATCH, 'message'), MISMATCH, `a value of ${JSON.stringify(value)}`);
  }
});

// What the documents say the sanitizer leaves: the skill, AGENTS.md and the CHANGELOG each list it. Every limit they name is checked here against the sanitizer itself, so a document that promises more than
// the rule does — or a rule that changes under a document — is a failing test, and each document is checked to name each limit it should.
test('the limits the skill, AGENTS.md and the CHANGELOG state are the limits the sanitizer has — each is a text that prints a value — and each document names them', () => {
  const sanitizerOf = (Value, types) => ss.sanitizer({ EnvironmentVariables: [{ SchemaName: 'new_A', Value }] }, types);
  const unknownOf = (Value) => sanitizerOf(Value, new Map());
  const printed = (sanitize, text, what) => assert.strictEqual(sanitize(text, 'message'), text, `${what}: ${text}`);
  // A value of fewer than six characters that is known not to be a secret: printed wherever a text quotes it.
  printed(sanitizerOf('PIN42', packageTypes({ new_A: TEXT_TYPE })), "Value 'PIN42' was refused", 'a short value the package says is not a secret');
  // A value of fewer than six characters whose type is not known: found only as a whole word, so printed when glued to letters, digits, marks or underscores or inside an escape the decoders do not read.
  for (const [what, text] of [...UNDECODED_TEXTS, ['a digit', 'PIN421 was refused'], ['a mark', 'Value PIN42\u0301 was refused']]) printed(unknownOf('PIN42'), text, `no type, ${what}`);
  // What the decoders do not know, for a secret of any length.
  const secret = 'caf\u00e9-secret-0123';
  const nested = (levels) => Array.from({ length: levels }).reduce((text) => encodeURIComponent(text), secret);
  const known = sanitizerOf(secret, packageTypes({ new_A: SECRET_TYPE }));
  for (const [what, text] of [
    ['a value quoted in part', 'the value caf\u00e9-secret was refused'],
    ['a value hashed', `the digest ${crypto.createHash('sha256').update(secret).digest('hex')} was refused`],
    ['a value base64-encoded', `the value ${Buffer.from(secret).toString('base64')} was refused`],
    ["a value written as an HTML entity beyond XML's five", 'the value caf&eacute;-secret-0123 was refused'],
    ['a value whose Unicode a service normalizes', `the value ${secret.normalize('NFD')} was refused`],
    ['an encoding nested more than three levels deep', `the value ${nested(4)} was refused`],
  ]) printed(known, text, what);
  assert.strictEqual(known(`the value ${nested(3)} was refused`, 'message'), WITHHELD('message'), 'three levels of encoding are within what the decoders read');
  // What the whole-word rule costs: a short value of unknown type that is a whole word of the SDK's own sentence withholds it.
  for (const value of ['none', 'is', 'the']) assert.strictEqual(unknownOf(value)(MISMATCH, 'message'), WITHHELD('message'), value);

  const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8').replace(/\r\n/g, '\n').replace(/\s+/g, ' ');
  const documents = [
    ['skills/genpage/SKILL.md', read('skills', 'genpage', 'SKILL.md'), [
      /a value of fewer than six characters that is known not to be a secret is not hidden/,
      /is found only as a whole word, so it is printed when glued to letters, digits, marks or underscores or written inside an escape the sanitizer does not decode/,
      /quoted in part, hashed, base64-encoded, written as an HTML entity beyond XML's five, Unicode-normalized or nested in more than three levels of encoding is not recognised/,
    ]],
    ['CHANGELOG.md', read('CHANGELOG.md'), [
      /quoted in part, hashed, base64-encoded, written as an HTML entity beyond XML's five, normalized in its Unicode by a service, or nested in more than three levels of encoding/,
      /a value of fewer than six characters that is known not to be a secret, which is printed wherever a text quotes it/,
      /a value of fewer than six characters with no recorded type that a text glues to letters, digits, marks or underscores or writes inside an escape the sanitizer does not read/,
    ]],
    ['AGENTS.md', read('AGENTS.md'), [
      /the SDK's account of which entry is wrong \(it names entries, never values\) stays readable unless the value is itself a whole word of that sentence \(see below\)/,
      /printed when a text quotes it glued to letters, digits, marks or underscores \(`ValuePIN42was`, `key_PIN42`\), or inside an escape the decoders do not read/,
      /a value that is known not to be one is printed wherever it is quoted/,
      /a service that quotes only part of a value, hashes or base64-encodes it, writes it as a named HTML entity beyond XML's five, normalizes its Unicode, or nests the encodings more than three deep/,
      /`none`, `is` or `the` as a value — still withholds that sentence/,
    ]],
  ];
  for (const [name, text, patterns] of documents) for (const pattern of patterns) assert.match(text, pattern, `${name} says ${pattern}`);
});

test('a text that quotes a SECRET is withheld whole — what takes its place says so — and the only thing kept in front of it is the status line the CALLER built from the SDK\'s own fields', () => {
  const sanitize = ss.sanitizer(mixedSettings(), packageTypes({ new_Secret: SECRET_TYPE, new_Text: TEXT_TYPE }));
  const lead = `HTTP 400 from ${ENV}/api/data/v9.0/ImportSolution: `;
  assert.strictEqual(sanitize(`${lead}value ${SECRET} is not a number; ${PLAIN} too`, 'message', lead), `${lead}${WITHHELD('message')}`);
  assert.strictEqual(sanitize(`the platform said ${SECRET}`, 'warning'), WITHHELD('warning'));
  assert.strictEqual(sanitize(`pac says ${SECRET}`), WITHHELD('text'));
  assert.strictEqual(sanitize(SECRET), WITHHELD('text'));
  // A text that only LOOKS like the SDK's status line is just text: without the caller's lead nothing is kept, and nothing in it is exempt — not the "URL", not the "status".
  assert.strictEqual(sanitize(`${lead}value ${SECRET}`, 'message'), WITHHELD('message'));
  assert.strictEqual(sanitize(`HTTP 400 from https://diagnostic.example/${SECRET}: rejected`, "the job log's text"), WITHHELD("the job log's text"));
  assert.strictEqual(sanitize(`HTTP 400 from ${ENV}/x: ${SECRET}`, 'warning'), WITHHELD('warning'));
  // A lead the text does not begin with is not used (the caller's claim is checked against the text).
  assert.strictEqual(sanitize(`value ${SECRET}`, 'message', lead), WITHHELD('message'));
  assert.strictEqual(sanitize(`${lead.slice(0, -2)}x ${SECRET}`, 'message', lead), WITHHELD('message'));
  // A value that straddles the lead and what follows it is found: the whole text is read, the lead included.
  const straddling = ss.sanitizer({ EnvironmentVariables: [{ SchemaName: 'new_S', Value: 'ImportSolution: kv-tail-value' }] }, packageTypes({ new_S: SECRET_TYPE }));
  assert.strictEqual(straddling(`${lead}kv-tail-value was refused`, 'message', lead), `${lead}${WITHHELD('message')}`);
  // A text that quotes only a connection id or a text variable is shown, with each replaced — a lead too, which is shown as the SDK wrote it unless it holds one.
  assert.strictEqual(sanitize(`${lead}no connection ${CONNECTION_ID} and no value ${PLAIN}`, 'message', lead), `${lead}no connection <redacted> and no value <redacted>`);
  assert.strictEqual(sanitize('a text that quotes nothing'), 'a text that quotes nothing');
});

test('a text longer than the sanitizer reads is withheld, not cut — a value that straddled the cut would leave its first half in what is shown — unless there is nothing to hide', () => {
  const sanitize = ss.sanitizer(mixedSettings(), packageTypes({ new_Secret: SECRET_TYPE, new_Text: TEXT_TYPE }));
  const fits = 'x'.repeat(ss.MAX_SANITIZED_CHARS);
  assert.strictEqual(sanitize(fits), fits, 'exactly the limit is read');
  assert.strictEqual(sanitize(`${fits}y`, 'text'), '<text withheld: it is too long to check against the settings file>');
  assert.strictEqual(sanitize(`${fits}${SECRET}`, 'warning'), '<warning withheld: it is too long to check against the settings file>');
  const lead = `HTTP 502 from ${ENV}/api/data/v9.0/ImportSolution: `;
  assert.strictEqual(sanitize(`${lead}${fits}`, 'message', lead), `${lead}<message withheld: it is too long to check against the settings file>`);
  assert.strictEqual(ss.sanitizer({})(`${fits}y`), `${fits}y`, 'a file that fills nothing in has nothing to hide from any text');
});

// The text of a spelling is looked at by DECODING it (JSON string escapes, XML character references, percent-encoding, a form's `+`), never by listing the spellings a value can have.
// The spellings themselves are written out in helpers/value-spellings.js, independently of the code under test, and each is put in a message of its own — one that is recognised
// must not hide one that is not.
const { SPELLINGS, VALUES, spellingsOfValue } = require('./helpers/value-spellings.js');

test('a SECRET is withheld whatever way its text is spelled — JSON, \\uXXXX in either case, XML references, percent-encoding, nested in one another — each spelling in a message of its own', () => {
  let tried = 0;
  for (const [valueName, value] of Object.entries(VALUES)) {
    const sanitize = ss.sanitizer({ EnvironmentVariables: [{ SchemaName: 'new_A', Value: value }] }, packageTypes({ new_A: SECRET_TYPE }));
    for (const [name, spelled] of spellingsOfValue(value)) {
      tried += 1;
      assert.strictEqual(sanitize(`Value ${spelled} was refused`, 'message'), WITHHELD('message'), `${valueName} as ${name}: ${spelled}`);
    }
  }
  assert.ok(tried >= 40, `the table is not empty (${tried})`);
});

test('a value that is NOT a secret is taken out where a text spells it as it is, and a text that spells it only in another form is withheld — it cannot be taken out of the text it was decoded from', () => {
  for (const [valueName, value] of Object.entries(VALUES)) {
    const sanitize = ss.sanitizer({ EnvironmentVariables: [{ SchemaName: 'new_A', Value: value }] }, packageTypes({ new_A: TEXT_TYPE }));
    assert.strictEqual(sanitize(`Value ${value} was refused`, 'message'), 'Value <redacted> was refused', valueName);
    for (const [name, spelled] of spellingsOfValue(value)) {
      if (name === 'raw') continue;
      const shown = sanitize(`Value ${spelled} was refused`, 'message');
      assert.ok(shown === WITHHELD('message') || shown === 'Value <redacted> was refused', `${valueName} as ${name}: ${shown}`);
      assert.ok(!shown.includes(spelled), `${valueName} as ${name}: ${shown}`);
    }
  }
  // Raw and encoded in one text: the raw one is replaced, the encoded one cannot be, so the text is withheld.
  const sanitize = ss.sanitizer({ EnvironmentVariables: [{ SchemaName: 'new_A', Value: VALUES.quote }] }, packageTypes({ new_A: TEXT_TYPE }));
  assert.strictEqual(sanitize(`${VALUES.quote} and ${SPELLINGS.json(VALUES.quote)}`, 'message'), WITHHELD('message'));
  // The same text as one that quotes it only raw: replaced, and the words around it kept.
  assert.strictEqual(sanitize(`${VALUES.quote} and ${VALUES.quote}`, 'message'), '<redacted> and <redacted>');
});

test('\\u0022, the JSON escape of a double quote that a list of spellings is likeliest to miss, and the other legal escapes of one character are each recognised alone', () => {
  const secret = 'cedar-"pine"-token';
  const sanitize = ss.sanitizer({ EnvironmentVariables: [{ SchemaName: 'new_A', Value: secret }] }, packageTypes({ new_A: SECRET_TYPE }));
  for (const spelled of [
    'cedar-\\u0022pine\\u0022-token', 'cedar-\\u0022pine"-token', 'cedar-"pine\\u0022-token', 'cedar-\\"pine\\"-token', 'cedar-\\x22pine\\x22-token',
    'cedar-&#34;pine&#34;-token', 'cedar-&#x22;pine&#x22;-token', 'cedar-%22pine%22-token', 'cedar-%5C%22pine%5C%22-token',
    '\\u0063edar-"pine"-token', 'cedar\\u002d"pine"-token', // letters and hyphens may be escaped too
  ]) {
    assert.strictEqual(sanitize(`Value "${spelled}" was refused`, 'message'), WITHHELD('message'), spelled);
  }
  assert.strictEqual(sanitize('Value "cedar-pine-token" was refused', 'message'), 'Value "cedar-pine-token" was refused', 'a text that does not repeat the value is not touched');
});

test('what looks like an escape but is not one is left alone, and a text is never changed by being looked at in its decoded forms', () => {
  const sanitize = ss.sanitizer({ EnvironmentVariables: [{ SchemaName: 'new_A', Value: 'abcdefgh' }] }, packageTypes({ new_A: SECRET_TYPE }));
  const innocent = 'see \\u0041 and %20 and &amp; and C:\\keys\\vault and %zz and &bogus; and &#99999999999; and 100%';
  assert.strictEqual(sanitize(innocent), innocent);
  // A value is not found in a text that only has pieces of it in different forms.
  assert.strictEqual(sanitize('abcd and \\u0065fgh'), 'abcd and \\u0065fgh');
  // A decoded view can bring a value out of an escape that is not a whole one's: `\u0065` is `e`.
  assert.strictEqual(sanitize('abcd\\u0065fgh'), WITHHELD());
});

test('decodedViews: a text, then each form the decoders make of it and of what they made — JSON string escapes, XML references, percent-encoding, `+` as a space — a few levels deep, each once', () => {
  const views = ss.decodedViews;
  assert.deepStrictEqual(views('plain text'), ['plain text']);
  assert.deepStrictEqual(views(''), ['']);
  const decodes = (encoded, decoded) => assert.ok(views(encoded).includes(decoded), `${encoded} -> ${decoded}: ${JSON.stringify(views(encoded))}`);
  // JSON: the two-character escapes (RFC 8259 §7), \uXXXX in either case, a surrogate pair, and the non-JSON \' and \xHH.
  for (const [encoded, decoded] of [
    ['\\"', '"'], ['\\\\', '\\'], ['\\/', '/'], ['\\b', '\b'], ['\\f', '\f'], ['\\n', '\n'], ['\\r', '\r'], ['\\t', '\t'], ["\\'", "'"],
    ['\\u0022', '"'], ['\\u003c', '<'], ['\\u003C', '<'], ['\\u00e9', '\u00e9'], ['\\u00E9', '\u00e9'], ['\\ud83d\\ude80', '\ud83d\ude80'], ['\\x41', 'A'],
  ]) decodes(`a${encoded}b`, `a${decoded}b`);
  // XML: the five named references, and decimal and hexadecimal numeric ones.
  for (const [encoded, decoded] of [['&quot;', '"'], ['&lt;', '<'], ['&gt;', '>'], ['&amp;', '&'], ['&apos;', "'"], ['&#34;', '"'], ['&#x22;', '"'], ['&#X22;', '"'], ['&#233;', '\u00e9'], ['&#xE9;', '\u00e9'], ['&#128640;', '\ud83d\ude80']]) decodes(`a${encoded}b`, `a${decoded}b`);
  // Percent-encoding: either hex case, multi-byte UTF-8, a run that is not valid UTF-8 decoded as far as it is valid, and a form's `+`.
  for (const [encoded, decoded] of [['%22', '"'], ['%2f', '/'], ['%2F', '/'], ['%C3%A9', '\u00e9'], ['%e4%b8%96', '\u4e16'], ['%F0%9F%9A%80', '\ud83d\ude80'], ['%FF%22', '\ufffd"'], ['+', ' ']]) decodes(`a${encoded}b`, `a${decoded}b`);
  // One inside another: two and three levels.
  decodes('a%2522b', 'a"b');
  decodes('a\\\\u0022b', 'a"b');
  decodes('a&amp;quot;b', 'a"b');
  decodes('a%5C%22b', 'a"b');
  decodes('a\\u0025\\u0032\\u0032b', 'a"b');
  decodes('a%252522b', 'a"b'); // three levels of percent
  decodes('a%26amp%3Bquot%3Bb', 'a"b'); // percent of XML of XML
  decodes('a\\u0022b%22c&quot;d', 'a"b"c"d'); // different spellings in one text
  // What is not an escape stays as it is — a path's backslashes, a stray `%`, a made-up entity — and an escape that is not a character is not made into one.
  for (const text of ['C:\\keys\\vault', '%zz', '%2', '100%', '&bogus;', '&#99999999999;', '&#xZZ;', '\\u12', '\\q']) assert.ok(views(text).includes(text), text);
  assert.ok(!views('a&#99999999999;b').some((view) => view.includes('\ufffd')), 'a number that is no character is not replaced');
  // Each view once, and few: every decoder at every level is at most 1 + 4 + 16 + 64 views, and a pathological text cannot make more.
  const heap = `${'\\u0025'.repeat(50)}25%2525&amp;amp;\\\\\\\\\\\\ ${'+%'.repeat(100)}`;
  const many = views(heap);
  assert.strictEqual(new Set(many).size, many.length);
  assert.ok(many.length <= 100, String(many.length));
  assert.strictEqual(many[0], heap, 'the text itself is the first view');
});

test('a secret with white space in it is found whatever white space the text holds — and a text that has collapsed it', () => {
  const secret = 'Cedar  Pine\tSecret42\nline';
  const sanitize = ss.sanitizer({ EnvironmentVariables: [{ SchemaName: 'new_A', Value: secret }] }, packageTypes({ new_A: SECRET_TYPE }));
  for (const text of [
    `Value '${secret}' was refused`,
    "Value 'Cedar Pine Secret42 line' was refused", // runs of white space made one by a service that joins the lines of what it quotes
    "Value 'Cedar    Pine   Secret42   line' was refused",
    "Value 'Cedar \t Pine\r\nSecret42\r\nline' was refused",
  ]) assert.strictEqual(sanitize(text, 'message'), WITHHELD('message'), JSON.stringify(text));
  assert.strictEqual(sanitize("Value 'Cedar Pine' was refused", 'message'), "Value 'Cedar Pine' was refused", 'a piece of it is not it');
  // The same, in an encoded text.
  assert.strictEqual(sanitize('Value Cedar%20%20Pine%09Secret42%0Aline', 'message'), WITHHELD('message'));
  // A value that is not a secret, with white space in it: replaced where it is spelled as it is; a text that collapsed it is withheld.
  const plain = ss.sanitizer({ EnvironmentVariables: [{ SchemaName: 'new_A', Value: 'Cedar  Pine Secret42' }] }, packageTypes({ new_A: TEXT_TYPE }));
  assert.strictEqual(plain("Value 'Cedar  Pine Secret42' was refused", 'message'), "Value '<redacted>' was refused");
  assert.strictEqual(plain("Value 'Cedar Pine Secret42' was refused", 'message'), WITHHELD('message'));
});

test('the status line the SDK writes is built from the error\'s own statusCode and url — never found by looking at how a text begins', () => {
  const { ConnectionError } = require('../lib/maker-sdk.js');
  const url = `${ENV}/api/data/v9.0/ImportSolution`;
  assert.strictEqual(ss.sdkLead(new ConnectionError(url, 400, 'bad')), `HTTP 400 from ${url}: `);
  assert.strictEqual(ss.sdkLead(new ConnectionError(url, 504, 'bad')), `HTTP 504 from ${url}: `);
  assert.strictEqual(ss.sdkLead(new ConnectionError(url, 0, 'no token')), `Transport failure reaching ${url}: `);
  // The message must really begin with it. One that does not (another error, a rebuilt message) has no lead: nothing is kept.
  assert.strictEqual(ss.sdkLead(Object.assign(new Error('something else'), { url, statusCode: 400 })), '');
  assert.strictEqual(ss.sdkLead(Object.assign(new Error(`HTTP 400 from ${url}x: bad`), { url, statusCode: 400 })), '');
  assert.strictEqual(ss.sdkLead(Object.assign(new Error(`HTTP 401 from ${url}: bad`), { url, statusCode: 400 })), '', 'the status of the error, not the one the text claims');
  assert.strictEqual(ss.sdkLead(Object.assign(new Error(`HTTP 400 from ${ENV}/other: bad`), { url, statusCode: 400 })), '', 'the url of the error, not the one the text claims');
  // An error without its fields — a plain one, one from pac, a string — has none, whatever its text says; nor has anything that is not an Error.
  const lookalike = `HTTP 400 from ${url}: bad`;
  for (const error of [null, undefined, lookalike, new Error(lookalike), Object.assign(new Error(lookalike), { statusCode: 400 }), Object.assign(new Error(lookalike), { url }),
    Object.assign(new Error(lookalike), { url, statusCode: '400' }), Object.assign(new Error(lookalike), { url: 42, statusCode: 400 }), { message: lookalike, url, statusCode: 400 }]) {
    assert.strictEqual(ss.sdkLead(error), '', String(error));
  }
});

test('case does not matter: a secret, a value that is not one and a connection id are found in a text that normalises their case — also inside an encoding', () => {
  const guid = '00000000-AAAA-BBBB-CCCC-0123456789AB';
  const sanitize = ss.sanitizer({
    EnvironmentVariables: [{ SchemaName: 'new_S', Value: 'AbCdEf-Secret-123' }, { SchemaName: 'new_T', Value: 'Production-Key-001' }],
    ConnectionReferences: [{ LogicalName: 'new_C', ConnectionId: `shared-sql-${guid}` }],
  }, packageTypes({ new_S: SECRET_TYPE, new_T: TEXT_TYPE }));
  assert.strictEqual(sanitize('Value abcdef-secret-123 refused', 'message'), WITHHELD('message'));
  assert.strictEqual(sanitize('Value ABCDEF-SECRET-123 refused', 'message'), WITHHELD('message'));
  assert.strictEqual(sanitize('Value production-key-001 and PRODUCTION-KEY-001 and Production-Key-001', 'message'), 'Value <redacted> and <redacted> and <redacted>');
  assert.strictEqual(sanitize(`no connection shared-sql-${guid.toLowerCase()} and SHARED-SQL-${guid}`, 'message'), 'no connection <redacted> and <redacted>');
  // Inside an encoding: a secret withholds the text, a value that is not one cannot be taken out of the text it was decoded from.
  assert.strictEqual(sanitize('Value abcdef%2dsecret%2d123 refused', 'message'), WITHHELD('message'));
  assert.strictEqual(sanitize('Value production%2Dkey%2D001 refused', 'message'), WITHHELD('message'));
  // A text that has none of them, in any case, is left alone.
  assert.strictEqual(sanitize('Value abcdef-secret refused', 'message'), 'Value abcdef-secret refused');
});

test('a value of white space alone, or empty, has nothing in it to hide — whatever its type — so the sanitizer leaves every text as it is', () => {
  for (const Value of ['', ' ', '   ', '\n', '\t \n']) {
    const sanitize = ss.sanitizer({ EnvironmentVariables: [{ SchemaName: 'a', Value, TypeId: 100000005 }], ConnectionReferences: [{ LogicalName: 'r', ConnectionId: '' }] });
    assert.strictEqual(sanitize('HTTP 400 from https://contoso.crm.dynamics.com/x: a message with spaces\nand a line break'), 'HTTP 400 from https://contoso.crm.dynamics.com/x: a message with spaces\nand a line break', JSON.stringify(Value));
  }
});

// --- the SDK's refusals --------------------------------------------------------------------------------------------------------------

test('template falls back to pac only for the two staging refusals', () => {
  for (const code of ['SOLUTION_STAGING_FAILED', 'SOLUTION_STAGING_UNREADABLE']) {
    assert.deepStrictEqual(ss.templateRefusal(refusal(code, 'words')), { code, message: 'words' }, code);
  }
  for (const code of ['INVALID_ARGUMENT', 'CONNECTION_ERROR', 'SOLUTION_NOT_FOUND', 'CONNECTIVITY_ROUTE_DECOMMISSIONED', 'VERSION_CONFLICT']) {
    assert.strictEqual(ss.templateRefusal(refusal(code)), null, code);
  }
  assert.strictEqual(ss.templateRefusal(new Error('plain')), null);
  assert.strictEqual(ss.templateRefusal(null), null);
});

const featureSettings = (extra = {}) => template(extra);
// The SDK's own sentence for a feature of pac's that the file holds (api/SolutionApi.ts readOverrides) — what the real bundle throws, pinned in solution-settings-real-bundle.test.js.
const listSentence = (key) => `importSolution: deploymentSettings is not a deployment-settings file this SDK applies — deploymentSettings.${key} is a pac feature this SDK does not apply: only an empty list is accepted. Nothing was imported.`;
const instanceSentence = (index) => `importSolution: deploymentSettings is not a deployment-settings file this SDK applies — deploymentSettings.ConnectionReferences[${index}].ConnectionInstance is pac's connection-instance feature, which this SDK does not apply. Nothing was imported.`;

test('import falls back to pac for an unreadable staging and for a settings feature the FILE holds and the SDK does not apply — never for a package that did not stage, nor any other failure', () => {
  assert.deepStrictEqual(ss.importRefusal(refusal('SOLUTION_STAGING_UNREADABLE', 'w'), template()), { code: 'SOLUTION_STAGING_UNREADABLE', message: 'w' });
  const withWorkflows = featureSettings({ Workflows: [{ WorkflowId: 'x' }] });
  const feature = refusal('INVALID_ARGUMENT', listSentence('Workflows'));
  assert.deepStrictEqual(ss.importRefusal(feature, withWorkflows), { code: 'INVALID_ARGUMENT', message: feature.message });
  assert.ok(ss.importRefusal(refusal('INVALID_ARGUMENT', listSentence('CanvasApps')), featureSettings({ CanvasApps: [{ Name: 'x' }] })));
  assert.ok(ss.importRefusal(refusal('INVALID_ARGUMENT', listSentence('CopilotAgents')), featureSettings({ CopilotAgents: [{ Name: 'x' }] })));
  const instance = template({ ConnectionReferences: [{ LogicalName: 'new_a', ConnectionId: '' }, { LogicalName: 'new_b', ConnectionId: '', ConnectionInstance: { x: 1 } }] });
  assert.ok(ss.importRefusal(refusal('INVALID_ARGUMENT', instanceSentence(1)), instance));
  // The platform said the package cannot go in here: pac would only try the same import.
  assert.strictEqual(ss.importRefusal(refusal('SOLUTION_STAGING_FAILED'), template()), null);
  // An argument error that is the caller's to fix is not a feature the SDK lacks.
  assert.strictEqual(ss.importRefusal(refusal('INVALID_ARGUMENT', 'importSolution: deploymentSettings does not match the package — EnvironmentVariables: \'x\' is not a variable of the package.'), withWorkflows), null);
  assert.strictEqual(ss.importRefusal(refusal('INVALID_ARGUMENT', '…deploymentSettings.Other is not part of the format (EnvironmentVariables, ConnectionReferences; Workflows, CanvasApps and CopilotAgents only empty; $schema)'), withWorkflows), null);
  for (const code of ['CONNECTION_ERROR', 'VERSION_CONFLICT', 'SOLUTION_STAGING_X']) assert.strictEqual(ss.importRefusal(refusal(code, listSentence('Workflows')), withWorkflows), null, code);
  assert.strictEqual(ss.importRefusal(null, template()), null);
});

test('whether pac is asked is decided from the FILE: its feature, and the SDK\'s sentence for exactly that feature — never from a phrase input can put in a message', () => {
  // The sentences the SDK refuses a file with, one per feature the file holds: a non-empty list, a ConnectionInstance.
  assert.deepStrictEqual(ss.pacOnlyFeatureMessages(template()), [], 'pac\'s own template — empty lists, no instance — holds none');
  assert.deepStrictEqual(ss.pacOnlyFeatureMessages(template({ Workflows: [], CanvasApps: [], CopilotAgents: [] })), [], 'an EMPTY list is not a feature: pac writes CopilotAgents: [] into a template');
  assert.deepStrictEqual(ss.pacOnlyFeatureMessages(template({ Workflows: [{ a: 1 }], CopilotAgents: [1] })), [listSentence('Workflows'), listSentence('CopilotAgents')]);
  assert.deepStrictEqual(ss.pacOnlyFeatureMessages(template({ ConnectionReferences: [{ LogicalName: 'a', ConnectionId: '', ConnectionInstance: 1 }] })), [instanceSentence(0)]);
  // Not a list at all (the SDK's sentence says "only an empty list is accepted" for it too) is a faulty file, not a feature pac has.
  for (const bad of [5, null, 'x', {}, true]) assert.deepStrictEqual(ss.pacOnlyFeatureMessages(template({ Workflows: bad })), [], JSON.stringify(bad));
  assert.deepStrictEqual(ss.pacOnlyFeatureMessages(null), []);
  assert.deepStrictEqual(ss.pacOnlyFeatureMessages({ ConnectionReferences: [null, 5, 'x'] }), []);

  // The phrase "this SDK does not apply" in a key or a name of an ORDINARY invalid file — the SDK quotes it in its normal complaint — is not a feature, and pac is not asked.
  const phrase = 'this SDK does not apply';
  const quoting = [
    [template({ [phrase]: true }), `importSolution: deploymentSettings is not a deployment-settings file this SDK applies — deploymentSettings.${phrase} is not part of the format (EnvironmentVariables, ConnectionReferences; Workflows, CanvasApps and CopilotAgents only empty; $schema). Nothing was imported.`],
    [template({ EnvironmentVariables: [{ SchemaName: 'new_a', Value: '', [phrase]: 1 }] }), `importSolution: deploymentSettings is not a deployment-settings file this SDK applies — deploymentSettings.EnvironmentVariables[0].${phrase} is not part of a variable (SchemaName, Value; DefaultValue, TypeId, IsRequired, Name). Nothing was imported.`],
    [template({ ConnectionReferences: [{ LogicalName: 'a', ConnectionId: '', [`ConnectionInstance is pac's connection-instance feature, which ${phrase}`]: 1 }] }), `…deploymentSettings.ConnectionReferences[0].x is pac's connection-instance feature, which ${phrase}. Nothing was imported.`],
    [template({ Other: 1 }), listSentence('Workflows')], // the SDK's sentence, but the file holds no such feature
    [template({ Workflows: [{ a: 1 }] }), `${listSentence('Workflows')} (and more)`], // a feature, but not the SDK's sentence for it
    [template({ Workflows: [{ a: 1 }] }), listSentence('CanvasApps')], // a feature, but another one's sentence
  ];
  for (const [settings, message] of quoting) assert.strictEqual(ss.importRefusal(refusal('INVALID_ARGUMENT', message), settings), null, message);
});

// --- the client for the long-running actions ------------------------------------------------------------------------------------------

function clientWith(answers) {
  const sent = [];
  const client = ss.solutionHttpClient(ENV, {
    getToken: () => 'dataverse-token',
    sleep: async () => {},
    request: async (options) => { sent.push(options); const next = answers.shift(); return typeof next === 'function' ? next(options) : next; },
  });
  return { client, sent };
}
const ok = (body = {}) => ({ statusCode: 200, headers: {}, body: JSON.stringify(body) });

test('ExportSolution, StageSolution and ImportSolution are given an hour to answer; any other request keeps the client\'s own limits', async () => {
  const { client, sent } = clientWith([ok(), ok(), ok(), ok(), ok()]);
  await client.post(`${ENV}/api/data/v9.0/ExportSolution`, { SolutionName: 'x' });
  await client.post(`${ENV}/api/data/v9.0/StageSolution`, { CustomizationFile: 'x' });
  await client.post(`${ENV}/api/data/v9.0/ImportSolution`, { ImportJobId: JOB });
  await client.post(`${ENV}/api/data/v9.0/appmodules`, {});
  await client.get(`${ENV}/api/data/v9.0/RetrieveCurrentOrganization()`);
  assert.deepStrictEqual(sent.map((s) => s.timeout), [3600000, 3600000, 3600000, 300000, 60000]);
});

test('a long action that gets no answer is never sent again, and an import names its job so the outcome can be looked up', async () => {
  const noAnswer = { error: 'Request timed out' };
  for (const [action, body] of [['ExportSolution', { SolutionName: 'x' }], ['StageSolution', { CustomizationFile: 'x' }], ['ImportSolution', { ImportJobId: JOB, CustomizationFile: 'x' }]]) {
    const { client, sent } = clientWith([noAnswer, ok(), ok(), ok(), ok(), ok(), ok()]);
    await assert.rejects(client.post(`${ENV}/api/data/v9.0/${action}`, body), (err) => {
      assert.match(err.message, new RegExp(`^${action} got no answer \\(Request timed out\\)\\. It was not sent again`));
      if (action === 'ImportSolution') assert.match(err.message, new RegExp(`import job ${JOB} \\(importjobs\\(${JOB}\\)`));
      else assert.doesNotMatch(err.message, /import job/);
      return true;
    }, action);
    assert.strictEqual(sent.length, 1, `${action}: one request, not the six attempts the plain client makes for a POST that got no answer`);
  }
});

test('another POST that gets no answer is still sent again by the plain client — the policy is the three actions\'', async () => {
  const { client, sent } = clientWith([{ error: 'Request timed out' }, ok({ done: true })]);
  const res = await client.post(`${ENV}/api/data/v9.0/appmodules`, {});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(sent.length, 2);
});

test('a long action that is answered — even with an error status — is returned as the SDK reads it', async () => {
  const { client } = clientWith([{ statusCode: 400, headers: {}, body: JSON.stringify({ error: { message: 'bad' } }) }]);
  const res = await client.post(`${ENV}/api/data/v9.0/ImportSolution`, { ImportJobId: JOB });
  assert.deepStrictEqual([res.status, res.body.error.message], [400, 'bad']);
});

test('a long action is sent EXACTLY ONCE whatever answers it — 500, 502, 503, 504, 429 and 401 each come back as the first answer, with its status and its typed code, and nothing is sent again or refreshed', async () => {
  const actions = [['ExportSolution', { SolutionName: 'x' }], ['StageSolution', { CustomizationFile: 'x' }], ['ImportSolution', { ImportJobId: JOB, CustomizationFile: 'x' }]];
  for (const status of [500, 502, 503, 504, 429, 401]) {
    for (const [action, body] of actions) {
      const tokenReads = [];
      const sent = [];
      const client = ss.solutionHttpClient(ENV, {
        getToken: (env, options) => { tokenReads.push(options); return 'dataverse-token'; },
        sleep: async () => {},
        // The platform ACCEPTED the request (it is in `sent`) and a gateway answered that it failed; a second send would be answered 200.
        request: async (options) => {
          sent.push(options);
          return sent.length === 1
            ? { statusCode: status, headers: { 'retry-after': '1' }, body: JSON.stringify({ error: { code: '0x80048d19', message: `status ${status}` } }) }
            : { statusCode: 200, headers: {}, body: '{}' };
        },
      });
      const res = await client.post(`${ENV}/api/data/v9.0/${action}`, body);
      assert.strictEqual(sent.length, 1, `${action} after ${status}: one send, not the client's usual six`);
      assert.deepStrictEqual([res.status, res.body.error.code, res.body.error.message], [status, '0x80048d19', `status ${status}`], `${action} after ${status}: the answer reaches the SDK as it came`);
      assert.strictEqual(tokenReads.length, 1, `${action} after ${status}: the token is read once — a 401 is not answered by a refresh and a second send`);
    }
  }
});

test('the policy is the three actions\': any other POST that is answered with a transient status is still sent again, and a 401 on one refreshes the token', async () => {
  const sent = [];
  const reads = [];
  const client = ss.solutionHttpClient(ENV, {
    getToken: (env, options) => { reads.push(options); return 'dataverse-token'; },
    sleep: async () => {},
    request: async (options) => { sent.push(options); return sent.length < 3 ? { statusCode: sent.length === 1 ? 503 : 401, headers: {}, body: '' } : { statusCode: 200, headers: {}, body: '{"done":true}' }; },
  });
  const res = await client.post(`${ENV}/api/data/v9.0/appmodules`, {});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(sent.length, 3, 'a 503, then a 401, then the answer');
  assert.deepStrictEqual(reads.map((options) => Boolean(options && options.fresh)), [false, true], 'the 401 asked for a fresh token');
  // A GET of the same path as an action is not one of them either: the policy is a POST of one of the three.
  const read = [];
  const getter = ss.solutionHttpClient(ENV, { getToken: () => 't', sleep: async () => {}, request: async (options) => { read.push(options); return read.length === 1 ? { statusCode: 503, headers: {}, body: '' } : { statusCode: 200, headers: {}, body: '{}' }; } });
  await getter.get(`${ENV}/api/data/v9.0/ImportSolution`);
  assert.strictEqual(read.length, 2);
});

// --- what the package says its variables are --------------------------------------------------------------------------------------------

// StageSolution's reply, as the platform shapes it (measured): each component's `Attributes` is { Count, Keys, Values }.
const stageReply = (components) => ({ StageSolutionResults: { StageSolutionStatus: 'Passed', StageSolutionUploadId: JOB, SolutionComponentsDetails: components } });
const definitionOf = (attributes, ComponentTypeName = 'EnvironmentVariableDefinition') => {
  const Keys = Object.keys(attributes);
  return { ComponentTypeName, Attributes: { Count: Keys.length, Keys, Values: Keys.map((key) => attributes[key]) } };
};
// What the SDK's staging of a package leaves in an import — the type of each variable its definitions give (`types`: schema name -> type) — for a test that stands the SDK in:
// `http` answers StageSolution with that reply, and `sdkFirst` does what the real one does with the plan's `httpClient` — the SDK stages the package through it before it imports.
function stagedAs(types, sdk) {
  const body = JSON.stringify(stageReply(Object.entries(types).map(([schemaname, type]) => definitionOf({ schemaname, type: String(type) }))));
  return {
    http: { getToken: () => 'dataverse-token', sleep: async () => {}, request: async () => ({ statusCode: 200, headers: {}, body }) },
    sdkFirst: async (env, plan) => {
      await plan.httpClient(env).post(`${env}/api/data/v9.0/StageSolution`, { CustomizationFile: 'x' });
      return stubSdkFirst(sdk)(env, plan);
    },
  };
}

test('the types of the package\'s own variable definitions are read from the StageSolution reply — by lower-cased schema name, a number or a decimal string — and what cannot be read is not recorded', () => {
  const definitions = new Map();
  ss.recordStagedTypes(definitions, JSON.stringify(stageReply([
    definitionOf({ schemaname: 'New_Secret', type: '100000005', defaultvalue: '' }),
    definitionOf({ schemaname: 'new_Text', type: 100000000 }),
    definitionOf({ SchemaName: 'new_Cased', Type: '100000002' }), // the case of a key is not relied on
    definitionOf({ schemaname: 'new_NoType' }), // no type: not recorded
    definitionOf({ schemaname: 'new_BadType', type: 'text' }),
    definitionOf({ schemaname: 'new_Float', type: 1.5 }),
    definitionOf({ connectionreferencelogicalname: 'new_Reference', schemaname: 'new_FromAReference', type: '100000005' }, 'ConnectionReference'), // another kind of component
    definitionOf({ schemaname: 'new_Other', type: '100000005' }, 'Entity'),
    { ComponentTypeName: 'EnvironmentVariableDefinition' }, // no attributes
    { ComponentTypeName: 'EnvironmentVariableDefinition', Attributes: { Keys: ['schemaname', 'type'], Values: ['new_Short'] } }, // keys and values differ in number
    { ComponentTypeName: 'EnvironmentVariableDefinition', Attributes: { Keys: ['schemaname', 'type'], Values: ['new_Long', '100000005', 'extra'] } }, // ...either way
    { ComponentTypeName: 7, Attributes: {} },
    null,
    definitionOf({ schemaname: '', type: '100000005' }),
    definitionOf({ schemaname: 42, type: '100000005' }),
  ])));
  assert.deepStrictEqual([...definitions], [['new_secret', 100000005], ['new_text', 100000000], ['new_cased', 100000002]]);
  // A status that is not "Passed" still lists what the package holds.
  const failed = new Map();
  ss.recordStagedTypes(failed, { StageSolutionResults: { StageSolutionStatus: 'Failed', SolutionComponentsDetails: [definitionOf({ schemaname: 'a', type: '100000005' })] } });
  assert.deepStrictEqual([...failed], [['a', 100000005]]);
  // Anything else is nothing: no throw, nothing recorded.
  for (const body of [undefined, null, '', 'not json', '[]', '{}', '{"StageSolutionResults":null}', '{"StageSolutionResults":{"SolutionComponentsDetails":"x"}}', 42, [], { StageSolutionResults: 'x' }]) {
    const none = new Map();
    assert.doesNotThrow(() => ss.recordStagedTypes(none, body), String(body));
    assert.strictEqual(none.size, 0, String(body));
  }
});

test('evidence only RAISES secrecy: a name the reply lists twice keeps the most secret type, and when the types differ and none is Secret nothing is known of it', () => {
  const stage = (...definitions) => stageReply(definitions.map(([schemaname, type]) => definitionOf(type === undefined ? { schemaname } : { schemaname, type: String(type) })));
  const NUMBER_TYPE = 100000001;
  const recorded = (...replies) => {
    const definitions = new Map();
    for (const reply of replies) ss.recordStagedTypes(definitions, JSON.stringify(reply));
    return [...definitions];
  };
  // Secret wins, in either order, however many times the name is listed, and in any case of the name.
  assert.deepStrictEqual(recorded(stage(['new_Secret', SECRET_TYPE], ['new_Secret', TEXT_TYPE])), [['new_secret', SECRET_TYPE]]);
  assert.deepStrictEqual(recorded(stage(['new_Secret', TEXT_TYPE], ['new_Secret', SECRET_TYPE])), [['new_secret', SECRET_TYPE]]);
  assert.deepStrictEqual(recorded(stage(['new_Secret', TEXT_TYPE], ['NEW_SECRET', NUMBER_TYPE], ['new_secret', SECRET_TYPE])), [['new_secret', SECRET_TYPE]]);
  assert.deepStrictEqual(recorded(stage(['new_Secret', SECRET_TYPE], ['new_Secret', TEXT_TYPE], ['new_Secret', NUMBER_TYPE])), [['new_secret', SECRET_TYPE]]);
  // The same type twice is that type; types that differ with no Secret among them are no type — kept in the map as "not known", which reads as no evidence.
  assert.deepStrictEqual(recorded(stage(['new_Text', TEXT_TYPE], ['new_Text', TEXT_TYPE])), [['new_text', TEXT_TYPE]]);
  assert.deepStrictEqual(recorded(stage(['new_Text', TEXT_TYPE], ['new_Text', NUMBER_TYPE])), [['new_text', undefined]]);
  assert.deepStrictEqual(recorded(stage(['new_Text', TEXT_TYPE], ['new_Text', NUMBER_TYPE], ['new_Text', TEXT_TYPE])), [['new_text', undefined]], 'a third listing does not undo the disagreement');
  // A listing whose type cannot be read disagrees with one that can; one listing that cannot be read records nothing, as before.
  assert.deepStrictEqual(recorded(stage(['new_Text', TEXT_TYPE], ['new_Text', undefined])), [['new_text', undefined]]);
  assert.deepStrictEqual(recorded(stage(['new_Text', undefined], ['new_Text', TEXT_TYPE])), [['new_text', undefined]]);
  assert.deepStrictEqual(recorded(stage(['new_Text', undefined])), []);
  assert.deepStrictEqual(recorded(stage(['new_Text', undefined], ['new_Text', SECRET_TYPE])), [['new_text', SECRET_TYPE]]);
  // The same holds across replies: what an earlier one said is evidence too.
  assert.deepStrictEqual(recorded(stage(['new_Text', TEXT_TYPE]), stage(['new_Text', NUMBER_TYPE])), [['new_text', undefined]]);
  assert.deepStrictEqual(recorded(stage(['new_Text', TEXT_TYPE], ['new_Text', NUMBER_TYPE]), stage(['new_Text', TEXT_TYPE])), [['new_text', undefined]], 'a later, clean listing does not undo it');
  assert.deepStrictEqual(recorded(stage(['new_Text', TEXT_TYPE], ['new_Text', NUMBER_TYPE]), stage(['new_Text', SECRET_TYPE])), [['new_text', SECRET_TYPE]]);
  assert.deepStrictEqual(recorded(stage(['new_Text', TEXT_TYPE]), stage(['new_Text', TEXT_TYPE])), [['new_text', TEXT_TYPE]]);
  // Names that are listed once are untouched by another's listings.
  assert.deepStrictEqual(recorded(stage(['new_A', TEXT_TYPE], ['new_B', SECRET_TYPE], ['new_B', TEXT_TYPE], ['new_C', NUMBER_TYPE])), [['new_a', TEXT_TYPE], ['new_b', SECRET_TYPE], ['new_c', NUMBER_TYPE]]);
  // What that does to a value: Secret wins, so a five-character value is found glued to words, as a secret's is; not known is a whole-word match, as for a name the package does not define.
  const settings = { EnvironmentVariables: [{ SchemaName: 'new_Secret', Value: 'PIN42' }, { SchemaName: 'new_Text', Value: 'en' }] };
  const definitions = new Map();
  ss.recordStagedTypes(definitions, JSON.stringify(stage(['new_Secret', SECRET_TYPE], ['new_Secret', TEXT_TYPE], ['new_Text', TEXT_TYPE], ['new_Text', NUMBER_TYPE])));
  const sanitize = ss.sanitizer(settings, definitions);
  assert.strictEqual(sanitize('ValuePIN42wasRefused', 'message'), WITHHELD('message'), 'Secret won');
  assert.strictEqual(sanitize('deployment', 'message'), 'deployment', 'no type: a whole-word match, so "en" in "deployment" is shown');
  assert.strictEqual(sanitize('the en value', 'message'), WITHHELD('message'), '...and "en" as a word is withheld');
});

test('the client tells what StageSolution answered — only that, and only an answer — before the SDK reads it, and passes the answer on untouched', async () => {
  const body = JSON.stringify(stageReply([definitionOf({ schemaname: 'new_Secret', type: '100000005' })]));
  const heard = [];
  const answers = [ok(), { statusCode: 200, headers: {}, body }, ok(), { error: 'Request timed out' }, { statusCode: 503, headers: {}, body: '{"error":{"message":"x"}}' }];
  const client = ss.solutionHttpClient(ENV, {
    getToken: () => 'dataverse-token',
    sleep: async () => {},
    request: async () => answers.shift(),
  }, { onStageReply: (text) => heard.push(text) });
  await client.post(`${ENV}/api/data/v9.0/ExportSolution`, {});
  const res = await client.post(`${ENV}/api/data/v9.0/StageSolution`, { CustomizationFile: 'x' });
  await client.post(`${ENV}/api/data/v9.0/ImportSolution`, { ImportJobId: JOB });
  await assert.rejects(client.post(`${ENV}/api/data/v9.0/StageSolution`, {}), /StageSolution got no answer/);
  const refused = await client.post(`${ENV}/api/data/v9.0/StageSolution`, {});
  assert.deepStrictEqual(heard, [body, '{"error":{"message":"x"}}'], 'the two StageSolution answers that arrived: not the export, not the import, not the one that never came');
  assert.deepStrictEqual(res.body, JSON.parse(body), 'the SDK gets the answer as it came');
  assert.strictEqual(refused.status, 503);
  // Without a listener — every other caller — the client is as it was.
  const plain = ss.solutionHttpClient(ENV, { getToken: () => 't', sleep: async () => {}, request: async () => ({ statusCode: 200, headers: {}, body }) });
  assert.deepStrictEqual((await plain.post(`${ENV}/api/data/v9.0/StageSolution`, {})).body, JSON.parse(body));
});

// --- template -----------------------------------------------------------------------------------------------------------------------

function sdkStub({ exported = 'RVhQT1JURUQ=', result = { settings: template() } } = {}) {
  const calls = [];
  return {
    calls,
    sdk: {
      exportSolution: async (options) => { calls.push(['exportSolution', options]); return { base64: exported }; },
      getDeploymentSettingsTemplate: async (options) => { calls.push(['getDeploymentSettingsTemplate', options]); return result; },
      importSolution: async (options) => { calls.push(['importSolution', options]); return { appliedSettings: { environmentVariables: ['new_Url'], connectionReferences: ['new_Dataverse'] } }; },
    },
  };
}
const templateRequest = (extra) => ({ command: 'template', env: ENV, force: false, ...extra });

test('template --solution: the solution is exported unmanaged from --env, its package staged for the template, and the file written as pac\'s format', async () => {
  const dir = tempDir();
  const { out } = files(dir);
  const { sdk, calls } = sdkStub();
  const record = [];
  const result = await ss.runTemplate(templateRequest({ solution: 'ContosoDemo', outPath: out }), { sdkFirst: stubSdkFirst(sdk, record) });
  assert.deepStrictEqual(result, { source: 'sdk', out, environmentVariables: 1, connectionReferences: 1 });
  assert.deepStrictEqual(calls, [
    ['exportSolution', { solutionName: 'ContosoDemo', managed: false }],
    ['getDeploymentSettingsTemplate', { base64: 'RVhQT1JURUQ=' }],
  ]);
  assert.strictEqual(record[0].env, ENV);
  const text = fs.readFileSync(out, 'utf8');
  assert.strictEqual(text, `${JSON.stringify(template(), null, 2)}\n`);
  assert.deepStrictEqual(JSON.parse(text), template());
  assert.strictEqual(typeof record[0].plan.httpClient, 'function', 'the org client is the long-action one');
});

test('template --package --env: the zip is staged as it is on disk (base64 of its bytes), and nothing is exported', async () => {
  const dir = tempDir();
  const { pkg, out } = files(dir);
  const { sdk, calls } = sdkStub();
  const result = await ss.runTemplate(templateRequest({ packagePath: pkg, outPath: out }), { sdkFirst: stubSdkFirst(sdk) });
  assert.strictEqual(result.source, 'sdk');
  assert.deepStrictEqual(calls, [['getDeploymentSettingsTemplate', { base64: ZIP.toString('base64') }]]);
});

test('warnings the SDK gives (a staged copy it could not delete) are carried to the output', async () => {
  const dir = tempDir();
  const { out } = files(dir);
  const { sdk } = sdkStub({ result: { settings: template(), warnings: ['The staged copy of the package (stagesolutionupload x) could not be deleted'] } });
  const result = await ss.runTemplate(templateRequest({ solution: 'Demo', outPath: out }), { sdkFirst: stubSdkFirst(sdk) });
  assert.deepStrictEqual(result.warnings, ['The staged copy of the package (stagesolutionupload x) could not be deleted']);
});

test('an existing --out is not replaced unless --force is given — and the refusal comes before anything is asked of the environment', async () => {
  const dir = tempDir();
  const { out } = files(dir);
  fs.writeFileSync(out, '{"mine":"filled in"}');
  const { sdk, calls } = sdkStub();
  const record = [];
  await assert.rejects(ss.runTemplate(templateRequest({ solution: 'Demo', outPath: out }), { sdkFirst: stubSdkFirst(sdk, record) }), (err) => err.code === 'OUT_EXISTS' && /already exists[\s\S]*--force/.test(err.message));
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(record, [], 'the SDK was not even made');
  assert.strictEqual(fs.readFileSync(out, 'utf8'), '{"mine":"filled in"}', 'the file is untouched');
  await ss.runTemplate(templateRequest({ solution: 'Demo', outPath: out, force: true }), { sdkFirst: stubSdkFirst(sdk) });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), template());
});

test('--out must be a plain file in a folder that exists: a directory, a missing folder and a link are refused before anything is read', async () => {
  const dir = tempDir();
  const { sdk, calls } = sdkStub();
  const run = (outPath) => ss.runTemplate(templateRequest({ solution: 'Demo', outPath }), { sdkFirst: stubSdkFirst(sdk) });
  await assert.rejects(run(dir), (err) => /not a regular file|could not be inspected|refusing/.test(err.message));
  await assert.rejects(run(path.join(dir, 'missing', 'settings.json')), (err) => err.code === 'UNSAFE_OUTPUT');
  const target = path.join(dir, 'target.json');
  fs.writeFileSync(target, 'x');
  const link = path.join(dir, 'link.json');
  let linked = true;
  try {
    fs.symlinkSync(target, link);
  } catch {
    linked = false; // creating a link needs a privilege some Windows machines do not grant
  }
  if (linked) {
    await assert.rejects(run(link), (err) => err.code === 'UNSAFE_OUTPUT');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'x');
  }
  assert.deepStrictEqual(calls, []);
});

test('without --force a file that APPEARS while the export, the staging or pac is awaited is never replaced — it is created, not overwritten, at the moment it is installed — and with --force it is', async () => {
  const mine = '{"EnvironmentVariables":[{"SchemaName":"new_Url","Value":"filled in meanwhile"}]}';
  // 1. through the SDK: the file is written while StageSolution's answer is awaited
  const dir = tempDir();
  const { out } = files(dir);
  const { sdk } = sdkStub();
  const meanwhile = { ...sdk, getDeploymentSettingsTemplate: async (options) => { fs.writeFileSync(out, mine); return sdk.getDeploymentSettingsTemplate(options); } };
  assert.strictEqual(fs.existsSync(out), false, 'absent when the run begins: the early check passes');
  await assert.rejects(ss.runTemplate(templateRequest({ solution: 'Demo', outPath: out }), { sdkFirst: stubSdkFirst(meanwhile) }), (err) => err.code === 'OUT_EXISTS' && /already exists[\s\S]*--force/.test(err.message));
  assert.strictEqual(fs.readFileSync(out, 'utf8'), mine, 'the file a maker started is untouched');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], 'and nothing is left beside it');
  await ss.runTemplate(templateRequest({ solution: 'Demo', outPath: out, force: true }), { sdkFirst: stubSdkFirst(meanwhile) });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), template(), 'with --force replacing it is what was asked');

  // 2. through pac, offline: the file is written while pac runs
  const dir2 = tempDir();
  const { pkg, out: out2 } = files(dir2);
  const { pac } = fakePac((args) => {
    fs.writeFileSync(out2, mine);
    fs.writeFileSync(flagValue(args, '--settings-file'), JSON.stringify(PAC_TEMPLATE));
    return { status: 0, stdout: 'created', stderr: '' };
  });
  await assert.rejects(ss.runTemplate({ command: 'template', packagePath: pkg, outPath: out2, force: false }, { sdkFirst: stubSdkFirst({}), pac }), (err) => err.code === 'OUT_EXISTS');
  assert.strictEqual(fs.readFileSync(out2, 'utf8'), mine);
});

test('a name that is taken at the very moment the file is installed is OUT_EXISTS, and a temporary file that cannot be removed is said there — and the SDK\'s warnings and the write\'s come out together', async () => {
  const dir = tempDir();
  const { out } = files(dir);
  // What a file system does that a test cannot ask of the real one: another writer takes the name between the look and the link, and a scanner holds the temporary name. Both are patched on the
  // module object that lib/safe-fs.js looks its functions up on at the time of the call, and put back in the `finally`.
  const realLink = fs.linkSync;
  const realUnlink = fs.unlinkSync;
  const sibling = /[\\/]\.[^\\/]+\.\d+\.[0-9a-f]{8}\.tmp$/;
  fs.unlinkSync = (target, ...rest) => {
    if (sibling.test(String(target))) throw Object.assign(new Error('EIO: i/o error, unlink'), { code: 'EIO' });
    return realUnlink(target, ...rest);
  };
  try {
    fs.linkSync = (from, to) => {
      fs.writeFileSync(to, 'theirs');
      return realLink(from, to);
    };
    const { sdk } = sdkStub();
    await assert.rejects(ss.runTemplate(templateRequest({ solution: 'ContosoDemo', outPath: out }), { sdkFirst: stubSdkFirst(sdk) }), (err) => {
      assert.strictEqual(err.code, 'OUT_EXISTS');
      assert.match(err.message, /^--out: .* already exists\. Choose another file, or pass --force to replace it \(a replaced file loses every value already filled in\)\. Its temporary file .*\.tmp could not be removed \(EIO\): delete it\.$/);
      return true;
    });
    assert.strictEqual(fs.readFileSync(out, 'utf8'), 'theirs', 'the file that appeared is not replaced');
    const [left] = fs.readdirSync(dir).filter((name) => /^\..*\.tmp$/.test(name));
    assert.ok(left, 'the temporary file is where the message says');
    fs.rmSync(path.join(dir, left));
    fs.rmSync(out);

    // The write is a success whose temporary name stays: its warning comes after the SDK's own, in one list.
    fs.linkSync = realLink;
    const staged = sdkStub({ result: { settings: template(), warnings: ['The staged copy of the package could not be deleted.'] } });
    const result = await ss.runTemplate(templateRequest({ solution: 'ContosoDemo', outPath: out }), { sdkFirst: stubSdkFirst(staged.sdk) });
    assert.strictEqual(result.warnings.length, 2);
    assert.strictEqual(result.warnings[0], 'The staged copy of the package could not be deleted.');
    assert.match(result.warnings[1], /was written in full, but its temporary name .*\.tmp could not be removed \(EIO\): delete it/);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), template(), 'the file is complete');
    // And without a leftover the warnings are the SDK's alone.
    for (const name of fs.readdirSync(dir).filter((entry) => /^\..*\.tmp$/.test(entry))) fs.rmSync(path.join(dir, name));
    fs.unlinkSync = realUnlink;
    const clean = await ss.runTemplate(templateRequest({ solution: 'ContosoDemo', outPath: out, force: true }), { sdkFirst: stubSdkFirst(staged.sdk) });
    assert.deepStrictEqual(clean.warnings, ['The staged copy of the package could not be deleted.']);
  } finally {
    fs.linkSync = realLink;
    fs.unlinkSync = realUnlink;
  }
});

test('--package is checked as far as a file can be before anything is requested: missing, a folder, empty, not a zip', async () => {
  const dir = tempDir();
  const { out } = files(dir);
  const empty = path.join(dir, 'empty.zip');
  fs.writeFileSync(empty, '');
  const notZip = path.join(dir, 'notzip.zip');
  fs.writeFileSync(notZip, 'this is text, not a package');
  const short = path.join(dir, 'short.zip');
  fs.writeFileSync(short, 'P');
  const { sdk, calls } = sdkStub();
  const record = [];
  const cases = [
    [path.join(dir, 'missing.zip'), /could not be read \(ENOENT\)/],
    [dir, /is not a file/],
    [empty, /is empty/],
    [notZip, /not a solution package: it is not a \.zip file \(it does not begin with PK\)/],
    [short, /not a solution package/],
  ];
  for (const [packagePath, message] of cases) {
    await assert.rejects(ss.runTemplate(templateRequest({ packagePath, outPath: out }), { sdkFirst: stubSdkFirst(sdk, record) }), (err) => err.code === 'PACKAGE_UNREADABLE' && message.test(err.message), packagePath);
  }
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(record, []);
  assert.strictEqual(fs.existsSync(out), false);
});

test('a package over the size limit is refused before it is read, a settings file over its limit likewise — and exactly the limit is allowed', async () => {
  // The limits are guards against reading an unexpectedly large file into memory (the package is held, then held again as base64).
  assert.strictEqual(ss.MAX_PACKAGE_BYTES, 128 * 1024 * 1024);
  assert.strictEqual(ss.MAX_SETTINGS_BYTES, 5 * 1024 * 1024);
  const dir = tempDir();
  const pkg = path.join(dir, 'big.zip');
  fs.writeFileSync(pkg, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(8)]));
  for (const withBytes of [false, true]) {
    assert.throws(() => ss.inspectPackage(pkg, { withBytes, maxBytes: 11 }), (err) => err.code === 'PACKAGE_UNREADABLE' && /is larger than/.test(err.message), `withBytes ${withBytes}`);
    assert.doesNotThrow(() => ss.inspectPackage(pkg, { withBytes, maxBytes: 12 }), `a package of exactly the limit, withBytes ${withBytes}`);
  }
  const settings = path.join(dir, 'big.json');
  const run = () => ss.runImport({ command: 'import', env: ENV, packagePath: pkg, settingsPath: settings }, { sdkFirst: async () => { throw new Error('nothing may be requested'); } });
  fs.writeFileSync(settings, ' '.repeat(ss.MAX_SETTINGS_BYTES + 1));
  await assert.rejects(run(), (err) => err.code === 'SETTINGS_UNREADABLE' && /is larger than 5 MiB/.test(err.message));
  fs.writeFileSync(settings, ' '.repeat(ss.MAX_SETTINGS_BYTES));
  await assert.rejects(run(), (err) => err.code === 'SETTINGS_INVALID', 'a file of exactly the limit is read (and is not JSON)');
});

// the template, through pac

const PAC_TEMPLATE = {
  EnvironmentVariables: [{ SchemaName: 'new_Url', Value: '', DefaultValue: 'https://default.example', Name: { Default: 'Url', ByLcid: { 1033: 'Url' } }, TypeId: 100000000, IsRequired: false }],
  ConnectionReferences: [{ LogicalName: 'new_Dataverse', ConnectionId: '', ConnectorId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps' }],
  CopilotAgents: [],
};
const pacWritesTemplate = (content = JSON.stringify(PAC_TEMPLATE, null, 2)) => fakePac((args) => {
  fs.writeFileSync(flagValue(args, '--settings-file'), content);
  return { status: 0, stdout: 'Deployment settings file created.\n', stderr: '' };
});

test('when the SDK refuses to stage the package, pac reads the zip the SDK exported — offline — and its file is what is written, with the refusal as the fallback', async () => {
  const dir = tempDir();
  const { out } = files(dir);
  const exported = Buffer.concat([ZIP, Buffer.from(' exported')]).toString('base64');
  const { sdk } = sdkStub({ exported });
  sdk.getDeploymentSettingsTemplate = async () => { throw refusal('SOLUTION_STAGING_FAILED', 'the package did not pass StageSolution in this environment'); };
  const { pac, calls } = pacWritesTemplate();
  let zipSeen;
  const spawn = pac.spawn;
  pac.spawn = (name, args, options) => {
    zipSeen = { path: flagValue(args, '--solution-zip'), bytes: fs.readFileSync(flagValue(args, '--solution-zip')), settingsDir: path.dirname(flagValue(args, '--settings-file')) };
    return spawn(name, args, options);
  };
  const result = await ss.runTemplate(templateRequest({ solution: 'Demo', outPath: out }), { sdkFirst: stubSdkFirst(sdk), pac });
  assert.deepStrictEqual(result, {
    source: 'pac', out, environmentVariables: 1, connectionReferences: 1,
    fallback: { code: 'SOLUTION_STAGING_FAILED', message: 'the package did not pass StageSolution in this environment' },
  });
  assert.deepStrictEqual(calls[0].args.slice(0, 3), ['solution', 'create-settings', '--solution-zip']);
  assert.deepStrictEqual(zipSeen.bytes, Buffer.from(exported, 'base64'), 'pac was given the package the SDK had exported');
  assert.strictEqual(fs.readFileSync(out, 'utf8'), JSON.stringify(PAC_TEMPLATE, null, 2), 'pac\'s own file, byte for byte');
  assert.strictEqual(fs.existsSync(zipSeen.settingsDir), false, 'the scratch folder holding a copy of the package is removed');
  assert.notStrictEqual(path.dirname(flagValue(calls[0].args, '--settings-file')), path.dirname(out), 'pac never writes at --out itself');
});

test('for a package on disk pac is given that file', async () => {
  const dir = tempDir();
  const { pkg, out } = files(dir);
  const { sdk } = sdkStub();
  sdk.getDeploymentSettingsTemplate = async () => { throw refusal('SOLUTION_STAGING_UNREADABLE'); };
  const { pac, calls } = pacWritesTemplate();
  const result = await ss.runTemplate(templateRequest({ packagePath: pkg, outPath: out }), { sdkFirst: stubSdkFirst(sdk), pac });
  assert.strictEqual(flagValue(calls[0].args, '--solution-zip'), pkg);
  assert.strictEqual(result.fallback.code, 'SOLUTION_STAGING_UNREADABLE');
});

test('without --env there is nothing to stage a package in: pac reads the zip, offline, and the SDK is never made — no fallback to report', async () => {
  const dir = tempDir();
  const { pkg, out } = files(dir);
  const record = [];
  const { pac, calls } = pacWritesTemplate();
  const result = await ss.runTemplate({ command: 'template', packagePath: pkg, outPath: out, force: false }, { sdkFirst: stubSdkFirst({}, record), pac });
  assert.deepStrictEqual(result, { source: 'pac', out, environmentVariables: 1, connectionReferences: 1 });
  assert.deepStrictEqual(record, []);
  assert.deepStrictEqual(calls[0].args.slice(0, 4), ['solution', 'create-settings', '--solution-zip', pkg]);
  assert.strictEqual(calls[0].name, 'pac');
});

test('--out is replaced the safe way: written to a temp file in its own folder and renamed over the target, never written in place — and no temp file is left', async (t) => {
  const dir = tempDir();
  const { pkg, out } = files(dir);
  fs.writeFileSync(out, '{"old":true}');
  const renames = [];
  const realRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    renames.push({ fromDir: path.dirname(from), fromName: path.basename(from), toDir: path.dirname(to), toName: path.basename(to) });
    return realRename(from, to);
  });
  const { pac } = pacWritesTemplate();
  await ss.runTemplate({ command: 'template', packagePath: pkg, outPath: out, force: true }, { sdkFirst: stubSdkFirst({}), pac });
  const onto = renames.filter((r) => r.toName === 'settings.json');
  assert.strictEqual(onto.length, 1, 'one rename onto --out');
  assert.strictEqual(fs.realpathSync(onto[0].toDir), fs.realpathSync(dir));
  assert.strictEqual(fs.realpathSync(onto[0].fromDir), fs.realpathSync(dir), 'the temp file is beside the target, so the rename replaces the entry');
  assert.match(onto[0].fromName, /^\.settings\.json\..+\.tmp$/);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), PAC_TEMPLATE, 'the old file is replaced');
});

test('a failure that is not a staging refusal is thrown — pac is not asked, and --out is not written', async () => {
  const dir = tempDir();
  const { out } = files(dir);
  const { sdk } = sdkStub();
  const failures = [
    Object.assign(new Error('HTTP 400 from https://contoso.crm.dynamics.com/api/data/v9.0/ExportSolution: Solution not found'), { code: 'CONNECTION_ERROR' }),
    refusal('INVALID_ARGUMENT', 'getDeploymentSettingsTemplate: bad input'),
    refusal('CONNECTIVITY_ROUTE_DECOMMISSIONED'),
  ];
  for (const failure of failures) {
    sdk.exportSolution = async () => { throw failure; };
    const { pac, calls } = pacWritesTemplate();
    await assert.rejects(ss.runTemplate(templateRequest({ solution: 'Demo', outPath: out }), { sdkFirst: stubSdkFirst(sdk), pac }), (err) => err === failure);
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(fs.existsSync(out), false);
  }
});

test('pac\'s failures leave --out unwritten, each with a code and the reason pac was asked: not run, timed out, refused, failed, wrote nothing, wrote what is no settings file', async () => {
  const dir = tempDir();
  const { out } = files(dir);
  const { sdk } = sdkStub();
  sdk.getDeploymentSettingsTemplate = async () => { throw refusal('SOLUTION_STAGING_FAILED', 'staging said no'); };
  const cases = [
    ['PAC_MISSING', { spawn: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn pac ENOENT: not found on PATH'), { code: 'ENOENT' }) }) }, /could not run/],
    ['PAC_TIMEOUT', { spawn: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) }) }, /did not finish within/],
    ['PAC_REFUSED', { spawn: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('cannot pass "a%b" to pac.cmd: a Windows batch file cannot receive a double quote, %, a control character unchanged'), { code: 'EARGUMENT' }) }) }, /was not run, and nothing was sent to pac: cannot pass/],
    ['PAC_FAILED', { spawn: () => ({ status: 1, stdout: '', stderr: 'Error: the zip is corrupt' }) }, /failed \(exit 1\): Error: the zip is corrupt/],
    ['PAC_OUTPUT_UNREADABLE', { spawn: () => ({ status: 0, stdout: 'created', stderr: '' }) }, /exited 0 but wrote no settings file/],
    ['PAC_OUTPUT_UNREADABLE', pacWritesTemplate('not json').pac, /is not valid JSON/],
    ['PAC_OUTPUT_UNREADABLE', pacWritesTemplate('[1]').pac, /is not a deployment-settings file/],
  ];
  for (const [code, pac, message] of cases) {
    await assert.rejects(ss.runTemplate(templateRequest({ solution: 'Demo', outPath: out }), { sdkFirst: stubSdkFirst(sdk), pac }), (err) => {
      assert.strictEqual(err.code, code);
      assert.match(err.message, message);
      assert.deepStrictEqual(err.fallback, { code: 'SOLUTION_STAGING_FAILED', message: 'staging said no' });
      return true;
    }, code);
    assert.strictEqual(fs.existsSync(out), false, `${code}: nothing is left at --out`);
  }
});

// --- import -------------------------------------------------------------------------------------------------------------------------

function importFiles(settings = filled()) {
  const dir = tempDir();
  const f = files(dir);
  fs.writeFileSync(f.settings, JSON.stringify(settings, null, 2));
  return { ...f, request: { command: 'import', env: ENV, packagePath: f.pkg, settingsPath: f.settings } };
}

test('import: the package and the parsed settings go to the SDK with pac\'s defaults — nothing overwritten, no workflows activated — and the job id is ours', async () => {
  const { request } = importFiles();
  const { sdk, calls } = sdkStub();
  const record = [];
  const result = await ss.runImport(request, { sdkFirst: stubSdkFirst(sdk, record), importJobId: JOB });
  assert.deepStrictEqual(calls, [['importSolution', {
    base64: ZIP.toString('base64'),
    overwriteUnmanagedCustomizations: false,
    publishWorkflows: false,
    importJobId: JOB,
    deploymentSettings: filled(),
  }]]);
  assert.deepStrictEqual(result, { source: 'sdk', importJobId: JOB, applied: { environmentVariables: ['new_Url'], connectionReferences: ['new_Dataverse'] } });
  assert.strictEqual(record[0].env, ENV);
  assert.ok(!JSON.stringify(result).includes(SECRET) && !JSON.stringify(result).includes(CONNECTION_ID), 'the output names entries, never their values');
});

test('import mints a job id when none is given: a GUID, so an unknown outcome can always be looked up', async () => {
  const { request } = importFiles();
  const { sdk } = sdkStub();
  const result = await ss.runImport(request, { sdkFirst: stubSdkFirst(sdk) });
  assert.match(result.importJobId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('import refuses a missing, unreadable or mis-shaped file before anything is requested — and says nothing of what the file holds', async () => {
  const { request, pkg, settings } = importFiles();
  const { sdk, calls } = sdkStub();
  const record = [];
  const run = (patch) => ss.runImport({ ...request, ...patch }, { sdkFirst: stubSdkFirst(sdk, record) });
  const dir = path.dirname(pkg);
  await assert.rejects(run({ settingsPath: path.join(dir, 'missing.json') }), (err) => err.code === 'SETTINGS_UNREADABLE' && /could not be read \(ENOENT\)/.test(err.message));
  await assert.rejects(run({ settingsPath: dir }), (err) => err.code === 'SETTINGS_UNREADABLE' && /is not a file/.test(err.message));
  for (const [text, code] of [['{ nope', 'SETTINGS_INVALID'], ['[]', 'SETTINGS_INVALID'], [JSON.stringify({ Other: SECRET }), 'SETTINGS_INVALID'], [JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'a', Value: { v: SECRET } }] }), 'SETTINGS_INVALID']]) {
    fs.writeFileSync(settings, text);
    await assert.rejects(run({}), (err) => err.code === code && !err.message.includes(SECRET), text);
  }
  fs.writeFileSync(settings, JSON.stringify(filled()));
  await assert.rejects(run({ packagePath: path.join(dir, 'missing.zip') }), (err) => err.code === 'PACKAGE_UNREADABLE');
  fs.writeFileSync(path.join(dir, 'text.zip'), 'plain text');
  await assert.rejects(run({ packagePath: path.join(dir, 'text.zip') }), (err) => err.code === 'PACKAGE_UNREADABLE' && /does not begin with PK/.test(err.message));
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(record, [], 'no SDK was made, so no token was read and no request sent');
});

test('import: a settings feature the SDK does not apply goes to pac with the same package and file, pinned to the environment, with the long budget; the refusal says why', async () => {
  const { request, pkg, settings } = importFiles(template({ Workflows: [{ WorkflowId: 'x' }] }));
  const { sdk } = sdkStub();
  sdk.importSolution = async () => { throw refusal('INVALID_ARGUMENT', listSentence('Workflows')); };
  const { pac, calls } = fakePac(() => ({ status: 0, stdout: 'Solution Imported successfully.\n', stderr: '' }));
  const result = await ss.runImport(request, { sdkFirst: stubSdkFirst(sdk), pac });
  assert.deepStrictEqual(calls[0].args, ['solution', 'import', '--path', pkg, '--environment', ENV, '--settings-file', settings]);
  assert.strictEqual(calls[0].options.timeout, 3600000, 'an import is given pac\'s own longest wait');
  assert.strictEqual(result.source, 'pac');
  assert.strictEqual(result.fallback.code, 'INVALID_ARGUMENT');
  assert.deepStrictEqual(result.applied, { environmentVariables: [], connectionReferences: [] }, 'the entries the file filled — here none');
  assert.ok(!('importJobId' in result), 'pac has its own job');
});

test('an ordinary invalid file whose key or name holds "this SDK does not apply" is NOT sent to pac — the SDK\'s normal complaint quotes it, and the import fails with the SDK\'s code', async () => {
  const phrase = 'this SDK does not apply';
  const cases = [
    [template({ [phrase]: true }), `importSolution: deploymentSettings is not a deployment-settings file this SDK applies — deploymentSettings.${phrase} is not part of the format (EnvironmentVariables, ConnectionReferences; Workflows, CanvasApps and CopilotAgents only empty; $schema). Nothing was imported.`],
    [template({ EnvironmentVariables: [{ SchemaName: phrase, Value: '' }, { SchemaName: phrase, Value: '' }] }), `importSolution: deploymentSettings is not a deployment-settings file this SDK applies — deploymentSettings.EnvironmentVariables[1].SchemaName names '${phrase}' a second time (names are case-insensitive). Nothing was imported.`],
  ];
  for (const [settings, message] of cases) {
    const { request } = importFiles(settings);
    const { sdk } = sdkStub();
    sdk.importSolution = async () => { throw refusal('INVALID_ARGUMENT', message); };
    const { pac, calls } = fakePac(() => ({ status: 0, stdout: 'imported', stderr: '' }));
    await assert.rejects(ss.runImport(request, { sdkFirst: stubSdkFirst(sdk), pac, importJobId: JOB }), (err) => {
      assert.strictEqual(err.code, 'INVALID_ARGUMENT');
      assert.ok(err.message.includes(phrase));
      assert.strictEqual(err.importJobId, JOB);
      assert.ok(!('fallback' in err), 'pac was not asked');
      return true;
    }, message);
    assert.deepStrictEqual(calls, [], 'pac is never started for it');
  }
});

test('import through pac names the entries the file filled, and never what they hold — a secret the SDK quoted withholds its words, a plain value or a connection id is replaced', async () => {
  const { request } = importFiles();
  const { sdk } = sdkStub();
  sdk.importSolution = async () => { throw refusal('SOLUTION_STAGING_UNREADABLE', `StageSolution's reply could not be read — detail mentions ${SECRET}`); };
  const { pac } = fakePac(() => ({ status: 0, stdout: '', stderr: '' }));
  const result = await ss.runImport(request, { sdkFirst: stubSdkFirst(sdk), pac });
  assert.deepStrictEqual(result.applied, { environmentVariables: ['new_Url'], connectionReferences: ['new_Dataverse'] });
  assert.ok(!JSON.stringify(result).includes(SECRET), 'the SDK\'s words in the fallback are cleaned too');
  assert.strictEqual(result.fallback.message, WITHHELD('message'));

  // A variable the package's own definition says is Text: its value is replaced where the words quote it, as a connection id is.
  const plain = importFiles(filledPlain());
  const plainSdk = sdkStub().sdk;
  plainSdk.importSolution = async () => { throw refusal('SOLUTION_STAGING_UNREADABLE', `StageSolution's reply could not be read — detail mentions ${PLAIN} and ${CONNECTION_ID}`); };
  const viaPac = await ss.runImport(plain.request, { ...stagedAs({ new_Url: TEXT_TYPE }, plainSdk), pac });
  assert.strictEqual(viaPac.fallback.message, 'StageSolution\'s reply could not be read — detail mentions <redacted> and <redacted>');
  // The package was not read: nothing says the variable is Text, so it is treated as a secret and the words are withheld — whatever TypeId the file gives it. A connection id alone is still replaced.
  const unread = await ss.runImport(plain.request, { sdkFirst: stubSdkFirst(plainSdk), pac });
  assert.strictEqual(unread.fallback.message, WITHHELD('message'));
  const idOnly = sdkStub().sdk;
  idOnly.importSolution = async () => { throw refusal('SOLUTION_STAGING_UNREADABLE', `StageSolution's reply could not be read — detail mentions ${CONNECTION_ID}`); };
  assert.strictEqual((await ss.runImport(plain.request, { sdkFirst: stubSdkFirst(idOnly), pac })).fallback.message, 'StageSolution\'s reply could not be read — detail mentions <redacted>');
});

test('a pac import that fails names no import job — pac mints its own, and the SDK\'s job was never sent — and says how long it was given and that pac ran out of it', async () => {
  const viaPac = importFiles({ ...filled(), CanvasApps: [{ Name: 'x' }] });
  const sdk = sdkStub().sdk;
  sdk.importSolution = async () => { throw refusal('INVALID_ARGUMENT', listSentence('CanvasApps')); };
  const failed = fakePac(() => ({ status: 1, stdout: '', stderr: 'Error: the import failed' }));
  await assert.rejects(ss.runImport(viaPac.request, { sdkFirst: stubSdkFirst(sdk), pac: failed.pac, importJobId: JOB }), (err) => {
    assert.strictEqual(err.code, 'PAC_FAILED');
    assert.strictEqual(err.fallback.code, 'INVALID_ARGUMENT');
    assert.ok(!('importJobId' in err), 'no SDK job to look up');
    assert.deepStrictEqual(ss.describeFailure(err), { ok: false, error: err.message, code: 'PAC_FAILED', fallback: err.fallback });
    return true;
  });
  const slow = fakePac(() => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn pac ETIMEDOUT'), { code: 'ETIMEDOUT' }) }));
  await assert.rejects(ss.runImport(viaPac.request, { sdkFirst: stubSdkFirst(sdk), pac: slow.pac, importJobId: JOB }), (err) => {
    assert.strictEqual(err.code, 'PAC_TIMEOUT');
    assert.match(err.message, /^`pac solution import` did not finish within 3600 s; pac and every process that held its output were stopped\. The environment may still be importing the package: look at its import history/);
    assert.ok(!('importJobId' in err));
    return true;
  });
});

// What pac's own text is, the plugin's words around it, and the sentence that sends a file to pac, are three different things, and only the first is another party's. pac's text is given to the
// sanitizer where it is READ (runPac's `redact`); the label and the exit status the plugin writes around it, and the feature sentence it builds from the file's keys, hold no value and are not.
const FEATURE_FILE = (value, name = 'new_Flag') => template({ EnvironmentVariables: [{ SchemaName: name, Value: value }], Workflows: [{ WorkflowId: 'x' }] });
function viaPacRequest(settings) {
  const files = importFiles(settings);
  const sdk = sdkStub().sdk;
  sdk.importSolution = async () => { throw refusal('INVALID_ARGUMENT', listSentence('Workflows')); };
  return { ...files, sdk };
}

test('a pac failure is sanitized ONCE, where pac\'s text is read: the plugin\'s own label and exit status stay whatever the values are — "1" for the status, "pac" for the label — and pac\'s own words are still cleaned', async () => {
  // Nothing was read of the package (the pac fallback), so each variable's type is unknown: below six characters a value is looked for as a whole word, from six as a substring.
  for (const value of ['1', 'pac', 'exit', 'solution', 'failed', 'import', 'import`']) {
    const { request, sdk } = viaPacRequest(FEATURE_FILE(value));
    const { pac } = fakePac(() => ({ status: 1, stdout: '', stderr: 'Error: the platform said no' }));
    await assert.rejects(ss.runImport(request, { sdkFirst: stubSdkFirst(sdk), pac, importJobId: JOB }), (err) => {
      assert.strictEqual(err.message, '`pac solution import` failed (exit 1): Error: the platform said no', JSON.stringify(value));
      assert.strictEqual(err.code, 'PAC_FAILED');
      assert.strictEqual(err.fallback.message, listSentence('Workflows'), `the reason pac was asked, for ${JSON.stringify(value)}`);
      return true;
    }, JSON.stringify(value));
  }
  // pac's own words are looked at where they are read: a value they quote takes them out and leaves the plugin's words.
  for (const [value, stderr] of [['1', 'Error: value 1 was refused'], ['pac', 'Error: pac said no'], ['PIN420', 'Error: the value PIN420 was refused'], ['PIN42', "Error: the value 'PIN42' was refused"]]) {
    const { request, sdk } = viaPacRequest(FEATURE_FILE(value));
    const { pac } = fakePac(() => ({ status: 1, stdout: '', stderr }));
    await assert.rejects(ss.runImport(request, { sdkFirst: stubSdkFirst(sdk), pac, importJobId: JOB }), (err) => {
      assert.strictEqual(err.message, `\`pac solution import\` failed (exit 1): ${WITHHELD('text')}`, stderr);
      return true;
    }, stderr);
  }
  // A call that ran out of time says so in the plugin's own words, "3600" and "within" among them.
  for (const value of ['3600', 'within', 'finish']) {
    const { request, sdk } = viaPacRequest(FEATURE_FILE(value));
    const { pac } = fakePac(() => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn pac ETIMEDOUT'), { code: 'ETIMEDOUT' }) }));
    await assert.rejects(ss.runImport(request, { sdkFirst: stubSdkFirst(sdk), pac, importJobId: JOB }), (err) => {
      assert.strictEqual(err.code, 'PAC_TIMEOUT');
      assert.match(err.message, /^`pac solution import` did not finish within 3600 s/, JSON.stringify(value));
      assert.doesNotMatch(err.message, /withheld/, JSON.stringify(value));
      return true;
    }, JSON.stringify(value));
  }
});

test('the sentence that sends a file to pac is the plugin\'s own and is shown as it is — failing and succeeding — whatever the values are: "en" is in "deployment", "Workflows" is the key it names', async () => {
  for (const value of ['en', 'pac', 'only', 'file', 'list', 'Workflows', 'a pac feature', 'deploymentSettings', 'Nothing was imported']) {
    const failing = viaPacRequest(FEATURE_FILE(value));
    const failed = fakePac(() => ({ status: 1, stdout: '', stderr: 'Error: the platform said no' }));
    await assert.rejects(ss.runImport(failing.request, { sdkFirst: stubSdkFirst(failing.sdk), pac: failed.pac }), (err) => {
      assert.deepStrictEqual(err.fallback, { code: 'INVALID_ARGUMENT', message: listSentence('Workflows') }, JSON.stringify(value));
      return true;
    }, JSON.stringify(value));
    const succeeding = viaPacRequest(FEATURE_FILE(value));
    const imported = fakePac(() => ({ status: 0, stdout: 'Solution Imported successfully.\n', stderr: '' }));
    const result = await ss.runImport(succeeding.request, { sdkFirst: stubSdkFirst(succeeding.sdk), pac: imported.pac });
    assert.deepStrictEqual(result.fallback, { code: 'INVALID_ARGUMENT', message: listSentence('Workflows') }, JSON.stringify(value));
    assert.deepStrictEqual(result.applied, { environmentVariables: ['new_Flag'], connectionReferences: [] });
  }
  // The other feature sentences are the plugin's own too.
  const instance = importFiles(template({ EnvironmentVariables: [{ SchemaName: 'new_Flag', Value: 'en' }], ConnectionReferences: [{ LogicalName: 'new_a', ConnectionId: '', ConnectionInstance: { x: 1 } }] }));
  const instanceSdk = sdkStub().sdk;
  instanceSdk.importSolution = async () => { throw refusal('INVALID_ARGUMENT', instanceSentence(0)); };
  const done = fakePac(() => ({ status: 0, stdout: '', stderr: '' }));
  assert.strictEqual((await ss.runImport(instance.request, { sdkFirst: stubSdkFirst(instanceSdk), pac: done.pac })).fallback.message, instanceSentence(0));
});

test('what the SDK says of a staging reply it could not read is ANOTHER party\'s text — it can quote what it was given — so it is still sanitized, and a short value that stands alone in it withholds it', async () => {
  const cases = [
    // [value, the SDK's words, shown as they are?]
    ['x', 'StageSolution\'s reply could not be read: the entry \'x\' has no type', false],
    ['x', 'StageSolution\'s reply could not be read: a box was not a list', true],
    ['en', 'StageSolution\'s reply could not be read: deployment of the entry has no type', true],
    ['en', 'StageSolution\'s reply could not be read: the en entry has no type', false],
    ['PIN420', 'StageSolution\'s reply could not be read: it held PIN420', false],
    ['PIN420', 'StageSolution\'s reply could not be read: it held ValuePIN420wasRefused', false],
  ];
  for (const [value, message, shown] of cases) {
    const { request } = importFiles(template({ EnvironmentVariables: [{ SchemaName: 'new_Flag', Value: value }] }));
    const sdk = sdkStub().sdk;
    sdk.importSolution = async () => { throw refusal('SOLUTION_STAGING_UNREADABLE', message); };
    const { pac } = fakePac(() => ({ status: 0, stdout: '', stderr: '' }));
    const result = await ss.runImport(request, { sdkFirst: stubSdkFirst(sdk), pac });
    assert.strictEqual(result.fallback.message, shown ? message : WITHHELD('message'), `${JSON.stringify(value)}: ${message}`);
    const failed = fakePac(() => ({ status: 1, stdout: '', stderr: 'Error: the platform said no' }));
    await assert.rejects(ss.runImport(request, { sdkFirst: stubSdkFirst(sdk), pac: failed.pac }), (err) => {
      assert.strictEqual(err.fallback.message, shown ? message : WITHHELD('message'));
      assert.strictEqual(err.message, '`pac solution import` failed (exit 1): Error: the platform said no');
      return true;
    });
  }
  // The feature sentence is accepted by EXACT equality: a complaint about a reply that merely begins with it is the SDK's words about a reply — it can quote a value — and is sanitized.
  const feature = importFiles(template({ EnvironmentVariables: [{ SchemaName: 'new_Flag', Value: 'PIN420' }], Workflows: [{ WorkflowId: 'x' }] }));
  const lookalike = sdkStub().sdk;
  lookalike.importSolution = async () => { throw refusal('SOLUTION_STAGING_UNREADABLE', `${listSentence('Workflows')} The reply also held PIN420.`); };
  const imported = fakePac(() => ({ status: 0, stdout: '', stderr: '' }));
  assert.strictEqual((await ss.runImport(feature.request, { sdkFirst: stubSdkFirst(lookalike), pac: imported.pac })).fallback.message, WITHHELD('message'));
});

test('a package that did not stage is NOT imported by pac: the failure is the SDK\'s, with its words and its code', async () => {
  const { request } = importFiles();
  const { sdk } = sdkStub();
  const failure = refusal('SOLUTION_STAGING_FAILED', 'importSolution: the package did not pass StageSolution in this environment (status "Failed"). Missing dependencies: x. Nothing was imported.');
  sdk.importSolution = async () => { throw failure; };
  const { pac, calls } = fakePac(() => ({ status: 0, stdout: '', stderr: '' }));
  await assert.rejects(ss.runImport(request, { sdkFirst: stubSdkFirst(sdk), pac, importJobId: JOB }), (err) => {
    assert.strictEqual(err.code, 'SOLUTION_STAGING_FAILED');
    assert.match(err.message, /Missing dependencies: x/);
    assert.strictEqual(err.importJobId, JOB);
    return true;
  });
  assert.deepStrictEqual(calls, []);
});

// --- what an import's failure tells, and what it never does ----------------------------------------------------------------------------------

// What the SDK throws for an answer that is not a success: a ConnectionError of the real bundle, naming the URL it reached.
const { ConnectionError } = require('../lib/maker-sdk.js');
const importFailureOf = (status, message, url = `${ENV}/api/data/v9.0/ImportSolution`) => new ConnectionError(url, status, message);
// The SDK attaches the cleanup warnings of a failed staging to its error under a symbol (errors/index.ts withCleanupWarnings), where readCleanupWarnings finds them.
const withWarnings = (error, warnings) => Object.defineProperty(error, Symbol.for('cds-maker-sdk.cleanupWarnings'), { value: warnings, enumerable: false });
const failAs = (error) => async () => { throw error; };

test('no message leaves an import with a filled value or connection id in it — the SDK\'s, the platform\'s or pac\'s — and the job is named', async () => {
  // A SECRET the platform quoted: its text is withheld, its status line and the job stay.
  const { request } = importFiles();
  const { sdk } = sdkStub();
  sdk.importSolution = failAs(importFailureOf(400, `the connection ${CONNECTION_ID} is not valid; value ${SECRET} is not a number`));
  await assert.rejects(ss.runImport(request, { sdkFirst: stubSdkFirst(sdk), importJobId: JOB, readJobLog: async () => null }), (err) => {
    assert.ok(!err.message.includes(SECRET) && !err.message.includes(CONNECTION_ID), err.message);
    assert.strictEqual(err.message, `HTTP 400 from ${ENV}/api/data/v9.0/ImportSolution: ${WITHHELD('message')}`);
    assert.strictEqual(err.code, 'CONNECTION_ERROR');
    assert.strictEqual(err.statusCode, 400);
    assert.strictEqual(err.importJobId, JOB);
    return true;
  });

  // A connection id and a value the package says is Text, alone: replaced where the platform spelled them, the rest of its words kept.
  const plain = importFiles(filledPlain());
  const plainSdk = sdkStub().sdk;
  plainSdk.importSolution = failAs(importFailureOf(400, `the connection ${CONNECTION_ID} is not valid; value ${PLAIN} is not a number`));
  await assert.rejects(ss.runImport(plain.request, { ...stagedAs({ new_Url: TEXT_TYPE }, plainSdk), importJobId: JOB, readJobLog: async () => null }), (err) => {
    assert.strictEqual(err.message, `HTTP 400 from ${ENV}/api/data/v9.0/ImportSolution: the connection <redacted> is not valid; value <redacted> is not a number`);
    return true;
  });

  const viaPac = importFiles({ ...filled(), CanvasApps: [{ Name: 'x' }] });
  const pacSdk = sdkStub().sdk;
  pacSdk.importSolution = async () => { throw refusal('INVALID_ARGUMENT', listSentence('CanvasApps')); };
  const { pac } = fakePac(() => ({ status: 1, stdout: `the value ${SECRET} was refused`, stderr: '' }));
  await assert.rejects(ss.runImport({ ...viaPac.request }, { sdkFirst: stubSdkFirst(pacSdk), pac }), (err) => err.code === 'PAC_FAILED' && !err.message.includes(SECRET) && /withheld/.test(err.message));

  const withSecret = importFiles();
  const secretSdk = sdkStub().sdk;
  secretSdk.importSolution = async () => { throw refusal('SOLUTION_STAGING_UNREADABLE', `reply held ${SECRET}`); };
  const { pac: failingPac } = fakePac(() => ({ status: 1, stdout: '', stderr: `bad ${CONNECTION_ID}` }));
  await assert.rejects(ss.runImport(withSecret.request, { sdkFirst: stubSdkFirst(secretSdk), pac: failingPac }), (err) => {
    assert.ok(!JSON.stringify({ message: err.message, fallback: err.fallback }).includes(SECRET));
    assert.ok(!err.message.includes(CONNECTION_ID));
    assert.strictEqual(err.fallback.code, 'SOLUTION_STAGING_UNREADABLE');
    return true;
  });
});

test('a rejection that is not an Error — a string — is still cleaned of values and names the job, as an Error with the same words', async () => {
  const { request } = importFiles();
  const { sdk } = sdkStub();
  sdk.importSolution = async () => { throw `the platform quoted ${SECRET}`; };
  await assert.rejects(ss.runImport(request, { sdkFirst: stubSdkFirst(sdk), importJobId: JOB }), (err) => {
    assert.ok(err instanceof Error);
    assert.strictEqual(err.message, WITHHELD('message'));
    assert.strictEqual(err.importJobId, JOB);
    return true;
  });
  const plain = importFiles(filledPlain());
  const plainSdk = sdkStub().sdk;
  plainSdk.importSolution = async () => { throw `the platform quoted ${PLAIN}`; };
  await assert.rejects(ss.runImport(plain.request, { ...stagedAs({ new_Url: TEXT_TYPE }, plainSdk), importJobId: JOB }), (err) => err.message === 'the platform quoted <redacted>' && err.importJobId === JOB);
});

test('the error an import leaves with is a NEW one: the SDK\'s own error, which holds the service\'s raw answer as its cause and its warnings unfiltered, is not passed on', async () => {
  const { request } = importFiles();
  const { sdk } = sdkStub();
  const original = withWarnings(new ConnectionError(`${ENV}/api/data/v9.0/ImportSolution`, 400, `bad ${SECRET}`, { error: { message: `raw ${SECRET}` } }), [`left behind: ${SECRET}`]);
  sdk.importSolution = failAs(original);
  await assert.rejects(ss.runImport(request, { sdkFirst: stubSdkFirst(sdk), importJobId: JOB, readJobLog: async () => null }), (err) => {
    assert.notStrictEqual(err, original);
    assert.ok(!('cause' in err) || err.cause === undefined, 'the raw answer does not travel with it');
    assert.ok(!JSON.stringify({ ...err, message: err.message, stack: err.stack }).includes(SECRET), 'nothing of it — message, stack, properties — holds the secret');
    return true;
  });
});

test('the SDK\'s cleanup warnings are cleaned on a FAILURE as they are on a success: a secret withholds the warning, a plain value or an id is replaced, and the failure carries them', async () => {
  const { request } = importFiles();
  const { sdk } = sdkStub();
  sdk.importSolution = failAs(withWarnings(importFailureOf(400, 'the import was refused'), [
    `The staged copy of the package (stagesolutionupload 33333333-3333-4333-8333-333333333333) could not be deleted: HTTP 400 from ${ENV}/api/data/v9.0/stagesolutionuploads(33333333-3333-4333-8333-333333333333): cleanup diagnosis contains ${SECRET}. It stays until it is deleted.`,
    `another warning with ${CONNECTION_ID}`,
  ]));
  await assert.rejects(ss.runImport(request, { sdkFirst: stubSdkFirst(sdk), importJobId: JOB, readJobLog: async () => null }), (err) => {
    assert.deepStrictEqual(err.warnings, [WITHHELD('warning'), 'another warning with <redacted>']);
    const described = ss.describeFailure(err, () => { throw new Error('the raw warnings must not be read again'); });
    assert.deepStrictEqual(described.warnings, err.warnings);
    assert.ok(!JSON.stringify(described).includes(SECRET) && !JSON.stringify(described).includes(CONNECTION_ID));
    return true;
  });
});

test('warnings the SDK gives on an import reach the output, cleaned of values', async () => {
  const { request } = importFiles();
  const { sdk } = sdkStub();
  sdk.importSolution = async () => ({ appliedSettings: { environmentVariables: [], connectionReferences: [] }, warnings: [`The staged copy could not be deleted (${SECRET})`, `and (${CONNECTION_ID})`] });
  const result = await ss.runImport(request, { sdkFirst: stubSdkFirst(sdk), importJobId: JOB });
  assert.deepStrictEqual(result.warnings, [WITHHELD('warning'), 'and (<redacted>)']);
});

// The ones the platform's own answer says nothing about: a gateway's 504, a 500, a 401, 408 and no answer at all are NOT "refused" — the work may be running.
test('an import whose answer does not say it was refused says it was sent once and was not repeated, and names the job to look up; a refusal does not', async () => {
  for (const status of [500, 502, 503, 504, 401, 408]) {
    const { request } = importFiles();
    const { sdk } = sdkStub();
    sdk.importSolution = failAs(importFailureOf(status, 'the gateway gave up'));
    await assert.rejects(ss.runImport(request, { sdkFirst: stubSdkFirst(sdk), importJobId: JOB, readJobLog: async () => null }), (err) => {
      assert.strictEqual(err.statusCode, status);
      assert.strictEqual(err.message, `HTTP ${status} from ${ENV}/api/data/v9.0/ImportSolution: the gateway gave up The request was sent once and was not sent again: the environment may have accepted it.${ss.lookUpJob(JOB)}`, String(status));
      assert.strictEqual(err.importJobId, JOB);
      return true;
    }, String(status));
  }
  // Answers that say the platform looked at the request and refused it: nothing to look up.
  for (const status of [400, 403, 404, 409, 412, 429]) {
    const { request } = importFiles();
    const { sdk } = sdkStub();
    sdk.importSolution = failAs(importFailureOf(status, 'refused'));
    await assert.rejects(ss.runImport(request, { sdkFirst: stubSdkFirst(sdk), importJobId: JOB, readJobLog: async () => null }), (err) => {
      assert.strictEqual(err.message, `HTTP ${status} from ${ENV}/api/data/v9.0/ImportSolution: refused`, String(status));
      return true;
    }, String(status));
  }
  // No answer at all: the client's own message already names the job — it is not said twice.
  const { request } = importFiles();
  const { sdk } = sdkStub();
  sdk.importSolution = failAs(importFailureOf(0, `ImportSolution got no answer (Request timed out). It was not sent again: the environment may still be working on it, or may have finished.${ss.lookUpJob(JOB)}`));
  await assert.rejects(ss.runImport(request, { sdkFirst: stubSdkFirst(sdk), importJobId: JOB, readJobLog: async () => null }), (err) => {
    assert.strictEqual(err.message.split('Look up import job').length, 2, err.message);
    return true;
  });
  // A failure with no status that did not come from the no-answer wrapper — no token could be had — happened BEFORE the request left: nothing is said of what the environment may have accepted.
  const { request: unsent } = importFiles();
  const { sdk: tokenless } = sdkStub();
  tokenless.importSolution = failAs(importFailureOf(0, "Failed to acquire an Azure CLI token for the environment. Run 'az login' first."));
  await assert.rejects(ss.runImport(unsent, { sdkFirst: stubSdkFirst(tokenless), importJobId: JOB, readJobLog: async () => null }), (err) => {
    assert.strictEqual(err.message, `Transport failure reaching ${ENV}/api/data/v9.0/ImportSolution: Failed to acquire an Azure CLI token for the environment. Run 'az login' first.`);
    assert.strictEqual(err.importJobId, JOB);
    return true;
  });
});

// What the SDK does with the error a client throws: its message is the status line followed by the client's own message, and the client's error is kept as its `cause` (measured on the real bundle in
// solution-settings-real-bundle.test.js). The plugin's own sentence for a request that got no answer is recognised by the identity of that cause — never by how a message reads.
test('the plugin\'s own "got no answer" sentence is shown whole, whatever short value the file fills in; a message that only reads like it, or has anything added to it, is sanitized like any other', async () => {
  const settings = { EnvironmentVariables: [{ SchemaName: 'new_Text', Value: 'not' }], ConnectionReferences: [] }; // "not" is a word of the plugin's sentence, and nothing is known of the variable's type here
  // The error the plugin's client throws for a request that got no answer: the one object the plugin marks as its own composition.
  let composed;
  const client = ss.solutionHttpClient(ENV, { getToken: () => 'dataverse-token', sleep: async () => {}, request: async () => ({ error: 'Request timed out' }) });
  await assert.rejects(client.post(`${ENV}/api/data/v9.0/StageSolution`, { CustomizationFile: 'x' }), (err) => { composed = err; return true; });
  const lead = `Transport failure reaching ${ENV}/api/data/v9.0/ImportSolution: `;
  const asTheSdkWraps = (message, cause) => new ConnectionError(`${ENV}/api/data/v9.0/ImportSolution`, 0, message, cause);
  const run = async (error) => {
    const { request } = importFiles(settings);
    const { sdk } = sdkStub();
    sdk.importSolution = failAs(error);
    return ss.runImport(request, { sdkFirst: stubSdkFirst(sdk), importJobId: JOB, readJobLog: async () => null }).then(
      () => assert.fail('the import was expected to fail'),
      (err) => err.message
    );
  };
  // The status line and the plugin's own sentence, exactly: not looked at again.
  assert.strictEqual(await run(asTheSdkWraps(composed.message, composed)), `${lead}${composed.message}`);
  // The same words with a cause the plugin never made (nothing marks it), or with no cause: another party's text, so sanitized — and "not" is a whole word in it.
  assert.strictEqual(await run(asTheSdkWraps(composed.message, new Error(composed.message))), `${lead}${WITHHELD('message')}`);
  assert.strictEqual(await run(importFailureOf(0, composed.message)), `${lead}${WITHHELD('message')}`);
  // The plugin's error as the cause, with something else in the message — the SDK's or the platform's words, before or after: sanitized.
  assert.strictEqual(await run(asTheSdkWraps(`${composed.message} The platform added a word.`, composed)), `${lead}${WITHHELD('message')}`);
  assert.strictEqual(await run(asTheSdkWraps(`Added first. ${composed.message}`, composed)), `${lead}${WITHHELD('message')}`);
  // The transport's own words are cleaned where the plugin reads them: a value they quote is withheld there, and the sentence around it stays.
  const sanitize = ss.sanitizer({ EnvironmentVariables: [{ SchemaName: 'new_Text', Value: 'timed' }] });
  const cleaning = ss.solutionHttpClient(ENV, { getToken: () => 'dataverse-token', sleep: async () => {}, request: async () => ({ error: 'Request timed out' }) }, { sanitize });
  await assert.rejects(cleaning.post(`${ENV}/api/data/v9.0/StageSolution`, { CustomizationFile: 'x' }), (err) => {
    assert.strictEqual(err.message, `StageSolution got no answer (${WITHHELD('transport text')}). It was not sent again: the environment may still be working on it, or may have finished.`);
    return true;
  });
});

// --- the reason an import's own log gives ----------------------------------------------------------------------------------------------------

// A failed import's log, shaped as the platform writes it (abridged; every value is synthetic): the root says the job failed, and each component that failed has a `result`.
const JOB_LOG = [
  '<importexportxml start="639000000000000000" stop="639000000100000000" progress="100" processed="true" succeeded="failure" status="Import failed">',
  '  <solutionManifests>',
  '    <solutionManifest>',
  '      <UniqueName>ContosoDemo</UniqueName><Version>1.0.0.0</Version><Managed>0</Managed>',
  '      <result result="success" errorcode="0x0" errortext="" />',
  '    </solutionManifest>',
  '  </solutionManifests>',
  '  <entities>',
  '    <entity name="new_ticket"><result result="failure" errorcode="0x80048d19" errortext="Could not find connection &apos;00000000000000000000000000000abc&apos; for API &apos;shared_sharepointonline&apos;." /></entity>',
  '    <entity name="new_other"><result result="failure" errorcode="0x80040203" errortext="A second failure" /></entity>',
  '  </entities>',
  '</importexportxml>',
].join('\n');

test('the first failure a job log reports is the COMPLETE text of its first failing result — XML references decoded, nothing collapsed or cut — else the root status', () => {
  assert.strictEqual(ss.jobLogFailure(JOB_LOG), "Could not find connection '00000000000000000000000000000abc' for API 'shared_sharepointonline'.");
  // Either quote, any order of attributes, a result that succeeded is skipped, a failure with no text is skipped; line breaks and white space in the text are as the log has them.
  assert.strictEqual(ss.jobLogFailure(`<importexportxml succeeded='failure'><a><result errortext='first&#10;line &amp; &lt;b&gt; &#x41;' RESULT='Failure'/></a></importexportxml>`), 'first\nline & <b> A');
  assert.strictEqual(ss.jobLogFailure('<importexportxml succeeded="failure" status="x"><result result="success" errortext="not this"/><result result="failure" errortext=""/><result result="failure" errortext="this one"/></importexportxml>'), 'this one');
  assert.strictEqual(ss.jobLogFailure('<result result="failure" errortext="  runs   of &#9;white&#10;&#10;space  "/>'), '  runs   of \twhite\n\nspace  ');
  // No failing result with text: the root's status — and only when the root does not say the job succeeded.
  assert.strictEqual(ss.jobLogFailure('<importexportxml succeeded="failure" status="Import failed"><result result="success"/></importexportxml>'), 'its status is Import failed');
  assert.strictEqual(ss.jobLogFailure('<importexportxml status="Import failed"></importexportxml>'), 'its status is Import failed');
  assert.strictEqual(ss.jobLogFailure('<importexportxml succeeded="success" status="Completed"></importexportxml>'), null);
  // Nothing readable: null, so the failure stands as it was.
  for (const log of [null, undefined, '', 'not xml', '<importexportxml></importexportxml>', '<result result="failure"/>']) assert.strictEqual(ss.jobLogFailure(log), null, String(log));
  // No cut and no collapsing here — the caller sanitizes this whole text first (importFailure) — for a result's text and for the root's status alike.
  assert.strictEqual(ss.jobLogFailure(`<result result="failure" errortext="${'x'.repeat(2000)}"/>`), 'x'.repeat(2000));
  assert.strictEqual(ss.jobLogFailure(`<importexportxml succeeded="failure" status="${'s'.repeat(2000)}"/>`), `its status is ${'s'.repeat(2000)}`);
  assert.strictEqual(ss.jobLogFailure('<result result="failure" errortext="&#99999999999;&#xZZ; &bogus;"/>'), '&#99999999999;&#xZZ; &bogus;', 'what is not an entity is left as it is');
});

test('oneLine makes the runs of white space one space and cuts a text to 600 characters — what is done to a text that has been through the sanitizer, never before it', () => {
  assert.strictEqual(ss.oneLine('a  b\n\tc \r\n d'), 'a b c d');
  assert.strictEqual(ss.oneLine('  padded  '), 'padded');
  assert.strictEqual(ss.oneLine('x'.repeat(600)), 'x'.repeat(600), 'exactly 600: not cut');
  assert.strictEqual(ss.oneLine('x'.repeat(601)), `${'x'.repeat(600)}…`);
  assert.strictEqual(ss.oneLine(`${'x'.repeat(599)}\n\n\nyz`), `${'x'.repeat(599)} …`, 'the collapsing comes first, so what is counted is what is shown');
  assert.strictEqual(ss.oneLine('x'.repeat(10), 5), 'xxxxx…');
});

test('a failed import reads its job\'s log once and puts the first failure\'s text in the message — through the same cleaning — and keeps the original message when the log cannot be read', async () => {
  const reads = [];
  const { request } = importFiles(filledPlain());
  const { sdk } = sdkStub();
  sdk.importSolution = failAs(importFailureOf(400, 'An unexpected error occurred.'));
  const log = JOB_LOG.replace('00000000000000000000000000000abc', CONNECTION_ID);
  await assert.rejects(ss.runImport(request, { sdkFirst: stubSdkFirst(sdk), importJobId: JOB, readJobLog: async (env, id) => { reads.push([env, id]); return log; } }), (err) => {
    assert.strictEqual(err.message, `HTTP 400 from ${ENV}/api/data/v9.0/ImportSolution: An unexpected error occurred. The import job's log (importjobs(${JOB})) says: Could not find connection '<redacted>' for API 'shared_sharepointonline'.`);
    assert.strictEqual(err.importJobId, JOB);
    return true;
  });
  assert.deepStrictEqual(reads, [[ENV, JOB]], 'one read, of this job, in this environment');

  // A log that quotes a SECRET is withheld like any other text; the original message stays.
  const secret = importFiles();
  const secretSdk = sdkStub().sdk;
  secretSdk.importSolution = failAs(importFailureOf(400, 'An unexpected error occurred.'));
  await assert.rejects(ss.runImport(secret.request, { sdkFirst: stubSdkFirst(secretSdk), importJobId: JOB, readJobLog: async () => `<result result="failure" errortext="bad value ${SECRET}"/>` }), (err) => {
    assert.ok(!err.message.includes(SECRET));
    assert.match(err.message, /An unexpected error occurred\. The import job's log \(importjobs\([0-9a-f-]+\)\) says: <the job log's text withheld: it repeated a value from the settings file>$/);
    return true;
  });

  // A read that fails, or says nothing, leaves the failure as it was.
  for (const read of [async () => { throw new Error('the environment is slow'); }, async () => null, async () => 'not a log']) {
    const { request: again } = importFiles();
    const { sdk: failing } = sdkStub();
    failing.importSolution = failAs(importFailureOf(400, 'An unexpected error occurred.'));
    await assert.rejects(ss.runImport(again, { sdkFirst: stubSdkFirst(failing), importJobId: JOB, readJobLog: read }), (err) => {
      assert.strictEqual(err.message, `HTTP 400 from ${ENV}/api/data/v9.0/ImportSolution: An unexpected error occurred.`);
      assert.strictEqual(err.importJobId, JOB);
      return true;
    });
  }
});

// A job log whose one failing result says `text`, escaped as the platform writes an attribute.
const logSaying = (text) => `<importexportxml succeeded="failure" status="Import failed"><entity><result result="failure" errortext="${text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"/></entity></importexportxml>`;
// What an import of `value` (a variable the package says is of type `type`) fails with when the job's log says `log` and the answer was "An unexpected error occurred."
async function failedImportWithLog(value, log, type = SECRET_TYPE) {
  const { request } = importFiles({ EnvironmentVariables: [{ SchemaName: 'new_Url', Value: value }], ConnectionReferences: [] });
  const { sdk } = sdkStub();
  sdk.importSolution = failAs(importFailureOf(400, 'An unexpected error occurred.'));
  try {
    await ss.runImport(request, { ...stagedAs({ new_Url: type }, sdk), importJobId: JOB, readJobLog: async () => log });
  } catch (err) {
    return err.message;
  }
  return assert.fail('the import should have failed');
}
const LOG_LEAD = `HTTP 400 from ${ENV}/api/data/v9.0/ImportSolution: An unexpected error occurred. The import job's log (importjobs(${JOB})) says: `;

test('the job log\'s words are sanitized COMPLETE, and only then made one line and cut — a secret that crosses the 600th character, or that holds runs of white space, is never shown in part', async () => {
  const secret = 'CedarPineSecret0123456789';
  // The secret begins before the 600th character of the line and ends after it — and at every offset around that cut — in a failing result and in the root's status.
  for (const before of [0, 1, 100, 570, 575, 580, 590, 592, 595, 599, 600, 601, 700]) {
    assert.strictEqual(await failedImportWithLog(secret, logSaying(`${'x'.repeat(before)}${secret} was refused`)), `${LOG_LEAD}${WITHHELD("the job log's text")}`, `${before} characters before it`);
    assert.strictEqual(await failedImportWithLog(secret, `<importexportxml succeeded="failure" status="${'x'.repeat(before)}${secret}"/>`), `${LOG_LEAD}${WITHHELD("the job log's text")}`, `${before} characters before it, in the status`);
  }
  // A secret made of runs of white space: the log's text is read as it is, so the value is found — one line made of it first would no longer hold it.
  const spaced = 'Cedar  Pine Secret42';
  for (const text of [`Value '${spaced}' was refused`, `Value '${spaced}'\n\n was refused`, `Value\t'${spaced}' was refused`]) {
    assert.strictEqual(await failedImportWithLog(spaced, logSaying(text)), `${LOG_LEAD}${WITHHELD("the job log's text")}`, JSON.stringify(text));
  }
  // A value that is not a secret is replaced in the complete text, and the line is made after: its white space is kept for the search, and what is cut is only the end.
  assert.strictEqual(await failedImportWithLog(spaced, logSaying(`Value '${spaced}'\n\n was refused`), TEXT_TYPE), `${LOG_LEAD}Value '<redacted>' was refused`);
  const plainAtTheCut = await failedImportWithLog(PLAIN, logSaying(`${'x'.repeat(592)}${PLAIN} was refused`), TEXT_TYPE);
  assert.strictEqual(plainAtTheCut, `${LOG_LEAD}${'x'.repeat(592)}<redacte…`);
  // The text is cut to 600 characters when nothing in it is a value, and not before.
  assert.strictEqual(await failedImportWithLog(secret, logSaying('y'.repeat(600))), `${LOG_LEAD}${'y'.repeat(600)}`);
  assert.strictEqual(await failedImportWithLog(secret, logSaying('y'.repeat(601))), `${LOG_LEAD}${'y'.repeat(600)}…`);
  assert.strictEqual(await failedImportWithLog(secret, logSaying(`a  b\n\nc ${'y'.repeat(598)}`)), `${LOG_LEAD}a b c ${'y'.repeat(594)}…`);
});

test('nothing in a text is trusted for looking like the SDK\'s status line — a job log\'s, a warning\'s, pac\'s, or what the SDK\'s own message goes on to say — only the line the SDK\'s error itself has', async () => {
  const secret = 'CedarPineSecret42';
  const lookalike = `HTTP 400 from https://diagnostic.example/${secret}: rejected`;
  // The job log.
  assert.strictEqual(await failedImportWithLog(secret, logSaying(lookalike)), `${LOG_LEAD}${WITHHELD("the job log's text")}`);
  assert.strictEqual(await failedImportWithLog(PLAIN, logSaying(`HTTP 400 from https://diagnostic.example/${PLAIN}: rejected`), TEXT_TYPE), `${LOG_LEAD}HTTP 400 from https://diagnostic.example/<redacted>: rejected`);
  // The SDK's own message: the line it really has is kept in front of the notice; what the platform said after it, which can look like another one, is text.
  const { request } = importFiles({ EnvironmentVariables: [{ SchemaName: 'new_Url', Value: secret }], ConnectionReferences: [] });
  const { sdk } = sdkStub();
  sdk.importSolution = failAs(withWarnings(importFailureOf(400, lookalike), [lookalike, `HTTP 400 from ${ENV}/api/data/v9.0/stagesolutionuploads(x): cleanup said ${secret}`]));
  await assert.rejects(ss.runImport(request, { ...stagedAs({ new_Url: SECRET_TYPE }, sdk), importJobId: JOB, readJobLog: async () => null }), (err) => {
    assert.strictEqual(err.message, `HTTP 400 from ${ENV}/api/data/v9.0/ImportSolution: ${WITHHELD('message')}`);
    assert.deepStrictEqual(err.warnings, [WITHHELD('warning'), WITHHELD('warning')], 'no warning keeps a line of its own, whatever it begins with');
    assert.ok(!JSON.stringify({ message: err.message, warnings: err.warnings }).includes(secret));
    return true;
  });
  // An error whose message does not begin with what its own fields would make has no status line to keep — the whole of it is withheld.
  const rebuilt = importFiles({ EnvironmentVariables: [{ SchemaName: 'new_Url', Value: secret }], ConnectionReferences: [] });
  const rebuiltSdk = sdkStub().sdk;
  rebuiltSdk.importSolution = failAs(Object.assign(new Error(`HTTP 400 from ${ENV}/api/data/v9.0/ImportSolution: ${secret}`), { url: `${ENV}/api/data/v9.0/ImportSolution`, statusCode: 409, code: 'CONNECTION_ERROR' }));
  await assert.rejects(ss.runImport(rebuilt.request, { ...stagedAs({ new_Url: SECRET_TYPE }, rebuiltSdk), importJobId: JOB, readJobLog: async () => null }), (err) => err.message === WITHHELD('message'));
  // pac's text.
  const viaPac = importFiles({ EnvironmentVariables: [{ SchemaName: 'new_Url', Value: secret }], ConnectionReferences: [], CanvasApps: [{ Name: 'x' }] });
  const pacSdk = sdkStub().sdk;
  pacSdk.importSolution = async () => { throw refusal('INVALID_ARGUMENT', listSentence('CanvasApps')); };
  const { pac } = fakePac(() => ({ status: 1, stdout: '', stderr: `Error: ${lookalike}` }));
  await assert.rejects(ss.runImport(viaPac.request, { sdkFirst: stubSdkFirst(pacSdk), pac }), (err) => {
    assert.strictEqual(err.message, `\`pac solution import\` failed (exit 1): ${WITHHELD('text')}`);
    return true;
  });
});

test('the job log is read only for a failure of the ImportSolution request itself: not for a refusal before it, a staging, an export, or a pac import', async () => {
  const reads = [];
  const readJobLog = async () => { reads.push(1); return JOB_LOG; };
  const cases = [
    importFailureOf(400, 'staging said no', `${ENV}/api/data/v9.0/StageSolution`),
    importFailureOf(400, 'export said no', `${ENV}/api/data/v9.0/ExportSolution`),
    refusal('INVALID_ARGUMENT', 'importSolution: deploymentSettings does not match the package'),
    refusal('SOLUTION_STAGING_FAILED', 'did not pass'),
    new Error('plain'),
  ];
  for (const failure of cases) {
    const { request } = importFiles();
    const { sdk } = sdkStub();
    sdk.importSolution = failAs(failure);
    await assert.rejects(ss.runImport(request, { sdkFirst: stubSdkFirst(sdk), importJobId: JOB, readJobLog }));
  }
  const viaPac = importFiles({ ...filled(), CanvasApps: [{ Name: 'x' }] });
  const { sdk: pacSdk } = sdkStub();
  pacSdk.importSolution = failAs(refusal('INVALID_ARGUMENT', listSentence('CanvasApps')));
  const failed = fakePac(() => ({ status: 1, stdout: '', stderr: 'Error: x' }));
  await assert.rejects(ss.runImport(viaPac.request, { sdkFirst: stubSdkFirst(pacSdk), pac: failed.pac, importJobId: JOB, readJobLog }));
  assert.deepStrictEqual(reads, [], 'no log was read');
});

test('without a stand-in the log is one GET of importjobs(<id>)?$select=data through the az-token client, once — a failing read is not repeated and its 401 is not refreshed', async () => {
  const sent = [];
  const answer = (statusCode, body) => ({ statusCode, headers: {}, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const http = (answers) => ({ getToken: () => 'dataverse-token', sleep: async () => {}, request: async (options) => { sent.push(options); return answers.shift(); } });
  const reason = await ss.readImportJobFailure(ENV, JOB, { http: http([answer(200, { importjobid: JOB, data: JOB_LOG })]) });
  assert.strictEqual(reason, "Could not find connection '00000000000000000000000000000abc' for API 'shared_sharepointonline'.");
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].method, 'GET');
  assert.strictEqual(new URL(sent[0].url).origin, ENV);
  assert.strictEqual(decodeURIComponent(new URL(sent[0].url).pathname + new URL(sent[0].url).search).replace(/^\/api\/data\/v9\.\d+\//, ''), `importjobs(${JOB})?$select=data`);
  for (const status of [500, 503, 401, 404, 429]) {
    sent.length = 0;
    assert.strictEqual(await ss.readImportJobFailure(ENV, JOB, { http: http([answer(status, '{}'), answer(200, { data: JOB_LOG })]) }), null, String(status));
    assert.strictEqual(sent.length, 1, `HTTP ${status}: one request`);
  }
  assert.strictEqual(await ss.readImportJobFailure(ENV, JOB, { http: http([{ error: 'Request timed out' }]) }), null);
  assert.strictEqual(await ss.readImportJobFailure(ENV, JOB, { http: http([answer(200, { data: 42 })]) }), null);
  assert.strictEqual(await ss.readImportJobFailure(ENV, JOB, { http: http([answer(200, 'plain text')]) }), null);
});

test('a job log that is never answered does not hold the failure report: the wait is bounded, and the failure stands as it was', { timeout: 15000 }, async () => {
  const hanging = { getToken: () => 'dataverse-token', sleep: async () => {}, request: () => new Promise(() => {}) };
  const started = Date.now();
  assert.strictEqual(await ss.readImportJobFailure(ENV, JOB, { http: hanging, jobLogTimeoutMs: 40 }), null);
  assert.ok(Date.now() - started < 10000, 'it gave up at its own limit');
  // Through a whole import: the original message, the job named, nothing else.
  const { request } = importFiles();
  const { sdk } = sdkStub();
  sdk.importSolution = failAs(importFailureOf(400, 'An unexpected error occurred.'));
  await assert.rejects(ss.runImport(request, { sdkFirst: stubSdkFirst(sdk), importJobId: JOB, http: hanging, jobLogTimeoutMs: 40 }), (err) => {
    assert.strictEqual(err.message, `HTTP 400 from ${ENV}/api/data/v9.0/ImportSolution: An unexpected error occurred.`);
    assert.strictEqual(err.importJobId, JOB);
    return true;
  });
});

// --- what a failure prints ----------------------------------------------------------------------------------------------------------

test('a failure is described by its message and — each only when there is one — its code, the HTTP status, the reason pac was asked, its import job and its cleanup warnings', () => {
  assert.deepStrictEqual(ss.describeFailure(new Error('plain')), { ok: false, error: 'plain' });
  const error = Object.assign(new Error('boom'), { code: 'PAC_FAILED', fallback: { code: 'X', message: 'y' }, importJobId: JOB });
  assert.deepStrictEqual(ss.describeFailure(error, () => ['a staged copy was left']), {
    ok: false, error: 'boom', code: 'PAC_FAILED', fallback: { code: 'X', message: 'y' }, importJobId: JOB, warnings: ['a staged copy was left'],
  });
  assert.deepStrictEqual(ss.describeFailure(error, () => []), { ok: false, error: 'boom', code: 'PAC_FAILED', fallback: { code: 'X', message: 'y' }, importJobId: JOB });
  // The status of the answer that failed it is a field of its own — it stays when the text is withheld — and is left out when there was no answer (0) or no status.
  assert.strictEqual(ss.describeFailure(Object.assign(new Error('m'), { code: 'CONNECTION_ERROR', statusCode: 504 })).status, 504);
  assert.ok(!('status' in ss.describeFailure(Object.assign(new Error('m'), { statusCode: 0 }))));
  assert.ok(!('status' in ss.describeFailure(new Error('m'))));
  // An error that carries its warnings already read and cleaned (an import's) is described by those; the raw ones are not read again.
  const cleaned = Object.assign(new Error('m'), { warnings: ['cleaned'] });
  assert.deepStrictEqual(ss.describeFailure(cleaned, () => { throw new Error('the raw warnings must not be read'); }).warnings, ['cleaned']);
});

async function runCli(argv, { readCleanupWarnings = () => undefined } = {}) {
  const emitted = [];
  const requires = {
    './lib/dataverse-auth.js': {
      ...realAuth,
      emitResult: (ok, payload, options) => {
        emitted.push({ ok, payload, options });
        const exit = new Error(`process.exit(${ok ? 0 : 1})`);
        exit.exitCode = ok ? 0 : 1;
        throw exit;
      },
    },
    './lib/maker-sdk.js': { readCleanupWarnings },
    './lib/sdk-first.js': { sdkFirst: async () => { throw new Error('unexpected SDK read'); } },
  };
  const cli = loadCli(SCRIPT, { requires, argv });
  let exitCode = 0;
  try {
    await cli.main();
  } catch (err) {
    if (typeof err.exitCode !== 'number') throw err;
    exitCode = err.exitCode;
  }
  return { emitted, exitCode, stdout: cli.stdoutText(), stderr: cli.stderrText() };
}

test('a usage error exits 1 with the problem and the usage on stderr, and prints nothing on stdout', async () => {
  const run = await runCli(['template', '--env', ENV, '--out', 'o.json']);
  assert.strictEqual(run.exitCode, 1);
  assert.strictEqual(run.stdout, '');
  assert.match(run.stderr, /✗ name the solution to export with --solution, or a package with --package/);
  assert.match(run.stderr, /Usage:\n {2}node scripts\/solution-settings\.js template --env/);
  assert.deepStrictEqual(run.emitted, []);
});

test('a failure prints one ok:false line as ASCII with the SDK\'s cleanup warnings, and exits 1', async () => {
  const dir = tempDir();
  const { pkg } = files(dir);
  // The real script, unstubbed past its edges: a package that is not a zip fails the run before any SDK is made.
  fs.writeFileSync(pkg, 'text');
  const run = await runCli(['template', '--package', pkg, '--out', path.join(dir, 'o.json')], { readCleanupWarnings: () => ['a staged copy was left'] });
  assert.strictEqual(run.exitCode, 1);
  assert.strictEqual(run.emitted[0].ok, false);
  assert.deepStrictEqual(run.emitted[0].options, { ascii: true });
  assert.strictEqual(run.emitted[0].payload.code, 'PACKAGE_UNREADABLE');
  assert.deepStrictEqual(run.emitted[0].payload.warnings, ['a staged copy was left']);
});
