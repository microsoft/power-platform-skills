'use strict';
// The access token a failure carries when the service quotes it from inside a SUCCESSFUL `$batch` answer, over the REAL vendored SDK and the production HTTP client.
//
// A change set the service refuses as a whole is answered HTTP 200 with the one part that failed. The SDK raises an error that QUOTES that part's body when it writes a flow's definition
// (`sendChangeSet`), and the scripts print the message, write it to the build's journal and hand its cause to the next layer. The HTTP client takes the access token out of every answer that is not
// a success, but a 2xx answer is the caller's data and is returned byte for byte: the strict readers that prove from an answer what a change set did (completeBatchStatus, isBatchThrottled, the page
// backend's refusal proof) count the bytes a part declares, and a refused write is sent again, or not, on what they prove. So the token is taken out of the failure where it leaves the SDK — of the text
// the SDK DECODED, which holds no JSON escape the service used once — by the SDK factory every script makes its SDK with (lib/maker-sdk.js), and the answer is left exactly as it came.
//
// Every scenario runs twice: over the SDK as the bundle ships it (the control: the failure holds the token, so the scenario reproduces the exposure and is not vacuous) and over the one the factory makes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const bundle = require('../vendor/cds-maker-sdk.cjs');
const { createMakerSdk, createNodeWorkspaceStorage, withVendoredCompiler } = require('../lib/maker-sdk.js');
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { bpfDef, inspectBpfStages, applyBpfStages } = require('../lib/sdk-build.js');
const { createAzHttpClient, completeBatchStatus } = require('../lib/sdk-http-client.js');
const { FakeGenPageServer, INSTANCE, ACCOUNT_TABLE } = require('./helpers/fake-genpage-server.js');
const { leaksIn } = require('./helpers/token-leaks.js');
const { makeTempDir } = require('./helpers/temp-dirs.js');

const SOURCE = "import * as React from 'react';\nexport default function Page() { return <div>Hello</div>; }\n";
// A token the way Azure issues one — three base64url parts joined by dots — and synthetic: each part is at least 24 characters, so each is taken out on its own.
const PARTS = ['syntheticHeaderPartNotARealCredential', 'syntheticPayloadPartNotARealCredential', 'syntheticSignaturePartNotARealCredential'];
const TOKEN = PARTS.join('.');
const SECRETS = [TOKEN, ...PARTS];
const NL = '\r\n';
const CODE = '0x80040220';
// A gateway that wraps a long header value folds it (RFC 9112 §5.2, the obsolete line folding: a line break and a space) — here every eight characters.
const FOLDED = TOKEN.match(/.{1,8}/g).join(`${NL} `);
// The first character of each part spelled as a JSON escape (`\u0073` is `s`): written into a JSON body the SDK decodes it, written as text it stays what it is.
const ESCAPED_INITIALS = PARTS.map((part) => `\\u${part.charCodeAt(0).toString(16).padStart(4, '0')}${part.slice(1)}`).join('.');

// What the refused part can say. The SDK quotes the body of the part as it parses it — a JSON body is decoded, so a character written `\uXXXX` is the character itself in the message, and a body that is
// itself escaped JSON keeps its escapes — and takes any text between the part's own delimiters as that body, whatever lines it holds.
const REFUSALS = [
  { name: 'plain JSON', body: JSON.stringify({ error: { code: CODE, message: `Principal user rejected bearer ${TOKEN} for this write` } }), typed: CODE },
  { name: 'multi-byte JSON', body: JSON.stringify({ error: { code: CODE, message: `Accès refusé 日本語 🧪 ${TOKEN} — fin` } }), typed: CODE },
  { name: 'JSON that names one part of the token', body: JSON.stringify({ error: { code: CODE, message: `The payload ${PARTS[1]} is not valid` } }), typed: CODE },
  { name: 'JSON with the first character of each part spelled as a \\u escape', body: `{"error":{"code":"${CODE}","message":"Rejected bearer ${ESCAPED_INITIALS} for this write"}}`, typed: CODE },
  { name: 'JSON that spells the escape itself (the escape is escaped, so the decoded message still holds it)', body: JSON.stringify({ error: { code: CODE, message: `The supplied literal spelling was ${ESCAPED_INITIALS}` } }), typed: CODE },
  { name: 'JSON with the token folded onto several lines', body: JSON.stringify({ error: { code: CODE, message: `Rejected bearer ${FOLDED}` } }), typed: CODE },
  { name: 'JSON with the token as a key of the body', body: JSON.stringify({ error: { code: CODE, message: 'no detail' }, [TOKEN]: 'the header the gateway echoed' }), typed: CODE },
  { name: 'plain text with a line that looks like an HTTP/2 status line', body: `Gateway diagnostic${NL}HTTP/2 200 OK${NL}Rejected bearer ${TOKEN}` },
  { name: 'plain text that looks like a delimiter: two dashes and the token', body: `--${TOKEN}` },
  { name: 'plain text with the token folded onto several lines', body: `Rejected bearer ${FOLDED}` },
];

// The production client over a fake service that speaks the SDK's HttpClient (`http`). `seen` is given every `$batch` answer as the transport handed it over.
function productionClient(http, { rewrite = (text) => text, seen = [] } = {}) {
  return createAzHttpClient(INSTANCE, {
    getToken: () => TOKEN, sleep: async () => {}, random: () => 0,
    request: async ({ url, method, headers, body }) => {
      const batch = method === 'POST' && url.endsWith('/$batch');
      const answer = batch ? await http.postRaw(url, body, { headers })
        : method === 'GET' ? await http.get(url, { headers })
          : method === 'DELETE' ? await http.delete(url, { headers })
            : method === 'PATCH' && Buffer.isBuffer(body) ? await http.patchRaw(url, body, { headers })
              : await http[method.toLowerCase()](url, typeof body === 'string' ? JSON.parse(body) : body, { headers });
      const text = typeof answer.body === 'string' || Buffer.isBuffer(answer.body) ? answer.body : JSON.stringify(answer.body === undefined ? null : answer.body);
      const sent = batch ? rewrite(text) : text;
      if (batch) seen.push(sent);
      return { statusCode: answer.status, headers: answer.headers || {}, body: sent };
    },
  });
}

// ── A business process flow: the SDK writes a definition in ONE change set and quotes the body of the part that failed ───────────────────────────────────────────────
// A fake of the flow's row: a create stores the row, a GET serves it, a PATCH merges into it and moves its version, and a `$batch` change set applies its PATCHes in order — or, when `refuse` is set, is refused as
// a whole: HTTP 200 with the one part that failed, which says why and counts its own bytes.
const stage = (name, ...steps) => ({ name, steps: steps.map((s) => { const [stepName, field] = s.split(':'); return { name: stepName, field }; }) });
const flowOf = (stages) => ({ name: 'Ticket Handling', entity: 'new_ticket', stages });
const DEPLOYED = () => flowOf([stage('Triage', 'Subject:new_subject', 'Priority:new_priority'), stage('Resolve', 'Notes:new_notes'), stage('Close', 'Status:new_status')]);

function workflowsService(state) {
  const rows = new Map();
  const bump = (row) => { row['@odata.etag'] = `W/"${Number(/\d+/.exec(row['@odata.etag'])[0]) + 1}"`; };
  const rowOf = (url) => rows.get(/workflows\(([^)]+)\)/i.exec(String(url))[1].replace(/'/g, ''));
  return {
    get: async (url) => {
      if (!/\/workflows\(/i.test(String(url))) return { status: 200, headers: {}, body: { value: [] } };
      const row = rowOf(url);
      return row ? { status: 200, headers: { etag: row['@odata.etag'] }, body: { ...row } } : { status: 404, headers: {}, body: { error: { message: 'not found' } } };
    },
    post: async (url, body) => {
      rows.set(body.workflowid, { ...body, statecode: 0, statuscode: 1, '@odata.etag': 'W/"1"' });
      return { status: 201, headers: { 'odata-entityid': `${INSTANCE}/api/data/v9.2/workflows(${body.workflowid})` }, body: { workflowid: body.workflowid, '@odata.etag': 'W/"1"' } };
    },
    patch: async (url, body) => {
      const row = rowOf(url);
      Object.assign(row, body);
      bump(row);
      return { status: 200, headers: { etag: row['@odata.etag'] }, body: { '@odata.etag': row['@odata.etag'] } };
    },
    put: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    postRaw: async (url, body) => {
      if (state.refuse) {
        const text = state.refusal;
        const part = ['--changesetresponse_x', 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', 'Content-ID: 1', '', 'HTTP/1.1 403 Forbidden', `Content-Type: ${text.startsWith('{') ? 'application/json' : 'text/plain'}`, `Content-Length: ${Buffer.byteLength(text)}`, '', text];
        return { status: 200, headers: {}, body: ['--batchresponse_x', 'Content-Type: multipart/mixed; boundary=changesetresponse_x', '', ...part, '--changesetresponse_x--', '--batchresponse_x--', ''].join(NL) };
      }
      const lines = ['--batchresponse_x', 'Content-Type: multipart/mixed; boundary=changesetresponse_x', ''];
      for (const part of String(body).split(/^--changeset_\S*/m).slice(1).filter((p) => /Content-ID/i.test(p))) {
        const target = /^(?:PATCH|POST|DELETE|GET) (\S+) HTTP/m.exec(part)[1];
        const json = part.slice(part.indexOf('{'), part.lastIndexOf('}') + 1);
        const row = rowOf(target);
        Object.assign(row, json ? JSON.parse(json) : {});
        bump(row);
        const representation = /^Prefer:\s*.*representation/im.test(part);
        lines.push('--changesetresponse_x', 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', `Content-ID: ${/Content-ID:\s*(\S+)/i.exec(part)[1]}`, '',
          representation ? 'HTTP/1.1 200 OK' : 'HTTP/1.1 204 No Content', `ETag: ${row['@odata.etag']}`, ...(representation ? ['Content-Type: application/json', '', JSON.stringify({ '@odata.etag': row['@odata.etag'], ...(state.echo ? { echoed: TOKEN } : {}) })] : ['']), '');
      }
      lines.push('--changesetresponse_x--', '--batchresponse_x--', '');
      return { status: 200, headers: { 'content-type': 'multipart/mixed; boundary=batchresponse_x' }, body: lines.join(NL) };
    },
  };
}

// A flow that exists, and an SDK over a workspace that has never seen it, asked to rename a stage: what a rebuild does. `makeSdk` is the factory the SDK is made with; `state` is the fake service's (`refuse`, `refusal`, `echo`).
// `seen` is every `$batch` answer as the service sent it, `given` every one the SDK was handed.
async function flowEdit(state, makeSdk) {
  const seen = [];
  const client = productionClient(workflowsService(state), { seen });
  const given = [];
  const watched = { ...client, postRaw: async (...args) => { const answer = await client.postRaw(...args); given.push(answer.body); return answer; } };
  const open = async () => {
    const sdk = makeSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('batch-failure-bpf-')), instanceUrl: INSTANCE, httpClient: watched });
    await sdk.initWorkspace();
    return sdk;
  };
  const creator = await open();
  const created = await creator.createArtifact('bpf', bpfDef({ ...DEPLOYED(), status: 'Active' }));
  await creator.pushArtifact('bpf', created.id);
  const sdk = await open();
  const deployed = DEPLOYED();
  const want = flowOf([{ ...deployed.stages[0], name: 'Intake' }, deployed.stages[1], deployed.stages[2]]);
  const inspected = await inspectBpfStages(sdk, want, created.id);
  assert.strictEqual(inspected.kind, 'edit', 'the flow has an edit to apply');
  seen.length = 0;
  given.length = 0;
  return { apply: () => applyBpfStages(sdk, want, created.id, inspected.plan, {}), seen, given };
}

// The SDK exactly as the bundle ships it, apart from the compiler every script's SDK is given: the factory without the guard on what it raises.
const unguarded = withVendoredCompiler(bundle.createMakerSdk);

async function refusedEdit(refusal, makeSdk) {
  const state = { refuse: false, refusal };
  const { apply, seen, given } = await flowEdit(state, makeSdk);
  state.refuse = true;
  const error = await apply().then(() => null, (e) => e);
  return { error, seen, given };
}

for (const { name, body, typed } of REFUSALS) {
  test(`REAL BUNDLE: a change set refused as a whole, the refused part repeating the access token — ${name} — fails with an error that says so without the token`, async () => {
    const control = await refusedEdit(body, unguarded);
    assert.ok(control.error, 'the control: the edit is refused');
    assert.ok(leaksIn(control.error, SECRETS).length > 0, 'the control: the SDK as the bundle ships it quotes the token — so this scenario is the exposure, and the check below is not vacuous');

    const { error, seen, given } = await refusedEdit(body, createMakerSdk);
    assert.ok(error, 'the edit is refused');
    assert.strictEqual(error.code, 'CONNECTION_ERROR');
    assert.strictEqual(error.statusCode, 403, 'the SDK still reads the part: its status is the one the service gave');
    assert.match(error.message, /^HTTP 403 from \S+\/workflows\([^)]+\): /, 'what the service said is there');
    assert.deepStrictEqual(leaksIn(error, SECRETS), [], 'neither the token nor any part of it can be read out of anything the error holds — in any spelling');
    assert.strictEqual(typeof error.cause, typeof control.error.cause, 'the body the SDK kept is the kind of value it was');
    if (typed) assert.strictEqual(error.cause.error.code, typed, 'a JSON body is still the parsed object, with the platform\'s own code in it');
    // The answer is the one the service sent: the strict readers that prove a refusal from it, and the retry that follows from the proof, see what they always saw.
    assert.strictEqual(given.length, 1, 'one change set was sent');
    assert.strictEqual(given[0], seen[0], 'and the SDK was handed the answer exactly as the service sent it, byte for byte');
    assert.strictEqual(completeBatchStatus({ body: given[0] }), completeBatchStatus({ body: control.given[0] }), 'the strict reader reads it as it reads the control\'s');
  });
}

test('REAL BUNDLE: a refusal that holds no token is the SDK\'s own, unchanged — its message, the body it kept, its code and its status', async () => {
  const body = JSON.stringify({ error: { code: CODE, message: 'The record is locked by another process' } });
  const control = await refusedEdit(body, unguarded);
  const { error } = await refusedEdit(body, createMakerSdk);
  // The flow's id is minted for each run, so it is the one thing that differs between the two.
  const withoutId = (text) => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>');
  assert.deepStrictEqual([withoutId(error.message), error.cause, error.code, error.statusCode, withoutId(error.url)], [withoutId(control.error.message), control.error.cause, control.error.code, control.error.statusCode, withoutId(control.error.url)]);
  assert.strictEqual(withoutId(error.stack.split('\n')[0]), withoutId(control.error.stack.split('\n')[0]), 'and so is the first line of its stack');
  assert.strictEqual(error.cause.error.message, 'The record is locked by another process');
});

test('REAL BUNDLE: a change set that succeeds, one part of which repeats the token, is applied all the same — and the SDK is handed the answer as the service sent it', async () => {
  const state = { refuse: false, refusal: '', echo: false };
  const { apply, seen, given } = await flowEdit(state, createMakerSdk);
  state.echo = true;
  const pushed = await apply();
  assert.strictEqual(pushed.saved, true, 'the edit is saved');
  assert.strictEqual(given.length, 1);
  assert.ok(seen[0].includes(TOKEN), 'the service did repeat the token, in a part that succeeded');
  assert.strictEqual(given[0], seen[0], 'a success is the caller\'s data: the answer is the very text the service sent');
});

// ── A page: the backend sends a refused change set once, or again, on what the answer PROVES — so the answer must stay the answer ───────────────────────────────────────────
function makeServer() {
  const server = new FakeGenPageServer();
  server.serveTable(ACCOUNT_TABLE);
  return server;
}

// A backend on a throwaway workspace whose folders are recorded, so the test can prove they are gone after dispose().
async function withBackend(client, fn) {
  const made = [];
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: client, sleep: async () => {}, random: () => 0, mkdtempSync: (prefix) => { const dir = fs.mkdtempSync(prefix); made.push(dir); return dir; } });
  try {
    return await fn(genpage);
  } finally {
    await genpage.dispose();
    for (const dir of made) assert.ok(!fs.existsSync(dir), `the throwaway workspace ${dir} is removed by dispose()`);
  }
}

// The page write refused as a whole: the fake's refused part has no body, so the answer is rewritten to give it one (`detail`, of `contentType`, counted in a `Content-Length`), as a service that explains the refusal does.
// `proofs` is what the strict reader proves from each such answer, as the backend reads it.
async function refusedPageWrite({ status, detail, contentType }) {
  const server = makeServer();
  const refusedPart = `HTTP/1.1 ${status} Failed${NL}OData-Version: 4.0${NL}${NL}`;
  const proofs = [];
  let refusing = false;
  const rewrite = (text) => {
    if (!refusing || !text.includes(refusedPart)) return text;
    const answer = text.replace(refusedPart, `HTTP/1.1 ${status} Refused${NL}Content-Type: ${contentType}${NL}Content-Length: ${Buffer.byteLength(detail)}${NL}${NL}${detail}${NL}`);
    proofs.push(completeBatchStatus({ body: answer }));
    return answer;
  };
  return withBackend(productionClient(server.http(), { rewrite }), async (genpage) => {
    const { pageId } = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'first', agentMessage: 'ok' });
    const before = server.batches.length;
    server.failOn = (_method, _path, batched) => (batched ? status : undefined);
    refusing = true;
    const error = await genpage.update(pageId, { source: SOURCE.replace('Hello', 'Second'), prompt: 'second', agentMessage: 'done' }).then(() => null, (e) => e);
    return { error, sends: server.batches.length - before, proofs };
  });
}

const COUNTED_REFUSAL = JSON.stringify({ error: { code: CODE, message: `Principal user rejected bearer ${TOKEN} for this write` } });

test('REAL BUNDLE: a page write refused as a whole by a part that counts its bytes and repeats the token is still proven a refusal — one send, nothing written — and holds no token', async () => {
  const { error, sends, proofs } = await refusedPageWrite({ status: 403, detail: COUNTED_REFUSAL, contentType: 'application/json' });
  assert.ok(error, 'the update is refused');
  assert.deepStrictEqual(proofs, [403], 'the strict reader proves the refusal from the answer as it came: the part counts the bytes it has');
  assert.strictEqual(error.outcome, 'nothing', 'so the backend says nothing was written');
  assert.strictEqual(sends, 1, 'and the change set was sent once');
  assert.match(error.message, /the service refused the change set with HTTP 403/);
  assert.deepStrictEqual(leaksIn(error, SECRETS), [], 'nothing the error holds has the token');
});

// What the strict reader cannot prove, the backend does not take for a refusal: a part whose body is a line that looks like a delimiter is read as an answer that proves nothing, so the write may have
// committed and is looked for before it is sent again — once more, for a 403 and for a 429 alike: a 429 is not sent six times over on a proof the answer does not give.
for (const status of [403, 429]) {
  test(`REAL BUNDLE: a page write refused with HTTP ${status} by a part whose body looks like a delimiter proves nothing — it is sent twice and its outcome is unknown, whether the body holds the token or not`, async () => {
    const withToken = await refusedPageWrite({ status, detail: `--${TOKEN}`, contentType: 'text/plain' });
    const withoutToken = await refusedPageWrite({ status, detail: '--the-gateway-says-no', contentType: 'text/plain' });
    for (const run of [withToken, withoutToken]) {
      assert.strictEqual(run.sends, 2, 'the backend looks for the write and sends it once more');
      assert.ok(run.proofs.length === 2 && run.proofs.every((proof) => proof === 0), 'the strict reader proves nothing from either answer');
      assert.strictEqual(run.error.outcome, 'unknown');
    }
    assert.deepStrictEqual(leaksIn(withToken.error, SECRETS), [], 'and nothing the error holds has the token');
  });
}

test('REAL BUNDLE: a page write refused with HTTP 429 by a part that proves the refusal is sent again on the schedule of a throttle — six sends in all', async () => {
  const { error, sends, proofs } = await refusedPageWrite({ status: 429, detail: COUNTED_REFUSAL, contentType: 'application/json' });
  assert.ok(error, 'the update is refused in the end');
  assert.ok(proofs.length === 6 && proofs.every((proof) => proof === 429), 'every answer proves the throttle');
  assert.strictEqual(sends, 6, 'the first send and five more, as for any throttled page write');
  assert.deepStrictEqual(leaksIn(error, SECRETS), []);
});

test('REAL BUNDLE: a change set that succeeds is read from the very bytes the service answered — through the production client, with a token long enough to be taken out of an answer', async () => {
  const server = makeServer();
  const seen = [];
  const client = productionClient(server.http(), { seen });
  const given = [];
  const watched = { ...client, postRaw: async (...args) => { const answer = await client.postRaw(...args); given.push(answer.body); return answer; } };
  await withBackend(watched, async (genpage) => {
    const out = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' });
    assert.ok(out.pageId, 'the page is created');
    assert.strictEqual(server.batches.length, 1);
    assert.deepStrictEqual(given, seen, 'every $batch answer the SDK was given is the text the service sent, byte for byte');
  });
});
