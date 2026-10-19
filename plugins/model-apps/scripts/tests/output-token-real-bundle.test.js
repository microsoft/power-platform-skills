'use strict';
// A change set the service refuses as a whole, over the REAL vendored SDK and the production az-token HTTP client: what the SDK raises, and that the ANSWER stays exactly what the service sent.
//
// A change set the service refuses as a whole is answered HTTP 200 with the one part that failed. The SDK raises an error that QUOTES that part's body when it writes a flow's definition (`sendChangeSet`), and a token the
// service repeats in the part reaches the error. The HTTP client takes the access token out of every answer that is not a success, but a 2xx answer is the caller's data and is returned byte for byte: the strict readers that
// prove from an answer what a change set did (completeBatchStatus, isBatchThrottled, the page backend's refusal proof) count the bytes a part declares, and a refused write is sent again, or not, on what they prove. So neither the
// answer nor the error is rewritten: the token is taken out of what the process WRITES (tests/output-token-boundary.test.js reads what reached its stdout, stderr and files). These tests hold the other half: the SDK's own error
// is the SDK's own, and the answer, the strict reader's proof and the sends that follow from it are those of a client that takes nothing out.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const bundle = require('../vendor/cds-maker-sdk.cjs');
const { createMakerSdk, withVendoredCompiler } = require('../lib/maker-sdk.js');
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { completeBatchStatus } = require('../lib/sdk-http-client.js');
const { FakeGenPageServer, INSTANCE, ACCOUNT_TABLE } = require('./helpers/fake-genpage-server.js');
const { productionClient, flowEdit, refusedEdit } = require('./helpers/bpf-batch-service.js');
const { TOKEN, SECRETS, NL, CODE, REFUSALS } = require('./helpers/synthetic-token.js');
const { leaksIn } = require('./helpers/token-leaks.js');
const { makeTempDir } = require('./helpers/temp-dirs.js');

const SOURCE = "import * as React from 'react';\nexport default function Page() { return <div>Hello</div>; }\n";
const makeDir = () => makeTempDir('batch-failure-bpf-');

// The SDK exactly as the bundle ships it, apart from the compiler every script's SDK is given: the factory without the wiring a script's SDK has on top of it.
const bundled = withVendoredCompiler(bundle.createMakerSdk);

// A withheld id is minted for each run, so it is the one thing that differs between two runs of the same edit.
const withoutId = (text) => String(text).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>');

for (const { name, body, typed } of REFUSALS) {
  test(`REAL BUNDLE: a change set refused as a whole, the refused part repeating the access token — ${name} — fails with the SDK's own error, and the SDK is handed the answer as the service sent it`, async () => {
    const control = await refusedEdit(body, bundled, makeDir);
    assert.ok(control.error, 'the control: the edit is refused');
    assert.ok(leaksIn(control.error, SECRETS).length > 0, 'the control: the SDK as the bundle ships it quotes the token — so this scenario is the exposure, and not a vacuous one');

    const { error, seen, given } = await refusedEdit(body, createMakerSdk, makeDir);
    assert.ok(error, 'the edit is refused');
    assert.strictEqual(error.code, 'CONNECTION_ERROR');
    assert.strictEqual(error.statusCode, 403, 'the SDK still reads the part: its status is the one the service gave');
    assert.match(error.message, /^HTTP 403 from \S+\/workflows\([^)]+\): /, 'what the service said is there');
    // The error is not rewritten: what a script writes is cleaned where it is written (tests/output-token-boundary.test.js), and an error keeps every word the SDK gave it.
    assert.ok(leaksIn(error, SECRETS).length > 0, 'the error holds what the SDK quoted');
    assert.deepStrictEqual([withoutId(error.message), error.cause, error.code, error.statusCode, withoutId(error.url)], [withoutId(control.error.message), control.error.cause, control.error.code, control.error.statusCode, withoutId(control.error.url)], 'and is the one the bundle makes');
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
  const control = await refusedEdit(body, bundled, makeDir);
  const { error } = await refusedEdit(body, createMakerSdk, makeDir);
  assert.deepStrictEqual([withoutId(error.message), error.cause, error.code, error.statusCode, withoutId(error.url)], [withoutId(control.error.message), control.error.cause, control.error.code, control.error.statusCode, withoutId(control.error.url)]);
  assert.strictEqual(withoutId(error.stack.split('\n')[0]), withoutId(control.error.stack.split('\n')[0]), 'and so is the first line of its stack');
  assert.strictEqual(error.cause.error.message, 'The record is locked by another process');
});

test('REAL BUNDLE: a change set that succeeds, one part of which repeats the token, is applied all the same — and the SDK is handed the answer as the service sent it', async () => {
  const state = { refuse: false, refusal: '', echo: false };
  const { apply, seen, given } = await flowEdit(state, createMakerSdk, makeDir);
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

test('REAL BUNDLE: a page write refused as a whole by a part that counts its bytes and repeats the token is still proven a refusal — one send, nothing written', async () => {
  const { error, sends, proofs } = await refusedPageWrite({ status: 403, detail: COUNTED_REFUSAL, contentType: 'application/json' });
  assert.ok(error, 'the update is refused');
  assert.deepStrictEqual(proofs, [403], 'the strict reader proves the refusal from the answer as it came: the part counts the bytes it has');
  assert.strictEqual(error.outcome, 'nothing', 'so the backend says nothing was written');
  assert.strictEqual(sends, 1, 'and the change set was sent once');
  assert.match(error.message, /the service refused the change set with HTTP 403/);
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
  });
}

test('REAL BUNDLE: a page write refused with HTTP 429 by a part that proves the refusal is sent again on the schedule of a throttle — six sends in all', async () => {
  const { error, sends, proofs } = await refusedPageWrite({ status: 429, detail: COUNTED_REFUSAL, contentType: 'application/json' });
  assert.ok(error, 'the update is refused in the end');
  assert.ok(proofs.length === 6 && proofs.every((proof) => proof === 429), 'every answer proves the throttle');
  assert.strictEqual(sends, 6, 'the first send and five more, as for any throttled page write');
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
