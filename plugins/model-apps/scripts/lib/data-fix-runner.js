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
//      needs its own, fresh consent. A revert the SDK stopped before a row was written (a refusal before its first
//      write, or a 403/throttle stop that left rows notAttempted) can be CONTINUED: the rows still pending get a new
//      review and a new digest, and a row the revert already wrote — or whose outcome is unknown — is never sent again.
//      A forward write the SDK gives no inverse for (an `unknown` row, or one acknowledged without the token it
//      produced) is never treated as undone: the revert reports it as `unrevertible` (see unrevertibleOf).
//   6. One writer at a time. Every write takes a lease on the environment and table; a repair bound to an app
//      (`appUniqueName`) also takes THE SAME build lease a build of that app takes — the app's lock in the build's
//      workspace (lib/app-operation-lease.js applyWorkspaceOf: `<appDir>/.maker-workspace`, or the `workspaceDir` the
//      build was given). The lease scope of an operation's first write is recorded, and every later write of it
//      (resume, revert) must name the same app and workspace: a revert that left out `--app` would otherwise write
//      while a build of the app is running.
//   7. Each result carries the attempt's own `summary` AND the whole operation's `operation` — every row's outcome
//      folded across its runs, so an `unknown` row from an earlier run is never hidden by a later clean one. Its
//      `status` is one word (OPERATION_SUCCESS lists the ones that mean every planned change was made); the CLI exits
//      non-zero on any other.
const fs = require('node:fs');
const path = require('node:path');
const { createPrivateFile } = require('./private-folder.js');
const { withAppBuildLease, applyWorkspaceOf } = require('./app-operation-lease.js');
const { acquireLease, releaseLease } = require('./apply-snapshot-store.js');
const { sha256 } = require('./hash.js');
const { GUID_RE, readOnlyHttpClient, isNonEmptyString, findingOf } = require('./readonly-operations.js');

const MAX_ROWS = 50000;
const OPERATIONS_DIR = '.data-fix';
const PLAN_FILE = 'plan.json';
const REVIEW_FILE = 'review.txt';
const APPROVAL_FILE = 'approval.json';
const JOURNAL_RE = /^journal-(\d{3})-(apply|resume|revert)-(send|result)\.json$/;
const RESULT_RE = /^result-(\d{3})-(apply|resume|revert)\.json$/;
const ROW_STATUSES = ['applied', 'conflict', 'gone', 'failed', 'unknown', 'notAttempted'];
// The operation statuses that mean every planned change was made (or there was none to make). Anything else —
// unknown, failed, conflicted, partial, unverified, unrevertible — is a repair (or revert) that did not do what was
// approved. `nothingToRevert` is a proven no-op only: no forward write may have been made.
const OPERATION_SUCCESS = Object.freeze(['repaired', 'reverted', 'nothingToWrite', 'nothingToRevert']);

class DataFixRunnerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DataFixRunnerError';
    this.code = code;
    // Every message here is this module's own words (codes, counts, the maker's own folder) — never a service's text
    // or a row value — so it may be printed (lib/readonly-operations.js findingOf).
    this.publicMessage = message;
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

// Sends one plan through the SDK with a journal entry on each side of it. The send entry carries the binding the caller
// gives — the lease scope included (see withOperationLease) — so every later write of the operation can be held to it.
async function sendJournaled({ dir, journal, phase, sdk, plan, options, binding }) {
  const seq = journal.next;
  writePrivateJson(dir, `journal-${pad(seq)}-${phase}-send.json`, { seq, phase, ...binding, planId: plan.planId, rows: plan.rows.length, at: new Date().toISOString() });
  let result;
  try {
    result = await sdk.applyDataFix(plan, options);
  } catch (err) {
    if (!refusedBeforeWrite(err)) throw err;
    // The refusal is printed, so only a real code (findingOf's check) or the SDK's error class name is named in it —
    // never free text standing where a code should be.
    const { code } = findingOf(err, 'DATA_FIX_REFUSED');
    const label = code !== 'DATA_FIX_REFUSED' || !/^[A-Za-z]+Error$/.test(String(err.name)) ? code : err.name;
    writePrivateJson(dir, `journal-${pad(seq + 1)}-${phase}-result.json`, { seq: seq + 1, phase, refusedBeforeWrite: { code: label }, at: new Date().toISOString() });
    throw new DataFixRunnerError(code, `The SDK refused the ${phase} before writing anything: ${label}.`, { refusedBeforeWrite: true });
  }
  const resultFile = writePrivateJson(dir, `result-${pad(seq + 1)}-${phase}.json`, result);
  writePrivateJson(dir, `journal-${pad(seq + 1)}-${phase}-result.json`, { seq: seq + 1, phase, result: path.basename(resultFile), summary: resultSummary(result), at: new Date().toISOString() });
  return { result, resultFile };
}

// The lease scope of a write: the app whose build lease it holds (lower-cased: lib/app-operation-lease.js compares app
// names without regard to case) and that lease's workspace folder — or neither, for a repair bound to no app. The
// folder is compared as its resolved path, case-folded on Windows, where two spellings name one folder.
function leaseScopeOf({ appDir, appUniqueName, workspaceDir }) {
  if (!isNonEmptyString(appUniqueName)) return { app: null, workspace: null };
  const folder = path.resolve(applyWorkspaceOf({ appDir, workspaceDir }));
  return { app: appUniqueName.toLowerCase(), workspace: process.platform === 'win32' ? folder.toLowerCase() : folder };
}

// Every write of an operation is made under the lease scope of its first write: a resume or revert that named no app
// (or another workspace) would take a different lock, and could write while a build of the app is applying.
function checkLeaseScope(dir, journal, scope) {
  const first = journal.entries.find((e) => e.event === 'send');
  if (!first) return;
  const recorded = readJson(path.join(dir, first.name), 'DATA_FIX_JOURNAL_UNREADABLE').leaseScope || { app: null, workspace: null };
  if (recorded.app !== scope.app || recorded.workspace !== scope.workspace) {
    throw new DataFixRunnerError('DATA_FIX_LEASE_MISMATCH', recorded.app
      ? 'This plan was first written under an app\'s build lease; every later write of it needs the same --app and --workspace as that first write. Nothing was sent.'
      : 'This plan was first written without --app; every later write of it must leave out --app and --workspace too. Nothing was sent.');
  }
}

// One writer per plan's table, and — for a repair bound to an app — no write while a build of that app is applying.
// The environment-and-table lease is always taken; when an app is named, the app's build lease (the very lock a build
// takes, in the build's workspace) is taken inside it. A held build lock is DATA_FIX_BUSY with a fixed message: the
// lease's own refusal quotes the lock's path. Both are released however the operation ends.
async function withOperationLease({ appDir, appUniqueName, workspaceDir, origin, table }, operation) {
  const root = operationsRoot(appDir);
  const lease = acquireLease(root, { file: `data-fix.${sha256(`${origin}|${table}`).slice(0, 16)}.lock` });
  if (!lease.ok) throw new DataFixRunnerError('DATA_FIX_BUSY', `Another data fix of ${table} in this environment is running (${lease.reason}).`);
  try {
    if (!isNonEmptyString(appUniqueName)) return await operation();
    let entered = false;
    try {
      return await withAppBuildLease({ workspaceDir: applyWorkspaceOf({ appDir, workspaceDir }), appUniqueName }, () => {
        entered = true;
        return operation();
      });
    } catch (err) {
      // Only a refusal to TAKE the lease is mapped; an error the operation itself threw passes through unchanged.
      if (!entered && err && err.code === 'build-locked') {
        throw new DataFixRunnerError('DATA_FIX_BUSY', 'A build of this app (or another data fix bound to it) holds its build lease; nothing was written. Run the repair again after it finishes.');
      }
      throw err;
    }
  } finally {
    releaseLease(lease);
  }
}

// The status of what an operation has done so far, from its rows' folded outcomes. The worst row decides: an unknown
// row (it may or may not have been written) outranks a failed one, that a conflict or a deleted row (another maker's
// change kept), that a row not yet attempted, and that a written row whose read-back did not show the planned value
// (the SDK's verification "notAsPlanned", or "unverified" when the read-back itself failed).
function operationStatus(kind, counts, verification) {
  if (counts.unknown) return 'unknown';
  if (counts.failed) return 'failed';
  if (counts.conflict || counts.gone) return 'conflicted';
  if (counts.notAttempted) return 'partial';
  if (verification.notAsPlanned || verification.unverified) return 'unverified';
  return kind === 'revert' ? 'reverted' : 'repaired';
}

// Folds per-row outcomes across an operation's results, in order. Every planned row starts notAttempted; a result's
// outcome replaces only a row still notAttempted, so a later run never overwrites an earlier unknown, conflict or
// failure (the SDK's remaining plans hold only notAttempted rows, so a well-formed journal never asks it to).
function foldRows(planRows, results) {
  const rows = new Map(planRows.map((r) => [String(r.id).toLowerCase(), { status: 'notAttempted' }]));
  for (const result of results) {
    for (const o of result.outcomes || []) {
      const id = String(o.id).toLowerCase();
      const prior = rows.get(id);
      if (!prior || prior.status === 'notAttempted') rows.set(id, { status: o.status, verification: o.verification });
    }
  }
  return rows;
}

const zeroCounts = () => Object.fromEntries(ROW_STATUSES.map((s) => [s, 0]));
const zeroVerification = () => ({ asPlanned: 0, notAsPlanned: 0, unverified: 0 });

function operationOf(kind, rows) {
  const counts = zeroCounts();
  const verification = zeroVerification();
  for (const row of rows.values()) {
    counts[row.status] = (counts[row.status] || 0) + 1;
    if (row.status === 'applied' && Object.prototype.hasOwnProperty.call(verification, row.verification)) verification[row.verification] += 1;
  }
  return { status: operationStatus(kind, counts, verification), counts, verification, rows: rows.size };
}

function forwardResults(dir, journal) {
  return journal.results.filter((r) => r.phase !== 'revert').map((r) => readJson(path.join(dir, r.name), 'DATA_FIX_RESULT_UNREADABLE'));
}

// The forward writes no revert plan can undo. The SDK's `revert` holds only `applied` rows whose write it can prove
// (`revertible`), so it gives no inverse for a row whose outcome is `unknown` (the answer was lost: it may or may not
// have been written) nor for an `applied` row acknowledged without the echo that proves the token our write produced.
// The absence of an inverse is therefore NOT proof that nothing was written: these rows are counted so a revert is
// never reported as `reverted` or `nothingToRevert` while one remains. Nothing is ever sent for them — an inverse
// cannot be invented, and an unknown row is never re-sent. Ids go only to the private review file.
function unrevertibleOf(planRows, forward, plans) {
  const inverse = new Set(plans.flatMap((p) => p.rows.map((r) => String(r.id).toLowerCase())));
  const counts = { rows: 0, unknown: 0, noInverse: 0 };
  const rows = [];
  for (const [id, row] of foldRows(planRows, forward)) {
    let reason = null;
    if (row.status === 'unknown') reason = 'unknown';
    else if (row.status === 'applied' && !inverse.has(id)) reason = 'noInverse';
    if (!reason) continue;
    counts.rows += 1;
    counts[reason] += 1;
    rows.push({ id, reason });
  }
  return { counts, rows };
}

// A revert's operation, with the forward writes it cannot undo: while one remains, a revert that otherwise finished
// (`reverted`, or `unverified`) is `unrevertible` — not a success. A worse status (unknown, failed, conflicted,
// partial) is kept; the counts say both.
function withUnrevertible(operation, unrevertible) {
  const finished = operation.status === 'reverted' || operation.status === 'unverified';
  return { ...operation, status: unrevertible.rows && finished ? 'unrevertible' : operation.status, unrevertible };
}

function unrevertibleText(rows) {
  if (!rows.length) return '';
  return ['', `cannot be undone by this revert: ${rows.length} row(s) (unknown: the answer to the write was lost, so it may have been written; noInverse: written, but acknowledged without the token the revert would need) — they are left as they are:`,
    ...rows.map((r) => `  ${r.id}  ${r.reason}`), ''].join('\n');
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
 * `appUniqueName` binds the repair to that app's build lease, in `workspaceDir` when the build was given one (else the
 * app folder's `.maker-workspace`, as the build's own default).
 * @returns {Promise<{planId, phase:'apply', summary, operation, resultFile}>}
 */
async function applyApprovedPlan({ origin, httpClient, makeSdk, appDir, appUniqueName, workspaceDir, planId, approve, options }) {
  const dir = operationDir(appDir, planId);
  await approvePlan({ origin, httpClient, appDir, planId, digest: approve });
  const { record, binding } = await bindAndCheck({ origin, httpClient, dir, approve });
  if (!record.plan.rows.length) {
    return { planId: record.plan.planId, phase: 'apply', summary: { complete: true, counts: zeroCounts(), nothingToWrite: true }, operation: { status: 'nothingToWrite', counts: zeroCounts(), verification: zeroVerification(), rows: 0 } };
  }
  const leaseScope = leaseScopeOf({ appDir, appUniqueName, workspaceDir });
  return withOperationLease({ appDir, appUniqueName, workspaceDir, origin, table: record.plan.table.logicalName }, async () => {
    const journal = journalOf(dir);
    refuseUnknownOutcome(journal);
    checkLeaseScope(dir, journal, leaseScope);
    // Every send has its result here (refuseUnknownOutcome); only a result the SDK refused before writing lets the
    // plan be applied again.
    if (journal.entries.some((e) => e.phase === 'apply' && e.event === 'result' && !isRefusal(dir, e))) {
      throw new DataFixRunnerError('DATA_FIX_ALREADY_APPLIED', 'This plan was already applied; use `resume` for its remaining rows or `revert`.');
    }
    const { result, resultFile } = await sendJournaled({ dir, journal, phase: 'apply', sdk: makeSdk(httpClient), plan: record.plan, options, binding: { ...binding, leaseScope } });
    const operation = operationOf('apply', foldRows(record.plan.rows, forwardResults(dir, journalOf(dir))));
    return { planId: record.plan.planId, phase: 'apply', summary: resultSummary(result), operation, resultFile };
  });
}

function isRefusal(dir, entry) {
  try { return !!JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf8')).refusedBeforeWrite; } catch { return false; }
}

/**
 * Continues an applied plan with the last result's `remaining` — its notAttempted rows only (the same tokens the plan
 * read, so a row another writer changed meanwhile is a conflict, never overwritten). An `unknown` row is never sent
 * again, and it stays in the operation's outcome: a clean resume after it is still not a repaired operation. Refused
 * once a revert of the plan was sent (DATA_FIX_REVERTED). Needs the plan digest again.
 */
async function resumeRemaining({ origin, httpClient, makeSdk, appDir, appUniqueName, workspaceDir, planId, approve, options }) {
  const dir = operationDir(appDir, planId);
  const { record, binding } = await bindAndCheck({ origin, httpClient, dir, approve });
  const leaseScope = leaseScopeOf({ appDir, appUniqueName, workspaceDir });
  return withOperationLease({ appDir, appUniqueName, workspaceDir, origin, table: record.plan.table.logicalName }, async () => {
    const journal = journalOf(dir);
    refuseUnknownOutcome(journal);
    checkLeaseScope(dir, journal, leaseScope);
    // A revert put rows back to their values before the fix; resuming the fix now would write over that restore.
    if (journal.entries.some((e) => e.phase === 'revert' && e.event === 'send')) {
      throw new DataFixRunnerError('DATA_FIX_REVERTED', 'A revert of this plan was sent, so it cannot be resumed. Plan again to repair the rows as they are now.');
    }
    const results = forwardResults(dir, journal);
    if (!results.length) throw new DataFixRunnerError('DATA_FIX_NOT_APPLIED', 'This plan has not been applied; apply it first.');
    const last = results[results.length - 1];
    if (!last.remaining || !last.remaining.rows.length) {
      const operation = operationOf('apply', foldRows(record.plan.rows, results));
      return { planId: record.plan.planId, phase: 'resume', nothingRemaining: true, summary: { nothingRemaining: true, ...resultSummary(last) }, operation };
    }
    // `remaining` is the SDK's; this only refuses to trust it past its contract — every row in it must have been
    // notAttempted in that result.
    const notAttempted = new Set(last.outcomes.filter((o) => o.status === 'notAttempted').map((o) => o.id.toLowerCase()));
    if (!last.remaining.rows.every((row) => notAttempted.has(row.id.toLowerCase()))) {
      throw new DataFixRunnerError('DATA_FIX_REMAINING_INVALID', 'The recorded remaining rows include a row that was attempted; nothing was sent. Plan again.');
    }
    const { result, resultFile } = await sendJournaled({ dir, journal, phase: 'resume', sdk: makeSdk(httpClient), plan: last.remaining, options, binding: { ...binding, leaseScope } });
    const operation = operationOf('apply', foldRows(record.plan.rows, forwardResults(dir, journalOf(dir))));
    return { planId: record.plan.planId, phase: 'resume', summary: resultSummary(result), operation, resultFile };
  });
}

// Where a revert stands, from its journal. The forward results' revert plans start pending. Each revert send entry
// names the plan it sent; a result for it (not a refusal) settles that plan — its rows' outcomes are folded in — and
// the result's own `remaining` (the rows the SDK stopped before: a 403, a throttle limit) becomes pending in its place.
// A refusal before the first write settles nothing, so its plan stays pending. An unknown row is never pending again:
// only `remaining`, which holds notAttempted rows alone, is.
function revertState(dir, journal, plans) {
  const pending = new Map(plans.map((p) => [String(p.planId).toLowerCase(), p]));
  const results = [];
  let sent = false;
  let lastSeq = 0;
  let current = null;
  for (const entry of journal.entries.filter((e) => e.phase === 'revert')) {
    const body = readJson(path.join(dir, entry.name), 'DATA_FIX_JOURNAL_UNREADABLE');
    lastSeq = entry.seq;
    if (entry.event === 'send') {
      sent = true;
      current = String(body.planId).toLowerCase();
      continue;
    }
    if (body.refusedBeforeWrite) continue;
    const result = readJson(path.join(dir, body.result), 'DATA_FIX_RESULT_UNREADABLE');
    pending.delete(current);
    results.push(result);
    if (result.remaining && result.remaining.rows.length) {
      const notAttempted = new Set((result.outcomes || []).filter((o) => o.status === 'notAttempted').map((o) => String(o.id).toLowerCase()));
      if (!result.remaining.rows.every((row) => notAttempted.has(String(row.id).toLowerCase()))) {
        throw new DataFixRunnerError('DATA_FIX_REMAINING_INVALID', 'A recorded revert result\'s remaining rows include a row that was attempted; nothing was sent.');
      }
      pending.set(String(result.remaining.planId).toLowerCase(), result.remaining);
    }
  }
  const operation = operationOf('revert', foldRows(plans.flatMap((p) => p.rows), results));
  return { pending: [...pending.values()], sent, lastSeq, operation };
}

/**
 * Reverts what this plan's applies wrote, from their own revert plans. Without `approve` it records a private review
 * and returns the revert digest; with `approve` equal to that digest it sends the revert plans, each row conditional
 * on the token our write produced (a row changed since is a conflict, never overwritten). A revert the SDK stopped
 * before every row was attempted is continued the same way — review (a new digest, covering only the rows still
 * pending), then approve.
 */
async function revertApplied({ origin, httpClient, makeSdk, appDir, appUniqueName, workspaceDir, planId, approve, options }) {
  const dir = operationDir(appDir, planId);
  const record = loadPlan(dir);
  const identity = await readIdentity(httpClient, origin);
  const field = sameIdentity(identity, record);
  if (field) throw new DataFixRunnerError('DATA_FIX_APPROVAL_MISMATCH', `This plan was applied in another ${field === 'actor' ? 'user\'s session' : 'environment'}.`, { field });
  const leaseScope = leaseScopeOf({ appDir, appUniqueName, workspaceDir });
  return withOperationLease({ appDir, appUniqueName, workspaceDir, origin, table: record.plan.table.logicalName }, async () => {
    const journal = journalOf(dir);
    refuseUnknownOutcome(journal);
    checkLeaseScope(dir, journal, leaseScope);
    const forward = forwardResults(dir, journal);
    const plans = forward.map((r) => r.revert).filter((p) => p && p.rows.length);
    const { counts: unrevertible, rows: unrevertibleRows } = unrevertibleOf(record.plan.rows, forward, plans);
    if (!plans.length) {
      // Nothing can be sent. Only when no forward write may have been made is that a successful no-op.
      const status = unrevertible.rows ? 'unrevertible' : 'nothingToRevert';
      return { planId: record.plan.planId, phase: 'revert', summary: { [status === 'unrevertible' ? 'nothingRevertible' : 'nothingToRevert']: true }, unrevertible, operation: { status, counts: zeroCounts(), verification: zeroVerification(), rows: 0, unrevertible } };
    }
    const state = revertState(dir, journal, plans);
    if (state.sent && !state.pending.length) {
      throw new DataFixRunnerError('DATA_FIX_ALREADY_REVERTED', 'A revert of this plan was already sent and none of its rows is left to send.', { operation: withUnrevertible(state.operation, unrevertible) });
    }
    // The first revert's digest covers the forward revert plans (as before); a continuation's covers only the plans
    // still pending and the journal position it continues from, so approving an earlier revert never authorizes it.
    const toSend = state.sent ? state.pending : plans;
    const revertDigest = digestOf({ ...identity, planDigest: record.planDigest, revert: toSend, ...(state.sent ? { continues: state.lastSeq } : {}) });
    const rows = toSend.reduce((n, p) => n + p.rows.length, 0);
    if (approve === undefined) {
      const name = `revert-review-${revertDigest.slice(0, 12)}.txt`;
      const title = state.sent ? `Continuation of the revert of data fix ${record.plan.planId}` : `Revert of data fix ${record.plan.planId}`;
      const review = fs.existsSync(path.join(dir, name)) ? path.join(dir, name) : createPrivateFile(dir, name, toSend.map((p) => reviewText(p, title)).join('\n') + unrevertibleText(unrevertibleRows));
      return { planId: record.plan.planId, phase: 'revert', approvalNeeded: true, continuation: state.sent, revertDigest, rows, unrevertible, review, operation: withUnrevertible(state.operation, unrevertible) };
    }
    if (approve !== revertDigest) throw new DataFixRunnerError('DATA_FIX_APPROVAL_MISMATCH', 'The approved digest is not this revert\'s digest; run revert without --approve to review it.', { field: 'digest' });
    const binding = { planDigest: record.planDigest, revertDigest, ...identity, leaseScope };
    const summaries = [];
    for (const plan of toSend) {
      // eslint-disable-next-line no-await-in-loop
      const { result } = await sendJournaled({ dir, journal: journalOf(dir), phase: 'revert', sdk: makeSdk(httpClient), plan, options, binding });
      summaries.push(resultSummary(result));
    }
    const counts = Object.fromEntries(ROW_STATUSES.map((s) => [s, summaries.reduce((n, x) => n + x.counts[s], 0)]));
    const { operation } = revertState(dir, journalOf(dir), plans);
    return { planId: record.plan.planId, phase: 'revert', summary: { complete: summaries.every((x) => x.complete), counts, parts: summaries }, unrevertible, operation: withUnrevertible(operation, unrevertible) };
  });
}

module.exports = {
  MAX_ROWS,
  OPERATIONS_DIR,
  OPERATION_SUCCESS,
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
