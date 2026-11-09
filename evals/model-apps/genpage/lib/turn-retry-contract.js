'use strict';

// The opt-in stable-turn-retry eval: the host's side of `genpage-upload.js --turn-id`.
//
// What it grades is the guidance in plugins/model-apps/skills/genpage/SKILL.md (the `--turn-id` bullet under "Drafts, the pages lease,
// and a compiler refresh") and edit-flow.md Edit Phase 6:
//   - a turn id is minted and kept BEFORE the first send of the one edit it names, never added after an answer was lost;
//   - a retry after a lost answer is the same command — the same files, flags, `--app-dir` — under the same turn, and may come from
//     another process (a second backend);
//   - the retried edit is one page and one history turn: a create resumes the page its record names, an update adds no second message;
//   - a reuse of the turn that asks for anything else (another binding list, which is another binding mode) is refused with
//     `GENPAGE_TURN_ID_REUSED`, nothing written and the page's connection still bound;
//   - an ordinary create or edit passes no `--turn-id`.
//
// The evidence is a contract-2 folder (fixture-loader.js) whose name has no eval id, so the default runners never load it and their
// counts do not change: it is graded only when selected by name, through run-stable-turn-retry.js. Each check returns a list of
// problems (empty = pass); missing or malformed evidence throws, which gradeEvidence turns into a FAIL, never a skip.

const crypto = require('node:crypto');
const { pathKey, isGuid, artifactText, artifactJson, commandInfo, scriptRuns, gradeEvidence } = require('./evidence-utils.js');

const UPLOAD = 'genpage-upload.js';
// The flags whose value is a file the upload sends. A retry repeats the same paths, and the bytes it sent are recorded in the event's
// `inputs` (path → SHA-256), so a file saved again between the lost send and its retry is a different edit, not the same one.
// `--data-sources` is not here: its value is a CSV of table names (genpage-upload.js usage), so the command-flags comparison covers it.
const FILE_FLAGS = ['code-file', 'name-file', 'prompt-file', 'agent-message-file', 'connectors', 'actions'];

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const sorted = (flags) => JSON.stringify(Object.keys(flags).sort().map((name) => [name, flags[name]]));
const without = (flags, names) => Object.fromEntries(Object.entries(flags).filter(([name]) => !names.includes(name)));

// Every recorded run of genpage-upload.js, in order, with its flags read the way the graders read any recorded command (evidence-utils.js).
function uploadsOf(fixture) {
  const events = fixture.events;
  if (!Array.isArray(events) || events.length === 0) throw new Error('no tool results: the fixture records no commands');
  return events.flatMap((event, index) => {
    if (!scriptRuns(event, UPLOAD).length) return [];
    const { flags, problems } = commandInfo(event);
    if (problems.length) throw new Error(`${event.id}: ${problems.join(', ')}`);
    const turn = typeof flags['turn-id'] === 'string' ? flags['turn-id'] : null;
    return [{ event, index, id: event.id, flags, turn }];
  });
}

function turnsOf(uploads) {
  const turns = new Map();
  for (const upload of uploads) {
    if (!upload.turn) continue;
    if (!turns.has(upload.turn)) turns.set(upload.turn, []);
    turns.get(upload.turn).push(upload);
  }
  return turns;
}

function gradedTurns(fixture) {
  const uploads = uploadsOf(fixture);
  const turns = turnsOf(uploads);
  if (turns.size === 0) throw new Error('no upload under --turn-id: there is no turn to grade');
  return { uploads, turns };
}

const declaredTurn = (fixture, turnId) => {
  const declared = (fixture.manifest?.turns || []).find((entry) => entry.turnId === turnId);
  if (!declared || !declared.readback) throw new Error(`fixture.json declares no read-back for turn ${turnId}`);
  return declared.readback;
};

// A turn's id is kept by the host before the first send it names, and never attached to an edit that was already sent without it.
function keptTurnProblems(fixture) {
  const { uploads, turns } = gradedTurns(fixture);
  const problems = [];
  for (const [turnId, runs] of turns) {
    const first = runs[0];
    if (!isGuid(turnId)) problems.push(`${first.id}: --turn-id ${JSON.stringify(turnId)} is not a GUID`);
    if (typeof first.flags['app-dir'] !== 'string') problems.push(`${first.id}: --turn-id without --app-dir, the folder that keeps the turn's record`);
    const kept = fixture.events.findIndex((event) => event.host === 'keep-turn' && event.turnId === turnId);
    if (kept < 0 || kept > first.index) problems.push(`turn ${turnId} was not kept before its first send (${first.id})`);
    const request = sorted(without(first.flags, ['turn-id', 'app-dir']));
    const sentBefore = uploads.find((upload) => upload.index < first.index && !upload.turn && sorted(without(upload.flags, ['turn-id', 'app-dir'])) === request);
    if (sentBefore) problems.push(`turn ${turnId} was added to ${first.id} after ${sentBefore.id} had sent the same edit without one`);
  }
  return problems;
}

// After a lost answer, the next send of that turn is the same command with the same bytes, from another process, and it answers under the turn.
function sameRetryProblems(fixture) {
  const { uploads, turns } = gradedTurns(fixture);
  const problems = [];
  for (const upload of uploads.filter((u) => u.turn)) {
    const inputs = upload.event.inputs;
    if (!inputs || typeof inputs !== 'object') { problems.push(`${upload.id}: no recorded inputs (path → SHA-256 of the bytes sent)`); continue; }
    for (const flag of FILE_FLAGS) {
      if (typeof upload.flags[flag] === 'string' && !Object.hasOwn(inputs, pathKey(upload.flags[flag]))) problems.push(`${upload.id}: the bytes of --${flag} ${upload.flags[flag]} are not recorded`);
    }
    for (const [file, digest] of Object.entries(inputs)) {
      if (sha256(artifactText(fixture, file)) !== digest) problems.push(`${upload.id}: the recorded digest of ${file} is not the digest of the fixture's file`);
    }
  }
  const lost = uploads.filter((u) => u.event.answer === 'lost');
  if (lost.length === 0) problems.push('no send whose answer was lost: there is no retry to grade');
  for (const send of lost) {
    if (!send.turn) { problems.push(`${send.id} lost its answer without a turn id: a retry could make the edit twice`); continue; }
    const retry = turns.get(send.turn).find((u) => u.index > send.index);
    if (!retry) { problems.push(`${send.id} lost its answer and was never retried under turn ${send.turn}`); continue; }
    if (sorted(retry.flags) !== sorted(send.flags)) problems.push(`${retry.id} is not the same command as ${send.id}: a retry repeats the files, flags and --app-dir`);
    else if (sorted(retry.event.inputs || {}) !== sorted(send.event.inputs || {})) problems.push(`${retry.id} sent other bytes than ${send.id}: a changed file is a new edit, with a new turn id`);
    if (!retry.event.process || retry.event.process === send.event.process) problems.push(`${retry.id} is not from a fresh process: the retry must not rely on what ${send.id}'s process held`);
    if (retry.event.result?.ok !== true || retry.event.result?.turn?.id !== send.turn) problems.push(`${retry.id} did not answer ok under turn ${send.turn}`);
  }
  return problems;
}

// The page and history a retried turn left, read back: one page (the one its record names) and one turn in its history.
function onePageProblems(fixture) {
  const { turns } = gradedTurns(fixture);
  const problems = [];
  for (const [turnId, runs] of turns) {
    const done = runs.filter((u) => u.event.result?.ok === true).at(-1);
    if (!done) { problems.push(`turn ${turnId} has no answered send`); continue; }
    const readback = declaredTurn(fixture, turnId);
    const pageId = done.event.result.pageId;
    if (!isGuid(pageId)) problems.push(`${done.id}: no page id in its answer`);
    if (typeof done.flags['page-id'] === 'string') {
      if (pageId !== done.flags['page-id']) problems.push(`${done.id} answered page ${pageId}, not the page ${done.flags['page-id']} it updates`);
    } else {
      const name = artifactText(fixture, done.flags['name-file']);
      const pages = artifactJson(fixture, readback.pages).filter((page) => page.name === name);
      if (pages.length !== 1) problems.push(`turn ${turnId}: ${pages.length} pages named ${JSON.stringify(name)} after the retry — a resumed create makes one`);
      else if (pages[0].pageId !== pageId) problems.push(`turn ${turnId}: the page read back is ${pages[0].pageId}, not the ${pageId} the retry answered`);
    }
    const history = artifactJson(fixture, readback.history);
    const prompt = artifactText(fixture, done.flags['prompt-file']);
    const message = artifactText(fixture, done.flags['agent-message-file']);
    const asked = history.filter((entry) => entry.role === 'user' && entry.text === prompt).length;
    const answered = history.filter((entry) => entry.role === 'agent' && entry.text === message).length;
    if (asked !== 1 || answered !== 1) problems.push(`turn ${turnId}: its prompt is in the page's history ${asked} times and its message ${answered} times — one turn has one of each`);
  }
  return problems;
}

const bindingsOf = (fixture, name) => {
  const config = artifactJson(fixture, name);
  if (!Array.isArray(config.connectorBindings)) throw new Error(`${name}: no connectorBindings`);
  return config.connectorBindings;
};

// A send under a turn that asks for anything other than its first send is refused before any write, and the page keeps its connection.
function changedReuseProblems(fixture) {
  const { turns } = gradedTurns(fixture);
  const problems = [];
  let changed = 0;
  for (const [turnId, runs] of turns) {
    const request = sorted(runs[0].flags);
    const others = runs.filter((u) => sorted(u.flags) !== request);
    if (!others.length) continue;
    changed += others.length;
    for (const other of others) {
      const result = other.event.result || {};
      if (result.ok !== false || result.code !== 'GENPAGE_TURN_ID_REUSED' || result.outcome !== 'nothing') {
        problems.push(`${other.id} asks turn ${turnId} for another request and was not refused GENPAGE_TURN_ID_REUSED with outcome "nothing"`);
      }
      if (other.event.writes !== 0) problems.push(`${other.id}: a refused reuse writes nothing, recorded ${JSON.stringify(other.event.writes)}`);
    }
    const readback = declaredTurn(fixture, turnId);
    const before = bindingsOf(fixture, readback.configBefore);
    const connected = before.filter((binding) => isGuid(binding.connectionId));
    if (!connected.length) problems.push(`turn ${turnId}: the page had no bound connection to keep (${readback.configBefore})`);
    for (const name of [readback.configAfterRetry, readback.configAfterChanged]) {
      if (JSON.stringify(bindingsOf(fixture, name)) !== JSON.stringify(before)) problems.push(`turn ${turnId}: the connector bindings in ${name} are not the ones the page had`);
    }
  }
  if (changed === 0) problems.push('no reuse of a turn for another request: there is no refusal to grade');
  return problems;
}

// Runs of genpage-upload.js in a workflow log, one per line (the log writes a command on a line of its own).
const loggedUploads = (log) => String(log || '').split(/\r?\n/).filter((line) => scriptRuns(line, UPLOAD).length).map((line) => commandInfo({ command: line }).flags);

// An ordinary edit forces no turn: this fixture's counterpart sends, and every upload the default corpus records.
function ordinaryEditProblems(fixture, corpus) {
  const problems = [];
  const uploads = uploadsOf(fixture);
  const ordinary = fixture.manifest?.ordinary;
  if (!Array.isArray(ordinary) || ordinary.length === 0) throw new Error('fixture.json names no ordinary edit to grade');
  for (const id of ordinary) {
    const upload = uploads.find((u) => u.id === id);
    if (!upload) problems.push(`the ordinary edit ${id} is not a recorded genpage-upload.js run`);
    else if (Object.hasOwn(upload.flags, 'turn-id')) problems.push(`the ordinary edit ${id} passes --turn-id`);
    else if (upload.event.result?.ok !== true) problems.push(`the ordinary edit ${id} did not answer ok`);
  }
  if (!Array.isArray(corpus) || corpus.length === 0) throw new Error('no default corpus to compare with');
  let seen = 0;
  for (const other of corpus) {
    const recorded = [
      ...(other.events || []).filter((event) => scriptRuns(event, UPLOAD).length).map((event) => commandInfo(event).flags),
      ...loggedUploads(other.workflowLog),
    ];
    seen += recorded.length;
    if (recorded.some((flags) => Object.hasOwn(flags, 'turn-id'))) problems.push(`${other.dirName} records an upload with --turn-id: an ordinary create or edit forces none`);
  }
  if (seen === 0) problems.push('the default corpus records no upload, so it shows nothing about ordinary edits');
  return problems;
}

const TURN_RETRY_CHECKS = [
  ['A turn id is kept before the first send of the upload it names, never added after a lost answer', keptTurnProblems],
  ['A retry after a lost answer is the same command with the same bytes, from a fresh process, under the same turn', sameRetryProblems],
  ['A retried turn leaves one page and one history turn', onePageProblems],
  ['A reuse of a turn for another request is refused with nothing written, and the page keeps its connection', changedReuseProblems],
  ['An ordinary edit passes no --turn-id: this fixture\'s counterpart and every upload the default corpus records', ordinaryEditProblems],
];

/** Every check on one fixture, in report order: `{ text, result }` with result `{ status: 'pass' | 'fail', reason }`. */
function gradeTurnRetry(fixture, { corpus } = {}) {
  return TURN_RETRY_CHECKS.map(([text, check]) => ({ text, result: gradeEvidence((f) => check(f, corpus), fixture) }));
}

module.exports = {
  TURN_RETRY_CHECKS, gradeTurnRetry,
  keptTurnProblems, sameRetryProblems, onePageProblems, changedReuseProblems, ordinaryEditProblems,
};
