'use strict';

// The opt-in stable-turn-retry eval (run-stable-turn-retry.js, lib/turn-retry-contract.js, fixtures/stable-turn-retry): the committed
// evidence passes, the default runners never load it, and every check fails on the host mistake it exists for.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { loadFixtures, loadFixtureDir } = require('../lib/fixture-loader.js');
const contract = require('../lib/turn-retry-contract.js');

const GENPAGE = path.join(__dirname, '..');
const FOLDER = path.join(GENPAGE, 'fixtures', 'stable-turn-retry');
const FIXTURE = loadFixtureDir(FOLDER);
const CORPUS = loadFixtures(path.join(GENPAGE, 'fixtures'));
const T1 = '33333333-3333-4333-8333-333333333333';
const T2 = '44444444-4444-4444-8444-444444444444';

const copy = () => structuredClone(FIXTURE);
const event = (fixture, id) => fixture.events.find((e) => e.id === id);
const fails = (problems, pattern, what) => assert.ok(problems.some((p) => pattern.test(p)), `${what}: expected a problem matching ${pattern}, got ${JSON.stringify(problems)}`);

test('the committed evidence passes every check, selected by name only: the default runners never load it', () => {
  const run = spawnSync(process.execPath, [path.join(GENPAGE, 'run-stable-turn-retry.js')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^# tests 5$/m);
  assert.match(run.stdout, /^# pass {2}5$/m);
  assert.match(run.stdout, /^# skip {2}0$/m);
  assert.match(run.stdout, /^# fixtures 1 \(pass 1, fail 0\)$/m);
  assert.deepEqual(contract.gradeTurnRetry(FIXTURE, { corpus: CORPUS }).filter((r) => r.result.status !== 'pass'), []);
  assert.equal(CORPUS.some((f) => f.dir === FOLDER), false, 'the default loader passes over a folder with no eval id');
  assert.equal(FIXTURE.manifest.provenance, 'synthetic');
  // --eval and --tier select default fixtures; a run that took them would report a pass for nothing it graded.
  const scoped = spawnSync(process.execPath, [path.join(GENPAGE, 'run-stable-turn-retry.js'), '--eval', '20'], { encoding: 'utf8' });
  assert.equal(scoped.status, 2);
});

test('a turn id kept after the first send, or added to an edit already sent without one, fails', () => {
  const late = copy();
  const kept = late.events.splice(late.events.findIndex((e) => e.id === 'keep-create-turn'), 1)[0];
  late.events.splice(late.events.findIndex((e) => e.id === 'create') + 1, 0, kept);
  fails(contract.keptTurnProblems(late), /was not kept before its first send \(create\)/, 'kept after the send');

  const added = copy();
  const first = event(added, 'create');
  first.command = first.command.replace(/ --app-dir app --turn-id \S+/, '');
  fails(contract.keptTurnProblems(added), /was added to create-retry after create had sent the same edit without one/, 'added after a lost answer');
  fails(contract.sameRetryProblems(added), /create lost its answer without a turn id/, 'a lost send with no turn');

  const noFolder = copy();
  for (const id of ['create', 'create-retry']) event(noFolder, id).command = event(noFolder, id).command.replace(' --app-dir app', '');
  fails(contract.keptTurnProblems(noFolder), /--turn-id without --app-dir/, 'no --app-dir');
});

test('a retry that is another command, other bytes, the same process or another turn fails', () => {
  const otherCommand = copy();
  event(otherCommand, 'create-retry').command += ' --draft';
  fails(contract.sameRetryProblems(otherCommand), /create-retry is not the same command as create/, 'a flag added');

  const otherBytes = copy();
  otherBytes.artifacts['create/prompt.txt'] = 'Build the Revenue summary, sorted.\n';
  fails(contract.sameRetryProblems(otherBytes), /recorded digest of create\/prompt\.txt is not the digest/, 'the file saved again');
  const resent = copy();
  event(resent, 'create-retry').inputs = { ...event(resent, 'create-retry').inputs, 'create/prompt.txt': '0'.repeat(64) };
  fails(contract.sameRetryProblems(resent), /create-retry sent other bytes than create/, 'other bytes sent');

  const sameProcess = copy();
  event(sameProcess, 'edit-retry').process = event(sameProcess, 'edit').process;
  fails(contract.sameRetryProblems(sameProcess), /edit-retry is not from a fresh process/, 'the same process');

  const otherTurn = copy();
  event(otherTurn, 'create-retry').result.turn.id = T2;
  fails(contract.sameRetryProblems(otherTurn), /create-retry did not answer ok under turn/, 'answered under another turn');

  const never = copy();
  never.events = never.events.filter((e) => e.id !== 'edit-retry' && e.id !== 'edit-binding-mode-change');
  fails(contract.sameRetryProblems(never), /edit lost its answer and was never retried/, 'no retry');
  const changedInstead = copy();
  changedInstead.events = changedInstead.events.filter((e) => e.id !== 'edit-retry');
  fails(contract.sameRetryProblems(changedInstead), /edit-binding-mode-change is not the same command as edit/, 'a changed request in place of the retry');
});

test('--data-sources is a list of table names, not a file: an identical retry may use it, a changed list fails', () => {
  const same = copy();
  for (const id of ['create', 'create-retry']) event(same, id).command += ' --data-sources account,contact';
  assert.deepEqual(contract.gradeTurnRetry(same, { corpus: CORPUS }).filter((row) => row.result.status !== 'pass'), [], 'a table-name list needs no recorded digest');

  const changed = copy();
  event(changed, 'create').command += ' --data-sources account';
  event(changed, 'create-retry').command += ' --data-sources account,contact';
  fails(contract.sameRetryProblems(changed), /create-retry is not the same command as create/, 'the list changed');
});

test('a retried turn that leaves a second page or a second history turn fails', () => {
  const twoPages = copy();
  twoPages.artifacts['create/pages-after.json'] = JSON.stringify([
    { pageId: '66666666-6666-4666-8666-666666666666', name: 'Revenue' }, { pageId: '77777777-7777-4777-8777-777777777777', name: 'Revenue' },
  ]);
  fails(contract.onePageProblems(twoPages), /2 pages named "Revenue"/, 'a second page');

  const otherPage = copy();
  event(otherPage, 'create-retry').result.pageId = '77777777-7777-4777-8777-777777777777';
  fails(contract.onePageProblems(otherPage), /the page read back is .* not the 77777777/, 'a page the record does not name');

  const twoTurns = copy();
  const history = JSON.parse(twoTurns.artifacts['edit/history-after.json']);
  twoTurns.artifacts['edit/history-after.json'] = JSON.stringify([...history, ...history.slice(-2)]);
  fails(contract.onePageProblems(twoTurns), new RegExp(`turn ${T2}: its prompt is in the page's history 2 times`), 'a second history turn');

  const undeclared = copy();
  undeclared.manifest.turns = undeclared.manifest.turns.filter((t) => t.turnId !== T1);
  assert.throws(() => contract.onePageProblems(undeclared), /declares no read-back for turn/);
});

test('a changed reuse that is accepted, writes, or loses the connection fails', () => {
  const accepted = copy();
  event(accepted, 'edit-binding-mode-change').result = { ok: true, pageId: '88888888-8888-4888-8888-888888888888', updated: true };
  fails(contract.changedReuseProblems(accepted), /was not refused GENPAGE_TURN_ID_REUSED/, 'accepted');

  const wrote = copy();
  event(wrote, 'edit-binding-mode-change').writes = 1;
  fails(contract.changedReuseProblems(wrote), /a refused reuse writes nothing/, 'a write');

  const dropped = copy();
  const config = JSON.parse(dropped.artifacts['edit/config-after-changed.json']);
  delete config.connectorBindings[0].connectionId;
  dropped.artifacts['edit/config-after-changed.json'] = JSON.stringify(config);
  fails(contract.changedReuseProblems(dropped), /connector bindings in edit\/config-after-changed\.json are not the ones the page had/, 'the connection dropped');

  const none = copy();
  none.events = none.events.filter((e) => e.id !== 'edit-binding-mode-change');
  fails(contract.changedReuseProblems(none), /no reuse of a turn for another request/, 'nothing to grade');
});

test('an ordinary edit with --turn-id, here or in the default corpus, fails', () => {
  const forced = copy();
  event(forced, 'ordinary-edit').command += ' --app-dir app --turn-id 12121212-1212-4121-8121-121212121212';
  fails(contract.ordinaryEditProblems(forced, CORPUS), /the ordinary edit ordinary-edit passes --turn-id/, 'this fixture');

  const corpus = structuredClone(CORPUS);
  const recorded = corpus.find((f) => (f.events || []).some((e) => /genpage-upload\.js/.test(e.command)));
  recorded.events.find((e) => /genpage-upload\.js/.test(e.command)).command += ` --app-dir app --turn-id ${T1}`;
  fails(contract.ordinaryEditProblems(FIXTURE, corpus), new RegExp(`${recorded.dirName} records an upload with --turn-id`), 'the default corpus');

  const unnamed = copy();
  unnamed.manifest.ordinary = [];
  assert.throws(() => contract.ordinaryEditProblems(unnamed, CORPUS), /names no ordinary edit/);
});
