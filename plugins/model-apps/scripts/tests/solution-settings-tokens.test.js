'use strict';
// The access token never leaves solution-settings.js — not on stdout, not on stderr, not in a file it writes — whichever path the words that quote it take. The Dataverse HttpClient takes the token
// out of every answer that is not a success (lib/sdk-http-client.js), and a success is the caller's data. But an answer of HTTP 200 can be a FAILURE all the same: StageSolution answers 200 with
// `StageSolutionStatus: "Failed"` and the SDK turns that into SOLUTION_STAGING_FAILED, quoting the dependencies and validation results it was given — words of the platform, in a message the script prints.
// So what the script prints is cleaned where it leaves: the text of another party that an import shows is taken out of every token the run sent as it is sanitized, and everything written to stdout or
// stderr — and the file `template` writes, and the note a process that is ending leaves — goes through the one function that takes the recorded tokens out (guardOutput, leaving).
//
// Real processes over the fake platform: the real script, the real vendored SDK and the real az-token client (helpers/run-with-fakes.js), with the platform configured to REQUIRE a recognisable token on
// every Dataverse request, and then to quote it in the one place a case is about.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const ss = require('../solution-settings.js');
const { createCloud, ORG } = require('./helpers/fake-power-platform.js');
const { runScript } = require('./helpers/run-with-fakes.js');

const SOLUTION_SETTINGS = path.resolve(__dirname, '..', 'solution-settings.js');
const STRAY_OUTPUT_PRELOAD = path.resolve(__dirname, 'helpers', 'fake-stray-output-preload.js');

// Three base64url parts joined by dots, as a bearer token is, each long enough (24 or more) for the scrubber to take it out alone — and short enough for the SDK's quoting (it cuts a text at 120 characters)
// to keep it whole. Not a credential: nothing here is, or ever was, valid.
const [HEADER, PAYLOAD, SIGNATURE] = ['syntheticHeaderPartNotACredential', 'syntheticPayloadPartNotACredential', 'syntheticSignaturePartNotACredential'];
const TOKEN = [HEADER, PAYLOAD, SIGNATURE].join('.');
const PIECES = [TOKEN, HEADER, PAYLOAD, SIGNATURE];

const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(' a solution package')]);
const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const inRunDir = (name) => (dir) => path.join(dir, name);
const stringsIn = (value) => (typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...stringsIn(item)]) : []);

const SETTINGS = JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'new_Url', Value: 'https://synthetic.example.test' }], ConnectionReferences: [] });
// A feature only pac applies (a non-empty Workflows list): the SDK refuses it before it sends anything, and pac imports.
const PAC_ONLY_SETTINGS = JSON.stringify({ ...JSON.parse(SETTINGS), Workflows: [{ WorkflowId: '1' }] });
const STAGE = { variables: [{ schemaName: 'new_Url', defaultValue: 'https://default.example' }] };
const PAC_IMPORTS = { responses: [{ match: ['solution', 'import'], status: 0, stdout: 'Solution Imported successfully.' }] };

function importing({ settings = SETTINGS, solution = {}, platform = {}, pac, env } = {}) {
  return runScript('solution-settings.js', ['import', '--env', ORG, '--package', inRunDir('solution.zip'), '--settings', inRunDir('filled.json')], {
    platform: { tokens: { dataverse: TOKEN }, solution: { packageBase64: ZIP.toString('base64'), stage: STAGE, ...solution }, ...platform },
    files: { 'solution.zip': ZIP, 'filled.json': settings },
    pac,
    env,
  });
}
function templating({ solution = {}, platform = {}, pac, env } = {}) {
  return runScript('solution-settings.js', ['template', '--env', ORG, '--solution', 'ContosoDemo', '--out', inRunDir('settings.json')], {
    platform: { tokens: { dataverse: TOKEN }, solution: { packageBase64: ZIP.toString('base64'), stage: STAGE, ...solution }, ...platform },
    pac,
    env,
    read: ['settings.json'],
  });
}
const pacWritesTemplate = (content) => ({ responses: [{ match: ['solution', 'create-settings'], writeFlag: '--settings-file', writeContent: content, stdout: 'Deployment settings file created.\n' }] });

// Everything a run put anywhere a person or a program can read it: both streams, each string of the JSON line on stdout (a quote or a backslash in it is escaped there), and the files the run wrote.
function assertNoToken(run, what) {
  const printed = [run.stdout, run.stderr, ...run.lines.flatMap((line) => { try { return stringsIn(JSON.parse(line)); } catch { return []; } }), ...Object.values(run.outputs).filter((text) => typeof text === 'string')];
  for (const text of printed) {
    for (const piece of PIECES) assert.ok(!text.includes(piece), `${what}: the token (${piece === TOKEN ? 'whole' : 'a part'}) reached the output:\n${text}`);
  }
}

// --- the main case: a staging that failed with HTTP 200 ---------------------------------------------------------------------------------------------

test('an import whose StageSolution answered 200 with a failed status prints the dependency that quotes the token WITHOUT it — the status, the code and the rest of the message stay, and nothing was sent', () => {
  const run = importing({ solution: { stage: { status: 'Failed', missingDependencies: [{ Message: `the component new_x needs ${TOKEN}` }] } } });
  assert.strictEqual(run.status, 1);
  const out = JSON.parse(run.lines[0]);
  assert.deepStrictEqual([out.ok, out.code], [false, 'SOLUTION_STAGING_FAILED']);
  assert.match(out.error, /the package did not pass StageSolution in this environment \(status "Failed"\)\. Missing dependencies: the component new_x needs <token>\. Validation: none\./);
  assert.strictEqual(run.stderr.trim(), out.error, 'stderr says the same');
  assert.strictEqual(run.state.importSends, 0, 'ImportSolution was never sent');
  assert.deepStrictEqual(run.pacCalls, [], 'and pac was not asked: the platform said the package cannot go in');
  assertNoToken(run, 'a token in a missing dependency');
});

test('the same for a validation result, and for one part of the token alone — the SDK quotes what it was given, whichever the shape', () => {
  const validation = importing({ solution: { stage: { status: 'Failed', validation: [{ Message: `the rule new_rule rejected ${TOKEN}` }] } } });
  assert.strictEqual(validation.status, 1);
  assert.match(JSON.parse(validation.lines[0]).error, /Missing dependencies: none\. Validation: the rule new_rule rejected <token>\./);
  assertNoToken(validation, 'a token in a validation result');

  const part = importing({ solution: { stage: { status: 'Failed', missingDependencies: [{ Message: `claim ${PAYLOAD} is not allowed` }], validation: [{ Message: `signed with ${SIGNATURE}` }] } } });
  assert.strictEqual(part.status, 1);
  assert.match(JSON.parse(part.lines[0]).error, /Missing dependencies: claim <token> is not allowed\. Validation: signed with <token>\./);
  assertNoToken(part, 'a part of the token in a dependency and in a validation result');

  const both = importing({ solution: { stage: { status: 'Failed', missingDependencies: [{ Message: `needs ${TOKEN}` }], validation: [{ Message: `rejected ${TOKEN}` }] } } });
  assert.strictEqual(both.status, 1);
  assert.strictEqual(JSON.parse(both.lines[0]).code, 'SOLUTION_STAGING_FAILED');
  assertNoToken(both, 'a token in both');
});

test('a dependency that is not an object is quoted by the SDK as JSON text — the token in it is taken out of that text too', () => {
  const run = importing({ solution: { stage: { status: 'Failed', missingDependencies: [`bare ${TOKEN}`], validation: [{ Code: 1, Detail: TOKEN }] } } });
  assert.strictEqual(run.status, 1);
  const out = JSON.parse(run.lines[0]);
  assert.strictEqual(out.code, 'SOLUTION_STAGING_FAILED');
  assert.match(out.error, /Missing dependencies: "bare <token>"\. Validation: \{"Code":1,"Detail":"<token>"\}\./);
  assertNoToken(run, 'a token in a dependency that is a string');
});

test('a message of the platform that holds NO token is printed exactly as it was — the cleaning takes out only what the run sent', () => {
  const run = importing({ solution: { stage: { status: 'Failed', missingDependencies: [{ Message: 'the component new_x depends on new_y' }], validation: [{ Message: 'the rule new_rule is not met' }] } } });
  assert.strictEqual(run.status, 1);
  assert.strictEqual(JSON.parse(run.lines[0]).error, 'importSolution: the package did not pass StageSolution in this environment (status "Failed"). Missing dependencies: the component new_x depends on new_y. Validation: the rule new_rule is not met. Its components cannot be checked against deploymentSettings. Nothing was imported.');
});

// --- every other diagnostic of an import ----------------------------------------------------------------------------------------------------------

// A StageSolution answer of HTTP 200 that the SDK cannot read: it refuses (SOLUTION_STAGING_UNREADABLE) and pac imports, with the SDK's words as the reason it was asked — the `fallback` of the answer.
const UNREADABLE = { stage: { answer: json(200, { StageSolutionResults: { StageSolutionStatus: `odd ${TOKEN}`, SolutionComponentsDetails: [] } }) } };

test('the reason pac was asked — the SDK\'s account of a staging answer it cannot read, which quotes the token — is printed without it, on success and on failure', () => {
  const imported = importing({ solution: UNREADABLE, pac: PAC_IMPORTS });
  assert.strictEqual(imported.status, 0, imported.stderr);
  const out = JSON.parse(imported.lines[0]);
  assert.deepStrictEqual([out.ok, out.source, out.fallback.code], [true, 'pac', 'SOLUTION_STAGING_UNREADABLE']);
  assert.match(out.fallback.message, /StageSolutionStatus is "odd <token>"/);
  assertNoToken(imported, 'the fallback of a successful pac import');

  const failed = importing({ solution: UNREADABLE, pac: { responses: [{ match: ['solution', 'import'], status: 1, stderr: 'Error: the import was refused.\n' }] } });
  assert.strictEqual(failed.status, 1);
  const failure = JSON.parse(failed.lines[0]);
  assert.deepStrictEqual([failure.ok, failure.code, failure.fallback.code], [false, 'PAC_FAILED', 'SOLUTION_STAGING_UNREADABLE']);
  assert.match(failure.fallback.message, /StageSolutionStatus is "odd <token>"/);
  assertNoToken(failed, 'the fallback of a failed pac import');

  const missing = importing({ solution: UNREADABLE });
  assert.strictEqual(missing.status, 1);
  assert.strictEqual(JSON.parse(missing.lines[0]).code, 'PAC_MISSING');
  assertNoToken(missing, 'the fallback when pac is not installed');
});

test('what pac prints is cleaned too — a failure that quotes the token is printed without it (pac is asked after a request was sent, so the run has been given its token)', () => {
  const run = importing({ solution: UNREADABLE, pac: { responses: [{ match: ['solution', 'import'], status: 1, stderr: `Error: the server rejected bearer ${TOKEN}\n` }] } });
  assert.strictEqual(run.status, 1);
  const out = JSON.parse(run.lines[0]);
  assert.strictEqual(out.code, 'PAC_FAILED');
  assert.match(out.error, /Error: the server rejected bearer <token>/);
  assertNoToken(run, 'pac\'s failure text');
});

test('the warnings of a run — what the SDK could not clean up — and the reason read from a failed import\'s job log carry no token (the two paths that were already cleaned stay so)', () => {
  const warned = importing({ solution: { deleteStagingAnswer: json(500, { error: { message: `could not delete, ${TOKEN}` } }) } });
  assert.strictEqual(warned.status, 0, warned.stderr);
  const warning = JSON.parse(warned.lines[0]).warnings;
  assert.strictEqual(warning.length, 1);
  assert.match(warning[0], /could not be deleted: HTTP 500 .*could not delete, <token>/);
  assertNoToken(warned, 'the warning of a staged copy that could not be deleted');

  const log = `<importexportxml succeeded="failure" status="Import failed"><result result="failure" errorcode="0x80048d19" errortext="rejected ${TOKEN} for new_t" /></importexportxml>`;
  const failed = importing({ solution: { importAnswer: json(400, { error: { code: '0x80048d19', message: 'the import failed' } }), jobLog: log } });
  assert.strictEqual(failed.status, 1);
  assert.match(JSON.parse(failed.lines[0]).error, /says: rejected <token> for new_t$/);
  assertNoToken(failed, 'the reason read from the job log');
});

// --- template -------------------------------------------------------------------------------------------------------------------------------

test('template: the staging failure that makes pac read the package is printed as the reason pac was asked — without the token its dependency quotes — and pac\'s own file is written as pac wrote it', () => {
  const pacFile = JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'new_Url', Value: '' }], ConnectionReferences: [] }, null, 2);
  const run = templating({ solution: { stage: { status: 'Failed', missingDependencies: [{ Message: `the component new_x needs ${TOKEN}` }], validation: [{ Message: `rejected ${TOKEN}` }] } }, pac: pacWritesTemplate(pacFile) });
  assert.strictEqual(run.status, 0, run.stderr);
  const out = JSON.parse(run.lines[0]);
  assert.deepStrictEqual([out.ok, out.source, out.fallback.code], [true, 'pac', 'SOLUTION_STAGING_FAILED']);
  assert.match(out.fallback.message, /Missing dependencies: the component new_x needs <token>\. Validation: rejected <token>\./);
  assert.strictEqual(run.outputs['settings.json'], pacFile, 'a file with no token in it is written byte for byte');
  assertNoToken(run, 'the fallback of a template');
});

test('template: a failure of pac after the SDK refused carries the SDK\'s words as `fallback` — printed without the token', () => {
  const run = templating({ solution: { stage: { status: 'Failed', missingDependencies: [{ Message: `needs ${TOKEN}` }] } } });
  assert.strictEqual(run.status, 1);
  const out = JSON.parse(run.lines[0]);
  assert.deepStrictEqual([out.ok, out.code, out.fallback.code], [false, 'PAC_MISSING', 'SOLUTION_STAGING_FAILED']);
  assert.match(out.fallback.message, /Missing dependencies: needs <token>\./);
  assertNoToken(run, 'the fallback of a failed template');
  assert.strictEqual(run.outputs['settings.json'], null, 'no file was written');
});

test('template: the file it writes is cleaned as well — a default value of the package, or a template pac wrote, that holds the token is written without it, and is still the JSON document it was', () => {
  const fromSdk = templating({ solution: { stage: { variables: [{ schemaName: 'new_Url', defaultValue: `https://default.example/?access=${TOKEN}` }] } } });
  assert.strictEqual(fromSdk.status, 0, fromSdk.stderr);
  assert.strictEqual(JSON.parse(fromSdk.lines[0]).source, 'sdk');
  assertNoToken(fromSdk, 'a default value of the package');
  assert.strictEqual(JSON.parse(fromSdk.outputs['settings.json']).EnvironmentVariables[0].DefaultValue, 'https://default.example/?access=<token>');

  const pacFile = JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'new_Url', Value: '', DefaultValue: `Bearer ${TOKEN}` }], ConnectionReferences: [] }, null, 2);
  const fromPac = templating({ solution: { stage: { status: 'Failed', missingDependencies: [{ Message: 'needs new_y' }] } }, pac: pacWritesTemplate(pacFile) });
  assert.strictEqual(fromPac.status, 0, fromPac.stderr);
  assertNoToken(fromPac, 'a template pac wrote');
  assert.strictEqual(JSON.parse(fromPac.outputs['settings.json']).EnvironmentVariables[0].DefaultValue, 'Bearer <token>');

  const plain = templating({ solution: { stage: { variables: [{ schemaName: 'new_Url', defaultValue: 'https://default.example' }] } } });
  assert.strictEqual(JSON.parse(plain.outputs['settings.json']).EnvironmentVariables[0].DefaultValue, 'https://default.example', 'a file with no token in it is unchanged');
});

// --- the one place everything leaves ----------------------------------------------------------------------------------------------------------

test('whatever code the script does not own writes to its streams after the run has its token — a library\'s console.error or console.log — is cleaned on the way out, and the result line stays whole', () => {
  const stray = `a library says ${TOKEN} and ${PAYLOAD}`;
  const run = importing({ env: { NODE_OPTIONS: `--require=${JSON.stringify(STRAY_OUTPUT_PRELOAD)}`, STRAY_OUTPUT: stray } });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.strictEqual(run.stderr.trim(), 'a library says <token> and <token>', 'the stray line on stderr is there, cleaned');
  assert.strictEqual(run.lines[0], 'a library says <token> and <token>', 'and so is the one on stdout');
  assert.deepStrictEqual([JSON.parse(run.lines[1]).ok, JSON.parse(run.lines[1]).source], [true, 'sdk'], 'the result line is untouched');
  assertNoToken(run, 'stray output');
});

test('the output of a normal run is byte for byte what it was: a result with no token in it is written as it is, on stdout and on stderr', () => {
  const imported = importing();
  assert.strictEqual(imported.status, 0, imported.stderr);
  assert.strictEqual(imported.stderr, '');
  assert.match(imported.stdout, /^\{"ok":true,"source":"sdk","importJobId":"[0-9a-f-]{36}","applied":\{"environmentVariables":\["new_Url"\],"connectionReferences":\[\]\}\}\n$/);
  const usage = runScript('solution-settings.js', ['import', '--env', ORG], { platform: {} });
  assert.strictEqual(usage.status, 1);
  assert.strictEqual(usage.stdout, '');
  assert.match(usage.stderr, /^✗ --package is required\nUsage:\n/);
});

// --- a future path cannot miss it -------------------------------------------------------------------------------------------------------------

// The guard on the streams covers whatever is written there. A file, and a write to a descriptor, are not streams, so the script's own writes of that kind are accounted for here: a new one fails this test, and
// whoever adds it decides — it is output, and goes through `leaving` — or it is data handed to another program, and is added here with the reason.
test('every place solution-settings.js writes a file or a descriptor is accounted for — what is output goes through the function that takes the tokens out, and the rest is data for pac', () => {
  const code = fs.readFileSync(SOLUTION_SETTINGS, 'utf8').split(/\r?\n/).filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join('\n');
  const calls = (pattern) => [...code.matchAll(pattern)].map((match) => match[0].trim());

  // Nothing but these two functions of `fs` writes anything: not an append, not a stream, not a copy, a rename or a link — each of those would be a way out that this test has not seen.
  const writers = new Set([...code.matchAll(/\bfs\.(\w+)/g)].map((match) => match[1]).filter((name) => /^(write|append|createWrite|copy|rename|truncate|link|symlink)/.test(name)));
  assert.deepStrictEqual([...writers].sort(), ['writeFileSync', 'writeSync']);
  assert.deepStrictEqual(calls(/\bconsole\.\w+\(/g), [], 'nothing is printed with console: a result goes through emitResult, which writes to the guarded streams');

  // OUTPUT: the file `template` writes, and the note a process that is ending leaves on stderr, are cleaned by `leaving` in the very call that writes them.
  const outputs = [...calls(/\bwriteFileSafe\([^\n]*/g), ...calls(/\bfs\.writeSync\([^\n]*/g)];
  assert.strictEqual(outputs.length, 2, outputs.join('\n'));
  for (const output of outputs) assert.match(output, /\bleaving\(/, `an output that does not go through leaving: ${output}`);

  // DATA for pac, which is not output: emptying the copy of the settings that stays when its folder cannot be removed (it must keep no value), and the package the SDK exported (pac reads the zip).
  assert.deepStrictEqual(calls(/\bfs\.writeFileSync\([^\n]*/g), ["fs.writeFileSync(path.join(dir, name), '');", 'fs.writeFileSync(zip, packageBytes);']);

  // Whatever is written to a stream is cleaned by the guard main installs before it reads its arguments, and every call that works for the run is given the function it needs.
  assert.match(code, /async function main\(\) \{\s*(\/\/[^\n]*\s*)*const tokens = new Set\(\);\s*guardOutput\(tokens\);/);
  assert.strictEqual(calls(/\binWorkFolder\(/g).length - 1, calls(/\bleaving: deps\.leaving\b/g).length, 'every caller of inWorkFolder gives it `leaving` (the first match is its definition)');
});

// --- the pieces ---------------------------------------------------------------------------------------------------------------------------------

test('in process, the error an import throws and the reason it carries for pac are clean too — what is cleaned where the words are shown does not wait for the output', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokens-inproc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const request = { command: 'import', env: ORG, packagePath: path.join(dir, 'solution.zip'), settingsPath: path.join(dir, 'filled.json') };
  fs.writeFileSync(request.packagePath, ZIP);
  fs.writeFileSync(request.settingsPath, SETTINGS);
  const seams = (solution) => {
    const cloud = createCloud({ tokens: { dataverse: TOKEN }, solution: { packageBase64: ZIP.toString('base64'), stage: STAGE, ...solution } });
    return {
      http: { getToken: () => cloud.tokens.dataverse, request: cloud.request, sleep: async () => {} },
      privateFile: (folder, name, bytes) => { const file = path.join(folder, name); fs.writeFileSync(file, bytes); return file; },
      pac: { spawn: () => ({ status: 0, stdout: 'Solution Imported successfully.', stderr: '' }) },
    };
  };

  await assert.rejects(ss.runImport(request, seams({ stage: { status: 'Failed', missingDependencies: [{ Message: `needs ${TOKEN}` }], validation: [{ Message: `claim ${PAYLOAD}` }] } })), (error) => {
    assert.strictEqual(error.code, 'SOLUTION_STAGING_FAILED');
    assert.match(error.message, /Missing dependencies: needs <token>\. Validation: claim <token>\./);
    for (const piece of PIECES) assert.ok(!error.message.includes(piece), error.message);
    return true;
  });

  const imported = await ss.runImport(request, seams(UNREADABLE));
  assert.strictEqual(imported.source, 'pac');
  assert.match(imported.fallback.message, /StageSolutionStatus is "odd <token>"/);
  for (const piece of PIECES) assert.ok(!JSON.stringify(imported).includes(piece), JSON.stringify(imported));
});

test('guardOutput: a guarded stream is written the text — and the bytes — it was given with the tokens taken out, as they are written; a chunk that holds none is passed on as the very same object', () => {
  const written = [];
  const stream = { write(chunk, ...rest) { written.push([this === stream, chunk, ...rest]); return 'the stream\'s own answer'; } };
  const tokens = new Set();
  const cb = () => {};
  ss.guardOutput(tokens, [stream]);

  assert.strictEqual(stream.write('before any token\n'), 'the stream\'s own answer', 'what the stream answers is what the caller gets');
  tokens.add(TOKEN); // a token the run is given later is taken out too
  stream.write(`a ${TOKEN} b ${PAYLOAD} c\n`, 'utf8', cb);
  const plainBytes = Buffer.from('no token in these bytes \u00e9\n');
  stream.write(plainBytes);
  stream.write(Buffer.from(`bytes ${TOKEN}\n`));
  stream.write(new Uint8Array(Buffer.from(`typed ${SIGNATURE}`)));
  const notBytes = { not: 'a chunk' };
  stream.write(notBytes);

  assert.deepStrictEqual(written[0], [true, 'before any token\n']);
  assert.deepStrictEqual(written[1], [true, 'a <token> b <token> c\n', 'utf8', cb], 'the encoding and the callback travel on');
  assert.strictEqual(written[2][1], plainBytes, 'bytes with no token in them are not decoded into anything else');
  assert.strictEqual(Buffer.isBuffer(written[3][1]) && written[3][1].toString('utf8'), 'bytes <token>\n');
  assert.strictEqual(Buffer.from(written[4][1]).toString('utf8'), 'typed <token>');
  assert.strictEqual(written[5][1], notBytes, 'whatever else is given is left for the stream to refuse');
});

test('writeNote writes the note to stderr\'s descriptor, synchronously, through the function it is given — and gives up quietly when nothing can be written', (t) => {
  const real = fs.writeSync;
  const calls = [];
  t.after(() => { fs.writeSync = real; });
  fs.writeSync = (fd, text) => { calls.push([fd, text]); };
  ss.writeNote(`The folder x could not be removed (EBUSY) ${TOKEN}.`, (text) => text.split(TOKEN).join('<token>'));
  assert.deepStrictEqual(calls, [[2, 'The folder x could not be removed (EBUSY) <token>.\n']]);
  fs.writeSync = () => { throw Object.assign(new Error('EPIPE'), { code: 'EPIPE' }); };
  assert.doesNotThrow(() => ss.writeNote('nobody is listening', (text) => text));
});

// The note is written when the process ENDS while pac runs, which only a real process end can say; here the process is a stand-in (lib/exit-cleanup.js's own seam, `deps.process`), the folder is held as a scanner holds it,
// and the folder's own name holds the token — the one place a plugin's note could ever quote one. The token is a short one, so that the path stays well inside Windows's 260 characters wherever the temp folder is.
const NOTE_TOKEN = 'syntheticNoteTokenNotACredential';
test('the note a process that is ending leaves about a folder that stayed goes through the run\'s function — the token its path holds is taken out', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tokens-note-'));
  const temp = path.join(base, NOTE_TOKEN);
  fs.mkdirSync(temp);
  const old = Object.fromEntries(['TEMP', 'TMP', 'TMPDIR'].map((name) => [name, process.env[name]]));
  const realRemove = fs.rmSync;
  const realWrite = fs.writeSync;
  const held = new Set();
  const notes = [];
  t.after(() => {
    fs.rmSync = realRemove;
    fs.writeSync = realWrite;
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    realRemove(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  for (const name of Object.keys(old)) process.env[name] = temp;
  // A removal of a work folder fails as a scanner's lock makes it fail.
  fs.rmSync = (target, options) => {
    if (/^solution-settings-[A-Za-z0-9]{6}$/.test(path.basename(String(target)))) {
      held.add(String(target));
      throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${target}'`), { code: 'EBUSY' });
    }
    return realRemove(target, options);
  };
  fs.writeSync = (...args) => (args[0] === 2 ? notes.push(args[1]) : realWrite(...args));

  const proc = new EventEmitter();
  const cloud = createCloud({ tokens: { dataverse: NOTE_TOKEN }, solution: { packageBase64: ZIP.toString('base64'), stage: STAGE } });
  const request = { command: 'import', env: ORG, packagePath: path.join(base, 'solution.zip'), settingsPath: path.join(base, 'filled.json') };
  fs.writeFileSync(request.packagePath, ZIP);
  fs.writeFileSync(request.settingsPath, PAC_ONLY_SETTINGS);
  const refusal = { code: 'SOLUTION_STAGING_UNREADABLE', message: 'importSolution: StageSolution\'s reply could not be read. Nothing was imported.' };
  await ss.runImport(request, {
    process: proc,
    http: { getToken: () => cloud.tokens.dataverse, request: cloud.request, sleep: async () => {} },
    // The copy of the settings is made the plain way: what is under test is the note, not the access list (test/solution-settings-snapshot.test.js is).
    privateFile: (folder, name, bytes) => { const file = path.join(folder, name); fs.writeFileSync(file, bytes); return file; },
    // The SDK's first request is what hands the run its token; the refusal then sends the file to pac.
    sdkFirst: async (env, plan) => {
      await plan.httpClient(env).get(`${ORG}/api/data/v9.0/WhoAmI`);
      return { source: 'pac', value: await plan.fromPac(refusal), fallback: refusal };
    },
    pac: {
      spawn: () => {
        // The process ends while pac runs: its cleanup tries to remove the folder, which a lock holds, and says so on stderr.
        proc.emit('exit', 0);
        return { status: 0, stdout: 'Solution Imported successfully.', stderr: '' };
      },
    },
  });
  assert.strictEqual(held.size > 0, true, 'the work folder was held');
  assert.strictEqual(notes.length, 1, notes.join('\n'));
  assert.match(notes[0], /^The folder .*<token>.* could not be removed \(EBUSY\)/, 'the note is there, and says where the folder is');
  assert.ok(!notes[0].includes(NOTE_TOKEN), `the note repeats the token: ${notes[0]}`);
});
