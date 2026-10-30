'use strict';
// Bulk data repair (lib/data-fix-runner.js, scripts/data-fix.js) over the REAL vendored SDK and the plugin's own HTTP
// client, against the small fake of helpers/data-fix-org.js (one table, conditional PATCHes in `$batch`, WhoAmI); the
// CLI's own runs use the same fake through helpers/data-fix-org-preload.js. Pinned here: planning sends nothing but
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
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const runner = require('../lib/data-fix-runner.js');
const { withAppBuildLease, applyWorkspaceOf } = require('../lib/app-operation-lease.js');
const { ORIGIN, SENTINEL, USER, ORG, createDataFixOrg } = require('./helpers/data-fix-org.js');

const TOKEN = 'x'.repeat(48);

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

// --- the lease a build of the same app takes ---------------------------------------------------------------------

test('an app-bound repair takes the lease a build of that app takes: while the build holds it, nothing is written', async () => {
  const { org, base, ids } = setup({ rows: 1 });
  const planned = await runner.planDataFix({ ...base, request: filterFix });
  const mark = org.requests.length;
  // The build's own call: build-model-app.js leases <app-dir>/.maker-workspace unless --workspace names another folder.
  await withAppBuildLease({ workspaceDir: applyWorkspaceOf({ appDir: base.appDir }), appUniqueName: 'contoso_Tickets' }, async () => {
    await assert.rejects(runner.applyApprovedPlan({ ...base, planId: planned.planId, approve: planned.planDigest, appUniqueName: 'contoso_tickets' }), (err) => {
      assert.equal(err.code, 'DATA_FIX_BUSY');
      assert.equal(err.message.includes(base.appDir), false, 'the refusal names no folder');
      return true;
    });
  });
  const workspace = makeTempDir('data-fix-build-workspace-');
  await withAppBuildLease({ workspaceDir: workspace, appUniqueName: 'contoso_Tickets' }, async () => {
    await assert.rejects(runner.applyApprovedPlan({ ...base, planId: planned.planId, approve: planned.planDigest, appUniqueName: 'contoso_Tickets', workspaceDir: workspace }), { code: 'DATA_FIX_BUSY' });
  });
  assert.deepEqual(nonGets(org, mark), [], 'no row write while a build of the app held its lease');
  assert.equal(org.tickets.get(ids[0]).contoso_note, `${SENTINEL}-0`);
  const applied = await runner.applyApprovedPlan({ ...base, planId: planned.planId, approve: planned.planDigest, appUniqueName: 'contoso_Tickets', workspaceDir: workspace });
  assert.equal(applied.summary.counts.applied, 1);
  // Every later write of this plan takes the same leases: a revert without the app (or with another workspace) is refused.
  for (const scope of [{}, { appUniqueName: 'contoso_Tickets' }, { appUniqueName: 'contoso_Other', workspaceDir: workspace }]) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(runner.revertApplied({ ...base, planId: planned.planId, ...scope }), { code: 'DATA_FIX_LEASE_MISMATCH' });
  }
  const review = await runner.revertApplied({ ...base, planId: planned.planId, appUniqueName: 'CONTOSO_TICKETS', workspaceDir: workspace });
  assert.equal(review.approvalNeeded, true);
  await assert.rejects(runner.applyApprovedPlan({ ...base, planId: planned.planId, approve: planned.planDigest, workspaceDir: workspace }), { code: 'DATA_FIX_LEASE_MISMATCH' });
});

// --- what an operation achieved, across its runs ----------------------------------------------------------------

test('resume keeps an earlier unknown row in the operation\'s outcome: a later clean run never reads as repaired', async () => {
  const { org, base, ids } = setup({ rows: 2 });
  const planned = await runner.planDataFix({ ...base, request: filterFix });
  org.onBatch = async () => ({ statusCode: 502, headers: { 'content-type': 'text/html' }, body: '<html>bad gateway</html>' });
  const applied = await runner.applyApprovedPlan({ ...base, planId: planned.planId, approve: planned.planDigest, options: { batchSize: 1 } });
  assert.equal(applied.operation.status, 'unknown');
  org.onBatch = null;
  const resumed = await runner.resumeRemaining({ ...base, planId: planned.planId, approve: planned.planDigest });
  assert.deepEqual(resumed.summary.counts, { applied: 1, conflict: 0, gone: 0, failed: 0, unknown: 0, notAttempted: 0 }, 'this run\'s own rows');
  assert.deepEqual(resumed.operation.counts, { applied: 1, conflict: 0, gone: 0, failed: 0, unknown: 1, notAttempted: 0 }, 'the whole operation\'s rows');
  assert.equal(resumed.operation.status, 'unknown');
  assert.equal(org.tickets.get(ids[0]).contoso_note, `${SENTINEL}-0`, 'the unknown row was not sent again');
  const again = await runner.resumeRemaining({ ...base, planId: planned.planId, approve: planned.planDigest });
  assert.equal(again.nothingRemaining, true);
  assert.equal(again.operation.status, 'unknown', 'resuming with nothing left still reports the unknown row');
});

test('a revert the service refused before writing a row can be continued, with fresh approval; a reverted row is never sent again', async () => {
  const { org, base, ids } = setup({ rows: 2 });
  const planned = await runner.planDataFix({ ...base, request: filterFix });
  await runner.applyApprovedPlan({ ...base, planId: planned.planId, approve: planned.planDigest });
  const review = await runner.revertApplied({ ...base, planId: planned.planId });
  let batches = 0;
  // The first row's restore lands; the service then refuses access (403) and the SDK stops with the second row notAttempted.
  org.onBatch = async () => {
    batches += 1;
    if (batches === 1) return null;
    return { statusCode: 403, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: '0x80040220', message: 'permission denied' } }) };
  };
  const first = await runner.revertApplied({ ...base, planId: planned.planId, approve: review.revertDigest, options: { batchSize: 1 } });
  assert.deepEqual(first.summary.counts, { applied: 1, conflict: 0, gone: 0, failed: 0, unknown: 0, notAttempted: 1 });
  assert.equal(first.operation.status, 'partial');
  org.onBatch = null;
  await assert.rejects(runner.revertApplied({ ...base, planId: planned.planId, approve: review.revertDigest }), { code: 'DATA_FIX_APPROVAL_MISMATCH' }, 'the first approval does not cover a continuation');
  const next = await runner.revertApplied({ ...base, planId: planned.planId });
  assert.equal(next.approvalNeeded, true);
  assert.equal(next.rows, 1);
  assert.notEqual(next.revertDigest, review.revertDigest);
  const sent = [];
  org.onPatch = ({ id }) => { sent.push(id); return null; };
  const done = await runner.revertApplied({ ...base, planId: planned.planId, approve: next.revertDigest });
  assert.equal(sent.length, 1);
  assert.equal(done.operation.status, 'reverted');
  assert.deepEqual(done.operation.counts, { applied: 2, conflict: 0, gone: 0, failed: 0, unknown: 0, notAttempted: 0 });
  assert.deepEqual(ids.map((id) => org.tickets.get(id).contoso_note), [`${SENTINEL}-0`, `${SENTINEL}-1`]);
  await assert.rejects(runner.revertApplied({ ...base, planId: planned.planId }), { code: 'DATA_FIX_ALREADY_REVERTED' });
  await assert.rejects(runner.resumeRemaining({ ...base, planId: planned.planId, approve: planned.planDigest }), { code: 'DATA_FIX_REVERTED' });
});

test('a revert refused before its first write (nothing sent) can be continued, once freshly approved', async () => {
  const { org, base } = setup({ rows: 1 });
  const planned = await runner.planDataFix({ ...base, request: filterFix });
  await runner.applyApprovedPlan({ ...base, planId: planned.planId, approve: planned.planDigest });
  const review = await runner.revertApplied({ ...base, planId: planned.planId });
  const refusing = (client) => ({ applyDataFix: async () => { throw Object.assign(new Error('the table no longer has optimistic concurrency'), { code: 'DATA_FIX_CONCURRENCY_UNSUPPORTED' }); }, client });
  await assert.rejects(runner.revertApplied({ ...base, makeSdk: refusing, planId: planned.planId, approve: review.revertDigest }), { code: 'DATA_FIX_CONCURRENCY_UNSUPPORTED' });
  const next = await runner.revertApplied({ ...base, planId: planned.planId });
  assert.equal(next.approvalNeeded, true);
  assert.notEqual(next.revertDigest, review.revertDigest);
  const done = await runner.revertApplied({ ...base, planId: planned.planId, approve: next.revertDigest });
  assert.equal(done.operation.status, 'reverted');
  assert.equal(nonGets(org).length, 2, 'the apply and the one revert that was sent');
});

test('an SDK refusal is reported by its code only when it is a code: free text in its place never reaches the message', async () => {
  const { base } = setup({ rows: 1 });
  const planned = await runner.planDataFix({ ...base, request: filterFix });
  const refusing = () => ({ applyDataFix: async () => { throw Object.assign(new Error('refused'), { code: 'DATA_FIX_ROW SENTINEL-value' }); } });
  await assert.rejects(runner.applyApprovedPlan({ ...base, makeSdk: refusing, planId: planned.planId, approve: planned.planDigest }), (e) => {
    assert.equal(e.code, 'DATA_FIX_REFUSED');
    assert.doesNotMatch(`${e.message} ${e.publicMessage}`, /SENTINEL/);
    return true;
  });
});

// --- the command line, end to end ---------------------------------------------------------------------------------

// The real scripts/data-fix.js in a child process over the fake (helpers/data-fix-org-preload.js); `mutate` changes the
// fake's rows between runs as another maker (or the service) would.
function dataFixCli(org) {
  const appDir = makeTempDir('data-fix-cli-app-');
  const stateFile = path.join(makeTempDir('data-fix-cli-org-'), 'org.json');
  fs.writeFileSync(stateFile, JSON.stringify(org.snapshot()));
  const env = { ...process.env, FAKE_DATA_FIX_ORG: stateFile };
  delete env.NODE_TEST_CONTEXT;
  const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return {
    appDir,
    read,
    mutate(change) {
      const state = read();
      const fake = createDataFixOrg({ seed: state });
      change(fake, state);
      fs.writeFileSync(stateFile, JSON.stringify({ ...state, ...fake.snapshot() }));
    },
    run(verb, args) {
      const r = spawnSync(process.execPath, ['--require', path.join(__dirname, 'helpers', 'data-fix-org-preload.js'), path.join(__dirname, '..', 'data-fix.js'), verb, '--env', ORIGIN, '--app-dir', appDir, ...args], { env, encoding: 'utf8' });
      let out = null;
      try { out = JSON.parse(r.stdout); } catch { /* a usage error prints no JSON */ }
      return { status: r.status, out, text: r.stdout + r.stderr };
    },
  };
}
const planArgs = ['--table', 'contoso_ticket', '--filter', "contoso_status eq 'open'", '--set', JSON.stringify({ contoso_note: 'fixed' }), '--max-rows', '10'];

test('CLI: a repair that did not make every planned change exits non-zero — a conflict is not success; a clean one exits 0', () => {
  const org = createDataFixOrg({ rows: 2 });
  const ids = [...org.tickets.keys()];
  const cli = dataFixCli(org);
  const planned = cli.run('plan', planArgs);
  assert.equal(planned.status, 0, planned.text);
  cli.mutate((fake) => fake.touch(ids[0], 'another maker'));
  const applied = cli.run('apply', ['--plan-id', planned.out.planId, '--approve', planned.out.planDigest]);
  assert.deepEqual(applied.out.summary.counts, { applied: 1, conflict: 1, gone: 0, failed: 0, unknown: 0, notAttempted: 0 });
  assert.equal(applied.out.operation.status, 'conflicted');
  assert.equal(applied.out.ok, false);
  assert.equal(applied.status, 1);
  assert.equal(new Map(cli.read().tickets).get(ids[0]).contoso_note, 'another maker', 'the other maker\'s change is kept');
  assert.equal(applied.text.includes(SENTINEL), false);
  // The maker plans again (the row as it is now) and applies: every planned change made, exit 0.
  const replanned = cli.run('plan', planArgs);
  const clean = cli.run('apply', ['--plan-id', replanned.out.planId, '--approve', replanned.out.planDigest]);
  assert.equal(clean.out.operation.status, 'repaired');
  assert.equal(clean.out.ok, true);
  assert.equal(clean.status, 0, clean.text);
  // --workspace names the build lease's folder, so it means nothing without --app.
  const noApp = cli.run('apply', ['--plan-id', replanned.out.planId, '--approve', replanned.out.planDigest, '--workspace', cli.appDir]);
  assert.equal(noApp.status, 1);
  assert.match(noApp.text, /--workspace needs --app/);
});

test('CLI: resume after an unknown row exits non-zero; a refused revert is continued with a fresh approval and exits 0', () => {
  const org = createDataFixOrg({ rows: 2 });
  const cli = dataFixCli(org);
  const planned = cli.run('plan', planArgs);
  const approve = ['--plan-id', planned.out.planId, '--approve', planned.out.planDigest];
  cli.mutate((fake, state) => { state.batchAnswer = { statusCode: 502, body: 'bad gateway' }; });
  const applied = cli.run('apply', [...approve, '--batch-size', '1']);
  assert.equal(applied.status, 1);
  assert.equal(applied.out.operation.status, 'unknown');
  cli.mutate((fake, state) => { delete state.batchAnswer; });
  const resumed = cli.run('resume', approve);
  assert.equal(resumed.out.summary.counts.applied, 1);
  assert.equal(resumed.out.operation.counts.unknown, 1);
  assert.equal(resumed.out.operation.status, 'unknown');
  assert.equal(resumed.out.ok, false);
  assert.equal(resumed.status, 1, 'an earlier unknown row keeps the operation unsettled');
  const review = cli.run('revert', ['--plan-id', planned.out.planId]);
  assert.equal(review.status, 0, 'a review is not a failure');
  assert.equal(review.out.approvalNeeded, true);
  cli.mutate((fake, state) => { state.batchAnswer = { statusCode: 403, body: JSON.stringify({ error: { code: '0x80040220', message: 'permission denied' } }) }; });
  const refused = cli.run('revert', ['--plan-id', planned.out.planId, '--approve', review.out.revertDigest]);
  assert.equal(refused.status, 1);
  assert.equal(refused.out.operation.status, 'partial');
  cli.mutate((fake, state) => { delete state.batchAnswer; });
  const next = cli.run('revert', ['--plan-id', planned.out.planId]);
  assert.equal(next.out.approvalNeeded, true);
  const done = cli.run('revert', ['--plan-id', planned.out.planId, '--approve', next.out.revertDigest]);
  assert.equal(done.out.operation.status, 'reverted');
  assert.equal(done.status, 0, done.text);
});

test('CLI: a service refusal is printed as its code and HTTP status in fixed words — never the service\'s own text', () => {
  const cli = dataFixCli(createDataFixOrg({ rows: 1 }));
  const refused = cli.run('plan', ['--table', 'contoso_secretive', '--filter', "contoso_status eq 'open'", '--set', JSON.stringify({ contoso_note: 'x' }), '--max-rows', '1']);
  assert.equal(refused.status, 1);
  assert.equal(refused.out.ok, false);
  assert.equal(refused.out.statusCode, 403);
  assert.equal(typeof refused.out.code, 'string');
  assert.equal(refused.text.includes(SENTINEL), false, refused.text);
});