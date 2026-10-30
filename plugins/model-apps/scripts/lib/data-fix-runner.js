'use strict';
// Bulk data repair (`scripts/data-fix.js plan|apply|resume|revert`): the plugin's half of the SDK's planDataFix /
// applyDataFix. The SDK owns the algorithm — the GET-only plan, one PATCH per row conditional on the token the plan read,
// the per-row classification (applied / conflict / gone / failed / unknown / notAttempted), `remaining` and `revert`.
// This module adds only what a maker's repair needs around it, and never re-implements a row write:
//
//   1. Planning is GET-only twice over: the SDK reads through a GET-only reader, and the SDK this module plans with sits
//      on a transport that refuses every other method before it is sent (lib/readonly-operations.js).
//   2. A plan is bound to WHERE and WHO: the environment's origin and organization id, and the signed-in user id, both
//      read from WhoAmI. The digest covers the plan and that binding, and an apply needs the same digest back, from the
//      same organization and user — approving one review never authorizes a different plan, org or person.
//   3. Everything that holds business data (the plan's before/after values, row names, the filter text, the server's
//      per-row error text) is written ONLY to files nobody but the current user can read (lib/private-folder.js). What
//      this module returns — and so what the CLI prints — is counts, codes, ids and paths.
//   4. A durable journal: an entry is written BEFORE a write is sent and another AFTER its result. A send with no
//      result means the process died while rows may have been written, so the operation refuses to continue and the
//      maker plans afresh (a new plan reads the rows as they now are: rows already written read as unchanged).
//   5. `resume` sends only the last result's `remaining` — the SDK's notAttempted rows — and never retries an
//      `unknown` row. `revert` sends the results' own revert plans (conditional on the tokens OUR writes produced) and
//      needs its own, fresh consent.
//   6. One writer at a time: the app's build lease when the repair is bound to an app, otherwise a lease scoped to the
//      environment and table.
const fs = require('node:fs');
const path = require('node:path');
const { createPrivateFile } = require('./private-folder.js');
const { withAppBuildLease } = require('./app-operation-lease.js');
const { acquireLease, releaseLease } = require('./apply-snapshot-store.js');
const { sha256 } = require('./hash.js');
const { GUID_RE, readOnlyHttpClient, isNonEmptyString } = require('./readonly-operations.js');

const MAX_ROWS = 50000;
const OPERATIONS_DIR = '.data-fix';
const PLAN_FILE = 'plan.json';
const REVIEW_FILE = 'review.txt';
const APPROVAL_FILE = 'approval.json';
const JOURNAL_RE = /^journal-(\d{3})-(apply|resume|revert)-(send|result)\.json$/;
const RESULT_RE = /^result-(\d{3})-(apply|resume|revert)\.json$/;
const ROW_STATUSES = ['applied', 'conflict', 'gone', 'failed', 'unknown', 'notAttempted'];

class DataFixRunnerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DataFixRunnerError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// A JSON rendering with sorted keys, so the digest depends on the plan's content only — never on the order a reader
// happened to build an object in.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}
const digestOf = (value) => sha256(canonical(value));

// The request the SDK takes, checked before anything is read. The SDK's own default for a filter plan is 5000 rows;
// this wrapper requires the maker to say how many rows the filter may select, so a too-wide filter is refused by a
// number the maker chose, not by a default they never saw.
function checkRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new DataFixRunnerError('DATA_FIX_REQUEST_INVALID', 'The data fix request must be an object.');
  const allowed = new Set(['table', 'filter', 'set', 'maxRows', 'rows']);
  const extra = Object.keys(request).filter((k) => !allowed.has(k));
  if (extra.length) throw new DataFixRunnerError('DATA_FIX_REQUEST_INVALID', `The data fix request has unknown keys: ${extra.join(', ')}.`);
  if (!isNonEmptyString(request.table)) throw new DataFixRunnerError('DATA_FIX_REQUEST_INVALID', 'The data fix request needs `table`, a table logical name.');
  const byFilter = request.filter !== undefined;
  const byRows = request.rows !== undefined;
  if (byFilter === byRows) throw new DataFixRunnerError('DATA_FIX_REQUEST_INVALID', 'The data fix request needs exactly one of `filter` (with `set` and `maxRows`) or `rows`.');
  if (byFilter) {
    if (!Number.isInteger(request.maxRows) || request.maxRows < 1 || request.maxRows > MAX_ROWS) {
      throw new DataFixRunnerError('DATA_FIX_MAX_ROWS_REQUIRED', `A filter plan needs an explicit \`maxRows\`, an integer 1..${MAX_ROWS}: the most rows the filter may select.`);
    }
    return { table: request.table, filter: request.filter, set: request.set, maxRows: request.maxRows };
  }
  if (request.set !== undefined || request.maxRows !== undefined) throw new DataFixRunnerError('DATA_FIX_REQUEST_INVALID', 'A rows plan carries each row\'s own `set`; `set` and `maxRows` belong to a filter plan.');
  return { table: request.table, rows: request.rows };
}

// WhoAmI is the standard Dataverse function: GET <origin>/api/data/v9.2/WhoAmI answers
//   { "BusinessUnitId": "<guid>", "UserId": "<guid>", "OrganizationId": "<guid>" }
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/whoami
// Anything else is refused: an identity that cannot be read cannot bind a plan.
async function readIdentity(httpClient, origin) {
  let res;
  try {
    res = await httpClient.get(`${origin}/api/data/v9.2/WhoAmI`);
  } catch (err) {
    throw new DataFixRunnerError('DATA_FIX_IDENTITY_UNREADABLE', 'Reading who is signed in (WhoAmI) failed in transport.');
  }
  const body = res && res.body;
  const userId = body && body.UserId;
  const organizationId = body && body.OrganizationId;
  if (!res || res.status !== 200 || !GUID_RE.test(String(userId)) || !GUID_RE.test(String(organizationId))) {
    throw new DataFixRunnerError('DATA_FIX_IDENTITY_UNREADABLE', `Reading who is signed in (WhoAmI) did not return a user and an organization (HTTP ${res && res.status}).`);
  }
  return { environment: { origin, organizationId: organizationId.toLowerCase() }, actor: { userId: userId.toLowerCase() } };
}

function sameIdentity(a, b) {
  if (a.environment.origin !== b.environment.origin || a.environment.organizationId !== b.environment.organizationId) return 'environment';
  if (a.actor.userId !== b.actor.userId) return 'actor';
  return null;
}

const operationsRoot = (appDir) => path.join(path.resolve(appDir), OPERATIONS_DIR);
function operationDir(appDir, planId) {
  if (!GUID_RE.test(String(planId))) throw new DataFixRunnerError('DATA_FIX_PLAN_ID_INVALID', 'The plan id must be the GUID `plan` printed.');
  return path.join(operationsRoot(appDir), String(planId).toLowerCase());
}

function writePrivateJson(dir, name, value) {
  return createPrivateFile(dir, name, `${JSON.stringify(value, null, 2)}\n`);
}
function readJson(file, code) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new DataFixRunnerError(code, `${path.basename(file)} is missing or unreadable in ${path.dirname(file)}.`);
  }
}

// Counts only: this is what the CLI prints, so it never carries a value, a row name or the filter text.
function planSummary(plan) {
  return {
    table: plan.table.logicalName,
    selection: plan.selection.by === 'filter' ? { by: 'filter', maxRows: plan.selection.maxRows, matched: plan.selection.matched } : { ...plan.selection },
    columns: plan.columns.map((c) => c.logicalName),
    counts: { write: plan.rows.length, unchanged: plan.unchanged.length, excluded: plan.excluded.length, missing: plan.missing.length, staleSinceRead: plan.staleSinceRead.length },
  };
}

// The maker's review: every row's before and after, in a private file. Values are rendered as JSON so an empty string,
// null and a number stay distinguishable.
function reviewText(plan, title) {
  const lines = [title, `table: ${plan.table.logicalName}`, `rows to write: ${plan.rows.length}`, ''];
  if (plan.selection.by === 'filter') lines.splice(2, 0, `filter: ${plan.selection.filter} (maxRows ${plan.selection.maxRows}, matched ${plan.selection.matched})`);
  for (const row of plan.rows) {
    lines.push(`${row.id}  ${row.name === null ? '(no name)' : JSON.stringify(row.name)}`);
    for (const column of Object.keys(row.after)) lines.push(`  ${column}: ${JSON.stringify(row.before[column])} -> ${JSON.stringify(row.after[column])}`);
  }
  for (const [label, list] of [['unchanged', plan.unchanged], ['missing', plan.missing], ['staleSinceRead', plan.staleSinceRead]]) {
    if (list.length) lines.push('', `${label}: ${list.join(', ')}`);
  }
  if (plan.excluded.length) lines.push('', 'excluded:', ...plan.excluded.map((e) => `  ${e.id} ${e.column}: ${e.reason}`));
  return `${lines.join('\n')}\n`;
}

/**
 * Plans a data fix, GET-only, and records it privately under `<appDir>/.data-fix/<planId>/`.
 * @param {object} args
 * @param {string} args.origin - the environment's https origin
 * @param {object} args.httpClient - the SDK's HttpClient for `origin`
 * @param {(httpClient: object) => object} args.makeSdk - builds a Maker SDK over the given HttpClient
 * @param {string} args.appDir - the user's app directory
 * @param {object} args.request - the SDK request: {table, filter, set, maxRows} or {table, rows}
 * @returns {Promise<{planId, planDigest, folder, review, summary, gets}>}
 */
async function planDataFix({ origin, httpClient, makeSdk, appDir, request }) {
  const checked = checkRequest(request);
  const readOnly = readOnlyHttpClient(httpClient);
  const identity = await readIdentity(readOnly.client, origin);
  const plan = await makeSdk(readOnly.client).planDataFix(checked);
  if (readOnly.stats.refusedWrites > 0) {
    throw new DataFixRunnerError('DATA_FIX_PLAN_NOT_READ_ONLY', 'Planning attempted a write; it was refused before it was sent, and no plan was recorded.');
  }
  if (!plan || plan.kind !== 'dataFixPlan' || !GUID_RE.test(String(plan.planId))) throw new DataFixRunnerError('DATA_FIX_PLAN_INVALID', 'The SDK returned something that is not a data fix plan.');
  const planDigest = digestOf({ ...identity, plan });
  const dir = operationDir(appDir, plan.planId);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.mkdirSync(dir);
  writePrivateJson(dir, PLAN_FILE, { kind: 'dataFixOperation', version: 1, planDigest, ...identity, request: { table: checked.table, by: checked.filter !== undefined ? 'filter' : 'rows', ...(checked.maxRows ? { maxRows: checked.maxRows } : {}) }, plan });
  const review = createPrivateFile(dir, REVIEW_FILE, reviewText(plan, `Data fix plan ${plan.planId}`));
  return { planId: plan.planId.toLowerCase(), planDigest, folder: dir, review, summary: planSummary(plan), gets: readOnly.stats.gets };
}

function loadPlan(dir) {
  const record = readJson(path.join(dir, PLAN_FILE), 'DATA_FIX_PLAN_NOT_FOUND');
  const { planDigest, environment, actor, plan } = record;
  if (!plan || !environment || !actor || digestOf({ environment, actor, plan }) !== planDigest) {
    throw new DataFixRunnerError('DATA_FIX_PLAN_TAMPERED', 'The recorded plan no longer matches its digest; plan again.');
  }
  return record;
}

/**
 * Records the maker's approval of a plan: the digest they were shown, checked against the recorded plan, from the
 * organization and user the plan was read as. Throws DATA_FIX_APPROVAL_MISMATCH (details.field: digest | environment |
 * actor) otherwise; nothing is written then.
 */
async function approvePlan({ origin, httpClient, appDir, planId, digest }) {
  const dir = operationDir(appDir, planId);
  const record = loadPlan(dir);
  if (digest !== record.planDigest) throw new DataFixRunnerError('DATA_FIX_APPROVAL_MISMATCH', 'The approved digest is not this plan\'s digest; review the plan and approve the digest `plan` printed.', { field: 'digest' });
  const identity = await readIdentity(httpClient, origin);
  const field = sameIdentity(identity, record);
  if (field) throw new DataFixRunnerError('DATA_FIX_APPROVAL_MISMATCH', `The plan was read in another ${field === 'actor' ? 'user\'s session' : 'environment'}; it can be approved only there.`, { field });
  if (fs.existsSync(path.join(dir, APPROVAL_FILE))) {
    const prior = readJson(path.join(dir, APPROVAL_FILE), 'DATA_FIX_APPROVAL_UNREADABLE');
    if (prior.planDigest !== record.planDigest) throw new DataFixRunnerError('DATA_FIX_APPROVAL_MISMATCH', 'A different approval is already recorded for this plan.', { field: 'digest' });
    return { approval: path.join(dir, APPROVAL_FILE), alreadyApproved: true };
  }
  const approval = writePrivateJson(dir, APPROVAL_FILE, { planDigest: record.planDigest, ...identity, rows: record.plan.rows.length, approvedAt: new Date().toISOString() });
  return { approval, alreadyApproved: false };
}

function journalOf(dir) {
  const entries = fs.readdirSync(dir).map((name) => JOURNAL_RE.exec(name)).filter(Boolean)
    .map((m) => ({ seq: Number(m[1]), phase: m[2], event: m[3], name: m[0] })).sort((a, b) => a.seq - b.seq);
  const results = fs.readdirSync(dir).map((name) => RESULT_RE.exec(name)).filter(Boolean)
    .map((m) => ({ seq: Number(m[1]), phase: m[2], name: m[0] })).sort((a, b) => a.seq - b.seq);
  return { entries, results, next: entries.length ? entries[entries.length - 1].seq + 1 : 1 };
}

// A send with no result after it: the process ended while a write was in flight, so its rows may or may not have been
// written, and nothing recorded here can say which. Nothing more is sent from this plan.
function refuseUnknownOutcome(journal) {
  const last = journal.entries[journal.entries.length - 1];
  if (last && last.event === 'send') {
    throw new DataFixRunnerError('DATA_FIX_OUTCOME_UNKNOWN', `The ${last.phase} recorded as ${last.name} has no recorded result: its rows may or may not have been written. Plan again — a fresh plan reads the rows as they are now — and do not resume this one.`);
  }
}

const pad = (n) => String(n).padStart(3, '0');

// The SDK documents that applyDataFix throws only BEFORE its first write (invalid options, an invalid or foreign plan,
// a table that lost optimistic concurrency, or that read failing) — those errors carry a DATA_FIX_* code or are its
// InvalidArgumentError. Only they are recorded as "nothing written"; any other error leaves the send without a result,
// so the operation reads as outcome-unknown, which is the safe reading of an error nobody classified.
const refusedBeforeWrite = (err) => !!err && ((typeof err.code === 'string' && /^DATA_FIX_/.test(err.code)) || err.name === 'InvalidArgumentError');

function resultSummary(result) {
  const counts = {};
  for (const status of ROW_STATUSES) counts[status] = (result.counts && result.counts[status]) || 0;
  return {
    complete: result.complete === true,
    counts,
    verification: result.verification,
    remaining: result.remaining ? result.remaining.rows.length : 0,
    revertible: result.revert ? result.revert.rows.length : 0,
    throttle: result.throttle,
    ...(result.stoppedBy ? { stoppedBy: { code: result.stoppedBy.code, ...(result.stoppedBy.httpStatus !== undefined ? { httpStatus: result.stoppedBy.httpStatus } : {}) } } : {}),
  };
}

// Sends one plan through the SDK with a journal entry on each side of it.
async function sendJournaled({ dir, journal, phase, sdk, plan, options, binding }) {
  const seq = journal.next;
  writePrivateJson(dir, `journal-${pad(seq)}-${phase}-send.json`, { seq, phase, ...binding, planId: plan.planId, rows: plan.rows.length, at: new Date().toISOString() });
  let result;
  try {
    result = await sdk.applyDataFix(plan, options);
  } catch (err) {
    if (!refusedBeforeWrite(err)) throw err;
    writePrivateJson(dir, `journal-${pad(seq + 1)}-${phase}-result.json`, { seq: seq + 1, phase, refusedBeforeWrite: { code: err.code || err.name }, at: new Date().toISOString() });
    throw new DataFixRunnerError(err.code || 'DATA_FIX_REFUSED', `The SDK refused the ${phase} before writing anything: ${err.code || err.name}.`, { refusedBeforeWrite: true });
  }
  const resultFile = writePrivateJson(dir, `result-${pad(seq + 1)}-${phase}.json`, result);
  writePrivateJson(dir, `journal-${pad(seq + 1)}-${phase}-result.json`, { seq: seq + 1, phase, result: path.basename(resultFile), summary: resultSummary(result), at: new Date().toISOString() });
  return { result, resultFile };
}

// One writer per plan's table: the app's build lease when the repair is bound to an app, else a lease on the
// environment and table. Both are released however the operation ends.
async function withOperationLease({ appDir, appUniqueName, origin, table }, operation) {
  if (isNonEmptyString(appUniqueName)) return withAppBuildLease({ workspaceDir: appDir, appUniqueName }, () => operation());
  const root = operationsRoot(appDir);
  const lease = acquireLease(root, { file: `data-fix.${sha256(`${origin}|${table}`).slice(0, 16)}.lock` });
  if (!lease.ok) throw new DataFixRunnerError('DATA_FIX_BUSY', `Another data fix of ${table} in this environment is running (${lease.reason}).`);
  try {
    return await operation();
  } finally {
    releaseLease(lease);
  }
}

async function bindAndCheck({ origin, httpClient, dir, approve }) {
  const record = loadPlan(dir);
  if (approve !== record.planDigest) throw new DataFixRunnerError('DATA_FIX_APPROVAL_MISMATCH', 'The approved digest is not this plan\'s digest.', { field: 'digest' });
  const identity = await readIdentity(httpClient, origin);
  const field = sameIdentity(identity, record);
  if (field) throw new DataFixRunnerError('DATA_FIX_APPROVAL_MISMATCH', `This plan was read in another ${field === 'actor' ? 'user\'s session' : 'environment'}.`, { field });
  return { record, binding: { planDigest: record.planDigest, ...identity } };
}

/**
 * Applies an approved plan once. `approve` is the plan digest; the approval is recorded first when it is not already.
 * @returns {Promise<{planId, phase:'apply', summary, resultFile}>}
 */
async function applyApprovedPlan({ origin, httpClient, makeSdk, appDir, appUniqueName, planId, approve, options }) {
  const dir = operationDir(appDir, planId);
  await approvePlan({ origin, httpClient, appDir, planId, digest: approve });
  const { record, binding } = await bindAndCheck({ origin, httpClient, dir, approve });
  if (!record.plan.rows.length) return { planId: record.plan.planId, phase: 'apply', summary: { complete: true, counts: Object.fromEntries(ROW_STATUSES.map((s) => [s, 0])), nothingToWrite: true } };
  return withOperationLease({ appDir, appUniqueName, origin, table: record.plan.table.logicalName }, async () => {
    const journal = journalOf(dir);
    refuseUnknownOutcome(journal);
    // Every send has its result here (refuseUnknownOutcome); only a result the SDK refused before writing lets the
    // plan be applied again.
    if (journal.entries.some((e) => e.phase === 'apply' && e.event === 'result' && !isRefusal(dir, e))) {
      throw new DataFixRunnerError('DATA_FIX_ALREADY_APPLIED', 'This plan was already applied; use `resume` for its remaining rows or `revert`.');
    }
    const { result, resultFile } = await sendJournaled({ dir, journal, phase: 'apply', sdk: makeSdk(httpClient), plan: record.plan, options, binding });
    return { planId: record.plan.planId, phase: 'apply', summary: resultSummary(result), resultFile };
  });
}

function isRefusal(dir, entry) {
  try { return !!JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf8')).refusedBeforeWrite; } catch { return false; }
}

function lastWriteResult(dir, journal) {
  const writes = journal.results.filter((r) => r.phase !== 'revert');
  if (!writes.length) return null;
  return readJson(path.join(dir, writes[writes.length - 1].name), 'DATA_FIX_RESULT_UNREADABLE');
}

/**
 * Continues an applied plan with the last result's `remaining` — its notAttempted rows only (the same tokens the plan
 * read, so a row another writer changed meanwhile is a conflict, never overwritten). An `unknown` row is never sent
 * again. Needs the plan digest again.
 */
async function resumeRemaining({ origin, httpClient, makeSdk, appDir, appUniqueName, planId, approve, options }) {
  const dir = operationDir(appDir, planId);
  const { record, binding } = await bindAndCheck({ origin, httpClient, dir, approve });
  return withOperationLease({ appDir, appUniqueName, origin, table: record.plan.table.logicalName }, async () => {
    const journal = journalOf(dir);
    refuseUnknownOutcome(journal);
    const last = lastWriteResult(dir, journal);
    if (!last) throw new DataFixRunnerError('DATA_FIX_NOT_APPLIED', 'This plan has not been applied; apply it first.');
    if (!last.remaining || !last.remaining.rows.length) return { planId: record.plan.planId, phase: 'resume', summary: { nothingRemaining: true, ...resultSummary(last) } };
    // `remaining` is the SDK's; this only refuses to trust it past its contract — every row in it must have been
    // notAttempted in that result.
    const notAttempted = new Set(last.outcomes.filter((o) => o.status === 'notAttempted').map((o) => o.id.toLowerCase()));
    if (!last.remaining.rows.every((row) => notAttempted.has(row.id.toLowerCase()))) {
      throw new DataFixRunnerError('DATA_FIX_REMAINING_INVALID', 'The recorded remaining rows include a row that was attempted; nothing was sent. Plan again.');
    }
    const { result, resultFile } = await sendJournaled({ dir, journal, phase: 'resume', sdk: makeSdk(httpClient), plan: last.remaining, options, binding });
    return { planId: record.plan.planId, phase: 'resume', summary: resultSummary(result), resultFile };
  });
}

function revertPlansOf(dir, journal) {
  return journal.results.filter((r) => r.phase !== 'revert')
    .map((r) => readJson(path.join(dir, r.name), 'DATA_FIX_RESULT_UNREADABLE').revert).filter((p) => p && p.rows.length);
}

/**
 * Reverts what this plan's applies wrote, from their own revert plans. Without `approve` it records a private review
 * and returns the revert digest; with `approve` equal to that digest it sends the revert plans, each row conditional
 * on the token our write produced (a row changed since is a conflict, never overwritten).
 */
async function revertApplied({ origin, httpClient, makeSdk, appDir, appUniqueName, planId, approve, options }) {
  const dir = operationDir(appDir, planId);
  const record = loadPlan(dir);
  const identity = await readIdentity(httpClient, origin);
  const field = sameIdentity(identity, record);
  if (field) throw new DataFixRunnerError('DATA_FIX_APPROVAL_MISMATCH', `This plan was applied in another ${field === 'actor' ? 'user\'s session' : 'environment'}.`, { field });
  return withOperationLease({ appDir, appUniqueName, origin, table: record.plan.table.logicalName }, async () => {
    const journal = journalOf(dir);
    refuseUnknownOutcome(journal);
    if (journal.entries.some((e) => e.phase === 'revert' && e.event === 'send')) throw new DataFixRunnerError('DATA_FIX_ALREADY_REVERTED', 'A revert of this plan was already sent.');
    const plans = revertPlansOf(dir, journal);
    if (!plans.length) return { planId: record.plan.planId, phase: 'revert', summary: { nothingToRevert: true } };
    const revertDigest = digestOf({ ...identity, planDigest: record.planDigest, revert: plans });
    const rows = plans.reduce((n, p) => n + p.rows.length, 0);
    if (approve === undefined) {
      const name = `revert-review-${revertDigest.slice(0, 12)}.txt`;
      const review = fs.existsSync(path.join(dir, name)) ? path.join(dir, name) : createPrivateFile(dir, name, plans.map((p) => reviewText(p, `Revert of data fix ${record.plan.planId}`)).join('\n'));
      return { planId: record.plan.planId, phase: 'revert', approvalNeeded: true, revertDigest, rows, review };
    }
    if (approve !== revertDigest) throw new DataFixRunnerError('DATA_FIX_APPROVAL_MISMATCH', 'The approved digest is not this revert\'s digest; run revert without --approve to review it.', { field: 'digest' });
    const binding = { planDigest: record.planDigest, revertDigest, ...identity };
    const summaries = [];
    for (const plan of plans) {
      // eslint-disable-next-line no-await-in-loop
      const { result } = await sendJournaled({ dir, journal: journalOf(dir), phase: 'revert', sdk: makeSdk(httpClient), plan, options, binding });
      summaries.push(resultSummary(result));
    }
    const counts = Object.fromEntries(ROW_STATUSES.map((s) => [s, summaries.reduce((n, x) => n + x.counts[s], 0)]));
    return { planId: record.plan.planId, phase: 'revert', summary: { complete: summaries.every((x) => x.complete), counts, parts: summaries } };
  });
}

module.exports = {
  MAX_ROWS,
  OPERATIONS_DIR,
  DataFixRunnerError,
  canonical,
  checkRequest,
  readIdentity,
  planDataFix,
  approvePlan,
  applyApprovedPlan,
  resumeRemaining,
  revertApplied,
};
