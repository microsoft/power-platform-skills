'use strict';
// A business process flow whose edit is written in ONE `$batch` change set, over a fake service — for the tests that drive the REAL vendored SDK and the production az-token HTTP client through a change set the
// service refuses as a whole (HTTP 200, with the one part that failed). Shared by the test file and by the child process of helpers/token-boundary-child.js, which is why it requires no test runner.
const assert = require('node:assert');
const { createNodeWorkspaceStorage } = require('../../lib/maker-sdk.js');
const { bpfDef, inspectBpfStages, applyBpfStages } = require('../../lib/sdk-build.js');
const { createAzHttpClient } = require('../../lib/sdk-http-client.js');
const { INSTANCE } = require('./fake-genpage-server.js');
const { TOKEN, NL } = require('./synthetic-token.js');

// The production client over a fake service that speaks the SDK's HttpClient (`http`). `seen` is given every `$batch` answer as the transport handed it over; `rewrite` may change a `$batch` answer first; `token` is the
// access token the client sends (the synthetic one unless a test names another).
function productionClient(http, { rewrite = (text) => text, seen = [], token = TOKEN } = {}) {
  return createAzHttpClient(INSTANCE, {
    getToken: () => token, sleep: async () => {}, random: () => 0,
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

// A fake of the flow's row: a create stores the row, a GET serves it, a PATCH merges into it and moves its version, and a `$batch` change set applies its PATCHes in order — or, when `state.refuse` is set, is refused as
// a whole: HTTP 200 with the one part that failed, which says why (`state.refusal`) and counts its own bytes. `state.echo` makes a part that succeeds repeat the token.
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

// A flow that exists, and an SDK over a workspace that has never seen it, asked to rename a stage: what a rebuild does. `makeSdk` is the factory the SDK is made with, `makeDir` makes a workspace folder, and `state` is the fake
// service's (`refuse`, `refusal`, `echo`). `seen` is every `$batch` answer as the service sent it, `given` every one the SDK was handed. `token` is the access token the client sends.
async function flowEdit(state, makeSdk, makeDir, { token = TOKEN } = {}) {
  const seen = [];
  const client = productionClient(workflowsService(state), { seen, token });
  const given = [];
  const watched = { ...client, postRaw: async (...args) => { const answer = await client.postRaw(...args); given.push(answer.body); return answer; } };
  const open = async () => {
    const sdk = makeSdk({ workspaceStorage: createNodeWorkspaceStorage(makeDir()), instanceUrl: INSTANCE, httpClient: watched });
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

// The edit, refused as a whole by a part whose body is `refusal`: the error the SDK raises, and the answers the transport sent and the SDK was handed.
async function refusedEdit(refusal, makeSdk, makeDir, options) {
  const state = { refuse: false, refusal };
  const { apply, seen, given } = await flowEdit(state, makeSdk, makeDir, options);
  state.refuse = true;
  const error = await apply().then(() => null, (e) => e);
  return { error, seen, given };
}

module.exports = { productionClient, workflowsService, flowEdit, refusedEdit, stage, flowOf, DEPLOYED };
