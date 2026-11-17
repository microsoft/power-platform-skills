'use strict';
// One OS process of the declared-dashboard crash-boundary tests (dashboard-settlement-real-bundle.test.js). The process
// is the boundary under test: the binding store and the maker's SDK workspace are files on disk, and only what reached
// them may decide the next build, never anything a process still holds in memory.
//   node dashboard-create-crash-child.js <input.json>
//   input: { action: 'crash' | 'recover', timing: 'before' | 'after', dir, workspaceDir, wireFile, crashFile, output }
// `crash`: a build creates a new declared dashboard, and its create POST succeeds; the process then exits at once (77),
// with no unwinding, immediately BEFORE the store writes the durable acknowledgement of that create (`timing: before`)
// or immediately AFTER it (`timing: after`). The service's rows are written to `wireFile` first, as the service would
// keep them, and what the process saw to `crashFile`.
// `recover`: a later build in a new process opens the same store `dir` and SDK workspace `workspaceDir` over a service
// rebuilt from `wireFile` and settles the same declaration with no adoption approval, then publishes; the outcome is
// written as JSON to `output`.
const fs = require('node:fs');
const { createManagedWire } = require('./managed-wire.js');
const { declared, catalogFor, settle, makerRun, treeBytes, scopedSettle } = require('./dashboard-maker-run.js');

const CRASH_EXIT = 77;
const createPosts = (wire) => wire.log.filter((e) => e.method === 'POST' && /^systemforms$/i.test(e.path)).length;
const dashboard = declared([{ key: 'open', type: 'list', view: 'Open cases' }]);

async function crash({ timing, dir, workspaceDir, wireFile, crashFile }) {
  const wire = createManagedWire();
  const w = await makerRun({ wire, dir, workspaceDir });
  const answer = w.store.noteDashboardCreateAnswer.bind(w.store);
  // The send observer calls this once the create POST has succeeded on the service; it is the one store write that
  // turns the create receipt into an acknowledged one.
  w.store.noteDashboardCreateAnswer = (...args) => {
    if (timing === 'after') answer(...args);
    fs.writeFileSync(wireFile, JSON.stringify({ saved: [...wire.saved.values()], published: [...wire.published.values()] }));
    const pending = w.store.readGroup('dashboard', 'ops').pending;
    fs.writeFileSync(crashFile, JSON.stringify({
      pid: process.pid,
      posts: createPosts(wire),
      acknowledged: !!(pending && pending.dashboardCreate && pending.dashboardCreate.acknowledged),
      source: treeBytes(workspaceDir),
    }));
    process.exit(CRASH_EXIT);
  };
  await settle(w, dashboard, { approvals: {} });
  throw new Error('the create was acknowledged without reaching the store');
}

async function recover({ dir, workspaceDir, wireFile, output }) {
  const state = JSON.parse(fs.readFileSync(wireFile, 'utf8'));
  const wire = createManagedWire();
  for (const row of state.saved) wire.putForm(row);
  for (const row of state.published) wire.published.set(row.formid, row);
  const w = await makerRun({ wire, dir, workspaceDir });
  const sourceAtStart = treeBytes(workspaceDir);
  let out = null;
  let error = null;
  try {
    out = await scopedSettle(w, dashboard, { approvals: {} }, { publishToo: true });
  } catch (e) {
    error = e;
  }
  const id = catalogFor(dashboard).identityFor('dashboard', 'ops').derivedId;
  const group = w.store.readGroup('dashboard', 'ops');
  fs.writeFileSync(output, JSON.stringify({
    pid: process.pid,
    id,
    error: error && { code: error.code, category: (error.cause && error.cause.category) || error.category, message: error.message },
    result: out && out.settled.result,
    settledId: out && out.settled.id,
    publishSent: !!(out && out.published && out.published.sent),
    isolated: out ? out.isolated : null,
    posts: createPosts(wire),
    writes: wire.writes().map((e) => `${e.method} ${e.path}`),
    published: wire.published.has(id),
    pending: !!group.pending,
    origins: group.committed ? group.committed.records.map((r) => r.origin) : null,
    sourceAtStart,
    sourceAtEnd: treeBytes(workspaceDir),
  }));
}

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
(input.action === 'crash' ? crash(input) : recover(input)).catch((e) => {
  process.stderr.write(`${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
