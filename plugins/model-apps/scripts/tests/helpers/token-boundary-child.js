'use strict';
// A REAL PROCESS that does what a script does with a failure the SDK raised, a warning it returned and an answer the service sent — prints them on stdout and stderr, writes them into the build's journal, its baseline and
// the files a download writes — so a test can read what actually reached the process's file descriptors and its folder, and not what a function was handed. Run by tests/output-token-real-bundle.test.js and
// tests/output-token-boundary.test.js:
//   node token-boundary-child.js <scenario> [<json parameters>]
// with TOKEN_BOUNDARY_DIR (an existing folder: everything the scenario writes goes there) and TOKEN_BOUNDARY_FACTS (a file for what the scenario KNOWS — booleans and counts, never the token's text — written with the
// plain `fs`, outside anything the plugin guards). It requires no test runner: a test runner prints its own report on stdout when the process ends.
//
// Only the plugin's own code is used to make, send and print: the production SDK factory (lib/maker-sdk.js) over the real vendored bundle and the production az-token client, `emitResult`, the journal, the baseline writer
// and the safe file writer. Nothing here names the code that keeps a token out of them, so the same scenarios run against a tree that has none.
const fs = require('node:fs');
const path = require('node:path');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../../lib/maker-sdk.js');
const { createAzHttpClient } = require('../../lib/sdk-http-client.js');
const { emitResult, getAuthToken } = require('../../lib/dataverse-auth.js');
const { requireSuccessfulPush } = require('../../lib/entity-provision.js');
const { openJournal } = require('../../lib/build-journal.js');
const { writeFileAtomic } = require('../../lib/apply-snapshot-store.js');
const { writeFileSafe } = require('../../lib/safe-fs.js');
const ai = require('../../lib/artifact-intent.js');
const { refusedEdit } = require('./bpf-batch-service.js');
const { createHarness, seedForm, NOTES_CLASS_ID } = require('./form-store-harness.js');
const { INSTANCE } = require('./fake-genpage-server.js');
const { TOKEN, SECRETS, FOLDED, REFUSALS } = require('./synthetic-token.js');
const { leaksIn } = require('./token-leaks.js');

const DIR = process.env.TOKEN_BOUNDARY_DIR;
const facts = {};
const note = (name, value) => { facts[name] = value; };
const saveFacts = () => fs.writeFileSync(process.env.TOKEN_BOUNDARY_FACTS, JSON.stringify(facts));
// A new folder for an SDK's workspace, inside the folder the test reads back.
let folders = 0;
const makeDir = () => { folders += 1; const dir = path.join(DIR, `sdk-${folders}`); fs.mkdirSync(dir, { recursive: true }); return dir; };

// What a script does with a failure, in the ways the plugin's scripts do it: a progress line and a warning on stderr, the failure's message and the body the SDK kept on stdout, the build's journal and status file, the
// baseline, a file of the result, and at last the documented result printer — which exits, so what the scenario knows is saved first.
function printLikeAScript(error) {
  saveFacts();
  console.error(error);
  process.stderr.write(`WARNING: ${error.message}\n`);
  process.stdout.write(`${JSON.stringify({ progress: error.message, cause: error.cause })}\n`);
  const journal = openJournal(path.join(DIR, 'journal'));
  journal.record({ phase: 'bpf', status: 'failed', label: 'flow edit', detail: error.message });
  journal.close({ status: 'halt', error: error.message });
  writeFileAtomic(path.join(DIR, 'baseline.json'), JSON.stringify({ lastError: error.message, cause: error.cause }));
  writeFileSafe(path.join(DIR, 'result.json'), `${JSON.stringify({ error: error.message, cause: error.cause }, null, 2)}\n`);
  emitResult(false, error);
}

const scenarios = {
  // A change set the service refuses as a whole — HTTP 200 with the one part that failed — which the SDK quotes into the error it raises. `index` is the spelling in REFUSALS.
  async 'change-set'({ index }) {
    const { error } = await refusedEdit(REFUSALS[index].body, createMakerSdk, makeDir);
    note('refused', Boolean(error));
    note('errorHoldsToken', leaksIn(error, SECRETS).length > 0);
    printLikeAScript(error);
  },

  // The same, and nothing catches it: what Node itself prints when an error ends a script. `how` is how it escapes. `source` is where the error comes from: the SDK's refusal (`change-set`, spelled `index` of REFUSALS), or
  // an error a script builds from text it was handed after the process had obtained its token (`plain`). With `exitHandler` the script has a handler for the end of the process, as the ones that clean up their folders do.
  async fatal({ source = 'change-set', index = 0, how, exitHandler = false }) {
    if (exitHandler) process.on('exit', (code) => fs.writeFileSync(path.join(DIR, 'exit-handler.txt'), `ran with ${code}`));
    let error;
    if (source === 'plain') {
      note('obtained', getAuthToken(INSTANCE, { exec: () => `${TOKEN}\n` }) === TOKEN);
      error = new Error(`push form failed: Rejected bearer ${FOLDED}`);
    } else {
      error = (await refusedEdit(REFUSALS[index].body, createMakerSdk, makeDir)).error;
    }
    note('errorHoldsToken', leaksIn(error, SECRETS).length > 0);
    saveFacts();
    if (how === 'throw') setTimeout(() => { throw error; }, 0);
    else if (how === 'reject') Promise.reject(error);
    else if (how === 'async-main') (async function main() { await Promise.resolve(); throw error; })();
    else throw new Error(`unknown way ${how}`);
  },

  // The SDK writes a form, reads it back to confirm and is refused the read (HTTP 403, the token folded onto several lines): it returns the refusal as a WARNING and the push is reported as saved — the text the build prints and
  // journals, which no error object carries.
  async form() {
    const diagnostic = JSON.stringify({ error: { code: '0x80040220', message: `Rejected bearer ${FOLDED}` } });
    const state = { armed: false, ready: false, refused: 0 };
    const h = createHarness({
      createSdk: (options) => {
        const upstream = options.httpClient;
        const client = createAzHttpClient(options.instanceUrl, {
          getToken: () => TOKEN, sleep: async () => {}, random: () => 0,
          request: async ({ method, url, headers, body }) => {
            if (state.armed && state.ready && method === 'GET' && /\/systemforms\(/.test(url)) {
              state.refused += 1;
              return { statusCode: 403, headers: {}, body: diagnostic };
            }
            const verb = method.toLowerCase();
            const res = method === 'GET' || method === 'DELETE' ? await upstream[verb](url, { headers }) : await upstream[verb](url, typeof body === 'string' ? JSON.parse(body) : body, { headers });
            if (state.armed && method === 'PATCH' && /\/systemforms\(/.test(url)) state.ready = true;
            return { statusCode: res.status, headers: res.headers || {}, body: typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? null) };
          },
        });
        return createMakerSdk({ ...options, httpClient: client });
      },
    });
    const spec = {
      entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] }],
      forms: [{ entity: 'new_ticket', name: 'Main', tabs: [{ name: 'tab_main', label: 'Main', sections: [{ name: 'sec_main', label: 'Main', columns: 1, fields: ['new_name'] }] }] }],
    };
    await seedForm(h, ai.compileFormIntent(spec, spec.forms[0], { notesClassId: NOTES_CLASS_ID }).tabs);
    const { sdk } = await h.freshSdk(makeDir());
    await sdk.fetchArtifact('form', h.formId);
    await sdk.updateElement('form', h.formId, '/name', 'Renamed');
    state.armed = true;
    const result = await sdk.pushArtifact('form', h.formId);
    h.cleanup();
    note('saved', result.saved);
    note('refusedReads', state.refused);
    // The warnings as the SDK returned them, and what the build does with them: each is a WARNING line on stderr, a step of the journal, and part of the result.
    const warnings = [];
    requireSuccessfulPush(result, 'form Main', (message) => { warnings.push(message); process.stderr.write(`WARNING: ${message}\n`); });
    note('warnings', warnings.length);
    note('warningHoldsToken', warnings.some((warning) => leaksIn(warning, SECRETS).length > 0));
    const journal = openJournal(path.join(DIR, 'journal'));
    for (const warning of warnings) journal.record({ phase: 'ui', status: 'warning', label: 'form Main', detail: warning });
    journal.close({ status: 'complete' });
    writeFileAtomic(path.join(DIR, 'baseline.json'), JSON.stringify({ warnings }));
    saveFacts();
    emitResult(true, { saved: result.saved, publish: result.publish, warnings });
  },

  // An error that is not the SDK's own — the transport failed with an error of an odd shape: a frozen one, one whose message is an accessor, one whose stack is a getter that writes — carried as the SDK's `cause`. `shape` names it.
  async 'error-shape'({ shape }) {
    let reads = 0;
    let original;
    if (shape === 'frozen') {
      original = Object.freeze(new Error(`Rejected bearer ${TOKEN}`));
    } else if (shape === 'accessor') {
      original = new Error('transport rejected');
      Object.defineProperty(original, 'message', { get() { reads += 1; return `Rejected bearer ${TOKEN}`; }, enumerable: true, configurable: true });
    } else if (shape === 'stack-getter') {
      original = new Error('transport rejected');
      Object.defineProperty(original, 'stack', { get() { reads += 1; process.stderr.write(`Stack accessor echoed ${TOKEN}\n`); return `Error: ${TOKEN}`; }, configurable: true });
    } else {
      original = new Error(`Rejected bearer ${TOKEN}`);
    }
    const client = createAzHttpClient(INSTANCE, { getToken: () => TOKEN, request: async () => { throw original; } });
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeDir()), instanceUrl: INSTANCE, httpClient: client });
    await sdk.initWorkspace();
    const error = await sdk.findTables().then(() => null, (e) => e);
    note('refused', Boolean(error));
    note('getterReadsDuringCall', reads);
    printLikeAScript(error);
  },

  // A token the process obtained the way a script does — from the Azure CLI — and then a success answer that repeats it: the data a script prints and a download writes. `answer` is the shape of the data.
  async answer() {
    const token = getAuthToken(INSTANCE, { exec: () => `${TOKEN}\n` });
    note('obtained', token === TOKEN);
    const data = { value: [{ name: 'Account', note: `Rejected bearer ${FOLDED}`, [TOKEN]: 'as a key', plain: `bearer ${TOKEN}` }] };
    writeFileSafe(path.join(DIR, 'answer.json'), `${JSON.stringify(data, null, 2)}\n`);
    saveFacts();
    emitResult(true, data);
  },

  // A token obtained from the Azure CLI and a result of several megabytes with the token in one row: printed in one write, complete, and still one JSON document when the process exits right after it.
  async big({ rows }) {
    note('obtained', getAuthToken(INSTANCE, { exec: () => `${TOKEN}\n` }) === TOKEN);
    const data = Array.from({ length: rows }, (_, i) => ({ id: i, name: `row ${i}`, note: i === Math.floor(rows / 2) ? `Rejected bearer ${FOLDED}` : 'The platform answered with a diagnostic that says nothing about credentials.' }));
    note('bytes', JSON.stringify(data).length);
    saveFacts();
    emitResult(true, data);
  },

  // The token obtained from the Azure CLI, printed in every way a script prints. `how` is the way.
  async print({ how }) {
    const token = getAuthToken(INSTANCE, { exec: () => `${TOKEN}\n` });
    note('obtained', token === TOKEN);
    saveFacts();
    const message = `Rejected bearer ${TOKEN}`;
    const ways = {
      'stdout-write': () => process.stdout.write(`${message}\n`),
      'stderr-write': () => process.stderr.write(`${message}\n`),
      'console-log': () => console.log(message),
      'console-info': () => console.info(message),
      'console-debug': () => console.debug(message),
      'console-warn': () => console.warn(message),
      'console-error': () => console.error(message),
      'console-error-object': () => console.error(new Error(message)),
      'console-log-folded-object': () => console.log({ error: { message: `Rejected bearer ${FOLDED}` } }),
      'json-line': () => process.stdout.write(`${JSON.stringify({ ok: false, error: message, nested: { list: [`bearer ${FOLDED}`] } })}\n`),
      'write-callback': () => new Promise((resolve) => process.stderr.write(`${message}\n`, 'utf8', resolve)),
      'emit-ok': () => emitResult(true, { message, folded: FOLDED }),
      'emit-ok-ascii': () => emitResult(true, { message, accent: 'é' }, { ascii: true }),
      'emit-error': () => emitResult(false, new Error(message)),
      'emit-text': () => emitResult(false, message),
      'emit-structured': () => emitResult(false, { ok: false, error: message, errors: [message, { detail: FOLDED }] }),
    };
    if (!ways[how]) throw new Error(`unknown way ${how}`);
    await ways[how]();
    // Ends as a script ends when it has nothing more to say.
    process.exit(0);
  },
};

const [, , name, parameters] = process.argv;
if (!scenarios[name]) {
  process.stderr.write(`unknown scenario ${name}\n`);
  process.exit(2);
}
scenarios[name](parameters ? JSON.parse(parameters) : {}).then(() => saveFacts(), (error) => {
  // A failure of the scenario itself (not the scripted one): said without the token's text, which the scenario never prints on purpose.
  fs.writeFileSync(process.env.TOKEN_BOUNDARY_FACTS, JSON.stringify({ ...facts, harnessFailure: String(error && error.stack ? error.stack : error).replace(TOKEN, '<token>') }));
  process.exit(3);
});
