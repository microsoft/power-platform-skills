'use strict';
// Bulk data repair (lib/data-fix-runner.js, scripts/data-fix.js) over the REAL vendored SDK and the plugin's own HTTP
// client. The shared lifecycle fake does not model the narrow metadata reads a data fix makes (the table's
// `IsOptimisticConcurrencyEnabled`, the per-kind attribute casts) nor `$batch` of one change set per row with
// `odata.continue-on-error`, so this file serves a small fake of exactly those: one table, conditional PATCHes that
// answer 412 on a moved token and 404 0x80040217 on a deleted row, and WhoAmI. Pinned here: planning sends nothing but
// GETs; a filter plan needs an explicit maxRows; the approval binds the digest, the organization and the user; business
// values reach only the private files, never what the runner returns or the CLI prints; another writer's change is a
// conflict and is kept; a deleted row is gone; an unanswered request is unknown and stops the run; a crash between the
// journal entries refuses any further write; resume sends only notAttempted rows; revert needs its own consent and
// restores only rows nobody changed since.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const runner = require('../lib/data-fix-runner.js');

const ORIGIN = 'https://contoso.crm.dynamics.com';
const TOKEN = 'x'.repeat(48);
const SENTINEL = 'SENTINEL-c0ffee-business-value';
const USER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';

const json = (statusCode, body, headers = {}) => ({ statusCode, headers: { 'content-type': 'application/json; odata.metadata=minimal', ...headers }, body: body === undefined ? '' : JSON.stringify(body) });
const odataError = (statusCode, code, message) => json(statusCode, { error: { code, message } });

function createDataFixOrg({ rows = 4 } = {}) {
  const tickets = new Map();
  let version = 100;
  for (let i = 0; i < rows; i += 1) {
    const id = randomUUID();
    tickets.set(id, { contoso_ticketid: id, contoso_name: `Ticket ${i}`, contoso_note: `${SENTINEL}-${i}`, contoso_status: 'open', etag: `W/"${(version += 1)}"` });
  }
  const org = {
    origin: ORIGIN,
    tickets,
    identity: { UserId: USER, OrganizationId: ORG, BusinessUnitId: randomUUID() },
    requests: [],
    // A test seam: called with each PATCH part before it is applied; may answer for it instead.
    onPatch: null,
    // A test seam: called with the whole `$batch` request; may answer for it instead (or throw: a lost answer).
    onBatch: null,
    // Another writer: a plain PATCH that moves the row's token, as a second maker's edit would.
    touch(id, note) {
      const row = tickets.get(id);
      row.contoso_note = note;
      row.etag = `W/"${(version += 1)}"`;
    },
  };
  const attributes = {
    contoso_name: { LogicalName: 'contoso_name', AttributeType: 'String', AttributeTypeName: { Value: 'StringType' }, IsValidForRead: true, IsValidForUpdate: true, IsSecured: false },
    contoso_note: { LogicalName: 'contoso_note', AttributeType: 'String', AttributeTypeName: { Value: 'StringType' }, IsValidForRead: true, IsValidForUpdate: true, IsSecured: false },
    contoso_status: { LogicalName: 'contoso_status', AttributeType: 'String', AttributeTypeName: { Value: 'StringType' }, IsValidForRead: true, IsValidForUpdate: true, IsSecured: false },
    contoso_secret: { LogicalName: 'contoso_secret', AttributeType: 'String', AttributeTypeName: { Value: 'StringType' }, IsValidForRead: true, IsValidForUpdate: true, IsSecured: true },
  };
  const namesIn = (filter) => [...String(filter || '').matchAll(/LogicalName eq '([^']*)'/g)].map((m) => m[1]);
  const project = (row, select) => {
    const out = { '@odata.etag': row.etag };
    for (const name of select) if (name in row) out[name] = row[name];
    return out;
  };

  function patchRow(where, headers, body) {
    const m = /^\/contoso_tickets\(([0-9a-f-]{36})\)(?:\?\$select=(.*))?$/i.exec(where);
    if (!m) return odataError(400, '0x80040203', `unmodelled PATCH ${where}`);
    const row = tickets.get(m[1].toLowerCase());
    if (!row) return odataError(404, '0x80040217', 'contoso_ticket With Id = ... Does Not Exist');
    const ifMatch = Object.entries(headers).find(([k]) => k.toLowerCase() === 'if-match');
    if (!ifMatch || ifMatch[1] !== row.etag) return odataError(412, '0x80060882', 'The version of the existing record doesn\'t match the RowVersion property provided.');
    Object.assign(row, body);
    row.etag = `W/"${(version += 1)}"`;
    return json(200, project(row, (m[2] || 'contoso_ticketid').split(',')), { ETag: row.etag });
  }

  // The SDK's `$batch` of single-operation change sets (BatchApi.renderChangeSets), e.g.
  //   --batch_<id>
  //   Content-Type: multipart/mixed;boundary=changeset_<id>
  //
  //   --changeset_<id>
  //   Content-Type: application/http
  //   Content-Transfer-Encoding: binary
  //   Content-ID: 1
  //
  //   PATCH https://contoso.crm.dynamics.com/api/data/v9.2/contoso_tickets(<id>)?$select=... HTTP/1.1
  //   If-Match: W/"101"
  //   ...
  //
  //   {"contoso_note":"..."}
  //   --changeset_<id>--
  //   --batch_<id>--
  function batch(text, headers) {
    const outer = /^--(\S+)/.exec(text)[1];
    const answers = [];
    for (const segment of text.split(`--${outer}`).slice(1)) {
      if (segment.startsWith('--')) break;
      const changeset = /boundary=(\S+)/.exec(segment)[1];
      const part = segment.split(`--${changeset}`)[1];
      const whole = part.replace(/^\r\n/, '');
      const mime = whole.slice(0, whole.indexOf('\r\n\r\n'));
      const request = whole.slice(whole.indexOf('\r\n\r\n') + 4);
      const contentId = /Content-ID:\s*(\S+)/i.exec(mime)[1];
      const [head, ...rest] = request.split(/\r\n\r\n/);
      const lines = head.split(/\r\n/);
      const [, method, url] = /^(\w+) (\S+) HTTP\/1\.1$/.exec(lines[0]);
      const partHeaders = Object.fromEntries(lines.slice(1).map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
      const where = decodeURIComponent(new URL(url, ORIGIN).pathname + new URL(url, ORIGIN).search).replace(/^\/api\/data\/v9\.\d+/, '');
      const body = rest.join('\r\n\r\n').trim() ? JSON.parse(rest.join('\r\n\r\n').trim()) : undefined;
      const injected = org.onPatch && org.onPatch({ method, where, headers: partHeaders, body, id: (/\(([0-9a-f-]{36})\)/i.exec(where) || [])[1] });
      answers.push({ contentId, res: injected || patchRow(where, partHeaders, body) });
    }
    const out = 'batchresponse_00000000-0000-0000-0000-00000000000a';
    const lines = [];
    for (const { contentId, res } of answers) {
      const cs = `changesetresponse_${randomUUID()}`;
      lines.push(`--${out}`, `Content-Type: multipart/mixed; boundary=${cs}`, '', `--${cs}`, 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', `Content-ID: ${contentId}`, '',
        `HTTP/1.1 ${res.statusCode} ${res.statusCode < 300 ? 'OK' : 'Error'}`, ...Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`), '', res.body, `--${cs}--`);
    }
    lines.push(`--${out}--`, '');
    return { statusCode: 200, headers: { 'content-type': `multipart/mixed; boundary=${out}` }, body: lines.join('\r\n') };
  }

  org.request = async ({ url, method, headers = {}, body }) => {
    const parsed = new URL(url);
    if (parsed.origin !== ORIGIN) throw new Error(`a request to another origin: ${url}`);
    const where = decodeURIComponent(parsed.pathname + parsed.search).replace(/^\/api\/data\/v9\.\d+/, '');
    org.requests.push({ method, path: where });
    if (method === 'GET' && where === '/WhoAmI') return json(200, org.identity);
    if (method === 'GET' && where.startsWith("/EntityDefinitions(LogicalName='contoso_ticket')?")) {
      return json(200, { EntitySetName: 'contoso_tickets', PrimaryIdAttribute: 'contoso_ticketid', PrimaryNameAttribute: 'contoso_name', IsOptimisticConcurrencyEnabled: true });
    }
    if (method === 'GET' && where.startsWith("/EntityDefinitions(LogicalName='contoso_nowhere')")) return odataError(404, '0x80060888', 'not found');
    const attr = /^\/EntityDefinitions\(LogicalName='contoso_ticket'\)\/Attributes(\/Microsoft\.Dynamics\.CRM\.(\w+))?\?(.*)$/.exec(where);
    if (method === 'GET' && attr) {
      const params = new URLSearchParams(attr[3]);
      const names = namesIn(params.get('$filter')).filter((n) => attributes[n]);
      if (!attr[2]) return json(200, { value: names.map((n) => attributes[n]) });
      return json(200, { value: names.map((n) => ({ LogicalName: n, MaxLength: 200 })) });
    }
    const rowsRead = /^\/contoso_tickets\?(.*)$/.exec(where);
    if (method === 'GET' && rowsRead) {
      const params = new URLSearchParams(rowsRead[1]);
      const select = (params.get('$select') || '').split(',');
      const filter = params.get('$filter') || '';
      const ids = /CRM\.In\(PropertyName='contoso_ticketid',PropertyValues=\[(.*)\]\)/.exec(filter);
      const eq = /^(\w+) eq '([^']*)'$/.exec(filter);
      let rows = [...tickets.values()];
      if (ids) {
        const wanted = new Set([...ids[1].matchAll(/'([^']*)'/g)].map((m) => m[1].toLowerCase()));
        rows = rows.filter((r) => wanted.has(r.contoso_ticketid));
      } else if (eq) {
        rows = rows.filter((r) => r[eq[1]] === eq[2]);
      } else {
        return odataError(400, '0x80060888', `unmodelled filter ${filter}`);
      }
      return json(200, { value: rows.map((r) => project(r, select)) });
    }
    if (method === 'POST' && where === '/$batch') {
      if (org.onBatch) {
        const answer = await org.onBatch({ body: String(body), headers });
        if (answer) return answer;
      }
      return batch(String(body), headers);
    }
    return odataError(501, '0x80040265', `the data fix fake does not model ${method} ${where}`);
  };
  return org;
}

function setup(options) {
  const org = createDataFixOrg(options);
  const appDir = makeTempDir('data-fix-app-');
  const sdkDir = makeTempDir('data-fix-sdk-');
  const httpClient = createAzHttpClient(ORIGIN, { getToken: () => TOKEN, request: org.request, sleep: async () => {} });
  const makeSdk = (client) => createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(sdkDir), instanceUrl: ORIGIN, httpClient: client });
  const base = { origin: ORIGIN, httpClient, makeSdk, appDir };
  return { org, appDir, base, ids: [...org.tickets.keys()] };
}
const nonGets = (org, mark = 0) => org.requests.slice(mark).filter((r) => r.method !== 'GET');
const filterFix = { table: 'contoso_ticket', filter: "contoso_status eq 'open'", set: { contoso_note: 'fixed' }, maxRows: 10 };

test('a filter plan without an explicit maxRows is refused before anything is read', async () => {
  const { org, base } = setup();
  await assert.rejects(runner.planDataFix({ ...base, request: { table: 'contoso_ticket', filter: "contoso_status eq 'open'", set: { contoso_note: 'x' } } }), { code: 'DATA_FIX_MAX_ROWS_REQUIRED' });
  await assert.rejects(runner.planDataFix({ ...base, request: { ...filterFix, maxRows: 50001 } }), { code: 'DATA_FIX_MAX_ROWS_REQUIRED' });
  await assert.rejects(runner.planDataFix({ ...base, request: { ...filterFix, colour: 'red' } }), { code: 'DATA_FIX_REQUEST_INVALID' });
  assert.equal(org.requests.length, 0);
});

test('planning is GET-only and keeps business values in private files only (privacy sentinel)', async () => {
  const { org, appDir, base } = setup();
  const planned = await runner.planDataFix({ ...base, request: filterFix });
  assert.deepEqual(nonGets(org), []);
  assert.equal(planned.summary.counts.write, 4);
  assert.deepEqual(planned.summary.columns, ['contoso_note']);
  assert.match(planned.planDigest, /^[0-9a-f]{64}$/);
  const printed = JSON.stringify(planned);
  assert.equal(printed.includes(SENTINEL), false, 'no before-value in what the runner returns');
  assert.equal(printed.includes('Ticket 0'), false, 'no row name in what the runner returns');
  assert.equal(printed.includes("contoso_status eq 'open'"), false, 'no filter text in what the runner returns');
  const review = fs.readFileSync(planned.review, 'utf8');
  assert.match(review, new RegExp(`"${SENTINEL}-0" -> "fixed"`));
  assert.equal(path.dirname(planned.review), path.join(appDir, '.data-fix', planned.planId));
  // A refused column is the SDK's rule, surfaced as its own error; no plan is recorded.
  await assert.rejects(runner.planDataFix({ ...base, request: { ...filterFix, set: { contoso_secret: 'x' } } }), (err) => /secured/.test(JSON.stringify(err.issues || err.message)));
});

test('the approval binds the digest, the organization and the user; a mismatch writes nothing', async () => {
  const { org, base } = setup();
  const planned = await runner.planDataFix({ ...base, request: filterFix });
  const mark = org.requests.length;
  await assert.rejects(runner.applyApprovedPlan({ ...base, planId: planned.planId, approve: '0'.repeat(64) }), (e) => e.code === 'DATA_FIX_APPROVAL_MISMATCH' && e.details.field === 'digest');
  org.identity = { ...org.identity, UserId: '33333333-3333-4333-8333-333333333333' };
  await assert.rejects(runner.applyApprovedPlan({ ...base, planId: planned.planId, approve: planned.planDigest }), (e) => e.code === 'DATA_FIX_APPROVAL_MISMATCH' && e.details.field === 'actor');
  org.identity = { ...org.identity, UserId: USER, OrganizationId: '44444444-4444-4444-8444-444444444444' };
  await assert.rejects(runner.applyApprovedPlan({ ...base, planId: planned.planId, approve: planned.planDigest }), (e) => e.code === 'DATA_FIX_APPROVAL_MISMATCH' && e.details.field === 'environment');
  assert.deepEqual(nonGets(org, mark), []);
  // A plan edited on disk after review no longer matches its digest.
  const file = path.join(planned.folder, 'plan.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.plan.rows[0].after.contoso_note = 'tampered';
  fs.writeFileSync(file, JSON.stringify(record));
  org.identity = { ...org.identity, OrganizationId: ORG };
  await assert.rejects(runner.applyApprovedPlan({ ...base, planId: planned.planId, approve: planned.planDigest }), { code: 'DATA_FIX_PLAN_TAMPERED' });
  assert.deepEqual(nonGets(org, mark), []);
});

test('apply: another maker\'s change is a conflict and is kept, a deleted row is gone, the rest applied; mixed is never all-success', async () => {
  const { org, base, ids } = setup();
  const planned = await runner.planDataFix({ ...base, request: filterFix });
  org.touch(ids[1], 'another maker');
  org.tickets.delete(ids[2]);
  const applied = await runner.applyApprovedPlan({ ...base, planId: planned.planId, approve: planned.planDigest });
  assert.deepEqual(applied.summary.counts, { applied: 2, conflict: 1, gone: 1, failed: 0, unknown: 0, notAttempted: 0 });
  assert.equal(applied.summary.complete, true);
  assert.equal(applied.summary.revertible, 2);
  assert.equal(org.tickets.get(ids[1]).contoso_note, 'another maker');
  assert.equal(org.tickets.get(ids[0]).contoso_note, 'fixed');
  assert.equal(JSON.stringify(applied).includes(SENTINEL), false);
  const files = fs.readdirSync(planned.folder).sort();
  assert.deepEqual(files.filter((f) => f.startsWith('journal-')), ['journal-001-apply-send.json', 'journal-002-apply-result.json']);
  // Applying the same plan twice is refused: the second run would only conflict, and resume is the way on.
  await assert.rejects(runner.applyApprovedPlan({ ...base, planId: planned.planId, approve: planned.planDigest }), { code: 'DATA_FIX_ALREADY_APPLIED' });
});

test('an unanswered request is unknown and stops the run; resume sends only the notAttempted rows and never the unknown one', async () => {
  const { org, base, ids } = setup();
  const planned = await runner.planDataFix({ ...base, request: filterFix });
  let batches = 0;
  org.onBatch = async () => {
    batches += 1;
    // The first request's answer is lost (a 502 with no multipart body): its row is unknown and nothing else is sent.
    if (batches === 1) return { statusCode: 502, headers: { 'content-type': 'text/html' }, body: '<html>bad gateway</html>' };
    return null;
  };
  const applied = await runner.applyApprovedPlan({ ...base, planId: planned.planId, approve: planned.planDigest, options: { batchSize: 1 } });
  assert.equal(applied.summary.complete, false);
  assert.equal(applied.summary.counts.unknown, 1);
  assert.equal(applied.summary.counts.notAttempted, 3);
  assert.equal(applied.summary.stoppedBy.code, 'DATA_FIX_REQUEST_UNKNOWN_OUTCOME');
  const sent = [];
  org.onPatch = ({ id }) => { sent.push(id); return null; };
  await assert.rejects(runner.resumeRemaining({ ...base, planId: planned.planId, approve: 'f'.repeat(64) }), { code: 'DATA_FIX_APPROVAL_MISMATCH' });
  const resumed = await runner.resumeRemaining({ ...base, planId: planned.planId, approve: planned.planDigest });
  assert.deepEqual(resumed.summary.counts, { applied: 3, conflict: 0, gone: 0, failed: 0, unknown: 0, notAttempted: 0 });
  assert.equal(sent.includes(ids[0]), false, 'the unknown row is never sent again');
  assert.deepEqual(sent.sort(), ids.slice(1).sort());
});

test('a crash between the send and the result entries refuses every later write: the maker plans afresh', async () => {
  const { org, base, ids } = setup();
  const planned = await runner.planDataFix({ ...base, request: filterFix });
  // The process dies after the SDK wrote the rows and before the result was recorded.
  const crashing = (client) => {
    const sdk = base.makeSdk(client);
    return { applyDataFix: async (...a) => { await sdk.applyDataFix(...a); throw new Error('process died'); } };
  };
  await assert.rejects(runner.applyApprovedPlan({ ...base, makeSdk: crashing, planId: planned.planId, approve: planned.planDigest }), /process died/);
  assert.equal(org.tickets.get(ids[0]).contoso_note, 'fixed');
  const mark = org.requests.length;
  for (const run of [runner.resumeRemaining, runner.applyApprovedPlan, runner.revertApplied]) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(run({ ...base, planId: planned.planId, approve: planned.planDigest }), { code: 'DATA_FIX_OUTCOME_UNKNOWN' });
  }
  assert.deepEqual(nonGets(org, mark), []);
  // A fresh plan reads the rows as they are now: the rows written before the crash are unchanged, not written again.
  const again = await runner.planDataFix({ ...base, request: filterFix });
  assert.equal(again.summary.counts.write, 0);
  assert.equal(again.summary.counts.unchanged, 4);
});

test('revert needs its own consent, restores the rows our write produced, and leaves a row another maker changed since', async () => {
  const { org, base, ids } = setup();
  const planned = await runner.planDataFix({ ...base, request: filterFix });
  await runner.applyApprovedPlan({ ...base, planId: planned.planId, approve: planned.planDigest });
  const mark = org.requests.length;
  const review = await runner.revertApplied({ ...base, planId: planned.planId });
  assert.equal(review.approvalNeeded, true);
  assert.equal(review.rows, 4);
  assert.match(fs.readFileSync(review.review, 'utf8'), new RegExp(`"fixed" -> "${SENTINEL}-0"`));
  assert.equal(JSON.stringify(review).includes(SENTINEL), false);
  assert.deepEqual(nonGets(org, mark), []);
  await assert.rejects(runner.revertApplied({ ...base, planId: planned.planId, approve: planned.planDigest }), { code: 'DATA_FIX_APPROVAL_MISMATCH' });
  org.touch(ids[3], 'changed after the fix');
  const reverted = await runner.revertApplied({ ...base, planId: planned.planId, approve: review.revertDigest });
  assert.deepEqual(reverted.summary.counts, { applied: 3, conflict: 1, gone: 0, failed: 0, unknown: 0, notAttempted: 0 });
  assert.equal(org.tickets.get(ids[0]).contoso_note, `${SENTINEL}-0`);
  assert.equal(org.tickets.get(ids[3]).contoso_note, 'changed after the fix');
  await assert.rejects(runner.revertApplied({ ...base, planId: planned.planId, approve: review.revertDigest }), { code: 'DATA_FIX_ALREADY_REVERTED' });
});

test('a second writer on the same table is refused while the lease is held', async () => {
  const { base } = setup();
  const planned = await runner.planDataFix({ ...base, request: filterFix });
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = (client) => {
    const sdk = base.makeSdk(client);
    return { applyDataFix: async (...a) => { await gate; return sdk.applyDataFix(...a); } };
  };
  const first = runner.applyApprovedPlan({ ...base, makeSdk: slow, planId: planned.planId, approve: planned.planDigest });
  await new Promise((r) => setTimeout(r, 200));
  const other = await runner.planDataFix({ ...base, request: filterFix });
  await assert.rejects(runner.applyApprovedPlan({ ...base, planId: other.planId, approve: other.planDigest }), { code: 'DATA_FIX_BUSY' });
  release();
  assert.equal((await first).summary.counts.applied, 4);
});

test('the CLI prints counts, codes and paths only, and refuses a filter plan without --max-rows', () => {
  const script = path.join(__dirname, '..', 'data-fix.js');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const appDir = makeTempDir('data-fix-cli-');
  const noMax = spawnSync(process.execPath, [script, 'plan', '--env', ORIGIN, '--app-dir', appDir, '--table', 'contoso_ticket', '--filter', "contoso_status eq 'open'", '--set', JSON.stringify({ contoso_note: SENTINEL })], { env, encoding: 'utf8' });
  assert.equal(noMax.status, 1);
  const out = JSON.parse(noMax.stdout);
  assert.equal(out.code, 'DATA_FIX_MAX_ROWS_REQUIRED');
  assert.equal(noMax.stdout.includes(SENTINEL) || noMax.stderr.includes(SENTINEL), false);
  const unknownVerb = spawnSync(process.execPath, [script, 'upsert', '--env', ORIGIN], { env, encoding: 'utf8' });
  assert.equal(unknownVerb.status, 1);
});
