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
const { resolveCommandStateContext, readCommandStateRow, decodeCommandStateRow, errorCode, NOT_FOUND, readFailureText } = require('./command-state-read.js');
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
  [CODES.notConfirmed]: 'the declared flags are not confirmed on the row. Read the row (list-command-states.js) before running the build again',
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

// Every outcome createCommandStateRun records for a row: `planned` before anything happens to it, then only what `record` accepts
// (checkRowRecord, which also checks the outcome against the row's facts below). The outcome is a short name for the row's step; it is never
// what a message says. Every message words the row from its FACTS, the ordered list of what the build read and sent for it:
//   unchanged     no write was sent and the last read found the declared flags
//   acknowledged  the last write was answered 200/204, and every read since it found the flags
//   observed-matching-after-unknown-send   the last write got no usable answer, and every read since it (at least one) found the flags
//   unknown       a write was sent and not every read since it found the flags
//   refused       no write was sent, or the last one was refused
//   drifted       one of the first three, then the read after every row's step did not find the flags; `before` keeps which one
const ROW_OUTCOMES = Object.freeze(['planned', 'unchanged', 'acknowledged', 'observed-matching-after-unknown-send', 'unknown', 'refused', 'drifted']);
// What a `drifted` row was before its later read: a row that matched after its own step.
const DRIFT_BEFORE = Object.freeze(['unchanged', 'acknowledged', 'observed-matching-after-unknown-send']);
// The one word for a write answered 200/204: a send's `answer` in the facts, and the outcome of a row read back holding its flags after one.
// It is named here, inside the vocabulary, so that no literal outside the vocabulary says it.
const ACKNOWLEDGED = 'acknowledged';
// The ONE vocabulary every claim about a row is made of (the renderer, renderRowHistory, and the publication kinds, rowKind, compose these and
// nothing else that claims a write). The rule the words keep: only a write answered 200/204 AND then read back holding the flags is
// "accepted" or "saved"; a write with no usable answer says its outcome is unknown and what a later read found; a row this build did not
// write says so; a read that could not be judged says only that.
const ROW_PHRASES = Object.freeze({
  notWritten: 'not written by this build',
  stoppedBefore: 'the build stopped before it',
  alreadyHeld: 'it already held the declared flags',
  writtenAndReadBack: 'written by this build: the write was accepted and read back holding the declared flags',
  answered: (status) => `this build's write was answered HTTP ${status}`,
  noAnswer: 'this build\'s write got no answer, so its outcome is unknown',
  noUsableAnswer: (status) => `this build's write got no usable answer (HTTP ${status}), so its outcome is unknown`,
  laterMatchAfterLost: 'a later read found the declared flags, which is not proof this build saved them',
  refusedSend: (status) => `its write was refused${status ? ` (HTTP ${status})` : ''}`,
  unnamed: 'what this build did to it is not known',
});
// Where in the build a read was made, as said after "a read".
const READ_PHASES = Object.freeze({
  plan: 'in the dry run',
  preflight: 'at the start of the build',
  recheck: 'in the commands phase, before the row writes',
  'own-step': 'at its own step',
  readback: 'after its write',
  'after-every-row': 'after every row\'s step',
  final: 'at the end of the build',
});
// A row's publication kind (rowKind), the words a table says when all its rows share it, and the order a mixed table counts them in.
const KINDS = Object.freeze({
  saved: 'saved',
  heldAfterLost: 'held after a write with no usable answer',
  alreadyHeld: 'already held',
  otherFlags: 'held other flags at its last read',
  unreadable: 'could not be read at its last read',
  unknown: 'outcome unknown',
  notWritten: 'not written',
});
const KIND_WHOLE = Object.freeze({
  [KINDS.saved]: 'saved, not published',
  [KINDS.heldAfterLost]: 'held the declared flags after a write with no usable answer (not known to be this build\'s), not published',
  [KINDS.alreadyHeld]: 'already held the declared flags, not published by this build',
  [KINDS.otherFlags]: 'held other flags than declared at its last read, not published',
  [KINDS.unreadable]: 'could not be read at its last read, not published',
  [KINDS.unknown]: 'write outcome unknown, not published',
  [KINDS.notWritten]: 'not written, not published',
});
const KIND_ORDER = Object.freeze(Object.values(KINDS));
const named = (outcome) => typeof outcome === 'string' && ROW_OUTCOMES.includes(outcome);

// The facts of one row, in order: what each read found and how each write was answered. They hold no version, token or service text.
//   { attempt, kind: 'read', phase: <READ_PHASES key>, result: 'matched' | 'differed' | 'unreadable', hidden?, disabled?, code? }
//   { attempt, kind: 'send', answer: 'acknowledged' | 'lost' | 'refused', status?, flags }
// `lost` is a send whose answer does not say whether it landed (none, 5xx, 408, 429 or a status this does not expect).
const isRead = (e) => !!e && e.kind === 'read';
const isSend = (e) => !!e && e.kind === 'send';
const counts = (e) => isSend(e) && (e.answer === ACKNOWLEDGED || e.answer === 'lost');
const matched = (e) => e.result === 'matched';
// The last write that may have landed, and the reads made after it (every read, when there is none).
function sinceLastSend(facts) {
  let at = -1;
  facts.forEach((e, i) => { if (counts(e)) at = i; });
  return { send: at >= 0 ? facts[at] : null, reads: facts.slice(at + 1).filter(isRead) };
}

// Consecutive reads of one attempt that found the same thing, as one.
function readRuns(reads) {
  const runs = [];
  for (const e of reads) {
    const key = `${e.attempt}|${e.result}|${e.hidden}|${e.disabled}|${e.code}`;
    if (runs.length && runs[runs.length - 1].key === key) continue;
    runs.push({ key, first: e });
  }
  return runs;
}
const readClause = (e) => {
  const where = READ_PHASES[e.phase] || 'at a step of the build';
  if (e.result === 'matched') return `a read ${where} found the declared flags`;
  if (e.result === 'differed') return `a read ${where} found hidden ${e.hidden}, disabled ${e.disabled}, not the declared flags`;
  return `the row could not be read and judged ${where} (${e.code || 'read failed'})`;
};

/**
 * What this build did to a row and what its reads found, from its facts alone: the one renderer every message after a row's step uses. A row
 * whose facts span more than one attempt of the build tags each clause with its attempt.
 */
function renderRowHistory(facts) {
  if (!Array.isArray(facts)) return ROW_PHRASES.unnamed;
  const multi = new Set(facts.map((e) => e.attempt)).size > 1;
  const tag = (e) => (multi ? ` (attempt ${e.attempt})` : '');
  const sends = facts.map((e, i) => [e, i]).filter(([e]) => isSend(e));
  if (!sends.length) {
    const runs = readRuns(facts.filter(isRead));
    if (!runs.length) return `${ROW_PHRASES.notWritten} (${ROW_PHRASES.stoppedBefore})`;
    const [first, ...rest] = runs;
    return [`${ROW_PHRASES.notWritten} (${matched(first.first) ? ROW_PHRASES.alreadyHeld : readClause(first.first)})${tag(first.first)}`,
      ...rest.map((r) => `then ${readClause(r.first)}${tag(r.first)}`)].join('; ');
  }
  // What the row held before a write is why it was written, which its approval said; the history starts at the first write.
  const clauses = [];
  sends.forEach(([send, at], n) => {
    const end = n + 1 < sends.length ? sends[n + 1][1] : facts.length;
    let runs = readRuns(facts.slice(at + 1, end).filter(isRead));
    if (send.answer === ACKNOWLEDGED) {
      if (runs.length && matched(runs[0].first) && runs[0].first.phase === 'readback' && runs[0].first.attempt === send.attempt) {
        clauses.push(`${ROW_PHRASES.writtenAndReadBack}${tag(send)}`);
        runs = runs.slice(1);
      } else {
        clauses.push(`${ROW_PHRASES.answered(send.status)}${tag(send)}`);
      }
    } else if (send.answer === 'lost') {
      clauses.push(`${Number.isInteger(send.status) ? ROW_PHRASES.noUsableAnswer(send.status) : ROW_PHRASES.noAnswer}${tag(send)}`);
      if (runs.length && matched(runs[0].first)) {
        clauses.push(`${ROW_PHRASES.laterMatchAfterLost}${tag(runs[0].first)}`);
        runs = runs.slice(1);
      }
    } else {
      clauses.push(`${ROW_PHRASES.notWritten}: ${ROW_PHRASES.refusedSend(send.status)}${tag(send)}`);
    }
    for (const r of runs) clauses.push(`then ${readClause(r.first)}${tag(r.first)}`);
  });
  return clauses.join('; ');
}

/** A row's publication kind (KIND_WHOLE), from its facts alone: its last read, and the last write that may have landed. */
function rowKind(facts) {
  if (!Array.isArray(facts)) return KINDS.unknown;
  const reads = facts.filter(isRead);
  const { send, reads: after } = sinceLastSend(facts);
  const last = reads[reads.length - 1];
  const lostAfterMatch = (list) => {
    const end = list[list.length - 1];
    if (!end || matched(end) || !list.some(matched)) return null;
    return end.result === 'differed' ? KINDS.otherFlags : KINDS.unreadable;
  };
  if (!send) {
    if (!last) return KINDS.notWritten;
    if (matched(last)) return KINDS.alreadyHeld;
    return lostAfterMatch(reads) || KINDS.notWritten;
  }
  if (after.length && after.every(matched)) return send.answer === ACKNOWLEDGED ? KINDS.saved : KINDS.heldAfterLost;
  return lostAfterMatch(after) || KINDS.unknown;
}

// Whether `outcome` is what the facts show (see ROW_OUTCOMES): the outcome a row is recorded with can never say more than its facts.
function factsShow(outcome, before, facts) {
  const reads = facts.filter(isRead);
  const last = reads[reads.length - 1];
  const { send, reads: after } = sinceLastSend(facts);
  const allMatched = after.length > 0 && after.every(matched);
  const lastSendOfAny = [...facts].reverse().find(isSend);
  switch (outcome) {
    case 'unchanged': return !send && !!last && matched(last);
    case ACKNOWLEDGED: return !!send && send.answer === ACKNOWLEDGED && allMatched;
    case 'observed-matching-after-unknown-send': return !!send && send.answer === 'lost' && allMatched;
    case 'unknown': return !!send && !allMatched;
    case 'refused': return !send || (!!lastSendOfAny && lastSendOfAny.answer === 'refused');
    case 'drifted': {
      if (!last || matched(last)) return false;
      let end = facts.length;
      while (end > 0 && isRead(facts[end - 1]) && !matched(facts[end - 1])) end -= 1;
      return factsShow(before, undefined, facts.slice(0, end));
    }
    default: return false;
  }
}

const rowHistory = (row) => (row && Array.isArray(row.facts) ? renderRowHistory(row.facts) : ROW_PHRASES.unnamed);
const rowLabel = (r) => `command state ${r.entity}/${r.location}/${r.rowId}`;
const ROW_MESSAGES = Object.freeze({
  /** A publication-unconfirmed table, from the facts of its rows. */
  publicationTable(entity, rows) {
    if (!rows.length) return `${entity}: publication not confirmed`;
    const tally = new Map();
    for (const r of rows) { const kind = rowKind(r && r.facts); tally.set(kind, (tally.get(kind) || 0) + 1); }
    if (tally.size === 1) return `${entity}: ${KIND_WHOLE[[...tally.keys()][0]]}`;
    return `${entity}: ${rows.length} rows (${KIND_ORDER.filter((k) => tally.has(k)).map((k) => `${tally.get(k)} ${k}`).join(', ')}), not published`;
  },
  /** A row whose read after every row's step did not find the declared flags. */
  postWriteMismatch(row) {
    return `${rowLabel(row)}: ${rowHistory(row)}`;
  },
  /** The final proof's preface: what this build did to every declared row, none of which is rolled back. */
  lateNote(rows) {
    return `checked again at the end of the build, after its app work; nothing is rolled back (${rows.map((r) => `${rowLabel(r)}: ${rowHistory(r)}`).join('; ')})`;
  },
  /** A row that no longer holds its declared flags at the final proof (its facts end with that read). */
  finalDrift(row) {
    return `${rowLabel(row)}: ${rowHistory(row)} — ${LATE_MISMATCH_REMEDY}`;
  },
  /** A row's line in the result an apply (or its halt) prints. */
  resultLine(row) {
    return `${rowLabel(row)}: ${row.outcome}${row.before ? ` after ${row.before}` : ''}${row.changed && row.changed.length ? ` (${row.changed.join(', ')})` : ''}${row.code ? ` [${row.code}]` : ''} — ${rowHistory(row)}`;
  },
});

/**
 * The one boundary a row's outcome is recorded through (createCommandStateRun's `record`): an outcome ROW_OUTCOMES does not name, `planned`
 * (only ever the starting value), a `drifted` without the matching history it came from, a `before` on any other outcome, or — given the
 * row's facts — an outcome its facts do not show is a defect in this module, thrown as one: never recorded. Without facts it checks the
 * vocabulary only.
 */
function checkRowRecord(patch, facts) {
  const outcome = patch && patch.outcome;
  if (!named(outcome) || outcome === 'planned') throw new TypeError(`command-state writer defect: ${JSON.stringify(outcome)} is not an outcome a row can be recorded with (ROW_OUTCOMES)`);
  if (outcome === 'drifted' ? !DRIFT_BEFORE.includes(patch.before) : patch.before !== undefined) {
    throw new TypeError(`command-state writer defect: ${JSON.stringify(outcome)} recorded with before ${JSON.stringify(patch.before)}`);
  }
  if (facts !== undefined && !(Array.isArray(facts) && factsShow(outcome, patch.before, facts))) {
    throw new TypeError(`command-state writer defect: ${JSON.stringify(outcome)}${patch.before ? ` after ${JSON.stringify(patch.before)}` : ''} is not what the row's facts show`);
  }
  return patch;
}

/**
 * The rows of one build invocation: each declared row's public result and its facts, kept across the build's own retries so a later attempt
 * says what an earlier one did. The publication observer, which lives for the invocation, owns one; a run without an observer (a dry run,
 * a direct caller) makes its own.
 */
function createCommandStateRowStore() {
  return { attempt: 0, rows: new Map() };
}

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
  const rowStore = createCommandStateRowStore();
  // What each unconfirmed table's rows are known to hold, worded from their facts by the one mapping (ROW_MESSAGES.publicationTable).
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
    /** The invocation's rows and their facts (createCommandStateRowStore), which every attempt of the build adds to. */
    rowStore,
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
  // The public result of each row, in the spec's order, with its facts: the invocation's own (the observer's store), so a retry of the build
  // keeps what an earlier attempt read and sent instead of starting each row again from `planned`.
  const store = observer && observer.rowStore ? observer.rowStore : createCommandStateRowStore();
  store.attempt += 1;
  const attempt = store.attempt;
  for (const s of states) {
    if (!store.rows.has(s.rowId)) store.rows.set(s.rowId, { entity: s.entity, location: s.bar, scope: s.scope, rowId: s.rowId, outcome: 'planned', changed: [], facts: [] });
  }
  const results = new Map(states.map((s) => [s.rowId, store.rows.get(s.rowId)]));
  let current = null;

  const label = (s) => `command state ${s.entity}/${s.bar}/${s.rowId}`;
  const record = (rowId, patch) => {
    const row = results.get(rowId);
    checkRowRecord(patch, row.facts);
    // A record replaces the row's whole step result: no `before` or `code` of an earlier record (an earlier attempt's) is carried into it.
    delete row.before;
    delete row.code;
    return Object.assign(row, patch);
  };
  const note = (rowId, fact) => { results.get(rowId).facts.push(Object.freeze({ attempt, ...fact })); };
  const history = (rowId) => renderRowHistory(results.get(rowId).facts);
  // An earlier attempt of this build sent a write to the row (one that may have landed): later messages must not say nothing was written.
  const sentBefore = (rowId) => results.get(rowId).facts.some((e) => counts(e) && e.attempt < attempt);

  function requireTransport({ write }) {
    const needs = ['get', 'getAbsolute', 'apiUrl', ...(write ? ['patchRow'] : [])];
    if (!transport || needs.some((name) => typeof transport[name] !== 'function')) {
      throw fail(CODES.transport, `commandStates: no ${write ? 'row reader and writer' : 'row reader'} was given to this build`);
    }
    if (!env) throw fail(CODES.transport, 'commandStates: the environment\'s https origin is not known');
  }

  // A row as the plan needs it, judged against the context: refused unless it is a candidate with a usable version. Every read is noted in the
  // row's facts (`phase`, READ_PHASES), whatever it found, before this returns or throws.
  async function readJudged(context, s, phase) {
    const table = context.tables.get(s.entity);
    const unreadable = (code) => note(s.rowId, { kind: 'read', phase, result: 'unreadable', code });
    let read;
    try {
      read = await readCommandStateRow(transport, s.rowId);
    } catch (error) {
      unreadable(error instanceof CommandStateError ? error.code : CODES.rowUnreadable);
      throw error;
    }
    if (!read.found) {
      unreadable(CODES.rowNotFound);
      throw fail(CODES.rowNotFound, `${label(s)}: the platform says the row does not exist`);
    }
    const decoded = decodeCommandStateRow(read.body, {
      rowId: s.rowId, entity: s.entity, metadataId: table.metadataId, appId: context.appId, inApp: table.inApp, location: s.location,
      optimisticConcurrency: context.optimisticConcurrency, requireVersion: true,
    });
    if (!decoded.eligible) {
      const code = codeForReasons(decoded.reasons) || CODES.rowUnreadable;
      unreadable(code);
      throw fail(code, `${label(s)}: ${decoded.reasons.join(', ')}${decoded.details.length ? ` (${decoded.details.join('; ')})` : ''}`);
    }
    note(s.rowId, { kind: 'read', phase, result: matches(s, decoded.row) ? 'matched' : 'differed', hidden: decoded.row.hidden, disabled: decoded.row.disabled });
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

  async function readPlan(phase) {
    const context = await resolveCommandStateContext(transport, { appUniqueName: spec.app.uniqueName, entities: [...new Set(states.map((s) => s.entity))] });
    if (!context.optimisticConcurrency) throw fail(CODES.versionUnavailable, 'commandStates: the table of commands does not keep row versions (optimistic concurrency is off)');
    const items = [];
    for (const s of states) {
      const { table, row } = await readJudged(context, s, phase);
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
    // A retry of the build after an earlier attempt sent a row write cannot say "before this build writes anything": it says which rows.
    const earlier = states.filter((s) => sentBefore(s.rowId));
    const when = earlier.length
      ? `before this attempt writes anything (an earlier attempt of this build already sent a write: ${earlier.map((s) => `${label(s)}: ${history(s.rowId)}`).join('; ')})`
      : 'before this build writes anything';
    // The message names what needs approval; the tokens themselves go only to the approval display (withApprovalDisplay).
    throw withApprovalDisplay(
      fail(code, `commandStates: ${lines.length} approval${lines.length === 1 ? '' : 's'} needed ${when} (the exact --authorize tokens are printed with this halt, and by a dry run):\n  ${lines.map(([what]) => what).join('\n  ')}\n`),
      approvalDisplayOf(lines),
    );
  }

  // Each declared flag, read back: identity and every flag the entry sets.
  const matches = (item, row) => Object.keys(item.desired).every((key) => (key === 'hidden' ? row.hidden : row.disabled) === item.desired[key]);

  async function readBack(item, phase) {
    try {
      const { row } = await readJudged(current.context, item, phase);
      return { ok: matches(item, row), row };
    } catch (error) {
      return { ok: false, error };
    }
  }

  // What the facts say a row's step ended as when this attempt had nothing to send: a row an earlier attempt wrote keeps that write's
  // outcome while every read since it has found the flags.
  function outcomeWithoutSend(facts) {
    const { send, reads } = sinceLastSend(facts);
    if (!send) return 'unchanged';
    if (reads.length && reads.every(matched)) return send.answer === ACKNOWLEDGED ? ACKNOWLEDGED : 'observed-matching-after-unknown-send';
    return 'unknown';
  }

  async function sendOne(item) {
    const { table, row } = await readJudged(current.context, item, 'own-step');
    const fresh = planItem(current.context, item, table, row);
    if (!fresh.approvalKey) {
      const outcome = outcomeWithoutSend(results.get(item.rowId).facts);
      if (outcome === 'unchanged') { record(item.rowId, { outcome, changed: [] }); return; }
      record(item.rowId, { outcome, changed: results.get(item.rowId).changed, ...(outcome === 'unknown' ? { code: CODES.notConfirmed } : {}) });
      if (outcome === 'unknown') throw fail(CODES.notConfirmed, `${label(item)}: ${history(item.rowId)}`);
      return;
    }
    if (!rowApprovals.has(fresh.approvalKey)) {
      const again = sentBefore(item.rowId) ? ` again (${history(item.rowId)})` : '';
      throw withApprovalDisplay(
        fail(CODES.approvalStale, `${label(item)}: the row changed since it was approved; it was not written${again} (its new --authorize token is printed with this halt, and by a dry run):\n  ${describe(fresh)}\n`),
        approvalDisplayOf([[describe(fresh), fresh.approvalKey]]),
      );
    }
    const changed = Object.keys(fresh.delta).map((key) => SPEC_FLAG[key]);
    const flags = { ...fresh.delta };
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
    const what = `${label(item)} (the write of ${flagWords(fresh.delta)})`;
    if (!thrown && (status === 200 || status === 204)) {
      note(item.rowId, { kind: 'send', answer: ACKNOWLEDGED, status, flags });
      const back = await readBack(fresh, 'readback');
      if (!back.ok) {
        record(item.rowId, { outcome: 'unknown', changed, code: CODES.notConfirmed });
        throw fail(CODES.notConfirmed, `${what}: ${history(item.rowId)}`);
      }
      record(item.rowId, { outcome: ACKNOWLEDGED, changed });
      return;
    }
    const refused = (code) => {
      note(item.rowId, { kind: 'send', answer: 'refused', status, flags });
      record(item.rowId, { outcome: 'refused', code });
    };
    if (!thrown && status === 404 && errorCode(answer.body) === NOT_FOUND) {
      refused(CODES.rowNotFound);
      throw fail(CODES.rowNotFound, `${label(item)}: the row no longer exists; it was not written (and is never created)`);
    }
    if (!thrown && status === 412) {
      refused(CODES.versionConflict);
      throw fail(CODES.versionConflict, `${label(item)}: the platform refused the write (HTTP 412): the row changed after it was read`);
    }
    // A definitive refusal: the request was authenticated and refused, so it changed nothing. 408 (timed out) and 429 (a limit) do not say
    // the write never started, so they are read like an unknown outcome below.
    if (!thrown && Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      refused(CODES.updateRejected);
      throw fail(CODES.updateRejected, `${label(item)}: the platform refused the write (HTTP ${status}${errorCode(answer.body) ? ` ${errorCode(answer.body)}` : ''})`);
    }
    // No answer, a 5xx, 408, 429 or any status this does not expect (201, 202, 3xx): the write may have committed. It is never sent again; the
    // row is read once more and the outcome said as it is found.
    note(item.rowId, { kind: 'send', answer: 'lost', ...(thrown ? {} : { status }), flags });
    const back = await readBack(fresh, 'readback');
    if (back.ok) {
      record(item.rowId, { outcome: 'observed-matching-after-unknown-send', changed });
      return;
    }
    record(item.rowId, { outcome: 'unknown', changed, code: CODES.writeUnknown });
    // Why there was no answer, as readFailureText says it: the status and the system code (ECONNRESET), never the error's own text, which a
    // transport may fill with what the service said.
    const cause = thrown ? ` [${readFailureText(thrown)}]` : '';
    const mayLand = back.row && back.row.version === fresh.etag ? '; the row is still at the version the write was made against, so the write may still land' : '';
    throw fail(CODES.writeUnknown, `${what}: ${history(item.rowId)}${cause}${mayLand}`);
  }

  // The final proof (assertComplete): a fresh app context, then every declared row read and judged against it and its flags compared. Each
  // read is noted in the row's facts, so the preface (said after the reads) and a drifted row's message say what the reads found.
  async function recheckAtCompletion() {
    try {
      requireTransport({ write: false });
      const context = await resolveCommandStateContext(transport, { appUniqueName: spec.app.uniqueName, entities: [...new Set(states.map((s) => s.entity))] });
      for (const s of states) {
        const { row } = await readJudged(context, s, 'final');
        if (!matches(s, row)) {
          // Its own remedy, not command-state-not-confirmed's: the commands phase read every row it wrote back holding the flags, so this
          // is a change made during the build, after that read. The row's recorded outcome stays what its step was.
          throw new CommandStateError(CODES.notConfirmed, ROW_MESSAGES.finalDrift(rowResultOf(s.rowId)));
        }
      }
    } catch (error) {
      if (!(error instanceof CommandStateError)) throw error;
      throw new CommandStateError(error.code, `${ROW_MESSAGES.lateNote(rowResults())}: ${error.message}`, error.detail);
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

  const rowResultOf = (rowId) => { const r = results.get(rowId); return { ...r, changed: [...r.changed], facts: [...r.facts] }; };
  const rowResults = () => states.map((s) => rowResultOf(s.rowId));
  function result() {
    return { rows: rowResults(), publication: observer ? observer.snapshot() : [] };
  }
  // The observer outlives this attempt: it reports the invocation's rows (this attempt's declared rows, with every attempt's facts).
  if (observer && typeof observer.trackRows === 'function') observer.trackRows(rowResults);

  return {
    /** Read-only planning for a dry run: what each row holds, what would change, and the exact approvals the apply would need. */
    plan: () => step('plan', async () => {
      requireTransport({ write: false });
      const p = await readPlan('plan');
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
      current = await readPlan('preflight');
      checkApprovals(current);
      if (observer) for (const t of current.tables) observer.register(t.entity, current.items.filter((i) => i.entity === t.entity).map((i) => i.rowId));
    }),
    /** In the commands phase, before any row write: everything read again, and every remaining change still approved. */
    recheckAll: () => step('commands', async () => {
      requireTransport({ write: true });
      current = await readPlan('recheck');
      checkApprovals(current);
    }),
    /** One row at a time, then every row read once more before the build publishes. */
    applyRows: () => step('commands', async () => {
      if (!current) throw fail(CODES.transport, 'commandStates: rows applied before they were planned');
      for (const item of current.items) {
        try {
          await sendOne(item);
        } catch (error) {
          // A refusal before the send (the fresh read) leaves this row planned in the results: say it was refused, and why. Only when its facts
          // show no write that may have landed: anything else is a defect of this module, which must surface as itself, not as a second one.
          const row = results.get(item.rowId);
          if (row.outcome === 'planned' && factsShow('refused', undefined, row.facts)) record(item.rowId, { outcome: 'refused', code: error && error.code });
          throw error;
        }
      }
      for (const item of current.items) {
        const back = await readBack(item, 'after-every-row');
        if (!back.ok) {
          // The row matched after its own step (unchanged, acknowledged or observed-matching) and has lost the match since: its own outcome,
          // which keeps that history; the halt, the result line and the publication all word the row from its facts, which end with this read.
          record(item.rowId, { outcome: 'drifted', before: results.get(item.rowId).outcome, code: CODES.notConfirmed });
          throw fail(CODES.notConfirmed, ROW_MESSAGES.postWriteMismatch(rowResultOf(item.rowId)));
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
  CODES, REMEDY, ROW_OUTCOMES, DRIFT_BEFORE, ROW_PHRASES, READ_PHASES, KIND_WHOLE, ROW_MESSAGES, renderRowHistory, rowKind, checkRowRecord, commandStateMode, commandStateHalt,
  commandStateSpecHalt, createCommandStateRun, createCommandStatePublicationObserver, createCommandStateRowStore,
};
