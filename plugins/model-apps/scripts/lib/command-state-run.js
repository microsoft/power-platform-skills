'use strict';
// The build's side of `commandStates[]`: set the hidden / disabled state of existing table-scoped modern command rows, by row id, and see
// that the build's own table publication covered each table it wrote on. Created per build attempt (createCommandStateRun); the publication
// observer (createCommandStatePublicationObserver) lives for the whole invocation, across the build's own retries. In memory only: nothing
// here is persisted, and nothing here sends a publish — the build's existing before-app table publication does that, and the observer only
// records what it answered.
//
// Order within one attempt (lib/sdk-build.js):
//   preflight()   before the build's first write: every row read and judged, every approval present — or the build stops having written nothing
//   recheckAll()  in the commands phase: everything read again; a row that changed since its approval stops the build (approval-stale)
//   applyRows()   then, one row at a time: a fresh read, one conditional PATCH of the flags that differ, a read back; then every row read again
//   assertComplete()  after all the build's shared work: every declared table's publication confirmed for its latest write, or exit 1
//
// Every refusal and every unknown outcome is a BuildHalt that is never retried automatically (RETRY.NEVER): a run again re-reads the row and
// asks for approval of what it then finds; it never replays a write.

const {
  usesCommandStates, normalizeCommandStates, diffCommandFlags, commandStateApprovalKey, commandTablePublishApprovalKey, codeForReasons, canonicalOrigin,
  CommandStateError, SPEC_FLAG, validateCommandStates,
} = require('./command-state-contract.js');
const { resolveCommandStateContext, readCommandStateRow, decodeCommandStateRow, errorCode, NOT_FOUND } = require('./command-state-read.js');
const { PHASES, STAGES } = require('./stages.js');

const CODES = Object.freeze({
  transport: 'command-state-transport-unavailable',
  publishRequired: 'command-state-publish-required',
  phaseUnsupported: 'command-state-phase-unsupported',
  keyedUnsupported: 'command-state-keyed-unsupported',
  legacyCreateConflict: 'command-state-legacy-create-conflict',
  approvalRequired: 'command-state-approval-required',
  approvalStale: 'command-state-approval-stale',
  publicationApprovalRequired: 'command-state-publication-approval-required',
  rowNotFound: 'command-state-row-not-found',
  rowUnreadable: 'command-state-row-unreadable',
  versionUnavailable: 'command-state-version-unavailable',
  versionConflict: 'command-state-version-conflict',
  updateRejected: 'command-state-update-rejected',
  writeUnknown: 'command-state-write-unknown',
  notConfirmed: 'command-state-not-confirmed',
  publishUnconfirmed: 'command-state-publish-unconfirmed',
});

// What to do next, one fixed sentence per code: never a service's own words, which can quote a record value.
const REMEDY = Object.freeze({
  [CODES.transport]: 'this build has no way to read and write command rows; run it through build-model-app.js',
  [CODES.publishRequired]: 'run the build with --publish: a command state is applied only by a build that also publishes its table',
  [CODES.phaseUnsupported]: 'run a full build (or exactly --stage data, which leaves command states alone)',
  [CODES.keyedUnsupported]: 'a build cannot use commandStates together with keyed commands[] (key) yet: remove one of them',
  [CODES.legacyCreateConflict]: 'commands[] would create a new command bar on a table whose existing button commandStates edits: create the button in one build, then add its state in a later one',
  [CODES.approvalRequired]: 'review each change above and run the build again with every --authorize it printed',
  [CODES.approvalStale]: 'the row changed after it was approved: run a dry run to see what it holds now, and approve the new token',
  [CODES.publicationApprovalRequired]: 'run the build again with every --authorize publish:command-state-table:... it printed; it publishes ALL saved customizations on that table',
  [CODES.rowNotFound]: 'no such row in this environment: list the app\'s buttons with list-command-states.js and correct rowId (a row is never created)',
  [CODES.rowUnreadable]: 'the row could not be read, so nothing about it is assumed: check access and the environment, then run the build again',
  [CODES.versionUnavailable]: 'the row has no usable version to make a conditional write against, so it is not written',
  [CODES.versionConflict]: 'someone changed the row after it was read; nothing was overwritten. Run a dry run, review the row and approve its new token',
  [CODES.updateRejected]: 'the platform refused the write; nothing was changed by it. Check access to the row, then run the build again',
  [CODES.writeUnknown]: 'the write may still complete; nothing was sent again. Read the row (list-command-states.js) before running the build again',
  [CODES.notConfirmed]: 'the row does not hold the declared flags. Read the row (list-command-states.js) before running the build again',
  [CODES.publishUnconfirmed]: 'run the build again with publishing',
  'command-state-context-unverified': 'the app or its tables could not be confirmed: check app.uniqueName and that each table is in the app',
  'command-state-target-mismatch': 'the row is not the declared table\'s button on the declared bar: list the app\'s buttons and correct the entry',
  'command-state-target-unsupported': 'this kind of button is not edited in this version (only active, unmanaged, top-level plain buttons with no visibility formula are)',
  'command-state-app-scope-unverified': 'app-scoped command rows are not edited in this version; only table-scoped rows are',
  'command-state-spec-invalid': 'correct the commandStates entries named above (or leave commandStates out)',
});

// The approval display: each change and the exact token that approves it, e.g.
//   commandStates — approve to apply (pass every --authorize back to the build):
//     new_ticket MainTab button "Go" (row <rowId>, ...): hidden false -> true
//       --authorize overwrite:command-state:new_ticket/MainTab/<rowId>/<sha256>
const approvalDisplayOf = (lines) => `commandStates — approve to apply (pass every --authorize back to the build):\n${lines.map(([what, token]) => `  ${what}\n    --authorize ${token}`).join('\n')}`;

const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
const flagWords = (flags) => Object.entries(flags).map(([key, value]) => `${SPEC_FLAG[key]} ${value}`).join(', ');

/**
 * How a build treats the spec's command states:
 *   off          the feature is not used (absent or []): nothing below runs, nothing is read
 *   plan         a dry run: read-only planning when the commands phase is selected
 *   data-stage   exactly --stage data: command states are not applied, needs no approval, reads nothing
 *   apply        a full build with --publish
 * or an error: { code, message } for any other apply — refused before the build writes anything.
 */
function commandStateMode(spec, { apply = false, publish = false, phases = PHASES, changedOnlyFast = false } = {}) {
  if (!usesCommandStates(spec)) return { mode: 'off' };
  if (!apply) return { mode: 'plan' };
  if (!changedOnlyFast && sameSet(phases, STAGES.data)) return { mode: 'data-stage' };
  if (changedOnlyFast || !sameSet(phases, PHASES)) {
    return { mode: 'error', code: CODES.phaseUnsupported, message: `commandStates: a partial apply (${(phases || []).join(',')}) cannot apply command states. ${REMEDY[CODES.phaseUnsupported]}` };
  }
  if (!publish) return { mode: 'error', code: CODES.publishRequired, message: `commandStates: ${REMEDY[CODES.publishRequired]}.` };
  const keyed = (c) => !!(c && (c.key !== undefined || (Array.isArray(c.children) && c.children.some(keyed))));
  if ((Array.isArray(spec.commands) ? spec.commands : []).some(keyed)) {
    return { mode: 'error', code: CODES.keyedUnsupported, message: `commandStates: ${REMEDY[CODES.keyedUnsupported]}.` };
  }
  return { mode: 'apply' };
}

// The remedy of a row that no longer holds its flags at the final proof: no write of this build is claimed, and none is undone.
const LATE_MISMATCH_REMEDY = 'this build did not overwrite that change and rolls nothing back. Read the row (list-command-states.js), find out what changed it, then run the build again';

// Every outcome createCommandStateRun records for a row (`record`, and `planned` before anything happens to it). Closed: a test scans this
// file's recorded outcome literals and fails on one this list (and ROW_WORDS) does not name.
const ROW_OUTCOMES = Object.freeze(['planned', 'unchanged', 'acknowledged', 'observed-matching-after-unknown-send', 'unknown', 'refused']);
// The ONE place a row outcome becomes words in a message the build says after the row's own step: the publication diagnostic (`kind`, a
// table's tally word), and what this build did to the row (`history`) for the post-write read, the final proof (drift and membership) and
// the result lines. The rule the wording keeps: only `acknowledged` (a write answered 200/204 AND read back holding the flags) is "saved" or
// "accepted". An unanswered send whose row later held the flags is not proof this build saved them (someone else may have), so it says its
// answer was unknown and what the later read showed. A row this build did not write says so.
const ROW_WORDS = Object.freeze({
  planned: Object.freeze({ kind: 'not written', history: 'not written by this build (the build stopped before it)' }),
  unchanged: Object.freeze({ kind: 'already held', history: 'not written by this build (it already held the declared flags)' }),
  acknowledged: Object.freeze({ kind: 'saved', history: 'written by this build: the write was accepted and read back holding the declared flags' }),
  'observed-matching-after-unknown-send': Object.freeze({
    kind: 'held after a write with no answer',
    history: 'this build\'s write got no answer, so its outcome is unknown; a later read found the declared flags, which is not proof this build saved them',
  }),
  unknown: Object.freeze({ kind: 'outcome unknown', history: 'this build\'s write has an unknown outcome: no read showed the row holding the declared flags' }),
  refused: Object.freeze({ kind: 'not written', history: 'not written by this build (it was refused)' }),
});
// A table's words when all its rows share one kind, and the order a mixed table counts them in.
const KIND_WHOLE = Object.freeze({
  saved: 'saved, not published',
  'held after a write with no answer': 'held the declared flags after a write with no answer (not known to be this build\'s), not published',
  'already held': 'already held the declared flags, not published by this build',
  'outcome unknown': 'write outcome unknown, not published',
  'not written': 'not written, not published',
});
const KIND_ORDER = Object.freeze(['saved', 'held after a write with no answer', 'already held', 'outcome unknown', 'not written']);
// An outcome the list does not name (a defect the inventory test exists to catch) is said as unknown: never as a write that landed.
const rowWords = (outcome) => (Object.prototype.hasOwnProperty.call(ROW_WORDS, outcome) ? ROW_WORDS[outcome] : ROW_WORDS.unknown);
const rowLabel = (r) => `command state ${r.entity}/${r.location}/${r.rowId}`;
const ROW_MESSAGES = Object.freeze({
  /** A publication-unconfirmed table, from the outcomes of its rows. */
  publicationTable(entity, rows) {
    if (!rows.length) return `${entity}: publication not confirmed`;
    const counts = new Map();
    for (const r of rows) { const { kind } = rowWords(r.outcome); counts.set(kind, (counts.get(kind) || 0) + 1); }
    if (counts.size === 1) return `${entity}: ${KIND_WHOLE[[...counts.keys()][0]]}`;
    return `${entity}: ${rows.length} rows (${KIND_ORDER.filter((k) => counts.has(k)).map((k) => `${counts.get(k)} ${k}`).join(', ')}), not published`;
  },
  /** A row that, read again after every row's step, does not hold the declared flags. */
  postWriteMismatch(row, back) {
    return `${rowLabel(row)} (${rowWords(row.outcome).history}): read again after every row's write, it ${back.row ? `holds hidden ${back.row.hidden}, disabled ${back.row.disabled}` : 'could not be read'}`;
  },
  /** The final proof's preface: what this build did to every declared row, none of which is rolled back. */
  lateNote(rows) {
    return `checked again at the end of the build, after its app work; nothing is rolled back (${rows.map((r) => `${rowLabel(r)}: ${rowWords(r.outcome).history}`).join('; ')})`;
  },
  /** A row that no longer holds its declared flags at the final proof. */
  finalDrift(row, now) {
    return `${rowLabel(row)}: it now holds hidden ${now.hidden}, disabled ${now.disabled}: the flags no longer match, so the row changed during the build, after this build's step for it (${rowWords(row.outcome).history}) — ${LATE_MISMATCH_REMEDY}`;
  },
  /** A row's line in the result an apply (or its halt) prints. */
  resultLine(row) {
    return `${rowLabel(row)}: ${row.outcome}${row.changed && row.changed.length ? ` (${row.changed.join(', ')})` : ''}${row.code ? ` [${row.code}]` : ''} — ${rowWords(row.outcome).history}`;
  },
});

function fail(code, message, detail) {
  return new CommandStateError(code, `${message} — ${REMEDY[code] || 'see the message above'}`, detail);
}

/**
 * The build halt for a command-state refusal or unknown outcome: never retried automatically (lib/retry-policy.js RETRY.NEVER), with its code
 * and the CommandStateError as its cause. Any other error is returned as it is.
 */
function commandStateHalt(error, phase) {
  if (!(error instanceof CommandStateError)) return error;
  const { BuildHalt } = require('./entity-provision.js');
  const { RETRY } = require('./retry-policy.js');
  const halt = new BuildHalt(`${error.code}: ${error.message}`, { phase, code: error.code, recoverable: false, retry: RETRY.NEVER, cause: error });
  if (error.approvalDisplay) withApprovalDisplay(halt, error.approvalDisplay);
  return halt;
}

/**
 * The exact --authorize tokens an approval halt asks for, kept OFF the error's message: a halt's message reaches the generic build journal
 * (build-log.jsonl, build-status.json), where an exact approval token or row digest must not be stored. They ride on the error as a
 * non-enumerable `approvalDisplay` (so no serialization carries them either), which build-model-app.js prints to the maker with the halt, on
 * the console only; a direct caller reads it there. A dry run prints the same tokens.
 */
function withApprovalDisplay(error, text) {
  try {
    Object.defineProperty(error, 'approvalDisplay', { value: text, enumerable: false, configurable: true, writable: true });
  } catch { /* a frozen error keeps its message; a dry run still prints every token */ }
  return error;
}

/**
 * The offline check of the spec's commandStates (lib/command-state-contract.js validateCommandStates), as the build halt the engine throws
 * before it does anything else, or null when the declaration is absent, empty or valid. The engine runs it itself because a direct caller
 * (or the CLI with a structural profile, where these findings are only warnings) never passed through the App Spec validator: a supplied
 * value that is not valid (null, an object, an entry with a commands[] field or app scope) is refused, never treated as absent. Any
 * malformed entry makes it command-state-spec-invalid; app scope alone is command-state-app-scope-unverified.
 */
function commandStateSpecHalt(spec) {
  const { findings, errors } = validateCommandStates(spec);
  if (!findings.length) return null;
  const code = findings.some((f) => f.code === 'command-state-spec-invalid') ? 'command-state-spec-invalid' : 'command-state-app-scope-unverified';
  return commandStateHalt(fail(code, `the App Spec's commandStates is not valid: ${errors.join('; ')}`), 'preflight');
}

/**
 * Records, for each declared table, whether the build's existing table publication was seen to cover its latest command-row write. Every
 * callback is read-only and never throws: an observation it cannot make leaves the table unconfirmed, which only assertComplete acts on.
 */
function createCommandStatePublicationObserver() {
  const tables = new Map();
  const lc = (name) => String(name).toLowerCase();
  const confirm = (entry, path) => {
    entry.outcome = 'confirmed';
    entry.confirmation = { generation: entry.generation, path };
    delete entry.reason;
  };
  const unconfirmedEntries = () => [...tables.values()].filter((t) => t.outcome !== 'confirmed');
  let rowsOf = () => [];
  // What each unconfirmed table's rows are known to hold, worded from their outcomes by the one mapping (ROW_MESSAGES.publicationTable).
  const describeTable = (entry) => {
    let rows = [];
    try { rows = (rowsOf() || []).filter((r) => r && lc(r.entity) === entry.entity); } catch { rows = []; }
    return ROW_MESSAGES.publicationTable(entry.entity, rows);
  };
  const describeUnconfirmed = () => unconfirmedEntries().sort((a, b) => (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0)).map(describeTable).join('; ');
  const snapshot = () => [...tables.values()].sort((a, b) => (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0)).map((t) => ({
    entity: t.entity,
    outcome: t.outcome,
    basis: 'existing-before-app-table-envelope',
    ...(t.confirmation ? { path: t.confirmation.path } : {}),
    ...(t.outcome !== 'confirmed' ? { reason: t.reason, code: CODES.publishUnconfirmed } : {}),
  }));
  return {
    /** The row results of the attempt now running (createCommandStateRun), for a halt to carry. */
    trackRows(fn) { if (typeof fn === 'function') rowsOf = fn; },
    /** A table every apply must see published, even when its rows already hold the declared flags (a save that was never published). */
    register(entity, rowIds = []) {
      const name = lc(entity);
      if (!tables.has(name)) tables.set(name, { entity: name, rowIds: new Set(), generation: 0, outcome: 'unconfirmed', reason: 'not-observed' });
      for (const id of rowIds) tables.get(name).rowIds.add(id);
    },
    declaredTables: () => [...tables.keys()].sort(),
    /** Before a row write is sent: a publication seen before it cannot have published it. */
    noteRowWrite(entity) {
      const entry = tables.get(lc(entity));
      if (!entry) return;
      entry.generation += 1;
      entry.outcome = 'unconfirmed';
      entry.reason = 'not-observed';
      delete entry.confirmation;
    },
    /** The plain before-app envelope: only a non-empty list answered ok confirms, and only the names it carried. */
    observePlain(names, outcome) {
      try {
        if (!Array.isArray(names) || !names.length) return;
        const ok = !!outcome && outcome.ok === true;
        for (const name of names) {
          const entry = tables.get(lc(name));
          if (!entry) continue;
          if (ok) confirm(entry, 'plain-before-app');
          else if (entry.outcome !== 'confirmed') entry.reason = 'failed';
        }
      } catch { /* an observation that cannot be made confirms nothing */ }
    },
    /** The managed publisher's flush: only the names in `published` confirm; `withheld` says why a table did not. */
    observeManaged(flushed) {
      try {
        const published = flushed && Array.isArray(flushed.published) ? flushed.published : [];
        const withheld = flushed && Array.isArray(flushed.withheld) ? flushed.withheld : [];
        for (const name of published) { const entry = tables.get(lc(name)); if (entry) confirm(entry, 'managed-before-app'); }
        for (const name of withheld) { const entry = tables.get(lc(name)); if (entry && entry.outcome !== 'confirmed') entry.reason = 'withheld'; }
      } catch { /* as above */ }
    },
    unconfirmed: () => unconfirmedEntries().map((t) => t.entity).sort(),
    /** Each unconfirmed table with what its rows are known to hold, e.g. `new_ticket: saved, not published`. */
    describeUnconfirmed,
    /**
     * What a halt carries for this feature (not enumerable: it never reaches a serialized error, the journal or a retry's reading of the
     * error): `commandStates`, the rows and tables as they stand, and — while a declared table's publication is unconfirmed —
     * `commandStatePublicationError`. The halt's own code, cause and retry policy are left as they are.
     */
    attachFailure(error) {
      try {
        if (!error || typeof error !== 'object') return;
        const open = unconfirmedEntries();
        for (const entry of open) if (entry.reason === 'not-observed') entry.reason = 'halted-before-send';
        Object.defineProperty(error, 'commandStates', { value: { rows: rowsOf(), publication: snapshot() }, enumerable: false, configurable: true, writable: true });
        if (!open.length) return;
        const names = open.map((t) => t.entity).sort();
        Object.defineProperty(error, 'commandStatePublicationError', {
          value: { code: CODES.publishUnconfirmed, tables: names, message: `${describeUnconfirmed()} — required table publication was not confirmed; ${REMEDY[CODES.publishUnconfirmed]}.` },
          enumerable: false, configurable: true, writable: true,
        });
      } catch { /* a frozen error carries nothing */ }
    },
    snapshot,
  };
}

/**
 * One build attempt's command-state work.
 * @param {object} options
 * @param {object} options.spec - a validated App Spec with a non-empty commandStates
 * @param {object} options.transport - lib/command-state-transport.js, with `patchRow`
 * @param {string} options.origin - the environment, e.g. https://contoso.crm.dynamics.com
 * @param {{ rows?: Set<string>, tables?: Set<string> }} [options.approvals] - the exact --authorize tokens of this feature
 * @param {boolean} [options.publish] - the run publishes (an apply always does: commandStateMode)
 * @param {object|null} [options.observer] - createCommandStatePublicationObserver, or null (a dry run)
 */
function createCommandStateRun({ spec, transport, origin, approvals = {}, publish = true, observer = null } = {}) {
  const states = normalizeCommandStates(spec);
  const rowApprovals = approvals.rows instanceof Set ? approvals.rows : new Set();
  const tableApprovals = approvals.tables instanceof Set ? approvals.tables : new Set();
  const env = canonicalOrigin(origin);
  // The public result of each row, in the spec's order.
  const results = new Map(states.map((s) => [s.rowId, { entity: s.entity, location: s.bar, scope: s.scope, rowId: s.rowId, outcome: 'planned', changed: [] }]));
  let current = null;

  const label = (s) => `command state ${s.entity}/${s.bar}/${s.rowId}`;
  const record = (rowId, patch) => Object.assign(results.get(rowId), patch);

  function requireTransport({ write }) {
    const needs = ['get', 'getAbsolute', 'apiUrl', ...(write ? ['patchRow'] : [])];
    if (!transport || needs.some((name) => typeof transport[name] !== 'function')) {
      throw fail(CODES.transport, `commandStates: no ${write ? 'row reader and writer' : 'row reader'} was given to this build`);
    }
    if (!env) throw fail(CODES.transport, 'commandStates: the environment\'s https origin is not known');
  }

  // A row as the plan needs it, judged against the context: refused unless it is a candidate with a usable version.
  async function readJudged(context, s) {
    const table = context.tables.get(s.entity);
    const read = await readCommandStateRow(transport, s.rowId);
    if (!read.found) throw fail(CODES.rowNotFound, `${label(s)}: the platform says the row does not exist`);
    const decoded = decodeCommandStateRow(read.body, {
      rowId: s.rowId, entity: s.entity, metadataId: table.metadataId, appId: context.appId, inApp: table.inApp, location: s.location,
      optimisticConcurrency: context.optimisticConcurrency, requireVersion: true,
    });
    if (!decoded.eligible) {
      const code = codeForReasons(decoded.reasons) || CODES.rowUnreadable;
      throw fail(code, `${label(s)}: ${decoded.reasons.join(', ')}${decoded.details.length ? ` (${decoded.details.join('; ')})` : ''}`);
    }
    return { table, row: decoded.row };
  }

  function planItem(context, s, table, row) {
    const before = { hidden: row.hidden, isdisabled: row.disabled };
    const delta = diffCommandFlags(s.desired, before);
    const ids = { origin: env, appId: context.appId, tableId: table.metadataId, entity: s.entity, location: s.location, rowId: s.rowId };
    return {
      ...s, tableId: table.metadataId, appId: context.appId, caption: row.caption, before, etag: row.version, delta,
      approvalKey: Object.keys(delta).length ? commandStateApprovalKey({ ...ids, ifMatch: row.version, desired: s.desired }) : null,
    };
  }

  async function readPlan() {
    const context = await resolveCommandStateContext(transport, { appUniqueName: spec.app.uniqueName, entities: [...new Set(states.map((s) => s.entity))] });
    if (!context.optimisticConcurrency) throw fail(CODES.versionUnavailable, 'commandStates: the table of commands does not keep row versions (optimistic concurrency is off)');
    const items = [];
    for (const s of states) {
      const { table, row } = await readJudged(context, s);
      items.push(planItem(context, s, table, row));
    }
    const tables = [...new Set(items.map((i) => i.entity))].sort().map((entity) => {
      const first = items.find((i) => i.entity === entity);
      return { entity, token: commandTablePublishApprovalKey({ origin: env, appId: context.appId, tableId: first.tableId, entity }) };
    });
    return { context, items, tables };
  }

  // What one change is, for a maker deciding whether to approve it.
  function describe(item) {
    const caption = item.caption === null ? '(unlabelled)' : JSON.stringify(item.caption);
    const changes = Object.keys(item.desired).map((key) => `${SPEC_FLAG[key]} ${item.before[key]} -> ${item.desired[key]}${item.before[key] === item.desired[key] ? ' (already)' : ''}`).join(', ');
    const disabledNote = Object.prototype.hasOwnProperty.call(item.delta, 'isdisabled') && item.delta.isdisabled
      ? '; disabled turns the modern command off for users (a ribbon equivalent can show instead) — it is not a security setting' : '';
    return `${item.entity} ${item.bar} button ${caption} (row ${item.rowId}, table scope: every app that shows this table; stored hidden ${item.before.hidden}, disabled ${item.before.isdisabled}): ${changes}${disabledNote}`;
  }

  // Every approval the plan needs and does not have, in one stop.
  function checkApprovals(p) {
    const lines = [];
    const codes = new Set();
    for (const item of p.items) {
      if (!item.approvalKey || rowApprovals.has(item.approvalKey)) continue;
      const prefix = item.approvalKey.slice(0, item.approvalKey.lastIndexOf('/') + 1);
      const stale = [...rowApprovals].some((token) => token.startsWith(prefix));
      codes.add(stale ? CODES.approvalStale : CODES.approvalRequired);
      lines.push([`${describe(item)}${stale ? ' — the approval given was for another version of this row or another intent' : ''}`, item.approvalKey]);
    }
    if (publish) {
      for (const table of p.tables) {
        if (tableApprovals.has(table.token)) continue;
        codes.add(CODES.publicationApprovalRequired);
        lines.push([`publish table ${table.entity}: publishes ALL saved customizations on it (anyone's), not only these buttons`, table.token]);
      }
    }
    if (!lines.length) return;
    const code = [CODES.approvalStale, CODES.approvalRequired, CODES.publicationApprovalRequired].find((c) => codes.has(c));
    // The message names what needs approval; the tokens themselves go only to the approval display (withApprovalDisplay).
    throw withApprovalDisplay(
      fail(code, `commandStates: ${lines.length} approval${lines.length === 1 ? '' : 's'} needed before this build writes anything (the exact --authorize tokens are printed with this halt, and by a dry run):\n  ${lines.map(([what]) => what).join('\n  ')}\n`),
      approvalDisplayOf(lines),
    );
  }

  // Each declared flag, read back: identity and every flag the entry sets.
  const matches = (item, row) => Object.keys(item.desired).every((key) => (key === 'hidden' ? row.hidden : row.disabled) === item.desired[key]);

  async function readBack(item) {
    try {
      const { row } = await readJudged(current.context, item);
      return { ok: matches(item, row), row };
    } catch (error) {
      return { ok: false, error };
    }
  }

  async function sendOne(item) {
    const { table, row } = await readJudged(current.context, item);
    const fresh = planItem(current.context, item, table, row);
    if (!fresh.approvalKey) {
      record(item.rowId, { outcome: 'unchanged', changed: [] });
      return;
    }
    if (!rowApprovals.has(fresh.approvalKey)) {
      throw withApprovalDisplay(
        fail(CODES.approvalStale, `${label(item)}: the row changed since it was approved; it was not written (its new --authorize token is printed with this halt, and by a dry run):\n  ${describe(fresh)}\n`),
        approvalDisplayOf([[describe(fresh), fresh.approvalKey]]),
      );
    }
    const changed = Object.keys(fresh.delta).map((key) => SPEC_FLAG[key]);
    if (observer) observer.noteRowWrite(item.entity);
    let answer;
    let thrown;
    try {
      answer = await transport.patchRow(item.rowId, fresh.etag, fresh.delta);
    } catch (error) {
      if (error instanceof CommandStateError) throw error;
      thrown = error;
    }
    const status = answer && answer.status;
    if (!thrown && (status === 200 || status === 204)) {
      const back = await readBack(fresh);
      if (!back.ok) {
        record(item.rowId, { outcome: 'unknown', changed, code: CODES.notConfirmed });
        throw fail(CODES.notConfirmed, `${label(item)}: the write of ${flagWords(fresh.delta)} was answered HTTP ${status}, but the row read back ${back.row ? `holds hidden ${back.row.hidden}, disabled ${back.row.disabled}` : `could not be judged (${(back.error && back.error.code) || 'read failed'})`}`);
      }
      record(item.rowId, { outcome: 'acknowledged', changed });
      return;
    }
    if (!thrown && status === 404 && errorCode(answer.body) === NOT_FOUND) {
      record(item.rowId, { outcome: 'refused', code: CODES.rowNotFound });
      throw fail(CODES.rowNotFound, `${label(item)}: the row no longer exists; it was not written (and is never created)`);
    }
    if (!thrown && status === 412) {
      record(item.rowId, { outcome: 'refused', code: CODES.versionConflict });
      throw fail(CODES.versionConflict, `${label(item)}: the platform refused the write (HTTP 412): the row changed after it was read`);
    }
    // A definitive refusal: the request was authenticated and refused, so it changed nothing. 408 (timed out) and 429 (a limit) do not say
    // the write never started, so they are read like an unknown outcome below.
    if (!thrown && Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      record(item.rowId, { outcome: 'refused', code: CODES.updateRejected });
      throw fail(CODES.updateRejected, `${label(item)}: the platform refused the write (HTTP ${status}${errorCode(answer.body) ? ` ${errorCode(answer.body)}` : ''})`);
    }
    // No answer, a 5xx, 408, 429 or any status this does not expect (201, 202, 3xx): the write may have committed. It is never sent again; the
    // row is read once more and the outcome said as it is found.
    const why = thrown ? `no answer (${String((thrown && thrown.message) || thrown).slice(0, 200)})` : `HTTP ${status}`;
    const back = await readBack(fresh);
    if (back.ok) {
      record(item.rowId, { outcome: 'observed-matching-after-unknown-send', changed });
      return;
    }
    record(item.rowId, { outcome: 'unknown', changed, code: CODES.writeUnknown });
    const seen = back.row ? `the row now holds hidden ${back.row.hidden}, disabled ${back.row.disabled} at version ${back.row.version}${back.row.version === fresh.etag ? ' (the version the write was made against: it may still land)' : ''}`
      : `the row could not be read back (${(back.error && back.error.code) || 'read failed'})`;
    throw fail(CODES.writeUnknown, `${label(item)}: the write of ${flagWords(fresh.delta)} got ${why}; ${seen}`);
  }

  // The final proof (assertComplete): a fresh app context, then every declared row read and judged against it and its flags compared.
  async function recheckAtCompletion() {
    const lateNote = ROW_MESSAGES.lateNote(rowResults());
    try {
      requireTransport({ write: false });
      const context = await resolveCommandStateContext(transport, { appUniqueName: spec.app.uniqueName, entities: [...new Set(states.map((s) => s.entity))] });
      for (const s of states) {
        const { row } = await readJudged(context, s);
        if (!matches(s, row)) {
          // Its own remedy, not command-state-not-confirmed's: the commands phase read every row it wrote back holding the flags, so this
          // is a change made during the build, after that read, and what this build did to the row is said from its recorded outcome.
          throw new CommandStateError(CODES.notConfirmed, ROW_MESSAGES.finalDrift({ ...results.get(s.rowId) }, row));
        }
      }
    } catch (error) {
      if (!(error instanceof CommandStateError)) throw error;
      throw new CommandStateError(error.code, `${lateNote}: ${error.message}`, error.detail);
    }
  }
  // A step's refusal, as the build halt it ends the build with.
  async function step(phase, run) {
    try {
      return await run();
    } catch (error) {
      throw commandStateHalt(error, phase);
    }
  }

  const rowResults = () => [...results.values()].map((r) => ({ ...r, changed: [...r.changed] }));
  function result() {
    return { rows: rowResults(), publication: observer ? observer.snapshot() : [] };
  }
  // The observer outlives this attempt: it reports the rows of the latest attempt with a halt that ends the invocation.
  if (observer && typeof observer.trackRows === 'function') observer.trackRows(rowResults);

  return {
    /** Read-only planning for a dry run: what each row holds, what would change, and the exact approvals the apply would need. */
    plan: () => step('plan', async () => {
      requireTransport({ write: false });
      const p = await readPlan();
      return {
        rows: p.items.map((item) => ({
          entity: item.entity, location: item.bar, scope: item.scope, rowId: item.rowId, caption: item.caption, before: { ...item.before },
          desired: { ...item.desired }, change: { ...item.delta }, description: describe(item),
          ...(item.approvalKey ? { approval: item.approvalKey, approved: rowApprovals.has(item.approvalKey) } : {}),
        })),
        tables: p.tables.map((t) => ({ ...t, approved: tableApprovals.has(t.token) })),
      };
    }),
    /** Before the build's first write: every row, every approval; then the observer learns which tables must be published. */
    preflight: () => step('preflight', async () => {
      requireTransport({ write: true });
      current = await readPlan();
      checkApprovals(current);
      if (observer) for (const t of current.tables) observer.register(t.entity, current.items.filter((i) => i.entity === t.entity).map((i) => i.rowId));
    }),
    /** In the commands phase, before any row write: everything read again, and every remaining change still approved. */
    recheckAll: () => step('commands', async () => {
      requireTransport({ write: true });
      current = await readPlan();
      checkApprovals(current);
    }),
    /** One row at a time, then every row read once more before the build publishes. */
    applyRows: () => step('commands', async () => {
      if (!current) throw fail(CODES.transport, 'commandStates: rows applied before they were planned');
      for (const item of current.items) {
        try {
          await sendOne(item);
        } catch (error) {
          // A refusal before the send (the fresh read) leaves this row planned in the results: say it was refused, and why.
          if (results.get(item.rowId).outcome === 'planned') record(item.rowId, { outcome: 'refused', code: error && error.code });
          throw error;
        }
      }
      for (const item of current.items) {
        const back = await readBack(item);
        if (!back.ok) {
          // Worded from the outcome the row had before it is recorded unknown here: what this build did to it.
          const message = ROW_MESSAGES.postWriteMismatch({ ...results.get(item.rowId) }, back);
          record(item.rowId, { outcome: 'unknown', code: CODES.notConfirmed });
          throw fail(CODES.notConfirmed, message);
        }
      }
    }),
    /** The tables this attempt's rows are on. */
    requiredTables: () => [...new Set(states.map((s) => s.entity))].sort(),
    /**
     * After the build's shared work: every declared row judged again against the app and its tables as they are NOW, and every declared
     * table's publication confirmed, or exit 1. The context the commands phase resolved is not proof here: the build's own app work runs
     * after it and can take a table out of the app, so membership is resolved afresh. A refusal this late does not undo anything: the rows
     * already written stay written and a publication already sent stands, and each row's outcome stays what was observed.
     */
    assertComplete: () => step('publish', async () => {
      if (!observer) return;
      await recheckAtCompletion();
      const open = observer.unconfirmed();
      if (open.length) throw fail(CODES.publishUnconfirmed, `${observer.describeUnconfirmed()} — required table publication was not confirmed`);
    }),
    result,
  };
}

module.exports = {
  CODES, REMEDY, ROW_OUTCOMES, ROW_WORDS, ROW_MESSAGES, commandStateMode, commandStateHalt, commandStateSpecHalt, createCommandStateRun, createCommandStatePublicationObserver,
};
